// POST /api/curate-sport?sport=Soccer|Basketball|Baseball|Football - protected,
// machine-to-machine only (X-Curate-Secret, same trust domain as /api/curate).
//
// The entry point worker-curate's daily cron actually uses. Curates exactly ONE sport
// group per request, so each gets its own 50-subrequest budget (Cloudflare Free plan's
// per-invocation ceiling). All the logic lives in curate.ts's runCuration(); this file
// only resolves which group to run.
//
// WHY A DISTINCT PATH RATHER THAN ?sport= ON /api/curate
// A query param is fail-OPEN in the wrong direction. Deploys are not atomic here - the
// Worker and the Pages Functions ship separately - so if worker-curate went out first
// and started sending ?sport=..., the old handler would ignore the unknown param and run
// ALL FOUR groups, four times over, for a silent 4x Anthropic bill with nothing in the
// response to indicate anything was wrong. A separate path 404s against an old
// deployment instead: worker-curate logs the failure and spends nothing. Cheap
// insurance for a mistake that is otherwise invisible until the invoice.
//
// An unknown or missing ?sport= is a 400, never a fallback to "all groups", for the same
// reason.

import type { PagesFunction } from '@cloudflare/workers-types';
import { jsonResponse, type Env } from '../../lib/pages-functions/db';
import { runCuration, SPORT_GROUPS } from './curate';

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const secret = context.request.headers.get('X-Curate-Secret');
    if (!secret || secret !== context.env.CURATE_SECRET) {
        return jsonResponse({ message: 'Unauthorized' }, { status: 401 });
    }

    const sport = new URL(context.request.url).searchParams.get('sport');
    if (!sport || !SPORT_GROUPS[sport]) {
        return jsonResponse({
            message: `Unknown or missing sport. Expected one of: ${Object.keys(SPORT_GROUPS).join(', ')}`,
            received: sport,
        }, { status: 400 });
    }

    const result = await runCuration(context.env, [sport]);
    // Echoing the group back lets the caller confirm it ran the single sport it asked
    // for rather than something wider.
    return jsonResponse({ mode: 'single', sportGroup: sport, ...result });
};
