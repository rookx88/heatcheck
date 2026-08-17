// Username ("signature") validation for the first-login welcome flow. Server-
// authoritative: welcome-client.tsx mirrors USERNAME_RE for instant feedback only.
// Uniqueness is deliberately NOT checked here - that's the partial unique index on
// LOWER(username) (add_username_to_waitlist.sql); callers map Postgres 23505 to a 409.
//
// The blocklist is a pilot-volume starter, not a moderation system: substring checks
// run against a folded form (lowercased, underscores stripped, common digit-for-letter
// substitutions collapsed) so 'x_SlurWord_x' and 'SlurW0rd' both trip it. Entries are
// chosen to avoid Scunthorpe-style false positives inside ordinary words - a miss here
// is a moderation problem, not a security one, so err toward letting names through.

export const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

// Exact-match (on the folded form) reserved names: staff-impersonation handles plus
// the in-world characters nobody gets to be.
const RESERVED = new Set([
    'admin',
    'administrator',
    'mod',
    'moderator',
    'staff',
    'support',
    'official',
    'system',
    'root',
    'help',
    'security',
    'heatchecks',
    'heatcheck',
    'ember',
    'embers',
    'sportsmclaren',
    'mclaren',
    'smclaren',
    'mudpuppy',
]);

// Folded, letters-only substrings. Keep each entry unlikely to occur inside an
// innocent name (no 'tard', no 'fag', no 'rape' - too many ordinary-word collisions
// at 20 chars).
const BLOCKED_SUBSTRINGS = [
    'fuck',
    'shit',
    'cunt',
    'bitch',
    'whore',
    'slut',
    'nigger',
    'nigga',
    'faggot',
    'retard',
    'kike',
    'chink',
    'tranny',
    'wetback',
    'beaner',
    'nazi',
    'hitler',
];

// Collapse the cheap evasions: case, underscores, and digit-for-letter swaps.
function fold(name: string): string {
    return name
        .toLowerCase()
        .replace(/_/g, '')
        .replace(/0/g, 'o')
        .replace(/1/g, 'i')
        .replace(/3/g, 'e')
        .replace(/4/g, 'a')
        .replace(/5/g, 's')
        .replace(/7/g, 't')
        .replace(/8/g, 'b');
}

export type UsernameValidation =
    | { ok: true; username: string }
    | { ok: false; message: string };

export function validateUsername(raw: unknown): UsernameValidation {
    const username = typeof raw === 'string' ? raw.trim() : '';
    if (username.length < 3 || username.length > 20) {
        return { ok: false, message: 'A signature runs 3 to 20 characters.' };
    }
    if (!USERNAME_RE.test(username)) {
        return { ok: false, message: 'Letters, numbers, and underscores only.' };
    }
    const folded = fold(username);
    if (RESERVED.has(folded)) {
        return { ok: false, message: 'That name is spoken for. Try another.' };
    }
    if (BLOCKED_SUBSTRINGS.some((s) => folded.includes(s))) {
        return { ok: false, message: "That name won't do here. Try another." };
    }
    return { ok: true, username };
}
