// Heatchecks Exchange editorial tickers - domain logic shared by the tag-creation
// endpoint (functions/api/ticker-tags.ts), the settlement tag loop
// (functions/api/settle.ts), and the public read endpoints (functions/api/tickers*).
//
// Two write paths only, both mechanical, neither anyone's opinion:
//   tag    - insertTagWithEvent(): the tagged side's real 3-day implied-probability
//            movement (CLOB price history), clamped to +/- the configured cap.
//   settle - settleTag(): +settle_win_pct / -settle_loss_pct from the tickers row,
//            uncapped, guarded by ticker_tags.calculated_at.
// No Ember writes live here (that's ledger.ts) - tickers are a display layer; nothing
// in this module credits, debits, or unlocks anything.

import type { NeonQueryFunction } from '@neondatabase/serverless';
import { fetchMarket, safeJsonParse } from './gamma';
import { getGameConfig } from './pets';

// Spec'd framing constraint: ticker values/charts are never presented as predictive.
// Every API response that carries a value or chart includes this note verbatim.
export const RETROSPECTIVE_NOTE =
    'Ticker values reflect how tagged storylines have gone - not a forecast.';

// dogs/chalk pivot on 0.5 by definition (below = underdog, at-or-above = favorite) -
// definitional, not a tunable, unlike the locks/moonshot thresholds in game_config.
const DOGS_CHALK_PIVOT = 0.5;

const CLOB_BASE_URL = 'https://clob.polymarket.com';
const TAG_WINDOW_SECONDS = 3 * 24 * 3600; // the "3-day movement" window
const CLOB_FIDELITY_MINUTES = 1440;       // daily buckets -> ~4 points over the window

export interface TickerConfig {
    tag_delta_cap_pct: number;
    locks_min_prob: number;
    moonshot_max_prob: number;
}

// Fail-loud read of game_config['tickers'] (seed_ticker_config.sql is a deploy
// prerequisite) - same contract as getGameConfig itself.
export async function getTickerConfig(sql: NeonQueryFunction<false, false>): Promise<TickerConfig> {
    const config = await getGameConfig(sql, 'tickers');
    for (const key of ['tag_delta_cap_pct', 'locks_min_prob', 'moonshot_max_prob'] as const) {
        if (typeof config[key] !== 'number') {
            throw new Error(`game_config['tickers'] is missing numeric "${key}"`);
        }
    }
    return config as unknown as TickerConfig;
}

export interface TickerRow {
    key: string;
    display_name: string;
    description: string;
    rule_type: string;
    settle_win_pct: number;
    settle_loss_pct: number;
    tab_order: number;
}

export async function getTicker(sql: NeonQueryFunction<false, false>, key: string): Promise<TickerRow | null> {
    const rows = await sql`
        SELECT key, display_name, description, rule_type,
               settle_win_pct::float8 AS settle_win_pct,
               settle_loss_pct::float8 AS settle_loss_pct,
               tab_order
        FROM tickers WHERE key = ${key} AND active = true LIMIT 1`;
    return rows.length ? (rows[0] as unknown as TickerRow) : null;
}

export async function getActiveTickers(sql: NeonQueryFunction<false, false>): Promise<TickerRow[]> {
    const rows = await sql`
        SELECT key, display_name, description, rule_type,
               settle_win_pct::float8 AS settle_win_pct,
               settle_loss_pct::float8 AS settle_loss_pct,
               tab_order
        FROM tickers WHERE active = true ORDER BY tab_order, key`;
    return rows as unknown as TickerRow[];
}

export type EligibilityResult = { ok: true } | { ok: false; reason: string };

// Eligibility is checked at tag time against the FROZEN snapshot probability of the
// tagged side (the prop's own stored market data - never any user's pick), and keyed on
// the ticker's rule_type so a future ticker can reuse a strategy without code changes.
export function checkEligibility(ruleType: string, sideProb: number, cfg: TickerConfig): EligibilityResult {
    if (!Number.isFinite(sideProb)) {
        return { ok: false, reason: 'tagged side has no usable implied probability in the snapshot' };
    }
    const pct = sideProb.toFixed(3);
    switch (ruleType) {
        case 'underdog':
            return sideProb < DOGS_CHALK_PIVOT
                ? { ok: true }
                : { ok: false, reason: `requires implied prob < ${DOGS_CHALK_PIVOT} (can't tag a favorite); tagged side is ${pct}` };
        case 'favorite':
            return sideProb >= DOGS_CHALK_PIVOT
                ? { ok: true }
                : { ok: false, reason: `requires implied prob >= ${DOGS_CHALK_PIVOT} (can't tag an underdog); tagged side is ${pct}` };
        case 'heavy_favorite':
            return sideProb >= cfg.locks_min_prob
                ? { ok: true }
                : { ok: false, reason: `requires implied prob >= ${cfg.locks_min_prob}; tagged side is ${pct}` };
        case 'longshot':
            return sideProb < cfg.moonshot_max_prob
                ? { ok: true }
                : { ok: false, reason: `requires implied prob < ${cfg.moonshot_max_prob}; tagged side is ${pct}` };
        default:
            return { ok: false, reason: `unknown rule_type "${ruleType}"` };
    }
}

// Tagging failures are typed so the endpoint can distinguish data-shaped rejections
// (422 - the tag can never work as submitted) from transient upstream failures
// (502 retriable - the curator just retries). Never falls back to a fabricated delta:
// ticker_events is append-only, so a wrong 0 would be permanent and indistinguishable
// from "the market genuinely didn't move".
export class TaggingError extends Error {
    constructor(
        public code: string,
        message: string,
        public retriable: boolean,
    ) {
        super(message);
        this.name = 'TaggingError';
    }
}

export interface TagDelta {
    delta: number;        // clamped, signed percentage points - what gets written
    rawDelta: number;     // pre-clamp, kept in event metadata
    capped: boolean;
    priceNow: number;     // 0-1
    price3dAgo: number;   // 0-1
    tokenId: string;
    historyPoints: number;
    thinHistory: boolean; // exactly one history point (market younger than the window)
}

interface ClobHistoryPoint {
    t: number; // unix seconds
    p: number; // price 0-1
}

// The tag-event calculation: the tagged side's real 3-day implied-probability movement.
// Token id comes from a live Gamma lookup (tank snapshots don't store clobTokenIds),
// history from the CLOB prices-history endpoint - a single on-demand call at tag time;
// Polymarket retains the history, we never snapshot prices ourselves.
export async function fetchTagDelta(marketId: string, relevantSide: number, capPct: number): Promise<TagDelta> {
    const market = await fetchMarket(marketId);
    if (!market) {
        throw new TaggingError('gamma_unavailable', `Gamma market ${marketId} could not be fetched - retry in a moment.`, true);
    }
    const tokens = safeJsonParse<string[]>(market.clobTokenIds);
    if (!tokens || tokens.length === 0) {
        throw new TaggingError('missing_clob_token_ids', `Gamma market ${marketId} has no clobTokenIds - cannot read price history.`, false);
    }
    const liveOutcomes = safeJsonParse<string[]>(market.outcomes);
    if (liveOutcomes && liveOutcomes.length > 0 && liveOutcomes.length !== tokens.length) {
        throw new TaggingError('clob_token_length_mismatch', `Gamma market ${marketId} has ${tokens.length} clob tokens but ${liveOutcomes.length} outcomes.`, false);
    }
    if (relevantSide < 0 || relevantSide >= tokens.length) {
        throw new TaggingError('side_out_of_range', `relevantSide ${relevantSide} is out of range for market ${marketId} (${tokens.length} outcomes).`, false);
    }
    const tokenId = tokens[relevantSide];

    const endTs = Math.floor(Date.now() / 1000);
    const startTs = endTs - TAG_WINDOW_SECONDS;
    const url = `${CLOB_BASE_URL}/prices-history?market=${encodeURIComponent(tokenId)}&startTs=${startTs}&endTs=${endTs}&fidelity=${CLOB_FIDELITY_MINUTES}`;
    let history: ClobHistoryPoint[];
    try {
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!res.ok) {
            throw new TaggingError('clob_unavailable', `CLOB prices-history returned ${res.status} - retry in a moment.`, true);
        }
        const body = (await res.json()) as { history?: ClobHistoryPoint[] };
        history = Array.isArray(body.history) ? body.history : [];
    } catch (err) {
        if (err instanceof TaggingError) throw err;
        throw new TaggingError('clob_unavailable', 'CLOB prices-history call failed - retry in a moment.', true);
    }
    const points = history.filter((h) => Number.isFinite(h?.p));
    if (points.length === 0) {
        // Empty history for a market Gamma just confirmed exists most likely means a bad
        // token id or bad params - reject rather than write a fabricated 0 into the log.
        throw new TaggingError('empty_price_history', `CLOB returned no price history for token ${tokenId} - retry, or investigate the market.`, true);
    }

    const price3dAgo = points[0].p;
    const priceNow = points[points.length - 1].p;
    // A single point means the market is younger than the window: ~zero 3-day movement
    // is the true value, not a fallback.
    const thinHistory = points.length === 1;
    const rawDelta = (priceNow - price3dAgo) * 100;
    const delta = Math.max(-capPct, Math.min(capPct, rawDelta));
    return {
        delta: Number(delta.toFixed(3)),
        rawDelta: Number(rawDelta.toFixed(3)),
        capped: Math.abs(rawDelta) > capPct,
        priceNow,
        price3dAgo,
        tokenId,
        historyPoints: points.length,
        thinHistory,
    };
}

export interface InsertTagInput {
    // Caller-generated (crypto.randomUUID()): Neon's sql.transaction takes a statement
    // array with no RETURNING chaining, so the id must exist before the transaction.
    tagId: string;
    tankId: string;
    tickerKey: string;
    relevantSide: number;
    retroactive?: boolean;
    delta: number;
    metadata: Record<string, unknown>;
}

// Tag row + its single 'tag' event, atomically. A unique violation on
// (tank_id, ticker_key) propagates to the caller (mapped to 409 by the endpoint).
export async function insertTagWithEvent(sql: NeonQueryFunction<false, false>, input: InsertTagInput): Promise<void> {
    await sql.transaction([
        sql`INSERT INTO ticker_tags (id, tank_id, ticker_key, relevant_side, retroactive)
            VALUES (${input.tagId}, ${input.tankId}, ${input.tickerKey}, ${input.relevantSide}, ${input.retroactive ?? false})`,
        sql`INSERT INTO ticker_events (ticker_tag_id, ticker_key, tank_id, event_type, delta, metadata)
            VALUES (${input.tagId}, ${input.tickerKey}, ${input.tankId}, 'tag', ${input.delta}, ${JSON.stringify(input.metadata)}::jsonb)`,
    ]);
}

export interface SettleTagInput {
    tagId: string;
    tickerKey: string;
    tankId: string;
    won: boolean;
    winPct: number;  // positive magnitude from the tickers row (::float8-cast)
    lossPct: number; // positive magnitude from the tickers row (::float8-cast)
    metadata: Record<string, unknown>;
}

// -----------------------------------------------------------------------------------
// Read helpers - the ONE source of the ticker read queries, shared by the JSON
// endpoints (functions/api/tickers*.ts), the server-rendered homepage Market Movers
// section (lib/pages-functions/homepage/data.ts), and the build-time static fallback
// (scripts/generate-static-site.ts via a tiny pg adapter). Marquee, cards, and API
// can never disagree because they all run these exact statements.
//
// SqlReader is the minimal structural shape those callers share: Neon's tagged-template
// function satisfies it directly; generate-static-site.ts adapts pg to it in 5 lines.
// -----------------------------------------------------------------------------------

export type SqlReader = (strings: TemplateStringsArray, ...params: unknown[]) => Promise<Record<string, unknown>[]>;

export interface TickerValue {
    key: string;
    displayName: string;
    description: string;
    ruleType: string;
    tabOrder: number;
    value: number;      // live SUM(delta): a cumulative percentage starting at 0, NOT an indexed price
    eventCount: number;
    settleWinPct: number;
    settleLossPct: number;
}

// All active tickers with their current values. A ticker's value only counts events
// on visibility='app' Tanks - a newsletter_only Tank's events exist but never count.
export async function getTickerValues(sql: SqlReader): Promise<TickerValue[]> {
    const rows = await sql`
        SELECT tk.key, tk.display_name, tk.description, tk.rule_type, tk.tab_order,
               tk.settle_win_pct::float8 AS settle_win_pct,
               tk.settle_loss_pct::float8 AS settle_loss_pct,
               COALESCE(SUM(e.delta) FILTER (WHERE t.visibility = 'app'), 0)::float8 AS value,
               COUNT(e.id) FILTER (WHERE t.visibility = 'app')::int AS event_count
        FROM tickers tk
        LEFT JOIN ticker_events e ON e.ticker_key = tk.key
        LEFT JOIN tank_pages t ON t.id = e.tank_id
        WHERE tk.active
        GROUP BY tk.key, tk.display_name, tk.description, tk.rule_type, tk.tab_order,
                 tk.settle_win_pct, tk.settle_loss_pct
        ORDER BY tk.tab_order, tk.key
    `;
    return rows.map((r) => ({
        key: r.key as string,
        displayName: r.display_name as string,
        description: r.description as string,
        ruleType: r.rule_type as string,
        tabOrder: r.tab_order as number,
        value: r.value as number,
        eventCount: r.event_count as number,
        settleWinPct: r.settle_win_pct as number,
        settleLossPct: r.settle_loss_pct as number,
    }));
}

export interface TickerSeriesEvent {
    id: string;
    tankId: string;
    eventType: 'tag' | 'settle';
    delta: number;
    cumulative: number;
    occurredAt: string;
}

// The chart source: events ordered by time with a running cumulative sum, grouped per
// ticker. The `id` tiebreak in both the window frame and ORDER BY makes same-timestamp
// cumulatives deterministic. Same visibility='app' exclusion as getTickerValues, so a
// chart's final cumulative always equals the ticker's current value.
export async function getTickerSeries(sql: SqlReader, key?: string | null): Promise<Record<string, TickerSeriesEvent[]>> {
    const keyParam = key ?? null;
    const rows = await sql`
        SELECT e.id, e.ticker_key, e.tank_id, e.event_type,
               e.delta::float8 AS delta,
               SUM(e.delta) OVER (PARTITION BY e.ticker_key ORDER BY e.occurred_at, e.id)::float8 AS cumulative,
               e.occurred_at
        FROM ticker_events e
        JOIN tank_pages t ON t.id = e.tank_id AND t.visibility = 'app'
        WHERE ${keyParam}::text IS NULL OR e.ticker_key = ${keyParam}
        ORDER BY e.ticker_key, e.occurred_at, e.id
    `;
    const series: Record<string, TickerSeriesEvent[]> = {};
    for (const row of rows) {
        (series[row.ticker_key as string] ??= []).push({
            id: row.id as string,
            tankId: row.tank_id as string,
            eventType: row.event_type as 'tag' | 'settle',
            delta: row.delta as number,
            cumulative: row.cumulative as number,
            occurredAt: String(row.occurred_at),
        });
    }
    return series;
}

export interface TickerNewsItem {
    tickerKey: string;
    slug: string;
    league: string;
    hook: string;    // model_output.hook, '' when missing
    excerpt: string; // model_output.cards[0], '' when missing - the established excerpt unit
    taggedAt: string;
}

// Most recently tagged public Tanks per ticker - the SSR "Recent News" source. Uses the
// same public-surface predicate as the homepage tank queries (data.ts): published, app
// visibility, slug + model_output present.
export async function getTickerNews(sql: SqlReader, limitPerTicker = 3): Promise<Record<string, TickerNewsItem[]>> {
    const rows = await sql`
        SELECT ticker_key, slug, league, hook, excerpt, tagged_at FROM (
            SELECT tt.ticker_key, t.slug, t.league,
                   t.model_output->>'hook'     AS hook,
                   t.model_output->'cards'->>0 AS excerpt,
                   tt.tagged_at,
                   ROW_NUMBER() OVER (PARTITION BY tt.ticker_key ORDER BY tt.tagged_at DESC, tt.id) AS rn
            FROM ticker_tags tt
            JOIN tank_pages t ON t.id = tt.tank_id
            WHERE t.status = 'published' AND t.visibility = 'app'
              AND t.slug IS NOT NULL AND t.model_output IS NOT NULL
        ) ranked
        WHERE rn <= ${limitPerTicker}
        ORDER BY ticker_key, rn
    `;
    const news: Record<string, TickerNewsItem[]> = {};
    for (const row of rows) {
        (news[row.ticker_key as string] ??= []).push({
            tickerKey: row.ticker_key as string,
            slug: row.slug as string,
            league: row.league as string,
            hook: (row.hook as string | null) ?? '',
            excerpt: (row.excerpt as string | null) ?? '',
            taggedAt: String(row.tagged_at),
        });
    }
    return news;
}

// -----------------------------------------------------------------------------------
// Tag sweep - the automated tagging path, run by /api/curate's daily cron (and safe to
// run any time). Finds published, app-visible polymarket Tanks that have NO ticker
// tags yet and tags BOTH sides, each with every active ticker whose rule the side's
// frozen snapshot probability satisfies. Publish-gated on purpose: drafts must never
// be tagged, because the public value/chart queries filter visibility but not status.
// The age window bounds retries: a Tank whose CLOB history is gone fails today, gets
// retried on later runs, and ages out of the window instead of erroring daily forever.
// Known limitation (accepted): the tank-level NOT EXISTS means a partially-tagged Tank
// (one side landed, the other failed) isn't revisited - side failures are near-always
// market-wide, and the manual /api/ticker-tags endpoint covers stragglers.
// -----------------------------------------------------------------------------------

export interface SweepReport {
    tanksConsidered: number;
    tagsCreated: number;
    skips: number; // duplicate (tank,ticker) rows that already existed
    deferred: number; // sides left for the next run by the maxSides budget cap
    failures: Array<{ slug: string; side: number; code: string; message: string }>;
}

export async function sweepUntaggedTanks(
    sql: NeonQueryFunction<false, false>,
    opts: { maxAgeDays: number; maxSides?: number },
): Promise<SweepReport> {
    // Each side costs ~2 external calls (Gamma + CLOB) plus inserts, and a Worker
    // invocation has a hard subrequest budget (the "Too many subrequests" limit) -
    // maxSides keeps one sweep run comfortably inside its own request's budget; any
    // remainder is deferred to the next daily run and reported.
    const maxSides = opts.maxSides ?? 12;
    let sidesProcessed = 0;
    const report: SweepReport = { tanksConsidered: 0, tagsCreated: 0, skips: 0, deferred: 0, failures: [] };

    const [cfg, activeTickers, rows] = await Promise.all([
        getTickerConfig(sql),
        getActiveTickers(sql),
        sql`
            SELECT t.id, t.slug,
                   t.game_snapshot->'prop'->>'id' AS market_id,
                   t.game_snapshot->'prop'->'odds'->'outcomePrices' AS outcome_prices
            FROM tank_pages t
            WHERE t.status = 'published' AND t.visibility = 'app' AND t.provider = 'polymarket'
              AND t.slug IS NOT NULL AND t.model_output IS NOT NULL
              AND t.game_snapshot->'prop'->>'id' IS NOT NULL
              AND t.published_at > NOW() - (INTERVAL '1 day' * ${opts.maxAgeDays})
              AND NOT EXISTS (SELECT 1 FROM ticker_tags tt WHERE tt.tank_id = t.id)
            ORDER BY t.published_at
        `,
    ]);
    report.tanksConsidered = rows.length;

    // Sequential, settle.ts discipline: each side costs a Gamma + CLOB call.
    for (const row of rows) {
        const tankId = row.id as string;
        const slug = row.slug as string;
        const marketId = row.market_id as string;
        const probs = Array.isArray(row.outcome_prices) ? (row.outcome_prices as unknown[]).map(Number) : [];
        if (probs.length === 0 || probs.some((p) => !Number.isFinite(p))) {
            report.failures.push({ slug, side: -1, code: 'missing_snapshot_odds', message: 'No usable outcomePrices in the frozen snapshot.' });
            continue;
        }
        for (let side = 0; side < probs.length; side++) {
            const eligible = activeTickers.filter((t) => checkEligibility(t.rule_type, probs[side], cfg).ok);
            if (eligible.length === 0) continue;
            if (sidesProcessed >= maxSides) {
                report.deferred++;
                continue;
            }
            sidesProcessed++;
            // One CLOB fetch per SIDE, shared by every ticker tagging that side.
            let tagDelta: TagDelta;
            try {
                tagDelta = await fetchTagDelta(marketId, side, cfg.tag_delta_cap_pct);
            } catch (err) {
                const code = err instanceof TaggingError ? err.code : 'error';
                const message = err instanceof Error ? err.message : String(err);
                report.failures.push({ slug, side, code, message });
                continue;
            }
            for (const ticker of eligible) {
                try {
                    await insertTagWithEvent(sql, {
                        tagId: crypto.randomUUID(),
                        tankId,
                        tickerKey: ticker.key,
                        relevantSide: side,
                        delta: tagDelta.delta,
                        metadata: {
                            rawDelta: tagDelta.rawDelta,
                            capped: tagDelta.capped,
                            capPct: cfg.tag_delta_cap_pct,
                            priceNow: tagDelta.priceNow,
                            price3dAgo: tagDelta.price3dAgo,
                            tokenId: tagDelta.tokenId,
                            historyPoints: tagDelta.historyPoints,
                            thinHistory: tagDelta.thinHistory,
                            snapshotProb: probs[side],
                            marketId,
                            source: 'curate_sweep',
                        },
                    });
                    report.tagsCreated++;
                } catch (err) {
                    if ((err as { code?: string })?.code === '23505') {
                        report.skips++;
                    } else {
                        report.failures.push({ slug, side, code: 'insert_error', message: err instanceof Error ? err.message : String(err) });
                    }
                }
            }
        }
    }
    return report;
}

// Settle-event write, idempotent by construction (same single-statement CTE discipline
// as ledger.ts's ledger+balance write): the event row only comes into existence if this
// statement is the one that flips calculated_at from NULL. Returns false on a replay.
// The delta is deliberately NOT capped - see create_ticker_tables.sql.
export async function settleTag(sql: NeonQueryFunction<false, false>, input: SettleTagInput): Promise<boolean> {
    const delta = input.won ? input.winPct : -input.lossPct;
    const rows = await sql`
        WITH upd AS (
            UPDATE ticker_tags SET calculated_at = NOW()
            WHERE id = ${input.tagId} AND calculated_at IS NULL
            RETURNING id
        )
        INSERT INTO ticker_events (ticker_tag_id, ticker_key, tank_id, event_type, delta, metadata)
        SELECT id, ${input.tickerKey}, ${input.tankId}, 'settle', ${delta}, ${JSON.stringify(input.metadata)}::jsonb
        FROM upd
        RETURNING id`;
    return rows.length > 0;
}
