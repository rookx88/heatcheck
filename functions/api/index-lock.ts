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
    MIN_SELECTION_LIQUIDITY,
    positionsForGame,
    type PositionSpec,
    type SlateMarketRow,
} from '../../lib/pages-functions/index-slate';
import { resolvePositionTeams } from '../../lib/pages-functions/team-identity';
import { teamAt, toSlateMarketRow } from '../../lib/pages-functions/slate-rows';

// Matches the gap between worker-curate's sweep slots (10:00 / 18:00 / 02:00 UTC), with
// an hour of overlap so a game can't fall between two runs.
const LOCK_LOOKAHEAD_HOURS = 9;

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const secret = context.request.headers.get('X-Curate-Secret');
    if (!secret || secret !== context.env.CURATE_SECRET) {
        return jsonResponse({ message: 'Unauthorized' }, { status: 401 });
    }

    const sql = getSql(context.env);
    const [cfg, tickers] = await Promise.all([getTickerConfig(sql), getActiveTickers(sql)]);

    // Every open game-line market for games kicking off inside the window. The selection
    // floor is applied here as well as in the selector so the payload stays small.
    //
    // THE FLOOR IS PER MARKET TYPE, and has to be. Moneylines and totals are gated on
    // volume - the market's own vote for which line is the headline one. Spreads and
    // both-teams-to-score carry real liquidity but frequently no volume at all (measured
    // 2026-09-13: in a sampled NFL game nearly every spread market had volume NULL or 0
    // while liquidity ran 12-920), so gating THEM on volume would silently drop both new
    // market types on every game, forever. They gate on liquidity instead. Both floors
    // live in index-slate.ts's SELECTION_POLICY so this predicate and the selector can
    // never disagree about what qualifies.
    const rows = await sql`
        SELECT event_id, league, market_id, condition_id, market_type, question,
               market_line::float8 AS market_line,
               outcomes, outcome_prices,
               volume::float8 AS volume, liquidity::float8 AS liquidity,
               event_start_time, event_teams
        FROM polymarket_props
        WHERE closed IS DISTINCT FROM TRUE
          AND market_type IN ('totals', 'moneyline', 'spreads', 'both_teams_to_score')
          AND event_id IS NOT NULL
          AND outcome_prices IS NOT NULL
          AND event_start_time > NOW()
          AND event_start_time < NOW() + (INTERVAL '1 hour' * ${LOCK_LOOKAHEAD_HOURS})
          AND (
                (market_type IN ('totals', 'moneyline')
                     AND COALESCE(volume, 0) >= ${MIN_SELECTION_VOLUME})
             OR (market_type IN ('spreads', 'both_teams_to_score')
                     AND COALESCE(liquidity, 0) >= ${MIN_SELECTION_LIQUIDITY})
          )
        ORDER BY event_id
    `;

    // Group by game, then let the (pure, tested) selector decide each index's position.
    const byEvent = new Map<string, SlateMarketRow[]>();
    // Abbreviations are a property of the GAME, not of a market, so they are kept beside
    // the grouped rows rather than widening SlateMarketRow (which index-slate owns).
    const abbrByEvent = new Map<string, { away: string | null; home: string | null }>();
    for (const r of rows) {
        const row = toSlateMarketRow(r);
        if (!abbrByEvent.has(row.event_id)) {
            abbrByEvent.set(row.event_id, { away: teamAt(r.event_teams, 'away').abbr, home: teamAt(r.event_teams, 'home').abbr });
        }
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

    // Canonical club identity, resolved HERE and frozen onto the row - the same reasoning
    // as entry_prob one level up (see add_team_identity_to_index_positions.sql). Resolving
    // at read time would mean a regex over another table's free text on an unenforced
    // join, and an unmapped club would vanish from a team's totals with nobody watching.
    // Here it lands in `unmappedTeams` below instead.
    const teams = specs.map((s) =>
        resolvePositionTeams({
            league: s.row.league,
            away: s.row.away,
            home: s.row.home,
            marketType: s.row.market_type,
            sideLabel: s.sideLabel,
            question: s.row.question,
        }),
    );

    let created = 0;
    if (specs.length > 0) {
        // One bulk insert via unnest - the position count must not become a subrequest
        // count. ON CONFLICT makes a re-run a no-op rather than an error.
        const inserted = await sql`
            INSERT INTO index_positions (
                ticker_key, provider, market_id, condition_id, league, event_id,
                away, home, kickoff, market_type, market_line,
                side_index, side_label, entry_prob,
                sel_volume, sel_liquidity, sel_runner_up_line, sel_median_agreed,
                away_team_id, home_team_id, subject_team_id, subject_src,
                away_abbr, home_abbr
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
                ${specs.map((s) => s.selMedianAgreed)}::boolean[],
                ${teams.map((t) => t.awayTeamId)}::text[],
                ${teams.map((t) => t.homeTeamId)}::text[],
                ${teams.map((t) => t.subjectTeamId)}::text[],
                ${teams.map((t) => t.subjectSource)}::text[],
                ${specs.map((s) => abbrByEvent.get(s.row.event_id)?.away ?? null)}::text[],
                ${specs.map((s) => abbrByEvent.get(s.row.event_id)?.home ?? null)}::text[]
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

    // Clubs that arrived with a name team-identity.ts has never seen. This is the ONLY
    // place the gap is visible: the rows still lock (a missing club costs the index
    // nothing), but those games are absent from a team page until the name is mapped.
    // Expect this to fire when a league is added or a club is promoted into one.
    const unmappedTeams = [...new Set(teams.flatMap((t) => t.unmapped))].sort();

    // Why each side did or didn't get a club. The bug classes below must stay at zero;
    // the acceptance suite asserts it, and this is where a regression shows up first.
    const subjectsBySrc: Record<string, number> = {};
    for (const t of teams) subjectsBySrc[t.subjectSource] = (subjectsBySrc[t.subjectSource] ?? 0) + 1;
    const BUG_SOURCES = ['unmapped_team', 'unreadable_question', 'label_matches_neither', 'missing_teams'];
    const attributionBugs = BUG_SOURCES.reduce((n, k) => n + (subjectsBySrc[k] ?? 0), 0);

    return jsonResponse({
        lookaheadHours: LOCK_LOOKAHEAD_HOURS,
        gamesConsidered: byEvent.size,
        gamesWithNoQualifyingMarket: gamesWithNoPick,
        positionsPlanned: specs.length,
        positionsCreated: created,
        alreadyLocked: specs.length - created,
        byTicker,
        unmappedTeams,
        subjectsBySrc,
        attributionBugs,
        positionsWithSubjectTeam: teams.filter((t) => t.subjectTeamId !== null).length,
    });
};
