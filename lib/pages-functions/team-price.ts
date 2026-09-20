// A club's Ember price: created and moved exactly the way an index ticker's is, judged on
// the club's own games. Pure functions plus two SqlReader readers, so the static build
// and the acceptance suite compute it from one SQL and one set of functions - every one
// of which is the index's own.
//
// THE THREE STEPS, AND WHAT EACH REUSES
//   1. Daily close  - the club's settled directional sides (team-records.ts's dedupe),
//                     bucketed by the INDEX close date the game rolled into, run through
//                     closeDelta() with THAT close's smoothing and scale. A club's close is
//                     therefore "the index close formula applied to the subset of that
//                     day's positions that are this club" - and because the numbers come
//                     from the linked close's own metadata, a future config retune cannot
//                     rewrite a club's history, for the same reason it cannot rewrite an
//                     index's.
//   2. News leg     - a published Tank's tag event (its side's real 3-day CLOB move,
//                     already scaled and clamped when the index was tagged) moves the club
//                     that side resolves to, by the SAME stored delta: same market, same
//                     side, same move. Tag events are deduped by (tank, side) because
//                     $CHALK and $MLBCHALK both tag the same side. Moneyline only in v1 -
//                     a spread tank's outcomes are abbreviations ('TEN', 'SEA') that name
//                     no club in the registry.
//   3. Price        - value = SUM(delta) over the club's events; price = priceFromValue(),
//                     baseline 100, ONE shared scale. Indexes carry per-ticker scales (20
//                     to 115) because they aggregate slates of very different sizes; a
//                     club's day is nearly always one game, so its daily sd is ~1.0 in
//                     every league and one number serves all of them.
//
// DERIVED, NOT STORED. Nothing here writes. The index closes exist as rows because tag
// events need a home and because a day's config has to be frozen - both of which the
// linked close's metadata already supplies a club for free. A club's series is
// recomputed from permanent rows on every build and cannot drift from them. If clubs
// ever become tradeable, the trade path needs a persisted price and this becomes the
// spec for the table it writes.
//
// Every surface that prints one of these prices carries ticker-price.ts's PRICE_NOTE
// verbatim, exactly as the index surfaces do: a price invites a forward-looking reading
// that a residual does not.

import type { SqlReader } from './tickers';
import { getGameConfigOrNull } from './pets';
import { closeDelta, contributionFor } from './index-slate';
import { priceFromValue, priceReturnPct, type PriceParams } from './ticker-price';
import { WINDOWS, sumSince, type WindowSums, type WindowedEvent } from './ticker-window';
import { resolvePositionTeams } from './team-identity';

export const DEFAULT_TEAM_PRICE_BASELINE = 100;
// $MLBCHALK's scale. The literal index rule (scale ~= daily sd / 0.12) gives 8, which
// priced the best club of the first fortnight at 196; see seed_team_records_config_v2.sql.
export const DEFAULT_TEAM_PRICE_SCALE = 20;

export interface TeamEvent {
    teamId: string;
    eventType: 'close' | 'tag';
    occurredAt: string;
    delta: number;
    /** Closes only: the index close date this day's games rolled into. */
    closeDate: string | null;
    /** Tags only: the Tank that moved the price. */
    tankSlug: string | null;
    /** Closes only. */
    positionsCounted?: number;
    positionsWon?: number;
}

function iso(v: unknown): string | null {
    if (v === null || v === undefined) return null;
    const d = v instanceof Date ? v : new Date(String(v));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * One derived close per (club, index close date): the club's settled directional sides
 * that day, through closeDelta with that day's own smoothing and scale.
 */
export async function getTeamCloseEvents(sql: SqlReader): Promise<TeamEvent[]> {
    const rows = await sql`
        WITH sides AS (
            SELECT DISTINCT ON (ip.event_id, ip.market_type, ip.side_index)
                   ip.subject_team_id AS team_id,
                   ip.entry_prob::float8 AS entry_prob,
                   (ip.result = 'win') AS won,
                   te.close_date, te.occurred_at,
                   (te.metadata->>'smoothing')::float8 AS smoothing,
                   (te.metadata->>'scalePct')::float8 AS scale_pct
            FROM index_positions ip
            JOIN ticker_events te ON te.id = ip.close_id AND te.source = 'slate'
            WHERE ip.market_type = 'moneyline'
              AND ip.result IN ('win', 'loss')
              AND ip.subject_team_id IS NOT NULL
            ORDER BY ip.event_id, ip.market_type, ip.side_index, ip.locked_at, ip.id
        )
        SELECT team_id, close_date::text AS close_date,
               MIN(occurred_at) AS occurred_at,
               array_agg(entry_prob ORDER BY occurred_at) AS probs,
               array_agg(won ORDER BY occurred_at) AS wons,
               MAX(smoothing) AS smoothing, MAX(scale_pct) AS scale_pct
        FROM sides
        GROUP BY team_id, close_date
        ORDER BY team_id, close_date
    `;
    const out: TeamEvent[] = [];
    for (const r of rows) {
        const probs = (r.probs as unknown[]).map(Number);
        const wons = (r.wons as unknown[]).map((w) => w === true || w === 't');
        const smoothing = Number(r.smoothing);
        const scalePct = Number(r.scale_pct);
        if (!Number.isFinite(smoothing) || !Number.isFinite(scalePct)) continue; // a close with no config is not a close
        const contribs = probs.map((p, i) => contributionFor(wons[i], p));
        const delta = closeDelta(contribs, { smoothing, scalePct });
        if (delta === null) continue;
        const occurredAt = iso(r.occurred_at);
        if (!occurredAt) continue;
        out.push({
            teamId: r.team_id as string,
            eventType: 'close',
            occurredAt,
            delta,
            closeDate: r.close_date as string,
            tankSlug: null,
            positionsCounted: contribs.length,
            positionsWon: wons.filter(Boolean).length,
        });
    }
    return out;
}

export interface TeamTagReport {
    events: TeamEvent[];
    /** Distinct (tank, side) moneyline tags considered. */
    considered: number;
    /** Sides that named no club - honest refusals (a soccer 'No') and unmapped names alike. */
    unresolved: number;
    /** Sides whose metadata carried no rawDelta, so the stored delta was clamped instead. */
    withoutRawDelta: number;
    tagScalePct: number;
    tagCapPct: number;
}

// The current tag rule, read from game_config['tickers']. Defaults mirror seed_ticker_
// config_v3.sql so a missing row still produces current-era magnitudes rather than raw ones.
const DEFAULT_TAG_SCALE_PCT = 0.12;
const DEFAULT_TAG_CAP_PCT = 1.5;

/**
 * Tank tag events resolved to the club their side names: one per (tank, side), the
 * earliest index tag winning, visibility='app' tanks only (getTickerValues' predicate).
 * The question for a soccer Yes/No tank comes from polymarket_props via the tag's own
 * marketId - the snapshot carries none.
 *
 * WHY THE DELTA IS RECOMPUTED AND NOT READ. A tag event's stored delta is what that tank
 * did to an INDEX under the config of its day, and that config changed: before
 * seed_ticker_config_v3.sql (2026-08-31) there was no tag_scale_pct and the cap was 10, so
 * August tags sit at +/-1 to +/-10 while today's are scaled by 0.12 and capped at 1.5
 * (a typical one is ~0.06). An index absorbs those old magnitudes across hundreds of
 * events; a club has one to five events in total, so a single August tag would BE its
 * price - measured 2026-09-13, the pre-v3 tags carried 102.5 of total |delta| against the
 * v3 era's 56.7, and Barcelona's price came out at 151.66 off one +5.000.
 *
 * metadata.rawDelta is the underlying fact - the side's real 3-day implied-probability
 * move, before any scaling or clamping - and it is era-independent. Applying today's rule
 * to it (the same clamp(raw * scale, +/-cap) that fetchTagDelta applies, tickers.ts) gives
 * every club tag a consistent, current magnitude: total |delta| 159.16 -> 37.20, max
 * 10.000 -> 1.380, nothing at the cap. Present on 134 of 136 live sides; the two without
 * fall back to their stored delta clamped to the current cap, which can only shrink it.
 */
export async function getTeamTagEvents(sql: SqlReader): Promise<TeamTagReport> {
    const cfg = await getGameConfigOrNull(sql, 'tickers') as { tag_scale_pct?: unknown; tag_delta_cap_pct?: unknown } | null;
    const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);
    const tagScalePct = num(cfg?.tag_scale_pct, DEFAULT_TAG_SCALE_PCT);
    const tagCapPct = num(cfg?.tag_delta_cap_pct, DEFAULT_TAG_CAP_PCT);
    const clamp = (v: number) => Math.max(-tagCapPct, Math.min(tagCapPct, v));

    const rows = await sql`
        SELECT DISTINCT ON (e.tank_id, tt.relevant_side)
               e.tank_id, tt.relevant_side, e.delta::float8 AS delta,
               (e.metadata->>'rawDelta')::float8 AS raw_delta,
               e.occurred_at,
               t.slug, t.league,
               t.game_snapshot->'game'->>'away' AS away,
               t.game_snapshot->'game'->>'home' AS home,
               t.game_snapshot->'prop'->'odds'->'outcomes'->>(tt.relevant_side::int) AS side_label,
               pp.question
        FROM ticker_events e
        JOIN ticker_tags tt ON tt.id = e.ticker_tag_id
        JOIN tank_pages t ON t.id = e.tank_id
        LEFT JOIN polymarket_props pp ON pp.market_id = e.metadata->>'marketId'
        WHERE e.event_type = 'tag'
          AND t.visibility = 'app'
          AND t.game_snapshot->'prop'->>'market' = 'moneyline'
        ORDER BY e.tank_id, tt.relevant_side, e.occurred_at
    `;
    const events: TeamEvent[] = [];
    let unresolved = 0;
    let withoutRawDelta = 0;
    for (const r of rows) {
        const res = resolvePositionTeams({
            league: (r.league as string | null) ?? null,
            away: (r.away as string | null) ?? null,
            home: (r.home as string | null) ?? null,
            marketType: 'moneyline',
            sideLabel: (r.side_label as string | null) ?? null,
            question: (r.question as string | null) ?? null,
        });
        const occurredAt = iso(r.occurred_at);
        if (!res.subjectTeamId || !occurredAt) {
            unresolved++;
            continue;
        }
        const raw = r.raw_delta;
        const hasRaw = typeof raw === 'number' && Number.isFinite(raw);
        if (!hasRaw) withoutRawDelta++;
        const delta = Number(
            (hasRaw ? clamp((raw as number) * tagScalePct) : clamp(Number(r.delta))).toFixed(3),
        );
        events.push({
            teamId: res.subjectTeamId,
            eventType: 'tag',
            occurredAt,
            delta,
            closeDate: null,
            tankSlug: (r.slug as string | null) ?? null,
        });
    }
    return { events, considered: rows.length, unresolved, withoutRawDelta, tagScalePct, tagCapPct };
}

export interface TeamSeriesEvent extends WindowedEvent {
    eventType: 'close' | 'tag';
    cumulative: number;
    tankSlug: string | null;
}

export interface TeamPricing {
    teamId: string;
    /** SUM(delta) over every event - the chart's secondary axis, in points. */
    value: number;
    price: number;
    priceBaseline: number;
    priceScale: number;
    eventCount: number;
    closeCount: number;
    tagCount: number;
    /** Oldest first, cumulative running. */
    series: TeamSeriesEvent[];
    /** Points moved inside each board window, for chooseWindowFromSums. */
    sums: WindowSums;
}

export function buildTeamPricing(teamId: string, events: TeamEvent[], params: PriceParams, now: number): TeamPricing {
    const sorted = [...events]
        .filter((e) => e.teamId === teamId)
        .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
    let cumulative = 0;
    const series: TeamSeriesEvent[] = sorted.map((e) => {
        cumulative = Number((cumulative + e.delta).toFixed(3));
        return { eventType: e.eventType, delta: e.delta, cumulative, occurredAt: e.occurredAt, tankSlug: e.tankSlug };
    });
    const value = series.length ? series[series.length - 1].cumulative : 0;
    return {
        teamId,
        value,
        price: priceFromValue(value, params),
        priceBaseline: params.baseline,
        priceScale: params.scale,
        eventCount: series.length,
        closeCount: sorted.filter((e) => e.eventType === 'close').length,
        tagCount: sorted.filter((e) => e.eventType === 'tag').length,
        series,
        sums: {
            h24: sumSince(series, now - WINDOWS[0].ms),
            d7: sumSince(series, now - WINDOWS[1].ms),
            d30: sumSince(series, now - WINDOWS[2].ms),
        },
    };
}

/** Every club that has at least one event, keyed by club id. */
export function buildAllTeamPricing(closes: TeamEvent[], tags: TeamEvent[], params: PriceParams, now: number): Map<string, TeamPricing> {
    const all = [...closes, ...tags];
    const ids = [...new Set(all.map((e) => e.teamId))].sort();
    return new Map(ids.map((id) => [id, buildTeamPricing(id, all, params, now)]));
}

/** The price's % return for a points move on a club - the one exp() site, reused. */
export function teamReturnPct(deltaPoints: number, priceScale: number): number {
    return priceReturnPct(deltaPoints, priceScale);
}
