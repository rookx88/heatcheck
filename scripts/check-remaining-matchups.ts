import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function checkRemainingMatchups() {
  try {
    console.log('🔍 Checking for remaining La Liga and Ligue 1 matchups after 2/6...\n');

    const result = await pool.query(`
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
      WHERE m.league IN ('La Liga', 'Ligue 1')
        AND m.scheduled_date > '2026-02-06'
      ORDER BY m.league ASC, m.scheduled_date ASC, m.scheduled_time ASC
    `);

    if (result.rows.length > 0) {
      console.log(`Found ${result.rows.length} remaining matchup(s):\n`);
      result.rows.forEach((row, i) => {
        console.log(`${i + 1}. ${row.team_a_name} vs ${row.team_b_name}`);
        console.log(`   League: ${row.league}`);
        console.log(`   Date: ${row.scheduled_date} ${row.scheduled_time || ''}`);
        console.log(`   ID: ${row.id}\n`);
      });
    } else {
      console.log('✅ No matchups found - database is clean');
      console.log('\nThe matchups you see in the loader are coming from the soccer database.');
      console.log('You should be able to import them now with the corrected dates.');
    }

    await pool.end();
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    await pool.end();
    process.exit(1);
  }
}

checkRemainingMatchups();











