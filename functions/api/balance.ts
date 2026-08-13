// GET /api/balance?email=... - the minimum needed for a user to ever see that
// settlement did anything. Without this, Ember payouts are invisible and the whole
// loop's payoff is inert.
//
// Same no-session trust model as every other endpoint in this app (email in, no
// token) - only returns a real balance for a verified account; unknown/unverified
// both get {balance: 0}, not an error, since a brand-new account legitimately has no
// balance yet. Logged on every call (see below) as the interim safeguard for that
// trust gap, since real auth isn't happening this round - see
// lib/pages-functions/tokens.ts for the generic primitive this can build on later.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, EMAIL_RE, type Env } from '../../lib/pages-functions/db';

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const url = new URL(context.request.url);
    const email = (url.searchParams.get('email') || '').trim().toLowerCase();

    if (!EMAIL_RE.test(email)) {
        return jsonResponse({ message: 'Please provide a valid email address.' }, { status: 400 });
    }

    // Interim safeguard while this route has no real auth behind it: anyone who knows
    // or guesses an email can read that account's balance. Not alerting on it yet,
    // just making sure it's visible after the fact if it ever needs to be - can't
    // backfill monitoring data for calls that already happened.
    console.log('[GET /api/balance]', {
        email,
        ip: context.request.headers.get('CF-Connecting-IP'),
        timestamp: new Date().toISOString(),
    });

    const sql = getSql(context.env);

    const rows = await sql`SELECT id, email_verified FROM waitlist WHERE LOWER(email) = ${email} LIMIT 1`;
    if (rows.length === 0 || !rows[0].email_verified) {
        return jsonResponse({ balance: 0, verified: false });
    }
    const waitlistId = rows[0].id as string;

    // ember_balances is a derived cache (lib/pages-functions/ledger.ts's balance()
    // only returns the number; queried directly here since this route also wants
    // updated_at) - no row yet just means no payout has ever landed, a legitimate
    // brand-new-account state, not an error.
    const balanceRows = await sql`SELECT balance, updated_at FROM ember_balances WHERE user_id = ${waitlistId} LIMIT 1`;
    if (balanceRows.length === 0) {
        return jsonResponse({ balance: 0, updatedAt: null, verified: true });
    }
    return jsonResponse({
        balance: balanceRows[0].balance as number,
        updatedAt: balanceRows[0].updated_at,
        verified: true,
    });
};
