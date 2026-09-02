// The `/heatchecks setup` guided wizard - a chained ephemeral flow (every step edits
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
import { hasManageGuildPermission, postDiscordChannelMessage, DEFAULT_COMMUNITY_POINTS_LABEL, DEFAULT_LEADERBOARD_LABEL } from './discord-api';
import { postWelcomeImageToChannel } from './leaderboard-image';
import { brandEmbed } from './discord-brand';
// Pre-rendered branded header (navy card, black plate, Orbitron green - the
// leaderboard's exact header language, generated once at build time by
// scratchpad/gen-banners.mjs, zero runtime CPU). Attached on the wizard's FIRST
// response; type-7 updates that omit the attachments field retain it, so the banner
// stays pinned above the embed through every step.
import BANNER_SETUP from './art/banner-setup.bin';
import BANNER_SETTINGS from './art/banner-settings.bin';
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
    // Includes the Discord-menu-only competitions (see polymarket.ts's LEAGUE_TAGS) so
    // a server that turns Soccer off turns ALL of them off - ALL_LEAGUES below, and
    // therefore disabled_sports, derives from this map.
    soccer: ['EPL', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1', 'EFL Championship', 'MLS', 'DFB-Pokal', 'Carabao Cup'],
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
                '`/pvp challenge` — put 3 picks up against another member, head to head',
            ].join('\n'),
            color: 0xffc72c,
            footer: { text: 'Entertainment only — no real-money wagering. Heatchecks never supplies or distributes prizes.' },
        }],
    };
}

// ===================================================================================
// Entry - `/heatchecks setup`. With a channel option: the original quick-set path,
// unchanged. Bare: the wizard.
// ===================================================================================

export async function handleSetupWizardCommand(context: RequestContext, interaction: any): Promise<Response> {
    const guildId: string | undefined = interaction.guild_id;
    if (!guildId) return screen('Run this in a server, not a DM.', [], true);
    if (!hasManageGuildPermission(interaction)) return screen('You need the "Manage Server" permission to run this.', [], true);

    const channelId: string | undefined = interaction.data?.options?.find((o: any) => o.name === 'channel')?.value;
    const configuredBy: string | undefined = interaction.member?.user?.id;
    const sql = getSql(context.env);

    // Quick path: `/heatchecks setup channel:#x` still works exactly as before.
    if (channelId && configuredBy) {
        await upsertChannel(sql, guildId, channelId, configuredBy);
        return screen(`Done — Tank posts will now go to <#${channelId}>. Run \`/heatchecks setup\` with no options for the full guided setup.`, [], true);
    }

    const existing = await sql`SELECT channel_id FROM discord_guild_configs WHERE guild_id = ${guildId}`;
    const updateMode = existing.length > 0
        ? `\n\nThis server is already set up (posting to <#${(existing[0] as any).channel_id}>) — this will **update** your settings; nothing resets until you change it.`
        : '';

    // NOTE: no '#' markdown headers in any screen copy - embeds don't render them.
    return screen(
        [
            "This setup will get your Discord server ready to go in a couple of minutes. Every choice can be changed later with `/heatchecks settings`.",
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
            if (!chanId) return screen('No channel configured — restart with `/heatchecks setup`.');
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
            '• `/heatchecks post community-pick` — post your first Community Prop, with an optional giveaway for correct calls',
            '• `/heatchecks post tank` — push any Tank on demand',
            '• `/heatchecks-league join` — NFL season league (activates the weekly Tuesday slate)',
            '• `/heatchecks post leaderboard` — post the standings publicly, any time',
            '• `/heatchecks draw` — draw a giveaway winner from any settled pick',
            '• `/heatchecks settings` — see or change any of these settings, anytime',
            '',
            'Your members can also run `/pvp challenge` to battle each other head-to-head, and `/pvp battles` to track it.',
            '',
            'Only admins with **Manage Server** can run any of that; everyone else can vote, pick, and check their own stats. `/heatchecks settings` → **Access & privacy** has the full breakdown and how to narrow it further.',
        ].join('\n'),
        [buttonRow([{ label: 'Post the latest Tanks now', customId: 'wz:backfill', style: STYLE_SUCCESS }])]
    );
}

// ===================================================================================
// The settings panel - what bare `/heatchecks settings` opens. Same problem the
// wizard solved for first-run, solved for day two: every setting used to be either a
// flag you had to already know the name of, or wizard-only (cadence, extra channels,
// weekly post, member-command visibility had NO command form at all). This panel is
// the single place all of them live: current values on top, one button per setting,
// and every change lands back here so the state you just changed is visible.
//
// It reuses this file's step screens and its exact UPDATE-the-same-message pattern,
// but under the `st:` prefix rather than `wz:` - the wizard chains forward step by
// step, the panel always returns to the panel. Changes write immediately; there's no
// save step to abandon.
// ===================================================================================

interface GuildSettingsRow {
    channel_id: string;
    disabled_sports: string[] | string;
    auto_draw_enabled: boolean;
    community_points_label: string | null;
    leaderboard_label: string | null;
    settlement_visibility: string;
    tank_posts_enabled: boolean;
    daily_post_limit: number | null;
    community_pick_channel_ids: string[] | string;
    weekly_leaderboard: string[] | string;
    ephemeral_user_commands: boolean;
    pvp_enabled: boolean;
    pvp_results_visibility: string;
    pvp_channel_id: string | null;
    pvp_announce_challenges: boolean;
    configured_by_discord_user_id: string;
    configured_at: string | Date;
}

const parseJsonArray = (v: string[] | string | null): string[] => (Array.isArray(v) ? v : JSON.parse((v as string) ?? '[]'));

// The panel's own screen shell - the settings banner instead of the setup one, and
// (like the wizard) attached only on the first response; every later type-7 update
// omits attachments so Discord keeps it pinned above the embed.
function panelScreen(body: string, rows: unknown[], firstResponse: boolean): Response {
    const data = {
        content: '',
        embeds: [brandEmbed({ kind: 'system', body })],
        components: rows,
        flags: firstResponse ? EPHEMERAL_FLAG : undefined,
    };
    if (!firstResponse) return json({ type: RESPONSE_UPDATE_MESSAGE, data });

    const form = new FormData();
    form.append('payload_json', JSON.stringify({ type: RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE, data }));
    form.append('files[0]', new Blob([new Uint8Array(BANNER_SETTINGS)], { type: 'image/png' }), 'server-settings.png');
    return new Response(form);
}

// One sub-screen for one setting, always with a way back to the panel.
function settingScreen(body: string, rows: unknown[]): Response {
    return panelScreen(body, [...rows, buttonRow([{ label: '← Back to settings', customId: 'st:panel' }])], false);
}

export async function buildSettingsPanel(context: RequestContext, guildId: string, firstResponse: boolean): Promise<Response> {
    const sql = getSql(context.env);
    const rows = await sql`
        SELECT channel_id, disabled_sports, auto_draw_enabled, community_points_label, leaderboard_label,
               settlement_visibility, tank_posts_enabled, daily_post_limit, community_pick_channel_ids,
               weekly_leaderboard, ephemeral_user_commands, pvp_enabled, pvp_results_visibility,
               pvp_channel_id, pvp_announce_challenges,
               configured_by_discord_user_id, configured_at
        FROM discord_guild_configs WHERE guild_id = ${guildId}
    `;
    if (rows.length === 0) {
        return panelScreen('This server has no configuration yet — run `/heatchecks setup` first.', [], firstResponse);
    }
    const c = rows[0] as unknown as GuildSettingsRow;
    const disabled = parseJsonArray(c.disabled_sports);
    const cpChannels = parseJsonArray(c.community_pick_channel_ids);
    const weekly = parseJsonArray(c.weekly_leaderboard);
    const enabledSports = ALL_LEAGUES.filter((s) => !disabled.includes(s));

    const body = [
        `**Main channel:** <#${c.channel_id}>`,
        `**Community Pick channels:** ${cpChannels.length ? cpChannels.map((id) => `<#${id}>`).join(' ') : 'main channel only'}`,
        `**Tank posts:** ${c.tank_posts_enabled ? `on (${c.daily_post_limit == null ? 'all' : `max ${c.daily_post_limit}/day`})` : 'off'}`,
        `**Sports:** ${enabledSports.length === ALL_LEAGUES.length ? 'all' : enabledSports.join(', ') || 'none'}`,
        `**Settlement results:** ${c.settlement_visibility === 'private' ? 'private (members use /my-results)' : 'announced in channel'}`,
        `**Auto-draw on settlement:** ${c.auto_draw_enabled ? 'on' : 'off'}`,
        `**Names:** points = "${c.community_points_label || DEFAULT_COMMUNITY_POINTS_LABEL}", leaderboard = "${c.leaderboard_label || DEFAULT_LEADERBOARD_LABEL}"`,
        `**Weekly leaderboard post:** ${weekly.length ? weekly.join(', ') : 'off'}`,
        `**Member commands:** ${c.ephemeral_user_commands ? 'visible only to the member' : 'visible to everyone'}`,
        `**PvP battles:** ${c.pvp_enabled
            ? `on in ${c.pvp_channel_id ? `<#${c.pvp_channel_id}>` : 'the main channel'} — challenges ${c.pvp_announce_challenges ? 'announced' : 'silent'}, results ${c.pvp_results_visibility === 'private' ? 'private' : 'announced'}`
            : 'off'}`,
        `**Who can run \`/heatchecks\`:** admins with Manage Server — everyone else can only vote, pick, and check their own stats.`,
        configuredByLine(c),
        '',
        'Pick anything below to change it — or re-run `/heatchecks setup` for the guided walkthrough.',
    ].join('\n');

    return panelScreen(body, [
        buttonRow([
            { label: 'Channels', customId: 'st:chans' },
            { label: 'Tank posts', customId: 'st:tank' },
            { label: 'Sports', customId: 'st:sports' },
            { label: 'Results', customId: 'st:vis' },
            { label: 'Auto-draw', customId: 'st:draw' },
        ]),
        buttonRow([
            { label: 'Names', customId: 'st:names' },
            { label: 'Weekly post', customId: 'st:weekly' },
            { label: 'Member commands', customId: 'st:eph' },
            { label: 'PvP', customId: 'st:pvp' },
            { label: 'Access & privacy', customId: 'st:access' },
        ]),
    ], firstResponse);
}

// "Last configured by" - configured_by_discord_user_id/configured_at have been stored
// since the table was created but never surfaced anywhere. In a server with several
// admins, "who changed this, and when" is the first question asked when a setting
// looks wrong, so the panel that shows the settings should answer it too.
// Neon hands timestamps back as Date objects, so go through new Date() rather than
// Date.parse() on a string that may already be one.
function configuredByLine(c: GuildSettingsRow): string {
    const ts = new Date(c.configured_at).getTime();
    const when = Number.isNaN(ts) ? '' : ` on <t:${Math.floor(ts / 1000)}:D>`;
    return `**Last configured by:** <@${c.configured_by_discord_user_id}>${when}`;
}

// The access/privacy explainer. Until this existed, the only trust copy an admin ever
// saw was the wizard's first screen - a one-time thing, gone the moment setup ended -
// and the permission model itself was never stated anywhere at all. This is the
// standing, re-readable version of both, plus the one genuinely actionable thing an
// admin can do about it: Discord's own per-command role/channel overrides, which are
// strictly narrower than our Manage Server default and which most admins don't know
// exist.
//
// Every claim here has to stay true of the code: the "re-checks on every request"
// line is only honest because hasManageGuildPermission gates the entry-point
// commands, the wizard steps, this panel, AND (see discord-commands.ts's
// denyIfNotAdmin) the mid-flow select/confirm steps.
function accessScreen(): Response {
    return settingScreen(
        [
            '**Access & privacy**',
            '',
            '**Who can do what**',
            '• **Admins with Manage Server** — `/heatchecks` and everything under it: setup, settings, posting, draws.',
            '• **Everyone else** — `/leaderboard`, `/me`, `/my-results`, `/heatchecks-league`, and the pick and vote buttons on cards.',
            '',
            'Discord hides admin commands from members who lack the permission, and Heatchecks re-checks it on every request — so a hidden command is never the only thing standing between a member and an admin action.',
            '',
            '**Want tighter control?**',
            'Server Settings → Integrations → Heatchecks lets you limit any command to specific roles or channels — staff-only posting, say, or member commands confined to a bot channel. Your rules there are narrower than ours and they win.',
            '',
            '**What Heatchecks never does**',
            'Read your message history, DM your members unprompted, distribute prizes, or touch real money. It posts to the channels you pick and replies when someone uses it.',
            '',
            '**Channel permissions it needs**',
            'View Channel, Send Messages, Embed Links, Attach Files — in your main channel and any Community Pick channel.',
        ].join('\n'),
        []
    );
}

// Every st:* component lands here. Writes are one-column UPDATEs on an existing row
// (the panel refuses to open without one), so an interrupted panel can't half-write a
// guild's config any more than the wizard can.
export async function handleSettingsComponent(context: RequestContext, interaction: any, customId: string): Promise<Response> {
    const guildId: string | undefined = interaction.guild_id;
    const userId: string | undefined = interaction.member?.user?.id;
    if (!guildId || !userId) return panelScreen("Couldn't read that.", [], false);
    if (!hasManageGuildPermission(interaction)) return panelScreen('You need the "Manage Server" permission to change settings.', [], false);

    const sql = getSql(context.env);
    const [, step, arg] = customId.split(':');

    switch (step) {
        case 'panel':
            return buildSettingsPanel(context, guildId, false);

        case 'access':
            return accessScreen();

        case 'chans':
            return settingScreen(
                '**Channels**\nMain channel is where Tank cards and announcements post. Community Pick channels are the extra channels admins may post picks into.',
                [
                    { type: ACTION_ROW, components: [{ type: CHANNEL_SELECT, custom_id: 'st:setchan', channel_types: [GUILD_TEXT], placeholder: 'Main channel' }] },
                    { type: ACTION_ROW, components: [{ type: CHANNEL_SELECT, custom_id: 'st:setcpchans', channel_types: [GUILD_TEXT], min_values: 1, max_values: 5, placeholder: 'Community Pick channels' }] },
                    buttonRow([{ label: 'Clear extra channels', customId: 'st:setcpchans:clear' }]),
                ]
            );

        case 'setchan': {
            const chanId = interaction.data?.values?.[0];
            if (!chanId) return settingScreen("Couldn't read that channel — try again.", []);
            await upsertChannel(sql, guildId, chanId, userId);
            return buildSettingsPanel(context, guildId, false);
        }

        case 'setcpchans': {
            const ids: string[] = arg === 'clear' ? [] : (interaction.data?.values ?? []);
            await sql`UPDATE discord_guild_configs SET community_pick_channel_ids = ${JSON.stringify(ids)}::jsonb WHERE guild_id = ${guildId}`;
            return buildSettingsPanel(context, guildId, false);
        }

        case 'tank':
            return settingScreen(
                '**Tank posts**\nDaily prop-pick cards from heatchecks.io. Turn them on or off, and cap how many post per day.',
                [
                    buttonRow([
                        { label: 'On', customId: 'st:settank:on', style: STYLE_PRIMARY },
                        { label: 'Off', customId: 'st:settank:off' },
                    ]),
                    buttonRow([
                        { label: '1 a day', customId: 'st:setcad:1' },
                        { label: '3 a day', customId: 'st:setcad:3' },
                        { label: 'All of them', customId: 'st:setcad:all' },
                    ]),
                ]
            );

        case 'settank':
            await sql`UPDATE discord_guild_configs SET tank_posts_enabled = ${arg === 'on'} WHERE guild_id = ${guildId}`;
            return buildSettingsPanel(context, guildId, false);

        case 'setcad': {
            const limit = arg === 'all' ? null : Number(arg);
            await sql`UPDATE discord_guild_configs SET daily_post_limit = ${limit} WHERE guild_id = ${guildId}`;
            return buildSettingsPanel(context, guildId, false);
        }

        case 'sports':
            return settingScreen(
                '**Sports**\nWhich sports post in this server. Picking replaces the current selection.',
                [{
                    type: ACTION_ROW,
                    components: [{
                        type: STRING_SELECT, custom_id: 'st:setsports', min_values: 1, max_values: 5, placeholder: 'Pick sports',
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

        case 'setsports': {
            const values: string[] = interaction.data?.values ?? [];
            const enabled = values.includes('all') ? ALL_LEAGUES : values.flatMap((v) => SPORT_GROUPS[v] ?? []);
            const disabled = ALL_LEAGUES.filter((l) => !enabled.includes(l));
            await sql`UPDATE discord_guild_configs SET disabled_sports = ${JSON.stringify(disabled)}::jsonb WHERE guild_id = ${guildId}`;
            return buildSettingsPanel(context, guildId, false);
        }

        case 'vis':
            return settingScreen(
                '**Settlement results**\nWhen picks settle, announce results in the channel, or keep them private (members check `/my-results`)?',
                [buttonRow([
                    { label: 'Announce in channel', customId: 'st:setvis:channel', style: STYLE_PRIMARY },
                    { label: 'Keep results private', customId: 'st:setvis:private' },
                ])]
            );

        case 'setvis':
            await sql`UPDATE discord_guild_configs SET settlement_visibility = ${arg === 'private' ? 'private' : 'channel'} WHERE guild_id = ${guildId}`;
            return buildSettingsPanel(context, guildId, false);

        case 'draw':
            return settingScreen(
                '**Auto-draw**\nAutomatically draw a giveaway winner whenever something settles here. Off means you draw by hand — the "Draw a winner" button on a settled card, or `/heatchecks draw`.\n\nHeatchecks only ever names a winner; it never supplies or distributes prizes.',
                [buttonRow([
                    { label: 'On', customId: 'st:setdraw:on', style: STYLE_PRIMARY },
                    { label: 'Off', customId: 'st:setdraw:off' },
                ])]
            );

        case 'setdraw':
            await sql`UPDATE discord_guild_configs SET auto_draw_enabled = ${arg === 'on'} WHERE guild_id = ${guildId}`;
            return buildSettingsPanel(context, guildId, false);

        case 'names':
            return settingScreen(
                '**Names**\nWhat this server calls its leaderboard and its points. Cosmetic only — scoring is unchanged.',
                [buttonRow([
                    { label: 'Rename leaderboard', customId: 'st:setlbname' },
                    { label: 'Rename points', customId: 'st:setptsname' },
                    { label: 'Reset both', customId: 'st:setnames:reset' },
                ])]
            );

        case 'setlbname':
            return json({
                type: RESPONSE_MODAL,
                data: {
                    custom_id: 'stm:lbname', title: 'Name your leaderboard',
                    components: [{ type: ACTION_ROW, components: [{ type: TEXT_INPUT, custom_id: 'name', label: 'Leaderboard name', style: 1, max_length: 40, required: true }] }],
                },
            });

        case 'setptsname':
            return json({
                type: RESPONSE_MODAL,
                data: {
                    custom_id: 'stm:ptsname', title: 'Name your points',
                    components: [{ type: ACTION_ROW, components: [{ type: TEXT_INPUT, custom_id: 'name', label: 'Points name', style: 1, max_length: 40, required: true }] }],
                },
            });

        case 'setnames':
            await sql`UPDATE discord_guild_configs SET leaderboard_label = NULL, community_points_label = NULL WHERE guild_id = ${guildId}`;
            return buildSettingsPanel(context, guildId, false);

        case 'weekly':
            return settingScreen(
                '**Weekly leaderboard post**\nPost your leaderboard automatically every week. Picking replaces the current selection.',
                [
                    {
                        type: ACTION_ROW,
                        components: [{
                            type: STRING_SELECT, custom_id: 'st:setweekly', min_values: 1, max_values: 3, placeholder: 'Which leaderboards?',
                            options: [
                                { label: 'Community Points', value: 'community' },
                                { label: 'Accuracy', value: 'accuracy' },
                                { label: 'Skill Rating', value: 'sr' },
                            ],
                        }],
                    },
                    buttonRow([{ label: 'Turn weekly post off', customId: 'st:setweekly:off' }]),
                ]
            );

        case 'setweekly': {
            const values: string[] = arg === 'off' ? [] : (interaction.data?.values ?? []);
            await sql`UPDATE discord_guild_configs SET weekly_leaderboard = ${JSON.stringify(values)}::jsonb WHERE guild_id = ${guildId}`;
            return buildSettingsPanel(context, guildId, false);
        }

        case 'eph':
            return settingScreen(
                '**Member commands**\n`/me`, `/leaderboard`, and `/my-results` — should replies be visible only to the member who asks, or posted for everyone?',
                [buttonRow([
                    { label: 'Only visible to them', customId: 'st:seteph:yes' },
                    { label: 'Visible to everyone', customId: 'st:seteph:no', style: STYLE_PRIMARY },
                ])]
            );

        case 'seteph':
            await sql`UPDATE discord_guild_configs SET ephemeral_user_commands = ${arg === 'yes'} WHERE guild_id = ${guildId}`;
            return buildSettingsPanel(context, guildId, false);

        case 'pvp': {
            const pvpRows = await sql`SELECT channel_id, pvp_channel_id FROM discord_guild_configs WHERE guild_id = ${guildId}`;
            const pvpCfg = pvpRows[0] as unknown as { channel_id: string; pvp_channel_id: string | null };
            return settingScreen(
                [
                    '**PvP battles**',
                    '`/pvp challenge` lets any two members challenge each other to a 3-pick head-to-head on games starting in the next 72 hours. Picks stay private until the battle settles; both players track them with `/pvp battles`.',
                    '',
                    `**Posts to:** ${pvpCfg?.pvp_channel_id ? `<#${pvpCfg.pvp_channel_id}>` : `the main channel (<#${pvpCfg?.channel_id}>)`} — pick a channel below to give PvP its own home.`,
                    '',
                    'A challenge posts ONE line pinging only the person challenged; the result recap posts when the battle settles. Each is switched separately below, and both are independent of your settlement results setting — so you can keep Tank and Community Pick recaps private and still announce battles. With challenge announcements off, the person challenged finds it by running `/pvp battles`.',
                ].join('\n'),
                [
                    { type: ACTION_ROW, components: [{ type: CHANNEL_SELECT, custom_id: 'st:setpvpchan', channel_types: [GUILD_TEXT], placeholder: 'PvP channel' }] },
                    buttonRow([
                        { label: 'Use main channel', customId: 'st:setpvpchan:clear' },
                        { label: 'PvP on', customId: 'st:setpvp:on', style: STYLE_PRIMARY },
                        { label: 'PvP off', customId: 'st:setpvp:off' },
                    ]),
                    buttonRow([
                        { label: 'Announce challenges', customId: 'st:setpvpann:on', style: STYLE_PRIMARY },
                        { label: 'Silent challenges', customId: 'st:setpvpann:off' },
                    ]),
                    buttonRow([
                        { label: 'Announce results', customId: 'st:setpvpvis:channel', style: STYLE_PRIMARY },
                        { label: 'Results private', customId: 'st:setpvpvis:private' },
                    ]),
                ]
            );
        }

        case 'setpvpchan': {
            // Blank = the main channel, which is why 'clear' writes NULL rather than
            // copying channel_id: a guild that later moves its main channel should
            // keep following it, not stay pinned to a stale copy.
            const chanId = arg === 'clear' ? null : (interaction.data?.values?.[0] ?? null);
            await sql`UPDATE discord_guild_configs SET pvp_channel_id = ${chanId} WHERE guild_id = ${guildId}`;
            return buildSettingsPanel(context, guildId, false);
        }

        case 'setpvpann':
            await sql`UPDATE discord_guild_configs SET pvp_announce_challenges = ${arg === 'on'} WHERE guild_id = ${guildId}`;
            return buildSettingsPanel(context, guildId, false);

        case 'setpvp':
            await sql`UPDATE discord_guild_configs SET pvp_enabled = ${arg === 'on'} WHERE guild_id = ${guildId}`;
            return buildSettingsPanel(context, guildId, false);

        case 'setpvpvis':
            await sql`UPDATE discord_guild_configs SET pvp_results_visibility = ${arg === 'private' ? 'private' : 'channel'} WHERE guild_id = ${guildId}`;
            return buildSettingsPanel(context, guildId, false);
    }
    return buildSettingsPanel(context, guildId, false);
}

// Settings-mode modal submits (stm:*) - same two rename modals the wizard uses, but
// they return to the panel instead of advancing a step.
export async function handleSettingsModal(context: RequestContext, interaction: any, customId: string): Promise<Response> {
    const guildId: string | undefined = interaction.guild_id;
    if (!guildId) return panelScreen("Couldn't read that.", [], false);
    if (!hasManageGuildPermission(interaction)) return panelScreen('You need the "Manage Server" permission to change settings.', [], false);

    const value: string = (interaction.data?.components?.[0]?.components?.[0]?.value ?? '').trim().slice(0, 40);
    const sql = getSql(context.env);

    if (customId === 'stm:lbname' && value) {
        await sql`UPDATE discord_guild_configs SET leaderboard_label = ${value} WHERE guild_id = ${guildId}`;
    } else if (customId === 'stm:ptsname' && value) {
        await sql`UPDATE discord_guild_configs SET community_points_label = ${value} WHERE guild_id = ${guildId}`;
    }
    return buildSettingsPanel(context, guildId, false);
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
    if (cfg.length === 0) return screen('No channel configured — restart with `/heatchecks setup`.');
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
