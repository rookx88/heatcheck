/**
 * Parse date string as local date (avoiding timezone shifts)
 * Handles both ISO format (YYYY-MM-DD) and full datetime strings
 */
function parseLocalDate(dateString: string): Date {
    // If it's already in YYYY-MM-DD format, parse it as local date
    const isoMatch = dateString.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) {
        const [, year, month, day] = isoMatch;
        // month is 0-indexed in Date constructor
        return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    }
    // Otherwise, parse normally and use local components
    const date = new Date(dateString);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
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
        'MLB': 'mlb',
        'NHL': 'nhl',
        'UFC': 'ufc',
        'Soccer': 'soccer',
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






