// POST /api/login - request a magic login link. One endpoint for new and returning
// emails alike (an email-only system has no separate signup/login): unknown email
// creates the waitlist row via the exact upsert POST /api/picks uses, known email
// resolves to its existing row - never a duplicate, which is the single most
// important guarantee of the whole auth flow (unique index on LOWER(email) enforces
// it). The response is byte-identical either way, so the endpoint leaks nothing about
// whether an email has an account.
//
// The link carries a signed action token ({userId, purpose:'login', nonce}, 15 min)
// that AUTHORIZES issuing a session on consumption - it is not a session itself. See
// lib/auth-token-payloads.ts for the two-token-type distinction.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, EMAIL_RE, type Env } from '../../lib/pages-functions/db';
import { sendLoginLinkEmail } from '../../lib/pages-functions/email';
import { signAuthToken } from '../../lib/pages-functions/auth-tokens';
import { resolveLoginOrigin, requireSameOrigin } from '../../lib/pages-functions/session';
import type { LoginTokenPayload } from '../../lib/auth-token-payloads';

const LOGIN_TOKEN_TTL_SECONDS = 15 * 60;
const DAILY_LINK_CAP = 10;

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const csrf = requireSameOrigin(context.request);
    if (csrf) return csrf;

    let body: any;
    try {
        body = await context.request.json();
    } catch {
        return jsonResponse({ message: 'Invalid JSON body.' }, { status: 400 });
    }

    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(email)) {
        return jsonResponse({ message: 'Please enter a valid email address.' }, { status: 400 });
    }

    const sql = getSql(context.env);

    let waitlistId: string;
    let lastSentAt: Date | null;
    let sentOn: string | null;
    let sentToday: number;
    try {
        const rows = await sql`
            INSERT INTO waitlist (email) VALUES (${email})
            ON CONFLICT ((LOWER(email))) DO UPDATE SET email = waitlist.email
            RETURNING id, login_link_last_sent_at, login_links_sent_on, login_links_sent_today
        `;
        const row = rows[0];
        waitlistId = row.id as string;
        lastSentAt = row.login_link_last_sent_at ? new Date(row.login_link_last_sent_at as string) : null;
        sentOn = row.login_links_sent_on ? String(row.login_links_sent_on) : null;
        sentToday = Number(row.login_links_sent_today ?? 0);
    } catch (err) {
        console.error('[POST /api/login] Error upserting waitlist row:', err);
        return jsonResponse({ message: 'Internal server error' }, { status: 500 });
    }

    // Rate limit, read first for a specific message (the guarded UPDATE below
    // re-checks both conditions atomically - this read is just to pick the copy).
    // Prevents using this endpoint to spam someone else's inbox.
    if (lastSentAt && Date.now() - lastSentAt.getTime() < 60_000) {
        return jsonResponse({ message: 'A login link was just sent - check your inbox (or spam folder).' }, { status: 429 });
    }
    const today = new Date().toISOString().slice(0, 10);
    if (sentOn && sentOn.slice(0, 10) === today && sentToday >= DAILY_LINK_CAP) {
        return jsonResponse({ message: 'Daily login-link limit reached. Try again tomorrow.' }, { status: 429 });
    }

    // Rotating login_nonce invalidates any previous outstanding link (single
    // outstanding link per account, same posture as the 6-digit code flow). The WHERE
    // clause re-checks both rate limits so two concurrent requests can't both pass
    // the read above and both send.
    const nonce = crypto.randomUUID();
    const updated = await sql`
        UPDATE waitlist SET
            login_nonce = ${nonce},
            login_nonce_expires_at = NOW() + INTERVAL '15 minutes',
            login_link_last_sent_at = NOW(),
            login_links_sent_today = CASE WHEN login_links_sent_on = CURRENT_DATE
                                          THEN login_links_sent_today + 1 ELSE 1 END,
            login_links_sent_on = CURRENT_DATE
        WHERE id = ${waitlistId}
          AND (login_link_last_sent_at IS NULL OR login_link_last_sent_at < NOW() - INTERVAL '60 seconds')
          AND (login_links_sent_on IS DISTINCT FROM CURRENT_DATE OR login_links_sent_today < ${DAILY_LINK_CAP})
        RETURNING id
    `;
    if (updated.length === 0) {
        return jsonResponse({ message: 'A login link was just sent - check your inbox (or spam folder).' }, { status: 429 });
    }

    const token = await signAuthToken<LoginTokenPayload>(
        { userId: waitlistId, purpose: 'login', nonce },
        context.env.SESSION_TOKEN_SECRET,
        LOGIN_TOKEN_TTL_SECONDS
    );
    // Trusted origin only (F1): a spoofed Host can never redirect the emailed link to
    // an attacker domain - resolveLoginOrigin echoes the request origin only for known
    // hosts and otherwise falls back to the canonical BASE_URL.
    const loginUrl = `${resolveLoginOrigin(context.request.url, context.env)}/login/?token=${encodeURIComponent(token)}`;

    try {
        await sendLoginLinkEmail(context.env, email, loginUrl);
    } catch (err) {
        // Nonce already rotated and the cooldown is ticking - acceptable, identical
        // posture to resend-verification.ts: a retry after 60s just issues a fresh link.
        console.error('[POST /api/login] Login-link email failed to send:', err);
        return jsonResponse({ message: 'Could not send the email right now. Try again shortly.' }, { status: 500 });
    }

    return jsonResponse({ sent: true });
};
