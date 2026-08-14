// GET /api/balance - the minimum needed for a user to ever see that settlement did
// anything. Without this, Ember payouts are invisible and the whole loop's payoff is
// inert.
//
// Session-required since the magic-link auth rollout: identity comes from the
// validated hc_session cookie (lib/pages-functions/session.ts), never from an email
// query param - the old email-in trust model let anyone who knew an address read that
// account's balance, and this is the structural fix. No session -> 401, full stop.
// `verified` rides along from the session's waitlist join; the old "unverified gets
// {balance: 0}" masking is gone because a session already proves inbox ownership.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../lib/pages-functions/db';
import { getSession } from '../../lib/pages-functions/session';

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const session = await getSession(context.request, context.env);
    if (!session) {
        return jsonResponse({ message: 'Login required.' }, { status: 401 });
    }
    const authHeaders = session.refreshedSetCookie ? { 'Set-Cookie': session.refreshedSetCookie } : undefined;

    const sql = getSql(context.env);

    // ember_balances is a derived cache (lib/pages-functions/ledger.ts's balance()
    // only returns the number; queried directly here since this route also wants
    // updated_at) - no row yet just means no payout has ever landed, a legitimate
    // brand-new-account state, not an error.
    const balanceRows = await sql`SELECT balance, updated_at FROM ember_balances WHERE user_id = ${session.userId} LIMIT 1`;
    if (balanceRows.length === 0) {
        return jsonResponse({ balance: 0, updatedAt: null, verified: session.verified }, { headers: authHeaders });
    }
    return jsonResponse(
        {
            balance: balanceRows[0].balance as number,
            updatedAt: balanceRows[0].updated_at,
            verified: session.verified,
        },
        { headers: authHeaders }
    );
};
