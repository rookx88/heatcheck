import { generateCrawlerNav, extractRecentDates, RecentDate } from '../utils/crawler-nav';
import { escapeHtml } from '../utils/html-escape';

export interface BaseTemplateOptions {
    title: string;
    description: string;
    url: string;
    baseUrl?: string;
    ogImage?: string;
    ogImageAlt?: string;
    ogType?: 'website' | 'article';
    articleMeta?: {
        publishedTime?: string;
        modifiedTime?: string;
        author?: string;
        section?: string;
        tags?: string[];
    };
    schemaOrg?: any;
    posts?: any[];
    recentDates?: RecentDate[];
    keywords?: string;
    robots?: string;
    twitterSite?: string;
    twitterCreator?: string;
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
        // Handle both array and single object
        const schemaData = Array.isArray(options.schemaOrg) ? options.schemaOrg : [options.schemaOrg];
        if (schemaData.length === 1) {
            schemaOrgScript = `<script type="application/ld+json">\n${JSON.stringify(schemaData[0], null, 2)}\n</script>`;
        } else {
            // Multiple schemas - wrap in array
            schemaOrgScript = `<script type="application/ld+json">\n${JSON.stringify(schemaData, null, 2)}\n</script>`;
        }
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
        // Add article tags for OpenGraph
        if (meta.tags && meta.tags.length > 0) {
            meta.tags.forEach(tag => {
                articleMetaTags += `    <meta property="article:tag" content="${escapeHtml(tag)}">\n`;
            });
        }
    }
    
    // Generate meta keywords (for legacy support)
    let keywordsTag = '';
    if (options.keywords) {
        keywordsTag = `    <meta name="keywords" content="${escapeHtml(options.keywords)}">\n`;
    }
    
    // Generate robots meta tag
    let robotsTag = '';
    if (options.robots) {
        robotsTag = `    <meta name="robots" content="${escapeHtml(options.robots)}">\n`;
    }
    
    // Generate og:image:alt tag
    let ogImageAltTag = '';
    if (options.ogImageAlt) {
        ogImageAltTag = `    <meta property="og:image:alt" content="${escapeHtml(options.ogImageAlt)}">\n`;
    }
    
    // Generate Twitter meta tags
    let twitterSiteTag = '';
    let twitterCreatorTag = '';
    if (options.twitterSite) {
        twitterSiteTag = `    <meta name="twitter:site" content="${escapeHtml(options.twitterSite)}">\n`;
    }
    if (options.twitterCreator) {
        twitterCreatorTag = `    <meta name="twitter:creator" content="${escapeHtml(options.twitterCreator)}">\n`;
    }
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(options.title)}</title>
    <meta name="description" content="${escapeHtml(options.description)}">
    ${keywordsTag}${robotsTag}    <link rel="canonical" href="${escapeHtml(options.url)}">
    
    <!-- OpenGraph -->
    <meta property="og:title" content="${escapeHtml(options.title)}">
    <meta property="og:description" content="${escapeHtml(options.description)}">
    <meta property="og:image" content="${escapeHtml(ogImage)}">
    ${ogImageAltTag}    <meta property="og:url" content="${escapeHtml(options.url)}">
    <meta property="og:type" content="${ogType}">
    <meta property="og:site_name" content="HeatChecks">
    
    <!-- Favicon -->
    <link rel="icon" type="image/svg+xml" href="/images/LogoFlameHeatChecks.svg">
    
    <!-- Twitter Card -->
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escapeHtml(options.title)}">
    <meta name="twitter:description" content="${escapeHtml(options.description)}">
    <meta name="twitter:image" content="${escapeHtml(ogImage)}">
    ${twitterSiteTag}${twitterCreatorTag}    
    ${articleMetaTags}${schemaOrgScript ? '\n    ' + schemaOrgScript : ''}
    
    <link rel="stylesheet" href="/assets/public-site.css">
</head>
<body>
    <!-- Mobile Hamburger Menu Toggle -->
    <button class="mobile-menu-toggle" id="mobile-menu-toggle" aria-label="Toggle navigation menu">
        <span></span>
        <span></span>
        <span></span>
    </button>
    
    <!-- Mobile Twitter Icon - Fixed position under hamburger -->
    <a href="https://x.com/heatchecksio" target="_blank" rel="noopener noreferrer" aria-label="Follow HeatChecks on X (Twitter)" class="mobile-twitter-icon" id="mobile-twitter-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
        </svg>
    </a>
    
    <!-- Mobile Navigation Overlay -->
    <div class="mobile-nav-overlay" id="mobile-nav-overlay"></div>
    
    <!-- Mobile Navigation Drawer -->
    <nav class="mobile-nav-drawer" id="mobile-nav-drawer">
        <!-- Mobile HeatScan Button - Main Attraction at Top -->
        <div style="padding: 1.5rem 0.75rem; border-bottom: 2px solid rgba(0, 255, 65, 0.4); margin-bottom: 1rem; background: rgba(0, 255, 65, 0.05);">
            <button class="mobile-heatscan-button" id="mobile-heatscan-button" style="background: transparent; border: none; padding: 0; cursor: pointer; display: flex; align-items: center; gap: 1rem; width: 100%;">
                <img src="/HeatScanButton.svg" alt="Heat Scan" style="width: 70px; height: auto;">
                <span style="color: #00ff41; font-family: 'Courier New', monospace; font-size: 1.1rem; font-weight: bold; text-transform: uppercase; letter-spacing: 0.1em; text-shadow: 0 0 10px rgba(0, 255, 65, 0.5);">SCAN GAMES</span>
            </button>
        </div>
        
        ${crawlerNav}
        
        <div style="margin-top: auto; padding: 2rem 1rem 1rem 1rem; border-top: 1px solid rgba(0, 255, 65, 0.2); display: flex; justify-content: center; align-items: center;">
            <a href="/" style="display: block;">
                <img src="/assets/images/HeatchecksMobileLogo.png" alt="HeatChecks" style="height: 60px; width: auto; opacity: 0.9;" onmouseover="this.style.opacity='1';" onmouseout="this.style.opacity='0.9';">
            </a>
        </div>
    </nav>
    
    <!-- Mobile Radar Modal -->
    <div class="mobile-radar-modal" id="mobile-radar-modal">
        <div class="mobile-radar-overlay" id="mobile-radar-overlay"></div>
        <div class="mobile-radar-content">
            <button class="mobile-radar-close-btn" id="mobile-radar-close-btn">×</button>
            <div class="mobile-radar-header">
                <div class="mobile-radar-title" style="display: flex; align-items: center; justify-content: center;">
                    <img src="/HeatScanButton.svg" alt="HeatScan" style="height: 60px; width: auto; filter: drop-shadow(0 0 10px rgba(0, 255, 65, 0.5));">
                </div>
            </div>
            <div class="mobile-radar-body">
                <div class="mobile-radar-initial-state" id="mobile-radar-initial-state">
                    <div class="mobile-radar-screen">
                        <div class="mobile-radar-grid"></div>
                        <div class="mobile-radar-sweep"></div>
                        <button class="mobile-scan-games-button" id="mobile-scan-games-button">
                            <span style="margin-right: 0.5rem;">▶</span> SCAN GAMES
                        </button>
                    </div>
                </div>
                <div class="mobile-radar-loading-state" id="mobile-radar-loading-state" style="display: none;">
                    <div class="mobile-radar-loading-content">
                        <div class="mobile-radar-loading-message" id="mobile-radar-loading-message">INITIALIZING SCAN...</div>
                        <div class="mobile-radar-loading-dots">
                            <div class="dot"></div>
                            <div class="dot"></div>
                            <div class="dot"></div>
                        </div>
                    </div>
                </div>
                <div class="mobile-radar-results-state" id="mobile-radar-results-state" style="display: none;">
                    <div class="mobile-radar-date-title" id="mobile-radar-date-title"></div>
                    <div class="mobile-radar-games" id="mobile-radar-games"></div>
                </div>
            </div>
        </div>
    </div>
    
    <!-- Glass Display Overlay (Mobile Only) -->
    <div class="glass-display-overlay" id="glass-display-overlay"></div>
    
    <div class="public-container">
        <div class="top-left">
            <a href="/">
                <img src="/images/HeatChecksMainLogo.svg" alt="HeatChecks" class="header-logo desktop-logo">
                <img src="/assets/images/HeatchecksMobileLogo.png" alt="HeatChecks" class="header-logo mobile-logo">
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
    ${(() => {
        try {
            if (options.posts && options.posts.length > 0) {
                return `<script type="application/json" id="posts-data">${JSON.stringify(options.posts)}</script>`;
            } else {
                return '<script type="application/json" id="posts-data">[]</script>';
            }
        } catch (error) {
            console.error('Error serializing posts for homepage:', error);
            return '<script type="application/json" id="posts-data">[]</script>';
        }
    })()}
    <script src="/assets/static-site.js" defer></script>
</body>
</html>`;
}
