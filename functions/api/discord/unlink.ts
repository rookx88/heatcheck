// POST /api/discord/unlink - removes the calling account's discord_links row.
// Session + CSRF required, same posture as any other state-changing account action.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../../lib/pages-functions/db';
import { getSession, requireSameOrigin } from '../../../lib/pages-functions/session';

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const csrf = requireSameOrigin(context.request);
    if (csrf) return csrf;

    const session = await getSession(context.request, context.env);
    if (!session) return jsonResponse({ message: 'Login required.' }, { status: 401 });

    const sql = getSql(context.env);
    await sql`DELETE FROM discord_links WHERE waitlist_id = ${session.userId}`;

    return jsonResponse(
        { unlinked: true },
        session.refreshedSetCookie ? { headers: { 'Set-Cookie': session.refreshedSetCookie } } : {}
    );
};
