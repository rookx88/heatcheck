// GET /api/discord/callback - Discord's OAuth2 redirect target. Verifies the signed
// `state` param minted by GET /api/discord/link (that's the CSRF protection for this
// leg - see link.ts), exchanges the code for the user's Discord identity, and upserts
// discord_links. Always redirects to /account/ with a query flag rather than
// returning JSON - this is a top-level browser navigation, not a fetch().

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, type Env } from '../../../lib/pages-functions/db';
import { resolveLoginOrigin } from '../../../lib/pages-functions/session';
import { verifyAuthToken } from '../../../lib/pages-functions/auth-tokens';
import { exchangeDiscordCode } from '../../../lib/pages-functions/discord-api';
import type { DiscordLinkTokenPayload } from '../../../lib/auth-token-payloads';

function redirectToAccount(origin: string, discordResult: 'linked' | 'error' | 'taken'): Response {
    return new Response(null, {
        status: 302,
        headers: { Location: `${origin}/account/?discord=${discordResult}` },
    });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const origin = resolveLoginOrigin(context.request.url, context.env);
    const url = new URL(context.request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) return redirectToAccount(origin, 'error');

    const payload = await verifyAuthToken<DiscordLinkTokenPayload>(state, context.env.SESSION_TOKEN_SECRET, 'discord_link');
    if (!payload) return redirectToAccount(origin, 'error');

    let discordUser;
    try {
        discordUser = await exchangeDiscordCode(context.env, code, `${origin}/api/discord/callback`);
    } catch (err) {
        console.error('[GET /api/discord/callback] Discord code exchange failed:', err);
        return redirectToAccount(origin, 'error');
    }

    const sql = getSql(context.env);
    try {
        await sql`
            INSERT INTO discord_links (waitlist_id, discord_user_id, discord_username)
            VALUES (${payload.userId}, ${discordUser.id}, ${discordUser.username})
            ON CONFLICT (waitlist_id) DO UPDATE
                SET discord_user_id = EXCLUDED.discord_user_id,
                    discord_username = EXCLUDED.discord_username,
                    linked_at = NOW()
        `;
    } catch (err: any) {
        if (err.code === '23505') { // idx_discord_links_discord_user_id - this Discord account is already linked elsewhere
            return redirectToAccount(origin, 'taken');
        }
        console.error('[GET /api/discord/callback] Error upserting discord_links row:', err);
        return redirectToAccount(origin, 'error');
    }

    return redirectToAccount(origin, 'linked');
};
