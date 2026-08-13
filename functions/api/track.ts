// POST /api/track - anonymous funnel/read-depth events. Fire-and-forget from the
// client's perspective: always fast, never blocks the actual UX. Only ever logs
// waitlist_id=null here (pre-conversion events) - picks.ts/verify-email.ts attach
// the real waitlist_id once a visitor converts, bridging their anonymous history.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, UUID_RE, type Env } from '../../lib/pages-functions/db';
import { logEvent, EVENT_TYPES, type EventType } from '../../lib/pages-functions/events';

export const onRequestPost: PagesFunction<Env> = async (context) => {
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

    const sql = getSql(context.env);
    try {
        await logEvent(sql, {
            visitorId,
            eventType: eventType as EventType,
            path: typeof body?.path === 'string' ? body.path : null,
            tankSlug: typeof body?.tankSlug === 'string' ? body.tankSlug : null,
            wallKind: typeof body?.wallKind === 'string' ? body.wallKind : null,
            metadata: body?.metadata,
        });
    } catch (err) {
        console.error('[POST /api/track] Error inserting event:', err);
        return jsonResponse({ message: 'Internal server error' }, { status: 500 });
    }

    return jsonResponse({ ok: true }, { status: 201 });
};
