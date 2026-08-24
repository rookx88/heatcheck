// Small wrappers around the Discord REST API, used by the account-linking OAuth2
// flow (functions/api/discord/link.ts + callback.ts) and the publish-to-Discord
// sweep (functions/api/discord-sweep.ts). No SDK - Discord's REST surface used here
// is three plain HTTP calls, not worth a dependency.

import type { Env } from './db';

export interface DiscordUser {
    id: string;
    username: string;
}

export function buildDiscordAuthorizeUrl(env: Env, redirectUri: string, state: string): string {
    const url = new URL('https://discord.com/oauth2/authorize');
    url.searchParams.set('client_id', env.DISCORD_CLIENT_ID);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'identify');
    url.searchParams.set('state', state);
    return url.toString();
}

/** Exchanges an OAuth2 authorization code for an access token, then resolves it to
 * the identify-scope Discord user. Throws on any non-2xx response - callers decide
 * how to surface that (the callback route redirects to /account/?discord=error). */
export async function exchangeDiscordCode(env: Env, code: string, redirectUri: string): Promise<DiscordUser> {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: env.DISCORD_CLIENT_ID,
            client_secret: env.DISCORD_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
        }),
    });
    if (!tokenRes.ok) {
        throw new Error(`Discord token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
    }
    const tokenBody = (await tokenRes.json()) as { access_token: string };

    const userRes = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${tokenBody.access_token}` },
    });
    if (!userRes.ok) {
        throw new Error(`Discord user fetch failed: ${userRes.status} ${await userRes.text()}`);
    }
    const user = (await userRes.json()) as { id: string; username: string };
    return { id: user.id, username: user.username };
}

/** Posts a message (embeds + components) to a channel as the bot. Requires the bot
 * to already be a member of that channel's server with Send Messages permission -
 * see the plan's Developer Portal setup steps. Buttons on a bot-sent message route
 * their click interactions back to this application's Interactions Endpoint URL,
 * which a plain incoming webhook message would not. Returns the created message id. */
export async function postDiscordChannelMessage(
    env: Env,
    body: { embeds: unknown[]; components: unknown[] }
): Promise<string> {
    const res = await fetch(`https://discord.com/api/v10/channels/${env.DISCORD_CHANNEL_ID}/messages`, {
        method: 'POST',
        headers: {
            Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        throw new Error(`Discord message post failed: ${res.status} ${await res.text()}`);
    }
    const message = (await res.json()) as { id: string };
    return message.id;
}
