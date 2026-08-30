// POST /api/discord/interactions - Discord's Interactions Endpoint URL. Every request
// must be Ed25519-verified BEFORE the body is trusted at all (verifyDiscordRequest),
// using the exact raw body bytes Discord signed - hence reading text() first rather
// than json(). Discord also requires this endpoint to answer a bare PING with a PONG
// before it will even save the URL in the Developer Portal (see the plan's setup
// steps), so that has to work standalone with no other config in place yet.
//
// This file is a thin, verify-first dispatcher - every interaction kind routes
// through the SAME signature check before anything else touches the body, no separate
// unverified path for any command or component added since. The pick-button handler
// (the original interaction this endpoint supported) stays inline below; every newer
// admin command/component handler lives in
// ../../../lib/pages-functions/discord-commands.ts, imported here.
//
// - MESSAGE_COMPONENT "pick:<slug>:<sideIndex>" - a button click on a Tank post from
//   functions/api/discord-sweep.ts. The clicking Discord user is resolved to a
//   Heatchecks account via discord_links and the pick runs through the exact same
//   lib/pages-functions/picks.ts#submitPick the website itself uses - same daily cap,
//   same per-Tank conflict, same odds/kickoff validation. Guild context is
//   irrelevant here on purpose: the cap is one shared pool per Heatchecks account,
//   never per-guild (see submitPick's own cap query).
// - APPLICATION_COMMAND "leaderboard" - guild-scoped leaderboard (accuracy by
//   default, or Community Points via the `view` option). Computes guild membership
//   LIVE (fetchGuildMembers) rather than from any stored table. Deferred (type 5)
//   since the member fetch + DB query can exceed Discord's 3-second window; the real
//   reply follows via a webhook PATCH once ready.
// - Everything else (the /heatchecks admin hub - setup/settings/post/draw - and every
//   search-select/confirm component those subcommands drive) is handled in
//   discord-commands.ts - see that file's own header for the full rundown.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, type Env } from '../../../lib/pages-functions/db';
import { verifyDiscordRequest } from '../../../lib/pages-functions/discord-verify';
import { submitPick, type SubmitPickResult } from '../../../lib/pages-functions/picks';
import { fetchGuildMembers, getGuildLabels, buildDiscordAvatarUrl, hasManageGuildPermission } from '../../../lib/pages-functions/discord-api';
import type { LeaderboardMessage } from '../../../lib/pages-functions/discord-leaderboard-card';
import { sendLeaderboardResult, postLeaderboardToChannel } from '../../../lib/pages-functions/leaderboard-image';
import { computeSkillRatings } from '../../../lib/pages-functions/skill-rating';
import { handleSetupWizardCommand, handleWizardComponent, handleWizardModal, handleSettingsComponent, handleSettingsModal } from '../../../lib/pages-functions/discord-setup-wizard';
import {
    handleConfigCommand,
    handlePostCommand,
    handleDrawCommand,
    handleTankPostSelect,
    handleTankRepostConfirm,
    handleCommunityPickSelect,
    handleCommunityPickConfirm,
    handleCommunityGiveawaySelect,
    handleCommunityVote,
    handleDrawSelect,
    handleDrawButton,
    handleLeagueCommand,
    handleMyResultsCommand,
    updateMessageResponse,
    buildCommunityPointsLeaderboardMessage,
    buildLeagueLeaderboardMessage,
    buildSrLeaderboardMessage,
    buildMeCardInput,
} from '../../../lib/pages-functions/discord-commands';
import { sendMeCard } from '../../../lib/pages-functions/me-card';

const DISCORD_PING = 1;
const DISCORD_APPLICATION_COMMAND = 2;
const DISCORD_MESSAGE_COMPONENT = 3;
const DISCORD_MODAL_SUBMIT = 5;
const RESPONSE_PONG = 1;
const RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE = 4;
const RESPONSE_DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE = 5;
const EPHEMERAL_FLAG = 64;
const DEFAULT_LEADERBOARD_MIN_PICKS = 5;
const LEADERBOARD_SIZE = 10;

function ephemeral(content: string): Response {
    return new Response(
        JSON.stringify({ type: RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE, data: { content, flags: EPHEMERAL_FLAG } }),
        { headers: { 'Content-Type': 'application/json' } }
    );
}

function numEnv(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function messageForResult(result: SubmitPickResult): string {
    switch (result.status) {
        case 'not_found': return "Couldn't find that Tank anymore - it may have been unpublished.";
        case 'not_settleable': return 'This Tank is not accepting picks.';
        case 'side_mismatch': return "That side doesn't match this Tank's call.";
        case 'game_started': return 'This game has already started - picks are closed.';
        case 'no_odds': return 'This prop has no odds on record and cannot be picked.';
        case 'odds_mismatch': return "Call sides do not match recorded odds for this prop.";
        case 'side_index_out_of_range': return 'Something went wrong with that button - try again from the Tank page.';
        case 'malformed_odds': return 'Recorded odds are malformed and cannot be picked.';
        case 'cap_reached': return "You've used today's picks — back tomorrow.";
        case 'conflict': return `You already made this call: **${result.pick?.side ?? 'your pick'}**.`;
        case 'ok': return `Locked in: **${result.pick.side}**. (${result.picksToday}/${result.dailyCap} picks used today)`;
    }
}

// Avoids importing EventContext's generic signature directly - matches whatever
// PagesFunction<Env>'s own context parameter type resolves to. Shared shape with
// discord-commands.ts's own identical local alias (kept separate per-file rather than
// exported, to avoid a needless cross-file type dependency for a one-line alias).
type RequestContext = Parameters<PagesFunction<Env>>[0];

async function handlePickButton(context: RequestContext, interaction: any, customId: string): Promise<Response> {
    const parts = customId.split(':');
    if (parts.length !== 3) return ephemeral("Couldn't process that button.");
    const slug = parts[1];
    const sideIndex = Number(parts[2]);
    if (!slug || !Number.isInteger(sideIndex)) {
        return ephemeral("Couldn't process that button.");
    }

    const discordUserId: string | undefined = interaction.member?.user?.id ?? interaction.user?.id;
    if (!discordUserId) return ephemeral("Couldn't identify your Discord account.");

    const sql = getSql(context.env);
    const linkRows = await sql`
        SELECT dl.waitlist_id, w.onboarded_at
        FROM discord_links dl
        JOIN waitlist w ON w.id = dl.waitlist_id
        WHERE dl.discord_user_id = ${discordUserId}
        LIMIT 1
    `;
    if (linkRows.length === 0) {
        return ephemeral('Connect your Heatchecks account first: heatchecks.io/api/discord/link — takes a few seconds, and creates an account for you if you don\'t have one yet.');
    }
    const link = linkRows[0] as unknown as { waitlist_id: string; onboarded_at: string | null };
    if (!link.onboarded_at) {
        return ephemeral('Finish setting up your Heatchecks account at heatchecks.io/welcome/ before picking from Discord.');
    }

    // custom_id only carries the slug + sideIndex (kept short - Discord caps custom_id
    // at 100 chars, and slugs here can run long). sideIndex is the authoritative signal
    // anyway (same convention functions/api/picks.ts's client relies on), so the side
    // text is resolved server-side from the Tank's own recorded call.sides rather than
    // trusting anything out of the interaction payload itself.
    const sidesRows = await sql`
        SELECT model_output->'call'->'sides' AS sides
        FROM tank_pages WHERE slug = ${slug} AND status = 'published' AND visibility = 'app' LIMIT 1
    `;
    if (sidesRows.length === 0) {
        return ephemeral("Couldn't find that Tank anymore - it may have been unpublished.");
    }
    const rawSides = sidesRows[0].sides as unknown;
    const sides: string[] = Array.isArray(rawSides)
        ? (rawSides as string[])
        : (typeof rawSides === 'string' ? JSON.parse(rawSides) : []);
    const side = sides[sideIndex];
    if (!side) return ephemeral("Couldn't process that button.");

    let result: SubmitPickResult;
    try {
        result = await submitPick(sql, context.env, { waitlistId: link.waitlist_id, slug, side, sideIndex, source: 'app' });
    } catch (err) {
        console.error('[POST /api/discord/interactions] submitPick failed:', err);
        return ephemeral('Something went wrong recording that pick. Try again shortly.');
    }

    return ephemeral(messageForResult(result));
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const rawBody = await context.request.text();
    const verified = await verifyDiscordRequest(
        rawBody,
        context.request.headers.get('X-Signature-Ed25519'),
        context.request.headers.get('X-Signature-Timestamp'),
        context.env.DISCORD_PUBLIC_KEY
    );
    if (!verified) return new Response('Invalid request signature.', { status: 401 });

    let interaction: any;
    try {
        interaction = JSON.parse(rawBody);
    } catch {
        return new Response('Invalid JSON body.', { status: 400 });
    }

    if (interaction.type === DISCORD_PING) {
        return new Response(JSON.stringify({ type: RESPONSE_PONG }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (interaction.type === DISCORD_APPLICATION_COMMAND) {
        const commandName = interaction.data?.name;
        // The admin hub: /heatchecks setup | settings | draw | post <tank|
        // community-pick|leaderboard>. Each branch hands its handler an interaction
        // shaped exactly like the old top-level command's - data.options rewritten to
        // the subcommand's own options (or, for the post group, to the single
        // subcommand entry handlePostCommand already reads) - so the handlers below
        // stay untouched by the reshuffle.
        if (commandName === 'heatchecks') {
            const first = interaction.data?.options?.[0];
            const shim = { ...interaction, data: { ...interaction.data, options: first?.options ?? [] } };
            if (first?.name === 'setup') return handleSetupWizardCommand(context, shim);
            if (first?.name === 'settings') return handleConfigCommand(context, shim);
            if (first?.name === 'draw') return handleDrawCommand(context, shim);
            if (first?.name === 'post') {
                if (first.options?.[0]?.name === 'leaderboard') return handlePostLeaderboardCommand(context, shim);
                return handlePostCommand(context, shim);
            }
            return new Response('Unknown subcommand.', { status: 400 });
        }
        // The pre-hub command names, kept live so admins mid-propagation (Discord
        // takes up to an hour to swap a global command set) don't hit a dead command.
        if (commandName === 'heatchecks-setup') return handleSetupWizardCommand(context, interaction);
        if (commandName === 'heatchecks-config') return handleConfigCommand(context, interaction);
        if (commandName === 'heatchecks-post') {
            // The leaderboard subcommand is handled here rather than in
            // discord-commands.ts - the accuracy builder and the channel-post
            // delivery live in this file's import graph (pulling them into
            // discord-commands would create a cycle).
            if (interaction.data?.options?.[0]?.name === 'leaderboard') return handlePostLeaderboardCommand(context, interaction);
            return handlePostCommand(context, interaction);
        }
        if (commandName === 'heatchecks-draw') return handleDrawCommand(context, interaction);
        if (commandName === 'heatchecks-league') return handleLeagueCommand(context, interaction);
        if (commandName === 'my-results') return handleMyResultsCommand(context, interaction);
        if (commandName === 'me') return handleMeCommand(context, interaction);
        if (commandName === 'leaderboard') return handleLeaderboardCommand(context, interaction);
        return new Response('Unknown command.', { status: 400 });
    }

    if (interaction.type === DISCORD_MODAL_SUBMIT) {
        const customId = typeof interaction.data?.custom_id === 'string' ? interaction.data.custom_id : '';
        if (customId.startsWith('wzm:')) return handleWizardModal(context, interaction, customId);
        if (customId.startsWith('stm:')) return handleSettingsModal(context, interaction, customId);
        return ephemeral("Couldn't process that.");
    }

    if (interaction.type === DISCORD_MESSAGE_COMPONENT) {
        const customId = typeof interaction.data?.custom_id === 'string' ? interaction.data.custom_id : '';
        if (customId.startsWith('wz:')) return handleWizardComponent(context, interaction, customId);
        if (customId.startsWith('st:')) return handleSettingsComponent(context, interaction, customId);
        if (customId.startsWith('dwbtn:')) return handleDrawButton(context, interaction, customId);
        if (customId.startsWith('pick:')) return handlePickButton(context, interaction, customId);
        if (customId === 'tpselect') return handleTankPostSelect(context, interaction);
        if (customId.startsWith('tprepost:')) return handleTankRepostConfirm(context, interaction, customId);
        if (customId === 'tpcancel') return updateMessageResponse('Cancelled.');
        if (customId.startsWith('cpselect')) return handleCommunityPickSelect(context, interaction, customId);
        if (customId.startsWith('cpgw:')) return handleCommunityGiveawaySelect(context, interaction, customId);
        if (customId.startsWith('cpcreate:')) return handleCommunityPickConfirm(context, interaction, customId);
        if (customId === 'cpcancel') return updateMessageResponse('Cancelled.');
        if (customId.startsWith('cpvote:')) return handleCommunityVote(context, interaction, customId);
        if (customId === 'dwselect') return handleDrawSelect(context, interaction);
        return ephemeral("Couldn't process that.");
    }

    return new Response('Unhandled interaction type.', { status: 400 });
};

// Shared deferred-image-command plumbing for /leaderboard and /me: immediate
// deferred ack (ephemeral when the guild's ephemeral_user_commands wizard setting is
// on), real content later via sendLeaderboardResult's webhook PATCH (image first,
// embed fallback).
async function deferImageCommand(
    context: RequestContext,
    interaction: any,
    buildMessage: Promise<{ content: string; headerLabel: string; rows: any[] }>
): Promise<Response> {
    const applicationId: string | undefined = interaction.application_id;
    const interactionToken: string | undefined = interaction.token;
    if (!applicationId || !interactionToken) return ephemeral("Couldn't process that command - try again.");

    const sql = getSql(context.env);
    const cfgRows = await sql`SELECT ephemeral_user_commands FROM discord_guild_configs WHERE guild_id = ${interaction.guild_id}`;
    const makeEphemeral = Boolean((cfgRows[0] as any)?.ephemeral_user_commands);

    context.waitUntil(
        buildMessage
            .catch((err) => {
                console.error('[POST /api/discord/interactions] Deferred build failed:', err);
                return { content: 'Could not build that right now — try again shortly.', headerLabel: '', rows: [] };
            })
            .then(({ content, headerLabel, rows }) => sendLeaderboardResult(applicationId, interactionToken, content, headerLabel, rows))
    );

    return new Response(
        JSON.stringify({ type: RESPONSE_DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: makeEphemeral ? { flags: EPHEMERAL_FLAG } : {} }),
        { headers: { 'Content-Type': 'application/json' } }
    );
}

function handleLeaderboardCommand(context: RequestContext, interaction: any): Promise<Response> | Response {
    const guildId: string | undefined = interaction.guild_id;
    if (!guildId) return ephemeral('Run this in a server, not a DM.');

    const view = interaction.data?.options?.find((o: any) => o.name === 'view')?.value ?? 'accuracy';
    const sport = interaction.data?.options?.find((o: any) => o.name === 'sport')?.value as string | undefined;
    if (view === 'league' && !sport) return ephemeral('Pick a sport to view the league leaderboard (e.g. sport:NFL).');

    const buildMessage = view === 'league'
        ? buildLeagueLeaderboardMessage(context.env, guildId, sport as string)
        : view === 'community'
        ? buildCommunityPointsLeaderboardMessage(context.env, guildId)
        : view === 'sr'
        ? buildSrLeaderboardMessage(context.env, guildId)
        : buildAccuracyLeaderboardMessage(context.env, guildId);

    return deferImageCommand(context, interaction, buildMessage);
}

// `/heatchecks post leaderboard` - an admin posts the leaderboard card publicly, once,
// on demand, into the main channel or an approved Community Pick channel. Reuses the
// exact builders + channel delivery (image-first, embed fallback) the weekly
// auto-post runs on - a new trigger, not new rendering logic.
async function handlePostLeaderboardCommand(context: RequestContext, interaction: any): Promise<Response> {
    const guildId: string | undefined = interaction.guild_id;
    if (!guildId) return ephemeral('Run this in a server, not a DM.');
    if (!hasManageGuildPermission(interaction)) return ephemeral('You need the "Manage Server" permission to run this.');

    const applicationId: string | undefined = interaction.application_id;
    const interactionToken: string | undefined = interaction.token;
    if (!applicationId || !interactionToken) return ephemeral("Couldn't process that command - try again.");

    const sub = interaction.data?.options?.[0];
    const view: string = sub?.options?.find((o: any) => o.name === 'view')?.value ?? 'community';
    const sport: string | undefined = sub?.options?.find((o: any) => o.name === 'sport')?.value;
    const requestedChannel: string | undefined = sub?.options?.find((o: any) => o.name === 'channel')?.value;
    if (view === 'league' && !sport) return ephemeral('Pick a sport for the league leaderboard (e.g. sport:NFL).');

    context.waitUntil((async () => {
        const patchUrl = `https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}/messages/@original`;
        const patch = (content: string) =>
            fetch(patchUrl, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) });
        try {
            const sql = getSql(context.env);
            const cfgRows = await sql`SELECT channel_id, community_pick_channel_ids FROM discord_guild_configs WHERE guild_id = ${guildId}`;
            if (cfgRows.length === 0) {
                await patch('This server has no channel configured - run `/heatchecks setup` first.');
                return;
            }
            const cfg = cfgRows[0] as unknown as { channel_id: string; community_pick_channel_ids: string[] | string };
            const extras: string[] = Array.isArray(cfg.community_pick_channel_ids) ? cfg.community_pick_channel_ids : JSON.parse((cfg.community_pick_channel_ids as string) ?? '[]');
            if (requestedChannel && requestedChannel !== cfg.channel_id && !extras.includes(requestedChannel)) {
                await patch(`<#${requestedChannel}> isn't an approved channel - use the main channel or one added in /heatchecks settings → Channels.`);
                return;
            }
            const channelId = requestedChannel ?? cfg.channel_id;

            const message =
                view === 'league' ? await buildLeagueLeaderboardMessage(context.env, guildId, sport as string)
                : view === 'sr' ? await buildSrLeaderboardMessage(context.env, guildId)
                : view === 'accuracy' ? await buildAccuracyLeaderboardMessage(context.env, guildId)
                : await buildCommunityPointsLeaderboardMessage(context.env, guildId);

            if (message.rows.length === 0) {
                await patch(message.content || 'Nothing to post for that view yet.');
                return;
            }
            await postLeaderboardToChannel(context.env, channelId, message.content, message.headerLabel, message.rows);
            await patch(`Leaderboard posted to <#${channelId}>.`);
        } catch (err) {
            console.error('[POST /api/discord/interactions] Manual leaderboard post failed:', err);
            await patch('Could not post the leaderboard - try again shortly.').catch(() => undefined);
        }
    })());

    return new Response(
        JSON.stringify({ type: RESPONSE_DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: EPHEMERAL_FLAG } }),
        { headers: { 'Content-Type': 'application/json' } }
    );
}

async function handleMeCommand(context: RequestContext, interaction: any): Promise<Response> {
    const guildId: string | undefined = interaction.guild_id;
    const discordUserId: string | undefined = interaction.member?.user?.id;
    if (!guildId || !discordUserId) return ephemeral('Run this in a server, not a DM.');

    const applicationId: string | undefined = interaction.application_id;
    const interactionToken: string | undefined = interaction.token;
    if (!applicationId || !interactionToken) return ephemeral("Couldn't process that command - try again.");

    const sql = getSql(context.env);
    const cfgRows = await sql`SELECT ephemeral_user_commands FROM discord_guild_configs WHERE guild_id = ${guildId}`;
    const makeEphemeral = Boolean((cfgRows[0] as any)?.ephemeral_user_commands);

    context.waitUntil(
        buildMeCardInput(context.env, guildId, discordUserId)
            .then((input) => sendMeCard(applicationId, interactionToken, input))
            .catch((err) => {
                console.error('[POST /api/discord/interactions] /me failed:', err);
                return fetch(`https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}/messages/@original`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: 'Could not build your card right now — try again shortly.' }),
                }).then(() => undefined);
            })
    );

    return new Response(
        JSON.stringify({ type: RESPONSE_DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: makeEphemeral ? { flags: EPHEMERAL_FLAG } : {} }),
        { headers: { 'Content-Type': 'application/json' } }
    );
}

interface LeaderboardRow {
    discord_user_id: string;
    discord_username: string;
    correct: number;
    settled: number;
}

// Guild-scoped, computed fresh every call - see the file header comment for why
// there's deliberately no stored membership table backing this. Exported for the
// weekly auto-post sweep (functions/api/weekly-leaderboard-sweep.ts).
export async function buildAccuracyLeaderboardMessage(env: Env, guildId: string): Promise<LeaderboardMessage> {
    const sql = getSql(env);
    const [members, { leaderboardLabel }] = await Promise.all([
        fetchGuildMembers(env, guildId),
        getGuildLabels(sql, guildId),
    ]);
    const memberIds = members.filter((m) => !m.user.bot).map((m) => m.user.id);
    if (memberIds.length === 0) return { content: 'No members to rank in this server yet.', headerLabel: '', rows: [] };

    const rows = (await sql`
        SELECT dl.discord_user_id, dl.discord_username,
               COUNT(*) FILTER (WHERE p.result = 'correct')::int AS correct,
               COUNT(*) FILTER (WHERE p.result IS NOT NULL)::int AS settled
        FROM discord_links dl
        JOIN picks p ON p.waitlist_id = dl.waitlist_id
        WHERE dl.discord_user_id = ANY(${memberIds}::text[])
        GROUP BY dl.discord_user_id, dl.discord_username
    `) as unknown as LeaderboardRow[];

    const minPicks = numEnv(env.LEADERBOARD_MIN_PICKS, DEFAULT_LEADERBOARD_MIN_PICKS);
    // Prefer each member's live Discord display name/avatar over our possibly-stale
    // cached discord_links.discord_username - freshest data available, same member
    // list we already paid the round-trip for.
    const memberById = new Map(members.map((m) => [m.user.id, m.user]));

    const ranked = rows
        .filter((r) => r.settled >= minPicks)
        .map((r) => {
            const member = memberById.get(r.discord_user_id);
            return {
                discordUserId: r.discord_user_id,
                name: member?.global_name || member?.username || r.discord_username,
                avatarUrl: buildDiscordAvatarUrl(r.discord_user_id, member?.avatar),
                correct: r.correct,
                settled: r.settled,
                accuracy: r.correct / r.settled,
            };
        })
        .sort((a, b) => b.accuracy - a.accuracy || b.settled - a.settled)
        .slice(0, LEADERBOARD_SIZE);

    if (ranked.length === 0) {
        return { content: `Nobody in this server has ${minPicks}+ settled picks yet — check back soon!`, headerLabel: '', rows: [] };
    }

    const srById = await computeSkillRatings(sql, guildId, ranked.map((r) => r.discordUserId));
    const rankedRows = ranked.map((r, i) => ({
        rank: i + 1,
        displayName: r.name,
        avatarUrl: r.avatarUrl,
        scoreLine: `${(r.accuracy * 100).toFixed(0)}% (${r.correct}/${r.settled})`,
        scoreValue: `${(r.accuracy * 100).toFixed(0)}%`,
        sr: srById.get(r.discordUserId) ?? 0,
    }));
    return { content: `**Heatchecks ${leaderboardLabel}**`, headerLabel: 'OVERALL ACCURACY', rows: rankedRows };
}
