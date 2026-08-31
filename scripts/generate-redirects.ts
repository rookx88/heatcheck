import * as fs from 'fs';
import * as path from 'path';

/**
 * Generate the fixed _redirects file. Heatchecks relaunched as a
 * beta-waitlist landing page at "/" - the old sports-analysis site (league
 * hubs, articles, archive, about) stays on disk untouched, but every visitor
 * hitting those URLs should land on the new homepage instead. These
 * wildcard rules catch that traffic; Cloudflare Pages matches _redirects
 * top-to-bottom on first match, so any old per-article slug is already
 * covered by its league's wildcard above - there's nothing more specific
 * left to redirect.
 */
export async function generateRedirectsFile(
    outputPath: string = 'public/_redirects'
): Promise<void> {
    const redirects: string[] = [
        '/nba/*         /  301',
        '/nfl/*         /  301',
        '/epl/*         /  301',
        '/laliga/*      /  301',
        '/serie-a/*     /  301',
        '/bundesliga/*  /  301',
        '/ligue-1/*     /  301',
        '/dfs/*         /  301',
        '/heat-picks/*  /  301',
        '/about/*       /  301',
        '/about         /  301',
        '/archive/*     /  301',
        '/archive       /  301',
        '',
        '# Tank articles that were unpublished and pruned from the build. Only the ones',
        '# with a genuine live equivalent get a redirect - the rest are meant to 404 now',
        '# that 404.html exists, which is the honest answer for content that is gone.',
        '/the-tank/articles/mike-vrabel-patriots-head-coach-out-by-2026/*  /the-tank/articles/mike-vrabel-patriots-hot-seat-fired-2026/  301',
        '/the-tank/articles/mike-vrabel-patriots-head-coach-out-by-2026    /the-tank/articles/mike-vrabel-patriots-hot-seat-fired-2026/  301',
    ];

    const redirectsContent = redirects.join('\n') + '\n';
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(outputPath, redirectsContent, 'utf-8');

    const ruleCount = redirects.filter(line => line.trim() && !line.trim().startsWith('#')).length;
    console.log(`✓ Generated ${ruleCount} redirect entries in ${outputPath}`);
}

// Run if called directly (ES module check)
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('generate-redirects.ts')) {
    generateRedirectsFile()
        .then(() => {
            console.log('Redirect generation completed');
            process.exit(0);
        })
        .catch((error) => {
            console.error('Redirect generation failed:', error);
            process.exit(1);
        });
}

