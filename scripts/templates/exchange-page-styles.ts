// The Exchange page look, shared by the team pages and league boards.
//
// FORKED, not imported, from tankdaqTickerStyles() (tankdaq-ticker-template.ts) and
// tankdaqIndexesStyles() (tankdaq-indexes-template.ts) on 2026-09-13: both are private
// to files that were mid-edit in another session that day. The team page keeps the
// `.hc-tq-*` class names verbatim so it IS the index page's look, rule for rule; the
// league board takes the index board's tile idiom under `.hc-lgb-*`. Once the ticker
// templates land, they can import from here and the copies collapse to one.
//
// Everything below sits on renderHead's shared sheet (the --hc-* vars, .hc-page,
// .hc-topbar, .hc-footer, the starfield). Market colours are ticker-format.ts's NEON_RGB
// as hex: #3ddc64 up / #ff6b57 down / #94a3b8 flat.

export function exchangePageStyles(): string {
    return `
        .hc-page.hc-tq-page { max-width: 1080px; }
        .hc-tq-fallback a { color: var(--hc-gold); }

        /* The board: everything sits on ONE opaque matte panel. Opaque on purpose - the
           shared head paints a starfield and stars behind body copy is tiring to read -
           and no backdrop-filter / transform, because either would make the board the
           containing block for PetWidget's fixed overlays (ContentChrome forbids that). */
        .hc-tq-board {
            position: relative;
            margin: 0.85rem 0 0;
            padding: 0.9rem 1.4rem 1.6rem;
            border-radius: 18px;
            background-color: #0f0a19;
            background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 .05 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
            border: 1px solid rgba(255, 255, 255, 0.1);
            box-shadow: 0 18px 48px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.05);
        }
        @media (max-width: 420px) {
            .hc-tq-board { padding: 0.75rem 1rem 1.25rem; border-radius: 14px; }
        }

        .hc-tq-back {
            display: inline-block; margin: 0.75rem 0 0;
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.72rem;
            letter-spacing: 0.1em; text-transform: uppercase;
            color: var(--hc-teal); text-decoration: none;
        }
        .hc-tq-back:hover { text-decoration: underline; }

        .hc-tq-header { margin: 0.5rem 0 0; }
        .hc-tq-title {
            font-family: 'Baloo 2', sans-serif; font-weight: 800;
            font-size: clamp(1.5rem, 5vw, 2.1rem); margin: 0; line-height: 1.15;
        }
        .hc-tq-symbol { color: var(--hc-gold); }
        .hc-tq-desc { margin: 0.35rem 0 0; color: var(--hc-bubble); font-size: 0.95rem; max-width: 64ch; line-height: 1.5; }
        .hc-tq-leagues { display: flex; flex-wrap: wrap; gap: 0.35rem; margin: 0.55rem 0 0; padding: 0; list-style: none; }
        .hc-tq-league {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.62rem;
            letter-spacing: 0.08em; text-transform: uppercase; color: var(--hc-teal);
            background: rgba(47, 230, 217, 0.1); border: 1px solid rgba(47, 230, 217, 0.35);
            border-radius: 999px; padding: 0.2rem 0.6rem; text-decoration: none;
        }
        a.hc-tq-league:hover { background: rgba(47, 230, 217, 0.2); }
        .hc-tq-note { margin: 0.4rem 0 0; font-size: 0.75rem; color: rgba(255,255,255,0.55); }

        .hc-tq-layout { display: flex; flex-direction: column; gap: 1.4rem; margin-top: 1.1rem; }
        @media (min-width: 1024px) {
            .hc-tq-layout {
                display: grid; grid-template-columns: minmax(0, 1fr) 330px;
                grid-template-rows: auto auto; gap: 1.6rem; align-items: start;
            }
            .hc-tq-main { grid-column: 1; grid-row: 1; }
            .hc-tq-news { grid-column: 1; grid-row: 2; }
            .hc-tq-side { grid-column: 2; grid-row: 1 / 3; }
        }

        .hc-tq-value-row { display: flex; align-items: baseline; gap: 0.6rem; flex-wrap: wrap; margin: 0 0 0.3rem; }
        .hc-tq-price {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 900;
            font-size: clamp(1.9rem, 6vw, 2.6rem); line-height: 1; color: #ffffff;
            display: inline-flex; align-items: center; gap: 0.15rem;
        }
        /* "Ember" beside the price - the index page draws a flame glyph here; the word in
           gold carries the same meaning at a fraction of the size. */
        .hc-tq-ember { color: var(--hc-gold); flex: none; font-size: 0.42em; font-weight: 800; letter-spacing: 0.06em; margin-left: 0.3rem; align-self: flex-end; padding-bottom: 0.15em; }
        .hc-tq-return {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800;
            font-size: clamp(1.05rem, 3.5vw, 1.35rem);
        }
        .hc-tq-ranges { display: flex; gap: 0.45rem; margin: 0 0 0.6rem; }
        .hc-tq-range {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.78rem;
            letter-spacing: 0.06em; cursor: pointer;
            color: rgba(255,255,255,0.75); background: rgba(255,255,255,0.08);
            border: 1px solid rgba(255,255,255,0.18); border-radius: 999px; padding: 0.32rem 0.95rem;
        }
        .hc-tq-range[aria-pressed="true"] { color: #1a1200; background: var(--hc-gold); border-color: var(--hc-gold); }
        .hc-tq-range:focus-visible { outline: 2px solid var(--hc-teal); outline-offset: 2px; }
        .hc-tq-ylabel-index { fill: rgba(255,255,255,0.3); }
        .hc-tq-index-line {
            margin: 0 0 0.75rem; font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 700;
            font-size: 0.72rem; letter-spacing: 0.02em; color: rgba(255,255,255,0.45);
        }
        .hc-tq-index-line .is-pos, .hc-tq-index-line .is-neg, .hc-tq-index-line .is-zero { font-weight: 800; opacity: 0.8; }
        .hc-tq-read { margin: 0 0 0.55rem; font-size: 0.92rem; line-height: 1.5; color: var(--hc-bubble); max-width: 64ch; }
        .hc-tq-delta24-label {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.66rem;
            letter-spacing: 0.1em; text-transform: uppercase; color: rgba(255,255,255,0.55);
            flex-basis: 100%;
        }
        .is-pos { color: #3ddc64; }
        .is-neg { color: #ff6b57; }
        .is-zero { color: #94a3b8; }

        .hc-tq-chart-panel {
            background: #160c27; border: 1.5px solid rgba(47, 230, 217, 0.4);
            border-radius: 14px; padding: 0.9rem 0.9rem 0.6rem; margin-top: 0.6rem;
        }
        .hc-tq-svg { display: block; width: 100%; height: auto; }
        .hc-tq-chart-note { margin: 0.4rem 0 0; font-size: 0.78rem; color: rgba(255,255,255,0.55); }
        .hc-tq-tick { font-family: 'Nunito', sans-serif; font-weight: 800; font-size: 11px; fill: rgba(255,255,255,0.6); }
        .hc-tq-ylabel { font-family: 'Nunito', sans-serif; font-weight: 800; font-size: 10px; fill: rgba(255,255,255,0.45); }
        .hc-tq-chart-legend {
            display: flex; gap: 1.1rem; margin: 0.45rem 0 0;
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.62rem;
            letter-spacing: 0.08em; text-transform: uppercase; color: rgba(255,255,255,0.55);
        }
        .hc-tq-legend-swatch { display: inline-block; width: 14px; height: 3px; border-radius: 2px; vertical-align: middle; margin-right: 0.3rem; }
        .hc-tq-legend-swatch--index { background: rgba(255,255,255,0.35); height: 0; border-top: 2px dashed rgba(255,255,255,0.45); }

        .hc-tq-side { display: flex; flex-direction: column; gap: 1.2rem; }
        .hc-tq-section-heading {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.85rem;
            letter-spacing: 0.14em; text-transform: uppercase; color: var(--hc-teal); margin: 1.2rem 0 0.55rem;
        }
        .hc-tq-results-panel {
            background: #000000; border: 1.5px solid rgba(47, 230, 217, 0.35);
            border-radius: 14px; padding: 1rem 1.1rem 1.15rem;
        }
        .hc-tq-results-panel .hc-tq-section-heading { margin-top: 0; color: #ffffff; }
        .hc-tq-movers-sub { margin: 0 0 0.6rem; font-size: 0.74rem; line-height: 1.4; color: rgba(255,255,255,0.5); }
        .hc-tq-movers-tally { margin: 0.8rem 0 0; padding-top: 0.6rem; border-top: 1px solid rgba(255,255,255,0.1); }
        .hc-tq-results-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.7rem; }
        .hc-tq-results-list li { font-size: 0.9rem; line-height: 1.45; color: var(--hc-bubble); }
        .hc-tq-chip {
            display: inline-block; font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800;
            font-size: 0.68rem; letter-spacing: 0.04em; text-transform: uppercase; color: #04120a;
            border-radius: 999px; padding: 0.08rem 0.5rem; margin: 0 0.35rem 0.1rem 0; vertical-align: middle;
        }
        .hc-tq-chip.is-pos { background: #3ddc64; color: #04120a; }
        .hc-tq-chip.is-neg { background: #ff6b57; color: #1c0500; }
        /* "Appeared" - the club was in the game but the slate held no side on it. */
        .hc-tq-chip.is-zero { background: rgba(148,163,184,0.25); color: #cfe6ff; border: 1px solid rgba(148,163,184,0.5); }
        .hc-tq-muted { font-size: 0.85rem; color: rgba(255,255,255,0.55); margin: 0; }
        .hc-tq-loading, .hc-tq-error { margin: 2.5rem 0; color: rgba(255,255,255,0.7); }

        /* Tables: "By competition" on a team page, the roster on a league page. */
        .hc-tq-table { width: 100%; border-collapse: collapse; font-size: 0.9rem; color: var(--hc-bubble); }
        .hc-tq-table th {
            text-align: left; font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.64rem;
            letter-spacing: 0.1em; text-transform: uppercase; color: rgba(255,255,255,0.55);
            padding: 0.35rem 0.5rem 0.35rem 0; border-bottom: 1px solid rgba(255,255,255,0.12);
        }
        .hc-tq-table td { padding: 0.45rem 0.5rem 0.45rem 0; border-bottom: 1px solid rgba(255,255,255,0.06); vertical-align: baseline; }
        .hc-tq-table td.is-num, .hc-tq-table th.is-num { text-align: right; font-variant-numeric: tabular-nums; }
        .hc-tq-table a { color: var(--hc-bubble); text-decoration: none; font-weight: 700; }
        .hc-tq-table a:hover { text-decoration: underline; }
        .hc-tq-table .hc-tq-rank { color: rgba(255,255,255,0.4); font-size: 0.8rem; padding-right: 0.5rem; }

        /* The hub: leagues by sport. */
        .hc-tq-hub-sport { margin: 1.4rem 0 0; }
        .hc-tq-hub-list { list-style: none; margin: 0.4rem 0 0; padding: 0; display: grid; gap: 0.5rem; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); }
        .hc-tq-hub-item {
            display: flex; align-items: baseline; justify-content: space-between; gap: 0.6rem;
            background: #000000; border: 1.5px solid rgba(47, 230, 217, 0.3); border-radius: 12px; padding: 0.7rem 0.9rem;
        }
        .hc-tq-hub-item a { font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; color: #ffffff; text-decoration: none; }
        .hc-tq-hub-item a:hover { text-decoration: underline; }
        .hc-tq-hub-item.is-empty { border-color: rgba(255,255,255,0.1); color: rgba(255,255,255,0.45); }
        .hc-tq-hub-meta { font-size: 0.72rem; color: rgba(255,255,255,0.5); white-space: nowrap; }
    `;
}

// The league board: the index board's tile idiom (tankdaqIndexesStyles), under its own
// prefix. Tiles are absolutely positioned percentage rects from the client's squarified
// layout; the client sets position/size, the neon border, the extrusion shadow stack and
// a px font-size inline. The face gradient + top highlight below give the raised block
// its lit-from-above look.
export function leagueBoardStyles(): string {
    return `
        .hc-lgb-board {
            position: relative; width: 100%; margin-top: 1rem;
            background: #000000; border: 2px solid rgba(47, 230, 217, 0.35); border-radius: 12px;
            overflow: hidden; aspect-ratio: 16 / 10;
        }
        @media (max-width: 759px) {
            .hc-lgb-board { aspect-ratio: 3 / 4; }
        }
        /* The crawlable roster the island replaces: readable on its own, inside the frame. */
        .hc-lgb-fallback { margin: 0; padding: 0.9rem 1.1rem; list-style: none; columns: 2; column-gap: 1.2rem; font-size: 0.85rem; }
        .hc-lgb-fallback li { break-inside: avoid; padding: 0.15rem 0; color: var(--hc-bubble); }
        .hc-lgb-fallback a { color: #ffffff; font-weight: 700; text-decoration: none; }
        .hc-lgb-fallback a:hover { text-decoration: underline; }
        .hc-lgb-tile {
            position: absolute; display: flex; flex-direction: column;
            align-items: center; justify-content: center; gap: 0.15em;
            text-decoration: none; text-align: center; overflow: hidden;
            background:
                linear-gradient(158deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.02) 38%, rgba(0,0,0,0) 60%),
                #000000;
            box-sizing: border-box; border-radius: 4px;
            transition: transform 0.16s ease, filter 0.16s ease, box-shadow 0.16s ease;
            will-change: transform;
        }
        .hc-lgb-tile:hover, .hc-lgb-tile:focus-visible, .hc-lgb-tile.is-active {
            filter: brightness(1.3); outline: none; z-index: 2;
        }
        .hc-lgb-sym {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 900; font-size: 1em;
            color: #ffffff; line-height: 1.1; padding: 0 0.25em;
        }
        .hc-lgb-quote {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.72em;
            line-height: 1.1; white-space: nowrap;
        }
        /* The card that floats over the board beside the hovered/selected club.
           pointer-events:none is load-bearing (see tankdaq-indexes-template.ts). */
        .hc-lgb-pop {
            position: absolute; z-index: 6; pointer-events: none;
            width: min(320px, calc(100% - 24px));
            background: rgba(7, 5, 11, 0.94);
            border: 1px solid rgba(255,255,255,0.16);
            border-left: 3px solid rgba(148,163,184,0.6);
            border-radius: 12px; padding: 0.7rem 0.85rem 0.8rem;
            box-shadow: 0 18px 44px rgba(0,0,0,0.65);
            backdrop-filter: blur(6px);
        }
        .hc-lgb-hint { margin: 0.6rem 0 0; font-size: 0.85rem; color: rgba(255,255,255,0.5); }
        /* Which window the board settled on (24H -> 7D -> 30D -> all-time until a club moved). */
        .hc-lgb-window {
            margin: 0.45rem 0 0; font-family: 'Montserrat', 'Nunito', sans-serif;
            font-weight: 800; font-size: 0.66rem; letter-spacing: 0.06em; text-transform: uppercase;
            color: var(--hc-gold); background: rgba(255, 199, 44, 0.1); border: 1px solid rgba(255, 199, 44, 0.35);
            border-radius: 999px; padding: 0.3rem 0.75rem; display: inline-block;
        }
        .hc-lgb-detail-head { display: flex; align-items: baseline; gap: 0.45rem; flex-wrap: wrap; margin: 0 0 0.3rem; }
        .hc-lgb-detail-name {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 900; font-size: 0.95rem;
            letter-spacing: 0.02em; color: #ffffff;
        }
        .hc-lgb-detail-delta { font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.9rem; }
        .hc-lgb-detail-blurb { margin: 0; font-size: 0.85rem; line-height: 1.45; color: var(--hc-bubble); }
        .hc-lgb-detail-more {
            display: inline-block; margin: 0.5rem 0 0;
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.62rem;
            letter-spacing: 0.08em; text-transform: uppercase; color: var(--hc-gold);
        }
        .hc-lgb-legend {
            display: flex; gap: 1rem; margin: 0.6rem 0 0; flex-wrap: wrap;
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.68rem;
            letter-spacing: 0.08em; text-transform: uppercase; color: rgba(255,255,255,0.6);
        }
        .hc-lgb-swatch {
            display: inline-block; width: 0.7rem; height: 0.7rem; border-radius: 3px;
            vertical-align: -1px; margin-right: 0.3rem;
            background: #000000; border: 2px solid currentColor; box-sizing: border-box;
        }
        @media (min-width: 1024px) {
            .hc-lgb-legend, .hc-lgb-hint { padding-right: 22ch; }
        }
        @media (prefers-reduced-motion: reduce) {
            .hc-lgb-tile { transition: none; }
            .hc-lgb-tile:hover, .hc-lgb-tile:focus-visible, .hc-lgb-tile.is-active { transform: none !important; }
        }
    `;
}
