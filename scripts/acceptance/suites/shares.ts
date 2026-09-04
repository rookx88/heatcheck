// Acceptance suite for TANKDAQ share trading: the Ember price transform
// (lib/pages-functions/ticker-price.ts, surfaced by getTickerValues), and the buy/sell/
// holdings endpoints (functions/api/tankdaq/*.ts) over ledger.buyShares/sellShares.
//
// What this proves, in order:
//   - every active index prices strictly positive AGAINST REAL DATA (including $DOGS at
//     its genuinely negative cumulative), and the price the API reports is exactly the
//     transform of the value it reports alongside;
//   - trading never touches ticker_events (row count identical across the whole suite);
//   - a buy debits ceil(shares * price) and holds a weighted-average cost; a replayed
//     tradeToken writes nothing new;
//   - a sell credits floor(shares * price) at the CURRENT price - proven by moving the
//     price between buy and sell WITHOUT writing ticker_events (flip the ticker's
//     price_baseline, restored by teardown) - and records realized P/L against cost;
//   - a sell for more than held is refused with nothing written; a full sell removes the
//     row and a later buy starts a fresh position;
//   - the $OVERS/$UNDERS mirror holds in price space (ln p_a + ln p_b = 2 ln baseline);
//   - all fourteen indexes are tradeable.
// Every DB assertion reads the tables directly (ledger, balances, holdings, trades) -
// a status code proves what one response said; the rows prove what was written.

import { pool, api, check, section, near, registerTeardown, warn, type Suite } from '../harness';
import { createSessionUser, cleanupUsersByEmailPrefix, ledgerTotals } from '../fixtures';
import { priceFromValue, buyCost, sellCredit } from '../../../lib/pages-functions/ticker-price';

const EMAIL_PREFIX = 'acceptance-shares-';
// The index the buy/sell sections trade. Chosen because its cumulative is deeply
// negative today, which is exactly the case the positivity guarantee has to cover.
const TICKER = 'dogs';

// ---------------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------------

function user(tag: string): string {
    return `${EMAIL_PREFIX}${tag}@example.com`;
}

// Same as suites/pets.ts's seedBalance: one ember_ledger row whose amount folds into
// ember_balances in the same statement, so the cache == SUM(ledger) invariant that
// ledger-trace asserts is never broken by a fixture.
async function seedBalance(userId: string, amount: number): Promise<void> {
    const idempotencyKey = `acceptance-shares-seed:${userId}:${crypto.randomUUID()}`;
    await pool.query(
        `WITH ins AS (
            INSERT INTO ember_ledger (user_id, amount, entry_type, rule_key, rule_version, idempotency_key, metadata)
            VALUES ($1, $2, 'adjustment', 'participation', 1, $3, '{"acceptance":"shares fixture seed"}')
            RETURNING amount
        )
        INSERT INTO ember_balances (user_id, balance, updated_at)
        SELECT $1, amount, NOW() FROM ins
        ON CONFLICT (user_id) DO UPDATE SET balance = ember_balances.balance + EXCLUDED.balance, updated_at = NOW()`,
        [userId, amount, idempotencyKey],
    );
}

async function currentBalance(userId: string): Promise<number> {
    const { rows } = await pool.query(`SELECT balance FROM ember_balances WHERE user_id = $1`, [userId]);
    return rows.length ? Number(rows[0].balance) : 0;
}

async function position(userId: string, tickerKey: string): Promise<{ shares: number; avgBuyPrice: number } | null> {
    const { rows } = await pool.query(
        `SELECT shares::float8 AS shares, avg_buy_price::float8 AS avg FROM share_holdings WHERE user_id = $1 AND ticker_key = $2`,
        [userId, tickerKey],
    );
    return rows.length ? { shares: Number(rows[0].shares), avgBuyPrice: Number(rows[0].avg) } : null;
}

async function ledgerRows(userId: string, ruleKey: string): Promise<Array<{ amount: number; idempotency_key: string }>> {
    const { rows } = await pool.query(
        `SELECT amount, idempotency_key FROM ember_ledger WHERE user_id = $1 AND rule_key = $2 ORDER BY id`,
        [userId, ruleKey],
    );
    return rows.map((r) => ({ amount: Number(r.amount), idempotency_key: r.idempotency_key as string }));
}

async function tradeRows(userId: string): Promise<Array<{ side: string; shares: number; price: number; ember_amount: number; realized_pnl: number | null }>> {
    const { rows } = await pool.query(
        `SELECT side, shares::float8 AS shares, price::float8 AS price, ember_amount, realized_pnl::float8 AS realized_pnl
         FROM share_trades WHERE user_id = $1 ORDER BY created_at, id`,
        [userId],
    );
    return rows.map((r) => ({
        side: r.side as string, shares: Number(r.shares), price: Number(r.price),
        ember_amount: Number(r.ember_amount), realized_pnl: r.realized_pnl === null ? null : Number(r.realized_pnl),
    }));
}

async function tickerEventCount(): Promise<number> {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ticker_events`);
    return Number(rows[0].n);
}

function buyReq(cookie: string | null, tickerKey: string, shares: unknown, tradeToken: string = crypto.randomUUID()) {
    return api('POST', '/api/tankdaq/buy', { cookie, body: { tickerKey, shares, tradeToken } });
}
function sellReq(cookie: string | null, tickerKey: string, shares: unknown, tradeToken: string = crypto.randomUUID()) {
    return api('POST', '/api/tankdaq/sell', { cookie, body: { tickerKey, shares, tradeToken } });
}
function holdingsReq(cookie: string | null) {
    return api('GET', '/api/tankdaq/holdings', { cookie });
}

// The live price of one index, from the same public read the boards use.
async function livePrice(tickerKey: string): Promise<{ price: number; value: number; baseline: number; scale: number }> {
    const res = await api('GET', `/api/tickers/detail?key=${tickerKey}`);
    const t = res.json?.ticker;
    return { price: t.price, value: t.value, baseline: t.priceBaseline, scale: t.priceScale };
}

async function cleanup(): Promise<void> {
    await cleanupUsersByEmailPrefix(EMAIL_PREFIX);
}

// ---------------------------------------------------------------------------------

async function run(): Promise<void> {
    await cleanup();

    // ticker_events must be untouched by everything below - captured first, compared last.
    const eventsBefore = await tickerEventCount();

    // =================================================================================
    section('1. Price transform against real data');
    // =================================================================================
    const list = await api('GET', '/api/tickers');
    const tickers: any[] = list.json?.tickers ?? [];
    check('GET /api/tickers returns 200 with priceNote', list.status === 200 && typeof list.json?.priceNote === 'string' && list.json.priceNote.includes('not a forecast'));
    check('all active indexes carry a strictly positive price', tickers.length > 0 && tickers.every((t) => typeof t.price === 'number' && t.price > 0),
        tickers.filter((t) => !(t.price > 0)).map((t) => `${t.key}=${t.price}`).join(','));
    const dogs = tickers.find((t) => t.key === 'dogs');
    check('$DOGS: negative cumulative value, positive price (the guarantee that matters)',
        !!dogs && dogs.value < 0 && dogs.price > 0, dogs ? `value=${dogs.value} price=${dogs.price}` : 'dogs missing');
    check('every reported price is exactly baseline * exp(value / scale) of its own row, to 4 dp',
        tickers.every((t) => near(t.price, priceFromValue(t.value, { baseline: t.priceBaseline, scale: t.priceScale }), 1e-6)));
    const detail = await api('GET', `/api/tickers/detail?key=${TICKER}`);
    check('GET /api/tickers/detail carries price, priceBaseline, priceScale and priceNote',
        detail.status === 200 && detail.json?.ticker?.price > 0 && detail.json?.ticker?.priceBaseline > 0
        && detail.json?.ticker?.priceScale > 0 && typeof detail.json?.priceNote === 'string');

    // =================================================================================
    section('2. Auth and validation');
    // =================================================================================
    const anon = await buyReq(null, TICKER, 1);
    check('buy without a session -> 401', anon.status === 401, `status=${anon.status}`);
    const u = await createSessionUser(user('trader'));
    await seedBalance(u.userId, 1000);
    const badToken = await api('POST', '/api/tankdaq/buy', { cookie: u.cookie, body: { tickerKey: TICKER, shares: 1, tradeToken: 'not-a-uuid' } });
    check('non-UUID tradeToken -> 400', badToken.status === 400, `status=${badToken.status}`);
    const fractional = await buyReq(u.cookie, TICKER, 1.5);
    check('fractional shares -> 400 (whole shares only)', fractional.status === 400, `status=${fractional.status}`);
    const zero = await buyReq(u.cookie, TICKER, 0);
    check('zero shares -> 400', zero.status === 400, `status=${zero.status}`);
    const unknown = await buyReq(u.cookie, 'not-an-index', 1);
    check('unknown index -> 404', unknown.status === 404, `status=${unknown.status}`);
    const notOnboarded = await createSessionUser(user('fresh'), { onboarded: false });
    const gated = await buyReq(notOnboarded.cookie, TICKER, 1);
    check('not-onboarded session -> 403', gated.status === 403, `status=${gated.status}`);
    check('nothing was written for any rejected request', (await ledgerRows(u.userId, 'shares_buy')).length === 0 && (await position(u.userId, TICKER)) === null);

    // =================================================================================
    section('3. Buy: debit is ceil(shares * price), position is Ember-paid / shares');
    // =================================================================================
    const before = await currentBalance(u.userId);
    const buy1 = await buyReq(u.cookie, TICKER, 3);
    check('buy 3 -> 200 ok, not a replay', buy1.status === 200 && buy1.json?.ok === true && buy1.json?.replay === false, JSON.stringify(buy1.json));
    const q1 = buy1.json?.trade?.price as number;
    const cost1 = buy1.json?.trade?.emberAmount as number;
    check('reported cost equals buyCost(3, quoted price)', cost1 === buyCost(3, q1), `cost=${cost1} expected=${buyCost(3, q1)}`);
    check('cost is a whole number of Ember >= 3 * price (ceil, never in the trader\'s favour)',
        Number.isInteger(cost1) && cost1 >= 3 * q1 && cost1 - 3 * q1 < 1, `cost=${cost1} 3*price=${3 * q1}`);
    check('balance dropped by exactly the cost', (await currentBalance(u.userId)) === before - cost1);
    const led1 = await ledgerRows(u.userId, 'shares_buy');
    check('exactly one shares_buy ledger row, amount = -cost', led1.length === 1 && led1[0].amount === -cost1, JSON.stringify(led1));
    const pos1 = await position(u.userId, TICKER);
    check('holdings: 3 shares at avg = cost / 3', !!pos1 && pos1.shares === 3 && near(pos1.avgBuyPrice, cost1 / 3, 1e-6), JSON.stringify(pos1));
    check('response position matches the row', buy1.json?.position?.shares === 3 && near(buy1.json?.position?.avgBuyPrice, cost1 / 3, 1e-6));
    const t1 = await tradeRows(u.userId);
    check('one trade row: buy, 3 shares, quoted price, cost, no realized P/L',
        t1.length === 1 && t1[0].side === 'buy' && t1[0].shares === 3 && near(t1[0].price, q1, 1e-6) && t1[0].ember_amount === cost1 && t1[0].realized_pnl === null, JSON.stringify(t1));
    const lt = await ledgerTotals(u.userId);
    check('ember_balances cache == SUM(ember_ledger) after the buy', lt.balanceCache ===lt.ledgerSum, JSON.stringify(lt));

    // =================================================================================
    section('4. A second buy re-weights the average by Ember actually paid');
    // =================================================================================
    const buy2 = await buyReq(u.cookie, TICKER, 2);
    const cost2 = buy2.json?.trade?.emberAmount as number;
    check('buy 2 more -> 200', buy2.status === 200 && buy2.json?.ok === true, JSON.stringify(buy2.json));
    const pos2 = await position(u.userId, TICKER);
    check('holdings: 5 shares, avg = (cost1 + cost2) / 5', !!pos2 && pos2.shares === 5 && near(pos2.avgBuyPrice, (cost1 + cost2) / 5, 1e-6), JSON.stringify({ pos2, cost1, cost2 }));
    check('two shares_buy ledger rows', (await ledgerRows(u.userId, 'shares_buy')).length === 2);

    // =================================================================================
    section('5. Same tradeToken replays as a no-op');
    // =================================================================================
    const token = crypto.randomUUID();
    const first = await buyReq(u.cookie, TICKER, 1, token);
    const again = await buyReq(u.cookie, TICKER, 1, token);
    check('first use -> 200 replay:false; second use -> 200 replay:true',
        first.status === 200 && first.json?.replay === false && again.status === 200 && again.json?.replay === true, `${first.status}/${first.json?.replay} ${again.status}/${again.json?.replay}`);
    check('exactly three shares_buy ledger rows (the replay wrote nothing)', (await ledgerRows(u.userId, 'shares_buy')).length === 3);
    const pos3 = await position(u.userId, TICKER);
    check('holdings: 6 shares (the replay added none)', !!pos3 && pos3.shares === 6, JSON.stringify(pos3));
    check('replay response still reports the position', again.json?.position?.shares === 6);

    // =================================================================================
    section('6. Sell realizes at the CURRENT price - moved without touching ticker_events');
    // =================================================================================
    const { rows: orig } = await pool.query(`SELECT price_baseline::float8 AS b, price_scale::float8 AS s FROM tickers WHERE key = $1`, [TICKER]);
    const origBaseline = Number(orig[0].b);
    const restore = async () => { await pool.query(`UPDATE tickers SET price_baseline = $1 WHERE key = $2`, [origBaseline, TICKER]); };
    registerTeardown(restore);
    const avgBefore = pos3!.avgBuyPrice;
    const priceBefore = (await livePrice(TICKER)).price;
    // 1.5x the baseline = 1.5x the price, and not one row of ticker_events changed.
    await pool.query(`UPDATE tickers SET price_baseline = $1 WHERE key = $2`, [origBaseline * 1.5, TICKER]);
    const moved = await livePrice(TICKER);
    check('price moved to 1.5x via baseline only', near(moved.price, priceBefore * 1.5, 0.01), `before=${priceBefore} after=${moved.price}`);
    check('ticker_events untouched by the price move', (await tickerEventCount()) === eventsBefore);

    const balBeforeSell = await currentBalance(u.userId);
    const sell1 = await sellReq(u.cookie, TICKER, 2);
    const credit1 = sell1.json?.trade?.emberAmount as number;
    const qs = sell1.json?.trade?.price as number;
    check('sell 2 -> 200 ok', sell1.status === 200 && sell1.json?.ok === true, JSON.stringify(sell1.json));
    check('quoted at the MOVED price, not the buy price', near(qs, moved.price, 1e-6) && qs > avgBefore, `quote=${qs} moved=${moved.price} avg=${avgBefore}`);
    check('credit equals sellCredit(2, current price) - floor, never rounded up', credit1 === sellCredit(2, qs) && credit1 <= 2 * qs, `credit=${credit1} 2*price=${2 * qs}`);
    check('balance rose by exactly the credit', (await currentBalance(u.userId)) === balBeforeSell + credit1);
    const sellLed = await ledgerRows(u.userId, 'shares_sell');
    check('one shares_sell ledger row, amount = +credit', sellLed.length === 1 && sellLed[0].amount === credit1, JSON.stringify(sellLed));
    const pos4 = await position(u.userId, TICKER);
    check('holdings: 4 shares remain, average unchanged by a sell', !!pos4 && pos4.shares === 4 && near(pos4.avgBuyPrice, avgBefore, 1e-6), JSON.stringify(pos4));
    const sellTrade = (await tradeRows(u.userId)).find((t) => t.side === 'sell');
    check('trade row realized_pnl = credit - 2 * avg_buy_price', !!sellTrade && sellTrade.realized_pnl !== null && near(sellTrade.realized_pnl, credit1 - 2 * avgBefore, 1e-3), JSON.stringify(sellTrade));
    check('realized P/L is a gain (sold above cost)', !!sellTrade && (sellTrade.realized_pnl ?? 0) > 0);
    const lt2 = await ledgerTotals(u.userId);
    check('ember_balances cache == SUM(ember_ledger) after the sell', lt2.balanceCache ===lt2.ledgerSum, JSON.stringify(lt2));
    await restore();
    check('baseline restored', near((await livePrice(TICKER)).price, priceBefore, 1e-6));

    // =================================================================================
    section('7. Over-sell is refused, nothing written');
    // =================================================================================
    const ledCountBefore = (await ledgerRows(u.userId, 'shares_sell')).length;
    const over = await sellReq(u.cookie, TICKER, 5); // holds 4
    check('sell 5 with 4 held -> 409 carrying the held count', over.status === 409 && over.json?.shares === 4, JSON.stringify(over.json));
    check('no ledger row, holdings unchanged', (await ledgerRows(u.userId, 'shares_sell')).length === ledCountBefore && (await position(u.userId, TICKER))?.shares === 4);
    const balAfterOver = await currentBalance(u.userId);
    check('balance unchanged by the refused sell', balAfterOver === balBeforeSell + credit1);

    // =================================================================================
    section('8. Full sell removes the row; a later buy starts fresh');
    // =================================================================================
    const sellAll = await sellReq(u.cookie, TICKER, 4);
    check('sell all 4 -> 200, position null in the response', sellAll.status === 200 && sellAll.json?.position === null, JSON.stringify(sellAll.json));
    check('share_holdings row is gone', (await position(u.userId, TICKER)) === null);
    const rebuy = await buyReq(u.cookie, TICKER, 2);
    const rebuyCost = rebuy.json?.trade?.emberAmount as number;
    const posFresh = await position(u.userId, TICKER);
    check('re-buy creates a fresh position with avg = new cost / 2 (no ghost of the old average)',
        rebuy.status === 200 && !!posFresh && posFresh.shares === 2 && near(posFresh.avgBuyPrice, rebuyCost / 2, 1e-6), JSON.stringify({ rebuy: rebuy.json, posFresh }));

    // =================================================================================
    section('9. Holdings endpoint');
    // =================================================================================
    const h = await holdingsReq(u.cookie);
    check('GET /api/tankdaq/holdings -> 200 with both notes', h.status === 200 && typeof h.json?.note === 'string' && typeof h.json?.priceNote === 'string');
    const hp = (h.json?.positions ?? []).find((p: any) => p.tickerKey === TICKER);
    check('lists the open position with live price and a computable P/L',
        !!hp && hp.shares === 2 && hp.price > 0 && hp.tradeable === true && hp.marketValue === sellCredit(2, hp.price) && hp.unrealizedPnl === hp.marketValue - hp.costBasis, JSON.stringify(hp));
    check('trade history newest-first, all six trades present', Array.isArray(h.json?.trades) && h.json.trades.length === 6 && h.json.trades[0].side === 'buy',
        `n=${h.json?.trades?.length} first=${h.json?.trades?.[0]?.side}`);
    check('holdings without a session -> 401', (await holdingsReq(null)).status === 401);

    // =================================================================================
    section('10. $OVERS/$UNDERS mirror holds in price space');
    // =================================================================================
    const overs = tickers.find((t) => t.key === 'overs');
    const unders = tickers.find((t) => t.key === 'unders');
    if (overs && unders) {
        check('mirror pair shares identical baseline and scale', overs.priceBaseline === unders.priceBaseline && overs.priceScale === unders.priceScale);
        check('cumulative values are exact negatives', near(overs.value + unders.value, 0, 1e-3), `${overs.value} + ${unders.value}`);
        check('ln(p_overs) + ln(p_unders) = 2 ln(baseline) - inverse moves in log space',
            near(Math.log(overs.price) + Math.log(unders.price), 2 * Math.log(overs.priceBaseline), 1e-6));
    } else {
        warn('overs/unders not both active - mirror check skipped');
    }

    // =================================================================================
    section('11. Every active index is tradeable');
    // =================================================================================
    const all = await createSessionUser(user('everything'));
    await seedBalance(all.userId, 5000);
    let bought = 0;
    for (const t of tickers) {
        const r = await buyReq(all.cookie, t.key, 1);
        if (r.status === 200 && r.json?.ok) bought++;
        else console.error(`    buy 1 ${t.key} -> ${r.status} ${JSON.stringify(r.json)}`);
    }
    check(`bought 1 share of each of the ${tickers.length} active indexes`, bought === tickers.length, `bought=${bought}`);
    const { rows: cnt } = await pool.query(`SELECT COUNT(*)::int AS n FROM share_holdings WHERE user_id = $1`, [all.userId]);
    check('one holdings row per index', Number(cnt[0].n) === tickers.length);
    const hAll = await holdingsReq(all.cookie);
    const sumMv = (hAll.json?.positions ?? []).reduce((s: number, p: any) => s + p.marketValue, 0);
    check('holdings totals reconcile to the positions', hAll.json?.totals?.marketValue === sumMv && hAll.json?.positions?.length === tickers.length);

    // =================================================================================
    section('12. Trading never wrote ticker_events');
    // =================================================================================
    check('ticker_events row count identical to before the suite', (await tickerEventCount()) === eventsBefore);

    await cleanup();
}

export const suite: Suite = {
    name: 'shares',
    requiredEnv: ['SESSION_TOKEN_SECRET'],
    run,
};
