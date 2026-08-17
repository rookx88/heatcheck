// GET /api/picks/today - the client's source of truth for "which tanks have I already
// picked today, and how many of my DAILY_PICK_CAP remain." Needed because a real
// multi-pick UI (up to 3/day across different tanks) has to reflect server truth, not
// a client-side cache that can drift across days/devices - unlike the old
// one-pick-ever model, where a single cached pick object could safely stand in for
// "have I picked" indefinitely.
//
// Session-required since the magic-link auth rollout: identity comes from the
// validated hc_session cookie, never from an email query param (see
// functions/api/balance.ts for the same migration and fuller reasoning). No session
// -> 401; the client treats that as "logged-out state", not an error.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../../lib/pages-functions/db';
import { getSession, requireOnboarded } from '../../../lib/pages-functions/session';

// Same env-gated default as functions/api/picks.ts (1/day for Phase 0, raised to 3 via
// the DAILY_PICK_CAP Cloudflare env var whenever Phase 1 is ready - no redeploy needed).
// Kept in sync manually since these are separate small Functions, not shared modules.
function numEnv(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

interface TodayPickRow {
    side: string;
    tank_slug: string;
    created_at: string;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const session = await getSession(context.request, context.env);
    if (!session) {
        return jsonResponse({ message: 'Login required.' }, { status: 401 });
    }
    const gate = requireOnboarded(session);
    if (gate) return gate;
    const authHeaders = session.refreshedSetCookie ? { 'Set-Cookie': session.refreshedSetCookie } : undefined;

    const sql = getSql(context.env);
    const DAILY_PICK_CAP = numEnv(context.env.DAILY_PICK_CAP, 1);

    // source = 'app' excludes newsletter-exclusive picks (functions/api/newsletter/pick.ts)
    // from this count/list - they're capped by "once per issue" (a DB unique index), not
    // by the daily app cap, and each issue only ever has one exclusive Tank to begin with.
    const pickRows = await sql`
        SELECT side, tank_slug, created_at FROM picks
        WHERE waitlist_id = ${session.userId} AND created_at >= CURRENT_DATE AND source = 'app'
        ORDER BY created_at ASC
    `;
    const picks = (pickRows as unknown as TodayPickRow[]).map((r) => ({
        slug: r.tank_slug,
        side: r.side,
        createdAt: r.created_at,
    }));

    return jsonResponse(
        {
            picks,
            picksToday: picks.length,
            remaining: Math.max(0, DAILY_PICK_CAP - picks.length),
            verified: session.verified,
        },
        { headers: authHeaders }
    );
};
