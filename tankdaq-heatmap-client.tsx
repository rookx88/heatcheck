// TANKDAQ Index Board island (/tankdaq/indexes/) - the crypto-heatmap view of every
// Exchange ticker: a squarified treemap on black where each index's tile area tracks
// the MAGNITUDE of its last-24h movement and its color the direction (neon green up /
// red down, dimmer the smaller the move; slate for flat). Every tile links to the
// index's detail page (/tankdaq/<key>/). Data: /api/tickers (meta + values) +
// /api/tickers/chart (full event series - the 24h deltas are computed here, same rule
// as the detail page). Styles live in scripts/templates/tankdaq-indexes-template.ts.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

interface TickerRow { key: string; displayName: string; ruleType: string; tabOrder: number; value: number }
interface SeriesEvent { delta: number; occurredAt: string }

interface Tile {
    key: string;
    displayName: string;
    value: number;
    delta24: number;
    x: number; y: number; w: number; h: number; // percentages of the board
}

const HOUR_MS = 3600_000;

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
    const boardRef = useRef<HTMLDivElement | null>(null);
    const [boardW, setBoardW] = useState(0);

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

                const cutoff = Date.now() - 24 * HOUR_MS;
                const rows = list.tickers.map((t) => {
                    let delta24 = 0;
                    for (const e of chart.series[t.key] ?? []) {
                        if (new Date(e.occurredAt).getTime() >= cutoff) delta24 += e.delta;
                    }
                    return { ...t, delta24: Number(delta24.toFixed(3)) };
                });

                const biggest = Math.max(...rows.map((r) => Math.abs(r.delta24)), 0);
                // Weight floor keeps quiet indexes visible and tappable; an all-quiet
                // day degrades to equal tiles.
                const floor = biggest > 0 ? biggest * 0.15 : 1;
                const weights = rows.map((r) => Math.max(Math.abs(r.delta24), floor));
                // 100x62.5 mirrors the desktop board's 16:10 aspect so "squarified"
                // is judged in roughly the shape the tiles actually render in.
                const rects = squarify(weights, 100, 62.5);
                setTiles(rows.map((r, i) => ({
                    key: r.key,
                    displayName: r.displayName,
                    value: r.value,
                    delta24: r.delta24,
                    x: rects[i].x, y: (rects[i].y / 62.5) * 100, w: rects[i].w, h: (rects[i].h / 62.5) * 100,
                })));
                setMaxAbs(biggest);
                setNote(list.note);
                setPhase('ready');
            } catch (err) {
                console.error('[TANKDAQ] board fetch failed:', err);
                if (!cancelled) setPhase('error');
            }
        })();
        return () => { cancelled = true; };
    }, []);

    if (phase === 'loading') return <p className="hc-tqb-loading">Loading the board&hellip;</p>;
    if (phase === 'error') return <p className="hc-tqb-error">Couldn&rsquo;t load the board right now &mdash; refresh to retry.</p>;

    return (
        <div>
            <header className="hc-tqb-header">
                <h1 className="hc-tqb-title">TANKDAQ <span style={{ color: 'var(--hc-gold)' }}>Index Board</span></h1>
                <p className="hc-tqb-sub">Every index at a glance &mdash; tile size tracks the size of the last-24h move, color its direction.</p>
            </header>
            <div ref={boardRef} className="hc-tqb-board" role="list" aria-label="Index heatmap, last 24 hours">
                {boardW > 0 && tiles.map((t) => {
                    const mag = maxAbs > 0 ? Math.abs(t.delta24) / maxAbs : 0;
                    const dir = t.delta24 > 0 ? 'pos' : t.delta24 < 0 ? 'neg' : 'zero';
                    const neon = NEON[dir];
                    // Black fill, neon border - direction from the hue, magnitude from
                    // border/glow intensity (on top of tile area).
                    const border = `2px solid rgba(${neon}, ${(0.5 + 0.5 * mag).toFixed(2)})`;
                    const boxShadow = `inset 0 0 ${Math.round(8 + 22 * mag)}px rgba(${neon}, ${(0.12 + 0.3 * mag).toFixed(2)})`;
                    // Type in real px from the measured board: the symbol must fit the
                    // tile's inner width (Montserrat 900 runs ~0.72em/char).
                    const tileWpx = (boardW * t.w) / 100;
                    const fitPx = (tileWpx - 14) / (t.displayName.length * 0.72);
                    const fontPx = Math.max(9, Math.min(Math.sqrt((t.w * t.h) / 100) * 9 + 8, fitPx));
                    return (
                        <a key={t.key} role="listitem" className="hc-tqb-tile" href={`/tankdaq/${t.key}/`}
                            style={{ left: `${t.x}%`, top: `${t.y}%`, width: `${t.w}%`, height: `${t.h}%`, border, boxShadow, fontSize: `${fontPx.toFixed(1)}px` }}
                            aria-label={`${t.displayName}: ${fmtPct(t.delta24)} in the last 24 hours, ${fmtPct(t.value)} overall`}>
                            <span className="hc-tqb-sym">{t.displayName}</span>
                            <span className="hc-tqb-delta" style={{ color: `rgb(${neon})` }}>{fmtPct(t.delta24)}</span>
                            {t.w * t.h > 90 && <span className="hc-tqb-total">{fmtPct(t.value)} all-time</span>}
                        </a>
                    );
                })}
            </div>
            <p className="hc-tqb-legend">
                <span style={{ color: '#3ddc64' }}><span className="hc-tqb-swatch" />Up last 24h</span>
                <span style={{ color: '#ff6b57' }}><span className="hc-tqb-swatch" />Down last 24h</span>
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
