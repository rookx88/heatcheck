// The two PUBLIC messages a PvP battle produces - the challenge ping and the result
// recap. Everything else about a battle (accepting, searching, picking, your own
// selections) lives on ephemeral screens in pvp.ts and never reaches a channel.
// Mirrors lib/pages-functions/discord-community-card.ts: pure builders, no I/O, so
// both the interaction path and the settlement sweep can render identical messages.
//
// Isolation reminder: this file names a winner and nothing else. Heatchecks never
// supplies, values, or distributes a prize for a PvP battle - the same posture the
// giveaway messages take.

import { brandEmbed } from './discord-brand';

export interface PvpMessageBody {
    content?: string;
    embeds?: unknown[];
    components?: unknown[];
    allowed_mentions?: unknown;
}

// Discord markdown that could be used to distort a display name inside the public
// challenge line. Names are attacker-controlled text going into a channel post, so
// they get escaped rather than trusted.
function escapeMarkdown(text: string): string {
    return text.replace(/([*_`~|\\>])/g, '\\$1').slice(0, 80);
}

/**
 * The single public line a challenge produces. `allowed_mentions` is doing real work
 * here: `parse: []` disables @everyone/@here/role expansion (a display name is being
 * interpolated into the content), and `users` limits the actual ping to the opponent
 * alone - nobody else in the channel is notified.
 */
export function buildPvpChallengeMessage(challengerName: string, opponentId: string): PvpMessageBody {
    return {
        content: `⚔ <@${opponentId}> — **${escapeMarkdown(challengerName)}** challenged you to a PvP battle. Run \`/pvp battles\` to respond.`,
        allowed_mentions: { parse: [], users: [opponentId] },
    };
}

export interface PvpResultPick {
    questionText: string;
    chosenLabel: string;
    correct: boolean;
    pointsAwarded: number;
    // A pick whose market never resolved before the 7-day backstop fired. Scored 0,
    // but labelling it "wrong" would be a lie about what happened.
    unresolved: boolean;
}

export interface PvpResultInput {
    challengerId: string;
    opponentId: string;
    challengerName: string;
    opponentName: string;
    challengerScore: number;
    opponentScore: number;
    outcome: 'challenger' | 'opponent' | 'draw';
    challengerPicks: PvpResultPick[];
    opponentPicks: PvpResultPick[];
    staleSettled: boolean;
}

function pickLines(picks: PvpResultPick[]): string {
    if (picks.length === 0) return '— no picks submitted';
    return picks
        .map((p) => {
            const label = `${p.questionText} — ${p.chosenLabel}`.slice(0, 90);
            if (p.unresolved) return `• ${label} — unresolved`;
            return p.correct ? `✓ ${label} (+${p.pointsAwarded})` : `✗ ${label}`;
        })
        .join('\n')
        .slice(0, 1024);
}

/**
 * The result recap. This is the ONLY place both players' picks appear together - it
 * is built inside the settlement sweep, which no user request can reach, which is
 * what keeps picks sealed right up to the moment the battle is over.
 */
export function buildPvpResultMessage(input: PvpResultInput): PvpMessageBody {
    const headline = input.outcome === 'draw'
        ? `⚔ <@${input.challengerId}> and <@${input.opponentId}> drew their PvP battle.`
        : `⚔ <@${input.outcome === 'challenger' ? input.challengerId : input.opponentId}> takes the PvP battle.`;

    const embed = brandEmbed({
        kind: 'settlement',
        plate: 'PVP — SETTLED',
        title: `${input.challengerName} ${input.challengerScore} — ${input.opponentScore} ${input.opponentName}`,
        body: input.staleSettled
            ? 'Some markets never resolved and were scored 0 so the battle could close.'
            : undefined,
        fields: [
            { name: `${input.challengerName} — ${input.challengerScore}`.slice(0, 256), value: pickLines(input.challengerPicks), inline: true },
            { name: `${input.opponentName} — ${input.opponentScore}`.slice(0, 256), value: pickLines(input.opponentPicks), inline: true },
        ],
        footer: 'trust',
    });

    return {
        content: headline,
        embeds: [embed],
        // Both players get pinged on the result (they played), nothing else expands.
        allowed_mentions: { parse: [], users: [input.challengerId, input.opponentId] },
    };
}
