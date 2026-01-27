/**
 * Check team IDs in matches table
 */

import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const soccerDataPool: Pool | null = process.env.SOCCER_DATA_DATABASE_URL
  ? new Pool({ connectionString: process.env.SOCCER_DATA_DATABASE_URL })
  : null;

async function checkMatchTeamIds() {
  if (!soccerDataPool) {
    console.error('❌ SOCCER_DATA_DATABASE_URL is not configured');
    process.exit(1);
  }

  try {
    console.log('🔍 Checking team IDs in matches table...\n');

    // Find the match
    const match = await soccerDataPool.query(`
      SELECT 
        m.match_id,
        m.date_utc::date as game_date,
        m.home_team_id,
        m.away_team_id,
        ht.team_name_std as home_team,
        at.team_name_std as away_team,
        m.league,
        m.season
      FROM public.matches m
      JOIN public.dim_team ht ON m.home_team_id = ht.team_id
      JOIN public.dim_team at ON m.away_team_id = at.team_id
      WHERE m.date_utc::date = '2026-01-26'
        AND (ht.team_name_std ILIKE '%Getafe%' OR at.team_name_std ILIKE '%Getafe%')
        AND (ht.team_name_std ILIKE '%Girona%' OR at.team_name_std ILIKE '%Girona%')
      LIMIT 5;
    `);
    
    console.log('Matches found:');
    match.rows.forEach((row, i) => {
      console.log(`${i + 1}. ${row.home_team} (${row.home_team_id}) vs ${row.away_team} (${row.away_team_id})`);
      console.log(`   Match ID: ${row.match_id}`);
      console.log(`   League: ${row.league}, Season: ${row.season}`);
    });

    // Check which team IDs have standings
    console.log('\nTeam standings status:');
    const standings = await soccerDataPool.query(`
      SELECT 
        dt.team_id,
        dt.team_name_std,
        CASE WHEN ls.team_id IS NOT NULL THEN 'Has standings' ELSE 'No standings' END as status
      FROM public.dim_team dt
      LEFT JOIN public.league_standings ls ON dt.team_id = ls.team_id 
        AND ls.season = '2025-2026'
        AND ls.snapshot_date <= '2026-01-26'
      WHERE dt.team_id IN (
        SELECT DISTINCT home_team_id FROM public.matches WHERE date_utc::date = '2026-01-26' 
        UNION 
        SELECT DISTINCT away_team_id FROM public.matches WHERE date_utc::date = '2026-01-26'
      )
      AND dt.team_name_std ILIKE '%Girona%' OR dt.team_name_std ILIKE '%Getafe%'
      ORDER BY dt.team_name_std;
    `);
    standings.rows.forEach(row => {
      console.log(`  ${row.team_name_std} (${row.team_id}): ${row.status}`);
    });

  } catch (error: any) {
    console.error('❌ Error:', error.message);
    console.error(error);
  } finally {
    if (soccerDataPool) {
      await soccerDataPool.end();
    }
  }
}

checkMatchTeamIds();

