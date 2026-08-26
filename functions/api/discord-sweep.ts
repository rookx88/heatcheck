// POST /api/discord-sweep - protected, machine-to-machine only (worker-curate/'s
// daily cron fires it right after /api/notify-sweep; shares X-Curate-Secret - same
// caller, same trust domain as every other sweep endpoint in this file family).
//
// Posts each newly-published Tank to EVERY configured guild's channel as the bot (not
// a plain incoming webhook - see lib/pages-functions/discord-api.ts's
// postDiscordChannelMessage comment for why that distinction matters for the pick
// buttons to work at all), with one button per call side. discord_guild_posts is the
// per-(guild, Tank) idempotency marker - a row is inserted once, on success, and never
// touched again - so re-running this sweep never double-posts to a guild, and
// reconfiguring one guild's channel mid-cycle can't cause a duplicate for it either
// (idempotency is keyed on the Tank, not the channel).
//
// Iterates guilds-then-Tanks, so total work scales with guilds x unposted Tanks per
// run - fine at this bot's current scale (a handful of installs); revisit with
// pagination/budgeting if that grows.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../lib/pages-functions/db';
import { postDiscordChannelMessage } from '../../lib/pages-functions/discord-api';
import { deriveSidesImpliedProb, deriveTaglineFallback } from '../../tank-deck-format';
import type { PropOdds } from '../../tank-types';

const BUTTON_STYLE_PRIMARY = 1;
const BUTTON_STYLE_SECONDARY = 2;
const BUTTON_TYPE = 2;
const ACTION_ROW_TYPE = 1;
// Discord hard limits: 5 buttons per action row, 5 action rows per message.
const MAX_SIDES = 5;
// Per-guild cap per run - bounds one guild's backlog from starving the others' budget
// within a single sweep invocation.
const MAX_TANKS_PER_GUILD_PER_RUN = 10;

interface ModelOutput {
    tagline?: string;
    hook: string;
    call: { question: string; sides: string[] };
}

interface TankRow {
    id: string;
    slug: string;
    model_output: ModelOutput | string;
    game_snapshot: { prop?: { odds?: PropOdds | null } } | null;
}

interface GuildConfigRow {
    guild_id: string;
    channel_id: string;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const secret = context.request.headers.get('X-Curate-Secret');
    if (!secret || secret !== context.env.CURATE_SECRET) {
        return jsonResponse({ message: 'Unauthorized' }, { status: 401 });
    }

    // Derived from the request itself rather than hardcoded/BASE_URL: worker-curate
    // always calls this endpoint at a fixed, known URL for whichever environment is
    // currently live (auth-sessions preview today, production after promotion - see
    // worker-curate/wrangler.toml's CURATE_URL), and per-Tank content (the OG card,
    // the article page) only exists on whichever domain actually built it. Deriving
    // from the request self-corrects at promotion with no further code change.
    const baseUrl = new URL(context.request.url).origin;

    const sql = getSql(context.env);
    const guildRows = (await sql`SELECT guild_id, channel_id FROM discord_guild_configs`) as unknown as GuildConfigRow[];

    let candidates = 0;
    let posted = 0;
    const errors: string[] = [];

    for (const guild of guildRows) {
        const rows = (await sql`
            SELECT t.id, t.slug, t.model_output, t.game_snapshot
            FROM tank_pages t
            WHERE t.status = 'published' AND t.visibility = 'app' AND t.published_at IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1 FROM discord_guild_posts dgp
                  WHERE dgp.guild_id = ${guild.guild_id} AND dgp.tank_page_id = t.id
              )
            ORDER BY t.published_at ASC
            LIMIT ${MAX_TANKS_PER_GUILD_PER_RUN}
        `) as unknown as TankRow[];
        candidates += rows.length;

        for (const rawRow of rows) {
            const modelOutput: ModelOutput | null = typeof rawRow.model_output === 'string'
                ? JSON.parse(rawRow.model_output)
                : rawRow.model_output;
            const sides = modelOutput?.call?.sides ?? [];
            if (!rawRow.slug || !modelOutput || sides.length === 0 || sides.length > MAX_SIDES) {
                // A Tank with no sides (or more than Discord's 5-button-per-row limit,
                // which nothing on this app's side ever generates) simply isn't
                // postable - skip it silently rather than fail the whole sweep.
                continue;
            }

            const odds = rawRow.game_snapshot?.prop?.odds ?? null;
            const sidesImpliedProb = deriveSidesImpliedProb(odds, sides.length);
            const tagline = modelOutput.tagline?.trim() || deriveTaglineFallback(modelOutput.hook);
            const tankUrl = `${baseUrl}/the-tank/articles/${rawRow.slug}/`;

            // Reuses the same branded OG card scripts/generate-og-image.ts already
            // renders per Tank at build time (matchup, tagline, both sides, odds,
            // resolve date, real logo, brand navy/gold/teal) - Discord's big embed
            // image slot, not a second design built from scratch. If a Tank was
            // published without a site rebuild since (so the PNG doesn't exist yet),
            // Discord just renders the embed without an image rather than failing.
            const embed = {
                author: { name: 'The Tank', icon_url: `${baseUrl}/assets/images/heatchecks-logo.png` },
                title: tagline,
                url: tankUrl,
                description: modelOutput.call.question,
                image: { url: `${baseUrl}/assets/og/${rawRow.slug}.png` },
                color: 0xffc72c,
                footer: {
                    text: `Connect your account at ${baseUrl.replace(/^https?:\/\//, '')}/account to make your pick count`,
                    icon_url: `${baseUrl}/assets/images/mudpuppy-default.png`,
                },
            };

            const buttons = sides.map((side, i) => ({
                type: BUTTON_TYPE,
                style: i === 0 ? BUTTON_STYLE_PRIMARY : BUTTON_STYLE_SECONDARY,
                // Discord button labels cap at 80 chars; a real prop side (a team
                // name, a yes/no, an over/under line) never approaches that, so no
                // truncation logic.
                label: sidesImpliedProb ? `${side} (${(sidesImpliedProb[i] * 100).toFixed(0)}%)` : side,
                custom_id: `pick:${rawRow.slug}:${i}`,
            }));

            try {
                const messageId = await postDiscordChannelMessage(context.env, guild.channel_id, {
                    embeds: [embed],
                    components: [{ type: ACTION_ROW_TYPE, components: buttons }],
                });
                await sql`
                    INSERT INTO discord_guild_posts (guild_id, tank_page_id, message_id)
                    VALUES (${guild.guild_id}, ${rawRow.id}, ${messageId})
                    ON CONFLICT (guild_id, tank_page_id) DO NOTHING
                `;
                posted++;
            } catch (err: any) {
                // Most commonly: the bot was removed from this guild since it was
                // configured (posting now 403s). Left for a human to notice/reconfig
                // rather than auto-deleting the guild's config row - this bot has no
                // gateway connection to react to a GUILD_DELETE event in real time,
                // so lazy failure-on-post is the honest signal here, not a listener.
                console.error(`[POST /api/discord-sweep] Failed to post Tank ${rawRow.slug} to guild ${guild.guild_id}:`, err);
                errors.push(`${guild.guild_id}:${rawRow.slug}`);
            }
        }
    }

    return jsonResponse({ guilds: guildRows.length, candidates, posted, errors });
};
