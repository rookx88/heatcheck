// GET /api/discord/link - starts the Discord OAuth2 flow. Works both logged in (link
// Discord to my existing account) and logged out (a Discord-originated visitor with no
// Heatchecks account yet, or one signing back in on a new device - see callback.ts's
// no-session branch). Redirects to Discord's own consent screen; the `state` param is
// a signed, short-TTL token recording whether a session existed when the flow started
// (the callback trusts that recorded intent, not whatever session state happens to
// exist when Discord redirects back) - since Discord's redirect back is a top-level
// GET, requireSameOrigin's Sec-Fetch-Site/Origin checks don't apply to it, so this
// token IS the CSRF protection for that leg.

import type { PagesFunction } from '@cloudflare/workers-types';
import { type Env } from '../../../lib/pages-functions/db';
import { getSession, resolveLoginOrigin } from '../../../lib/pages-functions/session';
import { signAuthToken } from '../../../lib/pages-functions/auth-tokens';
import { buildDiscordAuthorizeUrl } from '../../../lib/pages-functions/discord-api';
import type { DiscordLinkTokenPayload } from '../../../lib/auth-token-payloads';

const STATE_TTL_SECONDS = 10 * 60;

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const session = await getSession(context.request, context.env);

    const state = await signAuthToken<DiscordLinkTokenPayload>(
        { userId: session ? session.userId : '', purpose: 'discord_link' },
        context.env.SESSION_TOKEN_SECRET,
        STATE_TTL_SECONDS
    );
    const redirectUri = `${resolveLoginOrigin(context.request.url, context.env)}/api/discord/callback`;
    const authorizeUrl = buildDiscordAuthorizeUrl(context.env, redirectUri, state);

    return new Response(null, {
        status: 302,
        headers: {
            Location: authorizeUrl,
            ...(session?.refreshedSetCookie ? { 'Set-Cookie': session.refreshedSetCookie } : {}),
        },
    });
};
