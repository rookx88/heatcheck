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
