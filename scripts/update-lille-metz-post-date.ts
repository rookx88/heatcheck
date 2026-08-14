import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function updateLilleMetzPostDate() {
  try {
    console.log('🔍 Searching for Lille vs Metz post...\n');

    // First, find the post (posts table uses JSONB)
    const findResult = await pool.query(`
      SELECT 
        id,
        data->>'teamA' as "teamA",
        data->>'teamB' as "teamB",
        data->>'league' as league,
        data->>'matchupScheduledDate' as "matchupScheduledDate",
        data->>'status' as status,
        "createdAt"
      FROM posts
      WHERE (
        (data->>'teamA' ILIKE '%Lille%' AND data->>'teamB' ILIKE '%Metz%')
        OR (data->>'teamA' ILIKE '%Metz%' AND data->>'teamB' ILIKE '%Lille%')
      )
      AND data->>'league' = 'Ligue 1'
      ORDER BY "createdAt" DESC
      LIMIT 5
    `);

    if (findResult.rows.length === 0) {
      console.log('❌ No Lille vs Metz post found');
      await pool.end();
      return;
    }

    console.log(`Found ${findResult.rows.length} post(s):\n`);
    findResult.rows.forEach((row, i) => {
      console.log(`${i + 1}. ${row.teamA} vs ${row.teamB}`);
      console.log(`   ID: ${row.id}`);
      console.log(`   Status: ${row.status}`);
      console.log(`   Current Date: ${row.matchupScheduledDate || 'null'}`);
      console.log(`   Created: ${row.createdAt}`);
      console.log('');
    });

    // Update the most recent one (or all if multiple)
    const postToUpdate = findResult.rows[0];
    console.log(`Updating post ${postToUpdate.id}...\n`);

    // Get current data, update matchupScheduledDate in JSONB
    const currentDataResult = await pool.query(`
      SELECT data FROM posts WHERE id = $1
    `, [postToUpdate.id]);

    if (currentDataResult.rows.length === 0) {
      console.log('❌ Post not found');
      await pool.end();
      return;
    }

    const currentData = currentDataResult.rows[0].data;
    currentData.matchupScheduledDate = '2026-02-06';

    const updateResult = await pool.query(`
      UPDATE posts
      SET data = $1,
          "updatedAt" = NOW()
      WHERE id = $2
      RETURNING id, data->>'teamA' as "teamA", data->>'teamB' as "teamB", data->>'matchupScheduledDate' as "matchupScheduledDate"
    `, [JSON.stringify(currentData), postToUpdate.id]);

    if (updateResult.rows.length > 0) {
      const updated = updateResult.rows[0];
      console.log('✅ Successfully updated:');
      console.log(`   ${updated.teamA} vs ${updated.teamB}`);
      console.log(`   New Date: ${updated.matchupScheduledDate}`);
    } else {
      console.log('❌ Update failed');
    }

    await pool.end();
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    await pool.end();
    process.exit(1);
  }
}

updateLilleMetzPostDate();

