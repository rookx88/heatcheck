import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function deleteLaLigaMatchups() {
  try {
    console.log('🔍 Checking for La Liga matchups after 2026-02-06...\n');

    // First, check what we're about to delete
    const checkResult = await pool.query(`
      SELECT 
        m.id,
        m.league,
        m.scheduled_date,
        m.scheduled_time,
        ta.name as team_a_name,
        tb.name as team_b_name
      FROM matchups m
      JOIN teams ta ON m.team_a_id = ta.id
      JOIN teams tb ON m.team_b_id = tb.id
      WHERE m.league = 'La Liga'
        AND m.scheduled_date > '2026-02-06'
      ORDER BY m.scheduled_date ASC, m.scheduled_time ASC
    `);

    if (checkResult.rows.length === 0) {
      console.log('✅ No La Liga matchups found after 2026-02-06');
      await pool.end();
      return;
    }

    console.log(`Found ${checkResult.rows.length} La Liga matchup(s) to delete:\n`);
    checkResult.rows.forEach((row, i) => {
      console.log(`${i + 1}. ${row.team_a_name} vs ${row.team_b_name}`);
      console.log(`   Date: ${row.scheduled_date} ${row.scheduled_time || ''}`);
      console.log(`   ID: ${row.id}\n`);
    });

    // Delete the matchups
    const deleteResult = await pool.query(`
      DELETE FROM matchups
      WHERE league = 'La Liga'
        AND scheduled_date > '2026-02-06'
      RETURNING id
    `);

    console.log(`\n✅ Successfully deleted ${deleteResult.rows.length} La Liga matchup(s)`);
    console.log('You can now re-import La Liga matchups with the corrected timezone conversion.');

    await pool.end();
  } catch (error: any) {
    console.error('❌ Error deleting La Liga matchups:', error.message);
    await pool.end();
    process.exit(1);
  }
}

deleteLaLigaMatchups();

