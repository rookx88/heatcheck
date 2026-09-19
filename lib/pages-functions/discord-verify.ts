// Verifies the Ed25519 signature Discord attaches to every Interactions Endpoint
// request (functions/api/discord/interactions.ts) - required before touching the
// body at all, or the endpoint is an open relay for forged interactions. Web Crypto
// (crypto.subtle), not a library - same "Workers-native, no Node crypto dependency"
// convention lib/pages-functions/tokens.ts already established for HMAC; Ed25519 is
// natively supported by SubtleCrypto in the Workers runtime.

const HEX_RE = /^[0-9a-f]+$/i;

// How far X-Signature-Timestamp may sit from our clock. The timestamp is inside the
// signed message, so it can't be altered - but without an age check a captured request
// verifies forever and can be replayed (pre-launch security audit, 2026-09-18). Real
// deliveries arrive within a second or two; five minutes absorbs clock skew.
export const DISCORD_MAX_SKEW_SECONDS = 300;

function hexToBytes(hex: string): Uint8Array | null {
    if (hex.length === 0 || hex.length % 2 !== 0 || !HEX_RE.test(hex)) return null;
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    return bytes;
}

/**
 * Verifies a Discord interaction request against DISCORD_PUBLIC_KEY. `signatureHex`
 * and `timestamp` come from the X-Signature-Ed25519 / X-Signature-Timestamp headers;
 * `rawBody` must be the exact, unparsed request body text (Discord signs the raw
 * bytes, not any re-serialization of the parsed JSON). A timestamp (Unix seconds)
 * more than DISCORD_MAX_SKEW_SECONDS from `nowMs` fails too. Never throws on malformed
 * input - returns false.
 */
export async function verifyDiscordRequest(
    rawBody: string,
    signatureHex: string | null,
    timestamp: string | null,
    publicKeyHex: string,
    nowMs: number = Date.now()
): Promise<boolean> {
    if (!signatureHex || !timestamp) return false;
    if (!/^\d{1,12}$/.test(timestamp)) return false;
    if (Math.abs(nowMs / 1000 - Number(timestamp)) > DISCORD_MAX_SKEW_SECONDS) return false;
    const signatureBytes = hexToBytes(signatureHex);
    const publicKeyBytes = hexToBytes(publicKeyHex);
    if (!signatureBytes || !publicKeyBytes) return false;

    try {
        const key = await crypto.subtle.importKey('raw', publicKeyBytes, { name: 'Ed25519' }, false, ['verify']);
        const message = new TextEncoder().encode(timestamp + rawBody);
        return await crypto.subtle.verify('Ed25519', key, signatureBytes, message);
    } catch {
        return false;
    }
}
