import { renderHead, topbar, footer } from './waitlist-landing-template';
import { exchangePageStyles } from './exchange-page-styles';
import { escapeHtml } from '../utils/html-escape';
import { RETROSPECTIVE_NOTE } from '../../lib/pages-functions/tickers';
import { PRICE_NOTE, windowReturnPct } from '../../lib/pages-functions/ticker-price';
import { formatEmber, formatSignedPct, signOf } from '../../lib/pages-functions/ticker-format';
import { leagueSlug, type TeamPageModel } from '../../lib/pages-functions/team-pages';
import {
    gameOutcome, gameSentence, possessive, signedResidual, teamBlurb, teamHeadline, teamReadLine,
} from '../../lib/pages-functions/team-copy';
import { renderTeamChartSvg } from '../../lib/pages-functions/team-chart';

/**
 * Team page (/teams/<slug>/) - one club, in the index page's exact visual language.
 *
 * Past the games gate the club is PRICED, and the page is the index detail page's shape:
 * the Ember price as the headline with its window return beside it, the points value and
 * the market residual demoted to the secondary line, a one-sentence read, and a windowed
 * price chart (24H/3D/1W). The price is team-price.ts's - the index close formula over the
 * club's own games plus the Tank tags whose side is the club - and the chart's toggle is
 * the island's (teams-client.tsx), which re-renders #team-price-root from the model baked
 * into #team-page-data. Everything else on the page is server-rendered and stays.
 *
 * Below the gate the page still exists and lists every game - each row is a fact about
 * one game that needs no threshold - but posts no price and no residual. A price at n=3 is
 * one game's surprise exponentiated, and the copy says so instead.
 */
export function generateTeamPageHtml(baseUrl: string, model: TeamPageModel): string {
    const { team } = model;
    const slug = team.id;
    const path = `/teams/${slug}/`;
    const leadLeague = model.leagues[0] ?? null;
    const leadLeagueSlug = leadLeague ? leagueSlug(leadLeague) : null;
    const headline = teamHeadline(model);
    const readLine = teamReadLine(model);
    const blurb = teamBlurb(model);
    const chart = renderTeamChartSvg(model.series, team.display);
    const pricing = model.pricing;

    const title = `${team.display} | Teams | Heatchecks`;
    const description = `How ${possessive(team.display)} settled games have run against the market's pre-kickoff price on the Exchange slate. Retrospective only.`;

    const crumbs: Array<{ name: string; item: string }> = [
        { name: 'Home', item: `${baseUrl}/` },
        { name: 'Teams', item: `${baseUrl}/teams/` },
    ];
    if (leadLeague && leadLeagueSlug) crumbs.push({ name: leadLeague, item: `${baseUrl}/leagues/${leadLeagueSlug}/` });
    crumbs.push({ name: team.display, item: `${baseUrl}${path}` });
    const schemaOrg = {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: c.item })),
    };
    const head = renderHead({ title, description, path, baseUrl, schemaOrg });

    const chips = model.leagues.map((l) =>
        `<a class="hc-tq-league" href="/leagues/${escapeHtml(leagueSlug(l))}/">${escapeHtml(l)}</a>`).join('');

    const games = model.fixtures.map((f) => {
        const outcome = gameOutcome(f);
        const sign = outcome === 'won' ? 'pos' : outcome === 'appeared' ? 'zero' : 'neg';
        const chip = outcome === 'won' ? 'W' : outcome === 'lost' ? 'L' : outcome === 'did not win' ? 'DNW' : '\u2014';
        return `<li><span class="hc-tq-chip is-${sign}" title="${escapeHtml(outcome)}">${chip}</span>${escapeHtml(gameSentence(f, slug))}</li>`;
    }).join('\n                            ');

    const byLeague = model.record && model.record.byLeague.length > 0
        ? `<table class="hc-tq-table">
                            <thead><tr><th>Competition</th><th class="is-num">Games</th><th class="is-num">Won</th><th class="is-num">Residual</th></tr></thead>
                            <tbody>
                            ${model.record.byLeague.map((l) => `<tr>
                                <td><a href="/leagues/${escapeHtml(leagueSlug(l.league))}/">${escapeHtml(l.league)}</a></td>
                                <td class="is-num">${l.games}</td>
                                <td class="is-num">${l.wins}</td>
                                <td class="is-num"><span class="is-${signOf(l.residual)}">${escapeHtml(signedResidual(l.residual))}</span></td>
                            </tr>`).join('\n                            ')}
                            </tbody>
                        </table>`
        : `<p class="hc-tq-muted">The slate has held no directional position on ${escapeHtml(team.display)} yet, so there is nothing to break down by competition.</p>`;

    // The secondary line under either headline: the record and the market's average price.
    const recordLine = model.record
        ? `Won <span class="is-pos">${model.record.wins}</span>${model.record.didNotWin > 0 ? ` of ${model.record.games}` : ` &middot; lost <span class="is-neg">${model.record.losses}</span>`} &middot; market priced ${escapeHtml(model.record.avgEntryProb ? `${Math.round(model.record.avgEntryProb * 100)}%` : '\u2014')} on average`
        : '';

    let mainBlock: string;
    if (pricing && headline && model.record) {
        // PRICED. Server-rendered snapshot of the all-time window - the island swaps in the
        // 24H/3D/1W toggle and the price chart from the JSON below.
        const params = { baseline: pricing.priceBaseline, scale: pricing.priceScale };
        const allTimeRet = windowReturnPct(pricing.value, 0, params);
        const sign = signOf(allTimeRet);
        mainBlock = `<div id="team-price-root">
                        <div class="hc-tq-value-row">
                            <span class="hc-tq-price">${escapeHtml(formatEmber(pricing.price))}<span class="hc-tq-ember">Ember</span></span>
                            <span class="hc-tq-return is-${sign}">(${escapeHtml(formatSignedPct(allTimeRet))})</span>
                            <span class="hc-tq-delta24-label">Ember price &middot; all-time change</span>
                        </div>
                        <p class="hc-tq-index-line">Points <span class="is-${signOf(pricing.value)}">${escapeHtml(formatSignedPct(pricing.value).replace('%', ''))}</span> all-time &middot; ${escapeHtml(headline.label)} <span class="is-${signOf(model.record.residual)}">${escapeHtml(headline.value)}</span></p>
                        <p class="hc-tq-index-line">${recordLine}</p>
                        <p class="hc-tq-read">${escapeHtml(readLine)}</p>
                        <div class="hc-tq-chart-panel">
                            ${chart}
                            <p class="hc-tq-chart-legend"><span><span class="hc-tq-legend-swatch" style="background:#94a3b8"></span>Running market residual, by kickoff</span></p>
                        </div>
                    </div>
                    <script type="application/json" id="team-page-data">${JSON.stringify({
                        slug,
                        display: team.display,
                        pricing,
                        residual: model.record.residual,
                        residualLabel: headline.label,
                        residualValue: headline.value,
                        recordLine,
                        readLine,
                    }).replace(/</g, '\\u003c')}</script>`;
    } else if (headline && model.record) {
        // Qualifying club with no price events yet (cannot happen once a game has closed,
        // kept so a page never renders blank).
        mainBlock = `<div class="hc-tq-value-row">
                        <span class="hc-tq-price is-${signOf(model.record.residual)}">${escapeHtml(headline.value)}</span>
                        <span class="hc-tq-delta24-label">${escapeHtml(headline.label)}</span>
                    </div>
                    <p class="hc-tq-index-line">${recordLine}</p>
                    <p class="hc-tq-read">${escapeHtml(readLine)}</p>
                    <div class="hc-tq-chart-panel">
                        ${chart || `<p class="hc-tq-chart-note">No directional games to chart yet.</p>`}
                    </div>`;
    } else {
        // Below the gate: no price, no residual figure - the games speak for themselves.
        mainBlock = `<p class="hc-tq-read">${escapeHtml(readLine)}</p>
                    <div class="hc-tq-chart-panel">
                        ${chart || `<p class="hc-tq-chart-note">No directional games to chart yet.</p>`}
                        ${chart ? `<p class="hc-tq-chart-legend"><span><span class="hc-tq-legend-swatch" style="background:#94a3b8"></span>Running market residual, by kickoff</span></p>` : ''}
                    </div>`;
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
    ${head}
    <!-- Emitted by esbuild from the island's component imports (MapHud/PetWidget/
         NotificationsHost chrome) - without it the identity HUD renders unstyled. -->
    <link rel="stylesheet" href="/assets/teams.css">
    <style>${exchangePageStyles()}</style>
</head>
<body>
    <main class="hc-page hc-tq-page">
        ${topbar()}
        <div id="teams-chrome-root"></div>
        <div class="hc-tq-board">
            ${leadLeague && leadLeagueSlug ? `<a class="hc-tq-back" href="/leagues/${escapeHtml(leadLeagueSlug)}/">&larr; ${escapeHtml(leadLeague)} board</a>` : `<a class="hc-tq-back" href="/teams/">&larr; All leagues</a>`}
            <header class="hc-tq-header">
                <h1 class="hc-tq-title">${escapeHtml(team.display)}</h1>
                <p class="hc-tq-desc">${escapeHtml(blurb)}</p>
                ${chips ? `<p class="hc-tq-leagues">${chips}</p>` : ''}
                <p class="hc-tq-note">${escapeHtml(RETROSPECTIVE_NOTE)}</p>
                ${pricing ? `<p class="hc-tq-note">${escapeHtml(PRICE_NOTE)}</p>` : ''}
            </header>
            <div class="hc-tq-layout">
                <div class="hc-tq-main">
                    ${mainBlock}
                </div>
                <div class="hc-tq-side">
                    <aside class="hc-tq-results-panel" aria-label="Games">
                        <h2 class="hc-tq-section-heading">Games</h2>
                        <p class="hc-tq-movers-sub">Every settled game the club appeared in, newest first. A chip marks the club's own side where the slate held one.</p>
                        ${games ? `<ul class="hc-tq-results-list">
                            ${games}
                        </ul>` : `<p class="hc-tq-muted">No settled games yet.</p>`}
                    </aside>
                </div>
                <div class="hc-tq-news">
                    <section aria-label="By competition">
                        <h2 class="hc-tq-section-heading">By competition</h2>
                        ${byLeague}
                    </section>
                    <p class="hc-tq-muted" style="margin-top:1.2rem"><a href="/teams/" style="color:var(--hc-gold)">All leagues</a>${leadLeague && leadLeagueSlug ? ` &middot; <a href="/leagues/${escapeHtml(leadLeagueSlug)}/" style="color:var(--hc-gold)">${escapeHtml(leadLeague)} board</a>` : ''} &middot; <a href="/tankdaq/indexes/" style="color:var(--hc-gold)">TANKDAQ indexes</a></p>
                </div>
            </div>
        </div>
        ${footer()}
    </main>
    <script type="module" src="/assets/teams.js" defer></script>
</body>
</html>`;
}
