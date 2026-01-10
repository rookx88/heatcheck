import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { generateArticlePage } from './templates/article-template';
import { generateArchivePage } from './templates/archive-template';
import { generateLeagueHubPage } from './templates/league-hub-template';
import { generateDatePage } from './templates/date-page-template';
import { generateBaseHtml } from './templates/base-template';
import { formatDateISO, normalizeLeague } from './utils/date-formatter';
import { generateSlug, ensureUniqueSlug } from './utils/slug-generator';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config({ path: '.env.local' });

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
    
    // Connect to database
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
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
        
        // Ensure unique slugs
        const slugSet = new Set<string>();
        posts.forEach(post => {
            const slug = post.websiteStory?.seo?.slug || generateSlug(post.websiteStory.headline);
            const uniqueSlug = ensureUniqueSlug(slug, slugSet);
            slugSet.add(uniqueSlug);
            if (!post.websiteStory.seo) {
                post.websiteStory.seo = { slug: '', metaTitle: '', metaDescription: '' };
            }
            post.websiteStory.seo.slug = uniqueSlug;
        });
        
        // Copy assets first (before generating pages that reference them)
        console.log('Copying assets...');
        copyImages();
        copyAssets();
        console.log('');
        
        // Generate article pages
        console.log('Generating article pages...');
        const postsByLeague = groupPostsByLeague(posts);
        const postsByDate = groupPostsByDate(posts);
        
        for (const post of posts) {
            const league = normalizeLeague(post.league);
            const date = post.matchupScheduledDate 
                ? formatDateISO(post.matchupScheduledDate)
                : formatDateISO(post.createdAt);
            const slug = post.websiteStory.seo.slug;
            
            const relatedPosts = getRelatedPosts(post, posts, 3);
            const html = generateArticlePage(post, relatedPosts, baseUrl);
            
            // Write using relative path from dist/public root
            const articlePath = `${league}/${date}/${slug}.html`;
            writeHtmlFile(articlePath, html);
        }
        console.log(`✓ Generated ${posts.length} article pages\n`);
        
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
        const homepageHtml = generateBaseHtml(homepageContent, {
            title: 'HeatChecks | Sports Analysis & Heat Intelligence',
            description: 'Measure the emotion behind every matchup. HeatChecks tracks revenge, rivalry, narrative momentum, and psychological pressure in sports.',
            url: baseUrl,
            baseUrl,
            posts
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
        
        // Generate about page (simple version)
        console.log('Generating about page...');
        const aboutContent = `
            <div class="content-area-title">▶ ABOUT US</div>
            <div style="padding: 2rem; font-family: 'Courier New', monospace; color: rgba(255, 255, 255, 0.85); line-height: 1.8;">
                <h1 style="color: #f84242; font-size: 1.5rem; margin-bottom: 1rem;">HeatChecks</h1>
                <p style="margin-bottom: 1rem; font-size: 0.95rem;">
                    Measure the emotion behind every matchup. HeatChecks tracks revenge, rivalry, narrative momentum, and psychological pressure in sports.
                </p>
                <p style="margin-bottom: 1rem; font-size: 0.95rem;">
                    We analyze the hidden narratives that drive sports outcomes—the personal vendettas, historical curses, and psychological warfare that statistics can't capture.
                </p>
            </div>
        `;
        const aboutHtml = generateBaseHtml(aboutContent, {
            title: 'About Us | HeatChecks',
            description: 'Measure the emotion behind every matchup. HeatChecks tracks revenge, rivalry, narrative momentum, and psychological pressure in sports.',
            url: `${baseUrl}/about/`,
            baseUrl,
            posts
        });
        const aboutPath = 'about/index.html';
        writeHtmlFile(aboutPath, aboutHtml);
        console.log('✓ Generated about page\n');
        
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
