/**
 * Static Site JavaScript for HeatChecks Preview
 * Vanilla JS for maximum SEO compatibility
 */

// Global state
let publishedPosts = [];
let currentPage = 1;
const postsPerPage = 6;

// API Configuration
const API_URL = window.location.origin.includes('localhost') 
    ? 'http://localhost:3001' 
    : window.location.origin;
const API_KEY = ''; // Add if needed

/**
 * Fetch published posts from API
 */
async function fetchPublishedPosts() {
    try {
        const headers = {
            'Content-Type': 'application/json'
        };
        if (API_KEY) {
            headers['X-API-Key'] = API_KEY;
        }
        
        const response = await fetch(`${API_URL}/api/posts/published`, {
            method: 'GET',
            headers: headers
        });
        
        if (!response.ok) {
            throw new Error(`API Error: ${response.status}`);
        }
        
        const posts = await response.json();
        publishedPosts = posts;
        
        // Store in window for reference
        window.PUBLISHED_POSTS = posts;
        window.RECENT_LOGS_PAGINATION = {
            currentPage: 1,
            totalPages: Math.ceil(posts.length / postsPerPage),
            postsPerPage: postsPerPage
        };
        
        return posts;
    } catch (error) {
        console.error('Failed to fetch published posts:', error);
        return [];
    }
}

/**
 * V4 Heat Score Calculation Helpers (3-Pillar System)
 */
function clamp(x, lo, hi) {
    return Math.min(hi, Math.max(lo, x));
}

function scorePct(value, maxValue) {
    if (maxValue <= 0) return 0;
    return clamp(value / maxValue, 0, 1);
}

function calculateV4HeatScore(post) {
    const heatCheckData = post.heatCheckData || {};
    const matchPackV4 = heatCheckData.matchPackV4;
    const matchPackV3 = heatCheckData.matchPackV3;
    const narratives = heatCheckData.narratives || {};
    const evidenceBundle = heatCheckData.evidence_bundle || heatCheckData.evidenceBundle || {};
    
    // Get sections from V4 or V3
    const sections = (matchPackV4 && matchPackV4.factDrop && matchPackV4.factDrop.sections) 
        ? matchPackV4.factDrop.sections 
        : ((matchPackV3 && matchPackV3.factDrop && matchPackV3.factDrop.sections) 
            ? matchPackV3.factDrop.sections 
            : []);
    
    // Get advancedHeatStats from V4
    const advancedHeatStats = (matchPackV4 && matchPackV4.factDrop && matchPackV4.factDrop.raw && matchPackV4.factDrop.raw.advancedHeatStats)
        ? matchPackV4.factDrop.raw.advancedHeatStats
        : null;
    
    // Calculate Control Stress
    const controlStress = (advancedHeatStats && advancedHeatStats.controlStress) || {};
    let momentumDivergence = controlStress.momentumDivergence || 0;
    let creationAsymmetry = controlStress.creationAsymmetry || 0;
    let shotQualityMismatch = controlStress.shotQualityMismatch || 0;
    
    // V3 fallback for momentumDivergence
    if (momentumDivergence === 0 && matchPackV3 && matchPackV3.factDrop && matchPackV3.factDrop.raw && matchPackV3.factDrop.raw.teamForm) {
        const teamForm = matchPackV3.factDrop.raw.teamForm;
        const margin3_A = (teamForm.A && teamForm.A.margin3) ? teamForm.A.margin3 : 0;
        const margin10_A = (teamForm.A && teamForm.A.margin10) ? teamForm.A.margin10 : 0;
        const margin3_B = (teamForm.B && teamForm.B.margin3) ? teamForm.B.margin3 : 0;
        const margin10_B = (teamForm.B && teamForm.B.margin10) ? teamForm.B.margin10 : 0;
        const momentumDelta_A = margin3_A - margin10_A;
        const momentumDelta_B = margin3_B - margin10_B;
        momentumDivergence = clamp(Math.abs(momentumDelta_A - momentumDelta_B) * 0.6, 0, 12);
    }
    
    const controlStressRaw = scorePct(momentumDivergence, 12) * 45 + scorePct(creationAsymmetry, 10) * 30 + scorePct(shotQualityMismatch, 8) * 25;
    const controlStressScore = clamp(Math.round(controlStressRaw), 0, 100);
    
    // Calculate Structural Instability
    const structuralInstability = (advancedHeatStats && advancedHeatStats.structuralInstability) || {};
    let rotationVolatility = structuralInstability.rotationVolatility || 0;
    let availabilityImbalance = structuralInstability.availabilityImbalance || 0;
    const scheduleStress = structuralInstability.scheduleStress || 0;
    
    // V3 fallback for availabilityImbalance
    if (availabilityImbalance === 0 && matchPackV3 && matchPackV3.factDrop && matchPackV3.factDrop.raw && matchPackV3.factDrop.raw.availability) {
        const availability = matchPackV3.factDrop.raw.availability;
        const countA = (availability.majorAbsences && availability.majorAbsences.A && availability.majorAbsences.A.count) ? availability.majorAbsences.A.count : 0;
        const countB = (availability.majorAbsences && availability.majorAbsences.B && availability.majorAbsences.B.count) ? availability.majorAbsences.B.count : 0;
        const absDiff = Math.abs(countA - countB);
        availabilityImbalance = clamp(absDiff * 0.7, 0, 7);
    }
    
    const structuralRaw = scorePct(rotationVolatility, 8) * 45 + scorePct(availabilityImbalance, 7) * 35 + scorePct(scheduleStress, 5) * 20;
    const structuralInstabilityScore = clamp(Math.round(structuralRaw), 0, 100);
    
    // Calculate Emotional Load
    const revengeWatch = sections.find(function(s) { return s && s.title === 'REVENGE_WATCH'; });
    const revengeItems = (revengeWatch && Array.isArray(revengeWatch.items)) ? revengeWatch.items : [];
    const revengeCount = revengeItems.length;
    let revengeScore = 0;
    if (revengeCount === 0) revengeScore = 0;
    else if (revengeCount === 1) revengeScore = 18;
    else if (revengeCount === 2) revengeScore = 28;
    else revengeScore = 35;
    
    const availabilityShock = sections.find(function(s) { return s && s.title === 'AVAILABILITY_SHOCK'; });
    const shockItems = (availabilityShock && Array.isArray(availabilityShock.items)) ? availabilityShock.items : [];
    const shockCount = shockItems.length;
    let absDiff = 0;
    if (matchPackV3 && matchPackV3.factDrop && matchPackV3.factDrop.raw && matchPackV3.factDrop.raw.availability) {
        const availability = matchPackV3.factDrop.raw.availability;
        const countA = (availability.majorAbsences && availability.majorAbsences.A && availability.majorAbsences.A.count) ? availability.majorAbsences.A.count : 0;
        const countB = (availability.majorAbsences && availability.majorAbsences.B && availability.majorAbsences.B.count) ? availability.majorAbsences.B.count : 0;
        absDiff = Math.abs(countA - countB);
    }
    let shockBase = 0;
    if (shockCount === 0) shockBase = 0;
    else if (shockCount === 1) shockBase = 14;
    else if (shockCount === 2) shockBase = 22;
    else shockBase = 28;
    const imbalanceBonus = Math.min(2, absDiff);
    const availabilityShockScore = Math.min(30, shockBase + imbalanceBonus);
    
    const vsOppHistory = sections.find(function(s) { return s && s.title === 'VS_OPP_HISTORY'; });
    const histItems = (vsOppHistory && Array.isArray(vsOppHistory.items)) ? vsOppHistory.items : [];
    const histCount = histItems.length;
    let historyScore = 0;
    if (histCount === 0) historyScore = 0;
    else if (histCount === 1) historyScore = 8;
    else if (histCount === 2) historyScore = 14;
    else historyScore = 20;
    
    let closeDependScore = 0;
    let standingsScore = 0;
    let formCompressionScore = 0;
    if (matchPackV3 && matchPackV3.factDrop && matchPackV3.factDrop.raw) {
        const teamForm = matchPackV3.factDrop.raw.teamForm || {};
        const standings = matchPackV3.factDrop.raw.standings || {};
        const closeW10_A = (teamForm.A && teamForm.A.closeW10) ? teamForm.A.closeW10 : 0;
        const closeL10_A = (teamForm.A && teamForm.A.closeL10) ? teamForm.A.closeL10 : 0;
        const closeW10_B = (teamForm.B && teamForm.B.closeW10) ? teamForm.B.closeW10 : 0;
        const closeL10_B = (teamForm.B && teamForm.B.closeL10) ? teamForm.B.closeL10 : 0;
        const closeA = closeW10_A + closeL10_A;
        const closeB = closeW10_B + closeL10_B;
        const closeAvg = (closeA + closeB) / 2;
        if (closeAvg >= 6) closeDependScore = 6;
        else if (closeAvg >= 4) closeDependScore = 4;
        else if (closeAvg >= 2) closeDependScore = 2;
        const rankA = (standings.A && standings.A.rank) ? standings.A.rank : 0;
        const rankB = (standings.B && standings.B.rank) ? standings.B.rank : 0;
        const rankMin = Math.min(rankA, rankB);
        const rankMax = Math.max(rankA, rankB);
        if (rankMin <= 4 && rankMax <= 10) standingsScore = 6;
        else if (rankMin <= 6) standingsScore = 4;
        else if (rankMax >= 11) standingsScore = 2;
        const margin3_A = Math.abs((teamForm.A && teamForm.A.margin3) ? teamForm.A.margin3 : 0);
        const margin3_B = Math.abs((teamForm.B && teamForm.B.margin3) ? teamForm.B.margin3 : 0);
        const avgAbsMargin3 = (margin3_A + margin3_B) / 2;
        if (avgAbsMargin3 <= 3) formCompressionScore = 3;
        else if (avgAbsMargin3 <= 6) formCompressionScore = 2;
    }
    const pressureEnvScore = closeDependScore + standingsScore + formCompressionScore;
    const emotionalLoadScore = clamp(Math.round(revengeScore + availabilityShockScore + historyScore + pressureEnvScore), 0, 100);
    
    // Final weighted score: BASE_HEAT + (ControlStress * 0.40) + (StructuralInstability * 0.35) + (EmotionalLoad * 0.25)
    const BASE_HEAT = 40;
    const heatDelta = controlStressScore * 0.40 + structuralInstabilityScore * 0.35 + emotionalLoadScore * 0.25;
    const heatScore = clamp(Math.round(BASE_HEAT + heatDelta), 0, 100);
    
    return {
        heatScore: heatScore,
        pillars: {
            controlStress: {
                score: controlStressScore,
                inputs: { momentumDivergence, creationAsymmetry, shotQualityMismatch },
                receipts: controlStress.receipts || {}
            },
            structuralInstability: {
                score: structuralInstabilityScore,
                inputs: { rotationVolatility, availabilityImbalance, scheduleStress },
                receipts: structuralInstability.receipts || {}
            },
            emotionalLoad: {
                score: emotionalLoadScore,
                components: {
                    revenge: { score: revengeScore, count: revengeCount },
                    availabilityShock: { score: availabilityShockScore, count: shockCount, absDiff: absDiff > 0 ? absDiff : undefined },
                    history: { score: historyScore, count: histCount },
                    pressureEnv: { score: pressureEnvScore }
                }
            }
        }
    };
}

/**
 * Unified Heat Score Calculation (0-100)
 * Combines Heat Picks signals (momentum, availability, close games, comparisons) 
 * + Narrative strength + Evidence quality
 * Matches the Heat Picks scoring system for consistency
 * Temperature-based: 40 = baseline, 70 = warm, 90 = hot, 100 = scorching
 */
function calculateHeatScoreFromMatchupData(post) {
    // Special handling for DFS articles
    if (post.storyType === 'dfs_article') {
        const heatCheckData = post.heatCheckData || {};
        const dfsPlayers = heatCheckData.dfsPlayers || [];
        const articleDate = post.matchupScheduledDate || post.createdAt;
    
        // Calculate days since article date (same day = 0, next day = 1, etc.)
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
        
        // RECENCY (0-20 points) - DFS articles are most valuable same day
        let recencyScore = 0;
        if (daysAgo === 0) recencyScore = 20; // Same day = max score
        else if (daysAgo === 1) recencyScore = 15; // Yesterday
        else if (daysAgo === 2) recencyScore = 10; // 2 days ago
        else if (daysAgo <= 7) recencyScore = 8; // Within a week
        else if (daysAgo <= 30) recencyScore = 5; // Within a month
        else recencyScore = 2; // Older
        
        // STAKES (0-20 points) - Based on number of players analyzed
    let stakesScore = 0;
        const playerCount = dfsPlayers.length;
        if (playerCount >= 10) stakesScore = 18; // Full slate analysis
        else if (playerCount >= 8) stakesScore = 15;
        else if (playerCount >= 5) stakesScore = 12;
        else if (playerCount >= 3) stakesScore = 8;
        else stakesScore = 5;
            
        // EMOTION (0-20 points) - Based on average confidence scores
        let emotionScore = 0;
        if (playerCount > 0) {
            const avgConfidence = dfsPlayers.reduce((sum, p) => sum + (p.confidenceScore || 0), 0) / playerCount;
            if (avgConfidence >= 80) emotionScore = 18;
            else if (avgConfidence >= 70) emotionScore = 15;
            else if (avgConfidence >= 60) emotionScore = 12;
            else if (avgConfidence >= 50) emotionScore = 8;
            else emotionScore = 5;
        }
        
        // HISTORY (0-20 points) - Variety of narrative types
        const narrativeTypes = new Set(dfsPlayers.map(p => p.narrativeType || '').filter(Boolean));
        let historyScore = 0;
        if (narrativeTypes.size >= 5) historyScore = 18;
        else if (narrativeTypes.size >= 4) historyScore = 15;
        else if (narrativeTypes.size >= 3) historyScore = 12;
        else if (narrativeTypes.size >= 2) historyScore = 8;
        else historyScore = 5;
        
        // PAYBACK (0-20 points) - Count of revenge/motivation narratives
        let paybackScore = 0;
        const paybackNarratives = dfsPlayers.filter(p => {
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
    
    const heatCheckData = post.heatCheckData;
    
    // Check if this post has a stored Heat Picks score
    // Option 1: Check if this post itself has heatPicks data (for hub posts)
    if (heatCheckData.heatPicks && heatCheckData.heatPicks.heatPicks && Array.isArray(heatCheckData.heatPicks.heatPicks)) {
        const teamA = post.teamA || '';
        const teamB = post.teamB || '';
        // Find matching pick by team names or matchup string
        const matchingPick = heatCheckData.heatPicks.heatPicks.find((pick) => {
            if (!pick) return false;
            // Check direct team match
            if (pick.teamA === teamA && pick.teamB === teamB) return true;
            if (pick.teamA === teamB && pick.teamB === teamA) return true;
            // Check matchup string match
            if (pick.matchup) {
                const matchupLower = (pick.matchup || '').toLowerCase();
                const teamALower = teamA.toLowerCase();
                const teamBLower = teamB.toLowerCase();
                if (matchupLower.includes(teamALower) && matchupLower.includes(teamBLower)) return true;
            }
            return false;
        });
        
        if (matchingPick && typeof matchingPick.heatScore === 'number') {
            // Return the stored Heat Picks score to ensure consistency
            return {
                total: matchingPick.heatScore,
                breakdown: {
                    stakes: 0,
                    recency: 0,
                    payback: 0,
                    history: 0,
                    emotion: 0
                }
            };
        }
    }
    
    // Option 2: Check if this post has a directly stored heatScore from Heat Picks
    // (This would be set when Heat Picks are generated and synced to individual posts)
    if (heatCheckData.heatPicksHeatScore && typeof heatCheckData.heatPicksHeatScore === 'number') {
        return {
            total: heatCheckData.heatPicksHeatScore,
            breakdown: {
                stakes: 0,
                recency: 0,
                payback: 0,
                history: 0,
                emotion: 0
            }
        };
    }
    
    // Option 3: Try to find matching Heat Picks hub post from embedded posts
    // This works when all posts are available (like in static site generation)
    try {
        const embeddedPosts = getEmbeddedPosts();
        if (embeddedPosts && embeddedPosts.length > 0) {
            const teamA = post.teamA || '';
            const teamB = post.teamB || '';
            // Find Heat Picks hub posts
            const heatPicksHubs = embeddedPosts.filter((p) => p.storyType === 'heat_picks');
            for (const hub of heatPicksHubs) {
                const hubHeatPicks = hub.heatCheckData?.heatPicks;
                if (hubHeatPicks && hubHeatPicks.heatPicks && Array.isArray(hubHeatPicks.heatPicks)) {
                    const matchingPick = hubHeatPicks.heatPicks.find((pick) => {
                        if (!pick) return false;
                        if (pick.teamA === teamA && pick.teamB === teamB) return true;
                        if (pick.teamA === teamB && pick.teamB === teamA) return true;
                        if (pick.matchup) {
                            const matchupLower = (pick.matchup || '').toLowerCase();
                            const teamALower = teamA.toLowerCase();
                            const teamBLower = teamB.toLowerCase();
                            if (matchupLower.includes(teamALower) && matchupLower.includes(teamBLower)) return true;
                        }
                        return false;
                    });
                    if (matchingPick && typeof matchingPick.heatScore === 'number') {
                        return {
                            total: matchingPick.heatScore,
                            breakdown: {
                                stakes: 0,
                                recency: 0,
                                payback: 0,
                                history: 0,
                                emotion: 0
                            }
                        };
                    }
                }
            }
        }
    } catch (e) {
        // getEmbeddedPosts might not be available in all contexts, ignore errors
    }
    
    // Check if V4 heat score calculation is available (has matchPackV4 with advancedHeatStats)
    const matchPackV4 = heatCheckData.matchPackV4;
    if (matchPackV4 && matchPackV4.factDrop && matchPackV4.factDrop.raw && matchPackV4.factDrop.raw.advancedHeatStats) {
        try {
            const v4Result = calculateV4HeatScore(post);
            // Map V4 result to legacy breakdown format for backward compatibility
            return {
                total: v4Result.heatScore,
                breakdown: {
                    stakes: Math.round(v4Result.pillars.controlStress.score * 0.2),
                    recency: Math.round(v4Result.pillars.emotionalLoad.components.availabilityShock.score * 0.2),
                    payback: Math.round(v4Result.pillars.emotionalLoad.components.revenge.score * 0.2),
                    history: Math.round(v4Result.pillars.emotionalLoad.components.history.score * 0.2),
                    emotion: Math.round(v4Result.pillars.emotionalLoad.score * 0.2)
                }
            };
        } catch (e) {
            // Fall through to V3 calculation if V4 fails
            console.warn('[Heat Score] V4 calculation failed, falling back to V3:', e);
        }
    }
    
    const matchPackV3 = heatCheckData.matchPackV3;
    const factPack = heatCheckData.fact_pack || heatCheckData.factPack || {};
    const evidenceBundle = heatCheckData.evidence_bundle || heatCheckData.evidenceBundle || {};
    const narratives = heatCheckData.narratives || {};
    
    // Temperature-based scoring: 40 = baseline, 70 = warm, 90 = hot, 100 = scorching
    let baseScore = 0;
    let momentumScore = 0;
    let availabilityScore = 0;
    let closeGamesScore = 0;
    let comparisonsScore = 0;
    
    // If matchPackV3 exists, use Heat Picks signals (preferred method)
    if (matchPackV3 && matchPackV3.factDrop) {
        const factDrop = matchPackV3.factDrop;
        const teamForm = factDrop.raw && factDrop.raw.teamForm ? factDrop.raw.teamForm : {};
        const comparisons = factDrop.comparisons || [];
        const availability = factDrop.raw && factDrop.raw.availability ? factDrop.raw.availability : null;
    
        // 1. MOMENTUM (0-25 points, increased for temperature model)
        const aMargin10 = (teamForm.A && teamForm.A.margin10) || (teamForm.A && teamForm.A.xgDiff10) || 0;
        const aMargin3 = (teamForm.A && teamForm.A.margin3) || (teamForm.A && teamForm.A.xgDiff3) || 0;
        const bMargin10 = (teamForm.B && teamForm.B.margin10) || (teamForm.B && teamForm.B.xgDiff10) || 0;
        const bMargin3 = (teamForm.B && teamForm.B.margin3) || (teamForm.B && teamForm.B.xgDiff3) || 0;
        const momentumDivergence = Math.abs((aMargin3 - aMargin10) - (bMargin3 - bMargin10));
        momentumScore = Math.min(25, momentumDivergence * 2.5); // Increased multiplier
        
        // 2. AVAILABILITY (0-20 points, increased for temperature model)
        if (availability && availability.majorAbsences) {
            const aAbsences = (availability.majorAbsences.A && availability.majorAbsences.A.count) || 0;
            const bAbsences = (availability.majorAbsences.B && availability.majorAbsences.B.count) || 0;
            const availabilityDiff = Math.abs(aAbsences - bAbsences);
            availabilityScore = Math.min(20, availabilityDiff * 4); // Increased multiplier
        }
        
        // 3. CLOSE GAMES (0-20 points, increased for temperature model)
        const closeMarginComp = comparisons.find(c => c && c.key === 'closeMargin');
        if (closeMarginComp) {
            const aCloseW = (teamForm.A && teamForm.A.closeW10) || 0;
            const aCloseL = (teamForm.A && teamForm.A.closeL10) || 0;
            const bCloseW = (teamForm.B && teamForm.B.closeW10) || 0;
            const bCloseL = (teamForm.B && teamForm.B.closeL10) || 0;
            const aCloseRate = aCloseW + aCloseL > 0 ? aCloseW / (aCloseW + aCloseL) : 0;
            const bCloseRate = bCloseW + bCloseL > 0 ? bCloseW / (bCloseW + bCloseL) : 0;
            const closeGameDiff = Math.abs(aCloseRate - bCloseRate);
            closeGamesScore = Math.min(20, closeGameDiff * 40); // Increased multiplier
        }
        
        // 4. COMPARISONS (0-15 points, increased for temperature model)
        let comparisonsTotal = 0;
        comparisons.forEach(comp => {
            if (comp && comp.key && comp.key !== 'closeMargin') {
                const aVal = comp.A || 0;
                const bVal = comp.B || 0;
                const diff = Math.abs(aVal - bVal);
                if (diff > 0.1) {
                    comparisonsTotal += Math.min(3, diff * 1.5); // Increased cap and multiplier
                }
            }
        });
        comparisonsScore = Math.min(15, comparisonsTotal);
    } else {
        // Fallback: Use legacy factPack data if matchPackV3 not available
        const odds = factPack.odds || {};
        const markets = odds.markets || [];
        const spreadMarket = markets.find(m => m && m.market === 'Spread');
        
        // Use spread as proxy for competitiveness (scaled up)
        if (spreadMarket && typeof spreadMarket.point === 'number') {
            const spread = Math.abs(spreadMarket.point);
            if (spread <= 3) momentumScore = 22;
            else if (spread <= 6) momentumScore = 18;
            else if (spread <= 10) momentumScore = 15;
            else momentumScore = 12;
        } else {
            momentumScore = 15; // Default if no spread
        }
    }
    
    baseScore = momentumScore + availabilityScore + closeGamesScore + comparisonsScore;
    
    // NARRATIVE STRENGTH (0-35 points, increased for temperature model)
    let narrativeScore = 0;
    if (narratives && narratives.candidate_cards && narratives.candidate_cards.length > 0) {
        // Primary narrative score (0-20 points, increased from 15)
        const primaryNarrativeId = narratives.selected && narratives.selected.primary_narrative_id;
        const primaryCard = narratives.candidate_cards.find(
            c => c && c.narrative_id === primaryNarrativeId
        );
        
        if (primaryCard) {
            // Use total_score if available (0-35 scale), normalize to 0-20
            if (primaryCard.total_score !== undefined) {
                narrativeScore += Math.min(20, (primaryCard.total_score / 35) * 20);
            } else {
                // Fallback: use score_breakdown if available
                const breakdown = primaryCard.score_breakdown || {};
                const breakdownScore = (breakdown.factual_support || 0) + 
                                      (breakdown.stakes || 0) + 
                                      (breakdown.performance_alignment || 0);
                narrativeScore += Math.min(20, (breakdownScore / 20) * 20);
            }
        }
        
        // Secondary narratives boost (0-8 points, increased from 5)
        const secondaryIds = (narratives.selected && narratives.selected.secondary_narrative_ids) || [];
        if (secondaryIds.length >= 2) narrativeScore += 8;
        else if (secondaryIds.length === 1) narrativeScore += 4;
        
        // Emotion tags diversity (0-7 points, increased from 5)
        const allEmotionTags = narratives.candidate_cards
            .flatMap(c => (c && c.emotion_tags) ? c.emotion_tags : []);
        const uniqueEmotionTags = [...new Set(allEmotionTags)];
        if (uniqueEmotionTags.length >= 4) narrativeScore += 7;
        else if (uniqueEmotionTags.length >= 3) narrativeScore += 5;
        else if (uniqueEmotionTags.length >= 2) narrativeScore += 2;
    }
    
    narrativeScore = Math.min(35, Math.round(narrativeScore));
    
    // EVIDENCE QUALITY (0-23 points, increased for temperature model)
    let evidenceScore = 0;
    const quotes = evidenceBundle.quotes || [];
    const timelineEvents = evidenceBundle.timeline_events || [];
    
    // Quotes quality (0-12 points, increased from 8)
    if (quotes.length >= 5) evidenceScore += 12;
    else if (quotes.length >= 3) evidenceScore += 9;
    else if (quotes.length >= 2) evidenceScore += 6;
    else if (quotes.length === 1) evidenceScore += 3;
    
    // Timeline events (0-6 points, increased from 4)
    if (timelineEvents.length >= 5) evidenceScore += 6;
    else if (timelineEvents.length >= 3) evidenceScore += 5;
    else if (timelineEvents.length >= 2) evidenceScore += 3;
    else if (timelineEvents.length === 1) evidenceScore += 2;
    
    // Recent evidence bonus (0-5 points, increased from 3)
    const now = new Date();
    const recentQuotes = quotes.filter(q => {
        if (!q || !q.date_utc) return false;
        try {
            const quoteDate = new Date(q.date_utc);
            const daysAgo = Math.floor((now.getTime() - quoteDate.getTime()) / (1000 * 60 * 60 * 24));
            return daysAgo <= 30;
        } catch {
            return false;
        }
    });
    if (recentQuotes.length >= 3) evidenceScore += 5;
    else if (recentQuotes.length >= 2) evidenceScore += 3;
    else if (recentQuotes.length >= 1) evidenceScore += 2;
    
    evidenceScore = Math.min(23, evidenceScore);
    
    // Total score with base temperature: 40 = baseline, then add components
    // Base temperature ensures even basic matchups start at ~40-50
    // Good matchups reach 70-80, strong ones reach 90+
    const baseTemperature = 40;
    const rawTotal = baseTemperature + baseScore + narrativeScore + evidenceScore;
    const total = Math.round(Math.min(100, Math.max(40, rawTotal))); // Cap between 40-100
    
    // Map to legacy breakdown format for backward compatibility
    // Distribute scores across the 5 categories
    const stakes = Math.round((momentumScore + closeGamesScore) / 2);
    const recency = Math.round(evidenceScore * 0.8); // Most of evidence is recency-based
    const payback = Math.round(narrativeScore * 0.3); // Part of narrative is payback/rivalry
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

/**
 * Calculate heat score (backward compatible - returns just the number)
 */
function calculateHeatScore(post) {
    const result = calculateHeatScoreFromMatchupData(post);
    return result.total;
}

/**
 * Get primary narrative card with score breakdown (kept for compatibility)
 */
function getPrimaryNarrativeCard(post) {
    if (!post.heatCheckData) return null;
    
    const heatCheckData = post.heatCheckData;
    const narratives = heatCheckData.narratives;
    
    if (narratives && narratives.candidate_cards && narratives.selected) {
        const primaryNarrativeId = narratives.selected.primary_narrative_id;
        return narratives.candidate_cards.find(
            card => card.narrative_id === primaryNarrativeId
        );
    }
    
    return null;
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
    if (!text) return '';
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return String(text).replace(/[&<>"']/g, m => map[m]);
}

/**
 * Generate heat breakdown HTML for hover display
 * Uses matchup data to calculate and display 5 categories (0-20 each, total 0-100)
 */
function generateHeatBreakdown(post) {
    const result = calculateHeatScoreFromMatchupData(post);
    const { total, breakdown } = result;
    
    const criteria = [
        { key: 'stakes', label: 'STAKES', score: breakdown.stakes },
        { key: 'recency', label: 'RECENCY', score: breakdown.recency },
        { key: 'payback', label: 'PAYBACK', score: breakdown.payback },
        { key: 'history', label: 'HISTORY', score: breakdown.history },
        { key: 'emotion', label: 'EMOTION', score: breakdown.emotion }
    ];
    
    let breakdownHtml = `
        <div style="padding: 0.25rem; background: rgba(0, 0, 0, 0.95); border: 2px solid #ff0040; border-radius: 4px; font-family: 'Courier New', monospace; color: #fff; height: 100%; width: 100%; display: flex; flex-direction: column; box-sizing: border-box; overflow: hidden; position: absolute; top: 0; left: 0;">
            <div style="margin-bottom: 0.15rem; padding-bottom: 0.12rem; border-bottom: 1px solid rgba(255, 0, 64, 0.5); flex-shrink: 0;">
                <div style="font-size: 0.38rem; color: rgba(255, 255, 255, 0.7); margin-bottom: 0.03rem; line-height: 1;">HEAT BREAKDOWN</div>
                <div style="font-size: 0.7rem; font-weight: 900; color: #ff1a1a; line-height: 1;">${total}/100</div>
            </div>
            <div style="flex: 1; overflow: hidden; display: flex; flex-direction: column; gap: 0.12rem; min-height: 0; padding-top: 0.05rem;">
    `;
    
    // Display all 5 criteria - each score is 0-20, scale to 0-100 for display percentage
    criteria.forEach((criterion, index) => {
        // Scale 0-20 to 0-100 for display percentage
        const displayScore = Math.round((criterion.score / 20) * 100);
        const percentage = displayScore;
        const barColor = displayScore >= 80 ? '#00ff41' : displayScore >= 60 ? '#ffff00' : displayScore >= 40 ? '#ff8800' : '#ff0040';
        const isLast = index === criteria.length - 1;
        
        breakdownHtml += `
            <div style="flex-shrink: 0; ${isLast ? 'margin-bottom: 0;' : ''}">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.04rem; gap: 0.2rem;">
                    <span style="font-size: 0.4rem; color: rgba(255, 255, 255, 0.9); text-transform: uppercase; letter-spacing: 0.01em; line-height: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0;">${criterion.label}</span>
                    <span style="font-size: 0.5rem; font-weight: 900; color: ${barColor}; line-height: 1; flex-shrink: 0; min-width: 1.3rem; text-align: right;">${criterion.score}/20</span>
                </div>
                <div style="width: 100%; height: 2.5px; background: rgba(255, 255, 255, 0.1); border-radius: 1px; overflow: hidden; position: relative;">
                    <div style="width: ${percentage}%; height: 100%; background: ${barColor}; box-shadow: 0 0 2px ${barColor};"></div>
                </div>
            </div>
        `;
    });
    
    breakdownHtml += '</div></div>';
    return breakdownHtml;
}

/**
 * Generate 3-pillar heat breakdown HTML for hover display (NBA V4 articles)
 * Uses advancedHeatStats from matchPackV4
 * Falls back to 5-category breakdown if V4 data not available
 */
function generateHeatBreakdownV4(post) {
    const heatCheckData = post.heatCheckData || {};
    const matchPackV4 = heatCheckData.matchPackV4;
    
    // Check if this is a V4 article with advancedHeatStats
    if (!matchPackV4 || !matchPackV4.factDrop || !matchPackV4.factDrop.raw || !matchPackV4.factDrop.raw.advancedHeatStats) {
        // Fallback to old 5-category breakdown
        return generateHeatBreakdown(post);
    }
    
    // Use V4 calculation to get proper 0-100 pillar scores
    let v4Result;
    try {
        v4Result = calculateV4HeatScore(post);
    } catch (e) {
        console.warn('[Heat Breakdown] V4 calculation failed, falling back to 5-category:', e);
        return generateHeatBreakdown(post);
    }
    
    const controlStress = v4Result.pillars.controlStress;
    const structuralInstability = v4Result.pillars.structuralInstability;
    const emotionalLoad = v4Result.pillars.emotionalLoad;
    const total = v4Result.heatScore;
    
    // Helper: Render 5-block bar (each block = 20%)
    // Use consistent block characters that are the same width
    // score is 0-100, so each block = 20 points
    const renderBar = (score) => {
        const blocksFilled = Math.max(0, Math.min(5, Math.round((score / 100) * 5)));
        // Use full block (█) for filled and light shade (░) for empty - both are same width in monospace
        const filled = '█'.repeat(blocksFilled);
        const empty = '░'.repeat(5 - blocksFilled);
        return filled + empty;
    };
    
    // Helper: Get receipts for a pillar (1-2 max)
    const getReceipts = (receiptsObj, pillarType, controlStressData) => {
        const receipts = [];
        if (!receiptsObj) return receipts;
        
        // Control Stress receipts
        if (pillarType === 'performance') {
            // Check for momentum divergence receipt (may be stored directly in controlStress or receipts)
            // The SQL function stores momentumDivergence receipts in the scalar, but they might be in receipts.momentum
            if (Array.isArray(receiptsObj.momentum) && receiptsObj.momentum.length > 0) {
                receipts.push(...receiptsObj.momentum.slice(0, 1));
            }
            if (Array.isArray(receiptsObj.creation) && receiptsObj.creation.length > 0) {
                receipts.push(...receiptsObj.creation.slice(0, 1));
            }
            if (Array.isArray(receiptsObj.shotQuality) && receiptsObj.shotQuality.length > 0) {
                receipts.push(...receiptsObj.shotQuality.slice(0, 1));
            }
            // If we have momentumDivergence > 0 but no receipt, create a generic one
            if (receipts.length === 0 && controlStressData && controlStressData.momentumDivergence > 0) {
                receipts.push('Momentum diverging: recent form shift detected');
            }
        }
        
        // Structural Instability receipts
        if (pillarType === 'situational') {
            if (Array.isArray(receiptsObj.rotation) && receiptsObj.rotation.length > 0) {
                receipts.push(...receiptsObj.rotation.slice(0, 1));
            }
            if (Array.isArray(receiptsObj.availability) && receiptsObj.availability.length > 0) {
                receipts.push(...receiptsObj.availability.slice(0, 1));
            }
            if (Array.isArray(receiptsObj.schedule) && receiptsObj.schedule.length > 0) {
                receipts.push(...receiptsObj.schedule.slice(0, 1));
            }
        }
        
        return receipts.slice(0, 2); // Max 2 receipts
    };
    
    // Helper: Get emotional load receipts
    const getEmotionalReceipts = (components) => {
        const receipts = [];
        if (components.revenge && components.revenge.count > 0) {
            receipts.push('Revenge spot vs former team');
        }
        if (components.availabilityShock && components.availabilityShock.count > 0) {
            receipts.push('Recent availability shock detected');
        }
        if (components.history && components.history.count > 0) {
            receipts.push('Strong vs opponent history');
        }
        return receipts.slice(0, 1); // Limit to 1 receipt
    };
    
    // Determine if game is HOT+ (for showing receipts)
    const isHot = total >= 70;
    
    const pillars = [
        {
            emoji: '🔴',
            label: 'Performance Stress',
            description: 'Who\'s actually controlling games right now?',
            score: controlStress.score, // 0-100 score
            receipts: isHot ? getReceipts(controlStress.receipts, 'performance', controlStress) : []
        },
        {
            emoji: '🟠',
            label: 'Situational Pressure',
            description: 'Is this a normal game… or a fragile one?',
            score: structuralInstability.score, // 0-100 score
            receipts: isHot ? getReceipts(structuralInstability.receipts, 'situational') : []
        },
        {
            emoji: '🔥',
            label: 'Emotional Load',
            description: 'Is emotion likely to affect behavior?',
            score: emotionalLoad.score, // 0-100 score
            receipts: isHot ? getEmotionalReceipts(emotionalLoad.components) : []
        }
    ];
    
    let breakdownHtml = `
        <div style="padding: 0.25rem; background: rgba(0, 0, 0, 0.98); border: 2px solid #ff0040; border-radius: 4px; font-family: 'Courier New', monospace; color: #fff; height: 100%; width: 100%; display: flex; flex-direction: column; box-sizing: border-box; overflow: hidden; position: absolute; top: 0; left: 0; justify-content: space-between;">
            <!-- Pillars -->
            <div style="flex: 1; display: flex; flex-direction: column; gap: 0.14rem; min-height: 0; overflow: hidden;">
    `;
    
    pillars.forEach((pillar, index) => {
        const bar = renderBar(pillar.score); // score is 0-100, max is always 100
        
        breakdownHtml += `
            <div style="flex-shrink: 0; border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 2px; padding: 0.1rem 0.12rem; background: rgba(255, 255, 255, 0.02);">
                <!-- Pillar Header and Bar - Text on left, bar on right -->
                <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 0.2rem; margin-bottom: 0.05rem;">
                    <div style="flex: 1; min-width: 0;">
                        <div style="font-size: 0.5rem; color: rgba(255, 255, 255, 0.9); line-height: 1.2; margin-bottom: 0.03rem; font-weight: 700;">
                            ${pillar.emoji} ${pillar.label}
                        </div>
                        <div style="font-size: 0.38rem; color: rgba(255, 255, 255, 0.6); line-height: 1.15;">
                            ${pillar.description}
                        </div>
                    </div>
                    <!-- Bar on the right side - fixed width to ensure all bars are same size -->
                    <span style="font-size: 0.7rem; color: rgba(255, 255, 255, 0.95); font-family: 'Courier New', monospace; letter-spacing: 0; flex-shrink: 0; line-height: 1; display: inline-block; text-align: right; white-space: nowrap; padding-left: 0.1rem; width: 2.5rem; min-width: 2.5rem; max-width: 2.5rem;">${bar}</span>
                </div>
        `;
        
        // Show receipts if available and game is HOT+ (limit to 1 receipt to save space)
        if (pillar.receipts && pillar.receipts.length > 0) {
            const receipt = pillar.receipts[0]; // Only show first receipt
            breakdownHtml += `
                    <div style="font-size: 0.32rem; color: rgba(255, 255, 255, 0.65); line-height: 1.25; margin-top: 0.04rem; padding-left: 0.1rem; border-left: 1px solid rgba(255, 255, 255, 0.2); font-style: italic;">
                        "${escapeHtml(receipt)}"
                    </div>
            `;
        }
        
        breakdownHtml += '</div>';
    });
    
    // Footer
    breakdownHtml += `
            </div>
            
            <!-- Footer -->
            <div style="margin-top: 0.1rem; padding-top: 0.08rem; border-top: 1px solid rgba(255, 0, 64, 0.3); flex-shrink: 0;">
                <div style="font-size: 0.3rem; color: rgba(255, 255, 255, 0.5); line-height: 1.25; text-align: center; font-style: italic;">
                    Heat rises when control, context, and emotion collide.
                </div>
            </div>
        </div>
    `;
    
    return breakdownHtml;
}

/**
 * Format date as MM/DD for post card
 */
/**
 * Format date for card display (MM/DD)
 * Handles dates consistently regardless of timezone
 */
function formatDateForCard(dateString) {
    if (!dateString) return '';
    
    // Extract YYYY-MM-DD from the beginning of the string
    const dateMatch = dateString.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (dateMatch) {
        const [, year, month, day] = dateMatch;
        return `${month}/${day}`;
    }
    
    // Fallback
    try {
        const date = new Date(dateString);
        if (isNaN(date.getTime())) return '';
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${month}/${day}`;
    } catch (e) {
        return '';
    }
}

/**
 * Format date for URL (YYYY-MM-DD) - matches formatDateISO from backend
 * Always extracts date in YYYY-MM-DD format, ignoring time/timezone
 */
function formatDateForUrl(dateString) {
    if (!dateString) return '';
    
    // Extract YYYY-MM-DD from the beginning of the string (before any T or space)
    // This handles: "2026-01-10", "2026-01-10T00:00:00Z", "2026-01-10T08:00:00-05:00", etc.
    const dateMatch = dateString.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (dateMatch) {
        const [, year, month, day] = dateMatch;
        // Validate the date parts are valid
        const yearNum = parseInt(year, 10);
        const monthNum = parseInt(month, 10);
        const dayNum = parseInt(day, 10);
        if (yearNum >= 1900 && yearNum <= 2100 && monthNum >= 1 && monthNum <= 12 && dayNum >= 1 && dayNum <= 31) {
            return `${year}-${month}-${day}`;
        }
    }
    
    // Fallback for edge cases - parse as date but construct from components
    // This should rarely be needed if dates are stored properly
    try {
        const date = new Date(dateString);
        if (isNaN(date.getTime())) {
            console.warn('Invalid date string:', dateString);
            return '';
        }
        // Use local date components to avoid timezone shifts
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    } catch (e) {
        console.warn('Error parsing date:', dateString, e);
        return '';
    }
}

/**
 * Format date for nav display (e.g., "Jan 9")
 */
/**
 * Format date for nav display (e.g., "Jan 9")
 * Handles dates consistently by extracting date parts and constructing local date
 */
function formatDateForNav(dateString) {
    if (!dateString) return '';
    
    // Extract YYYY-MM-DD from the beginning of the string
    const dateMatch = dateString.match(/^(\d{4})-(\d{2})-(\d{2})/);
    let date;
    if (dateMatch) {
        const [, year, month, day] = dateMatch;
        // Construct date using local timezone components to avoid shifts
        date = new Date(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10));
    } else {
        // Fallback: parse as date but construct from local components
        try {
            const d = new Date(dateString);
            if (isNaN(d.getTime())) return '';
            date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        } catch (e) {
            return '';
        }
    }
    
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = monthNames[date.getMonth()];
    const day = date.getDate();
    return `${month} ${day}`;
}

/**
 * Get image path from post
 */
function getImagePath(post) {
    const imageName = post.websiteStory?.image || post.websiteStory?.imageUrl || '';
    if (!imageName) {
        console.log('[getImagePath] No image found for post:', post.id, post.websiteStory?.headline);
        return '';
    }
    
    // If already a full URL (http/https), return as is
    if (imageName.startsWith('http://') || imageName.startsWith('https://')) {
        return imageName;
    }
    
    // If already a full path starting with /, return as is
    if (imageName.startsWith('/')) {
        return imageName;
    }
    
    // If it contains /assets/images/, extract just the filename and reconstruct
    if (imageName.includes('/assets/images/')) {
        const filename = imageName.split('/assets/images/').pop() || imageName.split('/').pop();
        const path = `/assets/images/${filename}`;
        console.log('[getImagePath] Reconstructed path from full path:', { original: imageName, filename, path });
        return path;
    }
    
    // Otherwise, assume it's just a filename and construct path
    const path = `/assets/images/${imageName}`;
    console.log('[getImagePath] Constructed path from filename:', { original: imageName, path });
    return path;
}

/**
 * Normalize league name to URL-friendly format (matches backend logic)
 */
function normalizeLeague(league) {
    if (!league) return '';
    // Normalize to handle case variations and whitespace
    const normalized = String(league).trim();
    
    // Handle La Liga specifically first (most common issue)
    const upper = normalized.toUpperCase();
    if (upper === 'LA LIGA' || upper === 'LALIGA' || upper === 'LA-LIGA') {
        return 'laliga';
    }
    
    const leagueMap = {
        'NBA': 'nba',
        'NFL': 'nfl',
        'EPL': 'epl',
        'Premier League': 'epl',
        'LaLiga': 'laliga',
        'La Liga': 'laliga',
        'LA LIGA': 'laliga',
        'Serie A': 'serie-a',
        'SERIE A': 'serie-a',
        'Bundesliga': 'bundesliga',
        'Ligue 1': 'ligue-1',
        'LIGUE 1': 'ligue-1',
        'MLB': 'mlb',
        'NHL': 'nhl',
        'UFC': 'ufc',
        'Soccer': 'soccer',
        'DFS': 'dfs',
    };
    
    // Check exact match first
    if (leagueMap[normalized]) {
        return leagueMap[normalized];
    }
    
    // Final fallback: convert to lowercase and replace spaces with hyphens
    // But for La Liga, we want 'laliga' not 'la-liga'
    const lower = normalized.toLowerCase();
    if (lower === 'la liga' || lower === 'laliga' || lower === 'la-liga') {
        return 'laliga';
    }
    
    // Ensure we always return a valid string
    const result = lower.replace(/\s+/g, '-');
    return result || 'unknown';
}

/**
 * Generate slug from headline (matches backend logic)
 */
function generateSlugFromHeadline(headline) {
    if (!headline) return 'article';
    return headline
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
        .replace(/\s+/g, '-') // Replace spaces with hyphens
        .replace(/-+/g, '-') // Replace multiple hyphens with single hyphen
        .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens
}

/**
 * Extract narrative keywords from headline and tags
 */
function extractNarrativeKeywords(headline, emotionTags) {
    if (!headline) return 'analysis';
    
    const headlineLower = headline.toLowerCase();
    const allTags = (emotionTags || []).map(t => t.toLowerCase());
    
    const narrativeKeywords = [
        'revenge', 'rivalry', 'redemption', 'revenge-game', 'homecoming', 'return',
        'vengeance', 'vendetta', 'grudge', 'motivation', 'pressure', 'collapse',
        'upset', 'breakout', 'explosion', 'redemption-arc', 'personal-vendetta',
        'former-team', 'old-guard', 'new-era', 'clash', 'battle', 'showdown',
        'comeback', 'rematch', 'curse', 'legacy', 'dynasty'
    ];
    
    // Check headline for keywords
    for (const keyword of narrativeKeywords) {
        if (headlineLower.includes(keyword.replace('-', ' ')) || headlineLower.includes(keyword)) {
            return keyword;
        }
    }
    
    // Check emotion tags
    for (const tag of allTags) {
        const normalizedTag = tag.toLowerCase().replace(/\s+/g, '-');
        if (narrativeKeywords.includes(normalizedTag)) {
            return normalizedTag;
        }
    }
    
    // Extract first significant word from headline as fallback
    const stopWords = new Set(['the', 'a', 'an', 'in', 'on', 'at', 'vs', 'vs.', 'v', 'v.', 'for', 'to', 'of', 'and', 'or']);
    const words = headlineLower
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.has(w));
    
    if (words.length > 0) {
        return words[0].substring(0, 20); // Limit to 20 chars
    }
    
    return 'analysis'; // Ultimate fallback
}

/**
 * Generate narrative-based slug for matchup articles
 */
function generateNarrativeSlug(headline, teamA, teamB, emotionTags) {
    const teamASlug = teamA
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/^-|-$/g, '')
        .split('-')
        .slice(-1)[0]; // Take last word (team name)
    
    const teamBSlug = teamB
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/^-|-$/g, '')
        .split('-')
        .slice(-1)[0]; // Take last word (team name)
    
    const narrativeKeyword = extractNarrativeKeywords(headline, emotionTags);
    
    // Construct slug: teamA-vs-teamB-narrative
    let slug = `${teamASlug}-vs-${teamBSlug}-${narrativeKeyword}`;
    
    // Ensure slug doesn't exceed 60 characters
    if (slug.length > 60) {
        const maxTeamLength = Math.floor((60 - narrativeKeyword.length - 5) / 2); // 5 for "-vs-"
        const truncatedTeamA = teamASlug.substring(0, maxTeamLength);
        const truncatedTeamB = teamBSlug.substring(0, maxTeamLength);
        slug = `${truncatedTeamA}-vs-${truncatedTeamB}-${narrativeKeyword}`;
    }
    
    // Clean up slug
    slug = slug
        .replace(/-+/g, '-') // Replace multiple hyphens
        .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens
    
    return slug;
}

/**
 * Generate matchup slug for URL path: {teamA-short}-vs-{teamB-short}
 */
function generateMatchupSlug(teamA, teamB) {
    const teamAShort = getShortTeamName(teamA).toLowerCase();
    const teamBShort = getShortTeamName(teamB).toLowerCase();
    
    const matchupSlug = `${teamAShort}-vs-${teamBShort}`
        .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
        .replace(/\s+/g, '-') // Replace spaces with hyphens
        .replace(/-+/g, '-') // Replace multiple hyphens
        .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens
    
    return matchupSlug;
}

/**
 * Generate article URL with new structure: /{league}/{date}/{matchup}/{narrative-slug}/
 * For DFS articles: /dfs/{league}/{date}/dfs-value-narratives-{date}/
 */
function generateArticleUrl(post) {
    // Normalize league name - normalizeLeague handles La Liga correctly
    const league = normalizeLeague(post.league || '');
    const date = post.matchupScheduledDate 
        ? formatDateForUrl(post.matchupScheduledDate)
        : formatDateForUrl(post.createdAt);
    
    // Handle DFS articles with special URL structure
    if (post.storyType === 'dfs_article') {
        return `/dfs/${league}/${date}/dfs-value-narratives-${date}/`;
    }
    
    // Handle Heat Picks articles with special URL structure
    if (post.storyType === 'heat_picks') {
        const storedSlug = post.websiteStory?.seo?.slug || '';
        if (storedSlug) {
            return `/${league}/${storedSlug}/`;
        } else {
            // Fallback: generate from date
            const dateParts = date.split('-');
            const slugDate = `${dateParts[1]}-${dateParts[2]}-${dateParts[0]}`;
            return `/${league}/heat-picks-today-${slugDate}/`;
        }
    }
    
    // Check if stored slug is in prediction format (new SEO-optimized format)
    const storedSlug = post.websiteStory?.seo?.slug || '';
    const isPredictionFormat = storedSlug.includes('-prediction-preview-') && storedSlug.match(/\d{4}-\d{2}-\d{2}$/);
    
    if (isPredictionFormat) {
        // Use prediction format: /{league}/{prediction-slug}/
        return `/${league}/${storedSlug}/`;
    }
    
    // Fallback to old format
    let matchupSlug;
    let narrativeSlug;
    
    if (storedSlug.includes('/') && storedSlug.split('/').length === 2) {
        // Already in old format: matchup-slug/narrative-slug
        [matchupSlug, narrativeSlug] = storedSlug.split('/');
    } else {
        // Fallback: Generate from post data
        matchupSlug = generateMatchupSlug(post.teamA || '', post.teamB || '');
        
        // Get narrative keywords from heatCheckData
        const heatCheckData = post.heatCheckData || {};
        const narratives = heatCheckData.narratives || {};
        const candidateCards = narratives.candidate_cards || [];
        const primaryNarrativeId = narratives.selected?.primary_narrative_id || '';
        const activeCard = candidateCards.find(card => card.narrative_id === primaryNarrativeId);
        const emotionTags = activeCard?.emotion_tags || [];
        
        narrativeSlug = generateNarrativeSlug(
            post.websiteStory?.headline || '',
            post.teamA || '',
            post.teamB || '',
            emotionTags
        );
    }
    
    // Old URL structure without .html extension
    return `/${league}/${date}/${matchupSlug}/${narrativeSlug}/`;
}

/**
 * Extract short team name from full team name
 * Examples: "New England Patriots" -> "Patriots", "Los Angeles Lakers" -> "Lakers"
 * Handles special cases like "San Francisco 49ers" -> "49ers", "Green Bay Packers" -> "Packers"
 */
function getShortTeamName(fullName) {
    if (!fullName) return '';
    
    const trimmed = fullName.trim();
    if (!trimmed) return '';
    
    // Split by spaces
    const parts = trimmed.split(/\s+/);
    
    // If only one word, return it
    if (parts.length === 1) {
        return parts[0];
    }
    
    // Handle special cases where the team name is the last two words
    // Examples: "San Francisco 49ers" -> "49ers", "Golden State Warriors" -> "Warriors"
    const lastWord = parts[parts.length - 1];
    const secondLastWord = parts.length > 1 ? parts[parts.length - 2] : '';
    
    // If last word is a number (like "49ers"), return just the number
    if (/^\d+/.test(lastWord)) {
        return lastWord;
    }
    
    // If last word is "FC", "United", "City", etc., return last two words
    const suffixes = ['FC', 'United', 'City', 'Town'];
    if (suffixes.includes(lastWord) && parts.length > 1) {
        return secondLastWord + ' ' + lastWord;
    }
    
    // For most teams, the last word is the team name
    // Examples: "New England Patriots" -> "Patriots", "Chicago Bears" -> "Bears"
    return lastWord;
}

/**
 * Get 3-letter acronym for a team name
 * Returns the standard abbreviation used in sports (e.g., "LAL" for "Los Angeles Lakers")
 */
function getLeagueAbbreviation(league) {
    const upper = (league || '').toUpperCase();
    if (upper === 'BUNDESLIGA') return 'GER';
    if (upper === 'LIGUE 1') return 'FRA';
    if (upper === 'SERIE A') return 'ITA';
    if (upper === 'LA LIGA') return 'ESP';
    if (upper === 'EPL' || upper === 'PREMIER LEAGUE') return 'EPL';
    return league ? league.toUpperCase().substring(0, 3) : 'N/A';
}

function getTeamAcronym(fullName, league) {
    if (!fullName) return '';
    
    const trimmed = fullName.trim();
    if (!trimmed) return '';
    
    // Normalize for matching (case-insensitive)
    const normalized = trimmed.toLowerCase();
    
    // NBA abbreviations
    const nbaAbbrev = {
        'atlanta hawks': 'ATL',
        'brooklyn nets': 'BKN',
        'boston celtics': 'BOS',
        'charlotte hornets': 'CHA',
        'chicago bulls': 'CHI',
        'cleveland cavaliers': 'CLE',
        'dallas mavericks': 'DAL',
        'denver nuggets': 'DEN',
        'detroit pistons': 'DET',
        'golden state warriors': 'GSW',
        'houston rockets': 'HOU',
        'indiana pacers': 'IND',
        'los angeles clippers': 'LAC',
        'los angeles lakers': 'LAL',
        'memphis grizzlies': 'MEM',
        'miami heat': 'MIA',
        'milwaukee bucks': 'MIL',
        'minnesota timberwolves': 'MIN',
        'new orleans pelicans': 'NOP',
        'new york knicks': 'NYK',
        'oklahoma city thunder': 'OKC',
        'orlando magic': 'ORL',
        'philadelphia 76ers': 'PHI',
        'phoenix suns': 'PHX',
        'portland trail blazers': 'POR',
        'sacramento kings': 'SAC',
        'san antonio spurs': 'SAS',
        'toronto raptors': 'TOR',
        'utah jazz': 'UTA',
        'washington wizards': 'WAS',
    };
    
    // NFL abbreviations
    const nflAbbrev = {
        'arizona cardinals': 'ARI',
        'atlanta falcons': 'ATL',
        'baltimore ravens': 'BAL',
        'buffalo bills': 'BUF',
        'carolina panthers': 'CAR',
        'chicago bears': 'CHI',
        'cincinnati bengals': 'CIN',
        'cleveland browns': 'CLE',
        'dallas cowboys': 'DAL',
        'denver broncos': 'DEN',
        'detroit lions': 'DET',
        'green bay packers': 'GB',
        'houston texans': 'HOU',
        'indianapolis colts': 'IND',
        'jacksonville jaguars': 'JAX',
        'kansas city chiefs': 'KC',
        'las vegas raiders': 'LV',
        'los angeles chargers': 'LAC',
        'los angeles rams': 'LAR',
        'miami dolphins': 'MIA',
        'minnesota vikings': 'MIN',
        'new england patriots': 'NE',
        'new orleans saints': 'NO',
        'new york giants': 'NYG',
        'new york jets': 'NYJ',
        'philadelphia eagles': 'PHI',
        'pittsburgh steelers': 'PIT',
        'san francisco 49ers': 'SF',
        'seattle seahawks': 'SEA',
        'tampa bay buccaneers': 'TB',
        'tennessee titans': 'TEN',
        'washington commanders': 'WAS',
    };
    
    // EPL abbreviations (common teams)
    const eplAbbrev = {
        'arsenal': 'ARS',
        'aston villa': 'AVL',
        'bournemouth': 'BOU',
        'brentford': 'BRE',
        'brighton & hove albion': 'BHA',
        'brighton': 'BHA',
        'burnley': 'BUR',
        'chelsea': 'CHE',
        'crystal palace': 'CRY',
        'everton': 'EVE',
        'fulham': 'FUL',
        'leeds': 'LEE',
        'leeds united': 'LEE',
        'liverpool': 'LIV',
        'luton town': 'LUT',
        'manchester city': 'MCI',
        'manchester united': 'MUN',
        'newcastle united': 'NEW',
        'nottingham forest': 'NFO',
        'sheffield united': 'SHU',
        'tottenham hotspur': 'TOT',
        'west ham united': 'WHU',
        'wolverhampton wanderers': 'WOL',
    };
    
    // Try exact match first
    if (nbaAbbrev[normalized]) return nbaAbbrev[normalized];
    if (nflAbbrev[normalized]) return nflAbbrev[normalized];
    if (eplAbbrev[normalized]) return eplAbbrev[normalized];
    
    // Try league-specific lookup
    if (league) {
        const leagueUpper = (league || '').toUpperCase();
        if (leagueUpper === 'NBA' && nbaAbbrev[normalized]) return nbaAbbrev[normalized];
        if (leagueUpper === 'NFL' && nflAbbrev[normalized]) return nflAbbrev[normalized];
        if ((leagueUpper === 'EPL' || leagueUpper === 'PREMIER LEAGUE') && eplAbbrev[normalized]) return eplAbbrev[normalized];
    }
    
    // Fallback: generate from first letters of words (up to 3)
    const words = trimmed.split(/\s+/).filter(function(w) { return w.length > 0; });
    if (words.length === 1) {
        // Single word: take first 3 letters, uppercase
        return words[0].substring(0, 3).toUpperCase();
    }
    
    // Multiple words: take first letter of first 3 words
    const acronym = words.slice(0, 3).map(function(w) { return w[0]; }).join('').toUpperCase();
    return acronym.length >= 3 ? acronym.substring(0, 3) : acronym + 'X'.repeat(3 - acronym.length);
}

/**
 * Generate post card HTML
 */
function generatePostCard(post) {
    const heatScore = calculateHeatScore(post);
    const dateStr = formatDateForCard(post.matchupScheduledDate || post.createdAt);
    const teamAShort = getShortTeamName(post.teamA || '');
    const teamBShort = getShortTeamName(post.teamB || '');
    const matchup = `${teamAShort} VS ${teamBShort}`.toUpperCase();
    const league = (post.league || '').toUpperCase();
    
    // Check if this is a DFS article or Heat Picks article
    const isDFSArticle = post.storyType === 'dfs_article';
    const isHeatPicksArticle = post.storyType === 'heat_picks';
    
    // For DFS articles, recalculate headline based on matchupScheduledDate
    let headline = post.websiteStory?.headline || 'Untitled';
    if (isDFSArticle) {
        const articleDate = post.matchupScheduledDate || post.createdAt;
        try {
            const dateForDayOfWeek = new Date(articleDate + (articleDate.indexOf('T') !== -1 ? '' : 'T12:00:00'));
            const dayOfWeek = dateForDayOfWeek.toLocaleDateString('en-US', { weekday: 'long' });
            // Ensure league is in correct format (NBA, NFL, etc. not "Basketball")
            const normalizedLeague = league.toUpperCase();
            headline = dayOfWeek + ' ' + normalizedLeague + ' DFS';
        } catch (e) {
            // Keep original headline if date parsing fails
        }
    }
    
    const imagePath = getImagePath(post);
    const articleUrl = generateArticleUrl(post);
    const isHeatHigh = heatScore >= 71; // ~71 on 100 scale = ~25 on 35 scale
    
    // For DFS articles, generate matchup text with day of week + "[League] DFS"
    // For Heat Picks articles, use "Heat Picks" label
    let displayMatchup = matchup;
    let displayMatchupMobile = (getTeamAcronym(post.teamA || '', post.league) + ' VS ' + getTeamAcronym(post.teamB || '', post.league)).toUpperCase();
    if (isDFSArticle) {
        const articleDate = post.matchupScheduledDate || post.createdAt;
        try {
            const dateForDayOfWeek = new Date(articleDate + (articleDate.includes('T') ? '' : 'T12:00:00'));
            const dayOfWeek = dateForDayOfWeek.toLocaleDateString('en-US', { weekday: 'long' });
            // Ensure league is in correct format (NBA, NFL, etc. not "Basketball")
            const normalizedLeague = league.toUpperCase();
            displayMatchup = (dayOfWeek + ' ' + normalizedLeague + ' DFS').toUpperCase();
            displayMatchupMobile = displayMatchup; // DFS articles don't need mobile variant
        } catch (e) {
            displayMatchup = 'DFS VALUE';
            displayMatchupMobile = displayMatchup;
        }
    } else if (isHeatPicksArticle) {
        displayMatchup = 'HEAT PICKS';
        displayMatchupMobile = displayMatchup;
    }
    
    // Extract quote from evidence bundle
    const heatCheckData = post.heatCheckData || {};
    const evidenceBundle = heatCheckData.evidence_bundle || heatCheckData.evidenceBundle || {};
    const quotes = evidenceBundle.quotes || [];
    const selectedQuote = quotes.length > 0 ? quotes[0] : null; // Use first quote
    let quoteText = selectedQuote?.quote || '';
    let quoteSpeaker = selectedQuote?.speaker || '';
    let quoteTeam = selectedQuote?.team || '';
    
    // For DFS articles, use special quote text
    if (isDFSArticle) {
        quoteText = "Take a deeper look at narratives on key value players for today's slate";
        quoteSpeaker = '';
        quoteTeam = '';
    } else if (!quoteText) {
        // Fallback to matchup preview quote if no quotes found
        const articleDate = post.matchupScheduledDate || post.createdAt;
        const today = new Date().toISOString().split('T')[0];
        const isToday = articleDate && articleDate.split('T')[0] === today;
        quoteText = `${post.teamA || ''} and ${post.teamB || ''} meet ${isToday ? 'tonight' : 'in a seasonal matchup'} in ${(post.league || '').toUpperCase()}.`;
        quoteSpeaker = 'Matchup Preview';
        quoteTeam = '';
    }
    
    // Truncate quote if too long (max ~120 chars for card display)
    const maxQuoteLength = 120;
    const displayQuote = quoteText.length > maxQuoteLength 
        ? quoteText.substring(0, maxQuoteLength).trim() + '...'
        : quoteText;
    
    // Build quote HTML if available
    const quoteHtml = displayQuote ? `
        <div style="margin: 0 0 1rem 0; padding: 0.75rem; background: rgba(0, 0, 0, 0.4); border-left: 3px solid rgba(248, 66, 66, 0.6); border-radius: 2px; font-family: 'Courier New', monospace;">
            <p style="font-size: 0.7rem; line-height: 1.4; color: rgba(255, 255, 255, 0.85); font-style: italic; margin: 0 0 0.4rem 0; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; text-overflow: ellipsis;">
                "${displayQuote.replace(/"/g, '&quot;')}"
            </p>
            ${!isDFSArticle && quoteSpeaker ? `<div style="font-size: 0.65rem; color: rgba(255, 255, 255, 0.6); margin: 0; text-align: right;">— ${quoteSpeaker.replace(/</g, '&lt;').replace(/>/g, '&gt;')}${quoteTeam ? ` (${quoteTeam.replace(/</g, '&lt;').replace(/>/g, '&gt;')})` : ''}</div>` : ''}
        </div>
    ` : '';
    
    return `
        <div class="post-card" data-heat-high="${isHeatHigh}" data-post-id="${post.id}" ${isHeatPicksArticle ? 'data-heat-picks-card="true"' : ''}>
            <div style="display: flex; flex-direction: column; flex: 1; min-height: 0; width: 100%; box-sizing: border-box; overflow: hidden;">
                <div style="padding: 0.5rem 0.6rem; background: rgba(0, 0, 0, 0.5); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); border: 1px solid rgba(255, 255, 255, 0.35); margin-bottom: 0.75rem; text-align: center; display: flex; align-items: center; justify-content: space-between; gap: 0.4rem; width: 100%; box-sizing: border-box; overflow: hidden; border-radius: 4px;">
                    <div style="width: 50px; height: 50px; min-width: 50px; border-radius: 50%; border: 2px solid #fff; background: #fff; box-shadow: 0 2px 8px rgba(255, 255, 255, 0.5), 0 0 12px rgba(255, 255, 255, 0.3); display: flex; align-items: center; justify-content: center; flex-shrink: 0; box-sizing: border-box;">
                        <div style="color: #000; font-size: 0.85rem; font-family: 'Arial Black', 'Impact', 'Franklin Gothic Bold', 'Helvetica Neue', Arial, sans-serif; font-weight: 900; line-height: 1; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${dateStr}</div>
                    </div>
                    <div style="color: #fff; font-size: 1.05rem; font-family: 'Arial Black', 'Impact', 'Franklin Gothic Bold', 'Helvetica Neue', Arial, sans-serif; font-weight: 900; text-transform: uppercase; letter-spacing: 0.08em; flex: 1; min-width: 0; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-sizing: border-box; -webkit-text-stroke: 1px #000000; text-stroke: 1px #000000;">
                        <span class="matchup-card-full">${displayMatchup}</span>
                        <span class="matchup-card-mobile" style="display: none;">${displayMatchupMobile}</span>
                    </div>
                    <div style="width: 40px; height: 40px; min-width: 40px; border-radius: 50%; border: 2px solid #fff; background: rgba(255, 255, 255, 0.1); box-shadow: 0 2px 8px rgba(255, 255, 255, 0.3), 0 0 12px rgba(255, 255, 255, 0.2); display: flex; align-items: center; justify-content: center; flex-shrink: 0; box-sizing: border-box;">
                        <div style="color: #fff; font-size: 0.75rem; font-family: 'Arial Black', 'Impact', 'Franklin Gothic Bold', 'Helvetica Neue', Arial, sans-serif; font-weight: 900; line-height: 1; text-align: center; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; -webkit-text-stroke: 1px #000000; text-stroke: 1px #000000;">${getLeagueAbbreviation(league)}</div>
                    </div>
                </div>
                <div style="display: flex; gap: 0.5rem; margin-bottom: 0.75rem; align-items: center; justify-content: flex-start; position: relative; width: 100%; box-sizing: border-box;">
                    ${isDFSArticle ? `
                    <!-- DFS Heat Indicator -->
                    <div class="heat-indicator-container" data-post-id="${post.id}" style="width: 85px; height: 85px; min-width: 85px; border: 2px solid #00ff41; border-radius: 50%; background: rgba(0, 0, 0, 0.5); display: flex; align-items: center; justify-content: center; flex-shrink: 0; position: relative; box-shadow: inset 0 0 20px #00ff4140, 0 0 15px #00ff4160; overflow: hidden;">
                        <div style="color: #00ff41; font-size: 1.2rem; font-weight: 900; -webkit-text-stroke: 2px #000000; text-stroke: 2px #000000; font-family: 'Arial Black', 'Impact', 'Franklin Gothic Bold', 'Helvetica Neue', Arial, sans-serif; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; letter-spacing: 0.5px; z-index: 1; position: relative;">DFS</div>
                    </div>
                    ` : isHeatPicksArticle ? `
                    <!-- Heat Picks Indicator (HP) - Enhanced -->
                    <div class="heat-indicator-container heat-picks-indicator" data-post-id="${post.id}" data-heat-picks="true" style="width: 85px; height: 85px; min-width: 85px; border: 3px solid #ff4500; border-radius: 50%; background: linear-gradient(135deg, rgba(255, 69, 0, 0.5) 0%, rgba(255, 26, 26, 0.5) 50%, rgba(255, 69, 0, 0.3) 100%); display: flex; align-items: center; justify-content: center; flex-shrink: 0; position: relative; box-shadow: inset 0 0 30px rgba(255, 69, 0, 0.6), 0 0 25px rgba(255, 69, 0, 0.8), 0 0 40px rgba(255, 26, 26, 0.4); overflow: visible; cursor: default; pointer-events: none;">
                        <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 70px; height: 70px; border: 2px solid rgba(255, 69, 0, 0.6); border-radius: 50%; opacity: 0.8; background: rgba(0, 0, 0, 0.3);"></div>
                        <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 55px; height: 55px; border: 1.5px solid rgba(255, 26, 26, 0.7); border-radius: 50%; opacity: 0.6; background: rgba(0, 0, 0, 0.5);"></div>
                        <div style="color: #ff1a1a; font-size: 1.5rem; font-weight: 900; -webkit-text-stroke: 2.5px #000000; text-stroke: 2.5px #000000; font-family: 'Arial Black', 'Impact', 'Franklin Gothic Bold', 'Helvetica Neue', Arial, sans-serif; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; letter-spacing: 0.8px; z-index: 1; position: relative; text-shadow: 0 0 10px rgba(255, 26, 26, 0.8), 0 0 20px rgba(255, 26, 26, 0.5);">HP</div>
                    </div>
                    ` : `
                    <!-- Regular Heat Indicator -->
                    <div class="heat-indicator-container" data-post-id="${post.id}" style="width: 85px; height: 85px; min-width: 85px; border: 2px solid #ff0040; border-radius: 50%; background: rgba(0, 0, 0, 0.5); display: flex; align-items: center; justify-content: center; flex-shrink: 0; position: relative; box-shadow: inset 0 0 20px #ff004040, 0 0 15px #ff004060; overflow: hidden; cursor: pointer;">
                        <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 72px; height: 72px; border: 1.5px solid #ffe66d; border-radius: 50%; opacity: 0.75;"></div>
                        <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 50px; height: 50px; border: 1.5px solid #ff0040; opacity: 0.7;"></div>
                        <div class="heat-number" style="color: #ff1a1a; font-size: 1.8rem; font-weight: 900; -webkit-text-stroke: 2px #000000; text-stroke: 2px #000000; font-family: 'Arial Black', 'Impact', 'Franklin Gothic Bold', 'Helvetica Neue', Arial, sans-serif; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; letter-spacing: 0.5px; z-index: 1; position: relative; transition: text-shadow 0.3s ease;">${heatScore}</div>
                    </div>
                    `}
                    <div class="post-card-image-container" data-post-id="${post.id}" style="flex: 1; height: 130px; min-width: 0; position: relative; overflow: hidden; box-sizing: border-box;">
                        ${imagePath ? `<img src="${imagePath}" alt="${teamAShort} vs ${teamBShort} ${league} matchup analysis - ${headline} - HeatChecks Analysis" style="width: 100%; height: 100%; object-fit: cover; object-position: top; border-radius: 4px; display: block;">` : '<div style="width: 100%; height: 100%; background: rgba(255, 255, 255, 0.1); border-radius: 4px; display: flex; align-items: center; justify-content: center; color: rgba(255, 255, 255, 0.5); font-size: 0.75rem;">No Image</div>'}
                    </div>
                </div>
                ${isHeatPicksArticle ? `
                    <h2 style="font-size: 0.9rem; line-height: 1.2; margin: 0 0 0.75rem 0; padding: 0.5rem; background: rgba(0, 0, 0, 0.4); border: 1px solid rgba(0, 255, 65, 0.3); font-family: 'Courier New', monospace; font-size: 0.65rem; text-align: center; color: rgba(0, 255, 65, 0.9); font-weight: bold; text-transform: uppercase; letter-spacing: 0.1em; width: 100%; box-sizing: border-box;">${league} HEAT PICKS - SEE THE HOTTEST PLAYS TODAY</h2>
                    <div style="margin: 0 0 1rem 0; padding: 0.75rem; background: rgba(0, 0, 0, 0.4); border-left: 3px solid rgba(0, 255, 65, 0.6); border-radius: 2px; font-family: 'Courier New', monospace; display: flex; flex-wrap: nowrap; gap: 0.25rem; justify-content: center; align-items: center; font-size: 0.5rem; white-space: nowrap; overflow: hidden;">
                        <div style="color: rgba(0, 255, 65, 0.9); flex-shrink: 0;">✔ DATA-DRIVEN</div>
                        <div style="color: rgba(255, 255, 255, 0.6); flex-shrink: 0;">*</div>
                        <div style="color: rgba(0, 255, 65, 0.9); flex-shrink: 0;">NARRATIVE-VERIFIED</div>
                        <div style="color: rgba(255, 255, 255, 0.6); flex-shrink: 0;">*</div>
                        <div style="color: rgba(0, 255, 65, 0.9); flex-shrink: 0;">MARKET-LAG DETECTED</div>
                    </div>
                ` : `
                <h2 style="font-size: 0.9rem; line-height: 1.2; margin: 0 0 1rem 0; padding: 0; color: #fff; font-family: 'Arial Black', 'Impact', 'Franklin Gothic Bold', 'Helvetica Neue', Arial, sans-serif; font-weight: 900; text-align: center; min-height: 2.2em; max-height: 3.2em; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; width: 100%; box-sizing: border-box; word-wrap: break-word; -webkit-text-stroke: 1px #000000; text-stroke: 1px #000000;">${headline}</h2>
                ${quoteHtml}
                `}
                <a href="${articleUrl}" style="margin-top: 0; margin-bottom: 0; font-size: 0.7rem; padding: 0.4rem 0.8rem; background: #000; border: 2px solid rgba(0, 255, 65, 0.6); color: #fff; cursor: pointer; text-transform: uppercase; font-family: 'Arial Black', 'Impact', 'Franklin Gothic Bold', 'Helvetica Neue', Arial, sans-serif; font-weight: 900; letter-spacing: 0.08em; transition: all 0.3s ease; width: 100%; box-sizing: border-box; text-decoration: none; display: block; text-align: center; box-shadow: 0 0 10px rgba(0, 255, 65, 0.3), 0 0 20px rgba(0, 255, 65, 0.1);" onmouseover="this.style.borderColor='rgba(0, 255, 65, 0.8)'; this.style.boxShadow='0 0 15px rgba(0, 255, 65, 0.5), 0 0 30px rgba(0, 255, 65, 0.2)';" onmouseout="this.style.borderColor='rgba(0, 255, 65, 0.6)'; this.style.boxShadow='0 0 10px rgba(0, 255, 65, 0.3), 0 0 20px rgba(0, 255, 65, 0.1)';">VIEW STORY</a>
            </div>
        </div>
    `;
}

/**
 * Render posts to the page
 */
function renderPosts(posts, page = 1) {
    const postList = document.getElementById('recent-logs-list');
    if (!postList) return;
    
    const startIdx = (page - 1) * postsPerPage;
    const endIdx = startIdx + postsPerPage;
    const postsToShow = posts.slice(startIdx, endIdx);
    
    if (postsToShow.length === 0) {
        postList.innerHTML = '<p style="color: rgba(255, 255, 255, 0.7); font-size: 1rem; font-weight: 900; text-align: center; padding: 2rem;">NO ENTRIES YET</p>';
        return;
    }
    
    postList.innerHTML = postsToShow.map(post => generatePostCard(post)).join('');
    
    // Re-initialize hover effects after rendering (needed for pagination)
    initHeatIndicatorHover();
    
    // Update pagination
    const totalPages = Math.ceil(posts.length / postsPerPage);
    const paginationInfo = document.getElementById('pagination-info');
    const nextPageLink = document.getElementById('next-page-link');
    
    if (paginationInfo) {
        paginationInfo.textContent = `PAGE ${page} / ${totalPages}`;
    }
    
    if (nextPageLink) {
        if (page < totalPages) {
            nextPageLink.style.display = 'block';
            nextPageLink.href = `#page-${page + 1}`;
            nextPageLink.onclick = (e) => {
                e.preventDefault();
                currentPage = page + 1;
                renderPosts(posts, currentPage);
                window.scrollTo({ top: 0, behavior: 'smooth' });
            };
        } else {
            nextPageLink.style.display = 'none';
        }
    }
}

/**
 * Extract recent dates from posts for navigation
 */
function extractRecentDates(posts) {
    const dateMap = new Map();
    
    posts.forEach(post => {
        const date = post.matchupScheduledDate || post.createdAt;
        if (!date) return;
        
        const dateStr = formatDateForUrl(date);
        const storyType = String(post.storyType || '').toLowerCase();
        // Normalize league name FIRST (before uppercasing) to get correct URL format
        const leagueRaw = String(post.league || '');
        const leagueLower = normalizeLeague(leagueRaw);
        const leagueUpper = leagueRaw.toUpperCase();

        // DFS articles belong under /dfs/{sport}/{date}/ and should not populate main league submenus.
        if (storyType === 'dfs_article') {
            const dfsKey = 'DFS';
            if (!dateMap.has(dfsKey)) {
                dateMap.set(dfsKey, { items: new Set() });
            }
            dateMap.get(dfsKey).items.add(JSON.stringify({
                date: dateStr,
                display: `${formatDateForNav(dateStr)} ${leagueUpper}`,
                url: `/dfs/${leagueLower}/${dateStr}/`
            }));
            return;
        }
        
        // Heat Picks articles should appear in league hubs (not filtered out)
        // They will use the normal league/date structure
        
        // Use uppercase for key matching with data-league attribute
        if (!dateMap.has(leagueUpper)) {
            dateMap.set(leagueUpper, { dates: new Set(), leagueLower: leagueLower });
        }
        dateMap.get(leagueUpper).dates.add(dateStr);
    });
    
    // Convert to array and sort
    const result = {};
    dateMap.forEach((data, leagueUpper) => {
        if (leagueUpper === 'DFS') {
            const items = Array.from(data.items || [])
                .map(s => { try { return JSON.parse(s); } catch { return null; } })
                .filter(Boolean)
                .sort((a, b) => String(b.date).localeCompare(String(a.date)));
            result[leagueUpper] = items.slice(0, 1); // ONLY most recent DFS date
            return;
        }

        result[leagueUpper] = Array.from(data.dates)
            .sort()
            .reverse()
            .slice(0, 1) // ONLY the most recent date
            .map(dateStr => ({
                date: dateStr,
                display: formatDateForNav(dateStr),
                url: `/${data.leagueLower}/${dateStr}/`
            }));
    });
    
    return result;
}

/**
 * Initialize crawler navigation interactivity (submenu toggles) on all pages
 * This makes the existing nav HTML interactive
 */
function initCrawlerNavInteractivity() {
    const leagueLinks = document.querySelectorAll('.league-link');
    
    leagueLinks.forEach(link => {
        const leagueContainer = link.closest('.league-nav-item');
        if (!leagueContainer) return;
        
        const submenu = leagueContainer.querySelector('.nav-submenu');
        
        // Toggle submenu on click (but not if clicking a submenu link)
        link.addEventListener('click', (e) => {
            // Don't handle if clicking a submenu item inside
            if (e.target.closest('.nav-submenu')) {
                return;
            }
            
            // Only prevent default if clicking the league link itself
            if (e.target === link || (link.contains(e.target) && !e.target.closest('.nav-submenu'))) {
                e.preventDefault();
                e.stopPropagation();
                
                const arrow = link.querySelector('.league-arrow');
                
                if (submenu) {
                    submenu.classList.toggle('hidden');
                    if (arrow) {
                        arrow.style.transform = submenu.classList.contains('hidden') 
                            ? 'rotate(0deg)' 
                            : 'rotate(90deg)';
                    }
                }
            }
        });
        
        // Allow navigation on submenu links - don't stop propagation for links
        if (submenu) {
            submenu.addEventListener('click', (e) => {
                // Only stop propagation if clicking the submenu container itself, not links
                if (e.target === submenu || (!e.target.closest('a') && !e.target.matches('a'))) {
                e.stopPropagation();
                }
            });
        }
    });
}

/**
 * Initialize crawler navigation with dynamic dates (homepage only)
 */
function initCrawlerNav(posts) {
    const recentDates = extractRecentDates(posts);
    const leagueLinks = document.querySelectorAll('.league-link');

    leagueLinks.forEach(link => {
        const league = link.getAttribute('data-league');
        const leagueContainer = link.closest('.league-nav-item');
        if (!leagueContainer) return;

        const submenu = leagueContainer.querySelector('.nav-submenu');
        // Normalize league name to uppercase for lookup (recentDates uses uppercase keys)
        const leagueKey = league ? league.toUpperCase() : null;
        const items = leagueKey && recentDates[leagueKey] ? recentDates[leagueKey] : null;
        if (!submenu || !items || items.length === 0) return;

        // Keep (or create) HUB link
        let hubLink = Array.from(submenu.querySelectorAll('a')).find(a => (a.textContent || '').trim().toUpperCase() === 'HUB');
        if (!hubLink) {
            hubLink = document.createElement('a');
            hubLink.className = 'nav-link nav-submenu-item';
            hubLink.textContent = 'HUB';
            submenu.prepend(hubLink);
        }
        // Use normalizeLeague to get the correct URL format (e.g., "La Liga" -> "laliga", not "la-liga")
        const leagueLower = normalizeLeague(league || '');
        hubLink.href = (league || '').toUpperCase() === 'DFS' ? `/dfs/` : `/${leagueLower}/`;

        // Remove everything else
        Array.from(submenu.querySelectorAll('a')).forEach(a => {
            if (a === hubLink) return;
            a.remove();
        });

        // Add ONLY the most recent date link
        const dateInfo = items[0];
        if (dateInfo && dateInfo.url) {
            const dateLink = document.createElement('a');
            dateLink.href = dateInfo.url;
            dateLink.className = 'nav-link nav-submenu-item';
            dateLink.textContent = dateInfo.display;
            submenu.appendChild(dateLink);
        }
    });
}

/**
 * Get today's date in YYYY-MM-DD format (America/New_York timezone)
 * This ensures consistency with stored matchup dates which are in EST/EDT
 */
function getTodayDate() {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(now);

    const y = parts.find(p => p.type === "year").value;
    const m = parts.find(p => p.type === "month").value;
    const d = parts.find(p => p.type === "day").value;
    return `${y}-${m}-${d}`;
}

/**
 * Get tomorrow's date in YYYY-MM-DD format (America/New_York timezone)
 * Uses pure date math to avoid timezone shifts
 */
function getTomorrowDate() {
    // Get today in NY timezone first
    const today = getTodayDate();
    
    // Parse as pure date math (no timezone shifts)
    const [y, m, d] = today.split("-").map(Number);
    
    // Create date in UTC to avoid timezone issues, then add 1 day
    const dt = new Date(Date.UTC(y, m - 1, d)); // month is 0-indexed
    dt.setUTCDate(dt.getUTCDate() + 1);
    
    // Format back to YYYY-MM-DD
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(dt.getUTCDate()).padStart(2, "0");
    return `${yy}-${mm}-${dd}`;
}

/**
 * Format date for display (MM/DD)
 * Handles dates consistently regardless of timezone
 */
function formatDateMMDD(dateString) {
    if (!dateString) return '';
    
    // Extract YYYY-MM-DD from the beginning of the string
    const dateMatch = dateString.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (dateMatch) {
        const [, year, month, day] = dateMatch;
        return `${month}/${day}`;
    }
    
    // Fallback
    try {
        const date = new Date(dateString);
        if (isNaN(date.getTime())) return '';
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${month}/${day}`;
    } catch (e) {
        return '';
    }
}

/**
 * Format date for display (e.g., "Jan 9, 2026")
 */
/**
 * Format date for display (e.g., "Jan 9, 2026")
 * Handles dates consistently by extracting date parts and constructing local date
 */
function formatDateDisplay(dateString) {
    if (!dateString) return '';
    
    // Extract YYYY-MM-DD from the beginning of the string
    const dateMatch = dateString.match(/^(\d{4})-(\d{2})-(\d{2})/);
    let date;
    if (dateMatch) {
        const [, year, month, day] = dateMatch;
        // Construct date using local timezone components to avoid shifts
        date = new Date(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10));
    } else {
        // Fallback: parse as date
        try {
            date = new Date(dateString);
            if (isNaN(date.getTime())) {
                return '';
            }
        } catch (e) {
            return '';
        }
    }
    
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = monthNames[date.getMonth()];
    const day = date.getDate();
    const year = date.getFullYear();
    return `${month} ${day}, ${year}`;
}

/**
 * Get date from post (matchupScheduledDate or createdAt)
 * Returns YYYY-MM-DD format for consistent comparison and display
 */
function getPostDate(post) {
    const dateSource = post.matchupScheduledDate || post.createdAt;
    if (!dateSource) {
        console.warn('Post has no date:', post.id);
        return '';
    }
    const formatted = formatDateForUrl(dateSource);
    // Debug: log if date seems off
    if (post.matchupScheduledDate && post.matchupScheduledDate !== formatted) {
        console.log('Date formatted:', {
            original: post.matchupScheduledDate,
            formatted: formatted,
            teamA: post.teamA,
            teamB: post.teamB
        });
    }
    return formatted;
}

/**
 * Generate matchup button HTML
 */
function generateMatchupButton(post) {
    // Use the raw date source first, then format for display
    // This ensures we're displaying the actual scheduled date, not a potentially shifted date
    const rawDate = post.matchupScheduledDate || post.createdAt;
    const matchupDate = getPostDate(post); // YYYY-MM-DD for comparison
    const dateMMDD = formatDateMMDD(matchupDate); // Extract MM/DD for display
    const teamAShort = getShortTeamName(post.teamA || '');
    const teamBShort = getShortTeamName(post.teamB || '');
    const matchup = `${teamAShort} VS ${teamBShort}`;
    const league = (post.league || '').toUpperCase();
    const articleUrl = generateArticleUrl(post);
    
    // Calculate heat score (using unified temperature model: 40 = baseline, 70 = warm, 90 = hot)
    // Always recalculate to ensure we're using the latest unified model
    const heatScore = calculateHeatScoreFromMatchupData(post);
    const scoreTotal = heatScore.total || 0;
    
    // Debug: Log calculation method for troubleshooting
    const hasMatchPackV3 = !!(post.heatCheckData && post.heatCheckData.matchPackV3);
    const hasFactPack = !!(post.heatCheckData && (post.heatCheckData.fact_pack || post.heatCheckData.factPack));
    if (!hasMatchPackV3) {
        console.log(`[Radar] ${matchup}: Using fallback calculation (no matchPackV3), score: ${scoreTotal}`);
    }
    
    // Debug: Log if score seems off (for troubleshooting)
    if (scoreTotal < 40 || scoreTotal > 100) {
        console.warn('[Radar] Unexpected heat score:', {
            matchup: matchup,
            score: scoreTotal,
            hasMatchPackV3: hasMatchPackV3,
            hasFactPack: hasFactPack
        });
    }
    
    // Determine score tier with visual emojis
    // Tiers: ❄️ COOL (0–59), 🔥 WARM (60–69), 🔥🔥 HOT (70–79), 🔥🔥🔥 VOLATILE (80+)
    let scoreEmoji = '❄️';
    let scoreLabel = 'COOL';
    let scoreColor = 'rgba(255, 255, 255, 0.5)';
    
    if (scoreTotal >= 80) {
        scoreEmoji = '🔥🔥🔥';
        scoreLabel = 'SCORCHING';
        scoreColor = '#ff1a1a'; // Bright red for volatile
    } else if (scoreTotal >= 70) {
        scoreEmoji = '🔥🔥';
        scoreLabel = 'HOT';
        scoreColor = '#ff3333'; // Red for hot
    } else if (scoreTotal >= 60) {
        scoreEmoji = '🔥';
        scoreLabel = 'WARM';
        scoreColor = '#ff8000'; // Orange for warm
    } else {
        // 0-59: Cool
        scoreEmoji = '❄️';
        scoreLabel = 'COOL';
        scoreColor = 'rgba(255, 255, 255, 0.6)'; // White for cool
    }
    
    // Debug: log date issues
    if (rawDate && rawDate.includes('2026-01-10') || rawDate.includes('2026-01-11')) {
        console.log('Matchup button date:', {
            teamA: teamAShort,
            teamB: teamBShort,
            rawDate: rawDate,
            formattedDate: matchupDate,
            displayDate: dateMMDD
        });
    }
    
    return `
        <a href="${articleUrl}" class="roundup-game-item" style="display: flex; justify-content: space-between; align-items: center;">
            <div style="flex: 1; min-width: 0;">
                <div class="game-matchup">${matchup}</div>
                <div class="game-date">${dateMMDD} • ${league}</div>
            </div>
            <div class="game-heat-score" style="margin-left: 0.75rem; flex-shrink: 0; text-align: right;">
                <div style="color: ${scoreColor}; font-family: 'Courier New', monospace; font-size: 0.7rem; font-weight: bold; text-transform: uppercase; letter-spacing: 0.05em;">${scoreLabel}</div>
                <div style="color: rgba(255, 255, 255, 0.6); font-family: 'Courier New', monospace; font-size: 0.6rem; margin-top: 0.15rem; display: flex; align-items: center; justify-content: flex-end; gap: 0.25rem;">
                    <span style="font-size: 0.6rem; line-height: 1;">${scoreEmoji}</span>
                    <span>${scoreTotal}</span>
                </div>
            </div>
        </a>
    `;
}

/**
 * Show loading state with technical messages
 */
function showRadarLoading() {
    const initialState = document.querySelector('.radar-initial-state');
    const loadingState = document.querySelector('.radar-loading-state');
    const descriptionState = document.querySelector('.radar-description-state');
    const loadingDescription = document.querySelector('.radar-loading-description');
    const loadingMessage = document.getElementById('radar-loading-message');
    const loadingDesc = document.getElementById('radar-loading-description');
    
    if (initialState) initialState.style.display = 'none';
    if (descriptionState) descriptionState.style.display = 'none';
    if (loadingState) loadingState.style.display = 'flex';
    if (loadingDescription) loadingDescription.style.display = 'flex';
    
    const messages = [
        'SCANNING MATCHUPS...',
        'APPLYING HEATSCAN INTELLIGENCE...',
        'ANALYZING NARRATIVE MOMENTUM...',
        'PROCESSING REVENGE FACTORS...',
        'CALCULATING PSYCHOLOGICAL PRESSURE...',
        'COMPILING RESULTS...'
    ];
    
    const descriptions = [
        'Processing matchups and applying HeatScan intelligence algorithms...',
        'Analyzing narrative momentum and historical patterns...',
        'Identifying revenge factors and psychological pressure indicators...',
        'Calculating heat scores and matchup intensity...',
        'Finalizing intelligence report...',
        'Results ready for display...'
    ];
    
    let messageIndex = 0;
    const updateMessages = () => {
        if (messageIndex < messages.length) {
            if (loadingMessage) loadingMessage.textContent = messages[messageIndex];
            if (loadingDesc) loadingDesc.textContent = descriptions[messageIndex];
            messageIndex++;
        }
    };
    
    updateMessages();
    const interval = setInterval(updateMessages, 800);
    
    return interval;
}

/**
 * Store radar scan results in sessionStorage
 * Note: Posts are stored with their full data, so scores will be recalculated on display
 */
function storeRadarResults(todayPosts, tomorrowPosts) {
    try {
        const scanDate = getTodayDate();
        const scanData = {
            scanDate: scanDate,
            todayPosts: todayPosts,
            tomorrowPosts: tomorrowPosts,
            timestamp: Date.now(),
            // Store version to detect when calculation function changes
            scoreVersion: 'unified-temperature-v1'
        };
        sessionStorage.setItem('radarScanResults', JSON.stringify(scanData));
    } catch (error) {
        console.error('Failed to store radar results:', error);
    }
}

/**
 * Get stored radar scan results from sessionStorage
 * Results expire after 10 minutes to ensure newly published articles appear
 * Also checks score version to ensure we recalculate with latest function
 */
function getStoredRadarResults() {
    try {
        const stored = sessionStorage.getItem('radarScanResults');
        if (!stored) return null;
        
        const scanData = JSON.parse(stored);
        const today = getTodayDate();
        
        // Check if score version matches (if not, clear cache to force recalculation)
        const currentScoreVersion = 'unified-temperature-v1';
        if (scanData.scoreVersion !== currentScoreVersion) {
            console.log('[Radar] Score calculation updated, clearing cached results');
            sessionStorage.removeItem('radarScanResults');
            return null;
        }
        
        // Only use stored results if they're from today (dates haven't changed)
        if (scanData.scanDate === today) {
            // Check if results are still fresh (less than 10 minutes old)
            // This ensures newly published articles appear within 10 minutes
            const MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes
            const age = Date.now() - (scanData.timestamp || 0);
            
            if (age < MAX_AGE_MS) {
                console.log(`[Radar] Using cached results (${Math.round(age / 1000)}s old)`);
                // Note: Scores will be recalculated when generateMatchupButton is called
                return {
                    todayPosts: scanData.todayPosts || [],
                    tomorrowPosts: scanData.tomorrowPosts || []
                };
            } else {
                // Results are stale - clear them so fresh data will be fetched
                console.log(`[Radar] Cached results expired (${Math.round(age / 1000)}s old), will fetch fresh`);
                sessionStorage.removeItem('radarScanResults');
                return null;
            }
        } else {
            // Clear old results if dates don't match
            console.log('[Radar] Cached results from different date, clearing');
            sessionStorage.removeItem('radarScanResults');
            return null;
        }
    } catch (error) {
        console.error('Failed to retrieve stored radar results:', error);
        return null;
    }
}

/**
 * Show results state with matchups
 */
function showRadarResults(todayPosts, tomorrowPosts, shouldStore = true) {
    const initialState = document.querySelector('.radar-initial-state');
    const loadingState = document.querySelector('.radar-loading-state');
    const resultsState = document.querySelector('.radar-results-state');
    const descriptionState = document.querySelector('.radar-description-state');
    const loadingDescription = document.querySelector('.radar-loading-description');
    const resultsDescription = document.querySelector('.radar-results-description');
    const leftDate = document.getElementById('radar-left-date');
    const rightDate = document.getElementById('radar-right-date');
    const leftGames = document.getElementById('radar-left-games');
    const rightGames = document.getElementById('radar-right-games');
    
    // Hide initial and loading states
    if (initialState) initialState.style.display = 'none';
    if (descriptionState) descriptionState.style.display = 'none';
    if (loadingState) loadingState.style.display = 'none';
    if (loadingDescription) loadingDescription.style.display = 'none';
    
    // Show results state
    if (resultsState) resultsState.style.display = 'flex';
    if (resultsDescription) resultsDescription.style.display = 'flex';
    
    const today = getTodayDate();
    const tomorrow = getTomorrowDate();
    
    if (leftDate) leftDate.textContent = formatDateDisplay(today).toUpperCase();
    if (rightDate) rightDate.textContent = formatDateDisplay(tomorrow).toUpperCase();
    
    // Sort posts by heat score (hottest to coolest)
    const sortByHeatScore = (posts) => {
        return [...posts].sort((a, b) => {
            const scoreA = calculateHeatScoreFromMatchupData(a).total || 0;
            const scoreB = calculateHeatScoreFromMatchupData(b).total || 0;
            return scoreB - scoreA; // Descending order (hottest first)
        });
    };
    
    const sortedTodayPosts = sortByHeatScore(todayPosts);
    const sortedTomorrowPosts = sortByHeatScore(tomorrowPosts);
    
    if (leftGames) {
        if (sortedTodayPosts.length > 0) {
            leftGames.innerHTML = sortedTodayPosts.map(post => generateMatchupButton(post)).join('');
        } else {
            leftGames.innerHTML = '<div class="no-games-message">NO GAMES TODAY</div>';
        }
    }
    
    if (rightGames) {
        if (sortedTomorrowPosts.length > 0) {
            rightGames.innerHTML = sortedTomorrowPosts.map(post => generateMatchupButton(post)).join('');
        } else {
            rightGames.innerHTML = '<div class="no-games-message">NO GAMES TOMORROW</div>';
        }
    }
    
    // Store sorted results for persistence across page navigations
    if (shouldStore) {
        storeRadarResults(sortedTodayPosts, sortedTomorrowPosts);
    }
}

/**
 * Reset radar modal to initial state
 */
function resetRadarModal() {
    const initialState = document.querySelector('.radar-initial-state');
    const loadingState = document.querySelector('.radar-loading-state');
    const resultsState = document.querySelector('.radar-results-state');
    const descriptionState = document.querySelector('.radar-description-state');
    const loadingDescription = document.querySelector('.radar-loading-description');
    const resultsDescription = document.querySelector('.radar-results-description');
    
    if (initialState) initialState.style.display = 'flex';
    if (descriptionState) descriptionState.style.display = 'flex';
    if (loadingState) loadingState.style.display = 'none';
    if (resultsState) resultsState.style.display = 'none';
    if (loadingDescription) loadingDescription.style.display = 'none';
    if (resultsDescription) resultsDescription.style.display = 'none';
}

/**
 * Initialize Heat Scan radar modal
 */
function initRadarModal() {
    const toggleBtn = document.querySelector('.heat-radar-toggle');
    const closeBtn = document.querySelector('.radar-close-btn');
    const modal = document.querySelector('.radar-modal');
    const label = document.querySelector('.heat-radar-label');
    const scanButton = document.querySelector('.scan-games-button');
    
    if (!toggleBtn || !modal) return;
    
    let loadingInterval = null;
    
    const openModal = (e) => {
        // Prevent any default behavior or event propagation issues
        if (e) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
        }
        
        // Check if modal is already open - toggle it closed
        if (!modal.classList.contains('hidden')) {
            closeModal();
            return;
        }
        
        // Check if we have stored results first
        const storedResults = getStoredRadarResults();
        
        if (storedResults && (storedResults.todayPosts.length > 0 || storedResults.tomorrowPosts.length > 0)) {
            // Show stored results immediately
            showRadarResults(storedResults.todayPosts, storedResults.tomorrowPosts, false);
        } else {
            // Reset to initial state if no stored results
            resetRadarModal();
        }
        
        modal.classList.remove('hidden');
        updateToggleButtonText();
    };
    
    // Update button text based on modal state
    const updateToggleButtonText = () => {
        if (toggleBtn) {
            if (modal.classList.contains('hidden')) {
                toggleBtn.textContent = 'OPEN';
            } else {
                toggleBtn.textContent = 'CLOSE';
            }
        }
    };
    
    const closeModal = () => {
        modal.classList.add('hidden');
        if (loadingInterval) {
            clearInterval(loadingInterval);
            loadingInterval = null;
        }
        // Reset when closing
        resetRadarModal();
        updateToggleButtonText();
    };
    
    const handleScanGames = async () => {
        // Show loading state
        loadingInterval = showRadarLoading();
        
        try {
            // For radar modal: Try to fetch fresh from API, but fall back to embedded/available posts
            // On static sites (Cloudflare Pages), there's no API, so use embedded posts instead
            console.log('[Radar] Attempting to fetch fresh posts from API for radar modal...');
            let posts = [];
            
            try {
                posts = await fetchPublishedPosts();
                if (posts.length > 0) {
                    window.publishedPosts = posts;
                    console.log(`[Radar] Fetched ${posts.length} published posts from API`);
                } else {
                    console.warn('[Radar] No posts returned from API, trying embedded posts...');
                    // Fall back to embedded posts or window.publishedPosts
                    posts = getEmbeddedPosts();
                    if (posts.length === 0 && window.publishedPosts) {
                        posts = window.publishedPosts;
                    }
                }
            } catch (apiError) {
                console.log('[Radar] API fetch failed (expected on static sites), using embedded posts:', apiError.message);
                // On static sites, use embedded posts or window.publishedPosts
                posts = getEmbeddedPosts();
                if (posts.length === 0 && window.publishedPosts) {
                    posts = window.publishedPosts;
                }
            }
            
            if (posts.length === 0) {
                console.warn('[Radar] No posts available (neither from API nor embedded)');
            }
            
            // Get today and tomorrow dates (in America/New_York timezone)
            const today = getTodayDate();
            const tomorrow = getTomorrowDate();
            
            // Enhanced debug logging
            const now = new Date();
            console.log('=== RADAR DATE FILTERING ===');
            console.log('Today (NY):', today);
            console.log('Tomorrow (NY):', tomorrow);
            console.log('Your timezone:', Intl.DateTimeFormat().resolvedOptions().timeZone);
            console.log('Current time (local):', now.toLocaleString());
            console.log('Current time (NY):', now.toLocaleString("en-US", { timeZone: "America/New_York" }));
            console.log('Total posts to filter:', posts.length);
            console.log('=============================');
            
            // Filter posts by today and tomorrow - also check status is 'published'
            // Exclude DFS articles and Heat Picks articles (they're not matchups)
            const todayPosts = posts.filter(post => {
                // Exclude DFS articles and Heat Picks articles - they're not matchups
                if (post.storyType === 'dfs_article' || post.storyType === 'heat_picks') {
                    return false;
                }
                
                // Only include published posts
                if (post.status !== 'published') {
                    console.log('[Radar] Filtered out non-published post:', {
                        teamA: post.teamA,
                        teamB: post.teamB,
                        status: post.status
                    });
                    return false;
                }
                
                const postDate = getPostDate(post);
                const originalDate = post.matchupScheduledDate || post.createdAt;
                const matches = postDate === today;
                
                // Enhanced debug logging for ALL posts to understand what's happening
                console.log('Radar filter check:', {
                    teamA: post.teamA,
                    teamB: post.teamB,
                    headline: post.websiteStory?.headline?.substring(0, 30),
                    matchupScheduledDate: post.matchupScheduledDate,
                    createdAt: post.createdAt,
                    status: post.status,
                    originalDate: originalDate,
                    parsedDate: postDate,
                    today: today,
                    matchesToday: postDate === today,
                    matchesTomorrow: postDate === tomorrow
                });
                
                return matches;
            });
            
            const tomorrowPosts = posts.filter(post => {
                // Exclude DFS articles and Heat Picks articles - they're not matchups
                if (post.storyType === 'dfs_article' || post.storyType === 'heat_picks') {
                    return false;
                }
                
                // Only include published posts
                if (post.status !== 'published') {
                    return false;
                }
                
                const postDate = getPostDate(post);
                return postDate === tomorrow;
            });
            
            console.log('Filtered posts:', { 
                todayCount: todayPosts.length, 
                tomorrowCount: tomorrowPosts.length,
                todayDate: today,
                tomorrowDate: tomorrow
            });
            
            // Wait a bit to show loading messages (3 seconds minimum for UX)
            setTimeout(() => {
                if (loadingInterval) {
                    clearInterval(loadingInterval);
                    loadingInterval = null;
                }
                
                // Show results and store them for persistence
                showRadarResults(todayPosts, tomorrowPosts, true);
            }, 3000);
            
        } catch (error) {
            console.error('Failed to scan games:', error);
            if (loadingInterval) {
                clearInterval(loadingInterval);
                loadingInterval = null;
            }
            
            // Show error state
            const loadingState = document.querySelector('.radar-loading-state');
            const loadingMessage = document.getElementById('radar-loading-message');
            if (loadingState && loadingMessage) {
                loadingMessage.textContent = 'SCAN FAILED';
                loadingMessage.style.color = '#ff0040';
            }
        }
    };
    
    if (toggleBtn) {
        toggleBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            openModal(e);
        }, true); // Use capture phase to ensure it runs before other handlers
    }
    
    if (label) {
        label.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            openModal(e);
        }, true); // Use capture phase to ensure it runs before other handlers
    }
    
    if (closeBtn) {
        closeBtn.addEventListener('click', closeModal);
    }
    
    if (scanButton) {
        scanButton.addEventListener('click', handleScanGames);
    }
    
    // Close on outside click (but not on modal content)
    modal.addEventListener('click', (e) => {
        // Only close if clicking directly on modal background, not on content
        if (e.target === modal) {
            closeModal();
        }
    });
    
    // Prevent clicks inside modal from closing it
    const modalContent = modal.querySelector('.radar-modal-content');
    if (modalContent) {
        modalContent.addEventListener('click', (e) => {
            e.stopPropagation();
        });
    }
    
    // Check for stored results on initialization and restore them if available
    const storedResults = getStoredRadarResults();
    if (storedResults && (storedResults.todayPosts.length > 0 || storedResults.tomorrowPosts.length > 0)) {
        // Modal is open by default, so show stored results immediately
        showRadarResults(storedResults.todayPosts, storedResults.tomorrowPosts, false);
    }
    
    // Update button text to reflect initial state (modal is open by default)
    updateToggleButtonText();
}

/**
 * Initialize Mobile HeatScan Radar Modal
 */
function initMobileRadarModal() {
    const mobileButton = document.getElementById('mobile-heatscan-button');
    const mobileModal = document.getElementById('mobile-radar-modal');
    const mobileCloseBtn = document.getElementById('mobile-radar-close-btn');
    const mobileOverlay = document.getElementById('mobile-radar-overlay');
    const mobileScanButton = document.getElementById('mobile-scan-games-button');
    
    if (!mobileButton || !mobileModal) return;
    
    let loadingInterval = null;
    
    const openMobileModal = (e) => {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }
        
        // Check if modal is already open
        if (mobileModal.classList.contains('active')) {
            closeMobileModal();
            return;
        }
        
        // Open modal and immediately start scanning (skip initial state)
        mobileModal.classList.add('active');
        document.body.style.overflow = 'hidden'; // Prevent body scroll
        
        // Immediately start the scan process (skip initial state)
        handleMobileScanGames();
    };
    
    const closeMobileModal = () => {
        mobileModal.classList.remove('active');
        document.body.style.overflow = ''; // Restore body scroll
        if (loadingInterval) {
            clearInterval(loadingInterval);
            loadingInterval = null;
        }
        resetMobileRadarModal();
    };
    
    const handleMobileScanGames = async () => {
        // Show loading state
        loadingInterval = showMobileRadarLoading();
        
        try {
            let posts = [];
            
            try {
                posts = await fetchPublishedPosts();
                if (posts.length > 0) {
                    window.publishedPosts = posts;
                    console.log(`[Mobile Radar] Fetched ${posts.length} published posts from API`);
                } else {
                    posts = getEmbeddedPosts();
                    if (posts.length === 0 && window.publishedPosts) {
                        posts = window.publishedPosts;
                    }
                }
            } catch (apiError) {
                console.log('[Mobile Radar] API fetch failed, using embedded posts:', apiError.message);
                posts = getEmbeddedPosts();
                if (posts.length === 0 && window.publishedPosts) {
                    posts = window.publishedPosts;
                }
            }
            
            if (posts.length === 0) {
                console.warn('[Mobile Radar] No posts available');
            }
            
            // Get today's date (in America/New_York timezone)
            const today = getTodayDate();
            
            // Filter posts by today only - exclude DFS articles, Heat Picks articles and only published posts
            const todayPosts = posts.filter(post => {
                if (post.storyType === 'dfs_article' || post.storyType === 'heat_picks') {
                    return false;
                }
                
                if (post.status !== 'published') {
                    return false;
                }
                
                const postDate = getPostDate(post);
                return postDate === today;
            });
            
            console.log('[Mobile Radar] Filtered posts:', { 
                todayCount: todayPosts.length,
                todayDate: today
            });
            
            // Wait a bit to show loading messages (3 seconds minimum for UX)
            setTimeout(() => {
                if (loadingInterval) {
                    clearInterval(loadingInterval);
                    loadingInterval = null;
                }
                
                // Show results and store them (reuse desktop storage)
                showMobileRadarResults(todayPosts, true);
            }, 3000);
            
        } catch (error) {
            console.error('[Mobile Radar] Failed to scan games:', error);
            if (loadingInterval) {
                clearInterval(loadingInterval);
                loadingInterval = null;
            }
            
            const loadingMessage = document.getElementById('mobile-radar-loading-message');
            if (loadingMessage) {
                loadingMessage.textContent = 'SCAN FAILED';
                loadingMessage.style.color = '#ff0040';
            }
        }
    };
    
    if (mobileButton) {
        mobileButton.addEventListener('click', openMobileModal);
    }
    
    if (mobileCloseBtn) {
        mobileCloseBtn.addEventListener('click', closeMobileModal);
    }
    
    if (mobileOverlay) {
        mobileOverlay.addEventListener('click', closeMobileModal);
    }
    
    if (mobileScanButton) {
        mobileScanButton.addEventListener('click', handleMobileScanGames);
    }
}

/**
 * Show mobile radar results with today's matchups
 */
function showMobileRadarResults(todayPosts, shouldStore = true) {
    const initialState = document.getElementById('mobile-radar-initial-state');
    const loadingState = document.getElementById('mobile-radar-loading-state');
    const resultsState = document.getElementById('mobile-radar-results-state');
    const dateTitle = document.getElementById('mobile-radar-date-title');
    const gamesContainer = document.getElementById('mobile-radar-games');
    
    // Hide initial and loading states
    if (initialState) initialState.style.display = 'none';
    if (loadingState) loadingState.style.display = 'none';
    
    // Show results state
    if (resultsState) resultsState.style.display = 'block';
    
    const today = getTodayDate();
    
    if (dateTitle) {
        dateTitle.textContent = formatDateDisplay(today).toUpperCase();
    }
    
    // Sort posts by heat score (hottest to coolest)
    const sortByHeatScore = (posts) => {
        return [...posts].sort((a, b) => {
            const scoreA = calculateHeatScoreFromMatchupData(a).total || 0;
            const scoreB = calculateHeatScoreFromMatchupData(b).total || 0;
            return scoreB - scoreA; // Descending order (hottest first)
        });
    };
    
    const sortedTodayPosts = sortByHeatScore(todayPosts);
    
    if (gamesContainer) {
        if (sortedTodayPosts.length > 0) {
            gamesContainer.innerHTML = sortedTodayPosts.map(post => generateMatchupButton(post)).join('');
        } else {
            gamesContainer.innerHTML = '<div class="no-games-message">NO GAMES TODAY</div>';
        }
    }
    
    // Store sorted results (reuse desktop storage function)
    if (shouldStore) {
        const storedResults = getStoredRadarResults();
        const tomorrowPosts = storedResults ? storedResults.tomorrowPosts : [];
        storeRadarResults(sortedTodayPosts, tomorrowPosts);
    }
}

/**
 * Show mobile radar loading state
 */
function showMobileRadarLoading() {
    const initialState = document.getElementById('mobile-radar-initial-state');
    const loadingState = document.getElementById('mobile-radar-loading-state');
    const loadingMessage = document.getElementById('mobile-radar-loading-message');
    
    if (initialState) initialState.style.display = 'none';
    if (loadingState) loadingState.style.display = 'flex';
    
    const messages = [
        'SCANNING MATCHUPS...',
        'APPLYING HEATSCAN INTELLIGENCE...',
        'ANALYZING NARRATIVES...',
        'PROCESSING HEAT INDICATORS...',
        'FINALIZING RESULTS...'
    ];
    
    let messageIndex = 0;
    const interval = setInterval(() => {
        if (loadingMessage && messageIndex < messages.length) {
            loadingMessage.textContent = messages[messageIndex];
            messageIndex++;
        }
    }, 600);
    
    return interval;
}

/**
 * Reset mobile radar modal to initial state
 */
function resetMobileRadarModal() {
    const initialState = document.getElementById('mobile-radar-initial-state');
    const loadingState = document.getElementById('mobile-radar-loading-state');
    const resultsState = document.getElementById('mobile-radar-results-state');
    
    if (initialState) initialState.style.display = 'block';
    if (loadingState) loadingState.style.display = 'none';
    if (resultsState) resultsState.style.display = 'none';
    
    const loadingMessage = document.getElementById('mobile-radar-loading-message');
    if (loadingMessage) {
        loadingMessage.textContent = 'INITIALIZING SCAN...';
        loadingMessage.style.color = '#00ff41';
    }
}

/**
 * Initialize heat indicator hover effects
 */
function initHeatIndicatorHover() {
    // Store original image HTML for each post card
    const imageContainers = document.querySelectorAll('.post-card-image-container');
    const originalContent = new Map();
    
    imageContainers.forEach(container => {
        const postId = container.getAttribute('data-post-id');
        if (postId) {
            originalContent.set(postId, container.innerHTML);
        }
    });
    
    // Find all heat indicator containers
    const heatIndicators = document.querySelectorAll('.heat-indicator-container');
    
    heatIndicators.forEach(indicator => {
        const postId = indicator.getAttribute('data-post-id');
        if (!postId) return;
        
        const imageContainer = document.querySelector(`.post-card-image-container[data-post-id="${postId}"]`);
        if (!imageContainer) return;
        
        // Find the post data - try embedded posts first (most complete data), then fallback to window.publishedPosts
        let posts = getEmbeddedPosts();
        if (posts.length === 0) {
            posts = window.publishedPosts || publishedPosts || [];
        }
        const post = posts.find(p => p.id === postId);
        if (!post) return;
        
        // Skip hover effects for DFS articles and Heat Picks articles
        if (post.storyType === 'dfs_article' || post.storyType === 'heat_picks') {
            return;
        }
        
        // Also check for data-heat-picks attribute as fallback
        if (indicator.getAttribute('data-heat-picks') === 'true' || indicator.classList.contains('heat-picks-indicator')) {
            return;
        }
        
        // Store original content if not already stored
        if (!originalContent.has(postId)) {
            originalContent.set(postId, imageContainer.innerHTML);
        }
        
        // On mouseenter: replace image with breakdown
        indicator.addEventListener('mouseenter', () => {
            // Check if this is a V4 article with advancedHeatStats
            const heatCheckData = post.heatCheckData || {};
            const matchPackV4 = heatCheckData.matchPackV4;
            
            // More robust detection - check each level explicitly
            let isV4 = false;
            if (matchPackV4) {
                if (matchPackV4.factDrop) {
                    if (matchPackV4.factDrop.raw) {
                        if (matchPackV4.factDrop.raw.advancedHeatStats) {
                            isV4 = true;
                        }
                    }
                }
            }
            
            const breakdownHtml = isV4 
                ? generateHeatBreakdownV4(post)
                : generateHeatBreakdown(post);
            
            imageContainer.innerHTML = breakdownHtml;
        });
        
        // On mouseleave: restore original image
        indicator.addEventListener('mouseleave', () => {
            const originalHtml = originalContent.get(postId);
            if (originalHtml) {
                imageContainer.innerHTML = originalHtml;
            }
        });
    });
}

/**
 * Handle link clicks to ensure navigation works correctly
 */
function initLinkHandling() {
    // Handle all link clicks in the document using event delegation
    // This ensures dynamically added links are also handled
    document.addEventListener('click', (e) => {
        const link = e.target.closest('a');
        if (!link) return;
        
        const href = link.getAttribute('href');
        if (!href) return;
        
        // Skip javascript: and # links (these are handled separately)
        if (href.startsWith('javascript:') || href === '#' || href.startsWith('#')) {
            return;
        }
        
        // Skip if this is a league link (handled by initCrawlerNavInteractivity)
        if (link.classList.contains('league-link') && !link.closest('.nav-submenu')) {
            return; // Let the league link handler manage the toggle
        }
        
        // Skip if this is the back button (handled by initBackButton)
        if (link.classList.contains('article-back-btn')) {
            return; // Let the back button handler manage navigation
        }
        
        // Always handle relative URLs to ensure they work correctly
        if (href.startsWith('/') && !href.startsWith('//')) {
            // For article links (HTML files), allow normal navigation
            // This works on the static site where HTML files exist
            if (href.endsWith('.html')) {
                // Don't prevent default - let browser navigate normally
                // This ensures the link works correctly to the static HTML file
                return;
            }
            
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            
            // Push current page to history before navigating
            if (window.history && window.history.pushState) {
                window.history.pushState({ url: window.location.href }, '', window.location.href);
            }
            
            // Navigate within current window
            window.location.href = href;
            return;
        }
        
        // For absolute URLs on same origin, navigate within current window
        if (href.startsWith('http://') || href.startsWith('https://')) {
            try {
                const url = new URL(href);
                if (url.origin === window.location.origin) {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    window.location.href = href;
                    return;
                }
            } catch (err) {
                // Invalid URL, allow default navigation
                console.error('Invalid URL:', href, err);
            }
        }
    }, true); // Use capture phase to catch links early, before they bubble
}

/**
 * Determine back navigation URL based on referrer
 */
function getBackUrl() {
    const referrer = document.referrer;
    
    // If no referrer or referrer is external, go to homepage
    if (!referrer || !referrer.includes(window.location.origin)) {
        return '/';
    }
    
    try {
        const referrerUrl = new URL(referrer);
        const referrerPath = referrerUrl.pathname;
        
        // If referrer is the current page, go to homepage
        if (referrerPath === window.location.pathname) {
            return '/';
        }
        
        // Parse referrer to determine destination
        // Archive pages: /archive/ or /archive/page/X/
        if (referrerPath.startsWith('/archive')) {
            // Extract the archive path, preserving page number if present
            if (referrerPath === '/archive' || referrerPath === '/archive/') {
                return '/archive/';
            }
            // Check if it's a paginated archive page
            const archivePageMatch = referrerPath.match(/^\/archive\/page\/(\d+)\/?$/);
            if (archivePageMatch) {
                return referrerPath.endsWith('/') ? referrerPath : referrerPath + '/';
            }
            return '/archive/';
        }
        
        // League hub pages: /nba/, /nfl/, etc.
        // Pattern: /{league}/ (but not /{league}/{date}/)
        const hubMatch = referrerPath.match(/^\/([^\/]+)\/?$/);
        if (hubMatch) {
            const league = hubMatch[1];
            // Exclude common paths that aren't league hubs
            if (league !== 'archive' && league !== 'about' && !league.match(/^\d{4}-\d{2}-\d{2}$/)) {
                return referrerPath.endsWith('/') ? referrerPath : referrerPath + '/';
            }
        }
        
        // Date pages: /nba/2024-01-15/, /nfl/2024-01-15/, etc.
        // Pattern: /{league}/{date}/
        const dateMatch = referrerPath.match(/^\/([^\/]+)\/(\d{4}-\d{2}-\d{2})\/?$/);
        if (dateMatch) {
            return referrerPath.endsWith('/') ? referrerPath : referrerPath + '/';
        }
        
        // Homepage or other index pages
        if (referrerPath === '/' || referrerPath === '/index.html') {
            return '/';
        }
        
        // If referrer looks like an index page but we can't parse it, try to use it directly
        // (but remove .html extension if present for cleaner URLs)
        if (referrerPath && !referrerPath.includes('.html') && referrerPath !== '/') {
            return referrerPath.endsWith('/') ? referrerPath : referrerPath + '/';
        }
        
        // Default to homepage
        return '/';
    } catch (error) {
        console.error('Error parsing referrer:', error);
        return '/';
    }
}

/**
 * Initialize back button handling
 */
function initBackButton() {
    // Store referrer on page load for back navigation
    const referrer = document.referrer;
    
    // Handle browser back button (popstate event)
    window.addEventListener('popstate', (e) => {
        // When back button is pressed, navigate to the previous URL
        if (e.state && e.state.url) {
            window.location.href = e.state.url;
        } else if (referrer && referrer !== window.location.href) {
            // Use referrer if available
            const backUrl = getBackUrl();
            window.location.href = backUrl;
        } else {
            // Default: go to homepage
            window.location.href = '/';
        }
    });
    
    // Handle BACK button clicks on article pages
    // Use event delegation in capture phase to ensure it runs before initLinkHandling
    document.addEventListener('click', (e) => {
        const backBtn = e.target.closest('.article-back-btn');
        if (!backBtn) return;
        
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        
        // Determine where to go back based on referrer
        const backUrl = getBackUrl();
        window.location.href = backUrl;
    }, true); // Use capture phase to run before other handlers
    
    // Push current page to history on load (so back button works)
    if (window.history && window.history.pushState) {
        // Only push if we're not already at the root
        if (window.location.pathname !== '/') {
            window.history.pushState({ url: window.location.href }, '', window.location.href);
        }
    }
}

/**
 * Get posts data embedded in the page
 * Posts are embedded as JSON in a script tag with id="posts-data"
 */
function getEmbeddedPosts() {
    let postsDataScript = document.getElementById('posts-data');
    
    // If not found, wait a bit and retry (handles timing issues with large JSON)
    if (!postsDataScript) {
        // Check if we're in a synchronous context - if so, the script might not be parsed yet
        // This can happen if the JSON script tag is very large
        console.warn('[Embedded Posts] Script tag not found on first attempt, checking DOM...');
        
        // Use querySelector as an alternative
        postsDataScript = document.querySelector('script#posts-data');
        
        if (!postsDataScript) {
            console.warn('[Embedded Posts] Script tag with id="posts-data" not found in DOM');
            // Log all script tags for debugging
            const allScripts = document.querySelectorAll('script');
            console.warn('[Embedded Posts] Total script tags found:', allScripts.length);
            allScripts.forEach((script, index) => {
                if (script.id) {
                    console.warn(`[Embedded Posts] Script tag ${index}: id="${script.id}"`);
                } else if (script.type === 'application/json') {
                    console.warn(`[Embedded Posts] Script tag ${index}: type="application/json" (no id)`);
                }
            });
            return [];
        }
    }
    
    try {
        // Get text content and trim whitespace
        const jsonText = postsDataScript.textContent.trim();
        
        // Debug logging
        if (jsonText.length === 0) {
            console.warn('[Embedded Posts] Script tag found but content is empty');
            return [];
        }
        
        const posts = JSON.parse(jsonText);
        console.log(`[Embedded Posts] Successfully parsed ${posts.length} posts from embedded data`);
        return posts;
    } catch (e) {
        console.error('[Embedded Posts] Failed to parse embedded posts data:', e);
        console.error('[Embedded Posts] Script tag content length:', postsDataScript.textContent?.length || 0);
        // Log first 200 chars of content for debugging
        const preview = postsDataScript.textContent?.substring(0, 200) || 'N/A';
        console.error('[Embedded Posts] Content preview:', preview);
        return [];
    }
}

/**
 * Update heat scores on static pages to match dynamic calculation
 * This ensures all pages show the same scores regardless of when they were generated
 */
function updateStaticPageHeatScores() {
    // Get posts data embedded in the page
    const posts = getEmbeddedPosts();
    if (posts.length === 0) {
        return; // No posts on this page, skip
    }
    
    // Find all heat indicator containers on the page
    const heatIndicators = document.querySelectorAll('.heat-indicator-container');
    
    heatIndicators.forEach(indicator => {
        const postId = indicator.getAttribute('data-post-id');
        if (!postId) return;
        
        // Find post data from embedded posts
        const post = posts.find(p => p.id === postId);
        if (!post) {
            console.warn(`[Heat Score Update] Post not found for ID: ${postId}`);
            return;
        }
        
        // Calculate the correct score using JavaScript
        const correctScore = calculateHeatScore(post);
        
        // Debug: Log calculation details for troubleshooting
        const hasMatchPackV3 = !!(post.heatCheckData && post.heatCheckData.matchPackV3);
        const hasFactPack = !!(post.heatCheckData && (post.heatCheckData.fact_pack || post.heatCheckData.factPack));
        if (!hasMatchPackV3 && hasFactPack) {
            console.log(`[Heat Score Update] Post ${postId} (${post.teamA} vs ${post.teamB}): Using fallback calculation (no matchPackV3), score: ${correctScore}`);
        }
        
        // Find the score display element (the number inside the heat indicator)
        // The score is in a div that is a direct child of .heat-indicator-container
        // It's the div with z-index: 1, position: relative, and contains the score number
        const children = Array.from(indicator.children);
        for (const child of children) {
            const style = child.getAttribute('style') || '';
            const textContent = (child.textContent || '').trim();
            
            // Check if this is the score div - it has z-index: 1, position: relative, red color, 
            // and contains only a number (the score)
            const hasZIndex = style.includes('z-index') && (style.includes('z-index: 1') || style.includes('z-index:1'));
            const hasPosition = style.includes('position') && style.includes('relative');
            const hasRedColor =
                style.includes('#ff0040') || style.includes('color: #ff0040') || style.includes('color:#ff0040') ||
                style.includes('#ff0033') || style.includes('color: #ff0033') || style.includes('color:#ff0033') ||
                style.includes('#ff1a1a') || style.includes('color: #ff1a1a') || style.includes('color:#ff1a1a');
            const isNumber = /^\d+$/.test(textContent);
            
            if (hasZIndex && hasPosition && hasRedColor && isNumber) {
                // Found the score element - update it
                const currentScore = parseInt(textContent, 10);
                if (!isNaN(currentScore) && currentScore !== correctScore) {
                    child.textContent = correctScore;
                }
                break;
            }
        }
    });
}

/**
 * Initialize heat indicator hover for static HTML post cards
 * Works by reading post data embedded in the page as JSON
 */
function initHeatIndicatorHoverStatic() {
    // Get posts data embedded in the page
    let posts = getEmbeddedPosts();
    
    // If not found, wait a bit and retry (handles timing issues with large JSON script tags)
    if (posts.length === 0) {
        const postsDataScript = document.querySelector('script#posts-data');
        if (postsDataScript) {
            // Script tag exists but might not be parsed yet, wait a bit and retry
            setTimeout(() => {
                const retryPosts = getEmbeddedPosts();
                if (retryPosts.length > 0) {
                    // Store posts globally for easy access
                    window.publishedPosts = retryPosts;
                    // Update all heat scores on the page to match dynamic calculation
                    updateStaticPageHeatScores();
                    // Continue with the rest of the initialization
                    initHeatIndicatorHoverStaticContinue(retryPosts);
                } else {
                    console.warn('[Heat Indicator] Retry failed - posts still not found after delay');
                }
            }, 100);
            return; // Exit early, will retry in setTimeout
        } else {
            // No posts on this page, skip initialization
            return;
        }
    }
    
    // Store posts globally for easy access
    window.publishedPosts = posts;
    
    // Update all heat scores on the page to match dynamic calculation
    updateStaticPageHeatScores();
    
    // Continue with initialization
    initHeatIndicatorHoverStaticContinue(posts);
}

/**
 * Continue initialization of heat indicator hover (extracted to avoid duplication)
 */
function initHeatIndicatorHoverStaticContinue(posts) {
    // Store original image HTML for each post card
    const imageContainers = document.querySelectorAll('.post-card-image-container');
    const originalContent = new Map();
    
    imageContainers.forEach(container => {
        const postId = container.getAttribute('data-post-id');
        if (postId) {
            originalContent.set(postId, container.innerHTML);
        }
    });
    
    // Find all heat indicator containers
    const heatIndicators = document.querySelectorAll('.heat-indicator-container');
    
    heatIndicators.forEach(indicator => {
        const postId = indicator.getAttribute('data-post-id');
        if (!postId) return;
        
        const imageContainer = document.querySelector(`.post-card-image-container[data-post-id="${postId}"]`);
        if (!imageContainer) return;
        
        // Find post data from embedded posts
        const post = posts.find(p => p.id === postId);
        if (!post) {
            console.warn('Post data not found for post ID:', postId);
            return;
        }
        
        // Skip hover effects for DFS articles and Heat Picks articles
        if (post.storyType === 'dfs_article' || post.storyType === 'heat_picks') {
            return;
        }
        
        // Also check for data-heat-picks attribute as fallback
        if (indicator.getAttribute('data-heat-picks') === 'true' || indicator.classList.contains('heat-picks-indicator')) {
            return;
        }
        
        if (!originalContent.has(postId)) {
            originalContent.set(postId, imageContainer.innerHTML);
        }
        
        indicator.addEventListener('mouseenter', () => {
            // Check if this is a V4 article with advancedHeatStats
            const heatCheckData = post.heatCheckData || {};
            const matchPackV4 = heatCheckData.matchPackV4;
            
            // More robust detection - check each level explicitly
            let isV4 = false;
            if (matchPackV4) {
                if (matchPackV4.factDrop) {
                    if (matchPackV4.factDrop.raw) {
                        if (matchPackV4.factDrop.raw.advancedHeatStats) {
                            isV4 = true;
                        }
                    }
                }
            }
            
            const breakdownHtml = isV4 
                ? generateHeatBreakdownV4(post)
                : generateHeatBreakdown(post);
            
            imageContainer.innerHTML = breakdownHtml;
        });
        
        indicator.addEventListener('mouseleave', () => {
            const originalHtml = originalContent.get(postId);
            if (originalHtml) {
                imageContainer.innerHTML = originalHtml;
            }
        });
    });
}

/**
 * Initialize mobile hamburger menu
 */
function initMobileMenu() {
    const menuToggle = document.getElementById('mobile-menu-toggle');
    const navDrawer = document.getElementById('mobile-nav-drawer');
    const navOverlay = document.getElementById('mobile-nav-overlay');
    const body = document.body;
    
    if (!menuToggle || !navDrawer || !navOverlay) {
        // Retry after a short delay in case DOM isn't fully ready
        if (document.readyState === 'loading') {
            setTimeout(() => {
                const retryToggle = document.getElementById('mobile-menu-toggle');
                const retryDrawer = document.getElementById('mobile-nav-drawer');
                const retryOverlay = document.getElementById('mobile-nav-overlay');
                if (retryToggle && retryDrawer && retryOverlay) {
                    initMobileMenuElements(retryToggle, retryDrawer, retryOverlay, body);
                } else {
                    console.warn('[Mobile Menu] Required elements not found after retry');
                }
            }, 100);
        } else {
            console.warn('[Mobile Menu] Required elements not found');
        }
        return;
    }
    
    initMobileMenuElements(menuToggle, navDrawer, navOverlay, body);
}

function initMobileMenuElements(menuToggle, navDrawer, navOverlay, body) {
    
    // Toggle menu function
    const toggleMenu = (e) => {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }
        
        const isOpen = navDrawer.classList.contains('active');
        
        if (isOpen) {
            closeMenu();
        } else {
            openMenu();
        }
    };
    
    // Open menu function
    const openMenu = () => {
        navDrawer.classList.add('active');
        navOverlay.classList.add('active');
        menuToggle.classList.add('active');
        body.classList.add('menu-open');
        // Navigation interactivity is already initialized on page load via initCrawlerNavInteractivity()
        // which finds all .league-link elements including those in the mobile drawer
    };
    
    // Close menu function
    const closeMenu = () => {
        navDrawer.classList.remove('active');
        navOverlay.classList.remove('active');
        menuToggle.classList.remove('active');
        body.classList.remove('menu-open');
    };
    
    // Event listeners
    menuToggle.addEventListener('click', toggleMenu);
    navOverlay.addEventListener('click', closeMenu);
    
    // Close menu when clicking navigation links in mobile drawer
    // Use event delegation to handle dynamically added links (including date links added by initCrawlerNav)
    navDrawer.addEventListener('click', (e) => {
        const link = e.target.closest('a');
        if (!link) return;
        
        // Don't close for league links (they toggle submenus)
        if (link.classList.contains('league-link')) {
            return;
        }
        
        // Close menu for all other navigation links (including submenu items and regular links)
        // Use a small delay to allow navigation to proceed
        setTimeout(() => {
            closeMenu();
        }, 150);
    });
    
    // Close menu on escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && navDrawer.classList.contains('active')) {
            closeMenu();
        }
    });
    
    // Ensure menu closes on window resize if it exceeds mobile breakpoint
    let resizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            if (window.innerWidth > 768 && navDrawer.classList.contains('active')) {
                closeMenu();
            }
        }, 250);
    });
}

/**
 * Initialize everything when DOM is ready
 */
async function init() {
    try {
        // Initialize link handling FIRST (before other handlers that might stop propagation)
        initLinkHandling();
        
        // Initialize back button handling (works on all pages including articles)
        initBackButton();
        
        // Initialize mobile menu (before other nav handlers)
        initMobileMenu();
        
        // Initialize crawler nav interactivity on ALL pages (makes existing nav interactive)
        // This comes after initLinkHandling but handles league link toggles specially
        initCrawlerNavInteractivity();
        
        // Initialize heat indicator hover on ALL pages (for static HTML post cards)
        // This works for hub pages, date pages, and archive pages
        initHeatIndicatorHoverStatic();
        
        // Fetch posts (only if we're on a page that needs them - homepage/preview/index.html)
        const postList = document.getElementById('recent-logs-list');
        if (postList) {
            // For static sites: Use embedded posts first (generated during build)
            // These are embedded in a <script id="posts-data"> tag by the static site generator
            let posts = getEmbeddedPosts();
            
            // Only try to fetch from API if no embedded posts found (for development/preview scenarios)
            if (posts.length === 0) {
                console.log('[Homepage] No embedded posts found, trying to fetch from API...');
                try {
                    posts = await fetchPublishedPosts();
                } catch (error) {
                    console.warn('[Homepage] Failed to fetch from API (expected on static sites):', error.message);
                    posts = [];
                }
            } else {
                console.log(`[Homepage] Using ${posts.length} embedded posts from static site generation`);
            }
            
            // Sort posts by date (latest first) - Priority: matchupScheduledDate > updatedAt > createdAt
            // This ensures articles about upcoming/recent games appear first
            posts.sort((a, b) => {
                const getSortDate = (post) => {
                    if (post.matchupScheduledDate) {
                        return new Date(post.matchupScheduledDate).getTime();
                    }
                    if (post.updatedAt) {
                        return new Date(post.updatedAt).getTime();
                    }
                    if (post.createdAt) {
                        return new Date(post.createdAt).getTime();
                    }
                    return 0;
                };
                
                const dateA = getSortDate(a);
                const dateB = getSortDate(b);
                return dateB - dateA; // Descending order (latest first)
            });
            
            // Store posts globally so static pages can access them
            window.publishedPosts = posts;
            
            // Render posts
            renderPosts(posts, currentPage);
            
            // Initialize navigation with dates from posts (homepage only)
            initCrawlerNav(posts);
            
            // Initialize heat indicator hover effects for dynamically rendered posts (homepage)
            initHeatIndicatorHover();
        }
        
        // Initialize radar modal (this will also check for stored results)
        initRadarModal();
        
        // Initialize mobile radar modal
        initMobileRadarModal();
        
    } catch (error) {
        console.error('Initialization error:', error);
        const postList = document.getElementById('recent-logs-list');
        if (postList) {
            postList.innerHTML = '<p style="color: rgba(255, 0, 0, 0.7); font-size: 1rem; font-weight: 900; text-align: center; padding: 2rem;">Error loading posts. Please refresh the page.</p>';
        }
    }
}

/**
 * Initialize 3D reel navigation with position tracking
 */
// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

