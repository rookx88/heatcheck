// GET /api/picks/today?email=... - the client's source of truth for "which tanks have
// I already picked today, and how many of my DAILY_PICK_CAP remain." Needed because a
// real multi-pick UI (up to 3/day across different tanks) has to reflect server truth,
// not a client-side cache that can drift across days/devices - unlike the old
// one-pick-ever model, where a single cached pick object could safely stand in for
// "have I picked" indefinitely.
//
// Same no-session trust model as every other endpoint in this app (email in, no
// token) - see the settlement finalization plan's explicit note on this. Logged on
// every call (see below) as the interim safeguard for that gap, since real auth isn't
// happening this round.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, EMAIL_RE, type Env } from '../../../lib/pages-functions/db';

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
    const url = new URL(context.request.url);
    const email = (url.searchParams.get('email') || '').trim().toLowerCase();

    if (!EMAIL_RE.test(email)) {
        return jsonResponse({ message: 'Please provide a valid email address.' }, { status: 400 });
    }

    // Interim safeguard while this route has no real auth behind it - see
    // functions/api/balance.ts for the same pattern and the fuller reasoning.
    console.log('[GET /api/picks/today]', {
        email,
        ip: context.request.headers.get('CF-Connecting-IP'),
        timestamp: new Date().toISOString(),
    });

    const sql = getSql(context.env);
    const DAILY_PICK_CAP = numEnv(context.env.DAILY_PICK_CAP, 1);

    const waitlistRows = await sql`SELECT id, email_verified FROM waitlist WHERE LOWER(email) = ${email} LIMIT 1`;
    if (waitlistRows.length === 0) {
        return jsonResponse({ picks: [], picksToday: 0, remaining: DAILY_PICK_CAP, verified: false });
    }
    const waitlistId = waitlistRows[0].id as string;
    const verified = Boolean(waitlistRows[0].email_verified);

    // source = 'app' excludes newsletter-exclusive picks (functions/api/newsletter/pick.ts)
    // from this count/list - they're capped by "once per issue" (a DB unique index), not
    // by the daily app cap, and each issue only ever has one exclusive Tank to begin with.
    const pickRows = await sql`
        SELECT side, tank_slug, created_at FROM picks
        WHERE waitlist_id = ${waitlistId} AND created_at >= CURRENT_DATE AND source = 'app'
        ORDER BY created_at ASC
    `;
    const picks = (pickRows as unknown as TodayPickRow[]).map((r) => ({
        slug: r.tank_slug,
        side: r.side,
        createdAt: r.created_at,
    }));

    return jsonResponse({
        picks,
        picksToday: picks.length,
        remaining: Math.max(0, DAILY_PICK_CAP - picks.length),
        verified,
    });
};
