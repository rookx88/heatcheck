import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function updateMatchupDates() {
  try {
    console.log('🔧 Updating matchup dates and times...\n');

    // Update Real Sociedad vs Elche to 2/6 at 3:00 PM EST (12:00 PM PST)
    const update1 = await pool.query(`
      UPDATE matchups
      SET scheduled_date = '2026-02-06',
          scheduled_time = '15:00:00',
          updated_at = NOW()
      WHERE id = 'c2563bd6-2eaf-40a2-84ef-ea7e99efe49c'
      RETURNING id, scheduled_date, scheduled_time
    `);

    if (update1.rows.length > 0) {
      console.log('✅ Updated Real Sociedad vs Elche:');
      console.log(`   Date: ${update1.rows[0].scheduled_date}`);
      console.log(`   Time: ${update1.rows[0].scheduled_time}`);
    } else {
      console.log('❌ Real Sociedad vs Elche not found');
    }

    // Check for Celta Vigo vs Osasuna
    const checkCelta = await pool.query(`
      SELECT 
        m.id,
        m.scheduled_date,
        m.scheduled_time,
        ta.name as team_a_name,
        tb.name as team_b_name
      FROM matchups m
      JOIN teams ta ON m.team_a_id = ta.id
      JOIN teams tb ON m.team_b_id = tb.id
      WHERE m.league = 'La Liga'
        AND (
          (ta.name ILIKE '%Celta%' AND tb.name ILIKE '%Osasuna%')
          OR (ta.name ILIKE '%Osasuna%' AND tb.name ILIKE '%Celta%')
        )
        AND m.scheduled_date >= '2026-02-06'
        AND m.scheduled_date <= '2026-02-08'
      ORDER BY m.scheduled_date ASC
      LIMIT 1
    `);

    if (checkCelta.rows.length > 0) {
      const celtaMatch = checkCelta.rows[0];
      console.log(`\n📋 Found Celta Vigo vs Osasuna:`);
      console.log(`   ID: ${celtaMatch.id}`);
      console.log(`   Current Date: ${celtaMatch.scheduled_date}`);
      console.log(`   Current Time: ${celtaMatch.scheduled_time || 'null'}`);
      
      // Update to 2/6 at 3:00 PM EST (12:00 PM PST)
      const update2 = await pool.query(`
        UPDATE matchups
        SET scheduled_date = '2026-02-06',
            scheduled_time = '15:00:00',
            updated_at = NOW()
        WHERE id = $1
        RETURNING id, scheduled_date, scheduled_time
      `, [celtaMatch.id]);

      if (update2.rows.length > 0) {
        console.log('✅ Updated Celta Vigo vs Osasuna:');
        console.log(`   Date: ${update2.rows[0].scheduled_date}`);
        console.log(`   Time: ${update2.rows[0].scheduled_time}`);
      }
    } else {
      console.log('\n⚠️  Celta Vigo vs Osasuna not found in matchups table');
    }

    await pool.end();
    console.log('\n✅ Update complete!');
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    await pool.end();
    process.exit(1);
  }
}

updateMatchupDates();











