// ===================================================================================
// HEATCHECKS TANK — LIVE KALSHI PROP FETCH (kalshi-live.ts)
// ===================================================================================
// A zero-DB-dependency live Kalshi fetch, mirroring tank-gamma-live.ts's relationship
// to Polymarket: functions/api/curate.ts (a Cloudflare Pages Function, no pg/Node APIs
// available) sources live Kalshi player-prop candidates from here directly, rather than
// from kalshi.ts's kalshi_props cache table (which nothing keeps fresh in production -
// same reason Polymarket's cache is bypassed by tank-gamma-live.ts).
//
// Reuses the exact same ladder-collapse/classification logic the cached-DB path uses
// (tank-providers.ts's buildGamesFromKalshiFlatProps) by mapping live Kalshi markets
// into the same flat row shape, rather than reimplementing it a second time where it
// could quietly drift from the cached path's behavior.
// ===================================================================================

import type { Game } from './tank-types';
import {
    SUPPORTED_KALSHI_LEAGUES,
    KALSHI_SERIES_MAP,
    seriesTickersForLeague,
    fetchAllEventsForSeries,
    parseKalshiMatchup,
    parseKalshiSubjectName,
    extractSubjectKey,
    toNumberOrNull,
    type KalshiMarket,
} from './kalshi';
import { buildGamesFromKalshiFlatProps, type KalshiPropsRow } from './tank-providers';

// 7 days, matching tank-gamma-live.ts's DEFAULT_WINDOW_HOURS - curate.ts also filters
// out any candidate resolving sooner than MIN_LEAD_DAYS (default 2 days), so the
// candidate pool needs a wider window than that floor to have anything left to filter.
export const DEFAULT_KALSHI_WINDOW_HOURS = 24 * 7;

function withinWindow(market: KalshiMarket, now: number, windowMs: number): boolean {
    const t = market.occurrence_datetime;
    if (!t) return false;
    const ts = new Date(t).getTime();
    if (Number.isNaN(ts)) return false;
    return ts >= now && ts <= now + windowMs;
}

function bidAskMidOrLast(market: KalshiMarket): number {
    const bid = toNumberOrNull(market.yes_bid_dollars);
    const ask = toNumberOrNull(market.yes_ask_dollars);
    if (bid !== null && ask !== null && bid > 0 && ask < 1) return (bid + ask) / 2;
    return toNumberOrNull(market.last_price_dollars) ?? 0;
}

// Fetches every supported league's currently-open Kalshi player-prop markets
// (paginated, throttled via kalshi.ts's module-level queue), keeps only markets whose
// game kicks off within the window, and shapes the result into the same Game[]/Prop[]
// tank-filter.ts/tank-generate.ts already consume.
export async function fetchLiveKalshiGames(
    leagues: string[] = SUPPORTED_KALSHI_LEAGUES,
    windowHours: number = DEFAULT_KALSHI_WINDOW_HOURS
): Promise<Game[]> {
    const now = Date.now();
    const windowMs = windowHours * 60 * 60 * 1000;
    const rows: KalshiPropsRow[] = [];

    for (const league of leagues) {
        for (const seriesTicker of seriesTickersForLeague(league)) {
            const info = KALSHI_SERIES_MAP[seriesTicker];
            const pairs = await fetchAllEventsForSeries(seriesTicker, 'open');

            for (const { event, markets } of pairs) {
                const matchup = parseKalshiMatchup(event.sub_title);

                for (const market of markets) {
                    if (!withinWindow(market, now, windowMs)) continue;

                    rows.push({
                        league,
                        event_ticker: event.event_ticker,
                        event_title: event.title || null,
                        away: matchup?.away ?? null,
                        home: matchup?.home ?? null,
                        market_ticker: market.ticker,
                        subject_name: parseKalshiSubjectName(market.yes_sub_title || market.title),
                        subject_key: extractSubjectKey(market),
                        market_key: info.marketKey,
                        shape: info.shape,
                        floor_strike: market.floor_strike !== null ? String(market.floor_strike) : null,
                        yes_prob: String(bidAskMidOrLast(market)),
                        volume: market.volume_fp ?? null,
                        open_interest: market.open_interest_fp ?? null,
                        close_time: market.close_time || null,
                        occurrence_time: market.occurrence_datetime || null,
                    });
                }
            }
        }
    }

    return buildGamesFromKalshiFlatProps(rows);
}
