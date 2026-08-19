// ===================================================================================
// HEATCHECKS TANK — SHARED TYPES (tank-types.ts)
// ===================================================================================
// Types shared across the prop providers, the pre-filter, generation, and the
// backend routes. Kept dependency-free (no pg/express imports) so it can be
// imported from both backend.ts and scripts/ without pulling in server setup.
// ===================================================================================

export interface PropOdds {
    outcomes: string[];
    outcomePrices: number[]; // implied probability, 0-1, same order as outcomes
}

export interface Prop {
    id: string;
    player: string;
    team: string | null;       // not always derivable from the source data
    market: string;             // canonical stat key, e.g. "baseball_player_home_runs"
    line: number | null;        // null = yes/no market (e.g. Anytime TD)
    prominence: number;         // 0-99, used only for pre-filtering
    odds: PropOdds | null;
    // ISO 8601 - this specific market's own resolution deadline (Polymarket's per-market
    // endDate), when known. Prefer this over Game.settleDate for display: the event can
    // bundle markets with very different resolution windows (e.g. a same-night totals
    // prop next to a moneyline market Polymarket keeps open for a week), so the event-
    // level date doesn't reliably describe any one prop's actual settle time. Falls back
    // to Game.settleDate when absent (mock data, season futures with no discrete game).
    settleDate?: string;
}

export interface Game {
    id: string;
    league: string;             // NBA, NFL, MLB, EPL, La Liga, Serie A, Bundesliga, Ligue 1
    away: string;
    home: string;
    kickoff: string;            // ISO 8601 - actual game start (Polymarket's event.startTime)
    settleDate: string;         // ISO 8601 - market resolution deadline (event.endDate), distinct
                                 // from kickoff for season-long futures with no discrete game
    props: Prop[];
}

export interface PropProvider {
    fetchProps(): Promise<Game[]>;
}

export interface FilterParams {
    marketWhitelist: string[];
    minProminence: number;
    perGameCap: number;
}

export interface SelectedProp {
    prop: Prop;
    game: Game;
    angle: string;
}

export interface TankArticleSeo {
    title: string;
    meta_description: string;
    slug: string;
}

export interface TankArticleCall {
    question: string;
    sides: string[];
}

export interface TankArticle {
    seo: TankArticleSeo;
    body: string;
    tagline: string; // 2-6 words, the Hook wall's header - distinct from the full-sentence hook
    hook: string;
    cards: string[];
    call: TankArticleCall;
}

// The Fishtank artifact's render payload (components/Fishtank.tsx re-exports this for
// its consumers). Lives here, not in the component, so server-side code - the homepage
// data mappers under lib/pages-functions/, which type-check without DOM libs - can
// build one without importing a React/DOM module graph.
export interface DeckPayload {
    hook: string;
    cards: string[];
    // sidesImpliedProb is positionally parallel to sides (same convention
    // functions/api/picks.ts's sideIndex relies on) - the raw market implied
    // probability per side, straight from the frozen game_snapshot's prop.odds.
    // Optional because older, pre-rebuild payloads won't carry it yet.
    call: { question: string; sides: string[]; sidesImpliedProb?: number[] };
    // Wall-header content, below. All pre-formatted strings computed server-side (never
    // client-side) so the component stays purely presentational. tagline is the one
    // model-generated field; the rest are real facts pulled from the frozen game_snapshot
    // (league/subject, market odds, settle date) - same "never build a hard fact from
    // model prose" rule the schema.org JSON-LD already follows.
    tagline: string;           // Hook wall header - short storyline label, a few words
    contextLabel: string;      // Take 1 header - "{league} · {subject}"
    oddsOrMarketLabel: string; // Take 2 header - live odds, or the market label if no odds
    settleDateLabel: string;   // Call wall header - "Resolves {date}"
}
