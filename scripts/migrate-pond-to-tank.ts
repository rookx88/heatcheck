// One-off migration: renames the pond_pages table (and its indexes) to tank_pages,
// preserving all existing rows. Run manually via:
//   npx tsx scripts/migrate-pond-to-tank.ts
// Not added to package.json "scripts". Idempotent: no-ops cleanly if pond_pages
// doesn't exist (already migrated, or a fresh install that only ever had tank_pages).

import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
        const preflight = await pool.query(`SELECT to_regclass('public.pond_pages') AS exists`);
        if (!preflight.rows[0].exists) {
            console.log('pond_pages does not exist (already migrated, or fresh install) - nothing to do.');
            const check = await pool.query(`SELECT to_regclass('public.tank_pages') AS exists`);
            if (check.rows[0].exists) {
                const count = await pool.query('SELECT count(*) FROM tank_pages');
                console.log(`tank_pages exists with ${count.rows[0].count} row(s).`);
            }
            return;
        }

        await pool.query('BEGIN');
        try {
            await pool.query('ALTER TABLE pond_pages RENAME TO tank_pages');
            await pool.query('ALTER INDEX idx_pond_pages_slug RENAME TO idx_tank_pages_slug');
            await pool.query('ALTER INDEX idx_pond_pages_status RENAME TO idx_tank_pages_status');
            await pool.query('ALTER INDEX idx_pond_pages_league RENAME TO idx_tank_pages_league');
            await pool.query('ALTER INDEX idx_pond_pages_created_at RENAME TO idx_tank_pages_created_at');
            await pool.query('COMMIT');
        } catch (err) {
            await pool.query('ROLLBACK');
            throw err;
        }

        const count = await pool.query('SELECT count(*) FROM tank_pages');
        console.log(`✓ Migrated pond_pages -> tank_pages. ${count.rows[0].count} row(s) survived.`);
    } finally {
        await pool.end();
    }
}

main().catch(error => {
    console.error('Fatal error migrating pond_pages to tank_pages:', error);
    process.exit(1);
});
