// Session issuance + validation for the magic-link auth flow. The hc_session cookie
// holds a signed SessionTokenPayload pointing at a sessions row; the row - not the
// token - is the source of truth for expiry and revocation (create_sessions_table.sql),
// so logout and future "log out all devices" actually work immediately instead of
// waiting out a 30-day token.
//
// Sliding expiry: any authenticated request pushes expires_at back out to 30 days,
// throttled to at most once an hour per session so chatty pages don't turn every GET
// into an UPDATE. When the slide runs, a re-signed cookie comes back as
// refreshedSetCookie - handlers must attach it as a Set-Cookie header, otherwise the
// browser cookie and the token's own exp would still die 30 days after first login
// while the DB row slid forward, silently breaking the sliding guarantee.

import type { NeonQueryFunction } from '@neondatabase/serverless';
import { getSql, type Env } from './db';
import { signAuthToken, verifyAuthToken } from './auth-tokens';
import type { SessionTokenPayload } from '../auth-token-payloads';

export const SESSION_COOKIE = 'hc_session';
const SESSION_TTL_SECONDS = 30 * 24 * 3600;

// Structural request type rather than @cloudflare/workers-types' Request, so this
// stays importable from Node-checked programs (same motivation as
// lib/auth-token-payloads.ts's split).
interface RequestLike {
    url: string;
    headers: { get(name: string): string | null };
}

export interface Session {
    userId: string;
    email: string;
    verified: boolean;
    sessionId: string;
    // Non-null when the throttled sliding refresh ran this request - the handler MUST
    // attach it as a Set-Cookie response header.
    refreshedSetCookie: string | null;
}

// wrangler pages dev serves plain http on localhost, where a Secure cookie is
// rejected by some browsers (Safari, even for localhost); production is always
// https://heatchecks.io. Derived from the request rather than an env flag so there's
// nothing to misconfigure.
export function isSecureRequest(requestUrl: string): boolean {
    try {
        const { hostname } = new URL(requestUrl);
        return hostname !== 'localhost' && hostname !== '127.0.0.1';
    } catch {
        return true;
    }
}

export function getCookieValue(cookieHeader: string | null, name: string): string | null {
    if (!cookieHeader) return null;
    for (const part of cookieHeader.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
    }
    return null;
}

// httpOnly: the session is a real credential (it replaces raw-email trust on
// balance/picks-today), so it must never be reachable from client-side JS.
export function buildSessionCookie(token: string, secure: boolean): string {
    return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function buildClearSessionCookie(secure: boolean): string {
    return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export async function createSession(
    sql: NeonQueryFunction<false, false>,
    env: Env,
    userId: string,
    requestUrl: string
): Promise<{ setCookie: string }> {
    const rows = await sql`
        INSERT INTO sessions (user_id, expires_at)
        VALUES (${userId}, NOW() + INTERVAL '30 days')
        RETURNING session_id
    `;
    const sessionId = rows[0].session_id as string;
    const token = await signAuthToken<SessionTokenPayload>(
        { userId, purpose: 'session', sessionId },
        env.SESSION_TOKEN_SECRET,
        SESSION_TTL_SECONDS
    );
    return { setCookie: buildSessionCookie(token, isSecureRequest(requestUrl)) };
}

export async function getSession(request: RequestLike, env: Env): Promise<Session | null> {
    const raw = getCookieValue(request.headers.get('Cookie'), SESSION_COOKIE);
    if (!raw) return null;

    const payload = await verifyAuthToken<SessionTokenPayload>(raw, env.SESSION_TOKEN_SECRET, 'session');
    if (!payload) return null;

    const sql = getSql(env);

    // One round-trip: validate (row live, token and row agree on the user) and slide
    // expiry when it has drifted more than an hour behind the full 30 days.
    const rows = await sql`
        WITH s AS (
            SELECT s.session_id, s.user_id, w.email, w.email_verified
            FROM sessions s
            JOIN waitlist w ON w.id = s.user_id
            WHERE s.session_id = ${payload.sessionId}
              AND s.user_id = ${payload.userId}
              AND s.revoked_at IS NULL
              AND s.expires_at > NOW()
        ), refreshed AS (
            UPDATE sessions SET expires_at = NOW() + INTERVAL '30 days'
            WHERE session_id IN (SELECT session_id FROM s)
              AND expires_at < NOW() + INTERVAL '30 days' - INTERVAL '1 hour'
            RETURNING session_id
        )
        SELECT s.*, EXISTS (SELECT 1 FROM refreshed) AS did_refresh FROM s
    `;
    if (rows.length === 0) return null;
    const row = rows[0] as unknown as {
        session_id: string;
        user_id: string;
        email: string;
        email_verified: boolean;
        did_refresh: boolean;
    };

    let refreshedSetCookie: string | null = null;
    if (row.did_refresh) {
        const token = await signAuthToken<SessionTokenPayload>(
            { userId: row.user_id, purpose: 'session', sessionId: row.session_id },
            env.SESSION_TOKEN_SECRET,
            SESSION_TTL_SECONDS
        );
        refreshedSetCookie = buildSessionCookie(token, isSecureRequest(request.url));
    }

    return {
        userId: row.user_id,
        email: row.email,
        verified: Boolean(row.email_verified),
        sessionId: row.session_id,
        refreshedSetCookie,
    };
}
