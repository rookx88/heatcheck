import { renderHead, topbar, footer } from './waitlist-landing-template';

/**
 * The account page - the only place a logged-in user sees and manages account-level
 * settings, currently just the Discord link. Generic static shell; all
 * personalization is fetched client-side by account-client.tsx from GET /api/session,
 * so this page is safely CDN-cacheable. noindex: an account page has no business in
 * search results.
 */
export function generateAccountPageHtml(baseUrl: string): string {
    const title = 'Account | Heatchecks';
    const description = 'Manage your Heatchecks account.';
    const head = renderHead({ title, description, path: '/account/', baseUrl });

    return `<!DOCTYPE html>
<html lang="en">
<head>
    ${head}
    <meta name="robots" content="noindex">
    <style>
        .hc-account-loading {
            max-width: 560px; margin: 3rem auto; padding: 0 1.5rem; text-align: center;
            color: rgba(255,255,255,0.8);
        }
        .hc-account-card {
            max-width: 560px; margin: 2.5rem auto; padding: 2rem 1.75rem;
            background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
            border-radius: 18px;
        }
        .hc-account-card h1 {
            font-family: 'Baloo 2', sans-serif; font-weight: 800; margin: 0 0 1.25rem;
            font-size: clamp(1.4rem, 6vw, 1.9rem);
        }
        .hc-account-card h2 {
            font-family: 'Baloo 2', sans-serif; font-weight: 800; margin: 0 0 0.5rem;
            font-size: 1.1rem;
        }
        .hc-account-facts { display: grid; grid-template-columns: auto 1fr; gap: 0.35rem 1rem; margin: 0 0 1.75rem; }
        .hc-account-facts dt { color: rgba(255,255,255,0.55); font-size: 0.85rem; }
        .hc-account-facts dd { margin: 0; }
        .hc-account-discord { border-top: 1px solid rgba(255,255,255,0.12); padding-top: 1.25rem; }
        .hc-account-discord p { color: rgba(255,255,255,0.85); line-height: 1.5; margin: 0 0 1rem; }
        .hc-account-button {
            display: inline-block; background: var(--hc-gold); color: #1a1200;
            font-family: 'Baloo 2', 'Nunito', sans-serif; font-weight: 800; font-size: 1rem;
            text-decoration: none; padding: 0.6rem 1.5rem; border-radius: 12px; border: none;
            cursor: pointer;
        }
        .hc-account-button--secondary { background: transparent; color: #fff; border: 1px solid rgba(255,255,255,0.3); }
        .hc-account-button:disabled { opacity: 0.6; cursor: default; }
        .hc-account-flag { padding: 0.65rem 0.9rem; border-radius: 10px; font-size: 0.9rem; margin: 0 0 1.25rem; }
        .hc-account-flag--ok { background: rgba(47,230,217,0.15); color: var(--hc-teal); }
        .hc-account-flag--error { background: rgba(198,40,40,0.15); color: #ff8a80; }
    </style>
</head>
<body>
    <main class="hc-page">
        ${topbar('/')}
        <div id="account-root"></div>
        ${footer()}
    </main>
    <script type="module" src="/assets/account.js" defer></script>
</body>
</html>`;
}
