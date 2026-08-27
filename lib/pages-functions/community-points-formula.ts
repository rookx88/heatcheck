// Underdog-weighted Community Points formula - shared by every place that awards
// them: admin-created Community Picks (lib/pages-functions/discord-commands.ts),
// the weekly NFL auto-slate (functions/api/league-slate-sweep.ts), and real Tank
// settlement (functions/api/discord-settlement-sweep.ts). One implementation so the
// three call sites can't quietly drift on the math. Never used for Ember - Ember has
// its own separate, capped formula in lib/pages-functions/ledger.ts#correctCallPayout.

export function pointsForProbability(prob: number): number | null {
    if (!Number.isFinite(prob) || prob <= 0 || prob > 1) return null;
    return Math.round(100 * prob);
}

export function computePointsSplit(outcomePrices: number[]): { sideAPoints: number; sideBPoints: number } | null {
    if (outcomePrices.length !== 2) return null;
    const sideAPoints = pointsForProbability(outcomePrices[1]);
    const sideBPoints = pointsForProbability(outcomePrices[0]);
    if (sideAPoints === null || sideBPoints === null) return null;
    return { sideAPoints, sideBPoints };
}
