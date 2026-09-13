// Backfills $NFLO and $NFLU over the NFL totals their parents already hold.
//
// WHY THIS IS POSSIBLE AT ALL, when index_positions is famously un-backfillable. The rule
// in create_index_positions_table.sql's header is that a position must be locked BEFORE
// kickoff, because entry_prob comes from polymarket_props - a cache of OPEN markets,
// upserted in place with no price history - so a finished game's pre-game price is gone.
// That rule binds anything deriving a NEW price. It does not bind this script, because
// $OVERS and $UNDERS already locked every NFL totals market at the proper time and
// index_positions is permanent. Every number here is COPIED from a row we already own;
// nothing is re-derived from the cache. Read that as the hard constraint it is: if this
// script ever grows a polymarket_props join, it is wrong.
//
// $NFLO is by construction the NFL-filtered subset of $OVERS - same canonical market
// (positionsForGame memoizes one per market type per game), same line, same entry_prob,
// same result. So the clone is not an approximation of what the lock job would have
// written; it is exactly that.
//
// Unsettled positions are cloned too. Today's NFL slate locked under $OVERS/$UNDERS
// before these two indexes existed, so index-lock can never pick it up for them
// (event_start_time > NOW() excludes a kicked-off game). Cloning now means those games
// settle normally alongside their parents on the next /api/index-settle run.
//
// Closes are written only for rows that are already settled, one per (ticker, close_date),
// reusing closeDelta so the arithmetic is the production one. occurred_at is copied from
// the parent's close for that date so the charts line up.
//
//   npx tsx scripts/retro-nfl-totals-indexes.ts --dry-run   <- ALWAYS first
//   npx tsx scripts/retro-nfl-totals-indexes.ts             <- write, in one transaction
//
// Idempotent: positions upsert on (ticker_key, event_id) DO NOTHING, closes on
// (ticker_key, close_date) DO NOTHING. Safe to re-run after a later NFL week to pick up
// newly locked parent rows, though from here on index-lock handles those directly.
//
// Env: DATABASE_URL. Run AFTER add_tickers_batch4.sql + seed_ticker_prices_v2.sql.

import { Pool } from 'pg';
import dotenv from 'dotenv';
import { closeDelta } from '../lib/pages-functions/index-slate';

dotenv.config();

const DRY_RUN = process.argv.includes('--dry-run');

if (!process.env.DATABASE_URL) {
    console.error('Required env: DATABASE_URL.');
    process.exit(2);
}

// parent ticker -> the child that slices it to NFL.
const CLONE: Array<{ parent: string; child: string }> = [
    { parent: 'overs', child: 'nflo' },
    { parent: 'unders', child: 'nflu' },
];

async function main(): Promise<void> {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
        for (const { parent, child } of CLONE) {
            const { rows: exists } = await pool.query(`SELECT 1 FROM tickers WHERE key = $1`, [child]);
            if (exists.length === 0) {
                console.error(`Ticker "${child}" does not exist - run add_tickers_batch4.sql first.`);
                process.exit(2);
            }
        }

        console.log(DRY_RUN ? '\nDRY RUN - no writes.\n' : '');

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            for (const { parent, child } of CLONE) {
                // Clone every NFL totals position the parent holds. Column list is
                // explicit rather than SELECT *: close_id must NOT be copied (the child
                // gets its own close events), and a future column should fail loudly here
                // rather than silently carry a parent's value onto a child.
                const ins = await client.query(
                    `INSERT INTO index_positions (
                         ticker_key, provider, market_id, condition_id, league, event_id,
                         away, home, kickoff, market_type, market_line,
                         side_index, side_label, entry_prob, locked_at,
                         sel_volume, sel_liquidity, sel_runner_up_line, sel_median_agreed,
                         result, winning_index, settled_at, contrib
                     )
                     SELECT $2, provider, market_id, condition_id, league, event_id,
                            away, home, kickoff, market_type, market_line,
                            side_index, side_label, entry_prob, locked_at,
                            sel_volume, sel_liquidity, sel_runner_up_line, sel_median_agreed,
                            result, winning_index, settled_at, contrib
                     FROM index_positions
                     WHERE ticker_key = $1 AND league = 'NFL' AND market_type = 'totals'
                     ON CONFLICT (ticker_key, event_id) DO NOTHING
                     RETURNING id, result`,
                    [parent, child],
                );
                const settled = ins.rows.filter((r) => r.result === 'win' || r.result === 'loss').length;
                console.log(`${child}: cloned ${ins.rowCount} position(s) from ${parent} (${settled} already settled, ${ins.rowCount! - settled} pending)`);

                // One close per date the child now has settled positions on, with the
                // scale/smoothing and timestamp of the PARENT's close for that date - so
                // parent and child describe the same day with the same arithmetic and sit
                // at the same point on the chart.
                const { rows: days } = await client.query(
                    `SELECT pe.close_date, pe.occurred_at,
                            (pe.metadata->>'scalePct')::float8  AS scale_pct,
                            (pe.metadata->>'smoothing')::float8 AS smoothing,
                            array_agg(c.id)                     AS ids,
                            array_agg(c.contrib::float8)        AS contribs,
                            COUNT(*) FILTER (WHERE c.result = 'win')::int AS wins
                     FROM index_positions c
                     JOIN index_positions p
                       ON p.ticker_key = $1 AND p.event_id = c.event_id
                     JOIN ticker_events pe ON pe.id = p.close_id
                     WHERE c.ticker_key = $2
                       AND c.result IN ('win','loss')
                       AND c.close_id IS NULL
                     GROUP BY pe.close_date, pe.occurred_at, pe.metadata
                     ORDER BY pe.close_date`,
                    [parent, child],
                );

                for (const d of days) {
                    if (!Number.isFinite(d.scale_pct) || !Number.isFinite(d.smoothing)) {
                        console.log(`  ${d.close_date}: parent close has no scalePct/smoothing - skipped`);
                        continue;
                    }
                    const delta = closeDelta(d.contribs as number[], { smoothing: d.smoothing, scalePct: d.scale_pct });
                    if (delta === null) continue;

                    const closeRes = await client.query(
                        `INSERT INTO ticker_events (ticker_key, event_type, source, close_date, delta, occurred_at, metadata)
                         VALUES ($1, 'close', 'slate', $2, $3, $4, $5::jsonb)
                         ON CONFLICT (ticker_key, close_date) WHERE source = 'slate'
                         DO UPDATE SET delta = EXCLUDED.delta, metadata = EXCLUDED.metadata
                         RETURNING id`,
                        [
                            child,
                            d.close_date,
                            delta,
                            d.occurred_at,
                            JSON.stringify({
                                positionsCounted: (d.contribs as number[]).length,
                                positionsWon: d.wins,
                                scalePct: d.scale_pct,
                                smoothing: d.smoothing,
                                retro: 'retro-nfl-totals-indexes',
                            }),
                        ],
                    );
                    await client.query(
                        `UPDATE index_positions SET close_id = $1 WHERE id = ANY($2::uuid[])`,
                        [closeRes.rows[0].id, d.ids],
                    );
                    const sign = delta >= 0 ? '+' : '';
                    console.log(`  ${String(d.close_date).slice(0, 10)}  close ${sign}${delta.toFixed(3)}  (${(d.contribs as number[]).length} position(s), ${d.wins} won)`);
                }
            }

            // Read the result back inside the transaction so a dry run still reports the
            // real numbers before rolling them away.
            const { rows: totals } = await client.query(
                `SELECT tk.key, tk.price_scale::float8 AS scale,
                        COALESCE(SUM(e.delta), 0)::float8 AS value
                 FROM tickers tk
                 LEFT JOIN ticker_events e ON e.ticker_key = tk.key AND e.source = 'slate'
                 WHERE tk.key IN ('nflo','nflu')
                 GROUP BY tk.key, tk.price_scale ORDER BY tk.key`,
            );
            console.log('');
            for (const t of totals) {
                const price = 100 * Math.exp(t.value / t.scale);
                console.log(`$${t.key.toUpperCase()}  cumulative ${t.value >= 0 ? '+' : ''}${t.value.toFixed(3)}  ->  price ${price.toFixed(2)}`);
            }
            const [a, b] = totals;
            if (a && b) {
                const pa = 100 * Math.exp(a.value / a.scale);
                const pb = 100 * Math.exp(b.value / b.scale);
                const drift = Math.abs(Math.log(pa) + Math.log(pb) - (Math.log(100) + Math.log(100)));
                console.log(`mirror: values sum to ${(a.value + b.value).toFixed(6)}, log-price drift ${drift.toExponential(2)}`);
            }

            if (DRY_RUN) {
                await client.query('ROLLBACK');
                console.log('\n--dry-run: rolled back, nothing written.');
            } else {
                await client.query('COMMIT');
                console.log('\nCommitted.');
            }
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } finally {
        await pool.end();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
