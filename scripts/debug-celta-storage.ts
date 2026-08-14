import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const soccerDataPool: Pool | null = process.env.SOCCER_DATA_DATABASE_URL
  ? new Pool({ connectionString: process.env.SOCCER_DATA_DATABASE_URL })
  : null;

async function debugCeltaStorage() {
  if (!soccerDataPool) {
    console.error('❌ SOCCER_DATA_DATABASE_URL is not configured');
    process.exit(1);
  }

  try {
    console.log('🔍 Debugging Celta Vigo vs Osasuna storage...\n');
    console.log('Expected: 2/6 at 12:00 PM PST = 3:00 PM EST = 8:00 PM UTC\n');

    const result = await soccerDataPool.query(`
      SELECT 
        m.match_id,
        m.date_utc,
        m.date_utc::text as raw_text,
        EXTRACT(TIMEZONE FROM m.date_utc) as tz_offset_seconds,
        -- Show as UTC
        (m.date_utc AT TIME ZONE 'UTC')::text as as_utc,
        EXTRACT(HOUR FROM (m.date_utc AT TIME ZONE 'UTC')) as utc_hour,
        EXTRACT(MINUTE FROM (m.date_utc AT TIME ZONE 'UTC')) as utc_minute,
        -- Show what date/time it represents in different timezones
        (m.date_utc AT TIME ZONE 'UTC')::date as utc_date,
        to_char((m.date_utc AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI') as pst,
        to_char((m.date_utc AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI') as est,
        to_char((m.date_utc AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Madrid', 'YYYY-MM-DD HH24:MI') as madrid,
        ht.team_name_std as home_team,
        at.team_name_std as away_team
      FROM public.matches m
      JOIN public.dim_team ht ON ht.team_id = m.home_team_id
      JOIN public.dim_team at ON at.team_id = m.away_team_id
      WHERE m.league = 'ESP-La Liga'
        AND (
          (ht.team_name_std ILIKE '%Celta%' AND at.team_name_std ILIKE '%Osasuna%')
          OR (ht.team_name_std ILIKE '%Osasuna%' AND at.team_name_std ILIKE '%Celta%')
        )
        AND (m.date_utc AT TIME ZONE 'Europe/Madrid')::date >= '2026-02-06'
        AND (m.date_utc AT TIME ZONE 'Europe/Madrid')::date <= '2026-02-07'
      ORDER BY m.date_utc ASC
      LIMIT 1
    `);

    if (result.rows.length > 0) {
      const row = result.rows[0];
      const utcTime = `${row.utc_hour.toString().padStart(2, '0')}:${row.utc_minute.toString().padStart(2, '0')}`;
      
      console.log(`Match: ${row.home_team} vs ${row.away_team}`);
      console.log(`\nStored in Database:`);
      console.log(`  Raw: ${row.raw_text}`);
      console.log(`  TZ Offset: ${row.tz_offset_seconds} seconds (${row.tz_offset_seconds / 3600} hours)`);
      console.log(`  As UTC: ${row.as_utc}`);
      console.log(`  UTC Date: ${row.utc_date}, Time: ${utcTime}`);
      console.log(`\nWhat it converts to:`);
      console.log(`  PST: ${row.pst}`);
      console.log(`  EST: ${row.est}`);
      console.log(`  Madrid: ${row.madrid}`);
      console.log(`\nExpected:`);
      console.log(`  Should be: 2/6 at 12:00 PM PST = 3:00 PM EST = 8:00 PM UTC`);
      console.log(`  Current UTC: ${utcTime} on ${row.utc_date}`);
      
      if (row.utc_date.toISOString().split('T')[0] === '2026-02-07' && utcTime === '00:00') {
        console.log(`\n⚠️  Issue: Database has 2/7 at 00:00 UTC, but should be 2/6 at 20:00 UTC`);
        console.log(`   This is a 20-hour difference - the source database has incorrect data.`);
      }
    } else {
      console.log('❌ Match not found');
    }

    await soccerDataPool.end();
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    await soccerDataPool.end();
    process.exit(1);
  }
}

debugCeltaStorage();











