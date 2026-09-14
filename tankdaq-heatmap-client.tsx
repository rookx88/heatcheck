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
import { layoutNested } from './lib/pages-functions/treemap';
import { leagueShortCode, parseLeagueRule } from './lib/pages-functions/league-rules';
import { priceReturnPct } from './lib/pages-functions/ticker-price';
import { NEON_RGB, formatEmber, formatQuote, formatSignedPct, signOf } from './lib/pages-functions/ticker-format';
import { ContentChrome } from './components/ContentChrome';

interface TickerRow {
    key: string; displayName: string; ruleType: string; description: string;
    tabOrder: number; value: number;
    // The Ember price and the two inputs behind it (getTickerValues). priceScale turns
    // a window's points move into the price return the tile quotes.
    price: number; priceBaseline: number; priceScale: number;
    parentKey?: string | null;
}

// A league sub-index is drawn INSIDE the index it slices, so a tile is one of three
// things. Every tile is still an absolutely-positioned sibling in the board: the nested
// layout hands back absolute rects, so nothing has to be a DOM descendant of anything
// else. That is what keeps a child out of its parent's <a> (one link may not contain
// another) and keeps a hover on a child from also firing the parent's.
type TileKind =
    | 'leaf'       // a top-level index with no children - the whole tile is its link
    | 'container'  // a family's raised block; decorative, its children sit on top of it
    | 'header'     // the family's own symbol/value strip, and its only clickable area
    | 'child'      // one slice, inset on its parent's block
    // Level three ($CHALK -> $FOOTY -> $EPLCHALK). A child that holds its own family
    // plays the same container/header pair its root does, one level in.
    | 'childcontainer'
    | 'childheader'
    | 'grandchild';

interface Tile {
    key: string;
    kind: TileKind;
    displayName: string;
    shortLabel: string | null; // 'NBA' etc - fallback when the tile is too narrow
    indexLabel: string;
    ruleType: string;
    description: string;
    value: number;   // all-time cumulative index points (aria only - the detail page shows it)
    delta: number;   // points moved over the active window (see WINDOWS)
    price: number;
    priceReturnPct: number; // the price's % change over the active window - what the tile shows and is sized by
    returnLabel: string;    // formatSignedPct(priceReturnPct)
    quote: string;          // formatQuote(price, priceReturnPct) - "45.23 (+1.2%)"
    x: number; y: number; w: number; h: number; // percentages of the board
}

// Window selection + summing live in lib/pages-functions/ticker-window.ts, and the
// quote formatters in ticker-format.ts: pure, CSS-free, and therefore directly
// testable (this island can't be imported outside a bundler - it pulls component
// stylesheets).

// The squarified-treemap math lives in lib/pages-functions/treemap.ts so this board
// and the homepage's server-rendered SVG board lay out identically by construction.

// ---------------------------------------------------------------------------------

// Per-direction neon, as rgb triplets so border/glow alphas can scale with magnitude.
// The one palette (ticker-format.ts): a green tile here is the same green as the
// homepage board's and the league boards'.
const NEON = NEON_RGB;

const TankdaqBoard: React.FC = () => {
    const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
    const [tiles, setTiles] = useState<Tile[]>([]);
    const [note, setNote] = useState('');
    const [priceNote, setPriceNote] = useState('');
    const [maxAbs, setMaxAbs] = useState(0);
    const [windowInfo, setWindowInfo] = useState<WindowInfo>({ label: 'the last 24 hours', short: '24H', widened: false });
    const boardRef = useRef<HTMLDivElement | null>(null);
    const popRef = useRef<HTMLDivElement | null>(null);
    const [boardW, setBoardW] = useState(0);
    const [boardH, setBoardH] = useState(0);
    const [popH, setPopH] = useState(0);
    const [hoverKey, setHoverKey] = useState<string | null>(null);
    const [selectedKey, setSelectedKey] = useState<string | null>(null);

    // Hover wins over selection while a pointer is on a block, so a mouse user's
    // reading follows the cursor and a touch user's selection persists.
    const activeKey = hoverKey ?? selectedKey;
    const activeTile = tiles.find((t) => t.key === activeKey) ?? null;
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
    // this is what keeps long symbols inside small tiles at every screen size) and so
    // the hover card can be clamped inside the board's bounds.
    useLayoutEffect(() => {
        const el = boardRef.current;
        if (!el) return;
        const measure = () => { setBoardW(el.clientWidth); setBoardH(el.clientHeight); };
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [phase]);

    // The card's own height decides whether it can sit above its block or has to sit
    // below; measured after it renders, so the first frame may be a few px off.
    useLayoutEffect(() => {
        if (popRef.current) setPopH(popRef.current.offsetHeight);
    }, [activeKey, boardW]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const [listRes, chartRes] = await Promise.all([fetch('/api/tickers'), fetch('/api/tickers/chart')]);
                if (!listRes.ok || !chartRes.ok) throw new Error(`tickers ${listRes.status}/${chartRes.status}`);
                const list = (await listRes.json()) as { note: string; priceNote?: string; tickers: TickerRow[] };
                const chart = (await chartRes.json()) as { series: Record<string, SeriesEvent[]> };
                if (cancelled) return;

                // Widen until something actually moved - see ADAPTIVE WINDOW up top.
                // Everything visual then follows the PRICE return over that window,
                // not the raw points: per-ticker price scales were tuned so a one-sigma
                // day is ~12% on every index (seed_ticker_prices_v1.sql), which makes
                // the return the normalised "how big was this move" across indexes.
                const { deltas, info } = chooseWindow(list.tickers, chart.series, Date.now());
                const rows = list.tickers.map((t, i) => ({
                    ...t, delta: deltas[i], priceReturnPct: priceReturnPct(deltas[i], t.priceScale),
                }));

                const biggest = Math.max(...rows.map((r) => Math.abs(r.priceReturnPct)), 0);

                // A ticker whose parent isn't on the board is laid out as a root rather
                // than dropped - a bad parent_key can never make an index disappear.
                // Depth is WALKED, not inferred from parentKey - since the league slices
                // landed there are three rings, so "has a parent" no longer says which
                // one a tile belongs to. Cycle-safe via `seen`, so a bad parent_key loop
                // resolves deep instead of hanging the board.
                const present = new Set(rows.map((r) => r.key));
                const byKey = new Map(rows.map((r) => [r.key, r]));
                const parentOf = (r: typeof rows[number]) =>
                    (r.parentKey && present.has(r.parentKey) ? r.parentKey : null);
                const depthOf = (r: typeof rows[number]): number => {
                    let d = 1;
                    let cur = parentOf(r);
                    const seen = new Set([r.key]);
                    while (cur && !seen.has(cur)) { seen.add(cur); d++; cur = parentOf(byKey.get(cur)!); }
                    return d;
                };
                const roots = rows.filter((r) => depthOf(r) === 1);
                const families = roots.map((p) => rows.filter((c) => depthOf(c) === 2 && c.parentKey === p.key));
                const gFamilies = families.map((f) =>
                    f.map((c) => rows.filter((g) => depthOf(g) >= 3 && g.parentKey === c.key)));

                // 100x62.5 mirrors the desktop board's 16:10 aspect so "squarified"
                // is judged in roughly the shape the tiles actually render in.
                const BH = 62.5;
                const layout = layoutNested(
                    roots.map((r) => r.priceReturnPct),
                    families.map((f) => f.map((c) => c.priceReturnPct)),
                    100, BH,
                    {
                        headerRatio: 0.28, headerMin: 5, headerMax: 13, padding: 1.2,
                        grandchildHeaderRatio: 0.28, grandchildHeaderMin: 3, grandchildHeaderMax: 8,
                        grandchildPadding: 0.6,
                        // This board renders far wider than the homepage's (a full-width
                        // panel rather than a ~540px column), so the same tile carries
                        // roughly twice the pixels and the third ring stays readable at a
                        // smaller share of the box. Still gated, for the phone case.
                        grandchildMinArea: 14,
                    },
                    gFamilies.map((f) => f.map((gs) => gs.map((g) => g.priceReturnPct))),
                );

                const base = (r: TickerRow & { delta: number; priceReturnPct: number }) => {
                    const rule = parseLeagueRule(r.ruleType);
                    return {
                        key: r.key,
                        displayName: r.displayName,
                        shortLabel: rule ? leagueShortCode(rule) : null,
                        indexLabel: indexLabelOf(r.ruleType),
                        ruleType: r.ruleType,
                        description: r.description,
                        value: r.value,
                        delta: r.delta,
                        price: r.price,
                        priceReturnPct: r.priceReturnPct,
                        returnLabel: formatSignedPct(r.priceReturnPct),
                        quote: formatQuote(r.price, r.priceReturnPct),
                    };
                };
                // y and h are normalised out of the layout's 62.5-unit box into percent
                // of the board's height, which is what the absolute positioning uses.
                const pct = (rect: { x: number; y: number; w: number; h: number }) => ({
                    x: rect.x, y: (rect.y / BH) * 100, w: rect.w, h: (rect.h / BH) * 100,
                });

                const next: Tile[] = [];
                roots.forEach((r, i) => {
                    const kids = families[i];
                    const rect = layout.roots[i];
                    if (kids.length === 0) {
                        next.push({ ...base(r), kind: 'leaf', ...pct(rect) });
                        return;
                    }
                    // Containers are pushed first so they paint behind the header and
                    // children that sit on them.
                    next.push({ ...base(r), kind: 'container', ...pct(rect) });
                    next.push({
                        ...base(r), kind: 'header',
                        ...pct({ ...rect, h: layout.headers[i] }),
                    });
                    kids.forEach((c, j) => {
                        const gkids = gFamilies[i][j];
                        const gRects = layout.grandchildren[i][j];
                        // Read the LAYOUT, not the data: an empty rect list means either
                        // "no family" or "the legibility gate suppressed it", and both
                        // must render as a plain child tile.
                        if (gRects.length === 0) {
                            next.push({ ...base(c), kind: 'child', ...pct(layout.children[i][j]) });
                            return;
                        }
                        // Same container/header pair the root uses, one level in - pushed
                        // first so they paint behind the slices sitting on them.
                        next.push({ ...base(c), kind: 'childcontainer', ...pct(layout.children[i][j]) });
                        next.push({
                            ...base(c), kind: 'childheader',
                            ...pct({ ...layout.children[i][j], h: layout.childHeaders[i][j] }),
                        });
                        gkids.forEach((g, q) => next.push({ ...base(g), kind: 'grandchild', ...pct(gRects[q]) }));
                    });
                });
                setTiles(next);
                setMaxAbs(biggest);
                setWindowInfo(info);
                setNote(list.note);
                setPriceNote(list.priceNote ?? '');
                setPhase('ready');
            } catch (err) {
                console.error('[TANKDAQ] board fetch failed:', err);
                if (!cancelled) setPhase('error');
            }
        })();
        return () => { cancelled = true; };
    }, []);

    // Gutter between blocks: wide enough for a block's extruded side and cast shadow
    // to land in open space rather than on its neighbour, but scaled to the board so
    // phones don't lose tile area to it.
    const gutter = Math.max(5, Math.min(10, Math.round(boardW * 0.009)));
    // Children sit on an already-inset parent block, so they need far less room around
    // them - the container's own gutter is doing most of the separating.
    const childGutter = Math.max(2, Math.round(gutter * 0.45));
    // Tighter again for the third ring - two insets already separate it from the board.
    const grandchildGutter = Math.max(1, Math.round(gutter * 0.22));

    // Fit a tile's symbol to the space it actually has, in real px from the measured
    // board. A tile too narrow for its full symbol falls back to its league tag, which
    // says the same thing inside a family block at a third of the width; below that it
    // shows no type at all rather than type that spills onto its neighbour.
    const fitText = (t: Tile, innerWpx: number, innerHpx: number) => {
        const natural = Math.sqrt((t.w * t.h) / 100) * 9 + 8;
        // Leaves keep their original width-only fit so the top-level board renders
        // exactly as it did; headers and children are short, so height binds there.
        const heightShare = t.kind === 'header' || t.kind === 'childheader' ? 0.58
            // A grandchild is the shortest tile on the board; giving it the child's 0.44
            // leaves the symbol taller than the room under it.
            : t.kind === 'grandchild' ? 0.38
            : 0.44;
        const capped = t.kind === 'leaf'
            ? natural
            : Math.min(natural, innerHpx * heightShare);
        const sizeFor = (s: string) => Math.min(capped, innerWpx / (s.length * 0.8));
        let text = t.displayName;
        let px = sizeFor(text);
        // At level three the short code is the EXPECTED render, not a fallback: measured
        // on the real geometry a full symbol lands around 0.41 against a 1.15 floor, so
        // reach for the code before the size test rather than after it.
        if ((px < 9 || t.kind === 'grandchild') && t.shortLabel) {
            const short = t.shortLabel;
            const shortPx = sizeFor(short);
            if (shortPx > px) { text = short; px = shortPx; }
        }
        return { text, px: Math.max(px, 7), show: px >= 7 };
    };

    // The quote line under the symbol, at 0.72em of the symbol size: the full
    // "45.23 (+1.2%)" if it fits the tile's inner width, else just the "(+1.2%)", else
    // nothing - the aria label and the pop-over always carry the full quote. Digits and
    // parentheses run ~0.62em/char in Montserrat 800 (an over-estimate, on purpose).
    const fitQuote = (t: Tile, innerWpx: number, symPx: number): string | null => {
        // Never on a level-three tile. Two rows of type in a box that size collide, and
        // the pop-over and aria-label already carry the full quote - so the slice spends
        // all its height saying WHICH league, which is the one thing only it can say.
        if (t.kind === 'grandchild') return null;
        if (symPx < 10) return null;
        const quotePx = symPx * 0.72;
        const fits = (s: string) => s.length * quotePx * 0.62 <= innerWpx;
        if (fits(t.quote)) return t.quote;
        const short = `(${t.returnLabel})`;
        return fits(short) ? short : null;
    };

    // Identity chrome renders in every phase - it hydrates from its own endpoint and
    // must not wait on (or disappear with) the board's data. Same root <div> in every
    // phase, ContentChrome first: a fragment root here and a <div> root below made
    // React remount the chrome when the board data landed, costing a second
    // /api/toolbar-state request per page load (see tankdaq-ticker-client.tsx).
    if (phase === 'loading') return <div><ContentChrome /><p className="hc-tqb-loading">Loading the board&hellip;</p></div>;
    if (phase === 'error') return <div><ContentChrome /><p className="hc-tqb-error">Couldn&rsquo;t load the board right now &mdash; refresh to retry.</p></div>;

    return (
        <div>
            <ContentChrome />
            <header className="hc-tqb-header">
                <h1 className="hc-tqb-title">TANKDAQ <span style={{ color: 'var(--hc-gold)' }}>Index Board</span></h1>
                <p className="hc-tqb-sub">Every index at a glance &mdash; each tile shows the index&rsquo;s Ember price and its change over {windowInfo.label}; tile size tracks the size of that move, color its direction.</p>
                {windowInfo.widened && (
                    <p className="hc-tqb-widened">No index moved in the last 24 hours &mdash; showing {windowInfo.label} instead.</p>
                )}
            </header>
            <div ref={boardRef} className="hc-tqb-board" role="list" aria-label={`Index heatmap, ${windowInfo.label}`}>
                {boardW > 0 && tiles.map((t) => {
                    const mag = maxAbs > 0 ? Math.abs(t.priceReturnPct) / maxAbs : 0;
                    const dir = signOf(t.priceReturnPct);
                    const neon = NEON[dir];
                    const active = t.key === activeKey;
                    const pad = t.kind === 'grandchild' ? grandchildGutter
                        : t.kind === 'child' || t.kind === 'childcontainer' || t.kind === 'childheader' ? childGutter
                        : gutter;
                    const box = {
                        left: `calc(${t.x}% + ${pad}px)`,
                        top: `calc(${t.y}% + ${pad}px)`,
                        width: `calc(${t.w}% - ${2 * pad}px)`,
                        height: `calc(${t.h}% - ${2 * pad}px)`,
                    };
                    const innerWpx = (boardW * t.w) / 100 - 2 * pad - 10;
                    const innerHpx = (boardH * t.h) / 100 - 2 * pad;
                    const fit = fitText(t, innerWpx, innerHpx);
                    const quoteLine = fitQuote(t, innerWpx, fit.px);
                    const ariaLabel = `${t.displayName}: ${formatEmber(t.price)} Ember, ${t.returnLabel} over ${windowInfo.label}; index ${formatSignedPct(t.value)} overall`;

                    // The family's raised block. Decorative only: its header strip and
                    // its children carry every hover and every link, so it must not
                    // intercept a pointer heading for one of them.
                    // A child holding its own ring is the same decorative block one level
                    // in - shallower, so it reads as sitting ON its parent rather than
                    // competing with it.
                    if (t.kind === 'container' || t.kind === 'childcontainer') {
                        const lift = t.kind === 'childcontainer' ? 0.5 : 1;
                        const depth = (2.5 + 4.5 * mag) * (active ? 1.4 : 1) * lift;
                        return (
                            <div key={`${t.key}-box`} className="hc-tqb-container" aria-hidden="true"
                                style={{
                                    ...box, position: 'absolute', boxSizing: 'border-box',
                                    pointerEvents: 'none', borderRadius: 10,
                                    background: `rgba(${neon}, 0.07)`,
                                    border: `2px solid rgba(${neon}, ${active ? 1 : (0.5 + 0.5 * mag).toFixed(2)})`,
                                    boxShadow: [
                                        `0 ${depth.toFixed(1)}px 0 rgba(${neon}, ${active ? 0.95 : 0.8})`,
                                        `0 ${(depth + 2).toFixed(1)}px 0 rgba(0, 0, 0, 0.95)`,
                                        `0 ${(depth + 5).toFixed(1)}px ${(10 + depth).toFixed(1)}px rgba(0, 0, 0, 0.75)`,
                                        `inset 0 1px 0 rgba(255, 255, 255, ${active ? 0.22 : 0.12})`,
                                        active ? `0 0 30px rgba(${neon}, 0.6)` : '',
                                    ].filter(Boolean).join(', '),
                                    transform: active ? 'translateY(-3px)' : undefined,
                                }} />
                        );
                    }

                    // The family's own symbol and value, and the only part of a parent
                    // that is clickable - a child sits on the same block and has to be
                    // able to take its own click.
                    if (t.kind === 'header' || t.kind === 'childheader') {
                        return (
                            <a key={`${t.key}-head`} role="listitem" className={`hc-tqb-tile hc-tqb-head${active ? ' is-active' : ''}`}
                                href={`/tankdaq/${t.key}/`}
                                style={{
                                    ...box, background: 'transparent', border: 'none', boxShadow: 'none',
                                    fontSize: `${fit.px.toFixed(1)}px`,
                                    transform: active ? 'translateY(-3px)' : undefined,
                                }}
                                onMouseEnter={() => setHoverKey(t.key)}
                                onMouseLeave={() => setHoverKey((k) => (k === t.key ? null : k))}
                                onFocus={() => setHoverKey(t.key)}
                                onBlur={() => setHoverKey((k) => (k === t.key ? null : k))}
                                onClick={(e) => onTileClick(e, t.key)}
                                aria-label={ariaLabel}>
                                <span className="hc-tqb-sym">{t.displayName}</span>
                                {quoteLine && <span className="hc-tqb-quote" style={{ color: `rgb(${neon})` }}>{quoteLine}</span>}
                            </a>
                        );
                    }

                    // A league slice, recessed into its parent's block: thin edge, no
                    // extrusion of its own. Standing a child as proud as the family it
                    // belongs to would flatten the nesting it exists to show.
                    if (t.kind === 'child' || t.kind === 'grandchild') {
                        const deep = t.kind === 'grandchild';
                        return (
                            <a key={t.key} role="listitem"
                                className={`hc-tqb-tile ${deep ? 'hc-tqb-grandchild' : 'hc-tqb-child'}${active ? ' is-active' : ''}`}
                                href={`/tankdaq/${t.key}/`}
                                style={{
                                    ...box, borderRadius: deep ? 4 : 6, background: '#000',
                                    border: `1px solid rgba(${neon}, ${active ? 1 : ((deep ? 0.4 : 0.45) + 0.5 * mag).toFixed(2)})`,
                                    boxShadow: [
                                        `inset 0 1px 0 rgba(255, 255, 255, ${active ? 0.18 : 0.07})`,
                                        `inset 0 0 ${Math.round((deep ? 4 : 6) + 16 * mag)}px rgba(${neon}, ${(0.1 + 0.28 * mag).toFixed(2)})`,
                                        active ? `0 0 18px rgba(${neon}, 0.55)` : '',
                                    ].filter(Boolean).join(', '),
                                    fontSize: `${fit.px.toFixed(1)}px`,
                                }}
                                onMouseEnter={() => setHoverKey(t.key)}
                                onMouseLeave={() => setHoverKey((k) => (k === t.key ? null : k))}
                                onFocus={() => setHoverKey(t.key)}
                                onBlur={() => setHoverKey((k) => (k === t.key ? null : k))}
                                onClick={(e) => onTileClick(e, t.key)}
                                aria-label={ariaLabel}>
                                {fit.show && <span className="hc-tqb-sym">{fit.text}</span>}
                                {fit.show && quoteLine && (
                                    <span className="hc-tqb-quote" style={{ color: `rgb(${neon})` }}>{quoteLine}</span>
                                )}
                            </a>
                        );
                    }

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
                    // tile's inner width (fitText, above - 0.8em/char is a deliberate
                    // over-estimate of Montserrat 900, since the wide-glyph symbols like
                    // $MOONSHOT and $GRIDIRON graze the edge at a tighter ratio).
                    return (
                        <a key={t.key} role="listitem" className={`hc-tqb-tile${active ? ' is-active' : ''}`} href={`/tankdaq/${t.key}/`}
                            style={{
                                // Gutters: each block is inset so its extruded side and
                                // drop shadow land in open space, not on its neighbour.
                                ...box,
                                border, boxShadow, fontSize: `${Math.max(9, fit.px).toFixed(1)}px`,
                                transform: active ? 'translateY(-3px)' : undefined,
                            }}
                            onMouseEnter={() => setHoverKey(t.key)}
                            onMouseLeave={() => setHoverKey((k) => (k === t.key ? null : k))}
                            onFocus={() => setHoverKey(t.key)}
                            onBlur={() => setHoverKey((k) => (k === t.key ? null : k))}
                            onClick={(e) => onTileClick(e, t.key)}
                            aria-label={ariaLabel}>
                            <span className="hc-tqb-sym">{t.displayName}</span>
                            {/* The all-time index % no longer rides on the tile - the detail page keeps it. */}
                            {quoteLine && <span className="hc-tqb-quote" style={{ color: `rgb(${neon})` }}>{quoteLine}</span>}
                        </a>
                    );
                })}
                {activeTile && (() => {
                    const copy = tickerCopyFor(activeTile.ruleType);
                    const dir = signOf(activeTile.priceReturnPct);
                    // Anchor beside the block, then clamp inside the board so a card
                    // never hangs off an edge. Prefer the side of the block's centre
                    // with more room, so the card covers the map rather than its own
                    // block wherever possible.
                    const popW = Math.min(320, boardW - 24);
                    const cx = (boardW * (activeTile.x + activeTile.w / 2)) / 100;
                    const blockTop = (boardH * activeTile.y) / 100;
                    const blockBottom = (boardH * (activeTile.y + activeTile.h)) / 100;
                    const left = Math.max(12, Math.min(cx - popW / 2, boardW - popW - 12));
                    const above = blockTop - popH - 10;
                    const top = above >= 12 ? above : Math.min(blockBottom + 10, Math.max(12, boardH - popH - 12));
                    return (
                        <div ref={popRef} className="hc-tqb-pop" role="status"
                            style={{ left: `${left}px`, top: `${top}px`, width: `${popW}px`, borderLeftColor: `rgb(${NEON[dir]})` }}>
                            <p className="hc-tqb-detail-head">
                                <span className="hc-tqb-detail-name">{activeTile.displayName}</span>
                                <span className="hc-tqb-detail-index">{activeTile.indexLabel}</span>
                                <span className="hc-tqb-detail-delta" style={{ color: `rgb(${NEON[dir]})` }}>{formatEmber(activeTile.price)} Ember ({activeTile.returnLabel}) <span style={{ fontSize: '0.7em', opacity: 0.7 }}>{windowInfo.short}</span></span>
                            </p>
                            <p className="hc-tqb-detail-blurb">{copy?.blurb ?? activeTile.description}</p>
                            {copy && copy.leagues.length > 0 && (
                                <p className="hc-tqb-detail-leagues">
                                    {copy.leagues.map((l) => <span key={l} className="hc-tqb-detail-league">{l}</span>)}
                                </p>
                            )}
                            <span className="hc-tqb-detail-more">
                                {coarsePointer.current ? `Tap again to open ${activeTile.displayName}` : `Click to open ${activeTile.displayName}`} &rarr;
                            </span>
                        </div>
                    );
                })()}
            </div>
            <p className="hc-tqb-hint">
                {coarsePointer.current
                    ? 'Tap an index to see what moves it — tap it again to open its page.'
                    : 'Hover an index to see what moves it, or click through to its page.'}
            </p>
            <p className="hc-tqb-legend">
                <span style={{ color: '#3ddc64' }}><span className="hc-tqb-swatch" />Up &middot; {windowInfo.short}</span>
                <span style={{ color: '#ff6b57' }}><span className="hc-tqb-swatch" />Down &middot; {windowInfo.short}</span>
                <span style={{ color: '#94a3b8' }}><span className="hc-tqb-swatch" />Flat</span>
            </p>
            {note && <p className="hc-tqb-note">{note}</p>}
            {priceNote && <p className="hc-tqb-note">{priceNote}</p>}
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
