// POST /api/login/consume - exchanges a login action token for a real session.
// Deliberately a POST fired by the /login/ page's JS, never a GET that consumes on
// fetch: Outlook SafeLinks / Gmail / corporate scanners prefetch GET links in emails
// and would burn a single-use nonce before the human ever clicked. Scanners don't
// execute JS or POST, so page-then-POST keeps single-use real for actual people.
//
// Consuming also sets email_verified = true: clicking a link sent to the inbox is the
// same proof of ownership as typing the emailed 6-digit code.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, UUID_RE, type Env } from '../../../lib/pages-functions/db';
import { verifyAuthToken } from '../../../lib/pages-functions/auth-tokens';
import { createSession, requireSameOrigin } from '../../../lib/pages-functions/session';
import { logEvent } from '../../../lib/pages-functions/events';
import type { LoginTokenPayload } from '../../../lib/auth-token-payloads';

export const onRequestPost: PagesFunction<Env> = async (context) => {
    // CSRF guard (H3): without this, a cross-origin form/fetch could silently drive a
    // victim's browser through consumption and set them a session for the ATTACKER's
    // account (session fixation) - SameSite=Lax doesn't help, since the attack is about
    // the response SETTING a cookie, not sending one.
    const csrf = requireSameOrigin(context.request);
    if (csrf) return csrf;

    let body: any;
    try {
        body = await context.request.json();
    } catch {
        return jsonResponse({ message: 'Invalid JSON body.' }, { status: 400 });
    }

    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    const visitorId = typeof body?.visitorId === 'string' && UUID_RE.test(body.visitorId) ? body.visitorId : null;
    if (!token) {
        return jsonResponse({ message: 'Missing token.' }, { status: 400 });
    }

    // One honest message for bad signature, expired exp, and wrong-purpose tokens -
    // none of them are distinguishable in a way the person on the page can act on.
    const payload = await verifyAuthToken<LoginTokenPayload>(token, context.env.SESSION_TOKEN_SECRET, 'login');
    if (!payload) {
        return jsonResponse({ message: 'This login link is invalid or has expired. Request a new one.' }, { status: 400 });
    }

    const sql = getSql(context.env);

    let userId: string;
    let userEmail: string;
    let onboarded: boolean;
    let setCookie: string;
    try {
        // Atomic single-use consumption: the nonce match is the guard. A second click
        // (nonce already NULLed) or a superseded link (nonce rotated by a newer request)
        // matches zero rows.
        const rows = await sql`
            UPDATE waitlist
            SET login_nonce = NULL,
                login_nonce_expires_at = NULL,
                email_verified = true
            WHERE id = ${payload.userId}
              AND login_nonce = ${payload.nonce}
              AND login_nonce_expires_at > NOW()
            RETURNING id, email, onboarded_at
        `;
        if (rows.length === 0) {
            return jsonResponse(
                { message: 'This login link has already been used or replaced. Request a fresh one to log in.' },
                { status: 400 }
            );
        }
        userId = rows[0].id as string;
        userEmail = rows[0].email as string;
        // Drives the post-login destination: un-onboarded accounts land on the
        // /welcome/ letter, not the homepage (login-client.tsx).
        onboarded = Boolean(rows[0].onboarded_at);

        ({ setCookie } = await createSession(sql, context.env, userId, context.request.url));
    } catch (err) {
        console.error('[POST /api/login/consume] Error consuming link / issuing session:', err);
        return jsonResponse({ message: 'Could not complete login. Request a fresh link.' }, { status: 500 });
    }

    if (visitorId) {
        try {
            await logEvent(sql, { visitorId, waitlistId: userId, eventType: 'logged_in' });
        } catch (eventErr) {
            console.error('[POST /api/login/consume] Failed to log logged_in event:', eventErr);
        }
    }

    return jsonResponse(
        { userId, email: userEmail, verified: true, onboarded },
        { headers: { 'Set-Cookie': setCookie } }
    );
};
