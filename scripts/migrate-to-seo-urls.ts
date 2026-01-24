import { Pool } from 'pg';
import dotenv from 'dotenv';
import { rewriteArticleForSEO } from './services/seoRewriteService';
import { generatePredictionSlug } from './utils/slug-generator';

// Load environment variables
if (!process.env.DATABASE_URL && !process.env.CI) {
    try {
        dotenv.config({ path: '.env.local' });
    } catch (err) {
        // Silently ignore if .env.local doesn't exist
    }
}

interface HeatcheckPost {
    id: string;
    league: string;
    teamA: string;
    teamB: string;
    matchupScheduledDate?: string;
    createdAt: string;
    status: 'draft' | 'published';
    websiteStory: {
        headline: string;
        dek: string;
        theBackstory: string;
        seo: {
            slug: string;
            metaTitle: string;
            metaDescription: string;
            previousSlugs?: string[];
        };
    };
    heatCheckData?: {
        factPack?: any;
        article?: {
            long_form_markdown?: string;
        };
    };
}

/**
 * Migrate all published posts to SEO-optimized URLs
 * This will:
 * 1. Generate SEO rewrites for each published post
 * 2. Track old slugs in previousSlugs
 * 3. Update posts with new SEO format
 * 4. Preserve old URLs via redirects
 */
async function migrateToSEOUrls(
    dryRun: boolean = false,
    batchSize: number = 5,
    delayBetweenBatches: number = 2000
): Promise<void> {
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
    });

    try {
        // Fetch all published posts
        console.log('Fetching all published posts...');
        const result = await pool.query(`
            SELECT data 
            FROM posts 
            WHERE data->>'status' = 'published'
            ORDER BY (data->>'createdAt') DESC
        `);

        const posts: HeatcheckPost[] = result.rows.map(row => row.data);
        console.log(`Found ${posts.length} published posts to migrate\n`);

        if (posts.length === 0) {
            console.log('No published posts to migrate.');
            return;
        }

        // Filter out posts that already have prediction format slugs
        const postsToMigrate = posts.filter(post => {
            const currentSlug = post.websiteStory?.seo?.slug || '';
            const isAlreadyPredictionFormat = currentSlug.includes('-prediction-preview-') && currentSlug.match(/\d{4}-\d{2}-\d{2}$/);
            return !isAlreadyPredictionFormat;
        });

        console.log(`${postsToMigrate.length} posts need migration (${posts.length - postsToMigrate.length} already have prediction format)\n`);

        if (postsToMigrate.length === 0) {
            console.log('All posts already migrated!');
            return;
        }

        if (dryRun) {
            console.log('🔍 DRY RUN MODE - No changes will be saved\n');
        }

        let successCount = 0;
        let errorCount = 0;
        const errors: Array<{ id: string; headline: string; error: string }> = [];

        // Process in batches to avoid overwhelming the AI API
        for (let i = 0; i < postsToMigrate.length; i += batchSize) {
            const batch = postsToMigrate.slice(i, i + batchSize);
            const batchNum = Math.floor(i / batchSize) + 1;
            const totalBatches = Math.ceil(postsToMigrate.length / batchSize);

            console.log(`\n📦 Processing batch ${batchNum}/${totalBatches} (${batch.length} posts)...`);

            for (const post of batch) {
                try {
                    const postIndex = postsToMigrate.indexOf(post) + 1;
                    console.log(`\n[${postIndex}/${postsToMigrate.length}] Processing: ${post.websiteStory.headline.substring(0, 50)}...`);

                    // Get current slug (old format)
                    const currentSlug = post.websiteStory.seo?.slug || '';
                    const oldSlug = currentSlug;

                    // Generate SEO rewrite
                    console.log('  → Generating SEO rewrite...');
                    const rewrite = await rewriteArticleForSEO(post, post.heatCheckData?.factPack);

                    // Build previousSlugs array
                    const previousSlugs = post.websiteStory.seo?.previousSlugs || [];
                    if (oldSlug && oldSlug !== rewrite.seoSlug && !previousSlugs.includes(oldSlug)) {
                        previousSlugs.push(oldSlug);
                    }

                    // Update post data
                    const updatedPost: HeatcheckPost = {
                        ...post,
                        websiteStory: {
                            ...post.websiteStory,
                            headline: rewrite.h1Header,
                            theBackstory: rewrite.rewrittenBody,
                            seo: {
                                slug: rewrite.seoSlug,
                                metaTitle: rewrite.seoTitle,
                                metaDescription: rewrite.metaDescription,
                                previousSlugs: previousSlugs
                            }
                        },
                        heatCheckData: {
                            ...post.heatCheckData,
                            article: {
                                ...post.heatCheckData?.article,
                                long_form_markdown: rewrite.rewrittenBody // Sync from theBackstory
                            }
                        },
                        updatedAt: new Date().toISOString()
                    };

                    if (!dryRun) {
                        // Save to database
                        await pool.query(
                            'UPDATE posts SET data = $1, "updatedAt" = $2 WHERE id = $3',
                            [updatedPost, updatedPost.updatedAt, post.id]
                        );
                        console.log(`  ✓ Saved: ${rewrite.seoSlug}`);
                    } else {
                        console.log(`  ✓ Would save: ${rewrite.seoSlug}`);
                        console.log(`    Old URL: /${post.league.toLowerCase()}/.../${oldSlug}/`);
                        console.log(`    New URL: /${post.league.toLowerCase()}/${rewrite.seoSlug}/`);
                    }

                    successCount++;
                } catch (error: any) {
                    errorCount++;
                    const errorMsg = error.message || 'Unknown error';
                    console.error(`  ✗ Error: ${errorMsg}`);
                    errors.push({
                        id: post.id,
                        headline: post.websiteStory.headline,
                        error: errorMsg
                    });
                }

                // Small delay between posts to avoid rate limiting
                if (i + batch.length < postsToMigrate.length) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }

            // Delay between batches
            if (i + batchSize < postsToMigrate.length) {
                console.log(`\n⏳ Waiting ${delayBetweenBatches}ms before next batch...`);
                await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
            }
        }

        // Summary
        console.log('\n' + '='.repeat(60));
        console.log('MIGRATION SUMMARY');
        console.log('='.repeat(60));
        console.log(`Total posts: ${posts.length}`);
        console.log(`Posts to migrate: ${postsToMigrate.length}`);
        console.log(`Already migrated: ${posts.length - postsToMigrate.length}`);
        console.log(`Successfully migrated: ${successCount}`);
        console.log(`Errors: ${errorCount}`);

        if (errors.length > 0) {
            console.log('\n❌ ERRORS:');
            errors.forEach((e, idx) => {
                console.log(`  ${idx + 1}. ${e.headline.substring(0, 50)}...`);
                console.log(`     Error: ${e.error}`);
            });
        }

        if (dryRun) {
            console.log('\n⚠️  This was a DRY RUN - no changes were saved.');
            console.log('   Run without --dry-run to actually migrate posts.');
        } else {
            console.log('\n✅ Migration complete!');
            console.log('   Next steps:');
            console.log('   1. Run "npm run build:static" to regenerate static site');
            console.log('   2. Verify redirects are working');
            console.log('   3. Check sitemap for new URLs');
        }
    } catch (error: any) {
        console.error('Migration failed:', error);
        throw error;
    } finally {
        await pool.end();
    }
}

// Run if called directly (ES module check)
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run') || args.includes('-d');
const batchSize = parseInt(args.find(arg => arg.startsWith('--batch-size='))?.split('=')[1] || '5', 10);
const delay = parseInt(args.find(arg => arg.startsWith('--delay='))?.split('=')[1] || '2000', 10);

// Always run if this file is executed directly
migrateToSEOUrls(dryRun, batchSize, delay)
    .then(() => {
        console.log('\nMigration script completed');
        process.exit(0);
    })
    .catch((error) => {
        console.error('Migration script failed:', error);
        process.exit(1);
    });

export { migrateToSEOUrls };

