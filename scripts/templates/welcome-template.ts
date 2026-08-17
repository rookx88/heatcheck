import { renderHead, topbar, footer } from './waitlist-landing-template';

/**
 * The first-login welcome page - a letter from Sports McLaren that every account must
 * sign (choose a username) before the rest of the app opens up. Generic static shell;
 * all personalization is fetched client-side by welcome-client.tsx from
 * GET /api/onboarding-status, so this page is safely CDN-cacheable. noindex: an
 * onboarding page has no business in search results. No referrer meta needed - unlike
 * /login/, no token ever rides this URL.
 *
 * Styling is deliberately the login page's serif-document outlier look, pushed one
 * step further: an actual letter on cream paper sitting on the navy site background.
 */
export function generateWelcomePageHtml(baseUrl: string): string {
    const title = 'Welcome | Heatchecks';
    const description = 'A letter is waiting for you.';
    const head = renderHead({ title, description, path: '/welcome/', baseUrl });

    return `<!DOCTYPE html>
<html lang="en">
<head>
    ${head}
    <meta name="robots" content="noindex">
    <style>
        .hc-letter {
            max-width: 560px; margin: 2.5rem auto; padding: 2.5rem 2rem;
            background: #f6f1e4; color: #2b2b2b; border-radius: 4px;
            box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45);
            font-family: Georgia, 'Times New Roman', serif; line-height: 1.6;
        }
        .hc-letter-eyebrow {
            font-size: 0.72rem; letter-spacing: 0.14em; text-transform: uppercase;
            color: #8a7f66; margin: 0 0 0.2rem;
        }
        .hc-letter-role {
            font-size: 0.8rem; font-style: italic; color: #8a7f66;
            margin: 0 0 1.75rem; border-bottom: 1px solid #d9d0ba; padding-bottom: 1rem;
        }
        .hc-letter p { margin: 0 0 1.1rem; font-size: 1rem; }
        .hc-letter-ember { color: #b8860b; font-weight: bold; }
        .hc-letter-signoff { margin-top: 1.5rem; font-style: italic; }
        .hc-letter-sign-label {
            font-size: 0.72rem; letter-spacing: 0.14em; text-transform: uppercase;
            color: #8a7f66; margin: 2rem 0 0.35rem;
        }
        .hc-letter-signature {
            display: block; width: 100%; box-sizing: border-box; padding: 0.5rem 0.25rem;
            font-family: Georgia, 'Times New Roman', serif; font-style: italic; font-size: 1.35rem;
            color: #2b2b2b; background: transparent; border: none; border-bottom: 1px solid #999;
            border-radius: 0; outline: none;
        }
        .hc-letter-signature:focus { border-bottom-color: #b8860b; }
        .hc-letter-hint { font-size: 0.8rem; color: #8a7f66; margin: 0.4rem 0 1rem; }
        .hc-letter-button {
            display: block; width: 100%; padding: 0.9rem 1rem; font-size: 1rem; cursor: pointer;
            background: #111; color: #fff; border: none; border-radius: 6px;
        }
        .hc-letter-button:disabled { opacity: 0.6; cursor: default; }
        .hc-letter-error { color: #c62828; font-size: 0.95rem; margin: 0.75rem 0 0; }
        .hc-letter-loading {
            max-width: 560px; margin: 3rem auto; padding: 0 1.5rem; text-align: center;
            font-family: Georgia, 'Times New Roman', serif; color: #cfe6ff;
        }
    </style>
</head>
<body>
    <main class="hc-page">
        ${topbar('/')}
        <div id="welcome-root"></div>
        ${footer()}
    </main>
    <script type="module" src="/assets/welcome.js" defer></script>
</body>
</html>`;
}
