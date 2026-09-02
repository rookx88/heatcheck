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
import { chooseWindow } from './ticker-window';
import { layoutNested } from './treemap';
import { leagueShortCode, parseLeagueRule } from './league-rules';
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
    value: number;
    valueLabel: string;  // formatSignedPct(value) - the ONE string both tape and card show
    sign: 'pos' | 'neg' | 'zero';
    tabOrder: number;    // marquee/marketing order; the section grid sorts by value instead
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
    results: MarketMoverResultVM[]; // "Recent Results" sentences, newest first
}

export interface MarketMoverResultVM {
    text: string; // already-composed sentence
    won: boolean; // this specific result's own outcome - independent of the card's overall sign
}

export interface MarketMoversData {
    note: string;
    movers: MarketMoverVM[];
}

// SSR series cap: the homepage renders at most this many trailing events per ticker.
// The cumulative values come from SQL, so a truncated line honestly starts mid-flight
// (no synthetic origin is prepended when truncated - see renderTickerChartSvg).
const SERIES_CAP = 60;

export function emptyMarketMovers(): MarketMoversData {
    return { note: RETROSPECTIVE_NOTE, movers: [] };
}

// The one formatter for a ticker value, used by the marquee, the card header, and the
// SVG titles - identical strings everywhere by construction. Real minus (U+2212);
// -0 normalizes to "+0.0%".
export function formatSignedPct(v: number): string {
    const normalized = Object.is(v, -0) ? 0 : v;
    return `${normalized >= 0 ? '+' : '−'}${Math.abs(normalized).toFixed(1)}%`;
}

function signOf(v: number): 'pos' | 'neg' | 'zero' {
    if (v > 0) return 'pos';
    if (v < 0) return 'neg';
    return 'zero';
}

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

// "Lakers" -> "Lakers'"; "Celtics" -> "Celtics'"; "LeBron James" -> "LeBron James's" - the
// standard English rule (names already ending in s just take the bare apostrophe).
function possessive(name: string): string {
    return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

// A side label that names a side rather than a team/player ("Over", "Under 37.5",
// "Yes"/"No" on Kalshi markets) - never a sentence subject: "with Under's recent win"
// reads broken. Word-boundary match so "Over 37.5" counts but "Overton" wouldn't.
const GENERIC_SIDE_LABEL = /^(over|under|yes|no)\b/i;

// The "Team Name" / "Player" subject for a settled result: a player prop's real subject is
// prop.player itself; a game-line market's prop.player is a matchup fallback ("Away vs.
// Home" - tank-providers.ts), so the tagged side's own outcome label (a real team name for
// moneylines/spreads) is the correct subject there instead - EXCEPT totals-style markets,
// whose labels are generic side words: those pull the matchup name from prop.player. Same
// "_player_" substring test formatMarketLabel() (tank-deck-format.ts) already uses.
function subjectFor(item: TickerResultItem): string {
    const isPlayerProp = /_player_/.test(item.market);
    if (isPlayerProp) return item.player;
    if (!item.outcomeLabel || GENERIC_SIDE_LABEL.test(item.outcomeLabel)) return item.player;
    return item.outcomeLabel;
}

// The market types whose sides are Over/Under on a game score (mirrors
// GAME_LINE_MARKET_TYPES' totals subset in tank-providers.ts).
const TOTALS_MARKET_TYPES = ['totals', 'team_totals'];

// 'Over' | 'Under' from the tagged side's labels (outcome label first, then the call's
// pick label); null when the market words its sides some other way (e.g. Kalshi Yes/No -
// those fall through to the generic game-line sentences).
function totalsSideWord(item: TickerResultItem): 'Over' | 'Under' | null {
    for (const label of [item.outcomeLabel, item.pickLabel]) {
        if (/^over\b/i.test(label)) return 'Over';
        if (/^under\b/i.test(label)) return 'Under';
    }
    return null;
}

// One newsline-style sentence per settled result, rotating through 3 phrasings so a card's
// results list doesn't read as a repeated mad-lib. All three read the SAME two facts (won,
// |delta| in points - deliberately not the %-formatted valueLabel per the "points, not
// percent" ask) off the event; only the copy differs.
//
// Three market shapes, three sentence families (user feedback 2026-08-29: an Over can't
// "win", a matchup can't "lose", and "Over 8.5 don't deliver" fails agreement):
//   totals       - the side hits or misses IN a game; the game clears or stays under.
//   player props - the player is the singular animate subject; the pick label ("Over 1.5
//                  hits") is what they deliver on or miss, never the subject itself.
//   team lines   - the tagged team is the subject (original templates, plural verbs).
function buildResultSentence(item: TickerResultItem, displayName: string, templateIndex: number): string {
    const tickerWord = displayName.replace(/^\$/, '');
    const points = Math.abs(item.delta).toFixed(1);
    const t = templateIndex % 3;

    const totalsSide = TOTALS_MARKET_TYPES.includes(item.market) ? totalsSideWord(item) : null;
    if (totalsSide) {
        const matchup = item.player; // the game-line matchup fallback ("Away vs. Home")
        const line = (item.pickLabel.match(/\d+(?:\.\d+)?/) ?? [])[0];
        if (t === 0) {
            return `${displayName} ${item.won ? 'climbs' : 'sinks'} ${points} points as the ${totalsSide} ${item.won ? 'hits' : 'misses'} in ${matchup}.`;
        }
        if (t === 1) {
            return `The ${tickerWord} index experiences a local ${item.won ? 'high' : 'low'} as ${item.pickLabel || `the ${totalsSide}`} ${item.won ? 'hits' : 'misses'} in ${matchup}.`;
        }
        // Whether the GAME cleared the number follows from side + outcome: an Over
        // winning and an Under losing both mean the total was cleared.
        const cleared = (totalsSide === 'Over') === item.won;
        const gameAction = cleared ? 'clears the total' : line ? `stays under ${line}` : 'stays under the total';
        return item.won
            ? `Buyers applaud as ${matchup} ${gameAction}. The market climbs ${points} points.`
            : `Buyers up in arms as ${matchup} ${gameAction}. The market falls ${points} points.`;
    }

    if (/_player_/.test(item.market)) {
        const player = item.player;
        if (t === 0) {
            return `${displayName} ${item.won ? 'climbs' : 'sinks'} ${points} points with ${possessive(player)} recent ${item.won ? 'win' : 'loss'}.`;
        }
        if (t === 1) {
            return item.pickLabel
                ? `The ${tickerWord} index experiences a local ${item.won ? 'high' : 'low'} as ${player} ${item.won ? 'delivers on' : 'misses'} ${item.pickLabel}.`
                : `The ${tickerWord} index experiences a local ${item.won ? 'high' : 'low'} as ${player} ${item.won ? 'delivers' : 'comes up short'}.`;
        }
        return item.won
            ? `Buyers applaud heroics as ${player} impresses. The market climbs ${points} points.`
            : `Buyers up in arms as ${player} fails to impress. The market falls ${points} points.`;
    }

    const subject = subjectFor(item);
    // A pickLabel with substance beats the subject; a bare side word ("Under", "Yes")
    // doesn't - "as Under deliver" reads as broken as the possessive.
    const pickLabelIsBareSide = /^(over|under|yes|no)$/i.test(item.pickLabel.trim());
    const pick = (item.pickLabel && !pickLabelIsBareSide) ? item.pickLabel : subject;
    switch (t) {
        case 0:
            return `${displayName} ${item.won ? 'climbs' : 'sinks'} ${points} points with ${possessive(subject)} recent ${item.won ? 'win' : 'loss'}.`;
        case 1:
            return `The ${tickerWord} index experiences a local ${item.won ? 'high' : 'low'} as ${pick} ${item.won ? 'deliver' : "don't deliver"}.`;
        default:
            return item.won
                ? `Buyers applaud heroics as ${pick} impress. The market climbs ${points} points.`
                : `Buyers up in arms as ${pick} fails to impress. The market falls ${points} points.`;
    }
}

// The one sentence-composition entry point, shared by toMarketMovers below and the
// TANKDAQ detail endpoint (functions/api/tickers/detail.ts) - the same result reads
// the same everywhere it appears.
export function toResultSentences(items: TickerResultItem[], displayName: string): MarketMoverResultVM[] {
    return items.map((r, i) => ({ text: buildResultSentence(r, displayName, i), won: r.won }));
}

// -----------------------------------------------------------------------------------
// News sentences - the article-page counterpart to the result sentences above.
//
// A tag is a different kind of event from a settle: it is the market REPRICING on a
// story, before any game has been played, so none of the win/loss templates above
// apply. These read like investors reacting to a stock story.
//
// Two numbers, and they must not be conflated. rawPoints is the market's real 3-day
// move (vivid, typically 1-10 points); indexPct is what the index actually did after
// tag_scale_pct, which is well under a point. Quoting the raw number as the index's
// move would overstate it, so every template below attributes each number to its own
// subject: the market moved X, the index moved Y.
// -----------------------------------------------------------------------------------

export interface TickerNewsMoveItem {
    subject: string;   // the story's subject - matchup, player, or side label
    market: string;    // prop.market, to pick the right phrasing family
    outcomeLabel: string;
    pickLabel: string;
    rawPoints: number; // the market's own 3-day repricing, signed
    indexPct: number;  // what the index MOVED on this story, signed (already scaled)
}

// Below this the market didn't really move - most publishes don't coincide with a
// repricing (measured: half of all real tags moved under 0.5 points), and the copy
// must not manufacture drama on a quiet market.
const FLAT_POINTS = 0.5;

export function buildNewsSentence(item: TickerNewsMoveItem, displayName: string, templateIndex: number): string {
    const tickerWord = displayName.replace(/^\$/, '');
    const raw = Math.abs(item.rawPoints).toFixed(1);
    // Magnitude only - the direction verb carries the sign, and the tile beside this
    // sentence already shows where the index STANDS. Saying "climbs to -41.8%" would
    // read as a contradiction: the story moved it up, the index level is negative.
    const moved = `${Math.abs(item.indexPct).toFixed(1)}%`;
    const subject = subjectFor({
        player: item.subject, market: item.market, outcomeLabel: item.outcomeLabel,
        pickLabel: item.pickLabel, tickerKey: '', won: false, delta: 0, occurredAt: '',
    });
    const up = item.rawPoints > 0;
    const flat = Math.abs(item.rawPoints) < FLAT_POINTS;

    if (flat) {
        // Deliberately only two flat phrasings and no numbers quoted: there is nothing
        // to report but the absence of a move.
        return templateIndex % 2 === 0
            ? `${displayName} barely blinks at ${subject}; the market held its price.`
            : `Traders shrug at ${subject}, and the ${tickerWord} index sits still.`;
    }

    switch (templateIndex % 3) {
        case 0:
            return up
                ? `Buyers pile in on ${subject} — the market moved ${raw} points. ${displayName} climbs ${moved}.`
                : `Buyers stay wary on ${subject} — the market slid ${raw} points. ${displayName} eases ${moved}.`;
        case 1:
            return up
                ? `The ${tickerWord} index catches a bid, up ${moved}, as the market repriced ${subject} by ${raw} points.`
                : `The ${tickerWord} index gives ground, down ${moved}, as the market marked ${subject} down ${raw} points.`;
        default:
            return up
                ? `${raw} points of buying on ${subject}. ${displayName} follows it up ${moved}.`
                : `${raw} points came off ${subject}. ${displayName} follows it down ${moved}.`;
    }
}

export function toNewsSentences(items: TickerNewsMoveItem[], displayName: string): string[] {
    return items.map((it, i) => buildNewsSentence(it, displayName, i));
}

export function toMarketMovers(
    values: TickerValue[],
    series: Record<string, TickerSeriesEvent[]>,
    news: Record<string, TickerNewsItem[]>,
    results: Record<string, TickerResultItem[]>,
): MarketMoversData {
    const movers = values.map((t) => {
        const full = series[t.key] ?? [];
        return {
            key: t.key,
            displayName: t.displayName,
            indexLabel: indexLabelOf(t.ruleType),
            description: t.description,
            value: t.value,
            valueLabel: formatSignedPct(t.value),
            sign: signOf(t.value),
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
    // Default (no-JS) presentation order: biggest movers first, tab_order as tiebreak.
    // The marquee re-sorts its own copy back to tab_order (renderTickerTape).
    const byValueDesc = [...movers].sort((a, b) => b.value - a.value || a.tabOrder - b.tabOrder);
    return { note: RETROSPECTIVE_NOTE, movers: byValueDesc };
}

// -----------------------------------------------------------------------------------
// SVG chart - server-computed cumulative line, zero JS. Hover detail comes from native
// <title> elements; the whole SVG is role="img" with a spoken summary.
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

    // A non-truncated series gets a synthetic 0-origin so even a single event draws a
    // real line from 0 to its value; a truncated one honestly starts mid-flight.
    const cums = vm.series.map((e) => e.cumulative);
    const points = vm.seriesTruncated ? cums : [0, ...cums];
    const lo = Math.min(0, ...points);
    const hi = Math.max(0, ...points);
    const span = hi - lo || 1;
    const x = (i: number) => (PAD + (i * (CHART_W - 2 * PAD)) / Math.max(points.length - 1, 1)).toFixed(1);
    const y = (v: number) => (PAD + ((hi - v) * (PLOT_H - 2 * PAD)) / span).toFixed(1);

    const polyline = points.map((v, i) => `${x(i)},${y(v)}`).join(' ');
    // Navy plot panel in the site palette; market colors brightened for the dark
    // background - green up, red down, slate for a flat zero line.
    const stroke = vm.sign === 'pos' ? '#3ddc64' : vm.sign === 'neg' ? '#ff6b57' : '#94a3b8';
    const zeroAxis = lo < 0 && hi > 0
        ? `<line x1="${PAD}" x2="${CHART_W - PAD}" y1="${y(0)}" y2="${y(0)}" stroke="rgba(255,255,255,0.25)" stroke-dasharray="4 4" stroke-width="1"/>`
        : '';

    // One dot per REAL event (the synthetic origin gets none) with a native tooltip
    // carrying the full date + event detail.
    const originOffset = vm.seriesTruncated ? 0 : 1;
    const dots = vm.series.map((e, i) => {
        const title = `${utcDateLabel(e.occurredAt)} · ${e.eventType} · ${formatSignedPct(e.delta)} (running: ${formatSignedPct(e.cumulative)})`;
        return `<circle cx="${x(i + originOffset)}" cy="${y(e.cumulative)}" r="2.5" fill="${stroke}"><title>${escapeHtml(title)}</title></circle>`;
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

    const summary = `${vm.displayName} cumulative chart: currently ${vm.valueLabel} over ${vm.eventCount} event${vm.eventCount === 1 ? '' : 's'}`;
    return `<svg class="hc-mm-svg" viewBox="0 0 ${CHART_W} ${CHART_H}" role="img" aria-label="${escapeHtml(summary)}">
                <title>${escapeHtml(summary)}</title>
                <rect x="0.75" y="0.75" width="${CHART_W - 1.5}" height="${PLOT_H - 1.5}" rx="8" fill="#160c27" stroke="rgba(47,230,217,0.4)" stroke-width="1.5"/>
                ${zeroAxis}
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

const neonFor = (delta: number): string =>
    delta > 0 ? '61, 220, 100' : delta < 0 ? '255, 107, 87' : '148, 163, 184';

export function renderIndexBoardSvg(movers: MarketMoverVM[], now = Date.now()): string {
    if (movers.length === 0) return '';

    // Same adaptive window as the TANKDAQ board: widen until something actually moved,
    // so a quiet day reads as quiet rather than as fourteen identical grey blocks. Run
    // over every index, parents and children alike, so a family's tiles are all sized
    // against the same window.
    const { deltas, info } = chooseWindow(
        movers.map((m) => ({ key: m.key, value: m.value })),
        Object.fromEntries(movers.map((m) => [m.key, m.series])),
        now,
    );
    const deltaOf = new Map(movers.map((m, i) => [m.key, deltas[i]]));
    const maxAbs = Math.max(...deltas.map((d) => Math.abs(d)), 0);

    // A ticker whose parent isn't on this board is drawn as a root rather than dropped -
    // an index is never silently missing because of a bad parent_key.
    const present = new Set(movers.map((m) => m.key));
    const isRoot = (m: MarketMoverVM) => !m.parentKey || !present.has(m.parentKey);
    const roots = movers.filter(isRoot);
    const kidsOf = (key: string) => movers.filter((m) => !isRoot(m) && m.parentKey === key);
    const families = roots.map((r) => kidsOf(r.key));

    const layout = layoutNested(
        roots.map((m) => deltaOf.get(m.key) ?? 0),
        families.map((kids) => kids.map((k) => deltaOf.get(k.key) ?? 0)),
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
        const showDelta = r.h > symSize * 2.2 && symSize >= MIN_LEGIBLE_SIZE;
        const cx = (r.x + r.w / 2).toFixed(2);
        const neon = neonFor(delta);
        return `<text class="hc-mmb-sym" x="${cx}" y="${(r.y + r.h / 2 + (showDelta ? -0.2 : symSize * 0.35)).toFixed(2)}"
                          text-anchor="middle" font-size="${symSize.toFixed(2)}">${escapeHtml(text)}</text>
                    ${showDelta ? `<text class="hc-mmb-delta" x="${cx}" y="${(r.y + r.h / 2 + deltaSize * 1.35).toFixed(2)}"
                          text-anchor="middle" font-size="${deltaSize.toFixed(2)}" fill="rgb(${neon})">${formatSignedPct(delta)}</text>` : ''}`;
    };

    const titleOf = (m: MarketMoverVM, delta: number, parent?: MarketMoverVM) =>
        `${m.displayName}${parent ? ` (${parent.displayName} · ${m.indexLabel})` : ''}: `
        + `${formatSignedPct(delta)} over ${info.label}, ${m.valueLabel} overall`;

    const tiles = roots.map((m, i) => {
        const r = layout.roots[i];
        const kids = families[i];
        const delta = deltaOf.get(m.key) ?? 0;
        const mag = maxAbs > 0 ? Math.abs(delta) / maxAbs : 0;
        const neon = neonFor(delta);

        const x = r.x + BOARD_GUTTER;
        const y = r.y + BOARD_GUTTER;
        const w = Math.max(r.w - 2 * BOARD_GUTTER, 0.1);
        const h = Math.max(r.h - 2 * BOARD_GUTTER, 0.1);

        const title = titleOf(m, delta);
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
                        const kd = deltaOf.get(k.key) ?? 0;
                        const kmag = maxAbs > 0 ? Math.abs(kd) / maxAbs : 0;
                        const kneon = neonFor(kd);
                        const kx = kr.x + CHILD_GUTTER;
                        const ky = kr.y + CHILD_GUTTER;
                        const kw = Math.max(kr.w - 2 * CHILD_GUTTER, 0.1);
                        const kh = Math.max(kr.h - 2 * CHILD_GUTTER, 0.1);
                        const kt = titleOf(k, kd, m);
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
    const summary = `Index board: ${roots.length} indexes sized by their move over ${info.label}`
        + (nested > 0 ? `, with ${nested} league sub-indexes drawn inside the index each one slices` : '');
    return `
        <div class="hc-mmb">
            <h4 class="hc-mmb-heading">The Board</h4>
            <svg class="hc-mmb-svg" viewBox="0 0 ${BOARD_W} ${BOARD_H}" role="img" aria-label="${escapeHtml(summary)}">
                <title>${escapeHtml(summary)}</title>
                <rect x="0" y="0" width="${BOARD_W}" height="${BOARD_H}" fill="#000000"/>
                ${tiles}
            </svg>
            <p class="hc-mmb-caption">Tile size tracks the move over ${escapeHtml(info.label)}${info.widened ? ' (nothing moved in the last 24 hours)' : ''}${nested > 0 ? ' &middot; league slices sit inside the index they slice' : ''} &middot; <a href="/tankdaq/indexes/">Open the full board</a></p>
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
                    <span class="hc-mm-value is-${vm.sign}">${vm.valueLabel}</span>
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
    // Marquee reads in tab_order (marketing order), not the section's value-desc order -
    // both label strings come from the same VM, so the numbers can't disagree. Each item
    // trails its ticker's newest Recent Results sentence (same VM the cards render), in
    // a deliberately quieter style than the symbol/value.
    const items = [...(headline.length > 0 ? headline : movers)].sort((a, b) => a.tabOrder - b.tabOrder).map((m) => {
        const headline = m.results[0]
            ? ` <span class="hc-tape-headline">${escapeHtml(m.results[0].text)}</span>`
            : '';
        return `
                <li class="hc-tape-item is-${m.sign}"><a class="hc-tape-link" href="/tankdaq/${escapeHtml(m.key)}/">${escapeHtml(m.displayName)}</a> <span class="hc-mm-value is-${m.sign}">${m.valueLabel}</span>${headline}</li>`;
    }).join('');
    const group = (hidden: boolean) => `<ul class="hc-tape-group"${hidden ? ' aria-hidden="true"' : ''}>${items}</ul>`;
    return `
        <div class="hc-ticker-tape" aria-label="Ticker values — how tagged storylines have gone, not a forecast">
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
    // one card per tab, so the section stays compact. movers is value-desc sorted:
    // gainer = first; loser = last, only if it actually moved down. Server default
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
    const loser = last && last !== gainer && last.value < 0 ? last : null;
    const cards = gainer
        ? renderMarketMoverCard(gainer, 'gainer') + (loser ? renderMarketMoverCard(loser, 'loser') : '')
        : '';
    // The board sits AFTER the grid, never inside it: the gainers/losers rules are
    // scoped to .hc-mm-grid's descendants, so a sibling can't be hidden by a tab. It
    // also renders in the empty branch - with no card to show, the whole-board view is
    // the one thing still worth showing.
    const board = renderIndexBoardSvg(data.movers);
    const body = !gainer
        ? `<p class="hc-mm-empty">No ticker activity yet — storylines get tagged as they publish.</p>${board}`
        : `
        <div class="hc-mm-tabs" data-hc-mm-tabs hidden>
            <button type="button" class="hc-mm-tab is-gainers" data-mm-view="gainers" aria-pressed="true">Top Gainers</button>
            <button type="button" class="hc-mm-tab is-losers" data-mm-view="losers" aria-pressed="false">Top Losers</button>
        </div>
        <div class="hc-mm-grid" data-hc-mm-grid data-mm-view="all">${cards}</div>
        ${board}`;

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

// Appended into homepageStyles() output (render.ts). Mockup palette: orange marquee
// band with outlined sign-colored text (market green up / red down), folder-style
// green/salmon tab buttons, light-blue index cards and maroon serif news entries -
// with the plot itself restyled to the site's navy/teal (top-right of the card,
// visible date ticks below the panel). The page background itself stays untouched.
export function marketMoversStyles(): string {
    return `
        .hc-ticker-tape { overflow: hidden; margin: 0.9rem -1.25rem 0; background: #a36114; border-top: 2px solid #000000; border-bottom: 2px solid #000000; }
        .hc-tape-track { display: flex; width: max-content; animation: hc-tape 60s linear infinite; }
        .hc-tape-group {
            list-style: none; display: flex; gap: 2.25rem; margin: 0; padding: 0.5rem 1.5rem 0.55rem;
            white-space: nowrap;
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800;
            font-size: 1.45rem; letter-spacing: 0.03em; text-transform: uppercase;
        }
        .hc-tape-item, .hc-tape-item .hc-mm-value { font-weight: 800; }
        .hc-tape-item .hc-mm-value { font-size: 1.3rem; }
        .hc-tape-item.is-pos, .hc-tape-item.is-pos .hc-mm-value { color: #2f9e1e; }
        .hc-tape-item.is-neg, .hc-tape-item.is-neg .hc-mm-value { color: #e33a24; }
        .hc-tape-item.is-zero, .hc-tape-item.is-zero .hc-mm-value { color: #5b6572; }
        .hc-tape-item {
            text-shadow:
                1.5px 0 0 #fff, -1.5px 0 0 #fff, 0 1.5px 0 #fff, 0 -1.5px 0 #fff,
                1px 1px 0 #fff, -1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff,
                3px 3px 4px rgba(0,0,0,0.35);
        }
        .hc-tape-item .hc-tape-headline {
            font-size: 0.95rem; font-weight: 600; letter-spacing: 0.01em;
            color: #fdf3e0;
            text-shadow: 1px 1px 2px rgba(0,0,0,0.45);
            margin-left: 0.35rem;
        }
        @keyframes hc-tape { to { transform: translateX(-50%); } }

        .hc-mm-logo { display: block; width: clamp(180px, 42vw, 300px); height: auto; margin: 0 0 0.25rem -0.4rem; }
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
        .hc-mm-chartrow .hc-mm-value {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 900;
            font-size: clamp(1.15rem, 4vw, 1.5rem); flex-shrink: 0;
            text-shadow:
                1.5px 0 0 #fff, -1.5px 0 0 #fff, 0 1.5px 0 #fff, 0 -1.5px 0 #fff,
                1px 1px 0 #fff, -1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff,
                2.5px 2.5px 3px rgba(0,0,0,0.35);
        }
        .hc-mm-chartrow .hc-mm-value.is-pos { color: #2f9e1e; }
        .hc-mm-chartrow .hc-mm-value.is-neg { color: #e33a24; }
        .hc-mm-chartrow .hc-mm-value.is-zero { color: #5b6572; }
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
        .hc-mmb-delta { font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; }
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
