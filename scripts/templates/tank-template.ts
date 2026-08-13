import { renderHead } from './waitlist-landing-template';
import { escapeHtml } from '../utils/html-escape';
import type { DeckPayload } from '../../components/Fishtank';

export interface TankPageEntry {
    slug: string;
    league: string;
    matchup: string;
    payload: DeckPayload;
}

function formatKickoffFromMatchup(entry: TankPageEntry): string {
    // matchup is "Away @ Home" text only (no kickoff carried on TankPageEntry itself),
    // so the fallback list shows league + matchup - enough for real crawlable text and
    // internal links without needing to widen this type just for display purposes.
    return `${entry.league} · ${entry.matchup}`;
}

/**
 * Real, server-rendered fallback list of active Tank articles. Since .tank-screen
 * (mounted into #tank-page-root) is position:fixed/inset:0 with an opaque background,
 * and this page sets overflow:hidden on html/body, ordinary-flow content placed before
 * #tank-page-root is automatically covered once TankScreen mounts - no display:none or
 * cleanup JS needed. This is what makes /the-tank/ genuinely crawlable: a JS-disabled
 * visitor or crawler sees real <a> links to every active article; a JS-enabled visitor
 * sees the interactive carousel take over visually.
 */
function generateFallbackSection(baseUrl: string, tanks: TankPageEntry[]): string {
    const items = tanks.map(entry => `
        <li>
            <a href="/the-tank/articles/${entry.slug}/">${escapeHtml(entry.payload.hook)}</a>
            <span>${escapeHtml(formatKickoffFromMatchup(entry))}</span>
        </li>`).join('');

    return `
    <section class="tank-fallback">
        <h1>The Tank</h1>
        <p>Live prop storylines from Heatchecks, updated as games approach.</p>
        ${tanks.length === 0
            ? `<p>No active stories right now &mdash; check back soon.</p>`
            : `<ul>${items}</ul>`}
    </section>`;
}

function buildSchemaOrg(baseUrl: string, tanks: TankPageEntry[]): any[] {
    const url = `${baseUrl}/the-tank/`;

    // Same rule as tank-article-template.ts: structured-data headline text comes from
    // the frozen league/matchup record, never from the model's hook/cards/call copy.
    const collectionPageSchema = {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: 'The Tank',
        description: 'Live curated prop storylines from HeatChecks.',
        url,
        numberOfItems: tanks.length,
        mainEntity: tanks.length > 0 ? {
            '@type': 'ItemList',
            itemListElement: tanks.slice(0, 10).map((entry, index) => ({
                '@type': 'ListItem',
                position: index + 1,
                item: {
                    '@type': 'Article',
                    headline: `${entry.league}: ${entry.matchup}`,
                    url: `${baseUrl}/the-tank/articles/${entry.slug}/`,
                },
            })),
        } : undefined,
    };

    const breadcrumbSchema = {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Home', item: `${baseUrl}/` },
            { '@type': 'ListItem', position: 2, name: 'The Tank', item: url },
        ],
    };

    return [collectionPageSchema, breadcrumbSchema];
}

/**
 * The page reached by clicking the aquarium ("The Tank") on the world map. Full-bleed
 * background artwork with one clickable hotspot (the in-scene "TANKS AVAILABLE"
 * monitor) that opens a modal carousel of available tanks, mounted client-side by
 * tank-page-client.tsx / scripts/build-tank-page.ts. Also the site's one real, crawlable
 * hub for Tank articles - see generateFallbackSection() above.
 */
export function generateTankPageHtml(baseUrl: string, tanks: TankPageEntry[]): string {
    const title = 'The Tank | Heatchecks';
    const description = 'Step into the Tank - browse the sports stories available right now at Heatchecks headquarters.';
    const head = renderHead({ title, description, path: '/the-tank/', baseUrl, schemaOrg: buildSchemaOrg(baseUrl, tanks) });

    const tanksPayload = JSON.stringify(tanks).replace(/</g, '\\u003c');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    ${head}
    <link rel="stylesheet" href="/assets/tank-page.css">
    <style>
        html, body { overflow: hidden; }
        /* Covers .tank-fallback the instant this paints, before tank-page.js has even
           loaded - otherwise the real (deliberately unstyled) crawlable fallback list
           is visibly flashed on screen until React mounts .tank-screen on top of it,
           which carries this same background. Matches TankScreen.css's .tank-screen
           gradient exactly so there's no visible seam once that happens. */
        #tank-page-root {
            position: fixed;
            inset: 0;
            background: linear-gradient(180deg, #060c22 0%, #0b1a45 55%, #14275f 100%);
        }
    </style>
</head>
<body>
    ${generateFallbackSection(baseUrl, tanks)}
    <div id="tank-page-root"></div>
    <script type="application/json" id="tank-page-data">${tanksPayload}</script>
    <script type="module" src="/assets/tank-page.js" defer></script>
</body>
</html>`;
}
