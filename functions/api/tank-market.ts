// GET /api/tank-market?m=<Polymarket market id> - public, DB-free. The current prices of
// ONE Polymarket market, for the "Polymarket prices" panel on a Tank article page
// (components/ArticleMarket.tsx). Everything the panel needs besides the live price -
// the market id, kickoff, the prices frozen when the story was written - is baked into
// the article page at build time, so this never touches the database: one Gamma read.
//
// CACHED, unlike every other /api route (jsonResponse sends no-store). Without a cache,
// every article view would be a request to Polymarket. The Cache API entry is keyed on
// the validated id alone, so query-string junk can't mint new entries. Two copies of the
// response are built on purpose, the way functions/index.ts does it: cache.put honours
// Cache-Control, so the STORED copy carries `public, s-maxage`, while the copy returned to
// the browser carries a short max-age. Gamma itself is edge-cached for 300s upstream, so
// refreshing more often than ~2 minutes would buy nothing.
//
// Failure is not an error to the reader: an unreachable Gamma, an unknown id, or a market
// that isn't two-outcome returns 200 {available:false} (cached briefly, to prevent a
// stampede), and the panel keeps its dated server-rendered fallback.
//
// NOTE: the Cache API may not store entries on *.pages.dev preview hostnames; on the
// production custom domain it does. The response is correct either way - only the cache
// hit rate differs.

import type { PagesFunction } from '@cloudflare/workers-types';
import { jsonResponse, type Env } from '../../lib/pages-functions/db';
import { fetchMarket, safeJsonParse, type GammaMarketLite } from '../../lib/pages-functions/gamma';
import { isLiveBook, MARKET_PANEL_NOTE } from '../../tank-deck-format';

const MARKET_ID_RE = /^\d{1,12}$/;
const CACHE_SECONDS = 120;
const FAILURE_CACHE_SECONDS = 30;
const BROWSER_MAX_AGE_SECONDS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface TankMarketBody {
    available: boolean;
    liveBook?: boolean;
    closed?: boolean;
    question?: string | null;
    outcomes?: string[];
    pct?: number[];
    pct24hAgo?: number[] | null;
    asOf?: string;
    note: string;
}

async function buildBody(marketId: string): Promise<TankMarketBody> {
    const unavailable: TankMarketBody = { available: false, note: MARKET_PANEL_NOTE };
    let market: GammaMarketLite | null;
    try {
        market = await fetchMarket(marketId);
    } catch {
        return unavailable;
    }
    if (!market) return unavailable;

    const outcomes = safeJsonParse<string[]>(market.outcomes) ?? [];
    const prices = (safeJsonParse<string[]>(market.outcomePrices) ?? []).map(Number);
    if (outcomes.length !== 2 || prices.length !== 2 || prices.some((p) => !Number.isFinite(p))) return unavailable;

    const base = {
        available: true,
        outcomes,
        question: market.question ?? null,
        asOf: new Date().toISOString(),
        note: MARKET_PANEL_NOTE,
    };
    if (market.closed) return { ...base, closed: true, liveBook: false };

    // Polymarket's price is the bid/ask midpoint, so an empty book reads as a plausible
    // 50%. No book, no price.
    const liveBook = isLiveBook({
        bestBid: market.bestBid ?? null,
        bestAsk: market.bestAsk ?? null,
        volume: market.volumeNum ?? null,
    });
    if (!liveBook) return { ...base, closed: false, liveBook: false };

    const first = Math.round(prices[0] * 100);

    // The level 24 hours ago, from Gamma's precomputed change on outcome 0 - verified live
    // to match the CLOB history. Gamma OMITS the field when the change is zero, so absent
    // means flat. Shown only for a market older than a day: for a younger one the "change"
    // would describe a window from before the market existed.
    const createdMs = market.createdAt ? new Date(market.createdAt).getTime() : NaN;
    let pct24hAgo: number[] | null = null;
    if (Number.isFinite(createdMs) && Date.now() - createdMs > DAY_MS) {
        const change = typeof market.oneDayPriceChange === 'number' && Number.isFinite(market.oneDayPriceChange)
            ? market.oneDayPriceChange
            : 0;
        const then = Math.round(Math.min(1, Math.max(0, prices[0] - change)) * 100);
        pct24hAgo = [then, 100 - then];
    }

    return { ...base, closed: false, liveBook: true, pct: [first, 100 - first], pct24hAgo };
}

function toBrowser(payload: string, maxAge: number, cacheState: 'HIT' | 'MISS'): Response {
    return new Response(payload, {
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': `public, max-age=${maxAge}`,
            'X-Content-Type-Options': 'nosniff',
            'X-Tank-Market-Cache': cacheState,
        },
    });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const url = new URL(context.request.url);
    const marketId = (url.searchParams.get('m') ?? '').trim();
    if (!MARKET_ID_RE.test(marketId)) {
        return jsonResponse({ message: 'Provide ?m=<numeric Polymarket market id>.' }, { status: 400 });
    }

    const cacheKey = new Request(`${url.origin}/api/tank-market?m=${marketId}`, { method: 'GET' });
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) return toBrowser(await hit.text(), BROWSER_MAX_AGE_SECONDS, 'HIT');

    const body = await buildBody(marketId);
    const ttl = body.available ? CACHE_SECONDS : FAILURE_CACHE_SECONDS;
    const payload = JSON.stringify(body);
    const stored = new Response(payload, {
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': `public, s-maxage=${ttl}`,
            'X-Content-Type-Options': 'nosniff',
        },
    });
    context.waitUntil(cache.put(cacheKey, stored));
    return toBrowser(payload, Math.min(BROWSER_MAX_AGE_SECONDS, ttl), 'MISS');
};
