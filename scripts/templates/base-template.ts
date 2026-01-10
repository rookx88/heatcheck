import { generateCrawlerNav, extractRecentDates, RecentDate } from '../utils/crawler-nav';
import { escapeHtml } from '../utils/html-escape';

export interface BaseTemplateOptions {
    title: string;
    description: string;
    url: string;
    baseUrl?: string;
    ogImage?: string;
    ogType?: 'website' | 'article';
    articleMeta?: {
        publishedTime?: string;
        modifiedTime?: string;
        author?: string;
        section?: string;
    };
    schemaOrg?: any;
    posts?: any[];
    recentDates?: RecentDate[];
}

/**
 * Generate base HTML template with common structure
 */
export function generateBaseHtml(
    content: string,
    options: BaseTemplateOptions
): string {
    const baseUrl = options.baseUrl || 'https://heatchecks.io';
    const ogImage = options.ogImage || `${baseUrl}/images/default-og-image.jpg`;
    const ogType = options.ogType || 'website';
    
    // Extract recent dates from posts if not provided
    let recentDates = options.recentDates;
    if (!recentDates && options.posts) {
        recentDates = extractRecentDates(options.posts);
    }
    
    // Generate crawler navigation
    const crawlerNav = generateCrawlerNav(recentDates || [], baseUrl);
    
    // Generate Schema.org JSON-LD
    let schemaOrgScript = '';
    if (options.schemaOrg) {
        schemaOrgScript = `<script type="application/ld+json">\n${JSON.stringify(options.schemaOrg, null, 2)}\n</script>`;
    }
    
    // Generate article meta tags
    let articleMetaTags = '';
    if (options.articleMeta) {
        const meta = options.articleMeta;
        if (meta.publishedTime) {
            articleMetaTags += `    <meta property="article:published_time" content="${meta.publishedTime}">\n`;
        }
        if (meta.modifiedTime) {
            articleMetaTags += `    <meta property="article:modified_time" content="${meta.modifiedTime}">\n`;
        }
        if (meta.author) {
            articleMetaTags += `    <meta property="article:author" content="${meta.author}">\n`;
        }
        if (meta.section) {
            articleMetaTags += `    <meta property="article:section" content="${meta.section}">\n`;
        }
    }
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(options.title)}</title>
    <meta name="description" content="${escapeHtml(options.description)}">
    <link rel="canonical" href="${escapeHtml(options.url)}">
    
    <!-- OpenGraph -->
    <meta property="og:title" content="${escapeHtml(options.title)}">
    <meta property="og:description" content="${escapeHtml(options.description)}">
    <meta property="og:image" content="${escapeHtml(ogImage)}">
    <meta property="og:url" content="${escapeHtml(options.url)}">
    <meta property="og:type" content="${ogType}">
    <meta property="og:site_name" content="HeatChecks">
    
    <!-- Favicon -->
    <link rel="icon" type="image/svg+xml" href="/images/LogoFlameHeatChecks.svg">
    
    <!-- Twitter Card -->
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escapeHtml(options.title)}">
    <meta name="twitter:description" content="${escapeHtml(options.description)}">
    <meta name="twitter:image" content="${escapeHtml(ogImage)}">
    
    ${articleMetaTags}${schemaOrgScript ? '\n    ' + schemaOrgScript : ''}
    
    <link rel="stylesheet" href="/assets/public-site.css">
</head>
<body>
    <div class="public-container">
        <div class="top-left">
            <a href="/">
                <img src="/images/HeatChecksMainLogo.svg" alt="HeatChecks" class="header-logo">
            </a>
        </div>
        
        <div class="top-right">
            <img src="/HeatScanButton.svg" alt="Heat Scan" class="heat-radar-label" style="width: 72px; height: auto; margin-bottom: 0.425rem;">
            <button class="heat-radar-toggle">OPEN</button>
            <div class="radar-modal">
                <button class="radar-close-btn">×</button>
                <div class="radar-modal-content" style="display: flex; flex-direction: row; flex: 1; gap: 0.5rem; height: 100%;">
                    <div class="radar-column-left">
                        <div class="radar-initial-state">
                            <div class="radar-title">WHAT IS HEATSCAN?</div>
                            <div class="radar-screen">
                                <div class="radar-grid"></div>
                                <div class="radar-sweep"></div>
                                <button class="scan-games-button">
                                    <span style="margin-right: 0.5rem;">▶</span> SCAN GAMES
                                </button>
                            </div>
                        </div>
                        <div class="radar-loading-state" style="display: none;">
                            <div class="radar-loading-content">
                                <div class="radar-loading-message" id="radar-loading-message">INITIALIZING SCAN...</div>
                                <div class="radar-loading-dots">
                                    <div class="dot"></div>
                                    <div class="dot"></div>
                                    <div class="dot"></div>
                                </div>
                            </div>
                        </div>
                        <div class="radar-results-state" style="display: none;">
                            <div class="radar-date-title" id="radar-left-date"></div>
                            <div class="daily-roundup-games" id="radar-left-games"></div>
                        </div>
                    </div>
                    <div class="radar-column-right">
                        <div class="radar-description-state">
                            <div class="radar-title">HEAT INTELLIGENCE SCAN</div>
                            <div class="radar-blurb">
                                Find matchups today with Heat Intelligence. Scan published content to discover high-intensity games with narrative momentum, revenge factors, and psychological pressure indicators.
                            </div>
                        </div>
                        <div class="radar-loading-description" style="display: none;">
                            <div class="radar-title">SCANNING...</div>
                            <div class="radar-blurb" id="radar-loading-description">
                                Processing matchups and applying HeatScan intelligence algorithms...
                            </div>
                        </div>
                        <div class="radar-results-description" style="display: none;">
                            <div class="radar-date-title" id="radar-right-date"></div>
                            <div class="daily-roundup-games" id="radar-right-games"></div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        
        <div class="bottom-left">
            ${crawlerNav}
        </div>
        
        <div class="bottom-right">
            ${content}
        </div>
    </div>
    ${options.posts && options.posts.length > 0 ? `
    <script type="application/json" id="posts-data">${JSON.stringify(options.posts)}</script>
    ` : ''}
    <script src="/assets/static-site.js"></script>
</body>
</html>`;
}
