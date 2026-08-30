import { renderHead } from './waitlist-landing-template';

/**
 * TANKDAQ floor (/tankdaq/) - the exchange-floor LandScreen scene reached from the
 * grey columned building on Tank Land. Formerly generated through the generic
 * food-shop shell; split out once the INDEX PRICES sign became a real link so the
 * crawlable fallback can mirror the scene's navigation (same trick as
 * tank-land-template.ts: the fixed .land-screen covers this once tankdaq.js mounts).
 * Beaks the Broker stays a hover-only preview until his page ships.
 */
export function generateTankdaqPageHtml(baseUrl: string): string {
    const title = 'TANKDAQ | Heatchecks';
    const description = 'The TANKDAQ exchange floor - index prices for every Heatchecks storyline market.';

    const schemaOrg = [
        {
            '@context': 'https://schema.org',
            '@type': 'CollectionPage',
            name: 'TANKDAQ',
            description,
            url: `${baseUrl}/tankdaq/`,
        },
        {
            '@context': 'https://schema.org',
            '@type': 'BreadcrumbList',
            itemListElement: [
                { '@type': 'ListItem', position: 1, name: 'Home', item: `${baseUrl}/` },
                { '@type': 'ListItem', position: 2, name: 'Tank Land', item: `${baseUrl}/the-tank/` },
                { '@type': 'ListItem', position: 3, name: 'TANKDAQ', item: `${baseUrl}/tankdaq/` },
            ],
        },
    ];

    const head = renderHead({ title, description, path: '/tankdaq/', baseUrl, schemaOrg });

    return `<!DOCTYPE html>
<html lang="en">
<head>
    ${head}
    <link rel="stylesheet" href="/assets/tankdaq.css">
    <style>
        html, body { overflow: hidden; }
        #tankdaq-root {
            position: fixed;
            inset: 0;
            background: linear-gradient(180deg, #0b0713 0%, #160c27 55%, #23143e 100%);
        }
    </style>
</head>
<body>
    <section class="tankdaq-fallback">
        <h1>TANKDAQ</h1>
        <p>${description}</p>
        <ul>
            <li><a href="/tankdaq/indexes/">Index Board &mdash; every index at a glance</a></li>
        </ul>
        <p><a href="/the-tank/">Back to Tank Land</a></p>
    </section>
    <div id="tankdaq-root"></div>
    <script type="module" src="/assets/tankdaq.js" defer></script>
</body>
</html>`;
}
