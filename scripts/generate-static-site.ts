import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { generateArticlePage } from './templates/article-template';
import { generateArchivePage } from './templates/archive-template';
import { generateLeagueHubPage } from './templates/league-hub-template';
import { generateDatePage } from './templates/date-page-template';
import { generateDFSArticlePage } from './templates/dfs-article-template';
import { generateHeatPicksArticlePage } from './templates/heat-picks-article-template';
import { generateDFSHubPage } from './templates/dfs-hub-template';
import { generateHeatPicksHubPage } from './templates/heat-picks-hub-template';
import { generateTankArticlePage, TankPageRecord } from './templates/tank-article-template';
import { generateOgImage } from './generate-og-image';
import { buildTankBundles } from './build-tank-bundles';
import { formatMarketLabel, formatOddsLabel, formatSettleDate, formatGameTime, effectiveSettleDate, deriveTaglineFallback, truncateHeaderLabel, deriveSidesImpliedProb } from '../tank-deck-format';
import { buildWorldMap } from './build-world-map';
import { buildNewsletterPick } from './build-newsletter-pick';
import { buildLogin } from './build-login';
import { buildWelcome } from './build-welcome';
import { buildAccount } from './build-account';
import { buildMyTanks } from './build-my-tanks';
import { buildAnalyticsBeacon } from './build-analytics-beacon';
import { generateBaseHtml } from './templates/base-template';
import { generateBetaInfoPageHtml } from './templates/waitlist-landing-template';
import { generate404Page } from './templates/404-template';
import { renderHomepage } from '../lib/pages-functions/homepage/render';
import {
    filterAndSortLiveRows,
    pickLiveTankPerSport,
    emptyHomepageData,
    type HomepageTankRow,
} from '../lib/pages-functions/homepage/data';
import { getTickerNews, getTickerResults, getTickerSeries, getTickerValues, type SqlReader } from '../lib/pages-functions/tickers';
import { emptyMarketMovers, indexLabelOf, toMarketMovers } from '../lib/pages-functions/market-movers';
import { generateTankdaqPageHtml } from './templates/tankdaq-template';
import { generateTankdaqIndexesPageHtml } from './templates/tankdaq-indexes-template';
import { generateTankdaqTickerPageHtml } from './templates/tankdaq-ticker-template';
import { generateClaimYourSpotPageHtml } from './templates/claim-your-spot-template';
import { generateNewsletterPickPageHtml } from './templates/newsletter-pick-template';
import { generateLoginPageHtml } from './templates/login-template';
import { generateWelcomePageHtml } from './templates/welcome-template';
import { generateAccountPageHtml } from './templates/account-template';
import { generateMyTanksPageHtml } from './templates/my-tanks-template';
import { generateTankPageHtml, TankPageEntry } from './templates/tank-template';
import { generateTankLandPageHtml } from './templates/tank-land-template';
import { generateHatcheryPageHtml } from './templates/hatchery-template';
import { generateFoodShopPageHtml } from './templates/food-shop-template';
import { formatDateISO, normalizeLeague } from './utils/date-formatter';
import { generateSlug, ensureUniqueSlug, generateNarrativeSlug, generateMatchupSlug } from './utils/slug-generator';
import { getShortTeamName } from './utils/date-formatter';
import { generateSitemap } from './sitemap';
import { generateRedirectsFile } from './generate-redirects';
import { migrateToSEOUrls } from './migrate-to-seo-urls';
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

// The only assets/images/* files the NEW site (homepage, claim-your-spot, the-tank)
// actually references - everything else in that folder is legacy matchup-thumbnail
// art used solely by the legacy article pages, which are gated behind LEGACY_BUILD.
// Keeping this an explicit allowlist (rather than copying the whole folder) keeps
// those ~400 unused legacy images out of every normal deploy.
const NEW_SITE_IMAGES = [
    'checknav.webp',
    'heatchecks-logo.png',
    'heatchecks-logo.webp',
    'mudpuppy-default.png',
    'mudpuppy-default.webp',
    'mudpuppy-football.png',
    'mudpuppy-football.webp',
    'mudpuppy-jersey.png',
    'mudpuppy-jersey.webp',
    'world-map.png',
    'world-map.webp',
    'explore-logo.png',
    'explore-logo.webp',
    'og-share-world-map.jpg',
    'tank-email-correct.jpg',
    'tank-email-incorrect.jpg',
    'heatchecks-logo-email.png',
    'market-movers-logo.png',
    'market-movers-logo.webp',
    // Register CTA banner - homepage logged-out explore section (renderExplore in
    // homepage/render.ts) and the top-right corner of Tank article pages
    // (tank-article-template.ts). Replaces the old register-here.webp card art.
    'register-banner.webp',
    // Homepage tanks-panel backdrop - the cave the whole panel (pitch copy, tank
    // artifact, sport buttons, picks-left footer) sits in (.hc-tanks-backdrop,
    // server-rendered by homepage/render.ts).
    'tank-homepage-backdrop.webp',
    // Pet body sprite (components/petRender.ts) - subpath preserved on copy.
    'pets/mud_puppy_base_axol.png',
    // Satiated aura, layered behind the pet while state === 'satisfied'
    // (components/PetPortrait.tsx).
    'pets/aura-satiated.svg',
    // Food-shop item art, one per items_catalog food key (FoodShopModal/FeedModal/
    // PetInventoryModal build the URL as /assets/images/food/<catalog_key>.png).
    'food/food_banana_shake.png',
    'food/food_breakfast.png',
    'food/food_fresh_salad.png',
    'food/food_protein_shake.png',
    'food/food_ribeye.png',
    'food/food_stadium_dog.png',
    'food/food_worm_delicacy.png',
    'food/food_yogurt_parfait.png',
    // Genesis Collection card cover art (items_catalog config.cover_image;
    // CollectibleCard + the inventory Collectibles grid build the URL as
    // /assets/images/<cover_image>).
    'collectibles/gold_plated_card.jpg',
    'collectibles/neon_og_card.jpg',
];

// Videos follow the images' allowlist-copy model (assets/videos/ -> both output
// trees), but unlike assets/images/* the source folder has no legacy noise, so
// nothing is gitignored. Fixed filenames, updatable in place - cached a day via
// public/_headers, not immutable.
const NEW_SITE_VIDEOS = [
    // Card-interior backdrop, soccer scene (components/CollectibleCard.tsx).
    'soccerbackdrop.mp4',
];

function copyNewSiteVideos(): void {
    const assetsVideosDir = path.join(process.cwd(), 'assets', 'videos');
    if (!fs.existsSync(assetsVideosDir)) {
        console.log('⚠ No assets/videos directory found, skipping new-site video copy');
        return;
    }

    const distVideosDir = path.join(distDir, 'assets', 'videos');
    const publicVideosDir = path.join(publicDir, 'assets', 'videos');
    ensureDir(distVideosDir);
    ensureDir(publicVideosDir);
    let copied = 0;
    for (const file of NEW_SITE_VIDEOS) {
        const src = path.join(assetsVideosDir, file);
        if (!fs.existsSync(src)) {
            console.warn(`⚠ Expected new-site video not found: assets/videos/${file}`);
            continue;
        }
        fs.copyFileSync(src, path.join(distVideosDir, file));
        fs.copyFileSync(src, path.join(publicVideosDir, file));
        copied++;
    }
    console.log(`✓ Copied ${copied} new-site video(s) to dist/assets/videos and public/assets/videos`);
}

/**
 * Copy just the new-site images (see NEW_SITE_IMAGES) - this runs unconditionally,
 * unlike copyImages() (the full legacy folder), since the new homepage/claim-your-spot/
 * the-tank pages need these regardless of LEGACY_BUILD.
 */
function copyNewSiteImages(): void {
    if (!fs.existsSync(assetsImagesDir)) {
        console.log('⚠ No assets/images directory found, skipping new-site image copy');
        return;
    }

    ensureDir(distImagesDir);
    ensureDir(publicImagesDir);
    let copied = 0;
    for (const file of NEW_SITE_IMAGES) {
        const src = path.join(assetsImagesDir, file);
        if (!fs.existsSync(src)) {
            console.warn(`⚠ Expected new-site image not found: assets/images/${file}`);
            continue;
        }
        const distDest = path.join(distImagesDir, file);
        const publicDest = path.join(publicImagesDir, file);
        // Entries may carry a subpath (pets/, food/) that must exist at the destination.
        ensureDir(path.dirname(distDest));
        ensureDir(path.dirname(publicDest));
        fs.copyFileSync(src, distDest);
        fs.copyFileSync(src, publicDest);
        copied++;
    }
    console.log(`✓ Copied ${copied} new-site image(s) to dist/assets/images and public/assets/images`);
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

// Binary counterpart to writeHtmlFile, always dual-written (unlike the html helper's
// assets/ skip, which exists for vite-bundled JS/CSS this script never touches) - OG
// card PNGs are this script's own generated output and need to be servable from public/
// for the dev server exactly like dist/ is for production.
function writeBinaryFile(relativePath: string, data: Buffer): void {
    const distPath = path.join(distDir, relativePath);
    ensureDir(path.dirname(distPath));
    fs.writeFileSync(distPath, data);

    const publicPath = path.join(publicDir, relativePath);
    ensureDir(path.dirname(publicPath));
    fs.writeFileSync(publicPath, data);
}

/**
 * Find Tank articles that cover the SAME game and pick one to carry the canonical.
 *
 * Curation can select more than one prop from a single game, which produces several
 * articles competing for the same matchup query while each self-canonicalizes. The
 * loser pages stay live and fully functional - only the search signal consolidates.
 *
 * Keyed on away|home|kickoff, NOT on the team names alone: a three-game series is three
 * different games between the same two teams, and keying on teams would wrongly
 * canonicalize a Saturday article onto a Sunday one.
 *
 * Returns slug -> canonical slug, containing ONLY the losers. A page absent from the
 * map keeps the self-referential canonical it has always had.
 */
function buildCanonicalClusters(pages: TankPageRecord[]): Map<string, string> {
    const clusters = new Map<string, TankPageRecord[]>();
    for (const page of pages) {
        const game = page.game_snapshot?.game;
        if (!game?.kickoff || !game.away || !game.home) continue;
        const key = `${game.away}|${game.home}|${new Date(game.kickoff).getTime()}`;
        const bucket = clusters.get(key);
        if (bucket) bucket.push(page);
        else clusters.set(key, [page]);
    }

    // Postgres hands these back as Date objects, so go through new Date().getTime()
    // rather than Date.parse(), which would truncate to whole seconds.
    const publishedMs = (p: TankPageRecord): number =>
        new Date(p.published_at || p.created_at).getTime();

    const canonicalBySlug = new Map<string, string>();
    for (const bucket of clusters.values()) {
        if (bucket.length < 2) continue;
        // Newest wins - the latest angle on a game reflects the most recent news. Slug
        // breaks ties so the choice is stable build over build.
        const winner = [...bucket].sort((a, b) => {
            const delta = publishedMs(b) - publishedMs(a);
            return delta !== 0 ? delta : a.slug.localeCompare(b.slug);
        })[0];
        for (const page of bucket) {
            if (page.slug !== winner.slug) canonicalBySlug.set(page.slug, winner.slug);
        }
    }

    if (canonicalBySlug.size > 0) {
        console.log(`✓ Consolidated ${canonicalBySlug.size} duplicate Tank article(s) onto their newest sibling`);
    }
    return canonicalBySlug;
}

/**
 * Delete article directories that no longer correspond to a published row.
 *
 * The build writes article pages but has never removed them, so a Tank that gets
 * unpublished or flipped to newsletter_only stays on disk - live, indexable, and
 * self-canonicalizing - while dropping out of the sitemap. Pruning makes that
 * self-correcting instead of a cleanup someone has to remember.
 *
 * The zero-row guard matters: the caller's try/catch lets the build "succeed" with no
 * articles when the DB is unreachable, and without this check that failure mode would
 * delete the entire corpus.
 */
export function pruneStaleTankArticles(publishedSlugs: string[], baseDirs: string[] = [distDir, publicDir]): number {
    if (publishedSlugs.length === 0) {
        console.warn('⚠ Skipping stale-article prune: no published Tank articles in this build');
        return 0;
    }

    const keep = new Set(publishedSlugs);
    let removed = 0;
    for (const baseDir of baseDirs) {
        const articlesDir = path.join(baseDir, 'the-tank', 'articles');
        if (!fs.existsSync(articlesDir)) continue;
        for (const entry of fs.readdirSync(articlesDir, { withFileTypes: true })) {
            if (!entry.isDirectory() || keep.has(entry.name)) continue;
            fs.rmSync(path.join(articlesDir, entry.name), { recursive: true, force: true });
            console.log(`✓ Pruned stale Tank article: ${path.join(articlesDir, entry.name)}`);
            removed++;
        }
    }

    // The cards an unpublished article left behind. Without this they accumulate
    // forever - the directory was already ~70MB of orphans before the article
    // variant started adding a second file per Tank. Same zero-row guard as above
    // protects them: an unreachable DB must not wipe the set.
    for (const baseDir of baseDirs) {
        const ogDir = path.join(baseDir, 'assets', 'og');
        if (!fs.existsSync(ogDir)) continue;
        for (const entry of fs.readdirSync(ogDir, { withFileTypes: true })) {
            if (!entry.isFile()) continue;
            const slug = entry.name.replace(/(-article)?\.(png|jpg|webp)$/, '');
            if (slug === entry.name || keep.has(slug)) continue; // unknown naming, or still published
            fs.rmSync(path.join(ogDir, entry.name), { force: true });
            console.log(`✓ Pruned stale matchup card: ${path.join(ogDir, entry.name)}`);
            removed++;
        }
    }

    if (removed === 0) console.log('✓ No stale Tank articles to prune');
    return removed;
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

    // Legacy prediction-app pages (articles, DFS, Heat Picks, league hubs, date pages,
    // archive) are opt-in only — the site is pivoting to Tank/landing as primary.
    // Set LEGACY_BUILD=true to regenerate them (e.g. a one-off legacy refresh).
    const LEGACY_BUILD = process.env.LEGACY_BUILD === 'true';
    let posts: HeatcheckPost[] = [];

    try {
      // CSS/JS bundles, the new site's own images, and Cloudflare config files are
      // shared by every page (legacy and new), so these copy unconditionally. The
      // full legacy assets/images/ folder (~400 matchup thumbnails) is copied further
      // below, only when LEGACY_BUILD actually needs it.
      console.log('Copying assets...');
      copyAssets();
      copyPublicAssets();
      copyNewSiteImages();
      copyNewSiteVideos();
      copyConfigFiles();
      console.log('');

      if (LEGACY_BUILD) {
        // Fetch all published posts
        // Order by matchupScheduledDate (game date) first, then updatedAt, then createdAt
        // This ensures articles about upcoming/recent games appear first
        console.log('Fetching published posts from database...');
        const result = await pool.query(
            `SELECT data FROM posts
             WHERE (data->>'status') = 'published'
             ORDER BY
                 COALESCE((data->>'matchupScheduledDate')::timestamp, (data->>'updatedAt')::timestamp, (data->>'createdAt')::timestamp) DESC`
        );
        posts = result.rows.map(row => row.data);
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
            console.log('No published posts found. Skipping legacy page generation.\n');
        } else {

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
            // Only generate old-format slug if SEO slug is completely missing
            // Don't overwrite existing slugs - they may be in transition or already migrated
            const existingSlug = post.websiteStory.seo.slug || '';
            
            if (!existingSlug) {
                // Only set slug if it's completely missing - don't overwrite existing slugs
                // Store matchup slug and narrative slug separately for easy reference (old format)
                post.websiteStory.seo.slug = `${matchupSlug}/${uniqueNarrativeSlug}`;
            }
            // If slug exists (even if not in prediction format), leave it alone
            // The migration script will handle converting old format slugs to new format
        });

        // Full legacy image folder (~400 matchup thumbnails) - only the legacy article
        // pages generated below reference these, so this stays LEGACY_BUILD-gated.
        console.log('Copying legacy images...');
        copyImages();
        console.log('');

        // Generate article pages (excluding DFS and Heat Picks articles which are handled separately)
        console.log('Generating article pages...');
        const postsByLeague = groupPostsByLeague(posts);
        const postsByDate = groupPostsByDate(posts);
        const regularPosts = posts.filter(p => p.storyType !== 'dfs_article' && p.storyType !== 'heat_picks');
        
        for (const post of regularPosts) {
            const league = normalizeLeague(post.league);
            const date = post.matchupScheduledDate 
                ? formatDateISO(post.matchupScheduledDate)
                : formatDateISO(post.createdAt);
            
            // Extract slug from stored SEO slug
            const storedSlug = post.websiteStory?.seo?.slug || '';
            const isPredictionFormat = storedSlug && storedSlug.includes('-prediction-preview-') && storedSlug.match(/\d{4}-\d{2}-\d{2}$/);
            
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
        
        // Generate Heat Picks article pages
        console.log('Generating Heat Picks article pages...');
        const heatPicksPosts = posts.filter(p => p.storyType === 'heat_picks');
        console.log(`  Found ${heatPicksPosts.length} Heat Picks article(s)`);
        
        for (const post of heatPicksPosts) {
            const league = normalizeLeague(post.league);
            const date = post.matchupScheduledDate 
                ? formatDateISO(post.matchupScheduledDate)
                : formatDateISO(post.createdAt);
            
            // Extract slug from stored SEO slug
            const storedSlug = post.websiteStory?.seo?.slug || '';
            let articlePath: string;
            
            if (storedSlug) {
                // Use stored slug: {league}/heat-picks-today-{MM-DD-YYYY}/index.html
                articlePath = `${league}/${storedSlug}/index.html`;
            } else {
                // Fallback: generate from date
                const dateParts = date.split('-');
                const slugDate = `${dateParts[1]}-${dateParts[2]}-${dateParts[0]}`;
                articlePath = `${league}/heat-picks-today-${slugDate}/index.html`;
            }
            
            const relatedPosts = heatPicksPosts.filter(p => p.id !== post.id).slice(0, 3);
            // Pass all posts so we can find matching matchup articles for images
            const html = generateHeatPicksArticlePage(post, relatedPosts, baseUrl, posts);
            
            writeHtmlFile(articlePath, html);
        }
        console.log(`✓ Generated ${heatPicksPosts.length} Heat Picks article pages\n`);
        
        // Generate DFS hub page
        if (dfsPosts.length > 0) {
            console.log('Generating DFS hub page...');
            const html = generateDFSHubPage(dfsPosts, baseUrl);
            writeHtmlFile('dfs/index.html', html);
            console.log('✓ Generated DFS hub page\n');
        }
        
        // Generate Heat Picks hub page
        if (heatPicksPosts.length > 0) {
            console.log('Generating Heat Picks hub page...');
            const html = generateHeatPicksHubPage(heatPicksPosts, baseUrl);
            writeHtmlFile('heat-picks/index.html', html);
            console.log('✓ Generated Heat Picks hub page\n');
        }
        
        // Generate league hub pages (dynamically for all leagues that have posts)
        console.log('Generating league hub pages...');
        // Store both original league name and normalized key to avoid mismatches
        const leagueMap = new Map<string, string>(); // normalized key -> original league name
        posts.forEach(post => {
            const normalized = normalizeLeague(post.league);
            if (!leagueMap.has(normalized)) {
                leagueMap.set(normalized, post.league);
            }
        });
        const normalizedLeagues = Array.from(leagueMap.keys()).sort();
        console.log(`  Found ${normalizedLeagues.length} unique league(s): ${normalizedLeagues.join(', ')}`);
        
        for (const normalizedLeague of normalizedLeagues) {
            const originalLeague = leagueMap.get(normalizedLeague) || normalizedLeague;
            const leaguePosts = postsByLeague[normalizedLeague] || [];
            if (leaguePosts.length > 0) {
                console.log(`  Generating ${originalLeague} hub with ${leaguePosts.length} post(s)`);
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
            const html = generateLeagueHubPage(originalLeague, leaguePosts, baseUrl);
            const hubPath = `${normalizedLeague}/index.html`;
            writeHtmlFile(hubPath, html);
        }
        console.log(`✓ Generated ${normalizedLeagues.length} league hub pages\n`);
        
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
        } // end posts.length > 0
      } else {
        console.log('Skipping legacy static site generation (set LEGACY_BUILD=true to include it).\n');
      }

        // Homepage (index.html) is generated further down, after the tank_pages
        // fetch: it's now the logged-out fallback of the server-rendered homepage
        // (functions/index.ts), built from the same renderHomepage() template and the
        // same rows, so there's exactly one homepage template. The old marketing
        // landing page markup lives on only at /beta/ and /claim-your-spot/.

        // Generate beta info ("learn more") placeholder page
        console.log('Generating beta info page...');
        writeHtmlFile('beta/index.html', generateBetaInfoPageHtml(baseUrl));
        console.log('✓ Generated beta info page\n');

        // Not-found page. Its presence at the build root is what makes Cloudflare Pages
        // return a real 404 for unmatched routes - without it Pages falls back to
        // serving /index.html with a 200, so every dead URL was an indexable copy of the
        // homepage. No DB dependency, so it runs unconditionally.
        console.log('Generating 404 page...');
        writeHtmlFile('404.html', generate404Page(baseUrl));
        console.log('✓ Generated 404 page\n');

        // Build the interactive world map bundle before generating any page that embeds it.
        // No DB dependency, so this runs unconditionally here.
        console.log('Building world map bundle...');
        await buildWorldMap();
        console.log('✓ Built world map bundle\n');

        // Sitewide page-view beacon, referenced by every renderHead()-based page. No DB
        // dependency, so this runs unconditionally too.
        console.log('Building analytics beacon...');
        await buildAnalyticsBeacon();
        console.log('✓ Built analytics beacon\n');

        // Generate claim-your-spot page (interactive world map, all islands disabled)
        console.log('Generating claim-your-spot page...');
        writeHtmlFile('claim-your-spot/index.html', generateClaimYourSpotPageHtml(baseUrl));
        console.log('✓ Generated claim-your-spot page\n');

        // Build the newsletter-pick bundle and generate its static shell. No DB
        // dependency (all real content is fetched client-side via the signed token in
        // the URL), so this runs unconditionally too.
        console.log('Building newsletter-pick bundle...');
        await buildNewsletterPick();
        writeHtmlFile('newsletter-pick/index.html', generateNewsletterPickPageHtml(baseUrl));
        console.log('✓ Built newsletter-pick bundle and page\n');

        // Build the magic-link login bundle and its static shell (same pattern as
        // newsletter-pick: no DB dependency, all behavior client-side).
        console.log('Building login bundle...');
        await buildLogin();
        writeHtmlFile('login/index.html', generateLoginPageHtml(baseUrl));
        console.log('✓ Built login bundle and page\n');

        // First-login welcome letter: same standalone-bundle pattern as login (no DB
        // dependency; all personalization fetched client-side from
        // /api/onboarding-status).
        console.log('Building welcome bundle...');
        await buildWelcome();
        writeHtmlFile('welcome/index.html', generateWelcomePageHtml(baseUrl));
        console.log('✓ Built welcome bundle and page\n');

        // Account page: the only place a logged-in user manages account-level settings
        // (currently just the Discord link). Same standalone-bundle pattern as login/welcome.
        console.log('Building account bundle...');
        await buildAccount();
        writeHtmlFile('account/index.html', generateAccountPageHtml(baseUrl));
        console.log('✓ Built account bundle and page\n');

        // My Tanks page: a logged-in user's open + settled picks. Same
        // standalone-bundle pattern as account (all data client-side, /api/picks/mine).
        console.log('Building my-tanks bundle...');
        await buildMyTanks();
        writeHtmlFile('my-tanks/index.html', generateMyTanksPageHtml(baseUrl));
        console.log('✓ Built my-tanks bundle and page\n');

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
        // /about/ has been 301'd to / since the relaunch (see generate-redirects.ts), so
        // this page is unreachable - but it kept being written on every build, shipping a
        // stale description of the old "sports intelligence platform" product into dist/.
        // Gated with the rest of the legacy site rather than deleted, so a LEGACY_BUILD
        // run still reproduces the old output exactly.
        if (LEGACY_BUILD) {
            const aboutPath = 'about/index.html';
            writeHtmlFile(aboutPath, aboutHtml);
            console.log('✓ Generated about page\n');
        }
        
        // Build both Tank client bundles together (shared chunk extraction - see
        // build-tank-bundles.ts) before either piece of Tank HTML that references them.
        // Caught separately so a bundler failure doesn't take down the rest of the
        // static build (matches the existing warn-and-continue behavior below).
        console.log('Building Tank bundles...');
        try {
            await buildTankBundles();
        } catch (error: any) {
            console.warn('⚠ Warning: Failed to build Tank bundles:', error.message);
        }

        // Generate Tank article pages (published only)
        console.log('Generating Tank articles...');
        const tankArticleUrls: Array<{ loc: string; lastmod: string; changefreq: string; priority: string }> = [];
        // Populated below if the tank_pages query succeeds; stays empty otherwise so
        // the-tank page still generates (with its empty state) even if that table
        // isn't ready yet - it's a primary nav destination from the world map and
        // must never 404.
        let tankEntries: TankPageEntry[] = [];
        // Same rows, reused for the homepage fallback below (all rows here already
        // satisfy the public predicate: published + visibility='app' + slug + output).
        let homepageRows: HomepageTankRow[] = [];
        try {
            const tankPagesResult = await pool.query(
                `SELECT id, slug, league, angle, game_snapshot, model_output, created_at, updated_at, published_at
                 FROM tank_pages
                 WHERE status = 'published' AND visibility = 'app' AND slug IS NOT NULL AND model_output IS NOT NULL`
            );
            // Map every row up front - the canonical clustering below needs to see the
            // whole set before any page can be rendered.
            const tankPages: TankPageRecord[] = tankPagesResult.rows.map(row => ({
                id: row.id,
                slug: row.slug,
                league: row.league,
                angle: row.angle,
                game_snapshot: row.game_snapshot,
                model_output: row.model_output,
                created_at: row.created_at,
                updated_at: row.updated_at,
                published_at: row.published_at,
            }));

            const canonicalBySlug = buildCanonicalClusters(tankPages);

            let cardFailures = 0;
            for (const tankPage of tankPages) {
                const row = tankPage;
                // Two renders of the same card (scripts/generate-og-image.ts), from one
                // set of copy: the 'social' PNG is the og:image a crawler unfurls, and
                // the 'article' WebP is the matchup image the page itself shows under
                // its headline. Independent try/catch each, so one failing doesn't cost
                // the reader the other. Failure degrades that surface only - the social
                // card falls back to the site-wide placeholder (renderHead's default)
                // and the page simply omits its figure - never a broken image, and
                // never a failed build for one bad row.
                const { prop, game } = tankPage.game_snapshot;
                const cardData = {
                    league: tankPage.league,
                    contextLabel: truncateHeaderLabel(`${game.league} · ${prop.player}`),
                    tagline: truncateHeaderLabel(tankPage.model_output.tagline || deriveTaglineFallback(tankPage.model_output.hook)),
                    hook: tankPage.model_output.hook,
                    sides: tankPage.model_output.call.sides,
                    oddsOrMarketLabel: truncateHeaderLabel(formatOddsLabel(prop.odds) ?? formatMarketLabel(prop.market)),
                    settleDateLabel: truncateHeaderLabel(formatSettleDate(effectiveSettleDate(prop, game) ?? '')),
                };

                // JPEG, not the raw PNG resvg hands back: the card is photographic
                // artwork, so lossless bought nothing and cost ~1MB a share - enough
                // that size-capped unfurlers (WhatsApp especially) dropped the preview
                // rather than showing it. q85 lands the same picture in ~107KB. JPEG
                // rather than WebP for the same reason og-share-world-map.jpg is a
                // JPG - see renderHead's note on inconsistent WebP unfurling.
                let ogImageUrl: string | undefined;
                try {
                    const socialPng = await generateOgImage(cardData, 'social');
                    writeBinaryFile(`assets/og/${row.slug}.jpg`, await sharp(socialPng).flatten({ background: '#0b0713' }).jpeg({ quality: 85 }).toBuffer());
                    ogImageUrl = `${baseUrl}/assets/og/${row.slug}.jpg`;
                } catch (error: any) {
                    cardFailures++;
                    console.warn(`⚠ Social card generation failed for ${row.slug}, falling back to the default share image:`, error.message);
                }

                // WebP, not the raw PNG: resvg emits ~1MB of unoptimized RGBA, which is
                // the wrong thing to put near the top of an article. Same encoder the
                // landing art uses (sharp q82) takes it to ~40KB. The og:image above
                // stays PNG deliberately - see renderHead's note on unfurlers and WebP.
                let articleImageUrl: string | undefined;
                try {
                    const articlePng = await generateOgImage(cardData, 'article');
                    writeBinaryFile(`assets/og/${row.slug}-article.webp`, await sharp(articlePng).webp({ quality: 82 }).toBuffer());
                    articleImageUrl = `/assets/og/${row.slug}-article.webp`;
                } catch (error: any) {
                    cardFailures++;
                    console.warn(`⚠ Article card generation failed for ${row.slug}, the page will render without its matchup image:`, error.message);
                }

                const html = generateTankArticlePage(tankPage, baseUrl, ogImageUrl, canonicalBySlug.get(row.slug), articleImageUrl);
                writeHtmlFile(`the-tank/articles/${row.slug}/index.html`, html);
                // Consolidated articles stay in the sitemap on purpose. Google has to
                // fetch a duplicate to see its canonical tag, and with the hub listing
                // filtered to upcoming kickoffs these pages have no internal links left
                // to be recrawled through - dropping them here would strand the signal.
                tankArticleUrls.push({
                    loc: `${baseUrl}/the-tank/articles/${row.slug}/`,
                    lastmod: new Date(row.published_at || row.created_at).toISOString().split('T')[0],
                    changefreq: 'weekly',
                    priority: '0.6',
                });
            }
            console.log(`✓ Generated ${tankPages.length} Tank articles\n`);
            // One summary line instead of leaving single warnings buried in a 69-article
            // scroll. Every card failing is a different kind of problem from one failing
            // - it means the renderer itself is broken (missing fonts, resvg/sharp not
            // installed), and shipping a whole corpus of placeholder-shared,
            // image-less articles silently is worse than failing the build.
            const cardsExpected = tankPages.length * 2;
            if (cardFailures >= cardsExpected && cardsExpected > 0) {
                throw new Error(
                    `All ${cardsExpected} matchup card renders failed - the card renderer is broken, ` +
                    `not the content. Check the fonts in scripts/assets/fonts and that satori/resvg/sharp installed.`
                );
            }
            if (cardFailures > 0) {
                console.warn(`⚠ ${cardFailures} of ${cardsExpected} matchup card renders failed (see the warnings above)\n`);
            }
            pruneStaleTankArticles(tankPages.map(p => p.slug));
            homepageRows = tankPages as unknown as HomepageTankRow[];

            // Active feed for the-tank's carousel: published pages whose game hasn't
            // happened yet, soonest first. Reuses the rows already fetched above.
            const now = Date.now();
            const activeTankPages = tankPages.filter(p => {
                const kickoff = new Date(p.game_snapshot?.game?.kickoff || '').getTime();
                return !isNaN(kickoff) && kickoff > now;
            });
            tankEntries = activeTankPages.map(p => {
                const { prop, game } = p.game_snapshot;
                return {
                    slug: p.slug,
                    league: p.league,
                    matchup: `${game.away} @ ${game.home}`,
                    payload: {
                        hook: p.model_output.hook,
                        cards: p.model_output.cards,
                        call: {
                            ...p.model_output.call,
                            sidesImpliedProb: deriveSidesImpliedProb(prop.odds, p.model_output.call.sides.length),
                        },
                        tagline: truncateHeaderLabel(p.model_output.tagline || deriveTaglineFallback(p.model_output.hook)),
                        contextLabel: truncateHeaderLabel(`${game.league} · ${prop.player}`),
                        oddsOrMarketLabel: truncateHeaderLabel(formatOddsLabel(prop.odds) ?? formatMarketLabel(prop.market)),
                        settleDateLabel: truncateHeaderLabel(formatSettleDate(effectiveSettleDate(prop, game) ?? '')),
                        gameTimeLabel: truncateHeaderLabel(formatGameTime(game.kickoff)),
                        kickoff: game.kickoff,
                    },
                };
            });
        } catch (error: any) {
            console.warn('⚠ Warning: Failed to generate Tank articles (tank_pages table may not exist yet):', error.message);
        }

        // Generate the tank-world pages (unconditionally - /the-tank/ is a primary
        // nav destination from the world map, so it must exist even if tankEntries
        // came back empty):
        //   /the-tank/     - Tank Land hub (navigation artwork)
        //   /the-tank-hq/  - the story browser (formerly at /the-tank/); also the
        //                    site's one real, crawlable Tank hub - see
        //                    generateFallbackSection() inside tank-template.ts.
        //   /the-hatchery/ - egg shop + incubator
        //   /champions-terrace/, /quickboost-delicacies/ - the two food shops
        //   /tankdaq/      - the exchange floor (hover-preview scene for now)
        console.log('Generating tank-world pages...');
        writeHtmlFile('the-tank/index.html', generateTankLandPageHtml(baseUrl));
        writeHtmlFile('the-tank-hq/index.html', generateTankPageHtml(baseUrl, tankEntries));
        writeHtmlFile('the-hatchery/index.html', generateHatcheryPageHtml(baseUrl));
        writeHtmlFile('champions-terrace/index.html', generateFoodShopPageHtml(baseUrl, {
            path: '/champions-terrace/',
            title: "Champion's Lakeside Terrace | Heatchecks",
            heading: "Champion's Lakeside Terrace",
            description: 'Hearty plates by the lake - feed your Mud Puppy like a champion.',
            rootId: 'champions-terrace-root',
            scriptName: 'champions-terrace',
        }));
        writeHtmlFile('quickboost-delicacies/index.html', generateFoodShopPageHtml(baseUrl, {
            path: '/quickboost-delicacies/',
            title: 'Quickboost Delicacies | Heatchecks',
            heading: 'Quickboost Delicacies',
            description: 'Light bites and shakes - quick boosts for your Mud Puppy.',
            rootId: 'quickboost-root',
            scriptName: 'quickboost-delicacies',
        }));
        // TANKDAQ floor (own template since the INDEX PRICES sign links to the Index
        // Board; Beaks the Broker stays a hover-only preview).
        writeHtmlFile('tankdaq/index.html', generateTankdaqPageHtml(baseUrl));

        // Tagged-template -> pg adapter: interleaves the literal parts with $1..$n
        // placeholders so lib/pages-functions/tickers.ts's SqlReader helpers run
        // verbatim against the build-time pg pool. Shared by the TANKDAQ index pages
        // here and the homepage Market Movers fallback below.
        const sqlPg: SqlReader = async (strings, ...values) => {
            const text = strings.reduce((acc, part, i) => acc + `$${i}` + part);
            return (await pool.query(text, values as unknown[])).rows;
        };

        // TANKDAQ index pages: the Index Board heatmap plus one detail page per active
        // ticker. Shells only - live numbers come from /api/tickers* client-side - but
        // the ticker registry drives which pages exist, so a DB failure degrades to
        // "no index pages this build" (same warn-and-continue posture as the bundles).
        try {
            const tickerRows = (await getTickerValues(sqlPg)).map((t) => ({
                key: t.key,
                displayName: t.displayName,
                indexLabel: indexLabelOf(t.ruleType),
                description: t.description,
                ruleType: t.ruleType, // keys the friendly page copy (ticker-copy.ts)
            }));
            writeHtmlFile('tankdaq/indexes/index.html', generateTankdaqIndexesPageHtml(baseUrl, tickerRows));
            for (const ticker of tickerRows) {
                writeHtmlFile(`tankdaq/${ticker.key}/index.html`, generateTankdaqTickerPageHtml(baseUrl, ticker));
            }
            console.log(`✓ Generated TANKDAQ Index Board + ${tickerRows.length} index detail page(s)`);
        } catch (err) {
            console.warn('⚠ Ticker registry unavailable; skipping TANKDAQ index pages:', (err as Error).message);
        }
        // Note: all of these URLs are hardcoded sitemap entries in sitemap.ts - not
        // pushed here too, to avoid duplicate <url> entries.
        console.log(`✓ Generated Tank Land, Tank HQ (${tankEntries.length} tank(s)), and Hatchery pages\n`);

        // Homepage: the build-time, logged-out fallback of the server-rendered
        // homepage (functions/index.ts renders the live version per request and takes
        // routing precedence over this file). Same renderHomepage() template, same
        // mappers, fed from the rows fetched above. Market Movers runs the SAME query
        // helpers the live page and /api/tickers use, adapted onto pg via sqlPg below
        // (one source of SQL truth); a failure (e.g. an env whose ticker tables don't
        // exist yet) degrades to the empty section, never a broken build.
        console.log('Generating homepage (logged-out SSR fallback)...');
        // sqlPg (defined with the TANKDAQ index pages above) adapts the SqlReader
        // helpers onto the build-time pg pool - one source of SQL truth.
        let marketMovers = emptyMarketMovers();
        try {
            const [tickerValues, tickerSeries, tickerNews, tickerResults] = await Promise.all([
                getTickerValues(sqlPg), getTickerSeries(sqlPg), getTickerNews(sqlPg, 2), getTickerResults(sqlPg, 3),
            ]);
            marketMovers = toMarketMovers(tickerValues, tickerSeries, tickerNews, tickerResults);
        } catch (err) {
            console.warn('⚠ Ticker data unavailable for homepage fallback; rendering empty Market Movers:', (err as Error).message);
        }
        const homepageData = homepageRows.length > 0
            ? { sportSlots: pickLiveTankPerSport(filterAndSortLiveRows(homepageRows)), marketMovers }
            : { ...emptyHomepageData(), marketMovers };
        writeHtmlFile('index.html', renderHomepage({ baseUrl, user: null, data: homepageData }));
        console.log('✓ Generated homepage fallback\n');

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
        generateSitemap(posts, baseUrl, 'dist/sitemap.xml', tankArticleUrls);
        // Also write to public/ for local development
        generateSitemap(posts, baseUrl, 'public/sitemap.xml', tankArticleUrls);
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
