import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export interface HeatcheckPost {
    id: string;
    league: string;
    teamA: string;
    teamB: string;
    matchupScheduledDate?: string;
    createdAt: string;
    updatedAt: string;
    storyType?: string;
    websiteStory: {
        headline: string;
        seo?: {
            slug: string;
            previousSlugs?: string[];
        };
    };
    heatCheckData?: {
        narratives?: {
            candidate_cards?: Array<{
                narrative_id: string;
                emotion_tags?: string[];
            }>;
            selected?: {
                primary_narrative_id: string;
            };
        };
    };
}

/**
 * Generate XML sitemap.
 *
 * Heatchecks is relaunching as a beta-waitlist landing page: the old
 * sports-analysis site (league hubs, articles, archive, about) still exists
 * on disk but now 301-redirects to "/" (see generate-redirects.ts), so it's
 * deliberately left out of the sitemap to avoid pointing crawlers at
 * redirect chains. `posts` is accepted for call-site compatibility but no
 * longer used. The Tank is the one deliberate exception to the "hidden
 * during the waitlist phase" rule - it's live, real content. /the-tank/
 * itself is hardcoded below; `tankUrls` (each published Tank article,
 * computed by the caller) is appended on top of that.
 */
export function generateSitemap(
    _posts: HeatcheckPost[],
    baseUrl: string = 'https://heatchecks.io',
    outputPath: string = 'public/sitemap.xml',
    tankUrls: Array<{ loc: string; lastmod: string; changefreq: string; priority: string }> = []
): void {
    const today = new Date().toISOString().split('T')[0];
    const urls: Array<{
        loc: string;
        lastmod: string;
        changefreq: string;
        priority: string;
    }> = [
        { loc: `${baseUrl}/`, lastmod: today, changefreq: 'weekly', priority: '1.0' },
        { loc: `${baseUrl}/claim-your-spot/`, lastmod: today, changefreq: 'monthly', priority: '0.8' },
        { loc: `${baseUrl}/the-tank/`, lastmod: today, changefreq: 'daily', priority: '0.8' },
        { loc: `${baseUrl}/beta/`, lastmod: today, changefreq: 'monthly', priority: '0.6' },
    ];

    urls.push(...tankUrls);

    // Generate XML sitemap
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(url => `  <url>
    <loc>${escapeXml(url.loc)}</loc>
    <lastmod>${url.lastmod}</lastmod>
    <changefreq>${url.changefreq}</changefreq>
    <priority>${url.priority}</priority>
  </url>`).join('\n')}
</urlset>`;
    
    // Ensure directory exists
    const dir = dirname(outputPath);
    mkdirSync(dir, { recursive: true });
    
    // Write sitemap
    writeFileSync(outputPath, xml, 'utf-8');
    console.log(`✓ Generated sitemap with ${urls.length} URLs: ${outputPath}`);
}

/**
 * Escape XML special characters
 */
function escapeXml(unsafe: string): string {
    return unsafe
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
