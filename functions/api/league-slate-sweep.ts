// POST /api/league-slate-sweep - protected, machine-to-machine only (worker-curate's
// weekly cron slot - see worker-curate/src/index.ts's third event.cron branch).
//
// The automated half of NFL season leagues: for every guild with an active NFL
// league_seasons row, creates a Community Pick for every live NFL moneyline market
// this week. Reuses createAndPostCommunityPick (lib/pages-functions/
// community-pick-creation.ts) - the EXACT same insert-and-post path
// handleCommunityPickConfirm uses for an admin-triggered pick - this is a new
// trigger, not new pick-handling logic. These auto-picks are votable by anyone in
// the guild regardless of league membership; league membership only gates who counts
// on the league leaderboard (lib/pages-functions/discord-commands.ts's
// buildLeagueLeaderboardMessage).
//
// end_date on league_seasons is exactly what gates this job (the "active NFL
// season" query below simply won't return a guild whose season has ended) - manual
// /heatchecks-post community-pick posting is unaffected either way.
//
// Isolation reminder: this file never writes to ember_ledger, ember_balances,
// picks, or any shop table - only (via createAndPostCommunityPick) community_picks,
// and it reads league_seasons/discord_guild_configs.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../lib/pages-functions/db';
import { fetchLiveGames } from '../../tank-gamma-live';
import { createAndPostCommunityPick } from '../../lib/pages-functions/community-pick-creation';
import { computePointsSplit } from '../../lib/pages-functions/community-points-formula';

const LEAGUE_SPORT = 'NFL';

interface ActiveLeagueGuildRow {
    guild_id: string;
    channel_id: string;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const secret = context.request.headers.get('X-Curate-Secret');
    if (!secret || secret !== context.env.CURATE_SECRET) {
        return jsonResponse({ message: 'Unauthorized' }, { status: 401 });
    }

    const sql = getSql(context.env);
    const guildRows = (await sql`
        SELECT DISTINCT dgc.guild_id, dgc.channel_id
        FROM league_seasons ls
        JOIN discord_guild_configs dgc ON dgc.guild_id = ls.guild_id
        WHERE ls.sport = ${LEAGUE_SPORT} AND ls.end_date > NOW()
    `) as unknown as ActiveLeagueGuildRow[];

    if (guildRows.length === 0) {
        return jsonResponse({ guilds: 0, games: 0, created: 0, duplicate: 0, skippedNoOdds: 0, errors: [] });
    }

    // One shared fetch - the same live NFL slate applies to every qualifying guild,
    // no reason to re-fetch per guild.
    const games = await fetchLiveGames([LEAGUE_SPORT]);
    const moneylineGames = games.filter((g) => g.props.some((p) => p.market === 'moneyline'));

    let created = 0;
    let duplicate = 0;
    let skippedNoOdds = 0;
    const errors: string[] = [];

    for (const game of moneylineGames) {
        const prop = game.props.find((p) => p.market === 'moneyline')!;
        if (!prop.odds || prop.odds.outcomes.length !== 2) {
            skippedNoOdds++;
            continue;
        }
        const split = computePointsSplit(prop.odds.outcomePrices);
        if (!split) {
            skippedNoOdds++;
            continue;
        }

        const question = `${game.away} vs. ${game.home}`;
        // prop.settleDate (this specific market's own resolution deadline) over
        // Game.settleDate - see tank-types.ts's Prop.settleDate comment on why the
        // event-level date isn't reliable for any one prop.
        const resolveDate = prop.settleDate || game.settleDate || game.kickoff;

        for (const guild of guildRows) {
            try {
                const result = await createAndPostCommunityPick(sql, context.env, {
                    guildId: guild.guild_id,
                    channelId: guild.channel_id,
                    createdBy: null,
                    sport: LEAGUE_SPORT,
                    marketId: prop.id,
                    question,
                    sideALabel: prop.odds.outcomes[0],
                    sideBLabel: prop.odds.outcomes[1],
                    sourceOutcomes: prop.odds.outcomes,
                    sideAPoints: split.sideAPoints,
                    sideBPoints: split.sideBPoints,
                    resolveDate,
                    kickoffAt: game.kickoff ?? null,
                });
                if (result.status === 'duplicate') duplicate++;
                else created++;
            } catch (err) {
                console.error(`[POST /api/league-slate-sweep] Failed for guild ${guild.guild_id}, market ${prop.id}:`, err);
                errors.push(`${guild.guild_id}:${prop.id}`);
            }
        }
    }

    return jsonResponse({ guilds: guildRows.length, games: moneylineGames.length, created, duplicate, skippedNoOdds, errors });
};
