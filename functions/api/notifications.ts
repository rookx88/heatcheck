// GET /api/notifications - the account's notification feed, newest first. read_at and
// claimed_at are surfaced independently so the toolbar can render the two states (viewed
// vs collected) separately. Empty for a new account.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../lib/pages-functions/db';
import { getSession, requireOnboarded } from '../../lib/pages-functions/session';

interface NotificationRow {
    id: string;
    type: string;
    message: string;
    ref_type: string | null;
    ref_id: string | null;
    read_at: string | null;
    claimed_at: string | null;
    created_at: string;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const session = await getSession(context.request, context.env);
    if (!session) return jsonResponse({ message: 'Login required.' }, { status: 401 });
    const gate = requireOnboarded(session);
    if (gate) return gate;
    const authHeaders = session.refreshedSetCookie ? { 'Set-Cookie': session.refreshedSetCookie } : undefined;

    const sql = getSql(context.env);
    const rows = await sql`
        SELECT id, type, message, ref_type, ref_id, read_at, claimed_at, created_at
        FROM notifications WHERE user_id = ${session.userId}
        ORDER BY created_at DESC
        LIMIT 100
    `;
    const notifications = (rows as unknown as NotificationRow[]).map((r) => ({
        id: r.id,
        type: r.type,
        message: r.message,
        refType: r.ref_type,
        refId: r.ref_id,
        readAt: r.read_at,
        claimedAt: r.claimed_at,
        createdAt: r.created_at,
    }));
    return jsonResponse({ notifications }, { headers: authHeaders });
};
