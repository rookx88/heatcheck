import { generateBaseHtml, BaseTemplateOptions } from './base-template';
import { escapeHtml } from '../utils/html-escape';
import { formatDateForCard, formatDateISO, normalizeLeague } from '../utils/date-formatter';
import { generatePostCard } from './league-hub-template';

export interface HeatPicksHeatcheckPost {
    id: string;
    league: string;
    teamA?: string;
    teamB?: string;
    matchupScheduledDate?: string;
    createdAt: string;
    updatedAt?: string;
    websiteStory: {
        headline: string;
        dek?: string;
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
 * Generate Heat Picks hub page HTML
 */
export function generateHeatPicksHubPage(
    posts: HeatPicksHeatcheckPost[],
    baseUrl: string = 'https://heatchecks.io'
): string {
    // Sort posts by date (newest first)
    const sortedPosts = [...posts].sort((a, b) => {
        const dateA = a.matchupScheduledDate || a.createdAt;
        const dateB = b.matchupScheduledDate || b.createdAt;
        return new Date(dateB).getTime() - new Date(dateA).getTime();
    });

    let bodyContent = `<div class="content-area-title">▶ HEAT PICKS</div>`;
    bodyContent += `<div class="post-list" id="heat-picks-posts-list">`;
    
    if (sortedPosts.length === 0) {
        bodyContent += `<p style="color: rgba(255, 255, 255, 0.7); font-size: 1rem; font-weight: 900;">NO HEAT PICKS YET</p>`;
    } else {
        for (const post of sortedPosts) {
            bodyContent += generatePostCard(post as any, baseUrl);
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
        "name": "Heat Picks Hub",
        "description": "Data-driven betting picks with narrative verification, market lag detection, and visual evidence. The hottest plays across NBA, NFL, EPL, and Bundesliga.",
        "url": `${baseUrl}/heat-picks/`,
        "numberOfItems": sortedPosts.length,
        "mainEntity": sortedPosts.length > 0 ? {
            "@type": "ItemList",
            "itemListElement": sortedPosts.slice(0, 10).map((post, index) => {
                const date = post.matchupScheduledDate 
                    ? formatDateISO(post.matchupScheduledDate)
                    : formatDateISO(post.createdAt);
                const storedSlug = post.websiteStory?.seo?.slug || '';
                let articleUrl: string;
                if (storedSlug) {
                    articleUrl = `/${normalizeLeague(post.league)}/${storedSlug}/`;
                } else {
                    const dateParts = date.split('-');
                    const slugDate = `${dateParts[1]}-${dateParts[2]}-${dateParts[0]}`;
                    articleUrl = `/${normalizeLeague(post.league)}/heat-picks-today-${slugDate}/`;
                }
                
                return {
                    "@type": "ListItem",
                    "position": index + 1,
                    "item": {
                        "@type": "Article",
                        "headline": post.websiteStory.headline,
                        "url": articleUrl
                    }
                };
            })
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
                "name": "Heat Picks",
                "item": `${baseUrl}/heat-picks/`
            }
        ]
    };
    
    const keywords = 'heat picks, betting picks, sports betting, NBA picks, NFL picks, EPL picks, Bundesliga picks, data-driven picks, betting analysis, sports predictions';
    
    return generateBaseHtml(bodyContent, {
        title: 'Heat Picks | Data-Driven Betting Picks | HeatChecks',
        description: 'Data-driven betting picks with narrative verification, market lag detection, and visual evidence. The hottest plays across NBA, NFL, EPL, and Bundesliga.',
        url: `${baseUrl}/heat-picks/`,
        baseUrl,
        keywords: keywords,
        schemaOrg: [collectionPageSchema, breadcrumbSchema],
        posts: sortedPosts
    });
}

