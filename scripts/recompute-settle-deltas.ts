// One-off recompute of existing ticker settle-event deltas onto the odds-aware rule
// (computeSettleDelta in lib/pages-functions/tickers.ts): +(1-p)*settle_scale_pct on a
// win, -p*settle_scale_pct on a loss, p = the tagged side's frozen snapshot
// probability. Run once at the flat->odds-aware cutover (user decision, 2026-08-28):
// the old flat +/-settle_win/loss_pct scheme had put ~+2.4pts of structural drift per
// settle into chalk (and the mirror into dogs), carrying them past +/-100 - values the
// UI renders as impossible percentages.
//
// This is the ONE sanctioned exception to ticker_events' append-only rule: it rewrites
// 'settle' deltas in place (tag deltas are never touched) because appending correction
// events would leave the drift visible in every historical chart. Each rewritten row
// keeps its full audit trail: metadata gains oddsAware/sideProb/scalePct plus
// recomputedFromDelta/recomputedAt, so the pre-recompute value remains recoverable.
//
//   npx tsx scripts/recompute-settle-deltas.ts --dry-run   <- ALWAYS first; review table
//   npx tsx scripts/recompute-settle-deltas.ts             <- rewrite, in one transaction
//
// Env: DATABASE_URL. Idempotent: rows whose metadata already carries oddsAware (from a
// prior run, or written by the new /api/settle code) are skipped.

import { Pool } from 'pg';
import dotenv from 'dotenv';
import { computeSettleDelta } from '../lib/pages-functions/tickers';

dotenv.config();

const DRY_RUN = process.argv.includes('--dry-run');

if (!process.env.DATABASE_URL) {
    console.error('Required env: DATABASE_URL.');
    process.exit(2);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

interface SettleEventRow {
    id: string;
    ticker_key: string;
    old_delta: number;
    metadata: { winningIndex?: unknown; relevantSide?: unknown; oddsAware?: unknown } | null;
    relevant_side: number;
    side_prob: string | null;
    slug: string | null;
    visibility: string;
    settle_win_pct: number;
    settle_loss_pct: number;
}

async function main(): Promise<void> {
    const { rows: cfgRows } = await pool.query(
        `SELECT config FROM game_config WHERE key = 'tickers' AND active`);
    const scalePct = Number(cfgRows[0]?.config?.settle_scale_pct);
    if (!Number.isFinite(scalePct)) {
        console.error("game_config['tickers'] has no numeric settle_scale_pct - run seed_ticker_config.sql (v2) first.");
        process.exit(2);
    }

    const { rows } = await pool.query(`
        SELECT e.id, e.ticker_key, e.delta::float8 AS old_delta, e.metadata,
               tt.relevant_side,
               t.game_snapshot->'prop'->'odds'->'outcomePrices'->>tt.relevant_side AS side_prob,
               t.slug, t.visibility,
               tk.settle_win_pct::float8 AS settle_win_pct,
               tk.settle_loss_pct::float8 AS settle_loss_pct
        FROM ticker_events e
        JOIN ticker_tags tt ON tt.id = e.ticker_tag_id
        JOIN tank_pages t ON t.id = e.tank_id
        JOIN tickers tk ON tk.key = e.ticker_key
        WHERE e.event_type = 'settle'
        ORDER BY e.occurred_at, e.id`);
    const events = rows as SettleEventRow[];
    console.log(`${events.length} settle events found; scale = ${scalePct}. ${DRY_RUN ? 'DRY RUN - no writes.' : ''}\n`);

    interface Plan { id: string; tickerKey: string; oldDelta: number; newDelta: number; sideProb: number }
    const plans: Plan[] = [];
    let alreadyOddsAware = 0;
    const skippedNoProb: string[] = [];

    for (const ev of events) {
        if (ev.metadata?.oddsAware !== undefined) {
            alreadyOddsAware++;
            continue;
        }
        // The settle writer has always stamped winningIndex/relevantSide; the delta-sign
        // fallback only covers hand-inserted fixture rows (same backstop as
        // getTickerResults). No zero-magnitude ticker exists, so the sign is decisive.
        const won = typeof ev.metadata?.winningIndex === 'number' && typeof ev.metadata?.relevantSide === 'number'
            ? ev.metadata.relevantSide === ev.metadata.winningIndex
            : ev.old_delta >= 0;
        const sideProb = ev.side_prob !== null && ev.side_prob !== '' ? Number(ev.side_prob) : null;
        const { delta, oddsAware } = computeSettleDelta(won, sideProb, scalePct, ev.settle_win_pct, ev.settle_loss_pct);
        if (!oddsAware) {
            // No usable snapshot prob: the fallback equals the old flat scheme, so the
            // stored delta is already right - leave the row untouched and just report.
            skippedNoProb.push(`${ev.ticker_key} ${ev.slug ?? ev.id} (delta stays ${ev.old_delta})`);
            continue;
        }
        plans.push({ id: ev.id, tickerKey: ev.ticker_key, oldDelta: ev.old_delta, newDelta: delta, sideProb: sideProb! });
        const sideLabel = won ? 'win ' : 'loss';
        console.log(`  ${ev.ticker_key.padEnd(8)} ${sideLabel} p=${sideProb!.toFixed(2)}  ${String(ev.old_delta).padStart(7)} -> ${String(delta).padStart(7)}  ${ev.slug ?? ev.id}${ev.visibility !== 'app' ? ` [${ev.visibility}]` : ''}`);
    }

    if (alreadyOddsAware) console.log(`\n${alreadyOddsAware} already odds-aware - skipped.`);
    if (skippedNoProb.length) console.log(`\n${skippedNoProb.length} with no usable snapshot prob - left on the flat fallback:\n  ${skippedNoProb.join('\n  ')}`);

    const perTicker = new Map<string, { old: number; next: number; n: number }>();
    for (const p of plans) {
        const t = perTicker.get(p.tickerKey) ?? { old: 0, next: 0, n: 0 };
        t.old += p.oldDelta;
        t.next += p.newDelta;
        t.n++;
        perTicker.set(p.tickerKey, t);
    }
    console.log('\nSettle-delta sums over the rewritten rows:');
    for (const [key, t] of perTicker) {
        console.log(`  ${key.padEnd(8)} ${t.n} events: ${t.old.toFixed(1)} -> ${t.next.toFixed(1)}`);
    }

    if (DRY_RUN || plans.length === 0) {
        console.log(`\n${DRY_RUN ? 'Dry run - nothing written.' : 'Nothing to rewrite.'}`);
        return;
    }

    const recomputedAt = new Date().toISOString();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const p of plans) {
            await client.query(
                `UPDATE ticker_events
                 SET delta = $2,
                     metadata = metadata || jsonb_build_object(
                         'oddsAware', true, 'sideProb', $3::float8, 'scalePct', $4::float8,
                         'recomputedFromDelta', $5::float8, 'recomputedAt', $6::text)
                 WHERE id = $1 AND event_type = 'settle'`,
                [p.id, p.newDelta, p.sideProb, scalePct, p.oldDelta, recomputedAt]);
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
    console.log(`\n${plans.length} settle events rewritten (single transaction).`);

    const { rows: after } = await pool.query(`
        SELECT tk.key, COALESCE(SUM(e.delta) FILTER (WHERE t.visibility = 'app'), 0)::float8 AS value
        FROM tickers tk
        LEFT JOIN ticker_events e ON e.ticker_key = tk.key
        LEFT JOIN tank_pages t ON t.id = e.tank_id
        WHERE tk.active
        GROUP BY tk.key, tk.tab_order ORDER BY tk.tab_order`);
    console.log('\nTicker values now:');
    for (const r of after) console.log(`  ${String(r.key).padEnd(8)} ${Number(r.value).toFixed(2)}`);
}

main().then(() => pool.end()).catch((err) => {
    console.error(err);
    pool.end();
    process.exit(1);
});
