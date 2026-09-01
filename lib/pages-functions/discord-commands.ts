// Handlers for every Discord command/component added since the original pick-button
// bot: the /heatchecks admin hub (setup, settings, post <tank|community-pick|
// leaderboard>, draw), Community Pick voting, and the Community Points
// /leaderboard view. Imported and dispatched from functions/api/discord/
// interactions.ts, which owns the one Ed25519-verify-first entry point - nothing here
// is reachable except through that already-verified request.
//
// Admin-search flows (/heatchecks post, /heatchecks draw) all follow the same shape:
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
import { hasManageGuildPermission, fetchGuildMembers, postDiscordChannelMessage, clearMessageComponents, getGuildLabels, buildDiscordAvatarUrl, fetchGuildIconUrl, DEFAULT_COMMUNITY_POINTS_LABEL, DEFAULT_LEADERBOARD_LABEL } from './discord-api';
import type { LeaderboardMessage } from './discord-leaderboard-card';
import { computeSkillRatings } from './skill-rating';
import { brandEmbed } from './discord-brand';
// Pre-rendered branded headers (leaderboard-style navy/Orbitron plates, generated at
// build time - zero runtime CPU), attached above the matching embeds.
import BANNER_RESULTS from './art/banner-results.bin';
import { buildSettingsPanel } from './discord-setup-wizard';
import { computeLevels } from './leveling';
import { computePvpRecords } from './pvp-record';
import type { MeCardInput } from './me-card';
import { buildTankCardMessage, type TankCardModelOutput } from './discord-tank-card';
import { buildGiveawayResultMessage, buildNoEligiblePoolMessage } from './discord-community-card';
import { drawGiveawayWinner, type GiveawaySourceType } from './discord-draw';
import { fetchMarket, resolveMarket } from './gamma';
import { createAndPostCommunityPick } from './community-pick-creation';
import { computePointsSplit } from './community-points-formula';
import { describeMarket, formatKickoff, pickGameLines, buildMarketOption } from './market-menu';
import { fetchLiveGames } from '../../tank-gamma-live';
import { deriveTaglineFallback } from '../../tank-deck-format';

const RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE = 4;
const RESPONSE_UPDATE_MESSAGE = 7;
const EPHEMERAL_FLAG = 64;
const ACTION_ROW_TYPE = 1;
const SELECT_MENU_TYPE = 3;
const BUTTON_TYPE = 2;
const BUTTON_STYLE_SECONDARY = 2;
const BUTTON_STYLE_DANGER = 4;
const MAX_SELECT_OPTIONS = 25;

// A SUPERSET of curate.ts's SPORT_GROUPS: the eight leagues the whole pipeline knows
// (which can produce Tank pages, homepage slots and ticker constituents) plus four
// competitions that exist ONLY in Discord pick menus - see polymarket.ts's LEAGUE_TAGS
// for why. Picking one of those four here yields a Community Pick or a PvP pick and
// nothing else; no Tank will ever carry that league.
// Must stay set-equal with discord-setup-wizard.ts's SPORT_GROUPS (its ALL_LEAGUES
// drives disabled_sports) and with scripts/register-discord-commands.ts's own copy
// (the slash-command choice list). Three copies, no compile-time link between them.
export const SUPPORTED_SPORTS = [
    'NBA', 'NFL', 'MLB', 'EPL', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1',
    'EFL Championship', 'MLS', 'DFB-Pokal', 'Carabao Cup',
];

type RequestContext = Parameters<PagesFunction<Env>>[0];

export function ephemeral(content: string): Response {
    return new Response(
        JSON.stringify({ type: RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE, data: { content, flags: EPHEMERAL_FLAG } }),
        { headers: { 'Content-Type': 'application/json' } }
    );
}

// Ephemeral embed with a pre-rendered branded banner attached above it (interaction
// endpoints may respond with multipart/form-data to include files).
function ephemeralEmbedWithBanner(embed: Record<string, unknown>, banner: ArrayBuffer, filename: string): Response {
    const form = new FormData();
    form.append('payload_json', JSON.stringify({
        type: RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { embeds: [embed], flags: EPHEMERAL_FLAG },
    }));
    form.append('files[0]', new Blob([new Uint8Array(banner)], { type: 'image/png' }), filename);
    return new Response(form);
}

// Light branding for trivial text acks (league join/leave, config changes, Posted!)
// - a small gray HEATCHECKS tag under the line, no embed bloat.
function brandLine(text: string): string {
    return `${text}\n-# HEATCHECKS`;
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

// Manage Server re-check for the MID-FLOW steps of an admin flow (the select menus
// and confirm buttons), not just the command that opened it. Those components live on
// ephemeral messages only the invoking admin can see, so this isn't closing a hole a
// stranger could walk through - it closes the one real case: an admin demoted (or
// role-restricted via Server Settings -> Integrations) while a menu is still sitting
// open on their screen, who could otherwise finish the flow anyway. Same posture the
// entry-point commands and handleDrawButton already take; returns the denial as a
// type-7 update so it lands in the flow's own message rather than stacking a new one.
function denyIfNotAdmin(interaction: any): Response | null {
    return hasManageGuildPermission(interaction)
        ? null
        : updateMessageResponse('You need the "Manage Server" permission to do that.');
}

// Message payload for the deferred admin flows.
export interface DeferredMessageData {
    content?: string;
    embeds?: unknown[];
    components?: unknown[];
    // Optional attached image (e.g. a pre-rendered branded banner) - switches the
    // followup PATCH to multipart.
    file?: { data: ArrayBuffer; name: string };
}

function selectMenuData(customId: string, content: string, options: { label: string; value: string; description?: string }[]): DeferredMessageData {
    return {
        content,
        components: [{ type: ACTION_ROW_TYPE, components: [{ type: SELECT_MENU_TYPE, custom_id: customId, options: options.slice(0, MAX_SELECT_OPTIONS) }] }],
    };
}

const RESPONSE_DEFERRED = 5;

// Ack-first plumbing for every command whose real work (DB round-trips, Polymarket
// pagination) can't be trusted inside Discord's hard 3-second response window -
// especially right after a deploy, when a cold isolate + cold DB connection stack up
// ("The application did not respond" twice in live testing). Immediate ephemeral
// deferred ack, real content via webhook PATCH to @original, error fallback so the
// interaction can never hang.
export function deferredEphemeral(context: RequestContext, interaction: any, work: Promise<DeferredMessageData>): Response {
    const applicationId: string | undefined = interaction.application_id;
    const token: string | undefined = interaction.token;
    if (!applicationId || !token) return ephemeral("Couldn't process that command - try again.");

    context.waitUntil(
        work
            .catch((err) => {
                console.error('[discord-commands] Deferred command failed:', err);
                return { content: 'Something went wrong — try again shortly.' } as DeferredMessageData;
            })
            .then((data) => {
                const url = `https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/@original`;
                const payload = { content: data.content ?? '', embeds: data.embeds ?? [], components: data.components ?? [] };
                if (data.file) {
                    const form = new FormData();
                    form.append('payload_json', JSON.stringify(payload));
                    form.append('files[0]', new Blob([new Uint8Array(data.file.data)], { type: 'image/png' }), data.file.name);
                    return fetch(url, { method: 'PATCH', body: form });
                }
                return fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            })
    );

    return new Response(
        JSON.stringify({ type: RESPONSE_DEFERRED, data: { flags: EPHEMERAL_FLAG } }),
        { headers: { 'Content-Type': 'application/json' } }
    );
}

// `/heatchecks setup` now lives in lib/pages-functions/discord-setup-wizard.ts (the
// guided wizard; the old channel-option quick path survives there unchanged).

// Bare `/heatchecks settings` opens the interactive settings panel, which lives in
// lib/pages-functions/discord-setup-wizard.ts next to the step screens it reuses -
// one implementation of "show and change this guild's settings," not a read-only
// overview here and a separate editing flow there.

// ===================================================================================
// `/heatchecks settings` - bare opens the interactive panel; the option form below is
// the power-user shortcut (one flag, one write, no clicking).
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
    const settlementVisibilityOpt = options.find((o: any) => o.name === 'settlement_visibility')?.value as string | undefined;

    // Bare = the interactive panel: current values plus a button for every setting,
    // including the ones that have no flag here at all (cadence, extra channels,
    // weekly post, member-command visibility) and used to be wizard-only.
    if (sport === undefined && autoDrawOpt === undefined && pointsNameOpt === undefined && leaderboardNameOpt === undefined && settlementVisibilityOpt === undefined) {
        return buildSettingsPanel(context, guildId, true);
    }
    if (sport !== undefined && enabledOpt === undefined) {
        return ephemeral('Specify enabled:true or enabled:false along with the sport.');
    }

    const sql = getSql(context.env);
    const existing = await sql`SELECT disabled_sports FROM discord_guild_configs WHERE guild_id = ${guildId}`;
    if (existing.length === 0) {
        return ephemeral('Run `/heatchecks setup` first to choose a channel for this server.');
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
    if (settlementVisibilityOpt !== undefined) {
        await sql`UPDATE discord_guild_configs SET settlement_visibility = ${settlementVisibilityOpt} WHERE guild_id = ${guildId}`;
        replies.push(
            settlementVisibilityOpt === 'private'
                ? 'Settlement results are now private - no recap posts to the channel; members check /my-results instead.'
                : 'Settlement results now post to the channel again.'
        );
    }
    return ephemeral(brandLine(replies.join(' ')));
}

// ===================================================================================
// `/heatchecks post` - an on-demand real-Tank push, and Community Pick
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
        return deferredEphemeral(context, interaction, tankSearchData(context, search));
    }
    if (sub?.name === 'community-pick') {
        const sport = sub.options?.find((o: any) => o.name === 'sport')?.value as string | undefined;
        const keyword = sub.options?.find((o: any) => o.name === 'keyword')?.value as string | undefined;
        const channel = sub.options?.find((o: any) => o.name === 'channel')?.value as string | undefined;
        if (!sport) return ephemeral('Missing sport.');
        return deferredEphemeral(context, interaction, communityPickSearchData(context, guildId, sport, keyword, channel));
    }
    return ephemeral('Unknown subcommand.');
}

// ===================================================================================
// Search-menu formatting - every admin search menu (Tank post, Community Pick,
// draw) had cryptic one-line options (editorial taglines, bare matchups) with
// Discord's per-option `description` line left empty, making it hard to tell which
// matchup / date / prop bet a row actually was. These helpers put the identifying
// facts front and center: label carries matchup + the actual bet, description
// carries league, kickoff (US/Eastern, the sports-schedule convention), and
// odds/editorial context.
// ===================================================================================

// describeMarket / formatKickoff moved to lib/pages-functions/market-menu.ts, which owns
// every "pick a market" row now that /pvp and the Community Pick search share one builder.
// Re-exported so existing importers of this module keep working.
export { describeMarket, formatKickoff } from './market-menu';

interface TankSearchRow {
    slug: string;
    league: string;
    model_output: TankCardModelOutput | string;
    game_snapshot: { game?: { away?: string; home?: string; kickoff?: string }; prop?: { market?: string; player?: string; line?: number | null } } | null;
}

async function tankSearchData(context: RequestContext, search: string): Promise<DeferredMessageData> {
    const sql = getSql(context.env);
    const term = `%${search}%`;
    const rows = (await sql`
        SELECT slug, league, model_output, game_snapshot
        FROM tank_pages
        WHERE status = 'published' AND visibility = 'app'
          AND (slug ILIKE ${term} OR model_output->>'tagline' ILIKE ${term} OR model_output->>'hook' ILIKE ${term})
        ORDER BY published_at DESC
        LIMIT ${MAX_SELECT_OPTIONS}
    `) as unknown as TankSearchRow[];

    if (rows.length === 0) return { content: `No Tanks found matching "${search}".` };

    // Upcoming games first, soonest at the top; already-kicked-off/undated Tanks
    // follow in their original most-recently-published order.
    const now = Date.now();
    const kickoffOf = (r: TankSearchRow) => {
        const t = new Date(r.game_snapshot?.game?.kickoff ?? '').getTime();
        return Number.isNaN(t) ? null : t;
    };
    const sorted = [...rows].sort((a, b) => {
        const ka = kickoffOf(a);
        const kb = kickoffOf(b);
        const aUpcoming = ka !== null && ka > now;
        const bUpcoming = kb !== null && kb > now;
        if (aUpcoming && bUpcoming) return ka! - kb!;
        if (aUpcoming) return -1;
        if (bUpcoming) return 1;
        return 0; // both past/undated - keep the query's published-recency order
    });

    const options = sorted.map((row) => {
        const modelOutput: TankCardModelOutput | null = typeof row.model_output === 'string' ? JSON.parse(row.model_output) : row.model_output;
        const tagline = (modelOutput?.tagline?.trim() || modelOutput?.hook || row.slug).slice(0, 100);
        const game = row.game_snapshot?.game;
        const prop = row.game_snapshot?.prop;
        if (!game?.away || !game?.home) {
            // Older Tank without a usable snapshot - the tagline is all we have.
            return { label: tagline, value: row.slug };
        }
        const marketLabel = describeMarket(prop?.market, prop?.line);
        // Player props: lead with the player, since that's the bet's identity.
        const isPlayerProp = prop?.player && !prop.player.includes(' vs') && prop.player !== game.away && prop.player !== game.home;
        const bet = isPlayerProp ? `${prop!.player} ${marketLabel}` : marketLabel;
        const label = `${game.away} @ ${game.home} · ${bet}`.slice(0, 100);
        const description = [row.league, formatKickoff(game.kickoff), tagline].filter(Boolean).join(' · ').slice(0, 100);
        return { label, value: row.slug, description };
    });
    return selectMenuData('tpselect', `Found ${rows.length} Tank(s) — pick one to post:`, options);
}

interface TankRowForPost {
    id: string;
    model_output: TankCardModelOutput | string;
    game_snapshot: unknown;
}

async function postTankAndRespond(context: RequestContext, guildId: string, slug: string, isRepost: boolean): Promise<Response> {
    const sql = getSql(context.env);
    const configRows = await sql`SELECT channel_id FROM discord_guild_configs WHERE guild_id = ${guildId}`;
    if (configRows.length === 0) return updateMessageResponse('This server has no channel configured - run `/heatchecks setup` first.');
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
        return updateMessageResponse(brandLine(isRepost ? 'Reposted.' : 'Posted!'));
    } catch (err) {
        console.error('[discord-commands] Failed to post Tank on demand:', err);
        return updateMessageResponse('Something went wrong posting that Tank. Try again shortly.');
    }
}

export async function handleTankPostSelect(context: RequestContext, interaction: any): Promise<Response> {
    const denied = denyIfNotAdmin(interaction);
    if (denied) return denied;
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
    const denied = denyIfNotAdmin(interaction);
    if (denied) return denied;
    const guildId: string | undefined = interaction.guild_id;
    const slug = customId.split(':')[1];
    if (!slug || !guildId) return updateMessageResponse("Couldn't read your selection.");
    return postTankAndRespond(context, guildId, slug, true);
}

// --- Community Pick creation ---

interface MarketSearchOption {
    label: string;
    value: string; // Polymarket market id
    description?: string;
}

async function communityPickSearchData(context: RequestContext, guildId: string, sport: string, keyword?: string, channelId?: string): Promise<DeferredMessageData> {
    const configRows = await getSql(context.env)`SELECT channel_id, community_pick_channel_ids FROM discord_guild_configs WHERE guild_id = ${guildId}`;
    if (configRows.length === 0) return { content: 'Run `/heatchecks setup` first to choose a channel for this server.' };

    // Optional target channel - must be the main channel or one of the wizard's
    // approved Community Pick channels.
    if (channelId) {
        const cfg = configRows[0] as unknown as { channel_id: string; community_pick_channel_ids: string[] | string };
        const extras: string[] = Array.isArray(cfg.community_pick_channel_ids) ? cfg.community_pick_channel_ids : JSON.parse((cfg.community_pick_channel_ids as string) ?? '[]');
        if (channelId !== cfg.channel_id && !extras.includes(channelId)) {
            return { content: `<#${channelId}> isn't an approved Community Pick channel - add it in /heatchecks settings → Channels first.` };
        }
    }

    let games;
    try {
        games = await fetchLiveGames([sport]);
    } catch (err) {
        console.error('[discord-commands] fetchLiveGames failed:', err);
        return { content: 'Could not reach Polymarket right now - try again shortly.' };
    }

    const term = keyword?.trim().toLowerCase();
    const matches: MarketSearchOption[] = [];
    // Soonest game first, and no games that already kicked off - voting closes at
    // game start, so offering an in-progress game would only create dead picks.
    const now = Date.now();
    const searchable = games
        .filter((g) => {
            const t = new Date(g.kickoff).getTime();
            return Number.isNaN(t) || t > now;
        })
        .sort((a, b) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime());
    // One row per bet TYPE per matchup (moneyline / spread / total), not one per market:
    // a single MLB game carries four spread rungs and three totals, which used to fill the
    // whole menu with one fixture. See market-menu.ts#pickGameLines.
    outer: for (const game of searchable) {
        for (const prop of pickGameLines(game)) {
            // The keyword matches the raw market key AND the humanized label, so both
            // "spreads" and "spread" find the same rows.
            const haystack = `${game.away} ${game.home} ${prop.player} ${prop.market} ${describeMarket(prop.market, prop.line)}`.toLowerCase();
            if (term && !haystack.includes(term)) continue;

            // Bet first, matchup as a short team code - Discord truncates the tail of a
            // label, and the matchup used to consume all of it.
            const option = buildMarketOption(game, prop);
            if (!option) continue;
            matches.push(option);
            if (matches.length >= MAX_SELECT_OPTIONS) break outer;
        }
    }

    if (matches.length === 0) {
        return { content: `No live two-sided markets found for ${sport}${term ? ` matching "${keyword}"` : ''}.` };
    }
    // sport and target channel ride the select menu's own custom_id (":"-split,
    // safe even for multi-word sports like "La Liga" since only literal colons
    // split) so they survive through the select and confirm steps.
    return selectMenuData(`cpselect:${sport}:${channelId ?? ''}`, `Found ${matches.length} market(s) — pick one:`, matches);
}

// Gamma serves gameStartTime as "2026-08-29 17:05:00+00" (space-separated, bare
// offset) - normalize to ISO before Date parsing so it's engine-independent.
export function parseGameStartTime(raw: string | null | undefined): Date | null {
    if (!raw) return null;
    const iso = raw.includes('T') ? raw : raw.replace(' ', 'T').replace(/\+00$/, '+00:00');
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
}

export function parseMarketOutcomes(market: any): { question: string; outcomes: string[]; outcomePrices: number[] } | null {
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

// The confirm screen, shared by the market-select step and the giveaway-select step
// (which re-renders it with a new winner count baked into the Create button's
// custom_id - components are stateless, so the choice lives in the id).
function communityPickConfirmScreen(
    marketId: string, sport: string, channelId: string, gwCount: number,
    parsed: { question: string; outcomes: string[]; outcomePrices: number[] }
): Response {
    const split = computePointsSplit(parsed.outcomePrices);
    const pointsPreview = split ? `\n${parsed.outcomes[0]} → ~${split.sideAPoints} pts  ·  ${parsed.outcomes[1]} → ~${split.sideBPoints} pts` : '';
    const gwLine = gwCount > 0
        ? `\n🎉 Giveaway: **${gwCount} winner${gwCount === 1 ? '' : 's'}** drawn from correct calls at settlement (you supply any prize - Heatchecks only names winners).`
        : '';
    const chanLine = channelId ? `\nPosting to <#${channelId}>.` : '';
    const stateSuffix = `${marketId}:${sport}:${channelId}`;
    return new Response(
        JSON.stringify({
            type: RESPONSE_UPDATE_MESSAGE,
            data: {
                content: `Create a Community Pick for:\n**${parsed.question}**\n${parsed.outcomes[0]} vs. ${parsed.outcomes[1]}?${pointsPreview}${chanLine}${gwLine}`,
                embeds: [],
                components: [
                    {
                        type: ACTION_ROW_TYPE,
                        components: [{
                            type: SELECT_MENU_TYPE, custom_id: `cpgw:${stateSuffix}`, placeholder: 'Giveaway for correct calls? (optional)',
                            options: [
                                { label: 'No giveaway', value: '0' },
                                { label: '1 winner', value: '1' },
                                { label: '3 winners', value: '3' },
                                { label: '5 winners', value: '5' },
                            ],
                        }],
                    },
                    {
                        type: ACTION_ROW_TYPE,
                        components: [
                            { type: BUTTON_TYPE, style: 1, label: 'Create', custom_id: `cpcreate:${stateSuffix}:${gwCount}` },
                            { type: BUTTON_TYPE, style: BUTTON_STYLE_SECONDARY, label: 'Cancel', custom_id: 'cpcancel' },
                        ],
                    },
                ],
            },
        }),
        { headers: { 'Content-Type': 'application/json' } }
    );
}

export async function handleCommunityPickSelect(context: RequestContext, interaction: any, customId: string): Promise<Response> {
    const denied = denyIfNotAdmin(interaction);
    if (denied) return denied;
    const [, sport, channelId = ''] = customId.split(':');
    const marketId: string | undefined = interaction.data?.values?.[0];
    if (!marketId || !sport) return updateMessageResponse("Couldn't read your selection.");

    const market = await fetchMarket(marketId);
    if (!market) return updateMessageResponse("Couldn't load that market's details - it may no longer be available.");
    const parsed = parseMarketOutcomes(market);
    if (!parsed) return updateMessageResponse("That market can't be used for a Community Pick (needs exactly two sides).");

    // Preview odds only - the authoritative, stored split is always recomputed at
    // confirm time from a fresh fetch (see handleCommunityPickConfirm).
    return communityPickConfirmScreen(marketId, sport, channelId, 0, parsed);
}

// Giveaway winner-count select on the confirm screen - re-renders the same screen
// with the chosen count baked into the Create button.
export async function handleCommunityGiveawaySelect(context: RequestContext, interaction: any, customId: string): Promise<Response> {
    const denied = denyIfNotAdmin(interaction);
    if (denied) return denied;
    const [, marketId, sport, channelId = ''] = customId.split(':');
    const gwCount = Number(interaction.data?.values?.[0] ?? '0') || 0;
    if (!marketId || !sport) return updateMessageResponse("Couldn't read your selection.");

    const market = await fetchMarket(marketId);
    if (!market) return updateMessageResponse("Couldn't load that market anymore - it may no longer be available.");
    const parsed = parseMarketOutcomes(market);
    if (!parsed) return updateMessageResponse("That market can't be used for a Community Pick anymore.");

    return communityPickConfirmScreen(marketId, sport, channelId, gwCount, parsed);
}

export async function handleCommunityPickConfirm(context: RequestContext, interaction: any, customId: string): Promise<Response> {
    const denied = denyIfNotAdmin(interaction);
    if (denied) return denied;
    const guildId: string | undefined = interaction.guild_id;
    const [, marketId, sport, targetChannelId = '', gwRaw = '0'] = customId.split(':');
    const giveawayWinnerCount = Math.max(0, Math.min(25, Number(gwRaw) || 0));
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

    // Hard stop at game time - same posture as real Tank picks: once the game has
    // started, no new pick (and votes close at this same moment, see
    // handleCommunityVote).
    const kickoff = parseGameStartTime((market as any).gameStartTime);
    if (kickoff && kickoff.getTime() <= Date.now()) {
        return updateMessageResponse('That game has already started - pick an upcoming one.');
    }

    const split = computePointsSplit(parsed.outcomePrices);
    if (!split) return updateMessageResponse("This market's odds aren't usable for scoring right now - try a different one.");

    const sql = getSql(context.env);
    const configRows = await sql`SELECT channel_id, community_pick_channel_ids FROM discord_guild_configs WHERE guild_id = ${guildId}`;
    if (configRows.length === 0) return updateMessageResponse('This server has no channel configured - run `/heatchecks setup` first.');
    const cfg = configRows[0] as unknown as { channel_id: string; community_pick_channel_ids: string[] | string };
    const extras: string[] = Array.isArray(cfg.community_pick_channel_ids) ? cfg.community_pick_channel_ids : JSON.parse((cfg.community_pick_channel_ids as string) ?? '[]');
    // Re-validate the target channel server-side (custom_ids are client-round-tripped).
    const channelId = targetChannelId && (targetChannelId === cfg.channel_id || extras.includes(targetChannelId))
        ? targetChannelId
        : cfg.channel_id;

    // Resolve display date: the day after kickoff when the game time is known
    // (games resolve within hours of ending - the old now+30d placeholder made
    // cards claim absurdly late dates), else the market's own endDate, else a
    // 30-day fallback. The settlement sweep checks the market's real close state
    // regardless - this is honest display copy, not the resolution gate.
    const marketEnd = parseGameStartTime((market as any).endDate as string | undefined);
    const resolveDate = kickoff
        ? new Date(kickoff.getTime() + 24 * 60 * 60 * 1000).toISOString()
        : (marketEnd ? marketEnd.toISOString() : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString());

    const result = await createAndPostCommunityPick(sql, context.env, {
        guildId, channelId, createdBy, sport: sport || null, marketId,
        question: parsed.question, sideALabel: parsed.outcomes[0], sideBLabel: parsed.outcomes[1],
        sourceOutcomes: parsed.outcomes, sideAPoints: split.sideAPoints, sideBPoints: split.sideBPoints, resolveDate,
        kickoffAt: kickoff ? kickoff.toISOString() : null,
        giveawayWinnerCount,
    });

    if (result.status === 'duplicate') return updateMessageResponse('This market already has a Community Pick posted in this server.');
    if (result.status === 'post_failed') return updateMessageResponse('Created, but posting the card failed - try `/heatchecks post community-pick` again shortly.');
    return updateMessageResponse(brandLine('Posted!'));
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
    const pickRows = await sql`SELECT status, resolve_date, kickoff_at, side_a_label, side_b_label FROM community_picks WHERE id = ${pickId}`;
    if (pickRows.length === 0) return ephemeral("Couldn't find that Community Pick anymore.");
    const pick = pickRows[0] as unknown as { status: string; resolve_date: string; kickoff_at: string | null; side_a_label: string; side_b_label: string };
    if (pick.status !== 'open' || new Date(pick.resolve_date).getTime() <= Date.now()) {
        return ephemeral('Voting is closed on this one.');
    }
    // Hard stop at game time, same as real Tank picks - the pick stays visible but
    // can't be voted once the game is underway.
    if (pick.kickoff_at && new Date(pick.kickoff_at).getTime() <= Date.now()) {
        return ephemeral('This game has already started - voting is closed.');
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
// `/heatchecks draw` - search settled, undrawn sources in this guild, draw immediately
// on selection (idempotent via community_giveaway_draws' own unique constraint, so no
// separate confirm step - a repeat click just shows the same winner again).
// ===================================================================================

export async function handleDrawCommand(context: RequestContext, interaction: any): Promise<Response> {
    const guildId: string | undefined = interaction.guild_id;
    if (!guildId) return ephemeral('Run this in a server, not a DM.');
    if (!hasManageGuildPermission(interaction)) return ephemeral('You need the "Manage Server" permission to run this.');
    return deferredEphemeral(context, interaction, drawSearchData(context, guildId));
}

async function drawSearchData(context: RequestContext, guildId: string): Promise<DeferredMessageData> {
    const sql = getSql(context.env);

    const settledTanks = (await sql`
        SELECT dgp.tank_page_id, COALESCE(t.model_output->>'tagline', t.slug) AS label,
               t.league,
               t.game_snapshot->'game'->>'away' AS away,
               t.game_snapshot->'game'->>'home' AS home,
               t.game_snapshot->'prop'->>'market' AS market,
               t.game_snapshot->'prop'->>'line' AS line,
               dgp.settlement_posted_at
        FROM discord_guild_posts dgp
        JOIN tank_pages t ON t.id = dgp.tank_page_id
        WHERE dgp.guild_id = ${guildId} AND dgp.settlement_posted_at IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM community_giveaway_draws d
              WHERE d.guild_id = ${guildId} AND d.source_type = 'tank' AND d.source_id = dgp.tank_page_id::text
          )
        ORDER BY dgp.posted_at DESC
        LIMIT 15
    `) as unknown as { tank_page_id: string; label: string; league: string; away: string | null; home: string | null; market: string | null; line: string | null; settlement_posted_at: string }[];

    const settledPicks = (await sql`
        SELECT id, question_text, side_a_label, side_b_label, winning_side FROM community_picks
        WHERE guild_id = ${guildId} AND status = 'settled'
          AND NOT EXISTS (
              SELECT 1 FROM community_giveaway_draws d
              WHERE d.guild_id = ${guildId} AND d.source_type = 'community_pick' AND d.source_id = community_picks.id::text
          )
        ORDER BY created_at DESC
        LIMIT 10
    `) as unknown as { id: string; question_text: string; side_a_label: string; side_b_label: string; winning_side: number | null }[];

    if (settledTanks.length === 0 && settledPicks.length === 0) {
        return { content: 'Nothing settled and undrawn in this server right now.' };
    }

    // Same label/description shape as the other search menus: what the bet was on
    // the label, source type + winner/settled context on the description.
    const options = [
        ...settledTanks.map((t) => ({
            label: (t.away && t.home ? `${t.away} @ ${t.home} · ${describeMarket(t.market, t.line)}` : t.label).slice(0, 100),
            value: `tank:${t.tank_page_id}`,
            description: ['Tank', t.league, `settled ${formatKickoff(t.settlement_posted_at)}`, t.label].filter(Boolean).join(' · ').slice(0, 100),
        })),
        ...settledPicks.map((p) => ({
            label: p.question_text.slice(0, 100),
            value: `community_pick:${p.id}`,
            description: ['Community Pick', p.winning_side !== null ? `winner: ${p.winning_side === 0 ? p.side_a_label : p.side_b_label}` : ''].filter(Boolean).join(' · ').slice(0, 100),
        })),
    ].slice(0, MAX_SELECT_OPTIONS);
    return selectMenuData('dwselect', 'Pick a settled source to draw a winner from:', options);
}

export async function handleDrawSelect(context: RequestContext, interaction: any): Promise<Response> {
    const denied = denyIfNotAdmin(interaction);
    if (denied) return denied;
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

// The "Draw a winner" button on a settlement recap - the same draw as the search
// command, minus the search: the recap already identifies the source. The recap is a
// PUBLIC message, so Manage Server is re-checked here (a member who clicks gets a
// private "you need permission" reply and nothing happens). The winner announcement
// posts publicly like an auto-draw would; the button is then stripped from the recap
// best-effort, so a settled pick is only ever drawn once by hand.
export async function handleDrawButton(context: RequestContext, interaction: any, customId: string): Promise<Response> {
    const guildId: string | undefined = interaction.guild_id;
    if (!guildId) return ephemeral('Run this in a server, not a DM.');
    if (!hasManageGuildPermission(interaction)) return ephemeral('Only admins (Manage Server) can draw a winner.');

    const [, sourceType, sourceId] = customId.split(':') as [string, GiveawaySourceType, string];
    if ((sourceType !== 'tank' && sourceType !== 'community_pick') || !sourceId) {
        return ephemeral("Couldn't process that button.");
    }

    const sql = getSql(context.env);
    const drawnBy: string | undefined = interaction.member?.user?.id;
    const result = await drawGiveawayWinner(sql, context.env, { guildId, sourceType, sourceId, drawnBy: drawnBy ?? null });

    const sourceLabel: string = interaction.message?.embeds?.[0]?.title ?? 'Settled pick';
    // A winner is public (same as an auto-draw announcement); an empty pool is only
    // the clicking admin's problem, so it stays private rather than adding channel
    // noise to a recap that's still offering the button.
    const body = result.status === 'no_pool'
        ? { ...buildNoEligiblePoolMessage(sourceLabel), flags: EPHEMERAL_FLAG }
        : buildGiveawayResultMessage(sourceLabel, result.winnerDiscordUserId);

    // Only retire the button once a winner actually exists - an empty pool is worth
    // retrying later (someone could still be linked/added), a drawn winner is not.
    const channelId: string | undefined = interaction.channel_id;
    const messageId: string | undefined = interaction.message?.id;
    if (result.status !== 'no_pool' && channelId && messageId) {
        context.waitUntil(clearMessageComponents(context.env, channelId, messageId));
    }

    return new Response(
        JSON.stringify({ type: RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE, data: body }),
        { headers: { 'Content-Type': 'application/json' } }
    );
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

export async function buildCommunityPointsLeaderboardMessage(env: Env, guildId: string): Promise<LeaderboardMessage> {
    const sql = getSql(env);
    const [members, { communityPointsLabel, leaderboardLabel }] = await Promise.all([
        fetchGuildMembers(env, guildId),
        getGuildLabels(sql, guildId),
    ]);
    const memberIds = members.filter((m) => !m.user.bot).map((m) => m.user.id);
    if (memberIds.length === 0) return { content: 'No members to rank in this server yet.', headerLabel: '', rows: [] };

    const rows = (await sql`
        SELECT discord_user_id, points FROM community_points
        WHERE guild_id = ${guildId} AND discord_user_id = ANY(${memberIds}::text[]) AND points > 0
        ORDER BY points DESC
        LIMIT 10
    `) as unknown as CommunityLeaderboardRow[];

    if (rows.length === 0) return { content: `Nobody in this server has any ${communityPointsLabel} yet.`, headerLabel: '', rows: [] };

    const memberById = new Map(members.map((m) => [m.user.id, m.user]));
    const srById = await computeSkillRatings(sql, guildId, rows.map((r) => r.discord_user_id));
    const rankedRows = rows.map((r, i) => {
        const member = memberById.get(r.discord_user_id);
        return {
            rank: i + 1,
            displayName: member?.global_name || member?.username || 'Unknown',
            avatarUrl: buildDiscordAvatarUrl(r.discord_user_id, member?.avatar),
            scoreLine: `${r.points} ${communityPointsLabel}`,
            scoreValue: Number(r.points).toLocaleString('en-US'),
            sr: srById.get(r.discord_user_id) ?? 0,
        };
    });
    return {
        content: `**${communityPointsLabel} ${leaderboardLabel}**`,
        headerLabel: `OVERALL ${communityPointsLabel.toUpperCase()}`,
        rows: rankedRows,
    };
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
        return ephemeral(brandLine(`You're in! Points from ${sport} Community Picks count toward this server's ${sport} league leaderboard from now on.`));
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
        return ephemeral(brandLine(`You've left this server's ${sport} league.`));
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
export async function buildLeagueLeaderboardMessage(env: Env, guildId: string, sport: string): Promise<LeaderboardMessage> {
    const sql = getSql(env);
    const seasonRows = await sql`
        SELECT id FROM league_seasons
        WHERE guild_id = ${guildId} AND sport = ${sport} AND end_date > NOW()
        ORDER BY start_date DESC LIMIT 1
    `;
    if (seasonRows.length === 0) return { content: `No active ${sport} league in this server yet — run /heatchecks-league join sport:${sport} to start one.`, headerLabel: '', rows: [] };
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

    if (rows.length === 0) return { content: `Nobody in this server's ${sport} league has scored any points yet.`, headerLabel: '', rows: [] };

    const memberById = new Map(members.map((m) => [m.user.id, m.user]));
    const srById = await computeSkillRatings(sql, guildId, rows.map((r) => r.discord_user_id));
    const rankedRows = rows.map((r, i) => {
        const member = memberById.get(r.discord_user_id);
        return {
            rank: i + 1,
            displayName: member?.global_name || member?.username || 'Unknown',
            avatarUrl: buildDiscordAvatarUrl(r.discord_user_id, member?.avatar),
            scoreLine: `${r.points} pts`,
            scoreValue: Number(r.points).toLocaleString('en-US'),
            sr: srById.get(r.discord_user_id) ?? 0,
        };
    });
    return { content: `**${sport} League Leaderboard**`, headerLabel: `${sport} LEAGUE POINTS`, rows: rankedRows };
}

// ===================================================================================
// /leaderboard view:sr - ranked BY Skill Rating (everywhere else SR is display-only).
// Candidates: guild members with any settled picks or any Community Points.
// ===================================================================================

export async function buildSrLeaderboardMessage(env: Env, guildId: string): Promise<LeaderboardMessage> {
    const sql = getSql(env);
    const [members, { leaderboardLabel }] = await Promise.all([
        fetchGuildMembers(env, guildId),
        getGuildLabels(sql, guildId),
    ]);
    const memberIds = members.filter((m) => !m.user.bot).map((m) => m.user.id);
    if (memberIds.length === 0) return { content: 'No members to rank in this server yet.', headerLabel: '', rows: [] };

    const candidateRows = (await sql`
        SELECT DISTINCT dl.discord_user_id FROM discord_links dl
        JOIN picks p ON p.waitlist_id = dl.waitlist_id
        WHERE dl.discord_user_id = ANY(${memberIds}::text[]) AND p.result IS NOT NULL
        UNION
        SELECT discord_user_id FROM community_points
        WHERE guild_id = ${guildId} AND discord_user_id = ANY(${memberIds}::text[]) AND points > 0
    `) as unknown as { discord_user_id: string }[];
    const candidates = candidateRows.map((r) => r.discord_user_id);
    if (candidates.length === 0) return { content: 'Nobody in this server has any settled activity yet.', headerLabel: '', rows: [] };

    const srById = await computeSkillRatings(sql, guildId, candidates);
    const memberById = new Map(members.map((m) => [m.user.id, m.user]));
    const ranked = candidates
        .map((id) => ({ id, sr: srById.get(id) ?? 0 }))
        .sort((a, b) => b.sr - a.sr)
        .slice(0, 10);

    const rankedRows = ranked.map((r, i) => {
        const member = memberById.get(r.id);
        return {
            rank: i + 1,
            displayName: member?.global_name || member?.username || 'Unknown',
            avatarUrl: buildDiscordAvatarUrl(r.id, member?.avatar),
            scoreLine: `SR ${r.sr}`,
            scoreValue: String(r.sr),
            sr: r.sr,
        };
    });
    return { content: `**Skill Rating ${leaderboardLabel}**`, headerLabel: 'SKILL RATING', rows: rankedRows };
}

// ===================================================================================
// /me - gathers the personal-card inputs (points, Community Points rank, SR, LVL);
// rendering/delivery is lib/pages-functions/me-card.ts's layered-art card.
// ===================================================================================

export async function buildMeCardInput(env: Env, guildId: string, discordUserId: string): Promise<MeCardInput> {
    const sql = getSql(env);
    const [members, guildIconUrl] = await Promise.all([
        fetchGuildMembers(env, guildId),
        fetchGuildIconUrl(env, guildId),
    ]);
    const member = members.find((m) => m.user.id === discordUserId)?.user;

    const [pointsRows, rankRows, srById, levelById] = await Promise.all([
        sql`SELECT points FROM community_points WHERE guild_id = ${guildId} AND discord_user_id = ${discordUserId}`,
        sql`
            SELECT COUNT(*)::int AS ahead FROM community_points
            WHERE guild_id = ${guildId} AND points > COALESCE(
                (SELECT points FROM community_points WHERE guild_id = ${guildId} AND discord_user_id = ${discordUserId}), 0)
        `,
        computeSkillRatings(sql, guildId, [discordUserId]),
        computeLevels(sql, guildId, [discordUserId]),
    ]);
    // Fourth derived-on-read stat, same shape as SR and level (see
    // lib/pages-functions/pvp-record.ts). Kept out of the Promise.all above only
    // because it reads a different table set and is cheap enough to not matter.
    const pvpById = await computePvpRecords(sql, guildId, [discordUserId]);

    return {
        displayName: member?.global_name || member?.username || 'You',
        avatarUrl: buildDiscordAvatarUrl(discordUserId, member?.avatar),
        guildIconUrl,
        points: Number((pointsRows[0] as any)?.points ?? 0),
        rank: Number((rankRows[0] as any)?.ahead ?? 0) + 1,
        sr: srById.get(discordUserId) ?? 0,
        level: levelById.get(discordUserId)?.level ?? 1,
        pvpRecord: pvpById.get(discordUserId) ?? null,
    };
}

// ===================================================================================
// /my-results - a pull, not a push: always ephemeral (visible only to the caller,
// same RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE + EPHEMERAL_FLAG every other reply in
// this file uses), so it's the one place a picker can see their own recent results
// and awarded points without a channel broadcast or a DM - the alternative when a
// guild has set `/heatchecks settings settlement_visibility:Private` (see
// functions/api/discord-settlement-sweep.ts and
// functions/api/community-pick-settlement-sweep.ts, which skip their channel post
// in that mode but keep awarding points exactly as before). Works the same way
// regardless of that setting - a personal recap-on-demand is useful in Channel mode
// too, not just as the Private-mode fallback.
// ===================================================================================

const MY_RESULTS_LIMIT = 5;

interface MyTankResultRow {
    slug: string;
    model_output: { tagline?: string; hook: string } | string;
    side: string;
    result: string;
    points_awarded: number | null;
}

interface MyCommunityPickResultRow {
    question_text: string;
    side_a_label: string;
    side_b_label: string;
    side_chosen: number;
    winning_side: number;
    points_awarded: number | null;
}

export async function handleMyResultsCommand(context: RequestContext, interaction: any): Promise<Response> {
    const guildId: string | undefined = interaction.guild_id;
    const discordUserId: string | undefined = interaction.member?.user?.id;
    if (!guildId || !discordUserId) return ephemeral('Run this in a server, not a DM.');
    // Deferred like the other DB-backed commands - a cold isolate + cold DB
    // connection can't be trusted inside Discord's 3-second window.
    return deferredEphemeral(context, interaction, myResultsData(context, guildId, discordUserId));
}

async function myResultsData(context: RequestContext, guildId: string, discordUserId: string): Promise<DeferredMessageData> {
    const sql = getSql(context.env);
    const [tankRows, pickRows] = await Promise.all([
        sql`
            SELECT t.slug, t.model_output, p.side, p.result, cpt.delta AS points_awarded
            FROM picks p
            JOIN discord_links dl ON dl.waitlist_id = p.waitlist_id
            JOIN tank_pages t ON t.id = p.tank_page_id
            JOIN discord_guild_posts dgp ON dgp.guild_id = ${guildId} AND dgp.tank_page_id = t.id
            LEFT JOIN community_points_transactions cpt
                ON cpt.guild_id = ${guildId} AND cpt.discord_user_id = ${discordUserId}
                AND cpt.source_type = 'tank' AND cpt.source_id = t.id::text
            WHERE dl.discord_user_id = ${discordUserId} AND p.result IS NOT NULL
            ORDER BY p.settled_at DESC NULLS LAST
            LIMIT ${MY_RESULTS_LIMIT}
        ` as unknown as Promise<MyTankResultRow[]>,
        sql`
            SELECT cp.question_text, cp.side_a_label, cp.side_b_label, cpv.side_chosen, cp.winning_side, cpt.delta AS points_awarded
            FROM community_picks_votes cpv
            JOIN community_picks cp ON cp.id = cpv.community_pick_id AND cp.guild_id = ${guildId}
            LEFT JOIN community_points_transactions cpt
                ON cpt.guild_id = ${guildId} AND cpt.discord_user_id = ${discordUserId}
                AND cpt.source_type = 'community_pick' AND cpt.source_id = cp.id::text
            WHERE cpv.discord_user_id = ${discordUserId} AND cp.status = 'settled'
            ORDER BY cp.created_at DESC
            LIMIT ${MY_RESULTS_LIMIT}
        ` as unknown as Promise<MyCommunityPickResultRow[]>,
    ]);

    if (tankRows.length === 0 && pickRows.length === 0) {
        return { content: "No settled results yet - once something you picked or voted on settles, check back here." };
    }

    // points_awarded is read back from the already-stored transaction, never
    // recomputed here - same "never recompute, only display what was locked in"
    // discipline the cards themselves follow.
    const resultLine = (label: string, correct: boolean, points: number | null) =>
        correct ? `✓ ${label} — correct${points !== null ? ` (+${points} pts)` : ''}` : `✗ ${label} — incorrect`;

    const fields: { name: string; value: string }[] = [];
    if (tankRows.length > 0) {
        const lines = tankRows.map((r) => {
            const modelOutput = typeof r.model_output === 'string' ? JSON.parse(r.model_output) : r.model_output;
            const tagline = modelOutput?.tagline?.trim() || (modelOutput ? deriveTaglineFallback(modelOutput.hook) : r.slug);
            return resultLine(`${tagline} (${r.side})`, r.result === 'correct', r.points_awarded);
        });
        fields.push({ name: 'Real Tanks', value: lines.join('\n').slice(0, 1024) });
    }
    if (pickRows.length > 0) {
        const lines = pickRows.map((r) => {
            const pickedLabel = r.side_chosen === 0 ? r.side_a_label : r.side_b_label;
            return resultLine(`${r.question_text} (${pickedLabel})`, r.side_chosen === r.winning_side, r.points_awarded);
        });
        fields.push({ name: 'Community Picks', value: lines.join('\n').slice(0, 1024) });
    }

    return {
        embeds: [brandEmbed({ kind: 'system', body: 'Your recent settled calls in this server.', fields })],
        file: { data: BANNER_RESULTS, name: 'your-results.png' },
    };
}
