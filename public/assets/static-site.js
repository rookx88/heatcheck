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
 * Calculate heat score from matchup data (fact_pack, evidence_bundle)
 * Returns score breakdown with 5 categories, each 0-20 points = total 0-100
 */
function calculateHeatScoreFromMatchupData(post) {
    if (!post.heatCheckData) {
        return {
            total: 0,
            breakdown: {
                stakes: 0,
                recency: 0,
                payback: 0,
                history: 0,
                emotion: 0
            }
        };
    }
    
    const heatCheckData = post.heatCheckData;
    const factPack = heatCheckData.fact_pack || heatCheckData.factPack || {};
    const evidenceBundle = heatCheckData.evidence_bundle || heatCheckData.evidenceBundle || {};
    const narratives = heatCheckData.narratives || {};
    
    // Helper to safely get values
    const safeGet = (obj, path, defaultVal = 0) => {
        const keys = path.split('.');
        let value = obj;
        for (const key of keys) {
            if (value && typeof value === 'object' && key in value) {
                value = value[key];
            } else {
                return defaultVal;
            }
        }
        return value || defaultVal;
    };
    
    // Helper to get date difference in days (more recent = higher score)
    const getDaysAgo = (dateString) => {
        if (!dateString) return 365; // Default to old if missing
        try {
            const date = new Date(dateString);
            const now = new Date();
            const diffTime = Math.abs(now - date);
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            return diffDays;
        } catch {
            return 365;
        }
    };
    
    // 1. STAKES (0-20 points)
    let stakesScore = 0;
    
    // Helper to check if date is in playoff season for a league
    const isPlayoffSeason = (dateString, league) => {
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
    const hasPlayoffKeywords = () => {
        const playoffKeywords = ['playoff', 'postseason', 'super bowl', 'conference final', 'semifinal', 
                                'championship', 'wild card', 'divisional', 'world series', 'finals', 
                                'elimination', 'must-win', 'do-or-die', 'win or go home'];
        
        // Check headline/title
        const headline = (post.websiteStory?.headline || '').toLowerCase();
        if (playoffKeywords.some(keyword => headline.includes(keyword))) return true;
        
        // Check key_stats
        const keyStats = factPack.key_stats || [];
        const statsText = keyStats.map(s => `${s.label} ${s.value} ${s.why_it_matters || ''}`).join(' ').toLowerCase();
        if (playoffKeywords.some(keyword => statsText.includes(keyword))) return true;
        
        // Check standings_summary
        const standings = factPack.context?.standings_summary || '';
        if (playoffKeywords.some(keyword => standings.toLowerCase().includes(keyword))) return true;
        
        // Check narrative titles/claims
        const narrativeCards = narratives.candidate_cards || [];
        const narrativeText = narrativeCards.map(c => `${c.title} ${c.claim || ''}`).join(' ').toLowerCase();
        if (playoffKeywords.some(keyword => narrativeText.includes(keyword))) return true;
        
        return false;
    };
    
    const matchupDate = post.matchupScheduledDate || post.createdAt;
    const league = post.league || '';
    const isPlayoff = isPlayoffSeason(matchupDate, league) || hasPlayoffKeywords();
    
    // Get recent form data (used in both playoff and regular season calculations)
    const recentForm = factPack.context?.recent_form || {};
    const homeForm = recentForm.home || '';
    const awayForm = recentForm.away || '';
    
    // Playoff games get automatic high stakes (base score 15-18)
    if (isPlayoff) {
        stakesScore = 15; // Base playoff score
        
        // Close spread in playoffs = even higher stakes (+2-3 points)
        const odds = factPack.odds || {};
        const markets = odds.markets || [];
        const spreadMarket = markets.find(m => m.market === 'Spread');
        
        if (spreadMarket && typeof spreadMarket.point === 'number') {
            const spread = Math.abs(spreadMarket.point);
            if (spread <= 3) stakesScore += 3; // Very close playoff game
            else if (spread <= 6) stakesScore += 2; // Close playoff game
            else stakesScore += 1;
        } else {
            stakesScore += 2; // Default playoff boost if no spread
        }
        
        // Championship/Super Bowl level gets max (+2 points)
        const headline = (post.websiteStory?.headline || '').toLowerCase();
        const championshipKeywords = ['super bowl', 'championship', 'finals', 'world series', 'stanley cup'];
        if (championshipKeywords.some(keyword => headline.includes(keyword))) {
            stakesScore += 2;
        }
    } else {
        // Regular season games - calculate based on multiple factors
        
        // Close spread = competitive game = higher stakes (0-7 points)
        const odds = factPack.odds || {};
        const markets = odds.markets || [];
        const spreadMarket = markets.find(m => m.market === 'Spread');
        
        if (spreadMarket && typeof spreadMarket.point === 'number') {
            const spread = Math.abs(spreadMarket.point);
            if (spread <= 3) stakesScore += 7; // Very close
            else if (spread <= 6) stakesScore += 5; // Close
            else if (spread <= 10) stakesScore += 3; // Moderate
            else stakesScore += 1; // Blowout potential
        } else {
            stakesScore += 3; // Default if no spread
        }
        
        // Late season implications (0-5 points)
        // Check if game is in late season (within playoff race timeframe)
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
        const standings = factPack.context?.standings_summary || '';
        const keyStats = factPack.key_stats || [];
        const statsText = keyStats.map(s => `${s.label} ${s.value} ${s.why_it_matters || ''}`).join(' ').toLowerCase();
        
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
        const criticalInjuries = injuries.filter(i => 
            i.status && (i.status.toLowerCase().includes('out') || i.status.toLowerCase().includes('doubtful'))
        ).length;
        if (criticalInjuries >= 2) stakesScore += 1;
    }
    
    stakesScore = Math.min(20, stakesScore);
    
    // 2. RECENCY (0-20 points) - How recent are the relevant events?
    let recencyScore = 0;
    const timelineEvents = evidenceBundle.timeline_events || [];
    const quotes = evidenceBundle.quotes || [];
    
    // Most recent timeline event (0-10 points)
    if (timelineEvents.length > 0) {
        const sortedEvents = timelineEvents
            .map(e => ({ ...e, daysAgo: getDaysAgo(e.date_utc) }))
            .sort((a, b) => a.daysAgo - b.daysAgo);
        
        const mostRecentDays = sortedEvents[0].daysAgo;
        if (mostRecentDays <= 30) recencyScore += 10;
        else if (mostRecentDays <= 90) recencyScore += 8;
        else if (mostRecentDays <= 180) recencyScore += 6;
        else if (mostRecentDays <= 365) recencyScore += 4;
        else recencyScore += 2;
    } else {
        recencyScore += 2; // No events = low recency
    }
    
    // Most recent quote (0-10 points)
    if (quotes.length > 0) {
        const sortedQuotes = quotes
            .map(q => ({ ...q, daysAgo: getDaysAgo(q.date_utc) }))
            .sort((a, b) => a.daysAgo - b.daysAgo);
        
        const mostRecentQuoteDays = sortedQuotes[0].daysAgo;
        if (mostRecentQuoteDays <= 90) recencyScore += 10;
        else if (mostRecentQuoteDays <= 180) recencyScore += 8;
        else if (mostRecentQuoteDays <= 365) recencyScore += 6;
        else recencyScore += 4;
    } else {
        recencyScore += 2; // No quotes = low recency
    }
    
    recencyScore = Math.min(20, recencyScore);
    
    // 3. PAYBACK (0-20 points) - Revenge/payback scenarios
    let paybackScore = 0;
    
    // Timeline events with rivalry/trade type (0-12 points)
    const paybackEvents = timelineEvents.filter(e => {
        const eventType = (e.event_type || '').toLowerCase();
        return eventType.includes('rivalry') || eventType.includes('trade') || 
               eventType.includes('revenge') || eventType.includes('beef');
    });
    
    if (paybackEvents.length >= 3) paybackScore += 12;
    else if (paybackEvents.length === 2) paybackScore += 8;
    else if (paybackEvents.length === 1) paybackScore += 5;
    
    // Emotion tags from narratives (0-8 points)
    const primaryNarrativeId = narratives.selected?.primary_narrative_id;
    const primaryCard = (narratives.candidate_cards || []).find(
        c => c.narrative_id === primaryNarrativeId
    );
    const emotionTags = primaryCard?.emotion_tags || [];
    const paybackKeywords = ['revenge', 'payback', 'rivalry', 'beef', 'grudge', 'vendetta'];
    const matchingTags = emotionTags.filter(tag => 
        paybackKeywords.some(keyword => tag.toLowerCase().includes(keyword))
    );
    
    if (matchingTags.length >= 2) paybackScore += 8;
    else if (matchingTags.length === 1) paybackScore += 4;
    
    paybackScore = Math.min(20, paybackScore);
    
    // 4. HISTORY (0-20 points) - Historical context, H2H, timeline depth
    let historyScore = 0;
    
    // Timeline event count (indicates depth of history) (0-8 points)
    if (timelineEvents.length >= 5) historyScore += 8;
    else if (timelineEvents.length >= 3) historyScore += 6;
    else if (timelineEvents.length >= 2) historyScore += 4;
    else if (timelineEvents.length >= 1) historyScore += 2;
    
    // Key stats with H2H indicators (0-6 points)
    const keyStats = factPack.key_stats || [];
    const h2hStats = keyStats.filter(s => {
        const label = (s.label || '').toLowerCase();
        return label.includes('head') || label.includes('h2h') || 
               label.includes('versus') || label.includes('vs');
    });
    if (h2hStats.length >= 2) historyScore += 6;
    else if (h2hStats.length === 1) historyScore += 3;
    
    // Performance alignment (from recent form showing pattern) (0-6 points)
    const formPattern = homeForm + awayForm;
    // Streaks indicate patterns/history
    if (formPattern.match(/WWWW|LLLL/)) historyScore += 6; // Strong patterns
    else if (formPattern.match(/WWW|LLL/)) historyScore += 4;
    else if (formPattern.match(/WW|LL/)) historyScore += 2;
    
    historyScore = Math.min(20, historyScore);
    
    // 5. EMOTION (0-20 points) - Emotional intensity, quotes, audience resonance
    let emotionScore = 0;
    
    // Quote count and quality (0-10 points)
    if (quotes.length >= 5) emotionScore += 10;
    else if (quotes.length >= 3) emotionScore += 8;
    else if (quotes.length >= 2) emotionScore += 6;
    else if (quotes.length === 1) emotionScore += 3;
    
    // Emotion tags intensity (0-6 points)
    const allEmotionTags = (narratives.candidate_cards || [])
        .flatMap(c => c.emotion_tags || []);
    const uniqueEmotionTags = [...new Set(allEmotionTags)];
    if (uniqueEmotionTags.length >= 4) emotionScore += 6;
    else if (uniqueEmotionTags.length >= 3) emotionScore += 4;
    else if (uniqueEmotionTags.length >= 2) emotionScore += 2;
    
    // Quote speakers with team context (shows personality/story) (0-4 points)
    const quotesWithSpeakers = quotes.filter(q => q.speaker && q.team);
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
                <div style="font-size: 0.7rem; font-weight: 900; color: #ff0040; text-shadow: 0 0 4px #ff0040; line-height: 1;">${total}/100</div>
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
    const leagueMap = {
        'NBA': 'nba',
        'NFL': 'nfl',
        'EPL': 'epl',
        'Premier League': 'epl',
        'LaLiga': 'laliga',
        'MLB': 'mlb',
        'NHL': 'nhl',
        'UFC': 'ufc',
        'Soccer': 'soccer',
    };
    return leagueMap[league] || (league || '').toLowerCase().replace(/\s+/g, '-');
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
    const league = normalizeLeague(post.league || '');
    const date = post.matchupScheduledDate 
        ? formatDateForUrl(post.matchupScheduledDate)
        : formatDateForUrl(post.createdAt);
    
    // Handle DFS articles with special URL structure
    if (post.storyType === 'dfs_article') {
        return `/dfs/${league}/${date}/dfs-value-narratives-${date}/`;
    }
    
    // Check if stored slug is in new format (matchup/narrative)
    const storedSlug = post.websiteStory?.seo?.slug || '';
    let matchupSlug;
    let narrativeSlug;
    
    if (storedSlug.includes('/') && storedSlug.split('/').length === 2) {
        // Already in new format: matchup-slug/narrative-slug
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
    
    // New URL structure without .html extension
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
 * Generate post card HTML
 */
function generatePostCard(post) {
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
    let displayMatchup = matchup;
    if (isDFSArticle) {
        const articleDate = post.matchupScheduledDate || post.createdAt;
        try {
            const dateForDayOfWeek = new Date(articleDate + (articleDate.includes('T') ? '' : 'T12:00:00'));
            const dayOfWeek = dateForDayOfWeek.toLocaleDateString('en-US', { weekday: 'long' });
            // Ensure league is in correct format (NBA, NFL, etc. not "Basketball")
            const normalizedLeague = league.toUpperCase();
            displayMatchup = (dayOfWeek + ' ' + normalizedLeague + ' DFS').toUpperCase();
        } catch (e) {
            displayMatchup = 'DFS VALUE';
        }
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
                        ${imagePath ? `<img src="${imagePath}" alt="${teamAShort} vs ${teamBShort} ${league} matchup analysis - ${headline} - HeatChecks Analysis" style="width: 100%; height: 100%; object-fit: cover; object-position: top; border-radius: 4px; display: block;">` : '<div style="width: 100%; height: 100%; background: rgba(255, 255, 255, 0.1); border-radius: 4px; display: flex; align-items: center; justify-content: center; color: rgba(255, 255, 255, 0.5); font-size: 0.75rem;">No Image</div>'}
                    </div>
                </div>
                <h2 style="font-size: 0.75rem; line-height: 1.3; margin: 0 0 1rem 0; padding: 0; color: #fff; font-family: 'Arial Black', 'Impact', 'Franklin Gothic Bold', 'Helvetica Neue', Arial, sans-serif; font-weight: 900; text-align: center; min-height: 2em; max-height: 3em; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; width: 100%; box-sizing: border-box; word-wrap: break-word;">${headline}</h2>
                ${quoteHtml}
                <a href="${articleUrl}" style="margin-top: 0; margin-bottom: 0; font-size: 0.7rem; padding: 0.4rem 0.8rem; background: #000; border: 2px solid #f84242; color: #fff; cursor: pointer; text-transform: uppercase; font-family: 'Arial Black', 'Impact', 'Franklin Gothic Bold', 'Helvetica Neue', Arial, sans-serif; font-weight: 900; letter-spacing: 0.08em; transition: all 0.3s ease; width: 100%; box-sizing: border-box; text-decoration: none; display: block; text-align: center;">VIEW STORY</a>
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
        // Normalize league name using the same function used elsewhere
        const leagueUpper = (post.league || '').toUpperCase();
        const leagueLower = normalizeLeague(leagueUpper);
        
        // Use uppercase for key matching with data-league attribute
        if (!dateMap.has(leagueUpper)) {
            dateMap.set(leagueUpper, { dates: new Set(), leagueLower: leagueLower });
        }
        dateMap.get(leagueUpper).dates.add(dateStr);
    });
    
    // Convert to array and sort
    const result = {};
    dateMap.forEach((data, leagueUpper) => {
        result[leagueUpper] = Array.from(data.dates)
            .sort()
            .reverse()
            .slice(0, 10) // Limit to 10 most recent dates
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
        
        if (submenu && recentDates[league]) {
            // Clear existing date links (keep HUB link)
            const existingDateLinks = submenu.querySelectorAll('.nav-submenu-item:not([href*="/hub"]):not([href*="/' + league.toLowerCase() + '/"])');
            existingDateLinks.forEach(el => el.remove());
            
            // Fix HUB link if it exists
            const hubLink = submenu.querySelector('a[href*="/hub"]') || submenu.querySelector('a[href*="/' + league.toLowerCase() + '/"]');
            if (hubLink) {
                hubLink.href = `/${league.toLowerCase()}/`;
                hubLink.className = 'nav-link nav-submenu-item';
            }
            
            // Add date links
            recentDates[league].forEach(dateInfo => {
                // Check if link already exists
                const existingLink = Array.from(submenu.querySelectorAll('a')).find(a => a.href.endsWith(dateInfo.url));
                if (!existingLink) {
                    const dateLink = document.createElement('a');
                    dateLink.href = dateInfo.url;
                    dateLink.className = 'nav-link nav-submenu-item';
                    dateLink.textContent = dateInfo.display;
                    
                    // Navigation will be handled by initLinkHandling (already initialized)
                    submenu.appendChild(dateLink);
                }
            });
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
        <a href="${articleUrl}" class="roundup-game-item">
            <div class="game-matchup">${matchup}</div>
            <div class="game-date">${dateMMDD} • ${league}</div>
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
 */
function storeRadarResults(todayPosts, tomorrowPosts) {
    try {
        const scanDate = getTodayDate();
        const scanData = {
            scanDate: scanDate,
            todayPosts: todayPosts,
            tomorrowPosts: tomorrowPosts,
            timestamp: Date.now()
        };
        sessionStorage.setItem('radarScanResults', JSON.stringify(scanData));
    } catch (error) {
        console.error('Failed to store radar results:', error);
    }
}

/**
 * Get stored radar scan results from sessionStorage
 * Results expire after 10 minutes to ensure newly published articles appear
 */
function getStoredRadarResults() {
    try {
        const stored = sessionStorage.getItem('radarScanResults');
        if (!stored) return null;
        
        const scanData = JSON.parse(stored);
        const today = getTodayDate();
        
        // Only use stored results if they're from today (dates haven't changed)
        if (scanData.scanDate === today) {
            // Check if results are still fresh (less than 10 minutes old)
            // This ensures newly published articles appear within 10 minutes
            const MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes
            const age = Date.now() - (scanData.timestamp || 0);
            
            if (age < MAX_AGE_MS) {
                console.log(`[Radar] Using cached results (${Math.round(age / 1000)}s old)`);
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
    
    if (leftGames) {
        if (todayPosts.length > 0) {
            leftGames.innerHTML = todayPosts.map(post => generateMatchupButton(post)).join('');
        } else {
            leftGames.innerHTML = '<div class="no-games-message">NO GAMES TODAY</div>';
        }
    }
    
    if (rightGames) {
        if (tomorrowPosts.length > 0) {
            rightGames.innerHTML = tomorrowPosts.map(post => generateMatchupButton(post)).join('');
        } else {
            rightGames.innerHTML = '<div class="no-games-message">NO GAMES TOMORROW</div>';
        }
    }
    
    // Store results for persistence across page navigations
    if (shouldStore) {
        storeRadarResults(todayPosts, tomorrowPosts);
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
            // Exclude DFS articles (they're not matchups)
            const todayPosts = posts.filter(post => {
                // Exclude DFS articles - they're not matchups
                if (post.storyType === 'dfs_article') {
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
                // Exclude DFS articles - they're not matchups
                if (post.storyType === 'dfs_article') {
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
        
        // Check for stored results
        const storedResults = getStoredRadarResults();
        
        if (storedResults && storedResults.todayPosts.length > 0) {
            showMobileRadarResults(storedResults.todayPosts, false);
        } else {
            resetMobileRadarModal();
        }
        
        mobileModal.classList.add('active');
        document.body.style.overflow = 'hidden'; // Prevent body scroll
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
            
            // Filter posts by today only - exclude DFS articles and only published posts
            const todayPosts = posts.filter(post => {
                if (post.storyType === 'dfs_article') {
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
    
    if (gamesContainer) {
        if (todayPosts.length > 0) {
            gamesContainer.innerHTML = todayPosts.map(post => generateMatchupButton(post)).join('');
        } else {
            gamesContainer.innerHTML = '<div class="no-games-message">NO GAMES TODAY</div>';
        }
    }
    
    // Store results (reuse desktop storage function)
    if (shouldStore) {
        const storedResults = getStoredRadarResults();
        const tomorrowPosts = storedResults ? storedResults.tomorrowPosts : [];
        storeRadarResults(todayPosts, tomorrowPosts);
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
        
        // Find the post data from window.publishedPosts (works for both homepage and static pages)
        const posts = window.publishedPosts || publishedPosts || [];
        const post = posts.find(p => p.id === postId);
        if (!post) return;
        
        // Skip hover effects for DFS articles
        if (post.storyType === 'dfs_article') {
            return;
        }
        
        // Store original content if not already stored
        if (!originalContent.has(postId)) {
            originalContent.set(postId, imageContainer.innerHTML);
        }
        
        // On mouseenter: replace image with breakdown
        indicator.addEventListener('mouseenter', () => {
            const breakdownHtml = generateHeatBreakdown(post);
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
        if (!post) return;
        
        // Calculate the correct score using JavaScript
        const correctScore = calculateHeatScore(post);
        
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
            const hasRedColor = style.includes('#ff0040') || style.includes('color: #ff0040') || style.includes('color:#ff0040');
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
        
        // Skip hover effects for DFS articles
        if (post.storyType === 'dfs_article') {
            return;
        }
        
        if (!originalContent.has(postId)) {
            originalContent.set(postId, imageContainer.innerHTML);
        }
        
        indicator.addEventListener('mouseenter', () => {
            const breakdownHtml = generateHeatBreakdown(post);
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

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

