import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const soccerDataPool: Pool | null = process.env.SOCCER_DATA_DATABASE_URL
  ? new Pool({ connectionString: process.env.SOCCER_DATA_DATABASE_URL })
  : null;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function checkImportDates() {
  try {
    console.log('🔍 Checking what dates would be imported vs what exists...\n');

    // Check what's in the soccer database for La Liga after 2/6
    const soccerResult = await soccerDataPool?.query(`
      SELECT 
        m.match_id,
        m.date_utc,
        ht.team_name_std as home_team,
        at.team_name_std as away_team,
        to_char(((m.date_utc AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') as est_date,
        to_char((m.date_utc AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York', 'HH24:MI') as est_time
      FROM public.matches m
      JOIN public.dim_team ht ON ht.team_id = m.home_team_id
      JOIN public.dim_team at ON at.team_id = m.away_team_id
      WHERE m.league = 'ESP-La Liga'
        AND (m.date_utc AT TIME ZONE 'Europe/Madrid')::date >= '2026-02-07'
        AND (m.date_utc AT TIME ZONE 'Europe/Madrid')::date <= '2026-02-10'
        AND (m.status IS NULL OR m.status = 'scheduled' OR m.status = 'not_started')
      ORDER BY m.date_utc ASC
      LIMIT 5
    `);

    if (soccerResult && soccerResult.rows.length > 0) {
      console.log('Soccer DB would import these dates:\n');
      for (const row of soccerResult.rows) {
        console.log(`${row.home_team} vs ${row.away_team}:`);
        console.log(`  Would import as: ${row.est_date} ${row.est_time}`);
        
        // Check if this exists in main DB
        const mainCheck = await pool.query(`
          SELECT 
            m.id,
            m.scheduled_date,
            m.scheduled_time,
            ta.name as team_a,
            tb.name as team_b
          FROM matchups m
          JOIN teams ta ON m.team_a_id = ta.id
          JOIN teams tb ON m.team_b_id = tb.id
          WHERE m.league = 'La Liga'
            AND (
              (ta.name ILIKE '%${row.home_team.split(' ')[0]}%' AND tb.name ILIKE '%${row.away_team.split(' ')[0]}%')
              OR (ta.name ILIKE '%${row.away_team.split(' ')[0]}%' AND tb.name ILIKE '%${row.home_team.split(' ')[0]}%')
            )
            AND m.scheduled_date >= '2026-02-07'
          LIMIT 1
        `);
        
        if (mainCheck.rows.length > 0) {
          const existing = mainCheck.rows[0];
          console.log(`  ⚠️  EXISTS in main DB: ${existing.scheduled_date} ${existing.scheduled_time || ''}`);
          console.log(`     Would be skipped as duplicate`);
        } else {
          console.log(`  ✅ Not in main DB - would import`);
        }
        console.log('');
      }
    }

    await pool.end();
    if (soccerDataPool) await soccerDataPool.end();
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    await pool.end();
    if (soccerDataPool) await soccerDataPool.end();
    process.exit(1);
  }
}

checkImportDates();











