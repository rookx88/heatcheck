// League-scoped index rules: `<league>_favorite` / `<league>_underdog`.
//
// $CHALK and $DOGS score every game in every league. Their children score the same
// thing for one league - $NBACHALK is $CHALK's NBA slice, $MLBDOGS is $DOGS's MLB
// slice.
//
// PARTITION RESTORED (2026-09-12). It had lapsed: the global rules have no league gate,
// so the parents were also scoring the four Tank-less competitions in league-tags.ts
// (EFL Championship, MLS, DFB-Pokal, Carabao Cup) - together ~25% of $CHALK's lifetime
// contribution magnitude - while no child claimed them. All four are soccer, so they
// join the soccer group below and the families add up to their parents again: soccer's
// ten plus nba/nfl/mlb is exactly the thirteen leagues in league-tags.ts.
//
// This DID change what two live indexes measure - $FOOTY and $SOCDOGS now score MLS,
// EFL Championship and the domestic cups - which is why it was a deliberate call rather
// than a derived one (Sammy, 2026-09-12). Settled positions are untouched; the change
// applies to games locked from here on.
//
// LEAGUE_GROUPS stays hand-curated for that reason. Adding a 14th league to
// league-tags.ts means adding it here too, or the parents will score it while no child
// does - the same silent gap this comment used to describe.
//
// This exists as one parser rather than six more hand-written cases because rule types
// are enumerated in FOUR places (checkEligibility, index-slate's three functions, the
// publish-time mirror in backend.ts, and ticker-copy's map). Adding a league by hand
// would mean four edits and four chances to drift; adding one here lights it up
// everywhere. The two rule types that predate this - nfl_favorite and soccer_favorite,
// both live - parse identically here, so nothing shipped changes behaviour.
//
// Pure and dependency-free: no imports, so it runs in a Worker, the static build, a
// client bundle, and the Express admin alike.

// The side a league-scoped rule takes. The two totals sides joined on 2026-09-13 with
// $NFLO/$NFLU, the first children of $OVERS/$UNDERS - every child before them was a slice
// of $CHALK or $DOGS and therefore a moneyline.
//
// These are deliberately spelled 'total_over'/'total_under' and NOT 'over'/'under', to
// match the GLOBAL rule_types of the same meaning. ticker-copy.ts's READ_CLAUSES is keyed
// by rule_type for the global indexes and by rule.side for the children, so sharing the
// spelling means a league child inherits its parent's read line with no new copy and no
// second lookup table.
// The spread and both-teams-to-score sides joined on 2026-09-13, the first sides that
// read a market type the Exchange had never scored. They are spelled with the same
// strings as their global rule_types for the reason given above, so a future
// $NFLCOVER or $EPLBTTS is a pure-SQL migration with no new copy.
export type RuleSide =
    | 'favorite' | 'underdog'
    | 'total_over' | 'total_under'
    | 'spread_favorite' | 'spread_underdog'
    | 'btts_yes' | 'btts_no';

const SIDES = new Set<string>([
    'favorite', 'underdog', 'total_over', 'total_under',
    'spread_favorite', 'spread_underdog', 'btts_yes', 'btts_no',
]);

/** Does this rule take a side of a totals market rather than a moneyline? */
export function isTotalsSide(side: RuleSide): boolean {
    return side === 'total_over' || side === 'total_under';
}

/** The market types an index rule can draw from. */
export type MarketFamily = 'moneyline' | 'totals' | 'spreads' | 'both_teams_to_score';

/**
 * The market type a side reads.
 *
 * EXHAUSTIVE BY CONSTRUCTION - there is no default arm, so adding a RuleSide without a
 * case here is a COMPILE ERROR. That is the whole point of the function existing.
 *
 * Before it did, the league-child arms of BOTH marketTypeForRule and sideForRule ended
 * in a binary ternary - `isTotalsSide(side) ? totals : moneyline` and
 * `side === 'favorite' ? argmax : argmin`. Widening RuleSide would therefore have routed
 * every 'spread_favorite' at the MONEYLINE market and taken the argmin for every
 * 'btts_no', silently, on real money. That is precisely the failure the totals comment
 * in index-slate.ts's sideForRule describes: "a wrong position that settles real Ember -
 * never an error anyone would see". A switch the compiler checks is the only version of
 * this that cannot rot.
 */
export function marketFamilyForSide(side: RuleSide): MarketFamily {
    switch (side) {
        case 'favorite':
        case 'underdog':
            return 'moneyline';
        case 'total_over':
        case 'total_under':
            return 'totals';
        case 'spread_favorite':
        case 'spread_underdog':
            return 'spreads';
        case 'btts_yes':
        case 'btts_no':
            return 'both_teams_to_score';
    }
}

export interface LeagueRule {
    /** The rule_type prefix that named the group: 'nba' | 'nfl' | 'mlb' | 'soccer'. */
    group: string;
    /** The leagues this rule accepts - a single league, or the five soccer ones. */
    leagues: string[];
    side: RuleSide;
}

// Keyed by the rule_type prefix. 'soccer' is the one group that spans several leagues;
// the set mirrors the soccer slate the sync ingests (polymarket.ts's LEAGUE_TAGS).
//
// Champions League joined this set on 2026-09-09. Beyond it being the biggest club
// competition there is, the partition argument in this file's header REQUIRES it: the
// league-scoped children are supposed to cover every league the sync ingests, so a
// family partitions its parent exactly. UCL Tanks already tag $CHALK/$DOGS (the global
// rules below have no league gate at all), so leaving it out of this set would mean a
// Champions League storyline sat in the parent index and in none of its four children -
// the one thing that header promises can't happen.
// Exported so ticker-copy.ts can derive the soccer chips it renders from the same set
// the rule actually gates on, rather than keeping a second copy in sync by hand.
// GRAMMAR RULE, load-bearing: no key here may contain an underscore (parseLeagueRule
// splits on the first one), and no key may ever be named 'spread', 'btts', 'heavy' or
// 'total'. Those four are the prefixes of global rule_types whose suffix IS a valid side
// ('spread_favorite', 'btts_yes', 'heavy_favorite'), so they stay global ONLY because the
// group lookup below rejects them. Naming a league group after one would silently turn a
// global index into a league-scoped one. Asserted in the tickers acceptance suite.
//
// TWO KINDS OF KEY since 2026-09-13. 'soccer' is an AGGREGATE - $FOOTY/$SOCDOGS score
// every soccer league on the board. The single-league keys below it are LEAF groups: the
// level-3 slices that sit under $FOOTY/$SOCDOGS. 'soccer' therefore keeps all ten leagues
// and is NOT reduced to the leaves that happen to have a ticker - ticker-copy.ts derives
// $FOOTY's league chips from it, and $CHALK's partition is at the level-1 -> level-2
// boundary (nba + nfl + mlb + soccer = the thirteen in league-tags.ts), which is
// untouched by anything below.
export const LEAGUE_GROUPS: Record<string, string[]> = {
    nba: ['NBA'],
    nfl: ['NFL'],
    mlb: ['MLB'],
    soccer: [
        'EPL', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1', 'Champions League',
        'EFL Championship', 'MLS', 'DFB-Pokal', 'Carabao Cup',
    ],
    // Leaf soccer groups. The level-3 family under $FOOTY/$SOCDOGS is deliberately
    // PARTIAL - add_tickers_batch4.sql established that a family need not cover its
    // parent ("do NOT read batch3's header as requiring completeness here").
    epl: ['EPL'],
    laliga: ['La Liga'],
    bundesliga: ['Bundesliga'],
    ligue1: ['Ligue 1'],
    mls: ['MLS'],
    efl: ['EFL Championship'],
    // Real competitions with no fixtures on the board right now. Their tickers ship with
    // active=false so they lock nothing and draw nothing; flipping one on is a one-line
    // UPDATE with no code deploy (see add_tickers_batch6.sql).
    ucl: ['Champions League'],
    carabao: ['Carabao Cup'],
    dfb: ['DFB-Pokal'],
    // Serie A deliberately has NO leaf group. Measured 2026-09-13: zero typed game
    // markets EVER, zero moneylines ever, zero rows carrying event_start_time - only
    // season-long futures (Top Goalscorer, 2027 Champion, relegation). It stays in the
    // 'soccer' aggregate above because the RULE would honour it the moment a fixture
    // appeared; what it does not get is a permanently dead tile of its own.
};

/**
 * `'nba_favorite'` -> `{ leagues: ['NBA'], side: 'favorite' }`;
 * `'nfl_total_over'` -> `{ leagues: ['NFL'], side: 'total_over' }`;
 * null for anything that isn't a league-scoped rule (the global ones - favorite,
 * underdog, heavy_favorite, longshot, total_over, total_under - keep their own explicit
 * cases).
 *
 * Splits on the FIRST underscore, not the last, because a side may now contain one
 * ('nfl_total_over' is group 'nfl' + side 'total_over'). That is safe for every rule type
 * precisely because no LEAGUE_GROUPS key contains an underscore, so the two splits agree
 * wherever both apply, and the group lookup rejects the rest:
 *   nfl_favorite / soccer_underdog -> identical split either way
 *   heavy_favorite -> group 'heavy' is not a league group        -> null
 *   total_over     -> side 'over' is not a side, AND group       -> null
 *                     'total' is not a league group (two guards)
 *   favorite / underdog / longshot -> no underscore, sep <= 0    -> null
 * so each of those still falls through to its own explicit case downstream.
 */
export function parseLeagueRule(ruleType: string): LeagueRule | null {
    const sep = ruleType.indexOf('_');
    if (sep <= 0) return null;
    const prefix = ruleType.slice(0, sep);
    const suffix = ruleType.slice(sep + 1);
    if (!SIDES.has(suffix)) return null;
    const leagues = LEAGUE_GROUPS[prefix];
    return leagues ? { group: prefix, leagues, side: suffix as RuleSide } : null;
}

export function leagueRuleAccepts(rule: LeagueRule, league: string | null): boolean {
    return league !== null && rule.leagues.includes(league);
}

// A readable name for the league group, for copy and rejection messages.
export function leagueGroupLabel(rule: LeagueRule): string {
    // Just "soccer" - the group spans continents and tiers now (MLS is not European,
    // the EFL Championship is not top flight, and two are domestic cups), so any tighter
    // phrase is false. This string reaches readers through checkEligibility's rejection
    // reasons, which is why it has now been wrong twice; the plain word cannot go stale.
    return rule.leagues.length === 1 ? rule.leagues[0] : 'soccer';
}

/**
 * Three-letter tag for tight spaces - the board falls back to this when a child's tile
 * is too narrow for its full symbol. Inside $CHALK's box the slice only has to say
 * WHICH league, so 'NBA' carries the same meaning as '$NBACHALK' in a third of the room.
 */
export function leagueShortCode(rule: LeagueRule): string {
    return rule.group.slice(0, 3).toUpperCase();
}
