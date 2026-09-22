// Acceptance suite for the magic-link + 6-digit-code auth flow: functions/api/login.ts
// (token mint, not exercised via the real send path here), functions/api/login/consume.ts
// (single-use nonce consumption), functions/api/verify-email.ts (brute-force-guarded
// code check), and lib/pages-functions/session.ts (session validation, revocation,
// CSRF guard). Never calls the real POST /api/login in a way that would send email -
// tokens are minted directly via fixtures.mintLoginToken/mintVerificationCode, which
// mirror the real signing/DB-write paths without touching Resend. The one exception is
// the CSRF smoke test, which does call POST /api/login with a hostile Origin - per
// login.ts, requireSameOrigin() runs and returns before the body is even parsed, let
// alone before sendLoginLinkEmail() is reached, so no email can ever be sent by that
// call.

import { pool, api, check, section, type Suite } from '../harness';
import { createUser, mintSessionCookie, mintLoginToken, mintVerificationCode, cleanupUsersByEmailPrefix } from '../fixtures';
import { ResendError, sendResendEmail } from '../../../lib/pages-functions/resend';

const EMAIL_PREFIX = 'acceptance-auth-';

async function cleanup() {
    await cleanupUsersByEmailPrefix(EMAIL_PREFIX);
}

async function run() {
    await cleanup();

    // --- Login token mint + consume ---
    section('Login token mint + consume');
    const consumeUser = await createUser(`${EMAIL_PREFIX}consume@example.com`, { onboarded: true });
    // createUser always seeds email_verified=true; force it false first so consuming
    // the link actually exercises the "flips true" guarantee instead of a no-op.
    await pool.query(`UPDATE waitlist SET email_verified = false WHERE id = $1`, [consumeUser.userId]);
    const token1 = await mintLoginToken(consumeUser.userId);
    const consumeRes = await api('POST', '/api/login/consume', { body: { token: token1 } });
    check('consume -> 200', consumeRes.status === 200, JSON.stringify(consumeRes.json));
    check('Set-Cookie present on consume', (consumeRes.headers.get('set-cookie') ?? '').includes('hc_session='));
    check('response onboarded reflects true', consumeRes.json?.onboarded === true);
    const { rows: sessionRows1 } = await pool.query(`SELECT session_id FROM sessions WHERE user_id = $1`, [consumeUser.userId]);
    check('a sessions row now exists for the user', sessionRows1.length === 1);
    const { rows: verifiedRows1 } = await pool.query(`SELECT email_verified FROM waitlist WHERE id = $1`, [consumeUser.userId]);
    check('waitlist.email_verified flipped true', verifiedRows1[0].email_verified === true);

    // Un-onboarded account: onboarded in the response should reflect that too.
    const unonboardedUser = await createUser(`${EMAIL_PREFIX}unonboarded@example.com`, { onboarded: false });
    const tokenUnonboarded = await mintLoginToken(unonboardedUser.userId);
    const unonboardedRes = await api('POST', '/api/login/consume', { body: { token: tokenUnonboarded } });
    check('consume -> 200 for un-onboarded account', unonboardedRes.status === 200);
    check('response onboarded reflects false', unonboardedRes.json?.onboarded === false, JSON.stringify(unonboardedRes.json));

    // --- Single-use enforcement ---
    section('Single-use enforcement');
    const replayRes = await api('POST', '/api/login/consume', { body: { token: token1 } });
    check('replaying an already-consumed token -> 400', replayRes.status === 400, JSON.stringify(replayRes.json));
    check(
        "already-used message is the distinct 'already used or replaced' copy",
        replayRes.json?.message === 'This login link has already been used or replaced. Request a fresh one to log in.',
        replayRes.json?.message,
    );

    const expiredToken = await mintLoginToken(consumeUser.userId, { ttlSeconds: -10 });
    const expiredRes = await api('POST', '/api/login/consume', { body: { token: expiredToken } });
    check('an expired/invalid-signature token -> 400', expiredRes.status === 400, JSON.stringify(expiredRes.json));
    check(
        "invalid/expired message is the distinct 'invalid or has expired' copy, different from the already-used copy",
        expiredRes.json?.message === 'This login link is invalid or has expired. Request a new one.' &&
            expiredRes.json?.message !== replayRes.json?.message,
        expiredRes.json?.message,
    );

    // --- Session validation ---
    section('Session validation - live cookie works, revoked cookie is rejected');
    const sessUser = await createUser(`${EMAIL_PREFIX}session@example.com`);
    const sessCookie = await mintSessionCookie(sessUser.userId);
    const liveRes = await api('GET', '/api/toolbar-state', { cookie: sessCookie });
    check('authenticated request succeeds with a live session', liveRes.status === 200, JSON.stringify(liveRes.json));
    check('toolbar-state session.userId matches', liveRes.json?.session?.userId === sessUser.userId);

    await pool.query(`UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1`, [sessUser.userId]);
    const revokedRes = await api('GET', '/api/toolbar-state', { cookie: sessCookie });
    check('same cookie is rejected after hand-revoking the session row', revokedRes.status === 401, JSON.stringify(revokedRes.json));

    // --- Verify-email brute force ---
    section('Verify-email brute force guard');
    const veEmail = `${EMAIL_PREFIX}verify@example.com`;
    const veUser = await createUser(veEmail);
    await mintVerificationCode(veUser.userId, '123456');

    for (let i = 0; i < 5; i++) {
        const wrongCode = `00000${i}`;
        const res = await api('POST', '/api/verify-email', { body: { email: veEmail, code: wrongCode } });
        check(`wrong-code attempt ${i + 1}/5 -> 400 generic-fail message`, res.status === 400 && res.json?.message === 'This code is invalid or has expired. Request a new one.', JSON.stringify(res.json));
    }
    const { rows: attemptRows } = await pool.query(`SELECT verification_attempts FROM waitlist WHERE id = $1`, [veUser.userId]);
    check('verification_attempts reached 5', attemptRows[0].verification_attempts === 5, String(attemptRows[0].verification_attempts));

    const sixthRes = await api('POST', '/api/verify-email', { body: { email: veEmail, code: '123456' } });
    check('6th attempt (even with the CORRECT code) -> 429 cap-exceeded', sixthRes.status === 429, JSON.stringify(sixthRes.json));
    check(
        "cap-exceeded message is distinguishable from the generic wrong-code message",
        sixthRes.json?.message === 'Too many attempts. Request a new code.' &&
            sixthRes.json?.message !== 'This code is invalid or has expired. Request a new one.',
        sixthRes.json?.message,
    );

    // Fresh code + correct guess on the first attempt -> 200, session issued, verified.
    await mintVerificationCode(veUser.userId, '654321');
    const correctRes = await api('POST', '/api/verify-email', { body: { email: veEmail, code: '654321' } });
    check('fresh code + correct first guess -> 200', correctRes.status === 200, JSON.stringify(correctRes.json));
    check('Set-Cookie present on successful verify', (correctRes.headers.get('set-cookie') ?? '').includes('hc_session='));
    const { rows: verifiedRows2 } = await pool.query(`SELECT email_verified FROM waitlist WHERE id = $1`, [veUser.userId]);
    check('waitlist.email_verified true after correct verify', verifiedRows2[0].email_verified === true);
    const { rows: sessionRows2 } = await pool.query(`SELECT session_id FROM sessions WHERE user_id = $1`, [veUser.userId]);
    check('a sessions row exists after verify-email success', sessionRows2.length === 1);

    // --- CSRF guard smoke test ---
    section('CSRF guard - hostile Origin rejected before any state change');
    // Safe: requireSameOrigin() runs before body parsing/email-sending in login.ts, so
    // this can never reach sendLoginLinkEmail() regardless of the body sent here.
    const csrfLoginRes = await api('POST', '/api/login', {
        body: { email: `${EMAIL_PREFIX}csrf@example.com` },
        headers: { Origin: 'https://evil.example' },
    });
    check('POST /api/login with a hostile Origin -> 403', csrfLoginRes.status === 403, JSON.stringify(csrfLoginRes.json));

    const csrfConsumeRes = await api('POST', '/api/login/consume', {
        body: { token: 'irrelevant-since-csrf-blocks-first' },
        headers: { Origin: 'https://evil.example' },
    });
    check('POST /api/login/consume with a hostile Origin -> 403', csrfConsumeRes.status === 403, JSON.stringify(csrfConsumeRes.json));

    // --- The Resend transport, fetch stubbed. Pure tier: no network, no DB, no mail. ---
    //
    // Authentication here is passwordless and magic-link only, which makes Resend the one
    // dependency whose failure blocks the entire product rather than degrading a feature.
    // Everything below is about not letting somebody else's outage become OUR lockout.
    section('Resend transport - an outage must not cost the user their way in');
    const realFetch = globalThis.fetch;
    let sent = 0;
    const stubResend = (status: number, headers: Record<string, string> = {}) => {
        sent = 0;
        globalThis.fetch = (async () => {
            sent++;
            return new Response(JSON.stringify({ message: 'stub' }), { status, headers });
        }) as typeof fetch;
    };
    const caught = async (fn: () => Promise<unknown>): Promise<any> => {
        try { await fn(); return null; } catch (err) { return err; }
    };
    try {
        stubResend(200);
        check('a 200 send resolves and makes exactly one request',
            (await caught(() => sendResendEmail('k', 'test', { to: 'a@b.c' }))) === null && sent === 1);

        stubResend(429);
        const rate = await caught(() => sendResendEmail('k', 'test', { to: 'a@b.c' }));
        check('429 is retried exactly once (the one status that means "not accepted")', sent === 2, `requests: ${sent}`);
        check('  and it surfaces as retriable', rate instanceof ResendError && rate.retriable === true);
        check('  and NOT as possibly-delivered, so a caller can safely refund a budget',
            rate instanceof ResendError && rate.possiblyDelivered === false);

        stubResend(500);
        const server = await caught(() => sendResendEmail('k', 'test', { to: 'a@b.c' }));
        check('5xx is NOT retried - the message may already have gone out', sent === 1, `requests: ${sent}`);
        check('  and is marked possiblyDelivered, so callers do not invite a duplicate',
            server instanceof ResendError && server.possiblyDelivered === true);

        stubResend(422);
        const bad = await caught(() => sendResendEmail('k', 'test', { to: 'nope' }));
        check('a rejected payload is not retriable - trying again changes nothing',
            bad instanceof ResendError && bad.retriable === false && sent === 1);

        const missing = await caught(() => sendResendEmail(undefined, 'test', { to: 'a@b.c' }));
        check('a missing API key is a distinct, non-retriable failure (not "Resend is down")',
            missing instanceof ResendError && missing.status === null && missing.retriable === false);

        globalThis.fetch = (async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); }) as typeof fetch;
        const slow = await caught(() => sendResendEmail('k', 'test', { to: 'a@b.c' }));
        check('a timeout is retriable AND possibly-delivered (the genuinely ambiguous case)',
            slow instanceof ResendError && slow.retriable === true && slow.possiblyDelivered === true);
    } finally {
        globalThis.fetch = realFetch;
    }

    await cleanup();
}

export const suite: Suite = {
    name: 'auth',
    requiredEnv: ['SESSION_TOKEN_SECRET'],
    run,
};
