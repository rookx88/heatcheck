/**
 * Test script to check league_standings table data
 */

import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const soccerDataPool: Pool | null = process.env.SOCCER_DATA_DATABASE_URL
  ? new Pool({ connectionString: process.env.SOCCER_DATA_DATABASE_URL })
  : null;

async function testLeagueStandings() {
  if (!soccerDataPool) {
    console.error('❌ SOCCER_DATA_DATABASE_URL is not configured');
    process.exit(1);
  }

  try {
    console.log('🔍 Testing league_standings table...\n');

    // Check table structure
    console.log('1. Table structure:');
    const structure = await soccerDataPool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' 
        AND table_name = 'league_standings'
      ORDER BY ordinal_position;
    `);
    console.log(structure.rows);
    console.log('');

    // Check total rows
    const count = await soccerDataPool.query(`SELECT COUNT(*) as count FROM public.league_standings;`);
    console.log(`2. Total rows: ${count.rows[0].count}`);
    console.log('');

    // Check sample data
    console.log('3. Sample data (first 5 rows):');
    const sample = await soccerDataPool.query(`
      SELECT 
        league,
        season,
        snapshot_date,
        team_id,
        position,
        points,
        matches_played,
        wins,
        draws,
        losses
      FROM public.league_standings
      ORDER BY snapshot_date DESC, league, position
      LIMIT 5;
    `);
    sample.rows.forEach((row, i) => {
      console.log(`${i + 1}. ${row.league} ${row.season} - ${row.snapshot_date}: Team ${row.team_id} - ${row.position}th (${row.points}pts, ${row.wins}-${row.draws}-${row.losses})`);
    });
    console.log('');

    // Check for Getafe and Girona
    console.log('4. Checking for Getafe and Girona:');
    const teams = await soccerDataPool.query(`
      SELECT 
        dt.team_id,
        dt.team_name_std,
        ls.position,
        ls.points,
        ls.matches_played,
        ls.snapshot_date,
        ls.league,
        ls.season
      FROM public.dim_team dt
      LEFT JOIN public.league_standings ls ON dt.team_id = ls.team_id
      WHERE dt.team_name_std ILIKE '%Getafe%' OR dt.team_name_std ILIKE '%Girona%'
      ORDER BY dt.team_name_std, ls.snapshot_date DESC
      LIMIT 10;
    `);
    teams.rows.forEach((row) => {
      if (row.snapshot_date) {
        console.log(`  ${row.team_name_std} (${row.team_id}): ${row.position}th, ${row.points}pts, ${row.matches_played} matches - ${row.snapshot_date} (${row.league}, ${row.season})`);
      } else {
        console.log(`  ${row.team_name_std} (${row.team_id}): No standings data`);
      }
    });
    console.log('');

    // Check for La Liga standings around 2026-01-26
    console.log('5. La Liga standings around 2026-01-26:');
    const laLiga = await soccerDataPool.query(`
      SELECT 
        dt.team_name_std,
        ls.position,
        ls.points,
        ls.matches_played,
        ls.snapshot_date
      FROM public.league_standings ls
      JOIN public.dim_team dt ON ls.team_id = dt.team_id
      WHERE ls.league ILIKE '%La Liga%' OR ls.league ILIKE '%ESP%'
        AND ls.season = '2025-2026'
        AND ls.snapshot_date <= '2026-01-26'
        AND ls.snapshot_date >= '2026-01-20'
      ORDER BY ls.snapshot_date DESC, ls.position
      LIMIT 20;
    `);
    laLiga.rows.forEach((row) => {
      console.log(`  ${row.team_name_std}: ${row.position}th, ${row.points}pts (${row.snapshot_date})`);
    });
    console.log('');

    console.log('✅ League standings test complete!');
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    console.error(error);
  } finally {
    if (soccerDataPool) {
      await soccerDataPool.end();
    }
  }
}

testLeagueStandings();

