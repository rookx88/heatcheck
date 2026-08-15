// Generic HMAC-SHA256 sign/verify utility - deliberately NOT tied to balance,
// newsletter, or any specific feature. Nothing calls this yet: /api/balance and
// /api/picks/today keep using the plain-email trust model (matching every other
// endpoint in this app) for now, per the settlement finalization plan's explicit
// decision. This exists purely as prep - so that whenever token-based auth actually
// gets built (for those routes, a magic link, an unsubscribe link, anything else), it
// has a general-purpose primitive to build on instead of getting invented ad-hoc
// inside whichever feature needs it first.
//
// Web Crypto (crypto.subtle) rather than a Node crypto/jsonwebtoken dependency - this
// runs in the Cloudflare Workers runtime, which has no Node crypto module.

const ENCODER = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

async function importHmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', ENCODER.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

export type TokenPayload = Record<string, string | number | boolean>;

interface SignedTokenBody<T extends TokenPayload> {
    payload: T;
    // Unix seconds; absent means no expiry.
    exp?: number;
}

/**
 * Signs an arbitrary JSON-serializable payload into a compact, URL-safe token:
 * base64url(payload+exp).base64url(HMAC-SHA256 signature). Not JWT-spec-compliant
 * (no header segment, no alg negotiation) - deliberately minimal for this app's own
 * internal use, not for interop with third-party JWT consumers.
 */
export async function signToken<T extends TokenPayload>(
    payload: T,
    secret: string,
    expiresInSeconds?: number
): Promise<string> {
    const body: SignedTokenBody<T> = {
        payload,
        ...(expiresInSeconds !== undefined ? { exp: Math.floor(Date.now() / 1000) + expiresInSeconds } : {}),
    };
    const bodyB64 = toBase64Url(ENCODER.encode(JSON.stringify(body)));
    const key = await importHmacKey(secret, 'sign');
    const signature = await crypto.subtle.sign('HMAC', key, ENCODER.encode(bodyB64));
    const sigB64 = toBase64Url(new Uint8Array(signature));
    return `${bodyB64}.${sigB64}`;
}

/**
 * Verifies a token produced by signToken(). Returns the original payload if the
 * signature is valid and (when the token carries an exp) it hasn't expired; null for
 * anything else - malformed input, bad signature, or expired. Never throws on
 * untrusted input.
 */
export async function verifyToken<T extends TokenPayload>(token: string, secret: string): Promise<T | null> {
    const body = await verifyTokenBody<T>(token, secret);
    return body ? body.payload : null;
}

/**
 * Like verifyToken(), but returns the whole signed body ({ payload, exp? }) rather
 * than just the payload - so a caller that needs to enforce "this token MUST carry an
 * exp" (the auth-token wrapper) can actually see whether one was present, which
 * verifyToken()'s payload-only return structurally hides. Same never-throws contract.
 */
export async function verifyTokenBody<T extends TokenPayload>(
    token: string,
    secret: string
): Promise<SignedTokenBody<T> | null> {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [bodyB64, sigB64] = parts;

    try {
        const key = await importHmacKey(secret, 'verify');
        const valid = await crypto.subtle.verify('HMAC', key, fromBase64Url(sigB64), ENCODER.encode(bodyB64));
        if (!valid) return null;

        const body = JSON.parse(new TextDecoder().decode(fromBase64Url(bodyB64))) as SignedTokenBody<T>;
        if (body.exp !== undefined && body.exp < Math.floor(Date.now() / 1000)) return null;
        return body;
    } catch {
        return null;
    }
}
