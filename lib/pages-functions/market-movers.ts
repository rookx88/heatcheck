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
// League acronyms stay fully uppercase ("nfl_favorite" -> "NFL Favorite Index").
const ACRONYM_WORDS = new Set(['nfl', 'nba', 'mlb', 'epl']);
function indexLabelOf(ruleType: string): string {
    const words = ruleType.split('_')
        .map((w) => (ACRONYM_WORDS.has(w) ? w.toUpperCase() : w ? w[0].toUpperCase() + w.slice(1) : w))
        .join(' ');
    return `${words} Index`;
}

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
            return `The ${tickerWord} index experiences a local ${item.won ? 'high' : 'low'} as ${item.pickLabel || `the ${totalsSide}`} ${item.won ? 'hits' : 'misses'}.`;
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
            results: (results[t.key] ?? []).map((r, i) => ({ text: buildResultSentence(r, t.displayName, i), won: r.won })),
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
                        <span class="hc-mm-index">${escapeHtml(vm.indexLabel)}</span>
                        <span class="hc-mm-name">(${escapeHtml(vm.displayName)})</span>
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
    // Marquee reads in tab_order (marketing order), not the section's value-desc order -
    // both label strings come from the same VM, so the numbers can't disagree. Each item
    // trails its ticker's newest Recent Results sentence (same VM the cards render), in
    // a deliberately quieter style than the symbol/value.
    const items = [...movers].sort((a, b) => a.tabOrder - b.tabOrder).map((m) => {
        const headline = m.results[0]
            ? ` <span class="hc-tape-headline">${escapeHtml(m.results[0].text)}</span>`
            : '';
        return `
                <li class="hc-tape-item is-${m.sign}">${escapeHtml(m.displayName)} <span class="hc-mm-value is-${m.sign}">${m.valueLabel}</span>${headline}</li>`;
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
    const gainer = data.movers[0];
    const last = data.movers[data.movers.length - 1];
    const loser = last && last !== gainer && last.value < 0 ? last : null;
    const cards = gainer
        ? renderMarketMoverCard(gainer, 'gainer') + (loser ? renderMarketMoverCard(loser, 'loser') : '')
        : '';
    const body = !gainer
        ? `<p class="hc-mm-empty">No ticker activity yet — storylines get tagged as they publish.</p>`
        : `
        <div class="hc-mm-tabs" data-hc-mm-tabs hidden>
            <button type="button" class="hc-mm-tab is-gainers" data-mm-view="gainers" aria-pressed="true">Top Gainers</button>
            <button type="button" class="hc-mm-tab is-losers" data-mm-view="losers" aria-pressed="false">Top Losers</button>
        </div>
        <div class="hc-mm-grid" data-hc-mm-grid data-mm-view="all">${cards}</div>`;

    return `
        <section id="market-movers" class="hc-section" aria-labelledby="hc-mm-heading">
            <h2 id="hc-mm-heading" class="hc-visually-hidden">Market Movers</h2>
            <div class="hc-mm-band">
                <img class="hc-mm-logo" src="/assets/images/market-movers-logo.webp" alt="Market Movers" width="338" height="249" loading="lazy">
                <p class="hc-section-sub hc-mm-note">Real sport moments are the fuel that forges the world of Heatchecks. Each moment is tied to an index. Storylines and results affect each index differently! And soon, a new way to put your Embers to work while you enjoy sports content.</p>
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

        .hc-mm-tabs { display: flex; gap: 0.6rem; margin: 0.75rem 0 0; position: relative; z-index: 1; }
        .hc-mm-tab {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800;
            font-size: clamp(0.95rem, 3.2vw, 1.25rem); letter-spacing: 0.04em; text-transform: uppercase;
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

        /* Same orange frame as #tanks (homepage/render.ts), at every viewport - not
           just inside the desktop-only white-panel treatment below - so the two
           sections read as matching game panels side by side. box-sizing:border-box
           (global reset) keeps the added border from disturbing the desktop grid's
           stretch-alignment between the two panels. */
        #market-movers {
            border: 3px solid #000000;
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
                background: #ffffff;
                padding: 0 1rem 1.25rem;
            }
            .hc-mm-band {
                display: flex; align-items: center; gap: 1rem;
                background: #5e35b1;
                margin: 0 -1rem 0.25rem; padding: 0.6rem 1rem;
            }
            .hc-mm-logo { width: clamp(140px, 14vw, 190px); margin: 0; flex-shrink: 0; }
            .hc-mm-note {
                margin: 0; color: #ffffff; font-size: 0.78rem;
                background: rgba(255,255,255,0.14); border: 1px solid rgba(255,255,255,0.35);
                border-radius: 8px; padding: 0.45rem 0.7rem;
            }
            .hc-mm-tabs { margin-top: 0.5rem; }
            /* A fully transparent card read as flat/boring on the white panel -
               a light tint plus a sign-colored left rail gives the card its own
               presence instead of the text just floating on white. */
            .hc-mm-card {
                background: rgba(94, 193, 238, 0.22);
                padding: 1rem 1.15rem 1.2rem; border-radius: 10px;
                border-left: 5px solid #94a3b8;
                box-shadow: 0 2px 10px rgba(11, 21, 38, 0.08);
            }
            .hc-mm-card[data-sign="pos"] { border-left-color: #2f9e1e; }
            .hc-mm-card[data-sign="neg"] { border-left-color: #e33a24; }
            /* The white desc chip vanishes white-on-white - pale blue on desktop. */
            .hc-mm-desc { background: rgba(94, 193, 238, 0.35); }
        }

        @media (prefers-reduced-motion: reduce) {
            .hc-tape-track { animation: none; }
            .hc-tape-group[aria-hidden="true"] { display: none; }
            .hc-ticker-tape { overflow-x: auto; }
        }
    `;
}
