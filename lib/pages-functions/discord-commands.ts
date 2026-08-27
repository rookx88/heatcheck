// Handlers for every Discord command/component added since the original pick-button
// bot: /heatchecks-setup, /heatchecks-config, /heatchecks-post (tank + community-pick
// subcommands), /heatchecks-draw, Community Pick voting, and the Community Points
// /leaderboard view. Imported and dispatched from functions/api/discord/
// interactions.ts, which owns the one Ed25519-verify-first entry point - nothing here
// is reachable except through that already-verified request.
//
// Admin-search flows (/heatchecks-post, /heatchecks-draw) all follow the same shape:
// search command -> ephemeral select menu of up to 25 matches -> pick one -> either
// act immediately (draw; first-time Tank post) or show a Confirm/Cancel step first
// (Community Pick creation, since it creates new persistent state from a live market
// that could be stale by confirm time; re-posting a Tank, since it's a visible
// duplicate a click shouldn't cause by accident). Every step updates the SAME
// ephemeral message (response type 7) rather than stacking new ones.
//
// Every admin command is gated on Discord's Manage Server permission via
// hasManageGuildPermission (lib/pages-functions/discord-api.ts), re-checked here
// server-side rather than trusted from Discord's UI-level command visibility alone.
//
// Isolation reminder: nothing in this file writes to ember_ledger, ember_balances,
// picks, or any shop table - only discord_guild_configs, community_picks(_votes),
// community_points(_transactions), and community_giveaway_draws (via
// lib/pages-functions/community-points.ts and discord-draw.ts).

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, type Env } from './db';
import { hasManageGuildPermission, fetchGuildMembers, postDiscordChannelMessage, getGuildLabels } from './discord-api';
import { buildTankCardMessage, type TankCardModelOutput } from './discord-tank-card';
import { buildGiveawayResultMessage, buildNoEligiblePoolMessage } from './discord-community-card';
import { drawGiveawayWinner, type GiveawaySourceType } from './discord-draw';
import { fetchMarket, resolveMarket } from './gamma';
import { createAndPostCommunityPick } from './community-pick-creation';
import { computePointsSplit } from './community-points-formula';
import { fetchLiveGames } from '../../tank-gamma-live';

const RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE = 4;
const RESPONSE_UPDATE_MESSAGE = 7;
const EPHEMERAL_FLAG = 64;
const ACTION_ROW_TYPE = 1;
const SELECT_MENU_TYPE = 3;
const BUTTON_TYPE = 2;
const BUTTON_STYLE_SECONDARY = 2;
const BUTTON_STYLE_DANGER = 4;
const MAX_SELECT_OPTIONS = 25;

// Matches curate.ts's SPORT_GROUPS league set - the same leagues the rest of the
// pipeline already knows about, so a filter/search value here always means something
// downstream.
export const SUPPORTED_SPORTS = ['NBA', 'NFL', 'MLB', 'EPL', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1'];

type RequestContext = Parameters<PagesFunction<Env>>[0];

function ephemeral(content: string): Response {
    return new Response(
        JSON.stringify({ type: RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE, data: { content, flags: EPHEMERAL_FLAG } }),
        { headers: { 'Content-Type': 'application/json' } }
    );
}

// Component-interaction response that edits the message the component is attached to
// (response type 7) rather than creating a new one - every multi-step admin flow in
// this file updates in place instead of stacking ephemeral messages.
export function updateMessageResponse(content: string, buttons?: { label: string; customId: string; style?: number }[]): Response {
    const components = buttons
        ? [{ type: ACTION_ROW_TYPE, components: buttons.map((b) => ({ type: BUTTON_TYPE, style: b.style ?? BUTTON_STYLE_SECONDARY, label: b.label, custom_id: b.customId })) }]
        : [];
    return new Response(
        JSON.stringify({ type: RESPONSE_UPDATE_MESSAGE, data: { content, components, embeds: [] } }),
        { headers: { 'Content-Type': 'application/json' } }
    );
}

function selectMenuResponse(customId: string, content: string, options: { label: string; value: string; description?: string }[]): Response {
    return new Response(
        JSON.stringify({
            type: RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
                content,
                flags: EPHEMERAL_FLAG,
                components: [{ type: ACTION_ROW_TYPE, components: [{ type: SELECT_MENU_TYPE, custom_id: customId, options: options.slice(0, MAX_SELECT_OPTIONS) }] }],
            },
        }),
        { headers: { 'Content-Type': 'application/json' } }
    );
}

// ===================================================================================
// /heatchecks-setup - unchanged behavior, moved here from interactions.ts alongside
// the rest of the admin commands for one home instead of splitting old/new.
// ===================================================================================

export async function handleSetupCommand(context: RequestContext, interaction: any): Promise<Response> {
    const guildId: string | undefined = interaction.guild_id;
    if (!guildId) return ephemeral('Run this in a server, not a DM.');
    if (!hasManageGuildPermission(interaction)) return ephemeral('You need the "Manage Server" permission to run this.');

    const channelId: string | undefined = interaction.data?.options?.find((o: any) => o.name === 'channel')?.value;
    const configuredBy: string | undefined = interaction.member?.user?.id;
    if (!channelId || !configuredBy) return ephemeral("Couldn't read that command's input - try again.");

    const sql = getSql(context.env);
    await sql`
        INSERT INTO discord_guild_configs (guild_id, channel_id, configured_by_discord_user_id)
        VALUES (${guildId}, ${channelId}, ${configuredBy})
        ON CONFLICT (guild_id) DO UPDATE
            SET channel_id = EXCLUDED.channel_id,
                configured_by_discord_user_id = EXCLUDED.configured_by_discord_user_id,
                configured_at = NOW()
    `;
    return ephemeral(`Done — Tank posts will now go to <#${channelId}>.`);
}

// ===================================================================================
// /heatchecks-config - per-guild sport filter + auto-draw toggle.
// ===================================================================================

export async function handleConfigCommand(context: RequestContext, interaction: any): Promise<Response> {
    const guildId: string | undefined = interaction.guild_id;
    if (!guildId) return ephemeral('Run this in a server, not a DM.');
    if (!hasManageGuildPermission(interaction)) return ephemeral('You need the "Manage Server" permission to run this.');

    const options = interaction.data?.options ?? [];
    const sport = options.find((o: any) => o.name === 'sport')?.value as string | undefined;
    const enabledOpt = options.find((o: any) => o.name === 'enabled')?.value as boolean | undefined;
    const autoDrawOpt = options.find((o: any) => o.name === 'auto_draw')?.value as boolean | undefined;
    const pointsNameOpt = options.find((o: any) => o.name === 'points_name')?.value as string | undefined;
    const leaderboardNameOpt = options.find((o: any) => o.name === 'leaderboard_name')?.value as string | undefined;

    if (sport === undefined && autoDrawOpt === undefined && pointsNameOpt === undefined && leaderboardNameOpt === undefined) {
        return ephemeral('Specify a sport (with enabled:true/false), auto_draw:true/false, points_name, or leaderboard_name.');
    }
    if (sport !== undefined && enabledOpt === undefined) {
        return ephemeral('Specify enabled:true or enabled:false along with the sport.');
    }

    const sql = getSql(context.env);
    const existing = await sql`SELECT disabled_sports FROM discord_guild_configs WHERE guild_id = ${guildId}`;
    if (existing.length === 0) {
        return ephemeral('Run /heatchecks-setup first to choose a channel for this server.');
    }

    const replies: string[] = [];
    if (sport !== undefined && enabledOpt !== undefined) {
        const raw = existing[0].disabled_sports as string[] | string;
        const current: string[] = Array.isArray(raw) ? raw : JSON.parse(raw);
        const next = enabledOpt ? current.filter((s) => s !== sport) : Array.from(new Set([...current, sport]));
        await sql`UPDATE discord_guild_configs SET disabled_sports = ${JSON.stringify(next)}::jsonb WHERE guild_id = ${guildId}`;
        replies.push(`${sport} is now ${enabledOpt ? 'enabled' : 'disabled'} for this server.`);
    }
    if (autoDrawOpt !== undefined) {
        await sql`UPDATE discord_guild_configs SET auto_draw_enabled = ${autoDrawOpt} WHERE guild_id = ${guildId}`;
        replies.push(`Auto-draw is now ${autoDrawOpt ? 'on' : 'off'} for this server.`);
    }
    // Purely cosmetic - lib/pages-functions/discord-api.ts#getGuildLabels is the one
    // place every renderer resolves these (falling back to the defaults on NULL), so
    // setting them here is the only write path that matters.
    if (pointsNameOpt !== undefined) {
        await sql`UPDATE discord_guild_configs SET community_points_label = ${pointsNameOpt} WHERE guild_id = ${guildId}`;
        replies.push(`Points are now called "${pointsNameOpt}" in this server.`);
    }
    if (leaderboardNameOpt !== undefined) {
        await sql`UPDATE discord_guild_configs SET leaderboard_label = ${leaderboardNameOpt} WHERE guild_id = ${guildId}`;
        replies.push(`The leaderboard is now called "${leaderboardNameOpt}" in this server.`);
    }
    return ephemeral(replies.join(' '));
}

// ===================================================================================
// /heatchecks-post - two subcommands: an on-demand real-Tank push, and Community Pick
// creation. Card rendering is shared with functions/api/discord-sweep.ts (Tank side)
// - not a parallel rendering path.
// ===================================================================================

export async function handlePostCommand(context: RequestContext, interaction: any): Promise<Response> {
    const guildId: string | undefined = interaction.guild_id;
    if (!guildId) return ephemeral('Run this in a server, not a DM.');
    if (!hasManageGuildPermission(interaction)) return ephemeral('You need the "Manage Server" permission to run this.');

    const sub = interaction.data?.options?.[0];
    if (sub?.name === 'tank') {
        const search = sub.options?.find((o: any) => o.name === 'search')?.value as string | undefined;
        if (!search) return ephemeral('Missing search keyword.');
        return handleTankSearch(context, search);
    }
    if (sub?.name === 'community-pick') {
        const sport = sub.options?.find((o: any) => o.name === 'sport')?.value as string | undefined;
        const keyword = sub.options?.find((o: any) => o.name === 'keyword')?.value as string | undefined;
        if (!sport) return ephemeral('Missing sport.');
        return handleCommunityPickSearch(context, guildId, sport, keyword);
    }
    return ephemeral('Unknown subcommand.');
}

interface TankSearchRow {
    slug: string;
    model_output: TankCardModelOutput | string;
}

async function handleTankSearch(context: RequestContext, search: string): Promise<Response> {
    const sql = getSql(context.env);
    const term = `%${search}%`;
    const rows = (await sql`
        SELECT slug, model_output
        FROM tank_pages
        WHERE status = 'published' AND visibility = 'app'
          AND (slug ILIKE ${term} OR model_output->>'tagline' ILIKE ${term} OR model_output->>'hook' ILIKE ${term})
        ORDER BY published_at DESC
        LIMIT ${MAX_SELECT_OPTIONS}
    `) as unknown as TankSearchRow[];

    if (rows.length === 0) return ephemeral(`No Tanks found matching "${search}".`);

    const options = rows.map((row) => {
        const modelOutput: TankCardModelOutput | null = typeof row.model_output === 'string' ? JSON.parse(row.model_output) : row.model_output;
        const label = (modelOutput?.tagline?.trim() || modelOutput?.hook || row.slug).slice(0, 100);
        return { label, value: row.slug };
    });
    return selectMenuResponse('tpselect', `Found ${rows.length} Tank(s) — pick one to post:`, options);
}

interface TankRowForPost {
    id: string;
    model_output: TankCardModelOutput | string;
    game_snapshot: unknown;
}

async function postTankAndRespond(context: RequestContext, guildId: string, slug: string, isRepost: boolean): Promise<Response> {
    const sql = getSql(context.env);
    const configRows = await sql`SELECT channel_id FROM discord_guild_configs WHERE guild_id = ${guildId}`;
    if (configRows.length === 0) return updateMessageResponse('This server has no channel configured - run /heatchecks-setup first.');
    const channelId = (configRows[0] as unknown as { channel_id: string }).channel_id;

    const tankRows = (await sql`
        SELECT id, model_output, game_snapshot FROM tank_pages
        WHERE slug = ${slug} AND status = 'published' AND visibility = 'app' LIMIT 1
    `) as unknown as TankRowForPost[];
    if (tankRows.length === 0) return updateMessageResponse("Couldn't find that Tank anymore.");
    const tankRow = tankRows[0];

    const baseUrl = new URL(context.request.url).origin;
    const modelOutput: TankCardModelOutput = typeof tankRow.model_output === 'string' ? JSON.parse(tankRow.model_output) : tankRow.model_output;
    const message = buildTankCardMessage(baseUrl, { slug, modelOutput, gameSnapshot: tankRow.game_snapshot as any });
    if (!message) return updateMessageResponse("This Tank can't be posted (no valid sides).");

    try {
        const messageId = await postDiscordChannelMessage(context.env, channelId, message);
        await sql`
            INSERT INTO discord_guild_posts (guild_id, tank_page_id, message_id)
            VALUES (${guildId}, ${tankRow.id}, ${messageId})
            ON CONFLICT (guild_id, tank_page_id) DO UPDATE SET message_id = EXCLUDED.message_id, posted_at = NOW()
        `;
        return updateMessageResponse(isRepost ? 'Reposted.' : 'Posted!');
    } catch (err) {
        console.error('[discord-commands] Failed to post Tank on demand:', err);
        return updateMessageResponse('Something went wrong posting that Tank. Try again shortly.');
    }
}

export async function handleTankPostSelect(context: RequestContext, interaction: any): Promise<Response> {
    const slug: string | undefined = interaction.data?.values?.[0];
    const guildId: string | undefined = interaction.guild_id;
    if (!slug || !guildId) return updateMessageResponse("Couldn't read your selection.");

    const sql = getSql(context.env);
    const tankRows = await sql`SELECT id FROM tank_pages WHERE slug = ${slug} AND status = 'published' AND visibility = 'app' LIMIT 1`;
    if (tankRows.length === 0) return updateMessageResponse("Couldn't find that Tank anymore.");
    const tankId = (tankRows[0] as unknown as { id: string }).id;

    const existingPost = await sql`SELECT posted_at FROM discord_guild_posts WHERE guild_id = ${guildId} AND tank_page_id = ${tankId}`;
    if (existingPost.length > 0) {
        const postedDate = new Date((existingPost[0] as unknown as { posted_at: string }).posted_at).toLocaleDateString('en-US', { timeZone: 'UTC' });
        return updateMessageResponse(`This Tank was already posted here on ${postedDate}. Post it again?`, [
            { label: 'Repost', customId: `tprepost:${slug}`, style: BUTTON_STYLE_DANGER },
            { label: 'Cancel', customId: 'tpcancel' },
        ]);
    }

    return postTankAndRespond(context, guildId, slug, false);
}

export async function handleTankRepostConfirm(context: RequestContext, interaction: any, customId: string): Promise<Response> {
    const guildId: string | undefined = interaction.guild_id;
    const slug = customId.split(':')[1];
    if (!slug || !guildId) return updateMessageResponse("Couldn't read your selection.");
    return postTankAndRespond(context, guildId, slug, true);
}

// --- Community Pick creation ---

interface MarketSearchOption {
    label: string;
    value: string; // Polymarket market id
}

async function handleCommunityPickSearch(context: RequestContext, guildId: string, sport: string, keyword?: string): Promise<Response> {
    const configRows = await getSql(context.env)`SELECT 1 FROM discord_guild_configs WHERE guild_id = ${guildId}`;
    if (configRows.length === 0) return ephemeral('Run /heatchecks-setup first to choose a channel for this server.');

    let games;
    try {
        games = await fetchLiveGames([sport]);
    } catch (err) {
        console.error('[discord-commands] fetchLiveGames failed:', err);
        return ephemeral('Could not reach Polymarket right now - try again shortly.');
    }

    const term = keyword?.trim().toLowerCase();
    const matches: MarketSearchOption[] = [];
    outer: for (const game of games) {
        for (const prop of game.props) {
            // Community Picks are strictly two-sided (one button per side, per the
            // brief's own schema: side_a_label/side_b_label) - a market with any
            // other outcome count isn't eligible.
            if (!prop.odds || prop.odds.outcomes.length !== 2) continue;
            const haystack = `${game.away} ${game.home} ${prop.player} ${prop.market}`.toLowerCase();
            if (term && !haystack.includes(term)) continue;
            const subject = prop.player && prop.player !== game.away && prop.player !== game.home ? `${prop.player}: ` : '';
            matches.push({ label: `${subject}${game.away} @ ${game.home}`.slice(0, 100), value: prop.id });
            if (matches.length >= MAX_SELECT_OPTIONS) break outer;
        }
    }

    if (matches.length === 0) {
        return ephemeral(`No live two-sided markets found for ${sport}${term ? ` matching "${keyword}"` : ''}.`);
    }
    // sport rides the select menu's own custom_id (":" -split, safe even for
    // multi-word sports like "La Liga" since only literal colons split) so it
    // survives into the confirm step - community_picks.sport needs it, and the
    // select step itself only carries a market id as its value.
    return selectMenuResponse(`cpselect:${sport}`, `Found ${matches.length} market(s) — pick one:`, matches);
}

function parseMarketOutcomes(market: any): { question: string; outcomes: string[]; outcomePrices: number[] } | null {
    const question = market?.question as string | undefined;
    let outcomes: string[] = [];
    let outcomePrices: number[] = [];
    try {
        outcomes = JSON.parse(market?.outcomes ?? '[]');
        outcomePrices = (JSON.parse(market?.outcomePrices ?? '[]') as string[]).map(Number);
    } catch { /* leave empty, caught by the length check below */ }
    if (!question || outcomes.length !== 2) return null;
    return { question, outcomes, outcomePrices };
}

export async function handleCommunityPickSelect(context: RequestContext, interaction: any, customId: string): Promise<Response> {
    const sport = customId.split(':')[1];
    const marketId: string | undefined = interaction.data?.values?.[0];
    if (!marketId || !sport) return updateMessageResponse("Couldn't read your selection.");

    const market = await fetchMarket(marketId);
    if (!market) return updateMessageResponse("Couldn't load that market's details - it may no longer be available.");
    const parsed = parseMarketOutcomes(market);
    if (!parsed) return updateMessageResponse("That market can't be used for a Community Pick (needs exactly two sides).");

    // Estimated split for the preview only - the authoritative, stored value is
    // always recomputed at confirm time from a fresh fetch (see
    // handleCommunityPickConfirm), so this can legitimately differ slightly if odds
    // moved in the seconds between clicks.
    const split = computePointsSplit(parsed.outcomePrices);
    const pointsPreview = split ? `\n${parsed.outcomes[0]} → ~${split.sideAPoints} pts  ·  ${parsed.outcomes[1]} → ~${split.sideBPoints} pts` : '';

    return updateMessageResponse(`Create a Community Pick for:\n**${parsed.question}**\n${parsed.outcomes[0]} vs. ${parsed.outcomes[1]}?${pointsPreview}`, [
        { label: 'Create', customId: `cpcreate:${marketId}:${sport}` },
        { label: 'Cancel', customId: 'cpcancel' },
    ]);
}

export async function handleCommunityPickConfirm(context: RequestContext, interaction: any, customId: string): Promise<Response> {
    const guildId: string | undefined = interaction.guild_id;
    const [, marketId, sport] = customId.split(':');
    const createdBy: string | undefined = interaction.member?.user?.id;
    if (!guildId || !marketId || !createdBy) return updateMessageResponse("Couldn't read your selection.");

    // Re-fetch fresh rather than trust the earlier preview - avoids acting on a market
    // that moved/closed between the select step and this confirm. The points split
    // stored below comes from THIS fetch, not the select step's - it's the one that
    // actually gets locked in.
    const market = await fetchMarket(marketId);
    if (!market) return updateMessageResponse("Couldn't load that market anymore - it may no longer be available.");
    const parsed = parseMarketOutcomes(market);
    if (!parsed) return updateMessageResponse("That market can't be used for a Community Pick anymore.");

    const resolution = resolveMarket(market);
    if (resolution.status === 'resolved') return updateMessageResponse('That market has already resolved - pick a live one.');

    const split = computePointsSplit(parsed.outcomePrices);
    if (!split) return updateMessageResponse("This market's odds aren't usable for scoring right now - try a different one.");

    const sql = getSql(context.env);
    const configRows = await sql`SELECT channel_id FROM discord_guild_configs WHERE guild_id = ${guildId}`;
    if (configRows.length === 0) return updateMessageResponse('This server has no channel configured - run /heatchecks-setup first.');
    const channelId = (configRows[0] as unknown as { channel_id: string }).channel_id;

    // 30 days out is a simple, generous default resolve window - Community Picks
    // don't carry their own admin-set date input in this pass; the settlement sweep
    // re-checks the market's own actual close state regardless, so this field mainly
    // exists for display copy on the card, not as the real gate on resolution.
    const resolveDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const result = await createAndPostCommunityPick(sql, context.env, {
        guildId, channelId, createdBy, sport: sport || null, marketId,
        question: parsed.question, sideALabel: parsed.outcomes[0], sideBLabel: parsed.outcomes[1],
        sourceOutcomes: parsed.outcomes, sideAPoints: split.sideAPoints, sideBPoints: split.sideBPoints, resolveDate,
    });

    if (result.status === 'duplicate') return updateMessageResponse('This market already has a Community Pick posted in this server.');
    if (result.status === 'post_failed') return updateMessageResponse('Created, but posting the card failed - try /heatchecks-post community-pick again shortly.');
    return updateMessageResponse('Posted!');
}

// ===================================================================================
// Community Pick voting - MESSAGE_COMPONENT "cpvote:<pickId>:<sideIndex>". No account
// link required (create_community_picks_tables.sql's own rationale: this ledger never
// touches the real economy, so there's no integrity reason to require it).
// ===================================================================================

export async function handleCommunityVote(context: RequestContext, interaction: any, customId: string): Promise<Response> {
    const parts = customId.split(':');
    const pickId = parts[1];
    const sideIndex = Number(parts[2]);
    if (!pickId || !Number.isInteger(sideIndex)) return ephemeral("Couldn't process that button.");

    const discordUserId: string | undefined = interaction.member?.user?.id ?? interaction.user?.id;
    if (!discordUserId) return ephemeral("Couldn't identify your Discord account.");

    const sql = getSql(context.env);
    const pickRows = await sql`SELECT status, resolve_date, side_a_label, side_b_label FROM community_picks WHERE id = ${pickId}`;
    if (pickRows.length === 0) return ephemeral("Couldn't find that Community Pick anymore.");
    const pick = pickRows[0] as unknown as { status: string; resolve_date: string; side_a_label: string; side_b_label: string };
    if (pick.status !== 'open' || new Date(pick.resolve_date).getTime() <= Date.now()) {
        return ephemeral('Voting is closed on this one.');
    }
    const sideLabel = sideIndex === 0 ? pick.side_a_label : pick.side_b_label;
    if (!sideLabel) return ephemeral("Couldn't process that button.");

    const linkRows = await sql`SELECT waitlist_id FROM discord_links WHERE discord_user_id = ${discordUserId} LIMIT 1`;
    const linkedUserId = (linkRows[0] as unknown as { waitlist_id: string } | undefined)?.waitlist_id ?? null;

    try {
        await sql`
            INSERT INTO community_picks_votes (community_pick_id, discord_user_id, linked_heatchecks_user_id, side_chosen)
            VALUES (${pickId}, ${discordUserId}, ${linkedUserId}, ${sideIndex})
            ON CONFLICT (community_pick_id, discord_user_id) DO NOTHING
            RETURNING id
        `;
    } catch (err) {
        console.error('[discord-commands] Failed to record Community Pick vote:', err);
        return ephemeral('Something went wrong recording your vote. Try again shortly.');
    }

    // Whether this insert was the first vote or a no-op retry, tell the voter their
    // vote (their FIRST one - votes are immutable) is recorded, same as if it just
    // landed - a second click never surprises them with a "changed" message it can't
    // actually deliver.
    const existingVote = await sql`SELECT side_chosen FROM community_picks_votes WHERE community_pick_id = ${pickId} AND discord_user_id = ${discordUserId}`;
    const recordedSideIndex = (existingVote[0] as unknown as { side_chosen: number }).side_chosen;
    const recordedLabel = recordedSideIndex === 0 ? pick.side_a_label : pick.side_b_label;
    return ephemeral(`Vote recorded: **${recordedLabel}**.`);
}

// ===================================================================================
// /heatchecks-draw - search settled, undrawn sources in this guild, draw immediately
// on selection (idempotent via community_giveaway_draws' own unique constraint, so no
// separate confirm step - a repeat click just shows the same winner again).
// ===================================================================================

interface DrawCandidateTank {
    kind: 'tank';
    tankPageId: string;
    label: string;
}
interface DrawCandidatePick {
    kind: 'community_pick';
    pickId: string;
    label: string;
}

export async function handleDrawCommand(context: RequestContext, interaction: any): Promise<Response> {
    const guildId: string | undefined = interaction.guild_id;
    if (!guildId) return ephemeral('Run this in a server, not a DM.');
    if (!hasManageGuildPermission(interaction)) return ephemeral('You need the "Manage Server" permission to run this.');

    const sql = getSql(context.env);

    const settledTanks = (await sql`
        SELECT dgp.tank_page_id, COALESCE(t.model_output->>'tagline', t.slug) AS label
        FROM discord_guild_posts dgp
        JOIN tank_pages t ON t.id = dgp.tank_page_id
        WHERE dgp.guild_id = ${guildId} AND dgp.settlement_posted_at IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM community_giveaway_draws d
              WHERE d.guild_id = ${guildId} AND d.source_type = 'tank' AND d.source_id = dgp.tank_page_id::text
          )
        ORDER BY dgp.posted_at DESC
        LIMIT 15
    `) as unknown as { tank_page_id: string; label: string }[];

    const settledPicks = (await sql`
        SELECT id, question_text FROM community_picks
        WHERE guild_id = ${guildId} AND status = 'settled'
          AND NOT EXISTS (
              SELECT 1 FROM community_giveaway_draws d
              WHERE d.guild_id = ${guildId} AND d.source_type = 'community_pick' AND d.source_id = community_picks.id::text
          )
        ORDER BY created_at DESC
        LIMIT 10
    `) as unknown as { id: string; question_text: string }[];

    const candidates: (DrawCandidateTank | DrawCandidatePick)[] = [
        ...settledTanks.map((t) => ({ kind: 'tank' as const, tankPageId: t.tank_page_id, label: t.label })),
        ...settledPicks.map((p) => ({ kind: 'community_pick' as const, pickId: p.id, label: p.question_text })),
    ];

    if (candidates.length === 0) {
        return ephemeral('Nothing settled and undrawn in this server right now.');
    }

    const options = candidates.slice(0, MAX_SELECT_OPTIONS).map((c) =>
        c.kind === 'tank'
            ? { label: c.label.slice(0, 100), value: `tank:${c.tankPageId}` }
            : { label: c.label.slice(0, 100), value: `community_pick:${c.pickId}` }
    );
    return selectMenuResponse('dwselect', 'Pick a settled source to draw a winner from:', options);
}

export async function handleDrawSelect(context: RequestContext, interaction: any): Promise<Response> {
    const value: string | undefined = interaction.data?.values?.[0];
    const guildId: string | undefined = interaction.guild_id;
    if (!value || !guildId) return updateMessageResponse("Couldn't read your selection.");
    const [sourceType, sourceId] = value.split(':') as [GiveawaySourceType, string];
    if (sourceType !== 'tank' && sourceType !== 'community_pick') return updateMessageResponse("Couldn't read your selection.");

    const sql = getSql(context.env);
    const drawnBy: string | undefined = interaction.member?.user?.id;
    const result = await drawGiveawayWinner(sql, context.env, { guildId, sourceType, sourceId, drawnBy: drawnBy ?? null });

    if (result.status === 'no_pool') {
        return updateMessageResponse('No eligible participants to draw from for that one.');
    }
    return updateMessageResponse(`Winner: <@${result.winnerDiscordUserId}>${result.status === 'already_drawn' ? ' (already drawn previously)' : ''}`);
}

// ===================================================================================
// /leaderboard's Community Points view - same live-membership-scoping pattern as the
// accuracy view in functions/api/discord/interactions.ts, ranked by community_points
// instead of picks.result.
// ===================================================================================

interface CommunityLeaderboardRow {
    discord_user_id: string;
    points: number;
}

export async function buildCommunityPointsLeaderboardMessage(env: Env, guildId: string): Promise<string> {
    const sql = getSql(env);
    const [members, { communityPointsLabel, leaderboardLabel }] = await Promise.all([
        fetchGuildMembers(env, guildId),
        getGuildLabels(sql, guildId),
    ]);
    const memberIds = members.filter((m) => !m.user.bot).map((m) => m.user.id);
    if (memberIds.length === 0) return 'No members to rank in this server yet.';

    const rows = (await sql`
        SELECT discord_user_id, points FROM community_points
        WHERE guild_id = ${guildId} AND discord_user_id = ANY(${memberIds}::text[]) AND points > 0
        ORDER BY points DESC
        LIMIT 10
    `) as unknown as CommunityLeaderboardRow[];

    if (rows.length === 0) return `Nobody in this server has any ${communityPointsLabel} yet.`;

    const nameById = new Map(members.map((m) => [m.user.id, m.user.global_name || m.user.username]));
    const lines = rows.map((r, i) => `**${i + 1}.** ${nameById.get(r.discord_user_id) ?? 'Unknown'} — ${r.points} ${communityPointsLabel}`);
    return `**${communityPointsLabel} ${leaderboardLabel}**\n${lines.join('\n')}`;
}

// ===================================================================================
// /heatchecks-league join|leave - season-long, opt-in leagues layered on top of
// Community Points. A league is purely a membership filter over the same
// community_points_transactions data everything else already writes to - joining
// creates no points of its own, it just decides who counts on the league leaderboard
// and from when (joined_at is the cutoff - see buildLeagueLeaderboardMessage).
// NFL-only for now (SUPPORTED_LEAGUE_SPORTS below), not the full SUPPORTED_SPORTS
// list, per the brief's "start with NFL only, generalize later if it proves out."
// ===================================================================================

export const SUPPORTED_LEAGUE_SPORTS = ['NFL'];

// A placeholder length matching a real NFL season's rough span (regular season plus
// some margin) - easy to retune later; there's no admin-facing date config for this
// in v1, per the plan's "no admin date-config command needed."
const LEAGUE_SEASON_LENGTH_DAYS = 150;

async function resolveOrCreateActiveLeagueSeason(sql: ReturnType<typeof getSql>, guildId: string, sport: string): Promise<string> {
    const existing = await sql`
        SELECT id FROM league_seasons
        WHERE guild_id = ${guildId} AND sport = ${sport} AND end_date > NOW()
        ORDER BY start_date DESC LIMIT 1
    `;
    if (existing.length > 0) return (existing[0] as unknown as { id: string }).id;

    const startDate = new Date();
    const endDate = new Date(startDate.getTime() + LEAGUE_SEASON_LENGTH_DAYS * 24 * 60 * 60 * 1000);
    const created = await sql`
        INSERT INTO league_seasons (guild_id, sport, start_date, end_date)
        VALUES (${guildId}, ${sport}, ${startDate.toISOString()}, ${endDate.toISOString()})
        RETURNING id
    `;
    return (created[0] as unknown as { id: string }).id;
}

export async function handleLeagueCommand(context: RequestContext, interaction: any): Promise<Response> {
    const guildId: string | undefined = interaction.guild_id;
    const discordUserId: string | undefined = interaction.member?.user?.id;
    if (!guildId || !discordUserId) return ephemeral('Run this in a server, not a DM.');

    const sub = interaction.data?.options?.[0];
    const subName: string | undefined = sub?.name;
    const sport: string | undefined = sub?.options?.find((o: any) => o.name === 'sport')?.value;
    if (!subName || !sport || !SUPPORTED_LEAGUE_SPORTS.includes(sport)) return ephemeral("Couldn't read that command.");

    const sql = getSql(context.env);

    if (subName === 'join') {
        const seasonId = await resolveOrCreateActiveLeagueSeason(sql, guildId, sport);
        await sql`
            INSERT INTO league_memberships (league_season_id, discord_user_id)
            VALUES (${seasonId}, ${discordUserId})
            ON CONFLICT (league_season_id, discord_user_id) DO NOTHING
        `;
        return ephemeral(`You're in! Points from ${sport} Community Picks count toward this server's ${sport} league leaderboard from now on.`);
    }

    if (subName === 'leave') {
        const rows = await sql`
            SELECT id FROM league_seasons
            WHERE guild_id = ${guildId} AND sport = ${sport} AND end_date > NOW()
            ORDER BY start_date DESC LIMIT 1
        `;
        if (rows.length === 0) return ephemeral(`There's no active ${sport} league in this server.`);
        const seasonId = (rows[0] as unknown as { id: string }).id;
        await sql`DELETE FROM league_memberships WHERE league_season_id = ${seasonId} AND discord_user_id = ${discordUserId}`;
        return ephemeral(`You've left this server's ${sport} league.`);
    }

    return ephemeral("Couldn't read that command.");
}

interface LeagueLeaderboardRow {
    discord_user_id: string;
    points: number;
}

// Scoped to a guild's currently-active season for the sport - past (end_date-passed)
// seasons stay queryable in the DB but aren't what this command shows; there's no
// "view a past season" option in v1. created_at >= joined_at is the whole point of a
// membership table existing at all: a mid-season joiner's total only ever reflects
// points earned after they joined, never retroactive.
export async function buildLeagueLeaderboardMessage(env: Env, guildId: string, sport: string): Promise<string> {
    const sql = getSql(env);
    const seasonRows = await sql`
        SELECT id FROM league_seasons
        WHERE guild_id = ${guildId} AND sport = ${sport} AND end_date > NOW()
        ORDER BY start_date DESC LIMIT 1
    `;
    if (seasonRows.length === 0) return `No active ${sport} league in this server yet — run /heatchecks-league join sport:${sport} to start one.`;
    const seasonId = (seasonRows[0] as unknown as { id: string }).id;

    const [rows, members] = await Promise.all([
        sql`
            SELECT lm.discord_user_id, SUM(cpt.delta)::int AS points
            FROM league_memberships lm
            JOIN community_points_transactions cpt
                ON cpt.guild_id = ${guildId}
                AND cpt.discord_user_id = lm.discord_user_id
                AND cpt.source_type = 'community_pick'
                AND cpt.created_at >= lm.joined_at
            JOIN community_picks cp ON cp.id::text = cpt.source_id AND cp.sport = ${sport}
            WHERE lm.league_season_id = ${seasonId}
            GROUP BY lm.discord_user_id
            ORDER BY points DESC
            LIMIT 10
        ` as unknown as Promise<LeagueLeaderboardRow[]>,
        fetchGuildMembers(env, guildId),
    ]);

    if (rows.length === 0) return `Nobody in this server's ${sport} league has scored any points yet.`;

    const nameById = new Map(members.map((m) => [m.user.id, m.user.global_name || m.user.username]));
    const lines = rows.map((r, i) => `**${i + 1}.** ${nameById.get(r.discord_user_id) ?? 'Unknown'} — ${r.points} pts`);
    return `**${sport} League Leaderboard**\n${lines.join('\n')}`;
}
