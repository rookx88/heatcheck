// Market residual per club: how far reality has run ahead of - or behind - the price the
// market put on a team, over the games the Exchange slate has captured. Pure and
// dependency-free, like index-slate.ts and ticker-price.ts, so the static build, a
// Worker and the acceptance suite all compute it the same way.
//
// THE WHOLE FEATURE IS ONE REUSE. contributionFor(won, entryProb) - index-slate.ts:311 -
// already answers "how surprising was this result, against this frozen price": +(1-p) on
// a win, -p on a loss, EV-neutral on a calibrated market. The indexes feed it the side
// THEY hold. This module feeds it the side a CLUB is. Same function, same units, one
// level of aggregation across.
//
// That EV-neutrality is what makes the number mean something: a club that wins six games
// it was favoured in scores near zero, because the market already said so. Only results
// the price did not anticipate move a residual. It is therefore a statement about the
// market's pricing, not a rating of the team - a distinction the copy layer must keep.
//
// WHAT IS DELIBERATELY NOT COUNTED, and why the read query can be free of business logic:
// the decisions were all made once at lock time and frozen into subject_team_id /
// subject_src (see add_team_identity_to_index_positions.sql). Totals are not
// team-directional; a soccer 'No' is "opponent win OR draw", a three-way leg that names
// no club; legacy draw markets belong to neither side. All three arrive here already
// excluded by `subject_team_id IS NOT NULL`.

import { contributionFor } from './index-slate';

/**
 * One settled, team-directional side. Exactly one row per club per game - see
 * TEAM_SIDE_DEDUPE_SQL for why that is not the same as one row per index.
 */
export interface TeamSideRow {
    eventId: string;
    league: string;
    teamId: string;
    opponentTeamId: string | null;
    /** The club's own frozen pre-kickoff probability. */
    entryProb: number;
    won: boolean;
    settledAt: string | null;
    kickoff: string | null;
    away: string | null;
    home: string | null;
    /**
     * True when the club's side came from a three-way market (soccer). Then `won: false`
     * means DID NOT WIN - which includes a draw - and must never be rendered as a loss.
     */
    threeWay: boolean;
}

export interface TeamGame extends TeamSideRow {
    /** contributionFor(won, entryProb). Positive = the result beat the price. */
    contrib: number;
}

export interface TeamRecord {
    teamId: string;
    games: number;
    wins: number;
    /** Non-wins from two-way markets: genuine losses. */
    losses: number;
    /** Non-wins from three-way markets: "did not win", a draw or a defeat. */
    didNotWin: number;
    /** The headline: sum of contributionFor over every counted game. */
    residual: number;
    /** Sum of entry probabilities - "how many wins the market priced in". */
    expectedWins: number;
    /** Mean frozen price on this club. Makes the residual legible. */
    avgEntryProb: number;
    /** Largest single |contrib|. The most readable fact on a team page. */
    biggest: TeamGame | null;
    byLeague: Array<{ league: string; games: number; wins: number; residual: number }>;
    firstKickoff: string | null;
    lastKickoff: string | null;
    /** Newest first. */
    games_: TeamGame[];
}

// Below this many counted games a club gets no residual headline - the aggregate is
// noise at small n, and the slate only began on 2026-08-31. This is the DEFAULT; the
// live value is game_config['team_records'].min_games so it can be retuned without a
// redeploy, and it is always passed in rather than read here (same posture as
// sideForRule's cfg argument).
export const DEFAULT_MIN_GAMES = 5;

/**
 * The one correct way to select team sides. Kept here as a string so the static build,
 * any future endpoint and the acceptance suite cannot drift into three near-identical
 * queries - the drift this feature is least able to survive.
 *
 * DISTINCT ON MUST INCLUDE market_type. A game carries both a moneyline and a totals
 * market, and their sides are numbered independently - both have a side_index 0. Keying
 * the dedupe on (event_id, side_index) alone silently collapses a moneyline side into a
 * totals row and drops ~15% of attributable sides, measured. It produces a smaller,
 * entirely plausible number rather than an error, which is exactly why the acceptance
 * suite asserts the count.
 *
 * AND IT MUST DEDUPE AT ALL. $CHALK and $MLBCHALK hold the same side of the same game, so
 * ~2.6 index rows exist per market. Summing across them multiplies every residual. Worse,
 * aggregating across indexes instead of sides makes wins exactly equal losses and every
 * total exactly 0.00 - a real, verified property of this data, and one that reads as a
 * broken formula rather than a broken query.
 */
export const TEAM_SIDE_DEDUPE_SQL = `
    SELECT DISTINCT ON (ip.event_id, ip.market_type, ip.side_index)
           ip.event_id, ip.league, ip.subject_team_id, ip.subject_src,
           ip.entry_prob::float8 AS entry_prob,
           (ip.result = 'win') AS won,
           ip.settled_at, ip.kickoff, ip.away, ip.home,
           ip.away_team_id, ip.home_team_id
    FROM index_positions ip
    -- MONEYLINE ONLY, and it must stay that way. Since 2026-09-13 spread positions also
    -- resolve a subject_team_id (their side label IS a club), so this predicate is now
    -- the only thing keeping a club's record meaning "games won" rather than "games won
    -- or covered". Widening it would double-count every game a team both won AND covered
    -- and quietly restate every record on the site.
    WHERE ip.market_type = 'moneyline'
      AND ip.result IN ('win', 'loss')
      AND ip.subject_team_id IS NOT NULL
    ORDER BY ip.event_id, ip.market_type, ip.side_index, ip.locked_at, ip.id
`;

/**
 * Throws if two rows describe the same club in the same game. The failure this guards is
 * not hypothetical and does not announce itself: a missed dedupe scales every residual by
 * ~2.6 and still renders a believable leaderboard.
 */
export function assertDeduped(rows: TeamSideRow[]): void {
    const seen = new Set<string>();
    for (const r of rows) {
        const key = `${r.eventId}|${r.teamId}`;
        if (seen.has(key)) {
            throw new Error(`team-records: duplicate side for ${r.teamId} in game ${r.eventId} - check TEAM_SIDE_DEDUPE_SQL`);
        }
        seen.add(key);
    }
}

function round3(n: number): number {
    return Number(n.toFixed(3));
}

/** One club's record. Rows must already be that club's, and already deduped. */
export function buildTeamRecord(teamId: string, rows: TeamSideRow[]): TeamRecord {
    const games_: TeamGame[] = rows
        .map((r) => ({ ...r, contrib: contributionFor(r.won, r.entryProb) }))
        .sort((a, b) => {
            const at = a.kickoff ? new Date(a.kickoff).getTime() : 0;
            const bt = b.kickoff ? new Date(b.kickoff).getTime() : 0;
            return bt - at;
        });

    let wins = 0;
    let losses = 0;
    let didNotWin = 0;
    let residual = 0;
    let expectedWins = 0;
    const leagues = new Map<string, { league: string; games: number; wins: number; residual: number }>();

    for (const g of games_) {
        if (g.won) wins++;
        else if (g.threeWay) didNotWin++;
        else losses++;
        residual += g.contrib;
        expectedWins += g.entryProb;
        const l = leagues.get(g.league) ?? { league: g.league, games: 0, wins: 0, residual: 0 };
        l.games++;
        if (g.won) l.wins++;
        l.residual += g.contrib;
        leagues.set(g.league, l);
    }

    const kickoffs = games_.map((g) => g.kickoff).filter((k): k is string => !!k).sort();

    return {
        teamId,
        games: games_.length,
        wins,
        losses,
        didNotWin,
        residual: round3(residual),
        expectedWins: round3(expectedWins),
        avgEntryProb: games_.length ? round3(expectedWins / games_.length) : 0,
        biggest: games_.reduce<TeamGame | null>(
            (best, g) => (!best || Math.abs(g.contrib) > Math.abs(best.contrib) ? g : best),
            null,
        ),
        byLeague: [...leagues.values()]
            .map((l) => ({ ...l, residual: round3(l.residual) }))
            .sort((a, b) => b.games - a.games || a.league.localeCompare(b.league)),
        firstKickoff: kickoffs[0] ?? null,
        lastKickoff: kickoffs[kickoffs.length - 1] ?? null,
        games_,
    };
}

/** Every club's record, keyed by team id. Asserts the dedupe invariant first. */
export function buildTeamRecords(rows: TeamSideRow[]): Map<string, TeamRecord> {
    assertDeduped(rows);
    const byTeam = new Map<string, TeamSideRow[]>();
    for (const r of rows) {
        const list = byTeam.get(r.teamId);
        if (list) list.push(r); else byTeam.set(r.teamId, [r]);
    }
    const out = new Map<string, TeamRecord>();
    for (const [teamId, teamRows] of byTeam) out.set(teamId, buildTeamRecord(teamId, teamRows));
    return out;
}

/** Has this club enough counted games to post a residual? */
export function qualifies(r: TeamRecord, minGames: number): boolean {
    return r.games >= minGames;
}

/**
 * Qualifying clubs, largest residual first. Ties break on more games (the better-evidenced
 * of two equal numbers), then team id for a total order.
 */
export function rankByResidual(records: TeamRecord[], minGames: number): TeamRecord[] {
    return records
        .filter((r) => qualifies(r, minGames))
        .sort((a, b) => b.residual - a.residual || b.games - a.games || a.teamId.localeCompare(b.teamId));
}
