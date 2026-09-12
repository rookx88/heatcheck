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

export type RuleSide = 'favorite' | 'underdog';

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
export const LEAGUE_GROUPS: Record<string, string[]> = {
    nba: ['NBA'],
    nfl: ['NFL'],
    mlb: ['MLB'],
    soccer: [
        'EPL', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1', 'Champions League',
        'EFL Championship', 'MLS', 'DFB-Pokal', 'Carabao Cup',
    ],
};

/**
 * `'nba_favorite'` -> `{ leagues: ['NBA'], side: 'favorite' }`; null for anything that
 * isn't a league-scoped rule (the global ones - favorite, underdog, heavy_favorite,
 * longshot, total_over, total_under - keep their own explicit cases).
 */
export function parseLeagueRule(ruleType: string): LeagueRule | null {
    const sep = ruleType.lastIndexOf('_');
    if (sep <= 0) return null;
    const prefix = ruleType.slice(0, sep);
    const suffix = ruleType.slice(sep + 1);
    if (suffix !== 'favorite' && suffix !== 'underdog') return null;
    const leagues = LEAGUE_GROUPS[prefix];
    return leagues ? { group: prefix, leagues, side: suffix } : null;
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
