import { Pool } from 'pg';
import dotenv from 'dotenv';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Load environment variables
if (!process.env.DATABASE_URL && !process.env.CI) {
    try {
        dotenv.config({ path: '.env.local' });
    } catch (err) {
        // Silently ignore if .env.local doesn't exist
    }
}

/**
 * Check migration progress and restart if stopped
 */
async function checkAndRestartMigration(): Promise<void> {
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
    });

    try {
        // Check current migration status
        const result = await pool.query(`
            SELECT 
                COUNT(*) as total,
                COUNT(CASE WHEN data->'websiteStory'->'seo'->>'slug' LIKE '%-prediction-preview-%' THEN 1 END) as migrated
            FROM posts 
            WHERE data->>'status' = 'published'
        `);

        const total = parseInt(result.rows[0].total);
        const migrated = parseInt(result.rows[0].migrated);
        const remaining = total - migrated;
        const progress = ((migrated / total) * 100).toFixed(1);

        console.log(`\n[${new Date().toLocaleTimeString()}] Migration Status:`);
        console.log(`  Total: ${total} posts`);
        console.log(`  Migrated: ${migrated} posts`);
        console.log(`  Remaining: ${remaining} posts`);
        console.log(`  Progress: ${progress}%`);

        if (remaining === 0) {
            console.log('\n✅ Migration complete! All posts have been migrated.');
            return;
        }

        // Check if migration process is running
        try {
            const { stdout } = await execAsync('ps aux | grep -i "migrate-to-seo" | grep -v grep || echo ""');
            const isRunning = stdout.trim().length > 0;

            if (!isRunning && remaining > 0) {
                console.log('\n⚠️  Migration process not running. Restarting...');
                
                // Start migration in background
                const command = 'npm run migrate:seo';
                exec(command, { 
                    cwd: process.cwd(),
                    env: { ...process.env },
                    detached: true,
                    stdio: 'ignore'
                }, (error) => {
                    if (error) {
                        console.error('Failed to restart migration:', error.message);
                    } else {
                        console.log('✅ Migration restarted in background');
                    }
                });
                
                // Detach the process
                process.unref();
            } else if (isRunning) {
                console.log('✓ Migration process is running');
            }
        } catch (error: any) {
            // If check fails, try to restart anyway
            console.log('\n⚠️  Could not verify if migration is running. Attempting restart...');
            const command = 'npm run migrate:seo';
            exec(command, { 
                cwd: process.cwd(),
                env: { ...process.env },
                detached: true,
                stdio: 'ignore'
            });
            process.unref();
        }

    } catch (error: any) {
        console.error('Error checking migration:', error.message);
    } finally {
        await pool.end();
    }
}

// Run check every 30 seconds
const checkInterval = 30000; // 30 seconds

async function monitorLoop() {
    while (true) {
        await checkAndRestartMigration();
        await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
}

// Start monitoring
monitorLoop().catch(error => {
    console.error('Monitoring failed:', error);
    process.exit(1);
});

