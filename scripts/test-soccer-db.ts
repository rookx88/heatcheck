/**
 * Test script to verify soccer database connection and schema
 * Run with: npx ts-node scripts/test-soccer-db.ts
 */

import { Pool } from 'pg';
import 'dotenv/config';

const soccerDataPool: Pool | null = process.env.SOCCER_DATA_DATABASE_URL
  ? new Pool({ connectionString: process.env.SOCCER_DATA_DATABASE_URL })
  : null;

async function testSoccerDatabase() {
  console.log('=== Testing Soccer Database Connection ===\n');

  if (!soccerDataPool) {
    console.error('❌ SOCCER_DATA_DATABASE_URL is not configured');
    console.log('Please set SOCCER_DATA_DATABASE_URL in your .env file');
    process.exit(1);
  }

  try {
    // Test 1: Basic connection
    console.log('1. Testing basic connection...');
    const connectionTest = await soccerDataPool.query('SELECT NOW() as current_time, version() as postgres_version');
    console.log('✅ Connection successful!');
    console.log(`   Current time: ${connectionTest.rows[0].current_time}`);
    console.log(`   PostgreSQL version: ${connectionTest.rows[0].postgres_version.split(',')[0]}\n`);

    // Test 2: Check if public schema exists
    console.log('2. Checking schema...');
    const schemaCheck = await soccerDataPool.query(`
      SELECT schema_name 
      FROM information_schema.schemata 
      WHERE schema_name = 'public'
    `);
    if (schemaCheck.rows.length > 0) {
      console.log('✅ Public schema exists\n');
    } else {
      console.log('⚠️  Public schema not found\n');
    }

    // Test 3: List all tables
    console.log('3. Listing available tables...');
    const tables = await soccerDataPool.query(`
      SELECT table_name, table_type
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    if (tables.rows.length > 0) {
      console.log(`✅ Found ${tables.rows.length} table(s):`);
      tables.rows.forEach(row => {
        console.log(`   - ${row.table_name} (${row.table_type})`);
      });
      console.log('');
    } else {
      console.log('⚠️  No tables found in public schema\n');
    }

    // Test 4: Check for teams table
    console.log('4. Checking for teams table...');
    const teamsTable = await soccerDataPool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'teams'
      ORDER BY ordinal_position
    `);
    if (teamsTable.rows.length > 0) {
      console.log(`✅ Teams table exists with ${teamsTable.rows.length} column(s):`);
      teamsTable.rows.forEach(row => {
        console.log(`   - ${row.column_name} (${row.data_type}, nullable: ${row.is_nullable})`);
      });
      console.log('');
    } else {
      console.log('⚠️  Teams table not found\n');
    }

    // Test 5: Check for games/matches table
    console.log('5. Checking for games/matches table...');
    const gamesTable = await soccerDataPool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' 
        AND (table_name = 'games' OR table_name = 'matches')
      ORDER BY table_name
    `);
    if (gamesTable.rows.length > 0) {
      console.log(`✅ Found games/matches table: ${gamesTable.rows[0].table_name}`);
      const gameColumns = await soccerDataPool.query(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position
        LIMIT 10
      `, [gamesTable.rows[0].table_name]);
      console.log(`   Sample columns (first 10):`);
      gameColumns.rows.forEach(row => {
        console.log(`   - ${row.column_name} (${row.data_type})`);
      });
      console.log('');
    } else {
      console.log('⚠️  Games/matches table not found\n');
    }

    // Test 6: Try to get sample teams
    console.log('6. Getting sample teams...');
    try {
      const sampleTeams = await soccerDataPool.query(`
        SELECT team_id, full_name, abbreviation
        FROM public.teams
        LIMIT 5
      `);
      if (sampleTeams.rows.length > 0) {
        console.log(`✅ Found ${sampleTeams.rows.length} sample team(s):`);
        sampleTeams.rows.forEach(row => {
          console.log(`   - ${row.full_name || 'N/A'} (${row.abbreviation || 'N/A'}) [ID: ${row.team_id}]`);
        });
        console.log('');
      } else {
        console.log('⚠️  Teams table exists but is empty\n');
      }
    } catch (e: any) {
      console.log(`⚠️  Could not query teams table: ${e.message}\n`);
    }

    // Test 7: Try to get sample games
    console.log('7. Getting sample games...');
    try {
      const gameTableName = gamesTable.rows.length > 0 ? gamesTable.rows[0].table_name : 'games';
      const sampleGames = await soccerDataPool.query(`
        SELECT game_id, game_date_utc, game_date_local, home_team_id, away_team_id, league
        FROM public.${gameTableName}
        WHERE game_date_utc >= NOW() - INTERVAL '30 days'
        ORDER BY game_date_utc DESC
        LIMIT 5
      `);
      if (sampleGames.rows.length > 0) {
        console.log(`✅ Found ${sampleGames.rows.length} recent game(s):`);
        sampleGames.rows.forEach(row => {
          console.log(`   - Game ID: ${row.game_id}, Date: ${row.game_date_local || row.game_date_utc}, League: ${row.league || 'N/A'}`);
        });
        console.log('');
      } else {
        console.log('⚠️  No recent games found\n');
      }
    } catch (e: any) {
      console.log(`⚠️  Could not query games table: ${e.message}\n`);
    }

    // Test 8: Check if SQL function exists
    console.log('8. Checking for get_match_pack_v3_soccer function...');
    const functionCheck = await soccerDataPool.query(`
      SELECT routine_name, routine_type
      FROM information_schema.routines
      WHERE routine_schema = 'public' 
        AND routine_name = 'get_match_pack_v3_soccer'
    `);
    if (functionCheck.rows.length > 0) {
      console.log('✅ Function get_match_pack_v3_soccer exists\n');
    } else {
      console.log('⚠️  Function get_match_pack_v3_soccer not found');
      console.log('   Install it with: psql "$SOCCER_DATA_DATABASE_URL" -f scripts/sql/soccer_data/get_match_pack_v3_soccer.sql\n');
    }

    console.log('=== Test Complete ===');
    console.log('\nNext steps:');
    console.log('1. Review the table/column names above');
    console.log('2. Update get_match_pack_v3_soccer.sql if column names differ');
    console.log('3. Install the SQL function: psql "$SOCCER_DATA_DATABASE_URL" -f scripts/sql/soccer_data/get_match_pack_v3_soccer.sql');

  } catch (error: any) {
    console.error('❌ Error testing database:', error.message);
    if (error.stack) {
      console.error('Stack trace:', error.stack);
    }
    process.exit(1);
  } finally {
    await soccerDataPool.end();
  }
}

testSoccerDatabase();

