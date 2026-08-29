// POST /api/weekly-leaderboard-sweep - protected, machine-to-machine only
// (worker-curate's Sunday-evening cron slot). Posts the leaderboard image card to
// every guild that opted in via the setup wizard (discord_guild_configs.
// weekly_leaderboard, a JSONB array of views: "community" | "accuracy" | "sr").
// The retention ritual for the Competition-hub archetype - the card posts itself
// weekly instead of waiting for someone to run /leaderboard.
//
// Reuses the exact same builders the /leaderboard command uses (one per view) and
// the same image-first/embeds-fallback delivery, just addressed to the guild's
// channel as a bot message rather than an interaction reply.
//
// Isolation reminder: read-only against picks/community tables; writes nothing.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../lib/pages-functions/db';
import { buildCommunityPointsLeaderboardMessage, buildSrLeaderboardMessage } from '../../lib/pages-functions/discord-commands';
import { buildAccuracyLeaderboardMessage } from './discord/interactions';
import { postLeaderboardToChannel } from '../../lib/pages-functions/leaderboard-image';

interface GuildRow {
    guild_id: string;
    channel_id: string;
    weekly_leaderboard: string[] | string;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const secret = context.request.headers.get('X-Curate-Secret');
    if (!secret || secret !== context.env.CURATE_SECRET) {
        return jsonResponse({ message: 'Unauthorized' }, { status: 401 });
    }

    const sql = getSql(context.env);
    const guilds = (await sql`
        SELECT guild_id, channel_id, weekly_leaderboard FROM discord_guild_configs
        WHERE weekly_leaderboard IS NOT NULL AND weekly_leaderboard != '[]'::jsonb
    `) as unknown as GuildRow[];

    let posted = 0;
    const errors: string[] = [];

    for (const guild of guilds) {
        const views: string[] = Array.isArray(guild.weekly_leaderboard)
            ? guild.weekly_leaderboard
            : JSON.parse(guild.weekly_leaderboard ?? '[]');

        for (const view of views) {
            try {
                const message =
                    view === 'community' ? await buildCommunityPointsLeaderboardMessage(context.env, guild.guild_id)
                    : view === 'sr' ? await buildSrLeaderboardMessage(context.env, guild.guild_id)
                    : view === 'accuracy' ? await buildAccuracyLeaderboardMessage(context.env, guild.guild_id)
                    : null;
                if (!message || message.rows.length === 0) continue; // nothing to show - skip silently, no empty weekly spam
                await postLeaderboardToChannel(context.env, guild.channel_id, message.content, message.headerLabel, message.rows);
                posted++;
            } catch (err) {
                console.error(`[POST /api/weekly-leaderboard-sweep] Failed for guild ${guild.guild_id} view ${view}:`, err);
                errors.push(`${guild.guild_id}:${view}`);
            }
        }
    }

    return jsonResponse({ guilds: guilds.length, posted, errors });
};
