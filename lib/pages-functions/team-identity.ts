// Canonical team identity for the Exchange slate: one stable id per CLUB, resolved from
// the raw Polymarket strings that index-lock freezes onto index_positions. Pure and
// dependency-free - no DB, no DOM, no fetch - so the same resolver runs in the lock
// Pages Function, the static build, and the backfill script alike. Sharing it is the
// point: a team resolved two ways would eventually disagree, and a team page is an
// aggregate, so a disagreement silently splits a club's record in half.
//
// WHY AN EXPLICIT TABLE AND NOT A NORMALIZER. Three attempts at fuzzy team matching
// already exist in this repo and all three failed: scripts/data/oddsapi-team-mapping.json
// was never finished and is still an identity map (its 'Chelsea' doesn't match
// Polymarket's 'Chelsea FC'), backend.ts's findOrCreateTeam INSERTs a new row when its
// LIKE probe misses (so the legacy teams table has accumulated near-duplicates), and
// scripts/check-team-id-mismatch.ts exists precisely BECAUSE the soccerdata regex matcher
// returned wrong ids. No regex survives 'BV Borussia 09 Dortmund', '1. FSV Mainz 05' and
// 'RCD Espanyol de Barcelona' in the same pass. The table below is hand-curated,
// additive-only, and the resolver returns null rather than guessing.
//
// Three separate normalizeTeamName implementations exist and NONE is the right seed for
// this file. The richest (backend.ts:1000, a closure inside an Express route - not
// exported, and unreachable from the Workers runtime) strips a leading
// (sv|tsg|fc|sc|cf|ac|as|rc|ud|cd|real|athletic|club), which collapses 'Real Madrid CF'
// to 'madrid', 'Real Salt Lake' to 'salt lake' and 'Athletic Club' to 'club', and it
// folds no diacritics. The others are tank-providers.ts:447 (a one-line fuzzy join key
// for the Kalshi merge) and a SQL regex against a different database. All three are
// MATCHING normalizers - lossy keys for joining two lists - and a lossy key is exactly
// the wrong thing for an identity that names a URL. teamSlug below normalizes only the
// display strings WE choose; the lookup itself is exact.
//
// WHY IDENTITY IS CLUB-SCOPED AND NOT LEAGUE-SCOPED. 'Chelsea FC' already arrives under
// two league tags (EPL and Carabao Cup), and Polymarket's tagging is not reliable beyond
// that - 'Hull City AFC' arrives tagged EPL and 'West Ham United FC' tagged EFL
// Championship, neither of which is where those clubs play. Keying identity on the league
// would shard one club's record across several pages and would inherit every tagging
// error. So the lookup is on the raw NAME, which is globally unambiguous in the live
// data, and `league` is accepted only as a disambiguator for a future genuine collision
// (two distinct clubs sharing a string). Competition is a facet of a game, never part of
// a club's identity.

import { isDrawMarket, parseYesNoQuestion } from './index-slate';

export interface TeamId {
    /** Stable slug, also the URL segment: 'borussia-dortmund'. */
    id: string;
    /** What a reader is shown: 'Borussia Dortmund'. */
    display: string;
}

// Diacritic-folding kebab-case. NFKD splits 'e-acute' into 'e' plus a combining mark,
// which the ̀-ͯ strip then removes - so 'CF Montreal' (with the accent) slugs
// to 'cf-montreal' rather than losing the character entirely. Deliberately NOT
// tank-providers.ts's normalizeTeamName (that is a fuzzy join key, and it turns the
// accented form into two tokens) and not deriveTeamCode (which strips club tokens as a
// suffix only, mangling the 'CF Montreal' prefix form).
export function teamSlug(display: string): string {
    return display
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

// Raw Polymarket event_teams[].name -> the display name a reader gets. Every key is a
// string observed in live index_positions data; the value is the club's common name with
// the corporate form dropped ('Arsenal FC' -> 'Arsenal', 'AJ Auxerre' -> 'Auxerre'), kept
// only where it is genuinely part of how the club is known ('Paris FC', 'San Diego FC').
// The id is derived from the display via teamSlug, so the two can never drift.
//
// ADDING ENTRIES: append only. Changing a display string changes that club's slug, which
// changes its URL - do that only deliberately, and add a redirect.
const CLUB_DISPLAY: Record<string, string> = {
    // --- MLB (raw names are already the common form) ---------------------------------
    'Arizona Diamondbacks': 'Arizona Diamondbacks',
    'Athletics': 'Athletics',
    'Atlanta Braves': 'Atlanta Braves',
    'Baltimore Orioles': 'Baltimore Orioles',
    'Boston Red Sox': 'Boston Red Sox',
    'Chicago Cubs': 'Chicago Cubs',
    'Chicago White Sox': 'Chicago White Sox',
    'Cincinnati Reds': 'Cincinnati Reds',
    'Cleveland Guardians': 'Cleveland Guardians',
    'Colorado Rockies': 'Colorado Rockies',
    'Detroit Tigers': 'Detroit Tigers',
    'Houston Astros': 'Houston Astros',
    'Kansas City Royals': 'Kansas City Royals',
    'Los Angeles Angels': 'Los Angeles Angels',
    'Los Angeles Dodgers': 'Los Angeles Dodgers',
    'Miami Marlins': 'Miami Marlins',
    'Milwaukee Brewers': 'Milwaukee Brewers',
    'Minnesota Twins': 'Minnesota Twins',
    'New York Mets': 'New York Mets',
    'New York Yankees': 'New York Yankees',
    'Philadelphia Phillies': 'Philadelphia Phillies',
    'Pittsburgh Pirates': 'Pittsburgh Pirates',
    'San Diego Padres': 'San Diego Padres',
    'San Francisco Giants': 'San Francisco Giants',
    'Seattle Mariners': 'Seattle Mariners',
    'St. Louis Cardinals': 'St. Louis Cardinals',
    'Tampa Bay Rays': 'Tampa Bay Rays',
    'Texas Rangers': 'Texas Rangers',
    'Toronto Blue Jays': 'Toronto Blue Jays',
    'Washington Nationals': 'Washington Nationals',

    // --- NFL (raw names are already the common form) ----------------------------------
    'Arizona Cardinals': 'Arizona Cardinals',
    'Atlanta Falcons': 'Atlanta Falcons',
    'Baltimore Ravens': 'Baltimore Ravens',
    'Buffalo Bills': 'Buffalo Bills',
    'Carolina Panthers': 'Carolina Panthers',
    'Chicago Bears': 'Chicago Bears',
    'Cincinnati Bengals': 'Cincinnati Bengals',
    'Cleveland Browns': 'Cleveland Browns',
    'Dallas Cowboys': 'Dallas Cowboys',
    // Chiefs and Broncos were missing until 2026-09-15: the table was seeded from teams
    // already SEEN in index_positions, and neither had played inside the tracked window
    // until their Week 2 meeting - so all 32 NFL clubs were never actually checked.
    'Denver Broncos': 'Denver Broncos',
    'Detroit Lions': 'Detroit Lions',
    'Green Bay Packers': 'Green Bay Packers',
    'Houston Texans': 'Houston Texans',
    'Indianapolis Colts': 'Indianapolis Colts',
    'Jacksonville Jaguars': 'Jacksonville Jaguars',
    'Kansas City Chiefs': 'Kansas City Chiefs',
    'Las Vegas Raiders': 'Las Vegas Raiders',
    'Los Angeles Chargers': 'Los Angeles Chargers',
    'Los Angeles Rams': 'Los Angeles Rams',
    'Miami Dolphins': 'Miami Dolphins',
    'Minnesota Vikings': 'Minnesota Vikings',
    'New England Patriots': 'New England Patriots',
    'New Orleans Saints': 'New Orleans Saints',
    'New York Giants': 'New York Giants',
    'New York Jets': 'New York Jets',
    'Philadelphia Eagles': 'Philadelphia Eagles',
    'Pittsburgh Steelers': 'Pittsburgh Steelers',
    'San Francisco 49ers': 'San Francisco 49ers',
    'Seattle Seahawks': 'Seattle Seahawks',
    'Tampa Bay Buccaneers': 'Tampa Bay Buccaneers',
    'Tennessee Titans': 'Tennessee Titans',
    'Washington Commanders': 'Washington Commanders',

    // --- MLS -------------------------------------------------------------------------
    'Atlanta United FC': 'Atlanta United',
    'Austin FC': 'Austin FC',
    'CF Montréal': 'CF Montréal',
    'Charlotte FC': 'Charlotte FC',
    'Chicago Fire FC': 'Chicago Fire',
    'Colorado Rapids SC': 'Colorado Rapids',
    'Columbus Crew': 'Columbus Crew',
    'D.C. United SC': 'D.C. United',
    'FC Cincinnati': 'FC Cincinnati',
    'FC Dallas': 'FC Dallas',
    'Houston Dynamo': 'Houston Dynamo',
    'Inter Miami CF': 'Inter Miami',
    'Los Angeles FC': 'Los Angeles FC',
    'Los Angeles Galaxy': 'LA Galaxy',
    'Minnesota United FC': 'Minnesota United',
    'Nashville SC': 'Nashville SC',
    'New England Revolution': 'New England Revolution',
    'New York City FC': 'New York City FC',
    'New York Red Bulls': 'New York Red Bulls',
    'Orlando City SC': 'Orlando City',
    'Philadelphia Union': 'Philadelphia Union',
    'Portland Timbers': 'Portland Timbers',
    'Real Salt Lake': 'Real Salt Lake',
    'San Diego FC': 'San Diego FC',
    'San Jose Earthquakes': 'San Jose Earthquakes',
    'Seattle Sounders FC': 'Seattle Sounders',
    'Sporting Kansas City': 'Sporting Kansas City',
    'St. Louis City SC': 'St. Louis City SC',
    'Toronto FC': 'Toronto FC',
    'Vancouver Whitecaps FC': 'Vancouver Whitecaps',

    // --- England (EPL / EFL Championship / Carabao Cup share one club namespace) ------
    'AFC Bournemouth': 'Bournemouth',
    'Arsenal FC': 'Arsenal',
    'Aston Villa FC': 'Aston Villa',
    'Barnsley FC': 'Barnsley',
    'Birmingham City FC': 'Birmingham City',
    'Blackburn Rovers FC': 'Blackburn Rovers',
    'Bolton Wanderers FC': 'Bolton Wanderers',
    'Brentford FC': 'Brentford',
    'Bristol City FC': 'Bristol City',
    'Burnley FC': 'Burnley',
    'Cardiff City FC': 'Cardiff City',
    'Brighton & Hove Albion FC': 'Brighton & Hove Albion',
    'Charlton Athletic FC': 'Charlton Athletic',
    'Chelsea FC': 'Chelsea',
    'Coventry City FC': 'Coventry City',
    'Crystal Palace FC': 'Crystal Palace',
    'Derby County FC': 'Derby County',
    'Everton FC': 'Everton',
    'Fleetwood Town FC': 'Fleetwood Town',
    'Fulham FC': 'Fulham',
    'Hull City AFC': 'Hull City',
    'Ipswich Town FC': 'Ipswich Town',
    'Leeds United FC': 'Leeds United',
    'Lincoln City FC': 'Lincoln City',
    'Liverpool FC': 'Liverpool',
    'Manchester City FC': 'Manchester City',
    'Manchester United FC': 'Manchester United',
    'Middlesbrough FC': 'Middlesbrough',
    'Millwall FC': 'Millwall',
    'Newcastle United FC': 'Newcastle United',
    'Norwich City FC': 'Norwich City',
    'Nottingham Forest FC': 'Nottingham Forest',
    'Peterborough United FC': 'Peterborough United',
    'Portsmouth FC': 'Portsmouth',
    'Preston North End FC': 'Preston North End',
    'Queens Park Rangers FC': 'Queens Park Rangers',
    'Reading FC': 'Reading',
    'Sheffield United FC': 'Sheffield United',
    'Southampton FC': 'Southampton',
    'Stoke City FC': 'Stoke City',
    'Sunderland AFC': 'Sunderland',
    'Swansea City AFC': 'Swansea City',
    'Tottenham Hotspur FC': 'Tottenham Hotspur',
    'Watford FC': 'Watford',
    'West Bromwich Albion FC': 'West Bromwich Albion',
    'West Ham United FC': 'West Ham United',
    'Wolverhampton Wanderers FC': 'Wolverhampton Wanderers',
    'Wrexham AFC': 'Wrexham',

    // --- La Liga ---------------------------------------------------------------------
    'Athletic Club': 'Athletic Club',
    'CA Osasuna': 'Osasuna',
    'Club Atlético de Madrid': 'Atlético Madrid',
    'Deportivo Alavés': 'Alavés',
    'Elche CF': 'Elche',
    'FC Barcelona': 'Barcelona',
    'Getafe CF': 'Getafe',
    'Levante UD': 'Levante',
    'Málaga CF': 'Málaga',
    'RC Celta de Vigo': 'Celta Vigo',
    'RC Deportivo A Coruña': 'Deportivo La Coruña',
    'RCD Espanyol de Barcelona': 'Espanyol',
    'Rayo Vallecano de Madrid': 'Rayo Vallecano',
    'Real Betis Balompié': 'Real Betis',
    'Real Madrid CF': 'Real Madrid',
    'Real Racing Club': 'Racing Santander',
    'Real Sociedad de Fútbol': 'Real Sociedad',
    'Sevilla FC': 'Sevilla',
    'Valencia CF': 'Valencia',
    'Villarreal CF': 'Villarreal',

    // --- Ligue 1 ---------------------------------------------------------------------
    'AJ Auxerre': 'Auxerre',
    'AS Monaco FC': 'Monaco',
    'Angers SCO': 'Angers',
    'ES Troyes AC': 'Troyes',
    'FC Lorient': 'Lorient',
    'Le Havre AC': 'Le Havre',
    'Le Mans FC': 'Le Mans',
    'Lille OSC': 'Lille',
    'OGC Nice': 'Nice',
    'Olympique Lyonnais': 'Lyon',
    'Olympique de Marseille': 'Marseille',
    'Paris FC': 'Paris FC',
    'Paris Saint-Germain FC': 'Paris Saint-Germain',
    'RC Strasbourg Alsace': 'Strasbourg',
    'Racing Club de Lens': 'Lens',
    'Stade Brestois 29': 'Brest',
    'Stade Rennais FC 1901': 'Rennes',
    'Toulouse FC': 'Toulouse',

    // --- Bundesliga ------------------------------------------------------------------
    '1. FC Köln': 'FC Köln',
    '1. FC Union Berlin': 'Union Berlin',
    '1. FSV Mainz 05': 'Mainz 05',
    'BV Borussia 09 Dortmund': 'Borussia Dortmund',
    'Bayer 04 Leverkusen': 'Bayer Leverkusen',
    'Borussia Mönchengladbach': 'Borussia Mönchengladbach',
    'Eintracht Frankfurt': 'Eintracht Frankfurt',
    'FC Augsburg': 'Augsburg',
    'FC Bayern München': 'Bayern Munich',
    'FC Schalke 04': 'Schalke 04',
    'Hamburger SV': 'Hamburger SV',
    'RB Leipzig': 'RB Leipzig',
    'SC Freiburg': 'Freiburg',
    'SC Paderborn 07': 'Paderborn 07',
    'SV 07 Elversberg': 'Elversberg',
    'SV Werder Bremen': 'Werder Bremen',
    'TSG 1899 Hoffenheim': 'Hoffenheim',
    'VfB Stuttgart': 'Stuttgart',
};

// Reserved for a genuine collision - two DIFFERENT clubs that Polymarket spells the same
// way, distinguished by league. Empty today, and checked first so an entry here always
// beats the global table. Kept as a documented seam so the day it happens the fix is one
// line rather than a redesign of the key.
const LEAGUE_OVERRIDES: Record<string, Record<string, string>> = {};

/**
 * The club a raw Polymarket team string names, or null when it isn't in the table.
 *
 * Null is a real answer and callers must handle it: it means "a name arrived that nobody
 * has mapped yet", which happens whenever a league is added (league-tags.ts warns that
 * adding a key there is not a passive registration) or a club is promoted into a covered
 * competition. Callers count nulls and report them - see index-lock's unmappedTeams - so
 * the gap surfaces in a cron report instead of silently dropping games from a team page.
 */
export function canonicalTeam(league: string | null, rawName: string | null): TeamId | null {
    if (!rawName) return null;
    const raw = rawName.trim();
    if (!raw) return null;
    const display = (league ? LEAGUE_OVERRIDES[league]?.[raw] : undefined) ?? CLUB_DISPLAY[raw];
    if (!display) return null;
    return { id: teamSlug(display), display };
}

/** Every club in the table, id-ascending. The teams hub renders from this. */
export function allTeams(): TeamId[] {
    const byId = new Map<string, TeamId>();
    for (const display of Object.values(CLUB_DISPLAY)) {
        const id = teamSlug(display);
        if (!byId.has(id)) byId.set(id, { id, display });
    }
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Raw strings the table knows, for the backfill script's coverage report. */
export function mappedRawNames(): string[] {
    return Object.keys(CLUB_DISPLAY);
}

// -----------------------------------------------------------------------------------
// Position -> teams. The ONE dispatch that decides what a locked row is about, shared by
// the lock job (which writes it) and the backfill (which writes it for history), so the
// two can never disagree about a club's record.
// -----------------------------------------------------------------------------------

/**
 * WHY a null subject always carries a reason. Four completely different things produce
 * "no team on this side" - three of them correct and one of them a bug - and without a
 * reason code they are indistinguishable in the stored row:
 *
 *   totals / game_property / three_way_no / draw_market
 *                                        - honest refusals. Nothing to fix.
 *   unmapped_team / label_matches_*      - a club nobody has mapped, or a label that
 *                                          matched neither side. Those are bugs, and
 *                                          they must fail an acceptance check rather
 *                                          than quietly shrink a team's record.
 */
export type SubjectSource =
    | 'side_label'           // the label IS the club (MLB)
    | 'side_label_nickname'  // the label is a nickname of exactly one of the two (NFL)
    | 'side_label_abbr'      // the label is the abbreviation of exactly one of the two (NFL spreads)
    | 'question'             // soccer 'Yes', club named in the question
    | 'totals'               // not team-directional
    | 'game_property'        // both-teams-to-score: a fact about the game, not a side
    | 'three_way_no'         // 'No' = opponent win OR draw; not a team
    | 'draw_market'          // legacy "end in a draw?" rows; nobody's directional side
    | 'unmapped_team'        // BUG: a club the registry doesn't carry
    | 'unreadable_question'  // BUG: a 'Yes' whose question didn't parse or didn't match
    | 'label_matches_neither'// BUG: a label that is neither club, or ambiguously both
    | 'missing_teams';       // BUG: the fixture arrived with no teams at all

export interface PositionTeams {
    /** The fixture's clubs. Set whenever the names map, whichever side the index held. */
    awayTeamId: string | null;
    homeTeamId: string | null;
    /**
     * The club this position's HELD SIDE is a statement about, or null when there isn't
     * one. Null is the common case - see the migration header.
     */
    subjectTeamId: string | null;
    /** Why subjectTeamId is what it is. Never null - see SubjectSource. */
    subjectSource: SubjectSource;
    /** Raw names that reached the resolver and are not in the registry. */
    unmapped: string[];
}

export interface PositionTeamsInput {
    league: string | null;
    away: string | null;
    home: string | null;
    marketType: string | null;
    sideLabel: string | null;
    /** polymarket_props.question - only read for Yes/No markets. */
    question: string | null;
    /**
     * event_teams[].abbreviation for each side, as index_positions.away_abbr/home_abbr
     * already store them (slate-rows.ts lowercases at source). Optional: callers that
     * don't have them - team-price.ts reads a game_snapshot, not a position row - simply
     * lose the abbreviation arm, exactly as before.
     */
    awayAbbr?: string | null;
    homeAbbr?: string | null;
}

const YES_NO_LABEL = /^(yes|no)$/i;

/**
 * Mirrors the four market shapes buildResultSentence dispatches on
 * (market-movers.ts:180-192), and inherits its refusals verbatim:
 *
 *   totals      - a property of the game; neither club gets a directional position.
 *   team line   - the side label IS the club.
 *   Yes/No line - Polymarket's soccer moneylines. 'Yes' is the club named in the
 *                 question. 'No' is "opponent win OR draw", a three-way leg, so the
 *                 only honest fact is that the named club did not win - NOT that the
 *                 opponent was backed. It resolves to no subject.
 *   draw market - legacy rows only (isDrawMarket keeps these out of the slate now);
 *                 a draw is nobody's directional position.
 *
 * Anything unreadable resolves to no subject rather than a guess.
 */
export function resolvePositionTeams(input: PositionTeamsInput): PositionTeams {
    const unmapped: string[] = [];
    const resolve = (raw: string | null): string | null => {
        if (!raw || !raw.trim()) return null;
        const team = canonicalTeam(input.league, raw);
        if (!team) {
            unmapped.push(raw.trim());
            return null;
        }
        return team.id;
    };

    const away = (input.away ?? '').trim();
    const home = (input.home ?? '').trim();
    const awayTeamId = resolve(input.away);
    const homeTeamId = resolve(input.home);

    const done = (subjectTeamId: string | null, subjectSource: SubjectSource): PositionTeams => ({
        awayTeamId,
        homeTeamId,
        subjectTeamId,
        subjectSource,
        unmapped,
    });

    // 1. A moneyline and a SPREAD are both statements about a club - on a spread the side
    //    label IS the club (verified on the live board: a spread's two outcomes are the
    //    two team names, and outcome 0 is the team the question names). A total, and
    //    both-teams-to-score, are properties of the GAME and belong to neither side.
    //
    //    Spreads used to fall into the 'totals' arm below, which was a lie with teeth:
    //    'totals' is an honest-refusal code, so it is absent from index-lock's
    //    BUG_SOURCES, and every spread position would have recorded subject_team_id NULL
    //    with attributionBugs still reading 0. A whole market type would have gone
    //    unattributed and the acceptance suite would have passed.
    if (input.marketType === 'both_teams_to_score') return done(null, 'game_property');
    if (input.marketType !== 'moneyline' && input.marketType !== 'spreads') {
        return done(null, 'totals');
    }
    if (!away && !home) return done(null, 'missing_teams');

    const label = (input.sideLabel ?? '').trim();
    if (!label) return done(null, 'label_matches_neither');

    // 2. Legacy "end in a draw?" rows. isDrawMarket keeps new ones out of the slate, but
    //    six were locked before that guard existed and they are settled history. A draw
    //    is nobody's directional side, on EITHER side of the market.
    if (isDrawMarket({ question: input.question })) return done(null, 'draw_market');

    // 3. Polymarket's soccer moneylines: "Will <TEAM> win on <date>?" over ['Yes','No'].
    //
    //    SCOPED TO MONEYLINE (2026-09-20). This arm used to run for spreads too, and a
    //    spread on the New Orleans Saints has the side label 'NO' - which matched here,
    //    before any team matching, and returned 'three_way_no'. That is an
    //    honest-refusal code, so it sits in no BUG_SOURCES list: the row was silently
    //    mis-attributed and invisible to the acceptance invariant, to index-lock's
    //    attributionBugs counter and to the backfill's gate. A spread outcome is never a
    //    three-way leg, so the arm belongs to the market shape it was written for.
    if (input.marketType === 'moneyline' && YES_NO_LABEL.test(label)) {
        // 'No' is "opponent win OR draw" - a three-way leg, not a club. The only honest
        // fact is that the named club did not win, so no club owns this side.
        // market-movers.ts:186-189 makes the same refusal for the same reason.
        if (label.toLowerCase() === 'no') return done(null, 'three_way_no');

        const parsed = parseYesNoQuestion(input.question);
        if (parsed?.kind !== 'team') return done(null, 'unreadable_question');
        // The question's team is byte-identical to one of event_teams' names on 100% of
        // live soccer rows, so this equality is free - and it is a format-drift alarm.
        // Deliberately NOT a substring test: softening it would hide the drift.
        const side = parsed.team === away ? away : parsed.team === home ? home : null;
        if (!side) return done(null, 'unreadable_question');
        const id = resolve(side);
        return done(id, id ? 'question' : 'unmapped_team');
    }

    // 4. The label IS the club (MLB: 'Cleveland Guardians').
    if (label === away || label === home) {
        const id = resolve(label);
        return done(id, id ? 'side_label' : 'unmapped_team');
    }

    // 5. The label is a NICKNAME (NFL: '49ers' for 'San Francisco 49ers'; NBA will do the
    //    same). Matching is scoped to THIS GAME'S two clubs, which makes a globally
    //    ambiguous nickname locally unambiguous - 'Cardinals' is Arizona or St. Louis in
    //    the abstract and exactly one of them inside a fixture. Requiring EXACTLY one
    //    match matters: a guess between the two clubs of a game is the one guess that
    //    produces a wrong-but-plausible record.
    const isNicknameOf = (full: string) =>
        full.length > label.length && full.toLowerCase().endsWith(` ${label.toLowerCase()}`);
    const awayHit = away ? isNicknameOf(away) : false;
    const homeHit = home ? isNicknameOf(home) : false;
    if (awayHit !== homeHit) {
        const id = resolve(awayHit ? away : home);
        return done(id, id ? 'side_label_nickname' : 'unmapped_team');
    }

    // 6. The label is the fixture's ABBREVIATION ('BAL' for 'Baltimore Ravens'): what an
    //    NFL SPREAD's outcomes actually carry. The nickname rule above cannot reach these
    //    - it is a suffix test, and an abbreviation is a contraction, not a trailing word.
    //
    //    Safe for the same reason the nickname rule is: matching is scoped to THIS
    //    FIXTURE'S two abbreviations and requires EXACTLY one hit, so a globally ambiguous
    //    abbreviation is locally unambiguous. No new registry data is involved -
    //    event_teams[].abbreviation is a strict bijection with name inside a league, and
    //    index_positions froze both onto the row for exactly this re-resolve
    //    (add_team_identity_to_index_positions.sql). Case-insensitive: Gamma publishes
    //    'BAL' while slate-rows.ts lowercases at source.
    const abbrMatches = (abbr: string | null | undefined) =>
        !!abbr && abbr.trim().length > 0 && abbr.trim().toLowerCase() === label.toLowerCase();
    const awayAbbrHit = abbrMatches(input.awayAbbr);
    const homeAbbrHit = abbrMatches(input.homeAbbr);
    if (awayAbbrHit !== homeAbbrHit) {
        const id = resolve(awayAbbrHit ? away : home);
        return done(id, id ? 'side_label_abbr' : 'unmapped_team');
    }

    return done(null, 'label_matches_neither');
}
