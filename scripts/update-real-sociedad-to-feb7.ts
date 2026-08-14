import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function updateRealSociedadToFeb7() {
  try {
    console.log('🔧 Updating Real Sociedad vs Elche to 2/7...\n');

    // Update Real Sociedad vs Elche to 2/7 at 3:00 PM EST (12:00 PM PST)
    const update = await pool.query(`
      UPDATE matchups
      SET scheduled_date = '2026-02-07',
          scheduled_time = '15:00:00',
          updated_at = NOW()
      WHERE id = 'c2563bd6-2eaf-40a2-84ef-ea7e99efe49c'
      RETURNING id, scheduled_date, scheduled_time
    `);

    if (update.rows.length > 0) {
      console.log('✅ Updated Real Sociedad vs Elche:');
      console.log(`   Date: ${update.rows[0].scheduled_date}`);
      console.log(`   Time: ${update.rows[0].scheduled_time} (3:00 PM EST)`);
      console.log(`   This equals 12:00 PM PST on 2/7`);
    } else {
      console.log('❌ Real Sociedad vs Elche not found');
    }

    await pool.end();
    console.log('\n✅ Update complete!');
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    await pool.end();
    process.exit(1);
  }
}

updateRealSociedadToFeb7();











