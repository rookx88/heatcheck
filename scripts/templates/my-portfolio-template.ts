import { renderHead, topbar, footer } from './waitlist-landing-template';

/**
 * The My Portfolio page - everything a signed-in user holds: their Tank picks (open and
 * settled) and their TANKDAQ index shares (active positions and trade history), in two
 * top-level tabs. Formerly /my-tanks/ ("My Tanks"); that path 301s here. Generic static
 * shell, same pattern as account-template.ts: all personalization is fetched client-side
 * by my-portfolio-client.tsx (GET /api/picks/mine and GET /api/tankdaq/holdings), so
 * this page is safely CDN-cacheable. noindex: a personal page has no business in search.
 */
export function generateMyPortfolioPageHtml(baseUrl: string): string {
    const title = 'My Portfolio | Heatchecks';
    const description = 'Your Tank picks and your TANKDAQ index holdings - open calls, settled results, active positions and trade history.';
    const head = renderHead({ title, description, path: '/my-portfolio/', baseUrl });

    return `<!DOCTYPE html>
<html lang="en">
<head>
    ${head}
    <meta name="robots" content="noindex">
    <!-- The scoreboard's dot-matrix LED face: the homepage "Sports Tanks Available"
         sign's font. It is deliberately NOT in renderHead (other pages would pay for a
         face they never use - see renderHomepage), so this page requests it itself. -->
    <link href="https://fonts.googleapis.com/css2?family=Bitcount+Grid+Single:wght@100..900&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/assets/my-portfolio.css">
    <style>
        /* The shared .hc-page column is sized for prose; the holdings table needs the
           room the ticker pages already claim (same override as .hc-tq-page). */
        .hc-page.hc-portfolio-page { max-width: 860px; }

        /* =====================================================================
           The page is a stadium scoreboard: a steel bezel around a matte black
           board. EVERYTHING on the board is opaque. The old card and its rows were
           translucent white over renderHead's fixed starfield, and the stars showing
           through every surface is what made the page hard to read.

           One rule for type: the LED face (Bitcount Grid Single) is for numbers,
           labels and short tokens. Anything a person reads as a sentence - pick
           taglines, index names, notes - stays in Nunito.
           ===================================================================== */
        .hc-sb-frame {
            --sb-face: 'Bitcount Grid Single', 'Courier New', monospace;
            --sb-led: #ffb81c;                        /* lit amber - numbers */
            --sb-led-glow: rgba(255, 184, 28, 0.55);
            --sb-cream: #fff6c8;                      /* the homepage sign's lettering */
            --sb-label: #c9b27a;                      /* dim amber - captions */
            --sb-unlit: #8a7440;                      /* unlit segment, ~4:1 on the board */
            --sb-text: #e8e2d0;                       /* body copy on the board */
            --sb-board: #0b0b0c;
            --sb-cell: #111114;                       /* a row / panel on the board */
            --sb-well: #050506;                       /* a recessed readout */
            --sb-rule: #1f1f24;
            position: relative;
            max-width: 800px;
            margin: 2rem auto 2.5rem;
            padding: 8px;
            border-radius: 16px;
            /* Brushed steel: bands of light and shadow, the way a bezel catches the
               stadium lights. */
            background: linear-gradient(145deg, #8b9098 0%, #3a3e44 22%, #6f747c 48%, #2b2e33 74%, #7c818a 100%);
            box-shadow: 0 22px 50px rgba(0, 0, 0, 0.6),
                        inset 0 1px 0 rgba(255, 255, 255, 0.35),
                        inset 0 -1px 0 rgba(0, 0, 0, 0.5);
        }
        /* Corner bolts. Centred 8px in, where the bezel's outer radius (16px) and the
           board's inner radius (8px) leave a pocket of steel just big enough for a
           2px head - any larger and a bolt would overlap the board's corner. */
        .hc-sb-frame::before {
            content: '';
            position: absolute;
            inset: 0;
            border-radius: inherit;
            pointer-events: none;
            background:
                radial-gradient(circle at 8px 8px, #e4e7eb 0 1px, #4b4f56 1.6px 2px, transparent 2.6px),
                radial-gradient(circle at calc(100% - 8px) 8px, #e4e7eb 0 1px, #4b4f56 1.6px 2px, transparent 2.6px),
                radial-gradient(circle at 8px calc(100% - 8px), #e4e7eb 0 1px, #4b4f56 1.6px 2px, transparent 2.6px),
                radial-gradient(circle at calc(100% - 8px) calc(100% - 8px), #e4e7eb 0 1px, #4b4f56 1.6px 2px, transparent 2.6px);
        }
        /* The board. Matte means no sheen: a flat colour, not a gradient, with only a
           faint grain so it reads as a surface rather than a hole in the page. The
           grain is an image OVER an opaque colour, so the board stays fully opaque. */
        .hc-sb {
            position: relative;
            padding: 1.1rem 1.25rem 1.5rem;
            border-radius: 8px;
            background-color: var(--sb-board);
            background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 .05 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
            box-shadow: inset 0 0 0 1px #000000, inset 0 3px 18px rgba(0, 0, 0, 0.9);
            color: var(--sb-text);
        }

        /* ---- The marquee sign: bulbs top and bottom, the page title in LED ---- */
        .hc-sb-marquee {
            position: relative;
            margin: 0 0 1rem;
            padding: 1.05rem 1rem;
            text-align: center;
            background: var(--sb-well);
            /* The homepage sign's red outline, so the two read as one family. */
            border: 2px solid #8b1c18;
            border-radius: 6px;
            box-shadow: inset 0 2px 12px rgba(0, 0, 0, 0.95);
        }
        .hc-sb-marquee::before,
        .hc-sb-marquee::after {
            content: '';
            position: absolute;
            left: 10px;
            right: 10px;
            height: 6px;
            background: radial-gradient(circle, #ffd27a 0 1.6px, rgba(255, 184, 28, 0.35) 2.4px, transparent 3.2px) 0 50% / 14px 6px repeat-x;
        }
        .hc-sb-marquee::before { top: 4px; }
        .hc-sb-marquee::after { bottom: 4px; }
        .hc-sb-marquee h1 {
            margin: 0;
            font-family: var(--sb-face);
            font-weight: 700;
            font-size: clamp(1.45rem, 6vw, 2.1rem);
            letter-spacing: 0.06em;
            text-transform: uppercase;
            color: var(--sb-cream);
            text-shadow: 0 0 12px rgba(255, 240, 170, 0.4);
            animation: hc-sb-blink 9s linear infinite;
        }
        /* The homepage sign's bulb flicker (hc-tanks-title-blink), renamed so the two
           never collide: steady for ~8s, two quick dips, back to full. Dim, never off. */
        @keyframes hc-sb-blink {
            0%, 88.8% { color: #fff6c8; text-shadow: 0 0 12px rgba(255, 240, 170, 0.4); }
            89.3%, 90% { color: rgba(255, 246, 200, 0.5); text-shadow: 0 0 4px rgba(255, 240, 170, 0.15); }
            90.5%, 91.6% { color: #fff6c8; text-shadow: 0 0 12px rgba(255, 240, 170, 0.4); }
            92.1%, 92.7% { color: rgba(255, 246, 200, 0.62); text-shadow: 0 0 6px rgba(255, 240, 170, 0.2); }
            93.2%, 100% { color: #fff6c8; text-shadow: 0 0 12px rgba(255, 240, 170, 0.4); }
        }

        /* ---- Segment switches: lit = amber with a lit bar, unlit = dim amber ----
           Both levels share the look; the section switch is simply larger. The
           parents clip their corners, so focus rings are drawn inside. */
        .hc-sb-toptabs,
        .hc-portfolio-tabs {
            display: grid;
            grid-auto-flow: column;
            grid-auto-columns: 1fr;
            overflow: hidden;
            background: var(--sb-well);
            border: 1px solid var(--sb-rule);
            border-radius: 8px;
        }
        .hc-sb-toptabs { margin: 0 0 1rem; }
        .hc-portfolio-tabs { display: inline-grid; margin: 1.1rem 0 0.9rem; border-radius: 6px; }
        .hc-sb-toptab,
        .hc-portfolio-tab {
            appearance: none;
            border: 0;
            margin: 0;
            cursor: pointer;
            background: var(--sb-well);
            font-family: var(--sb-face);
            font-weight: 700;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: var(--sb-unlit);
            box-shadow: inset 0 -3px 0 transparent;
            transition: color 0.15s ease, text-shadow 0.15s ease, box-shadow 0.15s ease;
        }
        .hc-sb-toptab { padding: 0.7rem 0.5rem 0.65rem; font-size: clamp(1rem, 4vw, 1.3rem); }
        .hc-portfolio-tab { padding: 0.45rem 1.1rem; font-size: 0.9rem; letter-spacing: 0.06em; }
        .hc-sb-toptab + .hc-sb-toptab,
        .hc-portfolio-tab + .hc-portfolio-tab { border-left: 1px solid var(--sb-rule); }
        .hc-sb-toptab:hover:not(.is-active),
        .hc-portfolio-tab:hover:not(.is-active) { color: #b0955a; }
        .hc-sb-toptab.is-active,
        .hc-portfolio-tab.is-active {
            color: var(--sb-led);
            text-shadow: 0 0 10px var(--sb-led-glow);
            background: #120f08;
            box-shadow: inset 0 -3px 0 var(--sb-led);
        }
        .hc-sb-toptab:focus-visible,
        .hc-portfolio-tab:focus-visible { outline: 2px solid var(--hc-gold); outline-offset: -3px; }

        /* ---- Score boxes: the big readouts at the top of each section ---- */
        .hc-sb-scores {
            display: grid;
            grid-template-columns: repeat(4, minmax(0, 1fr));
            gap: 0.6rem;
        }
        .hc-sb-score {
            min-width: 0;
            padding: 0.55rem 0.4rem 0.75rem;
            text-align: center;
            background: var(--sb-well);
            border: 1px solid #1e1e22;
            border-radius: 8px;
            box-shadow: inset 0 2px 10px rgba(0, 0, 0, 0.95);
        }
        .hc-sb-score-label {
            display: block;
            margin-bottom: 0.35rem;
            font-family: 'Montserrat', 'Nunito', sans-serif;
            font-weight: 800;
            font-size: 0.62rem;
            letter-spacing: 0.16em;
            text-transform: uppercase;
            color: var(--sb-label);
        }
        .hc-sb-score-value {
            display: block;
            font-family: var(--sb-face);
            font-weight: 700;
            font-size: clamp(1.6rem, 6vw, 2.4rem);
            line-height: 1;
            white-space: nowrap;
            font-variant-numeric: tabular-nums;
            color: var(--sb-led);
            text-shadow: 0 0 10px var(--sb-led-glow);
        }
        /* Awaiting data: the board shows dashes in unlit segments. */
        .hc-sb-score-value.is-pending { color: var(--sb-unlit); text-shadow: none; }

        /* ---- Direction colours: the site's TANKDAQ neon set, lit on the board ---- */
        .is-pos { color: #3ddc64; }
        .is-neg { color: #ff6b57; }
        .is-zero { color: #94a3b8; }
        .hc-sb .is-pos,
        .hc-portfolio-table td.num.is-pos { color: #3ddc64; text-shadow: 0 0 10px rgba(61, 220, 100, 0.5); }
        .hc-sb .is-neg,
        .hc-portfolio-table td.num.is-neg { color: #ff6b57; text-shadow: 0 0 10px rgba(255, 107, 87, 0.5); }
        .hc-sb .is-zero,
        .hc-portfolio-table td.num.is-zero { color: #94a3b8; text-shadow: none; }

        /* ---- Message strip: loading, empty, error, sign-in prompts ---- */
        .hc-portfolio-loading,
        .hc-portfolio-empty {
            margin: 1rem 0 0;
            padding: 0.85rem 1rem;
            text-align: center;
            font-size: 0.95rem;
            line-height: 1.5;
            color: var(--sb-text);
            background: var(--sb-cell);
            border: 1px solid var(--sb-rule);
            border-radius: 8px;
        }
        .hc-portfolio-empty a,
        .hc-portfolio-loading a { color: var(--sb-led); font-weight: 700; }

        /* ---- Line-score rows ---- */
        .hc-portfolio-list {
            display: flex;
            flex-direction: column;
            margin: 0;
            padding: 0;
            list-style: none;
            overflow: hidden;
            background: var(--sb-cell);
            border: 1px solid var(--sb-rule);
            border-radius: 8px;
        }
        .hc-portfolio-row {
            display: flex;
            align-items: flex-start;
            gap: 0.8rem;
            padding: 0.85rem 1rem;
            background: var(--sb-cell);
        }
        .hc-portfolio-row + .hc-portfolio-row { border-top: 1px solid var(--sb-rule); }
        .hc-portfolio-rowbody { flex: 1; min-width: 0; }
        .hc-portfolio-row a { color: #ffffff; font-weight: 700; text-decoration: none; line-height: 1.35; }
        .hc-portfolio-row a:hover { color: var(--sb-led); }
        .hc-portfolio-meta {
            display: flex;
            flex-wrap: wrap;
            gap: 0.35rem 0.9rem;
            align-items: center;
            margin-top: 0.45rem;
            font-size: 0.82rem;
            color: rgba(232, 226, 208, 0.72);
        }
        /* LED tokens inside a row: the side taken, a percentage, a date, an amount. */
        .hc-sb-led {
            font-family: var(--sb-face);
            font-weight: 700;
            letter-spacing: 0.05em;
            text-transform: uppercase;
            font-variant-numeric: tabular-nums;
            color: var(--sb-label);
        }
        .hc-sb-pair { display: inline-flex; align-items: baseline; gap: 0.4rem; }
        .hc-sb-cap {
            font-family: 'Montserrat', 'Nunito', sans-serif;
            font-weight: 800;
            font-size: 0.6rem;
            letter-spacing: 0.14em;
            text-transform: uppercase;
            color: var(--sb-label);
        }
        .hc-portfolio-side,
        .hc-sb-amber { color: var(--sb-led); text-shadow: 0 0 6px rgba(255, 184, 28, 0.35); }
        .hc-portfolio-ember { color: var(--sb-led); text-shadow: 0 0 6px rgba(255, 184, 28, 0.35); }

        /* Result lamp on a settled pick: a lit W or L, like a scoreboard's
           possession or timeout light. */
        .hc-sb-lamp {
            flex: 0 0 auto;
            display: grid;
            place-items: center;
            width: 2.1rem;
            height: 2.1rem;
            font-family: var(--sb-face);
            font-weight: 700;
            font-size: 1.15rem;
            line-height: 1;
            background: var(--sb-well);
            border: 1px solid #1e1e22;
            border-radius: 6px;
            box-shadow: inset 0 2px 8px rgba(0, 0, 0, 0.9);
        }
        .hc-sb-lamp--correct {
            color: #3ddc64;
            text-shadow: 0 0 10px rgba(61, 220, 100, 0.6);
            box-shadow: inset 0 2px 8px rgba(0, 0, 0, 0.9), 0 0 0 1px rgba(61, 220, 100, 0.35);
        }
        .hc-sb-lamp--incorrect {
            color: #ff6b57;
            text-shadow: 0 0 10px rgba(255, 107, 87, 0.6);
            box-shadow: inset 0 2px 8px rgba(0, 0, 0, 0.9), 0 0 0 1px rgba(255, 107, 87, 0.35);
        }

        /* A game in progress: a red LIVE light that breathes. It pulses its colour,
           not its opacity, so the tag's dark face never turns see-through. */
        .hc-sb-live {
            font-family: var(--sb-face);
            font-weight: 700;
            letter-spacing: 0.1em;
            text-transform: uppercase;
            padding: 0.1rem 0.5rem;
            color: #ff3b2f;
            text-shadow: 0 0 10px rgba(255, 59, 47, 0.7);
            background: #140504;
            border: 1px solid rgba(255, 59, 47, 0.55);
            border-radius: 4px;
            animation: hc-sb-live 1.6s ease-in-out infinite;
        }
        @keyframes hc-sb-live {
            0%, 100% { color: #ff3b2f; text-shadow: 0 0 10px rgba(255, 59, 47, 0.7); }
            50% { color: #a8261d; text-shadow: 0 0 3px rgba(255, 59, 47, 0.25); }
        }

        /* Trade side tags: lit on a dark face. Buy teal and sell gold, as before. */
        .hc-portfolio-badge {
            font-family: var(--sb-face);
            font-weight: 700;
            font-size: 0.78rem;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            padding: 0.2rem 0.55rem;
            background: var(--sb-well);
            border: 1px solid #1e1e22;
            border-radius: 4px;
        }
        .hc-portfolio-badge--buy { color: var(--hc-teal); text-shadow: 0 0 8px rgba(47, 230, 217, 0.55); border-color: rgba(47, 230, 217, 0.35); }
        .hc-portfolio-badge--sell { color: var(--hc-gold); text-shadow: 0 0 8px rgba(255, 199, 44, 0.55); border-color: rgba(255, 199, 44, 0.35); }
        .hc-portfolio-traderow { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 0.7rem; }

        .hc-portfolio-more {
            display: block;
            margin: 1rem auto 0;
            padding: 0.5rem 1.4rem;
            font-family: var(--sb-face);
            font-weight: 700;
            font-size: 0.9rem;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: var(--sb-led);
            background: var(--sb-well);
            border: 1px solid rgba(255, 184, 28, 0.4);
            border-radius: 6px;
            cursor: pointer;
        }
        .hc-portfolio-more:hover { border-color: var(--sb-led); text-shadow: 0 0 8px var(--sb-led-glow); }
        .hc-portfolio-more:disabled { color: var(--sb-unlit); border-color: var(--sb-rule); text-shadow: none; cursor: default; }
        .hc-portfolio-more:focus-visible { outline: 2px solid var(--hc-gold); outline-offset: 2px; }

        /* ---- Holdings table: a line score. Scrolls inside its own wrapper on a
           narrow screen so the page never scrolls sideways. ---- */
        .hc-portfolio-tablewrap {
            overflow-x: auto;
            background: var(--sb-cell);
            border: 1px solid var(--sb-rule);
            border-radius: 8px;
        }
        .hc-portfolio-table { width: 100%; min-width: 520px; border-collapse: collapse; font-size: 0.9rem; }
        .hc-portfolio-table th {
            padding: 0.6rem 0.75rem;
            text-align: left;
            font-family: 'Montserrat', 'Nunito', sans-serif;
            font-weight: 800;
            font-size: 0.62rem;
            letter-spacing: 0.14em;
            text-transform: uppercase;
            color: var(--sb-label);
            background: var(--sb-well);
            border-bottom: 1px solid var(--sb-rule);
        }
        .hc-portfolio-table td {
            padding: 0.7rem 0.75rem;
            color: var(--sb-text);
            border-bottom: 1px solid var(--sb-rule);
        }
        .hc-portfolio-table .num { text-align: right; }
        .hc-portfolio-table td.num {
            font-family: var(--sb-face);
            font-weight: 700;
            font-size: 0.98rem;
            font-variant-numeric: tabular-nums;
            color: var(--sb-led);
            text-shadow: 0 0 6px rgba(255, 184, 28, 0.35);
        }
        .hc-portfolio-sym a { color: #ffffff; font-weight: 800; text-decoration: none; }
        .hc-portfolio-sym a:hover { color: var(--sb-led); }
        .hc-portfolio-symlabel { display: block; margin-top: 0.1rem; font-size: 0.72rem; color: rgba(232, 226, 208, 0.55); }
        .hc-portfolio-table tfoot td { background: var(--sb-well); border-top: 1px solid #2a2a30; border-bottom: none; }
        .hc-portfolio-table tfoot td:first-child {
            font-family: 'Montserrat', 'Nunito', sans-serif;
            font-weight: 800;
            font-size: 0.7rem;
            letter-spacing: 0.14em;
            text-transform: uppercase;
            color: var(--sb-label);
        }
        .hc-portfolio-balance { margin: 0.8rem 0 0; font-size: 0.85rem; color: rgba(232, 226, 208, 0.72); }
        .hc-portfolio-note { margin: 1rem 0 0; font-size: 0.74rem; line-height: 1.45; color: rgba(232, 226, 208, 0.5); }

        /* Screen-reader text for the lamps, which show only a letter. */
        .hc-sb-vh {
            position: absolute;
            width: 1px;
            height: 1px;
            margin: -1px;
            padding: 0;
            overflow: hidden;
            clip: rect(0 0 0 0);
            white-space: nowrap;
            border: 0;
        }

        /* Phones: a thinner bezel with no bolts (the corner pocket that fits one
           shrinks with it), tighter board padding, score boxes two by two. */
        @media (max-width: 560px) {
            .hc-sb-frame { margin: 1.25rem auto 2rem; padding: 6px; }
            .hc-sb-frame::before { display: none; }
            .hc-sb { padding: 0.85rem 0.8rem 1.1rem; }
            .hc-sb-scores { grid-template-columns: repeat(2, minmax(0, 1fr)); }
            .hc-portfolio-row { padding: 0.75rem 0.8rem; gap: 0.65rem; }
        }
        @media (prefers-reduced-motion: reduce) {
            .hc-sb-marquee h1,
            .hc-sb-live { animation: none; }
            .hc-sb-toptab,
            .hc-portfolio-tab { transition: none; }
        }
    </style>
</head>
<body>
    <main class="hc-page hc-portfolio-page">
        ${topbar(null)}
        <div id="my-portfolio-root"></div>
        ${footer()}
    </main>
    <script type="module" src="/assets/my-portfolio.js" defer></script>
</body>
</html>`;
}
