// POST /api/resend-verification - issues a fresh 6-digit code if the first email
// didn't land (or expired). A per-email cooldown guards against accidental
// double-click spam, a per-email daily cap and a per-IP throttle guard against the
// deliberate kind (launch audit, 2026-09-07: with only the cooldown, anyone could
// drive 1,440 emails a day at any address /api/login had ever upserted - and every
// resend reset verification_attempts, so verify-email.ts's 5-attempt guard never
// actually locked anything out; it is now bounded to DAILY_CODE_CAP x 5 guesses a
// day per address).
//
// Non-enumerating (M3): unknown email, already-verified account, within-cooldown,
// over the daily cap, and over the IP throttle ALL return the same generic
// { sent: true } WITHOUT sending, so this endpoint can't be used to probe which
// addresses have an account or are verified. Only an existing, unverified,
// past-cooldown, under-cap account actually gets a new code.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, EMAIL_RE, type Env } from '../../lib/pages-functions/db';
import { sendVerificationEmail, generateVerificationCode } from '../../lib/pages-functions/email';
import { requireSameOrigin } from '../../lib/pages-functions/session';
import { throttle, clientIp } from '../../lib/pages-functions/throttle';

const RESEND_COOLDOWN_MS = 60_000;
const DAILY_CODE_CAP = 5;

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

    // Per-IP throttle first: it is the cheapest check and the one an attacker
    // rotating addresses runs into. Silent, same shape as every other no-send exit.
    const ip = await throttle(sql, 'resend_verification', clientIp(context.request));
    if (!ip.allowed) return jsonResponse({ sent: true });

    const rows = await sql`
        SELECT id, email_verified, verification_code_expires_at,
               verification_codes_sent_on, verification_codes_sent_today
        FROM waitlist WHERE LOWER(email) = ${email} LIMIT 1
    `;
    // Unknown email or already-verified: report success without doing anything, so the
    // response is identical to the real send path (no account-existence/verified oracle).
    if (rows.length === 0 || rows[0].email_verified) {
        return jsonResponse({ sent: true });
    }
    const row = rows[0];

    // A fresh code is issued 15 minutes ahead of expiry each time, so "issued <60s
    // ago" is equivalent to "expires >14min from now". Within cooldown: report success
    // without re-sending (also non-enumerating).
    const expiresAt = row.verification_code_expires_at ? new Date(row.verification_code_expires_at as string) : null;
    if (expiresAt && expiresAt.getTime() - Date.now() > 15 * 60_000 - RESEND_COOLDOWN_MS) {
        return jsonResponse({ sent: true });
    }
    // Daily cap, read here for the early exit; the guarded UPDATE below re-checks it
    // atomically (same posture as functions/api/login.ts's link cap).
    const today = new Date().toISOString().slice(0, 10);
    const sentOn = row.verification_codes_sent_on ? String(row.verification_codes_sent_on).slice(0, 10) : null;
    if (sentOn === today && Number(row.verification_codes_sent_today ?? 0) >= DAILY_CODE_CAP) {
        return jsonResponse({ sent: true });
    }

    // A new code legitimately needs fresh attempts - the reset is what lets a user who
    // fumbled five times recover with a fresh email - but it is now bounded by the cap
    // in the WHERE clause, so it can never be used to grant unlimited guesses.
    const code = generateVerificationCode();
    const updated = await sql`
        UPDATE waitlist
        SET verification_code = ${code},
            verification_code_expires_at = NOW() + INTERVAL '15 minutes',
            verification_attempts = 0,
            verification_codes_sent_today = CASE WHEN verification_codes_sent_on = CURRENT_DATE
                                                 THEN verification_codes_sent_today + 1 ELSE 1 END,
            verification_codes_sent_on = CURRENT_DATE
        WHERE id = ${row.id}
          AND (verification_codes_sent_on IS DISTINCT FROM CURRENT_DATE OR verification_codes_sent_today < ${DAILY_CODE_CAP})
        RETURNING id
    `;
    if (updated.length === 0) {
        return jsonResponse({ sent: true });
    }

    try {
        await sendVerificationEmail(context.env, email, code);
    } catch (err) {
        console.error('[POST /api/resend-verification] Verification email failed to send:', err);
        return jsonResponse({ message: 'Could not send the email right now. Try again shortly.' }, { status: 500 });
    }

    return jsonResponse({ sent: true });
};
