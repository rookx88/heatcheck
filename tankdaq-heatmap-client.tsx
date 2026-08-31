// TANKDAQ Index Board island (/tankdaq/indexes/) - the crypto-heatmap view of every
// Exchange ticker: a squarified treemap of raised black blocks where each index's
// area tracks the MAGNITUDE of its movement over the active window, its neon edge the
// direction (green up / red down, slate flat), and its extrusion depth the magnitude
// again - bigger movers stand taller. Every tile links to its detail page.
//
// ADAPTIVE WINDOW: 24h is the headline, but ticker events arrive in bursts (a publish
// tags, a resolved game settles), so plenty of real days have none at all - and a
// board where every index reads 0.0% degenerates into eight equal grey blocks that
// look broken rather than quiet. So the window widens until it finds movement:
// 24h -> 7d -> 30d -> all-time, and the board says which one it settled on. It never
// invents movement; it only widens the lens and labels the lens honestly.
//
// Hovering (or focusing) a block lights it and fills the description panel under the
// board with what that index reacts to (ticker-copy.ts). Touch can't hover, so on a
// coarse pointer the first tap SELECTS a block (glow + description) and a second tap
// on the same block opens its page - the tile stays a real link for mouse and
// keyboard. ?index=<key> preselects one, so a board state is linkable.
//
// Data: /api/tickers (meta + values) + /api/tickers/chart (full event series - window
// deltas are summed here, same rule as the detail page). Styles live in
// scripts/templates/tankdaq-indexes-template.ts.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { indexLabelOf, tickerCopyFor } from './lib/pages-functions/ticker-copy';
import { chooseWindow, type WindowInfo, type WindowedEvent as SeriesEvent } from './lib/pages-functions/ticker-window';
import { ContentChrome } from './components/ContentChrome';

interface TickerRow { key: string; displayName: string; ruleType: string; description: string; tabOrder: number; value: number }

interface Tile {
    key: string;
    displayName: string;
    indexLabel: string;
    ruleType: string;
    description: string;
    value: number;   // all-time cumulative
    delta: number;   // movement over the active window (see WINDOWS)
    x: number; y: number; w: number; h: number; // percentages of the board
}

// Window selection + summing live in lib/pages-functions/ticker-window.ts: pure,
// CSS-free, and therefore directly testable (this island can't be imported outside a
// bundler - it pulls component stylesheets).

function fmtPct(v: number): string {
    const n = Object.is(v, -0) ? 0 : v;
    return `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------------
// Squarified treemap (Bruls et al.) - plenty at n=8. Weights in, percentage rects
// out. Items must arrive sorted by weight descending.
// ---------------------------------------------------------------------------------

interface Weighted { weight: number; index: number }
interface Rect { x: number; y: number; w: number; h: number }

// Aspect quality of a candidate row laid against the remaining rect's shorter side:
// strip thickness = (row weight / remaining weight) x (remaining area / side length),
// each tile's length along the strip is its share of the side. Lower is squarer.
function worstRatio(row: Weighted[], rect: Rect, total: number): number {
    const side = Math.min(rect.w, rect.h);
    const sum = row.reduce((s, r) => s + r.weight, 0);
    if (sum === 0 || side === 0 || total === 0) return Infinity;
    const thickness = (sum / total) * ((rect.w * rect.h) / side);
    let worst = 0;
    for (const r of row) {
        const len = (r.weight / sum) * side;
        if (len === 0 || thickness === 0) return Infinity;
        worst = Math.max(worst, len / thickness, thickness / len);
    }
    return worst;
}

// Carve the row's strip off the remaining rect (vertical strip when the rect is wide,
// horizontal when tall) and return what's left.
function layoutRow(row: Weighted[], rect: Rect, total: number, out: Rect[]): Rect {
    const sum = row.reduce((s, r) => s + r.weight, 0);
    let offset = 0;
    if (rect.w >= rect.h) {
        const w = (sum / total) * rect.w;
        for (const r of row) {
            const h = (r.weight / sum) * rect.h;
            out[r.index] = { x: rect.x, y: rect.y + offset, w, h };
            offset += h;
        }
        return { x: rect.x + w, y: rect.y, w: rect.w - w, h: rect.h };
    } else {
        const h = (sum / total) * rect.h;
        for (const r of row) {
            const w = (r.weight / sum) * rect.w;
            out[r.index] = { x: rect.x + offset, y: rect.y, w, h };
            offset += w;
        }
        return { x: rect.x, y: rect.y + h, w: rect.w, h: rect.h - h };
    }
}

function squarify(weights: number[], width: number, height: number): Rect[] {
    const items: Weighted[] = weights.map((weight, index) => ({ weight, index })).sort((a, b) => b.weight - a.weight);
    const out: Rect[] = new Array(weights.length);
    let rect: Rect = { x: 0, y: 0, w: width, h: height };
    let total = weights.reduce((s, w) => s + w, 0);
    let row: Weighted[] = [];
    for (const item of items) {
        if (row.length === 0 || worstRatio([...row, item], rect, total) <= worstRatio(row, rect, total)) {
            row.push(item);
        } else {
            rect = layoutRow(row, rect, total, out);
            total -= row.reduce((s, r) => s + r.weight, 0);
            row = [item];
        }
    }
    if (row.length) layoutRow(row, rect, total, out);
    return out;
}

// ---------------------------------------------------------------------------------

// Per-direction neon, as rgb triplets so border/glow alphas can scale with magnitude.
const NEON = { pos: '61, 220, 100', neg: '255, 107, 87', zero: '148, 163, 184' } as const;

const TankdaqBoard: React.FC = () => {
    const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
    const [tiles, setTiles] = useState<Tile[]>([]);
    const [note, setNote] = useState('');
    const [maxAbs, setMaxAbs] = useState(0);
    const [windowInfo, setWindowInfo] = useState<WindowInfo>({ label: 'the last 24 hours', short: '24H', widened: false });
    const boardRef = useRef<HTMLDivElement | null>(null);
    const [boardW, setBoardW] = useState(0);
    const [hoverKey, setHoverKey] = useState<string | null>(null);
    const [selectedKey, setSelectedKey] = useState<string | null>(null);
    // Read once: a session doesn't switch pointer types mid-visit (same posture as
    // Egg3D's reduced-motion probe).
    const coarsePointer = useRef(
        typeof window !== 'undefined' && typeof window.matchMedia === 'function'
            ? window.matchMedia('(pointer: coarse)').matches
            : false,
    );

    // ?index=<key> preselects a block, so a board state can be linked or screenshotted.
    useEffect(() => {
        const key = new URLSearchParams(window.location.search).get('index');
        if (key) setSelectedKey(key);
    }, []);

    // First tap on a coarse pointer reveals (there is no hover to reveal with); the
    // second tap on the same block follows the link like any other visit.
    const onTileClick = useCallback((e: React.MouseEvent, key: string) => {
        if (!coarsePointer.current) return;
        if (selectedKey !== key) {
            e.preventDefault();
            setSelectedKey(key);
        }
    }, [selectedKey]);

    // Measure the board so tile type can be sized in real px (no viewport guesswork -
    // this is what keeps long symbols inside small tiles at every screen size).
    useLayoutEffect(() => {
        const el = boardRef.current;
        if (!el) return;
        setBoardW(el.clientWidth);
        const ro = new ResizeObserver(() => setBoardW(el.clientWidth));
        ro.observe(el);
        return () => ro.disconnect();
    }, [phase]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const [listRes, chartRes] = await Promise.all([fetch('/api/tickers'), fetch('/api/tickers/chart')]);
                if (!listRes.ok || !chartRes.ok) throw new Error(`tickers ${listRes.status}/${chartRes.status}`);
                const list = (await listRes.json()) as { note: string; tickers: TickerRow[] };
                const chart = (await chartRes.json()) as { series: Record<string, SeriesEvent[]> };
                if (cancelled) return;

                // Widen until something actually moved - see ADAPTIVE WINDOW up top.
                const { deltas, info } = chooseWindow(list.tickers, chart.series, Date.now());
                const rows = list.tickers.map((t, i) => ({ ...t, delta: deltas[i] }));

                const biggest = Math.max(...rows.map((r) => Math.abs(r.delta)), 0);
                // Weight floor keeps quiet indexes visible and tappable; an all-quiet
                // board degrades to equal tiles.
                const floor = biggest > 0 ? biggest * 0.15 : 1;
                const weights = rows.map((r) => Math.max(Math.abs(r.delta), floor));
                // 100x62.5 mirrors the desktop board's 16:10 aspect so "squarified"
                // is judged in roughly the shape the tiles actually render in.
                const rects = squarify(weights, 100, 62.5);
                setTiles(rows.map((r, i) => ({
                    key: r.key,
                    displayName: r.displayName,
                    indexLabel: indexLabelOf(r.ruleType),
                    ruleType: r.ruleType,
                    description: r.description,
                    value: r.value,
                    delta: r.delta,
                    x: rects[i].x, y: (rects[i].y / 62.5) * 100, w: rects[i].w, h: (rects[i].h / 62.5) * 100,
                })));
                setMaxAbs(biggest);
                setWindowInfo(info);
                setNote(list.note);
                setPhase('ready');
            } catch (err) {
                console.error('[TANKDAQ] board fetch failed:', err);
                if (!cancelled) setPhase('error');
            }
        })();
        return () => { cancelled = true; };
    }, []);

    // Hover wins over selection while a pointer is on a block, so a mouse user's
    // reading follows the cursor and a touch user's selection persists.
    const activeKey = hoverKey ?? selectedKey;
    const activeTile = tiles.find((t) => t.key === activeKey) ?? null;
    // Gutter between blocks: wide enough for a block's extruded side and cast shadow
    // to land in open space rather than on its neighbour, but scaled to the board so
    // phones don't lose tile area to it.
    const gutter = Math.max(5, Math.min(10, Math.round(boardW * 0.009)));

    // Identity chrome renders in every phase - it hydrates from its own endpoint and
    // must not wait on (or disappear with) the board's data.
    if (phase === 'loading') return <><ContentChrome /><p className="hc-tqb-loading">Loading the board&hellip;</p></>;
    if (phase === 'error') return <><ContentChrome /><p className="hc-tqb-error">Couldn&rsquo;t load the board right now &mdash; refresh to retry.</p></>;

    return (
        <div>
            <ContentChrome />
            <header className="hc-tqb-header">
                <h1 className="hc-tqb-title">TANKDAQ <span style={{ color: 'var(--hc-gold)' }}>Index Board</span></h1>
                <p className="hc-tqb-sub">Every index at a glance &mdash; tile size tracks the size of the move over {windowInfo.label}, color its direction.</p>
                {windowInfo.widened && (
                    <p className="hc-tqb-widened">No index moved in the last 24 hours &mdash; showing {windowInfo.label} instead.</p>
                )}
            </header>
            <div ref={boardRef} className="hc-tqb-board" role="list" aria-label={`Index heatmap, ${windowInfo.label}`}>
                {boardW > 0 && tiles.map((t) => {
                    const mag = maxAbs > 0 ? Math.abs(t.delta) / maxAbs : 0;
                    const dir = t.delta > 0 ? 'pos' : t.delta < 0 ? 'neg' : 'zero';
                    const neon = NEON[dir];
                    const active = t.key === activeKey;
                    // Extruded block: the neon-lit face sits on a stack of shadows -
                    // a solid neon side (depth scales with the move, so big movers
                    // stand taller), a dimmer second step, the drop shadow it casts,
                    // and an inset top highlight for the lit top edge. Active blocks
                    // rise: deeper side + an outer bloom in their own colour.
                    const depth = (2.5 + 4.5 * mag) * (active ? 1.4 : 1);
                    const border = `2px solid rgba(${neon}, ${active ? 1 : (0.5 + 0.5 * mag).toFixed(2)})`;
                    const boxShadow = [
                        // The block's side face: near-solid neon, so it reads as a lit
                        // edge rather than a glow bleeding into the black board.
                        `0 ${depth.toFixed(1)}px 0 rgba(${neon}, ${active ? 0.95 : 0.8})`,
                        // A hard dark under-edge grounds the side and separates the
                        // block from whatever sits below it.
                        `0 ${(depth + 2).toFixed(1)}px 0 rgba(0, 0, 0, 0.95)`,
                        `0 ${(depth + 5).toFixed(1)}px ${(10 + depth).toFixed(1)}px rgba(0, 0, 0, 0.75)`,
                        `inset 0 1px 0 rgba(255, 255, 255, ${active ? 0.22 : 0.12})`,
                        `inset 0 0 ${Math.round(8 + 22 * mag)}px rgba(${neon}, ${(0.12 + 0.3 * mag).toFixed(2)})`,
                        active ? `0 0 30px rgba(${neon}, 0.6)` : '',
                    ].filter(Boolean).join(', ');
                    // Type in real px from the measured board: the symbol must fit the
                    // tile's inner width. 0.8em/char is a deliberate over-estimate of
                    // Montserrat 900 - the wide-glyph symbols ($MOONSHOT, $GRIDIRON)
                    // graze the edge at a tighter ratio.
                    const tileWpx = (boardW * t.w) / 100;
                    const fitPx = (tileWpx - 2 * gutter - 10) / (t.displayName.length * 0.8);
                    const fontPx = Math.max(9, Math.min(Math.sqrt((t.w * t.h) / 100) * 9 + 8, fitPx));
                    return (
                        <a key={t.key} role="listitem" className={`hc-tqb-tile${active ? ' is-active' : ''}`} href={`/tankdaq/${t.key}/`}
                            style={{
                                // Gutters: each block is inset so its extruded side and
                                // drop shadow land in open space, not on its neighbour.
                                left: `calc(${t.x}% + ${gutter}px)`,
                                top: `calc(${t.y}% + ${gutter}px)`,
                                width: `calc(${t.w}% - ${2 * gutter}px)`,
                                height: `calc(${t.h}% - ${2 * gutter}px)`,
                                border, boxShadow, fontSize: `${fontPx.toFixed(1)}px`,
                                transform: active ? 'translateY(-3px)' : undefined,
                            }}
                            onMouseEnter={() => setHoverKey(t.key)}
                            onMouseLeave={() => setHoverKey((k) => (k === t.key ? null : k))}
                            onFocus={() => setHoverKey(t.key)}
                            onBlur={() => setHoverKey((k) => (k === t.key ? null : k))}
                            onClick={(e) => onTileClick(e, t.key)}
                            aria-label={`${t.displayName}: ${fmtPct(t.delta)} over ${windowInfo.label}, ${fmtPct(t.value)} overall`}>
                            <span className="hc-tqb-sym">{t.displayName}</span>
                            <span className="hc-tqb-delta" style={{ color: `rgb(${neon})` }}>{fmtPct(t.delta)}</span>
                            {/* The all-time subline is redundant when all-time IS the metric. */}
                            {t.w * t.h > 90 && windowInfo.short !== 'ALL' && <span className="hc-tqb-total">{fmtPct(t.value)} all-time</span>}
                        </a>
                    );
                })}
            </div>
            <div className="hc-tqb-detail" style={activeTile ? { borderLeftColor: `rgb(${NEON[activeTile.delta > 0 ? 'pos' : activeTile.delta < 0 ? 'neg' : 'zero']})` } : undefined}>
                {activeTile ? (() => {
                    const copy = tickerCopyFor(activeTile.ruleType);
                    const dir = activeTile.delta > 0 ? 'pos' : activeTile.delta < 0 ? 'neg' : 'zero';
                    return (
                        <>
                            <p className="hc-tqb-detail-head">
                                <span className="hc-tqb-detail-name">{activeTile.displayName}</span>
                                <span className="hc-tqb-detail-index">{activeTile.indexLabel}</span>
                                <span className="hc-tqb-detail-delta" style={{ color: `rgb(${NEON[dir]})` }}>{fmtPct(activeTile.delta)} <span style={{ fontSize: '0.7em', opacity: 0.7 }}>{windowInfo.short}</span></span>
                            </p>
                            <p className="hc-tqb-detail-blurb">{copy?.blurb ?? activeTile.description}</p>
                            {copy && copy.leagues.length > 0 && (
                                <p className="hc-tqb-detail-leagues">
                                    {copy.leagues.map((l) => <span key={l} className="hc-tqb-detail-league">{l}</span>)}
                                </p>
                            )}
                            <a className="hc-tqb-detail-more" href={`/tankdaq/${activeTile.key}/`}>Open {activeTile.displayName} &rarr;</a>
                        </>
                    );
                })() : (
                    <p className="hc-tqb-detail-hint">
                        {coarsePointer.current
                            ? 'Tap an index to see what moves it — tap it again to open its page.'
                            : 'Hover an index to see what moves it, or click through to its page.'}
                    </p>
                )}
            </div>
            <p className="hc-tqb-legend">
                <span style={{ color: '#3ddc64' }}><span className="hc-tqb-swatch" />Up &middot; {windowInfo.short}</span>
                <span style={{ color: '#ff6b57' }}><span className="hc-tqb-swatch" />Down &middot; {windowInfo.short}</span>
                <span style={{ color: '#94a3b8' }}><span className="hc-tqb-swatch" />Flat</span>
            </p>
            {note && <p className="hc-tqb-note">{note}</p>}
        </div>
    );
};

function mount() {
    const root = document.getElementById('tankdaq-indexes-root');
    if (!root) return;
    // Drop the crawlable fallback - createRoot().render() appends, not replaces.
    root.replaceChildren();
    createRoot(root).render(<TankdaqBoard />);
}

mount();
