import { formatDateForNav, formatDateISO, normalizeLeague } from './date-formatter';

export interface RecentDate {
    league: string;
    date: string;
    display: string;
    url: string;
}

/**
 * Generate crawler navigation HTML with league dropdowns and recent dates
 */
export function generateCrawlerNav(recentDates: RecentDate[], baseUrl: string = ''): string {
    // Group dates by league
    const datesByLeague: Record<string, RecentDate[]> = {};
    recentDates.forEach(date => {
        const league = date.league.toUpperCase();
        if (!datesByLeague[league]) {
            datesByLeague[league] = [];
        }
        datesByLeague[league].push(date);
    });

    // Sort dates within each league (most recent first)
    Object.keys(datesByLeague).forEach(league => {
        datesByLeague[league].sort((a, b) => b.date.localeCompare(a.date));
    });

    const leagues = ['NBA', 'NFL', 'EPL'];
    
    // Use relative URLs for local navigation (baseUrl only for canonical/OG tags)
    // For static HTML files, use relative paths so navigation works correctly
    const urlPrefix = '';
    
    let navHtml = '<nav class="crawler-nav" aria-label="Site navigation">\n';
    navHtml += `  <a href="${urlPrefix}/about/" class="nav-link">ABOUT US</a>\n`;
    
    leagues.forEach(league => {
        const leagueLower = normalizeLeague(league);
        const dates = datesByLeague[league] || [];
        
        navHtml += `  <div class="league-nav-item">\n`;
        navHtml += `    <a href="javascript:void(0)" class="nav-link league-link" data-league="${league}">${league} <span class="league-arrow">▶</span></a>\n`;
        navHtml += `    <div class="nav-submenu hidden">\n`;
        navHtml += `      <a href="${urlPrefix}/${leagueLower}/" class="nav-link nav-submenu-item">HUB</a>\n`;
        
        // Add date links (limit to 10 most recent)
        dates.slice(0, 10).forEach(date => {
            navHtml += `      <a href="${urlPrefix}/${leagueLower}/${date.date}/" class="nav-link nav-submenu-item">${date.display}</a>\n`;
        });
        
        navHtml += `    </div>\n`;
        navHtml += `  </div>\n`;
    });
    
    navHtml += `  <a href="${urlPrefix}/archive/" class="nav-link" style="font-size: 0.95rem;">ARCHIVE</a>\n`;
    navHtml += '</nav>';
    
    return navHtml;
}

/**
 * Extract recent dates from posts for navigation
 */
export function extractRecentDates(posts: any[]): RecentDate[] {
    const dateMap = new Map<string, RecentDate>();
    
    posts.forEach(post => {
        const date = post.matchupScheduledDate || post.createdAt;
        if (!date) return;
        
        // Use formatDateISO which now handles timezone issues correctly
        const dateStr = formatDateISO(date);
        const league = (post.league || '').toUpperCase();
        const leagueLower = normalizeLeague(league);
        
        const key = `${league}-${dateStr}`;
        if (!dateMap.has(key)) {
            dateMap.set(key, {
                league,
                date: dateStr,
                display: formatDateForNav(date), // Also uses fixed date parsing
                url: `/${leagueLower}/${dateStr}/`
            });
        }
    });
    
    return Array.from(dateMap.values())
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 30); // Limit to 30 most recent dates
}
