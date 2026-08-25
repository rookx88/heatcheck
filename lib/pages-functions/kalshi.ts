// Kalshi market reads shared by the settlement path (functions/api/settle.ts) and the
// ticker tag-delta calculation (lib/pages-functions/tickers.ts's fetchKalshiTagDelta).
// Mirrors gamma.ts's role and "don't read the local cache" rationale for Polymarket -
// kalshi_props (kalshi.ts, the root-level sync module) is Phase-1/admin-tool-only,
// nothing keeps it fresh in production, so settlement always resolves live here instead.
//
// Deliberately exports only the low-level fetch/resolve primitives, not a
// fetchKalshiTagDelta wrapper - that function lives in tickers.ts itself (next to the
// existing Polymarket fetchTagDelta) so the module dependency stays one-directional
// (tickers.ts -> this file, never the reverse), matching the existing tickers.ts ->
// gamma.ts direction exactly and avoiding a circular import between this file and
// tickers.ts (which needs to call both this file's primitives AND settle.ts needs to
// call tickers.ts's settleTag).

const KALSHI_BASE_URL = 'https://api.elections.kalshi.com/trade-api/v2';

export interface KalshiMarketLite {
    status: string;
    result: string | null;
    yes_bid_dollars?: string;
    yes_ask_dollars?: string;
    last_price_dollars?: string;
}

export async function fetchMarket(ticker: string): Promise<KalshiMarketLite | null> {
    const res = await fetch(`${KALSHI_BASE_URL}/markets/${encodeURIComponent(ticker)}`, {
        headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { market?: KalshiMarketLite };
    return body.market ?? null;
}

// Three-way, not two ('not_closed_yet' | 'resolved'): Kalshi markets can settle to
// result:'scalar' - a fair-market-value price (settlement_value_dollars) rather than a
// clean yes/no win, when the underlying condition never cleanly occurred (player
// inactive, never took a snap, game cancelled - confirmed live against real settled
// markets, e.g. "Chris Brooks: 1+ touchdowns" settling to settlement_value_dollars:
// "0.2300" instead of a clean yes/no). Treated as VOIDED for pick/tag settlement
// purposes, same non-terminal posture as not_closed_yet - grading a pick against a
// fair-value price would be arbitrary, not a real win/loss.
//
// winningIndex is a FIXED convention, never a live/reorderable value (unlike
// Polymarket's outcomes array, which is why outcomeOrderMismatch exists in gamma.ts and
// has no equivalent here): 0 = the Yes/Over side, 1 = the No/Under side, matching
// tank-providers.ts's buildGamesFromKalshiFlatProps odds.outcomes = ['Over','Under'] |
// ['Yes','No'] ordering exactly.
export type KalshiMarketResolution =
    | { status: 'not_closed_yet' | 'voided' }
    | { status: 'resolved'; winningIndex: 0 | 1 };

export function resolveMarket(market: KalshiMarketLite | null): KalshiMarketResolution {
    if (!market || market.status !== 'finalized') return { status: 'not_closed_yet' };
    if (market.result === 'yes') return { status: 'resolved', winningIndex: 0 };
    if (market.result === 'no') return { status: 'resolved', winningIndex: 1 };
    return { status: 'voided' };
}

export interface KalshiTrade {
    yes_price_dollars: string;
    no_price_dollars: string;
    created_time: string;
}

interface KalshiTradesPage {
    trades: KalshiTrade[];
    cursor?: string;
}

// Newest-first (confirmed live) - paging forward via cursor walks progressively further
// back in time. tickers.ts's fetchKalshiTagDelta uses this to find the trade nearest
// "N days ago" as a substitute for Polymarket's CLOB /prices-history endpoint, which
// has no Kalshi equivalent.
export async function fetchKalshiTradesPage(ticker: string, cursor?: string): Promise<KalshiTradesPage> {
    const params = new URLSearchParams({ ticker, limit: '1000' });
    if (cursor) params.set('cursor', cursor);
    const res = await fetch(`${KALSHI_BASE_URL}/markets/trades?${params.toString()}`, {
        headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
        throw new Error(`Kalshi trades ${res.status} for ticker "${ticker}"`);
    }
    return (await res.json()) as KalshiTradesPage;
}
