// Shared giveaway-draw logic: builds the eligible pool for a settled source and picks
// one winner at random. Used by both /heatchecks-draw (manual, functions/api/discord/
// interactions.ts) and the auto-draw call sites (functions/api/discord-settlement-
// sweep.ts, functions/api/community-pick-settlement-sweep.ts, when a guild's
// discord_guild_configs.auto_draw_enabled is set) - one function, so a manual draw and
// an auto-triggered draw can never behave differently.
//
// Heatchecks never supplies, holds, or distributes an actual prize - this module's
// only output is a Discord user id. No prize-value field, no payout logic, anywhere
// in this file.

import type { NeonQueryFunction } from '@neondatabase/serverless';
import type { Env } from './db';
import { fetchGuildMembers } from './discord-api';

export type GiveawaySourceType = 'tank' | 'community_pick';

export interface DrawGiveawayInput {
    guildId: string;
    sourceType: GiveawaySourceType;
    sourceId: string;
    drawnBy: string | null; // null when auto-triggered rather than run by an admin
}

export type DrawGiveawayResult =
    | { status: 'drawn'; winnerDiscordUserId: string }
    | { status: 'already_drawn'; winnerDiscordUserId: string }
    | { status: 'no_pool' };

async function buildEligiblePool(
    sql: NeonQueryFunction<false, false>,
    env: Env,
    input: DrawGiveawayInput
): Promise<string[]> {
    if (input.sourceType === 'tank') {
        // Guild scope isn't inherent for a real Tank (it can post to many guilds), so
        // the pool has to be cross-referenced against THIS guild's live membership -
        // same fetchGuildMembers call /leaderboard already uses.
        const members = await fetchGuildMembers(env, input.guildId);
        const memberIds = members.filter((m) => !m.user.bot).map((m) => m.user.id);
        if (memberIds.length === 0) return [];
        const rows = await sql`
            SELECT DISTINCT dl.discord_user_id
            FROM discord_links dl
            JOIN picks p ON p.waitlist_id = dl.waitlist_id
            WHERE dl.discord_user_id = ANY(${memberIds}::text[])
              AND p.tank_page_id = ${input.sourceId} AND p.result = 'correct'
        `;
        return (rows as unknown as { discord_user_id: string }[]).map((r) => r.discord_user_id);
    }

    // Community Pick: guild scope is inherent - votes only ever exist for a pick
    // created inside one guild, no live-membership cross-check needed.
    const rows = await sql`
        SELECT cpv.discord_user_id
        FROM community_picks_votes cpv
        JOIN community_picks cp ON cp.id = cpv.community_pick_id
        WHERE cpv.community_pick_id = ${input.sourceId} AND cpv.side_chosen = cp.winning_side
    `;
    return (rows as unknown as { discord_user_id: string }[]).map((r) => r.discord_user_id);
}

// Idempotent via community_giveaway_draws' own UNIQUE (guild_id, source_type,
// source_id) constraint - the real guarantee, not just the pre-check below (which is
// just an optimization to skip pool-building work on an obvious repeat; a genuine
// race between two concurrent draw attempts is resolved by the INSERT's conflict,
// never by two winners existing for one source).
export async function drawGiveawayWinner(
    sql: NeonQueryFunction<false, false>,
    env: Env,
    input: DrawGiveawayInput
): Promise<DrawGiveawayResult> {
    const existing = await sql`
        SELECT winner_discord_user_id FROM community_giveaway_draws
        WHERE guild_id = ${input.guildId} AND source_type = ${input.sourceType} AND source_id = ${input.sourceId}
    `;
    if (existing.length > 0) {
        return { status: 'already_drawn', winnerDiscordUserId: (existing[0] as unknown as { winner_discord_user_id: string }).winner_discord_user_id };
    }

    const pool = await buildEligiblePool(sql, env, input);
    if (pool.length === 0) return { status: 'no_pool' };

    // Not a financial/adversarial context (no prize is ever handled by this system) -
    // Math.random() is fine, no need for anything cryptographic.
    const winner = pool[Math.floor(Math.random() * pool.length)];

    try {
        await sql`
            INSERT INTO community_giveaway_draws (guild_id, source_type, source_id, winner_discord_user_id, drawn_by)
            VALUES (${input.guildId}, ${input.sourceType}, ${input.sourceId}, ${winner}, ${input.drawnBy})
        `;
        return { status: 'drawn', winnerDiscordUserId: winner };
    } catch (err: any) {
        if (err.code === '23505') {
            // A concurrent draw attempt won the race between our pre-check and this
            // insert - return THEIR winner rather than erroring or drawing twice.
            const rows = await sql`
                SELECT winner_discord_user_id FROM community_giveaway_draws
                WHERE guild_id = ${input.guildId} AND source_type = ${input.sourceType} AND source_id = ${input.sourceId}
            `;
            const row = rows[0] as unknown as { winner_discord_user_id: string } | undefined;
            if (row) return { status: 'already_drawn', winnerDiscordUserId: row.winner_discord_user_id };
        }
        throw err;
    }
}
