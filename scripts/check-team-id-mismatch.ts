/**
 * Check if team ID mismatch is causing the issue
 */

import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const soccerDataPool: Pool | null = process.env.SOCCER_DATA_DATABASE_URL
  ? new Pool({ connectionString: process.env.SOCCER_DATA_DATABASE_URL })
  : null;

async function checkTeamIdMismatch() {
  if (!soccerDataPool) {
    console.error('❌ SOCCER_DATA_DATABASE_URL is not configured');
    process.exit(1);
  }

  try {
    console.log('🔍 Checking team ID matching...\n');

    // Find the match
    const match = await soccerDataPool.query(`
      SELECT 
        m.match_id,
        m.date_utc::date as game_date,
        m.season,
        m.home_team_id,
        m.away_team_id,
        ht.team_name_std as home_team,
        at.team_name_std as away_team
      FROM public.matches m
      JOIN public.dim_team ht ON m.home_team_id = ht.team_id
      JOIN public.dim_team at ON m.away_team_id = at.team_id
      WHERE (ht.team_name_std ILIKE '%Werder%' OR ht.team_name_std ILIKE '%Bremen%' OR at.team_name_std ILIKE '%Werder%' OR at.team_name_std ILIKE '%Bremen%')
        AND (ht.team_name_std ILIKE '%Hoffenheim%' OR at.team_name_std ILIKE '%Hoffenheim%')
        AND m.date_utc::date = '2026-05-09'
      LIMIT 1;
    `);

    if (match.rows.length === 0) {
      console.log('❌ No match found on 2026-05-09');
      return;
    }

    const m = match.rows[0];
    console.log(`Match: ${m.home_team} (${m.home_team_id}) vs ${m.away_team} (${m.away_team_id})`);
    console.log(`Match ID: ${m.match_id}\n`);

    // Check what team IDs the function would match
    console.log('2. Team IDs that function would match:');
    const functionTeams = await soccerDataPool.query(`
      WITH 
      p_team_a := 'Werder Bremen',
      p_team_b := 'Hoffenheim',
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
            and ls.season = '2025-2026'
          limit 1
        ) standings_check on true
        where
          lower(dt.team_name_std) = lower(p_team_a)
          or dt.team_name_std ilike '%' || p_team_a || '%'
          or lower(p_team_a) = lower(regexp_replace(dt.team_name_std, '\\s+(FC|CF|United|City|Town|Athletic|Club)$', '', 'g'))
          or lower(regexp_replace(p_team_a, '\\s+(FC|CF|United|City|Town|Athletic|Club)$', '', 'g')) = lower(regexp_replace(dt.team_name_std, '\\s+(FC|CF|United|City|Town|Athletic|Club)$', '', 'g'))
        order by
          case when standings_check.has_standings = 1 then 0 else 1 end,
          case
            when lower(dt.team_name_std) = lower(p_team_a) then 0
            when lower(regexp_replace(dt.team_name_std, '\\s+(FC|CF|United|City|Town|Athletic|Club)$', '', 'g')) = lower(regexp_replace(p_team_a, '\\s+(FC|CF|United|City|Town|Athletic|Club)$', '', 'g')) then 1
            else 2
          end,
          length(dt.team_name_std) asc
        limit 1
      ),
      tb as (
        select 
          dt.team_id, 
          dt.team_name_std, 
          dt.league
        from public.dim_team dt
        left join lateral (
          select 1 as has_standings
          from public.league_standings ls
          where ls.team_id = dt.team_id
            and ls.season = '2025-2026'
          limit 1
        ) standings_check on true
        where
          lower(dt.team_name_std) = lower(p_team_b)
          or dt.team_name_std ilike '%' || p_team_b || '%'
          or lower(p_team_b) = lower(regexp_replace(dt.team_name_std, '\\s+(FC|CF|United|City|Town|Athletic|Club)$', '', 'g'))
          or lower(regexp_replace(p_team_b, '\\s+(FC|CF|United|City|Town|Athletic|Club)$', '', 'g')) = lower(regexp_replace(dt.team_name_std, '\\s+(FC|CF|United|City|Town|Athletic|Club)$', '', 'g'))
        order by
          case when standings_check.has_standings = 1 then 0 else 1 end,
          case
            when lower(dt.team_name_std) = lower(p_team_b) then 0
            when lower(regexp_replace(dt.team_name_std, '\\s+(FC|CF|United|City|Town|Athletic|Club)$', '', 'g')) = lower(regexp_replace(p_team_b, '\\s+(FC|CF|United|City|Town|Athletic|Club)$', '', 'g')) then 1
            else 2
          end,
          length(dt.team_name_std) asc
        limit 1
      )
      SELECT 
        (SELECT team_id FROM ta) as team_a_id,
        (SELECT team_name_std FROM ta) as team_a_name,
        (SELECT team_id FROM tb) as team_b_id,
        (SELECT team_name_std FROM tb) as team_b_name;
    `);

    if (functionTeams.rows.length > 0) {
      const ft = functionTeams.rows[0];
      console.log(`  Function would match:`);
      console.log(`    Team A: ${ft.team_a_name} (${ft.team_a_id})`);
      console.log(`    Team B: ${ft.team_b_name} (${ft.team_b_id})`);
      console.log(`\n  Match uses:`);
      console.log(`    Home: ${m.home_team} (${m.home_team_id})`);
      console.log(`    Away: ${m.away_team} (${m.away_team_id})`);
      
      const matchIds = [m.home_team_id, m.away_team_id];
      const functionIds = [ft.team_a_id, ft.team_b_id];
      
      const idsMatch = (matchIds.includes(ft.team_a_id) && matchIds.includes(ft.team_b_id));
      console.log(`\n  IDs match: ${idsMatch ? '✅' : '❌'}`);
      
      if (!idsMatch) {
        console.log('\n  ⚠️  MISMATCH DETECTED!');
        console.log('  The function is matching to different team IDs than the match uses.');
        console.log('  This means team_match_history won\'t find any data.');
      }
    }

    // Check team_match_stats for the actual match team IDs
    console.log('\n3. Checking team_match_stats for match team IDs:');
    const stats = await soccerDataPool.query(`
      SELECT 
        tms.team_id,
        dt.team_name_std,
        COUNT(*) as match_count
      FROM public.team_match_stats tms
      JOIN public.dim_team dt ON tms.team_id = dt.team_id
      JOIN public.matches m ON tms.match_id = m.match_id
      WHERE tms.team_id IN ($1, $2)
        AND m.season = $3
        AND m.date_utc::date < $4::date
      GROUP BY tms.team_id, dt.team_name_std;
    `, [m.home_team_id, m.away_team_id, m.season, m.game_date]);
    
    stats.rows.forEach(row => {
      console.log(`  ${row.team_name_std} (${row.team_id}): ${row.match_count} matches`);
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

checkTeamIdMismatch();


