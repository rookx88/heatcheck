/**
 * Test team matching logic
 */

import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const soccerDataPool: Pool | null = process.env.SOCCER_DATA_DATABASE_URL
  ? new Pool({ connectionString: process.env.SOCCER_DATA_DATABASE_URL })
  : null;

async function testTeamMatching() {
  if (!soccerDataPool) {
    console.error('❌ SOCCER_DATA_DATABASE_URL is not configured');
    process.exit(1);
  }

  try {
    console.log('🔍 Testing team matching with improved logic...\n');

    // Test with "Girona" - should prefer "Girona FC" which has standings
    const testQuery = `
      WITH 
      p_team_a := 'Getafe',
      p_team_b := 'Girona',
      p_season := '2025-2026',
      ta as (
        select 
          dt.team_id, 
          dt.team_name_std, 
          dt.league
        from public.dim_team dt
        left join lateral (
          select 1 as has_standings
          from public.league_standings ls
          where ls.team_id = dt.team_id
            and (p_season is null or ls.season = p_season)
          limit 1
        ) standings_check on true
        where
          lower(dt.team_name_std) = lower(p_team_b)
          or dt.team_name_std ilike '%' || p_team_b || '%'
          or lower(p_team_b) = lower(regexp_replace(dt.team_name_std, '\\s+(FC|CF|United|City|Town|Athletic|Club)$', '', 'g'))
          or lower(regexp_replace(p_team_b, '\\s+(FC|CF|United|City|Town|Athletic|Club)$', '', 'g')) = lower(regexp_replace(dt.team_name_std, '\\s+(FC|CF|United|City|Town|Athletic|Club)$', '', 'g'))
        order by
          case
            when lower(dt.team_name_std) = lower(p_team_b) then 0
            when lower(regexp_replace(dt.team_name_std, '\\s+(FC|CF|United|City|Town|Athletic|Club)$', '', 'g')) = lower(regexp_replace(p_team_b, '\\s+(FC|CF|United|City|Town|Athletic|Club)$', '', 'g')) then 1
            else 2
          end,
          case when standings_check.has_standings = 1 then 0 else 1 end,
          length(dt.team_name_std) asc
        limit 1
      )
      SELECT 
        ta.team_id,
        ta.team_name_std,
        ta.league,
        (SELECT position FROM public.league_standings WHERE team_id = ta.team_id AND season = '2025-2026' ORDER BY snapshot_date DESC LIMIT 1) as position,
        (SELECT points FROM public.league_standings WHERE team_id = ta.team_id AND season = '2025-2026' ORDER BY snapshot_date DESC LIMIT 1) as points
      FROM ta;
    `;

    // Actually, let me test the function directly with different variations
    console.log('Testing with "Girona":');
    const result1 = await soccerDataPool.query(`
      SELECT 
        (get_match_pack_v3_soccer('Getafe', 'Girona', '2026-01-26', '2025-2026')->'factDrop'->'bullets'->5->>'display') as standings
    `);
    console.log('Standings:', result1.rows[0].standings);

    console.log('\nTesting with "Girona FC":');
    const result2 = await soccerDataPool.query(`
      SELECT 
        (get_match_pack_v3_soccer('Getafe', 'Girona FC', '2026-01-26', '2025-2026')->'factDrop'->'bullets'->5->>'display') as standings
    `);
    console.log('Standings:', result2.rows[0].standings);

    // Check what teams match "Girona"
    console.log('\nTeams matching "Girona":');
    const teams = await soccerDataPool.query(`
      SELECT 
        dt.team_id,
        dt.team_name_std,
        dt.league,
        CASE WHEN ls.team_id IS NOT NULL THEN 'Has standings' ELSE 'No standings' END as standings_status
      FROM public.dim_team dt
      LEFT JOIN public.league_standings ls ON dt.team_id = ls.team_id AND ls.season = '2025-2026'
      WHERE dt.team_name_std ILIKE '%Girona%'
      ORDER BY 
        CASE WHEN ls.team_id IS NOT NULL THEN 0 ELSE 1 END,
        dt.team_name_std;
    `);
    teams.rows.forEach(row => {
      console.log(`  ${row.team_name_std} (${row.team_id}): ${row.standings_status}`);
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

testTeamMatching();

