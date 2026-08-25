import { renderHead } from './waitlist-landing-template';

/**
 * The Hatchery (/the-hatchery/) - reached from the egg machine on Tank Land. The
 * "Eggs for Sale" sign opens the shop modal, the incubator opens the hatch modal;
 * both are client-side (hatchery-page.js). The fallback nav is covered by the fixed
 * .land-screen once the island mounts.
 */
export function generateHatcheryPageHtml(baseUrl: string): string {
    const title = 'The Hatchery | Heatchecks';
    const description = 'The Hatchery - buy eggs with Ember and hatch your Mud Puppy in the incubator.';

    const schemaOrg = [
        {
            '@context': 'https://schema.org',
            '@type': 'BreadcrumbList',
            itemListElement: [
                { '@type': 'ListItem', position: 1, name: 'Home', item: `${baseUrl}/` },
                { '@type': 'ListItem', position: 2, name: 'Tank Land', item: `${baseUrl}/the-tank/` },
                { '@type': 'ListItem', position: 3, name: 'The Hatchery', item: `${baseUrl}/the-hatchery/` },
            ],
        },
    ];

    const head = renderHead({ title, description, path: '/the-hatchery/', baseUrl, schemaOrg });

    return `<!DOCTYPE html>
<html lang="en">
<head>
    ${head}
    <link rel="stylesheet" href="/assets/hatchery-page.css">
    <style>
        html, body { overflow: hidden; }
        /* Covers the fallback nav before hatchery-page.js mounts - matches
           LandScreen.css's .land-screen gradient so there's no seam. */
        #hatchery-page-root {
            position: fixed;
            inset: 0;
            background: linear-gradient(180deg, #0b0713 0%, #160c27 55%, #23143e 100%);
        }
    </style>
</head>
<body>
    <section class="hatchery-fallback">
        <h1>The Hatchery</h1>
        <p>Buy eggs with Ember and hatch your Mud Puppy in the incubator.</p>
        <p><a href="/the-tank/">Back to Tank Land</a></p>
    </section>
    <div id="hatchery-page-root"></div>
    <script type="module" src="/assets/hatchery-page.js" defer></script>
</body>
</html>`;
}
