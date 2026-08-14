import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const soccerDataPool: Pool | null = process.env.SOCCER_DATA_DATABASE_URL
  ? new Pool({ connectionString: process.env.SOCCER_DATA_DATABASE_URL })
  : null;

async function verifyExpectedTimes() {
  if (!soccerDataPool) {
    console.error('❌ SOCCER_DATA_DATABASE_URL is not configured');
    process.exit(1);
  }

  try {
    console.log('🔍 Verifying what UTC times would give us the expected PST/EST times...\n');

    // Expected times from image (PST on Feb 8, 2026)
    const expected = [
      { pst: '05:00', est: '08:00', utc: '13:00' }, // 5:00 AM PST = 8:00 AM EST = 1:00 PM UTC
      { pst: '07:15', est: '10:15', utc: '15:15' }, // 7:15 AM PST = 10:15 AM EST = 3:15 PM UTC
      { pst: '09:30', est: '12:30', utc: '17:30' }, // 9:30 AM PST = 12:30 PM EST = 5:30 PM UTC
      { pst: '12:00', est: '15:00', utc: '20:00' }  // 12:00 PM PST = 3:00 PM EST = 8:00 PM UTC
    ];

    console.log('Expected conversions:\n');
    expected.forEach(e => {
      console.log(`  ${e.pst} PST = ${e.est} EST = ${e.utc} UTC`);
    });

    console.log('\n🔍 Checking what the database actually has for Feb 8 matches:\n');
    
    const result = await soccerDataPool.query(`
      SELECT 
        m.date_utc,
        EXTRACT(HOUR FROM (m.date_utc AT TIME ZONE 'UTC')) as utc_hour,
        EXTRACT(MINUTE FROM (m.date_utc AT TIME ZONE 'UTC')) as utc_minute,
        ht.team_name_std as home_team,
        at.team_name_std as away_team,
        -- Show what PST/EST we get from current UTC
        to_char((m.date_utc AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles', 'HH24:MI') as pst_from_utc,
        to_char((m.date_utc AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York', 'HH24:MI') as est_from_utc
      FROM public.matches m
      JOIN public.dim_team ht ON ht.team_id = m.home_team_id
      JOIN public.dim_team at ON at.team_id = m.away_team_id
      WHERE m.league = 'ESP-La Liga'
        AND (m.date_utc AT TIME ZONE 'Europe/Madrid')::date = '2026-02-08'
      ORDER BY m.date_utc ASC
    `);

    result.rows.forEach((row, i) => {
      const utcTime = `${row.utc_hour.toString().padStart(2, '0')}:${row.utc_minute.toString().padStart(2, '0')}`;
      console.log(`${i + 1}. ${row.home_team} vs ${row.away_team}:`);
      console.log(`   UTC: ${utcTime}`);
      console.log(`   Converts to: ${row.pst_from_utc} PST, ${row.est_from_utc} EST`);
      
      // Check if this matches any expected time
      const match = expected.find(e => e.utc === utcTime);
      if (match) {
        console.log(`   ✅ Matches expected: ${match.pst} PST = ${match.est} EST`);
      } else {
        console.log(`   ❌ Does NOT match any expected time`);
      }
      console.log('');
    });

    await soccerDataPool.end();
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    await soccerDataPool.end();
    process.exit(1);
  }
}

verifyExpectedTimes();











