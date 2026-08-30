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
    <!-- The form internals (input, gold CTA, Discord button, divider, notice,
         error) are the shared AuthForm - its styles ship as /assets/login.css,
         emitted by build-login.ts from components/AuthForm.css. -->
    <link rel="stylesheet" href="/assets/login.css">
    <style>
        /* Page-only chrome: navy glass panel with the teal border glow, Baloo
           heading - the same language as the tank modals and homepage. */
        .hc-login {
            max-width: 460px; margin: 2.5rem auto; padding: 2rem 1.75rem 2.25rem;
            background: rgba(255, 255, 255, 0.04);
            border: 2px solid rgba(47, 230, 217, 0.4);
            border-radius: 20px;
            box-shadow: 0 0 40px rgba(47, 230, 217, 0.12), 0 20px 50px rgba(0, 0, 0, 0.45);
            text-align: center;
        }
        .hc-login h1 {
            font-family: 'Baloo 2', 'Nunito', sans-serif; font-weight: 800;
            font-size: clamp(1.35rem, 5vw, 1.75rem); line-height: 1.2;
            color: #ffffff; margin: 0.4rem 0 0;
            text-shadow: 0 0 18px rgba(47, 230, 217, 0.25);
        }
        .hc-login-eyebrow {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.72rem;
            letter-spacing: 0.14em; text-transform: uppercase; color: var(--hc-teal);
            text-shadow: 0 0 10px rgba(47, 230, 217, 0.45); margin: 0;
        }
        /* Still used by the token-consuming states ("Logging you in…"). */
        .hc-login-copy {
            font-family: 'Nunito', sans-serif; font-size: 0.95rem; line-height: 1.55;
            color: rgba(255, 255, 255, 0.75); margin: 0.75rem 0 1.25rem;
        }
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
