import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const soccerDataPool: Pool | null = process.env.SOCCER_DATA_DATABASE_URL
  ? new Pool({ connectionString: process.env.SOCCER_DATA_DATABASE_URL })
  : null;

async function verifyLaLigaTimes() {
  if (!soccerDataPool) {
    console.error('❌ SOCCER_DATA_DATABASE_URL is not configured');
    process.exit(1);
  }

  try {
    console.log('🔍 Verifying La Liga time conversions for Feb 8, 2026...\n');

    // Check the specific matches mentioned
    const matches = [
      { home: 'Valencia', away: 'Real Madrid', expectedTimePST: '12:00 PM', expectedTimeEST: '3:00 PM' },
      { home: 'Alavés', away: 'Getafe', expectedTimePST: '5:00 AM', expectedTimeEST: '8:00 AM' },
      { home: 'Athletic Club', away: 'Levante', expectedTimePST: '7:15 AM', expectedTimeEST: '10:15 AM' },
      { home: 'Atlético Madrid', away: 'Real Betis', expectedTimePST: '9:30 AM', expectedTimeEST: '12:30 PM' }
    ];

    for (const match of matches) {
      const result = await soccerDataPool.query(`
        SELECT 
          m.match_id,
          m.date_utc,
          ht.team_name_std as home_team,
          at.team_name_std as away_team,
          -- Show what we get from database
          m.date_utc as raw_utc,
          -- Convert to PST (for reference)
          to_char(m.date_utc AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI') as pst_time,
          -- Convert to EST (what we're using)
          to_char(m.date_utc AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI') as est_time,
          to_char((m.date_utc AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') as est_date,
          to_char(m.date_utc AT TIME ZONE 'America/New_York', 'HH24:MI') as est_time_only
        FROM public.matches m
        JOIN public.dim_team ht ON ht.team_id = m.home_team_id
        JOIN public.dim_team at ON at.team_id = m.away_team_id
        WHERE m.league = 'ESP-La Liga'
          AND (m.date_utc AT TIME ZONE 'Europe/Madrid')::date = '2026-02-08'
          AND (
            (ht.team_name_std ILIKE '%${match.home}%' AND at.team_name_std ILIKE '%${match.away}%')
            OR (ht.team_name_std ILIKE '%${match.away}%' AND at.team_name_std ILIKE '%${match.home}%')
          )
        ORDER BY m.date_utc ASC
        LIMIT 1
      `);

      if (result.rows.length > 0) {
        const row = result.rows[0];
        console.log(`${row.home_team} vs ${row.away_team}:`);
        console.log(`  Raw UTC: ${row.raw_utc}`);
        console.log(`  PST: ${row.pst_time} (Expected: ${match.expectedTimePST})`);
        console.log(`  EST: ${row.est_time} (Expected: ${match.expectedTimeEST})`);
        console.log(`  EST Date: ${row.est_date}`);
        console.log(`  EST Time: ${row.est_time_only}`);
        console.log('');
      } else {
        console.log(`❌ Not found: ${match.home} vs ${match.away}\n`);
      }
    }

    await soccerDataPool.end();
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    await soccerDataPool.end();
    process.exit(1);
  }
}

verifyLaLigaTimes();











