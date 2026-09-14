// The island for the team surfaces (/teams/, /teams/<slug>/, /leagues/<slug>/), one
// bundle for all three. Built by scripts/build-tank-bundles.ts (entry 'teams') so it
// shares the React chunk, and its CSS sibling carries the ContentChrome styles every
// template links.
//
// Three jobs, all from server-baked JSON - there is no fetch and no endpoint:
//   * every page   - the identity chrome (MapHud / PetWidget / encounters / inbox) into
//                    #teams-chrome-root;
//   * a team page  - past the gate, #team-price-root becomes the index detail page's
//                    headline: the Ember price with its window return, the 24H/3D/1W
//                    toggle, and the price chart (price line, points dashed, dots on every
//                    close and Tank tag) - team-price.ts's series through the same
//                    priceFromValue / windowReturnPct the ticker island uses;
//   * a league page - the treemap. Tile AREA is games played in the competition (the
//                    club's sample size, the honest reading of "how much to trust the
//                    colour"). Past the gate a tile is COLOURED and QUOTED by the club's
//                    ALL-TIME price return - its price against the 100 baseline - through
//                    NEON_RGB, so green here means what green means on the index boards.
//                    Below the gate a tile is grey at zero intensity with its games count,
//                    and grey means only that. See the note on retOf for why this board
//                    does not take the index board's adaptive window.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ContentChrome } from './components/ContentChrome';
import { squarifyInto } from './lib/pages-functions/treemap';
import { NEON_RGB, formatEmber, formatQuote, formatSignedPct, neonAlpha, signOf } from './lib/pages-functions/ticker-format';
import { priceFromValue, priceReturnPct, windowReturnPct, type PriceParams } from './lib/pages-functions/ticker-price';
import { plural, signedResidual, tileTitle } from './lib/pages-functions/team-copy';
import type { LeagueBoardModel, LeagueTile } from './lib/pages-functions/team-pages';
import type { TeamPricing, TeamSeriesEvent } from './lib/pages-functions/team-price';

// ---------------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------------

const HOUR_MS = 3600_000;
// The detail-page lens, same three stops as the ticker island.
const WINDOWS = [
    { id: '24h', label: '24H', ms: 24 * HOUR_MS, sentence: 'the past 24 hours' },
    { id: '3d', label: '3D', ms: 72 * HOUR_MS, sentence: 'the past 3 days' },
    { id: '1w', label: '1W', ms: 168 * HOUR_MS, sentence: 'the past week' },
] as const;
type WindowId = (typeof WINDOWS)[number]['id'];

function fmtSignedPts(v: number): string {
    const n = Object.is(v, -0) ? 0 : v;
    return `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}`;
}

// ---------------------------------------------------------------------------------
// Team page: the price headline + windowed chart
// ---------------------------------------------------------------------------------

interface TeamPageData {
    slug: string;
    display: string;
    pricing: TeamPricing;
    residual: number;
    residualLabel: string;
    residualValue: string;
    recordLine: string; // server-rendered HTML fragment (chips), inserted as-is
    readLine: string;
}

interface ChartPoint { t: number; v: number; event?: TeamSeriesEvent }

// The chart's window: the last cumulative BEFORE the cutoff is the anchor (0 if the club
// hadn't started), with synthetic endpoints at the cutoff and at now.
function windowPoints(series: TeamSeriesEvent[], windowMs: number, nowMs: number): { points: ChartPoint[]; anchor: number } {
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
const PAD = { top: 14, right: 50, bottom: 26, left: 56 };

function scaleFor(values: number[], minSpan: number): { lo: number; hi: number; y: (v: number) => number } {
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    if (hi - lo < minSpan) {
        const mid = (hi + lo) / 2;
        lo = mid - minSpan / 2;
        hi = mid + minSpan / 2;
    }
    const span = hi - lo;
    return { lo, hi, y: (v: number) => PAD.top + ((hi - v) / span) * (CH - PAD.top - PAD.bottom) };
}

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

const TeamPriceChart: React.FC<{ series: TeamSeriesEvent[]; windowId: WindowId; display: string; params: PriceParams }> =
    ({ series, windowId, display, params }) => {
        const now = Date.now();
        const windowMs = WINDOWS.find((w) => w.id === windowId)!.ms;
        const { points, anchor } = windowPoints(series, windowMs, now);
        const cutoff = now - windowMs;
        const eventsInWindow = points.filter((p) => p.event).length;
        const last = points[points.length - 1].v;
        const windowRet = windowReturnPct(last, anchor, params);
        const sign = signOf(windowRet);
        const stroke = `rgb(${NEON_RGB[sign]})`;

        const prices = points.map((p) => priceFromValue(p.v, params));
        const anchorPrice = priceFromValue(anchor, params);
        const P = scaleFor(prices, Math.max(anchorPrice * 0.02, 0.01));
        const V = scaleFor(points.map((p) => p.v), 1);
        const x = (t: number) => PAD.left + ((t - cutoff) / windowMs) * (CW - PAD.left - PAD.right);

        const pricePath = points.map((p, i) => `${x(p.t).toFixed(1)},${P.y(prices[i]).toFixed(1)}`).join(' ');
        const pointsPath = points.map((p) => `${x(p.t).toFixed(1)},${V.y(p.v).toFixed(1)}`).join(' ');
        const areaPath = `${pricePath} ${x(now).toFixed(1)},${CH - PAD.bottom} ${x(cutoff).toFixed(1)},${CH - PAD.bottom}`;
        const ticks = tickTimes(windowId, cutoff, now);
        const summary = `${display}: ${formatEmber(prices[prices.length - 1])} Ember, ${formatSignedPct(windowRet)} over the selected window (${eventsInWindow} event${eventsInWindow === 1 ? '' : 's'}); points ${fmtSignedPts(last)}`;

        return (
            <>
                <svg className="hc-tq-svg" viewBox={`0 0 ${CW} ${CH}`} role="img" aria-label={summary}>
                    <title>{summary}</title>
                    <defs>
                        <linearGradient id={`hc-team-grad-${sign}`} x1="0" x2="0" y1="0" y2="1">
                            <stop offset="0" stopColor={stroke} stopOpacity={0.35} />
                            <stop offset="1" stopColor={stroke} stopOpacity={0} />
                        </linearGradient>
                    </defs>
                    {[P.hi, (P.hi + P.lo) / 2, P.lo].map((v, i) => (
                        <g key={`g${i}`}>
                            <line x1={PAD.left} x2={CW - PAD.right} y1={P.y(v)} y2={P.y(v)} stroke="rgba(255,255,255,0.08)" />
                            <text className="hc-tq-ylabel" x={PAD.left - 6} y={P.y(v) + 3.5} textAnchor="end">{formatEmber(v)}</text>
                        </g>
                    ))}
                    {[V.hi, (V.hi + V.lo) / 2, V.lo].map((v, i) => (
                        <text key={`r${i}`} className="hc-tq-ylabel hc-tq-ylabel-index" x={CW - PAD.right + 6} y={V.y(v) + 3.5} textAnchor="start">{fmtSignedPts(v)}</text>
                    ))}
                    <line x1={PAD.left} x2={CW - PAD.right} y1={P.y(anchorPrice)} y2={P.y(anchorPrice)} stroke="rgba(255,255,255,0.3)" strokeDasharray="5 5" />
                    <polygon points={areaPath} fill={`url(#hc-team-grad-${sign})`} />
                    <polyline points={pointsPath} fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth={1.25} strokeDasharray="3 4" />
                    <polyline points={pricePath} fill="none" stroke={stroke} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
                    {points.map((p, i) => p.event && (
                        <circle key={`${p.event.occurredAt}-${i}`} cx={x(p.t)} cy={P.y(prices[i])} r={3.5} fill={stroke} stroke="#160c27" strokeWidth={1}>
                            <title>{`${new Date(p.t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', hour12: true })} · ${p.event.eventType === 'tag' ? 'Tank tag' : 'daily close'} · ${formatEmber(prices[i])} Ember · ${fmtSignedPts(p.event.delta)} pts (running ${fmtSignedPts(p.event.cumulative)})`}</title>
                        </circle>
                    ))}
                    {ticks.map((t, i) => (
                        <text key={`t${i}`} className="hc-tq-tick" x={x(t)} y={CH - 8}
                            textAnchor={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'}>{tickLabel(windowId, t)}</text>
                    ))}
                </svg>
                <p className="hc-tq-chart-legend">
                    <span><span className="hc-tq-legend-swatch" style={{ background: stroke }} />Ember price</span>
                    <span><span className="hc-tq-legend-swatch hc-tq-legend-swatch--index" />Points</span>
                </p>
                {eventsInWindow === 0 && <p className="hc-tq-chart-note">No movement in this window.</p>}
            </>
        );
    };

const TeamPriceView: React.FC<{ data: TeamPageData }> = ({ data }) => {
    const [windowId, setWindowId] = useState<WindowId>('3d');
    const params = useMemo(() => ({ baseline: data.pricing.priceBaseline, scale: data.pricing.priceScale }), [data]);
    const win = WINDOWS.find((w) => w.id === windowId)!;
    const { windowRet, windowPts } = useMemo(() => {
        const { points, anchor } = windowPoints(data.pricing.series, win.ms, Date.now());
        const last = points[points.length - 1].v;
        return { windowRet: windowReturnPct(last, anchor, params), windowPts: Number((last - anchor).toFixed(3)) };
    }, [data, win, params]);
    const sign = signOf(windowRet);
    return (
        <>
            <div className="hc-tq-value-row">
                <span className="hc-tq-price">{formatEmber(data.pricing.price)}<span className="hc-tq-ember">Ember</span></span>
                <span className={`hc-tq-return is-${sign}`}>({formatSignedPct(windowRet)})</span>
                <span className="hc-tq-delta24-label">Ember price &middot; {win.label} change</span>
            </div>
            <p className="hc-tq-index-line">
                Points <span className={`is-${signOf(windowPts)}`}>{fmtSignedPts(windowPts)}</span> over {win.sentence}
                {' · '}<span className={`is-${signOf(data.pricing.value)}`}>{fmtSignedPts(data.pricing.value)}</span> all-time
                {' · '}{data.residualLabel} <span className={`is-${signOf(data.residual)}`}>{data.residualValue}</span>
            </p>
            <p className="hc-tq-index-line" dangerouslySetInnerHTML={{ __html: data.recordLine }} />
            <p className="hc-tq-read">{data.readLine}</p>
            <div className="hc-tq-ranges" role="group" aria-label="Chart window">
                {WINDOWS.map((w) => (
                    <button key={w.id} type="button" className="hc-tq-range" aria-pressed={w.id === windowId} onClick={() => setWindowId(w.id)}>{w.label}</button>
                ))}
            </div>
            <div className="hc-tq-chart-panel">
                <TeamPriceChart series={data.pricing.series} windowId={windowId} display={data.display} params={params} />
            </div>
        </>
    );
};

// ---------------------------------------------------------------------------------
// League board
// ---------------------------------------------------------------------------------

interface Placed extends LeagueTile {
    x: number; y: number; w: number; h: number; // percentages of the board
    /** Price return over the board's window; 0 for an unpriced (grey) tile. */
    ret: number;
    retSign: 'pos' | 'neg' | 'zero';
    mag: number;
}

// Every shorter tail of a club name ('White Sox', 'Sox'), for the fallback below.
const tailsOf = (display: string): string[] => {
    const words = display.split(/\s+/);
    const tails: string[] = [];
    for (let n = words.length - 1; n >= 1; n--) tails.push(words.slice(-n).join(' '));
    return tails;
};

// The tails that would name MORE than one club on this board - 'Sox' (White and Red),
// 'United' (Atlanta, Minnesota, D.C.), 'SC', 'FC'. A tile never shows one of these: a
// bare tile whose tooltip carries the full name beats a tile that names the wrong club.
const ambiguousTails = (tiles: LeagueTile[]): Set<string> => {
    const counts = new Map<string, number>();
    for (const t of tiles) for (const tail of tailsOf(t.display)) counts.set(tail, (counts.get(tail) ?? 0) + 1);
    return new Set([...counts].filter(([, c]) => c > 1).map(([tail]) => tail));
};

const fitText = (t: Placed, innerWpx: number, innerHpx: number, ambiguous: Set<string>) => {
    // 0.8em/char over-estimates Montserrat 900 on purpose (see the index board's note on
    // wide glyphs); club names are long, so the height term binds on short tiles.
    const natural = Math.sqrt((t.w * t.h) / 100) * 9 + 8;
    const capped = Math.min(natural, innerHpx * 0.44);
    const sizeFor = (s: string) => Math.min(capped, innerWpx / (s.length * 0.8));
    // The full name if it is legible at all; otherwise the longest tail that is - 'White
    // Sox' before 'Sox' - skipping any tail another club on this board shares. A tail is
    // already a compromise, so it has to earn a little more size than the full name.
    const candidates = [t.display, ...tailsOf(t.display)];
    for (const [i, text] of candidates.entries()) {
        const px = sizeFor(text);
        const min = i === 0 ? 7 : 9;
        if (px >= min && (i === 0 || !ambiguous.has(text))) return { text, px, show: true };
    }
    return { text: t.display, px: 7, show: false };
};

const LeagueBoard: React.FC<{ model: LeagueBoardModel }> = ({ model }) => {
    const boardRef = useRef<HTMLDivElement | null>(null);
    const popRef = useRef<HTMLDivElement | null>(null);
    const [boardW, setBoardW] = useState(0);
    const [boardH, setBoardH] = useState(0);
    const [popH, setPopH] = useState(0);
    const [hoverKey, setHoverKey] = useState<string | null>(null);
    const [selectedKey, setSelectedKey] = useState<string | null>(null);
    const coarsePointer = useRef(
        typeof window !== 'undefined' && typeof window.matchMedia === 'function'
            ? window.matchMedia('(pointer: coarse)').matches
            : false,
    );

    useLayoutEffect(() => {
        const el = boardRef.current;
        if (!el) return;
        const measure = () => {
            setBoardW(el.clientWidth);
            setBoardH(el.clientHeight);
        };
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    useLayoutEffect(() => {
        if (popRef.current) setPopH(popRef.current.offsetHeight);
    }, [hoverKey, selectedKey, boardW]);

    useEffect(() => {
        const key = new URLSearchParams(window.location.search).get('team');
        if (key) setSelectedKey(key);
    }, []);

    // On touch the first tap selects (opens the card), the second follows the link.
    const onTileClick = useCallback((e: React.MouseEvent, key: string) => {
        if (!coarsePointer.current) return;
        if (selectedKey !== key) {
            e.preventDefault();
            setSelectedKey(key);
        }
    }, [selectedKey]);

    // A tile's colour is the club's ALL-TIME price return - its price against the 100
    // baseline, which is the same fact the residual states and the same thing the club's
    // own page leads with.
    //
    // DELIBERATELY NOT the index board's adaptive window. That board widens 24H -> 7D ->
    // 30D until SOME index moved, which works because all sixteen close every day: they
    // move together, so one lens fits them all. Clubs do not - most of a league is idle on
    // any given day - so a 24H lens rendered 24 of 30 priced MLB clubs at +0.0%, i.e. grey,
    // which on this board already means "not enough games to price". Two different facts,
    // one colour. All-time keeps grey meaning exactly one thing and never leaves a priced
    // club uncoloured. (A windowed lens is a fine follow-up; it needs its own neutral
    // treatment for "priced but idle" first.)
    const retOf = useMemo(() => {
        const ret = new Map<string, number>();
        for (const t of model.tiles) {
            if (t.price === null || t.value === null) continue;
            ret.set(t.slug, priceReturnPct(t.value, model.priceScale));
        }
        return ret;
    }, [model]);
    const maxAbsRet = Math.max(0, ...[...retOf.values()].map((r) => Math.abs(r)));

    // Squarify in the board's real aspect so "square-ish" is judged in the shape the
    // tiles render in. Weights are fixture counts - positive integers, so no floor.
    const aspectH = boardW > 0 && boardH > 0 ? (boardH / boardW) * 100 : 62.5;
    const rects = squarifyInto(model.tiles.map((t) => Math.max(t.fixtures, 1)), { x: 0, y: 0, w: 100, h: aspectH });
    const tiles: Placed[] = model.tiles.map((t, i) => {
        const r = rects[i];
        const ret = retOf.get(t.slug) ?? 0;
        const priced = t.price !== null;
        return {
            ...t,
            x: r.x, y: (r.y / aspectH) * 100, w: r.w, h: (r.h / aspectH) * 100,
            ret,
            retSign: priced ? signOf(ret) : 'zero',
            mag: priced && maxAbsRet > 0 ? Math.abs(ret) / maxAbsRet : 0,
        };
    });

    const gutter = Math.max(5, Math.min(10, Math.round(boardW * 0.009)));
    const ambiguous = ambiguousTails(model.tiles);
    const activeKey = hoverKey ?? selectedKey;
    const activeTile = tiles.find((t) => t.slug === activeKey) ?? null;

    return (
        <>
            <div ref={boardRef} className="hc-lgb-board" role="list" aria-label={`${model.league} clubs`}>
                {boardW > 0 && tiles.map((t) => {
                    const active = t.slug === activeKey;
                    const neon = NEON_RGB[t.retSign];
                    const pad = gutter / 2;
                    const box = {
                        left: `calc(${t.x}% + ${pad}px)`,
                        top: `calc(${t.y}% + ${pad}px)`,
                        width: `calc(${t.w}% - ${gutter}px)`,
                        height: `calc(${t.h}% - ${gutter}px)`,
                    };
                    const innerWpx = (boardW * t.w) / 100 - 2 * pad - 10;
                    const innerHpx = (boardH * t.h) / 100 - 2 * pad;
                    const fit = fitText(t, innerWpx, innerHpx, ambiguous);
                    // Quote: the full "130.95 (+6.7%)" if it fits, else just the return, else
                    // the games count for an unpriced tile; the tooltip always has it all.
                    const quotePx = fit.px * 0.72;
                    const fits = (s: string) => s.length * quotePx * 0.62 <= innerWpx;
                    let quote: string | null = null;
                    if (fit.show && fit.px >= 10) {
                        if (t.price === null) quote = fits(plural(t.fixtures, 'game')) ? plural(t.fixtures, 'game') : null;
                        else {
                            const full = formatQuote(t.price, t.ret);
                            const short = `(${formatSignedPct(t.ret)})`;
                            quote = fits(full) ? full : fits(short) ? short : null;
                        }
                    }
                    // A grey tile is flat: no extrusion, no bloom - it makes no claim.
                    const depth = (t.price === null ? 1.5 : 2.5 + 4.5 * t.mag) * (active ? 1.4 : 1);
                    const border = `2px solid rgba(${neon}, ${active ? 1 : neonAlpha(0.5, t.mag)})`;
                    const boxShadow = [
                        `0 ${depth.toFixed(1)}px 0 rgba(${neon}, ${active ? 0.95 : 0.8})`,
                        `0 ${(depth + 2).toFixed(1)}px 0 rgba(0, 0, 0, 0.95)`,
                        `0 ${(depth + 5).toFixed(1)}px ${(10 + depth).toFixed(1)}px rgba(0, 0, 0, 0.75)`,
                        `inset 0 1px 0 rgba(255, 255, 255, ${active ? 0.22 : 0.12})`,
                        t.price === null ? '' : `inset 0 0 ${Math.round(8 + 22 * t.mag)}px rgba(${neon}, ${(0.12 + 0.3 * t.mag).toFixed(2)})`,
                        active ? `0 0 30px rgba(${neon}, 0.6)` : '',
                    ].filter(Boolean).join(', ');
                    const title = t.price === null
                        ? tileTitle(t)
                        : `${t.display}: ${formatEmber(t.price)} Ember, ${formatSignedPct(t.ret)} all-time; ${tileTitle(t).split(': ')[1]}`;
                    return (
                        <a key={t.slug} role="listitem" className={`hc-lgb-tile${active ? ' is-active' : ''}`} href={`/teams/${t.slug}/`}
                            style={{
                                ...box, border, boxShadow, fontSize: `${Math.max(9, fit.px).toFixed(1)}px`,
                                transform: active ? 'translateY(-3px)' : undefined,
                            }}
                            onMouseEnter={() => setHoverKey(t.slug)}
                            onMouseLeave={() => setHoverKey((k) => (k === t.slug ? null : k))}
                            onFocus={() => setHoverKey(t.slug)}
                            onBlur={() => setHoverKey((k) => (k === t.slug ? null : k))}
                            onClick={(e) => onTileClick(e, t.slug)}
                            aria-label={title}>
                            {fit.show && <span className="hc-lgb-sym">{fit.text}</span>}
                            {quote && <span className="hc-lgb-quote" style={{ color: `rgb(${neon})` }}>{quote}</span>}
                        </a>
                    );
                })}
                {activeTile && (() => {
                    const popW = Math.min(320, boardW - 24);
                    const cx = (boardW * (activeTile.x + activeTile.w / 2)) / 100;
                    const blockTop = (boardH * activeTile.y) / 100;
                    const blockBottom = (boardH * (activeTile.y + activeTile.h)) / 100;
                    const left = Math.max(12, Math.min(cx - popW / 2, boardW - popW - 12));
                    const above = blockTop - popH - 10;
                    const top = above >= 12 ? above : Math.min(blockBottom + 10, Math.max(12, boardH - popH - 12));
                    const neon = NEON_RGB[activeTile.retSign];
                    return (
                        <div ref={popRef} className="hc-lgb-pop" role="status"
                            style={{ left: `${left}px`, top: `${top}px`, width: `${popW}px`, borderLeftColor: `rgb(${neon})` }}>
                            <p className="hc-lgb-detail-head">
                                <span className="hc-lgb-detail-name">{activeTile.display}</span>
                                <span className="hc-lgb-detail-delta" style={{ color: `rgb(${neon})` }}>
                                    {activeTile.price === null
                                        ? plural(activeTile.fixtures, 'game')
                                        : <>{formatEmber(activeTile.price)} Ember ({formatSignedPct(activeTile.ret)})</>}
                                </span>
                            </p>
                            <p className="hc-lgb-detail-blurb">
                                {activeTile.residual === null
                                    ? `${plural(activeTile.games, 'directional game')} so far - the club is priced at ${model.minGames}.`
                                    : `Market residual ${signedResidual(activeTile.residual)} over ${plural(activeTile.games, 'directional game')}: results ran ${Math.abs(activeTile.residual).toFixed(1)} wins ${activeTile.residual >= 0 ? 'ahead of' : 'behind'} the market's price. ${plural(activeTile.fixtures, 'game')} in ${model.league}.`}
                            </p>
                            <span className="hc-lgb-detail-more">
                                {coarsePointer.current ? `Tap again to open ${activeTile.display}` : `Click to open ${activeTile.display}`} &rarr;
                            </span>
                        </div>
                    );
                })()}
            </div>
        </>
    );
};

// ---------------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------------

function readJson<T>(id: string): T | null {
    const el = document.getElementById(id);
    if (!el?.textContent) return null;
    try {
        return JSON.parse(el.textContent) as T;
    } catch {
        return null;
    }
}

function mount(): void {
    const chromeRoot = document.getElementById('teams-chrome-root');
    if (chromeRoot) {
        chromeRoot.replaceChildren();
        createRoot(chromeRoot).render(<ContentChrome />);
    }

    const priceRoot = document.getElementById('team-price-root');
    const teamData = readJson<TeamPageData>('team-page-data');
    if (priceRoot && teamData?.pricing?.series) {
        priceRoot.replaceChildren();
        createRoot(priceRoot).render(<TeamPriceView data={teamData} />);
    }

    const leagueRoot = document.getElementById('league-root');
    const model = readJson<LeagueBoardModel>('league-page-data');
    if (leagueRoot && model && Array.isArray(model.tiles) && model.tiles.length > 0) {
        // The board's own frame becomes React's root; the crawlable fallback goes, and
        // so do the frame's list semantics - LeagueBoard renders its own board element
        // with the same role and label, and nested lists would read twice.
        leagueRoot.replaceChildren();
        leagueRoot.className = '';
        leagueRoot.removeAttribute('role');
        leagueRoot.removeAttribute('aria-label');
        createRoot(leagueRoot).render(<LeagueBoard model={model} />);
    }
}

mount();
