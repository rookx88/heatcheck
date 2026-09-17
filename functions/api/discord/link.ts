// GET /api/discord/link - starts the Discord OAuth2 flow. Works both logged in (link
// Discord to my existing account) and logged out (a Discord-originated visitor with no
// Heatchecks account yet, or one signing back in on a new device - see callback.ts's
// no-session branch). Redirects to Discord's own consent screen; the `state` param is
// a signed, short-TTL token recording whether a session existed when the flow started
// (the callback trusts that recorded intent, not whatever session state happens to
// exist when Discord redirects back) - since Discord's redirect back is a top-level
// GET, requireSameOrigin's Sec-Fetch-Site/Origin checks don't apply to it, so this
// token IS the CSRF protection for that leg.
//
// The token alone is not enough, though: it proves the flow was started by SOMEONE,
// not by THIS browser. So the same random nonce goes into the token and into a
// short-lived HttpOnly cookie scoped to the callback path, and callback.ts requires
// both. A callback URL captured from one browser is then useless in any other.

import type { PagesFunction } from '@cloudflare/workers-types';
import { type Env } from '../../../lib/pages-functions/db';
import { getSession, resolveLoginOrigin, isSecureRequest } from '../../../lib/pages-functions/session';
import { signAuthToken } from '../../../lib/pages-functions/auth-tokens';
import { buildDiscordAuthorizeUrl } from '../../../lib/pages-functions/discord-api';
import type { DiscordLinkTokenPayload } from '../../../lib/auth-token-payloads';

const STATE_TTL_SECONDS = 10 * 60;

// Shared with callback.ts: the cookie that carries the flow nonce. Path-scoped to the
// callback so it rides no other request, and it lives exactly as long as the token.
export const DISCORD_LINK_COOKIE = 'hc_discord_link';
export const DISCORD_LINK_COOKIE_PATH = '/api/discord/';

export function buildDiscordLinkCookie(nonce: string, secure: boolean): string {
    return `${DISCORD_LINK_COOKIE}=${nonce}; Path=${DISCORD_LINK_COOKIE_PATH}; Max-Age=${STATE_TTL_SECONDS}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function buildClearDiscordLinkCookie(secure: boolean): string {
    return `${DISCORD_LINK_COOKIE}=; Path=${DISCORD_LINK_COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const session = await getSession(context.request, context.env);

    const nonce = crypto.randomUUID();
    const state = await signAuthToken<DiscordLinkTokenPayload>(
        { userId: session ? session.userId : '', purpose: 'discord_link', nonce },
        context.env.SESSION_TOKEN_SECRET,
        STATE_TTL_SECONDS
    );
    const redirectUri = `${resolveLoginOrigin(context.request.url, context.env)}/api/discord/callback`;
    const authorizeUrl = buildDiscordAuthorizeUrl(context.env, redirectUri, state);

    const headers = new Headers({ Location: authorizeUrl });
    headers.append('Set-Cookie', buildDiscordLinkCookie(nonce, isSecureRequest(context.request.url)));
    if (session?.refreshedSetCookie) headers.append('Set-Cookie', session.refreshedSetCookie);
    return new Response(null, { status: 302, headers });
};
