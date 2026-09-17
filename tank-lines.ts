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
// Nothing here is model-generated: every sentence is assembled from facts - the frozen
// snapshot, plus the LinesFacts the admin backend gathers when the row is created.
// ===================================================================================

import type { DeckPayload, Game, Prop, TankArticle } from './tank-types';
import {
    deriveSidesImpliedProb,
    effectiveSettleDate,
    formatGameTime,
    formatOddsLabel,
    formatSettleDate,
    hasShowablePrices,
    truncateHeaderLabel,
} from './tank-deck-format';
import { isYesNo, sideLabelsFor, yesSideLabel } from './market-movement';

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

// ---------------------------------------------------------------------------------
// FACTS. What the admin backend gathers for one line when it creates the row (backend.ts,
// gatherLinesFacts). Every field is optional: a fact that could not be established is
// simply absent and its sentence is never written, so a thin market produces a thinner
// card, never a guess. Nothing here comes from a model.
// ---------------------------------------------------------------------------------

export interface LinesTeamRecord {
    games: number;
    wins: number;
    /** Sum of the club's frozen pre-game prices: the wins those prices added up to. */
    expectedWins: number;
}

export interface LinesOverRecord {
    games: number;
    overs: number;
}

export interface LinesRung {
    line: number;
    /** Price of the SAME first outcome as this line's (Over; or the same team's cover). */
    prob: number;
}

export interface LinesFacts {
    /** ISO. When the facts were gathered - every sentence is dated to it. */
    asOf: string;
    volume?: number | null;
    liquidity?: number | null;
    /**
     * The first outcome's price about a day before asOf, and when exactly. Deliberately NOT
     * the market's first recorded price: a game market's first days are a thin book whose
     * midpoint wanders (a moneyline "at 97.5%", a total "at 38%" were both observed), so
     * "since it opened" reports a movement that never happened.
     */
    dayAgo?: { prob: number; ts: string } | null;
    /** The other rungs of this market's ladder, never this line itself. */
    ladder?: LinesRung[];
    /** The same game's moneyline - the spread's "win vs cover" card reads it. */
    moneyline?: { outcomes: string[]; probs: number[] } | null;
    records?: { away?: LinesTeamRecord | null; home?: LinesTeamRecord | null } | null;
    overs?: { league?: LinesOverRecord | null; away?: LinesOverRecord | null; home?: LinesOverRecord | null } | null;
}

// Below these a record is noise, not a fact worth a wall. MIN_TEAM_GAMES matches
// team-records.ts's DEFAULT_MIN_GAMES so a lines card and a team page agree on when a
// club has "a record".
export const MIN_TEAM_GAMES = 5;
export const MIN_LEAGUE_TOTALS = 20;
// Under a point the price "didn't move" - same threshold as market-movement.ts's
// UNCHANGED_BELOW_PP.
const UNCHANGED_BELOW = 0.01;

const SOCCER_LEAGUES = new Set([
    'EPL', 'Premier League', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1', 'Champions League',
    'EFL Championship', 'MLS', 'DFB-Pokal', 'Carabao Cup',
]);

function unitFor(league: string, n: number): string {
    const base = league === 'MLB' ? 'run' : league === 'NHL' || SOCCER_LEAGUES.has(league) ? 'goal' : 'point';
    return n === 1 ? base : `${base}s`;
}

// 0.5725 -> "57.3%", 0.5 -> "50%".
function pct(p: number): string {
    return `${Math.round(p * 1000) / 10}%`;
}

// 119097 -> "$119K", 1234567 -> "$1.2M".
function usd(n: number): string {
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
    return `$${Math.round(n)}`;
}

// Both sides of a two-way line, the second as the complement of the first so the pair
// always reads as 100% (57.3% / 42.7%, never 57.3% / 42.8%) - the same choice the page's
// price panel makes (renderMarketSection).
function pctPair(p: number[]): [string, string] {
    const first = Math.round(p[0] * 1000) / 10;
    return [`${first}%`, `${Math.round((100 - first) * 10) / 10}%`];
}

// A rung this lopsided is a decided side, not a line anyone is weighing - the same
// bounds index-slate.ts uses for an entry price (MIN_ENTRY_PROB / MAX_ENTRY_PROB).
const RUNG_MIN_PROB = 0.05;
const RUNG_MAX_PROB = 0.95;
function liveRung(r: LinesRung): boolean {
    return Number.isFinite(r.prob) && r.prob >= RUNG_MIN_PROB && r.prob <= RUNG_MAX_PROB;
}

function shortDate(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' }).format(d);
}

function signedLine(line: number): string {
    return line > 0 ? `+${line}` : `${line}`;
}

function capitalize(text: string): string {
    return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function livePrices(prop: Prop): number[] | null {
    if (!prop.odds || !hasShowablePrices(prop.odds, prop.book)) return null;
    const p = prop.odds.outcomePrices;
    return p.length === 2 && p.every((v) => typeof v === 'number' && Number.isFinite(v)) ? p : null;
}

// THE PRICE-LANGUAGE RULES, inherited from the story prompt (scripts/prompts/
// tank-narrative-prompt.ts, "Market movement") because a lines page is read long after it
// is written too: past tense over a bounded interval, two levels never a difference
// ("went from 50% to 57.3%", never "up 7 points"), a side named by its full label
// including the line, no data source named, and the market never written as a character -
// no "favorite", "chance", "likely", "expects", "the money".
function movementSentence(label: string, to: number, facts: LinesFacts): string | null {
    const opened = facts.dayAgo;
    if (!opened || !Number.isFinite(opened.prob)) return null;
    const d1 = shortDate(opened.ts);
    const d2 = shortDate(facts.asOf);
    if (!d1 || !d2) return null;
    const span = d1 === d2 ? `on ${d1}` : `between ${d1} and ${d2}`;
    if (Math.abs(to - opened.prob) < UNCHANGED_BELOW) return `The price on ${label} didn't move ${span}.`;
    return `The price on ${label} went from ${pct(opened.prob)} to ${pct(to)} ${span}.`;
}

function volumeSentence(facts: LinesFacts): string | null {
    const v = facts.volume ?? 0;
    const l = facts.liquidity ?? 0;
    if (v >= 1 && l >= 1) return `${usd(v)} in volume on this line when it was listed, with ${usd(l)} resting in the order book.`;
    if (v >= 1) return `${usd(v)} in volume on this line when it was listed.`;
    if (l >= 1) return `No volume yet on this line when it was listed, with ${usd(l)} resting in the order book.`;
    return null;
}

function volumeHeader(facts: LinesFacts): string | null {
    const v = facts.volume ?? 0;
    if (v >= 1) return `${usd(v)} volume`;
    const l = facts.liquidity ?? 0;
    return l >= 1 ? `${usd(l)} in the book` : null;
}

function join(...parts: Array<string | null | undefined>): string {
    return parts.filter((p): p is string => Boolean(p)).join(' ');
}

interface Wall { header: string; text: string }

// The two walls every line can always fill, whatever facts are missing.
function gameWall(prop: Prop, game: Game): Wall {
    return {
        header: `${game.league} · ${lineShortLabel(prop)}`,
        text: `${game.league} · ${matchupName(game)} · ${formatGameTime(game.kickoff)}`,
    };
}

function priceWall(prop: Prop, facts: LinesFacts | undefined): Wall {
    const priceLine = formatOddsLabel(prop.odds, prop.book);
    const money = facts ? volumeSentence(facts) : null;
    return {
        header: priceLine ?? lineLabel(prop),
        text: priceLine
            ? join(`When this line was listed: ${priceLine}.`, money)
            : join('No price to quote on this line when it was listed.', money),
    };
}

function recordSentence(team: string, r: LinesTeamRecord | null | undefined): string | null {
    if (!r || r.games < MIN_TEAM_GAMES) return null;
    return `${team}: ${r.wins} ${r.wins === 1 ? 'win' : 'wins'} in ${r.games} games on our board; their prices added up to ${r.expectedWins.toFixed(1)}.`;
}

interface BuiltWalls { hook: string; walls: [Wall, Wall] }

function moneylineWalls(prop: Prop, game: Game, sides: string[], facts: LinesFacts | undefined): BuiltWalls {
    const p = livePrices(prop);
    const matchup = matchupName(game);
    const yesLabel = isYesNo(prop.odds?.outcomes) ? yesSideLabel(prop.question) : null;
    const hook = !p
        ? `${matchup} — ${lineLabel(prop)}`
        : yesLabel
            ? `${capitalize(yesLabel)} was priced at ${pct(p[0])} when this line was listed.`
            : `${sides[0]} ${pctPair(p)[0]}, ${sides[1]} ${pctPair(p)[1]}: the moneyline on ${matchup} when it was listed.`;

    const records = join(recordSentence(game.away, facts?.records?.away), recordSentence(game.home, facts?.records?.home));
    const first: Wall = records ? { header: 'Wins vs prices', text: records } : gameWall(prop, game);

    const movement = p && facts ? movementSentence(yesLabel ?? sides[0], p[0], facts) : null;
    const money = facts ? volumeSentence(facts) : null;
    const second: Wall = movement || money
        ? { header: (facts && volumeHeader(facts)) || 'Price history', text: join(money, movement) }
        : priceWall(prop, facts);
    return { hook, walls: [first, second] };
}

function spreadWalls(prop: Prop, game: Game, sides: string[], facts: LinesFacts | undefined): BuiltWalls {
    const p = livePrices(prop);
    const matchup = matchupName(game);
    const outcomes = prop.odds?.outcomes ?? [];
    const hook = p
        ? `${sides[0]} ${pctPair(p)[0]}, ${sides[1]} ${pctPair(p)[1]}: the spread on ${matchup} when it was listed.`
        : `${matchup} — ${lineLabel(prop)}`;

    // Win vs cover: the same club's moneyline price next to its cover price. The
    // difference is, arithmetically, the price of winning by less than the spread.
    let first: Wall = gameWall(prop, game);
    const layIdx = sides.findIndex((label) => / -\d/.test(label));
    const margin = typeof prop.line === 'number' ? Math.floor(Math.abs(prop.line)) : 0;
    if (p && layIdx >= 0 && margin >= 1 && facts?.moneyline) {
        const team = outcomes[layIdx];
        const mlIdx = facts.moneyline.outcomes.findIndex((o) => o === team);
        const winP = mlIdx >= 0 ? facts.moneyline.probs[mlIdx] : NaN;
        if (Number.isFinite(winP) && winP > p[layIdx]) {
            const by = margin === 1 ? `exactly 1 ${unitFor(game.league, 1)}` : `${margin} ${unitFor(game.league, margin)} or fewer`;
            first = {
                header: 'Win vs cover',
                text: `${team} to win was priced at ${pct(winP)}; ${sides[layIdx]} at ${pct(p[layIdx])}. The difference is the price of ${team} winning by ${by}.`,
            };
        }
    }

    // The next rung out on the same club's ladder.
    const own = typeof prop.line === 'number' ? Math.abs(prop.line) : null;
    const next = own === null ? undefined : (facts?.ladder ?? [])
        .filter((r) => Math.abs(r.line) > own && liveRung(r))
        .sort((a, b) => Math.abs(a.line) - Math.abs(b.line))[0];
    const money = facts ? volumeSentence(facts) : null;
    let second: Wall = priceWall(prop, facts);
    if (next && outcomes[0]) {
        second = {
            header: `Next: ${signedLine(next.line)} at ${pct(next.prob)}`,
            text: join(`At ${outcomes[0]} ${signedLine(next.line)} the price was ${pct(next.prob)}.`, money),
        };
    } else if (p && money && facts) {
        second = { header: volumeHeader(facts) || 'Price history', text: join(money, movementSentence(sides[0], p[0], facts)) };
    }
    return { hook, walls: [first, second] };
}

function totalWalls(prop: Prop, game: Game, sides: string[], facts: LinesFacts | undefined): BuiltWalls {
    const p = livePrices(prop);
    const matchup = matchupName(game);
    const line = typeof prop.line === 'number' && Number.isFinite(prop.line) ? prop.line : null;
    const hook = p && line !== null
        ? `The total on ${matchup} was ${line} ${unitFor(game.league, line)}, with ${sides[0]} priced at ${pct(p[0])} when it was listed.`
        : `${matchup} — ${lineLabel(prop)}`;

    // The ladder: this number next to its neighbours, all priced for the Over.
    let first: Wall = gameWall(prop, game);
    // This number's nearest neighbours - an NFL total carries fifteen rungs, and the four
    // lowest say nothing about 54.5.
    // ...and only rungs genuinely near it: within 2, or 10% of the number for the big
    // totals (54.5 reaches 49-60, 220.5 reaches 198-243). A sparse ladder shows fewer
    // rungs rather than a far one.
    const reach = line === null ? 0 : Math.max(2, Math.abs(line) * 0.1);
    const others = line === null ? [] : (facts?.ladder ?? [])
        .filter((r) => liveRung(r) && r.line !== line && Math.abs(r.line - line) <= reach)
        .sort((a, b) => Math.abs(a.line - line) - Math.abs(b.line - line) || a.line - b.line)
        .slice(0, 3);
    if (p && line !== null && others.length > 0) {
        const rungs = [{ line, prob: p[0] }, ...others].sort((a, b) => a.line - b.line);
        const parts = rungs.map((r, i) => (i === 0 ? `Over ${r.line} was priced at ${pct(r.prob)}` : `Over ${r.line} at ${pct(r.prob)}`));
        const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}.` : `${parts[0]}.`;
        const nearest = [...rungs].sort((a, b) => Math.abs(a.prob - 0.5) - Math.abs(b.prob - 0.5))[0];
        first = {
            header: 'The ladder',
            text: join(list, nearest.line === line ? `${line} was the number closest to an even price.` : null),
        };
    }

    // How totals have landed on our board - league first, then each club's games.
    let second: Wall = priceWall(prop, facts);
    const league = facts?.overs?.league;
    if (facts && league && league.games >= MIN_LEAGUE_TOTALS) {
        const teamBit = (team: string, r: LinesOverRecord | null | undefined) =>
            r && r.games >= MIN_TEAM_GAMES ? `${team} games: ${r.overs} of ${r.games}.` : null;
        second = {
            header: `${game.league} Overs: ${league.overs} of ${league.games}`,
            text: join(
                `Through ${shortDate(facts.asOf)}, the Over landed in ${league.overs} of ${league.games} ${game.league} totals on our board.`,
                teamBit(game.away, facts.overs?.away),
                teamBit(game.home, facts.overs?.home),
            ),
        };
    } else if (p && facts && volumeSentence(facts)) {
        second = { header: volumeHeader(facts) || 'Price history', text: join(volumeSentence(facts), movementSentence(sides[0], p[0], facts)) };
    }
    return { hook, walls: [first, second] };
}

/**
 * The TankArticle a lines row carries in model_output. Shaped exactly like a narrative's
 * so every reader that renders a Tank (deck, picks, Discord card, portfolio) works
 * unchanged - but with an empty body, and every sentence assembled from facts rather than
 * written by a model. Exactly two cards, because the Fishtank cube only closes at four
 * walls (hook + 2 cards + call; components/Fishtank.tsx). call.sides is positional with
 * prop.odds.outcomes, the convention picks.ts's sideIndex relies on.
 *
 * `facts` is optional: without it (or with any part of it missing) each wall falls back
 * to what the snapshot alone can say. See the price-language rules above movementSentence.
 */
export function buildLinesArticle(prop: Prop, game: Game, facts?: LinesFacts): TankArticle {
    const sides = sideLabelsFor(prop);
    const label = lineLabel(prop);
    const matchup = matchupName(game);
    const built = prop.market === 'spreads' ? spreadWalls(prop, game, sides, facts)
        : prop.market === 'totals' ? totalWalls(prop, game, sides, facts)
            : moneylineWalls(prop, game, sides, facts);
    return {
        seo: {
            title: `${matchup} — ${label}`,
            meta_description: `Make your call on the ${game.league} ${lineShortLabel(prop).toLowerCase()} for ${matchup}, ${formatGameTime(game.kickoff)}. No story, just the line.`,
            slug: '',
        },
        body: '',
        tagline: truncateHeaderLabel(label),
        hook: built.hook,
        cards: [built.walls[0].text, built.walls[1].text],
        cardHeaders: [truncateHeaderLabel(built.walls[0].header), truncateHeaderLabel(built.walls[1].header)],
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
    const { hook, cards, call, tagline, cardHeaders } = row.model_output;
    return {
        hook,
        cards,
        slug: row.slug,
        call: { ...call, sidesImpliedProb: deriveSidesImpliedProb(prop.odds, call.sides.length, prop.book) },
        tagline: truncateHeaderLabel(tagline || hook),
        // A lines row names its own card walls (buildLinesArticle's cardHeaders); rows
        // created before it did fall back to the league/line and the frozen odds.
        contextLabel: truncateHeaderLabel(cardHeaders?.[0] || `${game.league} · ${lineShortLabel(prop)}`),
        oddsOrMarketLabel: truncateHeaderLabel(cardHeaders?.[1] || (formatOddsLabel(prop.odds, prop.book) ?? lineLabel(prop))),
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
