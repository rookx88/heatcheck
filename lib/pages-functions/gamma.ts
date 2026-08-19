// Polymarket Gamma market reads shared by the settlement paths (functions/api/settle.ts
// - both the pick loop and the ticker-tag loop) and the ticker tag-creation endpoint
// (functions/api/ticker-tags.ts, which needs clobTokenIds). Extracted from settle.ts
// so the resolution decision tree exists exactly once.
//
// Deliberately does NOT read the local polymarket_props cache table: nothing keeps that
// cache fresh in production (the only code that syncs it, polymarket.ts's
// syncAllLeagues/startPolymarketScheduler, is only ever called from backend.ts, which is
// not deployed), and even if it were running, its sync only ever fetches closed=false
// markets, so it would never observe a market transitioning to closed=true anyway.

const GAMMA_BASE_URL = 'https://gamma-api.polymarket.com';

// A price is only trusted as "the winner" once it's unambiguously resolved. Real closed
// markets settle outcomePrices to exact "1"/"0" strings - confirmed live against several
// actual resolved markets - but a stale/zero-liquidity market can resolve to something
// degenerate like ["0","0"], which must be left unsettled rather than guessed at.
export const WINNER_THRESHOLD = 0.99;

export interface GammaMarketLite {
    outcomes?: string;       // JSON-encoded string array
    outcomePrices?: string;  // JSON-encoded string array
    clobTokenIds?: string;   // JSON-encoded string array, positional with outcomes
    closed?: boolean;
}

export function safeJsonParse<T>(value: string | undefined | null): T | null {
    if (!value) return null;
    try {
        return JSON.parse(value) as T;
    } catch {
        return null;
    }
}

export async function fetchMarket(marketId: string): Promise<GammaMarketLite | null> {
    const res = await fetch(`${GAMMA_BASE_URL}/markets/${encodeURIComponent(marketId)}`, {
        headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return (await res.json()) as GammaMarketLite;
}

export type MarketResolution =
    | { status: 'not_closed_yet' | 'unresolvable_prices' | 'ambiguous_resolution' }
    | { status: 'resolved'; winningIndex: number; outcomes: string[] | null };

// The settlement decision tree, shared by picks and ticker tags. Status strings match
// the /api/settle response values that predate this module. All non-'resolved' statuses
// are non-terminal: the item stays unsettled and is retried on a future run.
// `outcomes` (the LIVE Gamma outcome names) is returned so callers can cross-check the
// live array order against the frozen snapshot order before trusting winningIndex.
export function resolveMarket(market: GammaMarketLite | null): MarketResolution {
    if (!market || !market.closed) return { status: 'not_closed_yet' };
    const outcomePrices = safeJsonParse<string[]>(market.outcomePrices) ?? [];
    const prices = outcomePrices.map(Number);
    if (prices.length === 0 || prices.every((p) => Number.isNaN(p))) {
        return { status: 'unresolvable_prices' };
    }
    let winningIndex = 0;
    for (let i = 1; i < prices.length; i++) {
        if (prices[i] > prices[winningIndex]) winningIndex = i;
    }
    if (prices[winningIndex] < WINNER_THRESHOLD) {
        // Neither outcome resolved unambiguously (e.g. a degenerate [0,0] market) -
        // leave it for a future run rather than guess.
        return { status: 'ambiguous_resolution' };
    }
    return { status: 'resolved', winningIndex, outcomes: safeJsonParse<string[]>(market.outcomes) };
}

// outcome_index / relevant_side are stamped against the FROZEN snapshot's outcome
// order, but winningIndex above comes from the LIVE Gamma array - if Polymarket ever
// reorders a market's outcomes, index comparison would silently settle inverted. Only a
// definite positional name disagreement counts as a mismatch; when either array is
// missing there is nothing to compare against, so settlement proceeds on the index
// (the pre-hardening behavior).
export function outcomeOrderMismatch(
    liveOutcomes: string[] | null,
    snapshotOutcomes: unknown,
): boolean {
    if (!liveOutcomes || liveOutcomes.length === 0) return false;
    if (!Array.isArray(snapshotOutcomes) || snapshotOutcomes.length === 0) return false;
    if (liveOutcomes.length !== snapshotOutcomes.length) return true;
    return liveOutcomes.some((name, i) => {
        const snap = snapshotOutcomes[i];
        return typeof snap !== 'string' || snap.trim().toLowerCase() !== name.trim().toLowerCase();
    });
}
