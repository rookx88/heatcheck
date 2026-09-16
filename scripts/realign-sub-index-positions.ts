// Re-aligns sub-index positions that were locked LATER than their parent's, and repairs
// only the daily closes those rows feed.
//
// THE INVARIANT. A sub-index is a filtered VIEW of its parent: positionsForGame memoizes
// one canonical market per market type per game, so $EPLCHALK holds the identical market,
// side and entry price $FOOTY holds on that game. scripts/acceptance/suites/index-results.ts
// asserts it.
//
// HOW IT BREAKS - the deploy gap. When a new sub-index's rows land in the database BEFORE
// the code that understands its rule_type is deployed, the old code gives it nothing while
// still locking the parent. The first run after the deploy then locks the slice on its own,
// still inside the 9h window but hours later, at whatever the price has drifted to.
// Observed once (2026-09-14): Leeds v Newcastle, locked for $FOOTY at 10:03 at 0.675 and
// for $EPLCHALK at 18:00 at 0.685 - same market, same side, same result, a 0.010
// difference in contribution. Any future sub-index shipped the same way can repeat it.
//
// THE PARENT IS THE SOURCE OF TRUTH, because it locked at the proper time: this copies the
// parent's lock-time fields onto the child, recomputes the child's contribution from them,
// and nothing else. A row whose market or side DIFFERS from its parent's is not a timing
// drift - it is reported and left alone for a human.
//
// CLOSES. Only the closes the realigned rows are linked to are recomputed - never the whole
// board. scripts/recompute-slate-closes.ts recomputes every close, which is not wanted here.
// Each close is rebuilt from its own linked positions with its OWN metadata's scalePct /
// smoothing (never live config), summed in event_id order so a mirror pair's two closes
// come out as exact negatives, and keeps its old value in metadata.recomputedFromDelta.
// This is the same sanctioned exception to ticker_events being append-only that
// recompute-slate-closes.ts documents: delta and the counts move, occurred_at and
// close_date do not, so every chart keeps its shape.
//
//   npx tsx scripts/realign-sub-index-positions.ts --dry-run   <- ALWAYS first
//   npx tsx scripts/realign-sub-index-positions.ts             <- write, in one transaction
//
// Idempotent: a second run finds nothing out of line and plans nothing.
//
// Env: DATABASE_URL.

import { Pool } from 'pg';
import dotenv from 'dotenv';
import { closeDelta, contributionFor } from '../lib/pages-functions/index-slate';

dotenv.config();

const DRY_RUN = process.argv.includes('--dry-run');

if (!process.env.DATABASE_URL) {
    console.error('Required env: DATABASE_URL.');
    process.exit(2);
}

interface Drift {
    child_id: string;
    child_key: string;
    parent_key: string;
    event_id: string;
    fixture: string;
    child_entry: number;
    parent_entry: number;
    child_locked: Date;
    parent_locked: Date;
    same_market: boolean;
    same_side: boolean;
    result: string | null;
    child_contrib: number | null;
    close_id: string | null;
}

async function main(): Promise<void> {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Every sub-index row whose parent holds the same game (same market type) on a
        // different price or lock time.
        const { rows: drift } = await client.query<Drift>(`
            SELECT c.id AS child_id, c.ticker_key AS child_key, t.parent_key,
                   c.event_id, coalesce(c.home, '?') || ' v ' || coalesce(c.away, '?') AS fixture,
                   c.entry_prob::float8 AS child_entry, p.entry_prob::float8 AS parent_entry,
                   c.locked_at AS child_locked, p.locked_at AS parent_locked,
                   (c.market_id = p.market_id) AS same_market,
                   (c.side_index = p.side_index) AS same_side,
                   c.result, c.contrib::float8 AS child_contrib, c.close_id
            FROM index_positions c
            JOIN tickers t ON t.key = c.ticker_key AND t.parent_key IS NOT NULL
            JOIN index_positions p
              ON p.ticker_key = t.parent_key
             AND p.event_id = c.event_id
             AND p.market_type = c.market_type
            WHERE c.entry_prob <> p.entry_prob
               OR c.locked_at <> p.locked_at
               OR c.market_id <> p.market_id
               OR c.side_index <> p.side_index
            ORDER BY c.event_id, c.ticker_key
        `);

        const fixable = drift.filter((d) => d.same_market && d.same_side);
        const review = drift.filter((d) => !(d.same_market && d.same_side));

        console.log(DRY_RUN ? '\nDRY RUN - rolled back at the end.\n' : '');
        if (drift.length === 0) {
            console.log('Every sub-index position matches its parent - nothing to do.');
            await client.query('ROLLBACK');
            return;
        }

        for (const d of fixable) {
            const won = d.result === 'win';
            const next = d.result === 'win' || d.result === 'loss' ? contributionFor(won, d.parent_entry) : null;
            console.log(
                `${d.child_key.padEnd(12)} <- ${d.parent_key.padEnd(8)} ${d.fixture}\n` +
                `    entry ${d.child_entry.toFixed(4)} -> ${d.parent_entry.toFixed(4)}` +
                `   locked ${d.child_locked.toISOString()} -> ${d.parent_locked.toISOString()}` +
                `   contrib ${d.child_contrib ?? '-'} -> ${next ?? '-'}`,
            );
        }
        for (const d of review) {
            console.log(
                `REVIEW (not changed): ${d.child_key} vs ${d.parent_key} on ${d.fixture} - ` +
                `${d.same_market ? '' : 'different market '}${d.same_side ? '' : 'different side'}`,
            );
        }

        if (fixable.length > 0) {
            // Copy every lock-time field from the parent; recompute the contribution from
            // the parent's price rather than copying it, so a result that ever differed
            // between the two would still be scored on the child's own outcome.
            await client.query(`
                UPDATE index_positions AS c SET
                    entry_prob         = p.entry_prob,
                    locked_at          = p.locked_at,
                    sel_volume         = p.sel_volume,
                    sel_liquidity      = p.sel_liquidity,
                    sel_runner_up_line = p.sel_runner_up_line,
                    sel_median_agreed  = p.sel_median_agreed,
                    contrib = CASE c.result
                                  WHEN 'win'  THEN round(1 - p.entry_prob, 3)
                                  WHEN 'loss' THEN round(-p.entry_prob, 3)
                                  ELSE c.contrib END
                FROM tickers t, index_positions p
                WHERE c.id = ANY($1::uuid[])
                  AND t.key = c.ticker_key
                  AND p.ticker_key = t.parent_key
                  AND p.event_id = c.event_id
                  AND p.market_type = c.market_type
            `, [fixable.map((d) => d.child_id)]);
        }

        // Rebuild only the closes the realigned rows feed.
        const closeIds = [...new Set(fixable.map((d) => d.close_id).filter((x): x is string => !!x))];
        if (closeIds.length > 0) {
            const { rows: closes } = await client.query(`
                SELECT te.id, te.ticker_key, te.close_date::text AS close_date,
                       te.delta::float8 AS old_delta, te.metadata,
                       array_agg(ip.contrib::float8 ORDER BY ip.event_id, ip.id) AS contribs,
                       COUNT(*) FILTER (WHERE ip.result = 'win')::int AS wins
                FROM ticker_events te
                JOIN index_positions ip ON ip.close_id = te.id AND ip.result IN ('win', 'loss')
                WHERE te.id = ANY($1::uuid[])
                GROUP BY te.id, te.ticker_key, te.close_date, te.delta, te.metadata
                ORDER BY te.close_date, te.ticker_key
            `, [closeIds]);

            console.log('\nCloses rebuilt:');
            const plans: Array<{ id: string; next: number; counted: number; wins: number }> = [];
            for (const c of closes) {
                const scalePct = Number(c.metadata?.scalePct);
                const smoothing = Number(c.metadata?.smoothing);
                if (!Number.isFinite(scalePct) || !Number.isFinite(smoothing)) {
                    console.log(`  ${c.ticker_key} ${c.close_date}: close metadata has no scalePct/smoothing - left alone`);
                    continue;
                }
                const next = closeDelta(c.contribs as number[], { smoothing, scalePct });
                if (next === null) continue;
                const rounded = Number(next.toFixed(3));
                console.log(`  ${c.ticker_key.padEnd(12)} ${c.close_date}  ${c.old_delta.toFixed(3)} -> ${rounded.toFixed(3)}  (${(c.contribs as number[]).length} positions)`);
                plans.push({ id: c.id, next: rounded, counted: (c.contribs as number[]).length, wins: c.wins });
            }
            if (plans.length > 0) {
                await client.query(`
                    UPDATE ticker_events te SET
                        delta = u.delta,
                        metadata = te.metadata
                                   || jsonb_build_object('positionsCounted', u.counted, 'positionsWon', u.wins)
                                   || jsonb_build_object('recomputedFromDelta', te.delta, 'recomputedAt', NOW(),
                                                         'recomputedBy', 'realign-sub-index-positions')
                    FROM unnest($1::uuid[], $2::numeric[], $3::int[], $4::int[]) AS u(id, delta, counted, wins)
                    WHERE te.id = u.id
                `, [plans.map((p) => p.id), plans.map((p) => p.next), plans.map((p) => p.counted), plans.map((p) => p.wins)]);
            }
        }

        // Read back inside the transaction so a dry run reports the real result.
        const { rows: left } = await client.query(`
            SELECT count(*)::int AS n FROM index_positions c
            JOIN tickers t ON t.key = c.ticker_key AND t.parent_key IS NOT NULL
            JOIN index_positions p ON p.ticker_key = t.parent_key AND p.event_id = c.event_id AND p.market_type = c.market_type
            WHERE c.market_id = p.market_id AND c.side_index = p.side_index
              AND (c.entry_prob <> p.entry_prob OR c.locked_at <> p.locked_at)
        `);
        console.log(`\nTiming drifts remaining after this run: ${left[0].n}`);

        if (DRY_RUN) {
            await client.query('ROLLBACK');
            console.log('--dry-run: rolled back, nothing written.');
        } else {
            await client.query('COMMIT');
            console.log('Committed.');
        }
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
