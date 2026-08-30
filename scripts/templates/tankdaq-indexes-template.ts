import { renderHead, topbar, footer } from './waitlist-landing-template';

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
    tickers: Array<{ key: string; displayName: string; indexLabel: string }>,
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
        .map((t) => `<li><a href="/tankdaq/${t.key}/">${t.indexLabel} (${t.displayName})</a></li>`)
        .join('\n                    ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    ${head}
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
        /* Tiles are BLACK with neon green/red borders (direction) - magnitude shows as
           tile area plus border/glow intensity, all set inline by the client. The
           tile's own font-size is computed in px from the measured board width
           (ResizeObserver), so labels always fit; children size in em against it and
           overflow:hidden keeps any worst case inside its own tile. */
        .hc-tqb-tile {
            position: absolute; display: flex; flex-direction: column;
            align-items: center; justify-content: center; gap: 0.15em;
            text-decoration: none; text-align: center; overflow: hidden;
            background: #000000; box-sizing: border-box; border-radius: 3px;
            transition: filter 0.15s ease;
        }
        .hc-tqb-tile:hover, .hc-tqb-tile:focus-visible { filter: brightness(1.35); outline: none; z-index: 1; }
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
    `;
}
