// POST /api/index-lock - protected, machine-to-machine only (fired by worker-curate's
// sweep slots, or by hand while testing). Shares X-Curate-Secret with the other sweeps:
// same caller, same trust domain.
//
// Locks each Exchange index's position on every game kicking off soon: picks the one
// market that represents the game (lib/pages-functions/index-slate.ts), records the
// side and its CURRENT price, and writes it down. Settlement scores against that frozen
// entry price later.
//
// WHY THIS RUNS LATE, AND IN A WORKER:
//   * Late - only games kicking off inside LOCK_LOOKAHEAD_HOURS. The market-selection
//     rule keys off volume, and volume exists for 100% of games within 24h of kickoff
//     but only 35% beyond three days. Locking early would both misidentify the headline
//     line and trip the volume floor, silently dropping most of the slate.
//   * In a Worker, not the local admin backend - this is the irreversible step.
//     polymarket_props is upserted in place with no price history, so a game whose
//     pre-game price was never captured can never be scored, at all, later. Capture must
//     not depend on a laptop being awake.
//
// Cheap by construction: config read, ticker read, one candidate query, one bulk insert
// - four Neon calls regardless of slate size, well inside the Worker subrequest budget
// (Neon's HTTP driver means DB calls count against it too). Safe to re-run any number of
// times a day: UNIQUE (ticker_key, event_id) makes a repeat lock a row-level no-op.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../lib/pages-functions/db';
import { getActiveTickers, getTickerConfig } from '../../lib/pages-functions/tickers';
import {
    MIN_SELECTION_VOLUME,
    positionsForGame,
    type PositionSpec,
    type SlateMarketRow,
} from '../../lib/pages-functions/index-slate';

// Matches the gap between worker-curate's sweep slots (10:00 / 18:00 / 02:00 UTC), with
// an hour of overlap so a game can't fall between two runs.
const LOCK_LOOKAHEAD_HOURS = 9;

function teamName(teams: unknown, ordering: 'away' | 'home'): string | null {
    if (!Array.isArray(teams)) return null;
    const match = teams.find((t: any) => t?.ordering === ordering);
    return typeof match?.name === 'string' ? match.name : null;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const secret = context.request.headers.get('X-Curate-Secret');
    if (!secret || secret !== context.env.CURATE_SECRET) {
        return jsonResponse({ message: 'Unauthorized' }, { status: 401 });
    }

    const sql = getSql(context.env);
    const [cfg, tickers] = await Promise.all([getTickerConfig(sql), getActiveTickers(sql)]);

    // Every open game-line market for games kicking off inside the window. The volume
    // floor is applied here as well as in the selector so the payload stays small.
    const rows = await sql`
        SELECT event_id, league, market_id, condition_id, market_type,
               market_line::float8 AS market_line,
               outcomes, outcome_prices,
               volume::float8 AS volume, liquidity::float8 AS liquidity,
               event_start_time, event_teams
        FROM polymarket_props
        WHERE closed IS DISTINCT FROM TRUE
          AND market_type IN ('totals', 'moneyline')
          AND event_id IS NOT NULL
          AND outcome_prices IS NOT NULL
          AND event_start_time > NOW()
          AND event_start_time < NOW() + (INTERVAL '1 hour' * ${LOCK_LOOKAHEAD_HOURS})
          AND COALESCE(volume, 0) >= ${MIN_SELECTION_VOLUME}
        ORDER BY event_id
    `;

    // Group by game, then let the (pure, tested) selector decide each index's position.
    const byEvent = new Map<string, SlateMarketRow[]>();
    for (const r of rows) {
        const row: SlateMarketRow = {
            event_id: r.event_id as string,
            league: (r.league as string) ?? '',
            market_id: r.market_id as string,
            condition_id: (r.condition_id as string | null) ?? null,
            market_type: (r.market_type as string) ?? '',
            market_line: (r.market_line as number | null) ?? null,
            outcomes: Array.isArray(r.outcomes) ? (r.outcomes as unknown[]).map(String) : null,
            outcome_prices: Array.isArray(r.outcome_prices) ? (r.outcome_prices as unknown[]).map(Number) : null,
            volume: (r.volume as number | null) ?? null,
            liquidity: (r.liquidity as number | null) ?? null,
            // Neon hands timestamps back as Date objects, and String(date) yields
            // "... GMT-0700 (Pacific Daylight Time)" which Postgres rejects on the way
            // back in. Always round-trip through ISO.
            kickoff: r.event_start_time ? new Date(r.event_start_time as string | Date).toISOString() : null,
            away: teamName(r.event_teams, 'away'),
            home: teamName(r.event_teams, 'home'),
        };
        const list = byEvent.get(row.event_id);
        if (list) list.push(row); else byEvent.set(row.event_id, [row]);
    }

    const specs: PositionSpec[] = [];
    let gamesWithNoPick = 0;
    for (const gameRows of byEvent.values()) {
        const picked = positionsForGame(gameRows, tickers, {
            locksMinProb: cfg.locks_min_prob,
            moonshotMaxProb: cfg.moonshot_max_prob,
        });
        if (picked.length === 0) gamesWithNoPick++;
        specs.push(...picked);
    }

    let created = 0;
    if (specs.length > 0) {
        // One bulk insert via unnest - the position count must not become a subrequest
        // count. ON CONFLICT makes a re-run a no-op rather than an error.
        const inserted = await sql`
            INSERT INTO index_positions (
                ticker_key, provider, market_id, condition_id, league, event_id,
                away, home, kickoff, market_type, market_line,
                side_index, side_label, entry_prob,
                sel_volume, sel_liquidity, sel_runner_up_line, sel_median_agreed
            )
            SELECT * FROM unnest(
                ${specs.map((s) => s.tickerKey)}::text[],
                ${specs.map(() => 'polymarket')}::text[],
                ${specs.map((s) => s.row.market_id)}::text[],
                ${specs.map((s) => s.row.condition_id)}::text[],
                ${specs.map((s) => s.row.league)}::text[],
                ${specs.map((s) => s.row.event_id)}::text[],
                ${specs.map((s) => s.row.away)}::text[],
                ${specs.map((s) => s.row.home)}::text[],
                ${specs.map((s) => s.row.kickoff)}::timestamptz[],
                ${specs.map((s) => s.row.market_type)}::text[],
                ${specs.map((s) => s.row.market_line)}::numeric[],
                ${specs.map((s) => s.sideIndex)}::smallint[],
                ${specs.map((s) => s.sideLabel)}::text[],
                ${specs.map((s) => s.entryProb)}::numeric[],
                ${specs.map((s) => s.selVolume)}::numeric[],
                ${specs.map((s) => s.selLiquidity)}::numeric[],
                ${specs.map((s) => s.selRunnerUpLine)}::numeric[],
                ${specs.map((s) => s.selMedianAgreed)}::boolean[]
            )
            ON CONFLICT (ticker_key, event_id) DO NOTHING
            RETURNING id
        `;
        created = inserted.length;
    }

    // Per-index counts make coverage visible at a glance: an index that silently stops
    // locking (a league out of season, a rule that no longer matches) shows up here
    // before it shows up as a flat chart.
    const byTicker: Record<string, number> = {};
    for (const s of specs) byTicker[s.tickerKey] = (byTicker[s.tickerKey] ?? 0) + 1;

    return jsonResponse({
        lookaheadHours: LOCK_LOOKAHEAD_HOURS,
        gamesConsidered: byEvent.size,
        gamesWithNoQualifyingMarket: gamesWithNoPick,
        positionsPlanned: specs.length,
        positionsCreated: created,
        alreadyLocked: specs.length - created,
        byTicker,
    });
};
