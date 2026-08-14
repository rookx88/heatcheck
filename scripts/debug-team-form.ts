/**
 * Debug team form calculation
 */

import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const soccerDataPool: Pool | null = process.env.SOCCER_DATA_DATABASE_URL
  ? new Pool({ connectionString: process.env.SOCCER_DATA_DATABASE_URL })
  : null;

async function debugTeamForm() {
  if (!soccerDataPool) {
    console.error('❌ SOCCER_DATA_DATABASE_URL is not configured');
    process.exit(1);
  }

  try {
    console.log('🔍 Debugging team form calculation...\n');

    // Test with the actual team IDs that are being matched
    const teamAId = 1282; // SV Werder Bremen
    const teamBId = 1273; // TSG Hoffenheim
    const gameDate = '2026-05-09';
    const season = '2025-2026';

    console.log(`Testing with team IDs: ${teamAId} (Werder Bremen) and ${teamBId} (Hoffenheim)`);
    console.log(`Game date: ${gameDate}, Season: ${season}\n`);

    // Check what team_match_history would find
    const history = await soccerDataPool.query(`
      SELECT 
        tms.team_id,
        dt.team_name_std,
        tms.match_id,
        m.date_utc::date as match_date,
        tms.goals_for,
        tms.goals_against,
        tms.xg_for,
        tms.xg_against,
        (tms.xg_for - tms.xg_against)::numeric as xg_diff,
        case when tms.goals_for > tms.goals_against then 'W'
             when tms.goals_for < tms.goals_against then 'L'
             else 'D' end as result
      FROM public.team_match_stats tms
      JOIN public.matches m ON m.match_id = tms.match_id
      WHERE tms.team_id IN ($1, $2)
        AND (m.season = $3 OR $3 IS NULL)
        AND m.date_utc::date < $4::date
        AND m.date_utc < (SELECT date_utc FROM public.matches WHERE date_utc::date = $4::date LIMIT 1)
      ORDER BY m.date_utc DESC
      LIMIT 20;
    `, [teamAId, teamBId, season, gameDate]);

    console.log(`Found ${history.rows.length} team_match_stats records before ${gameDate}`);
    if (history.rows.length > 0) {
      history.rows.slice(0, 10).forEach((row, i) => {
        console.log(`  ${i + 1}. ${row.team_name_std} (${row.team_id}): ${row.goals_for}-${row.goals_against} (xG: ${row.xg_for}-${row.xg_against}, diff: ${row.xg_diff}, result: ${row.result}) on ${row.match_date}`);
      });
    } else {
      console.log('  ⚠️  No records found!');
      
      // Check if there's a match on that date
      const matchCheck = await soccerDataPool.query(`
        SELECT match_id, date_utc, date_utc::date as game_date
        FROM public.matches
        WHERE date_utc::date = $1::date
        LIMIT 1;
      `, [gameDate]);
      
      if (matchCheck.rows.length === 0) {
        console.log(`  ⚠️  No match found on ${gameDate}`);
      } else {
        console.log(`  ✅ Match found on ${gameDate}: ${matchCheck.rows[0].match_id}`);
        
        // Check team_match_stats for that match
        const matchStats = await soccerDataPool.query(`
          SELECT tms.*, dt.team_name_std
          FROM public.team_match_stats tms
          JOIN public.dim_team dt ON tms.team_id = dt.team_id
          WHERE tms.match_id = $1;
        `, [matchCheck.rows[0].match_id]);
        
        console.log(`  Team stats for this match: ${matchStats.rows.length} records`);
        matchStats.rows.forEach(row => {
          console.log(`    ${row.team_name_std} (${row.team_id}): ${row.goals_for}-${row.goals_against}`);
        });
      }
    }

    // Check the actual query from the function
    console.log('\n2. Testing the exact query from team_match_history CTE:');
    const exactQuery = await soccerDataPool.query(`
      WITH ctx as (
        SELECT 
          $1::int as team_a_id,
          $2::int as team_b_id,
          $3::varchar as season,
          $4::date as game_date,
          (SELECT date_utc FROM public.matches WHERE date_utc::date = $4::date LIMIT 1) as date_utc
      )
      SELECT 
        tms.team_id,
        tms.match_id,
        m.date_utc::date as match_date,
        tms.goals_for,
        tms.goals_against,
        tms.xg_for,
        tms.xg_against,
        (tms.xg_for - tms.xg_against)::numeric as xg_diff,
        case when tms.goals_for > tms.goals_against then 'W'
             when tms.goals_for < tms.goals_against then 'L'
             else 'D' end as result,
        row_number() over (partition by tms.team_id order by m.date_utc desc) as rn
      FROM public.team_match_stats tms
      JOIN public.matches m on m.match_id = tms.match_id
      JOIN ctx c on tms.team_id in (c.team_a_id, c.team_b_id)
      WHERE (c.season is null or m.season = c.season)
        AND (c.game_date is null or m.date_utc::date < c.game_date)
        AND m.date_utc < c.date_utc
      ORDER BY m.date_utc desc
      LIMIT 20;
    `, [teamAId, teamBId, season, gameDate]);

    console.log(`Found ${exactQuery.rows.length} records with exact CTE logic`);
    if (exactQuery.rows.length > 0) {
      exactQuery.rows.slice(0, 10).forEach((row, i) => {
        console.log(`  ${i + 1}. Team ${row.team_id}, rn=${row.rn}: ${row.goals_for}-${row.goals_against} (xG diff: ${row.xg_diff}, result: ${row.result}) on ${row.match_date}`);
      });
    }

  } catch (error: any) {
    console.error('❌ Error:', error.message);
    console.error(error);
  } finally {
    if (soccerDataPool) {
      await soccerDataPool.end();
    }
  }
}

debugTeamForm();















