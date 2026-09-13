// One-off repair of slate close deltas that were overwritten instead of accumulated.
//
// THE BUG (fixed in functions/api/index-settle.ts, 2026-09-13). The close writer selected
// only positions with close_id IS NULL, computed closeDelta over that batch, and then
// upserted with `DO UPDATE SET delta = EXCLUDED.delta` - which REPLACES the day's delta
// rather than adding to it. Every settle run after the first on a given day therefore
// overwrote that day's close with just its own batch, discarding the earlier batches.
// MAX_MARKETS caps a run at 30 markets, so any slate larger than that settles across
// several runs by construction and was guaranteed to hit this.
//
// The positions were never lost - each still carries the close_id it was stamped with, so
// a close's true delta is recoverable from the rows that point at it. That is what this
// script does: for every source='slate' close, recompute closeDelta over its OWN linked
// positions and write the corrected delta and counts back.
//
// Measured before the fix: 5 of $OVERS' 12 closes were wrong, two with the sign flipped,
// and $MLBCHALK's cumulative read +1.160 against its positions' -2.545.
//
// This is the SECOND sanctioned exception to ticker_events being append-only (the first
// is recompute-settle-deltas.ts, whose header explains the reasoning - appending
// correction events would leave the error visible in every historical chart). It rewrites
// `delta` and the two count fields ONLY; occurred_at and close_date are untouched, so
// every chart keeps its shape and only its values move.
//
// scalePct/smoothing come from each close's OWN metadata, never from live config: those
// are the numbers that close was originally built with, and reading live config here
// would let a future v4 retune silently rewrite old history.
//
//   npx tsx scripts/recompute-slate-closes.ts --dry-run   <- ALWAYS first; review table
//   npx tsx scripts/recompute-slate-closes.ts             <- rewrite, in one transaction
//
// RE-PRICES EVERY INDEX. A corrected cumulative changes price = baseline * exp(value /
// scale), so charts, quotes and any open holding's unrealized P/L all move. Idempotent: a
// second run finds every delta already correct and plans nothing.
//
// Env: DATABASE_URL.

import { Pool } from 'pg';
import dotenv from 'dotenv';
import { closeDelta } from '../lib/pages-functions/index-slate';

dotenv.config();

const DRY_RUN = process.argv.includes('--dry-run');

if (!process.env.DATABASE_URL) {
    console.error('Required env: DATABASE_URL.');
    process.exit(2);
}

// NUMERIC(6,3) deltas; anything under half a milli-point is a rounding artifact.
const EPS = 0.0005;

interface CloseRow {
    id: string;
    ticker_key: string;
    close_date: string;
    old_delta: number;
    metadata: { scalePct?: unknown; smoothing?: unknown } | null;
    contribs: number[];
    wins: number;
}

async function main(): Promise<void> {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
        const { rows } = await pool.query(`
            SELECT te.id, te.ticker_key, te.close_date::text AS close_date,
                   te.delta::float8 AS old_delta, te.metadata,
                   COALESCE(array_agg(ip.contrib::float8) FILTER (WHERE ip.id IS NOT NULL), '{}') AS contribs,
                   COUNT(*) FILTER (WHERE ip.result = 'win')::int AS wins
            FROM ticker_events te
            LEFT JOIN index_positions ip ON ip.close_id = te.id
            WHERE te.source = 'slate' AND te.event_type = 'close'
            GROUP BY te.id, te.ticker_key, te.close_date, te.delta, te.metadata
            ORDER BY te.close_date, te.ticker_key
        `);
        const closes = rows as CloseRow[];

        interface Plan { id: string; key: string; date: string; old: number; next: number; counted: number; wins: number }
        const plans: Plan[] = [];
        const skipped: string[] = [];

        for (const c of closes) {
            const scalePct = Number(c.metadata?.scalePct);
            const smoothing = Number(c.metadata?.smoothing);
            if (!Number.isFinite(scalePct) || !Number.isFinite(smoothing)) {
                skipped.push(`${c.ticker_key} ${c.close_date} (metadata has no scalePct/smoothing)`);
                continue;
            }
            if (c.contribs.length === 0) {
                // A close with no linked positions cannot be recomputed from the rows, and
                // deleting it would silently drop history. Report and leave alone.
                skipped.push(`${c.ticker_key} ${c.close_date} (no linked positions)`);
                continue;
            }
            const next = closeDelta(c.contribs, { smoothing, scalePct });
            if (next === null) continue;
            plans.push({
                id: c.id,
                key: c.ticker_key,
                date: c.close_date,
                old: c.old_delta,
                next,
                counted: c.contribs.length,
                wins: c.wins,
            });
        }

        const wrong = plans.filter((p) => Math.abs(p.next - p.old) > EPS);

        console.log(`\n${closes.length} slate closes; ${wrong.length} need correcting.${DRY_RUN ? '  DRY RUN - no writes.' : ''}\n`);
        if (skipped.length) {
            console.log('Skipped:');
            for (const s of skipped) console.log(`  ${s}`);
            console.log('');
        }

        if (wrong.length) {
            console.log('close_date   ticker         stored     correct      shift  counted');
            for (const p of wrong) {
                console.log(
                    `${p.date}   ${p.key.padEnd(10)} ${p.old.toFixed(3).padStart(9)} ${p.next.toFixed(3).padStart(11)} ` +
                    `${(p.next - p.old >= 0 ? '+' : '') + (p.next - p.old).toFixed(3)}`.padStart(11) +
                    `  ${String(p.counted).padStart(5)}`,
                );
            }
        }

        // Per-ticker cumulative shift - the number that actually moves a price.
        const byTicker = new Map<string, { old: number; next: number }>();
        for (const p of plans) {
            const t = byTicker.get(p.key) ?? { old: 0, next: 0 };
            t.old += p.old;
            t.next += p.next;
            byTicker.set(p.key, t);
        }
        console.log('\nticker       slate cumulative: stored -> correct   (shift)');
        for (const [key, t] of [...byTicker].sort((a, b) => Math.abs(b[1].next - b[1].old) - Math.abs(a[1].next - a[1].old))) {
            const shift = t.next - t.old;
            console.log(
                `  ${key.padEnd(10)} ${t.old.toFixed(3).padStart(8)} -> ${t.next.toFixed(3).padStart(8)}   ` +
                `${(shift >= 0 ? '+' : '') + shift.toFixed(3)}`,
            );
        }

        if (DRY_RUN) {
            console.log('\n--dry-run: nothing written.');
            return;
        }
        if (wrong.length === 0) {
            console.log('\nEvery close already matches its positions - nothing to do.');
            return;
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const res = await client.query(
                `UPDATE ticker_events te SET
                     delta = u.delta,
                     metadata = te.metadata
                                || jsonb_build_object('positionsCounted', u.counted, 'positionsWon', u.wins)
                                || jsonb_build_object('recomputedFromDelta', te.delta, 'recomputedAt', NOW())
                 FROM unnest($1::uuid[], $2::numeric[], $3::int[], $4::int[])
                      AS u(id, delta, counted, wins)
                 WHERE te.id = u.id`,
                [
                    wrong.map((p) => p.id),
                    wrong.map((p) => p.next),
                    wrong.map((p) => p.counted),
                    wrong.map((p) => p.wins),
                ],
            );
            await client.query('COMMIT');
            console.log(`\nRewrote ${res.rowCount} close(s). Each keeps its pre-repair value in metadata.recomputedFromDelta.`);
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
