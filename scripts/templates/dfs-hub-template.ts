import { generateBaseHtml, BaseTemplateOptions } from './base-template';
import { escapeHtml } from '../utils/html-escape';
import { formatDateForCard, formatDateISO, normalizeLeague } from '../utils/date-formatter';

export interface DFSHeatcheckPost {
    id: string;
    league: string;
    teamA: string;
    teamB: string;
    matchupScheduledDate?: string;
    createdAt: string;
    updatedAt?: string;
    websiteStory: {
        headline: string;
        dek: string;
        seo: {
            slug: string;
        };
        image?: string;
        imageUrl?: string;
    };
    heatCheckData?: any;
    storyType?: string;
}

/**
 * Generate post card HTML for DFS articles
 */
function generateDFSPostCard(post: DFSHeatcheckPost, baseUrl: string): string {
    const dateStr = formatDateForCard(post.matchupScheduledDate || post.createdAt);
    const league = (post.league || '').toUpperCase();
    
    // For DFS articles, recalculate headline based on matchupScheduledDate to match homepage format
    let headline = post.websiteStory?.headline || 'Untitled';
    const articleDate = post.matchupScheduledDate || post.createdAt;
    try {
        const dateForDayOfWeek = new Date(articleDate + (articleDate.includes('T') ? '' : 'T12:00:00'));
        const dayOfWeek = dateForDayOfWeek.toLocaleDateString('en-US', { weekday: 'long' });
        // Ensure league is in correct format (NBA, NFL, etc.)
        const normalizedLeague = league.toUpperCase();
        headline = `${dayOfWeek} ${normalizedLeague} DFS`;
    } catch {
        // Keep original headline if date parsing fails
    }
    const imageName = post.websiteStory?.image || post.websiteStory?.imageUrl || '';
    const imagePath = imageName 
        ? (imageName.startsWith('http') 
            ? imageName 
            : imageName.startsWith('/')
            ? (imageName.includes('/assets/images/')
                ? (() => {
                    const parts = imageName.split('/assets/images/');
                    const filename = parts.length > 1 ? parts[parts.length - 1] : imageName.split('/').pop();
                    return `/assets/images/${filename}`;
                })()
                : imageName)
            : imageName.includes('/assets/images/')
            ? (() => {
                const parts = imageName.split('/assets/images/');
                const filename = parts.length > 1 ? parts[parts.length - 1] : imageName.split('/').pop();
                return `/assets/images/${filename}`;
            })()
            : `/assets/images/${imageName}`)
        : '';
    const leagueLower = normalizeLeague(post.league);
    const date = post.matchupScheduledDate 
        ? formatDateISO(post.matchupScheduledDate)
        : formatDateISO(post.createdAt);
    
    // DFS article URL structure: /dfs/{league}/{date}/dfs-value-narratives-{date}/
    const articleUrl = `/dfs/${leagueLower}/${date}/dfs-value-narratives-${date}/`;
    
    // Special quote text for DFS articles
    const displayQuote = "Take a deeper look at narratives on key value players for today's slate";
    
    const quoteHtml = `
        <div style="margin: 0 0 1rem 0; padding: 0.75rem; background: rgba(0, 0, 0, 0.4); border-left: 3px solid rgba(248, 66, 66, 0.6); border-radius: 2px; font-family: 'Courier New', monospace;">
            <p style="font-size: 0.7rem; line-height: 1.4; color: rgba(255, 255, 255, 0.85); font-style: italic; margin: 0; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; text-overflow: ellipsis;">
                "${escapeHtml(displayQuote)}"
            </p>
        </div>
    `;
    
    return `
        <div class="post-card" data-post-id="${post.id}">
            <div style="display: flex; flex-direction: column; flex: 1; min-height: 0; width: 100%; box-sizing: border-box; overflow: hidden;">
                <div style="padding: 0.3rem 0.5rem; background: rgba(0, 0, 0, 0.5); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); border: 1px solid rgba(255, 255, 255, 0.35); margin-bottom: 0.75rem; text-align: center; display: flex; align-items: center; justify-content: space-between; gap: 0.4rem; width: 100%; box-sizing: border-box; overflow: hidden; border-radius: 4px;">
                    <div style="width: 50px; height: 50px; min-width: 50px; border-radius: 50%; border: 2px solid #fff; background: #fff; box-shadow: 0 2px 8px rgba(255, 255, 255, 0.5), 0 0 12px rgba(255, 255, 255, 0.3); display: flex; align-items: center; justify-content: center; flex-shrink: 0; box-sizing: border-box;">
                        <div style="color: #000; font-size: 0.85rem; font-family: 'Arial Black', 'Impact', 'Franklin Gothic Bold', 'Helvetica Neue', Arial, sans-serif; font-weight: 900; line-height: 1; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${dateStr}</div>
                    </div>
                    <div style="color: #fff; font-size: 0.85rem; font-family: 'Arial Black', 'Impact', 'Franklin Gothic Bold', 'Helvetica Neue', Arial, sans-serif; font-weight: 900; text-transform: uppercase; letter-spacing: 0.08em; flex: 1; min-width: 0; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-sizing: border-box; -webkit-text-stroke: 1px #000000; text-stroke: 1px #000000;">DFS VALUE</div>
                    <div style="width: 40px; height: 40px; min-width: 40px; border-radius: 50%; border: 2px solid #fff; background: rgba(255, 255, 255, 0.1); box-shadow: 0 2px 8px rgba(255, 255, 255, 0.3), 0 0 12px rgba(255, 255, 255, 0.2); display: flex; align-items: center; justify-content: center; flex-shrink: 0; box-sizing: border-box;">
                        <div style="color: #fff; font-size: 0.75rem; font-family: 'Arial Black', 'Impact', 'Franklin Gothic Bold', 'Helvetica Neue', Arial, sans-serif; font-weight: 900; line-height: 1; text-align: center; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; -webkit-text-stroke: 1px #000000; text-stroke: 1px #000000;">${league}</div>
                    </div>
                </div>
                <div style="display: flex; gap: 0.5rem; margin-bottom: 0.75rem; align-items: center; justify-content: flex-start; position: relative; width: 100%; box-sizing: border-box;">
                    <div style="width: 85px; height: 85px; min-width: 85px; border: 2px solid #00ff41; border-radius: 50%; background: rgba(0, 0, 0, 0.5); display: flex; align-items: center; justify-content: center; flex-shrink: 0; position: relative; box-shadow: inset 0 0 20px #00ff4140, 0 0 15px #00ff4160; overflow: hidden;">
                        <div style="color: #00ff41; font-size: 1.2rem; font-weight: 900; -webkit-text-stroke: 2px #000000; text-stroke: 2px #000000; font-family: 'Arial Black', 'Impact', 'Franklin Gothic Bold', 'Helvetica Neue', Arial, sans-serif; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; letter-spacing: 0.5px; z-index: 1; position: relative;">DFS</div>
                    </div>
                    <div class="post-card-image-container" data-post-id="${post.id}" style="flex: 1; height: 130px; min-width: 0; position: relative; overflow: hidden; box-sizing: border-box;">
                        ${imagePath ? `<img src="${imagePath}" alt="${escapeHtml(`${headline} - HeatChecks DFS Analysis`)}" style="width: 100%; height: 100%; object-fit: contain; object-position: center; border-radius: 4px; display: block;">` : '<div style="width: 100%; height: 100%; background: rgba(255, 255, 255, 0.1); border-radius: 4px; display: flex; align-items: center; justify-content: center; color: rgba(255, 255, 255, 0.5); font-size: 0.75rem;">No Image</div>'}
                    </div>
                </div>
                <h2 style="font-size: 0.9rem; line-height: 1.2; margin: 0 0 1rem 0; padding: 0; color: #fff; font-family: 'Arial Black', 'Impact', 'Franklin Gothic Bold', 'Helvetica Neue', Arial, sans-serif; font-weight: 900; text-align: center; min-height: 2.2em; max-height: 3.2em; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; width: 100%; box-sizing: border-box; word-wrap: break-word; -webkit-text-stroke: 1px #000000; text-stroke: 1px #000000;">${escapeHtml(headline)}</h2>
                ${quoteHtml}
                <a href="${articleUrl}" style="margin-top: 0; margin-bottom: 0; font-size: 0.7rem; padding: 0.4rem 0.8rem; background: #000; border: 2px solid rgba(0, 255, 65, 0.6); color: #fff; cursor: pointer; text-transform: uppercase; font-family: 'Arial Black', 'Impact', 'Franklin Gothic Bold', 'Helvetica Neue', Arial, sans-serif; font-weight: 900; letter-spacing: 0.08em; transition: all 0.3s ease; width: 100%; box-sizing: border-box; text-decoration: none; display: block; text-align: center; box-shadow: 0 0 10px rgba(0, 255, 65, 0.3), 0 0 20px rgba(0, 255, 65, 0.1);" onmouseover="this.style.borderColor='rgba(0, 255, 65, 0.8)'; this.style.boxShadow='0 0 15px rgba(0, 255, 65, 0.5), 0 0 30px rgba(0, 255, 65, 0.2)';" onmouseout="this.style.borderColor='rgba(0, 255, 65, 0.6)'; this.style.boxShadow='0 0 10px rgba(0, 255, 65, 0.3), 0 0 20px rgba(0, 255, 65, 0.1)';">VIEW STORY</a>
            </div>
        </div>
    `;
}

/**
 * Generate DFS hub page HTML
 */
export function generateDFSHubPage(
    posts: DFSHeatcheckPost[],
    baseUrl: string = 'https://heatchecks.io'
): string {
    // Sort posts by date (newest first)
    const sortedPosts = [...posts].sort((a, b) => {
        const dateA = a.matchupScheduledDate || a.createdAt;
        const dateB = b.matchupScheduledDate || b.createdAt;
        return new Date(dateB).getTime() - new Date(dateA).getTime();
    });

    let bodyContent = `<div class="content-area-title">▶ DFS VALUE NARRATIVES</div>`;
    bodyContent += `<div class="post-list" id="dfs-posts-list">`;
    
    if (sortedPosts.length === 0) {
        bodyContent += `<p style="color: rgba(255, 255, 255, 0.7); font-size: 1rem; font-weight: 900;">NO DFS ARTICLES YET</p>`;
    } else {
        for (const post of sortedPosts) {
            bodyContent += generateDFSPostCard(post, baseUrl);
        }
    }
    
    bodyContent += `</div>`;
    
    // Embed posts data for JavaScript
    const postsJson = JSON.stringify(sortedPosts.map(post => ({
        id: post.id,
        league: post.league,
        teamA: post.teamA,
        teamB: post.teamB,
        matchupScheduledDate: post.matchupScheduledDate,
        updatedAt: post.updatedAt || post.createdAt,
        createdAt: post.createdAt,
        websiteStory: {
            slug: post.websiteStory.seo.slug,
            headline: post.websiteStory.headline,
            imageUrl: post.websiteStory.imageUrl,
            image: post.websiteStory.image
        },
        heatCheckData: post.heatCheckData,
        storyType: post.storyType
    })));
    
    bodyContent += `<script>window.PUBLISHED_POSTS = ${postsJson};</script>`;
    
    // Generate CollectionPage schema
    const collectionPageSchema = {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        "name": "DFS Value Narratives Hub",
        "description": "Daily Fantasy Sports value plays with narrative angles and strategic insights for NBA and NFL slates.",
        "url": `${baseUrl}/dfs/`,
        "numberOfItems": sortedPosts.length,
        "mainEntity": sortedPosts.length > 0 ? {
            "@type": "ItemList",
            "itemListElement": sortedPosts.slice(0, 10).map((post, index) => ({
                "@type": "ListItem",
                "position": index + 1,
                "item": {
                    "@type": "Article",
                    "headline": post.websiteStory.headline,
                    "url": `/dfs/${normalizeLeague(post.league)}/${post.matchupScheduledDate ? formatDateISO(post.matchupScheduledDate) : formatDateISO(post.createdAt)}/dfs-value-narratives-${post.matchupScheduledDate ? formatDateISO(post.matchupScheduledDate) : formatDateISO(post.createdAt)}/`
                }
            }))
        } : undefined
    };
    
    // Generate breadcrumb schema
    const breadcrumbSchema = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {
                "@type": "ListItem",
                "position": 1,
                "name": "Home",
                "item": `${baseUrl}/`
            },
            {
                "@type": "ListItem",
                "position": 2,
                "name": "DFS",
                "item": `${baseUrl}/dfs/`
            }
        ]
    };
    
    const keywords = 'DFS picks, daily fantasy sports, DFS value plays, DFS lineup, DFS strategy, NBA DFS, NFL DFS, DFS sleepers, DFS cash game, DFS tournament';
    
    return generateBaseHtml(bodyContent, {
        title: 'DFS Value Narratives | Daily Fantasy Sports Analysis | HeatChecks',
        description: 'Daily Fantasy Sports value plays with narrative angles and strategic insights for NBA and NFL slates. Expert DFS picks, lineups, and strategy.',
        url: `${baseUrl}/dfs/`,
        baseUrl,
        keywords: keywords,
        schemaOrg: [collectionPageSchema, breadcrumbSchema],
        posts: sortedPosts
    });
}

