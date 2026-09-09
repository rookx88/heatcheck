// POST /api/tank-resolution-sweep - protected, machine-to-machine only (X-Settle-Secret,
// same trust domain as /api/settle). Fired by worker-settle right after each settle call.
//
// STAGE 3 of the Tank pipeline: the resolution callback. Finds published v2 Tanks whose
// market has now resolved, and writes a short "here's what was claimed, here's what
// happened" line into tank_pages.resolution. The static build picks it up and renders it
// at the foot of the article (scripts/templates/tank-article-template.ts).
//
// WHY IT IS A SIBLING REQUEST RATHER THAN CODE INSIDE settle.ts
// Same reason /api/ticker-sweep and /api/index-settle are separate: each Pages Function
// invocation has its own subrequest budget, and settle.ts's Gamma + Neon traffic already
// spends a good part of one. This also keeps an Anthropic dependency out of settlement
// itself - a failure here must never be able to stop a pick from settling or a payout
// from landing.
//
// THE SAFETY PROPERTY THAT MATTERS MOST
// This is the only stage that writes about something that already happened, so a wrong
// answer is permanent, public, and checkable by anyone who watched the game. The winning
// side never comes from model prose: it is read from Polymarket/Kalshi resolution and
// cross-checked with outcomeOrderMismatch() against the frozen snapshot's outcome order,
// exactly as settle.ts:144 does. Polymarket can reorder a market's outcomes between the
// snapshot and now, and without that check this endpoint would confidently name THE
// LOSING SIDE AS THE WINNER, in prose, in a static page. On a mismatch we generate
// nothing and try again next run.
//
// WHY IT IS BOUNDED SO HARD
// tank_pages grows forever and markets can be voided or delisted, so resolveMarket()
// returns 'not_closed_yet' for some rows indefinitely. Without bounds this sweep would
// re-check dead markets every day for the life of the table, and the first run would try
// to process the entire back catalogue at once and die partway through - after spending
// Anthropic credits. Hence: a per-run cap, a lookback floor, an attempt counter, an age
// cutoff, and fewest-attempts-first ordering so a permanently-stuck row can never hold
// the front of the queue (the head-of-line failure documented for /api/index-settle in
// worker-curate/src/index.ts).

import type { PagesFunction } from '@cloudflare/workers-types';
import Anthropic from '@anthropic-ai/sdk';
import { getSql, jsonResponse, type Env } from '../../lib/pages-functions/db';
import { fetchMarket, outcomeOrderMismatch, resolveMarket } from '../../lib/pages-functions/gamma';
import {
    fetchMarket as fetchKalshiMarket,
    resolveMarket as resolveKalshiMarket,
} from '../../lib/pages-functions/kalshi';
import { extractJson, parseModelJson } from '../../tank-generate';
import {
    TANK_RESOLUTION_PROMPT,
    TANK_RESOLUTION_PROMPT_VERSION,
    TANK_RESOLUTION_SCHEMA,
} from '../../scripts/prompts/tank-resolution-prompt';
import { effectiveSettleDate } from '../../tank-deck-format';

// Local rather than imported from curate.ts: this endpoint has nothing else to do with
// curation, and importing one three-line helper from there would pull that module's
// entire graph - the Anthropic matching prompt, the verify prompt, Gamma's live fetch,
// the filter - into this bundle for no reason.
function numEnv(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

// Ten per run keeps the worst case at roughly 1 + 10 Gamma + 10 Anthropic + 1 batched
// write = ~22 subrequests, comfortably inside the 50 ceiling with room for retries.
export const DEFAULT_MAX_PER_RUN = 10;
// Only look back this far for unresolved Tanks. Bounds the first run against the whole
// back catalogue, and stops the scan growing without limit as the table does. Same
// posture as CURATE_TAG_SWEEP_DAYS.
export const DEFAULT_LOOKBACK_DAYS = 45;
// Give up after this many checks. A market that hasn't resolved in ten passes is voided,
// delisted, or otherwise never going to.
export const MAX_ATTEMPTS = 10;
// ...or once it's this far past the editorially meaningful settle date, whichever first.
const ABANDON_AFTER_SETTLE_MS = 14 * 24 * 60 * 60 * 1000;

interface PendingTank {
    id: string;
    slug: string;
    provider: string;
    angle: string;
    market_id: string | null;
    snapshot_outcomes: unknown;
    prop_settle_date: string | null;
    game_settle_date: string | null;
    kickoff: string | null;
    sides: unknown;
    call_question: string | null;
    trend_claim: string | null;
    resolution_attempts: number;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const secret = context.request.headers.get('X-Settle-Secret');
    if (!secret || secret !== context.env.SETTLE_SECRET) {
        return jsonResponse({ message: 'Unauthorized' }, { status: 401 });
    }

    const env = context.env;
    const sql = getSql(env);
    const maxPerRun = numEnv(env.TANK_RESOLUTION_MAX_PER_RUN, DEFAULT_MAX_PER_RUN);
    const lookbackDays = numEnv(env.TANK_RESOLUTION_LOOKBACK_DAYS, DEFAULT_LOOKBACK_DAYS);

    // Fails CLOSED when the migration hasn't been run, unlike the curate path which
    // degrades and carries on. Nothing here is worth doing without somewhere to write the
    // answer, and returning early costs zero Anthropic credits and zero Gamma calls.
    let pending: PendingTank[];
    try {
        pending = (await sql`
            SELECT t.id, t.slug, t.provider, t.angle,
                   t.game_snapshot->'prop'->>'id'              AS market_id,
                   t.game_snapshot->'prop'->'odds'->'outcomes' AS snapshot_outcomes,
                   t.game_snapshot->'prop'->>'settleDate'      AS prop_settle_date,
                   t.game_snapshot->'game'->>'settleDate'      AS game_settle_date,
                   t.game_snapshot->'game'->>'kickoff'         AS kickoff,
                   t.model_output->'call'->'sides'             AS sides,
                   t.model_output->'call'->>'question'         AS call_question,
                   t.curation->>'trend_claim'                  AS trend_claim,
                   t.resolution_attempts
            FROM tank_pages t
            WHERE t.status = 'published'
              AND t.visibility = 'app'
              AND t.slug IS NOT NULL
              AND t.model_output IS NOT NULL
              AND t.resolution IS NULL
              AND t.curation IS NOT NULL
              AND t.resolution_attempts < ${MAX_ATTEMPTS}
              AND t.provider IN ('polymarket', 'kalshi')
              AND t.published_at > NOW() - (INTERVAL '1 day' * ${lookbackDays})
            ORDER BY t.resolution_attempts ASC, t.published_at DESC
            LIMIT ${maxPerRun}
        `) as unknown as PendingTank[];
    } catch (err: any) {
        if (/column .*(resolution|curation)/i.test(err?.message ?? '')) {
            console.warn(
                '[tank-resolution] tank_pages.curation/resolution missing - skipping. '
                + 'Run: psql "$DATABASE_URL" -f add_curation_and_resolution_to_tank_pages.sql',
            );
            return jsonResponse({ skipped: 'migration_pending', considered: 0, written: 0, results: [] });
        }
        throw err;
    }

    if (pending.length === 0) {
        return jsonResponse({ considered: 0, written: 0, results: [] });
    }

    // maxRetries: 1 for the same subrequest-budget reason as curate.ts.
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1 });
    const now = Date.now();

    const results: Array<{ slug: string; status: string; detail?: string }> = [];
    const writes: Array<{ id: string; resolution: string | null }> = [];
    // Two Tanks can share a market (the canonical-cluster case), so cache per run exactly
    // as settle.ts's resolveOnce does.
    const resolutionCache = new Map<string, any>();

    for (const tank of pending) {
        if (!tank.market_id) {
            results.push({ slug: tank.slug, status: 'missing_market_id' });
            writes.push({ id: tank.id, resolution: JSON.stringify(terminal('missing_market_id')) });
            continue;
        }

        try {
            const cacheKey = `${tank.provider}:${tank.market_id}`;
            let resolution = resolutionCache.get(cacheKey);
            if (!resolution) {
                resolution = tank.provider === 'kalshi'
                    ? resolveKalshiMarket(await fetchKalshiMarket(tank.market_id))
                    : resolveMarket(await fetchMarket(tank.market_id));
                resolutionCache.set(cacheKey, resolution);
            }

            if (resolution.status !== 'resolved') {
                // Non-terminal, exactly as in settle.ts - unless this one has run out of
                // road, in which case retire it so it leaves the scan for good.
                const settleDate = effectiveSettleDate(
                    { settleDate: tank.prop_settle_date ?? undefined },
                    { settleDate: tank.game_settle_date ?? undefined, kickoff: tank.kickoff ?? undefined },
                );
                const settleMs = settleDate ? new Date(settleDate).getTime() : NaN;
                const tooOld = !Number.isNaN(settleMs) && now - settleMs > ABANDON_AFTER_SETTLE_MS;
                const outOfAttempts = tank.resolution_attempts + 1 >= MAX_ATTEMPTS;

                if (tooOld || outOfAttempts) {
                    writes.push({ id: tank.id, resolution: JSON.stringify(terminal(tooOld ? 'never_resolved' : 'max_attempts')) });
                    results.push({ slug: tank.slug, status: 'abandoned', detail: tooOld ? 'never_resolved' : 'max_attempts' });
                } else {
                    writes.push({ id: tank.id, resolution: null });
                    results.push({ slug: tank.slug, status: resolution.status });
                }
                continue;
            }

            // THE inversion guard - see the file header. Kalshi's winningIndex is a fixed
            // 0=Yes/1=No convention rather than a reorderable live array, so its resolved
            // variant carries no `outcomes` field at all; hence the `in` check rather than
            // a provider string comparison.
            if ('outcomes' in resolution && outcomeOrderMismatch(resolution.outcomes, tank.snapshot_outcomes)) {
                writes.push({ id: tank.id, resolution: null });
                results.push({ slug: tank.slug, status: 'outcome_order_mismatch' });
                continue;
            }

            const sides = Array.isArray(tank.sides) ? (tank.sides as string[]) : null;
            const winningSide = sides && typeof sides[resolution.winningIndex] === 'string'
                ? sides[resolution.winningIndex]
                : null;
            if (!winningSide) {
                // The positional sides<->outcomes convention (tank-deck-format.ts) didn't
                // hold for this row. Non-terminal: better no callback than one naming a
                // side we can't actually identify.
                writes.push({ id: tank.id, resolution: null });
                results.push({ slug: tank.slug, status: 'unnameable_winning_side' });
                continue;
            }

            const blurb = await generateCallback(client, env, {
                trend_claim: tank.trend_claim,
                angle: tank.angle,
                question: tank.call_question,
                winning_side: winningSide,
            });

            if (!blurb) {
                writes.push({ id: tank.id, resolution: null });
                results.push({ slug: tank.slug, status: 'generation_failed' });
                continue;
            }

            writes.push({
                id: tank.id,
                resolution: JSON.stringify({
                    status: 'resolved',
                    blurb,
                    winning_index: resolution.winningIndex,
                    winning_side: winningSide,
                    resolved_at: new Date(now).toISOString(),
                    prompt_version: TANK_RESOLUTION_PROMPT_VERSION,
                }),
            });
            results.push({ slug: tank.slug, status: 'written' });
        } catch (err: any) {
            console.error(`[tank-resolution] ${tank.slug} failed:`, err);
            writes.push({ id: tank.id, resolution: null });
            results.push({ slug: tank.slug, status: 'error', detail: err.message });
        }
    }

    // One batched write. `resolution: null` rows still bump the attempt counter and stamp
    // resolution_checked_at - that counter is what eventually retires a dead market, so
    // an unresolved pass must still record that it happened.
    if (writes.length > 0) {
        await sql.transaction(writes.map((w) => sql`
            UPDATE tank_pages
            SET resolution = COALESCE(${w.resolution}::jsonb, resolution),
                resolution_attempts = resolution_attempts + 1,
                resolution_checked_at = NOW()
            WHERE id = ${w.id} AND resolution IS NULL
        `));
    }

    const written = results.filter((r) => r.status === 'written').length;
    return jsonResponse({ considered: pending.length, written, results });
};

function terminal(reason: string) {
    return { status: 'abandoned', reason, resolved_at: new Date().toISOString() };
}

// Structured outputs (no tools on this call), so a schema-valid response is guaranteed
// and the extractJson/repair path isn't the failure mode it is for the narrative call.
async function generateCallback(
    client: Anthropic,
    env: Env,
    payload: { trend_claim: string | null; angle: string; question: string | null; winning_side: string },
): Promise<string | null> {
    try {
        const response = await client.messages.create({
            model: env.MODEL || 'claude-sonnet-5',
            max_tokens: numEnv(env.MAX_TOKENS, 400),
            thinking: { type: 'disabled' },
            system: [{ type: 'text', text: TANK_RESOLUTION_PROMPT, cache_control: { type: 'ephemeral' } }],
            output_config: { format: TANK_RESOLUTION_SCHEMA },
            messages: [{ role: 'user', content: JSON.stringify(payload) }],
        } as any);

        const textBlock = response.content.find((b: any) => b.type === 'text');
        const rawText = textBlock && 'text' in textBlock ? (textBlock as any).text : '';
        const parsed = parseModelJson(extractJson(rawText));
        const blurb = parsed?.blurb;
        return typeof blurb === 'string' && blurb.trim() ? blurb.trim() : null;
    } catch (err: any) {
        console.error('[tank-resolution] callback generation failed:', err.message);
        return null;
    }
}
