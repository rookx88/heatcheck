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

// The Discord OAuth2 "state" param (functions/api/discord/link.ts + callback.ts).
// Binds the callback back to the session that started the flow - Discord's redirect
// is a top-level GET, so requireSameOrigin's Sec-Fetch-Site/Origin checks don't apply
// to it; this signed, short-TTL token IS the CSRF protection for that leg instead.
//
// userId is '' rather than a real optional property (TokenPayload's index signature
// can't express string|undefined) when the flow started with no session at all - a
// Discord-originated visitor with no Heatchecks account yet, or one signing back in on
// a new device. Non-empty when it started from an existing session (link.ts while
// logged in - "connect Discord to my account"). The callback trusts whichever was true
// when the flow started, not whatever session state happens to exist when Discord
// redirects back - see callback.ts for the two branches this drives. '' is falsy, so
// `if (payload.userId)` there already does the right thing with no extra handling.
export interface DiscordLinkTokenPayload extends Record<string, string | number | boolean> {
    userId: string; // waitlist.id, or '' for no session
    purpose: 'discord_link';
}
