// ===================================================================================
// HEATCHECKS TANK — LIVE GAMMA PROP FETCH (tank-gamma-live.ts)
// ===================================================================================
// A zero-DB-dependency alternative to tank-providers.ts's createPolymarketPropProvider:
// that provider only ever reads the polymarket_props cache table, which nothing keeps
// fresh in production (its sync only runs from the non-deployed backend.ts). This talks
// to Polymarket's Gamma API directly - the same principle functions/api/settle.ts
// already established for settlement - so functions/api/curate.ts (a Cloudflare Pages
// Function, no pg/Node APIs available) can source live candidate props without it.
//
// Reuses the exact same classification/grouping logic the cached-DB path uses
// (tank-providers.ts's buildGamesFromFlatProps) by mapping a raw Gamma response into the
// same flat row shape, rather than reimplementing player-prop/game-line/season-futures
// detection a second time where it could quietly drift from the cached path's behavior.
// ===================================================================================

import type { Game } from './tank-types';
import {
    SUPPORTED_LEAGUES,
    LEAGUE_TAGS,
    fetchAllEventsForTag,
    parsePropShape,
    safeJsonParse,
    type GammaEvent,
} from './polymarket';
import { buildGamesFromFlatProps, type PolymarketPropsRow } from './tank-providers';

export const DEFAULT_WINDOW_HOURS = 48;

function withinWindow(event: GammaEvent, now: number, windowMs: number): boolean {
    const t = event.startTime || event.endDate;
    if (!t) return false;
    const ts = new Date(t).getTime();
    if (Number.isNaN(ts)) return false;
    return ts >= now && ts <= now + windowMs;
}

// Fetches every supported league's currently-open Gamma markets (paginated, throttled
// via polymarket.ts's module-level queue - unchanged from the cached-DB sync path),
// keeps only events kicking off within the window, and shapes the result into the same
// Game[]/Prop[] tank-filter.ts/tank-generate.ts already consume.
export async function fetchLiveGames(
    leagues: string[] = SUPPORTED_LEAGUES,
    windowHours: number = DEFAULT_WINDOW_HOURS
): Promise<Game[]> {
    const now = Date.now();
    const windowMs = windowHours * 60 * 60 * 1000;
    const rows: PolymarketPropsRow[] = [];

    for (const league of leagues) {
        const tags = LEAGUE_TAGS[league];
        if (!tags) continue;

        for (const tag of tags) {
            const events = await fetchAllEventsForTag(tag);
            for (const event of events) {
                if (!withinWindow(event, now, windowMs)) continue;

                for (const market of event.markets ?? []) {
                    const { isPlayerProp, subjectName } = parsePropShape(market.question || '', market.sportsMarketType);

                    rows.push({
                        league,
                        event_id: event.id,
                        event_slug: event.slug,
                        event_title: event.title,
                        event_start_time: event.startTime || null,
                        event_end_date: event.endDate || null,
                        event_teams: event.teams ?? null,
                        market_id: market.id,
                        market_end_date: market.endDate || null,
                        subject_name: subjectName,
                        market_type: market.sportsMarketType || null,
                        market_line: market.line !== undefined && market.line !== null ? String(market.line) : null,
                        outcomes: safeJsonParse<string[]>(market.outcomes),
                        outcome_prices: safeJsonParse<string[]>(market.outcomePrices),
                        volume: market.volume !== undefined && market.volume !== null ? String(market.volume) : null,
                        liquidity: market.liquidity !== undefined && market.liquidity !== null ? String(market.liquidity) : null,
                        question: market.question || null,
                        is_player_prop: isPlayerProp,
                    });
                }
            }
        }
    }

    return buildGamesFromFlatProps(rows);
}
