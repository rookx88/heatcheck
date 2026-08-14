import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const soccerDataPool: Pool | null = process.env.SOCCER_DATA_DATABASE_URL
  ? new Pool({ connectionString: process.env.SOCCER_DATA_DATABASE_URL })
  : null;

async function checkFeb8Matches() {
  if (!soccerDataPool) {
    console.error('❌ SOCCER_DATA_DATABASE_URL is not configured');
    process.exit(1);
  }

  try {
    console.log('🔍 Checking all La Liga matches for Feb 8, 2026...\n');

    const result = await soccerDataPool.query(`
      SELECT 
        m.match_id,
        m.date_utc,
        ht.team_name_std as home_team,
        at.team_name_std as away_team,
        -- Show conversions
        to_char(m.date_utc AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI') as pst_time,
        to_char(m.date_utc AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI') as est_time,
        to_char((m.date_utc AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') as est_date,
        to_char(m.date_utc AT TIME ZONE 'America/New_York', 'HH24:MI') as est_time_only,
        -- Also show Madrid time for reference
        to_char(m.date_utc AT TIME ZONE 'Europe/Madrid', 'YYYY-MM-DD HH24:MI') as madrid_time
      FROM public.matches m
      JOIN public.dim_team ht ON ht.team_id = m.home_team_id
      JOIN public.dim_team at ON at.team_id = m.away_team_id
      WHERE m.league = 'ESP-La Liga'
        AND (m.date_utc AT TIME ZONE 'Europe/Madrid')::date = '2026-02-08'
      ORDER BY m.date_utc ASC
    `);

    console.log(`Found ${result.rows.length} match(es) for Feb 8, 2026:\n`);

    result.rows.forEach((row, i) => {
      console.log(`${i + 1}. ${row.home_team} vs ${row.away_team}`);
      console.log(`   UTC: ${row.date_utc}`);
      console.log(`   Madrid: ${row.madrid_time}`);
      console.log(`   PST: ${row.pst_time}`);
      console.log(`   EST: ${row.est_time} (Date: ${row.est_date}, Time: ${row.est_time_only})`);
      console.log('');
    });

    // Now verify the conversion math
    console.log('\n📊 Expected conversions (PST → EST):');
    console.log('  5:00 AM PST = 8:00 AM EST');
    console.log('  7:15 AM PST = 10:15 AM EST');
    console.log('  9:30 AM PST = 12:30 PM EST');
    console.log('  12:00 PM PST = 3:00 PM EST');

    await soccerDataPool.end();
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    await soccerDataPool.end();
    process.exit(1);
  }
}

checkFeb8Matches();











