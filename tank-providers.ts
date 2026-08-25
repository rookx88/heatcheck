// ===================================================================================
// HEATCHECKS TANK — STAGE 1 PROP PROVIDERS (tank-providers.ts)
// ===================================================================================
// PropProvider is the pluggable seam: MockProvider ships fixed sample data, the real
// Polymarket adapter (a cache read, never a live Polymarket call) drops in behind the
// exact same interface. Selected at runtime via PROP_PROVIDER.
// ===================================================================================

import type { Pool } from 'pg';
import type { Game, Prop, PropProvider } from './tank-types';
import { parseKalshiTickerKickoff } from './kalshi';

// --- Mock provider -------------------------------------------------------------------

// Market keys mirror the real adapter's naming convention (Polymarket's own
// sportsMarketType strings, e.g. "baseball_player_home_runs") so marketWhitelist
// config works unchanged when swapping providers.
const MOCK_GAMES: Game[] = [
    {
        id: 'mock-nba-lal-bos',
        league: 'NBA',
        away: 'Los Angeles Lakers',
        home: 'Boston Celtics',
        kickoff: '2026-08-15T23:30:00Z',
        settleDate: '2026-08-16T02:00:00Z',
        props: [
            { id: 'mock-p1', player: 'LeBron James', team: 'Los Angeles Lakers', market: 'basketball_player_points', line: 25.5, prominence: 95, odds: { outcomes: ['Over', 'Under'], outcomePrices: [0.52, 0.48] } },
            { id: 'mock-p2', player: 'Jayson Tatum', team: 'Boston Celtics', market: 'basketball_player_points', line: 28.5, prominence: 92, odds: { outcomes: ['Over', 'Under'], outcomePrices: [0.55, 0.45] } },
            { id: 'mock-p3', player: 'LeBron James', team: 'Los Angeles Lakers', market: 'basketball_player_assists', line: 7.5, prominence: 60, odds: { outcomes: ['Over', 'Under'], outcomePrices: [0.5, 0.5] } },
            { id: 'mock-p4', player: 'Anthony Davis', team: 'Los Angeles Lakers', market: 'basketball_player_rebounds', line: 10.5, prominence: 55, odds: { outcomes: ['Over', 'Under'], outcomePrices: [0.48, 0.52] } },
        ],
    },
    {
        id: 'mock-nfl-buf-kc',
        league: 'NFL',
        away: 'Buffalo Bills',
        home: 'Kansas City Chiefs',
        kickoff: '2026-08-16T20:20:00Z',
        settleDate: '2026-08-16T23:45:00Z',
        props: [
            { id: 'mock-p5', player: 'Patrick Mahomes', team: 'Kansas City Chiefs', market: 'football_player_passing_yards', line: 275.5, prominence: 97, odds: { outcomes: ['Over', 'Under'], outcomePrices: [0.51, 0.49] } },
            { id: 'mock-p6', player: 'Josh Allen', team: 'Buffalo Bills', market: 'football_player_passing_yards', line: 260.5, prominence: 94, odds: { outcomes: ['Over', 'Under'], outcomePrices: [0.53, 0.47] } },
            { id: 'mock-p7', player: 'Travis Kelce', team: 'Kansas City Chiefs', market: 'football_player_anytime_td', line: null, prominence: 70, odds: { outcomes: ['Yes', 'No'], outcomePrices: [0.42, 0.58] } },
        ],
    },
    {
        id: 'mock-mlb-nyy-bos',
        league: 'MLB',
        away: 'New York Yankees',
        home: 'Boston Red Sox',
        kickoff: '2026-08-15T23:05:00Z',
        settleDate: '2026-08-16T02:00:00Z',
        props: [
            { id: 'mock-p8', player: 'Aaron Judge', team: 'New York Yankees', market: 'baseball_player_home_runs', line: 0.5, prominence: 96, odds: { outcomes: ['Over', 'Under'], outcomePrices: [0.38, 0.62] } },
            { id: 'mock-p9', player: 'Rafael Devers', team: 'Boston Red Sox', market: 'baseball_player_hits', line: 1.5, prominence: 65, odds: { outcomes: ['Over', 'Under'], outcomePrices: [0.45, 0.55] } },
        ],
    },
    {
        id: 'mock-epl-ars-che',
        league: 'EPL',
        away: 'Arsenal',
        home: 'Chelsea',
        kickoff: '2026-08-16T15:00:00Z',
        settleDate: '2026-08-16T16:45:00Z',
        props: [
            { id: 'mock-p10', player: 'Bukayo Saka', team: 'Arsenal', market: 'soccer_player_anytime_scorer', line: null, prominence: 88, odds: { outcomes: ['Yes', 'No'], outcomePrices: [0.4, 0.6] } },
            { id: 'mock-p11', player: 'Cole Palmer', team: 'Chelsea', market: 'soccer_player_shots_on_target', line: 1.5, prominence: 62, odds: { outcomes: ['Over', 'Under'], outcomePrices: [0.47, 0.53] } },
        ],
    },
    {
        id: 'mock-nba-den-mia',
        league: 'NBA',
        away: 'Denver Nuggets',
        home: 'Miami Heat',
        kickoff: '2026-08-17T23:00:00Z',
        settleDate: '2026-08-18T01:30:00Z',
        props: [
            { id: 'mock-p12', player: 'Nikola Jokic', team: 'Denver Nuggets', market: 'basketball_player_points', line: 26.5, prominence: 93, odds: { outcomes: ['Over', 'Under'], outcomePrices: [0.5, 0.5] } },
            { id: 'mock-p13', player: 'Nikola Jokic', team: 'Denver Nuggets', market: 'basketball_player_triple_double', line: null, prominence: 58, odds: { outcomes: ['Yes', 'No'], outcomePrices: [0.35, 0.65] } },
        ],
    },
];

export function createMockProvider(): PropProvider {
    return {
        async fetchProps(): Promise<Game[]> {
            // Deep copy so callers can't mutate the shared fixture.
            return JSON.parse(JSON.stringify(MOCK_GAMES));
        },
    };
}

// --- Polymarket provider ---------------------------------------------------------------

export interface PolymarketPropsRow {
    league: string;
    event_id: string | null;
    event_slug: string;
    event_title: string | null;
    event_start_time: string | null;
    event_end_date: string | null;
    event_teams: { name: string; abbreviation?: string; ordering?: string }[] | null;
    market_id: string;
    // This market's own endDate, distinct from event_end_date above - see Prop.settleDate
    // in tank-types.ts for why the distinction matters. Optional: the cached-DB provider
    // path (createPolymarketPropProvider) doesn't currently select this column, so it
    // falls back to the event-level date same as before for that path.
    market_end_date?: string | null;
    subject_name: string | null;
    market_type: string | null;
    market_line: string | null;
    outcomes: string[] | null;
    outcome_prices: string[] | null;
    volume: string | null;
    liquidity: string | null;
    question: string | null;
    is_player_prop: boolean;
}

// Team/game-level markets (as opposed to per-player stat props). Polymarket tags these
// with generic, sport-agnostic type strings - the same "moneyline" string appears under
// NFL and EPL alike, so leagues stay disambiguated by the row's own `league` column, not
// by this list.
export const GAME_LINE_MARKET_TYPES = ['moneyline', 'spreads', 'totals', 'team_totals'];

// Season-long futures ("Will Saquon Barkley have 1,499.5+ rushing yards in the 2026-27
// season?") never carry a sportsMarketType from Polymarket and don't follow the
// "Subject: Stat O/U line" shape real per-game player props use, so they need their own
// detection. Some rows use unresolved placeholder names ("Player 16") for
// not-yet-finalized candidate slots on leaderboard/award markets - those are excluded
// since there's no real subject to write about.
const SEASON_FUTURES_PATTERN = /^Will\s+(.+?)\s+(?:have|win|be)\b/i;

// A smaller slice of futures markets are phrased as a status question instead of
// "Will X ..." (e.g. "Mike Vrabel out as Patriots Head Coach by Dec 31, 2026?", "Joe
// Burrow traded to the Jets?"). Case matters here (unlike SEASON_FUTURES_PATTERN) -
// the capitalized-word run is how a real subject name is distinguished from a
// question that just happens to start with a capitalized non-name phrase.
const STATUS_TRIGGER_PATTERN = /^(?:Pro Football:\s*)?([A-Z][\w.'-]+(?:\s+[A-Z][\w.'-]+){1,2})\s+(?:out as|traded|to join|to sign|to [Pp]lay|rostered)\b/;
const PLACEHOLDER_NAME_PATTERN = /^Player\s+[\dA-Z]+$/i;

// No direct "prominence" signal exists on Polymarket; approximate it as a 0-99
// percentile rank of (volume + liquidity) among the other props in the same game,
// which is exactly the scope prominence is used for (pre-filtering, not display).
export function computeProminenceRanks(scores: number[]): number[] {
    const n = scores.length;
    if (n <= 1) return scores.map(() => 99);
    const sortedIndices = scores.map((_, i) => i).sort((a, b) => scores[a] - scores[b]);
    const ranks = new Array(n).fill(0);
    sortedIndices.forEach((originalIndex, rank) => {
        ranks[originalIndex] = Math.round((rank / (n - 1)) * 99);
    });
    return ranks;
}

// Classification + grouping, shared by createPolymarketPropProvider (rows read from the
// polymarket_props cache) and tank-gamma-live.ts's fetchLiveGames (rows built fresh from
// a live Gamma API response) - kept as one function so the two paths can't quietly drift
// on which markets count as a player prop / game-line / season-futures, or on how
// prominence is computed.
export function buildGamesFromFlatProps(rows: PolymarketPropsRow[]): Game[] {
    const byEvent = new Map<string, PolymarketPropsRow[]>();
    for (const row of rows) {
        let market: string;
        let subject: string | null;

        if (row.is_player_prop) {
            market = row.market_type || 'unknown';
            subject = row.subject_name;
        } else if (row.market_type && GAME_LINE_MARKET_TYPES.includes(row.market_type)) {
            market = row.market_type;
            subject = row.subject_name;
        } else {
            const question = row.question || '';
            const match = question.match(SEASON_FUTURES_PATTERN) || question.match(STATUS_TRIGGER_PATTERN);
            const name = match ? match[1].trim() : null;
            if (!name || PLACEHOLDER_NAME_PATTERN.test(name)) continue; // no real subject to write about
            market = 'season_futures';
            subject = name;
        }

        const key = row.event_id || row.event_slug;
        if (!byEvent.has(key)) byEvent.set(key, []);
        byEvent.get(key)!.push({ ...row, market_type: market, subject_name: subject });
    }

    const games: Game[] = [];
    for (const [eventKey, eventRows] of byEvent) {
        const first = eventRows[0];
        const teams = first.event_teams || [];
        const hasTeams = teams.length > 0;
        const away = hasTeams ? (teams.find(t => t.ordering === 'away')?.name || teams[0]?.name || 'Away') : first.league;
        const home = hasTeams ? (teams.find(t => t.ordering === 'home')?.name || teams[1]?.name || 'Home') : (first.event_title || 'Season Futures');
        const kickoff = first.event_start_time || first.event_end_date || new Date().toISOString();
        const settleDate = first.event_end_date || first.event_start_time || kickoff;

        const scores = eventRows.map(r => (Number(r.volume) || 0) + (Number(r.liquidity) || 0));
        const prominences = computeProminenceRanks(scores);

        // Whole-game markets ("Colts vs. Patriots" moneyline) have no "Subject:"
        // prefix to extract a name from - the matchup itself is the subject.
        const matchupFallback = hasTeams ? `${away} vs. ${home}` : (first.event_title || 'Unknown');

        const props: Prop[] = eventRows.map((row, i) => ({
            id: row.market_id,
            player: row.subject_name || matchupFallback,
            team: null, // not derivable per-player from Polymarket's event/market payload
            market: row.market_type || 'unknown',
            line: row.market_line !== null ? Number(row.market_line) : null,
            prominence: prominences[i],
            odds: row.outcomes && row.outcome_prices
                ? { outcomes: row.outcomes, outcomePrices: row.outcome_prices.map(Number) }
                : null,
            settleDate: row.market_end_date || undefined,
        }));

        games.push({
            id: eventKey,
            league: first.league,
            away,
            home,
            kickoff,
            settleDate,
            props,
        });
    }

    return games;
}

export function createPolymarketPropProvider(pool: Pool): PropProvider {
    return {
        async fetchProps(): Promise<Game[]> {
            const result = await pool.query<PolymarketPropsRow>(
                `SELECT league, event_id, event_slug, event_title, event_start_time, event_end_date,
                        event_teams, market_id, subject_name, market_type, market_line,
                        outcomes, outcome_prices, volume, liquidity, question, is_player_prop
                 FROM polymarket_props
                 WHERE closed IS DISTINCT FROM TRUE
                   AND (
                       is_player_prop = TRUE
                       OR market_type = ANY($1)
                       OR market_type IS NULL
                   )
                 ORDER BY event_id`,
                [GAME_LINE_MARKET_TYPES]
            );

            return buildGamesFromFlatProps(result.rows);
        },
    };
}

// --- Kalshi provider ---------------------------------------------------------------
// Kalshi is the player-prop source (see kalshi.ts's header); Polymarket keeps supplying
// game-lines/season-futures. This section mirrors the Polymarket provider section above
// in shape (a flat-row type + a shared classification builder + a factory function),
// but is a separate implementation, not a generalization of buildGamesFromFlatProps -
// Kalshi's ladder-of-thresholds shape and Polymarket's single-O/U-market shape don't
// share enough structure for one function to classify both without indirection.

export interface KalshiPropsRow {
    league: string;
    event_ticker: string;
    event_title: string | null;
    away: string | null;
    home: string | null;
    market_ticker: string;
    subject_name: string | null;
    subject_key: string | null;
    market_key: string;
    shape: string; // 'ladder' | 'binary'
    floor_strike: string | null;
    yes_prob: string | null;
    volume: string | null;
    open_interest: string | null;
    close_time: string | null;
    occurrence_time: string | null;
}

// Collapses Kalshi's threshold-ladder markets (multiple binary Yes/No contracts per
// player+stat, e.g. "75+"/"50+"/"100+" passing yards) into one representative Prop per
// player+game+stat, and groups props into Games by event_ticker. Shared by the
// cached-DB path (createKalshiPropProvider) and kalshi-live.ts's live-fetch path, the
// same reason buildGamesFromFlatProps above is shared - so the two paths can't drift.
export function buildGamesFromKalshiFlatProps(rows: KalshiPropsRow[]): Game[] {
    // Step 1: group rows by (event, market, subject) - this is the ladder collapse
    // grouping key. subject_key (Kalshi's own opaque player UUID from custom_strike)
    // is exact and stable; subject_name/market_ticker are fallbacks only for rows that
    // somehow lack it.
    const groups = new Map<string, KalshiPropsRow[]>();
    for (const row of rows) {
        const subject = row.subject_key || row.subject_name || row.market_ticker;
        const key = `${row.event_ticker}::${row.market_key}::${subject}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(row);
    }

    interface CollapsedProp {
        eventTicker: string; league: string; away: string | null; home: string | null;
        marketTicker: string; subjectName: string | null; marketKey: string; isLadder: boolean;
        line: number | null; yesProb: number; volume: number; closeTime: string | null; occurrenceTime: string | null;
    }

    const collapsed: CollapsedProp[] = [];
    for (const groupRows of groups.values()) {
        const first = groupRows[0];
        const isLadder = first.shape === 'ladder';

        // For a ladder, pick the rung whose yes-probability sits closest to 0.5 - the
        // rung a sportsbook's own O/U line would land at. A binary series only ever
        // has one rung (anytime TD, anytime goalscorer, ...), nothing to pick between.
        const selected = isLadder
            ? groupRows.reduce((best, r) => {
                const p = r.yes_prob !== null ? Number(r.yes_prob) : 0.5;
                const bestP = best.yes_prob !== null ? Number(best.yes_prob) : 0.5;
                return Math.abs(p - 0.5) < Math.abs(bestP - 0.5) ? r : best;
            }, groupRows[0])
            : first;

        const yesProb = selected.yes_prob !== null ? Number(selected.yes_prob) : 0.5;
        const line = isLadder && selected.floor_strike !== null ? Number(selected.floor_strike) : null;
        // volume+open_interest summed across every rung in the group, not just the
        // selected one - prominence should reflect the player+stat's total market
        // interest, not just whichever single rung happened to land closest to 50%.
        const volume = groupRows.reduce((sum, r) => sum + (Number(r.volume) || 0) + (Number(r.open_interest) || 0), 0);

        collapsed.push({
            eventTicker: first.event_ticker, league: first.league, away: first.away, home: first.home,
            marketTicker: selected.market_ticker, subjectName: selected.subject_name, marketKey: first.market_key,
            isLadder, line, yesProb, volume,
            closeTime: selected.close_time, occurrenceTime: selected.occurrence_time,
        });
    }

    // Step 2: group collapsed props into Games by event_ticker.
    const byEvent = new Map<string, CollapsedProp[]>();
    for (const p of collapsed) {
        if (!byEvent.has(p.eventTicker)) byEvent.set(p.eventTicker, []);
        byEvent.get(p.eventTicker)!.push(p);
    }

    const games: Game[] = [];
    for (const [eventTicker, props] of byEvent) {
        const first = props[0];
        const away = first.away || first.league;
        const home = first.home || 'Kalshi Game';
        // occurrence_time is the actual game start (see kalshi.ts's KalshiMarket
        // comment) - distinct from close_time, which is when each individual market
        // stops trading and is used for settleDate instead, matching Prop.settleDate's
        // "this market's own resolution deadline" contract in tank-types.ts.
        //
        // Cross-checked against the event ticker's own encoded date/time
        // (parseKalshiTickerKickoff) and the EARLIER of the two wins - occurrence_time
        // has been observed wrong-and-later on a live market (see that function's
        // comment), which let a pick land after the real game had already started.
        // Taking the minimum can only make the picks-close cutoff more conservative,
        // never less, so this is safe even when occurrence_time is correct.
        const occurrenceKickoff = props.map(p => p.occurrenceTime).filter((t): t is string => !!t).sort()[0] || null;
        const tickerKickoff = parseKalshiTickerKickoff(eventTicker);
        const kickoffCandidates = [occurrenceKickoff, tickerKickoff]
            .filter((t): t is string => !!t)
            .map(t => new Date(t).getTime())
            .filter(t => !Number.isNaN(t));
        const kickoff = kickoffCandidates.length > 0
            ? new Date(Math.min(...kickoffCandidates)).toISOString()
            : new Date().toISOString();
        const settleDate = props.map(p => p.closeTime).filter((t): t is string => !!t).sort().slice(-1)[0] || kickoff;

        const scores = props.map(p => p.volume);
        const prominences = computeProminenceRanks(scores);

        const matchupFallback = `${away} vs. ${home}`;
        const propsOut: Prop[] = props.map((p, i) => ({
            id: p.marketTicker,
            player: p.subjectName || matchupFallback,
            team: null, // not derivable per-player from Kalshi's event/market payload, same limitation Polymarket has
            market: p.marketKey,
            line: p.line,
            prominence: prominences[i],
            odds: { outcomes: p.isLadder ? ['Over', 'Under'] : ['Yes', 'No'], outcomePrices: [p.yesProb, 1 - p.yesProb] },
            settleDate: p.closeTime || undefined,
        }));

        games.push({
            id: `kalshi:${eventTicker}`,
            league: first.league,
            away, home, kickoff, settleDate,
            props: propsOut,
        });
    }

    return games;
}

export function createKalshiPropProvider(pool: Pool): PropProvider {
    return {
        async fetchProps(): Promise<Game[]> {
            const result = await pool.query<KalshiPropsRow>(
                `SELECT league, event_ticker, event_title, away, home, market_ticker,
                        subject_name, subject_key, market_key, shape, floor_strike, yes_prob,
                        volume, open_interest, close_time, occurrence_time
                 FROM kalshi_props
                 WHERE status IS DISTINCT FROM 'finalized'
                 ORDER BY event_ticker`
            );

            return buildGamesFromKalshiFlatProps(result.rows);
        },
    };
}

function normalizeTeamName(name: string): string {
    return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Merges Polymarket's non-player-prop Games (game-lines/season-futures - Kalshi player
// props are filtered out of Polymarket's contribution the same way curate.ts does it,
// via the "_player_" substring PLAYER_MARKET_TYPE_PATTERN already relies on) with
// Kalshi's player-prop Games. Merge key is (league, normalized away+home), not event
// id - the two sources have unrelated id spaces. A matchup found in both sources merges
// into one Game entry; an unmatched Kalshi game (no Polymarket game-line coverage for
// that matchup, or team-name formatting didn't line up) stays as its own separate Game
// entry rather than being dropped - worst case is a curator sees two rows for the same
// matchup, never silent data loss.
export function createComposedPropProvider(pool: Pool): PropProvider {
    return {
        async fetchProps(): Promise<Game[]> {
            const [polymarketGames, kalshiGames] = await Promise.all([
                createPolymarketPropProvider(pool).fetchProps(),
                createKalshiPropProvider(pool).fetchProps(),
            ]);

            const polymarketNonPlayerGames = polymarketGames
                .map(g => ({ ...g, props: g.props.filter(p => !p.market.includes('_player_')) }))
                .filter(g => g.props.length > 0);

            const merged: Game[] = [];
            const usedKalshiIndices = new Set<number>();

            for (const pmGame of polymarketNonPlayerGames) {
                const pmAway = normalizeTeamName(pmGame.away);
                const pmHome = normalizeTeamName(pmGame.home);
                const matchIndex = kalshiGames.findIndex((kg, i) =>
                    !usedKalshiIndices.has(i) &&
                    kg.league === pmGame.league &&
                    normalizeTeamName(kg.away) === pmAway &&
                    normalizeTeamName(kg.home) === pmHome
                );
                if (matchIndex !== -1) {
                    usedKalshiIndices.add(matchIndex);
                    merged.push({ ...pmGame, props: [...pmGame.props, ...kalshiGames[matchIndex].props] });
                } else {
                    merged.push(pmGame);
                }
            }

            kalshiGames.forEach((kg, i) => {
                if (!usedKalshiIndices.has(i)) merged.push(kg);
            });

            return merged;
        },
    };
}

// --- Factory -------------------------------------------------------------------------

export function getPropProvider(pool: Pool): PropProvider {
    const which = (process.env.PROP_PROVIDER || 'mock').toLowerCase();
    if (which === 'polymarket') return createPolymarketPropProvider(pool);
    if (which === 'kalshi') return createKalshiPropProvider(pool);
    if (which === 'both') return createComposedPropProvider(pool);
    return createMockProvider();
}
