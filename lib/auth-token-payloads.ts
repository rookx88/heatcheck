// Payload shapes signed/verified by lib/pages-functions/auth-tokens.ts for the
// magic-link auth flow. Same zero-dependency, type-only split as
// lib/newsletter-pick-token.ts, and for the same reason: a Node script (a future
// mailer, a test harness) can import these without pulling
// @cloudflare/workers-types into its program.
//
// The `purpose` discriminant is what keeps the two token kinds from ever being
// interchangeable: a login token answers "authorize this one login" and is consumed
// on first use; a session token answers "who is this, ongoing" and points at a
// sessions row. Both are signed with SESSION_TOKEN_SECRET, so the purpose check in
// verifyAuthToken() is the only thing separating them - it is not optional.

export interface LoginTokenPayload extends Record<string, string | number | boolean> {
    userId: string; // waitlist.id
    purpose: 'login';
    // Must match waitlist.login_nonce at consume time - rotated on each new link,
    // NULLed on consumption, which is what makes the link single-use.
    nonce: string;
}

export interface SessionTokenPayload extends Record<string, string | number | boolean> {
    userId: string; // waitlist.id
    purpose: 'session';
    // sessions.session_id - the row, not this token, is the source of truth for
    // expiry and revocation.
    sessionId: string;
}
