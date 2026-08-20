import { escapeHtml } from '../utils/html-escape';

/**
 * Standalone templates for the beta relaunch of heatchecks.io.
 * These pages intentionally do NOT use generateBaseHtml() — the old site's
 * chrome (hamburger nav, crawler nav, HeatScan modal) doesn't apply to this
 * new, much simpler marketing funnel (landing -> claim your spot / learn more).
 */

interface HeadOptions {
    title: string;
    description: string;
    path: string; // e.g. '/', '/waitlist/', '/beta/'
    baseUrl: string;
    schemaOrg?: any;
    ogType?: 'website' | 'article';
    articleMeta?: {
        publishedTime?: string;
        modifiedTime?: string;
        section?: string;
    };
}

export function renderHead(options: HeadOptions): string {
    const { title, description, path, baseUrl, schemaOrg, articleMeta } = options;
    const ogType = options.ogType || 'website';
    const url = `${baseUrl}${path}`;
    const ogImage = `${baseUrl}/assets/images/og-share-world-map.jpg`;
    const schemaScript = schemaOrg
        ? `<script type="application/ld+json">\n${JSON.stringify(schemaOrg, null, 2)}\n</script>`
        : '';

    // Postgres timestamp columns come back as JS Date objects at runtime (despite the
    // `string` type here), so normalize through Date -> toISOString() rather than
    // relying on String()'s human-readable default - Open Graph requires ISO 8601.
    const toIsoString = (value: string | Date): string => new Date(value).toISOString();

    let articleMetaTags = '';
    if (articleMeta) {
        if (articleMeta.publishedTime) {
            articleMetaTags += `\n    <meta property="article:published_time" content="${escapeHtml(toIsoString(articleMeta.publishedTime))}">`;
        }
        if (articleMeta.modifiedTime) {
            articleMetaTags += `\n    <meta property="article:modified_time" content="${escapeHtml(toIsoString(articleMeta.modifiedTime))}">`;
        }
        if (articleMeta.section) {
            articleMetaTags += `\n    <meta property="article:section" content="${escapeHtml(articleMeta.section)}">`;
        }
    }

    return `<meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}">
    <link rel="canonical" href="${escapeHtml(url)}">

    <meta property="og:title" content="${escapeHtml(title)}">
    <meta property="og:description" content="${escapeHtml(description)}">
    <meta property="og:image" content="${escapeHtml(ogImage)}">
    <meta property="og:url" content="${escapeHtml(url)}">
    <meta property="og:type" content="${ogType}">
    <meta property="og:site_name" content="HeatChecks">${articleMetaTags}

    <link rel="icon" type="image/png" href="/assets/images/heatchecks-logo.png">

    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escapeHtml(title)}">
    <meta name="twitter:description" content="${escapeHtml(description)}">
    <meta name="twitter:image" content="${escapeHtml(ogImage)}">

    ${schemaScript}

    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@500;700;800&family=Nunito:wght@400;600;800&display=swap" rel="stylesheet">

    <style>${sharedStyles()}</style>
    <script type="module" src="/assets/analytics-beacon.js" defer></script>`;
}

function sharedStyles(): string {
    return `
        :root {
            --hc-navy-dark: #060c22;
            --hc-navy: #0b1a45;
            --hc-navy-light: #14275f;
            --hc-gold: #ffc72c;
            --hc-gold-dark: #e8a800;
            --hc-teal: #2fe6d9;
            --hc-bubble: #cfe6ff;
        }
        * { box-sizing: border-box; }
        html, body {
            margin: 0;
            padding: 0;
            background: linear-gradient(180deg, var(--hc-navy-dark) 0%, var(--hc-navy) 55%, var(--hc-navy-light) 100%);
            color: #ffffff;
            font-family: 'Nunito', 'Helvetica Neue', Arial, sans-serif;
            -webkit-font-smoothing: antialiased;
        }
        /* House scrollbars everywhere: navy track, marquee-orange thumb. Surfaces
           with their own aesthetic (the tank-modal artifacts) override the thumb to
           teal in their own CSS. Firefox uses scrollbar-color; WebKit the pseudos. */
        html { scrollbar-color: #f89b4e var(--hc-navy-dark); }
        ::-webkit-scrollbar { width: 10px; height: 10px; }
        ::-webkit-scrollbar-track { background: var(--hc-navy-dark); }
        ::-webkit-scrollbar-thumb {
            background: linear-gradient(180deg, #f89b4e 0%, var(--hc-gold) 100%);
            border-radius: 999px;
            border: 2px solid var(--hc-navy-dark);
        }
        ::-webkit-scrollbar-thumb:hover { background: var(--hc-gold); }
        ::-webkit-scrollbar-corner { background: var(--hc-navy-dark); }
        a { color: inherit; }
        .hc-page {
            max-width: 560px;
            margin: 0 auto;
            min-height: 100vh;
            padding: 0.5rem 1.25rem 1rem;
            display: flex;
            flex-direction: column;
        }
        .hc-topbar {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 1rem;
        }
        .hc-logo img {
            width: clamp(190px, 54vw, 280px);
            height: auto;
            display: block;
        }
        .hc-learn-more {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 0.25rem;
            text-decoration: none;
            flex-shrink: 0;
        }
        .hc-learn-more .hc-check-box {
            width: 56px;
            height: 56px;
            border: 2px solid rgba(47, 230, 217, 0.6);
            border-radius: 12px;
            background: rgba(47, 230, 217, 0.08);
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 0 18px rgba(47, 230, 217, 0.25);
        }
        .hc-learn-more .hc-check-box img { width: 34px; height: auto; }
        .hc-learn-more span {
            font-family: 'Nunito', sans-serif;
            font-weight: 800;
            font-size: 0.7rem;
            letter-spacing: 0.04em;
            color: var(--hc-teal);
            text-transform: uppercase;
        }
        .hc-hero {
            margin-top: 0.15rem;
            margin-left: -1.25rem;
            margin-right: -1.25rem;
        }
        .hc-hero-inner {
            position: relative;
            width: fit-content;
            margin: 0 auto;
        }
        .hc-world-map {
            display: block;
            width: auto;
            max-width: 100%;
            max-height: 45vh;
            height: auto;
            animation: hc-float 4.5s ease-in-out infinite;
        }
        @keyframes hc-float {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-12px); }
        }
        @media (prefers-reduced-motion: reduce) {
            .hc-world-map { animation: none; }
        }
        .hc-puppy-stage {
            position: absolute;
            right: -2%;
            bottom: -8%;
            width: 42%;
            aspect-ratio: 2 / 3;
        }
        .hc-puppy-frame {
            position: absolute;
            inset: 0;
            opacity: 0;
            transition: opacity 0.7s ease;
        }
        .hc-puppy-frame.is-active { opacity: 1; }
        .hc-puppy-frame img {
            width: 100%;
            height: 100%;
            object-fit: contain;
            filter: drop-shadow(0 10px 18px rgba(0,0,0,0.45));
        }
        .hc-bubble {
            background: var(--hc-bubble);
            color: #0b1a45;
            border-radius: 22px 22px 22px 4px;
            padding: 0.6rem 0.9rem;
            margin-top: 0.85rem;
            box-shadow: 0 8px 24px rgba(0,0,0,0.35);
        }
        .hc-bubble h1 {
            font-family: 'Baloo 2', 'Nunito', sans-serif;
            font-weight: 800;
            font-size: clamp(1.15rem, 5.5vw, 1.6rem);
            line-height: 1.12;
            margin: 0;
            text-transform: uppercase;
        }
        .hc-subcopy {
            text-align: center;
            font-size: 0.85rem;
            line-height: 1.35;
            color: rgba(255,255,255,0.88);
            margin: 1rem 0 0;
        }
        .hc-cta-row {
            display: flex;
            justify-content: center;
            margin-top: 1.25rem;
        }
        .hc-cta-button {
            display: inline-block;
            background: var(--hc-gold);
            color: #1a1200;
            font-family: 'Baloo 2', 'Nunito', sans-serif;
            font-weight: 800;
            font-size: 1.1rem;
            text-decoration: none;
            padding: 0.7rem 2.1rem;
            border-radius: 14px;
            box-shadow: 0 6px 0 var(--hc-gold-dark), 0 10px 22px rgba(0,0,0,0.4);
            transition: transform 0.15s ease;
        }
        .hc-cta-button:active { transform: translateY(3px); box-shadow: 0 3px 0 var(--hc-gold-dark); }
        .hc-footer {
            margin-top: auto;
            padding-top: 2rem;
            text-align: center;
            font-size: 0.78rem;
            color: rgba(255,255,255,0.4);
        }
        .hc-footer a { color: rgba(255,255,255,0.6); text-decoration: underline; }

        /* Beta info / claim-your-spot pages */
        .hc-card {
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.12);
            border-radius: 18px;
            padding: 1.75rem 1.5rem;
            margin-top: 2rem;
        }
        .hc-card h1 {
            font-family: 'Baloo 2', sans-serif;
            font-weight: 800;
            font-size: clamp(1.4rem, 6vw, 1.9rem);
            margin: 0 0 0.75rem;
            color: #ffffff;
        }
        .hc-card p.hc-lede {
            font-size: 0.98rem;
            line-height: 1.6;
            color: rgba(255,255,255,0.8);
            margin: 0 0 1.5rem;
        }
        .hc-back-link {
            display: inline-block;
            margin-top: 1.5rem;
            font-size: 0.85rem;
            color: rgba(255,255,255,0.6);
            text-decoration: none;
        }
        .hc-back-link:hover { color: #ffffff; }

        @media (max-width: 420px) {
            .hc-page { padding: 0.5rem 1rem 0.85rem; }
            .hc-hero { margin-left: -1rem; margin-right: -1rem; }
        }
    `;
}

export function topbar(learnMoreHref: string): string {
    return `
        <div class="hc-topbar">
            <a class="hc-logo" href="/" aria-label="Heatchecks home">
                <img src="/assets/images/heatchecks-logo.webp" alt="Heatchecks logo" width="500" height="241">
            </a>
            <a class="hc-learn-more" href="${learnMoreHref}">
                <span class="hc-check-box">
                    <img src="/assets/images/checknav.webp" alt="" width="140" height="200">
                </span>
                <span>Learn more</span>
            </a>
        </div>`;
}

export function footer(): string {
    const year = new Date().getFullYear();
    return `
        <div class="hc-footer">
            &copy; ${year} Heatchecks &middot; <a href="/">Home</a>
        </div>`;
}

export function generateLandingPageHtml(baseUrl: string): string {
    const title = 'Heatchecks | A Sports World Worth Playing — Join the Beta Waitlist';
    const description = 'Heatchecks is becoming a Neopets-style sports world: explore themed sports islands, follow real matchups, and grow your own Mud Puppy pet. Join the free beta waitlist today.';

    const schemaOrg = [
        {
            '@context': 'https://schema.org',
            '@type': 'Organization',
            name: 'HeatChecks',
            url: baseUrl,
            logo: { '@type': 'ImageObject', url: `${baseUrl}/assets/images/heatchecks-logo.png` },
            description,
        },
        {
            '@context': 'https://schema.org',
            '@type': 'WebSite',
            name: 'HeatChecks',
            url: baseUrl,
            description,
        },
    ];

    const head = renderHead({ title, description, path: '/', baseUrl, schemaOrg });

    return `<!DOCTYPE html>
<html lang="en">
<head>
    ${head}
</head>
<body>
    <main class="hc-page">
        ${topbar('/beta/')}

        <div class="hc-hero">
            <div class="hc-hero-inner">
                <picture>
                    <source srcset="/assets/images/world-map.webp" type="image/webp">
                    <img class="hc-world-map" src="/assets/images/world-map.png" alt="Illustrated map of the Heatchecks sports world, with themed islands for soccer, football, basketball, baseball, hockey, and golf surrounding a central aquarium" width="1120" height="1113" loading="eager">
                </picture>
                <div class="hc-puppy-stage" aria-hidden="false" aria-label="Your Mud Puppy pet, shown cycling through its forms">
                    <picture class="hc-puppy-frame is-active" data-frame="0">
                        <source srcset="/assets/images/mudpuppy-default.webp" type="image/webp">
                        <img src="/assets/images/mudpuppy-default.png" alt="Mud Puppy, the Heatchecks pet, in its default form" width="800" height="1200">
                    </picture>
                    <picture class="hc-puppy-frame" data-frame="1">
                        <source srcset="/assets/images/mudpuppy-jersey.webp" type="image/webp">
                        <img src="/assets/images/mudpuppy-jersey.png" alt="Mud Puppy wearing a basketball jersey, evolved from playing and following basketball" width="800" height="1200">
                    </picture>
                    <picture class="hc-puppy-frame" data-frame="2">
                        <source srcset="/assets/images/mudpuppy-football.webp" type="image/webp">
                        <img src="/assets/images/mudpuppy-football.png" alt="Mud Puppy wearing football gear, evolved from playing and following football" width="800" height="1200">
                    </picture>
                </div>
            </div>
        </div>

        <div class="hc-bubble">
            <h1>The sports world you already follow, finally worth something.</h1>
        </div>

        <p class="hc-subcopy">Explore the world, read the stories, make the calls, play the games — and everything you do earns Embers to grow your Mud Puppy in a competitive sports world. Free to play!</p>

        <div class="hc-cta-row">
            <a class="hc-cta-button" href="/claim-your-spot/">Claim your spot.</a>
        </div>
    </main>
    <script>
    (function () {
        var frames = document.querySelectorAll('.hc-puppy-frame');
        if (frames.length < 2) return;
        var index = 0;
        setInterval(function () {
            frames[index].classList.remove('is-active');
            index = (index + 1) % frames.length;
            frames[index].classList.add('is-active');
        }, 3500);
    })();
    <\/script>
</body>
</html>`;
}

export function generateBetaInfoPageHtml(baseUrl: string): string {
    const title = 'What’s Coming to Heatchecks | Beta Info';
    const description = 'Heatchecks is turning into a free-to-play, Neopets-style sports world. Here’s a preview of what’s coming in the beta.';
    const head = renderHead({ title, description, path: '/beta/', baseUrl });

    return `<!DOCTYPE html>
<html lang="en">
<head>
    ${head}
</head>
<body>
    <main class="hc-page">
        ${topbar('/beta/')}

        <div class="hc-card">
            <h1>Something new is coming.</h1>
            <p class="hc-lede">We're rebuilding Heatchecks into a free-to-play sports world, complete with a pet to grow, islands to explore, and games built around the sports you already follow. Full details on the beta are on their way — check back soon.</p>
            <div class="hc-cta-row" style="justify-content: flex-start; margin-top: 0;">
                <a class="hc-cta-button" href="/claim-your-spot/">Claim your spot.</a>
            </div>
            <a class="hc-back-link" href="/">&larr; Back to Heatchecks</a>
        </div>

        ${footer()}
    </main>
</body>
</html>`;
}
