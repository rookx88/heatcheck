// GET /api/onboarding-status - what the /welcome/ page asks on load, and the resume
// check that makes the letter un-skippable: onboarded_at IS NULL keeps answering
// { onboarded: false } until the letter is actually signed, no matter how many times
// the tab closed mid-flow. Session-required, same shape as balance.ts.
//
// letterData personalizes the letter with REAL numbers only (never a vague "you've
// been busy"): the Ember balance and a LIFETIME, all-sources pick count. Lifetime and
// all-sources on purpose - founding-era detection asks "did this person ever do
// anything here", which is history semantics, not daily-cap semantics; a
// newsletter-exclusive pick is real history exactly like an app pick, and excluding it
// would tell an early newsletter picker they're brand-new - the false story the letter
// must never tell.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../lib/pages-functions/db';
import { getSession } from '../../lib/pages-functions/session';

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const session = await getSession(context.request, context.env);
    if (!session) {
        return jsonResponse({ message: 'Login required.' }, { status: 401 });
    }
    const authHeaders = session.refreshedSetCookie ? { 'Set-Cookie': session.refreshedSetCookie } : undefined;

    // Already onboarded: answered straight off the session's waitlist join, zero
    // extra queries - and permanently, since onboarded_at is never unset.
    if (session.onboarded) {
        return jsonResponse({ onboarded: true }, { headers: authHeaders });
    }

    // One round trip via scalar subqueries (picks.ts's cap-check pattern).
    // ember_balances is a derived cache - no row means genuinely nothing earned, a
    // legitimate brand-new state, not an error (same note as balance.ts).
    const sql = getSql(context.env);
    try {
        const rows = await sql`
            SELECT
                COALESCE((SELECT balance FROM ember_balances WHERE user_id = ${session.userId} LIMIT 1), 0)::int AS balance,
                (SELECT COUNT(*)::int FROM picks WHERE waitlist_id = ${session.userId}) AS pick_count
        `;
        const balance = Number(rows[0].balance ?? 0);
        const pickCount = Number(rows[0].pick_count ?? 0);
        return jsonResponse(
            {
                onboarded: false,
                letterData: { balance, pickCount, isFoundingEra: balance > 0 || pickCount > 0 },
            },
            { headers: authHeaders }
        );
    } catch (err) {
        console.error('[GET /api/onboarding-status] Error reading letter data:', err);
        return jsonResponse({ message: 'Internal server error' }, { status: 500, headers: authHeaders });
    }
};
