import { renderHead, topbar, footer } from './waitlist-landing-template';
import { escapeHtml } from '../utils/html-escape';
import { tickerCopyFor } from '../../lib/pages-functions/ticker-copy';

/**
 * TANKDAQ Index Board (/tankdaq/indexes/) - the crypto-heatmap view of every Exchange
 * ticker: a black treemap where each index is a neon green/red tile sized by the
 * magnitude of its last-24h movement, linking through to /tankdaq/<key>/. Reached from
 * the INDEX PRICES sign on the TANKDAQ floor. Static shell + island
 * (tankdaq-heatmap-client.tsx fetches /api/tickers + /api/tickers/chart); the fallback
 * list below keeps every index page crawlable without JS.
 */
export function generateTankdaqIndexesPageHtml(
    baseUrl: string,
    tickers: Array<{ key: string; displayName: string; indexLabel: string; ruleType: string }>,
): string {
    const title = 'TANKDAQ Index Board | Heatchecks';
    const description = 'Every Heatchecks index at a glance - a heatmap of how each has moved in the last 24 hours.';

    const schemaOrg = {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Home', item: `${baseUrl}/` },
            { '@type': 'ListItem', position: 2, name: 'TANKDAQ', item: `${baseUrl}/tankdaq/` },
            { '@type': 'ListItem', position: 3, name: 'Index Board', item: `${baseUrl}/tankdaq/indexes/` },
        ],
    };

    const head = renderHead({ title, description, path: '/tankdaq/indexes/', baseUrl, schemaOrg });

    const fallbackLinks = tickers
        .map((t) => {
            const copy = tickerCopyFor(t.ruleType);
            const blurb = copy ? ` &mdash; ${escapeHtml(copy.blurb)}` : '';
            return `<li><a href="/tankdaq/${escapeHtml(t.key)}/">${escapeHtml(t.indexLabel)} (${escapeHtml(t.displayName)})</a>${blurb}</li>`;
        })
        .join('\n                    ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    ${head}
    <!-- Emitted by esbuild from the island's component imports (MapHud/PetWidget/
         NotificationsHost chrome) - without it the identity HUD renders unstyled. -->
    <link rel="stylesheet" href="/assets/tankdaq-indexes.css">
    <style>${tankdaqIndexesStyles()}</style>
</head>
<body>
    <main class="hc-page hc-tqb-page">
        ${topbar('/the-tank/')}
        <div id="tankdaq-indexes-root">
            <!-- Crawlable fallback, replaced when the island mounts. -->
            <section class="hc-tqb-fallback">
                <h1>TANKDAQ Index Board</h1>
                <p>${description}</p>
                <ul>
                    ${fallbackLinks}
                </ul>
                <p><a href="/tankdaq/">Back to the TANKDAQ floor</a></p>
            </section>
        </div>
        ${footer()}
    </main>
    <script type="module" src="/assets/tankdaq-indexes.js" defer></script>
</body>
</html>`;
}

function tankdaqIndexesStyles(): string {
    return `
        .hc-page.hc-tqb-page { max-width: 1100px; }
        .hc-tqb-fallback a { color: var(--hc-gold); }

        .hc-tqb-header { margin: 0.5rem 0 0; }
        .hc-tqb-title {
            font-family: 'Baloo 2', sans-serif; font-weight: 800;
            font-size: clamp(1.5rem, 5vw, 2.1rem); margin: 0; line-height: 1.15;
        }
        .hc-tqb-sub { margin: 0.35rem 0 0; color: var(--hc-bubble); font-size: 0.95rem; }
        .hc-tqb-note { margin: 0.6rem 0 0; font-size: 0.75rem; color: rgba(255,255,255,0.55); }
        /* Shown only when 24h came back empty and the board widened its window. */
        .hc-tqb-widened {
            margin: 0.45rem 0 0; font-family: 'Montserrat', 'Nunito', sans-serif;
            font-weight: 800; font-size: 0.66rem; letter-spacing: 0.06em; text-transform: uppercase;
            color: var(--hc-gold);
            background: rgba(255, 199, 44, 0.1); border: 1px solid rgba(255, 199, 44, 0.35);
            border-radius: 999px; padding: 0.3rem 0.75rem; display: inline-block;
        }

        /* The board: pure black, hairline teal frame; tiles are absolutely positioned
           percentage rects from the client's squarified layout. */
        .hc-tqb-board {
            position: relative; width: 100%; margin-top: 1rem;
            background: #000000; border: 2px solid rgba(47, 230, 217, 0.35); border-radius: 12px;
            overflow: hidden; aspect-ratio: 16 / 10;
        }
        @media (max-width: 759px) {
            .hc-tqb-board { aspect-ratio: 3 / 4; }
        }
        /* Tiles are raised BLACK blocks with neon green/red edges (direction). The
           client sets, inline: position/size (squarified layout, inset by a gutter so
           each block floats free), the neon border, the stacked box-shadow that forms
           the extruded side + drop shadow (deeper for bigger movers), and a font-size
           computed in px from the measured board width so labels always fit. The face
           gradient + top-edge highlight below give the block its lit-from-above look
           (same bevel idiom as the Fishtank walls). */
        .hc-tqb-tile {
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
        /* Hover/focus/selected all share one look: the block rises and its whole face
           blooms in its own neon (the deeper shadow stack comes from the client). */
        .hc-tqb-tile:hover, .hc-tqb-tile:focus-visible, .hc-tqb-tile.is-active {
            filter: brightness(1.3); outline: none; z-index: 2;
        }
        .hc-tqb-sym {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 900; font-size: 1em;
            color: #ffffff; line-height: 1.1;
        }
        .hc-tqb-delta {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.72em;
            line-height: 1.1;
        }
        .hc-tqb-total {
            font-family: 'Nunito', sans-serif; font-weight: 700; font-size: 0.55em;
            color: rgba(255,255,255,0.6); line-height: 1.1;
        }

        /* Description panel: what the hovered/selected index reacts to. Min-height is
           reserved so moving between tiles never reflows the page under the cursor. */
        .hc-tqb-detail {
            margin: 0.75rem 0 0; min-height: 6.5rem;
            background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.12);
            border-left: 3px solid rgba(148,163,184,0.5);
            border-radius: 10px; padding: 0.8rem 1rem 0.9rem;
            transition: border-left-color 0.16s ease;
        }
        @media (max-width: 759px) { .hc-tqb-detail { min-height: 9rem; } }
        .hc-tqb-detail-head { display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; margin: 0 0 0.3rem; }
        .hc-tqb-detail-name {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 900; font-size: 0.95rem;
            letter-spacing: 0.04em; color: #ffffff;
        }
        .hc-tqb-detail-index {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.66rem;
            letter-spacing: 0.1em; text-transform: uppercase; color: rgba(255,255,255,0.55);
        }
        /* Inline, NOT pushed to the panel's right edge: the fixed PetWidget sits
           bottom-right and would cover a right-aligned value on a short page. */
        .hc-tqb-detail-delta { font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.9rem; }
        .hc-tqb-detail-blurb { margin: 0; font-size: 0.9rem; line-height: 1.5; color: var(--hc-bubble); }
        .hc-tqb-detail-hint { margin: 0; font-size: 0.88rem; color: rgba(255,255,255,0.5); }
        .hc-tqb-detail-leagues { display: flex; flex-wrap: wrap; gap: 0.3rem; margin: 0.5rem 0 0; padding: 0; }
        .hc-tqb-detail-league {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.58rem;
            letter-spacing: 0.08em; text-transform: uppercase; color: var(--hc-teal);
            background: rgba(47, 230, 217, 0.1); border: 1px solid rgba(47, 230, 217, 0.3);
            border-radius: 999px; padding: 0.16rem 0.5rem;
        }
        .hc-tqb-detail-more {
            display: inline-block; margin: 0.55rem 0 0;
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.66rem;
            letter-spacing: 0.08em; text-transform: uppercase; color: var(--hc-gold); text-decoration: none;
        }
        .hc-tqb-detail-more:hover { text-decoration: underline; }

        /* Keep the last rows clear of the fixed PetWidget's corner on wide screens. */
        @media (min-width: 1024px) {
            .hc-tqb-detail, .hc-tqb-legend, .hc-tqb-note { padding-right: 22ch; }
        }

        .hc-tqb-legend {
            display: flex; gap: 1rem; margin: 0.6rem 0 0; flex-wrap: wrap;
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.68rem;
            letter-spacing: 0.08em; text-transform: uppercase; color: rgba(255,255,255,0.6);
        }
        .hc-tqb-swatch {
            display: inline-block; width: 0.7rem; height: 0.7rem; border-radius: 3px;
            vertical-align: -1px; margin-right: 0.3rem;
            background: #000000; border: 2px solid currentColor; box-sizing: border-box;
        }

        .hc-tqb-loading, .hc-tqb-error { margin: 2.5rem 0; color: rgba(255,255,255,0.7); }

        /* Repo convention (market-movers.ts's tape): motion is optional, the
           information is not - drop the lift and the transitions, keep every colour,
           glow and depth cue exactly as-is. */
        @media (prefers-reduced-motion: reduce) {
            .hc-tqb-tile { transition: none; }
            .hc-tqb-tile:hover, .hc-tqb-tile:focus-visible, .hc-tqb-tile.is-active { transform: none !important; }
            .hc-tqb-detail { transition: none; }
        }
    `;
}
