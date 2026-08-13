// POST /api/verify-email - checks the 6-digit code sent by POST /api/picks. Purely
// confirms the email is real/reachable; never gates the pick itself (that's already
// saved and locked in by the time this runs).

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, EMAIL_RE, UUID_RE, type Env } from '../../lib/pages-functions/db';
import { logEvent } from '../../lib/pages-functions/events';

const MAX_ATTEMPTS = 5;

export const onRequestPost: PagesFunction<Env> = async (context) => {
    let body: any;
    try {
        body = await context.request.json();
    } catch {
        return jsonResponse({ message: 'Invalid JSON body.' }, { status: 400 });
    }

    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    const visitorId = typeof body?.visitorId === 'string' && UUID_RE.test(body.visitorId) ? body.visitorId : null;

    if (!EMAIL_RE.test(email)) {
        return jsonResponse({ message: 'Please enter a valid email address.' }, { status: 400 });
    }
    if (!code) {
        return jsonResponse({ message: 'Missing code.' }, { status: 400 });
    }

    const sql = getSql(context.env);

    const rows = await sql`
        SELECT id, email_verified, verification_code, verification_code_expires_at, verification_attempts
        FROM waitlist WHERE LOWER(email) = ${email} LIMIT 1
    `;
    if (rows.length === 0) {
        return jsonResponse({ message: 'No signup found for that email.' }, { status: 404 });
    }
    const row = rows[0];

    if (row.email_verified) {
        return jsonResponse({ alreadyVerified: true });
    }

    if (row.verification_attempts >= MAX_ATTEMPTS) {
        return jsonResponse({ message: 'Too many attempts. Request a new code.' }, { status: 429 });
    }

    const expiresAt = row.verification_code_expires_at ? new Date(row.verification_code_expires_at as string) : null;
    const expired = !expiresAt || expiresAt.getTime() < Date.now();
    const matches = !!row.verification_code && row.verification_code === code;

    if (expired || !matches) {
        await sql`UPDATE waitlist SET verification_attempts = verification_attempts + 1 WHERE id = ${row.id}`;
        return jsonResponse(
            { message: expired ? 'That code has expired. Request a new one.' : 'Incorrect code.' },
            { status: 400 }
        );
    }

    await sql`
        UPDATE waitlist
        SET email_verified = true, verification_code = NULL, verification_code_expires_at = NULL
        WHERE id = ${row.id}
    `;

    if (visitorId) {
        try {
            await logEvent(sql, { visitorId, waitlistId: row.id as string, eventType: 'email_verified' });
        } catch (eventErr) {
            console.error('[POST /api/verify-email] Failed to log email_verified event:', eventErr);
        }
    }

    return jsonResponse({ verified: true });
};
