// Per-IP request throttles for the abuse-prone public endpoints (login-link and
// verification-code senders, the unauthenticated first-pick path, the analytics
// beacon). Every other limit in this app is a per-email or per-account column; nothing
// read the client IP before this, so one scripted client could drive unbounded email
// sends and database writes (launch audit, 2026-09-07).
//
// Lives in the database, not a platform binding: Cloudflare's rate-limit binding is
// Workers-only and cannot be declared for Pages Functions. A WAF rate-limiting rule in
// the dashboard is the recommended blanket layer on top of this, but the code must not
// depend on one existing.
//
// Model: fixed windows, one request_throttles row per (bucket, subject). The upsert
// resets the counter when the window has elapsed and increments otherwise, in ONE
// statement, so concurrent requests can never both slip under the limit (the same
// "the guard is the write" discipline as ledger.ts). FAILS OPEN on a database error
// with a console.error: an outage must never lock everyone out of logging in, and the
// endpoints these gate are all idempotent or separately capped per account anyway.
//
// /api/track does not call throttle(); it folds the identical upsert into its own
// INSERT as a CTE so a page view stays one round-trip - keep the two in step.

import type { NeonQueryFunction } from '@neondatabase/serverless';

export interface ThrottleRule {
    limit: number;         // requests allowed per window, per subject
    windowSeconds: number;
}

// Named buckets so the caps live in one place. Per IP, per hour. The harness runs
// from a single IP, so the caps stay well above what a full run issues - the suite
// proves the gate by seeding a counter row to the limit, never by exhausting it.
export const THROTTLES = {
    login: { limit: 60, windowSeconds: 3600 },               // /api/login (sends email)
    resend_verification: { limit: 30, windowSeconds: 3600 }, // /api/resend-verification (sends email)
    verify_email: { limit: 60, windowSeconds: 3600 },        // /api/verify-email (mints a session on success)
    pick_email: { limit: 30, windowSeconds: 3600 },          // /api/picks unauthenticated email path (creates accounts, sends email)
    track: { limit: 600, windowSeconds: 3600 },              // /api/track (one DB write per page view)
} as const satisfies Record<string, ThrottleRule>;

export type ThrottleBucket = keyof typeof THROTTLES;

// Cloudflare sets CF-Connecting-IP on every request that reaches a Pages Function;
// wrangler pages dev sets it too (127.0.0.1). The fallback only matters for a request
// that somehow lacks it, where every such request then shares one counter - a stricter
// outcome than none, never a looser one.
export function clientIp(request: { headers: { get(name: string): string | null } }): string {
    return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}

export interface ThrottleResult {
    allowed: boolean;
    count: number; // this request's position in the current window (1-based)
}

export async function throttle(
    sql: NeonQueryFunction<false, false>,
    bucket: ThrottleBucket,
    subject: string,
    rule: ThrottleRule = THROTTLES[bucket],
): Promise<ThrottleResult> {
    try {
        const rows = await sql`
            INSERT INTO request_throttles (bucket, subject, window_start, count)
            VALUES (${bucket}, ${subject}, NOW(), 1)
            ON CONFLICT (bucket, subject) DO UPDATE SET
                count = CASE
                    WHEN request_throttles.window_start < NOW() - (${rule.windowSeconds}::int * INTERVAL '1 second') THEN 1
                    ELSE request_throttles.count + 1
                END,
                window_start = CASE
                    WHEN request_throttles.window_start < NOW() - (${rule.windowSeconds}::int * INTERVAL '1 second') THEN NOW()
                    ELSE request_throttles.window_start
                END
            RETURNING count
        `;
        const count = Number((rows[0] as unknown as { count: number }).count);
        return { allowed: count <= rule.limit, count };
    } catch (err) {
        console.error(`[throttle] ${bucket} counter unavailable - failing open:`, err);
        return { allowed: true, count: 0 };
    }
}
