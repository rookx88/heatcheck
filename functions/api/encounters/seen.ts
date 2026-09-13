// POST /api/encounters/seen - the player finished (or closed) a character's dialogue.
// Flips the encounter to 'seen' so toolbar-state stops offering it. Nothing else moves:
// every grant happened when the encounter was created (create_encounters.sql), and a
// closed dialogue counts the same as a finished one - closing by any means is seen.
// Idempotent (COALESCE keeps the first seen_at) and scoped to the session's own rows.
// Same shape as functions/api/notifications/read.ts.

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
    if (!id) return jsonResponse({ message: 'Missing or invalid encounter id.' }, { status: 400, headers: authHeaders });

    const sql = getSql(context.env);
    const rows = await sql`
        UPDATE encounters SET status = 'seen', seen_at = COALESCE(seen_at, NOW())
        WHERE id = ${id} AND user_id = ${session.userId}
        RETURNING id, seen_at
    `;
    if (rows.length === 0) {
        return jsonResponse({ message: 'Encounter not found.' }, { status: 404, headers: authHeaders });
    }
    return jsonResponse({ ok: true, seenAt: rows[0].seen_at }, { headers: authHeaders });
};
