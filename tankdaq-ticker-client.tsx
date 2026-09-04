// TANKDAQ index detail page island (/tankdaq/<key>/) - the finance-platform view of
// one Exchange ticker. Static shell: scripts/templates/tankdaq-ticker-template.ts
// (which also owns every .hc-tq-* style rule); one fetch to /api/tickers/detail
// powers the whole page. The chart is a hand-rolled SVG (no chart lib ships in any
// bundle - see market-movers.ts's SSR sparkline for the precedent): time-scaled line
// over the selected window, anchored at the window-start value, so the 24H/3D/1W
// toggle reads like an interday chart even though ticker events are sparse.
//
// The headline is the index's EMBER PRICE, stock-quote style - price large, the price's
// % change over the selected window beside it - with the cumulative index % kept as a
// secondary line. Every price on this page is priceFromValue(cumulative, {baseline,
// scale}) from ticker-price.ts, the same function the server used: the chart maps the
// existing cumulative series through it, so there is one price function and one data
// path. All values are retrospective - both API notes render verbatim.
//
// Trading lives in the right-hand panel (TradePanel): whole shares, priced server-side
// at the moment of the trade, cost/credit previewed here with the same shared math but
// never trusted by the server. The panel hydrates its own login state from
// /api/toolbar-state - ContentChrome keeps that private on purpose - and its position
// from /api/tankdaq/holdings.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { tickerCopyFor } from './lib/pages-functions/ticker-copy';
import { sumSince } from './lib/pages-functions/ticker-window';
import {
    MAX_SHARES_PER_TRADE,
    buyCost,
    priceFromValue,
    sellCredit,
    windowReturnPct,
    type PriceParams,
} from './lib/pages-functions/ticker-price';
import { ContentChrome } from './components/ContentChrome';
import { getToolbarState } from './toolbar-state-client';
import { InsufficientEmberError } from './egg-shop-client';
import {
    InsufficientSharesError,
    TickerUnavailableError,
    buyShares,
    getHoldings,
    sellShares,
    type Position,
} from './tankdaq-shares-client';

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
    priceNote: string;
    ticker: {
        key: string; displayName: string; indexLabel: string; description: string; ruleType: string;
        value: number; eventCount: number;
        price: number; priceBaseline: number; priceScale: number;
    };
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
// Ember prices read to the cent; the 4-dp quote stays the number the math runs on.
function fmtEmber(v: number): string {
    return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtSignedEmber(v: number): string {
    const n = Object.is(v, -0) ? 0 : v;
    return `${n >= 0 ? '+' : '−'}${Math.abs(n).toLocaleString('en-US')}`;
}

// Same flame glyph the HUD's Ember chip uses (components/MapHud.tsx).
const EmberGlyph: React.FC<{ size?: number }> = ({ size = 22 }) => (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="currentColor" className="hc-tq-ember">
        <path d="M12 2c.6 3.8-1.2 5.6-2.9 7.3C7.4 11 6 12.6 6 15a6 6 0 0 0 12 0c0-1.7-.6-3.1-1.5-4.5-.4 1-.9 1.7-1.8 2.3.3-3.4-1-6.5-2.7-8.8Z" />
    </svg>
);

// ---------------------------------------------------------------------------------
// Windowed chart geometry: x is TIME across the window (finance-style), y spans the
// window's price range. The line starts at the window-start anchor (the cumulative
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
// Right padding carries the secondary (index %) axis labels.
const PAD = { top: 14, right: 50, bottom: 26, left: 56 };

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

// A y-scale over a value range with a floor on the span so a flat window still draws.
function scaleFor(values: number[], minSpan: number): { lo: number; hi: number; y: (v: number) => number } {
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    if (hi - lo < minSpan) { const mid = (hi + lo) / 2; lo = mid - minSpan / 2; hi = mid + minSpan / 2; }
    const span = hi - lo;
    return { lo, hi, y: (v: number) => PAD.top + ((hi - v) / span) * (CH - PAD.top - PAD.bottom) };
}

const TickerChart: React.FC<{ series: SeriesEvent[]; windowId: WindowId; displayName: string; priceParams: PriceParams }> =
    ({ series, windowId, displayName, priceParams }) => {
    const now = Date.now();
    const windowMs = WINDOWS.find((w) => w.id === windowId)!.ms;
    const { points, anchor } = windowPoints(series, windowMs, now);
    const cutoff = now - windowMs;
    const eventsInWindow = points.filter((p) => p.event).length;
    const last = points[points.length - 1].v;
    // The window's price return - the sign the whole chart takes. exp() is monotonic, so
    // this agrees with the sign of the cumulative delta.
    const windowRet = windowReturnPct(last, anchor, priceParams);
    const sign = signOf(windowRet);
    const stroke = sign === 'pos' ? '#3ddc64' : sign === 'neg' ? '#ff6b57' : '#94a3b8';

    // Primary: price, from the SAME points mapped through the shared transform.
    const prices = points.map((p) => priceFromValue(p.v, priceParams));
    const anchorPrice = priceFromValue(anchor, priceParams);
    // A flat window still gets ~2% of price as breathing room.
    const P = scaleFor(prices, Math.max(anchorPrice * 0.02, 0.01));
    // Secondary: the cumulative index %, on its own scale (right axis).
    const V = scaleFor(points.map((p) => p.v), 1);

    const x = (t: number) => PAD.left + ((t - cutoff) / windowMs) * (CW - PAD.left - PAD.right);

    const priceLine = points.map((p, i) => `${x(p.t).toFixed(1)},${P.y(prices[i]).toFixed(1)}`).join(' ');
    const area = `${priceLine} ${x(now).toFixed(1)},${(CH - PAD.bottom).toFixed(1)} ${x(cutoff).toFixed(1)},${(CH - PAD.bottom).toFixed(1)}`;
    const indexLine = points.map((p) => `${x(p.t).toFixed(1)},${V.y(p.v).toFixed(1)}`).join(' ');
    const gradId = `hc-tq-grad-${sign}`;

    const priceLevels = [P.hi, (P.hi + P.lo) / 2, P.lo];
    const indexLevels = [V.hi, (V.hi + V.lo) / 2, V.lo];
    const ticks = tickTimes(windowId, cutoff, now);
    const summary = `${displayName}: ${fmtEmber(prices[prices.length - 1])} Ember, ${fmtPct(windowRet)} over the selected window (${eventsInWindow} event${eventsInWindow === 1 ? '' : 's'}); index ${fmtPct(last)}`;

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
                {priceLevels.map((v) => (
                    <g key={`p${v}`}>
                        <line x1={PAD.left} x2={CW - PAD.right} y1={P.y(v)} y2={P.y(v)} stroke="rgba(255,255,255,0.08)" strokeWidth={1} />
                        <text className="hc-tq-ylabel" x={PAD.left - 6} y={P.y(v) + 3} textAnchor="end">{fmtEmber(v)}</text>
                    </g>
                ))}
                {indexLevels.map((v) => (
                    <text key={`i${v}`} className="hc-tq-ylabel hc-tq-ylabel-index" x={CW - PAD.right + 6} y={V.y(v) + 3} textAnchor="start">{fmtPct(v)}</text>
                ))}
                {/* Window-start baseline: the price where this window began. */}
                <line x1={PAD.left} x2={CW - PAD.right} y1={P.y(anchorPrice)} y2={P.y(anchorPrice)} stroke="rgba(255,255,255,0.3)" strokeDasharray="5 5" strokeWidth={1} />
                <polygon points={area} fill={`url(#${gradId})`} />
                {/* Secondary: the index's cumulative % - same shape re-stretched to its own axis. */}
                <polyline points={indexLine} fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth={1.25} strokeDasharray="3 4" strokeLinejoin="round" />
                <polyline points={priceLine} fill="none" stroke={stroke} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
                {points.map((p, i) => p.event ? (
                    <circle key={p.event.id} cx={x(p.t)} cy={P.y(prices[i])} r={3.5} fill={stroke} stroke="#160c27" strokeWidth={1}>
                        <title>{`${new Date(p.t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', hour12: true })} · ${p.event.eventType} · ${fmtEmber(prices[i])} Ember · index ${fmtPct(p.event.delta)} (running: ${fmtPct(p.event.cumulative)})`}</title>
                    </circle>
                ) : null)}
                {ticks.map((t, i) => (
                    <text key={t} className="hc-tq-tick" x={x(t)} y={CH - 8}
                        textAnchor={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'}>
                        {tickLabel(windowId, t)}
                    </text>
                ))}
            </svg>
            <p className="hc-tq-chart-legend">
                <span><span className="hc-tq-legend-swatch" style={{ background: stroke }} /> Ember price</span>
                <span><span className="hc-tq-legend-swatch hc-tq-legend-swatch--index" /> Index %</span>
            </p>
            {eventsInWindow === 0 && <p className="hc-tq-chart-note">No movement in this window.</p>}
        </>
    );
};

// ---------------------------------------------------------------------------------
// Trade panel: whole shares, priced server-side. Login state is hydrated here because
// ContentChrome keeps it private (see header). A tradeToken is minted per INTENT - a
// new one whenever side or quantity changes and after every completed attempt - and
// kept across a network failure so a retry is idempotent.
// ---------------------------------------------------------------------------------

type Auth = 'loading' | 'out' | 'unonboarded' | 'in';

const TradePanel: React.FC<{ tickerKey: string; displayName: string; price: number; priceNote: string; onTraded: () => void }> =
    ({ tickerKey, displayName, price, priceNote, onTraded }) => {
    const [auth, setAuth] = useState<Auth>('loading');
    const [balance, setBalance] = useState<number | null>(null);
    const [position, setPosition] = useState<Position | null>(null);
    const [side, setSide] = useState<'buy' | 'sell'>('buy');
    const [qty, setQty] = useState<number>(1);
    const [token, setToken] = useState<string>(() => crypto.randomUUID());
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    const hydrate = useCallback(async () => {
        try {
            const state = await getToolbarState();
            if (!state) { setAuth('out'); return; }
            if (state.balance === null) { setAuth('unonboarded'); return; }
            setBalance(state.balance);
            setAuth('in');
            const h = await getHoldings();
            const mine = h?.positions.find((p) => p.tickerKey === tickerKey) ?? null;
            setPosition(mine ? { shares: mine.shares, avgBuyPrice: mine.avgBuyPrice } : null);
            if (h) setBalance(h.balance);
        } catch {
            setAuth((a) => (a === 'loading' ? 'out' : a));
        }
    }, [tickerKey]);

    useEffect(() => { hydrate(); }, [hydrate]);

    // A different side or quantity is a different intent - it gets its own token.
    useEffect(() => { setToken(crypto.randomUUID()); }, [side, qty]);

    const held = position?.shares ?? 0;
    const preview = side === 'buy' ? buyCost(qty, price) : sellCredit(qty, price);
    const canAfford = side === 'buy' ? (balance ?? 0) >= preview : held >= qty;
    const qtyValid = Number.isInteger(qty) && qty >= 1 && qty <= MAX_SHARES_PER_TRADE;

    const submit = async () => {
        if (busy || !qtyValid) return;
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            const res = side === 'buy'
                ? await buyShares(tickerKey, qty, token)
                : await sellShares(tickerKey, qty, token);
            setBalance(res.balance);
            setPosition(res.position);
            const t = res.trade;
            setNotice(res.replay
                ? 'Already done - that order had gone through.'
                : side === 'buy'
                    ? `Bought ${t.shares} share${t.shares === 1 ? '' : 's'} of ${displayName} for ${t.emberAmount.toLocaleString('en-US')} Ember at ${fmtEmber(t.price)}.`
                    : `Sold ${t.shares} share${t.shares === 1 ? '' : 's'} of ${displayName} for ${t.emberAmount.toLocaleString('en-US')} Ember at ${fmtEmber(t.price)}${typeof t.realizedPnl === 'number' ? ` (${fmtSignedEmber(Math.round(t.realizedPnl))} Ember realized)` : ''}.`);
            setToken(crypto.randomUUID());
            onTraded();
        } catch (err: any) {
            if (err instanceof InsufficientEmberError) {
                setBalance(err.balance);
                setError(`Not enough Ember - you have ${err.balance.toLocaleString('en-US')}.`);
                setToken(crypto.randomUUID());
            } else if (err instanceof InsufficientSharesError) {
                setError(err.shares > 0 ? `You hold ${err.shares} share${err.shares === 1 ? '' : 's'} - can't sell ${qty}.` : `You don't hold any ${displayName}.`);
                setPosition((p) => (err.shares > 0 ? { shares: err.shares, avgBuyPrice: p?.avgBuyPrice ?? 0 } : null));
                setQty(Math.max(1, err.shares));
                setToken(crypto.randomUUID());
            } else if (err instanceof TickerUnavailableError) {
                setError('This index isn\'t available to trade right now.');
            } else {
                // Network/unknown: keep the token so a retry stays idempotent.
                setError('Couldn\'t reach the exchange - try again.');
            }
        } finally {
            setBusy(false);
        }
    };

    if (auth === 'loading') {
        return <aside className="hc-tq-trade-panel" aria-label="Trade"><p className="hc-tq-muted">Loading&hellip;</p></aside>;
    }
    if (auth === 'out') {
        return (
            <aside className="hc-tq-trade-panel" aria-label="Trade">
                <h2 className="hc-tq-section-heading">Trade {displayName}</h2>
                <p className="hc-tq-trade-price"><EmberGlyph size={18} /> {fmtEmber(price)} <span className="hc-tq-trade-per">per share</span></p>
                <p className="hc-tq-muted">Log in to buy and sell shares with your Ember.</p>
                <a className="hc-tq-trade-btn" href="/login/">Log in</a>
                <p className="hc-tq-price-note">{priceNote}</p>
            </aside>
        );
    }
    if (auth === 'unonboarded') {
        return (
            <aside className="hc-tq-trade-panel" aria-label="Trade">
                <h2 className="hc-tq-section-heading">Trade {displayName}</h2>
                <p className="hc-tq-muted">Finish setting up your account to start trading.</p>
                <a className="hc-tq-trade-btn" href="/welcome/">Finish setup</a>
            </aside>
        );
    }

    const marketValue = position ? sellCredit(position.shares, price) : 0;
    const costBasis = position ? Math.round(position.shares * position.avgBuyPrice) : 0;
    const pnl = marketValue - costBasis;

    return (
        <aside className="hc-tq-trade-panel" aria-label="Trade">
            <h2 className="hc-tq-section-heading">Trade {displayName}</h2>
            <p className="hc-tq-trade-price"><EmberGlyph size={18} /> {fmtEmber(price)} <span className="hc-tq-trade-per">per share</span></p>

            <div className="hc-tq-ranges hc-tq-trade-sides" role="group" aria-label="Order side">
                <button type="button" className="hc-tq-range" aria-pressed={side === 'buy'} onClick={() => setSide('buy')}>Buy</button>
                <button type="button" className="hc-tq-range" aria-pressed={side === 'sell'} onClick={() => setSide('sell')} disabled={held === 0}>Sell</button>
            </div>

            <label className="hc-tq-qty-label" htmlFor="hc-tq-qty">Shares</label>
            <input id="hc-tq-qty" className="hc-tq-qty" type="number" inputMode="numeric" min={1} step={1}
                max={side === 'sell' ? Math.max(held, 1) : MAX_SHARES_PER_TRADE}
                value={qty}
                onChange={(e) => setQty(Math.floor(Number(e.target.value) || 0))} />
            {side === 'sell' && held > 0 && (
                <button type="button" className="hc-tq-linkbtn" onClick={() => setQty(held)}>Sell all {held}</button>
            )}

            <dl className="hc-tq-preview">
                <div><dt>{side === 'buy' ? 'Cost' : 'You receive'}</dt><dd><EmberGlyph size={13} /> {qtyValid ? preview.toLocaleString('en-US') : '—'}</dd></div>
                <div><dt>Balance</dt><dd><EmberGlyph size={13} /> {(balance ?? 0).toLocaleString('en-US')}</dd></div>
            </dl>

            <button type="button" className="hc-tq-trade-btn" onClick={submit} disabled={busy || !qtyValid || !canAfford}>
                {busy ? 'Placing…' : side === 'buy' ? `Buy ${qtyValid ? qty : ''} ${displayName}` : `Sell ${qtyValid ? qty : ''} ${displayName}`}
            </button>
            {!canAfford && qtyValid && !busy && (
                <p className="hc-tq-trade-hint">{side === 'buy' ? 'Not enough Ember for that many.' : `You hold ${held}.`}</p>
            )}
            {error && <p className="hc-tq-trade-error" role="alert">{error}</p>}
            {notice && <p className="hc-tq-trade-notice" role="status">{notice}</p>}

            <h3 className="hc-tq-position-heading">Your position</h3>
            {position ? (
                <dl className="hc-tq-position">
                    <div><dt>Shares</dt><dd>{position.shares.toLocaleString('en-US')}</dd></div>
                    <div><dt>Avg cost</dt><dd><EmberGlyph size={12} /> {fmtEmber(position.avgBuyPrice)}</dd></div>
                    <div><dt>Value now</dt><dd><EmberGlyph size={12} /> {marketValue.toLocaleString('en-US')}</dd></div>
                    <div><dt>Unrealized</dt><dd className={`is-${signOf(pnl)}`}>{fmtSignedEmber(pnl)}</dd></div>
                </dl>
            ) : (
                <p className="hc-tq-muted">You don&rsquo;t hold {displayName} yet.</p>
            )}
            <a className="hc-tq-portfolio-link" href="/my-portfolio/?tab=indexes">View portfolio &rarr;</a>
            <p className="hc-tq-price-note">{priceNote} Amounts round to whole Ember.</p>
        </aside>
    );
};

// ---------------------------------------------------------------------------------

const TankdaqTickerPage: React.FC<{ tickerKey: string }> = ({ tickerKey }) => {
    const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
    const [data, setData] = useState<DetailResponse | null>(null);
    const [windowId, setWindowId] = useState<WindowId>('3d');
    const [reloadKey, setReloadKey] = useState(0);

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
                if (!cancelled && phase === 'loading') setPhase('error');
            }
        })();
        return () => { cancelled = true; };
        // reloadKey: a completed trade refetches, since the price may have moved.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tickerKey, reloadKey]);

    const delta24 = useMemo(
        () => (data ? sumSince(data.series, Date.now() - 24 * HOUR_MS) : 0),
        [data],
    );
    // The price's % change over the SELECTED chart window - the number beside the price.
    const windowRet = useMemo(() => {
        if (!data) return 0;
        const ms = WINDOWS.find((w) => w.id === windowId)!.ms;
        const { points, anchor } = windowPoints(data.series, ms, Date.now());
        const params = { baseline: data.ticker.priceBaseline, scale: data.ticker.priceScale };
        return windowReturnPct(points[points.length - 1].v, anchor, params);
    }, [data, windowId]);

    // Identity chrome renders in every phase - it hydrates from its own endpoint and
    // must not wait on (or disappear with) this page's data.
    if (phase === 'loading') return <><ContentChrome /><p className="hc-tq-loading">Loading index&hellip;</p></>;
    if (phase === 'error' || !data) return <><ContentChrome /><p className="hc-tq-error">Couldn&rsquo;t load this index right now &mdash; refresh to retry.</p></>;

    const { ticker } = data;
    const priceParams: PriceParams = { baseline: ticker.priceBaseline, scale: ticker.priceScale };
    const copy = tickerCopyFor(ticker.ruleType);
    const totalSign = signOf(ticker.value);
    const d24Sign = signOf(delta24);
    const retSign = signOf(windowRet);
    const windowLabel = WINDOWS.find((w) => w.id === windowId)!.label;
    const dateLabel = (iso: string) => {
        const d = new Date(iso);
        return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    };

    return (
        <div>
            <ContentChrome />
            <a className="hc-tq-back" href="/tankdaq/indexes/">&larr; Index Board</a>
            <header className="hc-tq-header">
                <h1 className="hc-tq-title">{ticker.indexLabel} <span className="hc-tq-symbol">({ticker.displayName})</span></h1>
                {/* The friendly blurb when this strategy has one; the ticker's own
                    terse description is the fallback for a brand-new rule_type. */}
                <p className="hc-tq-desc">{copy?.blurb ?? ticker.description}</p>
                {copy && copy.leagues.length > 0 && (
                    <p className="hc-tq-leagues" aria-label="Leagues this index covers">
                        {copy.leagues.map((l) => <span key={l} className="hc-tq-league">{l}</span>)}
                    </p>
                )}
                <p className="hc-tq-note">{data.note}</p>
                <p className="hc-tq-note">{data.priceNote}</p>
            </header>
            {/* Three direct children so the phone order can differ from the desktop grid:
                on a phone the trade panel follows the chart (not four news items down);
                on desktop the side column spans both rows on the right. */}
            <div className="hc-tq-layout">
                <div className="hc-tq-main">
                    <div className="hc-tq-value-row">
                        <span className="hc-tq-price"><EmberGlyph /> {fmtEmber(ticker.price)}</span>
                        <span className={`hc-tq-return is-${retSign}`}>{fmtPct(windowRet)}</span>
                        <span className="hc-tq-delta24-label">Ember price &middot; {windowLabel} change</span>
                    </div>
                    <p className="hc-tq-index-line">
                        Index <span className={`is-${totalSign}`}>{fmtPct(ticker.value)}</span> all-time
                        &nbsp;&middot;&nbsp; <span className={`is-${d24Sign}`}>({fmtPct(delta24)})</span> last 24 hours
                    </p>
                    <div className="hc-tq-ranges" role="group" aria-label="Chart window">
                        {WINDOWS.map((w) => (
                            <button key={w.id} type="button" className="hc-tq-range"
                                aria-pressed={windowId === w.id} onClick={() => setWindowId(w.id)}>
                                {w.label}
                            </button>
                        ))}
                    </div>
                    <div className="hc-tq-chart-panel">
                        <TickerChart series={data.series} windowId={windowId} displayName={ticker.displayName} priceParams={priceParams} />
                    </div>
                </div>
                <div className="hc-tq-side">
                    <TradePanel
                        tickerKey={ticker.key}
                        displayName={ticker.displayName}
                        price={ticker.price}
                        priceNote={data.priceNote}
                        onTraded={() => setReloadKey((k) => k + 1)}
                    />
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
                <div className="hc-tq-news">
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
