import { generateCrawlerNav, RecentDate } from '../utils/crawler-nav';
import { escapeHtml } from '../utils/html-escape';
import { generateBaseHtml } from './base-template';
import { generatePostCard } from './index-template';

interface HeatcheckPost {
    id: string;
    createdAt: string;
    updatedAt: string;
    league: string;
    teamA: string;
    teamB: string;
    websiteStory: {
        headline: string;
        dek: string;
        imageUrl?: string;
        seo: {
            slug: string;
            metaTitle: string;
            metaDescription: string;
        };
    };
    matchupScheduledDate?: string;
    heatCheckData?: any;
    heatchecksEdge?: any;
    storyType?: any;
}

/**
 * Generate About Us page HTML
 * Uses the same card generation logic as the homepage
 */
export function generateAboutPage(
    posts: HeatcheckPost[],
    recentDates: RecentDate[],
    baseUrl: string = 'https://heatchecks.com'
): string {
    const crawlerNav = generateCrawlerNav(recentDates);
    
    // Get most recent 6 posts (same as homepage)
    const postsPerPage = 6;
    const page = 1;
    const startIdx = (page - 1) * postsPerPage;
    const endIdx = startIdx + postsPerPage;
    const latestPosts = posts.slice(startIdx, endIdx);
    
    let bodyContent = `<div class="content-area-title terminal-style"><span class="content-title-text"><span class="glitch-text" data-text="RECENT.LOGS">RECENT.LOGS</span></span><a href="https://x.com/heatchecksio" target="_blank" rel="noopener noreferrer" aria-label="Follow HeatChecks on X (Twitter)" class="twitter-icon-link"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg></a></div>`;
    bodyContent += `<div class="post-list" id="recent-logs-list">`;
    
    if (latestPosts.length === 0) {
        bodyContent += `<p style="color: rgba(255, 255, 255, 0.7); font-size: 1rem; font-weight: 900;">NO ENTRIES YET</p>`;
    } else {
        for (const post of latestPosts) {
            bodyContent += generatePostCard(post, baseUrl);
        }
    }
    
    bodyContent += `</div></div>`;
    
    // Embed posts data for JavaScript (same format as homepage)
    const postsJson = JSON.stringify(posts.map(post => ({
        id: post.id,
        league: post.league,
        teamA: post.teamA,
        teamB: post.teamB,
        matchupScheduledDate: post.matchupScheduledDate,
        updatedAt: post.updatedAt,
        createdAt: post.createdAt,
        websiteStory: {
            slug: post.websiteStory.seo.slug,
            headline: post.websiteStory.headline,
            imageUrl: post.websiteStory.imageUrl
        },
        heatCheckData: post.heatCheckData,
        heatchecksEdge: post.heatchecksEdge,
        storyType: post.storyType,
        websiteStory: post.websiteStory
    })));
    
    bodyContent += `<script>window.PUBLISHED_POSTS = ${postsJson}; window.RECENT_LOGS_PAGINATION = { currentPage: ${page}, totalPages: ${Math.ceil(posts.length / postsPerPage)}, postsPerPage: ${postsPerPage} };</script>`;
    
    return generateBaseHtml({
        title: 'About Us | HeatChecks',
        description: 'Emotional Intelligence for Sports. HeatChecks measures emotion, revenge, rivalry, and narrative momentum in sports matchups.',
        canonicalUrl: `${baseUrl}/about/`,
        ogType: 'website',
        bodyContent,
        crawlerNav,
        baseUrl,
    });
}

