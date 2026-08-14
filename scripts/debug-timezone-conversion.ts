import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const soccerDataPool: Pool | null = process.env.SOCCER_DATA_DATABASE_URL
  ? new Pool({ connectionString: process.env.SOCCER_DATA_DATABASE_URL })
  : null;

async function debugTimezoneConversion() {
  if (!soccerDataPool) {
    console.error('❌ SOCCER_DATA_DATABASE_URL is not configured');
    process.exit(1);
  }

  try {
    console.log('🔍 Debugging timezone conversion for Alaves vs Getafe...\n');

    // Check the actual data type and value
    const result = await soccerDataPool.query(`
      SELECT 
        m.date_utc,
        pg_typeof(m.date_utc) as date_type,
        -- Show raw value
        m.date_utc::text as raw_text,
        -- If it's timestamptz, show UTC explicitly
        (m.date_utc AT TIME ZONE 'UTC')::text as as_utc,
        -- Convert from UTC to PST
        (m.date_utc AT TIME ZONE 'UTC' AT TIME ZONE 'America/Los_Angeles')::text as utc_to_pst,
        -- Convert from UTC to EST  
        (m.date_utc AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::text as utc_to_est,
        -- What we're currently doing (might be wrong)
        (m.date_utc AT TIME ZONE 'America/Los_Angeles')::text as direct_to_pst,
        (m.date_utc AT TIME ZONE 'America/New_York')::text as direct_to_est,
        ht.team_name_std as home_team,
        at.team_name_std as away_team
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
      console.log('Database field info:');
      console.log(`  Type: ${row.date_type}`);
      console.log(`  Raw text: ${row.raw_text}`);
      console.log(`  As UTC: ${row.as_utc}`);
      console.log(`\nConversions:`);
      console.log(`  UTC → PST (correct): ${row.utc_to_pst}`);
      console.log(`  UTC → EST (correct): ${row.utc_to_est}`);
      console.log(`  Direct to PST (current): ${row.direct_to_pst}`);
      console.log(`  Direct to EST (current): ${row.direct_to_est}`);
      console.log(`\nExpected:`);
      console.log(`  Should be: 5:00 AM PST = 8:00 AM EST on Feb 8`);
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

debugTimezoneConversion();











