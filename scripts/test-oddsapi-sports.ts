/**
 * Test script to query TheOddsAPI sports endpoint
 * This will help us find the correct sport key for Bundesliga
 */

import 'dotenv/config';
import fetch from 'node-fetch';

async function testOddsAPISports() {
    const apiKey = process.env.THE_ODDS_API_KEY;
    
    if (!apiKey) {
        console.error('THE_ODDS_API_KEY not found in environment variables');
        process.exit(1);
    }

    try {
        const url = `https://api.the-odds-api.com/v4/sports?apiKey=${apiKey}`;
        console.log('Fetching available sports from TheOddsAPI...\n');
        
        const response = await fetch(url);
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`Error (${response.status}):`, errorText);
            process.exit(1);
        }

        const sports = await response.json() as any[];
        
        console.log(`Found ${sports.length} total sports\n`);
        
        // Filter for soccer-related sports
        const soccerSports = sports.filter(s => 
            s.key && (
                s.key.toLowerCase().includes('soccer') || 
                s.key.toLowerCase().includes('football') ||
                s.title?.toLowerCase().includes('bundesliga') ||
                s.title?.toLowerCase().includes('germany')
            )
        );
        
        console.log('=== SOCCER-RELATED SPORTS ===');
        soccerSports.forEach(sport => {
            console.log(`Key: ${sport.key}`);
            console.log(`Title: ${sport.title}`);
            console.log(`Description: ${sport.description || 'N/A'}`);
            console.log('---');
        });
        
        // Specifically look for Bundesliga
        const bundesligaSports = sports.filter(s => 
            s.key?.toLowerCase().includes('bundesliga') ||
            s.title?.toLowerCase().includes('bundesliga') ||
            (s.title?.toLowerCase().includes('germany') && s.title?.toLowerCase().includes('soccer'))
        );
        
        console.log('\n=== BUNDESLIGA-RELATED SPORTS ===');
        if (bundesligaSports.length > 0) {
            bundesligaSports.forEach(sport => {
                console.log(`Key: ${sport.key}`);
                console.log(`Title: ${sport.title}`);
                console.log(`Description: ${sport.description || 'N/A'}`);
                console.log('---');
            });
        } else {
            console.log('No Bundesliga-specific sport found. Checking all German soccer sports...');
            const germanSoccer = sports.filter(s => 
                s.title?.toLowerCase().includes('germany') && 
                (s.key?.toLowerCase().includes('soccer') || s.title?.toLowerCase().includes('soccer'))
            );
            germanSoccer.forEach(sport => {
                console.log(`Key: ${sport.key}`);
                console.log(`Title: ${sport.title}`);
                console.log('---');
            });
        }
        
    } catch (error: any) {
        console.error('Error fetching sports:', error.message);
        process.exit(1);
    }
}

testOddsAPISports();

