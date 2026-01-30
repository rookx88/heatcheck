/**
 * Parse date string as local date (avoiding timezone shifts)
 * Handles both ISO format (YYYY-MM-DD) and full datetime strings
 */
function parseLocalDate(dateString: string): Date {
    // Extract YYYY-MM-DD from the beginning of the string (handles both "2026-01-30" and "2026-01-30T08:00:00.000Z")
    const isoMatch = dateString.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) {
        const [, year, month, day] = isoMatch;
        // month is 0-indexed in Date constructor
        // Always use local date components to avoid timezone shifts
        return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    }
    // Fallback: try to parse and extract local components (should rarely be needed)
    try {
    const date = new Date(dateString);
        if (isNaN(date.getTime())) {
            throw new Error('Invalid date');
        }
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
    } catch (e) {
        // If all else fails, return current date
        console.warn('Failed to parse date:', dateString, e);
        return new Date();
    }
}

/**
 * Format date to "Jan 7" format for navigation links
 */
export function formatDateForNav(dateString: string): string {
    const date = parseLocalDate(dateString);
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = monthNames[date.getMonth()];
    const day = date.getDate();
    return `${month} ${day}`;
}

/**
 * Format date to MM/DD format for post cards
 */
export function formatDateForCard(dateString: string): string {
    if (!dateString) return '';
    const date = parseLocalDate(dateString);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${month}/${day}`;
}

/**
 * Format date to YYYY-MM-DD format
 */
export function formatDateISO(dateString: string): string {
    const date = parseLocalDate(dateString);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * Normalize league name to URL-friendly format
 */
export function normalizeLeague(league: string): string {
    const leagueMap: Record<string, string> = {
        'NBA': 'nba',
        'NFL': 'nfl',
        'EPL': 'epl',
        'Premier League': 'epl',
        'LaLiga': 'laliga',
        'La Liga': 'laliga',
        'Serie A': 'serie-a',
        'Bundesliga': 'bundesliga',
        'Ligue 1': 'ligue-1',
        'MLB': 'mlb',
        'NHL': 'nhl',
        'UFC': 'ufc',
        'Soccer': 'soccer',
        'DFS': 'dfs',
    };
    
    return leagueMap[league] || league.toLowerCase().replace(/\s+/g, '-');
}

/**
 * Extract short team name from full team name
 * Examples: "New England Patriots" -> "Patriots", "Los Angeles Lakers" -> "Lakers"
 * Handles special cases like "San Francisco 49ers" -> "49ers", "Green Bay Packers" -> "Packers"
 */
export function getShortTeamName(fullName: string): string {
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
export function getTeamAcronym(fullName: string, league?: string): string {
    if (!fullName) return '';
    
    const trimmed = fullName.trim();
    if (!trimmed) return '';
    
    // Normalize for matching (case-insensitive)
    const normalized = trimmed.toLowerCase();
    
    // NBA abbreviations
    const nbaAbbrev: Record<string, string> = {
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
    const nflAbbrev: Record<string, string> = {
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
    const eplAbbrev: Record<string, string> = {
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
        const leagueUpper = league.toUpperCase();
        if (leagueUpper === 'NBA' && nbaAbbrev[normalized]) return nbaAbbrev[normalized];
        if (leagueUpper === 'NFL' && nflAbbrev[normalized]) return nflAbbrev[normalized];
        if ((leagueUpper === 'EPL' || leagueUpper === 'PREMIER LEAGUE') && eplAbbrev[normalized]) return eplAbbrev[normalized];
    }
    
    // Fallback: generate from first letters of words (up to 3)
    const words = trimmed.split(/\s+/).filter(w => w.length > 0);
    if (words.length === 1) {
        // Single word: take first 3 letters, uppercase
        return words[0].substring(0, 3).toUpperCase();
    }
    
    // Multiple words: take first letter of first 3 words
    const acronym = words.slice(0, 3).map(w => w[0]).join('').toUpperCase();
    return acronym.length >= 3 ? acronym.substring(0, 3) : acronym.padEnd(3, 'X');
}






