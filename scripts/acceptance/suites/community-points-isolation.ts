// Acceptance suite: Community Points must never touch the real Ember economy - the
// isolation create_community_picks_tables.sql's header comment states as a hard
// requirement, proven here rather than assumed. Awards Community Points to a linked
// test account and asserts BY DIRECT QUERY that zero ember_ledger/ember_balances/
// inventory_items rows moved as a result, AND that no foreign key exists at the
// schema level from any Community table into the real ledger/picks tables - the
// isolation is enforced by the schema, not just by which code paths happen to be
// called today.

import { pool, check, section, type Suite } from '../harness';
import { createUser, cleanupUsersByEmailPrefix } from '../fixtures';
import { getSql, type Env } from '../../../lib/pages-functions/db';
import { awardCommunityPoints } from '../../../lib/pages-functions/community-points';

const PREFIX = 'acceptance-community-points-';
const TEST_GUILD_ID = 'acceptance-test-guild-cp';
const TEST_DISCORD_USER_ID = 'acceptance-test-discord-user-cp';

async function cleanup() {
    await cleanupUsersByEmailPrefix(PREFIX);
    await pool.query(`DELETE FROM community_points_transactions WHERE guild_id = $1`, [TEST_GUILD_ID]);
    await pool.query(`DELETE FROM community_points WHERE guild_id = $1`, [TEST_GUILD_ID]);
}

interface RealEconomySnapshot { ledger_rows: number; balance_rows: number; inventory_rows: number }

async function realEconomySnapshot(userId: string): Promise<RealEconomySnapshot> {
    const { rows } = await pool.query(
        `SELECT
            (SELECT COUNT(*)::int FROM ember_ledger WHERE user_id = $1) AS ledger_rows,
            (SELECT COUNT(*)::int FROM ember_balances WHERE user_id = $1) AS balance_rows,
            (SELECT COUNT(*)::int FROM inventory_items WHERE user_id = $1) AS inventory_rows`,
        [userId],
    );
    return rows[0] as RealEconomySnapshot;
}

async function run() {
    await cleanup();
    section('Community Points isolation - never touches the real Ember economy');

    const { userId } = await createUser(`${PREFIX}linked@example.com`);
    const sql = getSql({ DATABASE_URL: process.env.DATABASE_URL } as Env);

    const before = await realEconomySnapshot(userId);

    await awardCommunityPoints(sql, {
        guildId: TEST_GUILD_ID,
        discordUserId: TEST_DISCORD_USER_ID,
        linkedHeatchecksUserId: userId,
        delta: 1,
        sourceType: 'tank',
        sourceId: 'fixture-tank-id',
    });

    const after = await realEconomySnapshot(userId);
    check(
        'zero ember_ledger/ember_balances/inventory_items rows created by a Community Points award',
        JSON.stringify(before) === JSON.stringify(after),
        `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
    );

    const { rows: pointsRows } = await pool.query(
        `SELECT points FROM community_points WHERE guild_id = $1 AND discord_user_id = $2`,
        [TEST_GUILD_ID, TEST_DISCORD_USER_ID],
    );
    check('community_points credited exactly 1', pointsRows[0]?.points === 1, JSON.stringify(pointsRows[0]));

    // Idempotency: re-awarding the same (guild, user, source) must not double-credit.
    await awardCommunityPoints(sql, {
        guildId: TEST_GUILD_ID,
        discordUserId: TEST_DISCORD_USER_ID,
        linkedHeatchecksUserId: userId,
        delta: 1,
        sourceType: 'tank',
        sourceId: 'fixture-tank-id',
    });
    const { rows: pointsRows2 } = await pool.query(
        `SELECT points FROM community_points WHERE guild_id = $1 AND discord_user_id = $2`,
        [TEST_GUILD_ID, TEST_DISCORD_USER_ID],
    );
    check('re-awarding the same source is a no-op (idempotency_key held)', pointsRows2[0]?.points === 1, JSON.stringify(pointsRows2[0]));

    // Schema-level check: no FK from any Community table into the real ledger/picks
    // tables - the isolation is structural, not just a property of which code
    // happens to run today.
    const { rows: fkRows } = await pool.query(`
        SELECT tc.table_name, ccu.table_name AS foreign_table
        FROM information_schema.table_constraints tc
        JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_name IN ('community_points', 'community_points_transactions', 'community_picks', 'community_picks_votes', 'community_giveaway_draws')
          AND ccu.table_name IN ('ember_ledger', 'ember_balances', 'picks')
    `);
    check('zero foreign keys from any Community table into ember_ledger/ember_balances/picks', fkRows.length === 0, JSON.stringify(fkRows));

    await cleanup();
}

export const suite: Suite = {
    name: 'community-points-isolation',
    requiredEnv: ['DATABASE_URL'],
    run,
};
