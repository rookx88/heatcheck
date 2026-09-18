// Acceptance suite: server-only Tank calls from Discord (discord_tank_votes,
// lib/pages-functions/discord-tank-votes.ts). Anyone can call a Tank card for
// Community Points without an account; the call is one per person per Tank across
// guilds, never coexists with an Ember pick on the same Tank, closes at kickoff like an
// Ember pick, and - once settled - feeds the guild's draw pool, SR and XP.
//
// Settlement itself (functions/api/discord-settlement-sweep.ts) needs the live Discord
// roster and a market fetch, so it isn't driven here: the suite stamps results with the
// sweep's own UPDATE shape and checks everything downstream of it.

import { pool, check, section, type Suite } from '../harness';
import { createUser, insertTank, cleanupUsersByEmailPrefix, cleanupTanksBySlugPrefix } from '../fixtures';
import { getSql, type Env } from '../../../lib/pages-functions/db';
import { submitPick } from '../../../lib/pages-functions/picks';
import { recordTankVote, findTankVote } from '../../../lib/pages-functions/discord-tank-votes';
import { computeSkillRatings } from '../../../lib/pages-functions/skill-rating';
import { computeLevels } from '../../../lib/pages-functions/leveling';
import { drawGiveawayWinner } from '../../../lib/pages-functions/discord-draw';

const PREFIX = 'acceptance-dtv-';
const GUILD_A = 'acceptance-dtv-guild-a';
const GUILD_B = 'acceptance-dtv-guild-b';
const VOTER = 'acc-dtv-voter-1';
const LOSER = 'acc-dtv-voter-2';
const LINKED_DISCORD = 'acc-dtv-linked-1';

async function cleanup() {
    await pool.query(`DELETE FROM community_giveaway_draws WHERE guild_id LIKE 'acceptance-dtv-%'`);
    await pool.query(`DELETE FROM discord_tank_votes WHERE guild_id LIKE 'acceptance-dtv-%'`);
    await cleanupUsersByEmailPrefix(PREFIX);
    await cleanupTanksBySlugPrefix(PREFIX);
}

async function run() {
    await cleanup();
    section('Discord server-only Tank calls: anyone can call for Community Points, never Ember');

    const sql = getSql({ DATABASE_URL: process.env.DATABASE_URL } as Env);
    const slug = `${PREFIX}tank`;
    const tankId = await insertTank({ slug, marketId: `${slug}-market`, outcomes: ['Yes', 'No'], outcomePrices: [0.55, 0.45] });

    const first = await recordTankVote(sql, { guildId: GUILD_A, discordUserId: VOTER, linkedHeatchecksUserId: null, slug, sideIndex: 0 });
    check('unlinked member can call a Tank (status ok)', first.status === 'ok', JSON.stringify(first));
    check('call quotes the underdog-weighted points: round(100 × other side 0.45) = 45',
        first.status === 'ok' && first.pointsIfCorrect === 45, JSON.stringify(first));

    const again = await recordTankVote(sql, { guildId: GUILD_A, discordUserId: VOTER, linkedHeatchecksUserId: null, slug, sideIndex: 1 });
    check('second tap is refused and keeps the original side', again.status === 'already_voted' && again.side === 'Yes', JSON.stringify(again));

    const otherGuild = await recordTankVote(sql, { guildId: GUILD_B, discordUserId: VOTER, linkedHeatchecksUserId: null, slug, sideIndex: 1 });
    check('one call per person per Tank ACROSS guilds', otherGuild.status === 'already_voted', JSON.stringify(otherGuild));

    const found = await findTankVote(sql, slug, VOTER);
    check('findTankVote sees the call (the Ember-pick path refuses on it)', found?.side === 'Yes', JSON.stringify(found));

    const loser = await recordTankVote(sql, { guildId: GUILD_A, discordUserId: LOSER, linkedHeatchecksUserId: null, slug, sideIndex: 1 });
    check('a second member can call the other side', loser.status === 'ok', JSON.stringify(loser));

    // A linked member with an Ember pick on the Tank can't also hold a server-only call.
    const { userId } = await createUser(`${PREFIX}linked@example.com`);
    const pick = await submitPick(sql, { DAILY_PICK_CAP: '5' } as Env, { waitlistId: userId, slug, side: 'No', sideIndex: 1, source: 'app' });
    check('fixture Ember pick lands', pick.status === 'ok', JSON.stringify(pick));
    const dup = await recordTankVote(sql, { guildId: GUILD_A, discordUserId: LINKED_DISCORD, linkedHeatchecksUserId: userId, slug, sideIndex: 0 });
    check('a member with an Ember pick on this Tank is refused a server-only call', dup.status === 'already_picked' && dup.side === 'No', JSON.stringify(dup));

    // Kickoff closes server-only calls exactly as it closes Ember picks.
    const lateSlug = `${PREFIX}late`;
    await insertTank({ slug: lateSlug, marketId: `${lateSlug}-market`, outcomes: ['Yes', 'No'], outcomePrices: [0.5, 0.5] });
    await pool.query(
        `UPDATE tank_pages SET game_snapshot = jsonb_set(game_snapshot, '{game,kickoff}', to_jsonb($2::text)) WHERE slug = $1`,
        [lateSlug, new Date(Date.now() - 60_000).toISOString()],
    );
    const late = await recordTankVote(sql, { guildId: GUILD_A, discordUserId: VOTER, linkedHeatchecksUserId: null, slug: lateSlug, sideIndex: 0 });
    check('calls close at kickoff (game_started)', late.status === 'game_started', JSON.stringify(late));

    const { rows: emberRows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM picks WHERE tank_page_id = $1`, [tankId],
    );
    check('server-only calls never create picks rows (only the one Ember pick exists)', emberRows[0].n === 1, `picks=${emberRows[0].n}`);

    section('Settled server-only calls feed the guild draw pool, SR and XP');

    // The sweep's own settle UPDATE, winner = outcome 0 ('Yes').
    await pool.query(
        `UPDATE discord_tank_votes
         SET result = CASE WHEN outcome_index = 0 THEN 'correct' ELSE 'incorrect' END, settled_at = NOW()
         WHERE guild_id = $1 AND tank_page_id = $2 AND result IS NULL`,
        [GUILD_A, tankId],
    );

    // guildMembers: [] - no roster fetch; server-only callers join the pool without one.
    const draw = await drawGiveawayWinner(sql, {} as Env, { guildId: GUILD_A, sourceType: 'tank', sourceId: tankId, drawnBy: null, guildMembers: [] });
    check('draw picks the correct server-only caller, never the wrong one',
        draw.status === 'drawn' && draw.winnerDiscordUserId === VOTER, JSON.stringify(draw));

    const sr = await computeSkillRatings(sql, GUILD_A, [VOTER, LOSER]);
    check('SR counts server-only calls (winner rates above the loser)', (sr.get(VOTER) ?? 0) > (sr.get(LOSER) ?? 0), JSON.stringify([...sr]));
    const srOtherGuild = await computeSkillRatings(sql, GUILD_B, [VOTER]);
    check('SR is guild-scoped for server-only calls (guild B sees none)', (srOtherGuild.get(VOTER) ?? 0) < (sr.get(VOTER) ?? 0), JSON.stringify([...srOtherGuild]));

    const levels = await computeLevels(sql, GUILD_A, [VOTER, LOSER]);
    check('XP: correct call = 15 + 35 = 50', levels.get(VOTER)?.xp === 50, JSON.stringify(levels.get(VOTER)));
    check('XP: missed call = 15', levels.get(LOSER)?.xp === 15, JSON.stringify(levels.get(LOSER)));

    await cleanup();
}

export const suite: Suite = {
    name: 'discord-tank-votes',
    requiredEnv: ['DATABASE_URL'],
    run,
};
