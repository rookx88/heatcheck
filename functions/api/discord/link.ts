// GET /api/discord/link - starts the Discord account-linking OAuth2 flow. Requires an
// existing Heatchecks session (this is website-initiated, never Discord-initiated:
// the session is the only trusted "who is this" available at the point the flow
// starts). Redirects to Discord's own consent screen; the `state` param is a signed,
// short-TTL token binding the eventual callback back to this session's userId - since
// Discord's redirect back is a top-level GET, requireSameOrigin's Sec-Fetch-Site/
// Origin checks don't apply to it, so this token IS the CSRF protection for that leg.

import type { PagesFunction } from '@cloudflare/workers-types';
import { jsonResponse, type Env } from '../../../lib/pages-functions/db';
import { getSession, resolveLoginOrigin } from '../../../lib/pages-functions/session';
import { signAuthToken } from '../../../lib/pages-functions/auth-tokens';
import { buildDiscordAuthorizeUrl } from '../../../lib/pages-functions/discord-api';
import type { DiscordLinkTokenPayload } from '../../../lib/auth-token-payloads';

const STATE_TTL_SECONDS = 10 * 60;

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const session = await getSession(context.request, context.env);
    if (!session) return jsonResponse({ message: 'Login required.' }, { status: 401 });

    const state = await signAuthToken<DiscordLinkTokenPayload>(
        { userId: session.userId, purpose: 'discord_link' },
        context.env.SESSION_TOKEN_SECRET,
        STATE_TTL_SECONDS
    );
    const redirectUri = `${resolveLoginOrigin(context.request.url, context.env)}/api/discord/callback`;
    const authorizeUrl = buildDiscordAuthorizeUrl(context.env, redirectUri, state);

    return new Response(null, {
        status: 302,
        headers: {
            Location: authorizeUrl,
            ...(session.refreshedSetCookie ? { 'Set-Cookie': session.refreshedSetCookie } : {}),
        },
    });
};
