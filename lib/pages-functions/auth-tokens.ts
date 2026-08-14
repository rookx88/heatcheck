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

import { signToken, verifyToken, type TokenPayload } from './tokens';

type AuthPayload = TokenPayload & { purpose: string };

export async function signAuthToken<T extends AuthPayload>(
    payload: T,
    secret: string,
    expiresInSeconds: number
): Promise<string> {
    return signToken(payload, secret, expiresInSeconds);
}

export async function verifyAuthToken<T extends AuthPayload>(
    token: string,
    secret: string,
    expectedPurpose: T['purpose']
): Promise<T | null> {
    const payload = await verifyToken<T>(token, secret);
    if (!payload || payload.purpose !== expectedPurpose) return null;
    return payload;
}
