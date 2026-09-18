// Discord-only Tank calls (create_discord_tank_votes_table.sql) - what a tap on a Tank
// card records when there is no Ember pick behind it: the member has no linked account,
// hasn't finished onboarding, or has used today's Ember picks. The call scores for the
// server (Community Points, draws, SR/XP) and never for Ember - this file has no path to
// picks writes, ember_ledger or ember_balances.
//
// Validation mirrors lib/pages-functions/picks.ts#submitPick (published + app-visible,
// settleable provider, kickoff not passed, odds line up with the sides) so a server-only
// call is refused in exactly the cases an Ember pick would be.

import type { NeonQueryFunction } from '@neondatabase/serverless';
import { hasKickoffPassed } from '../../tank-deck-format';
import type { PropOdds } from '../../tank-types';
import { pointsForProbability } from './community-points-formula';

export interface RecordTankVoteInput {
    guildId: string;
    discordUserId: string;
    linkedHeatchecksUserId: string | null;
    slug: string;
    sideIndex: number;
}

export type RecordTankVoteResult =
    | { status: 'not_found' }
    | { status: 'not_settleable' }
    | { status: 'game_started' }
    | { status: 'no_odds' }
    | { status: 'side_index_out_of_range' }
    | { status: 'already_picked'; side: string }   // an Ember pick already exists on this Tank
    | { status: 'already_voted'; side: string }
    | { status: 'ok'; side: string; pointsIfCorrect: number | null };

/** The server-only call already on this Tank for this Discord user, if any. */
export async function findTankVote(
    sql: NeonQueryFunction<false, false>,
    slug: string,
    discordUserId: string
): Promise<{ side: string } | null> {
    const rows = await sql`
        SELECT v.side FROM discord_tank_votes v
        JOIN tank_pages t ON t.id = v.tank_page_id
        WHERE t.slug = ${slug} AND v.discord_user_id = ${discordUserId}
        LIMIT 1
    `;
    return rows.length > 0 ? { side: rows[0].side as string } : null;
}

export async function recordTankVote(
    sql: NeonQueryFunction<false, false>,
    input: RecordTankVoteInput
): Promise<RecordTankVoteResult> {
    const tankRows = await sql`
        SELECT id, provider, game_snapshot, model_output->'call'->'sides' AS sides
        FROM tank_pages WHERE slug = ${input.slug} AND status = 'published' AND visibility = 'app' LIMIT 1
    `;
    if (tankRows.length === 0) return { status: 'not_found' };
    const tankPageId = tankRows[0].id as string;
    if (!['polymarket', 'kalshi'].includes(tankRows[0].provider as string)) return { status: 'not_settleable' };

    const rawSides = tankRows[0].sides as unknown;
    const sides: string[] = Array.isArray(rawSides)
        ? (rawSides as string[])
        : (typeof rawSides === 'string' ? JSON.parse(rawSides) : []);

    const snapshot = tankRows[0].game_snapshot as { prop?: { odds?: PropOdds | null }; game?: { kickoff?: string } } | null;
    if (hasKickoffPassed(snapshot?.game?.kickoff)) return { status: 'game_started' };

    const odds = snapshot?.prop?.odds ?? null;
    if (!odds || !Array.isArray(odds.outcomes) || !Array.isArray(odds.outcomePrices)) return { status: 'no_odds' };
    if (odds.outcomes.length !== sides.length) return { status: 'no_odds' };
    const { sideIndex } = input;
    if (sideIndex < 0 || sideIndex >= sides.length) return { status: 'side_index_out_of_range' };
    const impliedProb = odds.outcomePrices[sideIndex];
    if (typeof impliedProb !== 'number' || !Number.isFinite(impliedProb)) return { status: 'no_odds' };
    const side = sides[sideIndex];

    if (input.linkedHeatchecksUserId) {
        const picked = await sql`
            SELECT side FROM picks WHERE waitlist_id = ${input.linkedHeatchecksUserId} AND tank_page_id = ${tankPageId} LIMIT 1
        `;
        if (picked.length > 0) return { status: 'already_picked', side: picked[0].side as string };
    }

    const inserted = await sql`
        INSERT INTO discord_tank_votes (guild_id, tank_page_id, discord_user_id, linked_heatchecks_user_id, side, outcome_index, implied_prob_at_vote)
        VALUES (${input.guildId}, ${tankPageId}, ${input.discordUserId}, ${input.linkedHeatchecksUserId}, ${side}, ${sideIndex}, ${impliedProb})
        ON CONFLICT (tank_page_id, discord_user_id) DO NOTHING
        RETURNING id
    `;
    if (inserted.length === 0) {
        const existing = await sql`
            SELECT side FROM discord_tank_votes WHERE tank_page_id = ${tankPageId} AND discord_user_id = ${input.discordUserId}
        `;
        return { status: 'already_voted', side: (existing[0]?.side as string | undefined) ?? side };
    }

    // Same underdog weighting the settlement sweep pays with - the other side's price.
    // Only defined for two-sided markets, like every other Community Points payout.
    const pointsIfCorrect = odds.outcomePrices.length === 2
        ? pointsForProbability(odds.outcomePrices[1 - sideIndex])
        : null;
    return { status: 'ok', side, pointsIfCorrect };
}
