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

    const leagues = ['NBA', 'NFL', 'EPL', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1', 'DFS'];
    
    // Use relative URLs for local navigation (baseUrl only for canonical/OG tags)
    // For static HTML files, use relative paths so navigation works correctly
    const urlPrefix = '';
    
    let navHtml = '<nav class="crawler-nav" aria-label="Site navigation">\n';
    navHtml += `  <a href="${urlPrefix}/heat-picks/" class="nav-link" style="display: inline-flex; align-items: center; gap: 0.2rem;"><span style="color: #ff1a1a;">HEAT</span><span style="color: #fff;">Picks</span></a>\n`;
    navHtml += `  <a href="${urlPrefix}/about/" class="nav-link">ABOUT US</a>\n`;
    
    leagues.forEach(league => {
        const leagueLower = normalizeLeague(league);
        // Normalize league name to uppercase for lookup (datesByLeague uses uppercase keys)
        const leagueKey = league.toUpperCase();
        const dates = datesByLeague[leagueKey] || [];
        
        navHtml += `  <div class="league-nav-item">\n`;
        // IMPORTANT: Use a real href so search engines can crawl these links.
        // JS will still intercept clicks (toggle submenu) via initCrawlerNavInteractivity().
        const leagueHref = league === 'DFS' ? `${urlPrefix}/dfs/` : `${urlPrefix}/${leagueLower}/`;
        navHtml += `    <a href="${leagueHref}" class="nav-link league-link" data-league="${league}">${league} <span class="league-arrow">▶</span></a>\n`;
        navHtml += `    <div class="nav-submenu hidden">\n`;
        
        // DFS: show HUB + most recent DFS date (if present)
        if (league === 'DFS') {
            navHtml += `      <a href="${urlPrefix}/dfs/" class="nav-link nav-submenu-item">HUB</a>\n`;
            const latest = dates[0];
            if (latest) {
                navHtml += `      <a href="${latest.url}" class="nav-link nav-submenu-item">${latest.display}</a>\n`;
            }
        } else {
            navHtml += `      <a href="${urlPrefix}/${leagueLower}/" class="nav-link nav-submenu-item">HUB</a>\n`;
            
            // Add ONLY the most recent date link (if any)
            const latest = dates[0];
            if (latest) {
                navHtml += `      <a href="${latest.url}" class="nav-link nav-submenu-item">${latest.display}</a>\n`;
            }
        }
        
        navHtml += `    </div>\n`;
        navHtml += `  </div>\n`;
    });
    
    navHtml += `  <a href="${urlPrefix}/archive/" class="nav-link" style="font-size: 0.95rem;">ARCHIVE</a>\n`;
    navHtml += `  <a href="https://x.com/heatchecksio" target="_blank" rel="noopener noreferrer" aria-label="Follow HeatChecks on X (Twitter)" class="nav-link twitter-icon-link" style="font-size: 0.95rem; display: flex; align-items: center; justify-content: center; padding-top: 0.5rem; margin-top: 0.5rem; border-top: 1px solid rgba(255, 255, 255, 0.2);"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" style="flex-shrink: 0;"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg></a>\n`;
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
        const storyType = String(post.storyType || '').toLowerCase();
        // Normalize league name FIRST (before uppercasing) to get correct URL format
        const leagueRaw = String(post.league || '');
        const leagueLower = normalizeLeague(leagueRaw);
        const leagueUpper = leagueRaw.toUpperCase();

        // DFS articles live under /dfs/{sport}/{date}/ and should NOT pollute the main league nav
        if (storyType === 'dfs_article') {
            const dfsSport = leagueLower; // nba | nfl | epl
            const dfsKey = `DFS-${dfsSport}-${dateStr}`;
            if (!dateMap.has(dfsKey)) {
                dateMap.set(dfsKey, {
                    league: 'DFS',
                    date: dateStr,
                    display: `${formatDateForNav(date)} ${leagueUpper}`, // e.g., "Jan 15 NBA"
                    url: `/dfs/${dfsSport}/${dateStr}/`
                });
            }
            return;
        }

        const key = `${leagueUpper}-${dateStr}`;
        if (!dateMap.has(key)) {
            dateMap.set(key, {
                league: leagueUpper,
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
