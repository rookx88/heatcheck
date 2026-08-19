// Acceptance suite for the Exchange ticker layer (and the settlement paths it touches).
// There is no test framework in this repo - this script IS the settlement acceptance
// suite: run it after any change to functions/api/settle.ts, lib/pages-functions/
// gamma.ts, lib/pages-functions/tickers.ts, or the ticker endpoints.
//
//   npx tsx scripts/acceptance-tickers.ts
//
// Requirements (env / .env):
//   DATABASE_URL        - a DEV/BRANCH database, NEVER prod: this script inserts and
//                         deletes fixture rows (slug prefix 'acceptance-ticker-') and
//                         temporarily version-flips game_config['tickers'].
//   ACCEPTANCE_CONFIRM  - must be "1" (explicit acknowledgement of the line above).
//   BASE_URL            - where the Pages Functions are serving (default
//                         http://localhost:8788 - `npm run dev:functions`; the dev
//                         server must be pointed at the SAME DATABASE_URL).
//   TICKER_SECRET       - must match the dev server's binding.
//   SETTLE_SECRET       - must match the dev server's binding.
//
// Uses real Polymarket data on purpose: eligibility/tag tests hit a live high-volume
// Gamma market (so the CLOB price-history integration is exercised for real), and
// settlement tests hand-insert ticker_tags on a real RESOLVED market (the same path
// retrotagging uses) so /api/settle resolves a genuine closed market.
//
// Manual post-deploy smoke checklist (prod, after migrations + secret provisioning):
//   curl https://heatchecks.io/api/tickers                         -> 4 tickers, note, numeric values
//   curl "https://heatchecks.io/api/tickers/chart?key=dogs"        -> ordered events, cumulative sums
//   curl -X POST https://heatchecks.io/api/ticker-tags             -> 401 (no secret)
//   curl -X POST -H "X-Settle-Secret: ..." https://heatchecks.io/api/settle  (twice)
//        -> second run settles nothing new; pick results shape unchanged

import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const BASE_URL = process.env.BASE_URL || 'http://localhost:8788';
const TICKER_SECRET = process.env.TICKER_SECRET || '';
const SETTLE_SECRET = process.env.SETTLE_SECRET || '';
const SLUG_PREFIX = 'acceptance-ticker-';
const EPS = 0.0005; // NUMERIC(6,3) comparisons

if (process.env.ACCEPTANCE_CONFIRM !== '1') {
    console.error('Refusing to run: set ACCEPTANCE_CONFIRM=1 to confirm DATABASE_URL is a dev/branch DB (this script writes and deletes rows).');
    process.exit(2);
}
if (!process.env.DATABASE_URL || !TICKER_SECRET || !SETTLE_SECRET) {
    console.error('DATABASE_URL, TICKER_SECRET and SETTLE_SECRET are all required.');
    process.exit(2);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let passCount = 0;
let failCount = 0;
function check(name: string, ok: boolean, detail?: string) {
    if (ok) {
        passCount++;
        console.log(`  PASS  ${name}`);
    } else {
        failCount++;
        console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
    }
}
function warn(msg: string) {
    console.warn(`  WARN  ${msg}`);
}
function near(a: number, b: number): boolean {
    return Math.abs(a - b) < EPS;
}

async function api(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
    const res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: any = null;
    try {
        json = await res.json();
    } catch {
        /* non-JSON response surfaces as json === null */
    }
    return { status: res.status, json };
}
const tagPost = (body: unknown, secret = TICKER_SECRET) =>
    api('POST', '/api/ticker-tags', body, { 'X-Ticker-Secret': secret });
const settlePost = () => api('POST', '/api/settle', undefined, { 'X-Settle-Secret': SETTLE_SECRET });

// ---------------------------------------------------------------------------------
// Gamma market discovery (real markets, so resolution/CLOB behavior is genuine)
// ---------------------------------------------------------------------------------

interface GammaMarket {
    id: string;
    question?: string;
    outcomes?: string;
    outcomePrices?: string;
    clobTokenIds?: string;
    closed?: boolean;
    volumeNum?: number;
}
function parseArr(v: string | undefined): string[] {
    try {
        const parsed = JSON.parse(v ?? '');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

async function findMarkets(): Promise<{ resolved: { id: string; outcomes: string[]; winningIndex: number }; live: { id: string; outcomes: string[] } }> {
    const liveRes = await fetch('https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=40', { headers: { Accept: 'application/json' } });
    const liveMarkets = (await liveRes.json()) as GammaMarket[];
    const live = liveMarkets
        .filter((m) => parseArr(m.clobTokenIds).length === 2 && parseArr(m.outcomes).length === 2)
        .sort((a, b) => (b.volumeNum ?? 0) - (a.volumeNum ?? 0))[0];
    if (!live) throw new Error('No usable live Gamma market found.');

    const closedRes = await fetch('https://gamma-api.polymarket.com/markets?closed=true&limit=100', { headers: { Accept: 'application/json' } });
    const closedMarkets = (await closedRes.json()) as GammaMarket[];
    const resolved = closedMarkets.find((m) => {
        const outcomes = parseArr(m.outcomes);
        const prices = parseArr(m.outcomePrices).map(Number);
        return m.closed === true && outcomes.length === 2 && prices.length === 2 && prices.some((p) => p >= 0.99) && prices.some((p) => p <= 0.01);
    });
    if (!resolved) throw new Error('No cleanly resolved Gamma market found.');
    const resolvedPrices = parseArr(resolved.outcomePrices).map(Number);
    return {
        resolved: {
            id: resolved.id,
            outcomes: parseArr(resolved.outcomes),
            winningIndex: resolvedPrices[0] > resolvedPrices[1] ? 0 : 1,
        },
        live: { id: live.id, outcomes: parseArr(live.outcomes) },
    };
}

// ---------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------

interface TankFixture {
    slug: string;
    provider?: string;
    visibility?: string;
    marketId: string;
    outcomes: string[];
    outcomePrices: number[];
}
async function insertTank(f: TankFixture): Promise<string> {
    const snapshot = {
        prop: {
            id: f.marketId,
            player: 'Acceptance Fixture',
            team: 'FIX',
            market: 'acceptance_market',
            line: 0,
            prominence: 1,
            odds: { outcomes: f.outcomes, outcomePrices: f.outcomePrices },
            settleDate: new Date().toISOString(),
        },
        game: { id: `acceptance-${f.slug}`, home: 'FIX', away: 'TURE' },
    };
    const modelOutput = { call: { question: 'Acceptance fixture call?', sides: f.outcomes } };
    const { rows } = await pool.query(
        `INSERT INTO tank_pages (slug, provider, league, angle, game_snapshot, model_output, status, visibility)
         VALUES ($1, $2, 'NBA', 'acceptance fixture', $3, $4, 'published', $5) RETURNING id`,
        [f.slug, f.provider ?? 'polymarket', JSON.stringify(snapshot), JSON.stringify(modelOutput), f.visibility ?? 'app'],
    );
    return rows[0].id as string;
}

// Hand-inserted tag - the retrotagging path: settlement must fire for these even
// though no pick and no endpoint call ever touched them.
async function insertTagDirect(tankId: string, tickerKey: string, relevantSide: number, tagDelta: number): Promise<string> {
    const { rows } = await pool.query(
        `INSERT INTO ticker_tags (tank_id, ticker_key, relevant_side, retroactive) VALUES ($1, $2, $3, true) RETURNING id`,
        [tankId, tickerKey, relevantSide],
    );
    const tagId = rows[0].id as string;
    await pool.query(
        `INSERT INTO ticker_events (ticker_tag_id, ticker_key, tank_id, event_type, delta, metadata)
         VALUES ($1, $2, $3, 'tag', $4, '{"acceptance": true}')`,
        [tagId, tickerKey, tankId, tagDelta],
    );
    return tagId;
}

async function insertUserWithPick(email: string, tankId: string, tankSlug: string, outcomeIndex: number, impliedProb: number): Promise<{ userId: string; pickId: string }> {
    const { rows: userRows } = await pool.query(
        `INSERT INTO waitlist (email) VALUES ($1)
         ON CONFLICT (LOWER(email)) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
        [email],
    );
    const userId = userRows[0].id as string;
    const { rows: pickRows } = await pool.query(
        `INSERT INTO picks (waitlist_id, tank_page_id, tank_slug, side, outcome_index, implied_prob_at_lock)
         VALUES ($1, $2, $3, 'Acceptance side', $4, $5) RETURNING id`,
        [userId, tankId, tankSlug, outcomeIndex, impliedProb],
    );
    return { userId, pickId: pickRows[0].id as string };
}

async function cleanup() {
    // Fixture users first (ledger/balances have no cascade from waitlist).
    const { rows: users } = await pool.query(`SELECT id FROM waitlist WHERE email LIKE 'acceptance-ticker-%@example.com'`);
    for (const u of users) {
        await pool.query(`DELETE FROM notifications WHERE user_id = $1`, [u.id]);
        await pool.query(`DELETE FROM ember_ledger WHERE user_id = $1`, [u.id]);
        await pool.query(`DELETE FROM ember_balances WHERE user_id = $1`, [u.id]);
        await pool.query(`DELETE FROM picks WHERE waitlist_id = $1`, [u.id]);
        await pool.query(`DELETE FROM waitlist WHERE id = $1`, [u.id]);
    }
    // Cascades picks/ticker_tags/ticker_events via their tank_id FKs.
    await pool.query(`DELETE FROM tank_pages WHERE slug LIKE $1`, [`${SLUG_PREFIX}%`]);
}

// game_config['tickers'] version-flip (the documented retune procedure) + restore.
let originalConfigVersion: number | null = null;
async function flipConfig(overrides: Record<string, number>) {
    const { rows } = await pool.query(`SELECT version, config FROM game_config WHERE key = 'tickers' AND active`);
    if (rows.length !== 1) throw new Error("game_config['tickers'] has no active row - run seed_ticker_config.sql first.");
    if (originalConfigVersion === null) originalConfigVersion = rows[0].version as number;
    const merged = { ...rows[0].config, ...overrides };
    const { rows: maxRows } = await pool.query(`SELECT MAX(version) AS v FROM game_config WHERE key = 'tickers'`);
    const nextVersion = (maxRows[0].v as number) + 1;
    await pool.query(`UPDATE game_config SET active = false WHERE key = 'tickers' AND active`);
    await pool.query(`INSERT INTO game_config (key, version, active, config) VALUES ('tickers', $1, true, $2)`, [nextVersion, JSON.stringify(merged)]);
}
async function restoreConfig() {
    if (originalConfigVersion === null) return;
    await pool.query(`UPDATE game_config SET active = false WHERE key = 'tickers' AND active`);
    await pool.query(`DELETE FROM game_config WHERE key = 'tickers' AND version > $1`, [originalConfigVersion]);
    await pool.query(`UPDATE game_config SET active = true WHERE key = 'tickers' AND version = $1`, [originalConfigVersion]);
}

async function tickerValue(key: string): Promise<number> {
    const res = await api('GET', '/api/tickers');
    const t = res.json?.tickers?.find((x: any) => x.key === key);
    return typeof t?.value === 'number' ? t.value : NaN;
}
async function settleEventDelta(tagId: string): Promise<number | null> {
    const { rows } = await pool.query(`SELECT delta::float8 AS delta FROM ticker_events WHERE ticker_tag_id = $1 AND event_type = 'settle'`, [tagId]);
    return rows.length ? (rows[0].delta as number) : null;
}

// ---------------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------------

async function main() {
    console.log(`Acceptance run against ${BASE_URL}\n`);
    await cleanup();

    const markets = await findMarkets();
    const W = markets.resolved.winningIndex;
    const L = 1 - W;
    console.log(`Live market: ${markets.live.id}; resolved market: ${markets.resolved.id} (winner index ${W})\n`);

    // --- Read shapes, pre-fixture baseline ---
    console.log('Read endpoints');
    const list = await api('GET', '/api/tickers');
    check('GET /api/tickers returns 200 with note', list.status === 200 && typeof list.json?.note === 'string');
    const keys = (list.json?.tickers ?? []).map((t: any) => t.key);
    check('all four tickers present, ordered by tab_order', JSON.stringify(keys.filter((k: string) => ['dogs', 'chalk', 'locks', 'moonshot'].includes(k))) === JSON.stringify(['dogs', 'chalk', 'locks', 'moonshot']));
    check('values are numeric (not NUMERIC strings)', (list.json?.tickers ?? []).every((t: any) => typeof t.value === 'number'));
    check('dogs/chalk seeded symmetric 5/5, locks 5/15, moonshot 20/5',
        ['dogs:5:5', 'chalk:5:5', 'locks:5:15', 'moonshot:20:5'].every((spec) => {
            const [k, w, l] = spec.split(':');
            const t = list.json?.tickers?.find((x: any) => x.key === k);
            return t && near(t.settleWinPct, Number(w)) && near(t.settleLossPct, Number(l));
        }));
    const unknownChart = await api('GET', '/api/tickers/chart?key=nope');
    check('chart with unknown key -> 404', unknownChart.status === 404);
    const badTank = await api('GET', '/api/tickers/tank');
    check('tank endpoint without slug/id -> 400', badTank.status === 400);

    // --- Tag endpoint: auth + validation + eligibility ---
    console.log('\nTag endpoint - auth, validation, eligibility (frozen snapshot probs)');
    const tankA = `${SLUG_PREFIX}live-a`;
    await insertTank({ slug: tankA, marketId: markets.live.id, outcomes: markets.live.outcomes, outcomePrices: [0.62, 0.38] });
    const mockTank = `${SLUG_PREFIX}mock`;
    await insertTank({ slug: mockTank, provider: 'mock', marketId: markets.live.id, outcomes: markets.live.outcomes, outcomePrices: [0.62, 0.38] });

    const noAuth = await api('POST', '/api/ticker-tags', { slug: tankA, tickerKey: 'dogs', relevantSide: 1 });
    check('no secret -> 401', noAuth.status === 401);
    const badSide = await tagPost({ slug: tankA, tickerKey: 'dogs', relevantSide: -1 });
    check('negative relevantSide -> 400', badSide.status === 400);
    const oob = await tagPost({ slug: tankA, tickerKey: 'dogs', relevantSide: 5 });
    check('out-of-range relevantSide -> 422 side_out_of_range', oob.status === 422 && oob.json?.code === 'side_out_of_range');
    const unknownTicker = await tagPost({ slug: tankA, tickerKey: 'rockets', relevantSide: 0 });
    check('unknown ticker -> 404', unknownTicker.status === 404);
    const mock = await tagPost({ slug: mockTank, tickerKey: 'dogs', relevantSide: 1 });
    check('non-polymarket tank -> 422 unsupported_provider', mock.status === 422 && mock.json?.code === 'unsupported_provider');

    for (const [ticker, side, prob] of [['dogs', 0, '0.62'], ['chalk', 1, '0.38'], ['locks', 0, '0.62'], ['moonshot', 1, '0.38']] as const) {
        const res = await tagPost({ slug: tankA, tickerKey: ticker, relevantSide: side });
        check(`${ticker} rejects side at ${prob} -> 422 ineligible`, res.status === 422 && res.json?.code === 'ineligible', JSON.stringify(res.json));
    }

    // --- Successful tag: real CLOB 3-day delta, immediate value movement ---
    console.log('\nTag event - real CLOB delta, cap, immediate value movement');
    const dogsBefore = await tickerValue('dogs');
    const tagOk = await tagPost({ slug: tankA, tickerKey: 'dogs', relevantSide: 1 });
    check('eligible dogs tag -> 201', tagOk.status === 201, JSON.stringify(tagOk.json));
    const delta = tagOk.json?.delta;
    check('delta is numeric, within default +/-10 cap', typeof delta === 'number' && Math.abs(delta) <= 10 + EPS);
    check('response carries retrospective note', typeof tagOk.json?.note === 'string' && tagOk.json.note.includes('not a forecast'));
    const dogsAfter = await tickerValue('dogs');
    check('ticker value moved by exactly the tag delta, pre-settlement', near(dogsAfter - dogsBefore, delta));
    const dup = await tagPost({ slug: tankA, tickerKey: 'dogs', relevantSide: 1 });
    check('duplicate (tank,ticker) -> 409', dup.status === 409);
    const { rows: evCount } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM ticker_events e JOIN tank_pages t ON t.id = e.tank_id WHERE t.slug = $1`, [tankA]);
    check('duplicate did not append an event', evCount[0].n === 1);

    // --- Config-driven behavior (no code change) ---
    console.log('\nConfig tunables - version-flip changes behavior with no code change');
    const tankB = `${SLUG_PREFIX}live-b`;
    await insertTank({ slug: tankB, marketId: markets.live.id, outcomes: markets.live.outcomes, outcomePrices: [0.85, 0.15] });
    try {
        await flipConfig({ locks_min_prob: 0.9 });
        const strict = await tagPost({ slug: tankB, tickerKey: 'locks', relevantSide: 0 });
        check('locks at 0.85 rejected under flipped locks_min_prob=0.90', strict.status === 422 && strict.json?.code === 'ineligible');
        await restoreConfig();
        const lenient = await tagPost({ slug: tankB, tickerKey: 'locks', relevantSide: 0 });
        check('locks at 0.85 accepted under restored locks_min_prob=0.80', lenient.status === 201, JSON.stringify(lenient.json));

        await flipConfig({ tag_delta_cap_pct: 0.01 });
        const capped = await tagPost({ slug: tankB, tickerKey: 'moonshot', relevantSide: 1 });
        check('tag under cap=0.01 -> |delta| <= 0.01', capped.status === 201 && Math.abs(capped.json?.delta) <= 0.01 + EPS, JSON.stringify(capped.json));
        if (capped.status === 201 && capped.json?.capped !== true) {
            warn('live market moved < 0.01pp over 3 days - clamp path not strictly proven this run (capped=false)');
        } else {
            check('capped flag set when raw delta exceeds cap', capped.json?.capped === true);
        }
    } finally {
        await restoreConfig();
    }

    // --- Settlement fixtures: hand-inserted tags on a real resolved market ---
    console.log('\nSettlement - zero-pick tags, per-ticker asymmetry, hardening');
    const ro = markets.resolved.outcomes;
    const roRev = [...ro].reverse();
    const rid = markets.resolved.id;
    const pricesWinHeavy = W === 0 ? [0.85, 0.15] : [0.15, 0.85];
    const pricesLoseHeavy = W === 0 ? [0.15, 0.85] : [0.85, 0.15];
    const pricesDogWin = W === 0 ? [0.6, 0.4] : [0.4, 0.6];

    const tankC = await insertTank({ slug: `${SLUG_PREFIX}res-c`, marketId: rid, outcomes: ro, outcomePrices: pricesWinHeavy });
    const cLocksWin = await insertTagDirect(tankC, 'locks', W, 1.5);        // lock hit: expected -> +5
    const cMoonLoss = await insertTagDirect(tankC, 'moonshot', L, 1.5);     // moonshot miss: expected -> -5
    const tankD = await insertTank({ slug: `${SLUG_PREFIX}res-d`, marketId: rid, outcomes: ro, outcomePrices: pricesLoseHeavy });
    const dLocksLoss = await insertTagDirect(tankD, 'locks', L, 1.5);       // lock FAILED: the surprise -> -15
    const dMoonWin = await insertTagDirect(tankD, 'moonshot', W, 1.5);      // moonshot HIT: the story -> +20
    const tankE = await insertTank({ slug: `${SLUG_PREFIX}res-e`, marketId: rid, outcomes: ro, outcomePrices: pricesDogWin });
    const eDogs = await insertTagDirect(tankE, 'dogs', L, 1.5);             // underdog side lost -> -5
    const eChalk = await insertTagDirect(tankE, 'chalk', W, 1.5);           // favorite side won -> +5
    const tankF = await insertTank({ slug: `${SLUG_PREFIX}res-f`, visibility: 'newsletter_only', marketId: rid, outcomes: ro, outcomePrices: pricesDogWin });
    const fDogs = await insertTagDirect(tankF, 'dogs', W, 3.3);
    const tankG = await insertTank({ slug: `${SLUG_PREFIX}res-g`, marketId: rid, outcomes: roRev, outcomePrices: pricesDogWin });
    const gDogs = await insertTagDirect(tankG, 'dogs', W, 1.5);
    const gPick = await insertUserWithPick(`${SLUG_PREFIX}g@example.com`, tankG, `${SLUG_PREFIX}res-g`, W, 0.5);
    const tankH = await insertTank({ slug: `${SLUG_PREFIX}res-h`, marketId: rid, outcomes: ro, outcomePrices: [0.5, 0.5] });
    const hPick = await insertUserWithPick(`${SLUG_PREFIX}h@example.com`, tankH, `${SLUG_PREFIX}res-h`, W, 0.5);

    const settle1 = await settlePost();
    check('POST /api/settle -> 200 with tickerResults', settle1.status === 200 && Array.isArray(settle1.json?.tickerResults));
    const trFor = (tagId: string) => settle1.json?.tickerResults?.find((r: any) => r.tagId === tagId);
    const prFor = (pickId: string) => settle1.json?.results?.find((r: any) => r.pickId === pickId);

    check('zero-pick locks(win) tag settled +5', trFor(cLocksWin)?.status === 'settled_win' && near(await settleEventDelta(cLocksWin) ?? NaN, 5));
    check('zero-pick moonshot(loss) tag settled -5', trFor(cMoonLoss)?.status === 'settled_loss' && near(await settleEventDelta(cMoonLoss) ?? NaN, -5));
    check('locks(loss) asymmetry: -15, not -5', trFor(dLocksLoss)?.status === 'settled_loss' && near(await settleEventDelta(dLocksLoss) ?? NaN, -15));
    check('moonshot(win) asymmetry: +20, not +5', trFor(dMoonWin)?.status === 'settled_win' && near(await settleEventDelta(dMoonWin) ?? NaN, 20));
    const eDogsDelta = await settleEventDelta(eDogs);
    const eChalkDelta = await settleEventDelta(eChalk);
    check('dogs/chalk inverse on the same real outcome (one +, one -)',
        eDogsDelta !== null && eChalkDelta !== null && ((eDogsDelta > 0) !== (eChalkDelta > 0)) && near(Math.abs(eDogsDelta), 5) && near(Math.abs(eChalkDelta), 5));
    check('newsletter_only tag still settles', (await settleEventDelta(fDogs)) !== null);
    const { rows: calcRows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM ticker_tags WHERE id = ANY($1) AND calculated_at IS NOT NULL`,
        [[cLocksWin, cMoonLoss, dLocksLoss, dMoonWin, eDogs, eChalk, fDogs]]);
    check('calculated_at stamped on all settled tags', calcRows[0].n === 7);

    check('reversed-outcome tag skipped: outcome_order_mismatch', trFor(gDogs)?.status === 'outcome_order_mismatch' && (await settleEventDelta(gDogs)) === null);
    check('reversed-outcome pick skipped: outcome_order_mismatch', prFor(gPick.pickId)?.status === 'outcome_order_mismatch');
    const hResult = prFor(hPick.pickId);
    check('pick path regression: correct pick settles with formula payout (20 * min(1/0.5, 2.5) = 40)',
        hResult?.status === 'settled_correct' && hResult?.payoutAmount === 40, JSON.stringify(hResult));

    // --- Idempotency ---
    console.log('\nIdempotency - re-running settlement is a no-op');
    const { rows: pre } = await pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(delta), 0)::float8 AS s FROM ticker_events`);
    const settle2 = await settlePost();
    const ourTagIds = new Set([cLocksWin, cMoonLoss, dLocksLoss, dMoonWin, eDogs, eChalk, fDogs]);
    const resettled = (settle2.json?.tickerResults ?? []).filter((r: any) => ourTagIds.has(r.tagId));
    check('settled tags absent from the second run\'s pending scan', resettled.length === 0, JSON.stringify(resettled));
    const { rows: post } = await pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(delta), 0)::float8 AS s FROM ticker_events`);
    check('no new events, SUM(delta) unchanged', pre[0].n === post[0].n && near(pre[0].s, post[0].s));

    // --- Read-side visibility + chart consistency ---
    console.log('\nRead side - newsletter exclusion, chart = cumulative event log');
    const { rows: sqlDogs } = await pool.query(
        `SELECT COALESCE(SUM(e.delta) FILTER (WHERE t.visibility = 'app'), 0)::float8 AS app_only,
                COALESCE(SUM(e.delta), 0)::float8 AS all_events
         FROM ticker_events e JOIN tank_pages t ON t.id = e.tank_id WHERE e.ticker_key = 'dogs'`);
    const apiDogs = await tickerValue('dogs');
    check('API dogs value == app-visible SUM(delta) from the log', near(apiDogs, sqlDogs[0].app_only));
    check('newsletter_only events exist but are excluded (sums differ)', !near(sqlDogs[0].app_only, sqlDogs[0].all_events));
    const chart = await api('GET', '/api/tickers/chart?key=dogs');
    const dogsSeries: any[] = chart.json?.series?.dogs ?? [];
    const { rows: fEventRows } = await pool.query(`SELECT id FROM ticker_events WHERE ticker_tag_id = $1`, [fDogs]);
    const fEventIds = new Set(fEventRows.map((r) => r.id));
    check('newsletter tank\'s events absent from the chart', dogsSeries.every((e) => !fEventIds.has(e.id)));
    let cumOk = dogsSeries.length > 0;
    let running = 0;
    for (const e of dogsSeries) {
        running += e.delta;
        if (!near(running, e.cumulative)) cumOk = false;
    }
    check('chart cumulative = running sum of deltas, in order', cumOk);
    const lastCum = dogsSeries.length ? dogsSeries[dogsSeries.length - 1].cumulative : NaN;
    check('chart final cumulative == ticker current value (same log, same filter)', near(lastCum, apiDogs));
    const tankView = await api('GET', `/api/tickers/tank?slug=${SLUG_PREFIX}res-c`);
    check('tank endpoint lists its tags with event ids for highlighting',
        tankView.status === 200
        && (tankView.json?.tags ?? []).length === 2
        && (tankView.json?.tags ?? []).every((t: any) => Array.isArray(t.eventIds) && t.eventIds.length === 2));

    await cleanup();
    console.log(`\n${passCount} passed, ${failCount} failed.`);
    process.exit(failCount > 0 ? 1 : 0);
}

main()
    .catch(async (err) => {
        console.error('\nSuite aborted:', err);
        process.exit(1);
    })
    .finally(async () => {
        try {
            await restoreConfig();
        } catch { /* best effort */ }
        await pool.end();
    });
