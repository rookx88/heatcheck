// POST /api/settle - protected, machine-to-machine only (called by worker-settle/'s
// daily cron, or by hand while testing). Auth is a shared secret header, not a user
// session - this is the first protected endpoint in this codebase, so it establishes
// the convention: compare X-Settle-Secret against Env.SETTLE_SECRET.
//
// Finds picks on polymarket-sourced Tanks with no result yet, and checks each
// underlying market's resolution directly against Polymarket's public Gamma API (see
// lib/pages-functions/gamma.ts for why the polymarket_props cache is deliberately not
// used). Also settles pending ticker tags (lib/pages-functions/tickers.ts): a
// ticker-tagged Tank resolves here even if nobody ever picked it, and a Tank with both
// picks and tags resolves its market exactly once per run via the resolution cache.
//
// Settlement via settleCall() (lib/pages-functions/ledger.ts) is idempotent per pick,
// and settleTag() is idempotent per tag (calculated_at CTE guard), so this endpoint is
// safe to call as often as you like - anything already settled simply won't show up in
// the pending scans on the next run.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../lib/pages-functions/db';
import { settleCall, type CallResult } from '../../lib/pages-functions/ledger';
import { sendSettlementEmail } from '../../lib/pages-functions/email';
import { logEvent } from '../../lib/pages-functions/events';
import {
    fetchMarket,
    outcomeOrderMismatch,
    resolveMarket,
    type MarketResolution,
} from '../../lib/pages-functions/gamma';
import {
    fetchMarket as fetchKalshiMarket,
    resolveMarket as resolveKalshiMarket,
    type KalshiMarketResolution,
} from '../../lib/pages-functions/kalshi';
import { settleTag } from '../../lib/pages-functions/tickers';

// Settlement resolution is providerless downstream of this dispatch: both resolvers'
// 'resolved' status carries the same { winningIndex } shape, so settleCall/settleTag
// and the win/loss comparison below don't need to know which provider produced it.
// Only outcomeOrderMismatch is Polymarket-specific (Kalshi's result field is fixed, not
// a reorderable array - see kalshi.ts's KalshiMarketResolution comment) - skipped
// entirely for Kalshi picks/tags below.
type AnyMarketResolution = MarketResolution | KalshiMarketResolution;

interface UnresolvedPick {
    id: string;
    waitlist_id: string;
    outcome_index: number;
    provider: string;
    market_id: string | null;
    snapshot_outcomes: unknown;
    implied_prob_at_lock: number;
    email: string;
    call_question: string | null;
    side: string | null;
    away: string | null;
    home: string | null;
}

interface PendingTickerTag {
    id: string;
    ticker_key: string;
    tank_id: string;
    relevant_side: number;
    provider: string;
    market_id: string | null;
    snapshot_outcomes: unknown;
    settle_win_pct: number;
    settle_loss_pct: number;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const secret = context.request.headers.get('X-Settle-Secret');
    if (!secret || secret !== context.env.SETTLE_SECRET) {
        return jsonResponse({ message: 'Unauthorized' }, { status: 401 });
    }

    const sql = getSql(context.env);

    // One resolution fetch per distinct (provider, market) per run - a Tank with both
    // picks and pending ticker tags resolves once and both loops consume the same
    // result. Within a single run (seconds) a market can't meaningfully flip, so
    // caching skip statuses is safe; thrown fetch errors are deliberately NOT cached,
    // so one network blip can't mark a market unresolvable for every later item in the
    // run. Cache key includes provider - a Polymarket market id and a Kalshi ticker are
    // never the same string shape (Kalshi tickers always start with "KX"), but this is
    // cheap insurance against any future collision.
    const resolutionCache = new Map<string, AnyMarketResolution>();
    async function resolveOnce(provider: string, marketId: string): Promise<AnyMarketResolution> {
        const cacheKey = `${provider}:${marketId}`;
        const cached = resolutionCache.get(cacheKey);
        if (cached) return cached;
        const resolution = provider === 'kalshi'
            ? resolveKalshiMarket(await fetchKalshiMarket(marketId))
            : resolveMarket(await fetchMarket(marketId));
        resolutionCache.set(cacheKey, resolution);
        return resolution;
    }

    // Belt-and-suspenders on `t.provider IN ('polymarket','kalshi')`: functions/api/picks.ts
    // already refuses to create picks on Tanks from other providers, but this keeps
    // settlement correct even if that invariant is ever bypassed by a future code path.
    // email + call_question are only for the settlement notification below, not
    // resolution itself.
    const rows = await sql`
        SELECT p.id, p.waitlist_id, p.outcome_index, p.implied_prob_at_lock::float8 AS implied_prob_at_lock,
               p.side, t.provider,
               t.game_snapshot->'prop'->>'id' AS market_id,
               t.game_snapshot->'prop'->'odds'->'outcomes' AS snapshot_outcomes,
               t.game_snapshot->'game'->>'away' AS away,
               t.game_snapshot->'game'->>'home' AS home,
               w.email, t.model_output->'call'->>'question' AS call_question
        FROM picks p
        JOIN tank_pages t ON t.id = p.tank_page_id
        JOIN waitlist w ON w.id = p.waitlist_id
        WHERE p.result IS NULL AND t.provider IN ('polymarket', 'kalshi')
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
            const resolution = await resolveOnce(pick.provider, pick.market_id);
            if (resolution.status !== 'resolved') {
                results.push({ pickId: pick.id, status: resolution.status });
                continue;
            }
            // outcome_index was stamped against the frozen snapshot's outcome order;
            // winningIndex comes from the live array. If the names no longer line up
            // positionally, skip (non-terminal) rather than possibly settle inverted.
            // Not applicable to Kalshi: its winningIndex is a fixed 0=Yes/1=No
            // convention, never a live reorderable array (see kalshi.ts's comment) -
            // the KalshiMarketResolution 'resolved' variant has no `outcomes` field at
            // all, hence the `in` check rather than a provider string check alone.
            if ('outcomes' in resolution && outcomeOrderMismatch(resolution.outcomes, pick.snapshot_outcomes)) {
                results.push({ pickId: pick.id, status: 'outcome_order_mismatch' });
                continue;
            }
            const result: CallResult = pick.outcome_index === resolution.winningIndex ? 'correct' : 'incorrect';
            const { payoutAmount } = await settleCall(sql, {
                pickId: pick.id,
                userId: pick.waitlist_id,
                result,
                impliedProbAtLock: pick.implied_prob_at_lock,
                // Notification copy context: the exact side they picked, and the Tank's
                // matchup ("Away vs Home"), falling back to the call question.
                pickLabel: pick.side ?? undefined,
                matchup: pick.away && pick.home ? `${pick.away} vs ${pick.home}` : pick.call_question ?? undefined,
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

    // Ticker tags settle independently of picks: a tagged Tank with zero picks still
    // resolves here. No visibility filter - a newsletter_only Tank's tags still settle;
    // its events are excluded at read time (functions/api/tickers*.ts), not at write
    // time. No email/logEvent either: nothing user-facing fires for a ticker move.
    const tagRows = await sql`
        SELECT tt.id, tt.ticker_key, tt.tank_id, tt.relevant_side, t.provider,
               t.game_snapshot->'prop'->>'id' AS market_id,
               t.game_snapshot->'prop'->'odds'->'outcomes' AS snapshot_outcomes,
               tk.settle_win_pct::float8 AS settle_win_pct,
               tk.settle_loss_pct::float8 AS settle_loss_pct
        FROM ticker_tags tt
        JOIN tank_pages t ON t.id = tt.tank_id
        JOIN tickers tk ON tk.key = tt.ticker_key
        WHERE tt.calculated_at IS NULL AND t.provider IN ('polymarket', 'kalshi')
    `;
    const pendingTags = tagRows as unknown as PendingTickerTag[];

    const tickerResults: Array<{ tagId: string; tickerKey: string; status: string; delta?: number }> = [];

    for (const tag of pendingTags) {
        if (!tag.market_id) {
            tickerResults.push({ tagId: tag.id, tickerKey: tag.ticker_key, status: 'missing_market_id' });
            continue;
        }
        try {
            const resolution = await resolveOnce(tag.provider, tag.market_id);
            if (resolution.status !== 'resolved') {
                tickerResults.push({ tagId: tag.id, tickerKey: tag.ticker_key, status: resolution.status });
                continue;
            }
            if ('outcomes' in resolution && outcomeOrderMismatch(resolution.outcomes, tag.snapshot_outcomes)) {
                tickerResults.push({ tagId: tag.id, tickerKey: tag.ticker_key, status: 'outcome_order_mismatch' });
                continue;
            }
            const won = tag.relevant_side === resolution.winningIndex;
            const inserted = await settleTag(sql, {
                tagId: tag.id,
                tickerKey: tag.ticker_key,
                tankId: tag.tank_id,
                won,
                winPct: tag.settle_win_pct,
                lossPct: tag.settle_loss_pct,
                metadata: {
                    winningIndex: resolution.winningIndex,
                    relevantSide: tag.relevant_side,
                    marketId: tag.market_id,
                },
            });
            tickerResults.push({
                tagId: tag.id,
                tickerKey: tag.ticker_key,
                status: inserted ? (won ? 'settled_win' : 'settled_loss') : 'already_settled',
                delta: won ? tag.settle_win_pct : -tag.settle_loss_pct,
            });
        } catch (err) {
            console.error(`[POST /api/settle] Failed to settle ticker tag ${tag.id}:`, err);
            tickerResults.push({ tagId: tag.id, tickerKey: tag.ticker_key, status: 'error' });
        }
    }

    return jsonResponse({ checked: unresolved.length, results, tickerTagsChecked: pendingTags.length, tickerResults });
};
