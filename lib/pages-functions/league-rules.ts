// League-scoped index rules: `<league>_favorite` / `<league>_underdog`.
//
// $CHALK and $DOGS score every game in every league. Their children score the same
// thing for one league - $NBACHALK is $CHALK's NBA slice, $MLBDOGS is $DOGS's MLB
// slice - and together the four children of each parent cover every league the sync
// ingests, so a family partitions its parent exactly.
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
const LEAGUE_GROUPS: Record<string, string[]> = {
    nba: ['NBA'],
    nfl: ['NFL'],
    mlb: ['MLB'],
    soccer: ['EPL', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1'],
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
    return rule.leagues.length === 1 ? rule.leagues[0] : "Europe's big five";
}

/**
 * Three-letter tag for tight spaces - the board falls back to this when a child's tile
 * is too narrow for its full symbol. Inside $CHALK's box the slice only has to say
 * WHICH league, so 'NBA' carries the same meaning as '$NBACHALK' in a third of the room.
 */
export function leagueShortCode(rule: LeagueRule): string {
    return rule.group.slice(0, 3).toUpperCase();
}
