// POST /api/notifications/claim - mark one notification claimed. Presentational only
// this build: it stamps claimed_at and reveals what already happened (settlement Ember
// was paid at settle time) - it moves no Ember and rolls no item. Writes ONLY
// claimed_at, never read_at - the two are independent actions. Idempotent (COALESCE) and
// scoped to the session's own rows.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, UUID_RE, type Env } from '../../../lib/pages-functions/db';
import { getSession, requireSameOrigin, requireOnboarded } from '../../../lib/pages-functions/session';

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const csrf = requireSameOrigin(context.request);
    if (csrf) return csrf;

    const session = await getSession(context.request, context.env);
    if (!session) return jsonResponse({ message: 'Login required.' }, { status: 401 });
    const gate = requireOnboarded(session);
    if (gate) return gate;
    const authHeaders = session.refreshedSetCookie ? { 'Set-Cookie': session.refreshedSetCookie } : undefined;

    let body: any;
    try {
        body = await context.request.json();
    } catch {
        return jsonResponse({ message: 'Invalid JSON body.' }, { status: 400, headers: authHeaders });
    }
    const id = typeof body?.id === 'string' && UUID_RE.test(body.id) ? body.id : '';
    if (!id) return jsonResponse({ message: 'Missing or invalid notification id.' }, { status: 400, headers: authHeaders });

    const sql = getSql(context.env);
    const rows = await sql`
        UPDATE notifications SET claimed_at = COALESCE(claimed_at, NOW())
        WHERE id = ${id} AND user_id = ${session.userId}
        RETURNING id, claimed_at
    `;
    if (rows.length === 0) {
        return jsonResponse({ message: 'Notification not found.' }, { status: 404, headers: authHeaders });
    }
    return jsonResponse({ ok: true, claimedAt: rows[0].claimed_at }, { headers: authHeaders });
};
