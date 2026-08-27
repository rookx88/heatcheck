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
// - Everything else (heatchecks-setup/-config/-post/-draw, and every
//   search-select/confirm component those commands drive) is handled in
//   discord-commands.ts - see that file's own header for the full rundown.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, type Env } from '../../../lib/pages-functions/db';
import { verifyDiscordRequest } from '../../../lib/pages-functions/discord-verify';
import { submitPick, type SubmitPickResult } from '../../../lib/pages-functions/picks';
import { fetchGuildMembers, getGuildLabels } from '../../../lib/pages-functions/discord-api';
import {
    handleSetupCommand,
    handleConfigCommand,
    handlePostCommand,
    handleDrawCommand,
    handleTankPostSelect,
    handleTankRepostConfirm,
    handleCommunityPickSelect,
    handleCommunityPickConfirm,
    handleCommunityVote,
    handleDrawSelect,
    handleLeagueCommand,
    handleMyResultsCommand,
    updateMessageResponse,
    buildCommunityPointsLeaderboardMessage,
    buildLeagueLeaderboardMessage,
} from '../../../lib/pages-functions/discord-commands';

const DISCORD_PING = 1;
const DISCORD_APPLICATION_COMMAND = 2;
const DISCORD_MESSAGE_COMPONENT = 3;
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
        if (commandName === 'heatchecks-setup') return handleSetupCommand(context, interaction);
        if (commandName === 'heatchecks-config') return handleConfigCommand(context, interaction);
        if (commandName === 'heatchecks-post') return handlePostCommand(context, interaction);
        if (commandName === 'heatchecks-draw') return handleDrawCommand(context, interaction);
        if (commandName === 'heatchecks-league') return handleLeagueCommand(context, interaction);
        if (commandName === 'my-results') return handleMyResultsCommand(context, interaction);
        if (commandName === 'leaderboard') return handleLeaderboardCommand(context, interaction);
        return new Response('Unknown command.', { status: 400 });
    }

    if (interaction.type === DISCORD_MESSAGE_COMPONENT) {
        const customId = typeof interaction.data?.custom_id === 'string' ? interaction.data.custom_id : '';
        if (customId.startsWith('pick:')) return handlePickButton(context, interaction, customId);
        if (customId === 'tpselect') return handleTankPostSelect(context, interaction);
        if (customId.startsWith('tprepost:')) return handleTankRepostConfirm(context, interaction, customId);
        if (customId === 'tpcancel') return updateMessageResponse('Cancelled.');
        if (customId.startsWith('cpselect')) return handleCommunityPickSelect(context, interaction, customId);
        if (customId.startsWith('cpcreate:')) return handleCommunityPickConfirm(context, interaction, customId);
        if (customId === 'cpcancel') return updateMessageResponse('Cancelled.');
        if (customId.startsWith('cpvote:')) return handleCommunityVote(context, interaction, customId);
        if (customId === 'dwselect') return handleDrawSelect(context, interaction);
        return ephemeral("Couldn't process that.");
    }

    return new Response('Unhandled interaction type.', { status: 400 });
};

function handleLeaderboardCommand(context: RequestContext, interaction: any): Response {
    const guildId: string | undefined = interaction.guild_id;
    if (!guildId) return ephemeral('Run this in a server, not a DM.');

    const applicationId: string | undefined = interaction.application_id;
    const interactionToken: string | undefined = interaction.token;
    if (!applicationId || !interactionToken) return ephemeral("Couldn't process that command - try again.");

    const view = interaction.data?.options?.find((o: any) => o.name === 'view')?.value ?? 'accuracy';
    const sport = interaction.data?.options?.find((o: any) => o.name === 'sport')?.value as string | undefined;
    if (view === 'league' && !sport) return ephemeral('Pick a sport to view the league leaderboard (e.g. sport:NFL).');

    // Deferred: fetchGuildMembers (paginated REST calls) plus the DB query can exceed
    // Discord's 3-second initial-response window, especially for a larger server.
    // waitUntil keeps the background work alive after this function returns its
    // immediate ack; the real content arrives via a webhook PATCH to @original.
    const buildMessage = view === 'league'
        ? buildLeagueLeaderboardMessage(context.env, guildId, sport as string)
        : view === 'community'
        ? buildCommunityPointsLeaderboardMessage(context.env, guildId)
        : buildAccuracyLeaderboardMessage(context.env, guildId);

    context.waitUntil(
        buildMessage
            .catch((err) => {
                console.error('[POST /api/discord/interactions] Leaderboard build failed:', err);
                return 'Could not build the leaderboard right now — try again shortly.';
            })
            .then((content) =>
                fetch(`https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}/messages/@original`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content }),
                })
            )
    );

    return new Response(
        JSON.stringify({ type: RESPONSE_DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE }),
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
// there's deliberately no stored membership table backing this.
async function buildAccuracyLeaderboardMessage(env: Env, guildId: string): Promise<string> {
    const sql = getSql(env);
    const [members, { leaderboardLabel }] = await Promise.all([
        fetchGuildMembers(env, guildId),
        getGuildLabels(sql, guildId),
    ]);
    const memberIds = members.filter((m) => !m.user.bot).map((m) => m.user.id);
    if (memberIds.length === 0) return 'No members to rank in this server yet.';

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
    // Prefer each member's live Discord display name over our possibly-stale cached
    // discord_links.discord_username - freshest name available, same member list we
    // already paid the round-trip for.
    const nameById = new Map(members.map((m) => [m.user.id, m.user.global_name || m.user.username]));

    const ranked = rows
        .filter((r) => r.settled >= minPicks)
        .map((r) => ({
            name: nameById.get(r.discord_user_id) ?? r.discord_username,
            correct: r.correct,
            settled: r.settled,
            accuracy: r.correct / r.settled,
        }))
        .sort((a, b) => b.accuracy - a.accuracy || b.settled - a.settled)
        .slice(0, LEADERBOARD_SIZE);

    if (ranked.length === 0) {
        return `Nobody in this server has ${minPicks}+ settled picks yet — check back soon!`;
    }

    const lines = ranked.map((r, i) => `**${i + 1}.** ${r.name} — ${(r.accuracy * 100).toFixed(0)}% (${r.correct}/${r.settled})`);
    return `**Heatchecks ${leaderboardLabel}**\n${lines.join('\n')}`;
}
