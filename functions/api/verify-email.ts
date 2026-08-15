// POST /api/verify-email - checks the 6-digit code sent by POST /api/picks. Confirms
// the email is real/reachable; never gates the pick itself (that's already saved and
// locked in by the time this runs). A correct code also issues a session cookie -
// typing the emailed code is the same proof of inbox ownership as clicking a magic
// link, so both paths converge on the same logged-in state without a second email
// round-trip. Deliberately NOT on the alreadyVerified branch below: that one is
// reachable by anyone who merely knows the email, with no proof of ownership.
//
// Since a correct code now mints a session, the attempt cap MUST be brute-force-proof.
// The counter is consumed and checked in a SINGLE atomic UPDATE (WHERE
// verification_attempts < cap): under the Neon HTTP driver every statement autocommits,
// so a read-then-write counter let concurrent bursts all read 0 and all get a guess -
// with a session as the prize, that was account takeover. The guarded UPDATE takes a
// row lock and re-checks the committed count, so at most MAX_ATTEMPTS guesses per code
// can ever succeed regardless of concurrency.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, EMAIL_RE, UUID_RE, type Env } from '../../lib/pages-functions/db';
import { createSession, requireSameOrigin } from '../../lib/pages-functions/session';
import { logEvent } from '../../lib/pages-functions/events';

const MAX_ATTEMPTS = 5;
// One generic message for unknown-email, wrong code, and expired code, so this endpoint
// isn't an account-existence oracle (login.ts is carefully non-enumerating; this keeps
// that property here too).
const GENERIC_FAIL = 'This code is invalid or has expired. Request a new one.';

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
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    const visitorId = typeof body?.visitorId === 'string' && UUID_RE.test(body.visitorId) ? body.visitorId : null;

    if (!EMAIL_RE.test(email)) {
        return jsonResponse({ message: 'Please enter a valid email address.' }, { status: 400 });
    }
    if (!code) {
        return jsonResponse({ message: 'Missing code.' }, { status: 400 });
    }

    const sql = getSql(context.env);

    // Existence + verified state - not attempt-sensitive, so a plain read. Unknown email
    // returns the same generic failure as a wrong code (no enumeration).
    const found = await sql`SELECT id, email_verified FROM waitlist WHERE LOWER(email) = ${email} LIMIT 1`;
    if (found.length === 0) {
        return jsonResponse({ message: GENERIC_FAIL }, { status: 400 });
    }
    const id = found[0].id as string;
    if (found[0].email_verified) {
        return jsonResponse({ alreadyVerified: true });
    }

    // Atomically consume one attempt iff still under the cap and unverified. Zero rows
    // means the cap is spent (or the row was verified by a racing request).
    const guess = await sql`
        UPDATE waitlist
        SET verification_attempts = verification_attempts + 1
        WHERE id = ${id} AND email_verified = false AND verification_attempts < ${MAX_ATTEMPTS}
        RETURNING verification_code, verification_code_expires_at
    `;
    if (guess.length === 0) {
        return jsonResponse({ message: 'Too many attempts. Request a new code.' }, { status: 429 });
    }
    const g = guess[0];
    const expiresAt = g.verification_code_expires_at ? new Date(g.verification_code_expires_at as string) : null;
    const expired = !expiresAt || expiresAt.getTime() < Date.now();
    const matches = !!g.verification_code && g.verification_code === code;

    if (expired || !matches) {
        return jsonResponse({ message: GENERIC_FAIL }, { status: 400 });
    }

    await sql`
        UPDATE waitlist
        SET email_verified = true, verification_code = NULL, verification_code_expires_at = NULL
        WHERE id = ${id}
    `;

    const { setCookie } = await createSession(sql, context.env, id, context.request.url);

    if (visitorId) {
        try {
            await logEvent(sql, { visitorId, waitlistId: id, eventType: 'email_verified' });
        } catch (eventErr) {
            console.error('[POST /api/verify-email] Failed to log email_verified event:', eventErr);
        }
    }

    return jsonResponse({ verified: true }, { headers: { 'Set-Cookie': setCookie } });
};
