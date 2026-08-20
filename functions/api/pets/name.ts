// POST /api/pets/name - give the account's pet its (one-time) name. Naming happens
// at hatch and is permanent this build: only an unnamed pet accepts a name. Names are
// globally unique, case-insensitively, across BOTH other pets' names (enforced by
// idx_pets_name_lower - a racing duplicate surfaces as 23505) and every account
// username (gated inside the UPDATE, so the check and the write can't race each
// other). Validation is deliberately conservative: 2-20 chars, letters/digits/space/
// underscore/hyphen/apostrophe, starting alphanumeric.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../../lib/pages-functions/db';
import { getSession, requireSameOrigin, requireOnboarded } from '../../../lib/pages-functions/session';
import { getGameConfig, petPublic, type FeedingConfig, type PetRow } from '../../../lib/pages-functions/pets';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _'-]{1,19}$/;

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const csrf = requireSameOrigin(context.request);
    if (csrf) return csrf;

    const session = await getSession(context.request, context.env);
    if (!session) return jsonResponse({ message: 'Login required.' }, { status: 401 });
    const gate = requireOnboarded(session);
    if (gate) return gate;
    const authHeaders = session.refreshedSetCookie ? { 'Set-Cookie': session.refreshedSetCookie } : undefined;

    let body: any;
    try {
        body = await context.request.json();
    } catch {
        return jsonResponse({ message: 'Invalid JSON body.' }, { status: 400, headers: authHeaders });
    }
    const name = typeof body?.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
    if (!NAME_RE.test(name)) {
        return jsonResponse(
            { message: '2-20 characters: letters, numbers, spaces, _ - \' (starting with a letter or number).' },
            { status: 400, headers: authHeaders }
        );
    }

    const sql = getSql(context.env);

    try {
        const cfg = (await getGameConfig(sql, 'feeding')) as unknown as FeedingConfig;

        // Name only an unnamed pet, and only when no account owns this as a username.
        // Both conditions live in the UPDATE so they're evaluated atomically with the
        // write; a same-name race between two PETS is caught by idx_pets_name_lower.
        const rows = await sql`
            UPDATE pets SET name = ${name}
            WHERE user_id = ${session.userId}
              AND name IS NULL
              AND NOT EXISTS (SELECT 1 FROM waitlist WHERE LOWER(username) = LOWER(${name}))
            RETURNING id, color, render_mode, render_config, name, is_captain, satisfaction_at_last_feed, last_fed_at
        `;
        if (rows.length > 0) {
            return jsonResponse({ pet: petPublic(rows[0] as unknown as PetRow, cfg) }, { headers: authHeaders });
        }

        // Nothing updated - disambiguate for a useful error.
        const petRows = await sql`SELECT id, color, render_mode, render_config, name, is_captain, satisfaction_at_last_feed, last_fed_at FROM pets WHERE user_id = ${session.userId} LIMIT 1`;
        if (petRows.length === 0) {
            return jsonResponse({ message: 'You have no pet to name yet.' }, { status: 404, headers: authHeaders });
        }
        const pet = petRows[0] as unknown as PetRow;
        if (pet.name !== null) {
            // Idempotent retry of the same submission returns the pet; a different
            // name is a real rejection - naming is one-time.
            if (pet.name.toLowerCase() === name.toLowerCase()) {
                return jsonResponse({ pet: petPublic(pet, cfg) }, { headers: authHeaders });
            }
            return jsonResponse(
                { message: `Your pet already has a name: ${pet.name}.`, alreadyNamed: true },
                { status: 409, headers: authHeaders }
            );
        }
        // Unnamed pet + no update = the username gate blocked it.
        return jsonResponse({ message: 'That name is taken.', taken: true }, { status: 409, headers: authHeaders });
    } catch (err: any) {
        // A racing pet claimed the same name first (idx_pets_name_lower).
        if (err?.code === '23505') {
            return jsonResponse({ message: 'That name is taken.', taken: true }, { status: 409, headers: authHeaders });
        }
        console.error('[POST /api/pets/name] Error:', err);
        return jsonResponse({ message: 'Internal server error' }, { status: 500, headers: authHeaders });
    }
};
