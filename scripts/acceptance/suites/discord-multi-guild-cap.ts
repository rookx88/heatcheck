// Acceptance suite: the daily pick cap must stay ONE shared pool per Heatchecks
// account, never per-guild, even as the Discord bot goes multi-guild (see the
// multi-guild plan's section 2). This is a REGRESSION GUARD, not a proof that
// guild-scoping needs adding: submitPick's cap query (lib/pages-functions/picks.ts)
// already has zero guild dimension - guild context never even reaches it
// (functions/api/discord/interactions.ts resolves discord_user_id -> waitlist_id and
// calls submitPick exactly the same way regardless of which guild's copy of a Tank's
// message was clicked). This suite calls submitPick directly - the same production
// function both the website and every guild's interactions ultimately call - to
// simulate two different guilds' picks plus one website pick against the same
// account, and asserts the cap is enforced against their COMBINED total. If anyone
// ever adds a guild/source dimension to that cap query, this fails.

import { pool, check, section, type Suite } from '../harness';
import { createUser, insertTank, cleanupUsersByEmailPrefix, cleanupTanksBySlugPrefix } from '../fixtures';
import { getSql, type Env } from '../../../lib/pages-functions/db';
import { submitPick } from '../../../lib/pages-functions/picks';
import { DiscordApiError, isGuildUnreachable, markGuildUnreachable, clearGuildUnreachable } from '../../../lib/pages-functions/discord-api';

const PREFIX = 'acceptance-discord-cap-';
const TEST_DAILY_CAP = 3;
const GONE_GUILD_ID = 'acceptance-gone-guild';

async function cleanup() {
    await pool.query(`DELETE FROM discord_guild_configs WHERE guild_id = $1`, [GONE_GUILD_ID]);
    await cleanupUsersByEmailPrefix(PREFIX);
    await cleanupTanksBySlugPrefix(PREFIX);
}

async function run() {
    await cleanup();
    section('Discord multi-guild: daily pick cap stays one shared pool per account, never per-guild');

    const { userId } = await createUser(`${PREFIX}shared-cap@example.com`);

    // Four distinct Tanks so each pick is genuinely new, never blocked by the
    // separate per-Tank "already picked this" conflict instead of the cap under test.
    const slugs = ['a', 'b', 'c', 'd'].map((letter) => `${PREFIX}tank-${letter}`);
    for (const slug of slugs) {
        await insertTank({ slug, marketId: `${slug}-market`, outcomes: ['Yes', 'No'], outcomePrices: [0.55, 0.45] });
    }

    // submitPick's env param is only ever read for DAILY_PICK_CAP - a minimal stub
    // pins the cap to a known value for this test regardless of the real deployment's
    // current setting.
    const env = { DAILY_PICK_CAP: String(TEST_DAILY_CAP) } as Env;
    const sql = getSql({ DATABASE_URL: process.env.DATABASE_URL } as Env);

    // Pick 1: simulating a Discord button click from "guild A".
    const pick1 = await submitPick(sql, env, { waitlistId: userId, slug: slugs[0], side: 'Yes', sideIndex: 0, source: 'app' });
    check('pick 1 (simulated guild A) succeeds', pick1.status === 'ok', JSON.stringify(pick1));

    // Pick 2: simulating a Discord button click from a DIFFERENT "guild B". Guild is
    // never actually passed to submitPick at all (it has no such parameter) - that
    // absence is exactly the property this suite exists to guard.
    const pick2 = await submitPick(sql, env, { waitlistId: userId, slug: slugs[1], side: 'Yes', sideIndex: 0, source: 'app' });
    check(
        'pick 2 (simulated guild B, same account) succeeds and counts against the SAME pool as guild A (picksToday=2)',
        pick2.status === 'ok' && pick2.picksToday === 2,
        JSON.stringify(pick2),
    );

    // Pick 3: simulating an ordinary website pick - same source:'app', no separate lane.
    const pick3 = await submitPick(sql, env, { waitlistId: userId, slug: slugs[2], side: 'Yes', sideIndex: 0, source: 'app' });
    check(
        `pick 3 (simulated website pick) succeeds and reaches the cap (picksToday=${TEST_DAILY_CAP})`,
        pick3.status === 'ok' && pick3.picksToday === TEST_DAILY_CAP,
        JSON.stringify(pick3),
    );

    // Pick 4, from either origin, must now be rejected - the actual assertion: 3
    // picks TOTAL across two guilds plus the website, not 3 per surface.
    const pick4 = await submitPick(sql, env, { waitlistId: userId, slug: slugs[3], side: 'Yes', sideIndex: 0, source: 'app' });
    check(
        '[CRITICAL] 4th pick (any origin) is rejected once the shared cap is reached - proves the pool is combined, not per-guild/per-surface',
        pick4.status === 'cap_reached',
        JSON.stringify(pick4),
    );

    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM picks WHERE waitlist_id = $1`, [userId]);
    check(`exactly ${TEST_DAILY_CAP} picks rows exist for this account, not 4`, rows[0].n === TEST_DAILY_CAP, `rows=${rows[0].n}`);

    // ===============================================================================
    section('A guild the bot was removed from is marked unreachable and skipped');
    // ===============================================================================
    // Found live 2026-09-20: one guild returned 404 from Discord (the bot had been
    // removed), and the posting sweep re-failed all ten of its posts every run, alerting
    // daily about a job that could never succeed. The mark is what stops that; the config
    // row survives so a re-invite keeps the admin's settings.
    {
        // discord_guild_configs.guild_id is VARCHAR(32) (real snowflakes are ~19 chars),
        // so this fixture id is short rather than PREFIX-based.
        const guildId = GONE_GUILD_ID;
        await pool.query(
            `INSERT INTO discord_guild_configs (guild_id, channel_id, configured_by_discord_user_id)
             VALUES ($1, 'acceptance-channel', 'acceptance-admin')
             ON CONFLICT (guild_id) DO UPDATE SET channel_id = EXCLUDED.channel_id, unreachable_at = NULL, unreachable_reason = NULL`,
            [guildId],
        );
        const sweepSees = async () => {
            const { rows: r } = await pool.query(
                `SELECT COUNT(*)::int AS n FROM discord_guild_configs WHERE guild_id = $1 AND unreachable_at IS NULL`, [guildId]);
            return r[0].n === 1;
        };
        check('a freshly configured guild is swept', await sweepSees());

        check('isGuildUnreachable: 404 and 403 mark it, other failures do not',
            isGuildUnreachable(new DiscordApiError('gone', 404)) === 404
            && isGuildUnreachable(new DiscordApiError('forbidden', 403)) === 403
            && isGuildUnreachable(new DiscordApiError('server error', 500)) === null
            && isGuildUnreachable(new Error('fetch failed')) === null);

        await markGuildUnreachable(sql, guildId, 404, 'discord-sweep: acceptance');
        check('after marking, the sweeps no longer see it', (await sweepSees()) === false);
        const { rows: reason } = await pool.query(`SELECT unreachable_reason FROM discord_guild_configs WHERE guild_id = $1`, [guildId]);
        check('the reason records the status for a human', String(reason[0].unreachable_reason).startsWith('HTTP 404'), reason[0].unreachable_reason);

        const { rows: kept } = await pool.query(`SELECT channel_id FROM discord_guild_configs WHERE guild_id = $1`, [guildId]);
        check('the guild config survives - a re-invite keeps the admin\'s settings', kept[0].channel_id === 'acceptance-channel');

        await clearGuildUnreachable(sql, guildId);
        check('clearing the mark (what the setup wizard does on re-setup) puts it back in the sweeps', await sweepSees());
    }

    await cleanup();
}

export const suite: Suite = {
    name: 'discord-multi-guild-cap',
    requiredEnv: ['DATABASE_URL'],
    run,
};
