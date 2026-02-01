import * as dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const ODDS_API_KEY = process.env.THE_ODDS_API_KEY;
if (!ODDS_API_KEY) {
    console.error('THE_ODDS_API_KEY not set in .env');
    process.exit(1);
}

// Map our league names to OddsAPI sport keys
const LEAGUE_TO_ODDS_API: { [key: string]: string } = {
    'NBA': 'basketball_nba',
    'NFL': 'americanfootball_nfl',
    'EPL': 'soccer_epl',
    'MLB': 'baseball_mlb',
    'NHL': 'icehockey_nhl',
    'Bundesliga': 'soccer_bundesliga',
    'La Liga': 'soccer_spain_la_liga',
    'Serie A': 'soccer_italy_serie_a',
    'Ligue 1': 'soccer_france_ligue_one',
};

interface OddsAPIGame {
    id: string;
    sport_key: string;
    sport_title: string;
    commence_time: string;
    home_team: string;
    away_team: string;
    bookmakers?: any[];
}

interface TeamMapping {
    [sport: string]: {
        [internalTeamName: string]: string; // Maps our name -> OddsAPI exact name
    };
}

async function fetchOddsAPITeams(sport: string): Promise<Set<string>> {
    const baseUrl = 'https://api.the-odds-api.com/v4';
    const params = new URLSearchParams({
        apiKey: ODDS_API_KEY!,
        regions: 'us',
        markets: 'h2h',
        dateFormat: 'iso',
        oddsFormat: 'american'
    });
    
    const url = `${baseUrl}/sports/${sport}/odds?${params.toString()}`;
    console.log(`Fetching teams from: ${sport}...`);
    
    try {
        const response = await fetch(url);
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`Error fetching ${sport}: ${response.status} - ${errorText.substring(0, 200)}`);
            return new Set();
        }
        
        const games: OddsAPIGame[] = await response.json();
        
        if (!Array.isArray(games)) {
            console.error(`Invalid response format for ${sport}`);
            return new Set();
        }
        
        const teams = new Set<string>();
        games.forEach(game => {
            if (game.home_team) teams.add(game.home_team);
            if (game.away_team) teams.add(game.away_team);
        });
        
        console.log(`  Found ${teams.size} unique teams in ${sport}`);
        return teams;
    } catch (error: any) {
        console.error(`Error fetching ${sport}:`, error.message);
        return new Set();
    }
}

async function fetchAllTeams(): Promise<TeamMapping> {
    const mapping: TeamMapping = {};
    
    // Fetch teams for each sport
    for (const [league, sportKey] of Object.entries(LEAGUE_TO_ODDS_API)) {
        const teams = await fetchOddsAPITeams(sportKey);
        
        if (teams.size > 0) {
            mapping[sportKey] = {};
            // For now, create identity mapping (our name -> OddsAPI name)
            // You'll need to manually map internal names to OddsAPI names
            teams.forEach(oddsApiName => {
                // Identity mapping - assumes our names match OddsAPI names
                mapping[sportKey][oddsApiName] = oddsApiName;
            });
            
            console.log(`\n${league} (${sportKey}) teams:`);
            Array.from(teams).sort().forEach(team => {
                console.log(`  - ${team}`);
            });
        }
    }
    
    return mapping;
}

async function main() {
    console.log('Fetching official team names from OddsAPI...\n');
    
    const mapping = await fetchAllTeams();
    
    // Save to JSON file
    const outputPath = path.resolve(process.cwd(), 'scripts/data/oddsapi-team-mapping.json');
    const outputDir = path.dirname(outputPath);
    
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    
    fs.writeFileSync(outputPath, JSON.stringify(mapping, null, 2));
    console.log(`\n✅ Saved team mapping to: ${outputPath}`);
    
    // Also create a reverse lookup (OddsAPI name -> possible internal names)
    const reverseMapping: { [sport: string]: string[] } = {};
    for (const [sport, teams] of Object.entries(mapping)) {
        reverseMapping[sport] = Object.keys(teams).sort();
    }
    
    const reversePath = path.resolve(process.cwd(), 'scripts/data/oddsapi-teams-list.json');
    fs.writeFileSync(reversePath, JSON.stringify(reverseMapping, null, 2));
    console.log(`✅ Saved team list to: ${reversePath}`);
    
    console.log('\n📋 Next steps:');
    console.log('1. Review the team names in oddsapi-teams-list.json');
    console.log('2. Update oddsapi-team-mapping.json to map your internal team names to OddsAPI names');
    console.log('3. Import the mapping in backend.ts for team name matching');
}

main().catch(console.error);

