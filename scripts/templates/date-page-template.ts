import { generateBaseHtml, BaseTemplateOptions } from './base-template';
import { escapeHtml } from '../utils/html-escape';
import { formatDateForCard, formatDateISO, normalizeLeague, formatDateForNav, getShortTeamName } from '../utils/date-formatter';
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
 * Calculate heat score from matchup data (fact_pack, evidence_bundle)
 * Returns score breakdown with 5 categories, each 0-20 points = total 0-100
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
    const factPack = heatCheckData.fact_pack || heatCheckData.factPack || {};
    const evidenceBundle = heatCheckData.evidence_bundle || heatCheckData.evidenceBundle || {};
    const narratives = heatCheckData.narratives || {};
    
    // Helper to get date difference in days (more recent = higher score)
    const getDaysAgo = (dateString: string | undefined): number => {
        if (!dateString) return 365;
        try {
            const date = new Date(dateString);
            const now = new Date();
            const diffTime = Math.abs(now.getTime() - date.getTime());
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            return diffDays;
        } catch {
            return 365;
        }
    };
    
    // 1. STAKES (0-20 points) - Prioritizes playoff games and high-stakes scenarios
    let stakesScore = 0;
    
    // Helper to check if date is in playoff season for a league
    const isPlayoffSeason = (dateString: string | undefined, league: string): boolean => {
        if (!dateString) return false;
        try {
            const date = new Date(dateString);
            const month = date.getMonth() + 1; // 1-12
            const leagueLower = (league || '').toLowerCase();
            
            // NFL: January-February (months 1-2)
            if (leagueLower.includes('nfl') || leagueLower === 'football') {
                return month === 1 || month === 2;
            }
            // NBA: April-June (months 4-6)
            if (leagueLower.includes('nba') || leagueLower === 'basketball') {
                return month >= 4 && month <= 6;
            }
            // MLB: October-November (months 10-11)
            if (leagueLower.includes('mlb') || leagueLower === 'baseball') {
                return month === 10 || month === 11;
            }
            // NHL: April-June (months 4-6)
            if (leagueLower.includes('nhl') || leagueLower === 'hockey') {
                return month >= 4 && month <= 6;
            }
            return false;
        } catch {
            return false;
        }
    };
    
    // Helper to check for playoff keywords
    const hasPlayoffKeywords = (): boolean => {
        const playoffKeywords = ['playoff', 'postseason', 'super bowl', 'conference final', 'semifinal', 
                                'championship', 'wild card', 'divisional', 'world series', 'finals', 
                                'elimination', 'must-win', 'do-or-die', 'win or go home'];
        
        // Check headline/title
        const headline = ((post.websiteStory?.headline || '') as string).toLowerCase();
        if (playoffKeywords.some(keyword => headline.includes(keyword))) return true;
        
        // Check key_stats
        const keyStats = factPack.key_stats || [];
        const statsText = keyStats.map((s: any) => `${s.label} ${s.value} ${s.why_it_matters || ''}`).join(' ').toLowerCase();
        if (playoffKeywords.some(keyword => statsText.includes(keyword))) return true;
        
        // Check standings_summary
        const standings = (factPack.context?.standings_summary || '') as string;
        if (playoffKeywords.some(keyword => standings.toLowerCase().includes(keyword))) return true;
        
        // Check narrative titles/claims
        const narrativeCards = narratives.candidate_cards || [];
        const narrativeText = narrativeCards.map((c: any) => `${c.title} ${c.claim || ''}`).join(' ').toLowerCase();
        if (playoffKeywords.some(keyword => narrativeText.includes(keyword))) return true;
        
        return false;
    };
    
    const matchupDate = post.matchupScheduledDate || post.createdAt;
    const league = post.league || '';
    const isPlayoff = isPlayoffSeason(matchupDate, league) || hasPlayoffKeywords();
    
    // Get recent form data (used in both playoff and regular season calculations)
    const recentForm = factPack.context?.recent_form || {};
    const homeForm = (recentForm.home || '') as string;
    const awayForm = (recentForm.away || '') as string;
    
    // Playoff games get automatic high stakes (base score 15-18)
    if (isPlayoff) {
        stakesScore = 15; // Base playoff score
        
        // Close spread in playoffs = even higher stakes (+2-3 points)
        const odds = factPack.odds || {};
        const markets = odds.markets || [];
        const spreadMarket = markets.find((m: any) => m.market === 'Spread');
        
        if (spreadMarket && typeof spreadMarket.point === 'number') {
            const spread = Math.abs(spreadMarket.point);
            if (spread <= 3) stakesScore += 3; // Very close playoff game
            else if (spread <= 6) stakesScore += 2; // Close playoff game
            else stakesScore += 1;
        } else {
            stakesScore += 2; // Default playoff boost if no spread
        }
        
        // Championship/Super Bowl level gets max (+2 points)
        const headline = ((post.websiteStory?.headline || '') as string).toLowerCase();
        const championshipKeywords = ['super bowl', 'championship', 'finals', 'world series', 'stanley cup'];
        if (championshipKeywords.some(keyword => headline.includes(keyword))) {
            stakesScore += 2;
        }
    } else {
        // Regular season games - calculate based on multiple factors
        
        // Close spread = competitive game = higher stakes (0-7 points)
        const odds = factPack.odds || {};
        const markets = odds.markets || [];
        const spreadMarket = markets.find((m: any) => m.market === 'Spread');
        
        if (spreadMarket && typeof spreadMarket.point === 'number') {
            const spread = Math.abs(spreadMarket.point);
            if (spread <= 3) stakesScore += 7; // Very close
            else if (spread <= 6) stakesScore += 5; // Close
            else if (spread <= 10) stakesScore += 3; // Moderate
            else stakesScore += 1; // Blowout potential
        } else {
            stakesScore += 3; // Default if no spread
        }
        
        // Late season implications (0-4 points)
        try {
            const gameDate = new Date(matchupDate);
            const month = gameDate.getMonth() + 1;
            const leagueLower = league.toLowerCase();
            
            // NFL: December-January (late season)
            if ((leagueLower.includes('nfl') || leagueLower === 'football') && (month === 12 || month === 1)) {
                stakesScore += 4;
            }
            // NBA: March-April (late season)
            else if ((leagueLower.includes('nba') || leagueLower === 'basketball') && (month >= 3 && month <= 4)) {
                stakesScore += 4;
            }
            // MLB: September-October (late season)
            else if ((leagueLower.includes('mlb') || leagueLower === 'baseball') && (month >= 9 && month <= 10)) {
                stakesScore += 4;
            }
            // NHL: March-April (late season)
            else if ((leagueLower.includes('nhl') || leagueLower === 'hockey') && (month >= 3 && month <= 4)) {
                stakesScore += 4;
            }
        } catch {
            // Date parsing failed, skip
        }
        
        // Standings/playoff race indicators (0-4 points)
        const standings = (factPack.context?.standings_summary || '') as string;
        const keyStats = factPack.key_stats || [];
        const statsText = keyStats.map((s: any) => `${s.label} ${s.value} ${s.why_it_matters || ''}`).join(' ').toLowerCase();
        
        const playoffRaceKeywords = ['playoff race', 'wild card', 'division', 'conference', 'standings', 'clinched', 'eliminated'];
        const hasPlayoffRaceContext = playoffRaceKeywords.some(keyword => 
            standings.toLowerCase().includes(keyword) || statsText.includes(keyword)
        );
        
        if (hasPlayoffRaceContext) {
            stakesScore += 4;
        }
        
        // Recent form indicators (0-3 points)
        const homeWins = (homeForm.match(/W/g) || []).length;
        const awayWins = (awayForm.match(/W/g) || []).length;
        const totalWins = homeWins + awayWins;
        if (totalWins >= 6) stakesScore += 3;
        else if (totalWins >= 4) stakesScore += 2;
        else if (totalWins >= 2) stakesScore += 1;
        
        // Injury impact (0-1 point) - less important in stakes, more in game outcome
        const injuries = factPack.context?.injuries || [];
        const criticalInjuries = injuries.filter((i: any) => 
            i.status && (i.status.toLowerCase().includes('out') || i.status.toLowerCase().includes('doubtful'))
        ).length;
        if (criticalInjuries >= 2) stakesScore += 1;
    }
    
    stakesScore = Math.min(20, stakesScore);
    
    // 2. RECENCY (0-20 points)
    let recencyScore = 0;
    const timelineEvents = evidenceBundle.timeline_events || [];
    const quotes = evidenceBundle.quotes || [];
    
    if (timelineEvents.length > 0) {
        const sortedEvents = timelineEvents
            .map((e: any) => ({ ...e, daysAgo: getDaysAgo(e.date_utc) }))
            .sort((a: any, b: any) => a.daysAgo - b.daysAgo);
        
        const mostRecentDays = sortedEvents[0].daysAgo;
        if (mostRecentDays <= 30) recencyScore += 10;
        else if (mostRecentDays <= 90) recencyScore += 8;
        else if (mostRecentDays <= 180) recencyScore += 6;
        else if (mostRecentDays <= 365) recencyScore += 4;
        else recencyScore += 2;
    } else {
        recencyScore += 2;
    }
    
    if (quotes.length > 0) {
        const sortedQuotes = quotes
            .map((q: any) => ({ ...q, daysAgo: getDaysAgo(q.date_utc) }))
            .sort((a: any, b: any) => a.daysAgo - b.daysAgo);
        
        const mostRecentQuoteDays = sortedQuotes[0].daysAgo;
        if (mostRecentQuoteDays <= 90) recencyScore += 10;
        else if (mostRecentQuoteDays <= 180) recencyScore += 8;
        else if (mostRecentQuoteDays <= 365) recencyScore += 6;
        else recencyScore += 4;
    } else {
        recencyScore += 2;
    }
    
    recencyScore = Math.min(20, recencyScore);
    
    // 3. PAYBACK (0-20 points)
    let paybackScore = 0;
    
    const paybackEvents = timelineEvents.filter((e: any) => {
        const eventType = (e.event_type || '').toLowerCase();
        return eventType.includes('rivalry') || eventType.includes('trade') || 
               eventType.includes('revenge') || eventType.includes('beef');
    });
    
    if (paybackEvents.length >= 3) paybackScore += 12;
    else if (paybackEvents.length === 2) paybackScore += 8;
    else if (paybackEvents.length === 1) paybackScore += 5;
    
    const primaryNarrativeId = narratives.selected?.primary_narrative_id;
    const primaryCard = (narratives.candidate_cards || []).find(
        (c: any) => c.narrative_id === primaryNarrativeId
    );
    const emotionTags = primaryCard?.emotion_tags || [];
    const paybackKeywords = ['revenge', 'payback', 'rivalry', 'beef', 'grudge', 'vendetta'];
    const matchingTags = emotionTags.filter((tag: string) => 
        paybackKeywords.some(keyword => tag.toLowerCase().includes(keyword))
    );
    
    if (matchingTags.length >= 2) paybackScore += 8;
    else if (matchingTags.length === 1) paybackScore += 4;
    
    paybackScore = Math.min(20, paybackScore);
    
    // 4. HISTORY (0-20 points)
    let historyScore = 0;
    
    if (timelineEvents.length >= 5) historyScore += 8;
    else if (timelineEvents.length >= 3) historyScore += 6;
    else if (timelineEvents.length >= 2) historyScore += 4;
    else if (timelineEvents.length >= 1) historyScore += 2;
    
    const keyStats = factPack.key_stats || [];
    const h2hStats = keyStats.filter((s: any) => {
        const label = (s.label || '').toLowerCase();
        return label.includes('head') || label.includes('h2h') || 
               label.includes('versus') || label.includes('vs');
    });
    if (h2hStats.length >= 2) historyScore += 6;
    else if (h2hStats.length === 1) historyScore += 3;
    
    const formPattern = homeForm + awayForm;
    if (formPattern.match(/WWWW|LLLL/)) historyScore += 6;
    else if (formPattern.match(/WWW|LLL/)) historyScore += 4;
    else if (formPattern.match(/WW|LL/)) historyScore += 2;
    
    historyScore = Math.min(20, historyScore);
    
    // 5. EMOTION (0-20 points)
    let emotionScore = 0;
    
    if (quotes.length >= 5) emotionScore += 10;
    else if (quotes.length >= 3) emotionScore += 8;
    else if (quotes.length >= 2) emotionScore += 6;
    else if (quotes.length === 1) emotionScore += 3;
    
    const allEmotionTags = (narratives.candidate_cards || [])
        .flatMap((c: any) => c.emotion_tags || []);
    const uniqueEmotionTags = [...new Set(allEmotionTags)];
    if (uniqueEmotionTags.length >= 4) emotionScore += 6;
    else if (uniqueEmotionTags.length >= 3) emotionScore += 4;
    else if (uniqueEmotionTags.length >= 2) emotionScore += 2;
    
    const quotesWithSpeakers = quotes.filter((q: any) => q.speaker && q.team);
    if (quotesWithSpeakers.length >= 3) emotionScore += 4;
    else if (quotesWithSpeakers.length >= 2) emotionScore += 2;
    else if (quotesWithSpeakers.length === 1) emotionScore += 1;
    
    emotionScore = Math.min(20, emotionScore);
    
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

/**
 * Calculate heat score (backward compatible - returns just the number)
 */
function calculateHeatScore(post: HeatcheckPost): number {
    return calculateHeatScoreFromMatchupData(post).total;
}

/**
 * Generate post card HTML (same as archive)
 */
function generatePostCard(post: HeatcheckPost, baseUrl: string): string {
    const heatScore = calculateHeatScore(post);
    const dateStr = formatDateForCard(post.matchupScheduledDate || post.createdAt);
    const teamAShort = getShortTeamName(post.teamA || '');
    const teamBShort = getShortTeamName(post.teamB || '');
    const matchup = `${teamAShort} VS ${teamBShort}`.toUpperCase();
    const league = (post.league || '').toUpperCase();
    
    // Check if this is a DFS article
    const isDFSArticle = post.storyType === 'dfs_article';
    
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
    let displayMatchup = matchup;
    if (isDFSArticle) {
        const articleDate = post.matchupScheduledDate || post.createdAt;
        try {
            const dateForDayOfWeek = new Date(articleDate + (articleDate.includes('T') ? '' : 'T12:00:00'));
            const dayOfWeek = dateForDayOfWeek.toLocaleDateString('en-US', { weekday: 'long' });
            const sportLabel = league === 'NBA' ? 'Basketball' : league === 'NFL' ? 'Football' : league;
            displayMatchup = `${dayOfWeek} DFS ${sportLabel}`.toUpperCase();
        } catch {
            displayMatchup = 'DFS VALUE';
        }
    }
    
    // URL structure differs for DFS articles
    const articleUrl = isDFSArticle 
        ? `/dfs/${leagueLower}/${date}/dfs-value-narratives-${date}/`
        : `/${leagueLower}/${date}/${matchupSlug}/${finalNarrativeSlug}/`;
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
        const quoteText = selectedQuote?.quote || '';
        quoteSpeaker = selectedQuote?.speaker || '';
        quoteTeam = selectedQuote?.team || '';
        
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
        <div class="post-card" data-heat-high="${isHeatHigh}" data-post-id="${post.id}">
            <div style="display: flex; flex-direction: column; flex: 1; min-height: 0; width: 100%; box-sizing: border-box; overflow: hidden;">
                <div style="padding: 0.5rem 0.6rem; background: rgba(0, 0, 0, 0.5); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); border: 1px solid rgba(255, 255, 255, 0.35); margin-bottom: 0.75rem; text-align: center; display: flex; align-items: center; justify-content: space-between; gap: 0.4rem; width: 100%; box-sizing: border-box; overflow: hidden; border-radius: 4px;">
                    <div style="width: 50px; height: 50px; min-width: 50px; border-radius: 50%; border: 2px solid #fff; background: #fff; box-shadow: 0 2px 8px rgba(255, 255, 255, 0.5), 0 0 12px rgba(255, 255, 255, 0.3); display: flex; align-items: center; justify-content: center; flex-shrink: 0; box-sizing: border-box;">
                        <div style="color: #000; font-size: 0.85rem; font-family: 'Arial Black', 'Impact', 'Franklin Gothic Bold', 'Helvetica Neue', Arial, sans-serif; font-weight: 900; line-height: 1; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${dateStr}</div>
                    </div>
                    <div style="color: #fff; font-size: 0.85rem; font-family: 'Arial Black', 'Impact', 'Franklin Gothic Bold', 'Helvetica Neue', Arial, sans-serif; font-weight: 900; text-transform: uppercase; letter-spacing: 0.08em; flex: 1; min-width: 0; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-sizing: border-box; text-shadow: 0 0 8px rgba(255, 255, 255, 0.6), 0 2px 4px rgba(255, 255, 255, 0.4);">${displayMatchup}</div>
                    <div style="width: 35px; height: 35px; min-width: 35px; border-radius: 50%; border: 2px solid #fff; background: rgba(255, 255, 255, 0.1); box-shadow: 0 2px 8px rgba(255, 255, 255, 0.3), 0 0 12px rgba(255, 255, 255, 0.2); display: flex; align-items: center; justify-content: center; flex-shrink: 0; box-sizing: border-box;">
                        <div style="color: #fff; font-size: 0.6rem; font-family: 'Arial Black', 'Impact', 'Franklin Gothic Bold', 'Helvetica Neue', Arial, sans-serif; font-weight: 900; line-height: 1; text-align: center; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-shadow: 0 0 8px rgba(255, 255, 255, 0.6), 0 2px 4px rgba(255, 255, 255, 0.4);">${league}</div>
                    </div>
                </div>
                <div style="display: flex; gap: 0.5rem; margin-bottom: 0.75rem; align-items: center; justify-content: flex-start; position: relative; width: 100%; box-sizing: border-box;">
                    ${isDFSArticle ? `
                    <!-- DFS Heat Indicator -->
                    <div class="heat-indicator-container" data-post-id="${post.id}" style="width: 85px; height: 85px; min-width: 85px; border: 2px solid #00ff41; border-radius: 50%; background: rgba(0, 0, 0, 0.5); display: flex; align-items: center; justify-content: center; flex-shrink: 0; position: relative; box-shadow: inset 0 0 20px #00ff4140, 0 0 15px #00ff4160; overflow: hidden;">
                        <div style="color: #00ff41; font-size: 1.2rem; font-weight: 900; text-shadow: 0 0 20px #00ff41, 0 0 30px rgba(0, 255, 65, 0.7), 0 0 40px rgba(0, 255, 65, 0.5), 0 0 2px rgba(255, 255, 255, 0.9); font-family: 'Arial Black', 'Impact', 'Franklin Gothic Bold', 'Helvetica Neue', Arial, sans-serif; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; letter-spacing: 0.5px; z-index: 1; position: relative;">DFS</div>
                    </div>
                    ` : `
                    <!-- Regular Heat Indicator -->
                    <div class="heat-indicator-container" data-post-id="${post.id}" style="width: 85px; height: 85px; min-width: 85px; border: 2px solid #ff0040; border-radius: 50%; background: rgba(0, 0, 0, 0.5); display: flex; align-items: center; justify-content: center; flex-shrink: 0; position: relative; box-shadow: inset 0 0 20px #ff004040, 0 0 15px #ff004060; overflow: hidden; cursor: pointer;">
                        <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 72px; height: 72px; border: 1.5px solid #00ff41; border-radius: 50%; opacity: 0.5;"></div>
                        <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 50px; height: 50px; border: 1.5px solid #ff0040; opacity: 0.7;"></div>
                        <div style="color: #ff0040; font-size: 1.55rem; font-weight: 900; text-shadow: 0 0 20px #ff0040, 0 0 30px rgba(255, 0, 64, 0.7), 0 0 40px rgba(255, 0, 64, 0.5), 0 0 2px rgba(255, 255, 255, 0.9); font-family: 'Arial Black', 'Impact', 'Franklin Gothic Bold', 'Helvetica Neue', Arial, sans-serif; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; letter-spacing: 0.5px; z-index: 1; position: relative;">${heatScore}</div>
                    </div>
                    `}
                    <div class="post-card-image-container" data-post-id="${post.id}" style="flex: 1; height: 130px; min-width: 0; position: relative; overflow: hidden; box-sizing: border-box;">
                        ${imagePath ? `<img src="${imagePath}" alt="${escapeHtml(`${teamAShort} vs ${teamBShort} ${league} ${finalNarrativeSlug} narrative - ${headline} - HeatChecks Analysis`)}" style="width: 100%; height: 100%; object-fit: cover; object-position: top; border-radius: 4px; display: block;">` : '<div style="width: 100%; height: 100%; background: rgba(255, 255, 255, 0.1); border-radius: 4px; display: flex; align-items: center; justify-content: center; color: rgba(255, 255, 255, 0.5); font-size: 0.75rem;">No Image</div>'}
                    </div>
                </div>
                <h2 style="font-size: 0.75rem; line-height: 1.3; margin: 0 0 1rem 0; padding: 0; color: #fff; font-family: 'Arial Black', 'Impact', 'Franklin Gothic Bold', 'Helvetica Neue', Arial, sans-serif; font-weight: 900; text-align: center; min-height: 2em; max-height: 3em; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; width: 100%; box-sizing: border-box; word-wrap: break-word;">${escapeHtml(headline)}</h2>
                ${quoteHtml}
                <a href="${articleUrl}" style="margin-top: 0; margin-bottom: 0; font-size: 0.7rem; padding: 0.4rem 0.8rem; background: #000; border: 2px solid #f84242; color: #fff; cursor: pointer; text-transform: uppercase; font-family: 'Arial Black', 'Impact', 'Franklin Gothic Bold', 'Helvetica Neue', Arial, sans-serif; font-weight: 900; letter-spacing: 0.08em; transition: all 0.3s ease; width: 100%; box-sizing: border-box; text-decoration: none; display: block; text-align: center;">VIEW STORY</a>
            </div>
        </div>
    `;
}

/**
 * Generate date page HTML
 */
export function generateDatePage(
    league: string,
    date: string,
    posts: HeatcheckPost[],
    baseUrl: string = 'https://heatchecks.io'
): string {
    const leagueUpper = league.toUpperCase();
    const leagueLower = normalizeLeague(league);
    
    // Filter posts by league and date
    const datePosts = posts.filter(post => {
        const postLeague = normalizeLeague(post.league);
        const postDate = post.matchupScheduledDate 
            ? formatDateISO(post.matchupScheduledDate)
            : formatDateISO(post.createdAt);
        return postLeague === leagueLower && postDate === date;
    }).sort((a, b) => {
        // Sort by creation time
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    
    const dateDisplay = formatDateForNav(date);
    
    let content = `<div class="content-area-title">▶ ${leagueUpper} ${dateDisplay}</div>`;
    content += '<div class="post-list" id="date-posts-list">';
    
    if (datePosts.length === 0) {
        content += '<p style="color: rgba(255, 255, 255, 0.7); font-size: 1rem; font-weight: 900; text-align: center; padding: 2rem;">NO ENTRIES YET</p>';
    } else {
        datePosts.forEach(post => {
            content += generatePostCard(post, baseUrl);
        });
    }
    
    content += '</div>';
    
    const dateUrl = `${baseUrl}/${leagueLower}/${date}/`;
    
    // Generate CollectionPage schema
    const collectionPageSchema = {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        "name": `${leagueUpper} ${date} Matchups`,
        "description": `HeatChecks analysis for ${leagueUpper} matchups on ${date}.`,
        "url": dateUrl,
        "numberOfItems": datePosts.length
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
                "item": `${baseUrl}/${leagueLower}/`
            },
            {
                "@type": "ListItem",
                "position": 3,
                "name": date,
                "item": dateUrl
            }
        ]
    };
    
    const keywords = leagueUpper === 'NBA' 
        ? `NBA betting, NBA picks, NBA predictions, ${date} NBA matchups, NBA analysis`
        : leagueUpper === 'NFL'
        ? `NFL betting, NFL picks, NFL predictions, ${date} NFL matchups, NFL analysis`
        : `${leagueUpper} betting, ${leagueUpper} picks, ${date} ${leagueUpper} matchups`;
    
    const options: BaseTemplateOptions = {
        title: `${leagueUpper} ${date} | ${leagueUpper} Matchup Analysis | HeatChecks`,
        description: `HeatChecks analysis for ${leagueUpper} matchups on ${date}. Expert ${leagueUpper} betting picks, predictions, and narrative-driven insights.`,
        url: dateUrl,
        baseUrl,
        keywords: keywords,
        schemaOrg: [collectionPageSchema, breadcrumbSchema],
        posts: datePosts
    };
    
    return generateBaseHtml(content, options);
}

