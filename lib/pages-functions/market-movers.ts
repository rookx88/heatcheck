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
    description: string; // real tickers.description text - page content, not a UI label
    value: number;
    valueLabel: string;  // formatSignedPct(value) - the ONE string both tape and card show
    sign: 'pos' | 'neg' | 'zero';
    tabOrder: number;    // marquee/marketing order; the section grid sorts by value instead
    eventCount: number;
    series: TickerSeriesEvent[]; // capped (SERIES_CAP) tail; cumulative values stay truthful
    seriesTruncated: boolean;
    news: MarketMoverNewsVM[];
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

// Same UTC-pinned date rule as the old feed's toFeedItemViewModel / formatSettleDate.
function utcDateLabel(iso: string): string {
    const d = new Date(iso);
    return isNaN(d.getTime())
        ? ''
        : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function toMarketMovers(
    values: TickerValue[],
    series: Record<string, TickerSeriesEvent[]>,
    news: Record<string, TickerNewsItem[]>,
): MarketMoversData {
    const movers = values.map((t) => {
        const full = series[t.key] ?? [];
        return {
            key: t.key,
            displayName: t.displayName,
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
const CHART_H = 72;
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
    const y = (v: number) => (PAD + ((hi - v) * (CHART_H - 2 * PAD)) / span).toFixed(1);

    const polyline = points.map((v, i) => `${x(i)},${y(v)}`).join(' ');
    const stroke = vm.sign === 'pos' ? 'var(--hc-teal)' : vm.sign === 'neg' ? '#ef4444' : 'rgba(255,255,255,0.55)';
    const zeroAxis = lo < 0 && hi > 0
        ? `<line x1="${PAD}" x2="${CHART_W - PAD}" y1="${y(0)}" y2="${y(0)}" stroke="rgba(255,255,255,0.25)" stroke-dasharray="4 4" stroke-width="1"/>`
        : '';

    // One dot per REAL event (the synthetic origin gets none) with a native tooltip.
    const originOffset = vm.seriesTruncated ? 0 : 1;
    const dots = vm.series.map((e, i) => {
        const title = `${utcDateLabel(e.occurredAt)} · ${e.eventType} · ${formatSignedPct(e.delta)} (running: ${formatSignedPct(e.cumulative)})`;
        return `<circle cx="${x(i + originOffset)}" cy="${y(e.cumulative)}" r="3" fill="${stroke}"><title>${escapeHtml(title)}</title></circle>`;
    }).join('');

    const summary = `${vm.displayName} cumulative chart: currently ${vm.valueLabel} over ${vm.eventCount} event${vm.eventCount === 1 ? '' : 's'}`;
    return `<svg class="hc-mm-svg" viewBox="0 0 ${CHART_W} ${CHART_H}" role="img" aria-label="${escapeHtml(summary)}">
                <title>${escapeHtml(summary)}</title>
                ${zeroAxis}
                <polyline fill="none" points="${polyline}" stroke="${stroke}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
                ${dots}
            </svg>`;
}

// -----------------------------------------------------------------------------------
// The reusable presentational core: one ticker's card. No section chrome, no session
// logic, no invest/divest UI - a future stock-market page wraps this, never forks it.
// -----------------------------------------------------------------------------------

export function renderMarketMoverCard(vm: MarketMoverVM): string {
    const newsBlock = vm.news.length === 0
        ? `<p class="hc-mm-news-empty">No tagged storylines yet.</p>`
        : `<ul class="hc-mm-news-list">${vm.news.map((n) => `
                <li>
                    <a href="${escapeHtml(n.href)}">${escapeHtml(n.hook)}</a>
                    ${n.excerpt ? `<p class="hc-mm-excerpt">${escapeHtml(n.excerpt)}</p>` : ''}
                    <span class="hc-mm-news-meta">${escapeHtml(n.league)}${n.dateLabel ? ` · ${escapeHtml(n.dateLabel)}` : ''}</span>
                </li>`).join('')}
            </ul>`;

    return `
        <article class="hc-mm-card" data-ticker="${escapeHtml(vm.key)}" data-sign="${vm.sign}">
            <header class="hc-mm-head">
                <h3 class="hc-mm-name">${escapeHtml(vm.displayName)}</h3>
                <span class="hc-mm-value is-${vm.sign}">${vm.valueLabel}</span>
            </header>
            <p class="hc-mm-desc">${escapeHtml(vm.description)}</p>
            <div class="hc-mm-chart">${renderTickerChartSvg(vm)}</div>
            <div class="hc-mm-news">
                <h4 class="hc-mm-news-heading">Recent news</h4>
                ${newsBlock}
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
    // both label strings come from the same VM, so the numbers can't disagree.
    const items = [...movers].sort((a, b) => a.tabOrder - b.tabOrder).map((m) => `
                <li class="hc-tape-item">${escapeHtml(m.displayName)} <span class="hc-mm-value is-${m.sign}">${m.valueLabel}</span></li>`).join('');
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
    const body = data.movers.length === 0
        ? `<p class="hc-mm-empty">No ticker activity yet — storylines get tagged as they publish.</p>`
        : `
        <div class="hc-mm-tabs" data-hc-mm-tabs hidden>
            <button type="button" data-mm-view="all" aria-pressed="true">All</button>
            <button type="button" data-mm-view="gainers" aria-pressed="false">Gainers</button>
            <button type="button" data-mm-view="losers" aria-pressed="false">Losers</button>
        </div>
        <div class="hc-mm-grid" data-hc-mm-grid data-mm-view="all">${data.movers.map(renderMarketMoverCard).join('')}</div>`;

    return `
        <section id="market-movers" class="hc-section" aria-labelledby="hc-mm-heading">
            <h2 id="hc-mm-heading">Market Movers</h2>
            <p class="hc-section-sub">${escapeHtml(data.note)}</p>
            ${body}
        </section>`;
}

// Appended into homepageStyles() output (render.ts). Sign colors: teal = positive,
// red = negative (the Baseball badge red), muted white = zero.
export function marketMoversStyles(): string {
    return `
        .hc-ticker-tape {
            overflow: hidden; margin: 0.75rem -1.25rem 0;
            border-top: 1px solid rgba(255,255,255,0.12); border-bottom: 1px solid rgba(255,255,255,0.12);
            background: rgba(255,255,255,0.04);
        }
        .hc-tape-track { display: flex; width: max-content; animation: hc-tape 28s linear infinite; }
        .hc-tape-group {
            list-style: none; display: flex; gap: 2rem; margin: 0; padding: 0.45rem 1rem 0.45rem 3rem;
            white-space: nowrap; font-weight: 800; font-size: 0.85rem;
        }
        @keyframes hc-tape { to { transform: translateX(-50%); } }
        .hc-mm-value.is-pos { color: var(--hc-teal); }
        .hc-mm-value.is-neg { color: #ef4444; }
        .hc-mm-value.is-zero { color: rgba(255,255,255,0.6); }

        .hc-mm-tabs { display: flex; gap: 0.5rem; margin: 0 0 1rem; }
        .hc-mm-tabs button {
            font-family: 'Nunito', sans-serif; font-weight: 800; font-size: 0.78rem;
            letter-spacing: 0.05em; text-transform: uppercase; cursor: pointer;
            color: rgba(255,255,255,0.75); background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.18); border-radius: 999px; padding: 0.3rem 0.9rem;
        }
        .hc-mm-tabs button[aria-pressed="true"] {
            color: var(--hc-teal); background: rgba(47, 230, 217, 0.1); border-color: rgba(47, 230, 217, 0.45);
        }
        .hc-mm-tabs button:focus-visible { outline: 2px solid var(--hc-teal); outline-offset: 2px; }

        .hc-mm-grid { display: flex; flex-direction: column; gap: 1rem; }
        .hc-mm-grid[data-mm-view="gainers"] .hc-mm-card:not([data-sign="pos"]) { display: none; }
        .hc-mm-grid[data-mm-view="losers"] .hc-mm-card:not([data-sign="neg"]) { display: none; }
        .hc-mm-card {
            display: flex; flex-direction: column; gap: 0.55rem;
            background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12);
            border-radius: 18px; padding: 1.1rem 1.1rem 1.2rem;
        }
        .hc-mm-head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.75rem; }
        .hc-mm-name { font-family: 'Baloo 2', 'Nunito', sans-serif; font-weight: 800; font-size: 1.1rem; margin: 0; }
        .hc-mm-value { font-family: 'Baloo 2', 'Nunito', sans-serif; font-weight: 800; font-size: 1rem; }
        .hc-mm-desc { font-size: 0.85rem; line-height: 1.45; color: rgba(255,255,255,0.78); margin: 0; }
        .hc-mm-chart { margin: 0.25rem 0; }
        .hc-mm-svg { display: block; width: 100%; height: auto; }
        .hc-mm-chart-empty, .hc-mm-news-empty, .hc-mm-empty {
            font-size: 0.82rem; color: rgba(255,255,255,0.55); margin: 0;
        }
        .hc-mm-news-heading {
            font-family: 'Nunito', sans-serif; font-weight: 800; font-size: 0.72rem;
            letter-spacing: 0.08em; text-transform: uppercase; color: rgba(255,255,255,0.6); margin: 0.25rem 0 0.4rem;
        }
        .hc-mm-news-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.7rem; }
        .hc-mm-news-list a { font-weight: 800; font-size: 0.9rem; line-height: 1.3; text-decoration: none; }
        .hc-mm-news-list a:hover { text-decoration: underline; }
        .hc-mm-excerpt { font-size: 0.82rem; line-height: 1.45; color: rgba(255,255,255,0.75); margin: 0.15rem 0 0.2rem; }
        .hc-mm-news-meta { font-size: 0.7rem; font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase; color: rgba(255,255,255,0.5); }

        @media (min-width: 760px) {
            .hc-mm-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1.25rem 2rem; }
        }
        @media (prefers-reduced-motion: reduce) {
            .hc-tape-track { animation: none; }
            .hc-tape-group[aria-hidden="true"] { display: none; }
            .hc-ticker-tape { overflow-x: auto; }
        }
    `;
}
