// Small wrappers around the Discord REST API, used by the account-linking OAuth2
// flow (functions/api/discord/link.ts + callback.ts) and the publish-to-Discord
// sweep (functions/api/discord-sweep.ts). No SDK - Discord's REST surface used here
// is three plain HTTP calls, not worth a dependency.

import type { NeonQueryFunction } from '@neondatabase/serverless';
import type { Env } from './db';

// Discord permission bit for "Manage Server" - https://discord.com/developers/docs/topics/permissions
const MANAGE_GUILD_PERMISSION = 0x20n;

export const DEFAULT_COMMUNITY_POINTS_LABEL = 'Community Points';
export const DEFAULT_LEADERBOARD_LABEL = 'Leaderboard';

export interface GuildLabels {
    communityPointsLabel: string;
    leaderboardLabel: string;
}

// Resolves a guild's custom display names for "Community Points" and "Leaderboard"
// (set via `/heatchecks settings`, add_custom_labels_to_discord_guild_configs.sql),
// falling back to the defaults when unset - purely cosmetic, every caller that
// renders either word anywhere goes through this one place so a guild's choice is
// never applied in some spots and missed in others.
export async function getGuildLabels(sql: NeonQueryFunction<false, false>, guildId: string): Promise<GuildLabels> {
    const rows = await sql`SELECT community_points_label, leaderboard_label FROM discord_guild_configs WHERE guild_id = ${guildId}`;
    const row = rows[0] as unknown as { community_points_label: string | null; leaderboard_label: string | null } | undefined;
    return {
        communityPointsLabel: row?.community_points_label || DEFAULT_COMMUNITY_POINTS_LABEL,
        leaderboardLabel: row?.leaderboard_label || DEFAULT_LEADERBOARD_LABEL,
    };
}

// Server-authoritative permission check for every admin-only slash command
// (the /heatchecks admin hub: setup, settings, post, draw) -
// re-checked here against the invoking member's real permission bitfield rather than
// trusted solely from Discord's UI-level command visibility
// (default_member_permissions at registration time, scripts/register-discord-commands.ts).
// Discord sends permissions as a STRING (can exceed JS's safe integer range), hence BigInt.
export function hasManageGuildPermission(interaction: any): boolean {
    const permissions = BigInt(interaction?.member?.permissions ?? '0');
    return (permissions & MANAGE_GUILD_PERMISSION) !== 0n;
}

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

/** Best-effort: opens (or reuses) a DM channel with the given Discord user and sends a
 * message as the bot. Requires the bot to share a server with them - Discord's
 * `POST /users/@me/channels` 403s (code 50007) otherwise, e.g. someone who signed up
 * via /login/'s "Continue with Discord" button without ever joining the server.
 * Callers should treat failure as non-fatal (catch and log, never block on it) - same
 * posture as the verification-email send in functions/api/picks.ts. */
export async function sendDiscordDirectMessage(env: Env, discordUserId: string, content: string): Promise<void> {
    const dmRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
        method: 'POST',
        headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient_id: discordUserId }),
    });
    if (!dmRes.ok) {
        throw new Error(`Discord DM channel open failed: ${dmRes.status} ${await dmRes.text()}`);
    }
    const dmChannel = (await dmRes.json()) as { id: string };

    const msgRes = await fetch(`https://discord.com/api/v10/channels/${dmChannel.id}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
    });
    if (!msgRes.ok) {
        throw new Error(`Discord DM send failed: ${msgRes.status} ${await msgRes.text()}`);
    }
}

const MAX_RATE_LIMIT_RETRIES = 3;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Posts a message (embeds + components) to the given channel as the bot. Requires
 * the bot to already be a member of that channel's server with Send Messages
 * permission - see the plan's Developer Portal setup steps. Buttons on a bot-sent
 * message route their click interactions back to this application's Interactions
 * Endpoint URL, which a plain incoming webhook message would not. Returns the
 * created message id.
 *
 * channelId is per-call (not read off env) since the bot is now installable across
 * many guilds, each with its own configured channel (discord_guild_configs) - see
 * functions/api/discord-sweep.ts and functions/api/discord-settlement-sweep.ts.
 *
 * Discord's per-channel message-create limit is roughly 5 requests/5s - a sweep
 * posting several Tanks back-to-back can trip it well within that burst, observed
 * live: 3 of 10 posts 429'd on the first real run. Retries on 429 honoring the
 * response's retry_after (seconds) rather than a guessed fixed delay, up to
 * MAX_RATE_LIMIT_RETRIES - after that, throws so the caller's per-row error handling
 * (the posts row for that guild/Tank stays unwritten) picks it up on the next sweep. */
export async function postDiscordChannelMessage(
    env: Env,
    channelId: string,
    // embeds is optional so a content-only message works (the PvP challenge line is
    // one line of text, deliberately not a card); allowed_mentions lets a caller pin
    // exactly who gets pinged - see lib/pages-functions/pvp-card.ts.
    body: { content?: string; embeds?: unknown[]; components?: unknown[]; allowed_mentions?: unknown }
): Promise<string> {
    for (let attempt = 0; ; attempt++) {
        const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
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

// Strips the components off an already-posted message - used after a one-shot button
// is consumed (the "Draw a winner" button on a settlement recap), so the recap can't
// be clicked again once it's done its job. Best-effort by design: the draw itself is
// already committed and idempotent, so a failure here is cosmetic and never throws
// into the caller's response path.
export async function clearMessageComponents(env: Env, channelId: string, messageId: string): Promise<void> {
    try {
        await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
            method: 'PATCH',
            headers: {
                Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ components: [] }),
        });
    } catch (err) {
        console.error('[discord-api] clearMessageComponents failed:', err);
    }
}

export interface DiscordGuildMember {
    user: { id: string; username: string; global_name?: string | null; bot?: boolean; avatar?: string | null };
}

// Discord's avatar CDN pattern - derivable entirely from data fetchGuildMembers
// already returns, no extra API call. Animated avatar hashes are prefixed "a_" and
// only resolve under .gif; everything else is .png. Falls back to Discord's own
// default-avatar CDN (index 0-5, derived from the user id) when the member has never
// set a custom avatar.
// The guild's own icon ("server pfp") - used by the /me card's glow circle. One
// REST call; returns null when the server has no icon set (or the fetch fails),
// callers pick their own fallback.
export async function fetchGuildIconUrl(env: Env, guildId: string): Promise<string | null> {
    try {
        const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}`, {
            headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
        });
        if (!res.ok) return null;
        const guild = (await res.json()) as { icon?: string | null };
        if (!guild.icon) return null;
        const ext = guild.icon.startsWith('a_') ? 'gif' : 'png';
        return `https://cdn.discordapp.com/icons/${guildId}/${guild.icon}.${ext}?size=512`;
    } catch (err) {
        console.error('[discord-api] Guild icon fetch failed:', err);
        return null;
    }
}

export function buildDiscordAvatarUrl(userId: string, avatar: string | null | undefined): string {
    if (avatar) {
        const ext = avatar.startsWith('a_') ? 'gif' : 'png';
        // ?size=512 (vs the 128px default) - the leaderboard card cover-crops the
        // avatar across a wide banner, which looks blurry from a 128px source.
        // Custom avatars only; the default embed/avatars set doesn't reliably
        // support the size param.
        return `https://cdn.discordapp.com/avatars/${userId}/${avatar}.${ext}?size=512`;
    }
    const defaultIndex = Number((BigInt(userId) >> 22n) % 6n);
    return `https://cdn.discordapp.com/embed/avatars/${defaultIndex}.png`;
}

// Live guild-membership read for /leaderboard and the settlement-announcement sweep
// (functions/api/discord/interactions.ts, functions/api/discord-settlement-sweep.ts) -
// deliberately not cached/stored anywhere (no membership table to keep in sync or
// leak), same "compute from source at read time" convention balance-from-ledger and
// satisfaction-from-timestamp already follow elsewhere in this app. Requires the
// Server Members Intent toggle in the Developer Portal - without it Discord returns
// 403 even though this is a plain REST call, not a gateway subscription.
export async function fetchGuildMembers(env: Env, guildId: string): Promise<DiscordGuildMember[]> {
    const members: DiscordGuildMember[] = [];
    let after: string | undefined;
    // 10 pages * 1000 = 10k members ceiling - generous for this bot's expected scale;
    // revisit if a guild this large actually installs it.
    for (let page = 0; page < 10; page++) {
        const url = new URL(`https://discord.com/api/v10/guilds/${guildId}/members`);
        url.searchParams.set('limit', '1000');
        if (after) url.searchParams.set('after', after);
        const res = await fetch(url.toString(), { headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } });
        if (!res.ok) {
            throw new Error(`Discord guild members fetch failed: ${res.status} ${await res.text()}`);
        }
        const pageMembers = (await res.json()) as DiscordGuildMember[];
        members.push(...pageMembers);
        if (pageMembers.length < 1000) break;
        after = pageMembers[pageMembers.length - 1].user.id;
    }
    return members;
}

// ONE member, by id - the single-member endpoint rather than paging the whole roster.
// Used by /pvp, which only ever needs the handful of people in your own battles;
// fetchGuildMembers above (10 pages) is the wrong tool for that and would dominate the
// cost of every hub render. Falls back to a neutral label rather than throwing: a name
// missing from a screen is cosmetic, and a left-the-server opponent is a real case.
export async function fetchGuildMemberName(env: Env, guildId: string, discordUserId: string): Promise<string> {
    try {
        const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${discordUserId}`, {
            headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
        });
        if (!res.ok) return 'Someone';
        const member = (await res.json()) as { nick?: string | null; user?: { global_name?: string | null; username?: string } };
        return member.nick || member.user?.global_name || member.user?.username || 'Someone';
    } catch {
        return 'Someone';
    }
}
