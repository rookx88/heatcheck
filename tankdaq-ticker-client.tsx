// TANKDAQ index detail page island (/tankdaq/<key>/) - the finance-platform view of
// one Exchange ticker. Static shell: scripts/templates/tankdaq-ticker-template.ts
// (which also owns every .hc-tq-* style rule); one fetch to /api/tickers/detail
// powers the whole page. The chart is a hand-rolled SVG (no chart lib ships in any
// bundle - see market-movers.ts's SSR sparkline for the precedent): time-scaled
// cumulative line over the selected window, anchored at the window-start value, so
// the 24H/3D/1W toggle reads like an interday chart even though ticker events are
// sparse. All values are retrospective - the API's note renders verbatim.

import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

interface SeriesEvent {
    id: string;
    tankId: string;
    eventType: 'tag' | 'settle';
    delta: number;
    cumulative: number;
    occurredAt: string;
}
interface NewsItem { href: string; hook: string; excerpt: string; league: string; taggedAt: string }
interface ResultItem { text: string; won: boolean }
interface DetailResponse {
    note: string;
    ticker: { key: string; displayName: string; indexLabel: string; description: string; value: number; eventCount: number };
    series: SeriesEvent[];
    news: NewsItem[];
    results: ResultItem[];
}

const HOUR_MS = 3600_000;
const WINDOWS = [
    { id: '24h', label: '24H', ms: 24 * HOUR_MS },
    { id: '3d', label: '3D', ms: 72 * HOUR_MS },
    { id: '1w', label: '1W', ms: 168 * HOUR_MS },
] as const;
type WindowId = (typeof WINDOWS)[number]['id'];

// Same formatter contract as market-movers.ts's formatSignedPct (real minus, -0 -> +0.0%),
// re-declared locally: importing market-movers would drag the SSR string builders into
// this bundle for one 3-line function.
function fmtPct(v: number): string {
    const n = Object.is(v, -0) ? 0 : v;
    return `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}%`;
}
function signOf(v: number): 'pos' | 'neg' | 'zero' {
    return v > 0 ? 'pos' : v < 0 ? 'neg' : 'zero';
}
function sumDeltasSince(series: SeriesEvent[], cutoffMs: number): number {
    let sum = 0;
    for (const e of series) if (new Date(e.occurredAt).getTime() >= cutoffMs) sum += e.delta;
    return Number(sum.toFixed(3));
}

// ---------------------------------------------------------------------------------
// Windowed chart geometry: x is TIME across the window (finance-style), y spans the
// window's value range. The line starts at the window-start anchor (the cumulative
// value just before the cutoff - 0 if the ticker hadn't started) and ends "now" at
// the current value, stepping through each event in between.
// ---------------------------------------------------------------------------------

interface ChartPoint { t: number; v: number; event?: SeriesEvent }

function windowPoints(series: SeriesEvent[], windowMs: number, nowMs: number): { points: ChartPoint[]; anchor: number } {
    const cutoff = nowMs - windowMs;
    let anchor = 0;
    const inWindow: ChartPoint[] = [];
    for (const e of series) {
        const t = new Date(e.occurredAt).getTime();
        if (t < cutoff) anchor = e.cumulative;
        else inWindow.push({ t, v: e.cumulative, event: e });
    }
    const last = inWindow.length ? inWindow[inWindow.length - 1].v : anchor;
    return { points: [{ t: cutoff, v: anchor }, ...inWindow, { t: nowMs, v: last }], anchor };
}

const CW = 720;
const CH = 260;
const PAD = { top: 14, right: 14, bottom: 26, left: 46 };

function tickTimes(windowId: WindowId, cutoff: number, now: number): number[] {
    const n = windowId === '24h' ? 4 : windowId === '3d' ? 3 : 7;
    const step = (now - cutoff) / n;
    return Array.from({ length: n + 1 }, (_, i) => cutoff + i * step);
}
function tickLabel(windowId: WindowId, t: number): string {
    const d = new Date(t);
    return windowId === '24h'
        ? d.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true })
        : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const TickerChart: React.FC<{ series: SeriesEvent[]; windowId: WindowId; displayName: string }> = ({ series, windowId, displayName }) => {
    const now = Date.now();
    const windowMs = WINDOWS.find((w) => w.id === windowId)!.ms;
    const { points, anchor } = windowPoints(series, windowMs, now);
    const cutoff = now - windowMs;
    const eventsInWindow = points.filter((p) => p.event).length;
    const windowDelta = points[points.length - 1].v - anchor;
    const sign = signOf(windowDelta);
    const stroke = sign === 'pos' ? '#3ddc64' : sign === 'neg' ? '#ff6b57' : '#94a3b8';

    const values = points.map((p) => p.v);
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    if (hi - lo < 1) { const mid = (hi + lo) / 2; lo = mid - 0.5; hi = mid + 0.5; } // flat window: give the line breathing room
    const span = hi - lo;
    const x = (t: number) => PAD.left + ((t - cutoff) / windowMs) * (CW - PAD.left - PAD.right);
    const y = (v: number) => PAD.top + ((hi - v) / span) * (CH - PAD.top - PAD.bottom);

    const line = points.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
    const area = `${line} ${x(now).toFixed(1)},${(CH - PAD.bottom).toFixed(1)} ${x(cutoff).toFixed(1)},${(CH - PAD.bottom).toFixed(1)}`;
    const gradId = `hc-tq-grad-${sign}`;

    const yLevels = [hi, (hi + lo) / 2, lo];
    const ticks = tickTimes(windowId, cutoff, now);
    const summary = `${displayName}: ${fmtPct(windowDelta)} over the selected window (${eventsInWindow} event${eventsInWindow === 1 ? '' : 's'})`;

    return (
        <>
            <svg className="hc-tq-svg" viewBox={`0 0 ${CW} ${CH}`} role="img" aria-label={summary}>
                <title>{summary}</title>
                <defs>
                    <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={stroke} stopOpacity="0.35" />
                        <stop offset="100%" stopColor={stroke} stopOpacity="0" />
                    </linearGradient>
                </defs>
                {yLevels.map((v) => (
                    <g key={v}>
                        <line x1={PAD.left} x2={CW - PAD.right} y1={y(v)} y2={y(v)} stroke="rgba(255,255,255,0.08)" strokeWidth={1} />
                        <text className="hc-tq-ylabel" x={PAD.left - 6} y={y(v) + 3} textAnchor="end">{fmtPct(v)}</text>
                    </g>
                ))}
                {/* Window-start baseline: where this window began. */}
                <line x1={PAD.left} x2={CW - PAD.right} y1={y(anchor)} y2={y(anchor)} stroke="rgba(255,255,255,0.3)" strokeDasharray="5 5" strokeWidth={1} />
                <polygon points={area} fill={`url(#${gradId})`} />
                <polyline points={line} fill="none" stroke={stroke} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
                {points.filter((p) => p.event).map((p) => (
                    <circle key={p.event!.id} cx={x(p.t)} cy={y(p.v)} r={3.5} fill={stroke} stroke="#160c27" strokeWidth={1}>
                        <title>{`${new Date(p.t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', hour12: true })} · ${p.event!.eventType} · ${fmtPct(p.event!.delta)} (running: ${fmtPct(p.event!.cumulative)})`}</title>
                    </circle>
                ))}
                {ticks.map((t, i) => (
                    <text key={t} className="hc-tq-tick" x={x(t)} y={CH - 8}
                        textAnchor={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'}>
                        {tickLabel(windowId, t)}
                    </text>
                ))}
            </svg>
            {eventsInWindow === 0 && <p className="hc-tq-chart-note">No movement in this window.</p>}
        </>
    );
};

const TankdaqTickerPage: React.FC<{ tickerKey: string }> = ({ tickerKey }) => {
    const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
    const [data, setData] = useState<DetailResponse | null>(null);
    const [windowId, setWindowId] = useState<WindowId>('3d');

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(`/api/tickers/detail?key=${encodeURIComponent(tickerKey)}`);
                if (!res.ok) throw new Error(`detail ${res.status}`);
                const body = (await res.json()) as DetailResponse;
                if (!cancelled) { setData(body); setPhase('ready'); }
            } catch (err) {
                console.error('[TANKDAQ] detail fetch failed:', err);
                if (!cancelled) setPhase('error');
            }
        })();
        return () => { cancelled = true; };
    }, [tickerKey]);

    const delta24 = useMemo(
        () => (data ? sumDeltasSince(data.series, Date.now() - 24 * HOUR_MS) : 0),
        [data],
    );

    if (phase === 'loading') return <p className="hc-tq-loading">Loading index&hellip;</p>;
    if (phase === 'error' || !data) return <p className="hc-tq-error">Couldn&rsquo;t load this index right now &mdash; refresh to retry.</p>;

    const { ticker } = data;
    const totalSign = signOf(ticker.value);
    const d24Sign = signOf(delta24);
    const dateLabel = (iso: string) => {
        const d = new Date(iso);
        return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    };

    return (
        <div>
            <a className="hc-tq-back" href="/tankdaq/indexes/">&larr; Index Board</a>
            <header className="hc-tq-header">
                <h1 className="hc-tq-title">{ticker.indexLabel} <span className="hc-tq-symbol">({ticker.displayName})</span></h1>
                <p className="hc-tq-desc">{ticker.description}</p>
                <p className="hc-tq-note">{data.note}</p>
            </header>
            <div className="hc-tq-layout">
                <div>
                    <div className="hc-tq-value-row">
                        <span className={`hc-tq-value is-${totalSign}`}>{fmtPct(ticker.value)}</span>
                        <span className={`hc-tq-delta24 is-${d24Sign}`}>({fmtPct(delta24)})</span>
                        <span className="hc-tq-delta24-label">All-time &middot; (last 24 hours)</span>
                    </div>
                    <div className="hc-tq-ranges" role="group" aria-label="Chart window">
                        {WINDOWS.map((w) => (
                            <button key={w.id} type="button" className="hc-tq-range"
                                aria-pressed={windowId === w.id} onClick={() => setWindowId(w.id)}>
                                {w.label}
                            </button>
                        ))}
                    </div>
                    <div className="hc-tq-chart-panel">
                        <TickerChart series={data.series} windowId={windowId} displayName={ticker.displayName} />
                    </div>
                    <section aria-label="Recent news">
                        <h2 className="hc-tq-section-heading">Recent News</h2>
                        {data.news.length === 0 ? (
                            <p className="hc-tq-muted">No tagged storylines yet.</p>
                        ) : (
                            <ul className="hc-tq-news-list">
                                {data.news.map((n) => (
                                    <li key={n.href}>
                                        <a href={n.href}>{n.hook || 'Read the storyline'}</a>
                                        {n.excerpt && <p className="hc-tq-excerpt">{n.excerpt}</p>}
                                        <span className="hc-tq-news-meta">{n.league}{dateLabel(n.taggedAt) ? ` · ${dateLabel(n.taggedAt)}` : ''}</span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>
                </div>
                <aside className="hc-tq-results-panel" aria-label="Recent results">
                    <h2 className="hc-tq-section-heading">Recent Results</h2>
                    {data.results.length === 0 ? (
                        <p className="hc-tq-muted">No settled results yet.</p>
                    ) : (
                        <ul className="hc-tq-results-list">
                            {data.results.map((r, i) => (
                                <li key={i}><span className={`hc-tq-chip is-${r.won ? 'pos' : 'neg'}`}>{r.won ? 'W' : 'L'}</span>{r.text}</li>
                            ))}
                        </ul>
                    )}
                </aside>
            </div>
        </div>
    );
};

function mount() {
    const root = document.getElementById('tankdaq-ticker-root');
    if (!root) return;
    const key = root.getAttribute('data-ticker-key');
    if (!key) return;
    // Drop the crawlable fallback first - createRoot().render() appends rather than
    // replacing (same gotcha homepage-client.tsx documents for its map root).
    root.replaceChildren();
    createRoot(root).render(<TankdaqTickerPage tickerKey={key} />);
}

mount();
