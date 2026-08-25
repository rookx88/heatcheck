// Acceptance suite for the PICK settlement path: functions/api/settle.ts's per-pick loop
// and lib/pages-functions/ledger.ts's settleCall(). suites/tickers.ts already exercises
// /api/settle thoroughly for ticker-tag settlement (zero-pick tags, per-ticker asymmetry,
// outcome_order_mismatch, idempotency at the ticker_events level) and touches the pick
// path only lightly (one correct pick, formula sanity-checked once). This suite promotes
// the pick path to a first-class target: the win/loss payout formula (including the cap),
// the ledger/notification bookkeeping settleCall() writes atomically, and idempotency
// specifically at the picks/ember_ledger/notifications level.
//
// Uses the same real-resolved-Gamma-market fixture as tickers.ts (via findMarkets()) so
// /api/settle resolves a genuine closed market instead of a stub.

import { pool, api, check, section, type Suite } from '../harness';
import {
    insertTank, insertUserWithPick, findMarkets, findKalshiMarkets, ledgerTotals,
    cleanupUsersByEmailPrefix, cleanupTanksBySlugPrefix,
} from '../fixtures';

const SETTLE_SECRET = process.env.SETTLE_SECRET || '';
const SLUG_PREFIX = 'acceptance-settle-';

const settlePost = (headers?: Record<string, string>) => api('POST', '/api/settle', { headers });
const authedSettle = () => settlePost({ 'X-Settle-Secret': SETTLE_SECRET });

async function cleanup() {
    await cleanupUsersByEmailPrefix(SLUG_PREFIX);
    await cleanupTanksBySlugPrefix(SLUG_PREFIX);
}

// ember_rules.config is read live (never hardcoded) so this suite keeps validating the
// true formula even if a future migration retunes base/cap/amount - see
// update_ember_rules_payout_formula.sql for why these aren't stable across the app's
// life.
interface RuleConfig { version: number; config: Record<string, number> }
async function activeRule(key: string): Promise<RuleConfig> {
    const { rows } = await pool.query(`SELECT version, config FROM ember_rules WHERE key = $1 AND active`, [key]);
    if (rows.length !== 1) throw new Error(`ember_rules['${key}'] has no active row - seed it first.`);
    return { version: rows[0].version as number, config: rows[0].config as Record<string, number> };
}

// Mirrors ledger.ts's private correctCallPayout() exactly: round(base * min(1/p, cap)).
function correctCallPayout(config: Record<string, number>, impliedProb: number): number {
    return Math.round(config.base * Math.min(1 / impliedProb, config.cap));
}

// Mirrors ledger.ts's buildIdempotencyKey('correct_call'|'participation', userId, `call:<pickId>`).
function callIdempotencyKey(ruleKey: string, userId: string, pickId: string): string {
    return `${ruleKey}:${userId}:call:${pickId}`;
}

async function pickRow(pickId: string): Promise<{ result: string | null; settled_at: string | null }> {
    const { rows } = await pool.query(`SELECT result, settled_at FROM picks WHERE id = $1`, [pickId]);
    return rows[0] as { result: string | null; settled_at: string | null };
}

async function ledgerRowCount(idemKey: string): Promise<number> {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ember_ledger WHERE idempotency_key = $1`, [idemKey]);
    return rows[0].n as number;
}

async function ledgerMetadata(idemKey: string): Promise<Record<string, unknown> | null> {
    const { rows } = await pool.query(`SELECT metadata FROM ember_ledger WHERE idempotency_key = $1`, [idemKey]);
    return rows.length ? (rows[0].metadata as Record<string, unknown>) : null;
}

async function notificationCount(pickId: string): Promise<number> {
    const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM notifications WHERE ref_type = 'pick' AND ref_id = $1 AND idempotency_key = $2`,
        [pickId, `settle:call:${pickId}`],
    );
    return rows[0].n as number;
}

async function run() {
    await cleanup();

    const markets = await findMarkets();
    const W = markets.resolved.winningIndex;
    const L = 1 - W;
    const rid = markets.resolved.id;
    const ro = markets.resolved.outcomes;
    console.log(`Resolved market: ${rid} (winner index ${W})`);

    // --- Auth ---
    section('Auth');
    const noHeader = await settlePost();
    check('POST /api/settle with no X-Settle-Secret header -> 401', noHeader.status === 401);
    const wrongSecret = await settlePost({ 'X-Settle-Secret': 'not-the-real-secret' });
    check('POST /api/settle with wrong secret -> 401', wrongSecret.status === 401);

    // --- Fixtures: three real wins at different implied probs (mid, cap-floor,
    // longshot-past-cap) plus one real loss, each its own Tank/pick on the same
    // resolved market. outcomePrices are cosmetic here (only tag-eligibility cares
    // about them); the resolution itself comes from a live Gamma fetch against marketId. ---
    section('Fixtures - real wins/loss on a real resolved Polymarket market');
    const correctRule = await activeRule('correct_call');
    const participationRule = await activeRule('participation');

    const winMidTank = await insertTank({ slug: `${SLUG_PREFIX}win-mid`, marketId: rid, outcomes: ro, outcomePrices: [0.5, 0.5] });
    const winMid = await insertUserWithPick(`${SLUG_PREFIX}win-mid@example.com`, winMidTank, `${SLUG_PREFIX}win-mid`, W, 0.5);

    const winCapFloorTank = await insertTank({ slug: `${SLUG_PREFIX}win-cap-floor`, marketId: rid, outcomes: ro, outcomePrices: [0.5, 0.5] });
    const winCapFloor = await insertUserWithPick(`${SLUG_PREFIX}win-cap-floor@example.com`, winCapFloorTank, `${SLUG_PREFIX}win-cap-floor`, W, 1.0);

    const winLongshotTank = await insertTank({ slug: `${SLUG_PREFIX}win-longshot`, marketId: rid, outcomes: ro, outcomePrices: [0.5, 0.5] });
    const winLongshot = await insertUserWithPick(`${SLUG_PREFIX}win-longshot@example.com`, winLongshotTank, `${SLUG_PREFIX}win-longshot`, W, 0.2);

    const lossTank = await insertTank({ slug: `${SLUG_PREFIX}loss`, marketId: rid, outcomes: ro, outcomePrices: [0.5, 0.5] });
    const loss = await insertUserWithPick(`${SLUG_PREFIX}loss@example.com`, lossTank, `${SLUG_PREFIX}loss`, L, 0.5);

    const expectedMid = correctCallPayout(correctRule.config, 0.5);
    const expectedCapFloor = correctCallPayout(correctRule.config, 1.0);
    const expectedLongshot = correctCallPayout(correctRule.config, 0.2);
    const expectedLoss = participationRule.config.amount;

    interface Fixture { label: string; pickId: string; userId: string; ruleKey: 'correct_call' | 'participation'; expectedPayout: number }
    const fixtures: Fixture[] = [
        { label: 'win @ p=0.5', pickId: winMid.pickId, userId: winMid.userId, ruleKey: 'correct_call', expectedPayout: expectedMid },
        { label: 'win @ p=1.0 (formula minimum)', pickId: winCapFloor.pickId, userId: winCapFloor.userId, ruleKey: 'correct_call', expectedPayout: expectedCapFloor },
        { label: 'win @ p=0.2 (cap applied)', pickId: winLongshot.pickId, userId: winLongshot.userId, ruleKey: 'correct_call', expectedPayout: expectedLongshot },
        { label: 'loss (participation floor)', pickId: loss.pickId, userId: loss.userId, ruleKey: 'participation', expectedPayout: expectedLoss },
    ];

    const settle1 = await authedSettle();
    check('POST /api/settle -> 200 with results', settle1.status === 200 && Array.isArray(settle1.json?.results));
    const prFor = (pickId: string) => settle1.json?.results?.find((r: any) => r.pickId === pickId);

    // --- Win payout formula, including both ends of the cap ---
    section('Win payout formula - round(base * min(1/p, cap))');
    check(`win @ p=0.5 settles correct with formula payout (${expectedMid})`,
        prFor(winMid.pickId)?.status === 'settled_correct' && prFor(winMid.pickId)?.payoutAmount === expectedMid,
        JSON.stringify(prFor(winMid.pickId)));
    check(`win @ p=1.0 settles correct at the formula's minimum (${expectedCapFloor})`,
        prFor(winCapFloor.pickId)?.status === 'settled_correct' && prFor(winCapFloor.pickId)?.payoutAmount === expectedCapFloor,
        JSON.stringify(prFor(winCapFloor.pickId)));
    check(`win @ p=0.2 settles correct at the capped payout (${expectedLongshot})`,
        prFor(winLongshot.pickId)?.status === 'settled_correct' && prFor(winLongshot.pickId)?.payoutAmount === expectedLongshot,
        JSON.stringify(prFor(winLongshot.pickId)));

    const longshotMeta = await ledgerMetadata(callIdempotencyKey('correct_call', winLongshot.userId, winLongshot.pickId));
    check('longshot pick: cap_applied:true recorded in ember_ledger.metadata', longshotMeta?.cap_applied === true, JSON.stringify(longshotMeta));
    const midMeta = await ledgerMetadata(callIdempotencyKey('correct_call', winMid.userId, winMid.pickId));
    check('p=0.5 pick: cap_applied:false recorded in ember_ledger.metadata (not past the cap)', midMeta?.cap_applied === false, JSON.stringify(midMeta));

    // --- Loss payout: participation's config.amount, read live ---
    section('Loss payout - participation rule\'s config.amount, read live from ember_rules');
    check(`losing pick settles incorrect, paid the participation floor (${expectedLoss})`,
        prFor(loss.pickId)?.status === 'settled_incorrect' && prFor(loss.pickId)?.payoutAmount === expectedLoss,
        JSON.stringify(prFor(loss.pickId)));

    // --- Bookkeeping: result/settled_at stamped once, notification fires once ---
    section('Bookkeeping - picks.result/settled_at stamped, settle:call notification fires exactly once');
    const settledAtByPick = new Map<string, string | null>();
    for (const f of fixtures) {
        const idemKey = callIdempotencyKey(f.ruleKey, f.userId, f.pickId);
        const row = await pickRow(f.pickId);
        settledAtByPick.set(f.pickId, row.settled_at);
        check(`${f.label}: picks.result/settled_at stamped`, row.result !== null && row.settled_at !== null, JSON.stringify(row));
        check(`${f.label}: exactly one ember_ledger row (payout ${f.expectedPayout})`,
            (await ledgerRowCount(idemKey)) === 1);
        check(`${f.label}: exactly one settle:call:<pickId> notification`, (await notificationCount(f.pickId)) === 1);
    }

    // --- Ledger cache consistency: a smaller-scale preview of the full ledger-trace phase,
    // just confirming settlement itself never lets ember_balances drift from ember_ledger. ---
    section('Ledger cache consistency - ledgerSum === balanceCache after settlement');
    for (const f of fixtures) {
        const totals = await ledgerTotals(f.userId);
        check(`${f.label}: ledgerSum === balanceCache === expected payout`,
            totals.balanceCache === totals.ledgerSum && totals.ledgerSum === f.expectedPayout,
            JSON.stringify(totals));
    }

    // --- Idempotency: re-running settlement must not resettle or duplicate anything ---
    section('Idempotency - second settle run is a no-op for these picks');
    const settle2 = await authedSettle();
    const ourPickIds = new Set(fixtures.map((f) => f.pickId));
    const resettled = (settle2.json?.results ?? []).filter((r: any) => ourPickIds.has(r.pickId));
    check('none of our picks reappear in the second run\'s results', resettled.length === 0, JSON.stringify(resettled));

    for (const f of fixtures) {
        const idemKey = callIdempotencyKey(f.ruleKey, f.userId, f.pickId);
        const row = await pickRow(f.pickId);
        // pg returns TIMESTAMP columns as Date objects despite the string|null type
        // annotation - two separately-fetched Date instances are never === even for the
        // same instant, so this must compare by value (getTime()), not reference.
        const before = settledAtByPick.get(f.pickId);
        const settledAtUnchanged = before !== null && row.settled_at !== null
            && new Date(before as unknown as string).getTime() === new Date(row.settled_at as unknown as string).getTime();
        check(`${f.label}: settled_at unchanged after re-run`, settledAtUnchanged, JSON.stringify(row));
        check(`${f.label}: still exactly one ember_ledger row after re-run`, (await ledgerRowCount(idemKey)) === 1);
        check(`${f.label}: still exactly one notification after re-run`, (await notificationCount(f.pickId)) === 1);
    }

    // --- Kalshi provider: proves settle.ts's resolveOnce dispatcher reaches the same
    // settleCall/ledger path for a genuine Kalshi resolution, not just Polymarket's.
    // One win + one loss is enough here - the payout FORMULA itself is already proven
    // exhaustively above (both cap ends, participation floor); this section is only
    // exercising the provider dispatch and resolveMarket('scalar'->voided not hit here
    // since findKalshiMarkets() only returns cleanly yes/no-resolved markets). ---
    section('Kalshi provider - pick settlement (proves the settle.ts provider dispatch)');
    const kalshiMarkets = await findKalshiMarkets();
    const kW = kalshiMarkets.resolved.winningIndex;
    const kL = 1 - kW;
    const kRid = kalshiMarkets.resolved.id;
    const kRo = kalshiMarkets.resolved.outcomes;
    console.log(`Kalshi resolved market: ${kRid} (winner index ${kW})`);

    const kWinTank = await insertTank({ slug: `${SLUG_PREFIX}kalshi-win`, provider: 'kalshi', marketId: kRid, outcomes: kRo, outcomePrices: [0.5, 0.5] });
    const kWin = await insertUserWithPick(`${SLUG_PREFIX}kalshi-win@example.com`, kWinTank, `${SLUG_PREFIX}kalshi-win`, kW, 0.5);
    const kLossTank = await insertTank({ slug: `${SLUG_PREFIX}kalshi-loss`, provider: 'kalshi', marketId: kRid, outcomes: kRo, outcomePrices: [0.5, 0.5] });
    const kLoss = await insertUserWithPick(`${SLUG_PREFIX}kalshi-loss@example.com`, kLossTank, `${SLUG_PREFIX}kalshi-loss`, kL, 0.5);

    const kalshiSettle = await authedSettle();
    const kPrFor = (pickId: string) => kalshiSettle.json?.results?.find((r: any) => r.pickId === pickId);
    const kExpectedWin = correctCallPayout(correctRule.config, 0.5);
    check(`kalshi win settles correct with formula payout (${kExpectedWin})`,
        kPrFor(kWin.pickId)?.status === 'settled_correct' && kPrFor(kWin.pickId)?.payoutAmount === kExpectedWin,
        JSON.stringify(kPrFor(kWin.pickId)));
    check(`kalshi loss settles incorrect, paid the participation floor (${expectedLoss})`,
        kPrFor(kLoss.pickId)?.status === 'settled_incorrect' && kPrFor(kLoss.pickId)?.payoutAmount === expectedLoss,
        JSON.stringify(kPrFor(kLoss.pickId)));

    await cleanup();
}

export const suite: Suite = {
    name: 'settlement',
    requiredEnv: ['SETTLE_SECRET'],
    run,
};
