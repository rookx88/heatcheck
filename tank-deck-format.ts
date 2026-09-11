// ===================================================================================
// HEATCHECKS TANK — SHARED DECK-HEADER FORMATTERS (tank-deck-format.ts)
// ===================================================================================
// Pure string formatting, no I/O. Used by both places that build a DeckPayload for the
// Fishtank artifact (scripts/templates/tank-article-template.ts and
// scripts/generate-static-site.ts's hub tankEntries mapping) so the wall headers stay
// identical between an article page and the hub carousel. Kept dependency-free like
// tank-types.ts so it's importable from backend.ts, scripts/, and the client bundle.
// ===================================================================================

import type { PropOdds, PropBook } from './tank-types';

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

// Compact prop-line tag for card/list surfaces: {market:'football_player_passing_yards',
// line:268.5} -> "O 268.5 Passing Yards". A null line means a yes/no market (e.g.
// Anytime TD) with no over/under number, so the market label stands alone - "O null"
// would be nonsense there.
export function formatPropTag(prop: { market: string; line: number | null }): string {
    const label = formatMarketLabel(prop.market);
    return prop.line != null ? `O ${prop.line} ${label}` : label;
}

// A price is only worth showing when a real order book stands behind it. Polymarket's
// quoted price is the bid/ask MIDPOINT, so an empty book (bid 0.06, ask 0.94, no trades)
// reads as a perfectly plausible 50% - verified live on Yankees-Twins, 2026-09-10, and
// shown as "50.0% / 50.0%" on 9 published articles before this guard existed. Live means
// a two-sided quote no wider than 10 points and at least some traded volume.
export const DEAD_BOOK_MAX_SPREAD = 0.1;

export function isLiveBook(book: Pick<PropBook, 'bestBid' | 'bestAsk' | 'volume'> | null | undefined): boolean {
    if (!book) return false;
    const { bestBid, bestAsk, volume } = book;
    if (typeof bestBid !== 'number' || typeof bestAsk !== 'number') return false;
    if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestAsk < bestBid) return false;
    if (typeof volume !== 'number' || !(volume > 0)) return false;
    return bestAsk - bestBid <= DEAD_BOOK_MAX_SPREAD + 1e-9;
}

// Whether frozen odds may be displayed as a price. With book data (snapshots taken from
// 2026-09-10 on) that is exactly isLiveBook. Without it - older snapshots, and the cached
// and admin paths - an all-0.500 two-way market is treated as an empty book: a genuine
// pick'em loses its percentages, which is the cheap direction to be wrong in.
export function hasShowablePrices(odds: PropOdds | null | undefined, book?: PropBook | null): boolean {
    if (!odds || odds.outcomes.length === 0 || odds.outcomePrices.length !== odds.outcomes.length) return false;
    if (book) return isLiveBook(book);
    const allHalf = odds.outcomePrices.length === 2 && odds.outcomePrices.every((p) => Math.abs(p - 0.5) < 1e-9);
    return !allHalf;
}

// The note carried by every surface that shows a Tank's own Polymarket prices (the
// article market panel's fallback and island, and /api/tank-market). Deliberately not
// tickers.ts's RETROSPECTIVE_NOTE, which describes index values, not prices.
export const MARKET_PANEL_NOTE = 'Polymarket midpoint prices, shown as percentages. Not a forecast and not a recommendation.';

// "Yes 13.5% / No 86.5%" - same math as index.tsx's formatOdds(). Null when there is no
// price worth showing (no odds, or a dead book - see hasShowablePrices), so the caller
// falls back to formatMarketLabel().
export function formatOddsLabel(odds: PropOdds | null, book?: PropBook | null): string | null {
    if (!odds || !hasShowablePrices(odds, book)) return null;
    return odds.outcomes.map((o, i) => `${o} ${(odds.outcomePrices[i] * 100).toFixed(1)}%`).join(' / ');
}

// Positionally parallel to a call's `sides` array, straight from the frozen odds -
// same trust-the-generation-order convention functions/api/picks.ts's sideIndex
// already relies on (odds.outcomes/outcomePrices are written in the same order
// call.sides was), so no name-matching, just a length check. Undefined when odds
// are absent or don't line up (mock/custom providers, or a mismatched outcome
// count) - the Fishtank ember-burst animation falls back to a fixed strength then.
// Undefined for a dead book too, so neither the deck nor a Discord button ("Chiefs
// (50%)") presents an empty book's midpoint as a price.
export function deriveSidesImpliedProb(odds: PropOdds | null, sidesLength: number, book?: PropBook | null): number[] | undefined {
    if (!odds || odds.outcomes.length !== sidesLength) return undefined;
    if (!hasShowablePrices(odds, book)) return undefined;
    return odds.outcomePrices;
}

// "Resolves Dec 31, 2026"
// Polymarket's GAME markets (MLB moneylines/spreads/totals) carry Gamma's endDate as
// an administrative resolution deadline padded ~a week past the game, while player
// props carry the true game time - observed live 2026-08: game markets settle-stamped
// kickoff + exactly 7 days. When the stored settle date sits implausibly far past
// kickoff, the game itself is the editorially meaningful date, so display that
// instead. 36h of slack covers late finishes, doubleheaders, and suspended games
// resuming next day without treating them as deadlines.
const SETTLE_DEADLINE_SLACK_MS = 36 * 60 * 60 * 1000;

export function effectiveSettleDate(
    prop: { settleDate?: string },
    game: { settleDate?: string; kickoff?: string },
): string | undefined {
    const stored = prop.settleDate ?? game.settleDate ?? game.kickoff;
    if (!stored || !game.kickoff) return stored;
    const storedMs = new Date(stored).getTime();
    const kickoffMs = new Date(game.kickoff).getTime();
    if (isNaN(storedMs) || isNaN(kickoffMs)) return stored;
    return storedMs - kickoffMs > SETTLE_DEADLINE_SLACK_MS ? game.kickoff : stored;
}

// Picks close the instant the underlying game starts - a reader (or a replayed/
// forged request) must never be able to lock in a call after kickoff, when the
// prop's outcome may already be partly or fully known. Missing/unparseable kickoff
// fails open (treated as not-yet-started) rather than blocking a legitimate prop
// over a data gap - Game.kickoff is a required field at generation time, so this
// only matters for stale pre-rebuild snapshots.
export function hasKickoffPassed(kickoff: string | undefined | null, now: number = Date.now()): boolean {
    if (!kickoff) return false;
    const kickoffMs = new Date(kickoff).getTime();
    return !isNaN(kickoffMs) && kickoffMs <= now;
}

export function formatSettleDate(iso: string): string {
    const date = new Date(iso);
    if (isNaN(date.getTime())) return 'Settle date TBD';
    // timeZone: 'UTC' pins this to the stored date regardless of the server/browser's
    // local timezone - without it a UTC-midnight timestamp can render as the day before.
    return `Resolves ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`;
}

// "Sat, Aug 29 · 7:05 PM ET"
// Always labeled "ET" generically rather than computing literal EST/EDT - standard
// sports-media convention, and it sidesteps DST: Intl.DateTimeFormat with an IANA
// timeZone always resolves the correct UTC offset for whichever DST regime is active
// on the given date, so the displayed clock time is already correct - only the "ET"
// suffix is a fixed literal. No year (kickoff is always near-term, and this sits right
// next to settleDateLabel which already carries a year - avoid redundant clutter in a
// small header). Same Intl.DateTimeFormat/America-New_York pattern already used
// server-side in backend.ts and client-side in index.tsx's getTodayDateNY().
export function formatGameTime(iso: string): string {
    const date = new Date(iso);
    if (isNaN(date.getTime())) return 'Game time TBD';
    const datePart = date.toLocaleDateString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York',
    });
    const timePart = date.toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
    });
    return `${datePart} · ${timePart} ET`;
}

// All four wall headers get clamped through this. It's a safety ceiling against a
// genuinely pathological, unbounded string (the model's "2 to 6 words" tagline
// guidance is a target, not a guarantee) - NOT a fit-to-width limit; the wall panel
// wraps headers to as many lines as they need instead of clipping them (see
// WallPanel's <h4> in components/Fishtank.tsx), so real content is never trimmed.
// 80 comfortably covers the longest realistic case: a whole-game market's
// contextLabel/oddsOrMarketLabel is built from real team names (e.g.
// "Bundesliga · Borussia Mönchengladbach vs. Bayern München" is ~57 chars).
const HEADER_LABEL_MAX_CHARS = 80;

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
