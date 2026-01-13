import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { normalizeLeague } from './utils/date-formatter';
import { formatDateISO } from './utils/date-formatter';
import { generateMatchupSlug, generateNarrativeSlug } from './utils/slug-generator';
import { getShortTeamName } from './utils/date-formatter';

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
 * Generate XML sitemap for all published posts
 */
export function generateSitemap(posts: HeatcheckPost[], baseUrl: string = 'https://heatchecks.io', outputPath: string = 'public/sitemap.xml'): void {
    const urls: Array<{
        loc: string;
        lastmod: string;
        changefreq: string;
        priority: string;
    }> = [];
    
    // Add homepage
    urls.push({
        loc: `${baseUrl}/`,
        lastmod: new Date().toISOString().split('T')[0],
        changefreq: 'daily',
        priority: '1.0'
    });
    
    // Add about page
    urls.push({
        loc: `${baseUrl}/about/`,
        lastmod: new Date().toISOString().split('T')[0],
        changefreq: 'monthly',
        priority: '0.8'
    });
    
    // Add DFS hub
    urls.push({
        loc: `${baseUrl}/dfs/`,
        lastmod: new Date().toISOString().split('T')[0],
        changefreq: 'daily',
        priority: '0.9'
    });
    
    // Add archive page
    urls.push({
        loc: `${baseUrl}/archive/`,
        lastmod: new Date().toISOString().split('T')[0],
        changefreq: 'daily',
        priority: '0.6'
    });
    
    // Add league hub pages
    const uniqueLeagues = new Set<string>();
    posts.forEach(post => {
        uniqueLeagues.add(post.league.toUpperCase());
    });
    
    uniqueLeagues.forEach(league => {
        const leagueLower = normalizeLeague(league);
        // Regular league hub
        urls.push({
            loc: `${baseUrl}/${leagueLower}/`,
            lastmod: new Date().toISOString().split('T')[0],
            changefreq: 'daily',
            priority: '0.7'
        });
        // DFS league hub
        urls.push({
            loc: `${baseUrl}/dfs/${leagueLower}/`,
            lastmod: new Date().toISOString().split('T')[0],
            changefreq: 'daily',
            priority: '0.8'
        });
    });
    
    // Get unique dates and add date pages
    const dateMap = new Map<string, string>();
    posts.forEach(post => {
        const date = post.matchupScheduledDate 
            ? formatDateISO(post.matchupScheduledDate)
            : formatDateISO(post.createdAt);
        const league = normalizeLeague(post.league);
        const dateKey = `${league}-${date}`;
        
        if (!dateMap.has(dateKey)) {
            dateMap.set(dateKey, `${baseUrl}/${league}/${date}/`);
            urls.push({
                loc: `${baseUrl}/${league}/${date}/`,
                lastmod: new Date(post.updatedAt || post.createdAt).toISOString().split('T')[0],
                changefreq: 'weekly',
                priority: '0.8'
            });
        }
    });
    
    // Add all article pages
    posts.forEach(post => {
        const league = normalizeLeague(post.league);
        const date = post.matchupScheduledDate 
            ? formatDateISO(post.matchupScheduledDate)
            : formatDateISO(post.createdAt);
        
        let articleUrl: string;
        let priority = '0.8';
        let changefreq = 'monthly';
        
        // Handle DFS articles
        if (post.storyType === 'dfs_article') {
            articleUrl = `${baseUrl}/dfs/${league}/${date}/dfs-value-narratives-${date}/`;
            // DFS articles get higher priority
            priority = '0.9';
            changefreq = 'daily';
        } else {
            // Regular articles
            const storedSlug = post.websiteStory?.seo?.slug || '';
            
            if (storedSlug.includes('/') && storedSlug.split('/').length === 2) {
                // New format: matchup-slug/narrative-slug
                const [matchupSlug, narrativeSlug] = storedSlug.split('/');
                articleUrl = `${baseUrl}/${league}/${date}/${matchupSlug}/${narrativeSlug}/`;
            } else {
                // Fallback: Generate from post data
                const matchupSlug = generateMatchupSlug(post.teamA || '', post.teamB || '', getShortTeamName);
                
                const heatCheckData = post.heatCheckData || {};
                const narratives = heatCheckData.narratives || {};
                const candidateCards = narratives.candidate_cards || [];
                const primaryNarrativeId = narratives.selected?.primary_narrative_id || '';
                const activeCard = candidateCards.find(card => card.narrative_id === primaryNarrativeId);
                const emotionTags = activeCard?.emotion_tags || [];
                
                const narrativeSlug = generateNarrativeSlug(
                    post.websiteStory.headline,
                    post.teamA || '',
                    post.teamB || '',
                    emotionTags
                );
                
                articleUrl = `${baseUrl}/${league}/${date}/${matchupSlug}/${narrativeSlug}/`;
            }
            
            // Determine priority based on recency (recent posts get higher priority)
            const postDate = new Date(post.createdAt);
            const daysSincePost = (Date.now() - postDate.getTime()) / (1000 * 60 * 60 * 24);
            
            if (daysSincePost < 7) {
                priority = '0.9';
                changefreq = 'daily';
            } else if (daysSincePost < 30) {
                priority = '0.8';
                changefreq = 'weekly';
            } else if (daysSincePost < 90) {
                priority = '0.7';
                changefreq = 'monthly';
            }
        }
        
        urls.push({
            loc: articleUrl,
            lastmod: new Date(post.updatedAt || post.createdAt).toISOString().split('T')[0],
            changefreq: changefreq,
            priority: priority
        });
    });
    
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
