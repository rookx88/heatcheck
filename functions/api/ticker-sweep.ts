// POST /api/ticker-sweep - protected, machine-to-machine only (called by
// worker-curate/'s daily cron right after /api/curate, or by hand while testing).
// Shares X-Curate-Secret with /api/curate: same caller, same trust domain.
//
// Runs the Exchange ticker tag sweep (sweepUntaggedTanks, lib/pages-functions/
// tickers.ts): published, app-visible polymarket Tanks with no ticker tags get BOTH
// sides tagged onto every eligible active ticker. This deliberately lives in its own
// endpoint rather than inside /api/curate: a Worker invocation has a hard subrequest
// budget ("Too many subrequests"), and curation's Gamma + Anthropic + Neon traffic
// already runs close to it - the sweep gets its own request, its own budget, and a
// maxSides cap inside sweepUntaggedTanks bounds this run well under the limit (the
// remainder is deferred to the next daily run and reported).
//
// Safe to call any time: publish-gated candidates only, duplicate tags are unique-
// violation skips, CLOB-dead markets age out of the CURATE_TAG_SWEEP_DAYS window.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../lib/pages-functions/db';
import { sweepUntaggedTanks } from '../../lib/pages-functions/tickers';

const DEFAULT_TAG_SWEEP_DAYS = 14;

function numEnv(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const secret = context.request.headers.get('X-Curate-Secret');
    if (!secret || secret !== context.env.CURATE_SECRET) {
        return jsonResponse({ message: 'Unauthorized' }, { status: 401 });
    }

    const sql = getSql(context.env);
    const report = await sweepUntaggedTanks(sql, {
        maxAgeDays: numEnv(context.env.CURATE_TAG_SWEEP_DAYS, DEFAULT_TAG_SWEEP_DAYS),
    });
    return jsonResponse(report);
};
