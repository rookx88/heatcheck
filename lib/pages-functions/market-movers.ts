// ===================================================================================
// MARKET MOVERS — shared presentational renderers for the Exchange ticker surface
// ===================================================================================
// Pure string builders over ticker read data (lib/pages-functions/tickers.ts helpers).
// Consumed today by the server-rendered homepage (lib/pages-functions/homepage/
// render.ts: the ticker-tape marquee + the Market Movers section); designed so a
// future stock-market page renders the SAME renderMarketMoverCard() and wraps its own
// interactivity AROUND it. Deliberately presentational: no session awareness, no
// invest/divest UI, no fetches - data in, HTML out. The only interactivity the markup
// carries is universally safe: native SVG <title> hover tooltips, and a
// gainers/losers tab strip that ships `hidden` and is unhidden by the vanilla island
// (homepage-client.tsx) - without JS the default all-tickers view renders complete.
//
// Same Workers-safety rule as render.ts: imports must stay pure string builders -
// escapeHtml and types only, no Node/DOM/React.
//
// Framing constraint carried from the backend: ticker values reflect how tagged
// storylines have gone - RETROSPECTIVE_NOTE renders as visible text, and no copy here
// may present movement as predictive.

import { escapeHtml } from '../../scripts/utils/html-escape';
import { chooseWindow, type WindowInfo } from './ticker-window';
import { layoutNested } from './treemap';
import { leagueShortCode, parseLeagueRule } from './league-rules';
import { parseYesNoQuestion } from './index-slate';
import { PRICE_NOTE, priceFromValue, priceReturnPct } from './ticker-price';
import { formatEmber, formatQuote, formatSignedPct, signOf, type Sign } from './ticker-format';
import {
    RETROSPECTIVE_NOTE,
    type TickerNewsItem,
    type TickerResultItem,
    type TickerSeriesEvent,
    type TickerValue,
} from './tickers';

export interface MarketMoverNewsVM {
    href: string;
    hook: string;
    excerpt: string; // cards[0], '' when the model returned no cards - the established excerpt unit
    league: string;
    dateLabel: string; // "Aug 12, 2026" or ''
}

export interface MarketMoverVM {
    key: string;
    displayName: string;
    indexLabel: string;  // "Underdog Index" etc, derived from rule_type
    description: string; // real tickers.description text - page content, not a UI label
    value: number;       // all-time cumulative index points - tooltips and the "overall" aside only
    valueLabel: string;  // formatSignedPct(value)
    // The headline quote, stock-ticker style: the Ember price and the price's % return
    // over the section's window - "45.23 (+1.2%)". sign, ranking, and the board's tile
    // sizing all key off priceReturnPct, never off the cumulative value: per-ticker
    // price scales were tuned so a one-sigma day is ~12% on every index
    // (seed_ticker_prices_v1.sql), so the price return is the normalised size of a move
    // across indexes in a way raw points are not.
    price: number;
    priceBaseline: number;
    priceScale: number;
    windowDelta: number;     // points moved inside the window (chooseWindow)
    priceReturnPct: number;  // priceReturnPct(windowDelta, priceScale)
    priceLabel: string;      // formatEmber(price)
    returnLabel: string;     // formatSignedPct(priceReturnPct)
    quoteLabel: string;      // formatQuote(price, priceReturnPct) - the ONE string tape, card and board share
    window: WindowInfo;      // the section's window, the same on every mover
    sign: Sign;
    tabOrder: number;    // marquee/marketing order; the section grid sorts by price return instead
    // Set on a league sub-index, naming the index it slices. The board nests these
    // inside their parent's tile; the tape and the card grid stay top-level only.
    parentKey: string | null;
    // 'NBA' / 'NFL' / 'MLB' / 'SOC' for a league slice, else null. The board's fallback
    // when a child's tile is too narrow for the full symbol.
    shortLabel: string | null;
    eventCount: number;
    series: TickerSeriesEvent[]; // capped (SERIES_CAP) tail; cumulative values stay truthful
    seriesTruncated: boolean;
    news: MarketMoverNewsVM[];
    results: MarketMoverResultVM[]; // "Recent Results" - settled slate games as sentences, newest first
}

export interface MarketMoverResultVM {
    text: string; // already-composed sentence
    won: boolean; // this specific result's own outcome - independent of the card's overall sign
}

export interface MarketMoversData {
    note: string;
    priceNote: string;   // PRICE_NOTE - rendered once wherever a price appears (ticker-price.ts rule)
    window: WindowInfo;  // the ONE window the tape, cards and board all quote
    movers: MarketMoverVM[];
}

// SSR series cap: the homepage renders at most this many trailing events per ticker.
// The cumulative values come from SQL, so a truncated line honestly starts mid-flight
// (no synthetic origin is prepended when truncated - see renderTickerChartSvg).
const SERIES_CAP = 60;

const DEFAULT_WINDOW: WindowInfo = { label: 'the last 24 hours', short: '24H', widened: false };

export function emptyMarketMovers(): MarketMoversData {
    return { note: RETROSPECTIVE_NOTE, priceNote: PRICE_NOTE, window: DEFAULT_WINDOW, movers: [] };
}

// The formatters live in ticker-format.ts so the TANKDAQ islands and the article tiles
// print byte-identical strings; re-exported here for this module's existing callers.
export { formatSignedPct } from './ticker-format';

// "underdog" -> "Underdog Index" - the card's display title ("UNDERDOG INDEX ($DOGS)").
// Implementation moved to ticker-copy.ts (a dependency-free module the TANKDAQ client
// bundles can import); re-exported here so this module stays the one import site for
// everything the Market Movers surface needs.
export { indexLabelOf } from './ticker-copy';
import { indexLabelOf } from './ticker-copy';

// Same UTC-pinned date rule as the old feed's toFeedItemViewModel / formatSettleDate.
function utcDateLabel(iso: string): string {
    const d = new Date(iso);
    return isNaN(d.getTime())
        ? ''
        : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

// Compact form for the chart's x-axis ticks ("Aug 12") - the full form with the year
// stays on the hover tooltips.
function utcShortDateLabel(iso: string): string {
    const d = new Date(iso);
    return isNaN(d.getTime())
        ? ''
        : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// A side label that names a side rather than a team/player ("Over", "Under 37.5",
// "Yes"/"No" on Kalshi markets) - never a sentence subject: "the price on Under" reads
// broken. Word-boundary match so "Over 37.5" counts but "Overton" wouldn't.
const GENERIC_SIDE_LABEL = /^(over|under|yes|no)\b/i;

// The "Team Name" / "Player" subject for a NEWS sentence (a Tank's own market): a player
// prop's real subject is prop.player itself; a game-line market's prop.player is a matchup
// fallback ("Away vs. Home" - tank-providers.ts), so the tagged side's own outcome label
// (a real team name for moneylines/spreads) is the correct subject there instead - EXCEPT
// totals-style markets, whose labels are generic side words: those pull the matchup name
// from prop.player. Same "_player_" substring test formatMarketLabel() (tank-deck-format.ts)
// already uses. Result sentences no longer come through here - a slate position carries
// its own away/home/side fields (see buildResultSentence).
interface SubjectFields {
    subject: string;
    market: string;
    outcomeLabel: string;
    pickLabel: string;
}
function subjectFor(item: SubjectFields): string {
    const isPlayerProp = /_player_/.test(item.market);
    if (isPlayerProp) return item.subject;
    if (!item.outcomeLabel || GENERIC_SIDE_LABEL.test(item.outcomeLabel)) return item.subject;
    return item.outcomeLabel;
}

// The market types whose sides are Over/Under on a game score (mirrors
// GAME_LINE_MARKET_TYPES' totals subset in tank-providers.ts).
const TOTALS_MARKET_TYPES = ['totals', 'team_totals'];

// -----------------------------------------------------------------------------------
// Result sentences - one per settled slate GAME (an index_positions row, via
// getTickerResults in tickers.ts).
//
// DESCRIPTIVE ONLY (rewritten 2026-09-11, alongside the news sentences' 2026-09-10
// rewrite). These used to rotate three playful templates - "Buyers applaud", "up in
// arms", "experiences a local high" - which is money-flow language describing a crowd
// that doesn't exist. Tank content never pushes a take, so a result sentence now states
// exactly two facts and nothing else: what happened in the game, and what the index did.
// One form per case, so the same kind of result always reads the same way. Past tense,
// never a forecast.
//
// The points figure is the game's own share of its day's close (TickerResultItem.delta,
// from positionShareOfClose) - deliberately not the %-formatted valueLabel, per the
// "points, not percent" ask - so a card's sentences add up to the move on its chart.
// Typical shares are small (0.05-0.8 points); when one decimal would print "0.0" the
// sentence shows two rather than claim a zero move.
//
// Four market shapes:
//   totals        - the game cleared the line or stayed under it. Whether it cleared
//                   follows from side + outcome: an Over winning and an Under losing both
//                   mean the total was cleared.
//   team line     - the side label IS the team; it won or lost.
//   Yes/No line   - Polymarket's soccer moneylines ("Will <TEAM> win?"). The team comes
//                   from the question. Yes held = the team; No held = the other side of a
//                   three-way (opponent win OR draw), so the only honest fact is that the
//                   team "did not win", and the index is named as having held the other
//                   side rather than pretending it backed a team.
//   draw market   - legacy only (isDrawMarket now keeps these out of the slate).
// Anything the shapes above can't name (a Yes/No with no readable question, an unknown
// market type) gets a tolerant fallback so nothing ever renders blank or throws.
// -----------------------------------------------------------------------------------

const YES_NO_LABEL = /^(yes|no)$/i;

function resultPoints(delta: number): string {
    const one = Math.abs(delta).toFixed(1);
    return one === '0.0' ? Math.abs(delta).toFixed(2) : one;
}

function matchupOf(item: Pick<TickerResultItem, 'away' | 'home'>): string {
    if (item.away && item.home) return `${item.away} vs. ${item.home}`;
    return item.away ?? item.home ?? 'the game';
}

// "at {home}" for the away side, "against {away}" for the home side, else the matchup.
function venueOf(team: string, item: Pick<TickerResultItem, 'away' | 'home'>): string {
    const norm = (s: string | null) => (s ?? '').trim().toLowerCase();
    if (item.home && norm(team) === norm(item.away)) return `at ${item.home}`;
    if (item.away && norm(team) === norm(item.home)) return `against ${item.away}`;
    return `in ${matchupOf(item)}`;
}

export function buildResultSentence(item: TickerResultItem, displayName: string, _templateIndex: number): string {
    const points = resultPoints(item.delta);
    const moved = item.won ? 'rose' : 'fell';
    const indexClause = (otherSide: boolean) =>
        `${displayName}${otherSide ? ', which held the other side,' : ''} ${moved} ${points} points.`;
    const matchup = matchupOf(item);

    if (TOTALS_MARKET_TYPES.includes(item.marketType)) {
        const isOver = /^over\b/i.test(item.sideLabel);
        const cleared = isOver === item.won;
        const line = typeof item.marketLine === 'number' ? String(item.marketLine) : null;
        const game = cleared
            ? `${line ? `Over ${line}` : 'The Over'} hit in ${matchup}`
            : `${matchup} stayed under ${line ?? 'the total'}`;
        return `${game}; ${indexClause(false)}`;
    }

    if (YES_NO_LABEL.test(item.sideLabel.trim())) {
        const heldYes = item.sideLabel.trim().toLowerCase() === 'yes';
        // The Yes side's fact came true exactly when (Yes held AND won) or (No held AND lost).
        const yesHappened = heldYes === item.won;
        const parsed = parseYesNoQuestion(item.question);
        if (parsed?.kind === 'team') {
            const team = parsed.team;
            const game = yesHappened ? `${team} won ${venueOf(team, item)}` : `${team} did not win ${venueOf(team, item)}`;
            return `${game}; ${indexClause(!heldYes)}`;
        }
        if (parsed?.kind === 'draw') {
            const game = yesHappened ? `${matchup} ended in a draw` : `${matchup} did not end in a draw`;
            return `${game}; ${indexClause(!heldYes)}`;
        }
        // No readable question: name the side literally rather than guess a team.
        return `${matchup}: the ${item.sideLabel.trim()} side ${item.won ? 'came in' : 'missed'}; ${indexClause(false)}`;
    }

    if (item.marketType === 'moneyline' && item.sideLabel) {
        const team = item.sideLabel;
        return `${team} ${item.won ? 'won' : 'lost'} ${venueOf(team, item)}; ${indexClause(false)}`;
    }

    return `${matchup}: the ${item.sideLabel || 'held'} side ${item.won ? 'came in' : 'missed'}; ${indexClause(false)}`;
}

// The one sentence-composition entry point, shared by toMarketMovers below and the
// TANKDAQ detail endpoint (functions/api/tickers/detail.ts) - the same settled game
// reads the same on the homepage cards, the tape, and /tankdaq/<key>/.
export function toResultSentences(items: TickerResultItem[], displayName: string): MarketMoverResultVM[] {
    return items.map((r, i) => ({ text: buildResultSentence(r, displayName, i), won: r.won }));
}

// -----------------------------------------------------------------------------------
// News sentences - the article-page counterpart to the result sentences above.
//
// A tag is a different kind of event from a settle: it records how the market priced a
// story over the 3 days before the story was added to an index, before any game has been
// played, so none of the win/loss templates above apply.
//
// DESCRIPTIVE ONLY (rewritten 2026-09-10). These used to read like investors reacting to
// a stock story - "Buyers pile in", "Traders shrug", "catches a bid", "points of buying".
// That is money-flow language, and on an article page it sits beside the Polymarket
// prices panel and the article's own market sentence, both of which report prices as
// plain levels and never as crowd behaviour. Tank content never pushes a take, so these
// now say what the price was, over which window, and what the index did - and nothing
// about who was buying or what it means.
//
// Two numbers, and they must not be conflated. The market's own move (fromPrice ->
// toPrice, or rawPoints when the levels weren't recorded) is real and typically 1-10
// points; indexPct is what the index actually did after tag_scale_pct, well under a
// point. Each is attributed to its own subject: the price did X, the index did Y.
// -----------------------------------------------------------------------------------

export interface TickerNewsMoveItem {
    subject: string;   // the story's subject - matchup, player, or side label
    market: string;    // prop.market, to pick the right phrasing family
    outcomeLabel: string;
    pickLabel: string;
    rawPoints: number; // the market's own 3-day repricing, signed
    indexPct: number;  // what the index MOVED on this story, signed (already scaled)
    // The tagged side's price 3 days before tagging and at tagging (0-1), from the tag
    // event's metadata. When both are present the sentence quotes two levels instead of
    // a difference.
    fromPrice?: number | null;
    toPrice?: number | null;
}

// Below this the market didn't really move - most publishes don't coincide with a
// repricing (measured: half of all real tags moved under 0.5 points), and the copy
// must not manufacture drama on a quiet market.
const FLAT_POINTS = 0.5;

// _templateIndex is kept for callers (toNewsSentences passes a position) but no longer
// rotates phrasings: there is one descriptive form per case, so the same move always
// reads the same way.
export function buildNewsSentence(item: TickerNewsMoveItem, displayName: string, _templateIndex: number): string {
    const subject = subjectFor(item);
    const lead = `Over the 3 days before this story was added to ${displayName}`;
    const moved = `${Math.abs(item.indexPct).toFixed(1)}%`;
    const indexClause = item.indexPct > 0
        ? `The index rose ${moved}.`
        : item.indexPct < 0
            ? `The index fell ${moved}.`
            : 'The index was unchanged.';

    if (Math.abs(item.rawPoints) < FLAT_POINTS) {
        return `${lead}, the price on ${subject} held steady, and the index barely changed.`;
    }

    const hasLevels = typeof item.fromPrice === 'number' && typeof item.toPrice === 'number'
        && Number.isFinite(item.fromPrice) && Number.isFinite(item.toPrice);
    if (hasLevels) {
        const from = Math.round((item.fromPrice as number) * 100);
        const to = Math.round((item.toPrice as number) * 100);
        if (from !== to) return `${lead}, the price on ${subject} went from ${from}% to ${to}%. ${indexClause}`;
    }

    const raw = Math.abs(item.rawPoints).toFixed(1);
    const direction = item.rawPoints > 0 ? 'rose' : 'fell';
    return `${lead}, the price on ${subject} ${direction} ${raw} percentage points. ${indexClause}`;
}

export function toNewsSentences(items: TickerNewsMoveItem[], displayName: string): string[] {
    return items.map((it, i) => buildNewsSentence(it, displayName, i));
}

export function toMarketMovers(
    values: TickerValue[],
    series: Record<string, TickerSeriesEvent[]>,
    news: Record<string, TickerNewsItem[]>,
    results: Record<string, TickerResultItem[]>,
    now = Date.now(),
): MarketMoversData {
    // ONE window for the whole section, chosen over every index (parents and children
    // alike, so a family's tiles are sized against the same lens): the tape, the card
    // and the board tile then all print the same "(+1.2%)" for an index. Widens
    // 24h -> 7d -> 30d until something moved; the all-time fallback hands back each
    // index's cumulative value, whose price return is simply the price against its
    // launch baseline.
    const { deltas, info } = chooseWindow(values.map((t) => ({ key: t.key, value: t.value })), series, now);
    const movers = values.map((t, i) => {
        const full = series[t.key] ?? [];
        const windowDelta = deltas[i];
        const ret = priceReturnPct(windowDelta, t.priceScale);
        return {
            key: t.key,
            displayName: t.displayName,
            indexLabel: indexLabelOf(t.ruleType),
            description: t.description,
            value: t.value,
            valueLabel: formatSignedPct(t.value),
            price: t.price,
            priceBaseline: t.priceBaseline,
            priceScale: t.priceScale,
            windowDelta,
            priceReturnPct: ret,
            priceLabel: formatEmber(t.price),
            returnLabel: formatSignedPct(ret),
            quoteLabel: formatQuote(t.price, ret),
            window: info,
            sign: signOf(ret),
            tabOrder: t.tabOrder,
            parentKey: t.parentKey,
            shortLabel: (() => { const r = parseLeagueRule(t.ruleType); return r ? leagueShortCode(r) : null; })(),
            eventCount: t.eventCount,
            series: full.slice(-SERIES_CAP),
            seriesTruncated: full.length > SERIES_CAP,
            news: (news[t.key] ?? []).map((n) => ({
                href: `/the-tank/articles/${n.slug}/`,
                hook: n.hook,
                excerpt: n.excerpt,
                league: n.league,
                dateLabel: utcDateLabel(n.taggedAt),
            })),
            results: toResultSentences(results[t.key] ?? [], t.displayName),
        };
    });
    // Default (no-JS) presentation order: biggest price movers over the window first,
    // tab_order as tiebreak. The marquee re-sorts its own copy back to tab_order
    // (renderTickerTape).
    const byReturnDesc = [...movers].sort((a, b) => b.priceReturnPct - a.priceReturnPct || a.tabOrder - b.tabOrder);
    return { note: RETROSPECTIVE_NOTE, priceNote: PRICE_NOTE, window: info, movers: byReturnDesc };
}

// -----------------------------------------------------------------------------------
// SVG chart - server-computed PRICE line, zero JS. The cumulative series is mapped
// point-by-point through priceFromValue with the ticker's own (baseline, scale), the
// same function the detail page and the trade endpoints use, so the sparkline draws
// the number the card quotes. Hover detail comes from native <title> elements; the
// whole SVG is role="img" with a spoken summary.
// -----------------------------------------------------------------------------------

const CHART_W = 260;
const PLOT_H = 72;      // the plot panel itself
const DATE_BAND = 16;   // x-axis date-tick strip below the panel
const CHART_H = PLOT_H + DATE_BAND;
const PAD = 6;

export function renderTickerChartSvg(vm: MarketMoverVM): string {
    if (vm.series.length === 0) {
        return `<p class="hc-mm-chart-empty">No activity yet.</p>`;
    }

    const params = { baseline: vm.priceBaseline, scale: vm.priceScale };
    // A non-truncated series gets a synthetic origin at the launch price (value 0) so
    // even a single event draws a real line; a truncated one honestly starts mid-flight.
    const launch = priceFromValue(0, params);
    const cums = vm.series.map((e) => e.cumulative);
    const points = (vm.seriesTruncated ? cums : [0, ...cums]).map((v) => priceFromValue(v, params));
    const lo = Math.min(...points);
    const hi = Math.max(...points);
    const span = hi - lo || 1;
    const x = (i: number) => (PAD + (i * (CHART_W - 2 * PAD)) / Math.max(points.length - 1, 1)).toFixed(1);
    const y = (p: number) => (PAD + ((hi - p) * (PLOT_H - 2 * PAD)) / span).toFixed(1);

    const polyline = points.map((p, i) => `${x(i)},${y(p)}`).join(' ');
    // Navy plot panel in the site palette; market colors brightened for the dark
    // background - green up, red down, slate for a flat line. Sign is the window's
    // price return, the same sign the quote beside the chart carries.
    const stroke = vm.sign === 'pos' ? '#3ddc64' : vm.sign === 'neg' ? '#ff6b57' : '#94a3b8';
    // Dashed reference at the launch price when the line crosses it.
    const launchAxis = lo < launch && hi > launch
        ? `<line x1="${PAD}" x2="${CHART_W - PAD}" y1="${y(launch)}" y2="${y(launch)}" stroke="rgba(255,255,255,0.25)" stroke-dasharray="4 4" stroke-width="1"/>`
        : '';

    // One dot per REAL event (the synthetic origin gets none) with a native tooltip
    // carrying the date, the event, the price it left the index at, and the event's
    // own price return; the cumulative index points ride along for the curious.
    const originOffset = vm.seriesTruncated ? 0 : 1;
    const dots = vm.series.map((e, i) => {
        const price = priceFromValue(e.cumulative, params);
        const title = `${utcDateLabel(e.occurredAt)} · ${e.eventType} · ${formatEmber(price)} Ember · ${formatSignedPct(priceReturnPct(e.delta, vm.priceScale))} (index running: ${formatSignedPct(e.cumulative)})`;
        return `<circle cx="${x(i + originOffset)}" cy="${y(price)}" r="2.5" fill="${stroke}"><title>${escapeHtml(title)}</title></circle>`;
    }).join('');

    // Visible date ticks under the plot: first / middle / last real event, deduped
    // when the series is short enough that they collide on the same label.
    const n = vm.series.length;
    const tickIndices = [...new Set([0, Math.floor((n - 1) / 2), n - 1])];
    const seen = new Set<string>();
    const ticks = tickIndices.map((i) => {
        const label = utcShortDateLabel(vm.series[i].occurredAt);
        if (!label || seen.has(label)) return '';
        seen.add(label);
        const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
        const tx = i === 0 ? PAD : i === n - 1 ? CHART_W - PAD : Number(x(i + originOffset));
        return `<text class="hc-mm-tick" x="${tx}" y="${PLOT_H + 12}" text-anchor="${anchor}">${escapeHtml(label)}</text>`;
    }).join('');

    const summary = `${vm.displayName}: ${vm.priceLabel} Ember, ${vm.returnLabel} over ${vm.window.label} (${vm.eventCount} event${vm.eventCount === 1 ? '' : 's'})`;
    return `<svg class="hc-mm-svg" viewBox="0 0 ${CHART_W} ${CHART_H}" role="img" aria-label="${escapeHtml(summary)}">
                <title>${escapeHtml(summary)}</title>
                <rect x="0.75" y="0.75" width="${CHART_W - 1.5}" height="${PLOT_H - 1.5}" rx="8" fill="#160c27" stroke="rgba(47,230,217,0.4)" stroke-width="1.5"/>
                ${launchAxis}
                <polyline fill="none" points="${polyline}" stroke="${stroke}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
                ${dots}
                ${ticks}
            </svg>`;
}

// -----------------------------------------------------------------------------------
// Index board - the whole Exchange at a glance, under the cards. Server-rendered SVG
// for the same reason the sparkline above is: zero JS, no layout shift, no extra
// request, and the labels are real text in the HTML.
//
// SVG also sidesteps what would otherwise block SSR entirely. The interactive TANKDAQ
// board sizes its gutters and tile type in PIXELS measured from a ResizeObserver -
// there is no such measurement on a server. Inside a viewBox every coordinate is
// already resolution-independent, so the same fit-to-width math runs once here in
// viewBox units and scales to whatever width the panel happens to give it.
//
// This is the glanceable version: hover glow and native tooltips, tiles linking
// through. The hover cards and tap-to-reveal live on /tankdaq/indexes/, which the
// caption points at - this is not a second copy of that page.
// -----------------------------------------------------------------------------------

const BOARD_W = 100;
// Nearly 6:5. Taller than the flat board's old 100x70 (and than TANKDAQ's 16:10)
// because the same box now carries fourteen tiles rather than eight: every league
// sub-index is drawn inside its parent, so the two family tiles each hold a header
// plus four children. This board sits in a ~540px column, not full width, and extra
// height is the cheapest way to buy the smallest child area.
const BOARD_H = 84;
const BOARD_GUTTER = 0.7;
// Children sit inside an already-inset parent, so they get a tighter gutter - the
// parent's own inset is doing most of the separating work.
const CHILD_GUTTER = 0.4;
// Below this (viewBox units, ~1.5% of board width) a label is too small to read at the
// panel's real width, so the tile drops its delta line and spends all its height on
// the symbol instead of rendering two illegible rows.
const MIN_LEGIBLE_SIZE = 2.0;
// And below THIS the symbol itself goes, leaving a bordered tile that is still linked
// and still carries its tooltip. Type that doesn't fit is worse than no type: it spills
// over its own tile and collides with the neighbour's, which is exactly what a forced
// minimum size used to produce on the smallest league slices.
const MIN_SYMBOL_SIZE = 1.15;
// A child never needs to shout louder than the family it belongs to.
const CHILD_MAX_SIZE = 3.2;
// Per-character width estimate for Montserrat 900 caps, in ems. Deliberately over the
// true average - a symbol that fits with room to spare beats one that kisses the border.
const CHAR_EM = 0.86;
// Digits, the point and the parentheses of a quote are narrower than caps; still an
// over-estimate for Montserrat 800.
const QUOTE_CHAR_EM = 0.62;
// The quote line's floor: what the old delta line rendered at when the symbol sat
// exactly at MIN_LEGIBLE_SIZE (0.72 of it).
const MIN_QUOTE_SIZE = MIN_LEGIBLE_SIZE * 0.72;

const neonFor = (delta: number): string =>
    delta > 0 ? '61, 220, 100' : delta < 0 ? '255, 107, 87' : '148, 163, 184';

// `window` is the section's window, chosen once in toMarketMovers - the same lens the
// tape and the cards quote, so a tile's "(+1.2%)" is the tape's "(+1.2%)". Tile area,
// colour and stroke all follow the price return over that window.
export function renderIndexBoardSvg(movers: MarketMoverVM[], window: WindowInfo): string {
    if (movers.length === 0) return '';

    const retOf = new Map(movers.map((m) => [m.key, m.priceReturnPct]));
    const maxAbs = Math.max(...movers.map((m) => Math.abs(m.priceReturnPct)), 0);
    const info = window;

    // A ticker whose parent isn't on this board is drawn as a root rather than dropped -
    // an index is never silently missing because of a bad parent_key.
    const present = new Set(movers.map((m) => m.key));
    const isRoot = (m: MarketMoverVM) => !m.parentKey || !present.has(m.parentKey);
    const roots = movers.filter(isRoot);
    const kidsOf = (key: string) => movers.filter((m) => !isRoot(m) && m.parentKey === key);
    const families = roots.map((r) => kidsOf(r.key));

    const layout = layoutNested(
        roots.map((m) => retOf.get(m.key) ?? 0),
        families.map((kids) => kids.map((k) => retOf.get(k.key) ?? 0)),
        BOARD_W,
        BOARD_H,
        { headerRatio: 0.3, headerMin: 5, headerMax: 11, padding: 0.9 },
    );

    // One tile body, sized to whatever rect it was given. Roots that have children pass
    // their header strip as the rect, so the family's symbol and value sit above its
    // children rather than behind them.
    const label = (m: MarketMoverVM, delta: number, r: { x: number; y: number; w: number; h: number }, maxSize: number) => {
        // Fit to BOTH axes. Width was the only constraint while every tile was a root
        // with height to spare; a parent's header strip is wide and short, so without
        // the height term the symbol grows until it overflows its own box.
        const byHeight = (r.h - 0.6) * 0.78;
        const natural = Math.min(Math.sqrt((r.w * r.h) / 100) * 10 + 1.4, byHeight, maxSize);
        const sizeFor = (text: string) => Math.min(natural, (r.w - 1.2) / (text.length * CHAR_EM));
        // Full symbol if it fits; otherwise the league tag, which says the same thing
        // inside a family box at a third of the width. Only when neither fits does the
        // tile go bare - still bordered, still linked, still carrying its tooltip.
        let text = m.displayName;
        let symSize = sizeFor(text);
        if (symSize < MIN_SYMBOL_SIZE && m.shortLabel) {
            text = m.shortLabel;
            symSize = sizeFor(text);
        }
        if (symSize < MIN_SYMBOL_SIZE) return '';
        const deltaSize = symSize * 0.72;
        // The quote line degrades: the full "45.23 (+1.2%)" if it fits, else just the
        // "(+1.2%)", else nothing - the tooltip and aria label always carry the full
        // quote, so a bare tile loses no information.
        const quoteSizeFor = (t: string) => Math.min(deltaSize, (r.w - 1.2) / (t.length * QUOTE_CHAR_EM));
        const quote = [m.quoteLabel, `(${m.returnLabel})`]
            .map((t) => ({ text: t, size: quoteSizeFor(t) }))
            .find((q) => q.size >= MIN_QUOTE_SIZE);
        const showDelta = !!quote && r.h > symSize * 2.2 && symSize >= MIN_LEGIBLE_SIZE;
        const cx = (r.x + r.w / 2).toFixed(2);
        const neon = neonFor(delta);
        return `<text class="hc-mmb-sym" x="${cx}" y="${(r.y + r.h / 2 + (showDelta ? -0.2 : symSize * 0.35)).toFixed(2)}"
                          text-anchor="middle" font-size="${symSize.toFixed(2)}">${escapeHtml(text)}</text>
                    ${showDelta && quote ? `<text class="hc-mmb-quote" x="${cx}" y="${(r.y + r.h / 2 + quote.size * 1.35).toFixed(2)}"
                          text-anchor="middle" font-size="${quote.size.toFixed(2)}" fill="rgb(${neon})">${escapeHtml(quote.text)}</text>` : ''}`;
    };

    const titleOf = (m: MarketMoverVM, parent?: MarketMoverVM) =>
        `${m.displayName}${parent ? ` (${parent.displayName} · ${m.indexLabel})` : ''}: `
        + `${m.priceLabel} Ember (${m.returnLabel} over ${info.label}), index ${m.valueLabel} overall`;

    const tiles = roots.map((m, i) => {
        const r = layout.roots[i];
        const kids = families[i];
        const delta = retOf.get(m.key) ?? 0;
        const mag = maxAbs > 0 ? Math.abs(delta) / maxAbs : 0;
        const neon = neonFor(delta);

        const x = r.x + BOARD_GUTTER;
        const y = r.y + BOARD_GUTTER;
        const w = Math.max(r.w - 2 * BOARD_GUTTER, 0.1);
        const h = Math.max(r.h - 2 * BOARD_GUTTER, 0.1);

        const title = titleOf(m);
        // A family's box is tinted in its own direction so the children read as sitting
        // INSIDE it; a leaf stays pure black against the board, exactly as before.
        const fill = kids.length > 0 ? `rgba(${neon}, 0.08)` : '#000000';
        const stroke = kids.length > 0 ? '0.5' : '0.35';
        // The parent's clickable area is its header strip only. Children are siblings in
        // the SVG, never nested inside the parent's <a> - one link may not contain
        // another, and a click on a child has to reach the child.
        const own = kids.length > 0
            ? { x, y, w, h: Math.max(layout.headers[i] - BOARD_GUTTER, 0.1) }
            : { x, y, w, h };

        return `
                <g class="hc-mmb-family">
                    <rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}"
                          rx="0.6" fill="${fill}" stroke="rgba(${neon}, ${(0.55 + 0.45 * mag).toFixed(2)})" stroke-width="${stroke}"/>
                    <a class="hc-mmb-tile" href="/tankdaq/${escapeHtml(m.key)}/" aria-label="${escapeHtml(title)}">
                        <title>${escapeHtml(title)}</title>
                        <rect x="${own.x.toFixed(2)}" y="${own.y.toFixed(2)}" width="${own.w.toFixed(2)}" height="${own.h.toFixed(2)}" fill="transparent"/>
                        ${label(m, delta, own, Infinity)}
                    </a>
                    ${kids.map((k, j) => {
                        const kr = layout.children[i][j];
                        const kd = retOf.get(k.key) ?? 0;
                        const kmag = maxAbs > 0 ? Math.abs(kd) / maxAbs : 0;
                        const kneon = neonFor(kd);
                        const kx = kr.x + CHILD_GUTTER;
                        const ky = kr.y + CHILD_GUTTER;
                        const kw = Math.max(kr.w - 2 * CHILD_GUTTER, 0.1);
                        const kh = Math.max(kr.h - 2 * CHILD_GUTTER, 0.1);
                        const kt = titleOf(k, m);
                        return `
                    <a class="hc-mmb-tile hc-mmb-child" href="/tankdaq/${escapeHtml(k.key)}/" aria-label="${escapeHtml(kt)}">
                        <title>${escapeHtml(kt)}</title>
                        <rect x="${kx.toFixed(2)}" y="${ky.toFixed(2)}" width="${kw.toFixed(2)}" height="${kh.toFixed(2)}"
                              rx="0.4" fill="#000000" stroke="rgba(${kneon}, ${(0.45 + 0.45 * kmag).toFixed(2)})" stroke-width="0.22"/>
                        ${label(k, kd, { x: kx, y: ky, w: kw, h: kh }, CHILD_MAX_SIZE)}
                    </a>`;
                    }).join('')}
                </g>`;
    }).join('');

    const nested = movers.length - roots.length;
    const summary = `Index board: ${roots.length} indexes sized by their price move over ${info.label}`
        + (nested > 0 ? `, with ${nested} league sub-indexes drawn inside the index each one slices` : '');
    return `
        <div class="hc-mmb">
            <h4 class="hc-mmb-heading">The Board</h4>
            <svg class="hc-mmb-svg" viewBox="0 0 ${BOARD_W} ${BOARD_H}" role="img" aria-label="${escapeHtml(summary)}">
                <title>${escapeHtml(summary)}</title>
                <rect x="0" y="0" width="${BOARD_W}" height="${BOARD_H}" fill="#000000"/>
                ${tiles}
            </svg>
            <p class="hc-mmb-caption">Tile size tracks the price move over ${escapeHtml(info.label)}${info.widened ? ' (nothing moved in the last 24 hours)' : ''}${nested > 0 ? ' &middot; league slices sit inside the index they slice' : ''} &middot; <a href="/tankdaq/indexes/">Open the full board</a></p>
        </div>`;
}

// -----------------------------------------------------------------------------------
// The reusable presentational core: one ticker's card. No section chrome, no session
// logic, no invest/divest UI - a future stock-market page wraps this, never forks it.
// -----------------------------------------------------------------------------------

export function renderMarketMoverCard(vm: MarketMoverVM, role?: 'gainer' | 'loser'): string {
    const newsBlock = vm.news.length === 0
        ? `<p class="hc-mm-news-empty">No tagged storylines yet.</p>`
        : `<ul class="hc-mm-news-list">${vm.news.map((n) => `
                <li>
                    <a href="${escapeHtml(n.href)}">${escapeHtml(n.hook)}</a>
                    ${n.excerpt ? `<p class="hc-mm-excerpt">${escapeHtml(n.excerpt)}</p>` : ''}
                    <span class="hc-mm-news-meta">${escapeHtml(n.league)}${n.dateLabel ? ` · ${escapeHtml(n.dateLabel)}` : ''}</span>
                </li>`).join('')}
            </ul>`;

    const resultsBlock = vm.results.length === 0
        ? `<p class="hc-mm-results-empty">No settled results yet.</p>`
        : `<ul class="hc-mm-results-list">${vm.results.map((r) => `
                <li><span class="hc-mm-result-chip is-${r.won ? 'pos' : 'neg'}">${escapeHtml(vm.displayName)}</span> ${escapeHtml(r.text)}</li>`).join('')}
            </ul>`;

    return `
        <article class="hc-mm-card" data-ticker="${escapeHtml(vm.key)}" data-sign="${vm.sign}"${role ? ` data-mm-role="${role}"` : ''}>
            <div class="hc-mm-top">
                <header class="hc-mm-head">
                    <h3 class="hc-mm-title">
                        <a class="hc-mm-title-link" href="/tankdaq/${escapeHtml(vm.key)}/">
                            <span class="hc-mm-index">${escapeHtml(vm.indexLabel)}</span>
                            <span class="hc-mm-name">(${escapeHtml(vm.displayName)})</span>
                        </a>
                    </h3>
                    <p class="hc-mm-desc">${escapeHtml(vm.description)}</p>
                </header>
                <div class="hc-mm-chartrow">
                    <span class="hc-mm-quote is-${vm.sign}" data-quote-for="${escapeHtml(vm.key)}"><span class="hc-mm-price">${escapeHtml(vm.priceLabel)}</span> <span class="hc-mm-return">(${escapeHtml(vm.returnLabel)})</span></span>
                    <span class="hc-mm-quote-label">Ember price &middot; ${escapeHtml(vm.window.short)} change</span>
                    <div class="hc-mm-chart">${renderTickerChartSvg(vm)}</div>
                </div>
            </div>
            <div class="hc-mm-news">
                <h4 class="hc-mm-news-heading">Recent News</h4>
                ${newsBlock}
            </div>
            <div class="hc-mm-results">
                <h4 class="hc-mm-results-heading">Recent Results</h4>
                ${resultsBlock}
            </div>
        </article>`;
}

// -----------------------------------------------------------------------------------
// Marquee: continuously-scrolling tape under the header. Two identical groups built
// from the same string; the track translates -50% for a seamless loop. The duplicate
// is aria-hidden, and reduced-motion turns the whole thing into a static scrollable
// row with the duplicate removed (see marketMoversStyles).
// -----------------------------------------------------------------------------------

export function renderTickerTape(movers: MarketMoverVM[]): string {
    if (movers.length === 0) return '';
    // Top-level indexes only. The tape is a fixed-duration scroll, so adding the eight
    // league sub-indexes would nearly double its length and slow every symbol's turn on
    // screen - and a headline tape wants headlines. The slices are one click away on
    // the board, which draws them inside their parent.
    const headline = movers.filter((m) => !m.parentKey);
    // Marquee reads in tab_order (marketing order), not the section's return-desc order -
    // the quote string comes from the same VM the card prints, so the numbers can't
    // disagree. Each item trails its ticker's newest settled slate game as a sentence
    // (results[0] - same VM the cards render), in a deliberately quieter style.
    const items = [...(headline.length > 0 ? headline : movers)].sort((a, b) => a.tabOrder - b.tabOrder).map((m) => {
        const headline = m.results[0]
            ? ` <span class="hc-tape-headline">${escapeHtml(m.results[0].text)}</span>`
            : '';
        return `
                <li class="hc-tape-item is-${m.sign}"><a class="hc-tape-link" href="/tankdaq/${escapeHtml(m.key)}/">${escapeHtml(m.displayName)}</a> <span class="hc-mm-quote is-${m.sign}">${escapeHtml(m.quoteLabel)}</span>${headline}</li>`;
    }).join('');
    const group = (hidden: boolean) => `<ul class="hc-tape-group"${hidden ? ' aria-hidden="true"' : ''}>${items}</ul>`;
    return `
        <div class="hc-ticker-tape" aria-label="Ember prices — how tagged storylines have gone, not a forecast">
            <div class="hc-tape-track">
                ${group(false)}
                ${group(true)}
            </div>
        </div>`;
}

// -----------------------------------------------------------------------------------
// The homepage section: heading + visible retrospective note + (JS-revealed) tab strip
// + card grid. Gainers/losers filtering is pure CSS keyed off data-mm-view; the island
// only flips the attribute and aria-pressed.
// -----------------------------------------------------------------------------------

export function renderMarketMoversSection(data: MarketMoversData): string {
    // Only the single top mover and (when one exists) the single top loser render -
    // one card per tab, so the section stays compact. movers is sorted by price return
    // over the section window: gainer = first; loser = last, only if its price actually
    // fell. Server default
    // view is "all" so the no-JS page shows both cards; the island reveals the tab
    // strip and flips the view to "gainers" (the mockup's default) in the same pass -
    // the gainers button ships aria-pressed to match that JS state.
    // Headline cards go to top-level indexes, same call the tape makes: a league slice
    // is a subset of its parent, so letting one take the headline would report a move
    // the parent is already reporting, from the narrower of the two.
    const headline = data.movers.filter((m) => !m.parentKey);
    const ranked = headline.length > 0 ? headline : data.movers;
    const gainer = ranked[0];
    const last = ranked[ranked.length - 1];
    const loser = last && last !== gainer && last.priceReturnPct < 0 ? last : null;
    const cards = gainer
        ? renderMarketMoverCard(gainer, 'gainer') + (loser ? renderMarketMoverCard(loser, 'loser') : '')
        : '';
    // The board sits AFTER the grid, never inside it: the gainers/losers rules are
    // scoped to .hc-mm-grid's descendants, so a sibling can't be hidden by a tab. It
    // also renders in the empty branch - with no card to show, the whole-board view is
    // the one thing still worth showing. The price note follows it in both branches:
    // every surface that prints an Ember price ships PRICE_NOTE (ticker-price.ts), and
    // one line under the board covers the tape, the cards and the tiles together.
    const board = renderIndexBoardSvg(data.movers, data.window);
    const priceNote = `<p class="hc-mm-price-note">${escapeHtml(data.priceNote)}</p>`;
    const body = !gainer
        ? `<p class="hc-mm-empty">No ticker activity yet — storylines get tagged as they publish.</p>${board}${priceNote}`
        : `
        <div class="hc-mm-tabs" data-hc-mm-tabs hidden>
            <button type="button" class="hc-mm-tab is-gainers" data-mm-view="gainers" aria-pressed="true">Top Gainers</button>
            <button type="button" class="hc-mm-tab is-losers" data-mm-view="losers" aria-pressed="false">Top Losers</button>
        </div>
        <div class="hc-mm-grid" data-hc-mm-grid data-mm-view="all">${cards}</div>
        ${board}${priceNote}`;

    return `
        <section id="market-movers" class="hc-section" aria-labelledby="hc-mm-heading">
            <h2 id="hc-mm-heading" class="hc-visually-hidden">Market Movers</h2>
            <div class="hc-mm-band">
                <img class="hc-mm-logo" src="/assets/images/market-movers-logo.webp" alt="Market Movers" width="338" height="249" loading="lazy">
                <p class="hc-section-sub hc-mm-note">Real sport moments are the fuel that forges the world of Heatchecks. Each moment is tied to an index. Storylines and results affect each index differently! If you got a read on a market, head over to <a href="/tankdaq/">TANKDAQ</a> to invest your Ember.</p>
            </div>
            ${body}
        </section>`;
}

// Appended into homepageStyles() output (render.ts). Mockup palette: yellow marquee
// band (site gold, black rules top and bottom) with outlined sign-colored text
// (market green up / red down), folder-style green/salmon tab buttons, light-blue
// index cards and maroon serif news entries - with the plot itself restyled to the
// site's navy/teal (top-right of the card, visible date ticks below the panel). The
// page background itself stays untouched.
export function marketMoversStyles(): string {
    return `
        .hc-ticker-tape { overflow: hidden; margin: 0.9rem -1.25rem 0; background: var(--hc-gold, #ffc72c); border-top: 3px solid #000000; border-bottom: 3px solid #000000; }
        .hc-tape-track { display: flex; width: max-content; animation: hc-tape 60s linear infinite; }
        .hc-tape-group {
            list-style: none; display: flex; gap: 2.25rem; margin: 0; padding: 0.5rem 1.5rem 0.55rem;
            white-space: nowrap;
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800;
            font-size: 1.45rem; letter-spacing: 0.03em; text-transform: uppercase;
        }
        .hc-tape-item, .hc-tape-item .hc-mm-quote { font-weight: 800; }
        /* The quote ("45.23 (+1.2%)") is about twice the old value's length - a size
           down keeps every symbol's turn on screen the same length. */
        .hc-tape-item .hc-mm-quote { font-size: 1.15rem; white-space: nowrap; }
        .hc-tape-item.is-pos, .hc-tape-item.is-pos .hc-mm-quote { color: #2f9e1e; }
        .hc-tape-item.is-neg, .hc-tape-item.is-neg .hc-mm-quote { color: #e33a24; }
        .hc-tape-item.is-zero, .hc-tape-item.is-zero .hc-mm-quote { color: #5b6572; }
        /* The parenthesised return sits a step under the price wherever a quote is
           split into its two parts (the card); the tape prints the joined string. */
        .hc-mm-return { font-size: 0.82em; }
        .hc-mm-quote-label {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.62rem;
            letter-spacing: 0.1em; text-transform: uppercase; color: #10203a; margin: -0.1rem 0 0.2rem;
        }
        .hc-mm-price-note { margin: 0.5rem 0 0; font-size: 0.72rem; line-height: 1.4; color: rgba(255,255,255,0.55); }
        .hc-tape-item {
            text-shadow:
                1.5px 0 0 #fff, -1.5px 0 0 #fff, 0 1.5px 0 #fff, 0 -1.5px 0 #fff,
                1px 1px 0 #fff, -1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff,
                3px 3px 4px rgba(0,0,0,0.35);
        }
        /* Dark ink for the headline sentence - the old cream vanished against the
           yellow band. */
        .hc-tape-item .hc-tape-headline {
            font-size: 0.95rem; font-weight: 600; letter-spacing: 0.01em;
            color: #1a1200;
            text-shadow: none;
            margin-left: 0.35rem;
        }
        @keyframes hc-tape { to { transform: translateX(-50%); } }

        /* Centered below 1024px, where .hc-mm-band is a plain block and the logo sits
           on its own line above the note. The desktop rule inside the min-width:1024px
           block resets this margin - there the band is a flex row and the logo is its
           left-hand item, so it stays put. */
        .hc-mm-logo { display: block; width: clamp(180px, 42vw, 300px); height: auto; margin: 0 auto 0.25rem; }
        /* The TANKDAQ link inside the note - gold reads on the dark page background
           (mobile) and the black band (desktop) alike. */
        .hc-mm-note a { color: var(--hc-gold); font-weight: 700; }

        .hc-mm-tabs { display: flex; gap: 0.6rem; margin: 0.75rem 0 0; position: relative; z-index: 1; }
        /* Same dotted-LED face as the Tanks panel title (#tanks h2 in homepage/
           render.ts) so the two panels' headers read as one family. That font is
           requested by a homepage-only <link> in renderHomepage - safe here because
           Market Movers only ever renders on the homepage; anywhere else this would
           silently fall back to Courier. */
        .hc-mm-tab {
            font-family: 'Bitcount Grid Single', 'Courier New', monospace; font-weight: 700;
            font-size: clamp(0.95rem, 3.2vw, 1.25rem); letter-spacing: 0.02em; text-transform: uppercase;
            cursor: pointer; color: #ffffff; border: none;
            border-radius: 14px 14px 0 0; padding: 0.55rem 1.3rem 0.5rem;
            text-shadow: 1.5px 0 0 #b3261e, -1.5px 0 0 #b3261e, 0 1.5px 0 #b3261e, 0 -1.5px 0 #b3261e,
                         1px 1px 0 #b3261e, -1px -1px 0 #b3261e, 1px -1px 0 #b3261e, -1px 1px 0 #b3261e;
            opacity: 0.68;
        }
        .hc-mm-tab.is-gainers { background: #55901f; }
        .hc-mm-tab.is-losers { background: #f0705f; }
        .hc-mm-tab[aria-pressed="true"] { opacity: 1; box-shadow: 0 -4px 12px rgba(255,255,255,0.18); }
        .hc-mm-tab:focus-visible { outline: 2px solid var(--hc-teal); outline-offset: 2px; }

        /* Card title + tape symbols link to the ticker's TANKDAQ detail page - keep
           the existing type treatment, reveal linkness on hover only. */
        .hc-mm-title-link { color: inherit; text-decoration: none; }
        .hc-mm-title-link:hover .hc-mm-index { text-decoration: underline; }
        .hc-tape-link { color: inherit; text-decoration: none; }
        .hc-tape-link:hover { text-decoration: underline; }

        .hc-mm-grid { display: flex; flex-direction: column; gap: 1.1rem; }
        .hc-mm-grid[data-mm-view="gainers"] .hc-mm-card[data-mm-role="loser"] { display: none; }
        .hc-mm-grid[data-mm-view="losers"] .hc-mm-card[data-mm-role="gainer"] { display: none; }
        /* CSS-only empty state when the losers tab has no card to show. */
        .hc-mm-grid[data-mm-view="losers"]:not(:has(.hc-mm-card[data-mm-role="loser"]))::after {
            content: 'No losers right now.'; display: block; padding: 1rem 0.25rem;
            font-size: 0.85rem; color: rgba(255,255,255,0.6);
        }

        .hc-mm-card {
            display: flex; flex-direction: column; gap: 0.6rem;
            background: #5ec1ee; color: #10203a;
            border-radius: 0 14px 14px 14px; padding: 1.15rem 1.15rem 1.3rem;
        }
        /* Card header row: title/description left, chart + % pinned top-right. */
        .hc-mm-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.75rem 1.25rem; flex-wrap: wrap; }
        .hc-mm-head { flex: 1 1 220px; min-width: 0; display: flex; flex-direction: column; }
        .hc-mm-title { display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; margin: 0; }
        .hc-mm-index {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.9rem;
            letter-spacing: 0.14em; text-transform: uppercase; color: #0b1526;
        }
        .hc-mm-name { font-family: 'Nunito', sans-serif; font-weight: 700; font-size: 0.95rem; color: #0b1526; }
        .hc-mm-desc {
            align-self: flex-start; margin: 0.1rem 0 0;
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.68rem;
            letter-spacing: 0.12em; text-transform: uppercase; color: #10203a;
            background: rgba(255,255,255,0.92); border-radius: 6px; padding: 0.28rem 0.6rem;
        }
        /* Slim column, % above the plot, hugging the card's top-right corner. */
        .hc-mm-chartrow { display: flex; flex-direction: column; align-items: flex-end; gap: 0.15rem; margin: 0 0 0 auto; flex: 0 1 210px; }
        .hc-mm-chart { width: 100%; min-width: 150px; max-width: 210px; }
        /* Mobile: the chart row spans the card with the plot centered; the % keeps
           its right-side placement. */
        @media (max-width: 1023px) {
            .hc-mm-chartrow { flex: 1 1 100%; margin: 0; }
            .hc-mm-chart { align-self: center; max-width: 240px; }
        }
        .hc-mm-svg { display: block; width: 100%; height: auto; }
        .hc-mm-tick {
            font-family: 'Nunito', sans-serif; font-weight: 800; font-size: 9px;
            letter-spacing: 0.04em; fill: #10203a;
        }
        .hc-mm-chartrow .hc-mm-quote {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 900;
            font-size: clamp(1.15rem, 4vw, 1.5rem); flex-shrink: 0; white-space: nowrap;
            text-shadow:
                1.5px 0 0 #fff, -1.5px 0 0 #fff, 0 1.5px 0 #fff, 0 -1.5px 0 #fff,
                1px 1px 0 #fff, -1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff,
                2.5px 2.5px 3px rgba(0,0,0,0.35);
        }
        .hc-mm-chartrow .hc-mm-quote.is-pos { color: #2f9e1e; }
        .hc-mm-chartrow .hc-mm-quote.is-neg { color: #e33a24; }
        .hc-mm-chartrow .hc-mm-quote.is-zero { color: #5b6572; }
        .hc-mm-chart-empty {
            font-size: 0.82rem; font-weight: 800; color: rgba(255,255,255,0.85); margin: 0;
            background: #160c27; border: 1.5px solid rgba(47,230,217,0.4); border-radius: 8px; padding: 0.8rem 0.9rem;
        }
        .hc-mm-news-empty { font-size: 0.85rem; color: #24344f; margin: 0; font-family: 'Nunito', sans-serif; }
        .hc-mm-empty { font-size: 0.85rem; color: rgba(255,255,255,0.6); margin: 1rem 0 0; }
        .hc-mm-news-heading {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.85rem;
            letter-spacing: 0.14em; text-transform: uppercase; color: #0b1526; margin: 0.4rem 0 0.45rem;
        }
        .hc-mm-news-list { list-style: none; margin: 0; padding: 0 0 0 0.35rem; display: flex; flex-direction: column; gap: 0.7rem; }
        .hc-mm-news-list a {
            font-family: 'Nunito', sans-serif; font-weight: 700; font-size: 0.95rem;
            line-height: 1.35; color: #7a1f1f; text-decoration: none;
        }
        .hc-mm-news-list a:hover { text-decoration: underline; }
        .hc-mm-excerpt {
            font-family: 'Nunito', sans-serif; font-size: 0.85rem; line-height: 1.45;
            color: #8b3a3a; margin: 0.15rem 0 0.2rem 1rem;
        }
        .hc-mm-news-meta {
            display: block; margin-left: 1rem; font-family: 'Montserrat', 'Nunito', sans-serif; font-size: 0.66rem; font-weight: 800;
            letter-spacing: 0.08em; text-transform: uppercase; color: #24344f;
        }

        .hc-mm-results-heading {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.85rem;
            letter-spacing: 0.14em; text-transform: uppercase; color: #0b1526; margin: 0.6rem 0 0.45rem;
        }
        .hc-mm-results {
            margin: 0.3rem 0 0; padding: 0.65rem 0.75rem 0.7rem; border-radius: 0 8px 8px 0;
            background: rgba(11, 21, 38, 0.06); border-left: 3px solid #94a3b8;
        }
        .hc-mm-card[data-sign="pos"] .hc-mm-results { border-left-color: #2f9e1e; background: rgba(47, 158, 30, 0.1); }
        .hc-mm-card[data-sign="neg"] .hc-mm-results { border-left-color: #e33a24; background: rgba(227, 58, 36, 0.1); }
        .hc-mm-results-heading { margin-top: 0; }
        .hc-mm-results-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.55rem; }
        .hc-mm-results-list li {
            font-family: 'Nunito', sans-serif; font-size: 0.9rem; line-height: 1.4; color: #24344f;
        }
        .hc-mm-result-chip {
            display: inline-block; font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800;
            font-size: 0.72rem; letter-spacing: 0.03em; text-transform: uppercase; color: #ffffff;
            border-radius: 999px; padding: 0.1rem 0.5rem; margin: 0 0.3rem 0.15rem 0; vertical-align: middle;
        }
        .hc-mm-result-chip.is-pos { background: #2f9e1e; }
        .hc-mm-result-chip.is-neg { background: #e33a24; }
        .hc-mm-results-empty { font-size: 0.85rem; color: #24344f; margin: 0; font-family: 'Nunito', sans-serif; }

        /* The index board, under the cards. The SVG carries its own geometry, so this
           is only chrome: a teal-framed black plate matching the TANKDAQ board. Sized
           by the SVG's own aspect ratio - no fixed height, no measurement. */
        .hc-mmb { margin: 1.1rem 0 0; }
        /* Teal on the dark page (mobile/tablet), dark on the white desktop panel - the
           board is section-level, so unlike the card headings it doesn't sit on the
           light-blue card ground and can't borrow its colour. */
        .hc-mmb-heading {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.85rem;
            letter-spacing: 0.14em; text-transform: uppercase; color: var(--hc-teal); margin: 0 0 0.45rem;
        }
        .hc-mmb-svg {
            display: block; width: 100%; height: auto;
            background: #000000; border: 2px solid rgba(47, 230, 217, 0.35); border-radius: 10px;
        }
        .hc-mmb-sym { font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 900; fill: #ffffff; }
        .hc-mmb-quote { font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; }
        /* Hover lives on the <a>, so the whole tile lights up rather than just the
           glyph the cursor happens to be over. */
        .hc-mmb-tile { cursor: pointer; transition: filter 0.16s ease; }
        .hc-mmb-tile:hover, .hc-mmb-tile:focus-visible { filter: brightness(1.45); outline: none; }
        .hc-mmb-caption {
            margin: 0.45rem 0 0; font-size: 0.72rem; line-height: 1.4;
            color: rgba(255,255,255,0.55);
        }
        .hc-mmb-caption a { color: var(--hc-gold); font-weight: 700; }
        @media (prefers-reduced-motion: reduce) {
            .hc-mmb-tile { transition: none; }
        }

        /* Framed at every viewport - not just inside the desktop-only white-panel
           treatment below - so this and #tanks read as matching game panels side by
           side. Light-blue frame (the card blue) against the black header band.
           box-sizing:border-box (global reset) keeps the added border from disturbing
           the desktop grid's stretch-alignment between the two panels. */
        #market-movers {
            border: 3px solid #5ec1ee;
            border-radius: 6px;
            padding: 0 1rem 1.1rem;
            overflow: hidden;
        }

        /* Base (mobile): the band wrapper is a plain block - zero visual change from
           the pre-band markup. */
        .hc-mm-band { display: block; }

        @media (min-width: 760px) and (max-width: 1023px) {
            .hc-mm-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1.25rem 2rem; }
            .hc-mm-card { border-radius: 14px; }
            .hc-mm-card:first-child { border-radius: 0 14px 14px 14px; }
        }

        /* Desktop (mockup): Market Movers as a white panel in the right grid column -
           violet header band (logo + note box), tabs beneath, card content on white. */
        @media (min-width: 1024px) {
            /* border/border-radius/overflow now come from the base rule above -
               desktop only adds the white fill, the taller bottom padding, and the
               grid-row top offset. */
            #market-movers {
                margin-top: 1.5rem;
                /* Black, so the light-blue cards sit ON it rather than being a tint
                   inside a light panel - the same figure/ground the black header band
                   and the #5ec1ee frame already set up. Everything tuned for a light
                   ground (dark headings, maroon news links, sign-coloured rails) lives
                   INSIDE the cards, which stay light blue, so none of it is affected;
                   the only things that sat directly on the old light panel were the
                   board heading and caption, whose light-panel overrides are dropped
                   below. */
                background: #000000;
                padding: 0 1rem 1.25rem;
            }
            .hc-mm-band {
                display: flex; align-items: center; gap: 1rem;
                background: #000000;
                /* The band and the panel are both black now, so the header would run
                   straight into the tabs with no edge. This line is that edge - same
                   #5ec1ee as the panel frame, bled to the panel's inner width by the
                   negative side margins below. */
                border-bottom: 3px solid #5ec1ee;
                margin: 0 -1rem 0.25rem; padding: 0.6rem 1rem;
            }
            .hc-mm-logo { width: clamp(140px, 14vw, 190px); margin: 0; flex-shrink: 0; }
            .hc-mm-note {
                margin: 0; color: #ffffff; font-size: 0.78rem;
                background: rgba(255,255,255,0.14); border: 1px solid rgba(255,255,255,0.35);
                border-radius: 8px; padding: 0.45rem 0.7rem;
            }
            .hc-mm-tabs { margin-top: 0.5rem; }
            /* No background override any more: the card keeps the base solid #5ec1ee.
               The old translucent tints existed only to separate a blue card from a
               light panel; over black a 0.42 blue would render dark and muddy, and the
               point of the black panel is that the light blue reads as light blue. */
            .hc-mm-card {
                padding: 1rem 1.15rem 1.2rem; border-radius: 10px;
                border-left: 5px solid #94a3b8;
            }
            .hc-mm-card[data-sign="pos"] { border-left-color: #2f9e1e; }
            .hc-mm-card[data-sign="neg"] { border-left-color: #e33a24; }
            /* .hc-mm-desc, .hc-mmb-caption and .hc-mmb-heading all had light-panel
               overrides here. The desc chip sits on the card, which is solid #5ec1ee
               again, so the base 0.92 white is the tuned value once more; the board
               heading and caption sit directly on the panel, which is now black - the
               same ground they have on mobile - so the base teal/white-at-55% read
               correctly and the dark overrides would have made them invisible. */
        }

        @media (prefers-reduced-motion: reduce) {
            .hc-tape-track { animation: none; }
            .hc-tape-group[aria-hidden="true"] { display: none; }
            .hc-ticker-tape { overflow-x: auto; }
        }
    `;
}
