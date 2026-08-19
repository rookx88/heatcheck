// GET /api/tickers/chart[?key=dogs] - public. The trading chart is not separate
// storage: it is ticker_events ordered by occurred_at with a running cumulative sum,
// computed live per request by getTickerSeries() (shared with the server-rendered
// homepage Market Movers section - same statement, no drift). Omit ?key for every
// active ticker's series at once, pass ?key for a single ticker (an article page pairs
// this with /api/tickers/tank to highlight that Tank's own events on the line).
//
// Only events on visibility='app' Tanks appear - same exclusion as the values in
// /api/tickers, so chart and value can never disagree.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../../lib/pages-functions/db';
import { RETROSPECTIVE_NOTE, getTicker, getTickerSeries } from '../../../lib/pages-functions/tickers';

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const url = new URL(context.request.url);
    const key = url.searchParams.get('key');
    const sql = getSql(context.env);

    if (key && !(await getTicker(sql, key))) {
        return jsonResponse({ message: `No active ticker "${key}".` }, { status: 404 });
    }

    const series = await getTickerSeries(sql, key);
    return jsonResponse({ note: RETROSPECTIVE_NOTE, series });
};
