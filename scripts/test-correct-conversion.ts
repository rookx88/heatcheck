import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const soccerDataPool: Pool | null = process.env.SOCCER_DATA_DATABASE_URL
  ? new Pool({ connectionString: process.env.SOCCER_DATA_DATABASE_URL })
  : null;

async function testCorrectConversion() {
  if (!soccerDataPool) {
    console.error('❌ SOCCER_DATA_DATABASE_URL is not configured');
    process.exit(1);
  }

  try {
    console.log('🔍 Testing correct timezone conversion pattern...\n');

    // Test with Alaves vs Getafe (should be 5:00 AM PST = 8:00 AM EST)
    const result = await soccerDataPool.query(`
      SELECT 
        m.date_utc,
        ht.team_name_std as home_team,
        at.team_name_std as away_team,
        -- Current (wrong) conversion
        to_char((m.date_utc AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') as current_est_date,
        to_char(m.date_utc AT TIME ZONE 'America/New_York', 'HH24:MI') as current_est_time,
        -- Correct conversion: first to UTC, then to EST
        to_char(((m.date_utc AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') as correct_est_date,
        to_char((m.date_utc AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York', 'HH24:MI') as correct_est_time,
        -- Also show PST for reference
        to_char((m.date_utc AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles', 'HH24:MI') as correct_pst_time
      FROM public.matches m
      JOIN public.dim_team ht ON ht.team_id = m.home_team_id
      JOIN public.dim_team at ON at.team_id = m.away_team_id
      WHERE m.league = 'ESP-La Liga'
        AND (m.date_utc AT TIME ZONE 'Europe/Madrid')::date = '2026-02-08'
        AND ht.team_name_std ILIKE '%Alaves%'
        AND at.team_name_std ILIKE '%Getafe%'
      LIMIT 1
    `);

    if (result.rows.length > 0) {
      const row = result.rows[0];
      console.log(`${row.home_team} vs ${row.away_team}:`);
      console.log(`  Raw UTC: ${row.date_utc}`);
      console.log(`\nCurrent conversion (WRONG):`);
      console.log(`  EST Date: ${row.current_est_date}, Time: ${row.current_est_time}`);
      console.log(`\nCorrect conversion (FIXED):`);
      console.log(`  PST Time: ${row.correct_pst_time} (Expected: 05:00)`);
      console.log(`  EST Date: ${row.correct_est_date}, Time: ${row.correct_est_time} (Expected: 08:00)`);
      console.log(`\n✅ Match: PST=${row.correct_pst_time === '05:00'}, EST=${row.correct_est_time === '08:00'}`);
    } else {
      console.log('Match not found');
    }

    await soccerDataPool.end();
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    await soccerDataPool.end();
    process.exit(1);
  }
}

testCorrectConversion();











