// Builds the Discord message body for a Community Pick - deliberately visually
// distinct from a real Tank card (lib/pages-functions/discord-tank-card.ts): a
// different accent color and an explicit "COMMUNITY PICK" badge in the author line,
// not just an internal flag on an identical-looking card. Community Picks are a raw
// market wrapper with no storyline/editorial content, so there's no tagline/hook/OG
// image to render here at all - title is the market question itself.

const BUTTON_STYLE_PRIMARY = 1;
const BUTTON_STYLE_SECONDARY = 2;
const BUTTON_TYPE = 2;
const ACTION_ROW_TYPE = 1;

export interface CommunityPickCardInput {
    id: string;
    questionText: string;
    sideALabel: string;
    sideBLabel: string;
    // Underdog-weighted payout, locked at creation time (see
    // lib/pages-functions/community-pick-creation.ts) - what's shown here is exactly
    // what a correct voter earns, for this pick's whole life. Displaying it on the
    // card itself (not just implied by the vote) is the point: nobody has to guess.
    sideAPoints: number;
    sideBPoints: number;
    resolveDate: string; // ISO 8601
}

export interface DiscordMessageBody {
    embeds: unknown[];
    components: unknown[];
}

export function buildCommunityPickCardMessage(input: CommunityPickCardInput): DiscordMessageBody {
    const resolveDateLabel = new Date(input.resolveDate).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
    });

    const embed = {
        author: { name: '🎲 COMMUNITY PICK' },
        title: input.questionText,
        description: `${input.sideALabel} → ${input.sideAPoints} pts  ·  ${input.sideBLabel} → ${input.sideBPoints} pts\n\nResolves ${resolveDateLabel} — vote below. No account required to vote.`,
        // Distinct purple, deliberately not the real Tank card's brand gold (0xffc72c)
        // or the settlement recap's teal (0x2fe6d9) - a glance should tell the three
        // apart.
        color: 0x9b59ff,
    };

    const buttons = [
        { type: BUTTON_TYPE, style: BUTTON_STYLE_PRIMARY, label: `${input.sideALabel} (${input.sideAPoints} pts)`, custom_id: `cpvote:${input.id}:0` },
        { type: BUTTON_TYPE, style: BUTTON_STYLE_SECONDARY, label: `${input.sideBLabel} (${input.sideBPoints} pts)`, custom_id: `cpvote:${input.id}:1` },
    ];

    return { embeds: [embed], components: [{ type: ACTION_ROW_TYPE, components: buttons }] };
}

export interface CommunitySettlementRecapInput {
    questionText: string;
    winningLabel: string | null; // null when nobody in this guild got it right
    correctCount: number;
    totalCount: number;
}

export function buildCommunitySettlementRecapMessage(input: CommunitySettlementRecapInput): DiscordMessageBody {
    const summary = input.winningLabel
        ? `**${input.winningLabel}** was right. ${input.correctCount}/${input.totalCount} of this server's voters got it.`
        : `Tough one — 0/${input.totalCount} of this server's voters got it this time.`;

    const embed = {
        author: { name: '🎲 COMMUNITY PICK — settled' },
        title: input.questionText,
        description: summary,
        color: 0x2fe6d9,
    };

    return { embeds: [embed], components: [] };
}

// Announces a giveaway draw's result - the bot's ONLY output for a draw is which
// Discord user was randomly selected. No prize-value field, no payout copy - what a
// server does with this winner is entirely outside Heatchecks.
export function buildGiveawayResultMessage(sourceLabel: string, winnerDiscordUserId: string): DiscordMessageBody {
    const embed = {
        author: { name: '🎉 Giveaway draw' },
        title: sourceLabel,
        description: `Randomly selected winner: <@${winnerDiscordUserId}>`,
        color: 0xffc72c,
    };
    return { embeds: [embed], components: [] };
}

export function buildNoEligiblePoolMessage(sourceLabel: string): DiscordMessageBody {
    const embed = {
        author: { name: '🎉 Giveaway draw' },
        title: sourceLabel,
        description: 'No eligible participants to draw from in this server.',
        color: 0xffc72c,
    };
    return { embeds: [embed], components: [] };
}
