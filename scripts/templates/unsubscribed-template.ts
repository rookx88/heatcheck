import { renderHead, topbar, footer } from './waitlist-landing-template';

/**
 * The landing page for a one-click email unsubscribe: GET /api/email/unsubscribe
 * writes the preference off and 302s here with ?kind=settlement|newsletter|invalid.
 * Static and login-free on purpose - the reader is often on a phone with no session,
 * and "log in to confirm you don't want email" is the failure this page exists to
 * avoid. The only dynamic part is which sentence to show, picked from the query string
 * by a few lines of inline script (no bundle). Links to the account page's
 * Notifications tab for the full set of switches. noindex: nothing to find here.
 */
export function generateUnsubscribedPageHtml(baseUrl: string): string {
    const title = 'Unsubscribed | Heatchecks';
    const description = 'Your Heatchecks email preference has been updated.';
    const head = renderHead({ title, description, path: '/unsubscribed/', baseUrl });

    return `<!DOCTYPE html>
<html lang="en">
<head>
    ${head}
    <meta name="robots" content="noindex">
    <meta name="referrer" content="no-referrer">
    <style>
        .hc-unsub {
            max-width: 460px; margin: 2.5rem auto; padding: 2rem 1.75rem 2.25rem;
            background: rgba(255, 255, 255, 0.04);
            border: 2px solid rgba(47, 230, 217, 0.4);
            border-radius: 20px;
            box-shadow: 0 0 40px rgba(47, 230, 217, 0.12), 0 20px 50px rgba(0, 0, 0, 0.45);
            text-align: center;
        }
        .hc-unsub-eyebrow {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.72rem;
            letter-spacing: 0.14em; text-transform: uppercase; color: var(--hc-teal);
            text-shadow: 0 0 10px rgba(47, 230, 217, 0.45); margin: 0;
        }
        .hc-unsub h1 {
            font-family: 'Baloo 2', 'Nunito', sans-serif; font-weight: 800;
            font-size: clamp(1.35rem, 5vw, 1.75rem); line-height: 1.2;
            color: #ffffff; margin: 0.4rem 0 0;
        }
        .hc-unsub p {
            font-family: 'Nunito', sans-serif; font-size: 0.95rem; line-height: 1.55;
            color: rgba(255, 255, 255, 0.75); margin: 0.75rem 0 1.25rem;
        }
        .hc-unsub-actions { display: flex; flex-wrap: wrap; gap: 0.75rem; justify-content: center; }
        .hc-unsub-button {
            display: inline-block; background: var(--hc-gold); color: #1a1200;
            font-family: 'Baloo 2', 'Nunito', sans-serif; font-weight: 800; font-size: 1rem;
            text-decoration: none; padding: 0.6rem 1.5rem; border-radius: 12px;
        }
        .hc-unsub-button--secondary { background: transparent; color: #fff; border: 1px solid rgba(255,255,255,0.3); }
    </style>
</head>
<body>
    <main class="hc-page">
        ${topbar()}
        <section class="hc-unsub" aria-live="polite">
            <p class="hc-unsub-eyebrow">Email preferences</p>
            <h1 data-unsub-heading>Updating your preference…</h1>
            <p data-unsub-copy></p>
            <div class="hc-unsub-actions">
                <a class="hc-unsub-button" href="/account/?tab=notifications">Manage all email settings</a>
                <a class="hc-unsub-button hc-unsub-button--secondary" href="/">Back to Heatchecks</a>
            </div>
        </section>
        ${footer()}
    </main>
    <script>
        (function () {
            var kind = new URLSearchParams(window.location.search).get('kind');
            var copy = {
                settlement: ['You\\u2019re unsubscribed.', 'You won\\u2019t get settlement result emails any more. Your calls still settle and your Ember still lands - you\\u2019ll just see it on the site instead of in your inbox.'],
                newsletter: ['You\\u2019re off the weekly newsletter.', 'No more weekly issues to this address. You can switch it back on from your account page any time.']
            };
            var picked = copy[kind] || ['That link didn\\u2019t work.', 'This unsubscribe link is invalid or has expired. You can manage every email from your account page instead.'];
            document.querySelector('[data-unsub-heading]').textContent = picked[0];
            document.querySelector('[data-unsub-copy]').textContent = picked[1];
        })();
    </script>
</body>
</html>`;
}
