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
