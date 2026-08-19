// GET /api/tickers/tank?slug=... (or ?id=...) - public. Which tickers a Tank is tagged
// to, and which ticker_events rows are that Tank's own - the article page fetches this
// plus /api/tickers/chart and visually distinguishes this Tank's tag/settle events from
// the rest of each ticker's line. Returns the Tank's visibility so the client knows a
// newsletter_only Tank's events won't appear in any public chart to highlight.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, UUID_RE, type Env } from '../../../lib/pages-functions/db';
import { RETROSPECTIVE_NOTE } from '../../../lib/pages-functions/tickers';

interface TagRow {
    ticker_key: string;
    relevant_side: number;
    tagged_at: string;
    calculated_at: string | null;
    retroactive: boolean;
    event_ids: string[];
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const url = new URL(context.request.url);
    const id = url.searchParams.get('id')?.trim() ?? '';
    const slug = url.searchParams.get('slug')?.trim() ?? '';
    if ((!id && !slug) || (id && !UUID_RE.test(id))) {
        return jsonResponse({ message: 'Provide ?slug=... or ?id=<uuid>.' }, { status: 400 });
    }

    const sql = getSql(context.env);
    const tankRows = id
        ? await sql`SELECT id, slug, visibility FROM tank_pages WHERE id = ${id} LIMIT 1`
        : await sql`SELECT id, slug, visibility FROM tank_pages WHERE slug = ${slug} LIMIT 1`;
    if (tankRows.length === 0) {
        return jsonResponse({ message: 'No Tank matches that id/slug.' }, { status: 404 });
    }
    const tank = tankRows[0] as unknown as { id: string; slug: string | null; visibility: string };

    const rows = await sql`
        SELECT tt.ticker_key, tt.relevant_side, tt.tagged_at, tt.calculated_at, tt.retroactive,
               COALESCE(array_agg(e.id ORDER BY e.occurred_at) FILTER (WHERE e.id IS NOT NULL), '{}') AS event_ids
        FROM ticker_tags tt
        LEFT JOIN ticker_events e ON e.ticker_tag_id = tt.id
        WHERE tt.tank_id = ${tank.id}
        GROUP BY tt.id, tt.ticker_key, tt.relevant_side, tt.tagged_at, tt.calculated_at, tt.retroactive
        ORDER BY tt.tagged_at
    `;
    const tags = (rows as unknown as TagRow[]).map((r) => ({
        tickerKey: r.ticker_key,
        relevantSide: r.relevant_side,
        taggedAt: r.tagged_at,
        settledAt: r.calculated_at,
        retroactive: r.retroactive,
        eventIds: r.event_ids,
    }));

    return jsonResponse({
        note: RETROSPECTIVE_NOTE,
        tank: { id: tank.id, slug: tank.slug, visibility: tank.visibility },
        tags,
    });
};
