/**
 * Test Werder Bremen vs Hoffenheim data retrieval
 */

import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const soccerDataPool: Pool | null = process.env.SOCCER_DATA_DATABASE_URL
  ? new Pool({ connectionString: process.env.SOCCER_DATA_DATABASE_URL })
  : null;

async function testWerderHoffenheim() {
  if (!soccerDataPool) {
    console.error('❌ SOCCER_DATA_DATABASE_URL is not configured');
    process.exit(1);
  }

  try {
    console.log('🔍 Testing Werder Bremen vs Hoffenheim data...\n');

    // 1. Check team matching
    console.log('1. Team matching:');
    const teams = await soccerDataPool.query(`
      SELECT team_id, team_name_std, league
      FROM public.dim_team
      WHERE team_name_std ILIKE '%Werder%' OR team_name_std ILIKE '%Bremen%' OR team_name_std ILIKE '%Hoffenheim%'
      ORDER BY team_name_std;
    `);
    teams.rows.forEach(row => {
      console.log(`  ${row.team_name_std} (${row.team_id}) - ${row.league}`);
    });
    console.log('');

    // 2. Check if match exists
    console.log('2. Finding match:');
    const match = await soccerDataPool.query(`
      SELECT 
        m.match_id,
        m.date_utc::date as game_date,
        m.season,
        m.league,
        ht.team_name_std as home_team,
        at.team_name_std as away_team
      FROM public.matches m
      JOIN public.dim_team ht ON m.home_team_id = ht.team_id
      JOIN public.dim_team at ON m.away_team_id = at.team_id
      WHERE (ht.team_name_std ILIKE '%Werder%' OR ht.team_name_std ILIKE '%Bremen%' OR at.team_name_std ILIKE '%Werder%' OR at.team_name_std ILIKE '%Bremen%')
        AND (ht.team_name_std ILIKE '%Hoffenheim%' OR at.team_name_std ILIKE '%Hoffenheim%')
      ORDER BY m.date_utc DESC
      LIMIT 5;
    `);
    console.log('Matches found:', match.rows.length);
    match.rows.forEach((row, i) => {
      console.log(`  ${i + 1}. ${row.home_team} vs ${row.away_team} on ${row.game_date} (${row.league}, ${row.season})`);
    });
    console.log('');

    // 3. Check team_match_stats for these teams
    if (match.rows.length > 0) {
      const testMatch = match.rows[0];
      console.log(`3. Checking team_match_stats for match on ${testMatch.game_date}:`);
      
      const stats = await soccerDataPool.query(`
        SELECT 
          tms.team_id,
          dt.team_name_std,
          tms.match_id,
          m.date_utc::date as match_date,
          tms.goals_for,
          tms.goals_against,
          tms.xg_for,
          tms.xg_against,
          (tms.xg_for - tms.xg_against) as xg_diff
        FROM public.team_match_stats tms
        JOIN public.dim_team dt ON tms.team_id = dt.team_id
        JOIN public.matches m ON tms.match_id = m.match_id
        WHERE tms.team_id IN (
          SELECT team_id FROM public.dim_team 
          WHERE team_name_std ILIKE '%Werder%' OR team_name_std ILIKE '%Bremen%' OR team_name_std ILIKE '%Hoffenheim%'
        )
        AND m.date_utc::date < $1
        AND m.season = $2
        ORDER BY m.date_utc DESC
        LIMIT 20;
      `, [testMatch.game_date, testMatch.season]);
      
      console.log(`  Found ${stats.rows.length} team_match_stats records`);
      if (stats.rows.length > 0) {
        stats.rows.slice(0, 5).forEach((row, i) => {
          console.log(`  ${i + 1}. ${row.team_name_std}: ${row.goals_for}-${row.goals_against} (xG: ${row.xg_for}-${row.xg_against}, diff: ${row.xg_diff}) on ${row.match_date}`);
        });
      } else {
        console.log('  ⚠️  No team_match_stats found!');
      }
      console.log('');

      // 4. Test the function directly
      console.log('4. Testing SQL function:');
      const funcResult = await soccerDataPool.query(`
        SELECT get_match_pack_v3_soccer('Werder Bremen', 'Hoffenheim', $1, $2) as pack;
      `, [testMatch.game_date, testMatch.season]);
      
      const pack = funcResult.rows[0].pack;
      if (pack.error) {
        console.log('  ❌ Function error:', pack.message);
        return;
      }
      
      const factDrop = pack.factDrop;
      if (factDrop && factDrop.bullets) {
        const last10 = factDrop.bullets.find((b: any) => b.key === 'last10');
        const last3 = factDrop.bullets.find((b: any) => b.key === 'last3');
        const standings = factDrop.bullets.find((b: any) => b.key === 'standings');
        
        console.log('  Last 10:', last10?.display || 'Not found');
        console.log('  Last 3:', last3?.display || 'Not found');
        console.log('  Standings:', standings?.display || 'Not found');
        
        if (last10) {
          console.log('  Last 10 raw:', JSON.stringify(last10.raw, null, 2));
        }
      }
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

testWerderHoffenheim();

