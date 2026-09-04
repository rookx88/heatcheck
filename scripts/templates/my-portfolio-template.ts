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
    <link rel="stylesheet" href="/assets/my-portfolio.css">
    <style>
        /* The shared .hc-page column is sized for prose; the holdings table needs the
           room the ticker pages already claim (same override as .hc-tq-page). */
        .hc-page.hc-portfolio-page { max-width: 860px; }
        .hc-portfolio-loading {
            margin: 1.5rem 0; text-align: center; color: rgba(255,255,255,0.8);
        }
        .hc-portfolio-card {
            max-width: 760px; margin: 2.5rem auto; padding: 2rem 1.75rem;
            background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
            border-radius: 18px;
        }
        .hc-portfolio-card h1 {
            font-family: 'Baloo 2', sans-serif; font-weight: 800; margin: 0 0 1rem;
            font-size: clamp(1.4rem, 6vw, 1.9rem);
        }
        /* Two tab levels, two looks: the section tabs are teal, the sub-tabs inside a
           section keep the gold pills the old page used. */
        .hc-portfolio-toptabs {
            display: flex; gap: 0.5rem; margin: 0 0 1.4rem; padding-bottom: 1rem;
            border-bottom: 1px solid rgba(255,255,255,0.12);
        }
        .hc-portfolio-toptab {
            font-family: 'Baloo 2', 'Nunito', sans-serif; font-weight: 800; font-size: 1rem;
            padding: 0.5rem 1.25rem; border-radius: 999px; cursor: pointer;
            background: transparent; color: rgba(255,255,255,0.7);
            border: 1px solid rgba(255,255,255,0.25);
        }
        .hc-portfolio-toptab.is-active { background: var(--hc-teal); color: #04120a; border-color: var(--hc-teal); }
        .hc-portfolio-toptab:focus-visible, .hc-portfolio-tab:focus-visible { outline: 2px solid var(--hc-gold); outline-offset: 2px; }
        .hc-portfolio-tabs { display: flex; gap: 0.5rem; margin: 0 0 1.25rem; }
        .hc-portfolio-tab {
            font-family: 'Baloo 2', 'Nunito', sans-serif; font-weight: 800; font-size: 0.95rem;
            padding: 0.45rem 1.1rem; border-radius: 999px; cursor: pointer;
            background: transparent; color: rgba(255,255,255,0.7);
            border: 1px solid rgba(255,255,255,0.25);
        }
        .hc-portfolio-tab.is-active { background: var(--hc-gold); color: #1a1200; border-color: var(--hc-gold); }
        .hc-portfolio-record { color: rgba(255,255,255,0.55); font-size: 0.85rem; margin: 0 0 1rem; }
        .hc-portfolio-list { display: flex; flex-direction: column; gap: 0.75rem; margin: 0; padding: 0; list-style: none; }
        .hc-portfolio-row {
            padding: 0.9rem 1rem; border-radius: 12px;
            background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
        }
        .hc-portfolio-row a { color: #fff; font-weight: 700; text-decoration: none; line-height: 1.35; }
        .hc-portfolio-row a:hover { color: var(--hc-gold); }
        .hc-portfolio-meta {
            display: flex; flex-wrap: wrap; gap: 0.35rem 0.9rem; align-items: center;
            margin-top: 0.4rem; font-size: 0.82rem; color: rgba(255,255,255,0.65);
        }
        .hc-portfolio-side { color: var(--hc-bubble); }
        .hc-portfolio-badge {
            font-family: 'Baloo 2', 'Nunito', sans-serif; font-weight: 800; font-size: 0.72rem;
            text-transform: uppercase; letter-spacing: 0.04em;
            padding: 0.15rem 0.6rem; border-radius: 999px;
        }
        .hc-portfolio-badge--correct { background: rgba(47,230,217,0.15); color: var(--hc-teal); }
        .hc-portfolio-badge--incorrect { background: rgba(198,40,40,0.18); color: #ff8a80; }
        .hc-portfolio-badge--buy { background: rgba(47,230,217,0.15); color: var(--hc-teal); }
        .hc-portfolio-badge--sell { background: rgba(255,199,44,0.16); color: var(--hc-gold); }
        .hc-portfolio-ember { color: var(--hc-gold); font-weight: 700; }
        .hc-portfolio-live { color: var(--hc-teal); font-weight: 700; }
        .hc-portfolio-more {
            display: block; margin: 1.1rem auto 0; padding: 0.45rem 1.4rem;
            font-family: 'Baloo 2', 'Nunito', sans-serif; font-weight: 800; font-size: 0.9rem;
            background: transparent; color: rgba(255,255,255,0.8); cursor: pointer;
            border: 1px solid rgba(255,255,255,0.25); border-radius: 999px;
        }
        .hc-portfolio-more:hover { border-color: var(--hc-gold); color: var(--hc-gold); }
        .hc-portfolio-more:disabled { opacity: 0.6; cursor: default; }
        .hc-portfolio-empty { color: rgba(255,255,255,0.65); line-height: 1.5; margin: 0.5rem 0 0; }
        .hc-portfolio-empty a { color: var(--hc-gold); }

        /* Index holdings table. Scrolls inside its own wrapper on a narrow screen so
           the page never scrolls sideways. */
        .hc-portfolio-tablewrap { overflow-x: auto; }
        .hc-portfolio-table { width: 100%; border-collapse: collapse; font-size: 0.9rem; min-width: 520px; }
        .hc-portfolio-table th {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.64rem;
            letter-spacing: 0.1em; text-transform: uppercase; color: rgba(255,255,255,0.55);
            text-align: left; padding: 0.45rem 0.6rem; border-bottom: 1px solid rgba(255,255,255,0.14);
        }
        .hc-portfolio-table td {
            padding: 0.7rem 0.6rem; border-bottom: 1px solid rgba(255,255,255,0.07);
            font-variant-numeric: tabular-nums; color: rgba(255,255,255,0.85);
        }
        .hc-portfolio-table .num { text-align: right; }
        .hc-portfolio-sym a { color: #fff; font-weight: 800; text-decoration: none; }
        .hc-portfolio-sym a:hover { color: var(--hc-gold); }
        .hc-portfolio-symlabel { display: block; font-size: 0.72rem; color: rgba(255,255,255,0.5); margin-top: 0.1rem; }
        .hc-portfolio-table tfoot td { font-weight: 800; color: #fff; border-top: 1px solid rgba(255,255,255,0.2); border-bottom: none; }
        .is-pos { color: #3ddc64; }
        .is-neg { color: #ff6b57; }
        .is-zero { color: #94a3b8; }
        .hc-portfolio-balance { margin: 1rem 0 0; font-size: 0.9rem; color: rgba(255,255,255,0.7); }
        .hc-portfolio-balance strong { color: var(--hc-gold); }
        .hc-portfolio-traderow { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 0.7rem; }
        .hc-portfolio-tradeqty { color: rgba(255,255,255,0.75); font-variant-numeric: tabular-nums; }
        .hc-portfolio-note { margin: 1.1rem 0 0; font-size: 0.72rem; line-height: 1.45; color: rgba(255,255,255,0.45); }
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
