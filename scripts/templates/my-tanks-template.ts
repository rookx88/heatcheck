import { renderHead, topbar, footer } from './waitlist-landing-template';

/**
 * The My Tanks page - a logged-in user's picks in two tabs: pending (picked, not yet
 * settled) and settled (with result + Ember earned). Generic static shell, same
 * pattern as account-template.ts: all personalization is fetched client-side by
 * my-tanks-client.tsx from GET /api/picks/mine, so this page is safely CDN-cacheable.
 * noindex: a personal picks page has no business in search results.
 */
export function generateMyTanksPageHtml(baseUrl: string): string {
    const title = 'My Tanks | Heatchecks';
    const description = 'Your Tank picks - open calls and settled results.';
    const head = renderHead({ title, description, path: '/my-tanks/', baseUrl });

    return `<!DOCTYPE html>
<html lang="en">
<head>
    ${head}
    <meta name="robots" content="noindex">
    <style>
        .hc-mytanks-loading {
            max-width: 640px; margin: 3rem auto; padding: 0 1.5rem; text-align: center;
            color: rgba(255,255,255,0.8);
        }
        .hc-mytanks-card {
            max-width: 640px; margin: 2.5rem auto; padding: 2rem 1.75rem;
            background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
            border-radius: 18px;
        }
        .hc-mytanks-card h1 {
            font-family: 'Baloo 2', sans-serif; font-weight: 800; margin: 0 0 1.25rem;
            font-size: clamp(1.4rem, 6vw, 1.9rem);
        }
        .hc-mytanks-tabs { display: flex; gap: 0.5rem; margin: 0 0 1.5rem; }
        .hc-mytanks-tab {
            font-family: 'Baloo 2', 'Nunito', sans-serif; font-weight: 800; font-size: 0.95rem;
            padding: 0.45rem 1.1rem; border-radius: 999px; cursor: pointer;
            background: transparent; color: rgba(255,255,255,0.7);
            border: 1px solid rgba(255,255,255,0.25);
        }
        .hc-mytanks-tab.is-active {
            background: var(--hc-gold); color: #1a1200; border-color: var(--hc-gold);
        }
        .hc-mytanks-record { color: rgba(255,255,255,0.55); font-size: 0.85rem; margin: 0 0 1rem; }
        .hc-mytanks-list { display: flex; flex-direction: column; gap: 0.75rem; margin: 0; padding: 0; list-style: none; }
        .hc-mytanks-row {
            padding: 0.9rem 1rem; border-radius: 12px;
            background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
        }
        .hc-mytanks-row a {
            color: #fff; font-weight: 700; text-decoration: none; line-height: 1.35;
        }
        .hc-mytanks-row a:hover { color: var(--hc-gold); }
        .hc-mytanks-meta {
            display: flex; flex-wrap: wrap; gap: 0.35rem 0.9rem; align-items: center;
            margin-top: 0.4rem; font-size: 0.82rem; color: rgba(255,255,255,0.65);
        }
        .hc-mytanks-side { color: var(--hc-bubble); }
        .hc-mytanks-badge {
            font-family: 'Baloo 2', 'Nunito', sans-serif; font-weight: 800; font-size: 0.72rem;
            text-transform: uppercase; letter-spacing: 0.04em;
            padding: 0.15rem 0.6rem; border-radius: 999px;
        }
        .hc-mytanks-badge--correct { background: rgba(47,230,217,0.15); color: var(--hc-teal); }
        .hc-mytanks-badge--incorrect { background: rgba(198,40,40,0.18); color: #ff8a80; }
        .hc-mytanks-ember { color: var(--hc-gold); font-weight: 700; }
        .hc-mytanks-live { color: var(--hc-teal); font-weight: 700; }
        .hc-mytanks-more {
            display: block; margin: 1.1rem auto 0; padding: 0.45rem 1.4rem;
            font-family: 'Baloo 2', 'Nunito', sans-serif; font-weight: 800; font-size: 0.9rem;
            background: transparent; color: rgba(255,255,255,0.8); cursor: pointer;
            border: 1px solid rgba(255,255,255,0.25); border-radius: 999px;
        }
        .hc-mytanks-more:hover { border-color: var(--hc-gold); color: var(--hc-gold); }
        .hc-mytanks-more:disabled { opacity: 0.6; cursor: default; }
        .hc-mytanks-empty { color: rgba(255,255,255,0.65); line-height: 1.5; margin: 0.5rem 0 0; }
        .hc-mytanks-empty a { color: var(--hc-gold); }
    </style>
</head>
<body>
    <main class="hc-page">
        ${topbar('/')}
        <div id="my-tanks-root"></div>
        ${footer()}
    </main>
    <script type="module" src="/assets/my-tanks.js" defer></script>
</body>
</html>`;
}
