// ===================================================================================
// HEATCHECKS TANK — LINES TANKS (tank-lines.ts)
// ===================================================================================
// The simplified Tank: one page per matchup showing its canonical moneyline, spread and
// total, each with a pick deck, no article and no ticker tag. Stored as up to three
// tank_pages rows (kind='lines', one per market - picks and settlement key on a row)
// that share a page_slug and render as one page at /the-tank/lines/<page_slug>/.
//
// Everything here is pure string/shape building, importable from backend.ts (creation),
// scripts/ (the static build) and the admin bundle, same posture as tank-deck-format.ts.
// Nothing here is model-generated: every field is a fact off the frozen snapshot.
// ===================================================================================

import type { DeckPayload, Game, Prop, TankArticle } from './tank-types';
import {
    deriveSidesImpliedProb,
    effectiveSettleDate,
    formatGameTime,
    formatOddsLabel,
    formatSettleDate,
    truncateHeaderLabel,
} from './tank-deck-format';
import { isYesNo, sideLabelsFor } from './market-movement';

export const LINE_TYPES = ['moneyline', 'spreads', 'totals'] as const;
export type LineType = (typeof LINE_TYPES)[number];
export type LineKey = 'ml' | 'spread' | 'total';

const LINE_KEY_BY_TYPE: Record<LineType, LineKey> = { moneyline: 'ml', spreads: 'spread', totals: 'total' };
const LINE_TYPE_BY_KEY: Record<LineKey, LineType> = { ml: 'moneyline', spread: 'spreads', total: 'totals' };

export function isLineType(market: string): market is LineType {
    return (LINE_TYPES as readonly string[]).includes(market);
}

export function lineKey(market: string): LineKey | null {
    return isLineType(market) ? LINE_KEY_BY_TYPE[market] : null;
}

export function lineTypeOf(key: LineKey): LineType {
    return LINE_TYPE_BY_KEY[key];
}

export function matchupName(game: Pick<Game, 'away' | 'home'>): string {
    return `${game.away} @ ${game.home}`;
}

// "Moneyline", "Will Chelsea FC win on 2026-09-12?", "Spread: Chiefs -6.5", "Total 47.5".
// The spread names the side laying the points because that is what a spread IS; a bare
// "Spread -6.5" says nothing about who. Soccer moneylines are single Yes/No markets on
// one team's win, so the market's own question is the only honest label.
export function lineLabel(prop: Pick<Prop, 'market' | 'line' | 'odds' | 'question'>): string {
    const outcomes = prop.odds?.outcomes ?? [];
    if (prop.market === 'moneyline') {
        return isYesNo(outcomes) && prop.question?.trim() ? prop.question.trim() : 'Moneyline';
    }
    if (prop.market === 'spreads') {
        const sides = sideLabelsFor(prop);
        return sides.length === 2 && /[-+]\d/.test(sides[0]) ? `Spread: ${sides[0]}` : 'Spread';
    }
    if (prop.market === 'totals') {
        return typeof prop.line === 'number' && Number.isFinite(prop.line) ? `Total ${prop.line}` : 'Total';
    }
    return prop.market;
}

// Short header for a wall or a chip: "Moneyline" / "Spread" / "Total 47.5".
export function lineShortLabel(prop: Pick<Prop, 'market' | 'line'>): string {
    if (prop.market === 'moneyline') return 'Moneyline';
    if (prop.market === 'spreads') return 'Spread';
    if (prop.market === 'totals') {
        return typeof prop.line === 'number' && Number.isFinite(prop.line) ? `Total ${prop.line}` : 'Total';
    }
    return prop.market;
}

function callQuestion(prop: Prop, game: Game, sides: string[]): string {
    const matchup = matchupName(game);
    if (prop.market === 'moneyline') {
        if (isYesNo(prop.odds?.outcomes) && prop.question?.trim()) return prop.question.trim();
        return `Who wins ${matchup}?`;
    }
    if (prop.market === 'spreads' && sides.length === 2) return `Who covers: ${sides[0]} or ${sides[1]}?`;
    if (prop.market === 'totals' && typeof prop.line === 'number') return `${matchup}: Over or Under ${prop.line}?`;
    return `${matchup}: ${lineLabel(prop)}`;
}

/**
 * The TankArticle a lines row carries in model_output. Shaped exactly like a narrative's
 * so every reader that renders a Tank (deck, picks, Discord card, portfolio) works
 * unchanged - but with an empty body and no prose anywhere. Exactly two cards, because
 * the Fishtank cube only closes at four walls (hook + 2 cards + call; components/
 * Fishtank.tsx). call.sides is positional with prop.odds.outcomes, the convention
 * picks.ts's sideIndex relies on.
 */
export function buildLinesArticle(prop: Prop, game: Game): TankArticle {
    const sides = sideLabelsFor(prop);
    const label = lineLabel(prop);
    const matchup = matchupName(game);
    const priceLine = formatOddsLabel(prop.odds, prop.book);
    return {
        seo: {
            title: `${matchup} — ${label}`,
            meta_description: `Make your call on the ${game.league} ${lineShortLabel(prop).toLowerCase()} for ${matchup}, ${formatGameTime(game.kickoff)}. No story, just the line.`,
            slug: '',
        },
        body: '',
        tagline: truncateHeaderLabel(label),
        hook: `${matchup} — ${label}`,
        cards: [
            `${game.league} · ${matchup} · ${formatGameTime(game.kickoff)}`,
            priceLine ? `Polymarket when this line was listed: ${priceLine}` : 'Not enough trading yet to quote a price for this line.',
        ],
        call: { question: callQuestion(prop, game, sides), sides },
    };
}

export interface LinesRowRecord {
    slug: string;
    game_snapshot: { prop: Prop; game: Game };
    model_output: TankArticle;
}

// Same fields, same formatters, as the article template's payload
// (scripts/templates/tank-article-template.ts) so the deck reads identically on both kinds.
export function buildLinesDeckPayload(row: LinesRowRecord): DeckPayload & { slug: string } {
    const { prop, game } = row.game_snapshot;
    const { hook, cards, call, tagline } = row.model_output;
    return {
        hook,
        cards,
        slug: row.slug,
        call: { ...call, sidesImpliedProb: deriveSidesImpliedProb(prop.odds, call.sides.length, prop.book) },
        tagline: truncateHeaderLabel(tagline || hook),
        contextLabel: truncateHeaderLabel(`${game.league} · ${lineShortLabel(prop)}`),
        oddsOrMarketLabel: truncateHeaderLabel(formatOddsLabel(prop.odds, prop.book) ?? lineLabel(prop)),
        settleDateLabel: truncateHeaderLabel(formatSettleDate(effectiveSettleDate(prop, game) ?? '')),
        gameTimeLabel: truncateHeaderLabel(formatGameTime(game.kickoff)),
        kickoff: game.kickoff,
    };
}

function slugPart(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// The ET calendar day, because that is the day a fan files the game under - a 7:05 PM
// ET first pitch is 23:05Z, which UTC would put on the next day.
export function etDateStamp(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'tbd';
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d).replace(/-/g, '');
}

// "lines-mlb-tor-cle-20260916". Uniqueness (doubleheaders, a re-listed fixture) is the
// caller's job via ensureUniqueSlug - the stored page_slug is the identity, never this.
export function linesPageSlugBase(game: Game): string {
    const away = slugPart(game.awayCode || game.away);
    const home = slugPart(game.homeCode || game.home);
    return `lines-${slugPart(game.league)}-${away}-${home}-${etDateStamp(game.kickoff)}`;
}

export function linesRowSlug(pageSlug: string, key: LineKey): string {
    return `${pageSlug}-${key}`;
}

export function linesPagePath(pageSlug: string): string {
    return `/the-tank/lines/${pageSlug}/`;
}
