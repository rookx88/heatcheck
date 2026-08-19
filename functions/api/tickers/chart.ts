// GET /api/tickers/chart[?key=dogs] - public. The trading chart is not separate
// storage: it is ticker_events ordered by occurred_at with a running cumulative sum,
// computed live per request. Omit ?key for every active ticker's series at once (the
// homepage), pass ?key for a single ticker (an article page pairs this with
// /api/tickers/tank to highlight that Tank's own events on the line).
//
// Only events on visibility='app' Tanks appear - same exclusion as the values in
// /api/tickers, so chart and value can never disagree. The `id` tiebreak in both the
// ORDER BY and the window frame makes same-timestamp cumulative values deterministic.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../../lib/pages-functions/db';
import { RETROSPECTIVE_NOTE } from '../../../lib/pages-functions/tickers';

interface ChartEventRow {
    id: string;
    ticker_key: string;
    tank_id: string;
    event_type: 'tag' | 'settle';
    delta: number;
    cumulative: number;
    occurred_at: string;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const url = new URL(context.request.url);
    const key = url.searchParams.get('key');
    const sql = getSql(context.env);

    if (key) {
        const known = await sql`SELECT 1 FROM tickers WHERE key = ${key} AND active LIMIT 1`;
        if (known.length === 0) {
            return jsonResponse({ message: `No active ticker "${key}".` }, { status: 404 });
        }
    }

    const rows = await sql`
        SELECT e.id, e.ticker_key, e.tank_id, e.event_type,
               e.delta::float8 AS delta,
               SUM(e.delta) OVER (PARTITION BY e.ticker_key ORDER BY e.occurred_at, e.id)::float8 AS cumulative,
               e.occurred_at
        FROM ticker_events e
        JOIN tank_pages t ON t.id = e.tank_id AND t.visibility = 'app'
        WHERE ${key}::text IS NULL OR e.ticker_key = ${key}
        ORDER BY e.ticker_key, e.occurred_at, e.id
    `;

    const series: Record<string, Array<{
        id: string; tankId: string; eventType: string; delta: number; cumulative: number; occurredAt: string;
    }>> = {};
    for (const row of rows as unknown as ChartEventRow[]) {
        (series[row.ticker_key] ??= []).push({
            id: row.id,
            tankId: row.tank_id,
            eventType: row.event_type,
            delta: row.delta,
            cumulative: row.cumulative,
            occurredAt: row.occurred_at,
        });
    }
    return jsonResponse({ note: RETROSPECTIVE_NOTE, series });
};
