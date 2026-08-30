// XP + leveling for the /me card's LVL stat (lib/pages-functions/me-card.ts).
// DERIVED, never stored - XP is computed from data settlement already writes
// (picks, votes, community points), the same posture as SR
// (lib/pages-functions/skill-rating.ts): no new settlement write paths, history is
// retroactively credited, idempotent by construction. Per-guild, like Community
// Points and the card itself.
//
//   XP = 15 × participation + 35 × correct + community_points
//        participation = settled Tank picks + settled Community Pick votes
//        correct       = correct picks + correct votes
//
// Participation always pays; being right pays ~3.3x more on top, and the
// community-points term folds in the underdog weighting (a longshot win is worth far
// more XP than chalk). A typical correct call lands ~100 XP vs 15 for a miss.
//
// Curve: cumulative XP to REACH level L = XP_BASE × (L-1)^XP_EXPONENT - fast early
// (first correct call usually hits Level 2 on the spot), stretching out later.
// LEVEL 27 IS THE FINAL LEVEL (the card's Apex gold/black tier): ~9,200 XP, a
// genuine full-season grind.
//
// Isolation reminder: read-only against picks/community tables; writes nothing,
// touches no Ember tables.

import type { NeonQueryFunction } from '@neondatabase/serverless';

const XP_PER_PARTICIPATION = 15;
const XP_PER_CORRECT = 35;
const XP_BASE = 50;
const XP_EXPONENT = 1.6;
export const MAX_LEVEL = 27;

export interface LevelInfo {
    xp: number;
    level: number;        // 1..MAX_LEVEL
    xpIntoLevel: number;  // progress within the current level
    xpForNext: number | null; // XP span of the current level; null at MAX_LEVEL
}

export function xpToReachLevel(level: number): number {
    return Math.round(XP_BASE * Math.pow(Math.max(0, level - 1), XP_EXPONENT));
}

export function levelForXp(xp: number): number {
    if (xp <= 0) return 1;
    return Math.min(MAX_LEVEL, Math.floor(Math.pow(xp / XP_BASE, 1 / XP_EXPONENT)) + 1);
}

export function levelInfoForXp(xp: number): LevelInfo {
    const level = levelForXp(xp);
    const floor = xpToReachLevel(level);
    if (level >= MAX_LEVEL) return { xp, level, xpIntoLevel: xp - floor, xpForNext: null };
    return { xp, level, xpIntoLevel: xp - floor, xpForNext: xpToReachLevel(level + 1) - floor };
}

export async function computeLevels(
    sql: NeonQueryFunction<false, false>,
    guildId: string,
    discordUserIds: string[]
): Promise<Map<string, LevelInfo>> {
    if (discordUserIds.length === 0) return new Map();

    const [tankRows, voteRows, pointsRows] = await Promise.all([
        sql`
            SELECT dl.discord_user_id,
                   COUNT(*)::int AS settled,
                   COUNT(*) FILTER (WHERE p.result = 'correct')::int AS correct
            FROM picks p JOIN discord_links dl ON dl.waitlist_id = p.waitlist_id
            WHERE dl.discord_user_id = ANY(${discordUserIds}::text[]) AND p.result IS NOT NULL
            GROUP BY dl.discord_user_id
        ` as unknown as Promise<{ discord_user_id: string; settled: number; correct: number }[]>,
        sql`
            SELECT cpv.discord_user_id,
                   COUNT(*)::int AS settled,
                   COUNT(*) FILTER (WHERE cpv.side_chosen = cp.winning_side)::int AS correct
            FROM community_picks_votes cpv
            JOIN community_picks cp ON cp.id = cpv.community_pick_id
            WHERE cp.guild_id = ${guildId} AND cp.status = 'settled' AND cp.winning_side IS NOT NULL
              AND cpv.discord_user_id = ANY(${discordUserIds}::text[])
            GROUP BY cpv.discord_user_id
        ` as unknown as Promise<{ discord_user_id: string; settled: number; correct: number }[]>,
        sql`
            SELECT discord_user_id, points FROM community_points
            WHERE guild_id = ${guildId} AND discord_user_id = ANY(${discordUserIds}::text[])
        ` as unknown as Promise<{ discord_user_id: string; points: number }[]>,
    ]);

    const tanksById = new Map(tankRows.map((r) => [r.discord_user_id, r]));
    const votesById = new Map(voteRows.map((r) => [r.discord_user_id, r]));
    const pointsById = new Map(pointsRows.map((r) => [r.discord_user_id, Number(r.points)]));

    const out = new Map<string, LevelInfo>();
    for (const id of discordUserIds) {
        const participation = (tanksById.get(id)?.settled ?? 0) + (votesById.get(id)?.settled ?? 0);
        const correct = (tanksById.get(id)?.correct ?? 0) + (votesById.get(id)?.correct ?? 0);
        const points = Math.max(0, pointsById.get(id) ?? 0);
        const xp = XP_PER_PARTICIPATION * participation + XP_PER_CORRECT * correct + points;
        out.set(id, levelInfoForXp(xp));
    }
    return out;
}
