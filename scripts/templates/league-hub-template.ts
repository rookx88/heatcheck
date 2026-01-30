import { generateBaseHtml, BaseTemplateOptions } from './base-template';
import { escapeHtml } from '../utils/html-escape';
import { formatDateForCard, formatDateISO, normalizeLeague, getShortTeamName, getTeamAcronym } from '../utils/date-formatter';
import { generateSlug, generateNarrativeSlug, generateMatchupSlug } from '../utils/slug-generator';

export interface HeatcheckPost {
    id: string;
    league: string;
    teamA: string;
    teamB: string;
    matchupScheduledDate?: string;
    createdAt: string;
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

/**
 * Unified Heat Score Calculation (0-100)
 * Combines Heat Picks signals (momentum, availability, close games, comparisons) 
 * + Narrative strength + Evidence quality
 * Matches the Heat Picks scoring system for consistency
 */
function calculateHeatScoreFromMatchupData(post: HeatcheckPost): { total: number; breakdown: { stakes: number; recency: number; payback: number; history: number; emotion: number } } {
    // Special handling for DFS articles
    if (post.storyType === 'dfs_article') {
        const heatCheckData = post.heatCheckData as any;
        const dfsPlayers = heatCheckData?.dfsPlayers || [];
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
            const avgConfidence = dfsPlayers.reduce((sum: number, p: any) => sum + (p.confidenceScore || 0), 0) / playerCount;
            if (avgConfidence >= 80) emotionScore = 18;
            else if (avgConfidence >= 70) emotionScore = 15;
            else if (avgConfidence >= 60) emotionScore = 12;
            else if (avgConfidence >= 50) emotionScore = 8;
            else emotionScore = 5;
        }
        
        // HISTORY (0-20 points) - Variety of narrative types
        const narrativeTypes = new Set(dfsPlayers.map((p: any) => p.narrativeType || '').filter(Boolean));
        let historyScore = 0;
        if (narrativeTypes.size >= 5) historyScore = 18;
        else if (narrativeTypes.size >= 4) historyScore = 15;
        else if (narrativeTypes.size >= 3) historyScore = 12;
        else if (narrativeTypes.size >= 2) historyScore = 8;
        else historyScore = 5;
        
        // PAYBACK (0-20 points) - Count of revenge/motivation narratives
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
    
    // Temperature-based scoring: 40 = baseline, 70 = warm, 90 = hot, 100 = scorching
    let baseScore = 0;
    let momentumScore = 0;
    let availabilityScore = 0;
    let closeGamesScore = 0;
    let comparisonsScore = 0;
    
    // If matchPackV3 exists, use Heat Picks signals (preferred method)
    if (matchPackV3?.factDrop) {
        const factDrop = matchPackV3.factDrop;
        const teamForm = factDrop.raw?.teamForm || {};
        const comparisons = factDrop.comparisons || [];
        const availability = factDrop.raw?.availability;
        
        // 1. MOMENTUM (0-25 points, increased for temperature model)
        const aMargin10 = teamForm.A?.margin10 || teamForm.A?.xgDiff10 || 0;
        const aMargin3 = teamForm.A?.margin3 || teamForm.A?.xgDiff3 || 0;
        const bMargin10 = teamForm.B?.margin10 || teamForm.B?.xgDiff10 || 0;
        const bMargin3 = teamForm.B?.margin3 || teamForm.B?.xgDiff3 || 0;
        const momentumDivergence = Math.abs((aMargin3 - aMargin10) - (bMargin3 - bMargin10));
        momentumScore = Math.min(25, momentumDivergence * 2.5); // Increased multiplier
        
        // 2. AVAILABILITY (0-20 points, increased for temperature model)
        const aAbsences = availability?.majorAbsences?.A?.count || 0;
        const bAbsences = availability?.majorAbsences?.B?.count || 0;
        const availabilityDiff = Math.abs(aAbsences - bAbsences);
        availabilityScore = Math.min(20, availabilityDiff * 4); // Increased multiplier
        
        // 3. CLOSE GAMES (0-20 points, increased for temperature model)
        const closeMarginComp = comparisons.find((c: any) => c?.key === 'closeMargin');
        if (closeMarginComp) {
            const aCloseW = teamForm.A?.closeW10 || 0;
            const aCloseL = teamForm.A?.closeL10 || 0;
            const bCloseW = teamForm.B?.closeW10 || 0;
            const bCloseL = teamForm.B?.closeL10 || 0;
            const aCloseRate = aCloseW + aCloseL > 0 ? aCloseW / (aCloseW + aCloseL) : 0;
            const bCloseRate = bCloseW + bCloseL > 0 ? bCloseW / (bCloseW + bCloseL) : 0;
            const closeGameDiff = Math.abs(aCloseRate - bCloseRate);
            closeGamesScore = Math.min(20, closeGameDiff * 40); // Increased multiplier
        }
        
        // 4. COMPARISONS (0-15 points, increased for temperature model)
        let comparisonsTotal = 0;
        comparisons.forEach((comp: any) => {
            if (comp?.key && comp?.key !== 'closeMargin') {
                const aVal = comp?.A || 0;
                const bVal = comp?.B || 0;
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
        const spreadMarket = markets.find((m: any) => m.market === 'Spread');
        
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
    if (narratives?.candidate_cards && narratives.candidate_cards.length > 0) {
        // Primary narrative score (0-20 points, increased from 15)
        const primaryNarrativeId = narratives.selected?.primary_narrative_id;
        const primaryCard = narratives.candidate_cards.find(
            (c: any) => c.narrative_id === primaryNarrativeId
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
        const secondaryIds = narratives.selected?.secondary_narrative_ids || [];
        if (secondaryIds.length >= 2) narrativeScore += 8;
        else if (secondaryIds.length === 1) narrativeScore += 4;
        
        // Emotion tags diversity (0-7 points, increased from 5)
        const allEmotionTags = narratives.candidate_cards
            .flatMap((c: any) => c.emotion_tags || []);
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
function calculateHeatScore(post: HeatcheckPost): number {
    return calculateHeatScoreFromMatchupData(post).total;
}

function getLeagueAbbreviation(league: string): string {
    const upper = (league || '').toUpperCase();
    if (upper === 'BUNDESLIGA') return 'GER';
    if (upper === 'LIGUE 1') return 'FRA';
    if (upper === 'SERIE A') return 'ITA';
    if (upper === 'LA LIGA') return 'ESP';
    if (upper === 'EPL' || upper === 'PREMIER LEAGUE') return 'EPL';
    return league ? league.toUpperCase().substring(0, 3) : 'N/A';
}

/**
 * Generate post card HTML (same as archive)
 */
export function generatePostCard(post: HeatcheckPost, baseUrl: string): string {
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
            const dateForDayOfWeek = new Date(articleDate + (articleDate.includes('T') ? '' : 'T12:00:00'));
            const dayOfWeek = dateForDayOfWeek.toLocaleDateString('en-US', { weekday: 'long' });
            // Ensure league is in correct format (NBA, NFL, etc. not "Basketball")
            const normalizedLeague = league.toUpperCase();
            headline = `${dayOfWeek} ${normalizedLeague} DFS`;
        } catch {
            // Keep original headline if date parsing fails
        }
    }
    const imageName = post.websiteStory?.image || post.websiteStory?.imageUrl || '';
    const imagePath = imageName 
        ? (imageName.startsWith('http') 
            ? imageName 
            : imageName.startsWith('/')
            ? (imageName.includes('/assets/images/')
                ? (() => {
                    // Extract filename from full path like "/assets/images/filename.png"
                    const parts = imageName.split('/assets/images/');
                    const filename = parts.length > 1 ? parts[parts.length - 1] : imageName.split('/').pop();
                    return `/assets/images/${filename}`;
                })()
                : imageName)
            : imageName.includes('/assets/images/')
            ? (() => {
                // Extract filename from full path (might not start with /)
                const parts = imageName.split('/assets/images/');
                const filename = parts.length > 1 ? parts[parts.length - 1] : imageName.split('/').pop();
                return `/assets/images/${filename}`;
            })()
            : `/assets/images/${imageName}`)
        : '';
    const leagueLower = normalizeLeague(post.league);
    const date = post.matchupScheduledDate 
        ? formatDateISO(post.matchupScheduledDate)
        : formatDateISO(post.createdAt);
    
    // Generate new URL structure: /{league}/{date}/{matchup}/{narrative-slug}/
    const matchupSlug = generateMatchupSlug(post.teamA || '', post.teamB || '', getShortTeamName);
    
    // Get narrative keywords from heatCheckData
    const heatCheckData = post.heatCheckData || {};
    const narratives = heatCheckData.narratives || {};
    const candidateCards = narratives.candidate_cards || [];
    const primaryNarrativeId = narratives.selected?.primary_narrative_id || '';
    const activeCard = candidateCards.find(card => card.narrative_id === primaryNarrativeId);
    const emotionTags = activeCard?.emotion_tags || [];
    
    // Generate narrative-based slug
    const narrativeSlug = generateNarrativeSlug(
        headline,
        post.teamA || '',
        post.teamB || '',
        emotionTags
    );
    
    // Check if stored slug is in new format (matchup/narrative) and use it if available
    const storedSlug = post.websiteStory?.seo?.slug || '';
    let finalNarrativeSlug = narrativeSlug;
    if (storedSlug.includes('/') && storedSlug.split('/').length === 2) {
        const [storedMatchup, storedNarrative] = storedSlug.split('/');
        if (storedMatchup === matchupSlug) {
            finalNarrativeSlug = storedNarrative;
        }
    }
    
    // For DFS articles, generate matchup text with day of week + "DFS Football"
    // For Heat Picks articles, use "Heat Picks" label
    let displayMatchup = matchup;
    let displayMatchupMobile = `${getTeamAcronym(post.teamA || '', post.league)} VS ${getTeamAcronym(post.teamB || '', post.league)}`.toUpperCase();
    if (isDFSArticle) {
        const articleDate = post.matchupScheduledDate || post.createdAt;
        try {
            const dateForDayOfWeek = new Date(articleDate + (articleDate.includes('T') ? '' : 'T12:00:00'));
            const dayOfWeek = dateForDayOfWeek.toLocaleDateString('en-US', { weekday: 'long' });
            const sportLabel = league === 'NBA' ? 'Basketball' : league === 'NFL' ? 'Football' : league;
            displayMatchup = `${dayOfWeek} DFS ${sportLabel}`.toUpperCase();
            displayMatchupMobile = displayMatchup; // DFS articles don't need mobile variant
        } catch {
            displayMatchup = 'DFS VALUE';
            displayMatchupMobile = displayMatchup;
        }
    } else if (isHeatPicksArticle) {
        displayMatchup = 'HEAT PICKS';
        displayMatchupMobile = displayMatchup;
    }
    
    // URL structure differs for DFS articles, Heat Picks articles, and prediction format
    let articleUrl: string;
    if (isDFSArticle) {
        articleUrl = `/dfs/${leagueLower}/${date}/dfs-value-narratives-${date}/`;
    } else if (isHeatPicksArticle) {
        // Use stored slug or generate from date
        const storedSlug = post.websiteStory?.seo?.slug || '';
        if (storedSlug) {
            articleUrl = `/${leagueLower}/${storedSlug}/`;
        } else {
            // Fallback: generate from date
            const dateParts = date.split('-');
            const slugDate = `${dateParts[1]}-${dateParts[2]}-${dateParts[0]}`;
            articleUrl = `/${leagueLower}/heat-picks-today-${slugDate}/`;
        }
    } else {
        // Check if SEO slug is in prediction format (new SEO-optimized format)
        const storedSlug = post.websiteStory?.seo?.slug || '';
        const isPredictionFormat = storedSlug.includes('-prediction-preview-') && storedSlug.match(/\d{4}-\d{2}-\d{2}$/);
        
        if (isPredictionFormat) {
            // Use prediction format: /{league}/{prediction-slug}/
            articleUrl = `/${leagueLower}/${storedSlug}/`;
        } else {
            // Fallback to old format: /{league}/{date}/{matchup}/{narrative-slug}/
            articleUrl = `/${leagueLower}/${date}/${matchupSlug}/${finalNarrativeSlug}/`;
        }
    }
    const isHeatHigh = heatScore >= 71; // ~71 on 100 scale = ~25 on 35 scale
    
    // For DFS articles, use special quote text
    let displayQuote = '';
    let quoteSpeaker = '';
    let quoteTeam = '';
    
    if (isDFSArticle) {
        displayQuote = "Take a deeper look at narratives on key value players for today's slate";
    } else {
        // Extract quote from evidence bundle for regular articles
        const evidenceBundle = heatCheckData.evidence_bundle || heatCheckData.evidenceBundle || {};
        const quotes = evidenceBundle.quotes || [];
        const selectedQuote = quotes.length > 0 ? quotes[0] : null; // Use first quote
        let quoteText = selectedQuote?.quote || '';
        quoteSpeaker = selectedQuote?.speaker || '';
        quoteTeam = selectedQuote?.team || '';
        
        // Fallback to matchup preview quote if no quotes found
        if (!quoteText) {
            const articleDate = post.matchupScheduledDate || post.createdAt;
            const today = formatDateISO(new Date().toISOString());
            const articleDateOnly = articleDate ? formatDateISO(articleDate) : '';
            const isToday = articleDateOnly === today;
            quoteText = `${post.teamA || ''} and ${post.teamB || ''} meet ${isToday ? 'tonight' : 'in a seasonal matchup'} in ${(post.league || '').toUpperCase()}.`;
            quoteSpeaker = 'Matchup Preview';
            quoteTeam = '';
        }
        
        // Truncate quote if too long (max ~120 chars for card display)
        const maxQuoteLength = 120;
        displayQuote = quoteText.length > maxQuoteLength 
            ? quoteText.substring(0, maxQuoteLength).trim() + '...'
            : quoteText;
    }
    
    // Build quote HTML if available
    const quoteHtml = displayQuote ? `
        <div style="margin: 0 0 1rem 0; padding: 0.75rem; background: rgba(0, 0, 0, 0.4); border-left: 3px solid rgba(248, 66, 66, 0.6); border-radius: 2px; font-family: 'Courier New', monospace;">
            <p style="font-size: 0.7rem; line-height: 1.4; color: rgba(255, 255, 255, 0.85); font-style: italic; margin: 0; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; text-overflow: ellipsis;">
                "${escapeHtml(displayQuote)}"
            </p>
            ${!isDFSArticle && quoteSpeaker ? `<div style="font-size: 0.65rem; color: rgba(255, 255, 255, 0.6); margin: 0.4rem 0 0 0; text-align: right;">— ${escapeHtml(quoteSpeaker)}${quoteTeam ? ` (${escapeHtml(quoteTeam)})` : ''}</div>` : ''}
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
                        ${imagePath ? `<img src="${imagePath}" alt="${escapeHtml(`${teamAShort} vs ${teamBShort} ${league} ${finalNarrativeSlug} narrative - ${headline} - HeatChecks Analysis`)}" style="width: 100%; height: 100%; object-fit: cover; object-position: top; border-radius: 4px; display: block;">` : '<div style="width: 100%; height: 100%; background: rgba(255, 255, 255, 0.1); border-radius: 4px; display: flex; align-items: center; justify-content: center; color: rgba(255, 255, 255, 0.5); font-size: 0.75rem;">No Image</div>'}
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
                <h2 style="font-size: 0.9rem; line-height: 1.2; margin: 0 0 1rem 0; padding: 0; color: #fff; font-family: 'Arial Black', 'Impact', 'Franklin Gothic Bold', 'Helvetica Neue', Arial, sans-serif; font-weight: 900; text-align: center; min-height: 2.2em; max-height: 3.2em; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; width: 100%; box-sizing: border-box; word-wrap: break-word; -webkit-text-stroke: 1px #000000; text-stroke: 1px #000000;">${escapeHtml(headline)}</h2>
                ${quoteHtml}
                `}
                <a href="${articleUrl}" style="margin-top: 0; margin-bottom: 0; font-size: 0.7rem; padding: 0.4rem 0.8rem; background: #000; border: 2px solid rgba(0, 255, 65, 0.6); color: #fff; cursor: pointer; text-transform: uppercase; font-family: 'Arial Black', 'Impact', 'Franklin Gothic Bold', 'Helvetica Neue', Arial, sans-serif; font-weight: 900; letter-spacing: 0.08em; transition: all 0.3s ease; width: 100%; box-sizing: border-box; text-decoration: none; display: block; text-align: center; box-shadow: 0 0 10px rgba(0, 255, 65, 0.3), 0 0 20px rgba(0, 255, 65, 0.1);" onmouseover="this.style.borderColor='rgba(0, 255, 65, 0.8)'; this.style.boxShadow='0 0 15px rgba(0, 255, 65, 0.5), 0 0 30px rgba(0, 255, 65, 0.2)';" onmouseout="this.style.borderColor='rgba(0, 255, 65, 0.6)'; this.style.boxShadow='0 0 10px rgba(0, 255, 65, 0.3), 0 0 20px rgba(0, 255, 65, 0.1)';">VIEW STORY</a>
            </div>
        </div>
    `;
}

/**
 * Generate league hub page HTML
 */
export function generateLeagueHubPage(
    league: string,
    posts: HeatcheckPost[],
    baseUrl: string = 'https://heatchecks.io'
): string {
    const leagueUpper = league.toUpperCase();
    const leagueLower = normalizeLeague(league);
    
    // Mobile CSS for matchup acronyms
    const mobileStyles = `
        <style>
            @media (max-width: 768px) {
                .matchup-card-full {
                    display: none !important;
                }
                .matchup-card-mobile {
                    display: inline !important;
                }
            }
        </style>
    `;
    
    // Filter posts by league
    const leaguePosts = posts.filter(post => 
        normalizeLeague(post.league) === leagueLower
    ).sort((a, b) => {
        const dateA = a.matchupScheduledDate || a.createdAt;
        const dateB = b.matchupScheduledDate || b.createdAt;
        return new Date(dateB).getTime() - new Date(dateA).getTime();
    });
    
    let content = `
        <style>
            @media (max-width: 768px) {
                .matchup-card-full {
                    display: none !important;
                }
                .matchup-card-mobile {
                    display: inline !important;
                }
            }
        </style>
        <div class="content-area-title">▶ ${leagueUpper} HUB</div>
    `;
    content += '<div class="post-list" id="league-posts-list">';
    
    if (leaguePosts.length === 0) {
        content += '<p style="color: rgba(255, 255, 255, 0.7); font-size: 1rem; font-weight: 900; text-align: center; padding: 2rem;">NO ENTRIES YET</p>';
    } else {
        leaguePosts.forEach(post => {
            content += generatePostCard(post, baseUrl);
        });
    }
    
    content += '</div>';
    
    const hubUrl = `${baseUrl}/${leagueLower}/`;
    
    // Generate CollectionPage schema
    const collectionPageSchema = {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        "name": `${leagueUpper} Hub`,
        "description": `HeatChecks analysis for ${leagueUpper} matchups and games.`,
        "url": hubUrl,
        "numberOfItems": leaguePosts.length,
        "mainEntity": leaguePosts.length > 0 ? {
            "@type": "ItemList",
            "itemListElement": leaguePosts.slice(0, 10).map((post, index) => {
                const date = post.matchupScheduledDate 
                    ? formatDateISO(post.matchupScheduledDate)
                    : formatDateISO(post.createdAt);
                const matchupSlug = generateMatchupSlug(post.teamA || '', post.teamB || '', getShortTeamName);
                const narratives = post.heatCheckData?.narratives || {};
                const candidateCards = narratives.candidate_cards || [];
                const primaryNarrativeId = narratives.selected?.primary_narrative_id || '';
                const activeCard = candidateCards.find(card => card.narrative_id === primaryNarrativeId);
                const emotionTags = activeCard?.emotion_tags || [];
                const narrativeSlug = generateNarrativeSlug(
                    post.websiteStory?.headline || '',
                    post.teamA || '',
                    post.teamB || '',
                    emotionTags
                );
                
                return {
                    "@type": "ListItem",
                    "position": index + 1,
                    "item": {
                        "@type": "Article",
                        "headline": post.websiteStory?.headline || 'Untitled',
                        "url": post.storyType === 'dfs_article' 
                            ? `/dfs/${leagueLower}/${date}/dfs-value-narratives-${date}/`
                            : post.storyType === 'heat_picks'
                            ? (() => {
                                const storedSlug = post.websiteStory?.seo?.slug || '';
                                if (storedSlug) {
                                    return `/${leagueLower}/${storedSlug}/`;
                                } else {
                                    const dateParts = date.split('-');
                                    const slugDate = `${dateParts[1]}-${dateParts[2]}-${dateParts[0]}`;
                                    return `/${leagueLower}/heat-picks-today-${slugDate}/`;
                                }
                            })()
                            : `/${leagueLower}/${date}/${matchupSlug}/${narrativeSlug}/`
                    }
                };
            })
        } : undefined
    };
    
    // Generate breadcrumb schema
    const breadcrumbSchema = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {
                "@type": "ListItem",
                "position": 1,
                "name": "Home",
                "item": `${baseUrl}/`
            },
            {
                "@type": "ListItem",
                "position": 2,
                "name": leagueUpper,
                "item": hubUrl
            }
        ]
    };
    
    const keywords = leagueUpper === 'NBA' 
        ? 'NBA betting, NBA picks, NBA predictions, NBA analysis, NBA matchups, NBA betting picks'
        : leagueUpper === 'NFL'
        ? 'NFL betting, NFL picks, NFL predictions, NFL analysis, NFL matchups, NFL betting picks'
        : `${leagueUpper} betting, ${leagueUpper} picks, ${leagueUpper} analysis`;
    
    const options: BaseTemplateOptions = {
        title: `${leagueUpper} Hub | ${leagueUpper} Matchup Analysis | HeatChecks`,
        description: `HeatChecks analysis for ${leagueUpper} matchups and games. Expert ${leagueUpper} betting picks, predictions, and narrative-driven insights.`,
        url: hubUrl,
        baseUrl,
        keywords: keywords,
        schemaOrg: [collectionPageSchema, breadcrumbSchema],
        posts: leaguePosts
    };
    
    return generateBaseHtml(content, options);
}

