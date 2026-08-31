// A member's head-to-head PvP record (wins-draws-losses) in one guild, DERIVED on
// read from settled pvp_battles rows - never a stored column, exactly like
// lib/pages-functions/skill-rating.ts and leveling.ts. Nothing writes a record
// anywhere; a battle settling is the only event, and this re-counts from scratch
// every time it's asked. That means backfills, corrections, and re-settlements are
// all automatically reflected with no reconciliation step.
//
// Deliberately imports nothing but types: it's read by discord-commands.ts (for the
// /me card) AND by pvp.ts (for the /pvp hub), and pvp.ts already imports
// discord-commands.ts - keeping this standalone is what stops that from becoming an
// import cycle.
//
// Isolation reminder: reads pvp_battles only. Writes nothing, and never touches
// ember_ledger/ember_balances/picks/community_* or any shop table.

import type { NeonQueryFunction } from '@neondatabase/serverless';

export interface PvpRecord {
    w: number;
    d: number;
    l: number;
}

export const EMPTY_PVP_RECORD: PvpRecord = { w: 0, d: 0, l: 0 };

export function formatPvpRecord(record: PvpRecord | null | undefined): string | null {
    if (!record) return null;
    if (record.w + record.d + record.l === 0) return null;
    return `${record.w}-${record.d}-${record.l}`;
}

interface PvpRecordRow {
    discord_user_id: string;
    w: number;
    d: number;
    l: number;
}

/**
 * W-D-L per Discord user for one guild, counting only settled battles. Ids with no
 * settled battles are absent from the returned Map (callers decide whether that means
 * a zeroed record or hiding the stat entirely - the /me card hides it).
 */
export async function computePvpRecords(
    sql: NeonQueryFunction<false, false>,
    guildId: string,
    discordUserIds: string[]
): Promise<Map<string, PvpRecord>> {
    if (discordUserIds.length === 0) return new Map();

    // The loss predicate tests outcome <> 'draw' FIRST on purpose:
    // winner_discord_user_id is NULL on a draw, so a bare "winner is not me" would
    // count every draw as a loss as well.
    const rows = (await sql`
        SELECT u.id AS discord_user_id,
               COUNT(*) FILTER (WHERE b.winner_discord_user_id = u.id)::int AS w,
               COUNT(*) FILTER (WHERE b.outcome = 'draw')::int AS d,
               COUNT(*) FILTER (WHERE b.outcome <> 'draw' AND b.winner_discord_user_id IS DISTINCT FROM u.id)::int AS l
        FROM unnest(${discordUserIds}::text[]) AS u(id)
        JOIN pvp_battles b
          ON b.guild_id = ${guildId}
         AND b.status = 'settled'
         AND (b.challenger_id = u.id OR b.opponent_id = u.id)
        GROUP BY u.id
    `) as unknown as PvpRecordRow[];

    const byId = new Map<string, PvpRecord>();
    for (const row of rows) {
        byId.set(row.discord_user_id, { w: Number(row.w), d: Number(row.d), l: Number(row.l) });
    }
    return byId;
}
