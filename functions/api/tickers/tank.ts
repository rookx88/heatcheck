// GET /api/tickers/tank?slug=... (or ?id=...) - public. Which indexes a Tank is tagged
// to, what this Tank's own news move did to each, and where each index stands now.
//
// Two consumers:
//   * the article page's index section, which renders a tile per index plus a
//     market-reaction line ("the market slid 5 points; $DOGS eases 0.6%") - it needs
//     tagDelta/rawDelta/tickerValue, which is why this returns more than event ids.
//   * chart highlighting, which pairs eventIds with /api/tickers/chart to mark this
//     Tank's own points on each index's line.
//
// The two deltas are deliberately BOTH here and mean different things: rawDelta is the
// market's real 3-day repricing on this story (vivid, 1-10 points), tagDelta is what
// the index actually moved after tag_scale_pct. Copy must never quote the raw number as
// the index's move.
//
// Returns the Tank's visibility so the client knows a newsletter_only Tank's events
// won't appear in any public chart to highlight.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, UUID_RE, type Env } from '../../../lib/pages-functions/db';
import { RETROSPECTIVE_NOTE, getTickerValues } from '../../../lib/pages-functions/tickers';
import { indexLabelOf } from '../../../lib/pages-functions/ticker-copy';
import { buildNewsSentence } from '../../../lib/pages-functions/market-movers';

interface TagRow {
    ticker_key: string;
    relevant_side: number;
    tagged_at: string;
    calculated_at: string | null;
    retroactive: boolean;
    event_ids: string[];
    tag_delta: number | null;
    raw_delta: number | null;
    settle_delta: number | null;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const url = new URL(context.request.url);
    const id = url.searchParams.get('id')?.trim() ?? '';
    const slug = url.searchParams.get('slug')?.trim() ?? '';
    if ((!id && !slug) || (id && !UUID_RE.test(id))) {
        return jsonResponse({ message: 'Provide ?slug=... or ?id=<uuid>.' }, { status: 400 });
    }

    const sql = getSql(context.env);
    // The snapshot bits come along for the ride so the news sentence can name what the
    // story was about, using the same subject rules the result sentences use. Both
    // branches are spelled out because a Neon tagged template interpolates values, not
    // SQL fragments - a shared `sql` fragment would be sent as a parameter.
    const tankRows = id
        ? await sql`
            SELECT id, slug, visibility,
                   game_snapshot->'prop'->>'player' AS player,
                   game_snapshot->'prop'->>'market' AS market,
                   game_snapshot->'prop'->'odds'->'outcomes' AS outcomes,
                   model_output->'call'->'sides' AS sides
            FROM tank_pages WHERE id = ${id} LIMIT 1`
        : await sql`
            SELECT id, slug, visibility,
                   game_snapshot->'prop'->>'player' AS player,
                   game_snapshot->'prop'->>'market' AS market,
                   game_snapshot->'prop'->'odds'->'outcomes' AS outcomes,
                   model_output->'call'->'sides' AS sides
            FROM tank_pages WHERE slug = ${slug} LIMIT 1`;
    if (tankRows.length === 0) {
        return jsonResponse({ message: 'No Tank matches that id/slug.' }, { status: 404 });
    }
    const tank = tankRows[0] as unknown as {
        id: string; slug: string | null; visibility: string;
        player: string | null; market: string | null; outcomes: unknown; sides: unknown;
    };

    // Current index values come from getTickerValues - the ONE place the slate/tank leg
    // filter lives. Re-deriving that SUM(...) FILTER here would be a second copy of a
    // rule that has already changed once.
    const [rows, values] = await Promise.all([
        sql`
            SELECT tt.ticker_key, tt.relevant_side, tt.tagged_at, tt.calculated_at, tt.retroactive,
                   COALESCE(array_agg(e.id ORDER BY e.occurred_at) FILTER (WHERE e.id IS NOT NULL), '{}') AS event_ids,
                   MAX(e.delta) FILTER (WHERE e.event_type = 'tag')::float8 AS tag_delta,
                   MAX((e.metadata->>'rawDelta')::float8) FILTER (WHERE e.event_type = 'tag') AS raw_delta,
                   MAX(e.delta) FILTER (WHERE e.event_type = 'settle')::float8 AS settle_delta
            FROM ticker_tags tt
            LEFT JOIN ticker_events e ON e.ticker_tag_id = tt.id
            WHERE tt.tank_id = ${tank.id}
            GROUP BY tt.id, tt.ticker_key, tt.relevant_side, tt.tagged_at, tt.calculated_at, tt.retroactive
            ORDER BY tt.tagged_at
        `,
        getTickerValues(sql),
    ]);
    const byKey = new Map(values.map((v) => [v.key, v]));

    const outcomes = Array.isArray(tank.outcomes) ? (tank.outcomes as unknown[]) : [];
    const sides = Array.isArray(tank.sides) ? (tank.sides as unknown[]) : [];

    const tags = (rows as unknown as TagRow[]).map((r, i) => {
        const ticker = byKey.get(r.ticker_key);
        // Composed here, not client-side: the article island would otherwise have to
        // import market-movers.ts and drag every SSR string builder into its bundle.
        // Same split /api/tickers/detail already uses for result sentences.
        const sentence = ticker && r.raw_delta !== null && r.tag_delta !== null
            ? buildNewsSentence({
                subject: tank.player ?? '',
                market: tank.market ?? '',
                outcomeLabel: typeof outcomes[r.relevant_side] === 'string' ? (outcomes[r.relevant_side] as string) : '',
                pickLabel: typeof sides[r.relevant_side] === 'string' ? (sides[r.relevant_side] as string) : '',
                rawPoints: r.raw_delta,
                // The index's move ON THIS STORY, not its level - the tile shows level.
                indexPct: r.tag_delta,
            }, ticker.displayName, i)
            : null;
        return {
            sentence,
            tickerKey: r.ticker_key,
            // Null when the ticker went inactive after this Tank was tagged - the tag
            // row outlives the ticker's activity, so the client must tolerate it.
            displayName: ticker?.displayName ?? null,
            indexLabel: ticker ? indexLabelOf(ticker.ruleType) : null,
            ruleType: ticker?.ruleType ?? null,
            tickerValue: ticker?.value ?? null,
            relevantSide: r.relevant_side,
            taggedAt: r.tagged_at,
            settledAt: r.calculated_at,
            retroactive: r.retroactive,
            eventIds: r.event_ids,
            // What this story did to the index...
            tagDelta: r.tag_delta,
            // ...and the market's own repricing behind it. Never present these as the
            // same number: rawDelta is pre-scale (see tag_scale_pct).
            rawDelta: r.raw_delta,
            settleDelta: r.settle_delta,
        };
    });

    return jsonResponse({
        note: RETROSPECTIVE_NOTE,
        tank: { id: tank.id, slug: tank.slug, visibility: tank.visibility },
        tags,
    });
};
