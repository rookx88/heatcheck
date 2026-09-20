// GET /api/ops/health - the same checks as the hourly /api/ops/health-check, on demand
// and read-only: no alert is raised or resolved, nothing is pruned, no email is sent.
// For "is everything okay right now?" without waiting for the next hour:
//   curl -H "X-Settle-Secret: $SETTLE_SECRET" https://auth-sessions.heatcheck.pages.dev/api/ops/health
// Add ?format=text for the daily-summary text instead of JSON.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../../lib/pages-functions/db';
import { secretMatches } from '../../../lib/pages-functions/secret-compare';
import { checkLedgers, opsSnapshot, renderDigest } from '../../../lib/pages-functions/ops-health';

export const onRequestGet: PagesFunction<Env> = async (context) => {
    if (!(await secretMatches(context.request.headers.get('X-Settle-Secret'), context.env.SETTLE_SECRET))) {
        return jsonResponse({ message: 'Unauthorized' }, { status: 401 });
    }
    const sql = getSql(context.env);
    // Two round trips: the ledger snapshot, and everything else batched (opsSnapshot).
    const [ledger, snapshot] = await Promise.all([checkLedgers(sql), opsSnapshot(sql)]);
    const { jobs, security, errors, openAlerts } = snapshot;
    const digest = renderDigest({ ledger, jobs, security, errors, openAlerts });

    if (new URL(context.request.url).searchParams.get('format') === 'text') {
        return new Response(digest.text, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    return jsonResponse({ allGood: digest.allGood, openAlerts, ledger, jobs, security, errors });
};
