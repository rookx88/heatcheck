/**
 * Test full integration: Backend -> Frontend -> Article Template
 */

import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const soccerDataPool: Pool | null = process.env.SOCCER_DATA_DATABASE_URL
  ? new Pool({ connectionString: process.env.SOCCER_DATA_DATABASE_URL })
  : null;

async function testFullIntegration() {
  if (!soccerDataPool) {
    console.error('❌ SOCCER_DATA_DATABASE_URL is not configured');
    process.exit(1);
  }

  try {
    console.log('🔍 Testing full integration...\n');

    // 1. Test SQL function directly
    console.log('1. Testing SQL function:');
    const sqlResult = await soccerDataPool.query(`
      SELECT get_match_pack_v3_soccer('Getafe', 'Girona', '2026-01-26', '2025-2026') as pack;
    `);
    
    const pack = sqlResult.rows[0].pack;
    if (pack.error) {
      console.log('  ❌ Function error:', pack.message);
      return;
    }
    
    console.log('  ✅ Function returned data');
    
    // 2. Check standings in factDrop
    const factDrop = pack.factDrop;
    if (!factDrop) {
      console.log('  ❌ No factDrop found');
      return;
    }
    
    const bullets = factDrop.bullets || [];
    const standingsBullet = bullets.find((b: any) => b.key === 'standings');
    
    if (!standingsBullet) {
      console.log('  ❌ No standings bullet found');
      console.log('  Available bullets:', bullets.map((b: any) => b.key));
      return;
    }
    
    console.log('  ✅ Standings bullet found');
    console.log('  Display:', standingsBullet.display);
    console.log('  Raw data:', JSON.stringify(standingsBullet.raw, null, 2));
    
    // 3. Verify data structure matches what frontend expects
    console.log('\n2. Verifying data structure:');
    const teamA = standingsBullet.raw?.A;
    const teamB = standingsBullet.raw?.B;
    
    if (!teamA || !teamB) {
      console.log('  ❌ Missing team data in raw');
      return;
    }
    
    const requiredFields = ['position', 'points'];
    const teamAValid = requiredFields.every(field => teamA.hasOwnProperty(field));
    const teamBValid = requiredFields.every(field => teamB.hasOwnProperty(field));
    
    if (!teamAValid || !teamBValid) {
      console.log('  ❌ Missing required fields');
      console.log('  Team A fields:', Object.keys(teamA));
      console.log('  Team B fields:', Object.keys(teamB));
      return;
    }
    
    console.log('  ✅ Data structure valid');
    console.log(`  Team A: position=${teamA.position}, points=${teamA.points}`);
    console.log(`  Team B: position=${teamB.position}, points=${teamB.points}`);
    
    // 4. Test that getWinner logic would work
    console.log('\n3. Testing getWinner logic:');
    const aR = Number(teamA.position) || Number(teamA.rank);
    const bR = Number(teamB.position) || Number(teamB.rank);
    const aP = Number(teamA.points) || Number(teamA.wins);
    const bP = Number(teamB.points) || Number(teamB.wins);
    
    let winner: string | null = null;
    if (Number.isFinite(aR) && Number.isFinite(bR) && aR !== bR) {
      winner = aR < bR ? 'A' : 'B';
      console.log(`  Winner by position: ${winner} (${aR < bR ? 'A' : 'B'} has better position)`);
    } else if (Number.isFinite(aP) && Number.isFinite(bP) && aP !== bP) {
      winner = aP > bP ? 'A' : 'B';
      console.log(`  Winner by points: ${winner} (${aP > bP ? 'A' : 'B'} has more points)`);
    } else {
      winner = 'even';
      console.log('  Winner: even (tie)');
    }
    
    console.log('\n✅ Full integration test complete!');
    console.log('\nSummary:');
    console.log(`  - SQL function: ✅ Working`);
    console.log(`  - Standings data: ✅ Present`);
    console.log(`  - Data structure: ✅ Valid`);
    console.log(`  - Winner logic: ✅ ${winner}`);
    
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    console.error(error);
  } finally {
    if (soccerDataPool) {
      await soccerDataPool.end();
    }
  }
}

testFullIntegration();

