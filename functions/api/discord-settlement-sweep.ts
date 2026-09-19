// POST /api/discord-settlement-sweep - protected, machine-to-machine only. Rides
// worker-settle's cron as a sibling call right after /api/settle (same posture as
// worker-curate's sweep chain: own request, own subrequest budget, fires regardless
// of the settle call's own outcome) - it depends on settlement having just run, which
// only happens on worker-settle's schedule, not worker-curate's.
//
// Settlement itself (functions/api/settle.ts) tracks outcomes per PICK (picks.result),
// not per Tank - there's no single "this Tank is settled" flag anywhere. A Tank counts
// as settled here the moment any pick against it has a non-null result.
// discord_guild_posts.settlement_posted_at is this feature's own idempotency marker,
// set once a guild's announcement for a given Tank goes out, same posted-once posture
// as posted_at itself.
//
// Each guild that had a Tank posted gets its OWN summary, scoped to that guild's
// members only (live-fetched, same mechanism as the /leaderboard command) - not a
// DM per picker, and not one global summary blasted to every guild regardless of who
// actually picked there.
//
// Data-honesty note: picks.result only says whether each picker was right, not what
// the resolved outcome actually was. If at least one of this guild's pickers is
// 'correct', that pick's own `side` IS the winning side and the summary names it. If
// every one of them got it wrong, the summary reports the aggregate only - there is
// no stored "the answer was X" fact to report in that case, and inventing one would
// be worse than omitting it.
//
// Also awards Community Points (lib/pages-functions/community-points.ts, fully
// isolated from ember_ledger/ember_balances) to every correct picker in the guild,
// and runs the giveaway draw when the guild has opted into auto-draw
// (discord_guild_configs.auto_draw_enabled) - additive only, guilds that never touch
// that feature just accumulate points nobody looks at and never see a draw.
//
// Community Points here use the exact same underdog-weighted formula Community
// Picks use (lib/pages-functions/community-points-formula.ts) - round(100 * the
// losing side's probability) - computed ONCE per Tank from its own frozen
// game_snapshot (never per-picker: every correct picker on a Tank necessarily
// picked the same winning outcome_index, so they all get the identical payout,
// same as everyone who votes the winning side of a Community Pick). This is
// completely separate from Ember, which keeps its own capped formula
// (lib/pages-functions/ledger.ts#correctCallPayout) driven by each picker's own
// individually-locked implied_prob_at_lock - nothing here touches that.
//
// Server-only Tank calls (discord_tank_votes - members with no Ember pick behind their
// tap) settle here too, and ONLY here: settle.ts never sees them. They need the Tank's
// real outcome, which the linked picks can't always supply (all wrong, or none at
// all), so a Tank with pending votes and no correct linked picker resolves its market
// directly - same provider dispatch + outcome-order guard as settle.ts. Such a Tank
// becomes a candidate once its kickoff has passed; while its market is unresolved it
// is retried each run, until VOTE_GIVE_UP_DAYS after posting (voided/stuck markets),
// when the recap is stamped done and the votes stay unsettled.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../lib/pages-functions/db';
import { postDiscordChannelMessage, fetchGuildMembers, DEFAULT_COMMUNITY_POINTS_LABEL } from '../../lib/pages-functions/discord-api';
import { deriveTaglineFallback } from '../../tank-deck-format';
import { awardCommunityPoints } from '../../lib/pages-functions/community-points';
import { pointsForProbability } from '../../lib/pages-functions/community-points-formula';
import { drawGiveawayWinner } from '../../lib/pages-functions/discord-draw';
import { brandEmbed } from '../../lib/pages-functions/discord-brand';
import { buildGiveawayResultMessage, buildNoEligiblePoolMessage, buildDrawButtonRow } from '../../lib/pages-functions/discord-community-card';
import type { PropOdds } from '../../tank-types';
import { fetchMarket, outcomeOrderMismatch, resolveMarket, type MarketResolution } from '../../lib/pages-functions/gamma';
import { fetchMarket as fetchKalshiMarket, resolveMarket as resolveKalshiMarket, type KalshiMarketResolution } from '../../lib/pages-functions/kalshi';
import { secretMatches } from '../../lib/pages-functions/secret-compare';

const MAX_ANNOUNCEMENTS_PER_RUN = 20;
const VOTE_GIVE_UP_DAYS = 14;
// Defensive-only floor - should never actually trigger, since a published Tank's
// game_snapshot always carries valid 2-sided odds (the same guarantee picks.ts
// already relies on to accept a submission). Mirrors
// lib/pages-functions/ledger.ts#correctCallPayout's own posture: degrade to the
// safe minimum rather than fail the whole sweep over one malformed snapshot.
const FALLBACK_POINTS_PER_CORRECT_PICK = 1;

interface ModelOutput {
    tagline?: string;
    hook: string;
    call?: { sides?: string[] };
}

interface CandidateRow {
    guild_id: string;
    tank_page_id: string;
    channel_id: string;
    auto_draw_enabled: boolean;
    community_points_label: string | null;
    settlement_visibility: string;
    slug: string;
    model_output: ModelOutput | string;
    game_snapshot: { prop?: { odds?: PropOdds | null } } | null;
    provider: string;
    market_id: string | null;
    snapshot_outcomes: unknown;
    stale: boolean; // posted more than VOTE_GIVE_UP_DAYS ago
}

interface VoteRow {
    discord_user_id: string;
    linked_heatchecks_user_id: string | null;
    side: string;
    outcome_index: number;
    result: string | null;
}

interface PickerRow {
    side: string;
    result: string;
    discord_user_id: string;
    waitlist_id: string;
    outcome_index: number;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const secret = context.request.headers.get('X-Settle-Secret');
    if (!(await secretMatches(secret, context.env.SETTLE_SECRET))) {
        return jsonResponse({ message: 'Unauthorized' }, { status: 401 });
    }

    const baseUrl = new URL(context.request.url).origin;
    const sql = getSql(context.env);

    // A Tank qualifies once any Ember pick on it has settled (settle.ts resolved its
    // market), or - for server-only votes, which settle.ts never sees - once its
    // kickoff has passed. The kickoff cast is guarded by a shape check so one malformed
    // snapshot can't fail the whole query; no usable kickoff falls back to posted_at.
    const candidates = (await sql`
        SELECT dgp.guild_id, dgp.tank_page_id, dgc.channel_id, dgc.auto_draw_enabled, dgc.community_points_label, dgc.settlement_visibility,
               t.slug, t.model_output, t.game_snapshot, t.provider,
               t.game_snapshot->'prop'->>'id' AS market_id,
               t.game_snapshot->'prop'->'odds'->'outcomes' AS snapshot_outcomes,
               dgp.posted_at < NOW() - make_interval(days => ${VOTE_GIVE_UP_DAYS}) AS stale
        FROM discord_guild_posts dgp
        JOIN discord_guild_configs dgc ON dgc.guild_id = dgp.guild_id
        JOIN tank_pages t ON t.id = dgp.tank_page_id
        WHERE dgp.settlement_posted_at IS NULL
          AND (
            EXISTS (SELECT 1 FROM picks p WHERE p.tank_page_id = dgp.tank_page_id AND p.result IS NOT NULL)
            OR (
              EXISTS (SELECT 1 FROM discord_tank_votes v WHERE v.guild_id = dgp.guild_id AND v.tank_page_id = dgp.tank_page_id)
              AND COALESCE(
                    CASE WHEN t.game_snapshot->'game'->>'kickoff' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                         THEN (t.game_snapshot->'game'->>'kickoff')::timestamptz END,
                    dgp.posted_at
                  ) < NOW()
            )
          )
        ORDER BY dgp.posted_at ASC
        LIMIT ${MAX_ANNOUNCEMENTS_PER_RUN}
    `) as unknown as CandidateRow[];

    // One market fetch per Tank per run, only for Tanks that need it (pending votes,
    // no correct linked picker to read the winner off). Thrown fetch errors aren't
    // cached, same as settle.ts's resolveOnce.
    const winnerCache = new Map<string, number | null>();
    async function resolveWinningIndex(row: CandidateRow): Promise<number | null> {
        if (winnerCache.has(row.tank_page_id)) return winnerCache.get(row.tank_page_id)!;
        let winningIndex: number | null = null;
        if (row.market_id && (row.provider === 'polymarket' || row.provider === 'kalshi')) {
            const resolution: MarketResolution | KalshiMarketResolution = row.provider === 'kalshi'
                ? resolveKalshiMarket(await fetchKalshiMarket(row.market_id))
                : resolveMarket(await fetchMarket(row.market_id));
            if (resolution.status === 'resolved'
                && !('outcomes' in resolution && outcomeOrderMismatch(resolution.outcomes, row.snapshot_outcomes))) {
                winningIndex = resolution.winningIndex;
            }
        }
        winnerCache.set(row.tank_page_id, winningIndex);
        return winningIndex;
    }

    let posted = 0;
    let skippedNoPickers = 0;
    const errors: string[] = [];

    // One roster read per GUILD per run, not per candidate. Candidates are ordered by
    // posted_at, not grouped by guild, so a guild with several newly-settled Tanks
    // used to page its entire membership (up to 10 Discord requests) once per Tank -
    // up to 20 x 10 = 200 serial requests in one invocation against the ~50
    // subrequest ceiling. Memoized as the promise so a failure isn't cached: a guild
    // whose fetch throws (bot removed, intent revoked) is retried by its next
    // candidate exactly as before, and each such candidate still lands in `errors`.
    const rosterByGuild = new Map<string, Promise<Awaited<ReturnType<typeof fetchGuildMembers>>>>();
    const guildRoster = (guildId: string) => {
        let pending = rosterByGuild.get(guildId);
        if (!pending) {
            pending = fetchGuildMembers(context.env, guildId).catch((err) => {
                rosterByGuild.delete(guildId);
                throw err;
            });
            rosterByGuild.set(guildId, pending);
        }
        return pending;
    };

    for (const row of candidates) {
        try {
            const members = await guildRoster(row.guild_id);
            const memberIds = members.filter((m) => !m.user.bot).map((m) => m.user.id);

            const pickers = memberIds.length === 0 ? [] : ((await sql`
                SELECT p.side, p.result, dl.discord_user_id, p.waitlist_id, p.outcome_index
                FROM picks p
                JOIN discord_links dl ON dl.waitlist_id = p.waitlist_id
                WHERE p.tank_page_id = ${row.tank_page_id} AND dl.discord_user_id = ANY(${memberIds}::text[])
            `) as unknown as PickerRow[]);

            // Server-only calls made in THIS guild. Guild scope is inherent (a vote is
            // cast in one server), like Community Pick votes - no roster cross-check. A
            // member who also has an Ember pick on this Tank (voted, then linked and
            // picked on the site) counts once, as the picker.
            const pickerIds = new Set(pickers.map((p) => p.discord_user_id));
            const allVotes = (await sql`
                SELECT discord_user_id, linked_heatchecks_user_id, side, outcome_index, result
                FROM discord_tank_votes
                WHERE guild_id = ${row.guild_id} AND tank_page_id = ${row.tank_page_id}
            `) as unknown as VoteRow[];
            let votes = allVotes.filter((v) => !pickerIds.has(v.discord_user_id));

            // The winner: read off a correct linked picker when there is one (no fetch),
            // else resolve the market - but only when votes need scoring.
            let winningIndex: number | null = pickers.find((p) => p.result === 'correct')?.outcome_index ?? null;
            if (winningIndex === null && votes.length > 0) {
                winningIndex = await resolveWinningIndex(row);
                if (winningIndex === null) {
                    if (!row.stale) continue; // not resolved yet - retry next run
                    console.error(`[POST /api/discord-settlement-sweep] Tank ${row.tank_page_id} unresolved after ${VOTE_GIVE_UP_DAYS} days - closing guild ${row.guild_id}'s recap with its server-only calls unsettled`);
                    await sql`
                        UPDATE discord_guild_posts SET settlement_posted_at = NOW()
                        WHERE guild_id = ${row.guild_id} AND tank_page_id = ${row.tank_page_id}
                    `;
                    skippedNoPickers++;
                    continue;
                }
            }

            if (winningIndex !== null && allVotes.some((v) => v.result === null)) {
                await sql`
                    UPDATE discord_tank_votes
                    SET result = CASE WHEN outcome_index = ${winningIndex} THEN 'correct' ELSE 'incorrect' END,
                        settled_at = NOW()
                    WHERE guild_id = ${row.guild_id} AND tank_page_id = ${row.tank_page_id} AND result IS NULL
                `;
                votes = votes.map((v) => ({ ...v, result: v.result ?? (v.outcome_index === winningIndex ? 'correct' : 'incorrect') }));
            }

            if (pickers.length === 0 && votes.length === 0) {
                // Nobody from this guild actually picked it (they may have just seen
                // the post, or this guild's overlap with the pickers is elsewhere) -
                // mark it done anyway so this pair never gets re-checked, but there's
                // nothing worth announcing.
                await sql`
                    UPDATE discord_guild_posts SET settlement_posted_at = NOW()
                    WHERE guild_id = ${row.guild_id} AND tank_page_id = ${row.tank_page_id}
                `;
                skippedNoPickers++;
                continue;
            }

            const correctPickers = pickers.filter((p) => p.result === 'correct');
            const correctVoters = votes.filter((v) => v.result === 'correct');
            const total = pickers.length + votes.length;
            const correct = correctPickers.length + correctVoters.length;

            const modelOutput: ModelOutput | null = typeof row.model_output === 'string'
                ? JSON.parse(row.model_output)
                : row.model_output;
            // Named from the resolved index when we have one (so an all-wrong server
            // still hears the answer), else from a correct picker as before.
            const winningSide = (winningIndex !== null ? modelOutput?.call?.sides?.[winningIndex] : undefined)
                ?? correctPickers[0]?.side ?? correctVoters[0]?.side ?? null;

            // One locked split per Tank, not per-picker: every correct caller shares the
            // same outcome_index by definition of "correct," so the losing side's price
            // (and therefore the payout) only needs computing once here.
            const odds = row.game_snapshot?.prop?.odds;
            const oddsUsable = !!odds && odds.outcomes.length === 2 && (winningIndex === 0 || winningIndex === 1);
            let pointsAwarded = FALLBACK_POINTS_PER_CORRECT_PICK;
            if (oddsUsable) {
                pointsAwarded = pointsForProbability(odds!.outcomePrices[1 - winningIndex!]) ?? FALLBACK_POINTS_PER_CORRECT_PICK;
            } else if (correct > 0) {
                console.error(`[POST /api/discord-settlement-sweep] Tank ${row.tank_page_id} has unusable odds for Community Points - falling back to ${FALLBACK_POINTS_PER_CORRECT_PICK}`);
            }

            // Pickers and server-only voters are paid identically - the same idempotency
            // key (guild, user, 'tank', tank id), so a re-run never double-credits.
            const winners = [
                ...correctPickers.map((p) => ({ discordUserId: p.discord_user_id, linked: p.waitlist_id as string | null })),
                ...correctVoters.map((v) => ({ discordUserId: v.discord_user_id, linked: v.linked_heatchecks_user_id })),
            ];
            for (const w of winners) {
                await awardCommunityPoints(sql, {
                    guildId: row.guild_id,
                    discordUserId: w.discordUserId,
                    linkedHeatchecksUserId: w.linked,
                    delta: pointsAwarded,
                    sourceType: 'tank',
                    sourceId: row.tank_page_id,
                });
            }
            const tagline = modelOutput?.tagline?.trim() || (modelOutput ? deriveTaglineFallback(modelOutput.hook) : row.slug);
            const tankUrl = `${baseUrl}/the-tank/articles/${row.slug}/`;

            const summary = winningSide
                ? `**${winningSide}** was right. ${correct}/${total} of this server's pickers got it.`
                : `Tough one — 0/${total} of this server's pickers got it this time.`;
            // Additive text only when points were actually awarded - guilds that never
            // touch the Community Points feature see the exact same recap as before.
            const pointsLabel = row.community_points_label || DEFAULT_COMMUNITY_POINTS_LABEL;
            const pointsLine = correct > 0 ? `\n\n+${pointsAwarded} ${pointsLabel} to ${correct} of you.` : '';

            const embed = brandEmbed({
                kind: 'settlement',
                plate: 'TANK — SETTLED',
                title: tagline,
                url: tankUrl,
                body: summary + pointsLine,
                footer: 'trust',
            });

            // Same one-click draw affordance the Community Pick recap carries: skipped
            // when auto-draw is already going to announce a winner for this Tank, or
            // when nobody in this guild picked it (nothing to draw from).
            const drawRow = !row.auto_draw_enabled && total > 0
                ? [buildDrawButtonRow('tank', row.tank_page_id)]
                : [];

            if (row.settlement_visibility !== 'private') {
                await postDiscordChannelMessage(context.env, row.channel_id, { embeds: [embed], components: drawRow });
            }
            await sql`
                UPDATE discord_guild_posts SET settlement_posted_at = NOW()
                WHERE guild_id = ${row.guild_id} AND tank_page_id = ${row.tank_page_id}
            `;
            posted++;

            if (row.auto_draw_enabled) {
                // Same roster this candidate already fetched - the draw's tank pool
                // would otherwise page the guild a second time.
                const draw = await drawGiveawayWinner(sql, context.env, {
                    guildId: row.guild_id, sourceType: 'tank', sourceId: row.tank_page_id, drawnBy: null,
                    guildMembers: members,
                });
                const drawMessage = draw.status === 'no_pool'
                    ? buildNoEligiblePoolMessage(tagline)
                    : buildGiveawayResultMessage(tagline, draw.winnerDiscordUserId);
                await postDiscordChannelMessage(context.env, row.channel_id, drawMessage);
            }
        } catch (err) {
            console.error(`[POST /api/discord-settlement-sweep] Failed for guild ${row.guild_id}, tank ${row.tank_page_id}:`, err);
            errors.push(`${row.guild_id}:${row.tank_page_id}`);
        }
    }

    return jsonResponse({ candidates: candidates.length, posted, skippedNoPickers, errors });
};
