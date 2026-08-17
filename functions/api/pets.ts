// GET /api/pets - the account's pet, or an explicit petless state. A user with no pet
// is a normal, expected state (a pet exists only after hatching an egg), so this returns
// { pet: null }, never a 404/error. Satisfaction is exposed ONLY as the Hungry/Satisfied
// label via petPublic - never the internal 0-100 number.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../lib/pages-functions/db';
import { getSession, requireOnboarded } from '../../lib/pages-functions/session';
import { getGameConfig, petPublic, type FeedingConfig, type PetRow } from '../../lib/pages-functions/pets';

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const session = await getSession(context.request, context.env);
    if (!session) return jsonResponse({ message: 'Login required.' }, { status: 401 });
    const gate = requireOnboarded(session);
    if (gate) return gate;
    const authHeaders = session.refreshedSetCookie ? { 'Set-Cookie': session.refreshedSetCookie } : undefined;

    const sql = getSql(context.env);
    const rows = await sql`SELECT id, color, render_mode, render_config, name, is_captain, satisfaction_at_last_feed, last_fed_at FROM pets WHERE user_id = ${session.userId} LIMIT 1`;
    if (rows.length === 0) {
        return jsonResponse({ pet: null }, { headers: authHeaders });
    }
    const cfg = (await getGameConfig(sql, 'feeding')) as unknown as FeedingConfig;
    return jsonResponse({ pet: petPublic(rows[0] as unknown as PetRow, cfg) }, { headers: authHeaders });
};
