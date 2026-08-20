import { renderHead, topbar, footer } from './waitlist-landing-template';
import { escapeHtml } from '../utils/html-escape';
import type { Prop, Game, TankArticle } from '../../tank-types';
import { formatMarketLabel, formatOddsLabel, formatSettleDate, effectiveSettleDate, deriveTaglineFallback, truncateHeaderLabel, deriveSidesImpliedProb } from '../../tank-deck-format';

export interface TankPageRecord {
    id: string;
    slug: string;
    league: string;
    angle: string;
    game_snapshot: { prop: Prop; game: Game };
    model_output: TankArticle;
    created_at: string;
    published_at: string | null;
}

/**
 * Generate a Tank article page. Critical constraint: the JSON-LD structured data is
 * built ONLY from game_snapshot (the frozen Prop/Game record the curator selected),
 * never from model_output - the model's narrative text never becomes a factual claim
 * in structured data. seo.title/meta_description/body ARE taken from model_output,
 * per the brief, for the human-facing title/meta/article text.
 *
 * Self-contained new-pivot template (like tank-template.ts) - intentionally does NOT
 * use generateBaseHtml(): the old site's chrome (hamburger nav, crawler nav, HeatScan
 * modal) doesn't belong on an article page. The interactive Fishtank artifact
 * (#tank-article-deck-root, hydrated by /assets/tank-article-deck.js) leads the page,
 * directly under the topbar - the plain-text header/body/cards below it are the
 * crawlable, no-JS fallback, same progressive-enhancement pattern as the Tank hub.
 */
export function generateTankArticlePage(page: TankPageRecord, baseUrl: string = 'https://heatchecks.io'): string {
    const { prop, game } = page.game_snapshot;
    const { seo, body, hook, cards, call } = page.model_output;
    // tagline is the one new field on TankArticle - already-published rows generated
    // before it existed won't have it, so fall back to a truncated hook rather than
    // showing a blank wall header.
    const tagline = truncateHeaderLabel(page.model_output.tagline || deriveTaglineFallback(hook));

    const url = `${baseUrl}/the-tank/articles/${page.slug}/`;
    const publishedTime = page.published_at || page.created_at;

    const eventName = `${game.away} @ ${game.home}`;
    const factualHeadline = `${prop.player} ${prop.market.replace(/_/g, ' ')} — ${eventName}`;

    const schemaOrg = [
        {
            '@context': 'https://schema.org',
            '@type': 'Article',
            headline: factualHeadline,
            datePublished: publishedTime,
            dateModified: publishedTime,
            author: { '@type': 'Organization', name: 'HeatChecks' },
            publisher: { '@type': 'Organization', name: 'HeatChecks' },
            mainEntityOfPage: { '@type': 'WebPage', '@id': url },
            about: {
                '@type': 'SportsEvent',
                name: eventName,
                startDate: game.kickoff,
                sport: game.league,
                homeTeam: { '@type': 'SportsTeam', name: game.home },
                awayTeam: { '@type': 'SportsTeam', name: game.away },
            },
        },
    ];

    const head = renderHead({
        title: seo.title,
        description: seo.meta_description,
        path: `/the-tank/articles/${page.slug}/`,
        baseUrl,
        ogType: 'article',
        schemaOrg,
        articleMeta: {
            publishedTime,
            section: page.league,
        },
    });

    const bodyHtml = body
        .split(/\n\s*\n/)
        .map(para => para.trim())
        .filter(Boolean)
        .map(para => `<p>${escapeHtml(para)}</p>`)
        .join('\n                ');

    const cardsHtml = cards.map(card => `<li>${escapeHtml(card)}</li>`).join('\n                    ');

    const deckPayload = JSON.stringify({
        hook, cards, slug: page.slug,
        call: { ...call, sidesImpliedProb: deriveSidesImpliedProb(prop.odds, call.sides.length) },
        tagline,
        contextLabel: truncateHeaderLabel(`${game.league} · ${prop.player}`),
        oddsOrMarketLabel: truncateHeaderLabel(formatOddsLabel(prop.odds) ?? formatMarketLabel(prop.market)),
        settleDateLabel: truncateHeaderLabel(formatSettleDate(effectiveSettleDate(prop, game) ?? '')),
    }).replace(/</g, '\\u003c');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    ${head}
    <link rel="stylesheet" href="/assets/tank-article-deck.css">
    <style>
        .tank-article {
            max-width: 720px;
            margin: 0 auto;
            padding: 0.5rem 1.25rem 3rem;
        }
        .tank-article-header {
            margin-top: 1rem;
            text-align: center;
        }
        .tank-article-header p {
            font-family: 'Nunito', sans-serif;
            font-weight: 700;
            font-size: 0.8rem;
            letter-spacing: 0.06em;
            text-transform: uppercase;
            color: var(--hc-teal);
            margin: 0 0 0.6rem;
            text-shadow: 0 0 12px rgba(47,230,217,0.45);
        }
        .tank-article-header h1 {
            font-family: 'Baloo 2', 'Nunito', sans-serif;
            font-weight: 800;
            font-size: clamp(1.4rem, 5.5vw, 2rem);
            line-height: 1.2;
            margin: 0;
            text-shadow: 0 0 18px rgba(47,230,217,0.2);
        }
        .tank-article-divider {
            width: 64px;
            height: 3px;
            margin: 1.1rem auto 0;
            border-radius: 999px;
            background: linear-gradient(90deg, transparent, var(--hc-teal), transparent);
            opacity: 0.7;
        }
        .tank-article-body {
            margin-top: 1.5rem;
            padding-left: 1rem;
            border-left: 2px solid rgba(47,230,217,0.25);
            font-size: 1rem;
            line-height: 1.7;
            color: rgba(255,255,255,0.85);
        }
        .tank-article-body p {
            margin: 0 0 1.1rem;
        }
        .tank-article-body p:last-child {
            margin-bottom: 0;
        }
        .tank-article-cards {
            list-style: none;
            margin: 1.75rem 0 0;
            padding: 0;
            display: flex;
            flex-direction: column;
            gap: 0.7rem;
        }
        .tank-article-cards li {
            position: relative;
            background: rgba(255,255,255,0.04);
            border: 1px solid rgba(255,255,255,0.1);
            border-left: 3px solid var(--hc-gold);
            border-radius: 12px;
            padding: 0.85rem 1.1rem;
            font-size: 0.92rem;
            line-height: 1.5;
            color: rgba(255,255,255,0.85);
        }
        .tank-article-artifact-section {
            margin-top: 2.5rem;
            text-align: center;
        }
        .tank-article-artifact-label {
            font-family: 'Nunito', sans-serif;
            font-weight: 800;
            font-size: 0.75rem;
            letter-spacing: 0.1em;
            text-transform: uppercase;
            color: var(--hc-gold);
            margin: 0 0 1rem;
        }
        .tank-article-artifact {
            min-height: 420px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .tank-article-back {
            display: inline-block;
            margin-top: 2.5rem;
            font-size: 0.85rem;
            color: rgba(255,255,255,0.6);
            text-decoration: none;
        }
        .tank-article-back:hover { color: #ffffff; }
    </style>
</head>
<body>
    <main class="hc-page tank-article">
        ${topbar(`${baseUrl}/beta/`)}

        <header class="tank-article-header">
            <p>${escapeHtml(game.league)} &middot; ${escapeHtml(eventName)}</p>
            <h1>${escapeHtml(seo.title)}</h1>
            <div class="tank-article-divider"></div>
        </header>

        <div class="tank-article-body">
            ${bodyHtml}
        </div>

        <ul class="tank-article-cards">
            ${cardsHtml}
        </ul>

        <div class="tank-article-artifact-section">
            <p class="tank-article-artifact-label">Make The Call</p>
            <div class="tank-article-artifact">
                <div id="tank-article-deck-root" data-hook="${escapeHtml(hook)}"></div>
                <script type="application/json" id="tank-article-deck-data">${deckPayload}</script>
            </div>
        </div>

        <a class="tank-article-back" href="${baseUrl}/the-tank-hq/">&larr; Back to The Tank HQ</a>

        ${footer()}
    </main>
    <script type="module" src="/assets/tank-article-deck.js" defer></script>
</body>
</html>`;
}
