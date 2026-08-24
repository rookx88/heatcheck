// Shared pick-submission core, extracted out of functions/api/picks.ts so a caller
// that isn't an HTTP request with a session cookie - specifically the Discord
// interactions handler (functions/api/discord/interactions.ts), which already knows
// the waitlistId via discord_links - can run the exact same Tank/odds/cap/conflict
// validation without going through a Request/Response at all.
//
// Deliberately NOT in scope here: CSRF, session/email resolution, and the
// verification-code-email side effect on first pick - those stay in picks.ts's HTTP
// handler, which is the only caller that needs them. A Discord-submitted pick is
// otherwise identical in every way that matters for scoring/settlement: it's a normal
// `picks` row with source='app', so it shares the same daily cap pool as a site pick.

import type { NeonQueryFunction } from '@neondatabase/serverless';
import type { Env } from './db';
import { hasKickoffPassed } from '../../tank-deck-format';
import type { PropOdds } from '../../tank-types';

function numEnv(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

export interface SubmitPickInput {
    waitlistId: string;
    slug: string;
    side: string;
    sideIndex: number;
    // 'app' | 'newsletter_exclusive' - matches picks.source. Both existing pick
    // callers and the Discord button flow all use 'app', so a Discord pick shares the
    // same daily-cap pool as a site pick (the cap query below filters on this).
    source: string;
}

interface PickRow {
    side: string;
    tank_slug: string;
    created_at: string;
}

export type SubmitPickResult =
    | { status: 'not_found' }
    | { status: 'not_settleable' }
    | { status: 'side_mismatch' }
    | { status: 'game_started' }
    | { status: 'no_odds' }
    | { status: 'odds_mismatch' }
    | { status: 'side_index_out_of_range' }
    | { status: 'malformed_odds' }
    | { status: 'cap_reached'; picksToday: number; dailyCap: number; verified: boolean }
    | { status: 'conflict'; pick: { slug: string; side: string; createdAt: string; verified: boolean } | null }
    | { status: 'ok'; pick: { slug: string; side: string; createdAt: string }; picksToday: number; dailyCap: number; verified: boolean };

export async function submitPick(
    sql: NeonQueryFunction<false, false>,
    env: Env,
    input: SubmitPickInput
): Promise<SubmitPickResult> {
    const { waitlistId, slug, side, sideIndex, source } = input;
    const DAILY_PICK_CAP = numEnv(env.DAILY_PICK_CAP, 1);

    const tankRows = await sql`
        SELECT id, provider, game_snapshot, model_output->'call'->'sides' AS sides
        FROM tank_pages WHERE slug = ${slug} AND status = 'published' AND visibility = 'app' LIMIT 1
    `;
    if (tankRows.length === 0) return { status: 'not_found' };
    const tankPageId = tankRows[0].id as string;
    const provider = tankRows[0].provider as string;
    if (!['polymarket', 'kalshi'].includes(provider)) return { status: 'not_settleable' };

    const rawSides = tankRows[0].sides as unknown;
    const validSides: string[] = Array.isArray(rawSides)
        ? (rawSides as string[])
        : (typeof rawSides === 'string' ? JSON.parse(rawSides) : []);
    if (validSides.length > 0 && !validSides.includes(side)) return { status: 'side_mismatch' };

    const snapshot = tankRows[0].game_snapshot as { prop?: { odds?: PropOdds | null }; game?: { kickoff?: string } } | null;
    if (hasKickoffPassed(snapshot?.game?.kickoff)) return { status: 'game_started' };

    const odds = snapshot?.prop?.odds ?? null;
    if (!odds || !Array.isArray(odds.outcomes) || !Array.isArray(odds.outcomePrices)) return { status: 'no_odds' };
    if (odds.outcomes.length !== validSides.length) return { status: 'odds_mismatch' };
    if (sideIndex < 0 || sideIndex >= odds.outcomes.length) return { status: 'side_index_out_of_range' };
    const impliedProbAtLock = odds.outcomePrices[sideIndex];
    if (typeof impliedProbAtLock !== 'number' || Number.isNaN(impliedProbAtLock)) return { status: 'malformed_odds' };

    // Same count-then-insert posture as the original inline version: not a hard
    // guarantee under a race, but picks pay out nothing by themselves, so the blast
    // radius of one extra slipped-through pick is negligible at this scale.
    const capRows = await sql`
        SELECT
            (SELECT COUNT(*)::int FROM picks WHERE waitlist_id = ${waitlistId} AND created_at >= CURRENT_DATE AND source = 'app') AS count,
            (SELECT email_verified FROM waitlist WHERE id = ${waitlistId}) AS email_verified
    `;
    const capRow = capRows[0] as unknown as { count: number; email_verified: boolean };
    const picksToday = capRow.count;
    const verified = Boolean(capRow.email_verified);
    if (picksToday >= DAILY_PICK_CAP) {
        return { status: 'cap_reached', picksToday, dailyCap: DAILY_PICK_CAP, verified };
    }

    try {
        const inserted = await sql`
            INSERT INTO picks (waitlist_id, tank_page_id, tank_slug, side, outcome_index, implied_prob_at_lock, source)
            VALUES (${waitlistId}, ${tankPageId}, ${slug}, ${side}, ${sideIndex}, ${impliedProbAtLock}, ${source})
            RETURNING side, tank_slug, created_at
        `;
        const row = inserted[0] as unknown as PickRow;
        return {
            status: 'ok',
            pick: { slug: row.tank_slug, side: row.side, createdAt: row.created_at },
            picksToday: picksToday + 1,
            dailyCap: DAILY_PICK_CAP,
            verified,
        };
    } catch (err: any) {
        if (err.code === '23505') { // idx_picks_waitlist_tank conflict - already picked THIS tank
            const existing = await sql`
                SELECT p.side, p.tank_slug, p.created_at, w.email_verified
                FROM picks p JOIN waitlist w ON w.id = p.waitlist_id
                WHERE p.waitlist_id = ${waitlistId} AND p.tank_page_id = ${tankPageId} LIMIT 1
            `;
            const row = existing[0] as unknown as { side: string; tank_slug: string; created_at: string; email_verified: boolean } | undefined;
            return {
                status: 'conflict',
                pick: row ? { slug: row.tank_slug, side: row.side, createdAt: row.created_at, verified: row.email_verified } : null,
            };
        }
        throw err;
    }
}
