// Small wrappers around the Discord REST API, used by the account-linking OAuth2
// flow (functions/api/discord/link.ts + callback.ts) and the publish-to-Discord
// sweep (functions/api/discord-sweep.ts). No SDK - Discord's REST surface used here
// is three plain HTTP calls, not worth a dependency.

import type { Env } from './db';

export interface DiscordUser {
    id: string;
    username: string;
    // Present only when the `email` scope was granted and Discord has a verified
    // address on file for this account. emailVerified is Discord's own flag, not
    // ours - callers (functions/api/discord/callback.ts's no-session branch) must
    // check it before trusting email for account creation/matching; an unverified
    // Discord email proves nothing about ownership.
    email: string | null;
    emailVerified: boolean;
}

// identify+email rather than identify alone: the no-session path in
// functions/api/discord/callback.ts needs a verified email to create or match a
// waitlist account. Requesting it unconditionally (even on the already-logged-in
// "link" path) keeps this to one authorize-URL shape instead of two - harmless there,
// since that path never reads DiscordUser.email at all.
export function buildDiscordAuthorizeUrl(env: Env, redirectUri: string, state: string): string {
    const url = new URL('https://discord.com/oauth2/authorize');
    url.searchParams.set('client_id', env.DISCORD_CLIENT_ID);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'identify email');
    url.searchParams.set('state', state);
    return url.toString();
}

/** Exchanges an OAuth2 authorization code for an access token, then resolves it to
 * the Discord user (identify+email scope). Throws on any non-2xx response - callers
 * decide how to surface that (the callback route redirects to an error state). */
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
    const user = (await userRes.json()) as { id: string; username: string; email?: string | null; verified?: boolean };
    return {
        id: user.id,
        username: user.username,
        email: user.email ?? null,
        emailVerified: Boolean(user.email && user.verified),
    };
}

const MAX_RATE_LIMIT_RETRIES = 3;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Posts a message (embeds + components) to a channel as the bot. Requires the bot
 * to already be a member of that channel's server with Send Messages permission -
 * see the plan's Developer Portal setup steps. Buttons on a bot-sent message route
 * their click interactions back to this application's Interactions Endpoint URL,
 * which a plain incoming webhook message would not. Returns the created message id.
 *
 * Discord's per-channel message-create limit is roughly 5 requests/5s - a sweep
 * posting several Tanks back-to-back (functions/api/discord-sweep.ts) can trip it
 * well within that burst, observed live: 3 of 10 posts 429'd on the first real run.
 * Retries on 429 honoring the response's retry_after (seconds) rather than a guessed
 * fixed delay, up to MAX_RATE_LIMIT_RETRIES - after that, throws so the caller's
 * per-row error handling (discord_posted_at stays NULL) picks it up on the next sweep. */
export async function postDiscordChannelMessage(
    env: Env,
    body: { embeds: unknown[]; components: unknown[] }
): Promise<string> {
    for (let attempt = 0; ; attempt++) {
        const res = await fetch(`https://discord.com/api/v10/channels/${env.DISCORD_CHANNEL_ID}/messages`, {
            method: 'POST',
            headers: {
                Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });
        if (res.ok) {
            const message = (await res.json()) as { id: string };
            return message.id;
        }
        if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
            const responseText = await res.text();
            let retryAfterSeconds = Number(res.headers.get('Retry-After'));
            try {
                const parsed = JSON.parse(responseText) as { retry_after?: number };
                if (typeof parsed.retry_after === 'number') retryAfterSeconds = parsed.retry_after;
            } catch {
                // Fall back to the header value already read above.
            }
            if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 0) retryAfterSeconds = 1;
            await sleep(retryAfterSeconds * 1000 + 100); // +100ms slack past Discord's own window
            continue;
        }
        throw new Error(`Discord message post failed: ${res.status} ${await res.text()}`);
    }
}
