// POST /api/logout - revokes the session server-side AND clears the cookie. The
// server-side revocation is the point of stateful sessions: a copied/leaked cookie
// dies here too, not just the browser's own copy. Verifies the session token directly
// rather than through getSession() - logout must still work for a session that's
// already expired or revoked (idempotent, always 200, no 401 path).

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../lib/pages-functions/db';
import { verifyAuthToken } from '../../lib/pages-functions/auth-tokens';
import {
    readSessionCookie,
    buildClearSessionCookie,
    isSecureRequest,
    requireSameOrigin,
} from '../../lib/pages-functions/session';
import type { SessionTokenPayload } from '../../lib/auth-token-payloads';

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const csrf = requireSameOrigin(context.request);
    if (csrf) return csrf;

    const raw = readSessionCookie(context.request);
    if (raw) {
        const payload = await verifyAuthToken<SessionTokenPayload>(raw, context.env.SESSION_TOKEN_SECRET, 'session');
        if (payload) {
            try {
                const sql = getSql(context.env);
                await sql`
                    UPDATE sessions SET revoked_at = NOW()
                    WHERE session_id = ${payload.sessionId} AND revoked_at IS NULL
                `;
            } catch (err) {
                console.error('[POST /api/logout] Failed to revoke session row:', err);
            }
        }
    }

    return jsonResponse(
        { loggedOut: true },
        { headers: { 'Set-Cookie': buildClearSessionCookie(isSecureRequest(context.request.url)) } }
    );
};
