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
        .hc-worldmap-wrap { margin-top: 1.5rem; }
        #world-map-root { min-height: 320px; }
    </style>
</head>
<body>
    <main class="hc-page">
        ${topbar('/beta/')}

        <div class="hc-bubble">
            <h1>Claim your spot</h1>
        </div>

        <p class="hc-subcopy">No, no! This isn't just an enter your email and off you go. This is the start (headstart actually) of your journey into the world of Heatchecks. Visit the TANK to get started.</p>

        <div class="hc-worldmap-wrap">
            <div id="world-map-root"></div>
        </div>

        ${footer()}
    </main>
    <script type="module" src="/assets/world-map.js" defer></script>
</body>
</html>`;
}
