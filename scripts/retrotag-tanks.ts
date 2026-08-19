// Mechanical retrotagging of existing published Tanks onto the Exchange tickers.
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
// RETROTAG_PREFER=favorite flips the side rule below.
//
// Side rule (user decision, 2026-08-19): on a binary market both sides are equally
// "extreme" (their probs mirror around 0.5), so a preference has to be explicit -
// default is the UNDERDOG side (the editorial storyline): dogs, plus moonshot when
// under the config threshold. RETROTAG_PREFER=favorite mirrors: chalk, plus locks.
//
// Outcome handling per POST: 201 tagged; 409 already_tagged = skip (safe rerun);
// 502 retriable (CLOB/Gamma hiccup, or empty price history on long-closed markets) =
// retry twice then park on the hand-tag list - NEVER force-inserted; data-shaped 422s
// also park; 422 ineligible is an anomaly (this script's plan disagreed with the API)
// and fails the run.

import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const BASE_URL = process.env.BASE_URL || '';
const TICKER_SECRET = process.env.TICKER_SECRET || '';
const SETTLE_SECRET = process.env.SETTLE_SECRET || '';
const DRY_RUN = process.argv.includes('--dry-run');
const NO_SETTLE = process.argv.includes('--no-settle');
const PREFER_FAVORITE = process.env.RETROTAG_PREFER === 'favorite';

if (!process.env.DATABASE_URL || !BASE_URL || !TICKER_SECRET || (!NO_SETTLE && !DRY_RUN && !SETTLE_SECRET)) {
    console.error('Required env: DATABASE_URL, BASE_URL, TICKER_SECRET (+ SETTLE_SECRET unless --no-settle/--dry-run).');
    process.exit(2);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

interface CandidateRow {
    slug: string;
    outcome_prices: unknown;
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
        `SELECT slug, game_snapshot->'prop'->'odds'->'outcomePrices' AS outcome_prices
         FROM tank_pages
         WHERE status = 'published' AND visibility = 'app' AND provider = 'polymarket'
           AND slug IS NOT NULL AND model_output IS NOT NULL
           AND game_snapshot->'prop'->>'id' IS NOT NULL
         ORDER BY published_at NULLS LAST, created_at`);
    const candidates = rows as CandidateRow[];
    console.log(`${candidates.length} candidate tank(s); side rule: ${PREFER_FAVORITE ? 'FAVORITE (chalk/locks)' : 'UNDERDOG (dogs/moonshot)'}; thresholds moonshot<${moonshotMax} locks>=${locksMin}\n`);

    // Build the mechanical plan.
    const plans: TagPlan[] = [];
    const skipped: Array<{ slug: string; reason: string }> = [];
    for (const c of candidates) {
        const probs = Array.isArray(c.outcome_prices) ? c.outcome_prices.map(Number) : [];
        if (probs.length === 0 || probs.some((p) => !Number.isFinite(p))) {
            skipped.push({ slug: c.slug, reason: 'no usable snapshot outcomePrices' });
            continue;
        }
        // Preferred side: the underdog (min prob) or, in favorite mode, the max-prob side.
        const side = PREFER_FAVORITE
            ? probs.indexOf(Math.max(...probs))
            : probs.indexOf(Math.min(...probs));
        const p = probs[side];
        const tickers = PREFER_FAVORITE
            ? [...(p >= 0.5 ? ['chalk'] : []), ...(p >= locksMin ? ['locks'] : [])]
            : [...(p < 0.5 ? ['dogs'] : []), ...(p < moonshotMax ? ['moonshot'] : [])];
        if (tickers.length === 0) {
            // e.g. a perfectly even market in underdog mode (p === 0.5 -> not < 0.5)
            skipped.push({ slug: c.slug, reason: `preferred side prob ${p.toFixed(3)} eligible for no ticker` });
            continue;
        }
        plans.push({ slug: c.slug, side, prob: p, tickers });
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
