// GET /api/tickers/tank?slug=... (or ?id=...) - public. Which indexes a Tank is tagged
// to, what this Tank's own news move did to each, and where each index stands now -
// as an Ember price with the price's % change over the boards' adaptive window
// (chooseWindowFromSums over this Tank's tagged indexes: 24h, widening to 7d / 30d /
// all-time until one of them moved).
//
// Two consumers:
//   * the article page's index section, which renders a tile per index (price +
//     window return) plus a line describing the market's own price over the 3 days
//     before tagging, and what the index did - it needs tagDelta/rawDelta and the
//     price fields, which is why this returns more than event ids.
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
import { RETROSPECTIVE_NOTE, getTickerValues, getTickerWindowSums, type TickerValue } from '../../../lib/pages-functions/tickers';
import { indexLabelOf } from '../../../lib/pages-functions/ticker-copy';
import { buildNewsSentence } from '../../../lib/pages-functions/market-movers';
import { chooseWindowFromSums } from '../../../lib/pages-functions/ticker-window';
import { PRICE_NOTE, priceReturnPct } from '../../../lib/pages-functions/ticker-price';

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
    price_3d_ago: number | null;
    price_now: number | null;
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
    // The window sums are one statement over the same log (getTickerWindowSums) so the
    // tile's "(+1.2%)" applies the boards' rule without loading every series here.
    const [rows, values, sums] = await Promise.all([
        sql`
            SELECT tt.ticker_key, tt.relevant_side, tt.tagged_at, tt.calculated_at, tt.retroactive,
                   COALESCE(array_agg(e.id ORDER BY e.occurred_at) FILTER (WHERE e.id IS NOT NULL), '{}') AS event_ids,
                   MAX(e.delta) FILTER (WHERE e.event_type = 'tag')::float8 AS tag_delta,
                   MAX((e.metadata->>'rawDelta')::float8) FILTER (WHERE e.event_type = 'tag') AS raw_delta,
                   MAX((e.metadata->>'price3dAgo')::float8) FILTER (WHERE e.event_type = 'tag') AS price_3d_ago,
                   MAX((e.metadata->>'priceNow')::float8) FILTER (WHERE e.event_type = 'tag') AS price_now,
                   MAX(e.delta) FILTER (WHERE e.event_type = 'settle')::float8 AS settle_delta
            FROM ticker_tags tt
            LEFT JOIN ticker_events e ON e.ticker_tag_id = tt.id
            WHERE tt.tank_id = ${tank.id}
            GROUP BY tt.id, tt.ticker_key, tt.relevant_side, tt.tagged_at, tt.calculated_at, tt.retroactive
            ORDER BY tt.tagged_at
        `,
        getTickerValues(sql),
        getTickerWindowSums(sql),
    ]);
    const byKey = new Map(values.map((v) => [v.key, v]));

    // The window is chosen over THIS Tank's tagged indexes (the ones the section shows),
    // so its tiles share one lens the way a board's tiles do.
    const tagged = (rows as unknown as TagRow[])
        .map((r) => byKey.get(r.ticker_key))
        .filter((v): v is TickerValue => !!v);
    const { deltas, info: window } = chooseWindowFromSums(tagged.map(({ key, value }) => ({ key, value })), sums);
    const deltaOf = new Map(tagged.map((t, i) => [t.key, deltas[i]]));

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
                fromPrice: r.price_3d_ago,
                toPrice: r.price_now,
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
            // The tile's quote: the Ember price and its % change over `window` below.
            price: ticker?.price ?? null,
            priceBaseline: ticker?.priceBaseline ?? null,
            priceScale: ticker?.priceScale ?? null,
            windowDelta: ticker ? (deltaOf.get(ticker.key) ?? 0) : null,
            priceReturnPct: ticker ? priceReturnPct(deltaOf.get(ticker.key) ?? 0, ticker.priceScale) : null,
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
        priceNote: PRICE_NOTE,
        window,
        tank: { id: tank.id, slug: tank.slug, visibility: tank.visibility },
        tags,
    });
};
