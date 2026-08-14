import { renderHead, topbar, footer } from './waitlist-landing-template';

/**
 * The page the "Claim your spot." CTA leads to. Shows the interactive world
 * map (mounted client-side by world-map-client.tsx / scripts/build-world-map.ts)
 * with every sport island disabled ("Coming Soon") except the central Tank,
 * which is the only live route from here.
 */
export function generateClaimYourSpotPageHtml(baseUrl: string): string {
    const title = 'Claim Your Spot | Heatchecks';
    const description = 'Claim your spot in the Heatchecks beta and take your first steps into the world of Heatchecks — visit the Tank to get started.';
    const head = renderHead({ title, description, path: '/claim-your-spot/', baseUrl });

    return `<!DOCTYPE html>
<html lang="en">
<head>
    ${head}
    <link rel="stylesheet" href="/assets/world-map.css">
    <style>
        /* Bumped from 1.5rem so the map sits further down the page on both mobile
           and desktop, giving the intro text + callout room to breathe above it -
           clamp scales the gap with viewport width instead of one fixed value. */
        .hc-worldmap-wrap { margin-top: clamp(2.5rem, 9vw, 4.5rem); }
        #world-map-root { min-height: 320px; }

        .claim-tank-callout {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 0.3rem;
            margin: 1.75rem auto 0;
        }
        .claim-tank-callout-text {
            display: inline-block;
            background: var(--hc-gold);
            color: #1a1200;
            font-family: 'Baloo 2', 'Nunito', sans-serif;
            font-weight: 800;
            font-size: clamp(0.95rem, 4vw, 1.15rem);
            text-transform: uppercase;
            letter-spacing: 0.02em;
            padding: 0.65rem 1.5rem;
            border-radius: 999px;
            box-shadow: 0 6px 0 var(--hc-gold-dark), 0 10px 22px rgba(0,0,0,0.4);
            animation: claim-tank-bounce 2.2s ease-in-out infinite;
        }
        .claim-tank-callout-arrow {
            font-size: 1.3rem;
            line-height: 1;
            color: var(--hc-gold);
            animation: claim-tank-arrow-bounce 1.4s ease-in-out infinite;
        }
        @keyframes claim-tank-bounce {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-4px); }
        }
        @keyframes claim-tank-arrow-bounce {
            0%, 100% { transform: translateY(0); opacity: 0.65; }
            50% { transform: translateY(6px); opacity: 1; }
        }
        @media (prefers-reduced-motion: reduce) {
            .claim-tank-callout-text, .claim-tank-callout-arrow { animation: none !important; }
        }
    </style>
</head>
<body>
    <main class="hc-page">
        ${topbar('/beta/')}

        <div class="hc-bubble">
            <h1>Claim your spot</h1>
        </div>

        <p class="hc-subcopy">No, no! This isn't just an enter your email and off you go. This is the start (headstart actually) of your journey into the world of Heatchecks.</p>

        <div class="claim-tank-callout">
            <span class="claim-tank-callout-text">Visit the TANK to get started</span>
            <span class="claim-tank-callout-arrow" aria-hidden="true">&darr;</span>
        </div>

        <div class="hc-worldmap-wrap">
            <div id="world-map-root"></div>
        </div>

        ${footer()}
    </main>
    <script type="module" src="/assets/world-map.js" defer></script>
</body>
</html>`;
}
