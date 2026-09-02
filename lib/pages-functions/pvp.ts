// /pvp - head-to-head 3-pick battles between two members of one guild. The command
// and every component screen live here; the tables are in create_pvp_tables.sql and
// settlement is functions/api/pvp-settlement-sweep.ts.
//
// The shape: /pvp challenge user:@X creates a pending battle and posts ONE public line pinging
// only the opponent. Everything after that is ephemeral - accepting, searching,
// picking, and each player's own selections - until the battle settles and the recap
// posts. Each player picks up to 3 props on games kicking off in the next 72h;
// a correct pick pays the same underdog-weighted points a Community Pick does
// (computePointsSplit), locked at submission. Highest total wins; equal totals draw.
//
// SEALED PICKS - the rule this file exists to enforce: no user-reachable code path
// may read pvp_battle_picks without a `discord_user_id = <the caller>` predicate.
// getOwnPicks below is the only accessor screens use, and the opponent's progress is
// exposed as a COUNT and nothing else. The single query that reads both players' rows
// lives in the settlement sweep, which no interaction can reach. A future PvP
// leaderboard or /my-results section must keep that line intact - and error copy must
// never echo a market the OPPONENT chose.
//
// Isolation reminder: writes only pvp_battles + pvp_battle_picks. PvP awards no
// Community Points and never touches ember_ledger/ember_balances/picks/community_* or
// any shop table.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, type Env } from './db';
import { postDiscordChannelMessage, deleteChannelMessage, fetchGuildMemberBrief, buildAvatarUrlForRender } from './discord-api';
import { brandEmbed } from './discord-brand';
import { buildPvpChallengeMessage } from './pvp-card';
import { computePvpRecords, formatPvpRecord, type PvpRecord } from './pvp-record';
import { renderPvpHubImage, MAX_IMAGE_ROWS, type PvpHubRow } from './pvp-hub-image';
import { computeSkillRatings } from './skill-rating';
import { computeLevels } from './leveling';
import { fetchMarket, resolveMarket } from './gamma';
import { computePointsSplit } from './community-points-formula';
import { fetchLiveGames } from '../../tank-gamma-live';
import {
    ephemeral,
    deferredEphemeral,
    parseMarketOutcomes,
    parseGameStartTime,
    SUPPORTED_SPORTS,
    type DeferredMessageData,
} from './discord-commands';
import { pickGameLines, buildMarketOption, type MarketOption } from './market-menu';

type RequestContext = Parameters<PagesFunction<Env>>[0];

const RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE = 4;
const RESPONSE_DEFERRED_UPDATE_MESSAGE = 6;
const RESPONSE_UPDATE_MESSAGE = 7;
const EPHEMERAL_FLAG = 64;
const ACTION_ROW = 1;
const BUTTON = 2;
const STRING_SELECT = 3;
const STYLE_PRIMARY = 1;
const STYLE_SECONDARY = 2;
const STYLE_SUCCESS = 3;
const STYLE_DANGER = 4;
const MAX_SELECT_OPTIONS = 25;

const PICKS_PER_PLAYER = 3;
// How far ahead a pickable game may kick off. Started at 24h ("today's slate"), which
// emptied the menu completely during international breaks and the NBA/NFL offseason -
// on 2026-09-01 only MLB and the EFL Championship had anything at all inside a day.
// 72h keeps battles short (worst case ~4 days from acceptance to the last kickoff,
// still well inside the settlement sweep's 7-day stale backstop) while covering a full
// weekend of fixtures. The admin Community Pick search keeps fetchLiveGames' 168h
// default - a Community Pick has no opponent waiting on it.
const SEARCH_WINDOW_HOURS = 72;
// Sentinel for the "any sport" row in the sport select. A '*' can never collide with a
// league name.
const ANY_SPORT = '*any';
// One member spraying challenges across the roster is the only way this feature can
// make public noise, so outgoing challenges are capped.
const MAX_OPEN_OUTGOING = 3;
// And a ceiling on battles actually in progress: three picks each, on their own 24h
// clocks, is already a lot to keep straight. Nobody can fill your slots for you - a
// battle only goes active when YOU accept - so this can't be used to block someone.
const MAX_ACTIVE_BATTLES = 5;

// ===================================================================================
// Response plumbing. PvP screens carry an embed AND (often) a select plus buttons, so
// they build type-7 payloads directly rather than going through discord-commands.ts's
// updateMessageResponse, which hard-blanks embeds and takes a single row of buttons.
// ===================================================================================

function json(body: unknown): Response {
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}

function screenData(body: string, components: unknown[] = []): { content: string; embeds: unknown[]; components: unknown[] } {
    return { content: '', embeds: [brandEmbed({ kind: 'settlement', plate: 'PVP', body })], components };
}

/** New ephemeral message (command responses). */
function screen(body: string, components: unknown[] = []): Response {
    return json({ type: RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE, data: { ...screenData(body, components), flags: EPHEMERAL_FLAG } });
}

/** Edits the message the component sits on (every mid-flow step). */
function updateScreen(body: string, components: unknown[] = []): Response {
    return json({ type: RESPONSE_UPDATE_MESSAGE, data: screenData(body, components) });
}

function buttonRow(buttons: { label: string; customId: string; style?: number; disabled?: boolean }[]): unknown {
    return {
        type: ACTION_ROW,
        components: buttons.map((b) => ({ type: BUTTON, style: b.style ?? STYLE_SECONDARY, label: b.label.slice(0, 80), custom_id: b.customId, disabled: b.disabled })),
    };
}

/**
 * The component-interaction twin of deferredEphemeral: acks with type 6 (DEFERRED
 * UPDATE), so the follow-up PATCH edits the ephemeral the component is sitting on
 * instead of stacking a second one the way a type-5 ack would. Needed because
 * fetchLiveGames paginates Polymarket and can't be trusted inside Discord's 3s window.
 */
function deferredUpdate(context: RequestContext, interaction: any, work: Promise<DeferredMessageData>): Response {
    const applicationId: string | undefined = interaction.application_id;
    const token: string | undefined = interaction.token;
    if (!applicationId || !token) return updateScreen("Couldn't process that - try again.");

    context.waitUntil(
        work
            .catch((err) => {
                console.error('[pvp] Deferred screen failed:', err);
                return screenData('Something went wrong — try again shortly.') as DeferredMessageData;
            })
            .then((data) => {
                const url = `https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/@original`;
                // Only fields the caller SET are sent. Discord retains anything
                // omitted, which is what lets a selection re-render swap the
                // components while the card image and body stay exactly as they were.
                const payload: Record<string, unknown> = { components: data.components ?? [] };
                if (data.content !== undefined) payload.content = data.content;
                if (data.embeds !== undefined) payload.embeds = data.embeds;
                if (data.file) {
                    // `attachments` naming ONLY the new upload is what makes this a
                    // replacement. Discord's rule is that omitting the field RETAINS
                    // whatever the message already carries (which is exactly what the
                    // setup wizard relies on to keep its banner pinned) - so a re-render
                    // that PATCHes a fresh PNG without this would leave the message
                    // carrying both the stale and the new image.
                    payload.attachments = [{ id: 0, filename: data.file.name }];
                    const form = new FormData();
                    form.append('payload_json', JSON.stringify(payload));
                    // No Content-Type header: fetch has to set the multipart boundary.
                    form.append('files[0]', new Blob([new Uint8Array(data.file.data)], { type: 'image/png' }), data.file.name);
                    return fetch(url, { method: 'PATCH', body: form });
                }
                // No file: omit `attachments` so an image already on the message stays.
                // That's what makes the dropdown "hold" re-renders free - they change
                // only which option is marked and which buttons show.
                return fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            })
            .catch((err) => console.error('[pvp] Deferred PATCH failed:', err))
    );

    return json({ type: RESPONSE_DEFERRED_UPDATE_MESSAGE });
}

// Display names (for buttons and select options, which unlike an embed description
// cannot render a <@id> mention) and avatars (for the hub card's mini /me cards). One
// single-member REST call each, memoized for the isolate's lifetime so a Refresh - or
// the second hub render of a session - costs nothing. Display only: every ownership
// decision reads the battle row, never a name.
const NAME_TTL_MS = 10 * 60 * 1000;
interface CachedMember { name: string; avatarUrl: string }
const memberCache = new Map<string, { at: number; member: CachedMember }>();

async function resolveMembers(env: Env, guildId: string, userIds: string[]): Promise<Map<string, CachedMember>> {
    const wanted = [...new Set(userIds)];
    const out = new Map<string, CachedMember>();
    const misses: string[] = [];
    for (const id of wanted) {
        const hit = memberCache.get(`${guildId}:${id}`);
        if (hit && Date.now() - hit.at < NAME_TTL_MS) out.set(id, hit.member);
        else misses.push(id);
    }
    const fetched = await Promise.all(misses.map((id) => fetchGuildMemberBrief(env, guildId, id)));
    misses.forEach((id, i) => {
        const member: CachedMember = {
            name: fetched[i].name,
            avatarUrl: buildAvatarUrlForRender(id, fetched[i].avatarHash),
        };
        memberCache.set(`${guildId}:${id}`, { at: Date.now(), member });
        out.set(id, member);
    });
    return out;
}

// ===================================================================================
// Rows + shared reads
// ===================================================================================

interface BattleRow {
    id: string;
    guild_id: string;
    channel_id: string;
    challenger_id: string;
    opponent_id: string;
    status: string;
    expires_at: string;
    picks_close_at: string | null;
}

interface OwnPickRow {
    slot: number;
    question_text: string;
    side_chosen: number;
    side_a_label: string;
    side_b_label: string;
    points_if_correct: number;
    kickoff_at: string | null;
}

async function loadBattle(sql: ReturnType<typeof getSql>, battleId: string): Promise<BattleRow | null> {
    // Cheap malformed-id guard: a non-UUID would make Postgres throw rather than
    // return zero rows, and these ids arrive from client-round-tripped custom_ids.
    if (!/^[0-9a-f-]{36}$/i.test(battleId)) return null;
    const rows = await sql`
        SELECT id, guild_id, channel_id, challenger_id, opponent_id, status, expires_at, picks_close_at
        FROM pvp_battles WHERE id = ${battleId}
    `;
    return (rows[0] as unknown as BattleRow) ?? null;
}

/**
 * The ONLY pick accessor any user-facing screen may use - always scoped to the
 * caller's own rows. See this file's header.
 */
async function getOwnPicks(sql: ReturnType<typeof getSql>, battleId: string, discordUserId: string): Promise<OwnPickRow[]> {
    return (await sql`
        SELECT slot, question_text, side_chosen, side_a_label, side_b_label, points_if_correct, kickoff_at
        FROM pvp_battle_picks
        WHERE battle_id = ${battleId} AND discord_user_id = ${discordUserId}
        ORDER BY slot
    `) as unknown as OwnPickRow[];
}

async function opponentPickCount(sql: ReturnType<typeof getSql>, battleId: string, opponentId: string): Promise<number> {
    // COUNT only - never the rows themselves.
    const rows = await sql`
        SELECT COUNT(*)::int AS n FROM pvp_battle_picks
        WHERE battle_id = ${battleId} AND discord_user_id = ${opponentId}
    `;
    return Number((rows[0] as unknown as { n: number })?.n ?? 0);
}

function otherPlayer(battle: BattleRow, me: string): string {
    return battle.challenger_id === me ? battle.opponent_id : battle.challenger_id;
}

// Which battle am I in? Every screen past the hub answers that, because with several
// battles running the pick flow is otherwise identity-free - the battle id lives only
// in custom_ids the user can't see, so it was possible to lock a pick into the wrong
// battle with no signal. A mention costs nothing (it renders in an embed description)
// and is always correct without a name lookup.
function vs(battle: BattleRow, me: string): string {
    return `**vs <@${otherPlayer(battle, me)}>**`;
}

// Select option descriptions are plain text - Discord's <t:...:R> markup only renders
// in message content and embed bodies - so the deadline gets spelled out there.
function relativeFromNow(unix: number): string {
    const mins = Math.round((unix * 1000 - Date.now()) / 60000);
    if (mins <= 0) return 'now';
    if (mins < 60) return `in ${mins}m`;
    const hours = Math.round(mins / 60);
    return hours < 48 ? `in ${hours}h` : `in ${Math.round(hours / 24)}d`;
}

function unixOf(value: string | null | undefined): number | null {
    if (!value) return null;
    const t = new Date(value).getTime();
    return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

// ===================================================================================
// /pvp - bare opens the hub, with a user issues a challenge.
// ===================================================================================

export async function handlePvpCommand(context: RequestContext, interaction: any): Promise<Response> {
    const guildId: string | undefined = interaction.guild_id;
    const me: string | undefined = interaction.member?.user?.id;
    if (!guildId || !me) return ephemeral('Run this in a server, not a DM.');

    // The dispatcher hands us the SUBCOMMAND's own options on data.options (the same
    // shim the /heatchecks hub uses), so this only has to pick a branch.
    const sub: string = interaction.data?.options?.[0]?.name ?? 'battles';
    if (sub === 'challenge') {
        const targetId: string | undefined = interaction.data?.options?.find((o: any) => o.name === 'user')?.value;
        if (!targetId) return ephemeral('Pick someone to challenge.');
        return createChallenge(context, interaction, guildId, me, targetId);
    }
    return deferredEphemeral(context, interaction, hubData(context, guildId, me));
}

async function createChallenge(context: RequestContext, interaction: any, guildId: string, me: string, targetId: string): Promise<Response> {
    if (targetId === me) return ephemeral("You can't challenge yourself.");

    // resolved.* is populated by Discord for a USER option in a guild - the bot check
    // and the membership check are free here, no roster fetch.
    const resolvedUser = interaction.data?.resolved?.users?.[targetId];
    if (resolvedUser?.bot) return ephemeral("You can't challenge a bot.");
    if (!interaction.data?.resolved?.members?.[targetId]) return ephemeral("That person isn't in this server.");

    const sql = getSql(context.env);
    const cfgRows = await sql`
        SELECT channel_id, pvp_enabled, pvp_channel_id, pvp_announce_challenges
        FROM discord_guild_configs WHERE guild_id = ${guildId}
    `;
    if (cfgRows.length === 0) return ephemeral('This server has no channel configured — an admin needs to run `/heatchecks setup` first.');
    const cfg = cfgRows[0] as unknown as {
        channel_id: string; pvp_enabled: boolean; pvp_channel_id: string | null; pvp_announce_challenges: boolean;
    };
    if (!cfg.pvp_enabled) return ephemeral('PvP is turned off in this server.');
    // Null pvp_channel_id means "wherever everything else goes". Resolved once, here,
    // and snapshotted onto the battle - a battle already running keeps posting its
    // result where it started even if an admin repoints this later.
    const pvpChannelId = cfg.pvp_channel_id || cfg.channel_id;

    const live = await sql`
        SELECT id FROM pvp_battles
        WHERE guild_id = ${guildId} AND status IN ('pending', 'active')
          AND ((challenger_id = ${me} AND opponent_id = ${targetId}) OR (challenger_id = ${targetId} AND opponent_id = ${me}))
        LIMIT 1
    `;
    if (live.length > 0) return ephemeral('You already have a battle going with them — run `/pvp battles` to see it.');

    // Both caps are checked BEFORE the public post, which is the whole point of them.
    const counts = (await sql`
        SELECT
            COUNT(*) FILTER (WHERE challenger_id = ${me} AND status = 'pending')::int AS outgoing,
            COUNT(*) FILTER (WHERE (challenger_id = ${me} OR opponent_id = ${me}) AND status = 'active')::int AS active
        FROM pvp_battles
        WHERE guild_id = ${guildId}
    `) as unknown as { outgoing: number; active: number }[];
    if (Number(counts[0]?.outgoing ?? 0) >= MAX_OPEN_OUTGOING) {
        return ephemeral(`You've got ${MAX_OPEN_OUTGOING} challenges out already — wait for one to be answered.`);
    }
    // Sending an invitation you couldn't play is worse than not sending it.
    if (Number(counts[0]?.active ?? 0) >= MAX_ACTIVE_BATTLES) {
        return ephemeral(`You've already got ${MAX_ACTIVE_BATTLES} battles going — finish one before starting another.`);
    }

    let battleId: string;
    try {
        const rows = await sql`
            INSERT INTO pvp_battles (guild_id, channel_id, challenger_id, opponent_id)
            VALUES (${guildId}, ${pvpChannelId}, ${me}, ${targetId})
            RETURNING id
        `;
        battleId = (rows[0] as unknown as { id: string }).id;
    } catch (err: any) {
        // The partial unique index is the real guard; the pre-check above just gets a
        // friendlier message in the common case.
        if (err?.code === '23505') return ephemeral('You already have a battle going with them — run `/pvp battles` to see it.');
        throw err;
    }

    // A server can silence the announcement, in which case the challenge is
    // discoverable only by running /pvp - so say that plainly rather than implying
    // they'll be pinged.
    if (!cfg.pvp_announce_challenges) {
        return screen(`Challenge sent to <@${targetId}>. Challenge announcements are off in this server, so tell them to run \`/pvp battles\` — they have 24h to accept.`);
    }

    const challengerName = interaction.member?.nick || interaction.member?.user?.global_name || interaction.member?.user?.username || 'Someone';
    try {
        const messageId = await postDiscordChannelMessage(context.env, pvpChannelId, buildPvpChallengeMessage(challengerName, targetId));
        await sql`UPDATE pvp_battles SET challenge_message_id = ${messageId} WHERE id = ${battleId}`;
    } catch (err) {
        console.error('[pvp] Challenge ping failed:', err);
        return screen(`Challenge sent to <@${targetId}> — but I couldn't post the notice in <#${pvpChannelId}>, so tell them to run \`/pvp battles\`. They have 24h to accept.`);
    }

    return screen(`Challenge sent to <@${targetId}>. They have 24h to accept — you'll see it under \`/pvp battles\` either way.`);
}

// ===================================================================================
// The hub
// ===================================================================================

interface HubBattleRow extends BattleRow {
    created_at: string;
}

/**
 * The hub, rendered as a card in the leaderboard's language with a mini /me card for
 * each opponent (see pvp-hub-image.ts).
 *
 * `selected` is a battle or challenge the user just picked from one of the dropdowns: a
 * select never navigates on its own (people read that as the screen jumping, or as
 * nothing having happened), so picking one re-renders THIS screen with the choice
 * marked on the widget and the action revealed underneath.
 *
 * `withImage` is false for exactly those selection re-renders: the underlying battles
 * haven't changed, and omitting the attachment makes Discord retain the image already
 * on the message - so the clicks people make most cost no render at all.
 */
async function hubData(context: RequestContext, guildId: string, me: string, selected?: string, withImage = true): Promise<DeferredMessageData> {
    const sql = getSql(context.env);
    const [battles, records] = await Promise.all([
        sql`
            SELECT id, guild_id, channel_id, challenger_id, opponent_id, status, expires_at, picks_close_at, created_at
            FROM pvp_battles
            WHERE guild_id = ${guildId} AND status IN ('pending', 'active')
              AND (challenger_id = ${me} OR opponent_id = ${me})
            ORDER BY created_at DESC
            LIMIT 10
        ` as unknown as Promise<HubBattleRow[]>,
        computePvpRecords(sql, guildId, [me]),
    ]);

    const record = formatPvpRecord(records.get(me)) ?? '0-0-0';
    const lines: string[] = [`**Record:** ${record}  (W-D-L)`];
    const rows: unknown[] = [];

    const incoming = battles.filter((b) => b.status === 'pending' && b.opponent_id === me);
    const outgoing = battles.filter((b) => b.status === 'pending' && b.challenger_id === me);
    const active = battles.filter((b) => b.status === 'active');

    // Every opponent this render will show, resolved in one parallel batch (name for
    // the components, avatar for the card).
    const opponentIds = [
        ...active.map((b) => otherPlayer(b, me)),
        ...incoming.map((b) => b.challenger_id),
        ...outgoing.map((b) => b.opponent_id),
    ];
    const members = await resolveMembers(context.env, guildId, opponentIds);
    const nameOf = (id: string) => members.get(id)?.name ?? 'Someone';

    // Pick counts for every active battle in one grouped query - counts only, never
    // pick rows (sealed-picks rule).
    const activeIds = active.map((b) => b.id);
    const countRows = activeIds.length > 0
        ? (await sql`
            SELECT battle_id, discord_user_id, COUNT(*)::int AS n
            FROM pvp_battle_picks WHERE battle_id = ANY(${activeIds}::uuid[])
            GROUP BY battle_id, discord_user_id
        `) as unknown as { battle_id: string; discord_user_id: string; n: number }[]
        : [];
    const countOf = (battleId: string, userId: string) =>
        Number(countRows.find((r) => r.battle_id === battleId && r.discord_user_id === userId)?.n ?? 0);

    // Incoming: one challenge gets straight-through buttons (the common case, one
    // click). Two or more go through a select, because two identical Accept/Decline
    // rows are indistinguishable - Discord button labels can't render a mention, and
    // the old build's positional correlation with the bullets above was a coin flip.
    if (incoming.length > 0) {
        lines.push('', '**Challenges for you**');
        for (const b of incoming) {
            const exp = unixOf(b.expires_at);
            lines.push(`• <@${b.challenger_id}> challenged you${exp ? ` — expires <t:${exp}:R>` : ''}`);
        }
        // One challenge: its buttons are already unambiguous, so show them directly.
        // Several: a select to choose which, and picking one reveals ITS buttons here
        // rather than replacing the screen.
        const chosenIncoming = incoming.find((b) => b.id === selected) ?? (incoming.length === 1 ? incoming[0] : undefined);
        if (incoming.length > 1) {
            rows.push({
                type: ACTION_ROW,
                components: [{
                    type: STRING_SELECT,
                    custom_id: 'pv:inc',
                    placeholder: 'Answer a challenge',
                    options: incoming.slice(0, MAX_SELECT_OPTIONS).map((b) => {
                        const exp = unixOf(b.expires_at);
                        return {
                            label: `${nameOf(b.challenger_id)} challenged you`.slice(0, 100),
                            value: b.id,
                            description: (exp ? `Expires ${new Date(exp * 1000).toUTCString().slice(5, 22)} UTC` : 'Accept or decline').slice(0, 100),
                            // Keeps the widget showing what was picked - without this it
                            // snaps back to the placeholder and looks like nothing happened.
                            default: b.id === chosenIncoming?.id,
                        };
                    }),
                }],
            });
        }
        if (chosenIncoming) {
            rows.push(buttonRow([
                { label: `Accept — ${nameOf(chosenIncoming.challenger_id)}`, customId: `pv:acc:${chosenIncoming.id}`, style: STYLE_SUCCESS },
                { label: 'Decline', customId: `pv:dec:${chosenIncoming.id}`, style: STYLE_DANGER },
            ]));
        }
    }

    // Active: ONE select naming every opponent. Buttons couldn't say who they belonged
    // to and only three fit a row, which left a fourth battle unreachable - you could
    // not pick in it at all. A select carries the name, your progress, theirs and the
    // deadline on every row, and holds 25.
    if (active.length > 0) {
        lines.push('', '**Active battles**');
        const options = active.slice(0, MAX_SELECT_OPTIONS).map((b) => {
            const them = otherPlayer(b, me);
            const close = unixOf(b.picks_close_at);
            const mine = countOf(b.id, me);
            lines.push(`• vs <@${them}> — you ${mine}/${PICKS_PER_PLAYER} · them ${countOf(b.id, them)}/${PICKS_PER_PLAYER}${close ? ` · picks lock <t:${close}:R>` : ''}`);
            return {
                label: `vs ${nameOf(them)} — ${mine}/${PICKS_PER_PLAYER} picked`.slice(0, 100),
                value: b.id,
                description: `They have ${countOf(b.id, them)}/${PICKS_PER_PLAYER}${close ? ` · picks lock ${relativeFromNow(close)}` : ''}`.slice(0, 100),
            };
        });
        const chosenActive = active.find((b) => b.id === selected);
        rows.push({
            type: ACTION_ROW,
            components: [{
                type: STRING_SELECT,
                custom_id: 'pv:go',
                placeholder: active.length === 1 ? 'Open your battle' : 'Choose a battle',
                options: options.map((o) => ({ ...o, default: o.value === chosenActive?.id })),
            }],
        });
        // The pick screen is a whole screen of its own, so this one reveals a button
        // rather than inlining - but it still doesn't move until you press it.
        if (chosenActive) {
            rows.push(buttonRow([
                { label: `Open battle vs ${nameOf(otherPlayer(chosenActive, me))}`, customId: `pv:open:${chosenActive.id}`, style: STYLE_PRIMARY },
            ]));
        }
    }

    if (outgoing.length > 0) {
        lines.push('', '**Waiting on them**');
        // Cancel exists so a challenger isn't stuck for 24h waiting on someone who
        // isn't around - the live-pair index means an unanswered challenge also blocks
        // re-challenging that same person, so "cancel and go again" needs to be one
        // click. MAX_OPEN_OUTGOING keeps these inside a single button row.
        const cancelButtons: { label: string; customId: string; style?: number }[] = [];
        for (const b of outgoing) {
            const exp = unixOf(b.expires_at);
            lines.push(`• <@${b.opponent_id}> hasn't answered${exp ? ` — expires <t:${exp}:R>` : ''}`);
            cancelButtons.push({
                label: outgoing.length > 1 ? `Cancel — ${nameOf(b.opponent_id)}` : 'Cancel challenge',
                customId: `pv:can:${b.id}`,
                style: STYLE_DANGER,
            });
        }
        rows.push(buttonRow(cancelButtons));
    }

    if (battles.length === 0) {
        lines.push('', 'No battles going. Challenge someone with `/pvp challenge user:@them` — you each pick 3 props on games starting in the next 72h, and the higher score wins.');
    }

    rows.push(buttonRow([{ label: 'Refresh', customId: 'pv:hub' }]));

    // A hold re-render changes only which option is marked and which buttons show,
    // so it sends components ALONE: content, embeds and the card image all stay
    // untouched, whether this hub rendered as an image or fell back to text.
    if (!withImage) return { components: rows };
    if (battles.length === 0) return screenData(lines.join('\n'), rows);

    // Their level, Skill Rating and record - all three helpers take an array and are
    // constant-query in N, so the whole opponent set costs the same as one user.
    const statIds = [...new Set(opponentIds)];
    const [srById, levelById, recordById] = await Promise.all([
        computeSkillRatings(sql, guildId, statIds),
        computeLevels(sql, guildId, statIds),
        computePvpRecords(sql, guildId, statIds),
    ]);

    // Live battles first, then challenges waiting on you, then ones you sent - the same
    // order the text body reads in.
    const imageRows: PvpHubRow[] = [
        ...active.map((b) => {
            const them = otherPlayer(b, me);
            const close = unixOf(b.picks_close_at);
            return miniCardRow(members.get(them), them, srById, levelById, recordById, {
                progress: `you ${countOf(b.id, me)}/${PICKS_PER_PLAYER} · them ${countOf(b.id, them)}/${PICKS_PER_PLAYER}`,
                status: close ? `picks lock ${relativeFromNow(close)}` : 'picks open',
                pending: false,
            });
        }),
        ...incoming.map((b) => {
            const exp = unixOf(b.expires_at);
            return miniCardRow(members.get(b.challenger_id), b.challenger_id, srById, levelById, recordById, {
                progress: 'challenged you',
                status: exp ? `expires ${relativeFromNow(exp)}` : 'awaiting your answer',
                pending: true,
            });
        }),
        ...outgoing.map((b) => {
            const exp = unixOf(b.expires_at);
            return miniCardRow(members.get(b.opponent_id), b.opponent_id, srById, levelById, recordById, {
                progress: 'waiting on them',
                status: exp ? `expires ${relativeFromNow(exp)}` : 'unanswered',
                pending: true,
            });
        }),
    ];

    const png = await renderPvpHubImage({
        record,
        rows: imageRows,
        overflow: Math.max(0, imageRows.length - MAX_IMAGE_ROWS),
    });
    // Render failure falls back to the text hub, unchanged - the screen is never lost.
    if (!png) return screenData(lines.join('\n'), rows);

    return {
        content: '',
        embeds: [],
        components: rows,
        file: { data: png.buffer as ArrayBuffer, name: 'pvp.png' },
    };
}

// One mini /me card's worth of data. Absent stats read as level 1 / SR 0 / no record,
// which is exactly right for someone who has never settled anything.
function miniCardRow(
    member: { name: string; avatarUrl: string } | undefined,
    userId: string,
    srById: Map<string, number>,
    levelById: Map<string, { level: number }>,
    recordById: Map<string, PvpRecord>,
    battle: { progress: string; status: string; pending: boolean }
): PvpHubRow {
    return {
        name: member?.name ?? 'Someone',
        avatarUrl: member?.avatarUrl ?? null,
        level: levelById.get(userId)?.level ?? 1,
        sr: srById.get(userId) ?? 0,
        record: recordById.get(userId) ?? null,
        progress: battle.progress,
        status: battle.status,
        pending: battle.pending,
    };
}

// ===================================================================================
// Component dispatch - every pv:* custom_id lands here.
// ===================================================================================

export async function handlePvpComponent(context: RequestContext, interaction: any, customId: string): Promise<Response> {
    const guildId: string | undefined = interaction.guild_id;
    const me: string | undefined = interaction.member?.user?.id;
    if (!guildId || !me) return updateScreen("Couldn't read that.");

    const parts = customId.split(':');
    const step = parts[1];
    const sql = getSql(context.env);

    if (step === 'hub') {
        return deferredUpdate(context, interaction, hubData(context, guildId, me));
    }
    const selectedBattleId: string | undefined = (step === 'go' || step === 'inc')
        ? interaction.data?.values?.[0]
        : undefined;
    const battleId = selectedBattleId ?? parts[2];
    if (!battleId) return updateScreen("Couldn't read that battle.");
    const battle = await loadBattle(sql, battleId);
    if (!battle || battle.guild_id !== guildId) return updateScreen("Couldn't find that battle.");

    switch (step) {
        case 'acc':
        case 'dec': {
            // The codebase's first per-user component gate. Ownership comes from the
            // DB row, never the custom_id - custom_ids are client-round-tripped, and
            // this is what stops a challenger self-accepting.
            if (battle.opponent_id !== me) return updateScreen("That challenge isn't yours to answer.");
            if (step === 'dec') {
                await sql`UPDATE pvp_battles SET status = 'declined' WHERE id = ${battle.id} AND status = 'pending' AND opponent_id = ${me}`;
                return deferredUpdate(context, interaction, hubData(context, guildId, me));
            }
            // Both sides have to have room: the challenger may have filled their
            // slots in the time this invitation sat unanswered. Name whichever side is
            // full - "it didn't work" is useless when the reason is someone else's
            // battle count. The challenge stays pending and expires normally.
            const full = (await sql`
                SELECT
                    COUNT(*) FILTER (WHERE challenger_id = ${me} OR opponent_id = ${me})::int AS mine,
                    COUNT(*) FILTER (WHERE challenger_id = ${battle.challenger_id} OR opponent_id = ${battle.challenger_id})::int AS theirs
                FROM pvp_battles
                WHERE guild_id = ${guildId} AND status = 'active'
            `) as unknown as { mine: number; theirs: number }[];
            if (Number(full[0]?.mine ?? 0) >= MAX_ACTIVE_BATTLES) {
                return updateScreen(`You've already got ${MAX_ACTIVE_BATTLES} battles going — finish one before taking this on.`);
            }
            if (Number(full[0]?.theirs ?? 0) >= MAX_ACTIVE_BATTLES) {
                return updateScreen(`<@${battle.challenger_id}> already has ${MAX_ACTIVE_BATTLES} battles going — this one has to wait until one of theirs finishes.`);
            }
            // Conditional claim: a double-click is idempotent, and an expired or
            // already-answered challenge returns zero rows.
            const claimed = await sql`
                UPDATE pvp_battles
                SET status = 'active', accepted_at = NOW(), picks_close_at = NOW() + INTERVAL '24 hours'
                WHERE id = ${battle.id} AND status = 'pending' AND opponent_id = ${me} AND expires_at > NOW()
                RETURNING id, picks_close_at
            `;
            if (claimed.length === 0) return updateScreen('That challenge already expired or was answered.');
            // The row we loaded above predates this UPDATE - carry the new state over
            // so the pick screen shows the real deadline instead of a blank one.
            battle.status = 'active';
            battle.picks_close_at = (claimed[0] as unknown as { picks_close_at: string }).picks_close_at;
            return pickScreen(context, sql, battle, me);
        }

        case 'can': {
            // The challenger's side of decline. Ownership from the DB row, and the
            // conditional UPDATE means a challenge answered a second ago can't be
            // cancelled out from under the opponent - accept wins the race.
            if (battle.challenger_id !== me) return updateScreen("That challenge isn't yours to cancel.");
            const cancelled = await sql`
                UPDATE pvp_battles SET status = 'cancelled'
                WHERE id = ${battle.id} AND status = 'pending' AND challenger_id = ${me}
                RETURNING challenge_message_id
            `;
            if (cancelled.length === 0) return updateScreen('That challenge was already answered or expired — run `/pvp battles` to see where it stands.');
            // Take the public ping down with it, so nobody answers a dead challenge.
            const messageId = (cancelled[0] as unknown as { challenge_message_id: string | null }).challenge_message_id;
            if (messageId) context.waitUntil(deleteChannelMessage(context.env, battle.channel_id, messageId));
            return deferredUpdate(context, interaction, hubData(context, guildId, me));
        }

        // The two hub selects HOLD: they re-render the hub with the choice marked and
        // the matching action revealed, instead of navigating on a dropdown touch.
        // Both holds pass withImage=false: nothing about the battles changed, so the
        // card already on the message stays and this costs no render.
        case 'go':
            if (battle.challenger_id !== me && battle.opponent_id !== me) return updateScreen("That battle isn't yours.");
            return deferredUpdate(context, interaction, hubData(context, guildId, me, battle.id, false));

        case 'inc':
            if (battle.opponent_id !== me) return updateScreen("That challenge isn't yours to answer.");
            if (battle.status !== 'pending') return updateScreen('That challenge was already answered or expired.');
            return deferredUpdate(context, interaction, hubData(context, guildId, me, battle.id, false));

        case 'open':
        case 'pick':
        case 'back':
            if (battle.challenger_id !== me && battle.opponent_id !== me) return updateScreen("That battle isn't yours.");
            return pickScreen(context, sql, battle, me);

        // Choosing a sport doesn't run the search - the search is the slow step (a
        // Gamma request per league) and firing it on a dropdown touch is what read as
        // "it jumped". The pick screen re-renders with the sport held and a Search
        // button; pv:srch is what actually goes.
        case 'sport': {
            if (battle.challenger_id !== me && battle.opponent_id !== me) return updateScreen("That battle isn't yours.");
            const sport: string | undefined = interaction.data?.values?.[0];
            if (!sport) return updateScreen("Couldn't read that sport.");
            return pickScreen(context, sql, battle, me, sport);
        }

        case 'srch': {
            if (battle.challenger_id !== me && battle.opponent_id !== me) return updateScreen("That battle isn't yours.");
            const sport = parts.slice(3).join(':');
            if (!sport) return updateScreen("Couldn't read that sport.");
            return deferredUpdate(context, interaction, searchScreen(context, battle, me, sport));
        }

        // Choosing a market holds too - but here the next step INLINES: the same screen
        // keeps the menu (choice marked) and reveals that market's two side buttons, so
        // it costs no extra click than before while never moving on its own.
        case 'mkt': {
            if (battle.challenger_id !== me && battle.opponent_id !== me) return updateScreen("That battle isn't yours.");
            const value: string | undefined = interaction.data?.values?.[0];
            if (!value) return updateScreen("Couldn't read that market.");
            // value is `<marketId>|<league>`; a bare id (a menu rendered before the
            // league started riding the value) falls back to the sport in this menu's
            // own custom_id, which is exactly the old behaviour.
            const bar = value.indexOf('|');
            const sport = bar === -1 ? (parts[3] ?? '') : value.slice(bar + 1);
            return deferredUpdate(context, interaction, searchScreen(context, battle, me, sport, value));
        }

        case 'lock': {
            if (battle.challenger_id !== me && battle.opponent_id !== me) return updateScreen("That battle isn't yours.");
            const side = Number(parts[3]);
            // `pv:lock:<battle>:<side>:<sport>:<marketId>` - the market id stays the
            // TAIL, so a value that ever contained a colon can't shift the side index.
            // An id emitted before the sport was threaded through has NOTHING after
            // index 4, which distinguishes the two formats exactly (no heuristics), so
            // an ephemeral left open across the deploy still locks - it just records no
            // league.
            const tail = parts.slice(5).join(':');
            const marketId = tail || (parts[4] ?? '');
            const sport = tail ? (parts[4] ?? '') : '';
            if ((side !== 0 && side !== 1) || !marketId) return updateScreen("Couldn't read that pick.");
            return lockPick(context, sql, battle, me, side, marketId, sport);
        }
    }
    return updateScreen("Couldn't process that.");
}

// ===================================================================================
// Screens
// ===================================================================================

function describePick(p: OwnPickRow): string {
    const chosen = p.side_chosen === 0 ? p.side_a_label : p.side_b_label;
    return `${p.slot}. ${p.question_text} → **${chosen}** (${p.points_if_correct} pts)`;
}

/** `heldSport` is a sport just chosen from the dropdown but NOT yet searched - the
 *  search is the slow step, so it waits for an explicit press. */
async function pickScreen(context: RequestContext, sql: ReturnType<typeof getSql>, battle: BattleRow, me: string, heldSport?: string): Promise<Response> {
    const them = otherPlayer(battle, me);
    const [mine, theirCount, sportRows] = await Promise.all([
        getOwnPicks(sql, battle.id, me),
        opponentPickCount(sql, battle.id, them),
        sql`SELECT disabled_sports FROM discord_guild_configs WHERE guild_id = ${battle.guild_id}`,
    ]);

    const rawDisabled = (sportRows[0] as any)?.disabled_sports;
    const disabled: string[] = Array.isArray(rawDisabled) ? rawDisabled : JSON.parse(rawDisabled ?? '[]');
    const sports = SUPPORTED_SPORTS.filter((s) => !disabled.includes(s));

    const closeUnix = unixOf(battle.picks_close_at);
    const closed = battle.picks_close_at ? new Date(battle.picks_close_at).getTime() <= Date.now() : false;

    const lines = [
        `**vs <@${them}>** — ${mine.length}/${PICKS_PER_PLAYER} picked${closeUnix ? ` · picks lock <t:${closeUnix}:R>` : ''}`,
        '',
        ...(mine.length > 0 ? mine.map(describePick) : ['_No picks yet._']),
        '',
        `<@${them}> has submitted ${theirCount}/${PICKS_PER_PLAYER}. You can't see their picks, and they can't see yours.`,
        'Picks are final once locked.',
    ];

    const rows: unknown[] = [];
    if (!closed && mine.length < PICKS_PER_PLAYER && sports.length > 0) {
        // "Any sport" first, because the common question is "what's even on right now" -
        // opening a dozen leagues one at a time to find out is what made the empty-menu
        // problem feel worse than it was. Suppressed for a single-sport guild, where it
        // would just duplicate the one league row under it.
        const options = [
            ...(sports.length > 1
                ? [{ label: 'Any sport — soonest first', value: ANY_SPORT, description: `The soonest games across all ${sports.length} of this server's sports` }]
                : []),
            ...sports.map((s) => ({ label: s, value: s })),
        ].slice(0, MAX_SELECT_OPTIONS);
        const held = options.find((o) => o.value === heldSport);
        rows.push({
            type: ACTION_ROW,
            components: [{
                type: STRING_SELECT,
                custom_id: `pv:sport:${battle.id}`,
                placeholder: `Pick ${mine.length + 1} of ${PICKS_PER_PLAYER} — choose a sport`,
                options: options.map((o) => ({ ...o, default: o.value === held?.value })),
            }],
        });
        if (held) {
            rows.push(buttonRow([
                { label: `Search ${held.label}`.slice(0, 80), customId: `pv:srch:${battle.id}:${held.value}`, style: STYLE_PRIMARY },
            ]));
        }
    } else if (closed) {
        lines.push('', 'The pick window has closed — this battle scores whatever was submitted.');
    }
    rows.push(buttonRow([{ label: 'Back to my battles', customId: 'pv:hub' }]));
    return updateScreen(lines.join('\n'), rows);
}

// Per-sport slate cache. /pvp is the first surface where a MEMBER (not an admin) can
// trigger a Gamma fetch, both players in a battle usually search the same league
// minutes apart, and "any sport" mode hits every enabled league at once - so this pays
// for itself immediately. Keyed by sport AND window so a future second window can't
// silently serve the wrong slate. Lives for the isolate's lifetime only; a
// stale-by-minutes slate is harmless because every pick re-fetches its own market at
// lock time anyway.
const SLATE_TTL_MS = 5 * 60 * 1000;
const slateCache = new Map<string, { at: number; games: Awaited<ReturnType<typeof fetchLiveGames>> }>();

async function fetchSlate(sport: string): Promise<Awaited<ReturnType<typeof fetchLiveGames>>> {
    const key = `${sport}:${SEARCH_WINDOW_HOURS}`;
    const hit = slateCache.get(key);
    if (hit && Date.now() - hit.at < SLATE_TTL_MS) return hit.games;
    // soonestFirst: ONE kickoff-ordered page per tag instead of paging the whole tag.
    // Interactive searches run inside a single Worker invocation against the Free
    // plan's 50-subrequest ceiling, and "any sport" fans this out across every enabled
    // league - see polymarket.ts#fetchSoonEventsForTag for why one page is sufficient.
    const games = await fetchLiveGames([sport], SEARCH_WINDOW_HOURS, { soonestFirst: true });
    slateCache.set(key, { at: Date.now(), games });
    return games;
}

/**
 * The market menu, and - once a row is chosen - that market's two side buttons inlined
 * underneath it. Choosing from the dropdown re-renders THIS screen with the choice
 * marked rather than navigating to a separate confirm, so a select touch never moves
 * you and the pick still costs the same number of presses it always did.
 *
 * `selectedValue` is the option value (`<marketId>|<league>`) the user just picked.
 */
async function searchScreen(
    context: RequestContext, battle: BattleRow, me: string, sport: string, selectedValue?: string
): Promise<DeferredMessageData> {
    const data = sport === ANY_SPORT
        ? await searchAnyData(context, battle, me)
        : await searchData(context, battle, me, sport);
    if (!selectedValue) return data;

    // Mark the chosen row so the widget reflects it - without this Discord snaps the
    // menu back to its placeholder and it reads as though nothing registered.
    const rows = (data.components ?? []).map((row: any) => {
        const select = row?.components?.[0];
        if (select?.type !== STRING_SELECT) return row;
        return {
            ...row,
            components: [{ ...select, options: (select.options ?? []).map((o: any) => ({ ...o, default: o.value === selectedValue })) }],
        };
    });

    const bar = selectedValue.indexOf('|');
    const marketId = bar === -1 ? selectedValue : selectedValue.slice(0, bar);
    const marketSport = bar === -1 ? sport : selectedValue.slice(bar + 1);
    const market = await fetchMarket(marketId);
    const parsed = parseMarketOutcomes(market);
    const split = parsed ? computePointsSplit(parsed.outcomePrices) : null;
    if (!parsed || !split) {
        return { ...data, components: rows, content: data.content, embeds: [brandEmbed({ kind: 'settlement', plate: 'PVP', body: `${vs(battle, me)} — those odds aren't usable for scoring right now, pick another.` })] };
    }

    const body = [
        vs(battle, me),
        '',
        `**${parsed.question}**`,
        `${parsed.outcomes[0]} → **${split.sideAPoints} pts** · ${parsed.outcomes[1]} → **${split.sideBPoints} pts**`,
        '',
        "Longer odds pay more. Pick your side below - that locks the points and can't be changed.",
    ].join('\n');

    return screenData(body, [
        ...rows.filter((r: any) => r?.components?.[0]?.type === STRING_SELECT),
        buttonRow([
            { label: `${parsed.outcomes[0]} (${split.sideAPoints} pts)`, customId: lockId(battle.id, 0, marketSport, marketId), style: STYLE_PRIMARY },
            { label: `${parsed.outcomes[1]} (${split.sideBPoints} pts)`, customId: lockId(battle.id, 1, marketSport, marketId), style: STYLE_PRIMARY },
        ]),
        buttonRow([{ label: 'Back', customId: `pv:back:${battle.id}` }]),
    ]);
}

async function searchData(context: RequestContext, battle: BattleRow, me: string, sport: string): Promise<DeferredMessageData> {
    const sql = getSql(context.env);
    const usedRows = (await sql`
        SELECT source_market_id FROM pvp_battle_picks WHERE battle_id = ${battle.id} AND discord_user_id = ${me}
    `) as unknown as { source_market_id: string }[];
    const used = new Set(usedRows.map((r) => r.source_market_id));

    let games;
    try {
        games = await fetchSlate(sport);
    } catch (err) {
        console.error('[pvp] fetchLiveGames failed:', err);
        return screenData(`${vs(battle, me)} — could not reach Polymarket right now, try again shortly.`, [buttonRow([{ label: 'Back', customId: `pv:back:${battle.id}` }])]);
    }

    const now = Date.now();
    const upcoming = games
        .filter((g) => {
            const t = new Date(g.kickoff).getTime();
            return !Number.isNaN(t) && t > now;
        })
        .sort((a, b) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime());

    const options: MarketOption[] = [];
    // Polymarket sometimes lists one fixture as several events, which would otherwise
    // repeat a matchup down the menu - same de-dupe the any-sport mode does.
    const seenMatchups = new Set<string>();
    outer: for (const game of upcoming) {
        const matchup = `${game.away}|${game.home}|${game.kickoff}`;
        if (seenMatchups.has(matchup)) continue;
        seenMatchups.add(matchup);
        // At most a moneyline, a spread and a total per matchup, so a menu spans several
        // games instead of every rung of one - see market-menu.ts#pickGameLines.
        for (const prop of pickGameLines(game, (id) => used.has(id))) {
            const option = buildMarketOption(game, prop, { valueSuffix: sport });
            if (!option) continue;
            options.push(option);
            if (options.length >= MAX_SELECT_OPTIONS) break outer;
        }
    }

    if (options.length === 0) {
        return screenData(
            `${vs(battle, me)}\n\nNo two-sided ${sport} markets kicking off in the next ${SEARCH_WINDOW_HOURS}h${used.size > 0 ? " that you haven't already picked" : ''}. Try another sport, or "Any sport" to see what's on.`,
            [buttonRow([{ label: 'Back', customId: `pv:back:${battle.id}` }])]
        );
    }

    return screenData(`${vs(battle, me)}\n\n${sport} — games starting in the next ${SEARCH_WINDOW_HOURS} hours. Pick one:`, [
        { type: ACTION_ROW, components: [{ type: STRING_SELECT, custom_id: `pv:mkt:${battle.id}:${sport}`, placeholder: 'Choose a market', options }] },
        buttonRow([{ label: 'Back', customId: `pv:back:${battle.id}` }]),
    ]);
}

type SlateGame = Awaited<ReturnType<typeof fetchLiveGames>>[number];

// "Any sport" - the soonest games across every league this guild has enabled, one row
// per GAME rather than per market. Walking props the way the per-league search does
// would let a single soccer match with a dozen two-sided markets eat half the menu, and
// "soonest first" would degenerate into "one game, twelve ways".
//
// Cost: one Gamma request per league (fetchSlate's soonestFirst path) - ~12 for a
// fully-enabled guild, plus three Neon queries and one Discord PATCH. That fits the
// Free plan's 50-subrequest ceiling with room, and the 5-minute slate cache makes the
// second search in a battle nearly free.
async function searchAnyData(context: RequestContext, battle: BattleRow, me: string): Promise<DeferredMessageData> {
    const sql = getSql(context.env);
    const [usedRows, cfgRows] = await Promise.all([
        sql`SELECT source_market_id FROM pvp_battle_picks WHERE battle_id = ${battle.id} AND discord_user_id = ${me}` as unknown as Promise<{ source_market_id: string }[]>,
        sql`SELECT disabled_sports FROM discord_guild_configs WHERE guild_id = ${battle.guild_id}`,
    ]);
    const used = new Set(usedRows.map((r) => r.source_market_id));
    const rawDisabled = (cfgRows[0] as any)?.disabled_sports;
    const disabled: string[] = Array.isArray(rawDisabled) ? rawDisabled : JSON.parse(rawDisabled ?? '[]');
    const sports = SUPPORTED_SPORTS.filter((s) => !disabled.includes(s));

    const now = Date.now();
    const entries: { game: SlateGame; sport: string; kickoff: number }[] = [];
    let failed = 0;
    for (const sport of sports) {
        try {
            for (const game of await fetchSlate(sport)) {
                const t = new Date(game.kickoff).getTime();
                if (!Number.isNaN(t) && t > now) entries.push({ game, sport, kickoff: t });
            }
        } catch (err) {
            // One dead league must not empty the whole menu.
            console.error(`[pvp] any-sport slate failed for ${sport}:`, err);
            failed++;
        }
    }
    if (sports.length > 0 && failed === sports.length) {
        return screenData(`${vs(battle, me)} — could not reach Polymarket right now, try again shortly.`, [buttonRow([{ label: 'Back', customId: `pv:back:${battle.id}` }])]);
    }

    entries.sort((a, b) => a.kickoff - b.kickoff);

    const options: MarketOption[] = [];
    // Two limits, both learned from real data: on 2026-09-01 a single Championship
    // evening had 25+ eligible games all kicking off at 18:45, and Gamma splits one
    // fixture across several events, so an unguarded "soonest first" rendered as the
    // same handful of matchups repeated under one league. Per-league cap keeps the
    // menu a spread; matchup de-dupe keeps a fixture from appearing twice.
    const PER_LEAGUE_CAP = 6;
    const perLeague = new Map<string, number>();
    const seenMatchups = new Set<string>();
    for (const entry of entries) {
        const taken = perLeague.get(entry.sport) ?? 0;
        if (taken >= PER_LEAGUE_CAP) continue;
        const matchup = `${entry.sport}|${entry.game.away}|${entry.game.home}|${entry.game.kickoff}`;
        if (seenMatchups.has(matchup)) continue;
        // One row per game here (not three): pickGameLines returns moneyline first, which
        // is the most legible bet in a list mixing competitions.
        const chosen = pickGameLines(entry.game, (id) => used.has(id))[0];
        if (!chosen) continue;
        const option = buildMarketOption(entry.game, chosen, { valueSuffix: entry.sport, league: entry.sport });
        if (!option) continue;
        seenMatchups.add(matchup);
        perLeague.set(entry.sport, taken + 1);
        options.push(option);
        if (options.length >= MAX_SELECT_OPTIONS) break;
    }

    if (options.length === 0) {
        return screenData(
            `${vs(battle, me)}\n\nNothing two-sided kicking off in the next ${SEARCH_WINDOW_HOURS}h across this server's sports. Check back later, or ask an admin to turn more sports on.`,
            [buttonRow([{ label: 'Back', customId: `pv:back:${battle.id}` }])]
        );
    }

    const searched = sports.length - failed;
    return screenData(
        `${vs(battle, me)}\n\nSoonest first across ${searched} league${searched === 1 ? '' : 's'} — next ${SEARCH_WINDOW_HOURS} hours. Pick one:`,
        [
            // '*' in the sport slot means "the league rides each option's value instead".
            { type: ACTION_ROW, components: [{ type: STRING_SELECT, custom_id: `pv:mkt:${battle.id}:*`, placeholder: 'Choose a market', options }] },
            buttonRow([{ label: 'Back', customId: `pv:back:${battle.id}` }]),
        ]
    );
}

// Discord rejects a custom_id over 100 chars, which would 400 the whole screen. Sport
// is a label, so drop it rather than lose the component if a pathological market id
// ever ate the budget - the pick still locks, it just records no league.
function lockId(battleId: string, side: number, sport: string, marketId: string): string {
    const withSport = `pv:lock:${battleId}:${side}:${sport}:${marketId}`;
    return withSport.length <= 100 ? withSport : `pv:lock:${battleId}:${side}:${marketId}`;
}

async function lockPick(
    context: RequestContext, sql: ReturnType<typeof getSql>, battle: BattleRow, me: string, side: number, marketId: string, sport: string
): Promise<Response> {
    if (battle.status !== 'active') return updateScreen(`${vs(battle, me)} — that battle isn't accepting picks.`);
    if (battle.picks_close_at && new Date(battle.picks_close_at).getTime() <= Date.now()) {
        return updateScreen(`${vs(battle, me)} — the pick window has closed on this battle.`);
    }

    // Re-fetch fresh: the preview odds shown a moment ago are NOT what gets stored -
    // same discipline handleCommunityPickConfirm follows.
    const market = await fetchMarket(marketId);
    const parsed = parseMarketOutcomes(market);
    if (!parsed) return updateScreen(`${vs(battle, me)} — couldn't read that market anymore, pick another.`, [buttonRow([{ label: 'Back', customId: `pv:back:${battle.id}` }])]);
    if (resolveMarket(market).status === 'resolved') {
        return updateScreen(`${vs(battle, me)} — that market has already resolved, pick another.`, [buttonRow([{ label: 'Back', customId: `pv:back:${battle.id}` }])]);
    }
    const kickoff = parseGameStartTime((market as any)?.gameStartTime);
    if (kickoff && kickoff.getTime() <= Date.now()) {
        return updateScreen(`${vs(battle, me)} — that game has already started, pick an upcoming one.`, [buttonRow([{ label: 'Back', customId: `pv:back:${battle.id}` }])]);
    }
    const split = computePointsSplit(parsed.outcomePrices);
    if (!split) return updateScreen(`${vs(battle, me)} — those odds aren't usable for scoring right now, pick another.`, [buttonRow([{ label: 'Back', customId: `pv:back:${battle.id}` }])]);

    const points = side === 0 ? split.sideAPoints : split.sideBPoints;
    // custom_ids are client-round-tripped, so the league arrives untrusted: a forged
    // over-length value would hit sport VARCHAR(20) and raise a Postgres 22001 the
    // catch below (which only handles 23505) would turn into a 500. It's a display
    // label - nothing authorizes, scores, or filters on it - so an unrecognized value
    // is simply dropped.
    const safeSport = sport && SUPPORTED_SPORTS.includes(sport) ? sport : null;
    const slotRows = await sql`
        SELECT COALESCE(MAX(slot), 0)::int AS max_slot FROM pvp_battle_picks
        WHERE battle_id = ${battle.id} AND discord_user_id = ${me}
    `;
    const slot = Number((slotRows[0] as unknown as { max_slot: number }).max_slot) + 1;
    if (slot > PICKS_PER_PLAYER) return updateScreen(`${vs(battle, me)} — you've already made all ${PICKS_PER_PLAYER} picks in this one.`, [buttonRow([{ label: 'Back', customId: `pv:back:${battle.id}` }])]);

    try {
        await sql`
            INSERT INTO pvp_battle_picks (
                battle_id, discord_user_id, slot, sport, source_market_id, question_text,
                side_a_label, side_b_label, source_outcomes, side_chosen, points_if_correct, kickoff_at
            ) VALUES (
                ${battle.id}, ${me}, ${slot}, ${safeSport}, ${marketId}, ${parsed.question},
                ${parsed.outcomes[0]}, ${parsed.outcomes[1]}, ${JSON.stringify(parsed.outcomes)}::jsonb,
                ${side}, ${points}, ${kickoff ? kickoff.toISOString() : null}
            )
        `;
    } catch (err: any) {
        if (err?.code === '23505') {
            // Two constraints can collide here and they mean different things - say
            // the true one. Neither message can leak anything about the opponent:
            // both are scoped to this caller's own rows by the constraint itself.
            const detail = String(err?.detail ?? err?.message ?? '');
            if (detail.includes('slot')) return updateScreen(`${vs(battle, me)} — that didn't land, try once more.`, [buttonRow([{ label: 'Back', customId: `pv:back:${battle.id}` }])]);
            return updateScreen(`${vs(battle, me)} — you already picked that market in this battle.`, [buttonRow([{ label: 'Back', customId: `pv:back:${battle.id}` }])]);
        }
        throw err;
    }

    return pickScreen(context, sql, battle, me);
}
