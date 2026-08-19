// GET /api/tickers - public. All active tickers with their current values, for the
// homepage ticker tab. A ticker's value is a LIVE SUM(delta) over ticker_events - a
// cumulative percentage starting at 0%, NOT an indexed price against a base of 100 -
// restricted to events whose Tank is visibility='app' (a newsletter_only Tank's events
// exist but never count toward any public value or chart). Nothing is cached or stored:
// this query is the only source of truth, so it can never drift from the event log.
//
// Framing constraint (see RETROSPECTIVE_NOTE): these values reflect how tagged
// storylines have gone - they are never presented as predictive.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../lib/pages-functions/db';
import { RETROSPECTIVE_NOTE } from '../../lib/pages-functions/tickers';

interface TickerValueRow {
    key: string;
    display_name: string;
    description: string;
    rule_type: string;
    tab_order: number;
    settle_win_pct: number;
    settle_loss_pct: number;
    value: number;
    event_count: number;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const sql = getSql(context.env);
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
    const tickers = (rows as unknown as TickerValueRow[]).map((r) => ({
        key: r.key,
        displayName: r.display_name,
        description: r.description,
        ruleType: r.rule_type,
        tabOrder: r.tab_order,
        value: r.value,
        eventCount: r.event_count,
        settleWinPct: r.settle_win_pct,
        settleLossPct: r.settle_loss_pct,
    }));
    return jsonResponse({ note: RETROSPECTIVE_NOTE, tickers });
};
