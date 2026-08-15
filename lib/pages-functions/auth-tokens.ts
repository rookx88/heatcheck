// Purpose-aware wrapper over tokens.ts for auth tokens (login links + session
// cookies). Two guarantees the raw primitive deliberately doesn't make:
//
//  1. Expiry is mandatory - signToken() treats exp as optional, but every token
//     signed under SESSION_TOKEN_SECRET must expire, so this wrapper won't sign
//     without one.
//  2. Purpose is checked - any well-signed token verifies under the raw primitive
//     regardless of what it was minted for. Since login and session tokens share
//     one secret, the `purpose` claim (see lib/auth-token-payloads.ts) is the only
//     wall between "authorize one login" and "be a standing credential". Every
//     future token kind sharing SESSION_TOKEN_SECRET must go through this wrapper,
//     never tokens.ts directly.
//
// The newsletter-pick flow stays on the raw primitive with its own
// NEWSLETTER_TOKEN_SECRET - different secret, so no cross-verification risk and no
// need to migrate its outstanding 30-day links.

import { signToken, verifyTokenBody, type TokenPayload } from './tokens';

type AuthPayload = TokenPayload & { purpose: string };

// A missing or too-short SESSION_TOKEN_SECRET must fail loudly, not silently run the
// whole auth system on an empty (publicly-known) HMAC key: TextEncoder.encode(undefined)
// yields a zero-length key and crypto.subtle.importKey accepts it without complaint, so
// without this guard a deployment missing the binding would look fine while being
// forgeable. 32 hex chars = the `openssl rand -hex 32` convention's floor.
function assertSecret(secret: string): void {
    if (!secret || secret.length < 32) {
        throw new Error('SESSION_TOKEN_SECRET is missing or too short - refusing to sign/verify auth tokens.');
    }
}

export async function signAuthToken<T extends AuthPayload>(
    payload: T,
    secret: string,
    expiresInSeconds: number
): Promise<string> {
    assertSecret(secret);
    return signToken(payload, secret, expiresInSeconds);
}

export async function verifyAuthToken<T extends AuthPayload>(
    token: string,
    secret: string,
    expectedPurpose: T['purpose']
): Promise<T | null> {
    assertSecret(secret);
    const body = await verifyTokenBody<T>(token, secret);
    // exp is mandatory for auth tokens: reject any token that carries none, so a
    // never-expiring token minted by a future raw-signToken caller under this secret
    // can't be accepted here. Turns the sign-time TypeScript guarantee into a
    // verify-time invariant.
    if (!body || body.exp === undefined) return null;
    if (body.payload.purpose !== expectedPurpose) return null;
    return body.payload;
}
