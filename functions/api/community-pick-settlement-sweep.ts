// POST /api/community-pick-settlement-sweep - protected, machine-to-machine only.
// Rides worker-settle's cron as a sibling call (same posture as
// functions/api/discord-settlement-sweep.ts: own request, own subrequest budget,
// fires regardless of the other sweeps' outcomes).
//
// Community Picks are structurally separate from picks/tank_pages (no shared rows),
// so they get their own resolution path here rather than hooking into
// functions/api/settle.ts - but reuse the EXACT SAME resolution primitives real
// settlement uses (lib/pages-functions/gamma.ts's fetchMarket/resolveMarket/
// outcomeOrderMismatch), including the outcome-order-mismatch hardening: a Community
// Pick resolving without it would be less safe than a real Tank pick, silently (see
// create_community_picks_tables.sql's comment on source_outcomes).
//
// Isolation reminder: this file never writes to ember_ledger, ember_balances, picks,
// or any shop table - only community_picks/community_points(_transactions)/
// community_giveaway_draws.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../lib/pages-functions/db';
import { fetchMarket, resolveMarket, outcomeOrderMismatch } from '../../lib/pages-functions/gamma';
import { postDiscordChannelMessage } from '../../lib/pages-functions/discord-api';
import { buildCommunitySettlementRecapMessage, buildGiveawayResultMessage, buildNoEligiblePoolMessage } from '../../lib/pages-functions/discord-community-card';
import { awardCommunityPoints } from '../../lib/pages-functions/community-points';
import { drawGiveawayWinner } from '../../lib/pages-functions/discord-draw';

const MAX_PER_RUN = 20;
const POINTS_PER_CORRECT_VOTE = 1;

interface OpenPickRow {
    id: string;
    guild_id: string;
    channel_id: string;
    auto_draw_enabled: boolean;
    source_market_id: string;
    question_text: string;
    side_a_label: string;
    side_b_label: string;
    source_outcomes: string[] | string;
}

interface VoteRow {
    discord_user_id: string;
    linked_heatchecks_user_id: string | null;
    side_chosen: number;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const secret = context.request.headers.get('X-Settle-Secret');
    if (!secret || secret !== context.env.SETTLE_SECRET) {
        return jsonResponse({ message: 'Unauthorized' }, { status: 401 });
    }

    const sql = getSql(context.env);
    const openPicks = (await sql`
        SELECT cp.id, cp.guild_id, dgc.channel_id, dgc.auto_draw_enabled,
               cp.source_market_id, cp.question_text, cp.side_a_label, cp.side_b_label, cp.source_outcomes
        FROM community_picks cp
        JOIN discord_guild_configs dgc ON dgc.guild_id = cp.guild_id
        WHERE cp.status = 'open'
        ORDER BY cp.created_at ASC
        LIMIT ${MAX_PER_RUN}
    `) as unknown as OpenPickRow[];

    let settled = 0;
    let pendingNotClosed = 0;
    const errors: string[] = [];

    for (const row of openPicks) {
        try {
            const resolution = resolveMarket(await fetchMarket(row.source_market_id));
            if (resolution.status !== 'resolved') {
                pendingNotClosed++;
                continue;
            }
            const sourceOutcomes: string[] = Array.isArray(row.source_outcomes)
                ? row.source_outcomes
                : JSON.parse(row.source_outcomes);
            if (outcomeOrderMismatch(resolution.outcomes, sourceOutcomes)) {
                // Leave it open rather than guess - same posture functions/api/settle.ts
                // takes on a real mismatch. Retried next run; if Polymarket's live
                // order never stabilizes this stays pending indefinitely, which is
                // the honest outcome here (no safe answer exists).
                console.error(`[POST /api/community-pick-settlement-sweep] Outcome order mismatch for ${row.id} (market ${row.source_market_id})`);
                errors.push(`${row.id}:order_mismatch`);
                continue;
            }

            const winningSide = resolution.winningIndex;
            const settleRows = await sql`
                UPDATE community_picks SET status = 'settled', winning_side = ${winningSide}
                WHERE id = ${row.id} AND status = 'open'
                RETURNING id
            `;
            if (settleRows.length === 0) continue; // already settled by a concurrent run
            settled++;

            const votes = (await sql`
                SELECT discord_user_id, linked_heatchecks_user_id, side_chosen
                FROM community_picks_votes WHERE community_pick_id = ${row.id}
            `) as unknown as VoteRow[];

            if (votes.length === 0) continue; // nobody voted - nothing to award or announce

            const correctVotes = votes.filter((v) => v.side_chosen === winningSide);
            for (const vote of correctVotes) {
                await awardCommunityPoints(sql, {
                    guildId: row.guild_id,
                    discordUserId: vote.discord_user_id,
                    linkedHeatchecksUserId: vote.linked_heatchecks_user_id,
                    delta: POINTS_PER_CORRECT_VOTE,
                    sourceType: 'community_pick',
                    sourceId: row.id,
                });
            }

            const winningLabel = correctVotes.length > 0
                ? (winningSide === 0 ? row.side_a_label : row.side_b_label)
                : null;
            const recap = buildCommunitySettlementRecapMessage({
                questionText: row.question_text,
                winningLabel,
                correctCount: correctVotes.length,
                totalCount: votes.length,
            });
            await postDiscordChannelMessage(context.env, row.channel_id, recap);

            if (row.auto_draw_enabled) {
                const draw = await drawGiveawayWinner(sql, context.env, {
                    guildId: row.guild_id, sourceType: 'community_pick', sourceId: row.id, drawnBy: null,
                });
                const drawMessage = draw.status === 'no_pool'
                    ? buildNoEligiblePoolMessage(row.question_text)
                    : buildGiveawayResultMessage(row.question_text, draw.winnerDiscordUserId);
                await postDiscordChannelMessage(context.env, row.channel_id, drawMessage);
            }
        } catch (err) {
            console.error(`[POST /api/community-pick-settlement-sweep] Failed for ${row.id}:`, err);
            errors.push(row.id);
        }
    }

    return jsonResponse({ candidates: openPicks.length, settled, pendingNotClosed, errors });
};
