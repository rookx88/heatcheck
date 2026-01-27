/**
 * Direct test of Girona matching
 */

import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const soccerDataPool: Pool | null = process.env.SOCCER_DATA_DATABASE_URL
  ? new Pool({ connectionString: process.env.SOCCER_DATA_DATABASE_URL })
  : null;

async function testGirona() {
  if (!soccerDataPool) {
    console.error('❌ SOCCER_DATA_DATABASE_URL is not configured');
    process.exit(1);
  }

  try {
    console.log('🔍 Testing Girona matching directly...\n');

    // Test the function
    const result = await soccerDataPool.query(`
      SELECT get_match_pack_v3_soccer('Getafe', 'Girona', '2026-01-26', '2025-2026') as data;
    `);
    
    const data = result.rows[0].data;
    console.log('Function returned data:', !!data);
    console.log('Full response:', JSON.stringify(data, null, 2));
    
    if (data && data.error) {
      console.log('ERROR:', data.message);
      console.log('Input:', data.input);
    } else if (data && data.factDrop && data.factDrop.bullets) {
      const standingsBullet = data.factDrop.bullets.find((b: any) => b.key === 'standings');
      if (standingsBullet) {
        console.log('Standings display:', standingsBullet.display);
        console.log('Standings raw:', JSON.stringify(standingsBullet.raw, null, 2));
      } else {
        console.log('No standings bullet found');
      }
    } else {
      console.log('No factDrop or bullets found');
      console.log('Keys:', Object.keys(data || {}));
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

testGirona();

