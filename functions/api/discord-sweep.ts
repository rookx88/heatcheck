// POST /api/discord-sweep - protected, machine-to-machine only (worker-curate/'s
// daily cron fires it right after /api/notify-sweep; shares X-Curate-Secret - same
// caller, same trust domain as every other sweep endpoint in this file family).
//
// Posts each newly-published Tank to EVERY configured guild's channel as the bot
// (not a plain incoming webhook - see lib/pages-functions/discord-api.ts's
// postDiscordChannelMessage comment for why that distinction matters for the pick
// buttons to work at all), respecting each guild's sport filter
// (discord_guild_configs.disabled_sports, set via /heatchecks-config). Card rendering
// is shared with the on-demand "/heatchecks-post tank" command via
// lib/pages-functions/discord-tank-card.ts - not a parallel rendering path.
//
// discord_guild_posts is the per-(guild, Tank) idempotency marker - a row is
// inserted once, on success, and never touched again by this sweep (the on-demand
// command CAN update it for an explicit re-post - see interactions.ts) - so
// re-running this sweep never double-posts to a guild, and reconfiguring one guild's
// channel mid-cycle can't cause a duplicate for it either (idempotency is keyed on
// the Tank, not the channel).
//
// Iterates guilds-then-Tanks, so total work scales with guilds x unposted Tanks per
// run - fine at this bot's current scale (a handful of installs); revisit with
// pagination/budgeting if that grows.
//
// ARTICLE-LIVE GATE (2026-08-27): a Tank is 'published' the moment its DB row flips,
// but its article page is a build-time static file that only exists on this deployment
// after the next Cloudflare build (publish in the admin UI -> deploy hook / git push
// -> build). Posting off DB state alone can therefore hand Discord a 404 link. Before
// posting, the sweep probes the article URL on its own origin and skips any Tank whose
// page isn't live yet - no discord_guild_posts row is written, so the Tank is retried
// naturally on the next sweep slot once the page deploys. One probe per distinct Tank
// per run (cached across guilds); a probe failure counts as not-live, never post on
// uncertainty. The on-demand /heatchecks-post admin command is deliberately ungated -
// explicit human action, latency-sensitive interaction flow.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../lib/pages-functions/db';
import { postDiscordChannelMessage } from '../../lib/pages-functions/discord-api';
import { buildTankCardMessage, type TankCardModelOutput } from '../../lib/pages-functions/discord-tank-card';
import type { PropOdds } from '../../tank-types';

// Per-guild cap per run - bounds one guild's backlog from starving the others' budget
// within a single sweep invocation.
const MAX_TANKS_PER_GUILD_PER_RUN = 10;

interface TankRow {
    id: string;
    slug: string;
    league: string;
    model_output: TankCardModelOutput | string;
    game_snapshot: { prop?: { odds?: PropOdds | null } } | null;
}

interface GuildConfigRow {
    guild_id: string;
    channel_id: string;
    disabled_sports: string[] | string;
    tank_posts_enabled: boolean;
    daily_post_limit: number | null;
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

    // See the ARTICLE-LIVE GATE header comment. Cached per slug for this run so a Tank
    // checked for one guild isn't re-probed for the next - keeps the added subrequest
    // cost to one per distinct unposted Tank.
    const articleLiveBySlug = new Map<string, boolean>();
    async function articleIsLive(slug: string): Promise<boolean> {
        const cached = articleLiveBySlug.get(slug);
        if (cached !== undefined) return cached;
        let live = false;
        try {
            const res = await fetch(`${baseUrl}/the-tank/articles/${slug}/`, { method: 'HEAD' });
            live = res.ok;
        } catch {
            live = false;
        }
        articleLiveBySlug.set(slug, live);
        return live;
    }

    const sql = getSql(context.env);
    const guildRows = (await sql`
        SELECT guild_id, channel_id, disabled_sports, tank_posts_enabled, daily_post_limit FROM discord_guild_configs
    `) as unknown as GuildConfigRow[];

    let candidates = 0;
    let posted = 0;
    let skippedByFilter = 0;
    let skippedNotLive = 0;
    const errors: string[] = [];

    for (const guild of guildRows) {
        // Wizard setting: this guild opted out of Tank posts entirely.
        if (guild.tank_posts_enabled === false) continue;

        const disabledSports: string[] = Array.isArray(guild.disabled_sports)
            ? guild.disabled_sports
            : (typeof guild.disabled_sports === 'string' ? JSON.parse(guild.disabled_sports) : []);

        // Wizard cadence setting: a per-UTC-day cap across all three daily sweep
        // slots. NULL = unlimited (original behavior). Capped guilds get the NEWEST
        // unposted Tanks first - if only 1 posts today, it should be today's, not the
        // oldest backlog item.
        let dailyBudget = Number.POSITIVE_INFINITY;
        if (guild.daily_post_limit != null) {
            const countRows = await sql`
                SELECT COUNT(*)::int AS n FROM discord_guild_posts
                WHERE guild_id = ${guild.guild_id} AND posted_at >= CURRENT_DATE
            `;
            dailyBudget = Math.max(0, guild.daily_post_limit - Number((countRows[0] as any).n));
            if (dailyBudget === 0) continue;
        }

        const rows = (await (guild.daily_post_limit != null
            ? sql`
                SELECT t.id, t.slug, t.league, t.model_output, t.game_snapshot
                FROM tank_pages t
                WHERE t.status = 'published' AND t.visibility = 'app' AND t.published_at IS NOT NULL
                  AND NOT EXISTS (
                      SELECT 1 FROM discord_guild_posts dgp
                      WHERE dgp.guild_id = ${guild.guild_id} AND dgp.tank_page_id = t.id
                  )
                ORDER BY t.published_at DESC
                LIMIT ${MAX_TANKS_PER_GUILD_PER_RUN}
            `
            : sql`
                SELECT t.id, t.slug, t.league, t.model_output, t.game_snapshot
                FROM tank_pages t
                WHERE t.status = 'published' AND t.visibility = 'app' AND t.published_at IS NOT NULL
                  AND NOT EXISTS (
                      SELECT 1 FROM discord_guild_posts dgp
                      WHERE dgp.guild_id = ${guild.guild_id} AND dgp.tank_page_id = t.id
                  )
                ORDER BY t.published_at ASC
                LIMIT ${MAX_TANKS_PER_GUILD_PER_RUN}
            `)) as unknown as TankRow[];
        candidates += rows.length;

        let postedThisGuild = 0;
        for (const rawRow of rows) {
            if (postedThisGuild >= dailyBudget) break;
            if (disabledSports.includes(rawRow.league)) {
                skippedByFilter++;
                continue;
            }

            // Article-live gate: skip (and retry next run) until the static page this
            // card would link to actually exists on this deployment.
            if (!(await articleIsLive(rawRow.slug))) {
                skippedNotLive++;
                continue;
            }

            const modelOutput: TankCardModelOutput | null = typeof rawRow.model_output === 'string'
                ? JSON.parse(rawRow.model_output)
                : rawRow.model_output;
            if (!modelOutput) continue;

            const message = buildTankCardMessage(baseUrl, {
                slug: rawRow.slug,
                modelOutput,
                gameSnapshot: rawRow.game_snapshot,
            });
            if (!message) continue; // unpostable (no sides / too many sides) - skip silently, not a sweep failure

            try {
                const messageId = await postDiscordChannelMessage(context.env, guild.channel_id, message);
                await sql`
                    INSERT INTO discord_guild_posts (guild_id, tank_page_id, message_id)
                    VALUES (${guild.guild_id}, ${rawRow.id}, ${messageId})
                    ON CONFLICT (guild_id, tank_page_id) DO NOTHING
                `;
                posted++;
                postedThisGuild++;
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

    return jsonResponse({ guilds: guildRows.length, candidates, posted, skippedByFilter, skippedNotLive, errors });
};
