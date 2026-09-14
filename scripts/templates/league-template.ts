import { renderHead, topbar, footer } from './waitlist-landing-template';
import { exchangePageStyles, leagueBoardStyles } from './exchange-page-styles';
import { escapeHtml } from '../utils/html-escape';
import { RETROSPECTIVE_NOTE } from '../../lib/pages-functions/tickers';
import { PRICE_NOTE } from '../../lib/pages-functions/ticker-price';
import { formatEmber } from '../../lib/pages-functions/ticker-format';
import { rosterOrder, type LeagueBoardModel } from '../../lib/pages-functions/team-pages';
import { leagueBlurb, plural, signedResidual, tileQuote } from '../../lib/pages-functions/team-copy';

/**
 * League page (/leagues/<slug>/) - one competition's clubs as a treemap, plus the roster
 * as a table. Static shell + island: the board itself is teams-client.tsx's work (it
 * needs a measured width for gutters and type), rendered from the model baked into
 * #league-page-data. Tile AREA is games played here; past the gate a tile carries the
 * club's Ember price and is coloured by that price against its 100 baseline. The crawlable
 * fallback inside the board frame and the roster table below it are the SEO path to every
 * team page.
 */
export function generateLeaguePageHtml(baseUrl: string, board: LeagueBoardModel): string {
    const path = `/leagues/${board.slug}/`;
    const title = `${board.league} | Teams | Heatchecks`;
    const description = `Every ${board.league} club on the Exchange slate, sized by games played and priced in Ember by how its settled results have run against the market's pre-kickoff price. Retrospective only.`;
    const schemaOrg = {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Home', item: `${baseUrl}/` },
            { '@type': 'ListItem', position: 2, name: 'Teams', item: `${baseUrl}/teams/` },
            { '@type': 'ListItem', position: 3, name: board.league, item: `${baseUrl}${path}` },
        ],
    };
    const head = renderHead({ title, description, path, baseUrl, schemaOrg });

    const roster = rosterOrder(board.tiles);
    const qualifying = roster.filter((t) => t.residual !== null).length;

    const fallback = roster.map((t) =>
        `<li><a href="/teams/${escapeHtml(t.slug)}/">${escapeHtml(t.display)}</a> &mdash; ${t.price !== null ? `${escapeHtml(formatEmber(t.price))} Ember &middot; ` : ''}${escapeHtml(tileQuote(t))}</li>`,
    ).join('\n                    ');

    const rows = roster.map((t, i) => `<tr>
                            <td>${t.residual !== null ? `<span class="hc-tq-rank">${i + 1}</span>` : ''}<a href="/teams/${escapeHtml(t.slug)}/">${escapeHtml(t.display)}</a></td>
                            <td class="is-num">${t.fixtures}</td>
                            <td class="is-num">${t.games}</td>
                            <td class="is-num">${t.price === null ? '<span class="hc-tq-muted">&mdash;</span>' : escapeHtml(formatEmber(t.price))}</td>
                            <td class="is-num">${t.residual === null ? '<span class="hc-tq-muted">&mdash;</span>' : `<span class="is-${t.sign}">${escapeHtml(signedResidual(t.residual))}</span>`}</td>
                        </tr>`).join('\n                        ');

    // The model the island renders from. '<' is escaped so a club name can never close
    // the script block (tank-article-template.ts's idiom).
    const data = JSON.stringify(board).replace(/</g, '\\u003c');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    ${head}
    <link rel="stylesheet" href="/assets/teams.css">
    <style>${exchangePageStyles()}${leagueBoardStyles()}</style>
</head>
<body>
    <main class="hc-page hc-tq-page">
        ${topbar(null)}
        <div id="teams-chrome-root"></div>
        <div class="hc-tq-board">
            <a class="hc-tq-back" href="/teams/">&larr; All leagues</a>
            <header class="hc-tq-header">
                <h1 class="hc-tq-title">${escapeHtml(board.league)} <span class="hc-tq-symbol">clubs</span></h1>
                <p class="hc-tq-desc">${escapeHtml(leagueBlurb(board.league, board.minGames))}</p>
                <p class="hc-tq-note">${escapeHtml(RETROSPECTIVE_NOTE)} ${escapeHtml(plural(board.games, 'settled game'))} on the slate; ${qualifying} of ${board.tiles.length} clubs past the ${board.minGames}-game line.</p>
                <p class="hc-tq-note">${escapeHtml(PRICE_NOTE)}</p>
            </header>
            <div id="league-root" class="hc-lgb-board" role="list" aria-label="${escapeHtml(board.league)} clubs">
                <!-- Crawlable roster, replaced when the island mounts. -->
                <ul class="hc-lgb-fallback">
                    ${fallback}
                </ul>
            </div>
            <script type="application/json" id="league-page-data">${data}</script>
            <p class="hc-lgb-legend">
                <span><span class="hc-lgb-swatch" style="color:#3ddc64"></span>Priced above 100 &mdash; results ran ahead of the market</span>
                <span><span class="hc-lgb-swatch" style="color:#ff6b57"></span>Priced below 100 &mdash; results ran behind</span>
                <span><span class="hc-lgb-swatch" style="color:#94a3b8"></span>Under ${board.minGames} directional games &mdash; not yet priced</span>
            </p>
            <p class="hc-lgb-hint">Tile size is games played in ${escapeHtml(board.league)}; colour is the club's Ember price against its 100 baseline. Hover or tap a club for its record; click through for its page.</p>
            <section aria-label="Roster">
                <h2 class="hc-tq-section-heading">Clubs</h2>
                <div style="overflow-x:auto">
                    <table class="hc-tq-table">
                        <thead><tr><th>Club</th><th class="is-num">Games here</th><th class="is-num">Directional</th><th class="is-num">Price</th><th class="is-num">Residual</th></tr></thead>
                        <tbody>
                        ${rows}
                        </tbody>
                    </table>
                </div>
            </section>
            <p class="hc-tq-muted" style="margin-top:1.2rem"><a href="/teams/" style="color:var(--hc-gold)">All leagues</a> &middot; <a href="/tankdaq/indexes/" style="color:var(--hc-gold)">TANKDAQ indexes</a></p>
        </div>
        ${footer()}
    </main>
    <script type="module" src="/assets/teams.js" defer></script>
</body>
</html>`;
}
