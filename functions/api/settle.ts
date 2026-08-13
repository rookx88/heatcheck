// POST /api/settle - protected, machine-to-machine only (called by worker-settle/'s
// daily cron, or by hand while testing). Auth is a shared secret header, not a user
// session - this is the first protected endpoint in this codebase, so it establishes
// the convention: compare X-Settle-Secret against Env.SETTLE_SECRET.
//
// Finds picks on polymarket-sourced Tanks with no result yet, and checks each
// underlying market's resolution directly against Polymarket's public Gamma API.
// Deliberately does NOT read the local polymarket_props cache table: nothing keeps that
// cache fresh in production (the only code that syncs it, polymarket.ts's
// syncAllLeagues/startPolymarketScheduler, is only ever called from backend.ts, which is
// not deployed), and even if it were running, its sync only ever fetches closed=false
// markets, so it would never observe a market transitioning to closed=true anyway.
//
// Settlement via settleCall() (lib/pages-functions/ledger.ts) is idempotent per pick, so
// this endpoint is safe to call as often as you like - a pick already settled simply
// won't show up in the `result IS NULL` query on the next run.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../lib/pages-functions/db';
import { settleCall, type CallResult } from '../../lib/pages-functions/ledger';
import { sendSettlementEmail } from '../../lib/pages-functions/email';
import { logEvent } from '../../lib/pages-functions/events';

const GAMMA_BASE_URL = 'https://gamma-api.polymarket.com';

// A price is only trusted as "the winner" once it's unambiguously resolved. Real closed
// markets settle outcomePrices to exact "1"/"0" strings - confirmed live against several
// actual resolved markets - but a stale/zero-liquidity market can resolve to something
// degenerate like ["0","0"], which must be left unsettled rather than guessed at.
const WINNER_THRESHOLD = 0.99;

interface UnresolvedPick {
    id: string;
    waitlist_id: string;
    outcome_index: number;
    market_id: string | null;
    implied_prob_at_lock: number;
    email: string;
    call_question: string | null;
}

interface GammaMarketLite {
    outcomes?: string;       // JSON-encoded string array
    outcomePrices?: string;  // JSON-encoded string array
    closed?: boolean;
}

function safeJsonParse<T>(value: string | undefined | null): T | null {
    if (!value) return null;
    try {
        return JSON.parse(value) as T;
    } catch {
        return null;
    }
}

async function fetchMarket(marketId: string): Promise<GammaMarketLite | null> {
    const res = await fetch(`${GAMMA_BASE_URL}/markets/${encodeURIComponent(marketId)}`, {
        headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return (await res.json()) as GammaMarketLite;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const secret = context.request.headers.get('X-Settle-Secret');
    if (!secret || secret !== context.env.SETTLE_SECRET) {
        return jsonResponse({ message: 'Unauthorized' }, { status: 401 });
    }

    const sql = getSql(context.env);

    // Belt-and-suspenders on `t.provider = 'polymarket'`: functions/api/picks.ts already
    // refuses to create picks on non-polymarket Tanks, but this keeps settlement correct
    // even if that invariant is ever bypassed by a future code path. email + call_question
    // are only for the settlement notification below, not resolution itself.
    const rows = await sql`
        SELECT p.id, p.waitlist_id, p.outcome_index, p.implied_prob_at_lock::float8 AS implied_prob_at_lock,
               t.game_snapshot->'prop'->>'id' AS market_id,
               w.email, t.model_output->'call'->>'question' AS call_question
        FROM picks p
        JOIN tank_pages t ON t.id = p.tank_page_id
        JOIN waitlist w ON w.id = p.waitlist_id
        WHERE p.result IS NULL AND t.provider = 'polymarket'
    `;
    const unresolved = rows as unknown as UnresolvedPick[];

    const results: Array<{ pickId: string; status: string; payoutAmount?: number }> = [];

    // Sequential, not Promise.all: current pick volume is small (up to DAILY_PICK_CAP
    // picks per account per day - functions/api/picks.ts), and Polymarket's Gamma API
    // has rate limits (see polymarket.ts's existing throttle/backoff handling for the
    // bulk sync path).
    for (const pick of unresolved) {
        if (!pick.market_id) {
            results.push({ pickId: pick.id, status: 'missing_market_id' });
            continue;
        }
        try {
            const market = await fetchMarket(pick.market_id);
            if (!market || !market.closed) {
                results.push({ pickId: pick.id, status: 'not_closed_yet' });
                continue;
            }
            const outcomePrices = safeJsonParse<string[]>(market.outcomePrices) ?? [];
            const prices = outcomePrices.map(Number);
            if (prices.length === 0 || prices.every((p) => Number.isNaN(p))) {
                results.push({ pickId: pick.id, status: 'unresolvable_prices' });
                continue;
            }
            let winningIndex = 0;
            for (let i = 1; i < prices.length; i++) {
                if (prices[i] > prices[winningIndex]) winningIndex = i;
            }
            if (prices[winningIndex] < WINNER_THRESHOLD) {
                // Neither outcome resolved unambiguously (e.g. a degenerate [0,0] market) -
                // leave it for a future run rather than guess.
                results.push({ pickId: pick.id, status: 'ambiguous_resolution' });
                continue;
            }
            const result: CallResult = pick.outcome_index === winningIndex ? 'correct' : 'incorrect';
            const { payoutAmount } = await settleCall(sql, {
                pickId: pick.id,
                userId: pick.waitlist_id,
                result,
                impliedProbAtLock: pick.implied_prob_at_lock,
            });
            results.push({ pickId: pick.id, status: `settled_${result}`, payoutAmount });

            // Both fire-and-forget - settlement itself already committed above, so
            // neither a Resend failure nor an analytics-insert failure should surface
            // as this pick having failed to settle. Same pattern as the verification
            // email in functions/api/picks.ts.
            try {
                const balanceRows = await sql`SELECT balance FROM ember_balances WHERE user_id = ${pick.waitlist_id} LIMIT 1`;
                const newBalance = balanceRows.length ? (balanceRows[0].balance as number) : payoutAmount;
                await sendSettlementEmail(context.env, pick.email, {
                    tankQuestion: pick.call_question || 'Your Tank call',
                    result,
                    payoutAmount,
                    newBalance,
                });
            } catch (emailErr) {
                console.error(`[POST /api/settle] Settlement email failed for pick ${pick.id}:`, emailErr);
            }
            try {
                // No real "visitor" for a cron-triggered settlement - a fresh random id
                // per event (rather than a fixed shared constant) avoids falsely
                // clustering unrelated settlement events under one synthetic visitor.
                await logEvent(sql, {
                    visitorId: crypto.randomUUID(),
                    waitlistId: pick.waitlist_id,
                    eventType: 'pick_settled',
                    metadata: { pickId: pick.id, result, payoutAmount },
                });
            } catch (eventErr) {
                console.error(`[POST /api/settle] Failed to log pick_settled event for pick ${pick.id}:`, eventErr);
            }
        } catch (err) {
            console.error(`[POST /api/settle] Failed to settle pick ${pick.id}:`, err);
            results.push({ pickId: pick.id, status: 'error' });
        }
    }

    return jsonResponse({ checked: unresolved.length, results });
};
