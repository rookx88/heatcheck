// Shared "insert the row, then post the card" logic for Community Picks - the ONE
// path both the admin-triggered flow (lib/pages-functions/discord-commands.ts's
// handleCommunityPickConfirm) and the automated weekly NFL slate
// (functions/api/league-slate-sweep.ts) go through, so a cron-triggered pick and a
// hand-created one can never be built two different ways. createdBy is nullable
// (community_picks.created_by, see add_weighted_community_pick_scoring.sql) - the
// weekly slate has no admin behind it.

import type { NeonQueryFunction } from '@neondatabase/serverless';
import type { Env } from './db';
import { postDiscordChannelMessage } from './discord-api';
import { buildCommunityPickCardMessage, buildCommunityVoteButtons } from './discord-community-card';
import { renderCommunityPickImage } from './community-pick-image';
import { postImageToChannel } from './leaderboard-image';

export interface CreateCommunityPickInput {
    guildId: string;
    channelId: string;
    createdBy: string | null;
    sport: string | null;
    marketId: string;
    question: string;
    sideALabel: string;
    sideBLabel: string;
    sourceOutcomes: string[];
    // Underdog-weighted, computed once by the caller from the market's own implied
    // probability at this exact moment - this function only ever stores and displays
    // whatever it's handed, it never computes or re-derives the split itself.
    sideAPoints: number;
    sideBPoints: number;
    resolveDate: string; // ISO 8601
    // Per-pick giveaway: how many winners to draw from CORRECT voters at settlement.
    // 0/omitted = none. Winners are only ever named - no prize handling anywhere.
    giveawayWinnerCount?: number;
}

export type CreateCommunityPickResult =
    | { status: 'created'; pickId: string }
    // idx_community_picks_guild_market (add_weighted_community_pick_scoring.sql) -
    // this exact market already has a Community Pick in this guild. Callers treat
    // this as "already handled," not an error: the weekly slate's own idempotency
    // guard against re-running, and the admin flow's guard against re-creating a
    // pick on a market it (or the slate) already posted.
    | { status: 'duplicate' }
    // The row exists but the Discord post itself failed (rate limit, permissions
    // changed, etc.) - the caller still has a real pickId to report/retry against,
    // distinct from a duplicate.
    | { status: 'post_failed'; pickId: string };

export async function createAndPostCommunityPick(
    sql: NeonQueryFunction<false, false>,
    env: Env,
    input: CreateCommunityPickInput
): Promise<CreateCommunityPickResult> {
    let pickId: string;
    try {
        const rows = await sql`
            INSERT INTO community_picks (
                guild_id, created_by, sport, source_market_id, question_text,
                side_a_label, side_b_label, source_outcomes, side_a_points, side_b_points, resolve_date,
                giveaway_winner_count
            )
            VALUES (
                ${input.guildId}, ${input.createdBy}, ${input.sport}, ${input.marketId}, ${input.question},
                ${input.sideALabel}, ${input.sideBLabel}, ${JSON.stringify(input.sourceOutcomes)}::jsonb,
                ${input.sideAPoints}, ${input.sideBPoints}, ${input.resolveDate},
                ${input.giveawayWinnerCount ?? 0}
            )
            RETURNING id
        `;
        pickId = (rows[0] as unknown as { id: string }).id;
    } catch (err: any) {
        if (err.code === '23505') return { status: 'duplicate' };
        throw err;
    }

    // Rendered image card first (the brand aesthetic), the branded purple embed as
    // automatic render-fallback - either way the SAME vote buttons ride the message,
    // so cpvote: handling never cares which form posted.
    const voteButtons = buildCommunityVoteButtons({
        id: pickId,
        sideALabel: input.sideALabel,
        sideBLabel: input.sideBLabel,
        sideAPoints: input.sideAPoints,
        sideBPoints: input.sideBPoints,
    });

    try {
        const png = await renderCommunityPickImage({
            questionText: input.question,
            sideALabel: input.sideALabel,
            sideBLabel: input.sideBLabel,
            sideAPoints: input.sideAPoints,
            sideBPoints: input.sideBPoints,
            resolveDate: input.resolveDate,
        });
        if (png) {
            await postImageToChannel(env, input.channelId, png, 'community-pick.png', voteButtons);
        } else {
            const card = buildCommunityPickCardMessage({
                id: pickId,
                questionText: input.question,
                sideALabel: input.sideALabel,
                sideBLabel: input.sideBLabel,
                sideAPoints: input.sideAPoints,
                sideBPoints: input.sideBPoints,
                resolveDate: input.resolveDate,
            });
            await postDiscordChannelMessage(env, input.channelId, card);
        }
        return { status: 'created', pickId };
    } catch (err) {
        console.error('[community-pick-creation] Failed to post Community Pick card:', err);
        return { status: 'post_failed', pickId };
    }
}
