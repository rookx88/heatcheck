/**
 * Test script to verify standings query logic
 */

import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const soccerDataPool: Pool | null = process.env.SOCCER_DATA_DATABASE_URL
  ? new Pool({ connectionString: process.env.SOCCER_DATA_DATABASE_URL })
  : null;

async function testStandingsQuery() {
  if (!soccerDataPool) {
    console.error('❌ SOCCER_DATA_DATABASE_URL is not configured');
    process.exit(1);
  }

  try {
    console.log('🔍 Testing standings query logic...\n');

    // Test with Getafe vs Girona on 2026-01-26
    const testQuery = `
      WITH 
      ta as (
        select team_id, team_name_std, league
        from public.dim_team
        where lower(team_name_std) = lower('Getafe')
        limit 1
      ),
      tb as (
        select team_id, team_name_std, league
        from public.dim_team
        where lower(team_name_std) = lower('Girona')
        limit 1
      ),
      m as (
        select
          m.match_id,
          m.season,
          m.date_utc,
          m.date_utc::date as game_date,
          m.home_team_id,
          m.away_team_id,
          m.league
        from public.matches m
        join ta on true
        join tb on true
        where (
          (m.home_team_id = ta.team_id and m.away_team_id = tb.team_id)
          or (m.home_team_id = tb.team_id and m.away_team_id = ta.team_id)
        )
        and m.date_utc::date = '2026-01-26'
        order by m.date_utc asc
        limit 1
      ),
      ctx as (
        select
          (select team_id from ta) as team_a_id,
          (select team_id from tb) as team_b_id,
          (select team_name_std from ta) as team_a_name,
          (select team_name_std from tb) as team_b_name,
          (select match_id from m) as match_id,
          (select season from m) as season,
          (select game_date from m) as game_date,
          (select date_utc from m) as date_utc,
          (select home_team_id from m) as home_team_id,
          (select away_team_id from m) as away_team_id,
          (select league from m) as match_league
      ),
      standings_pick as (
        select
          mts.home_pos,
          mts.away_pos,
          mts.home_pts,
          mts.away_pts,
          mts.snapshot_at
        from public.match_table_snapshot mts
        join public.matches m on m.match_id = mts.match_id
        join ctx c on mts.match_id = c.match_id
        where (c.season is null or m.season = c.season)
          and (c.match_league is null or m.league = c.match_league)
          and mts.snapshot_at::date <= coalesce(c.game_date, c.date_utc::date, current_date)
        order by mts.snapshot_at desc
        limit 1
      )
      SELECT 
        (select team_a_name from ctx) as team_a,
        (select team_b_name from ctx) as team_b,
        (select match_id from ctx) as match_id,
        (select season from ctx) as season,
        (select game_date from ctx) as game_date,
        (select match_league from ctx) as league,
        (select home_pos from standings_pick) as home_pos,
        (select away_pos from standings_pick) as away_pos,
        (select home_pts from standings_pick) as home_pts,
        (select away_pts from standings_pick) as away_pts,
        (select snapshot_at from standings_pick) as snapshot_at;
    `;

    const result = await soccerDataPool.query(testQuery);
    console.log('Standings query result:');
    console.log(result.rows[0]);
    console.log('');

    // Also test the user's provided query pattern
    console.log('Testing user-provided query pattern...');
    const userQuery = `
      SELECT 
        m.date_utc::date as match_date,
        t1.team_name_std as home_team,
        mts.home_pos as home_pos,
        mts.home_pts as home_pts,
        t2.team_name_std as away_team,
        mts.away_pos as away_pos,
        mts.away_pts as away_pts,
        mts.snapshot_at
      FROM matches m
      JOIN match_table_snapshot mts ON m.match_id = mts.match_id
      JOIN dim_team t1 ON m.home_team_id = t1.team_id
      JOIN dim_team t2 ON m.away_team_id = t2.team_id
      WHERE m.season = '2025-2026'
      AND m.league = 'ENG-Premier League'
      AND mts.snapshot_at::date <= '2025-12-31'
      ORDER BY m.date_utc
      LIMIT 5;
    `;

    const userResult = await soccerDataPool.query(userQuery);
    console.log('User query pattern result (first 5 rows):');
    userResult.rows.forEach((row, i) => {
      console.log(`${i + 1}. ${row.match_date}: ${row.home_team} (${row.home_pos}th, ${row.home_pts}pts) vs ${row.away_team} (${row.away_pos}th, ${row.away_pts}pts) - snapshot: ${row.snapshot_at}`);
    });
    console.log('');

    console.log('✅ Standings query test complete!');
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    console.error(error);
  } finally {
    if (soccerDataPool) {
      await soccerDataPool.end();
    }
  }
}

testStandingsQuery();

