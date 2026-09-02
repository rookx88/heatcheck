// Mechanical retrotagging of existing published Tanks onto the Exchange tickers.
// NOTE: superseded for ongoing use by the automated pipeline - backend.ts tags at
// publish time and /api/curate's daily sweep (sweepUntaggedTanks) is the catch-all.
// Keep this script for one-off backfills against Tanks older than the sweep window.
// Seeds the ticker layer with real data by driving the REAL production API - this
// script never writes to the database directly: every tag goes through
// POST /api/ticker-tags (which enforces eligibility, uniqueness, CLOB-derived deltas,
// and audit metadata), and settlement through POST /api/settle. DATABASE_URL is used
// read-only, to enumerate candidates and read the eligibility thresholds.
//
//   npx tsx scripts/retrotag-tanks.ts --dry-run     <- ALWAYS run this first; review the plan
//   npx tsx scripts/retrotag-tanks.ts               <- tag + settle
//   npx tsx scripts/retrotag-tanks.ts --no-settle   <- tag only
//
// Env: DATABASE_URL, BASE_URL (a deployed URL with TICKER_SECRET/SETTLE_SECRET bound,
// e.g. the branch preview), TICKER_SECRET, SETTLE_SECRET.
//
// Side rule (user decision, 2026-08-19, revised same day): tag BOTH sides of every
// market, each with its own eligible tickers - underdog side -> dogs (+ moonshot when
// under the config threshold), favorite side -> chalk (+ locks at/above its
// threshold). On a binary market the two sides mirror around 0.5, so this is what
// makes dogs/chalk (and locks/moonshot) move inversely off the same real market: one
// history drives both tag deltas with opposite signs, one outcome settles one side up
// and the other down. Tagging only one side (the original rule) left the favorite-side
// tickers with no events at all.
// Batch 2 (2026-08-29): the same pass also plans overs/unders (totals markets, by
// outcome label) and gridiron/footy (league-scoped, market-favored side) - used to
// backfill those tickers from existing published Tanks after their launch.
//
// Batch 3 (2026-09-02): this script no longer mirrors the eligibility rules at all. It
// used to keep a private copy - a hardcoded ticker list, its own SOCCER_LEAGUES and its
// own isMarketFavorite - which made it a FIFTH place a new rule type had to be added by
// hand, and the one place that was missed when the league sub-indexes landed. It now
// reads the active tickers (key + rule_type) straight from the table and asks the real
// checkEligibility() from lib/pages-functions/tickers.ts, the same function the API
// re-validates with. A new ticker is therefore backfillable the moment its row exists,
// with no edit here, and this script can no longer disagree with the endpoint about
// what is eligible.
//
// Outcome handling per POST: 201 tagged; 409 already_tagged = skip (safe rerun);
// 502 retriable (CLOB/Gamma hiccup, or empty price history on long-closed markets) =
// retry twice then park on the hand-tag list - NEVER force-inserted; data-shaped 422s
// also park; 422 ineligible is an anomaly (this script's plan disagreed with the API)
// and fails the run.

import { Pool } from 'pg';
import dotenv from 'dotenv';
import {
    checkEligibility,
    type EligibilityContext,
    type TickerConfig,
} from '../lib/pages-functions/tickers';

dotenv.config();

const BASE_URL = process.env.BASE_URL || '';
const TICKER_SECRET = process.env.TICKER_SECRET || '';
const SETTLE_SECRET = process.env.SETTLE_SECRET || '';
const DRY_RUN = process.argv.includes('--dry-run');
const NO_SETTLE = process.argv.includes('--no-settle');

if (!process.env.DATABASE_URL || !BASE_URL || !TICKER_SECRET || (!NO_SETTLE && !DRY_RUN && !SETTLE_SECRET)) {
    console.error('Required env: DATABASE_URL, BASE_URL, TICKER_SECRET (+ SETTLE_SECRET unless --no-settle/--dry-run).');
    process.exit(2);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

interface CandidateRow {
    slug: string;
    league: string | null;
    market: string | null;
    outcome_prices: unknown;
    outcome_labels: unknown;
}

interface TagPlan {
    slug: string;
    side: number;
    prob: number;
    tickers: string[];
}

interface TagResult {
    slug: string;
    tickerKey: string;
    side: number;
    status: 'tagged' | 'already_tagged' | 'hand_tag' | 'anomaly';
    detail: string;
}

async function postTag(slug: string, tickerKey: string, relevantSide: number): Promise<{ status: number; json: any }> {
    const res = await fetch(`${BASE_URL}/api/ticker-tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ticker-Secret': TICKER_SECRET },
        body: JSON.stringify({ slug, tickerKey, relevantSide }),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* non-JSON -> null */ }
    return { status: res.status, json };
}

async function main() {
    const { rows: cfgRows } = await pool.query(
        `SELECT config FROM game_config WHERE key = 'tickers' AND active`);
    if (cfgRows.length !== 1) throw new Error("No active game_config['tickers'] row.");
    const moonshotMax = Number(cfgRows[0].config.moonshot_max_prob);
    const locksMin = Number(cfgRows[0].config.locks_min_prob);

    const { rows } = await pool.query(
        `SELECT slug, league,
                game_snapshot->'prop'->>'market' AS market,
                game_snapshot->'prop'->'odds'->'outcomePrices' AS outcome_prices,
                game_snapshot->'prop'->'odds'->'outcomes' AS outcome_labels
         FROM tank_pages
         WHERE status = 'published' AND visibility = 'app' AND provider IN ('polymarket', 'kalshi')
           AND slug IS NOT NULL AND model_output IS NOT NULL
           AND game_snapshot->'prop'->>'id' IS NOT NULL
         ORDER BY published_at NULLS LAST, created_at`);
    const candidates = rows as CandidateRow[];

    // Every active ticker, in board order. Read from the table rather than listed here,
    // so a newly-seeded index is backfillable without touching this script.
    const { rows: tickerRows } = await pool.query(
        `SELECT key, rule_type FROM tickers WHERE active ORDER BY tab_order`);
    const activeTickers = tickerRows as Array<{ key: string; rule_type: string }>;
    console.log(`${candidates.length} candidate tank(s); rule: BOTH sides of every market, `
        + `against all ${activeTickers.length} active tickers (${activeTickers.map((t) => t.key).join(', ')}); `
        + `thresholds moonshot<${moonshotMax} locks>=${locksMin}\n`);

    // The config checkEligibility reads. Same row the endpoint loads, so a threshold
    // change can't make this script and the API disagree.
    const cfg = cfgRows[0].config as TickerConfig;

    // Build the mechanical plan: every side of every market, with that side's eligible
    // tickers. One plan entry per (tank, side). Eligibility is the REAL function, not a
    // local restatement of it - see the batch-3 note in the header.
    const plans: TagPlan[] = [];
    const skipped: Array<{ slug: string; reason: string }> = [];
    for (const c of candidates) {
        const probs = Array.isArray(c.outcome_prices) ? c.outcome_prices.map(Number) : [];
        if (probs.length === 0 || probs.some((p) => !Number.isFinite(p))) {
            skipped.push({ slug: c.slug, reason: 'no usable snapshot outcomePrices' });
            continue;
        }
        const outcomes = Array.isArray(c.outcome_labels) ? c.outcome_labels.map(String) : null;
        for (let side = 0; side < probs.length; side++) {
            const ctx: EligibilityContext = { side, probs, league: c.league, market: c.market, outcomes };
            const tickers = activeTickers
                .filter((t) => checkEligibility(t.rule_type, ctx, cfg).ok)
                .map((t) => t.key);
            plans.push({ slug: c.slug, side, prob: probs[side], tickers });
        }
    }

    console.log('Plan:');
    for (const p of plans) {
        console.log(`  ${p.slug}: side ${p.side} @ ${p.prob.toFixed(3)} -> ${p.tickers.join(' + ')}`);
    }
    for (const s of skipped) console.log(`  (skip) ${s.slug}: ${s.reason}`);
    if (DRY_RUN) {
        console.log('\n--dry-run: no tags posted, no settlement triggered.');
        return;
    }

    // Execute sequentially - each 201 costs the server a Gamma + CLOB call.
    const results: TagResult[] = [];
    for (const plan of plans) {
        for (const tickerKey of plan.tickers) {
            let outcome: TagResult | null = null;
            for (let attempt = 1; attempt <= 3 && !outcome; attempt++) {
                const { status, json } = await postTag(plan.slug, tickerKey, plan.side);
                if (status === 201) {
                    outcome = { slug: plan.slug, tickerKey, side: plan.side, status: 'tagged', detail: `delta ${json?.delta}${json?.capped ? ' (capped)' : ''}` };
                } else if (status === 409) {
                    outcome = { slug: plan.slug, tickerKey, side: plan.side, status: 'already_tagged', detail: 'skip' };
                } else if (status === 502 && attempt < 3) {
                    await new Promise((r) => setTimeout(r, 1500 * attempt));
                } else if (status === 502) {
                    outcome = { slug: plan.slug, tickerKey, side: plan.side, status: 'hand_tag', detail: `${json?.code}: ${json?.message}` };
                } else if (status === 422 && json?.code === 'ineligible') {
                    outcome = { slug: plan.slug, tickerKey, side: plan.side, status: 'anomaly', detail: json?.message ?? 'ineligible' };
                } else {
                    outcome = { slug: plan.slug, tickerKey, side: plan.side, status: 'hand_tag', detail: `${status} ${json?.code ?? ''}: ${json?.message ?? ''}` };
                }
            }
            results.push(outcome!);
            console.log(`  ${outcome!.status.toUpperCase().padEnd(14)} ${plan.slug} -> ${tickerKey}: ${outcome!.detail}`);
        }
    }

    if (!NO_SETTLE) {
        console.log('\nTriggering settlement scan...');
        const res = await fetch(`${BASE_URL}/api/settle`, { method: 'POST', headers: { 'X-Settle-Secret': SETTLE_SECRET } });
        const json: any = await res.json().catch(() => null);
        const counts: Record<string, number> = {};
        for (const r of json?.tickerResults ?? []) counts[r.status] = (counts[r.status] ?? 0) + 1;
        console.log(`  settle ${res.status}; tickerTagsChecked=${json?.tickerTagsChecked}; ${JSON.stringify(counts)}`);
    }

    const tally = (s: TagResult['status']) => results.filter((r) => r.status === s).length;
    console.log(`\nTotals: ${tally('tagged')} tagged, ${tally('already_tagged')} already tagged, ${tally('hand_tag')} for hand-tagging, ${tally('anomaly')} anomalies.`);
    const handTag = results.filter((r) => r.status === 'hand_tag');
    if (handTag.length) {
        console.log('Hand-tag list (CLOB history unavailable or data-shaped rejection - tag manually or leave):');
        for (const h of handTag) console.log(`  ${h.slug} -> ${h.tickerKey} (side ${h.side}): ${h.detail}`);
    }
    process.exit(tally('anomaly') > 0 ? 1 : 0);
}

main()
    .catch((err) => {
        console.error('Retrotag run aborted:', err);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
