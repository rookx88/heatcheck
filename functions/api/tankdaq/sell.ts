// POST /api/tankdaq/sell - sell whole shares of an index at its live Ember price. The
// credit is floor(shares * price) at the price the index carries RIGHT NOW, never the
// price the shares were bought at - that is what makes a position carry real, uncapped
// gain or loss rather than anything resembling a fixed return. The position decrement,
// the ledger credit, the balance fold and the trade record happen atomically
// (ledger.sellShares), guarded by `shares >= n` so a sell can never drive a position
// negative: asking for more than you hold -> 409, nothing written. No lock-in, no
// maturity - shares bought a second ago are sellable now.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, UUID_RE, type Env } from '../../../lib/pages-functions/db';
import { getSession, requireSameOrigin, requireOnboarded } from '../../../lib/pages-functions/session';
import { sellShares } from '../../../lib/pages-functions/ledger';
import { RETROSPECTIVE_NOTE, getTickerValues } from '../../../lib/pages-functions/tickers';
import { PRICE_NOTE, isWholeShares, sellCredit } from '../../../lib/pages-functions/ticker-price';

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const csrf = requireSameOrigin(context.request);
    if (csrf) return csrf;

    const session = await getSession(context.request, context.env);
    if (!session) return jsonResponse({ message: 'Login required.' }, { status: 401 });
    const gate = requireOnboarded(session);
    if (gate) return gate;
    const authHeaders = session.refreshedSetCookie ? { 'Set-Cookie': session.refreshedSetCookie } : undefined;

    let body: any;
    try {
        body = await context.request.json();
    } catch {
        return jsonResponse({ message: 'Invalid JSON body.' }, { status: 400, headers: authHeaders });
    }

    const tickerKey = typeof body?.tickerKey === 'string' ? body.tickerKey.trim() : '';
    const shares = body?.shares;
    const tradeToken = typeof body?.tradeToken === 'string' && UUID_RE.test(body.tradeToken) ? body.tradeToken : '';
    if (!tickerKey) return jsonResponse({ message: 'Missing tickerKey.' }, { status: 400, headers: authHeaders });
    if (!isWholeShares(shares)) return jsonResponse({ message: 'shares must be a whole number of at least 1.' }, { status: 400, headers: authHeaders });
    if (!tradeToken) return jsonResponse({ message: 'Missing or invalid tradeToken.' }, { status: 400, headers: authHeaders });

    const sql = getSql(context.env);

    const [ticker] = await getTickerValues(sql, tickerKey);
    if (!ticker) {
        return jsonResponse({ message: `No active index "${tickerKey}".` }, { status: 404, headers: authHeaders });
    }
    const price = ticker.price;
    const credit = sellCredit(shares, price);

    try {
        const result = await sellShares(sql, {
            userId: session.userId,
            tickerKey,
            shares,
            price,
            emberAmount: credit,
            tradeToken,
        });

        const positionRows = await sql`
            SELECT shares::float8 AS shares, avg_buy_price::float8 AS avg_buy_price
            FROM share_holdings WHERE user_id = ${session.userId} AND ticker_key = ${tickerKey} LIMIT 1`;
        const position = positionRows.length
            ? { shares: positionRows[0].shares as number, avgBuyPrice: positionRows[0].avg_buy_price as number }
            : null;

        if (!result.ok) {
            return jsonResponse(
                { message: 'Not enough shares.', shares: position?.shares ?? 0 },
                { status: 409, headers: authHeaders },
            );
        }

        const balanceRows = await sql`SELECT balance FROM ember_balances WHERE user_id = ${session.userId} LIMIT 1`;
        const balance = balanceRows.length ? (balanceRows[0].balance as number) : 0;

        return jsonResponse(
            {
                ok: true,
                replay: result.replay,
                trade: { side: 'sell', tickerKey, shares, price, emberAmount: credit, realizedPnl: result.realizedPnl },
                // null when the sale emptied the position (the row is removed).
                position,
                balance,
                note: RETROSPECTIVE_NOTE,
                priceNote: PRICE_NOTE,
            },
            { headers: authHeaders },
        );
    } catch (err) {
        console.error('[POST /api/tankdaq/sell] Error:', err);
        return jsonResponse({ message: 'Internal server error' }, { status: 500, headers: authHeaders });
    }
};
