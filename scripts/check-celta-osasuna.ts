import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const soccerDataPool: Pool | null = process.env.SOCCER_DATA_DATABASE_URL
  ? new Pool({ connectionString: process.env.SOCCER_DATA_DATABASE_URL })
  : null;

async function checkCeltaOsasuna() {
  if (!soccerDataPool) {
    console.error('❌ SOCCER_DATA_DATABASE_URL is not configured');
    process.exit(1);
  }

  try {
    console.log('🔍 Checking Celta Vigo vs Osasuna match...\n');
    console.log('Expected: 2/6 at 12:00 PM PST = 3:00 PM EST\n');

    const result = await soccerDataPool.query(`
      SELECT 
        m.match_id,
        m.date_utc,
        m.date_utc::text as raw_text,
        pg_typeof(m.date_utc) as date_type,
        ht.team_name_std as home_team,
        at.team_name_std as away_team,
        -- Show what timezone offset is stored
        EXTRACT(TIMEZONE FROM m.date_utc) as tz_offset_seconds,
        -- Show as UTC
        (m.date_utc AT TIME ZONE 'UTC')::text as as_utc,
        -- Show what we get with current conversion (UTC -> EST)
        to_char(((m.date_utc AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') as est_date,
        to_char((m.date_utc AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York', 'HH24:MI') as est_time,
        -- Show PST for reference
        to_char((m.date_utc AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI') as pst_datetime,
        -- Show what Madrid time would be
        to_char((m.date_utc AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Madrid', 'YYYY-MM-DD HH24:MI') as madrid_datetime,
        -- Show what the date would be in Madrid timezone
        (m.date_utc AT TIME ZONE 'Europe/Madrid')::date as madrid_date
      FROM public.matches m
      JOIN public.dim_team ht ON ht.team_id = m.home_team_id
      JOIN public.dim_team at ON at.team_id = m.away_team_id
      WHERE m.league = 'ESP-La Liga'
        AND (
          (ht.team_name_std ILIKE '%Celta%' AND at.team_name_std ILIKE '%Osasuna%')
          OR (ht.team_name_std ILIKE '%Osasuna%' AND at.team_name_std ILIKE '%Celta%')
        )
        AND (m.date_utc AT TIME ZONE 'Europe/Madrid')::date = '2026-02-06'
      ORDER BY m.date_utc ASC
      LIMIT 1
    `);

    if (result.rows.length > 0) {
      const row = result.rows[0];
      console.log(`Match: ${row.home_team} vs ${row.away_team}`);
      console.log(`\nDatabase Storage:`);
      console.log(`  Type: ${row.date_type}`);
      console.log(`  Raw: ${row.raw_text}`);
      console.log(`  TZ Offset: ${row.tz_offset_seconds} seconds (${row.tz_offset_seconds / 3600} hours)`);
      console.log(`  As UTC: ${row.as_utc}`);
      console.log(`\nConversions:`);
      console.log(`  EST Date: ${row.est_date}`);
      console.log(`  EST Time: ${row.est_time}`);
      console.log(`  PST: ${row.pst_datetime}`);
      console.log(`  Madrid: ${row.madrid_datetime}`);
      console.log(`  Madrid Date: ${row.madrid_date}`);
      console.log(`\nExpected:`);
      console.log(`  Should be: 2/6 at 12:00 PM PST = 3:00 PM EST`);
      console.log(`  UTC should be: 2026-02-06 20:00:00 (12:00 PM PST = 8:00 PM UTC)`);
    } else {
      console.log('❌ Match not found in database');
    }

    await soccerDataPool.end();
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    await soccerDataPool.end();
    process.exit(1);
  }
}

checkCeltaOsasuna();











