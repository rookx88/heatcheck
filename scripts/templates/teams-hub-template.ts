import { renderHead, topbar, footer } from './waitlist-landing-template';
import { exchangePageStyles } from './exchange-page-styles';
import { escapeHtml } from '../utils/html-escape';
import { RETROSPECTIVE_NOTE } from '../../lib/pages-functions/tickers';
import { SPORT_ORDER, type Sport } from '../../sport-map';
import { HUB_BLURB, NO_FIXTURES_YET, plural } from '../../lib/pages-functions/team-copy';

export interface HubLeague {
    league: string;
    slug: string;
    sport: Sport;
    /** Clubs with at least one settled fixture; 0 means no page exists yet. */
    clubs: number;
    games: number;
}

/**
 * The teams hub (/teams/): every league the slate could carry, grouped by sport. A league
 * with settled fixtures links to its board; one without is listed unlinked, so the roster
 * of competitions is complete and honest on day one.
 */
export function generateTeamsHubPageHtml(baseUrl: string, leagues: HubLeague[]): string {
    const path = '/teams/';
    const title = 'Teams | Heatchecks';
    const description = 'Every league on the Exchange slate, each a board of its clubs sized by games played and coloured by how their results have run against the market price.';
    const schemaOrg = {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Home', item: `${baseUrl}/` },
            { '@type': 'ListItem', position: 2, name: 'Teams', item: `${baseUrl}${path}` },
        ],
    };
    const head = renderHead({ title, description, path, baseUrl, schemaOrg });

    const sections = SPORT_ORDER.map((sport) => {
        const inSport = leagues.filter((l) => l.sport === sport).sort((a, b) => b.games - a.games || a.league.localeCompare(b.league));
        if (inSport.length === 0) return '';
        const items = inSport.map((l) => l.clubs > 0
            ? `<li class="hc-tq-hub-item"><a href="/leagues/${escapeHtml(l.slug)}/">${escapeHtml(l.league)}</a><span class="hc-tq-hub-meta">${escapeHtml(plural(l.clubs, 'club'))} &middot; ${escapeHtml(plural(l.games, 'game'))}</span></li>`
            : `<li class="hc-tq-hub-item is-empty"><span>${escapeHtml(l.league)}</span><span class="hc-tq-hub-meta">${escapeHtml(NO_FIXTURES_YET)}</span></li>`,
        ).join('\n                    ');
        return `<section class="hc-tq-hub-sport" aria-label="${escapeHtml(sport)}">
                <h2 class="hc-tq-section-heading">${escapeHtml(sport)}</h2>
                <ul class="hc-tq-hub-list">
                    ${items}
                </ul>
            </section>`;
    }).join('\n            ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    ${head}
    <link rel="stylesheet" href="/assets/teams.css">
    <style>${exchangePageStyles()}</style>
</head>
<body>
    <main class="hc-page hc-tq-page">
        ${topbar()}
        <div id="teams-chrome-root"></div>
        <div class="hc-tq-board">
            <a class="hc-tq-back" href="/tankdaq/indexes/">&larr; TANKDAQ indexes</a>
            <header class="hc-tq-header">
                <h1 class="hc-tq-title">Teams</h1>
                <p class="hc-tq-desc">${escapeHtml(HUB_BLURB)}</p>
                <p class="hc-tq-note">${escapeHtml(RETROSPECTIVE_NOTE)}</p>
            </header>
            ${sections}
        </div>
        ${footer()}
    </main>
    <script type="module" src="/assets/teams.js" defer></script>
</body>
</html>`;
}
