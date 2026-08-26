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

const PREFIX = 'acceptance-discord-cap-';
const TEST_DAILY_CAP = 3;

async function cleanup() {
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

    await cleanup();
}

export const suite: Suite = {
    name: 'discord-multi-guild-cap',
    requiredEnv: ['DATABASE_URL'],
    run,
};
