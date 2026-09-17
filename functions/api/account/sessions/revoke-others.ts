// POST /api/account/sessions/revoke-others - "Log out of all other devices". Revokes
// every live sessions row for the calling account EXCEPT the one making the request,
// server-side, so a cookie copied to another browser dies on its next request rather
// than in 30 days (the whole reason sessions are stateful - see session.ts's header).
//
// The current session is identified by the token the cookie carries (Session.sessionId),
// never by "most recent" or any heuristic, so the caller can't log themselves out by
// accident. There is no device list to show (sessions has no user-agent / IP column, on
// purpose - nothing to leak), so the page shows a count and this returns what it cut.
//
// Session + same-origin required.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../../../lib/pages-functions/db';
import { getSession, requireSameOrigin } from '../../../../lib/pages-functions/session';
import { logEvent } from '../../../../lib/pages-functions/events';

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const csrf = requireSameOrigin(context.request);
    if (csrf) return csrf;

    const session = await getSession(context.request, context.env);
    if (!session) return jsonResponse({ message: 'Login required.' }, { status: 401 });
    const authHeaders = session.refreshedSetCookie ? { 'Set-Cookie': session.refreshedSetCookie } : undefined;

    const sql = getSql(context.env);
    const revoked = await sql`
        UPDATE sessions SET revoked_at = NOW()
        WHERE user_id = ${session.userId}
          AND session_id <> ${session.sessionId}
          AND revoked_at IS NULL
          AND expires_at > NOW()
        RETURNING session_id
    `;

    if (revoked.length > 0) {
        try {
            await logEvent(sql, {
                visitorId: crypto.randomUUID(),
                waitlistId: session.userId,
                eventType: 'sessions_revoked_others',
                metadata: { revoked: revoked.length },
            });
        } catch (eventErr) {
            console.error('[POST /api/account/sessions/revoke-others] Failed to log event:', eventErr);
        }
    }

    return jsonResponse({ revoked: revoked.length, active: 1 }, { headers: authHeaders });
};
