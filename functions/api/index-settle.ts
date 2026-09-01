// POST /api/index-settle - protected, machine-to-machine only (fired by worker-settle
// right after /api/settle). Shares X-Settle-Secret with it: same caller, same trust
// domain.
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
// hard ~50 subrequest ceiling that Neon's HTTP driver also draws on. MAX_POSITIONS caps
// a run well inside it; the remainder is deferred to the next run and reported. That is
// safe because settlement is catch-up tolerant - unlike locking, a resolved market stays
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

const MAX_POSITIONS = 25;
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
    const secret = context.request.headers.get('X-Settle-Secret');
    if (!secret || secret !== context.env.SETTLE_SECRET) {
        return jsonResponse({ message: 'Unauthorized' }, { status: 401 });
    }

    const sql = getSql(context.env);

    const pending = (await sql`
        SELECT id, ticker_key, market_id, side_index, entry_prob::float8 AS entry_prob
        FROM index_positions
        WHERE settled_at IS NULL
          AND kickoff < NOW() - (INTERVAL '1 hour' * ${SETTLE_GRACE_HOURS})
        ORDER BY kickoff
        LIMIT ${MAX_POSITIONS}
    `) as unknown as PendingRow[];

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

        for (const [tickerKey, rows] of byTicker) {
            const delta = closeDelta(rows.map((r) => r.contrib), { smoothing, scalePct });
            if (delta === null) continue; // no positions -> no event, never a 0.0% close
            const won = rows.filter((r) => r.won).length;

            // Idempotent by the (ticker_key, close_date) unique index: a second run the
            // same day updates the existing close in place rather than appending a
            // second one, so re-running settlement can never double-count a day.
            const closeRows = await sql`
                INSERT INTO ticker_events (ticker_key, event_type, source, close_date, delta, metadata)
                VALUES (${tickerKey}, 'close', 'slate', CURRENT_DATE, ${delta}, ${JSON.stringify({
                    positionsCounted: rows.length,
                    positionsWon: won,
                    scalePct,
                    smoothing,
                })}::jsonb)
                ON CONFLICT (ticker_key, close_date) WHERE source = 'slate'
                DO UPDATE SET delta = EXCLUDED.delta, metadata = EXCLUDED.metadata
                RETURNING id
            `;
            const closeId = closeRows[0]?.id as string | undefined;
            if (closeId) {
                await sql`UPDATE index_positions SET close_id = ${closeId} WHERE id = ANY(${rows.map((r) => r.id)}::uuid[])`;
                closes.push({ tickerKey, delta, counted: rows.length, won });
            }
        }
    }

    return jsonResponse({
        pendingConsidered: pending.length,
        settled: settled.length,
        skipped,
        deferred: pending.length === MAX_POSITIONS ? 'more may remain; next run continues' : 'none',
        closes,
    });
};
