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
import { getSql, jsonResponse, type Env } from './db';
import { signAuthToken, verifyAuthToken } from './auth-tokens';
import type { SessionTokenPayload } from '../auth-token-payloads';

// Over HTTPS the cookie carries the __Host- prefix: browsers enforce that a __Host-
// cookie has Secure, Path=/, and NO Domain attribute - which makes it impossible for
// any *.heatchecks.io subdomain to set or overwrite it (cookie-tossing / session
// fixation). Over plain http (wrangler pages dev) the prefix is illegal, so the bare
// name is used there. getSession/logout read the name matching the request's scheme,
// so in production only the un-spoofable __Host- cookie is ever trusted.
export const SESSION_COOKIE = 'hc_session';
const HOST_SESSION_COOKIE = '__Host-hc_session';
function sessionCookieName(secure: boolean): string {
    return secure ? HOST_SESSION_COOKIE : SESSION_COOKIE;
}

const SESSION_TTL_SECONDS = 30 * 24 * 3600;

// Host shapes allowed to originate a login link and to count as same-origin. Preview
// and branch aliases are *.heatcheck.pages.dev; production is heatchecks.io; dev is
// localhost/127.0.0.1.
function isTrustedHost(hostname: string): boolean {
    return (
        hostname === 'heatchecks.io' ||
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname.endsWith('.heatcheck.pages.dev')
    );
}

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
    // NULL username / onboarded=false until the first-login welcome letter is signed
    // (functions/api/onboarding/complete.ts) - the client-side gate keys off this.
    username: string | null;
    onboarded: boolean;
    sessionId: string;
    // Non-null when the throttled sliding refresh ran this request - the handler MUST
    // attach it as a Set-Cookie response header.
    refreshedSetCookie: string | null;
}

// wrangler pages dev serves plain http on localhost, where a Secure cookie is
// rejected by some browsers (Safari, even for localhost); prod/preview are always
// https. Keyed on the scheme itself rather than a hostname allowlist - that's what
// actually determines whether a Secure cookie is valid, and it fails secure on a
// malformed URL.
export function isSecureRequest(requestUrl: string): boolean {
    try {
        return new URL(requestUrl).protocol === 'https:';
    } catch {
        return true;
    }
}

// The login link's origin, hardened against Host-header injection (F1): only a
// trusted request Host is echoed back; anything else falls back to the canonical
// origin, so an attacker who slips a spoofed Host past Cloudflare's routing can never
// get a victim emailed a valid token pointed at an attacker domain.
export function resolveLoginOrigin(requestUrl: string, env: Env): string {
    try {
        const u = new URL(requestUrl);
        if (isTrustedHost(u.hostname)) return u.origin;
    } catch {
        /* fall through to canonical */
    }
    return (env.BASE_URL || 'https://heatchecks.io').replace(/\/$/, '');
}

// CSRF guard for state-changing POST endpoints. Returns a 403 Response when the
// request shows positive evidence of being cross-origin, else null (allow). Blocks the
// login-CSRF / session-fixation class: a cross-site form or fetch carries either
// Sec-Fetch-Site != same-origin or an Origin whose host isn't ours. Non-browser
// clients (no Sec-Fetch-Site, no Origin) are allowed through - CSRF is strictly a
// browser-driven attack, and gating those would break curl-based tooling for no gain.
export function requireSameOrigin(request: RequestLike): Response | null {
    const secFetchSite = request.headers.get('Sec-Fetch-Site');
    if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
        return jsonResponse({ message: 'Cross-origin request rejected.' }, { status: 403 });
    }
    const origin = request.headers.get('Origin');
    if (origin) {
        try {
            if (!isTrustedHost(new URL(origin).hostname)) {
                return jsonResponse({ message: 'Cross-origin request rejected.' }, { status: 403 });
            }
        } catch {
            return jsonResponse({ message: 'Cross-origin request rejected.' }, { status: 403 });
        }
    }
    return null;
}

// Server-side onboarding gate for action endpoints (picks / balance / picks-today).
// Returns a 403 when a logged-in account hasn't signed the welcome letter yet, else
// null (allow). The client UI already redirects un-onboarded sessions to /welcome/, so
// this only bites hand-crafted API calls that skip the UI - onboardingRequired lets a
// client that does hit it route to the letter. NOT applied to /api/session,
// /api/onboarding-status, or /api/onboarding/complete: those must work for an
// un-onboarded account (they're how it learns it must onboard, and how it does).
// onboarded_at is never unset, so this never fires for an account that has onboarded.
export function requireOnboarded(session: Session): Response | null {
    if (session.onboarded) return null;
    return jsonResponse(
        { message: 'Finish setting up your account first.', onboardingRequired: true },
        { status: 403, headers: session.refreshedSetCookie ? { 'Set-Cookie': session.refreshedSetCookie } : undefined }
    );
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
// balance/picks-today), so it must never be reachable from client-side JS. Name and
// Secure flag both track the request scheme (see sessionCookieName / __Host- note).
export function buildSessionCookie(token: string, secure: boolean): string {
    return `${sessionCookieName(secure)}=${token}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function buildClearSessionCookie(secure: boolean): string {
    return `${sessionCookieName(secure)}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

// Reads the session cookie under the name matching the request scheme, so production
// (https) only ever trusts the un-spoofable __Host- cookie.
export function readSessionCookie(request: RequestLike): string | null {
    return getCookieValue(request.headers.get('Cookie'), sessionCookieName(isSecureRequest(request.url)));
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
    const raw = readSessionCookie(request);
    if (!raw) return null;

    const payload = await verifyAuthToken<SessionTokenPayload>(raw, env.SESSION_TOKEN_SECRET, 'session');
    if (!payload) return null;

    const sql = getSql(env);

    // One round-trip: validate (row live, token and row agree on the user) and slide
    // expiry when it has drifted more than an hour behind the full 30 days.
    const rows = await sql`
        WITH s AS (
            SELECT s.session_id, s.user_id, w.email, w.email_verified, w.username, w.onboarded_at
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
        username: string | null;
        onboarded_at: string | null;
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
        username: row.username ?? null,
        onboarded: Boolean(row.onboarded_at),
        sessionId: row.session_id,
        refreshedSetCookie,
    };
}
