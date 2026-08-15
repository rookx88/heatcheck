import { renderHead, topbar, footer } from './waitlist-landing-template';

/**
 * The magic-link login page - both the "enter email, get a link" form and the landing
 * target the emailed link points at (/login/?token=...). Generic static shell; all
 * behavior lives in login-client.tsx, which consumes the token via POST so
 * email-scanner GET prefetches can't burn the single-use link. noindex: a login page
 * has no business in search results.
 */
export function generateLoginPageHtml(baseUrl: string): string {
    const title = 'Log In | Heatchecks';
    const description = 'Get a one-tap login link for your Heatchecks account.';
    const head = renderHead({ title, description, path: '/login/', baseUrl });

    return `<!DOCTYPE html>
<html lang="en">
<head>
    ${head}
    <meta name="robots" content="noindex">
    <!-- The URL can carry ?token=; never leak it via Referer to any cross-origin
         subresource (defense-in-depth on top of the browser default). -->
    <meta name="referrer" content="no-referrer">
    <style>
        .hc-login {
            max-width: 480px; margin: 3rem auto; padding: 0 1.5rem; font-family: Georgia, 'Times New Roman', serif;
        }
        .hc-login-eyebrow { font-size: 0.75rem; letter-spacing: 0.08em; text-transform: uppercase; color: #888; }
        .hc-login-copy { font-size: 1rem; color: #333; margin: 0.75rem 0 1.25rem; }
        .hc-login-input {
            display: block; width: 100%; box-sizing: border-box; padding: 0.9rem 1rem; font-size: 1rem;
            border: 1px solid #ccc; border-radius: 6px; margin-bottom: 0.75rem;
        }
        .hc-login-button {
            display: block; width: 100%; padding: 0.9rem 1rem; font-size: 1rem; cursor: pointer;
            background: #111; color: #fff; border: none; border-radius: 6px;
        }
        .hc-login-button:disabled { opacity: 0.6; cursor: default; }
        .hc-login-error { color: #c62828; }
    </style>
</head>
<body>
    <main class="hc-page">
        ${topbar('/')}
        <div id="login-root"></div>
        ${footer()}
    </main>
    <script type="module" src="/assets/login.js" defer></script>
</body>
</html>`;
}
