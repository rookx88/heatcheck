// Renders /leaderboard's ranked rows as stacked Discord embeds - one embed per user,
// each a colored "row" with their real Discord avatar as a thumbnail. Discord allows
// up to 10 embeds per message, which already matches every leaderboard query's own
// LIMIT 10 / LEADERBOARD_SIZE cap (functions/api/discord/interactions.ts,
// lib/pages-functions/discord-commands.ts) - nothing upstream needs to change to fit
// this. Mirrors discord-tank-card.ts / discord-community-card.ts's existing pattern
// of keeping rendering separate from command-handling logic.

// Shared return shape for all three /leaderboard builders (accuracy in
// functions/api/discord/interactions.ts; Community Points and league in
// discord-commands.ts) - defined here rather than in either builder's own file so
// neither has to import from the other. Builders return raw row data, not yet
// rendered - lib/pages-functions/leaderboard-image.ts's sendLeaderboardResult is the
// one place that decides how to actually render/deliver it (generated image, falling
// back to this file's embeds on any failure).
export interface LeaderboardMessage {
    content: string;
    rows: LeaderboardRowInput[];
}

export interface LeaderboardRowInput {
    rank: number;
    displayName: string;
    avatarUrl: string;
    // Owned entirely by the caller - "92% (11/12)" for accuracy, "142 pts" for
    // Community Points/league. This file only lays it out, never computes it.
    scoreLine: string;
}

const COLOR_GOLD = 0xffc72c; // this bot's existing brand/premium color (Tank cards, giveaway results)
const COLOR_SILVER = 0xc0c0c0;
const COLOR_BRONZE = 0xcd7f32;
const COLOR_NEUTRAL = 0x5c6470; // flat slate for 4th place and below - keeps the podium visually distinct without a 10-color gradient

// Exported so lib/pages-functions/leaderboard-image.ts's generated-PNG rows use the
// exact same tier mapping as this file's embed fallback - one source of truth, not a
// second copy that could drift.
export function colorForRank(rank: number): number {
    if (rank === 1) return COLOR_GOLD;
    if (rank === 2) return COLOR_SILVER;
    if (rank === 3) return COLOR_BRONZE;
    return COLOR_NEUTRAL;
}

export function buildLeaderboardRowEmbeds(rows: LeaderboardRowInput[]): unknown[] {
    return rows.map((row) => ({
        color: colorForRank(row.rank),
        author: { name: `#${row.rank} · ${row.displayName}` },
        description: row.scoreLine,
        thumbnail: { url: row.avatarUrl },
    }));
}
