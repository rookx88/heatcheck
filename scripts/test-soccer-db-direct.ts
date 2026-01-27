/**
 * Test script to verify soccer database connection
 * Uses the connection string directly for testing
 * Run with: npx tsx scripts/test-soccer-db-direct.ts
 */

import { Pool } from 'pg';

// Use the connection string from the plan
const SOCCER_DB_URL = process.env.SOCCER_DATA_DATABASE_URL || 'postgresql://postgres@localhost:5432/soccerdata';

console.log('=== Testing Soccer Database Connection ===\n');
console.log(`Connection string: ${SOCCER_DB_URL.replace(/:[^:@]+@/, ':****@')}\n`);

const soccerDataPool = new Pool({ connectionString: SOCCER_DB_URL });

async function testSoccerDatabase() {
  try {
    // Test 1: Basic connection
    console.log('1. Testing basic connection...');
    const connectionTest = await soccerDataPool.query('SELECT NOW() as current_time, version() as postgres_version');
    console.log('✅ Connection successful!');
    console.log(`   Current time: ${connectionTest.rows[0].current_time}`);
    console.log(`   PostgreSQL version: ${connectionTest.rows[0].postgres_version.split(',')[0]}\n`);

    // Test 2: List all tables
    console.log('2. Listing available tables...');
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

    // Test 3: Check for teams table
    console.log('3. Checking for teams table...');
    const teamsTable = await soccerDataPool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'teams'
      ORDER BY ordinal_position
    `);
    if (teamsTable.rows.length > 0) {
      console.log(`✅ Teams table exists with ${teamsTable.rows.length} column(s):`);
      teamsTable.rows.slice(0, 10).forEach(row => {
        console.log(`   - ${row.column_name} (${row.data_type}, nullable: ${row.is_nullable})`);
      });
      if (teamsTable.rows.length > 10) {
        console.log(`   ... and ${teamsTable.rows.length - 10} more columns`);
      }
      console.log('');
    } else {
      console.log('⚠️  Teams table not found\n');
    }

    // Test 4: Get sample teams
    console.log('4. Getting sample teams...');
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
      const tableName = gamesTable.rows[0].table_name;
      console.log(`✅ Found games/matches table: ${tableName}`);
      const gameColumns = await soccerDataPool.query(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position
        LIMIT 15
      `, [tableName]);
      console.log(`   Columns (first 15):`);
      gameColumns.rows.forEach(row => {
        console.log(`   - ${row.column_name} (${row.data_type})`);
      });
      console.log('');
    } else {
      console.log('⚠️  Games/matches table not found\n');
    }

    // Test 6: Get sample games
    console.log('6. Getting sample games...');
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

    // Test 7: Check for SQL function
    console.log('7. Checking for get_match_pack_v3_soccer function...');
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
    console.log('\nSummary:');
    console.log('- Database connection: ✅ Working');
    console.log('- Tables found: Check output above');
    console.log('- Next step: Review table structure and update SQL function if needed');

  } catch (error: any) {
    console.error('❌ Error testing database:', error.message);
    if (error.code === 'ECONNREFUSED') {
      console.error('   Connection refused - is PostgreSQL running on localhost:5432?');
    } else if (error.code === 'ENOTFOUND') {
      console.error('   Host not found - check your connection string');
    } else if (error.message.includes('database') && error.message.includes('does not exist')) {
      console.error('   Database does not exist - create it first');
    }
    if (error.stack) {
      console.error('\nStack trace:', error.stack);
    }
    process.exit(1);
  } finally {
    await soccerDataPool.end();
  }
}

testSoccerDatabase();

