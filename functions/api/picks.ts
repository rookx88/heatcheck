// POST /api/picks - combined email + pick submission. The email IS the account
// identity (a row in the existing `waitlist` table, upserted here). Up to
// DAILY_PICK_CAP picks per account per UTC day, one pick per Tank per account
// (idx_picks_waitlist_tank, add_daily_pick_cap.sql) - not one pick ever, that changed
// with the settlement finalization's daily-cap spec. A verification code is sent on
// success, but the pick itself is saved and returned regardless of whether that email
// send succeeds.
//
// Only polymarket-sourced Tanks accept picks: settlement (functions/api/settle.ts)
// resolves outcomes against Polymarket's Gamma API, and mock/custom-provider Tanks have
// no resolution source, so a pick on one could never be settled. sideIndex (the position
// of the chosen side in call.sides) is the authoritative signal for scoring - it maps
// positionally to game_snapshot.prop.odds.outcomes/outcomePrices, which were frozen at
// generation time in the same order call.sides was written in. implied_prob_at_lock is
// captured here, once, from that snapshot - it is never recomputed later.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, EMAIL_RE, UUID_RE, type Env } from '../../lib/pages-functions/db';
import { sendVerificationEmail, generateVerificationCode } from '../../lib/pages-functions/email';
import { getSession } from '../../lib/pages-functions/session';
import { logEvent } from '../../lib/pages-functions/events';

// Defaults to 1/day (Phase 0) rather than the eventual 3/day Phase 1 standard -
// deliberately gated behind DAILY_PICK_CAP (see lib/pages-functions/db.ts's Env) so
// raising it to 3 is a Cloudflare dashboard env var change, not a code deploy. Same
// numEnv() pattern functions/api/curate.ts already uses for its own tunables.
function numEnv(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

interface PickRow {
    side: string;
    tank_slug: string;
    created_at: string;
}

interface ExistingPickRow extends PickRow {
    email_verified: boolean;
}

interface PropOdds {
    outcomes: string[];
    outcomePrices: number[];
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    let body: any;
    try {
        body = await context.request.json();
    } catch {
        return jsonResponse({ message: 'Invalid JSON body.' }, { status: 400 });
    }

    const slug = typeof body?.slug === 'string' ? body.slug.trim() : '';
    const side = typeof body?.side === 'string' ? body.side.trim() : '';
    const sideIndex = Number.isInteger(body?.sideIndex) ? (body.sideIndex as number) : null;
    // Optional: the anonymous analytics visitor id (see tank-analytics-client.ts). Absent
    // or invalid just means this pick's events won't bridge to earlier anonymous history -
    // never a reason to fail the pick itself.
    const visitorId = typeof body?.visitorId === 'string' && UUID_RE.test(body.visitorId) ? body.visitorId : null;

    // Session-preferred identity: with a valid session cookie, the session decides who
    // this pick belongs to and any body email is ignored (a logged-in user must not be
    // able to submit picks onto some other address). Without a session, the body email
    // is still accepted - that's the deliberate first-ever-pick funnel entry point,
    // where email doubles as account creation.
    const session = await getSession(context.request, context.env);
    const email = session
        ? session.email.toLowerCase()
        : (typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '');

    if (!session && !EMAIL_RE.test(email)) {
        return jsonResponse({ message: 'Please enter a valid email address.' }, { status: 400 });
    }
    if (!slug) return jsonResponse({ message: 'Missing slug.' }, { status: 400 });
    if (!side) return jsonResponse({ message: 'Missing side.' }, { status: 400 });
    if (sideIndex === null) return jsonResponse({ message: 'Missing sideIndex.' }, { status: 400 });

    const sql = getSql(context.env);
    const DAILY_PICK_CAP = numEnv(context.env.DAILY_PICK_CAP, 1);

    const tankRows = await sql`
        SELECT id, provider, game_snapshot, model_output->'call'->'sides' AS sides
        FROM tank_pages WHERE slug = ${slug} AND status = 'published' AND visibility = 'app' LIMIT 1
    `;
    if (tankRows.length === 0) {
        return jsonResponse({ message: 'Unknown or unpublished Tank.' }, { status: 400 });
    }
    const tankPageId = tankRows[0].id as string;
    const provider = tankRows[0].provider as string;
    if (provider !== 'polymarket') {
        return jsonResponse({ message: 'This Tank cannot be settled and is not accepting picks.' }, { status: 400 });
    }
    const rawSides = tankRows[0].sides as unknown;
    const validSides: string[] = Array.isArray(rawSides)
        ? (rawSides as string[])
        : (typeof rawSides === 'string' ? JSON.parse(rawSides) : []);
    if (validSides.length > 0 && !validSides.includes(side)) {
        return jsonResponse({ message: "Side does not match this Tank's call." }, { status: 400 });
    }

    // The difficulty snapshot (implied_prob_at_lock) is mandatory, no exceptions - reject
    // the pick rather than ever store a null. sideIndex maps positionally into the frozen
    // game_snapshot's odds, which were generated in the same order as call.sides.
    const snapshot = tankRows[0].game_snapshot as { prop?: { odds?: PropOdds | null } } | null;
    const odds = snapshot?.prop?.odds ?? null;
    if (!odds || !Array.isArray(odds.outcomes) || !Array.isArray(odds.outcomePrices)) {
        return jsonResponse({ message: 'This prop has no odds on record and cannot be picked.' }, { status: 400 });
    }
    if (odds.outcomes.length !== validSides.length) {
        return jsonResponse({ message: "Call sides do not match recorded odds for this prop." }, { status: 400 });
    }
    if (sideIndex < 0 || sideIndex >= odds.outcomes.length) {
        return jsonResponse({ message: 'sideIndex out of range.' }, { status: 400 });
    }
    const impliedProbAtLock = odds.outcomePrices[sideIndex];
    if (typeof impliedProbAtLock !== 'number' || Number.isNaN(impliedProbAtLock)) {
        return jsonResponse({ message: 'Recorded odds are malformed and cannot be picked.' }, { status: 400 });
    }

    let waitlistId: string;
    if (session) {
        // Identity already established - no upsert, the account row necessarily exists.
        waitlistId = session.userId;
    } else {
        try {
            const waitlistRows = await sql`
                INSERT INTO waitlist (email) VALUES (${email})
                ON CONFLICT ((LOWER(email))) DO UPDATE SET email = waitlist.email
                RETURNING id
            `;
            waitlistId = waitlistRows[0].id as string;
        } catch (err) {
            console.error('[POST /api/picks] Error upserting waitlist row:', err);
            return jsonResponse({ message: 'Internal server error' }, { status: 500 });
        }
    }

    // Sliding-session refresh (lib/pages-functions/session.ts): when getSession slid
    // the expiry this request, the re-signed cookie rides back on whichever response
    // this handler ends up returning.
    const authHeaders = session?.refreshedSetCookie ? { 'Set-Cookie': session.refreshedSetCookie } : undefined;

    // Daily volume cap: count-then-insert, not a DB constraint (Postgres can't express
    // "at most N rows" declaratively). Accepted, documented race window - two
    // near-simultaneous requests could both read a count under the cap and both
    // insert, landing one extra pick. Not worth a SELECT ... FOR UPDATE / advisory
    // lock at pilot scale: picks pay out nothing by themselves (only settlement does,
    // later, and settleCall() is idempotent regardless of how many picks exist), so
    // the actual blast radius is "one extra pick slips through," not an extra payout
    // beyond what a legitimate Nth pick would have earned anyway.
    // source = 'app' excludes newsletter-exclusive picks (functions/api/newsletter/pick.ts)
    // from the daily cap - they're capped by "once per issue" (a DB unique index)
    // instead, and each issue only ever has one exclusive Tank to begin with.
    const capRows = await sql`
        SELECT
            (SELECT COUNT(*)::int FROM picks WHERE waitlist_id = ${waitlistId} AND created_at >= CURRENT_DATE AND source = 'app') AS count,
            (SELECT email_verified FROM waitlist WHERE id = ${waitlistId}) AS email_verified
    `;
    const capRow = capRows[0] as unknown as { count: number; email_verified: boolean };
    const picksToday = capRow.count;
    if (picksToday >= DAILY_PICK_CAP) {
        // A 429 here has nothing to do with whether the email is verified - it's purely
        // a volume rejection - but the client has no other signal to learn verification
        // status from on a brand new session (no cached account => it never called
        // GET /api/picks/today before this). Without `verified` here, an
        // already-verified account hitting the cap on a fresh device/incognito session
        // would see a confusing "confirm your email" prompt it doesn't need.
        return jsonResponse(
            { message: "You've used today's picks — back tomorrow.", picksToday, remaining: 0, verified: Boolean(capRow.email_verified) },
            { status: 429, headers: authHeaders }
        );
    }

    try {
        const inserted = await sql`
            INSERT INTO picks (waitlist_id, tank_page_id, tank_slug, side, outcome_index, implied_prob_at_lock)
            VALUES (${waitlistId}, ${tankPageId}, ${slug}, ${side}, ${sideIndex}, ${impliedProbAtLock})
            RETURNING side, tank_slug, created_at
        `;
        const row = inserted[0] as unknown as PickRow;

        // Fire off a verification code, but never let a Resend failure fail the pick
        // itself - the pick is already committed at this point. session.verified is
        // fresh (getSession joins waitlist on every request), so a verified session
        // skips the extra read entirely.
        let verified = session?.verified ?? false;
        try {
            if (!verified) {
                const waitlistRow = await sql`SELECT email_verified FROM waitlist WHERE id = ${waitlistId}`;
                verified = Boolean((waitlistRow[0] as unknown as { email_verified: boolean } | undefined)?.email_verified);
            }
            if (!verified) {
                const code = generateVerificationCode();
                await sql`
                    UPDATE waitlist
                    SET verification_code = ${code},
                        verification_code_expires_at = NOW() + INTERVAL '15 minutes',
                        verification_attempts = 0
                    WHERE id = ${waitlistId}
                `;
                await sendVerificationEmail(context.env, email, code);
            }
        } catch (emailErr) {
            console.error('[POST /api/picks] Verification email failed to send:', emailErr);
        }

        if (visitorId) {
            try {
                await logEvent(sql, { visitorId, waitlistId, eventType: 'pick_submitted', tankSlug: slug, metadata: { side, sideIndex } });
            } catch (eventErr) {
                console.error('[POST /api/picks] Failed to log pick_submitted event:', eventErr);
            }
        }

        const newPicksToday = picksToday + 1;
        return jsonResponse(
            {
                pick: { slug: row.tank_slug, side: row.side, createdAt: row.created_at },
                verified,
                picksToday: newPicksToday,
                remaining: DAILY_PICK_CAP - newPicksToday,
            },
            { status: 201, headers: authHeaders }
        );
    } catch (err: any) {
        if (err.code === '23505') { // idx_picks_waitlist_tank conflict - already picked THIS tank
            const existing = await sql`
                SELECT p.side, p.tank_slug, p.created_at, w.email_verified
                FROM picks p JOIN waitlist w ON w.id = p.waitlist_id
                WHERE p.waitlist_id = ${waitlistId} AND p.tank_page_id = ${tankPageId} LIMIT 1
            `;
            const row = existing[0] as unknown as ExistingPickRow | undefined;

            if (visitorId) {
                try {
                    await logEvent(sql, { visitorId, waitlistId, eventType: 'pick_conflict', tankSlug: slug, metadata: { attemptedSide: side } });
                } catch (eventErr) {
                    console.error('[POST /api/picks] Failed to log pick_conflict event:', eventErr);
                }
            }

            return jsonResponse(
                {
                    message: 'You already made this call.',
                    pick: row ? { slug: row.tank_slug, side: row.side, createdAt: row.created_at, verified: row.email_verified } : null,
                },
                { status: 409, headers: authHeaders }
            );
        }
        console.error('[POST /api/picks] Error inserting pick:', err);
        return jsonResponse({ message: 'Internal server error' }, { status: 500 });
    }
};
