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
    fetchMarketsGroupedByEvent,
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

// Cloudflare Pages Functions cap outbound fetches per invocation at 50 ("Too many
// subrequests by single Worker invocation" - confirmed live 2026-08-25, is the same
// constraint functions/api/curate.ts's own header comment already documents for
// ticker-sweep, which is why that runs as its own separate request rather than inside
// this one). curate.ts's single request already spends part of that budget on
// Polymarket's fetch, Anthropic's match/generate calls, and a few DB queries, so
// Kalshi's live-fetch (sharing the SAME request/budget, not a separate one) can only
// afford a slice of KALSHI_SERIES_MAP's ~36 series, not all of them, every run. Capping
// per LEAGUE (not globally) keeps every league in the rotation rather than letting
// whichever league iterates first (NBA, alphabetically-ish in the map) crowd out the
// rest - each league's series are already ordered highest-value-first in the map
// (points/passing-yards/home-runs/anytime-scorer before the rarer stat types), so
// slicing keeps the series most likely to matter.
const MAX_KALSHI_SERIES_PER_LEAGUE = 3;

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
        for (const seriesTicker of seriesTickersForLeague(league).slice(0, MAX_KALSHI_SERIES_PER_LEAGUE)) {
            const info = KALSHI_SERIES_MAP[seriesTicker];

            // One series's fetch failing (a 429 after exhausting retries, a transient
            // 5xx, a network blip) must not take down every other series - or worse,
            // the whole curate run, since this function's caller Promise.all's it
            // alongside Polymarket's fetch. Mirrors polymarket.ts's syncLeague, which
            // has the same per-league try/catch for the same reason. Confirmed live
            // (2026-08-25): an unhandled 429 on the first series thrown here propagated
            // all the way to functions/api/curate.ts's request handler and 500'd the
            // entire run, silently producing zero drafts for every sport that day.
            //
            // Uses fetchMarketsGroupedByEvent (bulk markets only), not
            // fetchAllEventsForSeries (which adds one GET /events/{ticker} call per
            // distinct event) - also confirmed live (2026-08-25) that those per-event
            // lookups, summed across every series/league in one curate run, push a
            // single Pages Function invocation over Cloudflare's "Too many subrequests"
            // ceiling. Trade-off: away/home stay null here (see the fallback in
            // tank-providers.ts's buildGamesFromKalshiFlatProps) - real team names for
            // Kalshi candidates aren't worth reintroducing that N+1 call pattern for.
            let pairs: Awaited<ReturnType<typeof fetchMarketsGroupedByEvent>>;
            try {
                pairs = await fetchMarketsGroupedByEvent(seriesTicker, 'open');
            } catch (err) {
                console.error(`[Kalshi] Skipping series "${seriesTicker}" (${league}) after fetch failure:`, err instanceof Error ? err.message : err);
                continue;
            }

            for (const { eventTicker, markets } of pairs) {
                for (const market of markets) {
                    if (!withinWindow(market, now, windowMs)) continue;

                    rows.push({
                        league,
                        event_ticker: eventTicker,
                        event_title: null,
                        away: null,
                        home: null,
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
