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
import { fetchClosedMarkets, fetchMarketStrict, resolveMarket } from '../../lib/pages-functions/gamma';
import { getTickerConfig } from '../../lib/pages-functions/tickers';
import { closeDelta, contributionFor } from '../../lib/pages-functions/index-slate';
import { secretMatches } from '../../lib/pages-functions/secret-compare';

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

// After this long, a market that STILL won't resolve is written off as 'void' instead of
// being asked about forever.
//
// Polymarket does not always close a market it has stopped trading. Measured 2026-09-13:
// market 3809076 ("Will D.C. United SC win on 2026-09-05?") was still closed=false,
// active=true, priced ["0.45","0.55"] EIGHT DAYS after kickoff, holding four positions
// ($CHALK/$DOGS/$LOCKS/$MOONSHOT). resolveMarket returns 'not_closed_yet' for it on every
// run, forever.
//
// That is not merely one stuck game. The pending query below orders by kickoff ASC and
// takes the oldest MAX_MARKETS, so a market that can never resolve sits at the HEAD of
// the queue permanently, spending one of the 30 slots on every single pass. Stuck markets
// accumulate there and progressively starve the queue of real work - the failure is
// silent and compounding.
//
// 72h is far beyond any real fixture (the longest thing on the board is a 9-inning
// baseball game plus rain delay), so nothing legitimate is written off early. A void
// contributes nothing: the close query below counts only result IN ('win','loss'), which
// is exactly what create_index_positions_table.sql promises for 'void'.
const STALE_VOID_HOURS = 72;

interface PendingRow {
    id: string;
    ticker_key: string;
    market_id: string;
    side_index: number;
    entry_prob: number;
    // Only used to decide whether an unresolvable market is old enough to write off.
    stale: boolean;
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
    const [settleOk, curateOk] = await Promise.all([
        secretMatches(settleSecret, context.env.SETTLE_SECRET),
        secretMatches(curateSecret, context.env.CURATE_SECRET),
    ]);
    const authorized = settleOk || curateOk;
    if (!authorized) {
        return jsonResponse({ message: 'Unauthorized' }, { status: 401 });
    }

    const sql = getSql(context.env);

    // The oldest MAX_MARKETS due markets, and then EVERY pending position on them - so
    // one Gamma call always settles all the indexes holding that game, and no market is
    // left half-settled across runs.
    const pending = (await sql`
        WITH due AS (
            SELECT id, ticker_key, market_id, side_index, entry_prob::float8 AS entry_prob, kickoff,
                   kickoff < NOW() - (INTERVAL '1 hour' * ${STALE_VOID_HOURS}) AS stale
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
        SELECT d.id, d.ticker_key, d.market_id, d.side_index, d.entry_prob, d.stale
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
    // Written off rather than settled - reported separately so this stays visible instead
    // of looking like a quiet run. A number that climbs here is a real signal (Polymarket
    // leaving markets open, or our market ids drifting), not routine noise.
    const voidedStale: Record<string, number> = {};

    // One request for the whole run's closed markets, instead of one per market. Only
    // the markets Gamma RETURNS are seeded: an id missing from a closed-only batch means
    // "not closed, or not a market", and the loop below turns that status on a stale
    // position into a permanent void. That decision is too expensive to make on an
    // absence, so a missing id still gets its own authoritative fetchMarket call below.
    // The saving lands where it matters anyway - a run that settles nothing is a run
    // where nothing was closed (efficiency audit, 2026-09-20).
    //
    // A throw here is a batch-level failure, never an answer about any market: log it and
    // fall through to the per-market path, which is exactly what this ran before.
    try {
        const closed = await fetchClosedMarkets([...new Set(pending.map((p) => p.market_id))]);
        for (const [marketId, market] of closed) resolutions.set(marketId, resolveMarket(market));
    } catch (err) {
        console.error('[index-settle] batched market fetch failed, falling back to one call per market:', err);
    }

    for (const p of pending) {
        try {
            if (!resolutions.has(p.market_id)) {
                resolutions.set(p.market_id, resolveMarket(await fetchMarketStrict(p.market_id)));
            }
            const res = resolutions.get(p.market_id)!;
            if (res.status !== 'resolved') {
                // Gamma gave a definite non-answer. If the game is also long past
                // STALE_VOID_HOURS, stop asking: write the position off as void so it
                // leaves the queue it would otherwise block (see STALE_VOID_HOURS above).
                //
                // Deliberately NOT done in the catch below, because a failure to REACH
                // Gamma is not an answer about the market and voiding on one would
                // destroy a game that is merely unreachable this minute.
                //
                // That is only true because this asks via fetchMarketStrict. Until
                // 2026-09-22 it used fetchMarket, which folded a 429 or a 503 into null,
                // which resolveMarket reads as not_closed_yet - so an outage arriving
                // during the drain loop's ~240 sequential calls silently and permanently
                // voided every stale position it touched. The comment here used to claim
                // the protection this line now actually provides.
                if (p.stale) {
                    settled.push({ id: p.id, result: 'void', winningIndex: null, contrib: null });
                    voidedStale[res.status] = (voidedStale[res.status] ?? 0) + 1;
                    continue;
                }
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
    //
    // Skipped entirely when this pass settled nothing: the close write REPLACES the day's
    // delta from the same set of linked positions, so recomputing it without a new
    // settlement rewrites identical rows. This endpoint runs 5+ times a day and most
    // passes have nothing due - that idle pass cost 5 round trips and 2 writes for no
    // change (efficiency audit, 2026-09-19). `deferred` still returns work to the drain
    // loop, and the next pass that does settle something recomputes the whole day, which
    // is exactly the property the 2026-09-13 fix above relies on.
    if (settled.length === 0) {
        const hasMore = marketsConsidered === MAX_MARKETS;
        return jsonResponse({
            pendingConsidered: pending.length,
            marketsConsidered,
            settled: 0,
            voided: 0,
            voidedStale,
            skipped,
            hasMore,
            deferred: hasMore ? 'more may remain; next run continues' : 'none',
            closes: [],
        });
    }

    const cfg = await getTickerConfig(sql);
    const scalePct = cfg.close_scale_pct;
    const smoothing = cfg.close_smoothing;
    const closes: Array<{ tickerKey: string; delta: number; counted: number; won: number }> = [];

    if (typeof scalePct === 'number' && typeof smoothing === 'number') {
        // Everything that belongs in today's close - the newly settled positions AND the
        // ones an earlier run today already attached to it.
        //
        // Including the already-attached rows is the whole point. The write below upserts
        // on (ticker_key, close_date) with DO UPDATE SET delta = EXCLUDED.delta, which
        // REPLACES the day's delta rather than adding to it. Selecting only
        // `close_id IS NULL` therefore made each run overwrite the day with just its own
        // batch, silently discarding every earlier batch that day - and since MAX_MARKETS
        // caps a run at 30 markets, any slate bigger than that settles across several
        // runs by construction. Measured 2026-09-13: 5 of $OVERS' 12 closes were wrong,
        // two with the sign flipped, and $MLBCHALK read +1.160 when its own linked
        // positions summed to -2.545.
        //
        // Re-reading them makes EXCLUDED.delta the whole day, so the replace is correct.
        // Re-stamping close_id on rows that already carry it is a no-op.
        // UNION ALL of the two arms, not one OR: the OR form could not use
        // idx_index_positions_unclosed (a query predicate only reaches a partial index
        // when it implies the index's own), so add_hot_path_indexes.sql's index sat
        // unused while this went back to a sequential scan of every position ever
        // locked - 5 runs a day (efficiency audit, 2026-09-19). Split, the first arm
        // hits that partial index and the second hits idx_index_positions_close. The
        // arms are disjoint by construction (close_id IS NULL vs NOT NULL), so no row
        // can appear twice and the result is identical to the OR.
        const openRows = await sql`
            SELECT ip.ticker_key, ip.id, ip.contrib::float8 AS contrib, ip.result
            FROM index_positions ip
            WHERE ip.settled_at IS NOT NULL
              AND ip.result IN ('win', 'loss')
              AND ip.close_id IS NULL
            UNION ALL
            SELECT ip.ticker_key, ip.id, ip.contrib::float8 AS contrib, ip.result
            FROM index_positions ip
            JOIN ticker_events te ON te.id = ip.close_id
            WHERE ip.settled_at IS NOT NULL
              AND ip.result IN ('win', 'loss')
              AND te.source = 'slate'
              AND te.close_date = CURRENT_DATE
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
            // Idempotent by the (ticker_key, close_date) unique index: a second run the
            // same day updates the existing close in place rather than appending a second
            // one, so re-running settlement can never double-count a day. What makes the
            // in-place UPDATE correct rather than lossy is that the query above reads the
            // whole day, not just this run's batch - a replace of a total, never of a
            // partial sum.
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

    // Voids ride the same bulk UPDATE as real results, so separate them back out here -
    // "settled" should keep meaning "scored", or a run that only swept up stuck markets
    // would read as productive.
    const voidedCount = settled.filter((s) => s.result === 'void').length;

    // The run is capped on markets, so that is what signals a remainder. Shipped as a
    // BOOLEAN as well as the human string: worker-curate re-POSTs this endpoint until the
    // queue drains, and a caller should not have to string-match prose to know whether to
    // go round again.
    const hasMore = marketsConsidered === MAX_MARKETS;

    return jsonResponse({
        pendingConsidered: pending.length,
        marketsConsidered,
        settled: settled.length - voidedCount,
        voided: voidedCount,
        voidedStale,
        skipped,
        hasMore,
        deferred: hasMore ? 'more may remain; next run continues' : 'none',
        closes,
    });
};
