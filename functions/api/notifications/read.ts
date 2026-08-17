// POST /api/notifications/read - mark one notification viewed. Writes ONLY read_at,
// never claimed_at: viewing a message is a different action from collecting its reward,
// and the two must stay independent. Idempotent (COALESCE keeps the first read_at) and
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
        UPDATE notifications SET read_at = COALESCE(read_at, NOW())
        WHERE id = ${id} AND user_id = ${session.userId}
        RETURNING id, read_at
    `;
    if (rows.length === 0) {
        return jsonResponse({ message: 'Notification not found.' }, { status: 404, headers: authHeaders });
    }
    return jsonResponse({ ok: true, readAt: rows[0].read_at }, { headers: authHeaders });
};
