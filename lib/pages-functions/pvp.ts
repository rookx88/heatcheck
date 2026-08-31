// /pvp - head-to-head 3-pick battles between two members of one guild. The command
// and every component screen live here; the tables are in create_pvp_tables.sql and
// settlement is functions/api/pvp-settlement-sweep.ts.
//
// The shape: /pvp user:@X creates a pending battle and posts ONE public line pinging
// only the opponent. Everything after that is ephemeral - accepting, searching,
// picking, and each player's own selections - until the battle settles and the recap
// posts. Each player picks up to 3 props on games kicking off in the next 24h;
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
import { postDiscordChannelMessage } from './discord-api';
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
// How far ahead a pickable game may kick off. The admin Community Pick search uses
// fetchLiveGames' 168h default; PvP is deliberately a "today" game.
const SEARCH_WINDOW_HOURS = 24;
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
    const cfgRows = await sql`SELECT channel_id, pvp_enabled FROM discord_guild_configs WHERE guild_id = ${guildId}`;
    if (cfgRows.length === 0) return ephemeral('This server has no channel configured — an admin needs to run `/heatchecks setup` first.');
    const cfg = cfgRows[0] as unknown as { channel_id: string; pvp_enabled: boolean };
    if (!cfg.pvp_enabled) return ephemeral('PvP is turned off in this server.');

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
            VALUES (${guildId}, ${cfg.channel_id}, ${me}, ${targetId})
            RETURNING id
        `;
        battleId = (rows[0] as unknown as { id: string }).id;
    } catch (err: any) {
        // The partial unique index is the real guard; the pre-check above just gets a
        // friendlier message in the common case.
        if (err?.code === '23505') return ephemeral('You already have a battle going with them — run `/pvp` to see it.');
        throw err;
    }

    const challengerName = interaction.member?.nick || interaction.member?.user?.global_name || interaction.member?.user?.username || 'Someone';
    try {
        const messageId = await postDiscordChannelMessage(context.env, cfg.channel_id, buildPvpChallengeMessage(challengerName, targetId));
        await sql`UPDATE pvp_battles SET challenge_message_id = ${messageId} WHERE id = ${battleId}`;
    } catch (err) {
        console.error('[pvp] Challenge ping failed:', err);
        return screen(`Challenge sent to <@${targetId}> — but I couldn't post the notice in <#${cfg.channel_id}>, so tell them to run \`/pvp\`. They have 24h to accept.`);
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
        for (const b of outgoing.slice(0, 3)) {
            const exp = unixOf(b.expires_at);
            lines.push(`• <@${b.opponent_id}> hasn't answered${exp ? ` — expires <t:${exp}:R>` : ''}`);
        }
    }

    if (battles.length === 0) {
        lines.push('', 'No battles going. Challenge someone with `/pvp user:@them` — you each pick 3 props on games starting in the next 24h, and the higher score wins.');
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

        case 'pick':
        case 'back':
            if (battle.challenger_id !== me && battle.opponent_id !== me) return updateScreen("That battle isn't yours.");
            return pickScreen(context, sql, battle, me);

        case 'sport': {
            if (battle.challenger_id !== me && battle.opponent_id !== me) return updateScreen("That battle isn't yours.");
            const sport: string | undefined = interaction.data?.values?.[0];
            if (!sport) return updateScreen("Couldn't read that sport.");
            return deferredUpdate(context, interaction, searchData(context, battle, me, sport));
        }

        case 'mkt': {
            if (battle.challenger_id !== me && battle.opponent_id !== me) return updateScreen("That battle isn't yours.");
            const sport = parts[3] ?? '';
            const marketId: string | undefined = interaction.data?.values?.[0];
            if (!marketId) return updateScreen("Couldn't read that market.");
            return sideScreen(battle, sport, marketId);
        }

        case 'lock': {
            if (battle.challenger_id !== me && battle.opponent_id !== me) return updateScreen("That battle isn't yours.");
            const side = Number(parts[3]);
            // The market id is the TAIL, so a value that ever contained a colon can't
            // shift the side index out from under us.
            const marketId = parts.slice(4).join(':');
            if ((side !== 0 && side !== 1) || !marketId) return updateScreen("Couldn't read that pick.");
            return lockPick(context, sql, battle, me, side, marketId);
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
        rows.push({
            type: ACTION_ROW,
            components: [{
                type: STRING_SELECT,
                custom_id: `pv:sport:${battle.id}`,
                placeholder: `Pick ${mine.length + 1} of ${PICKS_PER_PLAYER} — choose a sport`,
                options: sports.map((s) => ({ label: s, value: s })),
            }],
        });
    } else if (closed) {
        lines.push('', 'The pick window has closed — this battle scores whatever was submitted.');
    }
    rows.push(buttonRow([{ label: 'Back to /pvp', customId: 'pv:hub' }]));
    return updateScreen(lines.join('\n'), rows);
}

// Per-sport cache for the 24h slate. /pvp is the first surface where a MEMBER (not an
// admin) can trigger fetchLiveGames, which paginates every Gamma tag for a league -
// and both players in a battle usually search the same league minutes apart. Lives for
// the isolate's lifetime only; a stale-by-minutes slate is harmless because every pick
// re-fetches its own market at lock time anyway.
const SLATE_TTL_MS = 5 * 60 * 1000;
const slateCache = new Map<string, { at: number; games: Awaited<ReturnType<typeof fetchLiveGames>> }>();

async function fetchSlate(sport: string): Promise<Awaited<ReturnType<typeof fetchLiveGames>>> {
    const hit = slateCache.get(sport);
    if (hit && Date.now() - hit.at < SLATE_TTL_MS) return hit.games;
    const games = await fetchLiveGames([sport], SEARCH_WINDOW_HOURS);
    slateCache.set(sport, { at: Date.now(), games });
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

    const options: { label: string; value: string; description: string }[] = [];
    outer: for (const game of upcoming) {
        for (const prop of game.props) {
            if (!prop.odds || prop.odds.outcomes.length !== 2) continue;
            if (used.has(prop.id)) continue;
            const marketLabel = describeMarket(prop.market, prop.line);
            const isPlayerProp = prop.player && !prop.player.includes(' vs') && prop.player !== game.away && prop.player !== game.home;
            const bet = isPlayerProp ? `${prop.player} ${marketLabel}` : marketLabel;
            const [pA, pB] = prop.odds.outcomePrices;
            const oddsPart = Number.isFinite(pA) && Number.isFinite(pB)
                ? `${prop.odds.outcomes[0]} ${Math.round(pA * 100)}% / ${prop.odds.outcomes[1]} ${Math.round(pB * 100)}%`
                : '';
            options.push({
                label: `${game.away} @ ${game.home} · ${bet}`.slice(0, 100),
                value: prop.id,
                description: [formatKickoff(game.kickoff), oddsPart].filter(Boolean).join(' · ').slice(0, 100),
            });
            if (options.length >= MAX_SELECT_OPTIONS) break outer;
        }
    }

    if (options.length === 0) {
        return screenData(
            `No two-sided ${sport} markets kicking off in the next ${SEARCH_WINDOW_HOURS}h${used.size > 0 ? " that you haven't already picked" : ''}. Try another sport.`,
            [buttonRow([{ label: 'Back', customId: `pv:back:${battle.id}` }])]
        );
    }

    return screenData(`${sport} — games starting in the next ${SEARCH_WINDOW_HOURS} hours. Pick one:`, [
        { type: ACTION_ROW, components: [{ type: STRING_SELECT, custom_id: `pv:mkt:${battle.id}:${sport}`, placeholder: 'Choose a market', options }] },
        buttonRow([{ label: 'Back', customId: `pv:back:${battle.id}` }]),
    ]);
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
            { label: `${parsed.outcomes[0]} (${split.sideAPoints} pts)`, customId: `pv:lock:${battle.id}:0:${marketId}`, style: STYLE_PRIMARY },
            { label: `${parsed.outcomes[1]} (${split.sideBPoints} pts)`, customId: `pv:lock:${battle.id}:1:${marketId}`, style: STYLE_PRIMARY },
        ]),
        buttonRow([{ label: 'Back', customId: `pv:back:${battle.id}` }]),
    ]);
}

async function lockPick(
    context: RequestContext, sql: ReturnType<typeof getSql>, battle: BattleRow, me: string, side: number, marketId: string
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
                ${battle.id}, ${me}, ${slot}, ${null}, ${marketId}, ${parsed.question},
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
