import { renderHead, topbar, footer } from './waitlist-landing-template';

/**
 * The not-found page. This file existing at the build root is the whole point:
 * Cloudflare Pages only falls back to serving /index.html for unmatched routes when
 * the output has no 404.html - which meant every typo, dead link and stale crawler URL
 * returned 200 with a byte-identical copy of the homepage. Shipping this makes Pages
 * return a real 404 status instead, so those URLs stop being indexable homepage
 * duplicates.
 *
 * noindex for the same reason a login page carries it - and because Pages serves this
 * body on every unmatched path, so without it one page could be indexed under
 * arbitrarily many URLs.
 *
 * The two links out are deliberate: a crawler (or person) that lands here should still
 * reach the site's real entry points rather than hitting a dead end.
 */
export function generate404Page(baseUrl: string): string {
    const title = 'Page Not Found | Heatchecks';
    const description = 'That page does not exist. Head back to Heatchecks or browse the latest stories in The Tank.';
    const head = renderHead({ title, description, path: '/404.html', baseUrl });

    return `<!DOCTYPE html>
<html lang="en">
<head>
    ${head}
    <meta name="robots" content="noindex">
    <style>
        .hc-404 {
            max-width: 560px;
            margin: 3rem auto;
            padding: 2.25rem 1.75rem 2.5rem;
            text-align: center;
            background: rgba(255, 255, 255, 0.04);
            border: 2px solid rgba(47, 230, 217, 0.4);
            border-radius: 20px;
            box-shadow: 0 0 40px rgba(47, 230, 217, 0.12), 0 20px 50px rgba(0, 0, 0, 0.45);
        }
        .hc-404-code {
            font-family: 'Montserrat', 'Nunito', sans-serif;
            font-weight: 900;
            font-size: clamp(2.75rem, 12vw, 4rem);
            line-height: 1;
            color: var(--hc-gold);
            text-shadow: 0 0 24px rgba(255, 199, 44, 0.35);
            margin: 0;
        }
        .hc-404 h1 {
            font-family: 'Baloo 2', 'Nunito', sans-serif;
            font-weight: 800;
            font-size: clamp(1.3rem, 5vw, 1.7rem);
            line-height: 1.2;
            color: #ffffff;
            margin: 0.6rem 0 0;
        }
        .hc-404 p {
            font-family: 'Nunito', sans-serif;
            font-size: 0.98rem;
            line-height: 1.55;
            color: rgba(255, 255, 255, 0.75);
            margin: 0.85rem 0 1.5rem;
        }
        .hc-404-links {
            display: flex;
            flex-wrap: wrap;
            gap: 0.75rem;
            justify-content: center;
        }
        .hc-404-links a {
            font-family: 'Montserrat', 'Nunito', sans-serif;
            font-weight: 800;
            font-size: 0.8rem;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            text-decoration: none;
            padding: 0.7rem 1.25rem;
            border-radius: 999px;
            border: 2px solid var(--hc-gold);
            color: var(--hc-navy-dark);
            background: var(--hc-gold);
        }
        .hc-404-links a.secondary {
            background: transparent;
            color: var(--hc-teal);
            border-color: rgba(47, 230, 217, 0.55);
        }
    </style>
</head>
<body>
    <main class="hc-page">
        ${topbar('/beta/')}
        <section class="hc-404">
            <p class="hc-404-code">404</p>
            <h1>This one got away.</h1>
            <p>The page you were after doesn&rsquo;t exist &mdash; it may have moved, or the link may be out of date.</p>
            <div class="hc-404-links">
                <a href="/">Back to Heatchecks</a>
                <a class="secondary" href="/the-tank-hq/">Browse The Tank</a>
            </div>
        </section>
        ${footer()}
    </main>
</body>
</html>`;
}
