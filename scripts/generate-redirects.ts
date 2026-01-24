import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { normalizeLeague } from './utils/date-formatter';
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
    websiteStory: {
        seo: {
            slug: string;
            previousSlugs?: string[];
        };
    };
}

/**
 * Generate redirects file from posts with previousSlugs
 * Format: /{oldPath} /{newPath} 301
 */
export async function generateRedirectsFile(
    outputPath: string = 'public/_redirects'
): Promise<void> {
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
    });

    try {
        // Fetch all published posts
        const result = await pool.query(`
            SELECT data 
            FROM posts 
            WHERE data->>'status' = 'published'
            ORDER BY (data->>'updatedAt') DESC
        `);

        const posts: HeatcheckPost[] = result.rows.map(row => row.data);
        const redirects: string[] = [];

        for (const post of posts) {
            const currentSlug = post.websiteStory?.seo?.slug || '';
            const previousSlugs = post.websiteStory?.seo?.previousSlugs || [];
            const league = normalizeLeague(post.league);

            if (!currentSlug) continue;

            // Determine new path (canonical URL)
            const isPredictionFormat = currentSlug.includes('-prediction-preview-') && currentSlug.match(/\d{4}-\d{2}-\d{2}$/);
            const newPath = isPredictionFormat 
                ? `/${league}/${currentSlug}/`
                : null; // Old format - don't generate redirects for it (it's the fallback)

            if (!newPath) continue; // Skip if not in prediction format

            // Generate redirects for each previous slug
            for (const oldSlug of previousSlugs) {
                if (!oldSlug || oldSlug === currentSlug) continue;

                // Determine old path format
                const oldIsPrediction = oldSlug.includes('-prediction-preview-') && oldSlug.match(/\d{4}-\d{2}-\d{2}$/);
                let oldPath: string;

                if (oldIsPrediction) {
                    // Old slug was also in prediction format
                    oldPath = `/${league}/${oldSlug}/`;
                } else if (oldSlug.includes('/') && oldSlug.split('/').length === 2) {
                    // Old format: matchup-slug/narrative-slug
                    const date = post.matchupScheduledDate 
                        ? new Date(post.matchupScheduledDate).toISOString().split('T')[0]
                        : new Date(post.createdAt).toISOString().split('T')[0];
                    oldPath = `/${league}/${date}/${oldSlug}/`;
                } else {
                    // Fallback: try to construct from old slug
                    const date = post.matchupScheduledDate 
                        ? new Date(post.matchupScheduledDate).toISOString().split('T')[0]
                        : new Date(post.createdAt).toISOString().split('T')[0];
                    oldPath = `/${league}/${date}/${oldSlug}/`;
                }

                // Add redirect entry
                redirects.push(`${oldPath} ${newPath} 301`);
            }
        }

        // Write redirects file
        const redirectsContent = redirects.join('\n') + '\n';
        const outputDir = path.dirname(outputPath);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        fs.writeFileSync(outputPath, redirectsContent, 'utf-8');

        console.log(`✓ Generated ${redirects.length} redirect entries in ${outputPath}`);
    } catch (error: any) {
        console.error('Error generating redirects:', error);
        throw error;
    } finally {
        await pool.end();
    }
}

// Run if called directly (ES module check)
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('generate-redirects.ts')) {
    generateRedirectsFile()
        .then(() => {
            console.log('Redirect generation completed');
            process.exit(0);
        })
        .catch((error) => {
            console.error('Redirect generation failed:', error);
            process.exit(1);
        });
}

