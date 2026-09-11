// Polymarket CLOB price history for ONE outcome token - the article pipeline's own read
// (functions/api/curate.ts, for the movement sentence). Pure fetch, no retries.
//
// Deliberately separate from tickers.ts's fetchTagDelta, which calls the same endpoint:
// that path is hard-wired to ticker tagging (a 3-day window, daily buckets, TaggingError
// codes) and sits next to settlement. Refactoring it to share this would touch working
// code for no gain here.
//
// Response shape, verified live 2026-09-10: {"history":[{"t":<unix seconds>,"p":<0-1>}]},
// hourly at fidelity=60 with occasional missing hours. A BAD TOKEN ID RETURNS HTTP 200
// WITH AN EMPTY LIST, not an error - so an empty history is reported as its own failure
// and never read as "the market didn't move".

import type { PricePoint } from '../../market-movement';

const CLOB_BASE_URL = 'https://clob.polymarket.com';

export type PriceHistoryResult =
    | { ok: true; points: PricePoint[] }
    | { ok: false; reason: 'http_error' | 'network_error' | 'empty' };

export async function fetchPriceHistory(
    tokenId: string,
    startTs: number,
    endTs: number,
    fidelityMinutes = 60,
): Promise<PriceHistoryResult> {
    const url = `${CLOB_BASE_URL}/prices-history?market=${encodeURIComponent(tokenId)}`
        + `&startTs=${Math.floor(startTs)}&endTs=${Math.floor(endTs)}&fidelity=${fidelityMinutes}`;
    try {
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!res.ok) return { ok: false, reason: 'http_error' };
        const body = (await res.json()) as { history?: unknown };
        const raw = Array.isArray(body.history) ? (body.history as Array<{ t?: unknown; p?: unknown }>) : [];
        const points = raw
            .map((h) => ({ t: Number(h?.t), p: Number(h?.p) }))
            .filter((h) => Number.isFinite(h.t) && Number.isFinite(h.p))
            .sort((a, b) => a.t - b.t);
        if (points.length === 0) return { ok: false, reason: 'empty' };
        return { ok: true, points };
    } catch {
        return { ok: false, reason: 'network_error' };
    }
}
