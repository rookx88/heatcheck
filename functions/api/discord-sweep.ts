// POST /api/discord-sweep - protected, machine-to-machine only (worker-curate/'s
// daily cron fires it right after /api/notify-sweep; shares X-Curate-Secret - same
// caller, same trust domain as every other sweep endpoint in this file family).
//
// Posts each newly-published Tank to the Discord channel as the bot (not a plain
// incoming webhook - see lib/pages-functions/discord-api.ts's postDiscordChannelMessage
// comment for why that distinction matters for the pick buttons to work at all), with
// one button per call side. discord_posted_at is the idempotency marker - set once, on
// success, never touched again - so re-running this sweep never double-posts.

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
    const rows = await sql`
        SELECT id, slug, model_output, game_snapshot
        FROM tank_pages
        WHERE status = 'published' AND visibility = 'app' AND discord_posted_at IS NULL AND published_at IS NOT NULL
        ORDER BY published_at ASC
        LIMIT 10
    `;

    let posted = 0;
    const errors: string[] = [];

    for (const rawRow of rows as unknown as TankRow[]) {
        const modelOutput: ModelOutput | null = typeof rawRow.model_output === 'string'
            ? JSON.parse(rawRow.model_output)
            : rawRow.model_output;
        const sides = modelOutput?.call?.sides ?? [];
        if (!rawRow.slug || !modelOutput || sides.length === 0 || sides.length > MAX_SIDES) {
            // A Tank with no sides (or more than Discord's 5-button-per-row limit,
            // which nothing on this app's side ever generates) simply isn't postable -
            // skip it silently rather than fail the whole sweep over one bad row.
            continue;
        }

        const odds = rawRow.game_snapshot?.prop?.odds ?? null;
        const sidesImpliedProb = deriveSidesImpliedProb(odds, sides.length);
        const tagline = modelOutput.tagline?.trim() || deriveTaglineFallback(modelOutput.hook);
        const tankUrl = `${baseUrl}/the-tank/articles/${rawRow.slug}/`;

        // Reuses the same branded OG card scripts/generate-og-image.ts already renders
        // per Tank at build time (matchup, tagline, both sides, odds, resolve date, real
        // logo, brand navy/gold/teal) - Discord's big embed image slot, not a second
        // design built from scratch. If a Tank was published without a site rebuild
        // since (so the PNG doesn't exist yet), Discord just renders the embed without
        // an image rather than failing the post.
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
            // Discord button labels cap at 80 chars; a real prop side (a team name, a
            // yes/no, an over/under line) never approaches that, so no truncation logic.
            label: sidesImpliedProb ? `${side} (${(sidesImpliedProb[i] * 100).toFixed(0)}%)` : side,
            custom_id: `pick:${rawRow.slug}:${i}`,
        }));

        try {
            await postDiscordChannelMessage(context.env, {
                embeds: [embed],
                components: [{ type: ACTION_ROW_TYPE, components: buttons }],
            });
            await sql`UPDATE tank_pages SET discord_posted_at = NOW() WHERE id = ${rawRow.id}`;
            posted++;
        } catch (err: any) {
            console.error(`[POST /api/discord-sweep] Failed to post Tank ${rawRow.slug}:`, err);
            errors.push(rawRow.slug);
        }
    }

    return jsonResponse({ candidates: rows.length, posted, errors });
};
