// The read side of the team pages: the queries and the page/board models that
// /teams/<slug>/ and /leagues/<slug>/ are built from. SqlReader-based like tickers.ts, so
// the identical SQL runs under pg at build time (scripts/generate-static-site.ts's sqlPg
// adapter) and under Neon in a Worker should an endpoint ever want it.
//
// TWO COUNTS, AND THEY DIFFER ON PURPOSE.
//   fixtures  - every settled game a club APPEARED in, from away_team_id/home_team_id.
//               Drives tile area on a league board and gives a full roster: a soccer club
//               shows up in ~2x as many fixtures as it has directional games, because the
//               slate's 'No' side on "Will <club> win?" names nobody (market-movers.ts:186).
//   games     - the club's DIRECTIONAL sides (subject_team_id), the only rows that carry a
//               contribution. Drive the residual and its gate.
// A fixture with no directional side is listed as "appeared" and nothing more: this
// module knows no scores, so it claims no outcome for it.
//
// Identity is club-scoped (team-identity.ts): a club's residual and its gate are
// club-wide, across every competition it appeared in. A league board colours a tile by
// that club-wide figure - so a coloured tile always links to a page with a headline and a
// grey one to a page without, which is the consistency a reader can feel. Only the tile's
// AREA is league-scoped (fixtures in that competition).

import type { SqlReader } from './tickers';
import { getGameConfigOrNull } from './pets';
import { contributionFor } from './index-slate';
import { DEFAULT_MIN_GAMES, qualifies, type TeamRecord, type TeamSideRow } from './team-records';
import { DEFAULT_TEAM_PRICE_BASELINE, DEFAULT_TEAM_PRICE_SCALE, type TeamPricing } from './team-price';
import type { WindowSums } from './ticker-window';
import { allTeams, teamSlug, type TeamId } from './team-identity';
import { signOf, type Sign } from './ticker-format';
import { LEAGUE_GROUPS } from './league-rules';
import { SUPPORTED_LEAGUES } from '../../league-tags';
import { SPORT_BY_LEAGUE, type Sport } from '../../sport-map';

// -----------------------------------------------------------------------------------
// League slugs. teamSlug already folds diacritics and punctuation, so 'La Liga' ->
// 'la-liga' and 'EFL Championship' -> 'efl-championship' with no second slugger.
// -----------------------------------------------------------------------------------

/** Every league a page could exist for: the sync's universe plus the rule groups' leaves. */
export function knownLeagues(): string[] {
    const set = new Set<string>(SUPPORTED_LEAGUES);
    for (const leagues of Object.values(LEAGUE_GROUPS)) for (const l of leagues) set.add(l);
    return [...set];
}

export function leagueSlug(league: string): string {
    return teamSlug(league);
}

export function leagueFromSlug(slug: string): string | null {
    for (const league of knownLeagues()) if (leagueSlug(league) === slug) return league;
    return null;
}

export function sportOf(league: string): Sport {
    return SPORT_BY_LEAGUE[league] ?? 'Soccer';
}

// -----------------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------------

export const TEAM_RECORDS_CONFIG_KEY = 'team_records';

export interface TeamConfig {
    minGames: number;
    priceBaseline: number;
    priceScale: number;
    /** 'default' when the config row is absent or unusable and the code defaults were used. */
    source: 'config' | 'default';
}

/**
 * game_config['team_records'] - min_games, price_baseline, price_scale - or the code
 * defaults when the row is absent or unusable. Degrades rather than throws: a fresh
 * environment should render team pages at the defaults, not skip them because
 * seed_team_records_config*.sql hasn't run. Each field falls back independently, so a v1
 * row (min_games only) still yields the default price params.
 */
export async function readTeamConfig(sql: SqlReader): Promise<TeamConfig> {
    const defaults: TeamConfig = {
        minGames: DEFAULT_MIN_GAMES,
        priceBaseline: DEFAULT_TEAM_PRICE_BASELINE,
        priceScale: DEFAULT_TEAM_PRICE_SCALE,
        source: 'default',
    };
    try {
        const cfg = await getGameConfigOrNull(sql, TEAM_RECORDS_CONFIG_KEY) as
            { min_games?: unknown; price_baseline?: unknown; price_scale?: unknown } | null;
        if (!cfg) return defaults;
        const num = (v: unknown, ok: (n: number) => boolean, fallback: number) =>
            typeof v === 'number' && Number.isFinite(v) && ok(v) ? v : fallback;
        return {
            minGames: num(cfg.min_games, (n) => Number.isInteger(n) && n >= 1, defaults.minGames),
            priceBaseline: num(cfg.price_baseline, (n) => n > 0, defaults.priceBaseline),
            priceScale: num(cfg.price_scale, (n) => n > 0, defaults.priceScale),
            source: 'config',
        };
    } catch {
        return defaults;
    }
}

/** The gate alone - kept for callers that only need it. */
export async function readMinGames(sql: SqlReader): Promise<{ minGames: number; source: 'config' | 'default' }> {
    const c = await readTeamConfig(sql);
    return { minGames: c.minGames, source: c.source };
}

// -----------------------------------------------------------------------------------
// Readers
// -----------------------------------------------------------------------------------

function iso(v: unknown): string | null {
    if (v === null || v === undefined) return null;
    const d = v instanceof Date ? v : new Date(String(v));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Every settled, team-directional side, one row per club per game. This is
 * TEAM_SIDE_DEDUPE_SQL (team-records.ts) as a tagged template so it flows through
 * sqlPg; the rules it encodes are documented there and must not drift from it.
 */
export async function getTeamSides(sql: SqlReader): Promise<TeamSideRow[]> {
    const rows = await sql`
        SELECT DISTINCT ON (ip.event_id, ip.market_type, ip.side_index)
               ip.event_id, ip.league, ip.subject_team_id, ip.subject_src,
               ip.entry_prob::float8 AS entry_prob,
               (ip.result = 'win') AS won,
               ip.settled_at, ip.kickoff, ip.away, ip.home,
               ip.away_team_id, ip.home_team_id
        FROM index_positions ip
        WHERE ip.market_type = 'moneyline'
          AND ip.result IN ('win', 'loss')
          AND ip.subject_team_id IS NOT NULL
        ORDER BY ip.event_id, ip.market_type, ip.side_index, ip.locked_at, ip.id
    `;
    return rows.map((r) => {
        const teamId = r.subject_team_id as string;
        return {
            eventId: r.event_id as string,
            league: r.league as string,
            teamId,
            opponentTeamId: teamId === r.away_team_id ? (r.home_team_id as string | null) : (r.away_team_id as string | null),
            entryProb: r.entry_prob as number,
            won: r.won as boolean,
            settledAt: iso(r.settled_at),
            kickoff: iso(r.kickoff),
            away: (r.away as string | null) ?? null,
            home: (r.home as string | null) ?? null,
            threeWay: r.subject_src === 'question',
        };
    });
}

export interface TeamFixture {
    eventId: string;
    league: string;
    kickoff: string | null;
    settledAt: string | null;
    away: string | null;
    home: string | null;
    awayTeamId: string | null;
    homeTeamId: string | null;
    /** The club's directional side on this game, if the slate held one. */
    side: { entryProb: number; won: boolean; threeWay: boolean; contrib: number } | null;
}

/**
 * One row per (club, settled game) over BOTH sides of the fixture, LEFT-joined to the
 * club's own deduped moneyline side. Keyed by club id.
 */
export async function getTeamFixtures(sql: SqlReader): Promise<Map<string, TeamFixture[]>> {
    const rows = await sql`
        SELECT DISTINCT ON (g.team_id, g.event_id)
               g.team_id, g.event_id, g.league, g.kickoff, g.settled_at,
               g.away, g.home, g.away_team_id, g.home_team_id,
               s.entry_prob, s.won, s.subject_src
        FROM (
            SELECT ip.event_id, ip.league, ip.kickoff, ip.settled_at, ip.away, ip.home,
                   ip.away_team_id, ip.home_team_id, ip.away_team_id AS team_id
            FROM index_positions ip
            WHERE ip.result IN ('win', 'loss') AND ip.away_team_id IS NOT NULL
            UNION ALL
            SELECT ip.event_id, ip.league, ip.kickoff, ip.settled_at, ip.away, ip.home,
                   ip.away_team_id, ip.home_team_id, ip.home_team_id AS team_id
            FROM index_positions ip
            WHERE ip.result IN ('win', 'loss') AND ip.home_team_id IS NOT NULL
        ) g
        LEFT JOIN LATERAL (
            SELECT ip2.entry_prob::float8 AS entry_prob, (ip2.result = 'win') AS won, ip2.subject_src
            FROM index_positions ip2
            WHERE ip2.event_id = g.event_id
              AND ip2.market_type = 'moneyline'
              AND ip2.result IN ('win', 'loss')
              AND ip2.subject_team_id = g.team_id
            ORDER BY ip2.locked_at, ip2.id
            LIMIT 1
        ) s ON true
        ORDER BY g.team_id, g.event_id, g.settled_at NULLS LAST
    `;
    const out = new Map<string, TeamFixture[]>();
    for (const r of rows) {
        const teamId = r.team_id as string;
        const hasSide = typeof r.entry_prob === 'number';
        const won = hasSide ? (r.won as boolean) : false;
        const fixture: TeamFixture = {
            eventId: r.event_id as string,
            league: r.league as string,
            kickoff: iso(r.kickoff),
            settledAt: iso(r.settled_at),
            away: (r.away as string | null) ?? null,
            home: (r.home as string | null) ?? null,
            awayTeamId: (r.away_team_id as string | null) ?? null,
            homeTeamId: (r.home_team_id as string | null) ?? null,
            side: hasSide
                ? {
                    entryProb: r.entry_prob as number,
                    won,
                    threeWay: r.subject_src === 'question',
                    contrib: contributionFor(won, r.entry_prob as number),
                }
                : null,
        };
        const list = out.get(teamId);
        if (list) list.push(fixture); else out.set(teamId, [fixture]);
    }
    // Newest first, the order every list on the site uses.
    for (const list of out.values()) {
        list.sort((a, b) => (b.kickoff ? Date.parse(b.kickoff) : 0) - (a.kickoff ? Date.parse(a.kickoff) : 0));
    }
    return out;
}

/** id -> display for every club in the registry, for surfaces that only hold a slug. */
export function teamDisplayMap(): Map<string, TeamId> {
    return new Map(allTeams().map((t) => [t.id, t]));
}

// -----------------------------------------------------------------------------------
// Models
// -----------------------------------------------------------------------------------

export interface TeamSeriesPoint {
    occurredAt: string;
    delta: number;
    cumulative: number;
}

export interface TeamPageModel {
    team: TeamId;
    /** Every competition the club appeared in, most fixtures first. */
    leagues: string[];
    /** null when the slate never held a directional side on the club. */
    record: TeamRecord | null;
    fixtures: TeamFixture[];
    fixtureCount: number;
    qualifies: boolean;
    minGames: number;
    /** Running residual over the club's directional games, oldest first. */
    series: TeamSeriesPoint[];
    /**
     * The club's Ember price and event series (team-price.ts). null below the gate - the
     * price is the same information as the residual, exponentiated, so it is withheld on
     * exactly the same terms - and null when the club has no events at all.
     */
    pricing: TeamPricing | null;
}

export function buildTeamPageModel(
    team: TeamId,
    record: TeamRecord | null,
    fixtures: TeamFixture[],
    minGames: number,
    pricing: TeamPricing | null = null,
): TeamPageModel {
    const byLeague = new Map<string, number>();
    for (const f of fixtures) byLeague.set(f.league, (byLeague.get(f.league) ?? 0) + 1);
    const leagues = [...byLeague.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([l]) => l);

    const series: TeamSeriesPoint[] = [];
    if (record) {
        let cumulative = 0;
        const oldestFirst = [...record.games_].sort(
            (a, b) => (a.kickoff ? Date.parse(a.kickoff) : 0) - (b.kickoff ? Date.parse(b.kickoff) : 0),
        );
        for (const g of oldestFirst) {
            cumulative = Number((cumulative + g.contrib).toFixed(3));
            series.push({ occurredAt: g.kickoff ?? g.settledAt ?? '', delta: g.contrib, cumulative });
        }
    }

    const passes = record ? qualifies(record, minGames) : false;
    return {
        team,
        leagues,
        record,
        fixtures,
        fixtureCount: fixtures.length,
        qualifies: passes,
        minGames,
        series,
        pricing: passes && pricing && pricing.eventCount > 0 ? pricing : null,
    };
}

export interface LeagueTile {
    slug: string;
    display: string;
    /** Settled games the club appeared in, in THIS competition - the tile's area. */
    fixtures: number;
    /** The club's directional games, club-wide - what the gate reads. */
    games: number;
    /** Club-wide residual once it clears the gate; null below it (rendered grey). */
    residual: number | null;
    sign: Sign;
    /**
     * The club's Ember price and its points moved per board window, once it clears the
     * gate; null below it. The island picks the board's window with chooseWindowFromSums
     * over these, then colours and quotes each tile by its price return in that window -
     * the index board's rule, applied to clubs.
     */
    price: number | null;
    value: number | null;
    sums: WindowSums | null;
}

export interface LeagueBoardModel {
    league: string;
    slug: string;
    sport: Sport;
    minGames: number;
    priceBaseline: number;
    priceScale: number;
    tiles: LeagueTile[];
    /** Over qualifying tiles only; 0 when none qualify. */
    maxAbsResidual: number;
    /** Distinct settled games in this competition. */
    games: number;
}

export function buildLeagueBoardModel(
    league: string,
    records: Map<string, TeamRecord>,
    fixturesByTeam: Map<string, TeamFixture[]>,
    minGames: number,
    displayOf: Map<string, TeamId>,
    pricing: Map<string, TeamPricing> = new Map(),
    priceParams: { baseline: number; scale: number } = { baseline: DEFAULT_TEAM_PRICE_BASELINE, scale: DEFAULT_TEAM_PRICE_SCALE },
): LeagueBoardModel {
    const tiles: LeagueTile[] = [];
    const events = new Set<string>();
    for (const [teamId, fixtures] of fixturesByTeam) {
        const inLeague = fixtures.filter((f) => f.league === league);
        if (inLeague.length === 0) continue;
        for (const f of inLeague) events.add(f.eventId);
        const record = records.get(teamId) ?? null;
        const ok = record ? qualifies(record, minGames) : false;
        const residual = ok && record ? record.residual : null;
        const p = ok ? pricing.get(teamId) ?? null : null;
        tiles.push({
            slug: teamId,
            display: displayOf.get(teamId)?.display ?? teamId,
            fixtures: inLeague.length,
            games: record?.games ?? 0,
            residual,
            sign: residual === null ? 'zero' : signOf(residual),
            price: p ? p.price : null,
            value: p ? p.value : null,
            sums: p ? p.sums : null,
        });
    }
    // Largest area first so the squarify's descending sort matches the roster's reading
    // order; ties by name for a stable build.
    tiles.sort((a, b) => b.fixtures - a.fixtures || a.display.localeCompare(b.display));
    const maxAbsResidual = tiles.reduce((m, t) => (t.residual === null ? m : Math.max(m, Math.abs(t.residual))), 0);
    return {
        league,
        slug: leagueSlug(league),
        sport: sportOf(league),
        minGames,
        priceBaseline: priceParams.baseline,
        priceScale: priceParams.scale,
        tiles,
        maxAbsResidual,
        games: events.size,
    };
}

/** Roster order for a league page: qualifying clubs by residual, then the rest by fixtures. */
export function rosterOrder(tiles: LeagueTile[]): LeagueTile[] {
    const ranked = tiles.filter((t) => t.residual !== null).sort((a, b) => (b.residual as number) - (a.residual as number) || b.games - a.games || a.display.localeCompare(b.display));
    const rest = tiles.filter((t) => t.residual === null).sort((a, b) => b.fixtures - a.fixtures || a.display.localeCompare(b.display));
    return [...ranked, ...rest];
}
