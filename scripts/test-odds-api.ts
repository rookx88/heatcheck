/**
 * Test TheOddsAPI connection and quota status
 */

import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const ODDS_API_KEY = process.env.THE_ODDS_API_KEY;

async function testOddsAPI() {
  if (!ODDS_API_KEY) {
    console.error('❌ THE_ODDS_API_KEY is not configured in .env.local');
    process.exit(1);
  }

  console.log('🔍 Testing TheOddsAPI connection...\n');
  console.log(`API Key configured: ${ODDS_API_KEY ? 'YES (length: ' + ODDS_API_KEY.length + ')' : 'NO'}\n`);

  try {
    // Test 1: Check API status/usage
    console.log('1. Testing API connection with a simple request...');
    const baseUrl = 'https://api.the-odds-api.com/v4';
    const params = new URLSearchParams({
      apiKey: ODDS_API_KEY,
      regions: 'us',
      markets: 'h2h',
      dateFormat: 'iso',
      oddsFormat: 'american'
    });
    
    const url = `${baseUrl}/sports/basketball_nba/odds?${params.toString()}`;
    console.log(`   URL: ${baseUrl}/sports/basketball_nba/odds`);
    
    const response = await fetch(url);
    const responseText = await response.text();
    
    console.log(`   Status: ${response.status} ${response.statusText}`);
    
    if (!response.ok) {
      let errorData: any;
      try {
        errorData = JSON.parse(responseText);
      } catch {
        errorData = { message: responseText };
      }
      
      console.log(`   ❌ Error Response:`, JSON.stringify(errorData, null, 2));
      
      if (errorData.error_code === 'OUT_OF_USAGE_CREDITS' || response.status === 401) {
        console.log('\n⚠️  QUOTA ISSUE DETECTED:');
        console.log('   TheOddsAPI usage quota has been reached.');
        console.log('   You need to either:');
        console.log('   1. Upgrade your plan at https://the-odds-api.com');
        console.log('   2. Wait for your quota to reset (usually monthly)');
        console.log('   3. Use a different API key with available quota');
      }
      
      return;
    }
    
    const games = JSON.parse(responseText);
    if (Array.isArray(games)) {
      console.log(`   ✅ Success! Received ${games.length} games`);
      if (games.length > 0) {
        console.log(`   Sample game: ${games[0].home_team} vs ${games[0].away_team}`);
      }
    } else {
      console.log(`   ⚠️  Unexpected response format:`, typeof games);
      console.log(`   Response:`, JSON.stringify(games, null, 2).substring(0, 500));
    }
    
    // Test 2: Check if we can find a specific game
    console.log('\n2. Testing find-event endpoint...');
    const testParams = new URLSearchParams({
      teamA: 'Portland Trail Blazers',
      teamB: 'Washington Wizards',
      gameDate: '2026-01-26',
      sport: 'basketball_nba'
    });
    
    // Note: This would need to be tested through the backend endpoint
    // since it requires authentication
    console.log('   (This requires backend endpoint - test manually)');
    
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    console.error(error);
  }
}

testOddsAPI();

