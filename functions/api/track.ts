// POST /api/track - anonymous funnel/read-depth events. Fire-and-forget from the
// client's perspective: always fast, never blocks the actual UX. Only ever logs
// waitlist_id=null here (pre-conversion events) - picks.ts/verify-email.ts attach
// the real waitlist_id once a visitor converts, bridging their anonymous history.
//
// BOUNDED (launch audit, 2026-09-07). Before this the endpoint accepted any origin,
// any string lengths and an arbitrary-size JSON `metadata` with no per-client limit:
// one script could insert unlimited multi-megabyte rows into `events` from anywhere.
// Now: same-origin only (the beacon is a same-origin fetch; non-browser clients still
// pass, which is fine once the write itself is bounded), hard length caps on every
// string, metadata must be a plain object of at most METADATA_MAX_BYTES serialized,
// and a per-IP hourly cap (THROTTLES.track) folded INTO the insert as a CTE so a page
// view stays one round-trip. Over the cap the insert is simply skipped and the
// response is still 201 - the client fires and forgets, and a 429 would only invite
// retries.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, UUID_RE, type Env } from '../../lib/pages-functions/db';
import { EVENT_TYPES, type EventType } from '../../lib/pages-functions/events';
import { requireSameOrigin } from '../../lib/pages-functions/session';
import { THROTTLES, clientIp } from '../../lib/pages-functions/throttle';

const PATH_MAX = 512;
const SLUG_MAX = 200;
const WALL_KIND_MAX = 64;
const METADATA_MAX_BYTES = 2048;

// A string field, or null when absent; a 400 (not a truncation) when over the cap, so
// a client bug shows up in its own console rather than as silently mangled analytics.
function boundedString(value: unknown, max: number): string | null | false {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') return false;
    return value.length <= max ? value : false;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const csrf = requireSameOrigin(context.request);
    if (csrf) return csrf;

    let body: any;
    try {
        body = await context.request.json();
    } catch {
        return jsonResponse({ message: 'Invalid JSON body.' }, { status: 400 });
    }

    const visitorId = typeof body?.visitorId === 'string' ? body.visitorId : '';
    const eventType = typeof body?.eventType === 'string' ? body.eventType : '';

    if (!UUID_RE.test(visitorId)) {
        return jsonResponse({ message: 'Missing or invalid visitorId.' }, { status: 400 });
    }
    if (!EVENT_TYPES.includes(eventType as EventType)) {
        return jsonResponse({ message: 'Unknown eventType.' }, { status: 400 });
    }

    const path = boundedString(body?.path, PATH_MAX);
    const tankSlug = boundedString(body?.tankSlug, SLUG_MAX);
    const wallKind = boundedString(body?.wallKind, WALL_KIND_MAX);
    if (path === false || tankSlug === false || wallKind === false) {
        return jsonResponse({ message: 'Field too long.' }, { status: 400 });
    }

    let metadata: string | null = null;
    if (body?.metadata !== undefined && body?.metadata !== null) {
        const m = body.metadata;
        if (typeof m !== 'object' || Array.isArray(m)) {
            return jsonResponse({ message: 'metadata must be an object.' }, { status: 400 });
        }
        const serialized = JSON.stringify(m);
        if (new TextEncoder().encode(serialized).length > METADATA_MAX_BYTES) {
            return jsonResponse({ message: 'metadata too large.' }, { status: 400 });
        }
        metadata = serialized;
    }

    const rule = THROTTLES.track;
    const ip = clientIp(context.request);
    const sql = getSql(context.env);
    try {
        // The `gate` CTE is throttle.ts's upsert verbatim (keep them in step); the
        // insert only fires while this IP is under its hourly cap.
        await sql`
            WITH gate AS (
                INSERT INTO request_throttles (bucket, subject, window_start, count)
                VALUES ('track', ${ip}, NOW(), 1)
                ON CONFLICT (bucket, subject) DO UPDATE SET
                    count = CASE
                        WHEN request_throttles.window_start < NOW() - (${rule.windowSeconds}::int * INTERVAL '1 second') THEN 1
                        ELSE request_throttles.count + 1
                    END,
                    window_start = CASE
                        WHEN request_throttles.window_start < NOW() - (${rule.windowSeconds}::int * INTERVAL '1 second') THEN NOW()
                        ELSE request_throttles.window_start
                    END
                RETURNING count
            )
            INSERT INTO events (visitor_id, waitlist_id, event_type, path, tank_slug, wall_kind, metadata)
            SELECT ${visitorId}, NULL, ${eventType}, ${path}, ${tankSlug}, ${wallKind}, ${metadata}::jsonb
            FROM gate
            WHERE gate.count <= ${rule.limit}::int
        `;
    } catch (err) {
        console.error('[POST /api/track] Error inserting event:', err);
        return jsonResponse({ message: 'Internal server error' }, { status: 500 });
    }

    return jsonResponse({ ok: true }, { status: 201 });
};
