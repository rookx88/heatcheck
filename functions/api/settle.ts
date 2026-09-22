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
import { buildManagePrefsUrl, buildUnsubscribeUrl } from '../../lib/pages-functions/unsubscribe-links';
import { resolveLoginOrigin } from '../../lib/pages-functions/session';
import {
    fetchClosedMarkets,
    fetchMarketStrict,
    outcomeOrderMismatch,
    resolveMarket,
    type MarketResolution,
} from '../../lib/pages-functions/gamma';
import {
    fetchMarketStrict as fetchKalshiMarket,
    resolveMarket as resolveKalshiMarket,
    type KalshiMarketResolution,
} from '../../lib/pages-functions/kalshi';
import { computeSettleDelta, getTickerConfig, settleTag } from '../../lib/pages-functions/tickers';
import { secretMatches } from '../../lib/pages-functions/secret-compare';

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
    // The account page's "Settlement results" email switch (add_account_prefs_to_
    // waitlist.sql). A soft-deleted account has it false, so its still-pending picks
    // settle (Ember lands on the anonymized row) without emailing a scrubbed address.
    email_settlement_results: boolean;
    call_question: string | null;
    side: string | null;
    away: string | null;
    home: string | null;
}

// Per-pick outcome of the settlement email, on the result entry: the acceptance
// harness runs with Resend blanked, so 'skipped' vs 'failed' is how it can tell the
// preference gate fired from the email merely not sending.
type EmailOutcome = 'sent' | 'failed' | 'skipped';

interface PendingTickerTag {
    id: string;
    ticker_key: string;
    tank_id: string;
    relevant_side: number;
    provider: string;
    market_id: string | null;
    snapshot_outcomes: unknown;
    side_prob: string | null; // frozen snapshot outcomePrices[relevant_side], as text
    settle_win_pct: number;   // fallback magnitudes for tags with no usable side_prob
    settle_loss_pct: number;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const secret = context.request.headers.get('X-Settle-Secret');
    if (!(await secretMatches(secret, context.env.SETTLE_SECRET))) {
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
        // Strict on purpose: an unreachable provider must surface as a thrown error the
        // per-pick catch reports as 'error' (which ops-classify counts), not as a
        // not_closed_yet that looks like a perfectly ordinary "the game isn't over".
        const resolution = provider === 'kalshi'
            ? resolveKalshiMarket(await fetchKalshiMarket(marketId))
            : resolveMarket(await fetchMarketStrict(marketId));
        resolutionCache.set(cacheKey, resolution);
        return resolution;
    }

    // Fill that cache for the Polymarket side in ONE request rather than one per market
    // (gamma.ts's fetchClosedMarkets - read its notes, the list endpoint has two traps).
    // Only ids Gamma actually returned are seeded: an absence from a closed-only batch
    // means "not closed, or not a market", and resolveOnce's own call is the honest way
    // to tell those apart. Kalshi has no id-list form, so its tickers are untouched.
    // A throw is a batch failure, never a verdict - it is logged and the per-market path
    // below runs exactly as it did before (efficiency audit, 2026-09-20).
    async function prewarmPolymarket(items: Array<{ provider: string; market_id: string | null }>): Promise<void> {
        const ids = items
            .filter((i) => i.provider === 'polymarket' && i.market_id)
            .map((i) => i.market_id as string)
            .filter((id) => !resolutionCache.has(`polymarket:${id}`));
        if (new Set(ids).size < 2) return; // one market is one call either way
        try {
            const closed = await fetchClosedMarkets(ids);
            for (const [marketId, market] of closed) {
                resolutionCache.set(`polymarket:${marketId}`, resolveMarket(market));
            }
        } catch (err) {
            console.error('[settle] batched market fetch failed, falling back to one call per market:', err);
        }
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
               w.email, w.email_settlement_results, t.model_output->'call'->>'question' AS call_question
        FROM picks p
        JOIN tank_pages t ON t.id = p.tank_page_id
        JOIN waitlist w ON w.id = p.waitlist_id
        WHERE p.result IS NULL AND t.provider IN ('polymarket', 'kalshi')
    `;
    const unresolved = rows as unknown as UnresolvedPick[];

    const results: Array<{ pickId: string; status: string; payoutAmount?: number; email?: EmailOutcome }> = [];
    // pick_settled analytics, flushed in one insert after the loop (see below).
    const settledEvents: Array<{ visitorId: string; waitlistId: string; pickId: string; result: CallResult; payoutAmount: number }> = [];

    // Footer links for every settlement email this run sends: the request origin is the
    // Pages deployment the cron hit (preview or prod), hardened the same way the login
    // link is, so an unsubscribe link always points back at the site that sent it.
    const emailOrigin = resolveLoginOrigin(context.request.url, context.env);
    const manageUrl = buildManagePrefsUrl(emailOrigin);

    // Sequential, not Promise.all: current pick volume is small (up to DAILY_PICK_CAP
    // picks per account per day - functions/api/picks.ts), and Polymarket's Gamma API
    // has rate limits (see polymarket.ts's existing throttle/backoff handling for the
    // bulk sync path).
    await prewarmPolymarket(unresolved);
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
            const settleResult = await settleCall(sql, {
                pickId: pick.id,
                userId: pick.waitlist_id,
                result,
                impliedProbAtLock: pick.implied_prob_at_lock,
                // Notification copy context: the exact side they picked, and the Tank's
                // matchup ("Away vs Home"), falling back to the call question.
                pickLabel: pick.side ?? undefined,
                matchup: pick.away && pick.home ? `${pick.away} vs ${pick.home}` : pick.call_question ?? undefined,
            });
            const { payoutAmount } = settleResult;
            const entry: { pickId: string; status: string; payoutAmount?: number; email?: EmailOutcome } =
                { pickId: pick.id, status: `settled_${result}`, payoutAmount };
            results.push(entry);

            // Both fire-and-forget - settlement itself already committed above, so
            // neither a Resend failure nor an analytics-insert failure should surface
            // as this pick having failed to settle. Same pattern as the verification
            // email in functions/api/picks.ts. The preference gate comes first: an
            // account that switched settlement emails off never reaches Resend at all.
            if (!pick.email_settlement_results) {
                entry.email = 'skipped';
            } else {
                try {
                    // settleCall returns the balance its own write produced; only a
                    // replayed payout (idempotency no-op) leaves it null and needs a read.
                    let newBalance = settleResult.newBalance;
                    if (newBalance === null) {
                        const balanceRows = await sql`SELECT balance FROM ember_balances WHERE user_id = ${pick.waitlist_id} LIMIT 1`;
                        newBalance = balanceRows.length ? (balanceRows[0].balance as number) : payoutAmount;
                    }
                    const unsubscribeUrl = await buildUnsubscribeUrl(emailOrigin, context.env.SESSION_TOKEN_SECRET, pick.waitlist_id, 'settlement');
                    await sendSettlementEmail(context.env, pick.email, {
                        tankQuestion: pick.call_question || 'Your Tank call',
                        result,
                        payoutAmount,
                        newBalance,
                        manageUrl,
                        unsubscribeUrl,
                    });
                    entry.email = 'sent';
                } catch (emailErr) {
                    entry.email = 'failed';
                    console.error(`[POST /api/settle] Settlement email failed for pick ${pick.id}:`, emailErr);
                }
            }
            // Analytics rows are collected and written once after the loop rather than
            // one INSERT per settled pick (efficiency audit, 2026-09-19). No real
            // "visitor" for a cron-triggered settlement - a fresh random id per event
            // (rather than a fixed shared constant) avoids falsely clustering unrelated
            // settlement events under one synthetic visitor.
            settledEvents.push({ visitorId: crypto.randomUUID(), waitlistId: pick.waitlist_id, pickId: pick.id, result, payoutAmount });
        } catch (err) {
            console.error(`[POST /api/settle] Failed to settle pick ${pick.id}:`, err);
            results.push({ pickId: pick.id, status: 'error' });
        }
    }

    // One insert for the whole run's analytics. Still fire-and-forget: settlement has
    // already committed for every pick above, so a failed analytics write must never
    // make a settled pick look unsettled.
    if (settledEvents.length > 0) {
        try {
            await sql`
                INSERT INTO events (visitor_id, waitlist_id, event_type, metadata)
                SELECT * FROM unnest(
                    ${settledEvents.map((e) => e.visitorId)}::uuid[],
                    ${settledEvents.map((e) => e.waitlistId)}::uuid[],
                    ${settledEvents.map(() => 'pick_settled')}::varchar[],
                    ${settledEvents.map((e) => JSON.stringify({ pickId: e.pickId, result: e.result, payoutAmount: e.payoutAmount }))}::jsonb[]
                )
            `;
        } catch (eventErr) {
            console.error(`[POST /api/settle] Failed to log ${settledEvents.length} pick_settled event(s):`, eventErr);
        }
    }

    // TANK SETTLE EVENTS ARE RETIRED (slate indexes, phase 2). An index now has two
    // legs: a published Tank's 3-day price move is the NEWS leg (still written at tag
    // time, the way news repricing moves a stock), and the totality of a category's game
    // results is the RESULTS leg, scored by /api/index-settle from index_positions. Every
    // game's result must be counted exactly once, and the slate is what counts it - so
    // settling a Tank's tag here too would double-count the games we happen to cover,
    // and at a much larger magnitude than a daily close.
    //
    // Tags are left with calculated_at NULL on purpose: that column is the settle
    // idempotency marker, and stamping it without an event would fake a settlement that
    // never happened. Nothing scans them any more - the public Recent Results
    // (getTickerResults, lib/pages-functions/tickers.ts) read settled index_positions,
    // not settle events.
    //
    // The block below is kept, unreached, behind SETTLE_TANK_TAGS purely so the previous
    // behaviour is one flag away while the slate legs bed in. Delete it once a full
    // season of closes has run.
    const SETTLE_TANK_TAGS = false;
    const tagRows = SETTLE_TANK_TAGS ? await sql`
        SELECT tt.id, tt.ticker_key, tt.tank_id, tt.relevant_side, t.provider,
               t.game_snapshot->'prop'->>'id' AS market_id,
               t.game_snapshot->'prop'->'odds'->'outcomes' AS snapshot_outcomes,
               t.game_snapshot->'prop'->'odds'->'outcomePrices'->>tt.relevant_side AS side_prob,
               tk.settle_win_pct::float8 AS settle_win_pct,
               tk.settle_loss_pct::float8 AS settle_loss_pct
        FROM ticker_tags tt
        JOIN tank_pages t ON t.id = tt.tank_id
        JOIN tickers tk ON tk.key = tt.ticker_key
        WHERE tt.calculated_at IS NULL AND t.provider IN ('polymarket', 'kalshi')
    ` : [];
    const pendingTags = tagRows as unknown as PendingTickerTag[];

    const tickerResults: Array<{ tagId: string; tickerKey: string; status: string; delta?: number }> = [];

    // settle_scale_pct drives the odds-aware settle deltas below; fail-loud (a config
    // error 500s the run and settles nothing) is preferable to silently settling every
    // pending tag with wrong numbers into an append-only log. Skipped when there are no
    // pending tags so the pick-only path can't be blocked by a ticker config problem.
    const tickerCfg = pendingTags.length > 0 ? await getTickerConfig(sql) : null;

    // Tags on markets the pick loop already resolved are skipped inside prewarm, so this
    // only ever asks about markets no pick covered.
    await prewarmPolymarket(pendingTags);
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
            const sideProb = tag.side_prob !== null && tag.side_prob !== '' ? Number(tag.side_prob) : null;
            const { delta, oddsAware } = computeSettleDelta(
                won, sideProb, tickerCfg!.settle_scale_pct, tag.settle_win_pct, tag.settle_loss_pct);
            const inserted = await settleTag(sql, {
                tagId: tag.id,
                tickerKey: tag.ticker_key,
                tankId: tag.tank_id,
                delta,
                metadata: {
                    winningIndex: resolution.winningIndex,
                    relevantSide: tag.relevant_side,
                    marketId: tag.market_id,
                    sideProb,
                    scalePct: tickerCfg!.settle_scale_pct,
                    oddsAware,
                },
            });
            tickerResults.push({
                tagId: tag.id,
                tickerKey: tag.ticker_key,
                status: inserted ? (won ? 'settled_win' : 'settled_loss') : 'already_settled',
                delta,
            });
        } catch (err) {
            console.error(`[POST /api/settle] Failed to settle ticker tag ${tag.id}:`, err);
            tickerResults.push({ tagId: tag.id, tickerKey: tag.ticker_key, status: 'error' });
        }
    }

    return jsonResponse({ checked: unresolved.length, results, tickerTagsChecked: pendingTags.length, tickerResults });
};
