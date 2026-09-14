// Backfills the twelve per-league soccer slices over the moneylines their parents
// ($FOOTY / $SOCDOGS) already hold.
//
// WHY THIS IS POSSIBLE AT ALL, when index_positions is famously un-backfillable. The rule
// in create_index_positions_table.sql's header is that a position must be locked BEFORE
// kickoff, because entry_prob comes from polymarket_props - a cache of OPEN markets,
// upserted in place with no price history - so a finished game's pre-game price is gone.
// That rule binds anything deriving a NEW price. It does not bind this script, because
// $FOOTY and $SOCDOGS already locked every soccer moneyline at the proper time and
// index_positions is permanent. Every number here is COPIED from a row we already own;
// nothing is re-derived from the cache. Read that as the hard constraint it is: if this
// script ever grows a polymarket_props join, it is wrong.
//
// $EPLCHALK is by construction the EPL-filtered subset of $FOOTY - same canonical market
// (positionsForGame memoizes one per market type per game), same line, same entry_prob,
// same result. So the clone is not an approximation of what the lock job would have
// written; it is exactly that. This is the same argument scripts/retro-nfl-totals-
// indexes.ts makes one level up, and it holds here for the same reason.
//
// WITHOUT THIS the twelve slices launch as twelve flat lines at 100.00, and there is no
// daily volatility to re-tune their price_scale against for a month (see
// seed_ticker_prices_v4.sql, which seeds them PROVISIONALLY at 65 for exactly that
// reason). With it they arrive carrying their real history.
//
// Unsettled positions are cloned too. Today's soccer slate locked under $FOOTY/$SOCDOGS
// before these indexes existed, so index-lock can never pick it up for them
// (event_start_time > NOW() excludes a kicked-off game). Cloning now means those games
// settle normally alongside their parents on the next /api/index-settle run.
//
// Closes are written only for rows that are already settled, one per (ticker, close_date),
// reusing closeDelta so the arithmetic is the production one. occurred_at is copied from
// the parent's close for that date so the charts line up.
//
//   npx tsx scripts/retro-soccer-league-indexes.ts --dry-run   <- ALWAYS first
//   npx tsx scripts/retro-soccer-league-indexes.ts             <- write, in one transaction
//
// Idempotent: positions upsert on (ticker_key, event_id) DO NOTHING, closes on
// (ticker_key, close_date) DO UPDATE. Safe to re-run after a later matchday to pick up
// newly locked parent rows, though from here on index-lock handles those directly.
//
// The three DORMANT pairs (ucl/carabao/dfb) are listed but skipped unless their ticker
// exists AND is active - they are switched on later by a one-line UPDATE, and this script
// should be re-run at that point to give the newly-live slice its parent's history.
//
// Env: DATABASE_URL. Run AFTER add_tickers_batch6.sql + seed_ticker_prices_v4.sql.

import { Pool } from 'pg';
import dotenv from 'dotenv';
import { closeDelta } from '../lib/pages-functions/index-slate';
import { LEAGUE_GROUPS } from '../lib/pages-functions/league-rules';

dotenv.config();

const DRY_RUN = process.argv.includes('--dry-run');

if (!process.env.DATABASE_URL) {
    console.error('Required env: DATABASE_URL.');
    process.exit(2);
}

// child ticker -> (parent it slices, the LEAGUE_GROUPS key naming the leagues it claims).
// The leagues themselves are read from LEAGUE_GROUPS rather than written out here, so
// this script and the live rule can never disagree about what a slice covers.
const CLONE: Array<{ parent: string; child: string; group: string }> = [
    { parent: 'footy', child: 'mlschalk', group: 'mls' },
    { parent: 'socdogs', child: 'mlsdogs', group: 'mls' },
    { parent: 'footy', child: 'laligachalk', group: 'laliga' },
    { parent: 'socdogs', child: 'laligadogs', group: 'laliga' },
    { parent: 'footy', child: 'eflchalk', group: 'efl' },
    { parent: 'socdogs', child: 'efldogs', group: 'efl' },
    { parent: 'footy', child: 'eplchalk', group: 'epl' },
    { parent: 'socdogs', child: 'epldogs', group: 'epl' },
    { parent: 'footy', child: 'bundeschalk', group: 'bundesliga' },
    { parent: 'socdogs', child: 'bundesdogs', group: 'bundesliga' },
    { parent: 'footy', child: 'ligue1chalk', group: 'ligue1' },
    { parent: 'socdogs', child: 'ligue1dogs', group: 'ligue1' },
    // Dormant today - skipped automatically while active = false.
    { parent: 'footy', child: 'uclchalk', group: 'ucl' },
    { parent: 'socdogs', child: 'ucldogs', group: 'ucl' },
    { parent: 'footy', child: 'carachalk', group: 'carabao' },
    { parent: 'socdogs', child: 'caradogs', group: 'carabao' },
    { parent: 'footy', child: 'dfbchalk', group: 'dfb' },
    { parent: 'socdogs', child: 'dfbdogs', group: 'dfb' },
];

async function main(): Promise<void> {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
        const { rows: known } = await pool.query<{ key: string; active: boolean }>(
            `SELECT key, active FROM tickers WHERE key = ANY($1::text[])`,
            [CLONE.map((c) => c.child)],
        );
        const activeOf = new Map(known.map((r) => [r.key, r.active]));
        const missing = CLONE.filter((c) => !activeOf.has(c.child)).map((c) => c.child);
        if (missing.length === CLONE.length) {
            console.error('None of the league slices exist - run add_tickers_batch6.sql first.');
            process.exit(2);
        }
        const todo = CLONE.filter((c) => activeOf.get(c.child) === true);
        const skipped = CLONE.filter((c) => activeOf.get(c.child) === false);
        if (skipped.length > 0) {
            console.log(`Skipping ${skipped.length} dormant slice(s): ${skipped.map((s) => s.child).join(', ')}`);
            console.log('  (re-run this script after switching one to active = true)');
        }
        if (missing.length > 0) console.log(`Not present, ignored: ${missing.join(', ')}`);

        console.log(DRY_RUN ? '\nDRY RUN - no writes.\n' : '');

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            for (const { parent, child, group } of todo) {
                const leagues = LEAGUE_GROUPS[group];
                if (!leagues || leagues.length === 0) {
                    console.error(`  ${child}: LEAGUE_GROUPS has no key "${group}" - refusing to guess.`);
                    continue;
                }
                // Clone every position the parent holds in this slice's leagues. Column
                // list is explicit rather than SELECT *: close_id must NOT be copied (the
                // child gets its own close events), and a future column should fail loudly
                // here rather than silently carry a parent's value onto a child.
                //
                // The team-identity columns ARE copied - they describe the game and the
                // side, both identical between parent and child, and re-deriving them
                // would be the one thing this script must never do.
                const ins = await client.query(
                    `INSERT INTO index_positions (
                         ticker_key, provider, market_id, condition_id, league, event_id,
                         away, home, kickoff, market_type, market_line,
                         side_index, side_label, entry_prob, locked_at,
                         sel_volume, sel_liquidity, sel_runner_up_line, sel_median_agreed,
                         result, winning_index, settled_at, contrib,
                         away_team_id, home_team_id, subject_team_id, subject_src,
                         away_abbr, home_abbr
                     )
                     SELECT $2, provider, market_id, condition_id, league, event_id,
                            away, home, kickoff, market_type, market_line,
                            side_index, side_label, entry_prob, locked_at,
                            sel_volume, sel_liquidity, sel_runner_up_line, sel_median_agreed,
                            result, winning_index, settled_at, contrib,
                            away_team_id, home_team_id, subject_team_id, subject_src,
                            away_abbr, home_abbr
                     FROM index_positions
                     WHERE ticker_key = $1 AND league = ANY($3::text[])
                     ON CONFLICT (ticker_key, event_id) DO NOTHING
                     RETURNING id, result`,
                    [parent, child, leagues],
                );
                const settled = ins.rows.filter((r) => r.result === 'win' || r.result === 'loss').length;
                console.log(`${child}: cloned ${ins.rowCount} position(s) from ${parent} [${leagues.join(', ')}] (${settled} settled, ${ins.rowCount! - settled} pending)`);

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
                                retro: 'retro-soccer-league-indexes',
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
                `SELECT tk.key, tk.price_baseline::float8 AS baseline, tk.price_scale::float8 AS scale,
                        COALESCE(SUM(e.delta), 0)::float8 AS value
                 FROM tickers tk
                 LEFT JOIN ticker_events e ON e.ticker_key = tk.key AND e.source = 'slate'
                 WHERE tk.key = ANY($1::text[])
                 GROUP BY tk.key, tk.price_baseline, tk.price_scale ORDER BY tk.key`,
                [todo.map((c) => c.child)],
            );
            console.log('');
            for (const t of totals) {
                const price = t.baseline * Math.exp(t.value / t.scale);
                console.log(`$${t.key.toUpperCase().padEnd(12)} cumulative ${t.value >= 0 ? '+' : ''}${t.value.toFixed(3)}  ->  price ${price.toFixed(2)}`);
            }

            // Each chalk/dogs pair must come out as exact negatives of one another - they
            // hold opposite sides of the same market on the same games, so anything else
            // means the clone picked up rows it should not have.
            console.log('');
            const valueOf = new Map(totals.map((t) => [t.key, t.value as number]));
            for (let i = 0; i < todo.length; i += 2) {
                const a = todo[i], b = todo[i + 1];
                if (!a || !b || a.group !== b.group) continue;
                const va = valueOf.get(a.child), vb = valueOf.get(b.child);
                if (va === undefined || vb === undefined) continue;
                const sum = va + vb;
                console.log(`mirror ${a.child}/${b.child}: values sum to ${sum.toFixed(6)}${Math.abs(sum) > 1e-6 ? '   <-- NOT MIRRORED' : ''}`);
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
