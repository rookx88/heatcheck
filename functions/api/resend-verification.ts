// POST /api/resend-verification - issues a fresh 6-digit code if the first email
// didn't land (or expired). A light per-email cooldown guards against accidental
// double-click spam without needing any new infra.
//
// Non-enumerating (M3): unknown email, already-verified account, and within-cooldown
// all return the same generic { sent: true } WITHOUT sending, so this endpoint can't be
// used to probe which addresses have an account or are verified. Only an existing,
// unverified, past-cooldown account actually gets a new code.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, EMAIL_RE, type Env } from '../../lib/pages-functions/db';
import { sendVerificationEmail, generateVerificationCode } from '../../lib/pages-functions/email';
import { requireSameOrigin } from '../../lib/pages-functions/session';

const RESEND_COOLDOWN_MS = 60_000;

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

    const rows = await sql`
        SELECT id, email_verified, verification_code_expires_at
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

    const code = generateVerificationCode();
    await sql`
        UPDATE waitlist
        SET verification_code = ${code},
            verification_code_expires_at = NOW() + INTERVAL '15 minutes',
            verification_attempts = 0
        WHERE id = ${row.id}
    `;

    try {
        await sendVerificationEmail(context.env, email, code);
    } catch (err) {
        console.error('[POST /api/resend-verification] Verification email failed to send:', err);
        return jsonResponse({ message: 'Could not send the email right now. Try again shortly.' }, { status: 500 });
    }

    return jsonResponse({ sent: true });
};
