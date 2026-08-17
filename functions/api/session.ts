// GET /api/session - the client's "am I logged in?" check on load. Returns the
// session's minimal identity or 401; an expired/invalid cookie just gets the 401
// (no cookie-clearing here - a dead cookie is harmless and logout owns clearing).

import type { PagesFunction } from '@cloudflare/workers-types';
import { jsonResponse, type Env } from '../../lib/pages-functions/db';
import { getSession } from '../../lib/pages-functions/session';

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const session = await getSession(context.request, context.env);
    if (!session) {
        return jsonResponse({ message: 'Login required.' }, { status: 401 });
    }
    return jsonResponse(
        {
            userId: session.userId,
            email: session.email,
            verified: session.verified,
            username: session.username,
            onboarded: session.onboarded,
        },
        session.refreshedSetCookie ? { headers: { 'Set-Cookie': session.refreshedSetCookie } } : {}
    );
};
