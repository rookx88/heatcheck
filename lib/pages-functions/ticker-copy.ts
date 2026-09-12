// Reader-facing copy for the Exchange indexes: which sports feed an index, and what
// kind of real-world result moves it. Keyed on rule_type (the eligibility strategy)
// rather than ticker key, so a future ticker that reuses a strategy inherits its copy
// with no code change - the same extensibility contract checkEligibility has.
//
// This is the FRIENDLY layer. tickers.description (the DB column) stays the terse
// one-liner the homepage Market Movers chip shows; these blurbs are what the TANKDAQ
// index pages and the Index Board render. Deliberately no thresholds, no probability
// language, no formulas - a reader should learn what an index reacts to, not how
// eligibility is computed.
//
// Framing rules these strings inherit from the ticker layer (lib/pages-functions/
// tickers.ts): retrospective only - describe what HAS moved an index, never imply
// what will happen next - and never a take on any team, player, or side.
//
// Imports only other dependency-free modules (league-tags.ts, league-rules.ts), so this
// stays safe in a Worker, in the static build, and inside a client bundle alike.

import { SUPPORTED_LEAGUES } from '../../league-tags';
import { LEAGUE_GROUPS } from './league-rules';

export interface TickerCopy {
    leagues: string[]; // rendered as chips; [] means "no league scope to show"
    blurb: string;     // 1-2 sentences, sentence case
}

// DERIVED, never hand-listed (2026-09-11). Both of these used to be literal arrays, and
// both silently went stale: the global indexes score whatever the sync ingests (see
// league-tags.ts's header - index-lock.ts applies no league predicate), so the chips
// advertised 8 leagues while $CHALK was actually scoring 13, including three the copy
// never mentioned. Deriving them means adding a league updates the reader-facing chips
// on its own, which is the only version of this that stays true.
//
// ALL_LEAGUES tracks the global rules' real universe; SOCCER_LEAGUES tracks the exact
// set $FOOTY and $SOCDOGS gate on, so a chip can never claim scope the rule won't honor.
const ALL_LEAGUES = SUPPORTED_LEAGUES;
const SOCCER_LEAGUES = LEAGUE_GROUPS.soccer;

const COPY: Record<string, TickerCopy> = {
    underdog: {
        leagues: ALL_LEAGUES,
        blurb: 'Rides with the side the market counted out. When an overlooked team or player comes through, it climbs; when the expected result lands, it slides.',
    },
    favorite: {
        leagues: ALL_LEAGUES,
        blurb: 'Rides with the side the market expects. It grinds upward on the days the form book holds, and drops when a favorite gets rolled.',
    },
    heavy_favorite: {
        leagues: ALL_LEAGUES,
        blurb: 'The closest things to sure bets on the board. Expected wins barely nudge it - the rare stunner is what really moves it.',
    },
    longshot: {
        leagues: ALL_LEAGUES,
        blurb: 'The long-priced sides nobody has circled. Quiet most days, then one improbable result sends it flying.',
    },
    total_over: {
        leagues: ALL_LEAGUES,
        blurb: 'Follows the Over on game totals. Shootouts, track meets and extra innings lift it; grind-it-out defensive days weigh it down.',
    },
    total_under: {
        leagues: ALL_LEAGUES,
        blurb: 'Follows the Under on game totals. Defensive slugfests and low-scoring draws lift it; scoreboard-melting nights weigh it down.',
    },
    nfl_favorite: {
        leagues: ['NFL'],
        blurb: 'Tracks the side the market favors each week in the NFL. It climbs when the favored teams take care of business, and falls on upset Sundays.',
    },
    soccer_favorite: {
        leagues: SOCCER_LEAGUES,
        blurb: 'Tracks the favored side across every soccer competition on the board - league games, domestic cups and the Champions League alike. It climbs when the pecking order holds, and falls when a giant slips - draws included.',
    },
    // League slices of the two big indexes. Same measure as their parent, one league
    // only - together they cover every league on the board, so a family adds up to the
    // parent it sits inside.
    nba_favorite: {
        leagues: ['NBA'],
        blurb: 'The NBA slice of the favorites. It climbs on nights the better team simply wins, and falls when the league does what the NBA does.',
    },
    nba_underdog: {
        leagues: ['NBA'],
        blurb: "The NBA slice of the underdogs. Rides whoever the market wrote off that night - and the NBA writes off plenty of teams that go on to win.",
    },
    mlb_favorite: {
        leagues: ['MLB'],
        blurb: 'The baseball slice of the favorites. The best team loses constantly in this sport, so it takes more punishment than the others.',
    },
    mlb_underdog: {
        leagues: ['MLB'],
        blurb: 'The baseball slice of the underdogs. A long season of bullpen games and short-priced favorites getting beaten keeps this one interesting.',
    },
    nfl_underdog: {
        leagues: ['NFL'],
        blurb: 'The NFL slice of the underdogs. One Sunday of upsets moves it more than a quiet month does.',
    },
    soccer_underdog: {
        leagues: SOCCER_LEAGUES,
        blurb: 'The soccer slice of the underdogs, across every soccer competition on the board. Rides the longest price in each match, so a single giant-killing carries it.',
    },
};

// null for an unknown rule_type: every caller falls back to the ticker's own
// description, so a ticker on a brand-new strategy renders plainly rather than blank.
export function tickerCopyFor(ruleType: string): TickerCopy | null {
    return COPY[ruleType] ?? null;
}

// "underdog" -> "Underdog Index"; league acronyms stay uppercase ("nfl_favorite" ->
// "NFL Favorite Index"). Lives here rather than in market-movers.ts so the client
// bundles can use it without pulling in that module's SSR string builders;
// market-movers.ts re-exports it for its existing callers.
const ACRONYM_WORDS = new Set(['nfl', 'nba', 'mlb', 'epl']);
export function indexLabelOf(ruleType: string): string {
    const words = ruleType.split('_')
        .map((w) => (ACRONYM_WORDS.has(w) ? w.toUpperCase() : w ? w[0].toUpperCase() + w.slice(1) : w))
        .join(' ');
    return `${words} Index`;
}
