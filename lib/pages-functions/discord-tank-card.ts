// Builds the Discord message body (embed + pick buttons) for a real Tank - the one
// rendering path shared by the daily sweep (functions/api/discord-sweep.ts) and the
// on-demand admin push (functions/api/discord/interactions.ts's "/heatchecks post
// tank" branch), so the two can never drift into rendering the same Tank two
// different ways. Pure - no I/O, no DB access; callers own fetching the row and
// posting the result via lib/pages-functions/discord-api.ts#postDiscordChannelMessage.

import { deriveSidesImpliedProb, deriveTaglineFallback } from '../../tank-deck-format';
import type { PropOdds } from '../../tank-types';

const BUTTON_STYLE_PRIMARY = 1;
const BUTTON_STYLE_SECONDARY = 2;
const BUTTON_TYPE = 2;
const ACTION_ROW_TYPE = 1;
// Discord hard limits: 5 buttons per action row, 5 action rows per message.
export const MAX_TANK_CARD_SIDES = 5;

export interface TankCardModelOutput {
    tagline?: string;
    hook: string;
    call: { question: string; sides: string[] };
}

export interface TankCardRow {
    slug: string;
    modelOutput: TankCardModelOutput;
    gameSnapshot: { prop?: { odds?: PropOdds | null } } | null;
}

export interface DiscordMessageBody {
    embeds: unknown[];
    components: unknown[];
}

// Returns null when the Tank isn't postable (no sides, or more than Discord's
// 5-button-per-row limit, which nothing on this app's side ever generates) - callers
// skip it rather than posting a broken card.
export function buildTankCardMessage(baseUrl: string, row: TankCardRow): DiscordMessageBody | null {
    const sides = row.modelOutput.call.sides;
    if (!row.slug || sides.length === 0 || sides.length > MAX_TANK_CARD_SIDES) return null;

    const odds = row.gameSnapshot?.prop?.odds ?? null;
    const sidesImpliedProb = deriveSidesImpliedProb(odds, sides.length);
    const tagline = row.modelOutput.tagline?.trim() || deriveTaglineFallback(row.modelOutput.hook);
    const tankUrl = `${baseUrl}/the-tank/articles/${row.slug}/`;

    // Reuses the same branded OG card scripts/generate-og-image.ts already renders per
    // Tank at build time (matchup, tagline, both sides, odds, resolve date, real logo,
    // brand navy/gold/teal) - Discord's big embed image slot, not a second design
    // built from scratch. If a Tank was published without a site rebuild since (so the
    // card doesn't exist yet), Discord just renders the embed without an image rather
    // than failing the post.
    // .jpg, not .png: the card is photographic artwork, and lossless was costing ~1MB
    // a share for a visually identical image - enough that size-capped unfurlers
    // (WhatsApp especially) dropped the preview entirely. Same reasoning that already
    // made the site-wide og-share-world-map a JPG.
    const embed = {
        author: { name: 'The Tank', icon_url: `${baseUrl}/assets/images/heatchecks-logo.png` },
        title: tagline,
        url: tankUrl,
        description: row.modelOutput.call.question,
        image: { url: `${baseUrl}/assets/og/${row.slug}.jpg` },
        color: 0xffc72c,
        footer: {
            // Leads with what a member gets for free - the old line ("connect your
            // account to make your pick count") read as a paywall on picking at all,
            // when picking here already earns Community Points with no account. The
            // link is the upsell to Ember, not the price of entry. baseUrl is the
            // deployment's own origin, so production says heatchecks.io.
            text: `Earn Community points, no account needed. Link Discord at ${baseUrl.replace(/^https?:\/\//, '')} to earn Ember!`,
            icon_url: `${baseUrl}/assets/images/mudpuppy-default.png`,
        },
    };

    const buttons = sides.map((side, i) => ({
        type: BUTTON_TYPE,
        style: i === 0 ? BUTTON_STYLE_PRIMARY : BUTTON_STYLE_SECONDARY,
        // Discord button labels cap at 80 chars; a real prop side (a team name, a
        // yes/no, an over/under line) never approaches that, so no truncation logic.
        label: sidesImpliedProb ? `${side} (${(sidesImpliedProb[i] * 100).toFixed(0)}%)` : side,
        custom_id: `pick:${row.slug}:${i}`,
    }));

    return { embeds: [embed], components: [{ type: ACTION_ROW_TYPE, components: buttons }] };
}
