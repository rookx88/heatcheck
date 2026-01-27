/**
 * Test script to investigate standings data in soccer database
 */

import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const soccerDataPool: Pool | null = process.env.SOCCER_DATA_DATABASE_URL
  ? new Pool({ connectionString: process.env.SOCCER_DATA_DATABASE_URL })
  : null;

async function testStandingsData() {
  if (!soccerDataPool) {
    console.error('❌ SOCCER_DATA_DATABASE_URL is not configured');
    process.exit(1);
  }

  try {
    console.log('🔍 Testing standings data...\n');

    // 1. Check if match_table_snapshot table exists and has data
    console.log('1. Checking match_table_snapshot table structure...');
    const tableCheck = await soccerDataPool.query(`
      SELECT 
        column_name, 
        data_type, 
        is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' 
        AND table_name = 'match_table_snapshot'
      ORDER BY ordinal_position;
    `);
    console.log('Columns:', tableCheck.rows);
    console.log('');

    // 2. Check how many rows exist
    const countResult = await soccerDataPool.query(`
      SELECT COUNT(*) as count FROM public.match_table_snapshot;
    `);
    console.log(`2. Total rows in match_table_snapshot: ${countResult.rows[0].count}`);
    console.log('');

    // 3. Check sample data
    console.log('3. Sample data from match_table_snapshot (first 5 rows):');
    const sampleData = await soccerDataPool.query(`
      SELECT 
        match_id,
        home_pos,
        away_pos,
        home_pts,
        away_pts,
        snapshot_at
      FROM public.match_table_snapshot
      ORDER BY snapshot_at DESC
      LIMIT 5;
    `);
    console.log(sampleData.rows);
    console.log('');

    // 4. Check if there's a standings table (alternative source)
    console.log('4. Checking for alternative standings tables...');
    const standingsTables = await soccerDataPool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND (table_name ILIKE '%standings%' OR table_name ILIKE '%table%' OR table_name ILIKE '%position%')
      ORDER BY table_name;
    `);
    console.log('Found tables:', standingsTables.rows.map(r => r.table_name));
    console.log('');

    // 5. Test with a specific match (Getafe vs Girona on 2026-01-26)
    console.log('5. Testing with Getafe vs Girona on 2026-01-26...');
    const testMatch = await soccerDataPool.query(`
      WITH team_lookup as (
        SELECT team_id, team_name_std
        FROM public.dim_team
        WHERE team_name_std ILIKE '%Getafe%' OR team_name_std ILIKE '%Girona%'
      ),
      match_lookup as (
        SELECT 
          m.match_id,
          m.date_utc::date as game_date,
          m.home_team_id,
          m.away_team_id,
          ht.team_name_std as home_team,
          at.team_name_std as away_team
        FROM public.matches m
        JOIN team_lookup tl1 ON m.home_team_id = tl1.team_id
        JOIN team_lookup tl2 ON m.away_team_id = tl2.team_id
        JOIN public.dim_team ht ON m.home_team_id = ht.team_id
        JOIN public.dim_team at ON m.away_team_id = at.team_id
        WHERE m.date_utc::date = '2026-01-26'
        LIMIT 1
      )
      SELECT 
        ml.*,
        mts.match_id as snapshot_match_id,
        mts.home_pos,
        mts.away_pos,
        mts.home_pts,
        mts.away_pts,
        mts.snapshot_at
      FROM match_lookup ml
      LEFT JOIN public.match_table_snapshot mts ON mts.match_id = ml.match_id
      LIMIT 1;
    `);
    console.log('Match with standings:', testMatch.rows[0]);
    console.log('');

    // 6. Check if we can get standings by team_id and date (alternative approach)
    console.log('6. Checking if we can query standings by team and date...');
    const standingsByTeam = await soccerDataPool.query(`
      SELECT 
        mts.match_id,
        m.date_utc::date as match_date,
        m.home_team_id,
        m.away_team_id,
        ht.team_name_std as home_team,
        at.team_name_std as away_team,
        mts.home_pos,
        mts.away_pos,
        mts.home_pts,
        mts.away_pts,
        mts.snapshot_at
      FROM public.match_table_snapshot mts
      JOIN public.matches m ON m.match_id = mts.match_id
      JOIN public.dim_team ht ON m.home_team_id = ht.team_id
      JOIN public.dim_team at ON m.away_team_id = at.team_id
      WHERE m.date_utc::date >= '2026-01-20'
      ORDER BY m.date_utc DESC
      LIMIT 10;
    `);
    console.log('Recent standings data:');
    standingsByTeam.rows.forEach(row => {
      console.log(`  ${row.match_date}: ${row.home_team} (${row.home_pos}th, ${row.home_pts}pts) vs ${row.away_team} (${row.away_pos}th, ${row.away_pts}pts)`);
    });
    console.log('');

    // 7. Check if there's a way to get current standings without match_table_snapshot
    console.log('7. Checking for current standings table or view...');
    const currentStandings = await soccerDataPool.query(`
      SELECT table_name, table_type
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND (table_name ILIKE '%current%' OR table_name ILIKE '%league%')
      ORDER BY table_name;
    `);
    console.log('Potential standings sources:', currentStandings.rows);
    console.log('');

    console.log('✅ Standings data investigation complete!');
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    console.error(error);
  } finally {
    if (soccerDataPool) {
      await soccerDataPool.end();
    }
  }
}

testStandingsData();

