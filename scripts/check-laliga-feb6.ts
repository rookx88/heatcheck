import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const soccerDataPool: Pool | null = process.env.SOCCER_DATA_DATABASE_URL
  ? new Pool({ connectionString: process.env.SOCCER_DATA_DATABASE_URL })
  : null;

async function checkLaLigaFeb6() {
  if (!soccerDataPool) {
    console.error('❌ SOCCER_DATA_DATABASE_URL is not configured');
    process.exit(1);
  }

  try {
    console.log('🔍 Checking all La Liga matches for Feb 6, 2026...\n');

    const result = await soccerDataPool.query(`
      SELECT 
        m.match_id,
        m.date_utc,
        m.date_utc::text as raw_text,
        ht.team_name_std as home_team,
        at.team_name_std as away_team,
        -- Show conversions
        to_char(((m.date_utc AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') as est_date,
        to_char((m.date_utc AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York', 'HH24:MI') as est_time,
        to_char((m.date_utc AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI') as pst_datetime,
        (m.date_utc AT TIME ZONE 'Europe/Madrid')::date as madrid_date,
        to_char((m.date_utc AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Madrid', 'HH24:MI') as madrid_time
      FROM public.matches m
      JOIN public.dim_team ht ON ht.team_id = m.home_team_id
      JOIN public.dim_team at ON at.team_id = m.away_team_id
      WHERE m.league = 'ESP-La Liga'
        AND (m.date_utc AT TIME ZONE 'Europe/Madrid')::date = '2026-02-06'
      ORDER BY m.date_utc ASC
    `);

    console.log(`Found ${result.rows.length} match(es) for Feb 6, 2026:\n`);

    result.rows.forEach((row, i) => {
      console.log(`${i + 1}. ${row.home_team} vs ${row.away_team}`);
      console.log(`   Raw UTC: ${row.raw_text}`);
      console.log(`   Madrid Date: ${row.madrid_date}, Time: ${row.madrid_time}`);
      console.log(`   PST: ${row.pst_datetime}`);
      console.log(`   EST: ${row.est_date} ${row.est_time}`);
      console.log('');
    });

    // Check specifically for Celta Vigo vs Osasuna
    console.log('\n🔍 Searching for Celta Vigo vs Osasuna...\n');
    const celtaResult = await soccerDataPool.query(`
      SELECT 
        m.match_id,
        m.date_utc,
        m.date_utc::text as raw_text,
        ht.team_name_std as home_team,
        at.team_name_std as away_team,
        (m.date_utc AT TIME ZONE 'Europe/Madrid')::date as madrid_date,
        to_char((m.date_utc AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI') as est_datetime,
        to_char((m.date_utc AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI') as pst_datetime
      FROM public.matches m
      JOIN public.dim_team ht ON ht.team_id = m.home_team_id
      JOIN public.dim_team at ON at.team_id = m.away_team_id
      WHERE m.league = 'ESP-La Liga'
        AND (
          (ht.team_name_std ILIKE '%Celta%' AND at.team_name_std ILIKE '%Osasuna%')
          OR (ht.team_name_std ILIKE '%Osasuna%' AND at.team_name_std ILIKE '%Celta%')
        )
      ORDER BY m.date_utc ASC
      LIMIT 5
    `);

    if (celtaResult.rows.length > 0) {
      console.log('Found Celta Vigo vs Osasuna matches:');
      celtaResult.rows.forEach((row, i) => {
        console.log(`\n${i + 1}. ${row.home_team} vs ${row.away_team}`);
        console.log(`   Madrid Date: ${row.madrid_date}`);
        console.log(`   PST: ${row.pst_datetime}`);
        console.log(`   EST: ${row.est_datetime}`);
      });
    } else {
      console.log('❌ Celta Vigo vs Osasuna not found');
    }

    await soccerDataPool.end();
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    await soccerDataPool.end();
    process.exit(1);
  }
}

checkLaLigaFeb6();











