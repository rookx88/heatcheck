import { renderHead } from './waitlist-landing-template';

/**
 * Tank Land (/the-tank/) - the hub the world map's tank region lands on. The page is
 * pure navigation artwork: the Tank HQ structure leads to /the-tank-hq/ (the story
 * browser) and the egg machine leads to /the-hatchery/. The fallback nav below
 * mirrors the artwork's hotspots as real crawlable links, covered by the fixed
 * .land-screen once tank-land.js mounts (same trick as the Tank HQ page).
 */
export function generateTankLandPageHtml(baseUrl: string): string {
    const title = 'Tank Land | Heatchecks';
    const description = 'Explore Tank Land - visit the Tank HQ for today’s stories or the Hatchery for eggs and hatching.';

    const schemaOrg = [
        {
            '@context': 'https://schema.org',
            '@type': 'CollectionPage',
            name: 'Tank Land',
            description,
            url: `${baseUrl}/the-tank/`,
        },
        {
            '@context': 'https://schema.org',
            '@type': 'BreadcrumbList',
            itemListElement: [
                { '@type': 'ListItem', position: 1, name: 'Home', item: `${baseUrl}/` },
                { '@type': 'ListItem', position: 2, name: 'Tank Land', item: `${baseUrl}/the-tank/` },
            ],
        },
    ];

    const head = renderHead({ title, description, path: '/the-tank/', baseUrl, schemaOrg });

    return `<!DOCTYPE html>
<html lang="en">
<head>
    ${head}
    <link rel="stylesheet" href="/assets/tank-land.css">
    <style>
        html, body { overflow: hidden; }
        /* Covers the fallback nav before tank-land.js mounts - matches
           LandScreen.css's .land-screen gradient so there's no seam. */
        #tank-land-root {
            position: fixed;
            inset: 0;
            background: linear-gradient(180deg, #0b0713 0%, #160c27 55%, #23143e 100%);
        }
    </style>
</head>
<body>
    <section class="tank-land-fallback">
        <h1>Tank Land</h1>
        <ul>
            <li><a href="/the-tank-hq/">The Tank HQ &mdash; today's tanks</a></li>
            <li><a href="/the-hatchery/">The Hatchery &mdash; eggs and incubator</a></li>
        </ul>
    </section>
    <div id="tank-land-root"></div>
    <script type="module" src="/assets/tank-land.js" defer></script>
</body>
</html>`;
}
