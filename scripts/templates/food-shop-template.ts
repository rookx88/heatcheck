import { renderHead } from './waitlist-landing-template';

/**
 * One parameterized generator for both Tank Land food-shop pages (Champion's
 * Lakeside Terrace, Quickboost Delicacies) - each is a LandScreen scene whose one
 * hotspot opens the vendor's FoodShopModal. Fallback nav is covered by the fixed
 * .land-screen once the island mounts (same trick as the other tank-world pages).
 * Despite the name it's a generic LandScreen-page shell - TANKDAQ (/tankdaq/)
 * uses it too.
 */
export interface FoodShopPage {
    path: string;        // '/champions-terrace/'
    title: string;       // 'Champion's Lakeside Terrace | Heatchecks'
    heading: string;     // fallback <h1>
    description: string;
    rootId: string;      // 'champions-terrace-root'
    scriptName: string;  // 'champions-terrace' -> /assets/champions-terrace.js|.css
}

export function generateFoodShopPageHtml(baseUrl: string, page: FoodShopPage): string {
    const schemaOrg = [
        {
            '@context': 'https://schema.org',
            '@type': 'BreadcrumbList',
            itemListElement: [
                { '@type': 'ListItem', position: 1, name: 'Home', item: `${baseUrl}/` },
                { '@type': 'ListItem', position: 2, name: 'Tank Land', item: `${baseUrl}/the-tank/` },
                { '@type': 'ListItem', position: 3, name: page.heading, item: `${baseUrl}${page.path}` },
            ],
        },
    ];

    const head = renderHead({ title: page.title, description: page.description, path: page.path, baseUrl, schemaOrg });

    return `<!DOCTYPE html>
<html lang="en">
<head>
    ${head}
    <link rel="stylesheet" href="/assets/${page.scriptName}.css">
    <style>
        html, body { overflow: hidden; }
        #${page.rootId} {
            position: fixed;
            inset: 0;
            background: linear-gradient(180deg, #0b0713 0%, #160c27 55%, #23143e 100%);
        }
    </style>
</head>
<body>
    <section class="food-shop-fallback">
        <h1>${page.heading}</h1>
        <p>${page.description}</p>
        <p><a href="/the-tank/">Back to Tank Land</a></p>
    </section>
    <div id="${page.rootId}"></div>
    <script type="module" src="/assets/${page.scriptName}.js" defer></script>
</body>
</html>`;
}
