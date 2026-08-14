import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function checkRealSociedadElche() {
  try {
    console.log('🔍 Checking Real Sociedad vs Elche matches in matchups table...\n');

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
      WHERE m.league = 'La Liga'
        AND (
          (ta.name ILIKE '%Real Sociedad%' AND tb.name ILIKE '%Elche%')
          OR (ta.name ILIKE '%Elche%' AND tb.name ILIKE '%Real Sociedad%')
        )
        AND m.scheduled_date >= '2026-02-06'
        AND m.scheduled_date <= '2026-02-08'
      ORDER BY m.scheduled_date ASC, m.scheduled_time ASC
    `);

    if (result.rows.length > 0) {
      console.log(`Found ${result.rows.length} match(es):\n`);
      result.rows.forEach((row, i) => {
        console.log(`${i + 1}. ${row.team_a_name} vs ${row.team_b_name}`);
        console.log(`   ID: ${row.id}`);
        console.log(`   Current Date: ${row.scheduled_date}`);
        console.log(`   Current Time: ${row.scheduled_time || 'null'}`);
        console.log('');
      });
    } else {
      console.log('❌ No matches found in matchups table');
    }

    await pool.end();
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    await pool.end();
    process.exit(1);
  }
}

checkRealSociedadElche();











