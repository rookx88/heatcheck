// ===================================================================================
// HEATCHECKS TANK — SHARED DECK-HEADER FORMATTERS (tank-deck-format.ts)
// ===================================================================================
// Pure string formatting, no I/O. Used by both places that build a DeckPayload for the
// Fishtank artifact (scripts/templates/tank-article-template.ts and
// scripts/generate-static-site.ts's hub tankEntries mapping) so the wall headers stay
// identical between an article page and the hub carousel. Kept dependency-free like
// tank-types.ts so it's importable from backend.ts, scripts/, and the client bundle.
// ===================================================================================

import type { PropOdds } from './tank-types';

// "football_player_passing_yards" -> "Passing Yards", "moneyline" -> "Moneyline",
// "season_futures" -> "Season Futures". Generic prefix-strip + title-case instead of a
// hand-kept dictionary, so new market types Polymarket introduces format sensibly
// without a matching code change. Not the same map as index.tsx's MARKET_INFO (that one
// also carries a league bucket for the curator's checkbox UI) - this is just prose.
export function formatMarketLabel(market: string): string {
    const cleaned = market.replace(/^(?:basketball|football|baseball|soccer)_player_/, '');
    return cleaned
        .split('_')
        .filter(Boolean)
        .map(word => word[0].toUpperCase() + word.slice(1))
        .join(' ');
}

// "Yes 13.5% / No 86.5%" - same math as index.tsx's formatOdds(). Null in, null out, so
// the caller can fall back to formatMarketLabel() when no market price exists.
export function formatOddsLabel(odds: PropOdds | null): string | null {
    if (!odds || odds.outcomes.length === 0) return null;
    return odds.outcomes.map((o, i) => `${o} ${(odds.outcomePrices[i] * 100).toFixed(1)}%`).join(' / ');
}

// "Resolves Dec 31, 2026"
export function formatSettleDate(iso: string): string {
    const date = new Date(iso);
    if (isNaN(date.getTime())) return 'Settle date TBD';
    // timeZone: 'UTC' pins this to the stored date regardless of the server/browser's
    // local timezone - without it a UTC-midnight timestamp can render as the day before.
    return `Resolves ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`;
}

// All four wall headers get clamped through this. The model's "2 to 6 words" prompt
// guidance is a target, not a guarantee - and contextLabel/oddsOrMarketLabel are built
// from real team/player names of unpredictable length (e.g. "New York Giants vs. New
// York Jets"). A hard character cap, enforced here rather than left to CSS truncation
// alone, is what actually guarantees every header fits the wall's fixed width.
const HEADER_LABEL_MAX_CHARS = 34;

export function truncateHeaderLabel(text: string, maxChars: number = HEADER_LABEL_MAX_CHARS): string {
    const trimmed = text.trim();
    if (trimmed.length <= maxChars) return trimmed;
    const cut = trimmed.slice(0, maxChars);
    const lastSpace = cut.lastIndexOf(' ');
    // Only break on a word boundary if it doesn't throw away more than half the budget.
    return (lastSpace > maxChars * 0.5 ? cut.slice(0, lastSpace) : cut).trim() + '…';
}

// Only used for already-published rows generated before `tagline` existed on
// TankArticle, whose model_output has no tagline to show in the header.
export function deriveTaglineFallback(hook: string): string {
    return truncateHeaderLabel(hook.trim());
}
