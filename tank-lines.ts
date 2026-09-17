// ===================================================================================
// HEATCHECKS TANK — LINES TANKS, RENDER SIDE (tank-lines.ts)
// ===================================================================================
// The simplified Tank: one page per matchup showing its canonical moneyline, spread and
// total, each with a pick deck and no article. Stored as up to three tank_pages rows
// (kind = 'lines', one per market - picks and settlement key on a row) that share a
// page_slug and render as one page at /the-tank/lines/<page_slug>/.
//
// PORT NOTE. This is the render-only half, ported to main on its own. Lines rows are
// CREATED by the admin backend on the auth-sessions branch, which holds the full module
// (buildLinesArticle, slugging, the canonical-market picker). A row arrives here complete
// - model_output already carries its hook, cards and call - so production only has to
// read it. When auth-sessions is promoted, its tank-lines.ts replaces this file whole.
//
// Pure string/shape building, dependency-free like tank-deck-format.ts.
// ===================================================================================

import type { Game, Prop, TankArticle } from './tank-types';
import type { DeckPayload } from './components/Fishtank';
import { formatOddsLabel, formatSettleDate, truncateHeaderLabel } from './tank-deck-format';

export type LineKey = 'ml' | 'spread' | 'total';

const LINE_KEY_BY_TYPE: Record<string, LineKey> = { moneyline: 'ml', spreads: 'spread', totals: 'total' };

// The frozen snapshot carries the market's own question (written by the auth-sessions
// provider); main's Prop type predates the field.
export type LinesProp = Prop & { question?: string | null };

export function lineKey(market: string): LineKey | null {
    return LINE_KEY_BY_TYPE[market] ?? null;
}

export function matchupName(game: Pick<Game, 'away' | 'home'>): string {
    return `${game.away} @ ${game.home}`;
}

export function linesPagePath(pageSlug: string): string {
    return `/the-tank/lines/${pageSlug}/`;
}

// "Tue, Sep 16, 7:05 PM ET" - the ET clock, because that is the day a fan files the game
// under (a 7:05 PM ET first pitch is 23:05Z, which UTC would put on the next day).
export function formatGameTime(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'Time TBD';
    return new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }).format(d) + ' ET';
}

function isYesNo(outcomes: string[] | undefined): boolean {
    return Array.isArray(outcomes) && outcomes.length === 2
        && outcomes[0].trim().toLowerCase() === 'yes' && outcomes[1].trim().toLowerCase() === 'no';
}

// "Moneyline", "Will Chelsea FC win on 2026-09-12?", "Spread: Chiefs -6.5", "Total 47.5".
// The spread names the side laying the points, read off the row's own call.sides (built
// when the row was created) rather than re-derived here.
export function lineLabel(prop: LinesProp, sides: string[] = []): string {
    if (prop.market === 'moneyline') {
        const q = prop.question?.trim();
        return isYesNo(prop.odds?.outcomes) && q ? q : 'Moneyline';
    }
    if (prop.market === 'spreads') {
        return sides.length === 2 && /[-+]\d/.test(sides[0]) ? `Spread: ${sides[0]}` : 'Spread';
    }
    if (prop.market === 'totals') {
        return typeof prop.line === 'number' && Number.isFinite(prop.line) ? `Total ${prop.line}` : 'Total';
    }
    return prop.market;
}

// Short header for a wall: "Moneyline" / "Spread" / "Total 47.5".
export function lineShortLabel(prop: Pick<Prop, 'market' | 'line'>): string {
    if (prop.market === 'moneyline') return 'Moneyline';
    if (prop.market === 'spreads') return 'Spread';
    if (prop.market === 'totals') {
        return typeof prop.line === 'number' && Number.isFinite(prop.line) ? `Total ${prop.line}` : 'Total';
    }
    return prop.market;
}

export interface LinesDeckRow {
    slug: string;
    game_snapshot: { prop: LinesProp; game: Game };
    model_output: TankArticle;
}

// Same fields, same formatters, as the article template's payload so the deck reads
// identically on both kinds. sidesImpliedProb is positional with call.sides, the
// convention functions/api/picks.ts's sideIndex relies on.
export function buildLinesDeckPayload(row: LinesDeckRow): DeckPayload & { slug: string } {
    const { prop, game } = row.game_snapshot;
    const { hook, cards, call, tagline, cardHeaders } = row.model_output;
    const prices = prop.odds?.outcomePrices;
    const sidesImpliedProb = Array.isArray(prices) && prices.length === call.sides.length
        && prices.every((p) => typeof p === 'number' && Number.isFinite(p))
        ? prices
        : undefined;
    return {
        hook,
        cards,
        slug: row.slug,
        call: sidesImpliedProb ? { ...call, sidesImpliedProb } : call,
        tagline: truncateHeaderLabel(tagline || hook),
        // A lines row names its own card walls; rows created before it did fall back to the
        // league/line and the frozen odds.
        contextLabel: truncateHeaderLabel(cardHeaders?.[0] || `${game.league} · ${lineShortLabel(prop)}`),
        oddsOrMarketLabel: truncateHeaderLabel(cardHeaders?.[1] || (formatOddsLabel(prop.odds) ?? lineLabel(prop, call.sides))),
        settleDateLabel: truncateHeaderLabel(formatSettleDate(prop.settleDate ?? game.settleDate ?? game.kickoff)),
    };
}
