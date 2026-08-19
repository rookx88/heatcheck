// GET /api/tickers - public. All active tickers with their current values, for the
// homepage ticker tab. A ticker's value is a LIVE SUM(delta) over ticker_events - a
// cumulative percentage starting at 0%, NOT an indexed price against a base of 100 -
// restricted to events whose Tank is visibility='app' (a newsletter_only Tank's events
// exist but never count toward any public value or chart). Nothing is cached or stored:
// getTickerValues() is the only source of truth (shared with the server-rendered
// homepage Market Movers section), so the two surfaces can never drift.
//
// Framing constraint (see RETROSPECTIVE_NOTE): these values reflect how tagged
// storylines have gone - they are never presented as predictive.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../lib/pages-functions/db';
import { RETROSPECTIVE_NOTE, getTickerValues } from '../../lib/pages-functions/tickers';

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const sql = getSql(context.env);
    const tickers = await getTickerValues(sql);
    return jsonResponse({ note: RETROSPECTIVE_NOTE, tickers });
};
