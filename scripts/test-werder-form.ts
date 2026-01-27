/**
 * Test Werder Bremen vs Hoffenheim form data
 */

import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const soccerDataPool: Pool | null = process.env.SOCCER_DATA_DATABASE_URL
  ? new Pool({ connectionString: process.env.SOCCER_DATA_DATABASE_URL })
  : null;

async function testWerderForm() {
  if (!soccerDataPool) {
    console.error('❌ SOCCER_DATA_DATABASE_URL is not configured');
    process.exit(1);
  }

  try {
    console.log('🔍 Testing Werder Bremen vs Hoffenheim form data...\n');

    // Test the function
    const result = await soccerDataPool.query(`
      SELECT get_match_pack_v3_soccer('Werder Bremen', 'Hoffenheim', '2026-05-09', '2025-2026') as pack;
    `);
    
    const pack = result.rows[0].pack;
    if (pack.error) {
      console.log('❌ Function error:', pack.message);
      return;
    }
    
    const factDrop = pack.factDrop;
    if (!factDrop || !factDrop.bullets) {
      console.log('❌ No factDrop or bullets found');
      return;
    }
    
    const bullets = factDrop.bullets;
    console.log('Bullets found:');
    bullets.forEach((b: any, i: number) => {
      console.log(`${i}. ${b.key}: ${b.display || 'N/A'}`);
      if (b.key === 'last10' || b.key === 'last3') {
        console.log(`   Raw: ${JSON.stringify(b.raw)}`);
      }
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

testWerderForm();

