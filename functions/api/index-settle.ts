// POST /api/index-settle - protected, machine-to-machine only. Fired by worker-settle
// right after /api/settle (X-Settle-Secret), and by worker-curate's sweep chain
// (X-Curate-Secret) - four passes a day between them. Safe to run repeatedly: a pass
// with nothing due costs two queries and writes nothing, and the closes upsert.
//
// Two steps, in order:
//   1. SETTLE - resolve locked index_positions whose game has finished, scoring each
//      against the price it was locked at: +(1 - p) on a win, -p on a loss. EV-neutral
//      on a calibrated market, so an index measures how far reality diverged from the
//      price rather than how often a side won.
//   2. CLOSE  - roll each index's newly-settled positions into ONE ticker_event per
//      index per day (source='slate'). This is the results leg, and the main driver of
//      an index's movement.
//
// BUDGET: resolution is one Gamma call per distinct market, and a Pages Function has a
// hard ~50 subrequest ceiling that Neon's HTTP driver also draws on. MAX_MARKETS caps a
// run on the quantity that actually spends the budget; the remainder is deferred to the
// next run and reported. That is safe because settlement is catch-up tolerant - unlike
// locking, a resolved market stays
// resolved, so nothing is lost by settling late. (Locking is the step that can't wait -
// see index-lock.ts.)
//
// Results are read from Gamma's authoritative /markets/{id}, NOT from polymarket_props:
// the sync fetches closed=false events, so it structurally cannot observe a market after
// its event closes. Of finished game-lines in the cache only ~49% carry closed=true, and
// a chunk of the rest froze at ambiguous prices - fine for choosing a line, not fine for
// deciding who won.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../lib/pages-functions/db';
import { fetchMarket, resolveMarket } from '../../lib/pages-functions/gamma';
import { getTickerConfig } from '../../lib/pages-functions/tickers';
import { closeDelta, contributionFor } from '../../lib/pages-functions/index-slate';

// A run's cost is driven by DISTINCT MARKETS, not positions: resolution is one Gamma
// call per market, and every index holding the same game shares that one call. Capping
// positions instead was throttling the run against the wrong quantity - after the league
// sub-indexes landed, 2.6 positions share each market, so a 25-position cap spent only
// ~11 Gamma calls and stopped less than a quarter of the way into the budget while the
// backlog grew ~30 a day. Paging by market also means a market is never half-settled.
//
// Budget: 6 fixed Neon calls (config, pending, bulk settle, open positions, close
// upsert, close backfill) + one Gamma call per market, against the ~50 subrequest
// ceiling that Neon's HTTP driver also draws on. 30 leaves real headroom.
const MAX_MARKETS = 30;
// Give the market time to actually resolve before asking about it.
const SETTLE_GRACE_HOURS = 3;

interface PendingRow {
    id: string;
    ticker_key: string;
    market_id: string;
    side_index: number;
    entry_prob: number;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    // Two callers, one endpoint. worker-settle fires this after /api/settle with
    // X-Settle-Secret; worker-curate fires it from its sweep chain with X-Curate-Secret,
    // which is how settlement gets four passes a day out of a single cron trigger (the
    // Workers Free plan's five are all spent). Same trust domain either way - both are
    // this account's own cron Workers, and /api/index-lock, which WRITES the positions
    // this endpoint scores, already authenticates on X-Curate-Secret alone. Accepting
    // either avoids provisioning a second secret onto worker-curate for no added safety.
    const settleSecret = context.request.headers.get('X-Settle-Secret');
    const curateSecret = context.request.headers.get('X-Curate-Secret');
    const authorized =
        (settleSecret && settleSecret === context.env.SETTLE_SECRET) ||
        (curateSecret && curateSecret === context.env.CURATE_SECRET);
    if (!authorized) {
        return jsonResponse({ message: 'Unauthorized' }, { status: 401 });
    }

    const sql = getSql(context.env);

    // The oldest MAX_MARKETS due markets, and then EVERY pending position on them - so
    // one Gamma call always settles all the indexes holding that game, and no market is
    // left half-settled across runs.
    const pending = (await sql`
        WITH due AS (
            SELECT id, ticker_key, market_id, side_index, entry_prob::float8 AS entry_prob, kickoff
            FROM index_positions
            WHERE settled_at IS NULL
              AND kickoff < NOW() - (INTERVAL '1 hour' * ${SETTLE_GRACE_HOURS})
        ),
        markets AS (
            SELECT market_id FROM due
            GROUP BY market_id
            ORDER BY MIN(kickoff)
            LIMIT ${MAX_MARKETS}
        )
        SELECT d.id, d.ticker_key, d.market_id, d.side_index, d.entry_prob
        FROM due d
        JOIN markets m ON m.market_id = d.market_id
        ORDER BY d.kickoff
    `) as unknown as PendingRow[];
    const marketsConsidered = new Set(pending.map((p) => p.market_id)).size;

    // One fetch per distinct market: $OVERS and $UNDERS share a market, as do
    // $CHALK/$DOGS, so this typically halves the call count.
    const resolutions = new Map<string, Awaited<ReturnType<typeof resolveMarket>>>();
    const settled: Array<{ id: string; result: 'win' | 'loss' | 'void'; winningIndex: number | null; contrib: number | null }> = [];
    const skipped: Record<string, number> = {};

    for (const p of pending) {
        try {
            if (!resolutions.has(p.market_id)) {
                resolutions.set(p.market_id, resolveMarket(await fetchMarket(p.market_id)));
            }
            const res = resolutions.get(p.market_id)!;
            if (res.status !== 'resolved') {
                skipped[res.status] = (skipped[res.status] ?? 0) + 1;
                continue;
            }
            const won = res.winningIndex === p.side_index;
            settled.push({
                id: p.id,
                result: won ? 'win' : 'loss',
                winningIndex: res.winningIndex,
                contrib: contributionFor(won, p.entry_prob),
            });
        } catch (err) {
            console.error(`[index-settle] ${p.market_id} failed:`, err);
            skipped['error'] = (skipped['error'] ?? 0) + 1;
        }
    }

    // Bulk write the results - one query, not one per position.
    if (settled.length > 0) {
        await sql`
            UPDATE index_positions AS ip
            SET result = s.result, winning_index = s.winning_index,
                contrib = s.contrib, settled_at = NOW()
            FROM (
                SELECT * FROM unnest(
                    ${settled.map((s) => s.id)}::uuid[],
                    ${settled.map((s) => s.result)}::text[],
                    ${settled.map((s) => s.winningIndex)}::smallint[],
                    ${settled.map((s) => s.contrib)}::numeric[]
                ) AS t(id, result, winning_index, contrib)
            ) AS s
            WHERE ip.id = s.id AND ip.settled_at IS NULL
        `;
    }

    // ---- Daily closes -------------------------------------------------------------
    // Every settled-but-unclosed position, grouped by index. Positions settled on an
    // earlier run today are included, so a deferred remainder still lands in the right
    // day's close rather than being stranded.
    const cfg = await getTickerConfig(sql);
    const scalePct = cfg.close_scale_pct;
    const smoothing = cfg.close_smoothing;
    const closes: Array<{ tickerKey: string; delta: number; counted: number; won: number }> = [];

    if (typeof scalePct === 'number' && typeof smoothing === 'number') {
        const openRows = await sql`
            SELECT ticker_key, id, contrib::float8 AS contrib, result
            FROM index_positions
            WHERE settled_at IS NOT NULL AND close_id IS NULL AND result IN ('win', 'loss')
        `;
        const byTicker = new Map<string, Array<{ id: string; contrib: number; won: boolean }>>();
        for (const r of openRows) {
            const key = r.ticker_key as string;
            const list = byTicker.get(key) ?? [];
            list.push({ id: r.id as string, contrib: r.contrib as number, won: r.result === 'win' });
            byTicker.set(key, list);
        }

        // Build every index's close first, then write them all in TWO queries. Doing it
        // per ticker cost 2 Neon calls each, so the write phase grew with the number of
        // indexes - at 14 that was 28 subrequests before a single Gamma call, and it
        // would have kept growing with every index added.
        const planned: Array<{ tickerKey: string; delta: number; counted: number; won: number; ids: string[] }> = [];
        for (const [tickerKey, rows] of byTicker) {
            const delta = closeDelta(rows.map((r) => r.contrib), { smoothing, scalePct });
            if (delta === null) continue; // no positions -> no event, never a 0.0% close
            planned.push({
                tickerKey,
                delta,
                counted: rows.length,
                won: rows.filter((r) => r.won).length,
                ids: rows.map((r) => r.id),
            });
        }

        if (planned.length > 0) {
            // Still idempotent by the (ticker_key, close_date) unique index: a second run
            // the same day updates each existing close in place rather than appending a
            // second one, so re-running settlement can never double-count a day.
            const closeRows = await sql`
                INSERT INTO ticker_events (ticker_key, event_type, source, close_date, delta, metadata)
                SELECT k, 'close', 'slate', CURRENT_DATE, d, m::jsonb
                FROM unnest(
                    ${planned.map((p) => p.tickerKey)}::text[],
                    ${planned.map((p) => p.delta)}::numeric[],
                    ${planned.map((p) => JSON.stringify({
                        positionsCounted: p.counted,
                        positionsWon: p.won,
                        scalePct,
                        smoothing,
                    }))}::text[]
                ) AS t(k, d, m)
                ON CONFLICT (ticker_key, close_date) WHERE source = 'slate'
                DO UPDATE SET delta = EXCLUDED.delta, metadata = EXCLUDED.metadata
                RETURNING id, ticker_key
            `;
            const closeIdOf = new Map(closeRows.map((r) => [r.ticker_key as string, r.id as string]));

            // Stamp every counted position with its index's close id, in one pass.
            const posIds: string[] = [];
            const closeIds: string[] = [];
            for (const p of planned) {
                const closeId = closeIdOf.get(p.tickerKey);
                if (!closeId) continue;
                for (const id of p.ids) { posIds.push(id); closeIds.push(closeId); }
                closes.push({ tickerKey: p.tickerKey, delta: p.delta, counted: p.counted, won: p.won });
            }
            if (posIds.length > 0) {
                await sql`
                    UPDATE index_positions AS ip
                    SET close_id = t.close_id
                    FROM unnest(${posIds}::uuid[], ${closeIds}::uuid[]) AS t(id, close_id)
                    WHERE ip.id = t.id
                `;
            }
        }
    }

    return jsonResponse({
        pendingConsidered: pending.length,
        marketsConsidered,
        settled: settled.length,
        skipped,
        // The run is capped on markets now, so that is what signals a remainder.
        deferred: marketsConsidered === MAX_MARKETS ? 'more may remain; next run continues' : 'none',
        closes,
    });
};
