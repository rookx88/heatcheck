// SR (Skill Rating) - the blended per-user, per-guild stat shown on the /leaderboard
// card (lib/pages-functions/leaderboard-image.ts). 0-1000 scale, weighted blend of
// three 0-1 components:
//
//   SR = round(1000 × (0.45·A + 0.30·D + 0.25·V))
//
//   A  accuracy      (correct + K/2) / (settled + K) pooled across real-Tank picks
//                    AND Community Pick votes - Bayesian smoothing toward 50% with
//                    K=5 phantom picks, replacing a hard minimum-picks floor:
//                    1-for-1 reads ~0.58, not a gamed-looking 1.0, and the prior's
//                    pull fades as real volume accumulates.
//   D  difficulty    average over WON picks of (1 − implied prob of the chosen
//                    side) - "when you win, how unlikely was it?" Chalk-only
//                    winners trend ~0.3, longshot hitters 0.7+. Zero with no wins.
//   V  points volume min(1, log10(1 + community_points) / 3) - log-scaled so early
//                    points matter most, saturating at 1,000 points.
//
// Implied probabilities: real Tanks store the picker's own frozen
// picks.implied_prob_at_lock (the same value Ember payouts use - read here, never
// recomputed). Community Picks lock underdog-weighted side points at creation
// (side_a_points = round(100 × P(side B))), so the chosen side's implied prob is
// recoverable as the OPPOSITE side's points / 100.
//
// Display-only: nothing ranks or pays out by SR, and this file is read-only against
// picks/community tables - it never touches ember_ledger/ember_balances or writes
// anything at all.

import type { NeonQueryFunction } from '@neondatabase/serverless';

const WEIGHT_ACCURACY = 0.45;
const WEIGHT_DIFFICULTY = 0.3;
const WEIGHT_VOLUME = 0.25;
const ACCURACY_PRIOR_STRENGTH = 5; // K phantom picks at 50%
const VOLUME_SATURATION_LOG10 = 3; // log10(1000) - points beyond 1,000 stop adding

interface TankStatsRow {
    discord_user_id: string;
    settled: number;
    correct: number;
    win_difficulty_sum: number; // Σ (1 - implied_prob_at_lock) over correct picks
}

interface VoteStatsRow {
    discord_user_id: string;
    settled: number;
    correct: number;
    win_difficulty_sum: number;
}

interface PointsRow {
    discord_user_id: string;
    points: number;
}

export async function computeSkillRatings(
    sql: NeonQueryFunction<false, false>,
    guildId: string,
    discordUserIds: string[]
): Promise<Map<string, number>> {
    if (discordUserIds.length === 0) return new Map();

    const [tankRows, voteRows, pointsRows] = await Promise.all([
        // Real-Tank picks: all of a member's settled picks, same (deliberately
        // guild-agnostic) scoping the accuracy leaderboard already uses - a pick is
        // one shared account-level thing, only the points below are guild-scoped.
        sql`
            SELECT dl.discord_user_id,
                   COUNT(*)::int AS settled,
                   COUNT(*) FILTER (WHERE p.result = 'correct')::int AS correct,
                   COALESCE(SUM(1 - p.implied_prob_at_lock) FILTER (WHERE p.result = 'correct'), 0)::float8 AS win_difficulty_sum
            FROM picks p
            JOIN discord_links dl ON dl.waitlist_id = p.waitlist_id
            WHERE dl.discord_user_id = ANY(${discordUserIds}::text[]) AND p.result IS NOT NULL
            GROUP BY dl.discord_user_id
        ` as unknown as Promise<TankStatsRow[]>,
        // Community Pick votes on settled picks in THIS guild. LEAST/GREATEST clamp
        // the recovered probability into [0,1] against rounding at the edges.
        sql`
            SELECT cpv.discord_user_id,
                   COUNT(*)::int AS settled,
                   COUNT(*) FILTER (WHERE cpv.side_chosen = cp.winning_side)::int AS correct,
                   COALESCE(SUM(
                       1 - LEAST(1, GREATEST(0,
                           (CASE WHEN cpv.side_chosen = 0 THEN cp.side_b_points ELSE cp.side_a_points END) / 100.0
                       ))
                   ) FILTER (WHERE cpv.side_chosen = cp.winning_side), 0)::float8 AS win_difficulty_sum
            FROM community_picks_votes cpv
            JOIN community_picks cp ON cp.id = cpv.community_pick_id
            WHERE cp.guild_id = ${guildId} AND cp.status = 'settled' AND cp.winning_side IS NOT NULL
              AND cpv.discord_user_id = ANY(${discordUserIds}::text[])
            GROUP BY cpv.discord_user_id
        ` as unknown as Promise<VoteStatsRow[]>,
        sql`
            SELECT discord_user_id, points FROM community_points
            WHERE guild_id = ${guildId} AND discord_user_id = ANY(${discordUserIds}::text[])
        ` as unknown as Promise<PointsRow[]>,
    ]);

    const tankById = new Map(tankRows.map((r) => [r.discord_user_id, r]));
    const votesById = new Map(voteRows.map((r) => [r.discord_user_id, r]));
    const pointsById = new Map(pointsRows.map((r) => [r.discord_user_id, Number(r.points)]));

    const ratings = new Map<string, number>();
    for (const id of discordUserIds) {
        const tanks = tankById.get(id);
        const votes = votesById.get(id);
        const settled = (tanks?.settled ?? 0) + (votes?.settled ?? 0);
        const correct = (tanks?.correct ?? 0) + (votes?.correct ?? 0);
        const winDifficultySum = (tanks?.win_difficulty_sum ?? 0) + (votes?.win_difficulty_sum ?? 0);
        const points = pointsById.get(id) ?? 0;

        const accuracy = (correct + ACCURACY_PRIOR_STRENGTH / 2) / (settled + ACCURACY_PRIOR_STRENGTH);
        const difficulty = correct > 0 ? winDifficultySum / correct : 0;
        const volume = Math.min(1, Math.log10(1 + Math.max(0, points)) / VOLUME_SATURATION_LOG10);

        ratings.set(id, Math.round(1000 * (WEIGHT_ACCURACY * accuracy + WEIGHT_DIFFICULTY * difficulty + WEIGHT_VOLUME * volume)));
    }
    return ratings;
}
