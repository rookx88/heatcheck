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
    // Only the LIST endpoint carries this (the single endpoint is addressed by id
    // already). fetchClosedMarkets keys its result map on it - never on array position,
    // because /markets returns its own ordering, not the requested one.
    id?: string | number;
    outcomes?: string;       // JSON-encoded string array
    outcomePrices?: string;  // JSON-encoded string array
    clobTokenIds?: string;   // JSON-encoded string array, positional with outcomes
    closed?: boolean;
    // Read by the article market panel (functions/api/tank-market.ts). Verified live
    // 2026-09-10: prices are bid/ask midpoints, and Gamma OMITS a change field when the
    // change is zero - so a missing oneDayPriceChange means flat, never unknown.
    question?: string;
    bestBid?: number | null;
    bestAsk?: number | null;
    volumeNum?: number | null;
    oneDayPriceChange?: number | null;
    createdAt?: string;
}

export function safeJsonParse<T>(value: string | undefined | null): T | null {
    if (!value) return null;
    try {
        return JSON.parse(value) as T;
    } catch {
        return null;
    }
}

// Nothing in this file had a timeout before 2026-09-22. Cloudflare does not cap a
// subrequest on the Worker's behalf, so a hung Gamma connection held a settle or lock
// window open until the platform killed the whole invocation - one slow market could
// cost every market behind it in the run. 10s is far longer than a healthy Gamma
// response and far shorter than any window this runs in.
const GAMMA_TIMEOUT_MS = 10_000;

/**
 * One market, keeping "Gamma did not answer" and "Gamma says there is no such market"
 * APART. Use this from anything that writes an irreversible conclusion.
 *
 * The distinction is not academic. `resolveMarket(null)` reads as `not_closed_yet`
 * (below), and in functions/api/index-settle.ts that status on a position past
 * STALE_VOID_HOURS writes it off as `void` - permanently, with no way back. So under the
 * old contract a Gamma 429 or 503 on an old position destroyed it, and the drain loop
 * fires up to 240 sequential Gamma calls per slot, which is exactly when a rate-limit
 * burst arrives. Confirmed against the code 2026-09-22; the comment in index-settle
 * claiming voids never follow a failed fetch was only true of transport-level throws.
 *
 * A 404 still returns null, because that IS an answer: Gamma is telling us the market is
 * gone. Everything else - 429, 5xx, timeout, DNS, TLS - throws.
 */
export async function fetchMarketStrict(marketId: string): Promise<GammaMarketLite | null> {
    const res = await fetch(`${GAMMA_BASE_URL}/markets/${encodeURIComponent(marketId)}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(GAMMA_TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Gamma /markets/${marketId} failed: ${res.status}`);
    return (await res.json()) as GammaMarketLite;
}

/**
 * One market, where ANY failure reads as "not available right now".
 *
 * This is the right contract for a screen: a Discord select, the article market panel,
 * the PvP pick list. They show "couldn't load that market" and the reader tries again -
 * nothing is written, so conflating an outage with an absence costs nothing. It is the
 * WRONG contract for a batch job that settles or voids; those use fetchMarketStrict.
 *
 * Note this now also swallows transport-level throws, which it previously propagated.
 * That is deliberate and it only affects those same screens: every caller that acts on
 * the difference has been moved to the strict variant.
 */
export async function fetchMarket(marketId: string): Promise<GammaMarketLite | null> {
    try {
        return await fetchMarketStrict(marketId);
    } catch {
        return null;
    }
}

// How many ids ride in one /markets URL. No cap was found (70 ids in one request came
// back complete), so this is chosen for a short URL and a small blast radius per
// request, not because Gamma requires it.
const GAMMA_ID_CHUNK = 40;

/**
 * The CLOSED markets among `marketIds`, in one request per 40 ids instead of one per
 * market. For the settlement paths, which ask about 30+ markets a run and care about
 * exactly one thing: has this market resolved yet.
 *
 * Probed live 2026-09-20, and every line below is a finding rather than a preference:
 *
 *  - `?id=a&id=b` works, but the list endpoint applies a closed-state filter and the
 *    DEFAULT excludes closed markets. Without `closed=true`, a batch of 8 settled
 *    markets returned 1. So this helper is closed-only by construction, which is also
 *    exactly what settlement wants.
 *  - The default `limit` is 20 and over-length responses are TRUNCATED SILENTLY - a 200
 *    with a short array. A batch of 30 ids without a limit returns 20, and the 10 lost
 *    rows would read as "not closed yet", which on a stale position means voiding it
 *    permanently. Hence `limit = chunk.length + 1`: at most chunk.length rows can match,
 *    so a response that REACHES the limit is a truncation and throws.
 *  - The response is ordered by Gamma, not by the request, so it is re-keyed on
 *    `market.id`. A positional map would settle picks against another game's result.
 *  - A request failure THROWS rather than returning an empty map. `fetchMarket` folds
 *    every failure into `null`, which `resolveMarket` reads as `not_closed_yet` - fine
 *    for one market, but a thrown batch must never be mistaken for "none of these 30
 *    have resolved."
 *
 * An id absent from the result means "not closed, or not a market" - callers that treat
 * absence as a settlement input should confirm it with `fetchMarket` rather than trust a
 * silence (see functions/api/index-settle.ts).
 */
export async function fetchClosedMarkets(marketIds: string[]): Promise<Map<string, GammaMarketLite>> {
    const out = new Map<string, GammaMarketLite>();
    const unique = [...new Set(marketIds.filter((id) => !!id))];
    for (let i = 0; i < unique.length; i += GAMMA_ID_CHUNK) {
        const chunk = unique.slice(i, i + GAMMA_ID_CHUNK);
        const params = chunk.map((id) => `id=${encodeURIComponent(id)}`).join('&');
        const res = await fetch(`${GAMMA_BASE_URL}/markets?${params}&closed=true&limit=${chunk.length + 1}`, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(GAMMA_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`Gamma /markets batch failed: ${res.status}`);
        const body = (await res.json()) as unknown;
        if (!Array.isArray(body)) throw new Error('Gamma /markets batch: expected an array');
        if (body.length > chunk.length) {
            throw new Error(`Gamma /markets batch returned ${body.length} rows for ${chunk.length} ids (truncated or over-matched)`);
        }
        for (const market of body as GammaMarketLite[]) {
            const id = market?.id == null ? '' : String(market.id);
            // An id we did not ask for means the filter did not apply - the one failure
            // mode that would quietly settle the wrong game, so it is fatal, not skipped.
            if (!chunk.includes(id)) {
                throw new Error(`Gamma /markets batch returned an unrequested id: ${id || '(none)'}`);
            }
            out.set(id, market);
        }
    }
    return out;
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
