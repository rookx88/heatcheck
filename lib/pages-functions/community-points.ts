// The Community Points ledger - the one write path for community_points_transactions
// and community_points. Deliberately a SEPARATE file from lib/pages-functions/
// ledger.ts (the real Ember ledger), not an extension of it: nothing in here ever
// touches ember_ledger, ember_balances, picks, or any shop/inventory table - see
// create_community_picks_tables.sql's header comment for why that isolation is
// enforced at the schema level, not just by keeping the write paths in different
// files. This file mirrors ledger.ts#post()'s exact CTE shape on purpose (append the
// transaction, fold it into the cached balance in the same statement so a no-op
// insert on a retried idempotency key can never double-credit the cache) - proven
// pattern, not reinvented.

import type { NeonQueryFunction } from '@neondatabase/serverless';

export type CommunityPointsSourceType = 'tank' | 'community_pick';

export function buildCommunityPointsIdempotencyKey(
    guildId: string,
    discordUserId: string,
    sourceType: CommunityPointsSourceType,
    sourceId: string
): string {
    return `points:${guildId}:${discordUserId}:${sourceType}:${sourceId}`;
}

export interface AwardCommunityPointsInput {
    guildId: string;
    discordUserId: string;
    // Backfilled onto community_points opportunistically when known - never required,
    // Community Picks allow unlinked participation (see create_community_picks_tables.sql).
    linkedHeatchecksUserId: string | null;
    delta: number;
    sourceType: CommunityPointsSourceType;
    sourceId: string;
}

// Idempotent: a retried award for the same (guild, user, source) is a safe no-op -
// the transactions INSERT's ON CONFLICT DO NOTHING means the balance CTE below it
// only ever sees a row (and only ever updates the cache) when the transaction was
// genuinely new.
export async function awardCommunityPoints(sql: NeonQueryFunction<false, false>, input: AwardCommunityPointsInput): Promise<void> {
    await awardCommunityPointsBatch(sql, [input]);
}

// Every award in one statement. The settlement sweeps award one row per correct picker
// or voter per Tank per guild, and calling the single form in a loop was the only
// unbounded per-row round trip left in the codebase - a popular Tank in a busy guild
// meant one Neon call per participant (efficiency audit, 2026-09-19).
//
// Same guarantees as the single form, and they matter here: the transactions insert is
// the idempotent one (ON CONFLICT DO NOTHING on the key), so the cache upsert below
// only ever sees genuinely new rows. Deltas are summed per (guild, user) BEFORE the
// cache upsert, because one batch can legitimately carry several awards for the same
// person - without the sum, ON CONFLICT DO UPDATE would apply only the last one.
export async function awardCommunityPointsBatch(sql: NeonQueryFunction<false, false>, inputs: AwardCommunityPointsInput[]): Promise<void> {
    if (inputs.length === 0) return;
    const guildIds = inputs.map((i) => i.guildId);
    const userIds = inputs.map((i) => i.discordUserId);
    const linked = inputs.map((i) => i.linkedHeatchecksUserId);
    const deltas = inputs.map((i) => i.delta);
    const sourceTypes = inputs.map((i) => i.sourceType);
    const sourceIds = inputs.map((i) => i.sourceId);
    const keys = inputs.map((i) => buildCommunityPointsIdempotencyKey(i.guildId, i.discordUserId, i.sourceType, i.sourceId));
    await sql`
        WITH input AS (
            SELECT * FROM unnest(
                ${guildIds}::text[], ${userIds}::text[], ${linked}::uuid[], ${deltas}::int[],
                ${sourceTypes}::text[], ${sourceIds}::text[], ${keys}::text[]
            ) AS t(guild_id, discord_user_id, linked_heatchecks_user_id, delta, source_type, source_id, idempotency_key)
        ), ins AS (
            INSERT INTO community_points_transactions (guild_id, discord_user_id, delta, source_type, source_id, idempotency_key)
            SELECT guild_id, discord_user_id, delta, source_type, source_id, idempotency_key FROM input
            ON CONFLICT (idempotency_key) DO NOTHING
            RETURNING guild_id, discord_user_id, delta
        ), agg AS (
            SELECT guild_id, discord_user_id, SUM(delta)::int AS delta FROM ins GROUP BY guild_id, discord_user_id
        ), known_link AS (
            SELECT DISTINCT ON (guild_id, discord_user_id) guild_id, discord_user_id, linked_heatchecks_user_id
            FROM input WHERE linked_heatchecks_user_id IS NOT NULL
            ORDER BY guild_id, discord_user_id
        )
        INSERT INTO community_points (guild_id, discord_user_id, linked_heatchecks_user_id, points, updated_at)
        SELECT a.guild_id, a.discord_user_id, l.linked_heatchecks_user_id, a.delta, NOW()
        FROM agg a LEFT JOIN known_link l ON l.guild_id = a.guild_id AND l.discord_user_id = a.discord_user_id
        ON CONFLICT (guild_id, discord_user_id) DO UPDATE
            SET points = community_points.points + EXCLUDED.points,
                linked_heatchecks_user_id = COALESCE(EXCLUDED.linked_heatchecks_user_id, community_points.linked_heatchecks_user_id),
                updated_at = NOW()
    `;
}

// Recomputes the true point total from the transactions log and resets the cache to
// match - reconciliation helper, mirrors ledger.ts#rebuildBalance() exactly. Never
// called in a normal write path; transactions are the source of truth, this table is
// always reconstructable from them.
export async function rebuildCommunityPoints(sql: NeonQueryFunction<false, false>, guildId: string, discordUserId: string): Promise<number> {
    const rows = await sql`
        SELECT COALESCE(SUM(delta), 0) AS total FROM community_points_transactions
        WHERE guild_id = ${guildId} AND discord_user_id = ${discordUserId}
    `;
    const total = Number((rows[0] as unknown as { total: number }).total);
    await sql`
        INSERT INTO community_points (guild_id, discord_user_id, points, updated_at)
        VALUES (${guildId}, ${discordUserId}, ${total}, NOW())
        ON CONFLICT (guild_id, discord_user_id) DO UPDATE SET points = EXCLUDED.points, updated_at = NOW()
    `;
    return total;
}
