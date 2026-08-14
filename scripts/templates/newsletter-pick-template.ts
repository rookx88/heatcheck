import { renderHead, topbar, footer } from './waitlist-landing-template';

/**
 * The landing page a newsletter recipient lands on after clicking the exclusive-pick
 * link in their email (emails/NewsletterIssue.tsx). Generic shell - all real content
 * (this week's exclusive Tank's hook/call) is fetched client-side by
 * newsletter-pick-client.tsx using the token in the URL, since this page is static and
 * has no server-rendered per-request data.
 */
export function generateNewsletterPickPageHtml(baseUrl: string): string {
    const title = 'This Week’s Exclusive Call | Heatchecks';
    const description = 'Your newsletter-exclusive Tank pick, ready to make.';
    const head = renderHead({ title, description, path: '/newsletter-pick/', baseUrl });

    return `<!DOCTYPE html>
<html lang="en">
<head>
    ${head}
    <style>
        .hc-newsletter-pick, .hc-newsletter-pick-loading, .hc-newsletter-pick-error, .hc-newsletter-pick-done {
            max-width: 480px; margin: 3rem auto; padding: 0 1.5rem; font-family: Georgia, 'Times New Roman', serif;
        }
        .hc-newsletter-pick-eyebrow { font-size: 0.75rem; letter-spacing: 0.08em; text-transform: uppercase; color: #888; }
        .hc-newsletter-pick-question { font-size: 1rem; color: #333; margin: 0.75rem 0 1.25rem; }
        .hc-newsletter-pick-sides { display: flex; gap: 0.75rem; flex-wrap: wrap; }
        .hc-newsletter-pick-sides button {
            flex: 1; min-width: 140px; padding: 0.9rem 1rem; font-size: 1rem; cursor: pointer;
            background: #111; color: #fff; border: none; border-radius: 6px;
        }
        .hc-newsletter-pick-sides button:disabled { opacity: 0.6; cursor: default; }
        .hc-newsletter-pick-error { color: #c62828; }
    </style>
</head>
<body>
    <main class="hc-page">
        ${topbar('/')}
        <div id="newsletter-pick-root"></div>
        ${footer()}
    </main>
    <script type="module" src="/assets/newsletter-pick.js" defer></script>
</body>
</html>`;
}
