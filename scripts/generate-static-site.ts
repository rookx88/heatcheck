import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { generateArticlePage } from './templates/article-template';
import { generateArchivePage } from './templates/archive-template';
import { generateLeagueHubPage } from './templates/league-hub-template';
import { generateDatePage } from './templates/date-page-template';
import { generateDFSArticlePage } from './templates/dfs-article-template';
import { generateDFSHubPage } from './templates/dfs-hub-template';
import { generateBaseHtml } from './templates/base-template';
import { formatDateISO, normalizeLeague } from './utils/date-formatter';
import { generateSlug, ensureUniqueSlug, generateNarrativeSlug, generateMatchupSlug } from './utils/slug-generator';
import { getShortTeamName } from './utils/date-formatter';
import { generateSitemap } from './sitemap';
import { generateRedirectsFile } from './generate-redirects';
import dotenv from 'dotenv';

// Load environment variables from .env.local only in local development
// Cloudflare Pages sets environment variables directly, so dotenv is not needed there
// Only try to load .env.local if DATABASE_URL is not already set (production environments)
if (!process.env.DATABASE_URL && !process.env.CI) {
    try {
        dotenv.config({ path: '.env.local' });
    } catch (err) {
        // Silently ignore if .env.local doesn't exist (normal in production)
    }
}

interface HeatcheckPost {
    id: string;
    league: string;
    teamA: string;
    teamB: string;
    matchupScheduledDate?: string;
    createdAt: string;
    updatedAt: string;
    websiteStory: {
        headline: string;
        dek: string;
        theBackstory: string;
        seo: {
            slug: string;
            metaTitle: string;
            metaDescription: string;
        };
        image?: string;
        imageUrl?: string;
    };
    heatCheckData?: any;
    heatchecksEdge?: any;
    storyType?: string;
    status?: string;
}

const baseUrl = process.env.BASE_URL || 'https://heatchecks.io';
const distDir = path.join(process.cwd(), 'dist');
const publicDir = path.join(process.cwd(), 'public');
const assetsImagesDir = path.join(process.cwd(), 'assets', 'images');
const distImagesDir = path.join(distDir, 'assets', 'images');
const publicImagesDir = path.join(publicDir, 'assets', 'images');

/**
 * Ensure directory exists
 */
function ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

/**
 * Copy images from assets/images to dist/assets/images and public/assets/images
 */
function copyImages(): void {
    if (!fs.existsSync(assetsImagesDir)) {
        console.log('⚠ No assets/images directory found, skipping image copy');
        return;
    }
    
    const imageFiles = fs.readdirSync(assetsImagesDir);
    
    // Copy to dist
    ensureDir(distImagesDir);
    for (const file of imageFiles) {
        const src = path.join(assetsImagesDir, file);
        const dest = path.join(distImagesDir, file);
        if (fs.statSync(src).isFile()) {
            fs.copyFileSync(src, dest);
        }
    }
    console.log(`✓ Copied ${imageFiles.length} image(s) to dist/assets/images`);
    
    // Copy to public
    ensureDir(publicImagesDir);
    for (const file of imageFiles) {
        const src = path.join(assetsImagesDir, file);
        const dest = path.join(publicImagesDir, file);
        if (fs.statSync(src).isFile()) {
            fs.copyFileSync(src, dest);
        }
    }
    console.log(`✓ Copied ${imageFiles.length} image(s) to public/assets/images`);
}

/**
 * Copy CSS and JS assets to dist/assets for production hosting
 */
function copyAssets(): void {
    const publicAssetsDir = path.join(publicDir, 'assets');
    const distAssetsDir = path.join(distDir, 'assets');
    
    // Ensure dist/assets directory exists
    ensureDir(distAssetsDir);
    
    // Copy static-site.js
    const staticSiteJs = path.join(publicAssetsDir, 'static-site.js');
    if (fs.existsSync(staticSiteJs)) {
        const dest = path.join(distAssetsDir, 'static-site.js');
        fs.copyFileSync(staticSiteJs, dest);
        console.log('✓ Copied static-site.js to dist/assets/');
    }
    
    // Copy public-site.css
    const publicSiteCss = path.join(publicAssetsDir, 'public-site.css');
    if (fs.existsSync(publicSiteCss)) {
        const dest = path.join(distAssetsDir, 'public-site.css');
        fs.copyFileSync(publicSiteCss, dest);
        console.log('✓ Copied public-site.css to dist/assets/');
    }
}

/**
 * Copy public assets (images, SVGs) to dist/ for production hosting
 */
function copyPublicAssets(): void {
    // Copy images from public/images to dist/images
    const publicImagesDir = path.join(publicDir, 'images');
    const distImagesDir = path.join(distDir, 'images');
    
    if (fs.existsSync(publicImagesDir)) {
        ensureDir(distImagesDir);
        const imageFiles = fs.readdirSync(publicImagesDir);
        for (const file of imageFiles) {
            const src = path.join(publicImagesDir, file);
            const dest = path.join(distImagesDir, file);
            if (fs.statSync(src).isFile()) {
                fs.copyFileSync(src, dest);
            }
        }
        console.log(`✓ Copied ${imageFiles.length} image(s) from public/images to dist/images`);
    }
    
    // Copy HeatScanButton.svg and other root-level assets from public/ to dist/
    const rootAssets = ['HeatScanButton.svg'];
    for (const asset of rootAssets) {
        const src = path.join(publicDir, asset);
        if (fs.existsSync(src)) {
            const dest = path.join(distDir, asset);
            fs.copyFileSync(src, dest);
            console.log(`✓ Copied ${asset} to dist/`);
        }
    }
}

/**
 * Copy Cloudflare Pages configuration files (_headers, _redirects) to dist/
 */
function copyConfigFiles(): void {
    // Copy _headers
    const headersSource = path.join(publicDir, '_headers');
    if (fs.existsSync(headersSource)) {
        const headersDest = path.join(distDir, '_headers');
        fs.copyFileSync(headersSource, headersDest);
        console.log('✓ Copied _headers to dist/');
    }
    
    // Copy _redirects
    const redirectsSource = path.join(publicDir, '_redirects');
    if (fs.existsSync(redirectsSource)) {
        const redirectsDest = path.join(distDir, '_redirects');
        fs.copyFileSync(redirectsSource, redirectsDest);
        console.log('✓ Copied _redirects to dist/');
    }
}

/**
 * Write HTML file to both dist and public (for dev server access)
 */
function writeHtmlFile(relativePath: string, html: string): void {
    // Write to dist (for production)
    const distPath = path.join(distDir, relativePath);
    ensureDir(path.dirname(distPath));
    fs.writeFileSync(distPath, html, 'utf-8');
    console.log(`✓ Generated: ${distPath}`);
    
    // Also write to public (for dev server access during development)
    // Only write if path is not already in public (avoid overwriting preview.html and assets)
    if (!relativePath.startsWith('preview.html') && !relativePath.startsWith('assets/') && !relativePath.startsWith('images/')) {
        const publicPath = path.join(publicDir, relativePath);
        ensureDir(path.dirname(publicPath));
        fs.writeFileSync(publicPath, html, 'utf-8');
    }
}

/**
 * Get related posts for an article
 */
function getRelatedPosts(post: HeatcheckPost, allPosts: HeatcheckPost[], limit: number = 3): HeatcheckPost[] {
    const league = normalizeLeague(post.league);
    const date = post.matchupScheduledDate 
        ? formatDateISO(post.matchupScheduledDate)
        : formatDateISO(post.createdAt);
    
    // Find posts from same league and date, excluding current post
    const related = allPosts
        .filter(p => {
            if (p.id === post.id) return false;
            const pLeague = normalizeLeague(p.league);
            const pDate = p.matchupScheduledDate 
                ? formatDateISO(p.matchupScheduledDate)
                : formatDateISO(p.createdAt);
            return pLeague === league && pDate === date;
        })
        .slice(0, limit);
    
    // If not enough from same date, add from same league
    if (related.length < limit) {
        const additional = allPosts
            .filter(p => {
                if (p.id === post.id || related.some(r => r.id === p.id)) return false;
                return normalizeLeague(p.league) === league;
            })
            .slice(0, limit - related.length);
        related.push(...additional);
    }
    
    return related;
}

/**
 * Group posts by league
 */
function groupPostsByLeague(posts: HeatcheckPost[]): Record<string, HeatcheckPost[]> {
    const grouped: Record<string, HeatcheckPost[]> = {};
    posts.forEach(post => {
        const league = normalizeLeague(post.league);
        if (!grouped[league]) {
            grouped[league] = [];
        }
        grouped[league].push(post);
    });
    return grouped;
}

/**
 * Group posts by date
 */
function groupPostsByDate(posts: HeatcheckPost[]): Record<string, HeatcheckPost[]> {
    const grouped: Record<string, HeatcheckPost[]> = {};
    posts.forEach(post => {
        const date = post.matchupScheduledDate 
            ? formatDateISO(post.matchupScheduledDate)
            : formatDateISO(post.createdAt);
        if (!grouped[date]) {
            grouped[date] = [];
        }
        grouped[date].push(post);
    });
    return grouped;
}

/**
 * Generate all static pages
 */
async function generateAllPages(): Promise<void> {
    console.log('Starting static site generation...\n');
    
    // Validate DATABASE_URL exists
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
        throw new Error('DATABASE_URL environment variable is not set. Please set it in Cloudflare Pages environment variables.');
    }
    
    // Debug: Log connection string info (without exposing full credentials)
    const urlMatch = databaseUrl.match(/postgresql:\/\/([^:]+):([^@]+)@([^\/\?]+)/);
    if (urlMatch) {
        console.log(`Connecting to database: ${urlMatch[3]} (user: ${urlMatch[1]})`);
    } else {
        console.error('DATABASE_URL format may be incorrect. Expected format: postgresql://user:pass@host:port/dbname');
        console.error('DATABASE_URL length:', databaseUrl.length);
        console.error('DATABASE_URL first 50 chars:', databaseUrl.substring(0, 50).replace(/./g, '*'));
        throw new Error('Invalid DATABASE_URL format. Please check your environment variable in Cloudflare Pages.');
    }
    
    // Connect to database
    const pool = new Pool({
        connectionString: databaseUrl,
    });
    
    try {
        // Fetch all published posts
        console.log('Fetching published posts from database...');
        const result = await pool.query(
            `SELECT data FROM posts WHERE (data->>'status') = 'published' ORDER BY "updatedAt" DESC`
        );
        const posts: HeatcheckPost[] = result.rows.map(row => row.data);
        console.log(`Found ${posts.length} published posts\n`);
        
        // Debug: Log posts with/without images
        const postsWithImages = posts.filter(p => p.websiteStory?.image || p.websiteStory?.imageUrl);
        const postsWithoutImages = posts.filter(p => !(p.websiteStory?.image || p.websiteStory?.imageUrl));
        console.log(`Posts with images: ${postsWithImages.length}`);
        console.log(`Posts without images: ${postsWithoutImages.length}`);
        if (postsWithImages.length > 0) {
            console.log('Sample post with image:', {
                headline: postsWithImages[0].websiteStory?.headline?.substring(0, 40),
                image: postsWithImages[0].websiteStory?.image,
                imageUrl: postsWithImages[0].websiteStory?.imageUrl
            });
        }
        if (postsWithoutImages.length > 0) {
            console.log('Sample post without image:', {
                headline: postsWithoutImages[0].websiteStory?.headline?.substring(0, 40),
                websiteStoryKeys: Object.keys(postsWithoutImages[0].websiteStory || {}),
                hasImageField: 'image' in (postsWithoutImages[0].websiteStory || {}),
                hasImageUrlField: 'imageUrl' in (postsWithoutImages[0].websiteStory || {})
            });
        }
        console.log('');
        
        if (posts.length === 0) {
            console.log('No published posts found. Exiting.');
            return;
        }
        
        // Generate unique slugs with new URL structure: {league}/{date}/{matchup}/{narrative-slug}/
        // Track uniqueness per matchup to avoid conflicts
        const matchupSlugMap = new Map<string, Set<string>>(); // Key: "{league}/{date}/{matchup}", Value: Set of narrative slugs
        
        posts.forEach(post => {
            const league = normalizeLeague(post.league);
            const date = post.matchupScheduledDate 
                ? formatDateISO(post.matchupScheduledDate)
                : formatDateISO(post.createdAt);
            
            // Generate matchup slug
            const matchupSlug = generateMatchupSlug(post.teamA || '', post.teamB || '', getShortTeamName);
            const matchupKey = `${league}/${date}/${matchupSlug}`;
            
            // Get narrative keywords from heatCheckData
            const heatCheckData = post.heatCheckData || {};
            const narratives = heatCheckData.narratives || {};
            const candidateCards = narratives.candidate_cards || [];
            const primaryNarrativeId = narratives.selected?.primary_narrative_id || '';
            const activeCard = candidateCards.find(card => card.narrative_id === primaryNarrativeId);
            const emotionTags = activeCard?.emotion_tags || [];
            
            // Generate narrative-based slug
            let narrativeSlug = generateNarrativeSlug(
                post.websiteStory.headline,
                post.teamA || '',
                post.teamB || '',
                emotionTags
            );
            
            // Ensure uniqueness within the matchup
            if (!matchupSlugMap.has(matchupKey)) {
                matchupSlugMap.set(matchupKey, new Set<string>());
            }
            const narrativeSlugSet = matchupSlugMap.get(matchupKey)!;
            
            // Ensure unique narrative slug within this matchup
            let uniqueNarrativeSlug = narrativeSlug;
            let counter = 1;
            while (narrativeSlugSet.has(uniqueNarrativeSlug)) {
                uniqueNarrativeSlug = `${narrativeSlug}-${counter}`;
                counter++;
            }
            narrativeSlugSet.add(uniqueNarrativeSlug);
            
            // Store the full path structure for reference (though we'll generate it dynamically)
            if (!post.websiteStory.seo) {
                post.websiteStory.seo = { slug: '', metaTitle: '', metaDescription: '' };
            }
            // Store matchup slug and narrative slug separately for easy reference
            post.websiteStory.seo.slug = `${matchupSlug}/${uniqueNarrativeSlug}`;
        });
        
        // Copy assets first (before generating pages that reference them)
        console.log('Copying assets...');
        copyImages();
        copyAssets();
        copyPublicAssets();
        copyConfigFiles();
        console.log('');
        
        // Generate article pages (excluding DFS articles which are handled separately)
        console.log('Generating article pages...');
        const postsByLeague = groupPostsByLeague(posts);
        const postsByDate = groupPostsByDate(posts);
        const regularPosts = posts.filter(p => p.storyType !== 'dfs_article');
        
        for (const post of regularPosts) {
            const league = normalizeLeague(post.league);
            const date = post.matchupScheduledDate 
                ? formatDateISO(post.matchupScheduledDate)
                : formatDateISO(post.createdAt);
            
            // Extract slug from stored SEO slug
            const storedSlug = post.websiteStory.seo?.slug || '';
            const isPredictionFormat = storedSlug.includes('-prediction-preview-') && storedSlug.match(/\d{4}-\d{2}-\d{2}$/);
            
            let articlePath: string;
            
            if (isPredictionFormat) {
                // Use prediction format: {league}/{prediction-slug}/index.html
                articlePath = `${league}/${storedSlug}/index.html`;
            } else {
                // Fallback to old format: {league}/{date}/{matchup}/{narrative-slug}/index.html
                let matchupSlug: string;
                let narrativeSlug: string;
                
                if (storedSlug.includes('/') && storedSlug.split('/').length === 2) {
                    // Already in old format: matchup-slug/narrative-slug
                    [matchupSlug, narrativeSlug] = storedSlug.split('/');
                } else {
                    // Regenerate if not set correctly
                    matchupSlug = generateMatchupSlug(post.teamA || '', post.teamB || '', getShortTeamName);
                    const heatCheckData = post.heatCheckData || {};
                    const narratives = heatCheckData.narratives || {};
                    const candidateCards = narratives.candidate_cards || [];
                    const primaryNarrativeId = narratives.selected?.primary_narrative_id || '';
                    const activeCard = candidateCards.find(card => card.narrative_id === primaryNarrativeId);
                    const emotionTags = activeCard?.emotion_tags || [];
                    narrativeSlug = generateNarrativeSlug(
                        post.websiteStory.headline,
                        post.teamA || '',
                        post.teamB || '',
                        emotionTags
                    );
                }
                articlePath = `${league}/${date}/${matchupSlug}/${narrativeSlug}/index.html`;
            }
            
            const relatedPosts = getRelatedPosts(post, posts, 3);
            const html = generateArticlePage(post, relatedPosts, baseUrl);
            
            writeHtmlFile(articlePath, html);
        }
        console.log(`✓ Generated ${regularPosts.length} article pages\n`);
        
        // Generate DFS article pages
        console.log('Generating DFS article pages...');
        const dfsPosts = posts.filter(p => p.storyType === 'dfs_article');
        console.log(`  Found ${dfsPosts.length} DFS article(s)`);
        
        for (const post of dfsPosts) {
            const league = normalizeLeague(post.league);
            const date = post.matchupScheduledDate 
                ? formatDateISO(post.matchupScheduledDate)
                : formatDateISO(post.createdAt);
            
            const relatedPosts = dfsPosts.filter(p => p.id !== post.id).slice(0, 3);
            const html = generateDFSArticlePage(post, relatedPosts, baseUrl);
            
            // DFS URL structure: dfs/{league}/{date}/dfs-value-narratives-{date}/index.html
            const articlePath = `dfs/${league}/${date}/dfs-value-narratives-${date}/index.html`;
            writeHtmlFile(articlePath, html);
        }
        console.log(`✓ Generated ${dfsPosts.length} DFS article pages\n`);
        
        // Generate DFS hub page
        if (dfsPosts.length > 0) {
            console.log('Generating DFS hub page...');
            const html = generateDFSHubPage(dfsPosts, baseUrl);
            writeHtmlFile('dfs/index.html', html);
            console.log('✓ Generated DFS hub page\n');
        }
        
        // Generate league hub pages (dynamically for all leagues that have posts)
        console.log('Generating league hub pages...');
        const uniqueLeagues = new Set<string>();
        posts.forEach(post => {
            uniqueLeagues.add(post.league.toUpperCase());
        });
        const leagues = Array.from(uniqueLeagues).sort();
        console.log(`  Found ${leagues.length} unique league(s): ${leagues.join(', ')}`);
        
        for (const league of leagues) {
            const leaguePosts = postsByLeague[normalizeLeague(league)] || [];
            if (leaguePosts.length > 0) {
                console.log(`  Generating ${league} hub with ${leaguePosts.length} post(s)`);
                // Debug: Log posts with/without images for this hub
                const postsWithImages = leaguePosts.filter(p => p.websiteStory?.image || p.websiteStory?.imageUrl);
                const postsWithoutImages = leaguePosts.filter(p => !(p.websiteStory?.image || p.websiteStory?.imageUrl));
                if (postsWithoutImages.length > 0) {
                    console.warn(`    ⚠️ ${postsWithoutImages.length} post(s) without images`);
                    postsWithoutImages.slice(0, 3).forEach(p => {
                        console.warn(`      - ${p.websiteStory?.headline?.substring(0, 40)}`);
                    });
                }
                if (postsWithImages.length > 0) {
                    console.log(`    ✓ ${postsWithImages.length} post(s) with images`);
                }
            }
            const html = generateLeagueHubPage(league, leaguePosts, baseUrl);
            const hubPath = `${normalizeLeague(league)}/index.html`;
            writeHtmlFile(hubPath, html);
        }
        console.log(`✓ Generated ${leagues.length} league hub pages\n`);
        
        // Generate date pages
        console.log('Generating date pages...');
        const datePages = new Set<string>();
        posts.forEach(post => {
            const league = normalizeLeague(post.league);
            const date = post.matchupScheduledDate 
                ? formatDateISO(post.matchupScheduledDate)
                : formatDateISO(post.createdAt);
            const key = `${league}-${date}`;
            if (!datePages.has(key)) {
                datePages.add(key);
                const datePosts = posts.filter(p => {
                    const pLeague = normalizeLeague(p.league);
                    const pDate = p.matchupScheduledDate 
                        ? formatDateISO(p.matchupScheduledDate)
                        : formatDateISO(p.createdAt);
                    return pLeague === league && pDate === date;
                });
                // Debug: Log posts being used for this date page
                if (datePosts.length > 0) {
                    console.log(`  Generating ${league}/${date} with ${datePosts.length} post(s)`);
                    const postsWithImages = datePosts.filter(p => p.websiteStory?.image || p.websiteStory?.imageUrl);
                    const postsWithoutImages = datePosts.filter(p => !(p.websiteStory?.image || p.websiteStory?.imageUrl));
                    if (postsWithoutImages.length > 0) {
                        console.warn(`    ⚠️ ${postsWithoutImages.length} post(s) without images`);
                        postsWithoutImages.slice(0, 2).forEach(p => {
                            console.warn(`      - ${p.websiteStory?.headline?.substring(0, 40)}`);
                        });
                    }
                    if (postsWithImages.length > 0) {
                        console.log(`    ✓ ${postsWithImages.length} post(s) with images`);
                    }
                }
                const html = generateDatePage(league, date, datePosts, baseUrl);
                const datePath = `${league}/${date}/index.html`;
                writeHtmlFile(datePath, html);
            }
        });
        console.log(`✓ Generated ${datePages.size} date pages\n`);
        
        // Generate archive pages
        console.log('Generating archive pages...');
        const postsPerPage = 12;
        const totalPages = Math.ceil(posts.length / postsPerPage);
        
        for (let page = 1; page <= totalPages; page++) {
            const html = generateArchivePage(posts, page, totalPages, baseUrl);
            if (page === 1) {
                const archivePath = 'archive/index.html';
                writeHtmlFile(archivePath, html);
            } else {
                const archivePath = `archive/page/${page}/index.html`;
                writeHtmlFile(archivePath, html);
            }
        }
        console.log(`✓ Generated ${totalPages} archive page(s)\n`);
        
        // Generate homepage (index.html)
        console.log('Generating homepage...');
        const homepageContent = `
            <div class="content-area-title">▶ RECENT.LOGS</div>
            <div class="post-list" id="recent-logs-list">
                <!-- Post cards will be inserted here by static-site.js -->
            </div>
            <div style="margin-top: 2rem; padding: 1rem; display: flex; gap: 1rem; justify-content: center; align-items: center; color: #fff; font-family: 'Courier New', monospace;">
                <span style="margin-right: 1rem;" id="pagination-info">PAGE 1 / 1</span>
                <a href="#" id="next-page-link" style="color: #fff; text-decoration: none; border: 1px solid #fff; padding: 0.5rem 1rem; transition: all 0.3s ease; display: none;" onmouseover="this.style.background='rgba(255, 255, 255, 0.1)';" onmouseout="this.style.background='transparent';">NEXT &gt;</a>
            </div>
        `;
        
        // Filter posts to only include fields needed by homepage JavaScript
        // This significantly reduces JSON size by excluding:
        // - Full markdown content (theBackstory, long_form_markdown, etc.)
        // - Detailed evidence bundle content (full quote objects, source objects, timeline events)
        // - heatchecksEdge objects
        // - Other unused websiteStory fields
        const filteredPosts = posts.map(post => ({
            id: post.id,
            league: post.league,
            teamA: post.teamA,
            teamB: post.teamB,
            matchupScheduledDate: post.matchupScheduledDate,
            updatedAt: post.updatedAt || post.createdAt,
            createdAt: post.createdAt,
            storyType: post.storyType,
            status: post.status, // Include status for radar modal filtering
            websiteStory: {
                slug: post.websiteStory?.seo?.slug || '',
                headline: post.websiteStory?.headline || '',
                imageUrl: post.websiteStory?.imageUrl,
                image: post.websiteStory?.image
            },
            // Only include heatCheckData fields needed for heat score calculation
            heatCheckData: post.heatCheckData ? {
                fact_pack: post.heatCheckData.fact_pack || post.heatCheckData.factPack,
                factPack: post.heatCheckData.factPack,
                evidence_bundle: post.heatCheckData.evidence_bundle || post.heatCheckData.evidenceBundle,
                evidenceBundle: post.heatCheckData.evidenceBundle,
                narratives: post.heatCheckData.narratives,
                // For DFS articles, include dfsPlayers
                dfsPlayers: post.heatCheckData.dfsPlayers
            } : undefined
        }));
        
        // Generate Organization schema
        const organizationSchema = {
            "@context": "https://schema.org",
            "@type": "Organization",
            "name": "HeatChecks",
            "url": baseUrl,
            "logo": {
                "@type": "ImageObject",
                "url": `${baseUrl}/images/HeatChecksMainLogo.svg`
            },
            "description": "Measure the emotion behind every matchup. HeatChecks tracks revenge, rivalry, narrative momentum, and psychological pressure in sports.",
            "sameAs": [
                // Add social media profiles if available
            ]
        };
        
        // Generate WebSite schema
        const websiteSchema = {
            "@context": "https://schema.org",
            "@type": "WebSite",
            "name": "HeatChecks",
            "url": baseUrl,
            "description": "Measure the emotion behind every matchup. HeatChecks tracks revenge, rivalry, narrative momentum, and psychological pressure in sports.",
            "publisher": {
                "@type": "Organization",
                "name": "HeatChecks"
            },
            "potentialAction": {
                "@type": "SearchAction",
                "target": {
                    "@type": "EntryPoint",
                    "urlTemplate": `${baseUrl}/?q={search_term_string}`
                },
                "query-input": "required name=search_term_string"
            }
        };
        
        // Generate ItemList schema for recent posts
        const itemListSchema = {
            "@context": "https://schema.org",
            "@type": "ItemList",
            "name": "Recent Sports Analysis Articles",
            "description": "Latest HeatChecks articles covering NBA, NFL, and DFS analysis",
            "numberOfItems": Math.min(filteredPosts.length, 20),
            "itemListElement": filteredPosts.slice(0, 20).map((post, index) => {
                const league = normalizeLeague(post.league);
                const date = post.matchupScheduledDate 
                    ? formatDateISO(post.matchupScheduledDate)
                    : formatDateISO(post.createdAt);
                
                let articleUrl = '';
                if (post.storyType === 'dfs_article') {
                    articleUrl = `${baseUrl}/dfs/${league}/${date}/dfs-value-narratives-${date}/`;
                } else {
                    const matchupSlug = generateMatchupSlug(post.teamA || '', post.teamB || '', getShortTeamName);
                    const narratives = post.heatCheckData?.narratives || {};
                    const candidateCards = narratives.candidate_cards || [];
                    const primaryNarrativeId = narratives.selected?.primary_narrative_id || '';
                    const activeCard = candidateCards.find(card => card.narrative_id === primaryNarrativeId);
                    const emotionTags = activeCard?.emotion_tags || [];
                    const narrativeSlug = generateNarrativeSlug(
                        post.websiteStory?.headline || '',
                        post.teamA || '',
                        post.teamB || '',
                        emotionTags
                    );
                    articleUrl = `${baseUrl}/${league}/${date}/${matchupSlug}/${narrativeSlug}/`;
                }
                
                return {
                    "@type": "ListItem",
                    "position": index + 1,
                    "item": {
                        "@type": "Article",
                        "headline": post.websiteStory?.headline || 'Untitled',
                        "url": articleUrl
                    }
                };
            })
        };
        
        const homepageKeywords = 'sports betting, DFS picks, daily fantasy sports, NBA betting, NFL betting, sports analysis, matchup preview, betting picks, DFS strategy, sports predictions';
        
        const homepageHtml = generateBaseHtml(homepageContent, {
            title: 'HeatChecks | Sports Analysis & Heat Intelligence',
            description: 'Measure the emotion behind every matchup. HeatChecks tracks revenge, rivalry, narrative momentum, and psychological pressure in sports. Expert betting picks and DFS analysis.',
            url: baseUrl,
            baseUrl,
            keywords: homepageKeywords,
            schemaOrg: [organizationSchema, websiteSchema, itemListSchema],
            posts: filteredPosts
        });
        // Generate index.html (homepage) - allow it to be written to public
        const homepageDistPath = path.join(distDir, 'index.html');
        ensureDir(path.dirname(homepageDistPath));
        fs.writeFileSync(homepageDistPath, homepageHtml, 'utf-8');
        console.log(`✓ Generated: ${homepageDistPath}`);
        
        // Also write to public for dev server access
        const homepagePublicPath = path.join(publicDir, 'index.html');
        ensureDir(path.dirname(homepagePublicPath));
        fs.writeFileSync(homepagePublicPath, homepageHtml, 'utf-8');
        console.log(`✓ Generated: ${homepagePublicPath}`);
        console.log('✓ Generated homepage\n');
        
        // Generate about page (comprehensive SEO-optimized version)
        console.log('Generating about page...');
        const aboutContent = `
            <article>
                <div class="content-area-title">▶ ABOUT US</div>
                <div class="article-content-grid" style="display: grid; grid-template-columns: 2fr 1fr; grid-template-rows: auto 1fr; gap: 0.5rem; padding: 0.5rem;">
                    <!-- Left Column: Main Content -->
                    <div class="article-main-column" style="grid-column: 1; grid-row: 1 / -1; display: flex; flex-direction: column; background: rgba(0, 0, 0, 0.4); border: 1px solid rgba(255, 255, 255, 0.2); box-shadow: inset 0 0 20px rgba(255, 255, 255, 0.05), 0 0 30px rgba(0, 0, 0, 0.3); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); overflow: hidden;">
                        <div style="padding: 0.5rem 0.75rem; background: rgba(255, 255, 255, 0.05); border-bottom: 1px solid rgba(255, 255, 255, 0.15); display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0;">
                            <div style="width: 8px; height: 8px; background: rgba(255, 255, 255, 0.5); border-radius: 50%; box-shadow: 0 0 8px rgba(255, 255, 255, 0.3);"></div>
                            <div style="width: 8px; height: 8px; background: rgba(255, 255, 255, 0.5); border-radius: 50%; box-shadow: 0 0 8px rgba(255, 255, 255, 0.3);"></div>
                            <div style="width: 8px; height: 8px; background: rgba(255, 255, 255, 0.6); border-radius: 50%; box-shadow: 0 0 8px rgba(255, 255, 255, 0.4);"></div>
                            <div style="color: rgba(255, 255, 255, 0.9); font-size: 0.75rem; font-family: 'Courier New', monospace; margin-left: 0.5rem; letter-spacing: 0.1em;">ABOUT_HEATCHECKS.log</div>
                        </div>
                        <div class="main-article-content" style="flex: 1; overflow-y: auto; padding: 1.5rem; font-family: 'Courier New', monospace; color: rgba(255, 255, 255, 0.85); line-height: 1.8;">
                            <style>.main-article-content::-webkit-scrollbar { display: none; }</style>
                            
                            <!-- Logo Section -->
                            <div style="margin-bottom: 2rem; text-align: center; padding: 2rem 0; border-bottom: 1px dashed rgba(255, 255, 255, 0.3);">
                                <a href="/" style="display: inline-block;">
                                    <img src="/images/HeatChecksMainLogo.svg" alt="HeatChecks" style="height: 120px; width: auto; opacity: 0.95; filter: drop-shadow(0 0 20px rgba(0, 255, 65, 0.3));" onmouseover="this.style.opacity='1'; this.style.filter='drop-shadow(0 0 25px rgba(0, 255, 65, 0.5))';" onmouseout="this.style.opacity='0.95'; this.style.filter='drop-shadow(0 0 20px rgba(0, 255, 65, 0.3))';">
                                </a>
                            </div>
                            
                            <div style="margin-bottom: 2rem; border-bottom: 1px dashed rgba(255, 255, 255, 0.3); padding-bottom: 1rem;">
                                <h1 style="color: rgba(255, 255, 255, 0.95); font-size: 1.3rem; margin-bottom: 0.5rem; font-weight: bold; line-height: 1.3;">About Heatchecks</h1>
                                <div style="color: rgba(255, 255, 255, 0.6); font-size: 0.85rem; margin-bottom: 0.5rem;">// The Science of Sports Emotion</div>
                            </div>
                            
                            <section style="font-family: 'Courier New', monospace; color: rgba(255, 255, 255, 0.85); line-height: 1.8;">
                    <h2 style="color: rgba(0, 255, 65, 0.9); font-size: 1.1rem; margin-top: 2rem; margin-bottom: 1rem; font-weight: bold; font-family: 'Courier New', monospace; text-transform: uppercase; letter-spacing: 0.1em; border-bottom: 1px solid rgba(0, 255, 65, 0.3); padding-bottom: 0.5rem;">&gt; THE SCIENCE OF SPORTS EMOTION</h2>
                    
                    <p style="margin-bottom: 1.5rem; font-size: 1rem; line-height: 1.8;">
                        Heatchecks is a next-generation sports intelligence platform focused on the most powerful variable in competition: <strong>human emotion</strong>.
                    </p>
                    
                    <p style="margin-bottom: 1.5rem; font-size: 1rem; line-height: 1.8;">
                        While most sports sites obsess over numbers, spreadsheets, and projections, we go deeper — into the stories, grudges, rivalries, pressure moments, and psychological dynamics that quietly decide games.
                    </p>
                    
                    <p style="margin-bottom: 2rem; font-size: 1rem; line-height: 1.8;">
                        We believe every matchup contains a narrative undercurrent that the markets consistently undervalue. Heatchecks exists to uncover it.
                    </p>
                    
                    <h2 style="color: rgba(0, 255, 65, 0.9); font-size: 1.1rem; margin-top: 2.5rem; margin-bottom: 1rem; font-weight: bold; font-family: 'Courier New', monospace; text-transform: uppercase; letter-spacing: 0.1em; border-bottom: 1px solid rgba(0, 255, 65, 0.3); padding-bottom: 0.5rem;">&gt; OUR MISSION</h2>
                    
                    <p style="margin-bottom: 1.5rem; font-size: 1rem; line-height: 1.8;">
                        Our mission is to identify and explain high-tension moments in sports — revenge games, rivalry showdowns, personal vendettas, pressure collapses, redemption arcs — and present them in a way that is:
                    </p>
                    
                    <ul style="margin-left: 2rem; margin-bottom: 1.5rem; list-style-type: none; padding-left: 0;">
                        <li style="margin-bottom: 0.75rem; padding-left: 1.5rem; position: relative;">
                            <span style="position: absolute; left: 0; color: #ff0040;">▶</span>
                            <strong>emotionally compelling</strong>
                        </li>
                        <li style="margin-bottom: 0.75rem; padding-left: 1.5rem; position: relative;">
                            <span style="position: absolute; left: 0; color: #ff0040;">▶</span>
                            <strong>analytically grounded</strong>
                        </li>
                        <li style="margin-bottom: 0.75rem; padding-left: 1.5rem; position: relative;">
                            <span style="position: absolute; left: 0; color: #ff0040;">▶</span>
                            and <strong>strategically useful</strong> for fans, analysts, and DFS players
                        </li>
                    </ul>
                    
                    <p style="margin-bottom: 2rem; font-size: 1rem; line-height: 1.8;">
                        We blend sports data, media signals, historical context, and human psychology into long-form matchup intelligence you won&apos;t find anywhere else.
                    </p>
                    
                    <h2 style="color: rgba(0, 255, 65, 0.9); font-size: 1.1rem; margin-top: 2.5rem; margin-bottom: 1rem; font-weight: bold; font-family: 'Courier New', monospace; text-transform: uppercase; letter-spacing: 0.1em; border-bottom: 1px solid rgba(0, 255, 65, 0.3); padding-bottom: 0.5rem;">&gt; WHAT WE COVER</h2>
                    
                    <p style="margin-bottom: 1rem; font-size: 1rem; line-height: 1.8;">
                        We analyze and publish daily content for:
                    </p>
                    
                    <ul style="margin-left: 2rem; margin-bottom: 1.5rem; list-style-type: none; padding-left: 0;">
                        <li style="margin-bottom: 0.5rem; padding-left: 1.5rem; position: relative;">
                            <span style="position: absolute; left: 0; color: #ff0040;">▶</span>
                            <strong>NBA</strong>
                        </li>
                        <li style="margin-bottom: 0.5rem; padding-left: 1.5rem; position: relative;">
                            <span style="position: absolute; left: 0; color: #ff0040;">▶</span>
                            <strong>NFL</strong>
                        </li>
                        <li style="margin-bottom: 0.5rem; padding-left: 1.5rem; position: relative;">
                            <span style="position: absolute; left: 0; color: #ff0040;">▶</span>
                            <strong>Premier League</strong>
                        </li>
                        <li style="margin-bottom: 0.5rem; padding-left: 1.5rem; position: relative;">
                            <span style="position: absolute; left: 0; color: #ff0040;">▶</span>
                            <strong>La Liga</strong>
                        </li>
                        <li style="margin-bottom: 0.5rem; padding-left: 1.5rem; position: relative;">
                            <span style="position: absolute; left: 0; color: #ff0040;">▶</span>
                            (and expanding leagues soon)
                        </li>
                    </ul>
                    
                    <p style="margin-bottom: 2rem; font-size: 1rem; line-height: 1.8;">
                        Every article is designed to answer one question:
                    </p>
                    
                    <p style="margin-bottom: 2rem; font-size: 1rem; line-height: 1.8; padding-left: 1rem; border-left: 3px solid #ff0040; font-style: italic; color: rgba(255, 255, 255, 0.95);">
                        What emotional forces are truly shaping this game — and how does that create opportunity?
                    </p>
                    
                    <h2 style="color: rgba(0, 255, 65, 0.9); font-size: 1.1rem; margin-top: 2.5rem; margin-bottom: 1rem; font-weight: bold; font-family: 'Courier New', monospace; text-transform: uppercase; letter-spacing: 0.1em; border-bottom: 1px solid rgba(0, 255, 65, 0.3); padding-bottom: 0.5rem;">&gt; OUR EDGE</h2>
                    
                    <p style="margin-bottom: 1rem; font-size: 1rem; line-height: 1.8;">
                        Most outlets track:
                    </p>
                    
                    <p style="margin-bottom: 1rem; font-size: 0.95rem; color: rgba(255, 255, 255, 0.7); padding-left: 1.5rem;">
                        Scores • Injuries • Stats • Trends
                    </p>
                    
                    <p style="margin-bottom: 1rem; font-size: 1rem; line-height: 1.8; margin-top: 1.5rem;">
                        We track:
                    </p>
                    
                    <p style="margin-bottom: 2rem; font-size: 0.95rem; color: #00ff41; padding-left: 1.5rem; font-weight: 600;">
                        Motivation • Pressure • History • Grudges • Momentum • Psychology
                    </p>
                    
                    <p style="margin-bottom: 2rem; font-size: 1rem; line-height: 1.8; font-weight: 600; color: rgba(255, 255, 255, 0.95);">
                        This is the missing layer of sports intelligence.
                    </p>
                    
                    <h2 style="color: rgba(0, 255, 65, 0.9); font-size: 1.1rem; margin-top: 2.5rem; margin-bottom: 1rem; font-weight: bold; font-family: 'Courier New', monospace; text-transform: uppercase; letter-spacing: 0.1em; border-bottom: 1px solid rgba(0, 255, 65, 0.3); padding-bottom: 0.5rem;">&gt; HOW HEATCHECKS WORKS</h2>
                    
                    <p style="margin-bottom: 1rem; font-size: 1rem; line-height: 1.8;">
                        Heatchecks uses proprietary scanning systems and editorial analysis to:
                    </p>
                    
                    <ul style="margin-left: 2rem; margin-bottom: 1.5rem; list-style-type: none; padding-left: 0;">
                        <li style="margin-bottom: 0.75rem; padding-left: 1.5rem; position: relative;">
                            <span style="position: absolute; left: 0; color: #ff0040;">▶</span>
                            Detect upcoming matchups with emotional volatility
                        </li>
                        <li style="margin-bottom: 0.75rem; padding-left: 1.5rem; position: relative;">
                            <span style="position: absolute; left: 0; color: #ff0040;">▶</span>
                            Cross-reference player history, transactions, interviews, media signals, and rivalry context
                        </li>
                        <li style="margin-bottom: 0.75rem; padding-left: 1.5rem; position: relative;">
                            <span style="position: absolute; left: 0; color: #ff0040;">▶</span>
                            Construct narrative-driven game theses supported by real data
                        </li>
                        <li style="margin-bottom: 0.75rem; padding-left: 1.5rem; position: relative;">
                            <span style="position: absolute; left: 0; color: #ff0040;">▶</span>
                            Publish high-impact articles optimized for fans, DFS players, and search engines
                        </li>
                    </ul>
                    
                    <p style="margin-bottom: 2rem; font-size: 1rem; line-height: 1.8;">
                        All content is reviewed and curated by human editors.
                    </p>
                    
                    <h2 style="color: rgba(0, 255, 65, 0.9); font-size: 1.1rem; margin-top: 2.5rem; margin-bottom: 1rem; font-weight: bold; font-family: 'Courier New', monospace; text-transform: uppercase; letter-spacing: 0.1em; border-bottom: 1px solid rgba(0, 255, 65, 0.3); padding-bottom: 0.5rem;">&gt; LEGAL &amp; TRANSPARENCY NOTICE</h2>
                    
                    <p style="margin-bottom: 1rem; font-size: 0.95rem; line-height: 1.8; color: rgba(255, 255, 255, 0.9);">
                        Heatchecks is a sports analysis &amp; entertainment publication.
                    </p>
                    
                    <p style="margin-bottom: 1rem; font-size: 0.95rem; line-height: 1.8; color: rgba(255, 255, 255, 0.9);">
                        We are <strong>not</strong> a gambling service, sportsbook, or betting operator.
                    </p>
                    
                    <p style="margin-bottom: 1rem; font-size: 0.95rem; line-height: 1.8; color: rgba(255, 255, 255, 0.9);">
                        All content on this site is for:
                    </p>
                    
                    <ul style="margin-left: 2rem; margin-bottom: 1.5rem; list-style-type: none; padding-left: 0;">
                        <li style="margin-bottom: 0.5rem; padding-left: 1.5rem; position: relative; font-size: 0.95rem;">
                            <span style="position: absolute; left: 0; color: #ff0040;">▶</span>
                            informational purposes
                        </li>
                        <li style="margin-bottom: 0.5rem; padding-left: 1.5rem; position: relative; font-size: 0.95rem;">
                            <span style="position: absolute; left: 0; color: #ff0040;">▶</span>
                            educational discussion
                        </li>
                        <li style="margin-bottom: 0.5rem; padding-left: 1.5rem; position: relative; font-size: 0.95rem;">
                            <span style="position: absolute; left: 0; color: #ff0040;">▶</span>
                            and entertainment use only
                        </li>
                    </ul>
                    
                    <p style="margin-bottom: 1rem; font-size: 0.95rem; line-height: 1.8; color: rgba(255, 255, 255, 0.9);">
                        We do not provide betting advice, financial advice, or guarantees of any kind. Any references to wagering, DFS, or predictions are opinions and commentary only.
                    </p>
                    
                    <p style="margin-bottom: 1rem; font-size: 0.95rem; line-height: 1.8; color: rgba(255, 255, 255, 0.9);">
                        We may participate in affiliate partnerships with fantasy sports and sports-related services. If you choose to engage with any third-party platforms through links on this site, you do so at your own discretion.
                    </p>
                    
                    <p style="margin-bottom: 2rem; font-size: 0.95rem; line-height: 1.8; color: rgba(255, 255, 255, 0.9);">
                        Users must comply with all applicable local, state, and federal laws — including California regulations — regarding sports wagering and online gaming.
                    </p>
                    
                    <h2 style="color: rgba(0, 255, 65, 0.9); font-size: 1.1rem; margin-top: 2.5rem; margin-bottom: 1rem; font-weight: bold; font-family: 'Courier New', monospace; text-transform: uppercase; letter-spacing: 0.1em; border-bottom: 1px solid rgba(0, 255, 65, 0.3); padding-bottom: 0.5rem;">&gt; NO AFFILIATION DISCLAIMER</h2>
                    
                    <p style="margin-bottom: 1.5rem; font-size: 0.95rem; line-height: 1.8; color: rgba(255, 255, 255, 0.9);">
                        Heatchecks is an independent publication and is <strong>not affiliated</strong> with the NBA, NFL, Premier League, La Liga, or any professional league or team.
                    </p>
                    
                    <p style="margin-bottom: 2rem; font-size: 0.95rem; line-height: 1.8; color: rgba(255, 255, 255, 0.9);">
                        All team names, logos, and trademarks belong to their respective owners and are used under nominative fair use for commentary and analysis.
                    </p>
                    
                    <h2 style="color: rgba(0, 255, 65, 0.9); font-size: 1.1rem; margin-top: 2.5rem; margin-bottom: 1rem; font-weight: bold; font-family: 'Courier New', monospace; text-transform: uppercase; letter-spacing: 0.1em; border-bottom: 1px solid rgba(0, 255, 65, 0.3); padding-bottom: 0.5rem;">&gt; WHY HEATCHECKS EXISTS</h2>
                    
                    <p style="margin-bottom: 1.5rem; font-size: 1rem; line-height: 1.8;">
                        Because games are not won on spreadsheets alone.
                    </p>
                    
                    <p style="margin-bottom: 1rem; font-size: 1rem; line-height: 1.8;">
                        They are won on:
                    </p>
                    
                    <p style="margin-bottom: 2rem; font-size: 1rem; line-height: 1.8; padding-left: 1.5rem; color: #ff0040; font-weight: 600;">
                        emotion, identity, memory, and pressure.
                    </p>
                    
                    <p style="margin-bottom: 0; font-size: 1rem; line-height: 1.8; font-weight: 600; color: rgba(255, 255, 255, 0.95); font-style: italic;">
                        We read the game beneath the game.
                    </p>
                            </section>
                        </div>
                    </div>
                    
                    <!-- Right Column: Sidebar -->
                    <div class="article-sidebar-column" style="grid-column: 2; grid-row: 1 / -1; display: flex; flex-direction: column; gap: 0.5rem; overflow: hidden;">
                        <!-- Info Panel -->
                        <div style="flex: 1 1 auto; display: flex; flex-direction: column; background: rgba(0, 0, 0, 0.4); border: 1px solid rgba(255, 255, 255, 0.2); box-shadow: inset 0 0 20px rgba(255, 255, 255, 0.05), 0 0 30px rgba(0, 0, 0, 0.3); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); overflow: hidden; min-height: 0;">
                            <div style="padding: 0.5rem 0.75rem; background: rgba(255, 255, 255, 0.05); border-bottom: 1px solid rgba(0, 255, 65, 0.3); display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0;">
                                <div style="width: 6px; height: 6px; background: rgba(0, 255, 65, 0.8); border-radius: 50%; box-shadow: 0 0 6px rgba(0, 255, 65, 0.5);"></div>
                                <div style="color: rgba(255, 255, 255, 0.9); font-size: 0.75rem; font-family: 'Courier New', monospace; letter-spacing: 0.1em; font-weight: bold;">INFO_PANEL</div>
                            </div>
                            <div style="flex: 1; overflow-y: auto; padding: 1rem; font-family: 'Courier New', monospace; font-size: 0.8rem; color: rgba(255, 255, 255, 0.85);">
                                <style>.article-sidebar-column div::-webkit-scrollbar { display: none; }</style>
                                
                                <div style="margin-bottom: 1.5rem; padding: 0.75rem; background: rgba(0, 255, 65, 0.1); border: 1px solid rgba(0, 255, 65, 0.3); border-left: 3px solid rgba(0, 255, 65, 0.6);">
                                    <div style="color: rgba(0, 255, 65, 0.9); font-size: 0.75rem; font-weight: bold; margin-bottom: 0.5rem; text-transform: uppercase;">&gt; PLATFORM</div>
                                    <div style="color: rgba(255, 255, 255, 0.85); font-size: 0.8rem; line-height: 1.6;">
                                        Next-generation sports intelligence focused on emotional dynamics in competition.
                                    </div>
                                </div>
                                
                                <div style="margin-bottom: 1.5rem; padding: 0.75rem; background: rgba(248, 66, 66, 0.1); border: 1px solid rgba(248, 66, 66, 0.3); border-left: 3px solid rgba(248, 66, 66, 0.6);">
                                    <div style="color: rgba(248, 66, 66, 0.9); font-size: 0.75rem; font-weight: bold; margin-bottom: 0.5rem; text-transform: uppercase;">&gt; COVERAGE</div>
                                    <div style="color: rgba(255, 255, 255, 0.85); font-size: 0.8rem; line-height: 1.6;">
                                        NBA • NFL • Premier League • La Liga
                                    </div>
                                </div>
                                
                                <div style="margin-bottom: 1.5rem; padding: 0.75rem; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.2); border-left: 3px solid rgba(255, 255, 255, 0.4);">
                                    <div style="color: rgba(255, 255, 255, 0.9); font-size: 0.75rem; font-weight: bold; margin-bottom: 0.5rem; text-transform: uppercase;">&gt; METHODOLOGY</div>
                                    <div style="color: rgba(255, 255, 255, 0.75); font-size: 0.75rem; line-height: 1.6;">
                                        Proprietary scanning systems + editorial analysis + narrative intelligence
                                    </div>
                                </div>
                                
                                <div style="padding: 0.75rem; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.1);">
                                    <div style="color: rgba(255, 255, 255, 0.7); font-size: 0.7rem; line-height: 1.6; margin-bottom: 0.5rem;">
                                        Independent publication. Not affiliated with any professional league or team.
                                    </div>
                                    <div style="color: rgba(255, 255, 255, 0.5); font-size: 0.65rem; line-height: 1.5; border-top: 1px dashed rgba(255, 255, 255, 0.2); padding-top: 0.5rem; margin-top: 0.5rem;">
                                        All content for informational, educational, and entertainment purposes only.
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </article>
        `;
        
        // Schema.org Organization structured data for SEO
        const schemaOrg = {
            "@context": "https://schema.org",
            "@type": "Organization",
            "name": "Heatchecks",
            "url": baseUrl,
            "logo": `${baseUrl}/images/HeatChecksMainLogo.svg`,
            "description": "Next-generation sports intelligence platform analyzing emotional forces behind sports matchups. We track motivation, pressure, history, grudges, and psychology to uncover narrative opportunities in NBA, NFL, Premier League, and La Liga.",
            "foundingDate": "2026",
            "contactPoint": {
                "@type": "ContactPoint",
                "contactType": "Customer Service",
                "availableLanguage": ["English"]
            },
            "sameAs": []
        };
        
        const aboutHtml = generateBaseHtml(aboutContent, {
            title: 'About Heatchecks | The Science of Sports Emotion',
            description: 'Heatchecks is a next-generation sports intelligence platform analyzing the emotional forces behind matchups. We track motivation, pressure, history, and psychology to uncover narrative opportunities in NBA, NFL, Premier League, and La Liga.',
            url: `${baseUrl}/about/`,
            baseUrl,
            posts,
            schemaOrg
        });
        const aboutPath = 'about/index.html';
        writeHtmlFile(aboutPath, aboutHtml);
        console.log('✓ Generated about page\n');
        
        // Generate redirects file (for Cloudflare Pages)
        console.log('Generating redirects...');
        try {
            await generateRedirectsFile('public/_redirects');
            // Also copy to dist/ for Cloudflare Pages deployment
            const distRedirectsPath = path.join('dist', '_redirects');
            if (fs.existsSync('public/_redirects')) {
                fs.mkdirSync(path.dirname(distRedirectsPath), { recursive: true });
                fs.copyFileSync('public/_redirects', distRedirectsPath);
            }
            console.log('✓ Redirects generated\n');
        } catch (error: any) {
            console.warn('⚠ Warning: Failed to generate redirects:', error.message);
            // Continue - redirects are not critical for site generation
        }
        
        // Generate sitemap.xml (write to dist/ for Cloudflare Pages)
        console.log('Generating sitemap...');
        generateSitemap(posts, baseUrl, 'dist/sitemap.xml');
        // Also write to public/ for local development
        generateSitemap(posts, baseUrl, 'public/sitemap.xml');
        console.log('');
        
        // Generate robots.txt (write to dist/ for Cloudflare Pages)
        console.log('Generating robots.txt...');
        const robotsTxt = `User-agent: *
Allow: /
Disallow: /app/
Disallow: /api/

# Sitemap
Sitemap: ${baseUrl}/sitemap.xml

# Disallow admin/API paths if any
Disallow: /admin/
Disallow: /api/
`;
        const distRobotsPath = path.join('dist', 'robots.txt');
        fs.mkdirSync(path.dirname(distRobotsPath), { recursive: true });
        fs.writeFileSync(distRobotsPath, robotsTxt, 'utf-8');
        // Also write to public/ for local development
        const publicRobotsPath = path.join('public', 'robots.txt');
        fs.mkdirSync(path.dirname(publicRobotsPath), { recursive: true });
        fs.writeFileSync(publicRobotsPath, robotsTxt, 'utf-8');
        console.log('✓ Generated robots.txt\n');
        
        console.log('Static site generation complete!');
        
    } catch (error) {
        console.error('Error generating static site:', error);
        throw error;
    } finally {
        await pool.end();
    }
}

// Export the function so it can be called programmatically
export { generateAllPages };

// Only run automatically if this script is executed directly (not imported)
// This check works for both ES modules and when executed via tsx/npm
if (process.argv[1] && process.argv[1].includes('generate-static-site')) {
    generateAllPages().catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}
