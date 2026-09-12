// ===================================================================================
// HEATCHECKS - LEAGUE -> POLYMARKET TAG CATALOG (league-tags.ts)
// ===================================================================================
// THE list of leagues this product knows about. Extracted from polymarket.ts on
// 2026-09-11 so it can be a single source of truth rather than a constant that
// reader-facing copy has to re-declare by hand.
//
// Kept dependency-free like sport-map.ts / tank-types.ts / tank-deck-format.ts, so it's
// importable from client islands, scripts/, the Workers runtime (lib/pages-functions)
// AND the Express admin alike. polymarket.ts re-exports both symbols, so every existing
// `from './polymarket'` import keeps working unchanged.
//
// WHY THIS MATTERS MORE THAN IT LOOKS: adding a key here is not a passive registration.
// functions/api/index-lock.ts selects Exchange index candidates straight out of
// polymarket_props with NO league predicate, and index-slate.ts's leagueQualifies()
// returns true for every global rule. So a league added here automatically starts
// scoring $CHALK, $DOGS, $LOCKS, $MOONSHOT, $OVERS and $UNDERS as soon as the sync
// ingests it - measured 2026-09-11, the four "menu-only" competitions below were
// already 25% of $CHALK's lifetime contribution magnitude. That is intended (confirmed
// by Sammy 2026-09-11: the global indexes should score every match Polymarket carries
// for every league we sync), but it is why ticker-copy.ts now DERIVES its reader-facing
// league chips from SUPPORTED_LEAGUES instead of re-listing them - the two drifted
// silently for weeks before this split.
//
// The league-SCOPED indexes ($FOOTY, $NBACHALK, ...) are the exception: they gate on
// lib/pages-functions/league-rules.ts's LEAGUE_GROUPS, which stays hand-curated.
// ===================================================================================

// Canonical league name -> Polymarket tag_slug(s) that carry that league's markets.
// Soccer is split across its major leagues since Polymarket has no single umbrella tag
// with full coverage; naming matches the league strings already used across the app.
export const LEAGUE_TAGS: Record<string, string[]> = {
    'NBA': ['nba'],
    'NFL': ['nfl'],
    'MLB': ['mlb'],
    'EPL': ['epl'],
    'La Liga': ['la-liga'],
    'Serie A': ['serie-a'],
    'Bundesliga': ['bundesliga'],
    'Ligue 1': ['ligue-1'],
    // The UEFA Champions League league phase. The tag is 'ucl', NOT 'champions-league'
    // or 'uefa-champions-league' - both of those exist and both are the wrong thing:
    // 'champions-league' carries only season futures (2027 Champion, Top Scorer, League
    // Phase awards), and 'uefa-champions-league' carries *domestic* "team to qualify for
    // next season's UCL" markets hanging off EPL/LaLiga/etc. Only 'ucl' has fixtures.
    //
    // Unlike the eight above, Polymarket publishes UCL fixtures only for the imminent
    // matchday - probed 2026-09-09, the tag held MD1 (Sept 9-10) and nothing else, while
    // EPL was posted 11 days out. Since the league phase runs ~8 matchdays between
    // September and January, expect this league to be EMPTY on most days and to arrive in
    // bursts. That is normal, not a broken tag.
    'Champions League': ['ucl'],
    // The four below carry no TANK COVERAGE - they're deliberately absent from
    // functions/api/curate.ts's SPORT_GROUPS and sport-map.ts, so they never produce a
    // Tank page or a homepage slot. Don't "fix" that asymmetry by adding them to curate:
    // that spends Anthropic credits generating articles for lower-profile matches.
    //
    // They ARE Exchange index constituents, via the slate - see this file's header. An
    // earlier version of this comment claimed they "never produce a ticker constituent",
    // which was true when written and became false when the slate (index_positions,
    // 2026-08-31) replaced Tank tags as the results leg. Corrected 2026-09-11.
    //
    // They exist because the leagues above all go dark together during international
    // breaks and the NBA/NFL offseason, leaving /pvp and Community Pick search with
    // nothing to offer; these keep playing through it (the EFL Championship alone
    // carried 56 games inside 24h on the day this was added).
    'EFL Championship': ['efl-championship'],
    'MLS': ['mls'],
    'DFB-Pokal': ['dfb-pokal'],
    'Carabao Cup': ['carabao-cup'],
    // Coppa Italia is NOT here on purpose: Polymarket has no tag carrying it (probed
    // 'coppa-italia' -> 0 events). Europa League is likewise absent: as of 2026-09-09
    // 'europa-league' still carries only season futures, and 'conference-league' returns
    // 0 events. Recheck both once their league phases start - if a fixture-carrying tag
    // appears it slots in exactly like 'ucl' above.
};

export const SUPPORTED_LEAGUES = Object.keys(LEAGUE_TAGS);
