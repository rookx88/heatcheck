import { Pool } from 'pg';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

interface HeatcheckPost {
    id: string;
    league: string;
    teamA: string;
    teamB: string;
    matchupScheduledDate?: string;
    createdAt: string;
    updatedAt: string;
    websiteStory: {
        headline: string;
        dek: string;
        seo: {
            slug: string;
        };
        image?: string;
        imageUrl?: string;
    };
    heatCheckData?: any;
    storyType?: string;
}

// Copy of the unified heat score calculation function
function calculateHeatScoreFromMatchupData(post: HeatcheckPost): { total: number; breakdown: { stakes: number; recency: number; payback: number; history: number; emotion: number } } {
    // Special handling for DFS articles
    if (post.storyType === 'dfs_article') {
        const heatCheckData = post.heatCheckData as any;
        const dfsPlayers = heatCheckData?.dfsPlayers || [];
        const articleDate = post.matchupScheduledDate || post.createdAt;
        
        let daysAgo = 365;
        if (articleDate) {
            try {
                const articleDateTime = new Date(articleDate);
                const now = new Date();
                const diffTime = Math.abs(now.getTime() - articleDateTime.getTime());
                daysAgo = Math.floor(diffTime / (1000 * 60 * 60 * 24));
            } catch {
                daysAgo = 365;
            }
        }
        
        let recencyScore = 0;
        if (daysAgo === 0) recencyScore = 20;
        else if (daysAgo === 1) recencyScore = 15;
        else if (daysAgo === 2) recencyScore = 10;
        else if (daysAgo <= 7) recencyScore = 8;
        else if (daysAgo <= 30) recencyScore = 5;
        else recencyScore = 2;
        
        let stakesScore = 0;
        const playerCount = dfsPlayers.length;
        if (playerCount >= 10) stakesScore = 18;
        else if (playerCount >= 8) stakesScore = 15;
        else if (playerCount >= 5) stakesScore = 12;
        else if (playerCount >= 3) stakesScore = 8;
        else stakesScore = 5;
        
        let emotionScore = 0;
        if (playerCount > 0) {
            const avgConfidence = dfsPlayers.reduce((sum: number, p: any) => sum + (p.confidenceScore || 0), 0) / playerCount;
            if (avgConfidence >= 80) emotionScore = 18;
            else if (avgConfidence >= 70) emotionScore = 15;
            else if (avgConfidence >= 60) emotionScore = 12;
            else if (avgConfidence >= 50) emotionScore = 8;
            else emotionScore = 5;
        }
        
        const narrativeTypes = new Set(dfsPlayers.map((p: any) => p.narrativeType || '').filter(Boolean));
        let historyScore = 0;
        if (narrativeTypes.size >= 5) historyScore = 18;
        else if (narrativeTypes.size >= 4) historyScore = 15;
        else if (narrativeTypes.size >= 3) historyScore = 12;
        else if (narrativeTypes.size >= 2) historyScore = 8;
        else historyScore = 5;
        
        let paybackScore = 0;
        const paybackNarratives = dfsPlayers.filter((p: any) => {
            const type = (p.narrativeType || '').toLowerCase();
            return type.includes('revenge') || type.includes('motivation') || type.includes('homecoming');
        }).length;
        if (paybackNarratives >= 5) paybackScore = 18;
        else if (paybackNarratives >= 3) paybackScore = 15;
        else if (paybackNarratives >= 2) paybackScore = 12;
        else if (paybackNarratives >= 1) paybackScore = 8;
        else paybackScore = 5;
        
        const total = stakesScore + recencyScore + paybackScore + historyScore + emotionScore;
        
        return {
            total: Math.min(100, Math.max(0, total)),
            breakdown: {
                stakes: stakesScore,
                recency: recencyScore,
                payback: paybackScore,
                history: historyScore,
                emotion: emotionScore
            }
        };
    }
    
    if (!post.heatCheckData) {
        return {
            total: 0,
            breakdown: { stakes: 0, recency: 0, payback: 0, history: 0, emotion: 0 }
        };
    }
    
    const heatCheckData = post.heatCheckData as any;
    const matchPackV3 = heatCheckData.matchPackV3;
    const factPack = heatCheckData.fact_pack || heatCheckData.factPack || {};
    const evidenceBundle = heatCheckData.evidence_bundle || heatCheckData.evidenceBundle || {};
    const narratives = heatCheckData.narratives || {};
    
    // Base score from statistical signals (0-60 points)
    let baseScore = 0;
    let momentumScore = 0;
    let availabilityScore = 0;
    let closeGamesScore = 0;
    let comparisonsScore = 0;
    
    // If matchPackV3 exists, use Heat Picks signals
    if (matchPackV3?.factDrop) {
        const factDrop = matchPackV3.factDrop;
        const teamForm = factDrop.raw?.teamForm || {};
        const comparisons = factDrop.comparisons || [];
        const availability = factDrop.raw?.availability;
        
        const aMargin10 = teamForm.A?.margin10 || teamForm.A?.xgDiff10 || 0;
        const aMargin3 = teamForm.A?.margin3 || teamForm.A?.xgDiff3 || 0;
        const bMargin10 = teamForm.B?.margin10 || teamForm.B?.xgDiff10 || 0;
        const bMargin3 = teamForm.B?.margin3 || teamForm.B?.xgDiff3 || 0;
        const momentumDivergence = Math.abs((aMargin3 - aMargin10) - (bMargin3 - bMargin10));
        momentumScore = Math.min(20, momentumDivergence * 2);
        
        const aAbsences = availability?.majorAbsences?.A?.count || 0;
        const bAbsences = availability?.majorAbsences?.B?.count || 0;
        const availabilityDiff = Math.abs(aAbsences - bAbsences);
        availabilityScore = Math.min(15, availabilityDiff * 3);
        
        const closeMarginComp = comparisons.find((c: any) => c?.key === 'closeMargin');
        if (closeMarginComp) {
            const aCloseW = teamForm.A?.closeW10 || 0;
            const aCloseL = teamForm.A?.closeL10 || 0;
            const bCloseW = teamForm.B?.closeW10 || 0;
            const bCloseL = teamForm.B?.closeL10 || 0;
            const aCloseRate = aCloseW + aCloseL > 0 ? aCloseW / (aCloseW + aCloseL) : 0;
            const bCloseRate = bCloseW + bCloseL > 0 ? bCloseW / (bCloseW + bCloseL) : 0;
            const closeGameDiff = Math.abs(aCloseRate - bCloseRate);
            closeGamesScore = Math.min(15, closeGameDiff * 30);
        }
        
        let comparisonsTotal = 0;
        comparisons.forEach((comp: any) => {
            if (comp?.key && comp?.key !== 'closeMargin') {
                const aVal = comp?.A || 0;
                const bVal = comp?.B || 0;
                const diff = Math.abs(aVal - bVal);
                if (diff > 0.1) {
                    comparisonsTotal += Math.min(2, diff);
                }
            }
        });
        comparisonsScore = Math.min(10, comparisonsTotal);
    } else {
        // Fallback: Use legacy factPack data
        const odds = factPack.odds || {};
        const markets = odds.markets || [];
        const spreadMarket = markets.find((m: any) => m.market === 'Spread');
        
        if (spreadMarket && typeof spreadMarket.point === 'number') {
            const spread = Math.abs(spreadMarket.point);
            if (spread <= 3) momentumScore = 18;
            else if (spread <= 6) momentumScore = 15;
            else if (spread <= 10) momentumScore = 12;
            else momentumScore = 8;
        } else {
            momentumScore = 10;
        }
    }
    
    baseScore = momentumScore + availabilityScore + closeGamesScore + comparisonsScore;
    
    // Narrative Strength (0-25 points)
    let narrativeScore = 0;
    if (narratives?.candidate_cards && narratives.candidate_cards.length > 0) {
        const primaryNarrativeId = narratives.selected?.primary_narrative_id;
        const primaryCard = narratives.candidate_cards.find(
            (c: any) => c.narrative_id === primaryNarrativeId
        );
        
        if (primaryCard) {
            if (primaryCard.total_score !== undefined) {
                narrativeScore += Math.min(15, (primaryCard.total_score / 35) * 15);
            } else {
                const breakdown = primaryCard.score_breakdown || {};
                const breakdownScore = (breakdown.factual_support || 0) + 
                                      (breakdown.stakes || 0) + 
                                      (breakdown.performance_alignment || 0);
                narrativeScore += Math.min(15, (breakdownScore / 20) * 15);
            }
        }
        
        const secondaryIds = narratives.selected?.secondary_narrative_ids || [];
        if (secondaryIds.length >= 2) narrativeScore += 5;
        else if (secondaryIds.length === 1) narrativeScore += 2;
        
        const allEmotionTags = narratives.candidate_cards
            .flatMap((c: any) => c.emotion_tags || []);
        const uniqueEmotionTags = [...new Set(allEmotionTags)];
        if (uniqueEmotionTags.length >= 4) narrativeScore += 5;
        else if (uniqueEmotionTags.length >= 3) narrativeScore += 3;
        else if (uniqueEmotionTags.length >= 2) narrativeScore += 1;
    }
    
    narrativeScore = Math.min(25, Math.round(narrativeScore));
    
    // Evidence Quality (0-15 points)
    let evidenceScore = 0;
    const quotes = evidenceBundle.quotes || [];
    const timelineEvents = evidenceBundle.timeline_events || [];
    
    if (quotes.length >= 5) evidenceScore += 8;
    else if (quotes.length >= 3) evidenceScore += 6;
    else if (quotes.length >= 2) evidenceScore += 4;
    else if (quotes.length === 1) evidenceScore += 2;
    
    if (timelineEvents.length >= 5) evidenceScore += 4;
    else if (timelineEvents.length >= 3) evidenceScore += 3;
    else if (timelineEvents.length >= 2) evidenceScore += 2;
    else if (timelineEvents.length === 1) evidenceScore += 1;
    
    const now = new Date();
    const recentQuotes = quotes.filter((q: any) => {
        if (!q.date_utc) return false;
        try {
            const quoteDate = new Date(q.date_utc);
            const daysAgo = Math.floor((now.getTime() - quoteDate.getTime()) / (1000 * 60 * 60 * 24));
            return daysAgo <= 30;
        } catch {
            return false;
        }
    });
    if (recentQuotes.length >= 3) evidenceScore += 3;
    else if (recentQuotes.length >= 2) evidenceScore += 2;
    else if (recentQuotes.length >= 1) evidenceScore += 1;
    
    evidenceScore = Math.min(23, evidenceScore); // Increased from 15
    
    // Total score with base temperature: 50 = baseline, then add components
    // Base temperature ensures even basic matchups start at ~50-60
    // Good matchups reach 70-80, strong ones reach 90+
    const baseTemperature = 50;
    const rawTotal = baseTemperature + baseScore + narrativeScore + evidenceScore;
    const total = Math.round(Math.min(100, Math.max(50, rawTotal))); // Cap between 50-100
    
    // Map to legacy breakdown format
    const stakes = Math.round((momentumScore + closeGamesScore) / 2);
    const recency = Math.round(evidenceScore * 0.8);
    const payback = Math.round(narrativeScore * 0.3);
    const history = Math.round(comparisonsScore + (narrativeScore * 0.2));
    const emotion = Math.round((narrativeScore * 0.5) + (evidenceScore * 0.2));
    
    return {
        total: Math.min(100, Math.max(0, total)),
        breakdown: {
            stakes: Math.min(20, stakes),
            recency: Math.min(20, recency),
            payback: Math.min(20, payback),
            history: Math.min(20, history),
            emotion: Math.min(20, emotion)
        }
    };
}

async function getLast10HeatScores() {
    const databaseUrl = process.env.DATABASE_URL;
    
    if (!databaseUrl) {
        console.error('DATABASE_URL environment variable is not set');
        process.exit(1);
    }

    const pool = new Pool({
        connectionString: databaseUrl,
    });

    try {
        console.log('Fetching last 10 posts from database...\n');
        
        const result = await pool.query(
            `SELECT data FROM posts 
             ORDER BY 
                 COALESCE((data->>'updatedAt')::timestamp, (data->>'createdAt')::timestamp) DESC
             LIMIT 10`
        );
        
        const posts: HeatcheckPost[] = result.rows.map(row => row.data);
        
        if (posts.length === 0) {
            console.log('No posts found in database.');
            return;
        }

        console.log('Heat Scores for Last 10 Posts:');
        console.log('================================\n');

        posts.forEach((post, idx) => {
            const heatScoreResult = calculateHeatScoreFromMatchupData(post);
            const heatScore = heatScoreResult.total;
            const breakdown = heatScoreResult.breakdown;
            
            const matchup = `${post.teamA} @ ${post.teamB}`;
            const headline = post.websiteStory?.headline || 'No headline';
            const date = post.matchupScheduledDate || post.createdAt;
            const league = post.league || 'Unknown';
            
            console.log(`${idx + 1}. ${matchup} (${league})`);
            console.log(`   Date: ${date}`);
            console.log(`   Heat Score: ${heatScore}/100`);
            console.log(`   Breakdown:`);
            console.log(`     - Stakes: ${breakdown.stakes}/20`);
            console.log(`     - Recency: ${breakdown.recency}/20`);
            console.log(`     - Payback: ${breakdown.payback}/20`);
            console.log(`     - History: ${breakdown.history}/20`);
            console.log(`     - Emotion: ${breakdown.emotion}/20`);
            console.log(`   Headline: ${headline.substring(0, 60)}${headline.length > 60 ? '...' : ''}`);
            console.log(`   Story Type: ${post.storyType || 'standard'}`);
            console.log(`   Has matchPackV3: ${!!post.heatCheckData?.matchPackV3}`);
            console.log(`   Has narratives: ${!!post.heatCheckData?.narratives?.candidate_cards?.length}`);
            console.log(`   Has evidence: ${!!(post.heatCheckData?.evidence_bundle || post.heatCheckData?.evidenceBundle)}`);
            console.log('');
        });

        // Summary statistics
        const scores = posts.map(p => calculateHeatScoreFromMatchupData(p).total);
        const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
        const maxScore = Math.max(...scores);
        const minScore = Math.min(...scores);
        
        console.log('Summary Statistics:');
        console.log('===================');
        console.log(`Average Heat Score: ${avgScore.toFixed(1)}`);
        console.log(`Highest Score: ${maxScore}`);
        console.log(`Lowest Score: ${minScore}`);
        console.log(`Posts >= 85 (HEAT_PICK threshold): ${scores.filter(s => s >= 85).length}`);
        console.log(`Posts >= 70 (WARM_LEAN threshold): ${scores.filter(s => s >= 70).length}`);
        console.log(`Posts < 70 (NO_HEAT): ${scores.filter(s => s < 70).length}`);

    } catch (error) {
        console.error('Error fetching posts:', error);
    } finally {
        await pool.end();
    }
}

// Run the script
getLast10HeatScores().catch(console.error);
