// GET /api/tankdaq/overlay?key=dogs&since=<ISO> - the signed-in user's own settled picks
// that fit ONE index's style, scored the way that index scores a game, over the window
// the detail page is showing. Serves the "Your picks in this style" line under the
// index's read line on /tankdaq/<key>/. Session required; identity comes from the
// validated cookie only. 401/403 double as the page's auth probe, exactly like
// /api/tankdaq/holdings (the client hides the line on either).
//
// Which picks count: every settled pick in the window is re-run through
// checkEligibility(rule_type) against the Tank's frozen snapshot and the pick's own
// outcome_index - the identical test a curator's tag or the sweep would apply to that
// side - via the shared snapshotEligibilityContext. Not the ticker_tags join: that only
// knows about tanks a curator tagged, and most of a user's picks are on untagged ones.
//
// How they score: contributionFor(won, p) with p = the implied probability frozen on
// the pick at lock (falling back to the snapshot's own price for the side), then
// closeDelta over the matched set with the live close config - the user's picks scored
// as if they were one slate, so `points` is in the index's own units and sits next to
// its window move honestly. That smoothing damps thin samples on purpose (same reason
// as the index's own closes); the W-L record carries the headline. `points` is null
// when the v3 close keys are absent from config, same posture as index-settle.
//
// Retrospective only: nothing here scores pending picks, and the response says what the
// user's picks HAVE done next to what the index has done. It is not a rating.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../../lib/pages-functions/db';
import { getSession, requireOnboarded } from '../../../lib/pages-functions/session';
import {
    RETROSPECTIVE_NOTE,
    checkEligibility,
    getTicker,
    getTickerConfig,
    snapshotEligibilityContext,
} from '../../../lib/pages-functions/tickers';
import { closeDelta, contributionFor } from '../../../lib/pages-functions/index-slate';

// The widest window the detail chart offers is a week; a month is generous headroom
// without letting a caller ask for a user's whole history on a hot path.
const MAX_WINDOW_MS = 31 * 24 * 3600_000;
const PICKS_LIMIT = 300;

interface PickRow {
    outcome_index: number;
    implied_prob: number | null;
    result: 'correct' | 'incorrect';
    league: string | null;
    market: string | null;
    outcome_prices: unknown;
    outcome_labels: unknown;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const session = await getSession(context.request, context.env);
    if (!session) return jsonResponse({ message: 'Login required.' }, { status: 401 });
    const gate = requireOnboarded(session);
    if (gate) return gate;
    const authHeaders = session.refreshedSetCookie ? { 'Set-Cookie': session.refreshedSetCookie } : undefined;

    const url = new URL(context.request.url);
    const key = url.searchParams.get('key') ?? '';
    if (!key) {
        return jsonResponse({ message: 'Provide a ticker key (?key=dogs).' }, { status: 400, headers: authHeaders });
    }
    const sinceRaw = url.searchParams.get('since') ?? '';
    const sinceMs = Date.parse(sinceRaw);
    if (!sinceRaw || !Number.isFinite(sinceMs) || sinceMs < Date.now() - MAX_WINDOW_MS) {
        return jsonResponse({ message: 'Provide since=<ISO timestamp> within the last 31 days.' }, { status: 400, headers: authHeaders });
    }
    const since = new Date(sinceMs);

    const sql = getSql(context.env);

    try {
        const ticker = await getTicker(sql, key);
        if (!ticker) return jsonResponse({ message: `No active ticker "${key}".` }, { status: 404, headers: authHeaders });

        const [cfg, rows] = await Promise.all([
            getTickerConfig(sql),
            sql`
                SELECT p.outcome_index,
                       p.implied_prob_at_lock::float8 AS implied_prob,
                       p.result,
                       t.league,
                       t.game_snapshot->'prop'->>'market' AS market,
                       t.game_snapshot->'prop'->'odds'->'outcomePrices' AS outcome_prices,
                       t.game_snapshot->'prop'->'odds'->'outcomes' AS outcome_labels
                FROM picks p
                JOIN tank_pages t ON t.id = p.tank_page_id
                WHERE p.waitlist_id = ${session.userId}
                  AND p.result IN ('correct', 'incorrect')
                  AND p.settled_at >= ${since.toISOString()}
                  AND p.outcome_index IS NOT NULL
                ORDER BY p.settled_at DESC
                LIMIT ${PICKS_LIMIT}
            `,
        ]);

        const contribs: number[] = [];
        let won = 0;
        let lost = 0;
        for (const raw of rows as unknown as PickRow[]) {
            const ctx = snapshotEligibilityContext(raw, raw.outcome_index);
            if (!ctx) continue;
            if (!checkEligibility(ticker.rule_type, ctx, cfg).ok) continue;
            const p = typeof raw.implied_prob === 'number' && Number.isFinite(raw.implied_prob)
                ? raw.implied_prob
                : ctx.probs[ctx.side];
            const isWin = raw.result === 'correct';
            if (isWin) won++; else lost++;
            contribs.push(contributionFor(isWin, p));
        }

        const points = typeof cfg.close_smoothing === 'number' && typeof cfg.close_scale_pct === 'number'
            ? closeDelta(contribs, { smoothing: cfg.close_smoothing, scalePct: cfg.close_scale_pct })
            : null;

        return jsonResponse(
            {
                note: RETROSPECTIVE_NOTE,
                key: ticker.key,
                since: since.toISOString(),
                matched: contribs.length,
                won,
                lost,
                points,
            },
            { headers: authHeaders },
        );
    } catch (err) {
        console.error('[GET /api/tankdaq/overlay] Error:', err);
        return jsonResponse({ message: 'Internal server error' }, { status: 500, headers: authHeaders });
    }
};
