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
// Pure data + a lookup: no imports, no runtime deps, so this module is safe in a
// Worker, in the static build, and inside a client bundle alike.

export interface TickerCopy {
    leagues: string[]; // rendered as chips; [] means "no league scope to show"
    blurb: string;     // 1-2 sentences, sentence case
}

// Every league the prop sync ingests (lib/pages-functions/polymarket.ts). The soccer
// subset mirrors SOCCER_LEAGUES in tickers.ts - the set $FOOTY's rule actually uses.
const ALL_LEAGUES = ['NFL', 'NBA', 'MLB', 'EPL', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1'];
const SOCCER_LEAGUES = ['EPL', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1'];

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
        blurb: "Tracks the favored side across Europe's big five. It climbs when the pecking order holds, and falls when a giant slips - draws included.",
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
        blurb: "The soccer slice of the underdogs, across Europe's big five. Rides the longest price in each match, so a single giant-killing carries it.",
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
