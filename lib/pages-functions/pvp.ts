// /pvp - head-to-head 3-pick battles between two members of one guild. The command
// and every component screen live here; the tables are in create_pvp_tables.sql and
// settlement is functions/api/pvp-settlement-sweep.ts.
//
// The shape: /pvp user:@X creates a pending battle and posts ONE public line pinging
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
import { postDiscordChannelMessage, deleteChannelMessage } from './discord-api';
import { brandEmbed } from './discord-brand';
import { buildPvpChallengeMessage } from './pvp-card';
import { computePvpRecords, formatPvpRecord } from './pvp-record';
import { fetchMarket, resolveMarket } from './gamma';
import { computePointsSplit } from './community-points-formula';
import { fetchLiveGames } from '../../tank-gamma-live';
import {
    ephemeral,
    deferredEphemeral,
    describeMarket,
    formatKickoff,
    parseMarketOutcomes,
    parseGameStartTime,
    SUPPORTED_SPORTS,
    type DeferredMessageData,
} from './discord-commands';

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
            .then((data) => fetch(`https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/@original`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: data.content ?? '', embeds: data.embeds ?? [], components: data.components ?? [] }),
            }))
            .catch((err) => console.error('[pvp] Deferred PATCH failed:', err))
    );

    return json({ type: RESPONSE_DEFERRED_UPDATE_MESSAGE });
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

    const targetId: string | undefined = interaction.data?.options?.find((o: any) => o.name === 'user')?.value;
    if (targetId) return createChallenge(context, interaction, guildId, me, targetId);
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
    if (live.length > 0) return ephemeral('You already have a battle going with them — run `/pvp` to see it.');

    // Checked BEFORE the public post, which is the whole point of the cap.
    const outgoing = await sql`
        SELECT COUNT(*)::int AS n FROM pvp_battles
        WHERE guild_id = ${guildId} AND challenger_id = ${me} AND status = 'pending'
    `;
    if (Number((outgoing[0] as unknown as { n: number }).n) >= MAX_OPEN_OUTGOING) {
        return ephemeral(`You've got ${MAX_OPEN_OUTGOING} challenges out already — wait for one to be answered.`);
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
        if (err?.code === '23505') return ephemeral('You already have a battle going with them — run `/pvp` to see it.');
        throw err;
    }

    // A server can silence the announcement, in which case the challenge is
    // discoverable only by running /pvp - so say that plainly rather than implying
    // they'll be pinged.
    if (!cfg.pvp_announce_challenges) {
        return screen(`Challenge sent to <@${targetId}>. Challenge announcements are off in this server, so tell them to run \`/pvp\` — they have 24h to accept.`);
    }

    const challengerName = interaction.member?.nick || interaction.member?.user?.global_name || interaction.member?.user?.username || 'Someone';
    try {
        const messageId = await postDiscordChannelMessage(context.env, pvpChannelId, buildPvpChallengeMessage(challengerName, targetId));
        await sql`UPDATE pvp_battles SET challenge_message_id = ${messageId} WHERE id = ${battleId}`;
    } catch (err) {
        console.error('[pvp] Challenge ping failed:', err);
        return screen(`Challenge sent to <@${targetId}> — but I couldn't post the notice in <#${pvpChannelId}>, so tell them to run \`/pvp\`. They have 24h to accept.`);
    }

    return screen(`Challenge sent to <@${targetId}>. They have 24h to accept — you'll see it under \`/pvp\` either way.`);
}

// ===================================================================================
// The hub
// ===================================================================================

interface HubBattleRow extends BattleRow {
    created_at: string;
}

async function hubData(context: RequestContext, guildId: string, me: string): Promise<DeferredMessageData> {
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

    if (incoming.length > 0) {
        lines.push('', '**Challenges for you**');
        for (const b of incoming.slice(0, 2)) {
            const exp = unixOf(b.expires_at);
            lines.push(`• <@${b.challenger_id}> challenged you${exp ? ` — expires <t:${exp}:R>` : ''}`);
            rows.push(buttonRow([
                { label: 'Accept', customId: `pv:acc:${b.id}`, style: STYLE_SUCCESS },
                { label: 'Decline', customId: `pv:dec:${b.id}`, style: STYLE_DANGER },
            ]));
        }
        if (incoming.length > 2) lines.push(`• …and ${incoming.length - 2} more (answer these first)`);
    }

    if (active.length > 0) {
        lines.push('', '**Active battles**');
        const pickButtons: { label: string; customId: string; style?: number }[] = [];
        for (const b of active.slice(0, 3)) {
            const them = otherPlayer(b, me);
            const close = unixOf(b.picks_close_at);
            const mine = countOf(b.id, me);
            lines.push(`• vs <@${them}> — you ${mine}/${PICKS_PER_PLAYER} · them ${countOf(b.id, them)}/${PICKS_PER_PLAYER}${close ? ` · picks lock <t:${close}:R>` : ''}`);
            pickButtons.push({
                label: mine >= PICKS_PER_PLAYER ? 'View your picks' : `Make picks (${mine}/${PICKS_PER_PLAYER})`,
                customId: `pv:pick:${b.id}`,
                style: STYLE_PRIMARY,
            });
        }
        if (pickButtons.length > 0) rows.push(buttonRow(pickButtons));
        if (active.length > 3) lines.push(`• …and ${active.length - 3} more`);
    }

    if (outgoing.length > 0) {
        lines.push('', '**Waiting on them**');
        const shown = outgoing.slice(0, 3);
        // Cancel exists so a challenger isn't stuck for 24h waiting on someone who
        // isn't around - the live-pair index means an unanswered challenge also blocks
        // re-challenging that same person, so "cancel and go again" needs to be one
        // click. Numbered only when there's more than one, since button labels can't
        // render a mention.
        const cancelButtons: { label: string; customId: string; style?: number }[] = [];
        shown.forEach((b, i) => {
            const exp = unixOf(b.expires_at);
            const n = shown.length > 1 ? `${i + 1}. ` : '• ';
            lines.push(`${n}<@${b.opponent_id}> hasn't answered${exp ? ` — expires <t:${exp}:R>` : ''}`);
            cancelButtons.push({ label: shown.length > 1 ? `Cancel ${i + 1}` : 'Cancel challenge', customId: `pv:can:${b.id}`, style: STYLE_DANGER });
        });
        if (outgoing.length > 3) lines.push(`• …and ${outgoing.length - 3} more`);
        rows.push(buttonRow(cancelButtons));
    }

    if (battles.length === 0) {
        lines.push('', 'No battles going. Challenge someone with `/pvp user:@them` — you each pick 3 props on games starting in the next 72h, and the higher score wins.');
    }

    rows.push(buttonRow([{ label: 'Refresh', customId: 'pv:hub' }]));
    return screenData(lines.join('\n'), rows);
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

    const battleId = parts[2];
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
            if (cancelled.length === 0) return updateScreen('That challenge was already answered or expired — run `/pvp` to see where it stands.');
            // Take the public ping down with it, so nobody answers a dead challenge.
            const messageId = (cancelled[0] as unknown as { challenge_message_id: string | null }).challenge_message_id;
            if (messageId) context.waitUntil(deleteChannelMessage(context.env, battle.channel_id, messageId));
            return deferredUpdate(context, interaction, hubData(context, guildId, me));
        }

        case 'pick':
        case 'back':
            if (battle.challenger_id !== me && battle.opponent_id !== me) return updateScreen("That battle isn't yours.");
            return pickScreen(context, sql, battle, me);

        case 'sport': {
            if (battle.challenger_id !== me && battle.opponent_id !== me) return updateScreen("That battle isn't yours.");
            const sport: string | undefined = interaction.data?.values?.[0];
            if (!sport) return updateScreen("Couldn't read that sport.");
            return sport === ANY_SPORT
                ? deferredUpdate(context, interaction, searchAnyData(context, battle, me))
                : deferredUpdate(context, interaction, searchData(context, battle, me, sport));
        }

        case 'mkt': {
            if (battle.challenger_id !== me && battle.opponent_id !== me) return updateScreen("That battle isn't yours.");
            const value: string | undefined = interaction.data?.values?.[0];
            if (!value) return updateScreen("Couldn't read that market.");
            // value is `<marketId>|<league>`; a bare id (a menu rendered before the
            // league started riding the value) falls back to the sport in this menu's
            // own custom_id, which is exactly the old behaviour.
            const bar = value.indexOf('|');
            const marketId = bar === -1 ? value : value.slice(0, bar);
            const sport = bar === -1 ? (parts[3] ?? '') : value.slice(bar + 1);
            return sideScreen(battle, sport, marketId);
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

async function pickScreen(context: RequestContext, sql: ReturnType<typeof getSql>, battle: BattleRow, me: string): Promise<Response> {
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
        rows.push({
            type: ACTION_ROW,
            components: [{
                type: STRING_SELECT,
                custom_id: `pv:sport:${battle.id}`,
                placeholder: `Pick ${mine.length + 1} of ${PICKS_PER_PLAYER} — choose a sport`,
                options,
            }],
        });
    } else if (closed) {
        lines.push('', 'The pick window has closed — this battle scores whatever was submitted.');
    }
    rows.push(buttonRow([{ label: 'Back to /pvp', customId: 'pv:hub' }]));
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
        return screenData('Could not reach Polymarket right now — try again shortly.', [buttonRow([{ label: 'Back', customId: `pv:back:${battle.id}` }])]);
    }

    const now = Date.now();
    const upcoming = games
        .filter((g) => {
            const t = new Date(g.kickoff).getTime();
            return !Number.isNaN(t) && t > now;
        })
        .sort((a, b) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime());

    const options: SelectOption[] = [];
    outer: for (const game of upcoming) {
        for (const prop of game.props) {
            const option = buildMarketOption(game, prop, used, sport, false);
            if (!option) continue;
            options.push(option);
            if (options.length >= MAX_SELECT_OPTIONS) break outer;
        }
    }

    if (options.length === 0) {
        return screenData(
            `No two-sided ${sport} markets kicking off in the next ${SEARCH_WINDOW_HOURS}h${used.size > 0 ? " that you haven't already picked" : ''}. Try another sport, or "Any sport" to see what's on.`,
            [buttonRow([{ label: 'Back', customId: `pv:back:${battle.id}` }])]
        );
    }

    return screenData(`${sport} — games starting in the next ${SEARCH_WINDOW_HOURS} hours. Pick one:`, [
        { type: ACTION_ROW, components: [{ type: STRING_SELECT, custom_id: `pv:mkt:${battle.id}:${sport}`, placeholder: 'Choose a market', options }] },
        buttonRow([{ label: 'Back', customId: `pv:back:${battle.id}` }]),
    ]);
}

type SlateGame = Awaited<ReturnType<typeof fetchLiveGames>>[number];
type SlateProp = SlateGame['props'][number];

interface SelectOption {
    label: string;
    value: string;
    description: string;
}

// One select row for one market. `value` carries the league after a '|' so the pick row
// can record which competition it came from even in any-sport mode, where every row is
// a different league and the menu's own custom_id can't hold it. Market ids are numeric
// and no league name contains a '|', so splitting on the first one is unambiguous.
function buildMarketOption(game: SlateGame, prop: SlateProp, used: Set<string>, sport: string, showLeague: boolean): SelectOption | null {
    if (!prop.odds || prop.odds.outcomes.length !== 2) return null;
    if (used.has(prop.id)) return null;
    const marketLabel = describeMarket(prop.market, prop.line);
    const isPlayerProp = prop.player && !prop.player.includes(' vs') && prop.player !== game.away && prop.player !== game.home;
    const bet = isPlayerProp ? `${prop.player} ${marketLabel}` : marketLabel;
    const [pA, pB] = prop.odds.outcomePrices;
    const oddsPart = Number.isFinite(pA) && Number.isFinite(pB)
        ? `${prop.odds.outcomes[0]} ${Math.round(pA * 100)}% / ${prop.odds.outcomes[1]} ${Math.round(pB * 100)}%`
        : '';
    return {
        label: `${game.away} @ ${game.home} · ${bet}`.slice(0, 100),
        value: `${prop.id}|${sport}`.slice(0, 100),
        // League FIRST in any-sport mode: the 100-char clamp then eats the odds tail on
        // long team names rather than the competition name, which is the one thing a
        // mixed list has to answer.
        description: [showLeague ? sport : '', formatKickoff(game.kickoff), oddsPart].filter(Boolean).join(' · ').slice(0, 100),
    };
}

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
        return screenData('Could not reach Polymarket right now — try again shortly.', [buttonRow([{ label: 'Back', customId: `pv:back:${battle.id}` }])]);
    }

    entries.sort((a, b) => a.kickoff - b.kickoff);

    const options: SelectOption[] = [];
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
        // Moneyline where a game has one - it's the most legible bet in a mixed list -
        // otherwise the most prominent two-sided market on that game.
        const eligible = entry.game.props.filter((p) => p.odds && p.odds.outcomes.length === 2 && !used.has(p.id));
        if (eligible.length === 0) continue;
        const chosen = eligible.find((p) => p.market === 'moneyline')
            ?? eligible.reduce((best, p) => (p.prominence > best.prominence ? p : best), eligible[0]);
        const option = buildMarketOption(entry.game, chosen, used, entry.sport, true);
        if (!option) continue;
        seenMatchups.add(matchup);
        perLeague.set(entry.sport, taken + 1);
        options.push(option);
        if (options.length >= MAX_SELECT_OPTIONS) break;
    }

    if (options.length === 0) {
        return screenData(
            `Nothing two-sided kicking off in the next ${SEARCH_WINDOW_HOURS}h across this server's sports. Check back later, or ask an admin to turn more sports on.`,
            [buttonRow([{ label: 'Back', customId: `pv:back:${battle.id}` }])]
        );
    }

    const searched = sports.length - failed;
    return screenData(
        `Soonest first across ${searched} league${searched === 1 ? '' : 's'} — next ${SEARCH_WINDOW_HOURS} hours. Pick one:`,
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

async function sideScreen(battle: BattleRow, sport: string, marketId: string): Promise<Response> {
    const market = await fetchMarket(marketId);
    const parsed = parseMarketOutcomes(market);
    if (!parsed) return updateScreen("Couldn't read that market's odds — pick another.", [buttonRow([{ label: 'Back', customId: `pv:back:${battle.id}` }])]);
    const split = computePointsSplit(parsed.outcomePrices);
    if (!split) return updateScreen("That market's odds aren't usable for scoring right now — pick another.", [buttonRow([{ label: 'Back', customId: `pv:back:${battle.id}` }])]);

    const body = [
        `**${parsed.question}**`,
        '',
        `${parsed.outcomes[0]} → **${split.sideAPoints} pts** · ${parsed.outcomes[1]} → **${split.sideBPoints} pts**`,
        '',
        'Longer odds pay more. Pick your side — this locks the points and can\'t be changed.',
    ].join('\n');

    return updateScreen(body, [
        buttonRow([
            { label: `${parsed.outcomes[0]} (${split.sideAPoints} pts)`, customId: lockId(battle.id, 0, sport, marketId), style: STYLE_PRIMARY },
            { label: `${parsed.outcomes[1]} (${split.sideBPoints} pts)`, customId: lockId(battle.id, 1, sport, marketId), style: STYLE_PRIMARY },
        ]),
        buttonRow([{ label: 'Back', customId: `pv:back:${battle.id}` }]),
    ]);
}

async function lockPick(
    context: RequestContext, sql: ReturnType<typeof getSql>, battle: BattleRow, me: string, side: number, marketId: string, sport: string
): Promise<Response> {
    if (battle.status !== 'active') return updateScreen('That battle isn\'t accepting picks.');
    if (battle.picks_close_at && new Date(battle.picks_close_at).getTime() <= Date.now()) {
        return updateScreen('The pick window has closed on this battle.');
    }

    // Re-fetch fresh: the preview odds shown a moment ago are NOT what gets stored -
    // same discipline handleCommunityPickConfirm follows.
    const market = await fetchMarket(marketId);
    const parsed = parseMarketOutcomes(market);
    if (!parsed) return updateScreen("Couldn't read that market anymore — pick another.", [buttonRow([{ label: 'Back', customId: `pv:back:${battle.id}` }])]);
    if (resolveMarket(market).status === 'resolved') {
        return updateScreen('That market has already resolved — pick another.', [buttonRow([{ label: 'Back', customId: `pv:back:${battle.id}` }])]);
    }
    const kickoff = parseGameStartTime((market as any)?.gameStartTime);
    if (kickoff && kickoff.getTime() <= Date.now()) {
        return updateScreen('That game has already started — pick an upcoming one.', [buttonRow([{ label: 'Back', customId: `pv:back:${battle.id}` }])]);
    }
    const split = computePointsSplit(parsed.outcomePrices);
    if (!split) return updateScreen("That market's odds aren't usable for scoring right now — pick another.", [buttonRow([{ label: 'Back', customId: `pv:back:${battle.id}` }])]);

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
    if (slot > PICKS_PER_PLAYER) return updateScreen(`You've already made all ${PICKS_PER_PLAYER} picks.`, [buttonRow([{ label: 'Back', customId: `pv:back:${battle.id}` }])]);

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
            if (detail.includes('slot')) return updateScreen("That didn't land — try once more.", [buttonRow([{ label: 'Back', customId: `pv:back:${battle.id}` }])]);
            return updateScreen('You already picked that market in this battle.', [buttonRow([{ label: 'Back', customId: `pv:back:${battle.id}` }])]);
        }
        throw err;
    }

    return pickScreen(context, sql, battle, me);
}
