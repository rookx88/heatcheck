// GET /api/tankdaq/holdings - the signed-in user's index portfolio: every position they
// hold, priced at this moment, plus their trade history. Serves the "Your position"
// panel on each /tankdaq/<key>/ page and the Indexes tab of /my-portfolio/. Session
// required; identity comes from the validated cookie only.
//
// marketValue is sellCredit(shares, price) - literally what a full sell would credit
// right now, floor and all - so the number a user sees is the number they would get.
// costBasis is Ember actually paid (avg_buy_price already includes each buy's ceil), so
// unrealized P/L reconciles to real ledger flows.
//
// Positions on a deactivated index are still listed (they are the user's) but carry
// tradeable:false and no price: getTickerValues prices active indexes only, and this
// build blocks both buying and selling an inactive one.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../../lib/pages-functions/db';
import { getSession, requireOnboarded } from '../../../lib/pages-functions/session';
import { RETROSPECTIVE_NOTE, getTickerValues } from '../../../lib/pages-functions/tickers';
import { indexLabelOf } from '../../../lib/pages-functions/ticker-copy';
import { PRICE_NOTE, sellCredit } from '../../../lib/pages-functions/ticker-price';

const TRADES_LIMIT = 100;

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const session = await getSession(context.request, context.env);
    if (!session) return jsonResponse({ message: 'Login required.' }, { status: 401 });
    const gate = requireOnboarded(session);
    if (gate) return gate;
    const authHeaders = session.refreshedSetCookie ? { 'Set-Cookie': session.refreshedSetCookie } : undefined;

    const sql = getSql(context.env);

    try {
        const [holdingRows, tradeRows, balanceRows] = await sql.transaction([
            sql`
                SELECT h.ticker_key, h.shares::float8 AS shares, h.avg_buy_price::float8 AS avg_buy_price,
                       tk.display_name, tk.rule_type, tk.active, tk.tab_order
                FROM share_holdings h
                JOIN tickers tk ON tk.key = h.ticker_key
                WHERE h.user_id = ${session.userId}
                ORDER BY tk.tab_order, tk.key
            `,
            sql`
                SELECT id, ticker_key, side, shares::float8 AS shares, price::float8 AS price,
                       ember_amount, realized_pnl::float8 AS realized_pnl, created_at
                FROM share_trades
                WHERE user_id = ${session.userId}
                ORDER BY created_at DESC, id DESC
                LIMIT ${TRADES_LIMIT}
            `,
            sql`SELECT balance FROM ember_balances WHERE user_id = ${session.userId} LIMIT 1`,
        ]);
        // Live prices from the one shared query; keyed for the join below.
        const priced = new Map((await getTickerValues(sql)).map((t) => [t.key, t]));
        const displayNames = new Map<string, string>();

        const positions = holdingRows.map((h) => {
            const key = h.ticker_key as string;
            const shares = h.shares as number;
            const avgBuyPrice = h.avg_buy_price as number;
            const live = priced.get(key) ?? null;
            const costBasis = Math.round(shares * avgBuyPrice);
            const marketValue = live ? sellCredit(shares, live.price) : null;
            displayNames.set(key, h.display_name as string);
            return {
                tickerKey: key,
                displayName: h.display_name as string,
                indexLabel: indexLabelOf(h.rule_type as string),
                ruleType: h.rule_type as string,
                shares,
                avgBuyPrice,
                costBasis,
                price: live ? live.price : null,
                marketValue,
                unrealizedPnl: marketValue !== null ? marketValue - costBasis : null,
                value: live ? live.value : null,
                tradeable: Boolean(live),
            };
        });

        const trades = tradeRows.map((t) => ({
            id: t.id as string,
            tickerKey: t.ticker_key as string,
            displayName: displayNames.get(t.ticker_key as string) ?? priced.get(t.ticker_key as string)?.displayName ?? `$${(t.ticker_key as string).toUpperCase()}`,
            side: t.side as 'buy' | 'sell',
            shares: t.shares as number,
            price: t.price as number,
            emberAmount: t.ember_amount as number,
            realizedPnl: (t.realized_pnl as number | null) ?? null,
            // Neon returns timestamps as Date objects; normalise to ISO for the client.
            createdAt: new Date(t.created_at as string).toISOString(),
        }));

        const totals = positions.reduce(
            (acc, p) => ({
                marketValue: acc.marketValue + (p.marketValue ?? 0),
                costBasis: acc.costBasis + p.costBasis,
                unrealizedPnl: acc.unrealizedPnl + (p.unrealizedPnl ?? 0),
            }),
            { marketValue: 0, costBasis: 0, unrealizedPnl: 0 },
        );
        const realizedPnl = trades.reduce((s, t) => s + (t.realizedPnl ?? 0), 0);

        return jsonResponse(
            {
                note: RETROSPECTIVE_NOTE,
                priceNote: PRICE_NOTE,
                balance: balanceRows.length ? (balanceRows[0].balance as number) : 0,
                positions,
                trades,
                totals: { ...totals, realizedPnl: Number(realizedPnl.toFixed(4)) },
            },
            { headers: authHeaders },
        );
    } catch (err) {
        console.error('[GET /api/tankdaq/holdings] Error:', err);
        return jsonResponse({ message: 'Internal server error' }, { status: 500, headers: authHeaders });
    }
};
