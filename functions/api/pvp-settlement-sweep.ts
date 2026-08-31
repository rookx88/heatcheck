// POST /api/pvp-settlement-sweep - protected, machine-to-machine only. Rides
// worker-settle's existing cron as a fourth sibling call (same posture as
// functions/api/community-pick-settlement-sweep.ts: own request, own subrequest
// budget, fires regardless of the other sweeps' outcomes). No new cron trigger - the
// Workers Free plan's 5 account-wide triggers are all spent.
//
// Four phases, in order:
//   0. expire challenges nobody answered
//   1. resolve individual picks whose game has kicked off
//   2. settle battles whose pick window has closed AND whose picks have all resolved
//   3. post the public recap for anything settled but unposted
//
// Scoring reuses the resolution primitives real settlement uses (gamma.ts's
// fetchMarket/resolveMarket/outcomeOrderMismatch) including the outcome-order-mismatch
// guard - a battle resolving without it could be silently inverted by Polymarket
// reordering a market's outcomes.
//
// There is deliberately NO void outcome: once accepted, a battle always scores. A
// player who submitted nothing sums to 0 and loses; partial submissions score on what
// was submitted. That falls out of SUM() ignoring absent rows rather than needing
// special cases.
//
// Isolation reminder: this file writes only pvp_battles + pvp_battle_picks. PvP awards
// no Community Points and never touches ember_ledger/ember_balances/picks/community_*
// or any shop table.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../lib/pages-functions/db';
import type { GammaMarketLite } from '../../lib/pages-functions/gamma';
import { fetchMarket, resolveMarket, outcomeOrderMismatch } from '../../lib/pages-functions/gamma';
import { postDiscordChannelMessage, fetchGuildMemberName } from '../../lib/pages-functions/discord-api';
import { buildPvpResultMessage, type PvpResultPick } from '../../lib/pages-functions/pvp-card';

// Each unresolved pick costs one Gamma request, each settled battle costs up to three
// Discord requests (two name lookups + one post) - both well inside a single
// invocation's subrequest budget at these limits.
const MAX_PICKS_PER_RUN = 25;
const MAX_BATTLES_PER_RUN = 10;
// A battle whose market never resolves would otherwise pin this pair out of PvP
// forever (the live-pair unique index covers 'active'), so after this long it settles
// on what did resolve, flagged stale_settled for auditability.
const PVP_STALE_SETTLE_DAYS = 7;

interface UnresolvedPickRow {
    id: string;
    battle_id: string;
    source_market_id: string;
    source_outcomes: string[] | string;
    side_chosen: number;
}

interface SettleCandidateRow {
    id: string;
    guild_id: string;
    channel_id: string;
    challenger_id: string;
    opponent_id: string;
    is_stale: boolean;
}

interface SettledRow {
    id: string;
    guild_id: string;
    channel_id: string;
    challenger_id: string;
    opponent_id: string;
    challenger_score: number;
    opponent_score: number;
    outcome: 'challenger' | 'opponent' | 'draw';
    stale_settled: boolean;
    pvp_results_visibility: string;
}

interface ResultPickRow {
    discord_user_id: string;
    question_text: string;
    side_chosen: number;
    side_a_label: string;
    side_b_label: string;
    points_awarded: number | null;
    winning_side: number | null;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const secret = context.request.headers.get('X-Settle-Secret');
    if (!secret || secret !== context.env.SETTLE_SECRET) {
        return jsonResponse({ message: 'Unauthorized' }, { status: 401 });
    }

    const sql = getSql(context.env);
    const errors: string[] = [];

    // ---- Phase 0: expire unanswered challenges. Posts nothing, affects no record.
    const expiredRows = await sql`
        UPDATE pvp_battles SET status = 'expired'
        WHERE status = 'pending' AND expires_at <= NOW()
        RETURNING id
    `;

    // ---- Phase 1: resolve individual picks whose game has already kicked off.
    const unresolved = (await sql`
        SELECT p.id, p.battle_id, p.source_market_id, p.source_outcomes, p.side_chosen
        FROM pvp_battle_picks p
        JOIN pvp_battles b ON b.id = p.battle_id
        WHERE b.status = 'active'
          AND p.points_awarded IS NULL
          AND (p.kickoff_at IS NULL OR p.kickoff_at <= NOW())
        ORDER BY p.kickoff_at ASC NULLS LAST
        LIMIT ${MAX_PICKS_PER_RUN}
    `) as unknown as UnresolvedPickRow[];

    // Both players in a battle - and players in different battles - land on the same
    // market often enough that this cache meaningfully cuts the subrequest count.
    const marketCache = new Map<string, GammaMarketLite | null>();
    const fetchCached = async (marketId: string): Promise<GammaMarketLite | null> => {
        if (marketCache.has(marketId)) return marketCache.get(marketId) ?? null;
        const market = await fetchMarket(marketId);
        marketCache.set(marketId, market);
        return market;
    };

    let resolvedPicks = 0;
    let pendingMarkets = 0;
    for (const pick of unresolved) {
        try {
            const resolution = resolveMarket(await fetchCached(pick.source_market_id));
            if (resolution.status !== 'resolved') {
                pendingMarkets++;
                continue;
            }
            const sourceOutcomes = Array.isArray(pick.source_outcomes) ? pick.source_outcomes : JSON.parse(pick.source_outcomes);
            if (outcomeOrderMismatch(resolution.outcomes, sourceOutcomes)) {
                // Leave it unresolved rather than guess - the same "no safe answer
                // exists" posture the community sweep takes. The 7-day backstop below
                // stops this from pinning the pair forever.
                console.error(`[POST /api/pvp-settlement-sweep] Outcome order mismatch for pick ${pick.id} (market ${pick.source_market_id})`);
                errors.push(`${pick.id}:order_mismatch`);
                continue;
            }
            const winningSide = resolution.winningIndex;
            await sql`
                UPDATE pvp_battle_picks
                SET winning_side = ${winningSide},
                    points_awarded = CASE WHEN side_chosen = ${winningSide} THEN points_if_correct ELSE 0 END,
                    resolved_at = NOW()
                WHERE id = ${pick.id} AND points_awarded IS NULL
            `;
            resolvedPicks++;
        } catch (err) {
            console.error(`[POST /api/pvp-settlement-sweep] Failed resolving pick ${pick.id}:`, err);
            errors.push(`${pick.id}:resolve_failed`);
        }
    }

    // ---- Phase 2: settle battles.
    // Scoreable requires BOTH halves: the pick window has closed (else a freshly
    // accepted battle with no picks would settle 0-0 instantly) and nothing is still
    // unresolved (else games that haven't been played get scored). Neither implies the
    // other - a pick made in the window's last minute can be on a game a day later.
    const candidates = (await sql`
        SELECT b.id, b.guild_id, b.channel_id, b.challenger_id, b.opponent_id,
               (b.picks_close_at + (${PVP_STALE_SETTLE_DAYS} || ' days')::interval) <= NOW() AS is_stale
        FROM pvp_battles b
        WHERE b.status = 'active'
          AND b.picks_close_at <= NOW()
          AND (
                NOT EXISTS (SELECT 1 FROM pvp_battle_picks p WHERE p.battle_id = b.id AND p.points_awarded IS NULL)
             OR (b.picks_close_at + (${PVP_STALE_SETTLE_DAYS} || ' days')::interval) <= NOW()
          )
        ORDER BY b.picks_close_at ASC
        LIMIT ${MAX_BATTLES_PER_RUN}
    `) as unknown as SettleCandidateRow[];

    let settled = 0;
    for (const battle of candidates) {
        try {
            // Claim and score in ONE statement: the sum and the state transition can't
            // diverge, and a concurrent run can't double-settle (zero rows back means
            // someone else claimed it). SUM ignoring NULL rows is what makes "no picks
            // = 0 points" and "unresolved picks count 0" fall out with no special case.
            const claimed = await sql`
                WITH s AS (
                    SELECT COALESCE(SUM(points_awarded) FILTER (WHERE discord_user_id = ${battle.challenger_id}), 0)::int AS cs,
                           COALESCE(SUM(points_awarded) FILTER (WHERE discord_user_id = ${battle.opponent_id}), 0)::int AS os
                    FROM pvp_battle_picks WHERE battle_id = ${battle.id}
                )
                UPDATE pvp_battles b SET
                    status = 'settled',
                    settled_at = NOW(),
                    challenger_score = s.cs,
                    opponent_score = s.os,
                    outcome = CASE WHEN s.cs > s.os THEN 'challenger' WHEN s.os > s.cs THEN 'opponent' ELSE 'draw' END,
                    winner_discord_user_id = CASE WHEN s.cs > s.os THEN b.challenger_id WHEN s.os > s.cs THEN b.opponent_id ELSE NULL END,
                    stale_settled = ${battle.is_stale}
                FROM s
                WHERE b.id = ${battle.id} AND b.status = 'active'
                RETURNING b.id
            `;
            if (claimed.length > 0) settled++;
        } catch (err) {
            console.error(`[POST /api/pvp-settlement-sweep] Failed settling battle ${battle.id}:`, err);
            errors.push(`${battle.id}:settle_failed`);
        }
    }

    // ---- Phase 3: post recaps. Driven off the marker rather than the settle loop, so
    // a post that fails (rate limit, permissions changed) retries next run instead of
    // being silently lost.
    const toPost = (await sql`
        SELECT b.id, b.guild_id, b.channel_id, b.challenger_id, b.opponent_id,
               b.challenger_score, b.opponent_score, b.outcome, b.stale_settled,
               dgc.pvp_results_visibility
        FROM pvp_battles b
        JOIN discord_guild_configs dgc ON dgc.guild_id = b.guild_id
        WHERE b.status = 'settled' AND b.result_posted_at IS NULL
        ORDER BY b.settled_at ASC
        LIMIT ${MAX_BATTLES_PER_RUN}
    `) as unknown as SettledRow[];

    let posted = 0;
    for (const battle of toPost) {
        try {
            // The ONE query in the codebase that reads both players' picks - it lives
            // here, inside a machine-to-machine sweep no user request can reach, which
            // is what keeps picks sealed right up until the battle is over.
            const picks = (await sql`
                SELECT discord_user_id, question_text, side_chosen, side_a_label, side_b_label, points_awarded, winning_side
                FROM pvp_battle_picks WHERE battle_id = ${battle.id}
                ORDER BY discord_user_id, slot
            `) as unknown as ResultPickRow[];

            // A battle nobody picked in settles silently as a draw - announcing a 0-0
            // no-show is channel noise (same posture as skipping zero-voter recaps).
            if (picks.length === 0 || battle.pvp_results_visibility === 'private') {
                await sql`UPDATE pvp_battles SET result_posted_at = NOW() WHERE id = ${battle.id}`;
                continue;
            }

            const toResultPick = (p: ResultPickRow): PvpResultPick => ({
                questionText: p.question_text,
                chosenLabel: p.side_chosen === 0 ? p.side_a_label : p.side_b_label,
                correct: p.winning_side !== null && p.side_chosen === p.winning_side,
                pointsAwarded: Number(p.points_awarded ?? 0),
                unresolved: p.points_awarded === null,
            });

            const [challengerName, opponentName] = await Promise.all([
                fetchGuildMemberName(context.env, battle.guild_id, battle.challenger_id),
                fetchGuildMemberName(context.env, battle.guild_id, battle.opponent_id),
            ]);

            await postDiscordChannelMessage(context.env, battle.channel_id, buildPvpResultMessage({
                challengerId: battle.challenger_id,
                opponentId: battle.opponent_id,
                challengerName,
                opponentName,
                challengerScore: Number(battle.challenger_score ?? 0),
                opponentScore: Number(battle.opponent_score ?? 0),
                outcome: battle.outcome,
                challengerPicks: picks.filter((p) => p.discord_user_id === battle.challenger_id).map(toResultPick),
                opponentPicks: picks.filter((p) => p.discord_user_id === battle.opponent_id).map(toResultPick),
                staleSettled: battle.stale_settled,
            }));
            await sql`UPDATE pvp_battles SET result_posted_at = NOW() WHERE id = ${battle.id}`;
            posted++;
        } catch (err) {
            console.error(`[POST /api/pvp-settlement-sweep] Failed posting result for ${battle.id}:`, err);
            errors.push(`${battle.id}:post_failed`);
        }
    }

    return jsonResponse({
        expired: expiredRows.length,
        candidatePicks: unresolved.length,
        resolvedPicks,
        pendingMarkets,
        candidateBattles: candidates.length,
        settled,
        posted,
        errors,
    });
};
