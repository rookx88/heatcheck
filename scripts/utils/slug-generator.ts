/**
 * Generate URL-friendly slug from headline
 */
export function generateSlug(headline: string): string {
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
 * Keywords: revenge, rivalry, redemption, motivation, pressure, vendetta, grudge, homecoming, return
 */
export function extractNarrativeKeywords(headline: string, emotionTags?: string[]): string {
    const headlineLower = headline.toLowerCase();
    const allTags = (emotionTags || []).map(t => t.toLowerCase());
    
    // Priority narrative keywords (ordered by importance for SEO)
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
    // Skip common words (the, a, an, in, on, at, vs, vs., v, v.)
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
 * Format: {teamA}-vs-{teamB}-{narrative-keyword}
 */
export function generateNarrativeSlug(
    headline: string,
    teamA: string,
    teamB: string,
    emotionTags?: string[]
): string {
    // Normalize team names to short names and lowercase
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
 * Ensure slug is unique by appending a number if needed
 */
export function ensureUniqueSlug(slug: string, existingSlugs: Set<string>): string {
    if (!existingSlugs.has(slug)) {
        return slug;
    }
    
    let counter = 1;
    let uniqueSlug = `${slug}-${counter}`;
    while (existingSlugs.has(uniqueSlug)) {
        counter++;
        uniqueSlug = `${slug}-${counter}`;
    }
    
    return uniqueSlug;
}

/**
 * Generate matchup slug for URL path: {teamA-short}-vs-{teamB-short}
 * This is used in the URL structure: /{league}/{date}/{matchup}/{narrative-slug}
 */
export function generateMatchupSlug(teamA: string, teamB: string, getShortTeamName: (name: string) => string): string {
    const teamAShort = getShortTeamName(teamA).toLowerCase();
    const teamBShort = getShortTeamName(teamB).toLowerCase();
    
    const matchupSlug = `${teamAShort}-vs-${teamBShort}`
        .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
        .replace(/\s+/g, '-') // Replace spaces with hyphens
        .replace(/-+/g, '-') // Replace multiple hyphens
        .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens
    
    return matchupSlug;
}








