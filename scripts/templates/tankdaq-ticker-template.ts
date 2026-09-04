import { renderHead, topbar, footer } from './waitlist-landing-template';
import { escapeHtml } from '../utils/html-escape';
import { tickerCopyFor } from '../../lib/pages-functions/ticker-copy';

/**
 * TANKDAQ index detail page (/tankdaq/<key>/) - one page per Exchange ticker, the
 * finance-platform view of a single index: its Ember price as the headline with the
 * price's window return beside it (the cumulative index % as a secondary line), a
 * windowed price chart (24H/3D/1W toggle), a Buy/Sell panel with the signed-in user's
 * position, Recent News, and Recent Results. Same
 * static-shell-plus-island pattern as my-tanks-template.ts: this shell is generic and
 * CDN-cacheable; all live numbers come from GET /api/tickers/detail?key=<key>, fetched
 * by tankdaq-ticker-client.tsx (mounted into #tankdaq-ticker-root, which carries the
 * key as a data attribute). Ticker meta baked here is for SEO/fallback only - the
 * island re-renders from the API response.
 */
export interface TankdaqTickerPage {
    key: string;         // 'dogs'
    displayName: string; // '$DOGS'
    indexLabel: string;  // 'Underdog Index'
    description: string; // tickers.description - the terse line, still what SEO meta uses
    ruleType: string;    // eligibility strategy - keys the friendly copy (ticker-copy.ts)
}

export function generateTankdaqTickerPageHtml(baseUrl: string, ticker: TankdaqTickerPage): string {
    const copy = tickerCopyFor(ticker.ruleType);
    const title = `${ticker.indexLabel} (${ticker.displayName}) | TANKDAQ | Heatchecks`;
    // Meta stays composed from the TERSE description: the friendly blurb is page copy,
    // and pasting it here would blow past the ~155 chars search results actually show.
    const description = `${ticker.description} Track how ${ticker.displayName} has moved - trend chart, recent news, and settled results.`;
    const path = `/tankdaq/${ticker.key}/`;

    const schemaOrg = {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Home', item: `${baseUrl}/` },
            { '@type': 'ListItem', position: 2, name: 'TANKDAQ', item: `${baseUrl}/tankdaq/` },
            { '@type': 'ListItem', position: 3, name: `${ticker.indexLabel} (${ticker.displayName})`, item: `${baseUrl}${path}` },
        ],
    };

    const head = renderHead({ title, description, path, baseUrl, schemaOrg });

    return `<!DOCTYPE html>
<html lang="en">
<head>
    ${head}
    <!-- Emitted by esbuild from the island's component imports (MapHud/PetWidget/
         NotificationsHost chrome) - without it the identity HUD renders unstyled. -->
    <link rel="stylesheet" href="/assets/tankdaq-ticker.css">
    <style>${tankdaqTickerStyles()}</style>
</head>
<body>
    <main class="hc-page hc-tq-page">
        ${topbar(null)}
        <div id="tankdaq-ticker-root" data-ticker-key="${ticker.key}">
            <!-- Crawlable fallback, replaced when the island mounts. -->
            <section class="hc-tq-fallback">
                <h1>${escapeHtml(ticker.indexLabel)} (${escapeHtml(ticker.displayName)})</h1>
                <p>${escapeHtml(copy?.blurb ?? ticker.description)}</p>
                ${copy && copy.leagues.length > 0 ? `<p>Leagues: ${escapeHtml(copy.leagues.join(', '))}</p>` : ''}
                <p>Priced in Ember. Signed-in members can buy and sell whole shares of ${escapeHtml(ticker.displayName)} at its live price.</p>
                <p><a href="/tankdaq/indexes/">All TANKDAQ indexes</a> &middot; <a href="/tankdaq/">TANKDAQ floor</a></p>
            </section>
        </div>
        ${footer()}
    </main>
    <script type="module" src="/assets/tankdaq-ticker.js" defer></script>
</body>
</html>`;
}

// Page-scoped styles (.hc-tq-*) - the shared sheet (renderHead) provides the vars,
// fonts, .hc-page chrome; market colors match the Market Movers dark-panel treatment
// (#3ddc64 up / #ff6b57 down / #94a3b8 flat on #160c27 panels).
function tankdaqTickerStyles(): string {
    return `
        .hc-page.hc-tq-page { max-width: 1080px; }
        .hc-tq-fallback a { color: var(--hc-gold); }

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
        /* League chips: which sports feed this index. */
        .hc-tq-leagues { display: flex; flex-wrap: wrap; gap: 0.35rem; margin: 0.55rem 0 0; padding: 0; }
        .hc-tq-league {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.62rem;
            letter-spacing: 0.08em; text-transform: uppercase; color: var(--hc-teal);
            background: rgba(47, 230, 217, 0.1); border: 1px solid rgba(47, 230, 217, 0.35);
            border-radius: 999px; padding: 0.2rem 0.6rem;
        }
        .hc-tq-note { margin: 0.4rem 0 0; font-size: 0.75rem; color: rgba(255,255,255,0.55); }

        /* Phone: a single column in DOM order - price/chart, then the trade panel and
           results, then news - so trading sits right under the chart. Desktop: a grid
           where the side column spans both rows on the right. */
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
        /* The headline: the index's Ember price, stock-quote style, with the price's
           window return beside it. The cumulative index % drops to a secondary line. */
        .hc-tq-price {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 900;
            font-size: clamp(1.9rem, 6vw, 2.6rem); line-height: 1; color: #ffffff;
            display: inline-flex; align-items: center; gap: 0.15rem;
        }
        .hc-tq-ember { color: var(--hc-gold); flex: none; }
        .hc-tq-return {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800;
            font-size: clamp(1.05rem, 3.5vw, 1.35rem);
        }
        .hc-tq-index-line {
            margin: 0 0 0.75rem; font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800;
            font-size: 0.8rem; letter-spacing: 0.02em; color: rgba(255,255,255,0.65);
        }
        .hc-tq-index-line .is-pos, .hc-tq-index-line .is-neg, .hc-tq-index-line .is-zero { font-weight: 900; }
        .hc-tq-delta24-label {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.66rem;
            letter-spacing: 0.1em; text-transform: uppercase; color: rgba(255,255,255,0.55);
            flex-basis: 100%;
        }
        .is-pos { color: #3ddc64; }
        .is-neg { color: #ff6b57; }
        .is-zero { color: #94a3b8; }

        .hc-tq-ranges { display: flex; gap: 0.45rem; margin: 0 0 0.6rem; }
        .hc-tq-range {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.78rem;
            letter-spacing: 0.06em; cursor: pointer;
            color: rgba(255,255,255,0.75); background: rgba(255,255,255,0.08);
            border: 1px solid rgba(255,255,255,0.18); border-radius: 999px; padding: 0.32rem 0.95rem;
        }
        .hc-tq-range[aria-pressed="true"] {
            color: #1a1200; background: var(--hc-gold); border-color: var(--hc-gold);
        }
        .hc-tq-range:focus-visible { outline: 2px solid var(--hc-teal); outline-offset: 2px; }

        .hc-tq-chart-panel {
            background: #160c27; border: 1.5px solid rgba(47, 230, 217, 0.4);
            border-radius: 14px; padding: 0.9rem 0.9rem 0.6rem;
        }
        .hc-tq-svg { display: block; width: 100%; height: auto; }
        .hc-tq-chart-note { margin: 0.4rem 0 0; font-size: 0.78rem; color: rgba(255,255,255,0.55); }
        .hc-tq-tick { font-family: 'Nunito', sans-serif; font-weight: 800; font-size: 11px; fill: rgba(255,255,255,0.6); }
        .hc-tq-ylabel { font-family: 'Nunito', sans-serif; font-weight: 800; font-size: 10px; fill: rgba(255,255,255,0.45); }
        .hc-tq-ylabel-index { fill: rgba(255,255,255,0.3); }
        .hc-tq-chart-legend {
            display: flex; gap: 1.1rem; margin: 0.45rem 0 0;
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.62rem;
            letter-spacing: 0.08em; text-transform: uppercase; color: rgba(255,255,255,0.55);
        }
        .hc-tq-legend-swatch { display: inline-block; width: 14px; height: 3px; border-radius: 2px; vertical-align: middle; margin-right: 0.3rem; }
        .hc-tq-legend-swatch--index { background: rgba(255,255,255,0.35); height: 0; border-top: 2px dashed rgba(255,255,255,0.45); }

        /* Right column: the trade panel above Recent Results. */
        .hc-tq-side { display: flex; flex-direction: column; gap: 1.2rem; }
        .hc-tq-trade-panel {
            background: #000000; border: 1.5px solid rgba(255, 199, 44, 0.45);
            border-radius: 14px; padding: 1rem 1.1rem 1.1rem;
        }
        .hc-tq-trade-panel .hc-tq-section-heading { margin-top: 0; color: #ffffff; }
        .hc-tq-trade-price {
            margin: 0 0 0.75rem; font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 900;
            font-size: 1.35rem; color: #ffffff; display: flex; align-items: center; gap: 0.2rem;
        }
        .hc-tq-trade-per { font-size: 0.7rem; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; color: rgba(255,255,255,0.5); margin-left: 0.35rem; }
        .hc-tq-trade-sides { margin-bottom: 0.7rem; }
        .hc-tq-trade-sides .hc-tq-range { flex: 1; text-align: center; }
        .hc-tq-range:disabled { opacity: 0.4; cursor: not-allowed; }
        .hc-tq-qty-label {
            display: block; font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.66rem;
            letter-spacing: 0.1em; text-transform: uppercase; color: rgba(255,255,255,0.55); margin: 0 0 0.3rem;
        }
        .hc-tq-qty {
            width: 100%; box-sizing: border-box; font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 900;
            font-size: 1.25rem; color: #ffffff; background: rgba(255,255,255,0.06);
            border: 1px solid rgba(255,255,255,0.2); border-radius: 10px; padding: 0.5rem 0.75rem;
        }
        .hc-tq-qty:focus-visible { outline: 2px solid var(--hc-teal); outline-offset: 2px; }
        .hc-tq-linkbtn {
            background: none; border: none; padding: 0.25rem 0; cursor: pointer;
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.7rem;
            letter-spacing: 0.06em; text-transform: uppercase; color: var(--hc-teal);
        }
        .hc-tq-preview, .hc-tq-position { margin: 0.7rem 0 0; display: flex; flex-direction: column; gap: 0.35rem; }
        .hc-tq-preview div, .hc-tq-position div { display: flex; justify-content: space-between; align-items: baseline; gap: 0.6rem; }
        .hc-tq-preview dt, .hc-tq-position dt {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.66rem;
            letter-spacing: 0.1em; text-transform: uppercase; color: rgba(255,255,255,0.55);
        }
        .hc-tq-preview dd, .hc-tq-position dd {
            margin: 0; font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 900; font-size: 0.98rem;
            color: #ffffff; display: inline-flex; align-items: center; gap: 0.15rem;
        }
        .hc-tq-trade-btn {
            display: block; width: 100%; box-sizing: border-box; margin: 0.85rem 0 0; text-align: center;
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 900; font-size: 0.9rem;
            letter-spacing: 0.06em; text-transform: uppercase; text-decoration: none; cursor: pointer;
            color: #1a1200; background: var(--hc-gold); border: 1px solid var(--hc-gold);
            border-radius: 999px; padding: 0.7rem 1rem;
        }
        .hc-tq-trade-btn:disabled { opacity: 0.45; cursor: not-allowed; }
        .hc-tq-trade-btn:focus-visible { outline: 2px solid var(--hc-teal); outline-offset: 2px; }
        .hc-tq-trade-hint, .hc-tq-trade-error, .hc-tq-trade-notice { margin: 0.55rem 0 0; font-size: 0.82rem; line-height: 1.4; }
        .hc-tq-trade-hint { color: rgba(255,255,255,0.55); }
        .hc-tq-trade-error { color: #ff6b57; }
        .hc-tq-trade-notice { color: #3ddc64; }
        .hc-tq-position-heading {
            margin: 1.1rem 0 0.3rem; font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.72rem;
            letter-spacing: 0.12em; text-transform: uppercase; color: var(--hc-teal);
        }
        .hc-tq-portfolio-link {
            display: inline-block; margin: 0.7rem 0 0; font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800;
            font-size: 0.72rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--hc-gold); text-decoration: none;
        }
        .hc-tq-portfolio-link:hover { text-decoration: underline; }
        .hc-tq-price-note { margin: 0.8rem 0 0; font-size: 0.7rem; line-height: 1.4; color: rgba(255,255,255,0.45); }

        .hc-tq-section-heading {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.85rem;
            letter-spacing: 0.14em; text-transform: uppercase; color: var(--hc-teal); margin: 1.2rem 0 0.55rem;
        }
        .hc-tq-news-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.8rem; }
        .hc-tq-news-list a {
            font-family: 'Nunito', sans-serif; font-weight: 700; font-size: 0.98rem; line-height: 1.35;
            color: var(--hc-bubble); text-decoration: none;
        }
        .hc-tq-news-list a:hover { text-decoration: underline; }
        .hc-tq-excerpt { margin: 0.2rem 0 0.2rem; font-size: 0.85rem; line-height: 1.45; color: rgba(255,255,255,0.65); }
        .hc-tq-news-meta {
            display: block; font-family: 'Montserrat', 'Nunito', sans-serif; font-size: 0.66rem; font-weight: 800;
            letter-spacing: 0.08em; text-transform: uppercase; color: rgba(255,255,255,0.5);
        }

        .hc-tq-results-panel {
            background: #000000; border: 1.5px solid rgba(47, 230, 217, 0.35);
            border-radius: 14px; padding: 1rem 1.1rem 1.15rem;
        }
        .hc-tq-results-panel .hc-tq-section-heading { margin-top: 0; color: #ffffff; }
        .hc-tq-results-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.7rem; }
        .hc-tq-results-list li { font-size: 0.9rem; line-height: 1.45; color: var(--hc-bubble); }
        .hc-tq-chip {
            display: inline-block; font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800;
            font-size: 0.68rem; letter-spacing: 0.04em; text-transform: uppercase; color: #04120a;
            border-radius: 999px; padding: 0.08rem 0.5rem; margin: 0 0.35rem 0.1rem 0; vertical-align: middle;
        }
        .hc-tq-chip.is-pos { background: #3ddc64; color: #04120a; }
        .hc-tq-chip.is-neg { background: #ff6b57; color: #1c0500; }
        .hc-tq-muted { font-size: 0.85rem; color: rgba(255,255,255,0.55); margin: 0; }

        .hc-tq-loading, .hc-tq-error { margin: 2.5rem 0; color: rgba(255,255,255,0.7); }
    `;
}
