// One-off script: pushes every waitlist row that already has newsletter_opt_in = true
// into the Resend Audience. Needed once, for signups that opted in before contact sync
// existed in functions/api/newsletter-optin.ts (this script only ever needs to run once
// per pre-existing backlog - new opt-ins sync live going forward).
//
// Run: npx tsx scripts/backfill-resend-audience.ts

import { Pool } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

import { upsertResendAudienceContact } from '../lib/resend-audience';

async function main() {
    const apiKey = process.env.RESEND_API_KEY;
    const audienceId = process.env.RESEND_AUDIENCE_ID;
    if (!apiKey || !audienceId) {
        console.error('RESEND_API_KEY and RESEND_AUDIENCE_ID must both be set.');
        process.exit(1);
    }

    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
        const result = await pool.query(
            `SELECT email FROM waitlist WHERE newsletter_opt_in = true`
        );
        console.log(`Backfilling ${result.rows.length} contact(s)...`);

        let succeeded = 0;
        let failed = 0;
        for (const row of result.rows) {
            try {
                await upsertResendAudienceContact(apiKey, audienceId, row.email);
                succeeded++;
            } catch (err: any) {
                failed++;
                console.error(`  Failed for ${row.email}:`, err.message);
            }
        }
        console.log(`Done. ${succeeded} succeeded, ${failed} failed.`);
    } finally {
        await pool.end();
    }
}

main();
