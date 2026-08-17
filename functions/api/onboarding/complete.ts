// POST /api/onboarding/complete - signs the welcome letter: stores the username
// ("signature") and stamps onboarded_at, exactly once. The WHERE onboarded_at IS NULL
// guard is the whole idempotency story: a double-submit or second tab matches zero
// rows and gets reported the already-settled state, never an error and never a
// second mutation. Non-negotiable: this writes exactly three waitlist columns (plus
// one analytics event) - no pet, no starter item, no bonus Ember is provisioned here
// or anywhere else on first login.
//
// Username uniqueness is server-authoritative via idx_waitlist_username_lower
// (case-insensitive partial index); the expected collision path surfaces as a clean
// 409, not a 500.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, UUID_RE, type Env } from '../../../lib/pages-functions/db';
import { getSession, requireSameOrigin } from '../../../lib/pages-functions/session';
import { validateUsername } from '../../../lib/pages-functions/username';
import { logEvent } from '../../../lib/pages-functions/events';

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const csrf = requireSameOrigin(context.request);
    if (csrf) return csrf;

    const session = await getSession(context.request, context.env);
    if (!session) {
        return jsonResponse({ message: 'Login required.' }, { status: 401 });
    }
    const authHeaders = session.refreshedSetCookie ? { 'Set-Cookie': session.refreshedSetCookie } : undefined;

    let body: any;
    try {
        body = await context.request.json();
    } catch {
        return jsonResponse({ message: 'Invalid JSON body.' }, { status: 400, headers: authHeaders });
    }

    const check = validateUsername(body?.username);
    if (!check.ok) {
        return jsonResponse({ message: check.message }, { status: 400, headers: authHeaders });
    }
    const visitorId = typeof body?.visitorId === 'string' && UUID_RE.test(body.visitorId) ? body.visitorId : null;

    const sql = getSql(context.env);
    try {
        const rows = await sql`
            UPDATE waitlist
            SET username = ${check.username},
                username_updated_at = NOW(),
                onboarded_at = NOW()
            WHERE id = ${session.userId} AND onboarded_at IS NULL
            RETURNING id, username
        `;
        if (rows.length === 0) {
            // Another tab/device already signed. Report the settled state so the
            // client proceeds into the app under the name that actually won.
            const cur = await sql`SELECT username FROM waitlist WHERE id = ${session.userId} LIMIT 1`;
            return jsonResponse(
                { ok: true, alreadyOnboarded: true, username: (cur[0]?.username as string) ?? null },
                { headers: authHeaders }
            );
        }

        if (visitorId) {
            try {
                await logEvent(sql, { visitorId, waitlistId: session.userId, eventType: 'onboarding_completed' });
            } catch (eventErr) {
                console.error('[POST /api/onboarding/complete] Failed to log event:', eventErr);
            }
        }

        return jsonResponse({ ok: true, username: rows[0].username as string }, { headers: authHeaders });
    } catch (err: any) {
        // unique_violation on idx_waitlist_username_lower - the one expected
        // contention path (a popular name, or a case-variant of one).
        if (err?.code === '23505') {
            return jsonResponse(
                { message: "That name's taken — try another signature." },
                { status: 409, headers: authHeaders }
            );
        }
        console.error('[POST /api/onboarding/complete] Error:', err);
        return jsonResponse({ message: 'Internal server error' }, { status: 500, headers: authHeaders });
    }
};
