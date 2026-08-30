// The /heatchecks-setup guided wizard - a chained ephemeral flow (every step edits
// the same message, response type 7) that walks an admin from "bot just joined" to
// fully configured in ~2 minutes. Settings write as-you-go: the guild config row is
// created the moment a channel is chosen (step 2), and every later step just updates
// one column - so an abandoned wizard always leaves a valid, working guild, and
// re-running the wizard is naturally "update mode" (current values shown, nothing
// reset). Dispatched from functions/api/discord/interactions.ts: components under
// the wz: prefix, modal submits under wzm:.
//
// Custom display names (steps 6-7) use Discord modals (interaction response type 9,
// text-input component type 4) - the first modal use in this bot; modal submits
// arrive as interaction type 5 and respond with UPDATE_MESSAGE like any component.
//
// Isolation reminder: writes only discord_guild_configs + discord_guild_posts (the
// backfill button) - never ember_ledger/ember_balances/picks or any shop table.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, type Env } from './db';
import { hasManageGuildPermission, postDiscordChannelMessage } from './discord-api';
import { postWelcomeImageToChannel } from './leaderboard-image';
import { brandEmbed } from './discord-brand';
// Pre-rendered branded header (navy card, black plate, Orbitron green - the
// leaderboard's exact header language, generated once at build time by
// scratchpad/gen-banners.mjs, zero runtime CPU). Attached on the wizard's FIRST
// response; type-7 updates that omit the attachments field retain it, so the banner
// stays pinned above the embed through every step.
import BANNER_SETUP from './art/banner-setup.bin';
import { buildTankCardMessage, type TankCardModelOutput } from './discord-tank-card';
import type { PropOdds } from '../../tank-types';

type RequestContext = Parameters<PagesFunction<Env>>[0];

const RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE = 4;
const RESPONSE_UPDATE_MESSAGE = 7;
const RESPONSE_MODAL = 9;
const EPHEMERAL_FLAG = 64;
const ACTION_ROW = 1;
const BUTTON = 2;
const STRING_SELECT = 3;
const TEXT_INPUT = 4;
const CHANNEL_SELECT = 8;
const STYLE_PRIMARY = 1;
const STYLE_SECONDARY = 2;
const STYLE_SUCCESS = 3;
const GUILD_TEXT = 0;

// Friendly sport groups -> the per-league values disabled_sports actually stores.
// Selecting groups ENABLES those leagues; everything not selected gets disabled.
export const SPORT_GROUPS: Record<string, string[]> = {
    baseball: ['MLB'],
    soccer: ['EPL', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1'],
    basketball: ['NBA'],
    football: ['NFL'],
};
const ALL_LEAGUES = Object.values(SPORT_GROUPS).flat();

// The daily content sweeps fire at these UTC hours (worker-curate/wrangler.toml) -
// used only for the "your first cards arrive ~then" expectation line.
const SWEEP_UTC_HOURS = [2, 10, 18];

function nextSweepUnix(): number {
    const now = new Date();
    for (let addDays = 0; addDays < 2; addDays++) {
        for (const h of SWEEP_UTC_HOURS) {
            const t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + addDays, h, 0, 0);
            if (t > now.getTime()) return Math.floor(t / 1000);
        }
    }
    return Math.floor(now.getTime() / 1000) + 8 * 3600; // unreachable fallback
}

function json(body: unknown): Response {
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}

// Every wizard step renders as one branded embed (green strip, HEATCHECKS SETUP
// plate) - the embed-world translation of the card aesthetic, applied here once for
// all screens instead of per-call-site. The first response additionally attaches the
// pre-rendered navy/Orbitron banner via multipart (interaction endpoints may respond
// with multipart/form-data to include files); every later type-7 update omits the
// attachments field, so Discord retains the banner above the updating embed.
function screen(content: string, rows: unknown[] = [], firstResponse = false): Response {
    const data = {
        content: '',
        embeds: [brandEmbed({ kind: 'system', body: content })],
        components: rows,
        flags: firstResponse ? EPHEMERAL_FLAG : undefined,
    };
    if (!firstResponse) return json({ type: RESPONSE_UPDATE_MESSAGE, data });

    const form = new FormData();
    form.append('payload_json', JSON.stringify({ type: RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE, data }));
    form.append('files[0]', new Blob([new Uint8Array(BANNER_SETUP)], { type: 'image/png' }), 'heatchecks-setup.png');
    return new Response(form);
}

function buttonRow(buttons: { label: string; customId: string; style?: number }[]): unknown {
    return { type: ACTION_ROW, components: buttons.map((b) => ({ type: BUTTON, style: b.style ?? STYLE_SECONDARY, label: b.label, custom_id: b.customId })) };
}

// ===================================================================================
// The welcome card - posted publicly at step 3 as the permission smoke test, then
// left in the channel as the member-facing explainer (pinnable). Carries the trust
// line big servers need to be able to point at.
// ===================================================================================

export function buildWelcomeCardMessage(): { embeds: unknown[] } {
    return {
        embeds: [{
            author: { name: 'HEATCHECKS' },
            title: 'Heatchecks is live in this server',
            description: [
                '**What happens here**',
                '• Daily **Tank cards** — real sports storylines with pick buttons. Picking links your Discord to a free [heatchecks.io](https://heatchecks.io) account and earns **Ember** when you call it right.',
                '• **Community Picks** — quick market votes anyone can join, no account needed. Correct calls earn Community Points toward this server\'s leaderboard.',
                '',
                '**Try it**',
                '`/leaderboard` — this server\'s standings · `/my-results` — your recent calls (only you see it)',
            ].join('\n'),
            color: 0xffc72c,
            footer: { text: 'Entertainment only — no real-money wagering. Heatchecks never supplies or distributes prizes.' },
        }],
    };
}

// ===================================================================================
// Entry - /heatchecks-setup. With a channel option: the original quick-set path,
// unchanged. Bare: the wizard.
// ===================================================================================

export async function handleSetupWizardCommand(context: RequestContext, interaction: any): Promise<Response> {
    const guildId: string | undefined = interaction.guild_id;
    if (!guildId) return screen('Run this in a server, not a DM.', [], true);
    if (!hasManageGuildPermission(interaction)) return screen('You need the "Manage Server" permission to run this.', [], true);

    const channelId: string | undefined = interaction.data?.options?.find((o: any) => o.name === 'channel')?.value;
    const configuredBy: string | undefined = interaction.member?.user?.id;
    const sql = getSql(context.env);

    // Quick path: /heatchecks-setup channel:#x still works exactly as before.
    if (channelId && configuredBy) {
        await upsertChannel(sql, guildId, channelId, configuredBy);
        return screen(`Done — Tank posts will now go to <#${channelId}>. Run \`/heatchecks-setup\` with no options for the full guided setup.`, [], true);
    }

    const existing = await sql`SELECT channel_id FROM discord_guild_configs WHERE guild_id = ${guildId}`;
    const updateMode = existing.length > 0
        ? `\n\nThis server is already set up (posting to <#${(existing[0] as any).channel_id}>) — this will **update** your settings; nothing resets until you change it.`
        : '';

    // NOTE: no '#' markdown headers in any screen copy - embeds don't render them.
    return screen(
        [
            "This setup will get your Discord server ready to go in a couple of minutes. Every choice can be changed later with `/heatchecks-config`.",
            '',
            '**What Heatchecks will never do:** read your message history, DM your members unprompted, distribute prizes, or touch real money. It only posts cards to the channels you pick and replies when someone uses it.' + updateMode,
        ].join('\n'),
        [buttonRow([{ label: "Let's go", customId: 'wz:start', style: STYLE_PRIMARY }])],
        true
    );
}

async function upsertChannel(sql: ReturnType<typeof getSql>, guildId: string, channelId: string, configuredBy: string): Promise<void> {
    await sql`
        INSERT INTO discord_guild_configs (guild_id, channel_id, configured_by_discord_user_id)
        VALUES (${guildId}, ${channelId}, ${configuredBy})
        ON CONFLICT (guild_id) DO UPDATE
            SET channel_id = EXCLUDED.channel_id,
                configured_by_discord_user_id = EXCLUDED.configured_by_discord_user_id,
                configured_at = NOW()
    `;
}

// ===================================================================================
// Component dispatch - every wz:* custom_id lands here.
// ===================================================================================

export async function handleWizardComponent(context: RequestContext, interaction: any, customId: string): Promise<Response> {
    const guildId: string | undefined = interaction.guild_id;
    const userId: string | undefined = interaction.member?.user?.id;
    if (!guildId || !userId) return screen("Couldn't read that.");
    if (!hasManageGuildPermission(interaction)) return screen('You need the "Manage Server" permission for setup.');

    const sql = getSql(context.env);
    const [, step, arg] = customId.split(':');

    switch (step) {
        case 'start':
            return screen(
                '**Step 1 of 9 — main channel**\nWhere should daily Tank cards and announcements go?',
                [{ type: ACTION_ROW, components: [{ type: CHANNEL_SELECT, custom_id: 'wz:chan', channel_types: [GUILD_TEXT], placeholder: 'Choose a channel' }] }]
            );

        case 'chan': {
            const chanId = interaction.data?.values?.[0];
            if (!chanId) return screen("Couldn't read the channel — try again.");
            await upsertChannel(sql, guildId, chanId, userId);
            return screen(
                `**Step 2 of 9 — Community Pick channels**\nMain channel set to <#${chanId}>. Should admins also be able to post **Community Picks** into other channels? Pick any, or skip.`,
                [
                    { type: ACTION_ROW, components: [{ type: CHANNEL_SELECT, custom_id: 'wz:cpchans', channel_types: [GUILD_TEXT], min_values: 1, max_values: 5, placeholder: 'Extra channels (optional)' }] },
                    buttonRow([{ label: 'Skip', customId: 'wz:welcomeask' }]),
                ]
            );
        }

        case 'cpchans': {
            const ids: string[] = interaction.data?.values ?? [];
            await sql`UPDATE discord_guild_configs SET community_pick_channel_ids = ${JSON.stringify(ids)}::jsonb WHERE guild_id = ${guildId}`;
            return welcomeAskScreen();
        }
        case 'welcomeask':
            return welcomeAskScreen();

        case 'welcome': {
            const rows = await sql`SELECT channel_id FROM discord_guild_configs WHERE guild_id = ${guildId}`;
            const chanId = (rows[0] as any)?.channel_id;
            if (!chanId) return screen('No channel configured — restart with /heatchecks-setup.');
            try {
                // Rendered welcome card in the leaderboard's aesthetic; the plain
                // embed only if rendering itself fails. Channel-post failures throw
                // either way - that's the permission smoke test.
                const result = await postWelcomeImageToChannel(context.env, chanId);
                if (result === 'embed_needed') {
                    await postDiscordChannelMessage(context.env, chanId, buildWelcomeCardMessage());
                }
            } catch (err) {
                console.error('[setup-wizard] Welcome post failed:', err);
                return screen(
                    `**Couldn't post in <#${chanId}>.** Heatchecks needs these channel permissions there: **View Channel, Send Messages, Embed Links, Attach Files**. Grant them (channel settings → permissions → add Heatchecks), then try again.`,
                    [buttonRow([{ label: 'Try again', customId: 'wz:welcome', style: STYLE_PRIMARY }])]
                );
            }
            return screen(
                '**Step 4 of 9 — Heatchecks Tank posts**\nWelcome card posted ✓ (feel free to pin it).\n\nTanks are daily prop-pick cards tied to [heatchecks.io](https://heatchecks.io) — members who pick from Discord earn **Ember** on the site when they call it right. Post them here?',
                [buttonRow([
                    { label: 'Yes, post Tanks', customId: 'wz:tank:on', style: STYLE_PRIMARY },
                    { label: 'No Tank posts', customId: 'wz:tank:off' },
                ])]
            );
        }

        case 'tank': {
            const on = arg === 'on';
            await sql`UPDATE discord_guild_configs SET tank_posts_enabled = ${on} WHERE guild_id = ${guildId}`;
            if (!on) return visibilityScreen(); // cadence + sports only matter for Tank posting
            return screen(
                '**Step 5 of 9 — how many per day**\nHow many Tank cards should post per day?',
                [buttonRow([
                    { label: 'Just 1 a day', customId: 'wz:cad:1' },
                    { label: '3 a day', customId: 'wz:cad:3' },
                    { label: 'All of them', customId: 'wz:cad:all', style: STYLE_PRIMARY },
                ])]
            );
        }

        case 'cad': {
            const limit = arg === 'all' ? null : Number(arg);
            await sql`UPDATE discord_guild_configs SET daily_post_limit = ${limit} WHERE guild_id = ${guildId}`;
            return screen(
                '**Step 6 of 9 — sports**\nWhich sports should post here?',
                [{
                    type: ACTION_ROW,
                    components: [{
                        type: STRING_SELECT, custom_id: 'wz:sports', min_values: 1, max_values: 5, placeholder: 'Pick sports',
                        options: [
                            { label: 'All sports', value: 'all' },
                            { label: 'Baseball', value: 'baseball' },
                            { label: 'Soccer (Football)', value: 'soccer' },
                            { label: 'Basketball', value: 'basketball' },
                            { label: 'American Football', value: 'football' },
                        ],
                    }],
                }]
            );
        }

        case 'sports': {
            const values: string[] = interaction.data?.values ?? [];
            const enabled = values.includes('all')
                ? ALL_LEAGUES
                : values.flatMap((v) => SPORT_GROUPS[v] ?? []);
            const disabled = ALL_LEAGUES.filter((l) => !enabled.includes(l));
            await sql`UPDATE discord_guild_configs SET disabled_sports = ${JSON.stringify(disabled)}::jsonb WHERE guild_id = ${guildId}`;
            return visibilityScreen();
        }

        case 'vis': {
            await sql`UPDATE discord_guild_configs SET settlement_visibility = ${arg === 'private' ? 'private' : 'channel'} WHERE guild_id = ${guildId}`;
            return screen(
                '**Step 8 of 9 — naming**\nWhat would you like to call your **Leaderboard**?',
                [buttonRow([
                    { label: 'Keep "Leaderboard"', customId: 'wz:lbname:keep', style: STYLE_PRIMARY },
                    { label: 'Something else…', customId: 'wz:lbname:custom' },
                ])]
            );
        }

        case 'lbname': {
            if (arg === 'custom') {
                return json({
                    type: RESPONSE_MODAL,
                    data: {
                        custom_id: 'wzm:lbname', title: 'Name your leaderboard',
                        components: [{ type: ACTION_ROW, components: [{ type: TEXT_INPUT, custom_id: 'name', label: 'Leaderboard name', style: 1, max_length: 40, required: true }] }],
                    },
                });
            }
            await sql`UPDATE discord_guild_configs SET leaderboard_label = NULL WHERE guild_id = ${guildId}`;
            return pointsNameScreen();
        }

        case 'ptsname': {
            if (arg === 'custom') {
                return json({
                    type: RESPONSE_MODAL,
                    data: {
                        custom_id: 'wzm:ptsname', title: 'Name your points',
                        components: [{ type: ACTION_ROW, components: [{ type: TEXT_INPUT, custom_id: 'name', label: 'Points name', style: 1, max_length: 40, required: true }] }],
                    },
                });
            }
            await sql`UPDATE discord_guild_configs SET community_points_label = NULL WHERE guild_id = ${guildId}`;
            return weeklyScreen();
        }

        case 'weekly': {
            const values: string[] = interaction.data?.values ?? [];
            await sql`UPDATE discord_guild_configs SET weekly_leaderboard = ${JSON.stringify(values)}::jsonb WHERE guild_id = ${guildId}`;
            return ephScreen();
        }
        case 'weeklyskip':
            await sql`UPDATE discord_guild_configs SET weekly_leaderboard = '[]'::jsonb WHERE guild_id = ${guildId}`;
            return ephScreen();

        case 'eph': {
            await sql`UPDATE discord_guild_configs SET ephemeral_user_commands = ${arg === 'yes'} WHERE guild_id = ${guildId}`;
            return doneScreen();
        }

        case 'backfill':
            return runBackfill(context, sql, guildId);
    }
    return screen("Couldn't process that setup step.");
}

// Modal submits (interaction type 5, custom_ids wzm:*).
export async function handleWizardModal(context: RequestContext, interaction: any, customId: string): Promise<Response> {
    const guildId: string | undefined = interaction.guild_id;
    if (!guildId) return screen("Couldn't read that.");
    if (!hasManageGuildPermission(interaction)) return screen('You need the "Manage Server" permission for setup.');

    const value: string = (interaction.data?.components?.[0]?.components?.[0]?.value ?? '').trim().slice(0, 40);
    const sql = getSql(context.env);

    if (customId === 'wzm:lbname') {
        if (value) await sql`UPDATE discord_guild_configs SET leaderboard_label = ${value} WHERE guild_id = ${guildId}`;
        return pointsNameScreen();
    }
    if (customId === 'wzm:ptsname') {
        if (value) await sql`UPDATE discord_guild_configs SET community_points_label = ${value} WHERE guild_id = ${guildId}`;
        return weeklyScreen();
    }
    return screen("Couldn't process that.");
}

// ===================================================================================
// Shared screens
// ===================================================================================

function welcomeAskScreen(): Response {
    return screen(
        "**Step 3 of 9 — test it**\nOnce you say yes, Heatchecks will send a welcome card to your main channel as a test. It doubles as a pinnable explainer for your members.",
        [buttonRow([{ label: 'Yes — post the welcome card', customId: 'wz:welcome', style: STYLE_PRIMARY }])]
    );
}

function visibilityScreen(): Response {
    return screen(
        '**Step 7 of 9 — settlement announcements**\nWhen picks settle, should Heatchecks announce results in the channel, or keep them private (members check `/my-results`)?',
        [buttonRow([
            { label: 'Announce in channel', customId: 'wz:vis:channel', style: STYLE_PRIMARY },
            { label: 'Keep results private', customId: 'wz:vis:private' },
        ])]
    );
}

function pointsNameScreen(): Response {
    return screen(
        '**Step 8 of 9 — naming**\nAnd what would you like to call your **Points**?',
        [buttonRow([
            { label: 'Keep "Community Points"', customId: 'wz:ptsname:keep', style: STYLE_PRIMARY },
            { label: 'Something else…', customId: 'wz:ptsname:custom' },
        ])]
    );
}

function weeklyScreen(): Response {
    return screen(
        '**Step 9 of 9 — weekly leaderboard**\nWant your leaderboard posted automatically every week? Pick which, or skip.',
        [
            {
                type: ACTION_ROW,
                components: [{
                    type: STRING_SELECT, custom_id: 'wz:weekly', min_values: 1, max_values: 3, placeholder: 'Which leaderboards?',
                    options: [
                        { label: 'Community Points', value: 'community' },
                        { label: 'Accuracy', value: 'accuracy' },
                        { label: 'Skill Rating', value: 'sr' },
                    ],
                }],
            },
            buttonRow([{ label: 'No weekly post', customId: 'wz:weeklyskip' }]),
        ]
    );
}

function ephScreen(): Response {
    return screen(
        '**One last thing — member commands**\nMembers can use `/my-results`, `/leaderboard`, and `/me`. Should replies be visible **only to the member who asks** (instead of posting in the channel)?',
        [buttonRow([
            { label: 'Only visible to them', customId: 'wz:eph:yes' },
            { label: 'Visible to everyone', customId: 'wz:eph:no', style: STYLE_PRIMARY },
        ])]
    );
}

function doneScreen(): Response {
    return screen(
        [
            "**You're all set! 🔥**",
            `Your first Tank cards arrive around <t:${nextSweepUnix()}:t> (<t:${nextSweepUnix()}:R>) — or post recent ones right now with the button below.`,
            '',
            '**More you can do**',
            '• `/heatchecks-post community-pick` — post your first Community Prop, with an optional giveaway for correct calls',
            '• `/heatchecks-post tank` — push any Tank on demand',
            '• `/heatchecks-league join` — NFL season league (activates the weekly Tuesday slate)',
            '• `/heatchecks-draw` — draw a giveaway winner from any settled pick',
            '• `/heatchecks-config` — see or change any of these settings, anytime',
        ].join('\n'),
        [buttonRow([{ label: 'Post the latest Tanks now', customId: 'wz:backfill', style: STYLE_SUCCESS }])]
    );
}

// ===================================================================================
// "Post the latest Tanks now" - the sweep's own per-(guild, Tank) idempotent path,
// scoped to this guild and capped at 3, so a fresh channel isn't empty until cron.
// ===================================================================================

interface BackfillTankRow {
    id: string;
    slug: string;
    league: string;
    model_output: TankCardModelOutput | string;
    game_snapshot: { prop?: { odds?: PropOdds | null } } | null;
}

async function runBackfill(context: RequestContext, sql: ReturnType<typeof getSql>, guildId: string): Promise<Response> {
    const cfg = await sql`SELECT channel_id, disabled_sports FROM discord_guild_configs WHERE guild_id = ${guildId}`;
    if (cfg.length === 0) return screen('No channel configured — restart with /heatchecks-setup.');
    const channelId = (cfg[0] as any).channel_id as string;
    const rawDisabled = (cfg[0] as any).disabled_sports;
    const disabled: string[] = Array.isArray(rawDisabled) ? rawDisabled : JSON.parse(rawDisabled ?? '[]');

    const rows = (await sql`
        SELECT t.id, t.slug, t.league, t.model_output, t.game_snapshot
        FROM tank_pages t
        WHERE t.status = 'published' AND t.visibility = 'app' AND t.published_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM discord_guild_posts dgp WHERE dgp.guild_id = ${guildId} AND dgp.tank_page_id = t.id)
        ORDER BY t.published_at DESC
        LIMIT 6
    `) as unknown as BackfillTankRow[];

    const baseUrl = new URL(context.request.url).origin;
    let posted = 0;
    let postFailed = false;
    for (const row of rows) {
        if (posted >= 3 || disabled.includes(row.league)) continue;
        const modelOutput: TankCardModelOutput | null = typeof row.model_output === 'string' ? JSON.parse(row.model_output) : row.model_output;
        if (!modelOutput) continue;
        const message = buildTankCardMessage(baseUrl, { slug: row.slug, modelOutput, gameSnapshot: row.game_snapshot });
        if (!message) continue;
        try {
            const messageId = await postDiscordChannelMessage(context.env, channelId, message);
            await sql`
                INSERT INTO discord_guild_posts (guild_id, tank_page_id, message_id)
                VALUES (${guildId}, ${row.id}, ${messageId})
                ON CONFLICT (guild_id, tank_page_id) DO NOTHING
            `;
            posted++;
        } catch (err) {
            console.error('[setup-wizard] Backfill post failed:', err);
            postFailed = true;
            break;
        }
    }
    // Three genuinely different endings - say the true one, not a conflated guess
    // (a fully-served server hitting this button gets "up to date", not a shrug).
    if (posted > 0) {
        return screen(`Posted ${posted} Tank card${posted === 1 ? '' : 's'} — you're live. Everything else arrives on the daily schedule.`);
    }
    if (postFailed) {
        return screen(`Couldn't post in <#${channelId}> — check Heatchecks has View Channel, Send Messages, Embed Links, and Attach Files there, then try again.`);
    }
    return screen(
        rows.length === 0
            ? "You're already up to date — every published Tank is in this channel. New ones arrive on the daily schedule."
            : 'Nothing matched your sport settings to post right now — your first cards arrive on the daily schedule.'
    );
}
