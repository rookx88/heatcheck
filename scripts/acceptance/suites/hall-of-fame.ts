// Acceptance suite for the Hall of Fame (2026-09-10): ember_balances.lifetime_earned -
// the second derived counter lib/pages-functions/ledger.ts maintains - and
// GET /api/hall-of-fame, the public top-100 board ranked by it. Run after any change
// to ledger.ts's credit paths, rebuildBalance(), the endpoint, or the definition in
// add_lifetime_earned_to_ember_balances.sql (which must already be applied).
//
// The definition under test: lifetime_earned = game-rule ledger rows (correct_call,
// participation, discovery_find) + the positive, floored realized_pnl of every TANKDAQ
// sell. What this proves, in order:
//   - a seed/adjustment moves balance and never lifetime_earned;
//   - settlement payouts (capped win, favourite win, loss consolation) land in both
//     counters, and a replayed settlement moves neither;
//   - a buy moves nothing, a profitable sell adds exactly floor(profit), a losing sell
//     adds 0, and sale PROCEEDS never count (balance rises by the credit, the counter
//     only by the profit); a fractional average is floored per trade like the backfill;
//   - rebuildBalance() reproduces both counters from the definition, including after
//     the cache is deliberately corrupted;
//   - the board is public, shaped as documented, ordered, capped, no-store, and the
//     viewer's own rank is 1 + the number of accounts above them - the same competition
//     rank the rows carry;
//   - page validation.
// The ledger functions are driven directly through sqlViaPoolTx (their real
// statements, including the transaction shape), not re-implemented; every assertion
// reads the tables back. Live accounts share the board, so fixture-presence checks
// locate the fixture by its computed rank rather than assuming it is on page 1, and
// are skipped when the endpoint reports its ranked half came from the 60s edge cache.

import { pool, api, check, section, warn, near, type Suite } from '../harness';
import {
    createSessionUser, cleanupUsersByEmailPrefix, cleanupTanksBySlugPrefix, insertTank,
    seedBalance, ledgerTotals, sqlViaPoolTx,
} from '../fixtures';
import { settleCall, buyShares, sellShares, rebuildBalance } from '../../../lib/pages-functions/ledger';

const EMAIL_PREFIX = 'acceptance-hof-';
const SLUG_PREFIX = 'acceptance-hof-';
// Any active index works - the prices below are caller-supplied to the ledger
// functions (the endpoints quote them; the ledger only records them).
const TICKER = 'dogs';
const PAGE_SIZE = 10;
const MAX_RANKED = 100;

function user(tag: string): string {
    return `${EMAIL_PREFIX}${tag}@example.com`;
}

async function lifetimeEarned(userId: string): Promise<number | null> {
    const { rows } = await pool.query(`SELECT lifetime_earned FROM ember_balances WHERE user_id = $1`, [userId]);
    return rows.length ? Number(rows[0].lifetime_earned) : null;
}

async function balanceOf(userId: string): Promise<number | null> {
    const { rows } = await pool.query(`SELECT balance FROM ember_balances WHERE user_id = $1`, [userId]);
    return rows.length ? Number(rows[0].balance) : null;
}

// Read live, never hardcoded (see suites/settlement.ts for why).
async function activeRule(key: string): Promise<Record<string, number>> {
    const { rows } = await pool.query(`SELECT config FROM ember_rules WHERE key = $1 AND active`, [key]);
    if (rows.length !== 1) throw new Error(`ember_rules['${key}'] has no active row`);
    return rows[0].config as Record<string, number>;
}

// Mirrors ledger.ts's private correctCallPayout(): round(base * min(1/p, cap)).
function correctCallPayout(config: Record<string, number>, p: number): number {
    return Math.round(config.base * Math.min(1 / p, config.cap));
}

async function insertPick(userId: string, tankId: string, slug: string, outcomeIndex: number, p: number): Promise<string> {
    const { rows } = await pool.query(
        `INSERT INTO picks (waitlist_id, tank_page_id, tank_slug, side, outcome_index, implied_prob_at_lock)
         VALUES ($1, $2, $3, 'Acceptance side', $4, $5) RETURNING id`,
        [userId, tankId, slug, outcomeIndex, p],
    );
    return rows[0].id as string;
}

// The endpoint's own rank arithmetic, run independently: competition rank among
// board-eligible accounts (earned > 0 with a username).
async function competitionRank(earned: number): Promise<number> {
    const { rows } = await pool.query(
        `SELECT 1 + COUNT(*)::int AS rank FROM ember_balances b JOIN waitlist w ON w.id = b.user_id
         WHERE b.lifetime_earned > $1 AND w.username IS NOT NULL`,
        [earned],
    );
    return Number(rows[0].rank);
}

async function sellProfitSum(userId: string): Promise<number> {
    const { rows } = await pool.query(
        `SELECT COALESCE(SUM(GREATEST(FLOOR(realized_pnl), 0)), 0)::int AS n FROM share_trades WHERE user_id = $1 AND side = 'sell'`,
        [userId],
    );
    return Number(rows[0].n);
}

async function assertCountersConsistent(userId: string, label: string): Promise<void> {
    const t = await ledgerTotals(userId);
    check(`${label}: balance cache == SUM(ledger)`, t.balanceCache === t.ledgerSum, JSON.stringify(t));
    check(`${label}: lifetime_earned cache == recompute`, t.lifetimeCache === t.lifetimeRecomputed, JSON.stringify(t));
}

async function cleanup(): Promise<void> {
    await cleanupUsersByEmailPrefix(EMAIL_PREFIX);
    await cleanupTanksBySlugPrefix(SLUG_PREFIX);
}

interface BoardRow { rank: number; username: string; earned: number }

async function run(): Promise<void> {
    await cleanup();
    const sql = sqlViaPoolTx();

    // =================================================================================
    section('1. Fixtures: four onboarded accounts, no Ember');
    // =================================================================================
    const a = await createSessionUser(user('a'), { username: 'acceptancehofa' });
    const b = await createSessionUser(user('b'), { username: 'acceptancehofb' });
    const c = await createSessionUser(user('c'), { username: 'acceptancehofc' });
    const d = await createSessionUser(user('d'), { username: 'acceptancehofd' }); // never earns
    check('no ember_balances row for a fresh account', (await lifetimeEarned(a.userId)) === null && (await balanceOf(a.userId)) === null);

    // =================================================================================
    section('2. A seed / adjustment moves balance, never lifetime_earned');
    // =================================================================================
    await seedBalance(a.userId, 500);
    await seedBalance(b.userId, 500);
    await seedBalance(c.userId, 100);
    check('seed: balance 500, lifetime_earned 0', (await balanceOf(a.userId)) === 500 && (await lifetimeEarned(a.userId)) === 0,
        `balance=${await balanceOf(a.userId)} lifetime=${await lifetimeEarned(a.userId)}`);
    await assertCountersConsistent(a.userId, '2: seeded');

    // =================================================================================
    section('3. Settlement payouts count: capped win, favourite win, loss consolation');
    // =================================================================================
    const cc = await activeRule('correct_call');
    const part = await activeRule('participation');
    const slug = `${SLUG_PREFIX}tank`;
    // newsletter_only: the tank exists only to satisfy picks' FK, so keep it off the
    // app feed (the shared database is the live one) - settlement here is driven
    // directly, never through /api/settle's published-tank scan.
    const tankId = await insertTank({ slug, marketId: 'acceptance-hof-market', outcomes: ['Yes', 'No'], outcomePrices: [0.4, 0.6], visibility: 'newsletter_only' });
    const pA = 0.3; // 1/0.3 = 3.33 > cap -> the cap applies
    const pB = 0.5;
    const pickA = await insertPick(a.userId, tankId, slug, 0, pA);
    const pickB = await insertPick(b.userId, tankId, slug, 0, pB);
    const pickC = await insertPick(c.userId, tankId, slug, 1, 0.6);

    const payA = (await settleCall(sql, { pickId: pickA, userId: a.userId, result: 'correct', impliedProbAtLock: pA })).payoutAmount;
    const payB = (await settleCall(sql, { pickId: pickB, userId: b.userId, result: 'correct', impliedProbAtLock: pB })).payoutAmount;
    const payC = (await settleCall(sql, { pickId: pickC, userId: c.userId, result: 'incorrect', impliedProbAtLock: 0.6 })).payoutAmount;
    check('win payouts follow the live formula (A capped, B at base*2)', payA === correctCallPayout(cc, pA) && payB === correctCallPayout(cc, pB), `A=${payA} B=${payB}`);
    check('loss pays the participation amount', payC === part.amount, `C=${payC} rule=${part.amount}`);
    check('A: lifetime_earned == win payout', (await lifetimeEarned(a.userId)) === payA);
    check('B: lifetime_earned == win payout', (await lifetimeEarned(b.userId)) === payB);
    check('C: lifetime_earned == participation', (await lifetimeEarned(c.userId)) === payC);
    check('A: balance == seed + payout', (await balanceOf(a.userId)) === 500 + payA);
    const { rows: pickRows } = await pool.query(`SELECT result FROM picks WHERE id = $1`, [pickA]);
    check('the pick itself settled (real settleCall path, not a fixture)', pickRows[0]?.result === 'correct');
    for (const [label, u] of [['A', a], ['B', b], ['C', c]] as const) await assertCountersConsistent(u.userId, `3: ${label} settled`);

    // =================================================================================
    section('4. A replayed settlement moves neither counter');
    // =================================================================================
    const rowsBefore = (await ledgerTotals(a.userId)).ledgerRows;
    await settleCall(sql, { pickId: pickA, userId: a.userId, result: 'correct', impliedProbAtLock: pA });
    check('replay: no new ledger row', (await ledgerTotals(a.userId)).ledgerRows === rowsBefore);
    check('replay: lifetime_earned unchanged', (await lifetimeEarned(a.userId)) === payA);
    check('replay: balance unchanged', (await balanceOf(a.userId)) === 500 + payA);

    // =================================================================================
    section('5. TANKDAQ: profit counts, proceeds and losses do not');
    // =================================================================================
    // A: buy 2 @ 10 (cost 20), sell 2 @ 15 (credit 30) -> profit 10.
    const buyA = await buyShares(sql, { userId: a.userId, tickerKey: TICKER, shares: 2, price: 10, emberAmount: 20, tradeToken: crypto.randomUUID() });
    check('A buy -> ok', buyA.ok && !buyA.replay, JSON.stringify(buyA));
    check('a buy moves lifetime_earned by nothing', (await lifetimeEarned(a.userId)) === payA);
    const sellA = await sellShares(sql, { userId: a.userId, tickerKey: TICKER, shares: 2, price: 15, emberAmount: 30, tradeToken: crypto.randomUUID() });
    check('A sell -> ok with realized P/L 10', sellA.ok && sellA.realizedPnl !== null && near(sellA.realizedPnl, 10, 1e-6), JSON.stringify(sellA));
    check('A: lifetime_earned rose by the PROFIT (10), not the credit (30)', (await lifetimeEarned(a.userId)) === payA + 10, `lifetime=${await lifetimeEarned(a.userId)}`);
    check('A: balance rose by the full credit (proceeds are still real Ember)', (await balanceOf(a.userId)) === 500 + payA - 20 + 30);

    // B: buy 3 @ 10 (cost 30); sell 1 @ 12.5 (credit 12, floor) -> profit 2; sell 2 @ 8 (credit 16) -> loss 4 -> +0.
    const buyB = await buyShares(sql, { userId: b.userId, tickerKey: TICKER, shares: 3, price: 10, emberAmount: 30, tradeToken: crypto.randomUUID() });
    const sellB1 = await sellShares(sql, { userId: b.userId, tickerKey: TICKER, shares: 1, price: 12.5, emberAmount: 12, tradeToken: crypto.randomUUID() });
    const sellB2 = await sellShares(sql, { userId: b.userId, tickerKey: TICKER, shares: 2, price: 8, emberAmount: 16, tradeToken: crypto.randomUUID() });
    check('B trades all ok', buyB.ok && sellB1.ok && sellB2.ok, JSON.stringify({ buyB, sellB1, sellB2 }));
    check('B: profitable sell +2, losing sell +0', (await lifetimeEarned(b.userId)) === payB + 2, `lifetime=${await lifetimeEarned(b.userId)} pnl1=${sellB1.realizedPnl} pnl2=${sellB2.realizedPnl}`);
    check('B: losing sell recorded a negative realized_pnl (so the +0 is a floor, not a missing row)', sellB2.realizedPnl !== null && sellB2.realizedPnl < 0);

    // C: a fractional average. buy 3 for 31 (avg 10.333333); sell 1 @ 11 -> pnl 0.666667 -> +0;
    // sell 2 @ 11 -> pnl 22 - 20.666667 = 1.333333 -> +1. Per-trade floor, like the backfill.
    const buyC = await buyShares(sql, { userId: c.userId, tickerKey: TICKER, shares: 3, price: 10.3333, emberAmount: 31, tradeToken: crypto.randomUUID() });
    const sellC1 = await sellShares(sql, { userId: c.userId, tickerKey: TICKER, shares: 1, price: 11, emberAmount: 11, tradeToken: crypto.randomUUID() });
    const sellC2 = await sellShares(sql, { userId: c.userId, tickerKey: TICKER, shares: 2, price: 11, emberAmount: 22, tradeToken: crypto.randomUUID() });
    check('C trades all ok', buyC.ok && sellC1.ok && sellC2.ok, JSON.stringify({ buyC, sellC1, sellC2 }));
    check('C: fractional profits floor per trade (0 + 1)', (await lifetimeEarned(c.userId)) === payC + 1, `lifetime=${await lifetimeEarned(c.userId)} pnl1=${sellC1.realizedPnl} pnl2=${sellC2.realizedPnl}`);
    for (const [label, u] of [['A', a], ['B', b], ['C', c]] as const) {
        check(`5: ${label} counter increment == SUM(GREATEST(FLOOR(realized_pnl), 0)) over its sells`,
            (await lifetimeEarned(u.userId))! - (label === 'A' ? payA : label === 'B' ? payB : payC) === (await sellProfitSum(u.userId)));
        await assertCountersConsistent(u.userId, `5: ${label} traded`);
    }
    const expectedA = payA + 10;
    const expectedB = payB + 2;
    const expectedC = payC + 1;

    // =================================================================================
    section('6. rebuildBalance() reproduces both counters from the definition');
    // =================================================================================
    for (const [label, u, expected] of [['A', a, expectedA], ['B', b, expectedB], ['C', c, expectedC]] as const) {
        const balBefore = await balanceOf(u.userId);
        await rebuildBalance(sql, u.userId);
        check(`rebuild ${label}: balance unchanged, lifetime_earned == ${expected}`,
            (await balanceOf(u.userId)) === balBefore && (await lifetimeEarned(u.userId)) === expected,
            `balance=${await balanceOf(u.userId)} lifetime=${await lifetimeEarned(u.userId)}`);
    }
    await pool.query(`UPDATE ember_balances SET lifetime_earned = 999999 WHERE user_id = $1`, [a.userId]);
    await rebuildBalance(sql, a.userId);
    check('rebuild resets a corrupted lifetime_earned to the definition', (await lifetimeEarned(a.userId)) === expectedA);
    await assertCountersConsistent(a.userId, '6: rebuilt');

    // =================================================================================
    section('7. GET /api/hall-of-fame - the public board');
    // =================================================================================
    const anon = await api('GET', '/api/hall-of-fame');
    check('anonymous -> 200', anon.status === 200, `status=${anon.status}`);
    check('loggedIn false, me null for an anonymous viewer', anon.json?.loggedIn === false && anon.json?.me === null, JSON.stringify({ loggedIn: anon.json?.loggedIn, me: anon.json?.me }));
    check('page 1 of 10-row pages', anon.json?.page === 1 && anon.json?.pageSize === PAGE_SIZE);
    check('no-store (the me half is personalised)', anon.headers.get('cache-control') === 'no-store', `cache-control=${anon.headers.get('cache-control')}`);
    const rows: BoardRow[] = anon.json?.rows ?? [];
    check('rows <= page size', Array.isArray(rows) && rows.length <= PAGE_SIZE, `n=${rows.length}`);
    check('every row is exactly {rank, username, earned} with earned > 0',
        rows.every((r) => Object.keys(r).sort().join(',') === 'earned,rank,username' && typeof r.username === 'string' && Number.isInteger(r.earned) && r.earned > 0),
        JSON.stringify(rows.slice(0, 2)));
    check('rows ordered by earned desc, ranks non-decreasing, first rank is 1',
        rows.every((r, i) => i === 0 || (r.earned <= rows[i - 1].earned && r.rank >= rows[i - 1].rank)) && (rows.length === 0 || rows[0].rank === 1));
    check('ties share a rank (competition rank)', rows.every((r, i) => i === 0 || (r.earned === rows[i - 1].earned) === (r.rank === rows[i - 1].rank)));
    const totalRanked = anon.json?.totalRanked;
    check('totalRanked capped at 100, totalPages = ceil(totalRanked / 10), at least 1',
        Number.isInteger(totalRanked) && totalRanked <= MAX_RANKED && anon.json?.totalPages === Math.max(1, Math.ceil(totalRanked / PAGE_SIZE)),
        JSON.stringify({ totalRanked, totalPages: anon.json?.totalPages }));

    // Fixture presence: locate A by its computed rank. Only meaningful when the ranked
    // half was computed for this request (a run inside the last minute serves the
    // cached page, which predates these fixtures).
    const rankA = await competitionRank(expectedA);
    const cacheState = anon.headers.get('x-hall-of-fame-cache');
    if (rankA > MAX_RANKED) {
        warn(`fixture A ranks #${rankA}, outside the top 100 on this database - presence-on-board checks skipped (rank checks still run below)`);
    } else {
        const pageA = Math.ceil(rankA / PAGE_SIZE);
        const res = pageA === 1 ? anon : await api('GET', `/api/hall-of-fame?page=${pageA}`);
        const state = res.headers.get('x-hall-of-fame-cache') ?? cacheState;
        if (state === 'HIT') {
            warn(`page ${pageA} served from the edge cache (a run inside the last 60s) - presence-on-board check skipped`);
        } else {
            const rowA = (res.json?.rows as BoardRow[] | undefined)?.find((r) => r.username === 'acceptancehofa');
            check(`A appears on page ${pageA} at rank ${rankA} with earned ${expectedA}`, !!rowA && rowA.rank === rankA && rowA.earned === expectedA, JSON.stringify(rowA));
        }
    }

    // =================================================================================
    section('8. The viewer\'s own rank');
    // =================================================================================
    const meA = await api('GET', '/api/hall-of-fame', { cookie: a.cookie });
    check('A: loggedIn true', meA.status === 200 && meA.json?.loggedIn === true);
    check('A: me = {rank, username, earned} with the competition rank and the counter', meA.json?.me?.username === 'acceptancehofa' && meA.json?.me?.earned === expectedA && meA.json?.me?.rank === rankA,
        JSON.stringify({ me: meA.json?.me, rankA }));
    const meC = await api('GET', '/api/hall-of-fame', { cookie: c.cookie });
    check('C: me.rank is 1 + accounts above (a lower earner ranks below A)', meC.json?.me?.earned === expectedC && meC.json?.me?.rank === (await competitionRank(expectedC)) && meC.json.me.rank > rankA, JSON.stringify(meC.json?.me));
    const meD = await api('GET', '/api/hall-of-fame', { cookie: d.cookie });
    check('D (never earned): loggedIn true, me null', meD.json?.loggedIn === true && meD.json?.me === null, JSON.stringify({ loggedIn: meD.json?.loggedIn, me: meD.json?.me }));
    check('the board never carries an account with nothing earned', !((meD.json?.rows as BoardRow[]) ?? []).some((r) => r.username === 'acceptancehofd'));

    // =================================================================================
    section('9. Page validation');
    // =================================================================================
    for (const bad of ['0', '11', 'abc', '1.5', '-1']) {
        const res = await api('GET', `/api/hall-of-fame?page=${bad}`);
        check(`page=${bad} -> 400`, res.status === 400, `status=${res.status}`);
    }
    const last = await api('GET', '/api/hall-of-fame?page=10');
    check('page=10 -> 200 (empty rows are fine, shape still holds)', last.status === 200 && last.json?.page === 10 && Array.isArray(last.json?.rows), `status=${last.status}`);

    await cleanup();
}

export const suite: Suite = {
    name: 'hall-of-fame',
    requiredEnv: ['SESSION_TOKEN_SECRET'],
    run,
};
