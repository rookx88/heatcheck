// Constant-time check of a machine secret header (X-Settle-Secret, X-Curate-Secret,
// X-Ticker-Secret) against its env value. A plain `!==` returns as soon as a character
// differs, which in principle lets response timing reveal a secret one prefix at a time
// (pre-launch security audit, 2026-09-18). Both sides are hashed first so the byte
// comparison below always runs over 32 bytes, whatever the lengths, and never leaks
// the secret's length either. Fails closed: a missing header or an unset env var is
// never a match.

export async function secretMatches(provided: string | null | undefined, expected: string | null | undefined): Promise<boolean> {
    if (!provided || !expected) return false;
    const enc = new TextEncoder();
    const [a, b] = await Promise.all([
        crypto.subtle.digest('SHA-256', enc.encode(provided)),
        crypto.subtle.digest('SHA-256', enc.encode(expected)),
    ]);
    const x = new Uint8Array(a);
    const y = new Uint8Array(b);
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
    return diff === 0;
}
