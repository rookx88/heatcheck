import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const soccerDataPool: Pool | null = process.env.SOCCER_DATA_DATABASE_URL
  ? new Pool({ connectionString: process.env.SOCCER_DATA_DATABASE_URL })
  : null;

async function verifyTimezoneMath() {
  if (!soccerDataPool) {
    console.error('❌ SOCCER_DATA_DATABASE_URL is not configured');
    process.exit(1);
  }

  try {
    console.log('🔍 Verifying timezone conversion math...\n');

    // Expected times from image (PST on Feb 8, 2026)
    const expectedMatches = [
      { home: 'Alavés', away: 'Getafe', pst: '5:00 AM', est: '8:00 AM' },
      { home: 'Athletic Club', away: 'Levante', pst: '7:15 AM', est: '10:15 AM' },
      { home: 'Atlético Madrid', away: 'Real Betis', pst: '9:30 AM', est: '12:30 PM' },
      { home: 'Valencia', away: 'Real Madrid', pst: '12:00 PM', est: '3:00 PM' }
    ];

    for (const match of expectedMatches) {
      // Calculate what UTC time should be for the PST time
      // 5:00 AM PST = 13:00 UTC (1:00 PM UTC) on Feb 8
      // 7:15 AM PST = 15:15 UTC (3:15 PM UTC) on Feb 8
      // 9:30 AM PST = 17:30 UTC (5:30 PM UTC) on Feb 8
      // 12:00 PM PST = 20:00 UTC (8:00 PM UTC) on Feb 8
      
      const pstHour = match.pst.includes('AM') 
        ? parseInt(match.pst.split(':')[0])
        : parseInt(match.pst.split(':')[0]) + 12;
      const pstMinute = parseInt(match.pst.split(':')[1].split(' ')[0]);
      
      // PST is UTC-8, so add 8 hours to get UTC
      const utcHour = (pstHour + 8) % 24;
      const utcMinute = pstMinute;
      
      console.log(`\n${match.home} vs ${match.away}:`);
      console.log(`  Expected: ${match.pst} PST = ${match.est} EST`);
      console.log(`  Should be UTC: ${utcHour.toString().padStart(2, '0')}:${utcMinute.toString().padStart(2, '0')} on Feb 8`);
      
      // Check what's actually in the database
      const result = await soccerDataPool.query(`
        SELECT 
          m.date_utc,
          ht.team_name_std as home_team,
          at.team_name_std as away_team,
          -- Raw UTC components
          EXTRACT(HOUR FROM m.date_utc) as utc_hour,
          EXTRACT(MINUTE FROM m.date_utc) as utc_minute,
          -- Conversions
          to_char(m.date_utc AT TIME ZONE 'America/Los_Angeles', 'HH24:MI') as pst_time,
          to_char(m.date_utc AT TIME ZONE 'America/New_York', 'HH24:MI') as est_time,
          to_char((m.date_utc AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') as est_date
        FROM public.matches m
        JOIN public.dim_team ht ON ht.team_id = m.home_team_id
        JOIN public.dim_team at ON at.team_id = m.away_team_id
        WHERE m.league = 'ESP-La Liga'
          AND (m.date_utc AT TIME ZONE 'Europe/Madrid')::date = '2026-02-08'
          AND (
            (ht.team_name_std ILIKE '%${match.home.replace('é', 'e').replace('á', 'a')}%' 
             AND at.team_name_std ILIKE '%${match.away.replace('é', 'e')}%')
            OR (ht.team_name_std ILIKE '%${match.away.replace('é', 'e')}%' 
                AND at.team_name_std ILIKE '%${match.home.replace('é', 'e').replace('á', 'a')}%')
          )
        LIMIT 1
      `);

      if (result.rows.length > 0) {
        const row = result.rows[0];
        console.log(`  Found in DB:`);
        console.log(`    UTC: ${row.utc_hour}:${row.utc_minute.toString().padStart(2, '0')}`);
        console.log(`    PST: ${row.pst_time} (Expected: ${match.pst})`);
        console.log(`    EST: ${row.est_time} (Expected: ${match.est})`);
        console.log(`    EST Date: ${row.est_date}`);
        
        // Check if times match
        const pstMatch = row.pst_time === match.pst.replace(' AM', '').replace(' PM', '').replace(':', '');
        const estMatch = row.est_time === match.est.replace(' AM', '').replace(' PM', '').replace(':', '');
        console.log(`    ✅ PST Match: ${pstMatch}, EST Match: ${estMatch}`);
      } else {
        console.log(`  ❌ Not found in database`);
      }
    }

    await soccerDataPool.end();
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    await soccerDataPool.end();
    process.exit(1);
  }
}

verifyTimezoneMath();











