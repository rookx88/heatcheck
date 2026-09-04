// POST /api/tankdaq/buy - buy whole shares of an index at its live Ember price. The
// debit, the ledger row, the position upsert and the trade record happen in ONE atomic,
// idempotent statement (ledger.buyShares), so a rapid double-submit with the same
// tradeToken debits once and grants once. Nothing the client sends is trusted for
// pricing: the server reads the index's price from the same query every board uses
// (getTickerValues) at the moment of the request, and cost is ceil(shares * price) so
// rounding never favours the trader. Insufficient Ember -> 402, nothing written.
//
// Trading never writes ticker_events. Stories and results move the price; a trade only
// consumes it - which is why this endpoint reads the price and then simply pays it.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, UUID_RE, type Env } from '../../../lib/pages-functions/db';
import { getSession, requireSameOrigin, requireOnboarded } from '../../../lib/pages-functions/session';
import { buyShares } from '../../../lib/pages-functions/ledger';
import { RETROSPECTIVE_NOTE, getTickerValues } from '../../../lib/pages-functions/tickers';
import { PRICE_NOTE, buyCost, isWholeShares } from '../../../lib/pages-functions/ticker-price';

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
    // A client-supplied idempotency token (UUID): a double-submit reuses it and no-ops.
    const tradeToken = typeof body?.tradeToken === 'string' && UUID_RE.test(body.tradeToken) ? body.tradeToken : '';
    if (!tickerKey) return jsonResponse({ message: 'Missing tickerKey.' }, { status: 400, headers: authHeaders });
    if (!isWholeShares(shares)) return jsonResponse({ message: 'shares must be a whole number of at least 1.' }, { status: 400, headers: authHeaders });
    if (!tradeToken) return jsonResponse({ message: 'Missing or invalid tradeToken.' }, { status: 400, headers: authHeaders });

    const sql = getSql(context.env);

    // The live price, from the one query every surface reads. An unknown or inactive
    // index has no price and can't be bought.
    const [ticker] = await getTickerValues(sql, tickerKey);
    if (!ticker) {
        return jsonResponse({ message: `No active index "${tickerKey}".` }, { status: 404, headers: authHeaders });
    }
    const price = ticker.price;
    const cost = buyCost(shares, price);

    try {
        const result = await buyShares(sql, {
            userId: session.userId,
            tickerKey,
            shares,
            price,
            emberAmount: cost,
            tradeToken,
        });

        const balanceRows = await sql`SELECT balance FROM ember_balances WHERE user_id = ${session.userId} LIMIT 1`;
        const balance = balanceRows.length ? (balanceRows[0].balance as number) : 0;

        if (!result.ok) {
            return jsonResponse({ message: 'Not enough Ember.', balance, cost }, { status: 402, headers: authHeaders });
        }

        // On an idempotent replay the CTE returns no position (nothing was written this
        // time), so read the one the original request left behind.
        let position = result.position;
        if (!position) {
            const rows = await sql`
                SELECT shares::float8 AS shares, avg_buy_price::float8 AS avg_buy_price
                FROM share_holdings WHERE user_id = ${session.userId} AND ticker_key = ${tickerKey} LIMIT 1`;
            position = rows.length
                ? { shares: rows[0].shares as number, avgBuyPrice: rows[0].avg_buy_price as number }
                : null;
        }

        return jsonResponse(
            {
                ok: true,
                replay: result.replay,
                trade: { side: 'buy', tickerKey, shares, price, emberAmount: cost },
                position,
                balance,
                note: RETROSPECTIVE_NOTE,
                priceNote: PRICE_NOTE,
            },
            { headers: authHeaders },
        );
    } catch (err) {
        console.error('[POST /api/tankdaq/buy] Error:', err);
        return jsonResponse({ message: 'Internal server error' }, { status: 500, headers: authHeaders });
    }
};
