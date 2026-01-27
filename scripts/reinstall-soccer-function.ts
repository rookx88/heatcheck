/**
 * Reinstall the get_match_pack_v3_soccer SQL function
 */

import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { join } from 'path';

dotenv.config({ path: '.env.local' });

const soccerDataPool: Pool | null = process.env.SOCCER_DATA_DATABASE_URL
  ? new Pool({ connectionString: process.env.SOCCER_DATA_DATABASE_URL })
  : null;

async function reinstallFunction() {
  if (!soccerDataPool) {
    console.error('❌ SOCCER_DATA_DATABASE_URL is not configured');
    process.exit(1);
  }

  try {
    console.log('📦 Reading SQL function file...');
    const sqlFile = readFileSync(join(process.cwd(), 'scripts/sql/soccer_data/get_match_pack_v3_soccer.sql'), 'utf-8');
    
    console.log('🔄 Installing/updating function...');
    await soccerDataPool.query(sqlFile);
    
    console.log('✅ Function installed successfully!');
    
    // Test the function
    console.log('\n🧪 Testing function with Getafe vs Girona on 2026-01-26...');
    const testResult = await soccerDataPool.query(`
      WITH result AS (
        SELECT get_match_pack_v3_soccer('Getafe', 'Girona', '2026-01-26', '2025-2026') as data
      )
      SELECT 
        jsonb_array_elements(result.data->'factDrop'->'bullets') as bullet
      FROM result;
    `);
    
    console.log('All bullets:');
    testResult.rows.forEach((row, i) => {
      const bullet = row.bullet;
      const key = bullet?.key || bullet?.['key'];
      const label = bullet?.label || bullet?.['label'];
      const display = bullet?.display || bullet?.['display'];
      const raw = bullet?.raw || bullet?.['raw'];
      console.log(`${i}. Key: ${key}, Label: ${label}`);
      if (key === 'standings') {
        console.log(`   Display: ${display}`);
        console.log(`   RAW: ${JSON.stringify(raw)}`);
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

reinstallFunction();

