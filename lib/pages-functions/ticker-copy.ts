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
import { LEAGUE_GROUPS, leagueGroupLabel, parseLeagueRule } from './league-rules';

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
const NFL_LEAGUES = LEAGUE_GROUPS.nfl;

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
    // League slices of the totals pair - the first children $OVERS/$UNDERS have. NFL is
    // the natural place to start: one slate a week, and a league where the total is the
    // number most games are argued over.
    nfl_total_over: {
        leagues: NFL_LEAGUES,
        blurb: 'The NFL slice of the overs. Shootouts and a late score that nobody needed lift it; a defensive Sunday in the wind weighs it down.',
    },
    nfl_total_under: {
        leagues: NFL_LEAGUES,
        blurb: 'The NFL slice of the unders. Field goals, punts and a running clock lift it; a track meet in a dome weighs it down.',
    },
};

// null for an unknown rule_type: every caller falls back to the ticker's own
// description, so a ticker on a brand-new strategy renders plainly rather than blank.
export function tickerCopyFor(ruleType: string): TickerCopy | null {
    return COPY[ruleType] ?? null;
}

// -----------------------------------------------------------------------------------
// The read line - one sentence under the price that says, in words, what the number
// beside it means: what the settled results in the window looked like, and how far the
// index moved on them. Same neutrality contract as the blurbs above: past tense, what
// HAS happened, never a lean on where it goes next, and no probability language.
//
// Keyed on the rule FAMILY (the six global rules); a league child borrows its parent's
// clause with the league named up front, so a new <league>_favorite ticker reads
// correctly with no edit here. An unknown rule type gets a generic clause rather than
// nothing, matching tickerCopyFor's fallback posture.
// -----------------------------------------------------------------------------------

interface ReadClauses {
    up: string;   // what the results looked like on a window the index rose
    down: string; // ...and on one it fell
}

const READ_CLAUSES: Record<string, ReadClauses> = {
    underdog: {
        up: 'the overlooked sides came through more often than not',
        down: 'the overlooked sides mostly missed',
    },
    favorite: {
        up: 'the favored sides mostly took care of business',
        down: 'favorites got rolled more often than not',
    },
    heavy_favorite: {
        up: 'the heaviest favorites on the board held',
        down: 'at least one heavy favorite got stunned',
    },
    longshot: {
        up: 'at least one long-priced side came in',
        down: 'the long-priced sides missed',
    },
    total_over: {
        up: 'more games cleared their totals than stayed under',
        down: 'more games stayed under their totals than cleared them',
    },
    total_under: {
        up: 'more games stayed under their totals than cleared them',
        down: 'more games cleared their totals than stayed under',
    },
};

const GENERIC_CLAUSES: ReadClauses = {
    up: 'the results this index tracks went its way',
    down: 'the results this index tracks went against it',
};

// Below half a tenth of a point the sentence would print "0.0 points" - that is a quiet
// window, and it says so instead (same rounding threshold the result sentences use).
function readPoints(deltaPoints: number): string | null {
    const fixed = Math.abs(deltaPoints).toFixed(1);
    return fixed === '0.0' ? null : fixed;
}

/**
 * `readLineFor('underdog', '$DOGS', 1.2, 'the past 3 days')` ->
 * "Over the past 3 days the overlooked sides came through more often than not; $DOGS is
 * up 1.2 points." windowLabel reads inside "over ..." ('the past 24 hours', 'its whole
 * history'). deltaPoints is the index's POINTS moved in that window (the cumulative
 * series' delta, not the price return).
 */
export function readLineFor(ruleType: string, displayName: string, deltaPoints: number, windowLabel: string): string {
    const points = readPoints(deltaPoints);
    if (points === null) {
        return `No settled results have moved ${displayName} over ${windowLabel}.`;
    }
    const up = deltaPoints > 0;
    const move = `${displayName} is ${up ? 'up' : 'down'} ${points} points.`;

    const global = READ_CLAUSES[ruleType];
    if (global) {
        const clause = up ? global.up : global.down;
        return `Over ${windowLabel} ${clause}; ${move}`;
    }
    const rule = parseLeagueRule(ruleType);
    if (rule) {
        // A child reads its parent's clause, which is why RuleSide is spelled with the
        // same strings as the global rule_types above ('total_over', not 'over'). The
        // fallback is a guard, not a feature: this lookup used to be unguarded, so a side
        // added to league-rules.ts without a clause here threw a TypeError on the index's
        // own detail page rather than degrading to the generic line.
        const parent = READ_CLAUSES[rule.side] ?? GENERIC_CLAUSES;
        const clause = up ? parent.up : parent.down;
        return `In ${leagueGroupLabel(rule)} over ${windowLabel}, ${clause}; ${move}`;
    }
    const clause = up ? GENERIC_CLAUSES.up : GENERIC_CLAUSES.down;
    return `Over ${windowLabel} ${clause}; ${move}`;
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
