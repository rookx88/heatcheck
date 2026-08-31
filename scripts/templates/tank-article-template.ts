import { renderHead, footer } from './waitlist-landing-template';
import { escapeHtml } from '../utils/html-escape';
import { repairTruncatedTitle } from '../utils/seo-title';
import type { Prop, Game, TankArticle } from '../../tank-types';
import { formatMarketLabel, formatOddsLabel, formatSettleDate, formatGameTime, effectiveSettleDate, deriveTaglineFallback, truncateHeaderLabel, deriveSidesImpliedProb } from '../../tank-deck-format';

export interface TankPageRecord {
    id: string;
    slug: string;
    league: string;
    angle: string;
    game_snapshot: { prop: Prop; game: Game };
    model_output: TankArticle;
    created_at: string;
    updated_at?: string | null;
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
export function generateTankArticlePage(
    page: TankPageRecord,
    baseUrl: string = 'https://heatchecks.io',
    ogImageUrl?: string,
    // Set only when this article shares a game with another one. Points canonical at
    // the cluster's surviving article so the two stop competing in search; the page
    // itself stays fully live either way. See the cluster logic in generate-static-site.
    canonicalSlug?: string,
    // The matchup card rendered for the page itself (generate-og-image's 'article'
    // variant), shown under the headline. Undefined when that render failed - the
    // figure is then omitted entirely rather than pointing at an image that isn't
    // there. Distinct from ogImageUrl, which is the social PNG a crawler unfurls.
    articleImageUrl?: string,
): string {
    const { prop, game } = page.game_snapshot;
    const { seo, body, hook, cards, call } = page.model_output;
    // The model enforces its own "<= 60 chars" cap by stopping mid-word, so titles can
    // arrive already broken. Repaired once here, then used for <title>, og/twitter,
    // JSON-LD headline and the <h1> alike - they must not diverge.
    const title = repairTruncatedTitle(seo.title, page.slug);
    // tagline is the one new field on TankArticle - already-published rows generated
    // before it existed won't have it, so fall back to a truncated hook rather than
    // showing a blank wall header.
    const tagline = truncateHeaderLabel(page.model_output.tagline || deriveTaglineFallback(hook));

    const url = `${baseUrl}/the-tank/articles/${page.slug}/`;
    const publishedTime = page.published_at || page.created_at;
    // Falls back to publishedTime for rows that predate updated_at being selected, so
    // dateModified is never absent - just equal, which is the honest signal there.
    const modifiedTime = page.updated_at || publishedTime;

    const eventName = `${game.away} @ ${game.home}`;

    const schemaOrg = [
        {
            '@context': 'https://schema.org',
            '@type': 'Article',
            // headline must match the page's visible title - Google treats a mismatch as
            // a structured-data error, and the old "factual headline" built from the prop
            // record stuttered badly on team props, where prop.player holds the matchup:
            // "Arsenal FC vs. Aston Villa FC totals — Arsenal FC @ Aston Villa FC".
            // This is not a break from the rule in the doc comment above: headline is by
            // definition the page's title, and every FACTUAL field below (about, teams,
            // startDate) still comes only from the frozen game_snapshot.
            headline: title,
            // The page's own lead image, which Google lists as recommended for Article
            // and which was previously absent. Not a break from the rule above either:
            // this is the asset this page renders, not a claim about the event.
            ...(ogImageUrl ? { image: [ogImageUrl] } : {}),
            datePublished: publishedTime,
            dateModified: modifiedTime,
            author: { '@type': 'Organization', name: 'HeatChecks' },
            publisher: {
                '@type': 'Organization',
                name: 'HeatChecks',
                url: baseUrl,
                logo: { '@type': 'ImageObject', url: `${baseUrl}/assets/images/heatchecks-logo.png` },
            },
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
        title,
        description: seo.meta_description,
        path: `/the-tank/articles/${page.slug}/`,
        canonicalPath: canonicalSlug ? `/the-tank/articles/${canonicalSlug}/` : undefined,
        baseUrl,
        ogType: 'article',
        schemaOrg,
        articleMeta: {
            publishedTime,
            modifiedTime,
            section: page.league,
        },
        ogImage: ogImageUrl,
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
        gameTimeLabel: truncateHeaderLabel(formatGameTime(game.kickoff)),
        kickoff: game.kickoff,
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
            font-family: 'Montserrat', 'Nunito', sans-serif;
            font-weight: 700;
            font-size: 0.8rem;
            letter-spacing: 0.06em;
            text-transform: uppercase;
            color: var(--hc-teal);
            margin: 0 0 0.6rem;
            text-shadow: 0 0 12px rgba(47,230,217,0.45);
        }
        .tank-article-header .tank-article-gametime {
            font-family: 'Montserrat', 'Nunito', sans-serif;
            font-weight: 600;
            font-size: 0.7rem;
            letter-spacing: 0.04em;
            text-transform: none;
            color: rgba(255,255,255,0.55);
            margin: 0 0 0.6rem;
            text-shadow: none;
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
        /* Matchup card between the headline and the body (generate-og-image's
           'article' variant). Framed like the register banner above - same radius,
           teal hairline and drop shadow - so the two read as one house treatment.
           aspect-ratio plus the img's width/height attrs hold the space before it
           loads, which matters here: it sits above the fold and would otherwise
           shove the whole article down as it arrives. */
        .tank-article-hero {
            margin: 1.5rem 0 0;
            border-radius: 12px;
            overflow: hidden;
            aspect-ratio: 1200 / 630;
            box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45), 0 0 0 2px rgba(47, 230, 217, 0.25);
        }
        .tank-article-hero img { display: block; width: 100%; height: auto; }
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
            font-family: 'Montserrat', 'Nunito', sans-serif;
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
        /* Replaces the shared topbar()'s "Learn more" slot on article pages only -
           built inline here (reusing .hc-topbar/.hc-logo from waitlist-landing-
           template's shared styles) rather than editing topbar() itself, since that
           function is also used by login/account/welcome/claim-your-spot/newsletter
           pages where "Learn more" still belongs. */
        /* The shared topbar's nowrap default (fine for the small "Learn more" link
           it was built for) overflows now that this slot holds a much bigger
           banner - wrap it so the banner drops to its own line on narrow phones
           instead of clipping past the viewport edge. */
        .hc-topbar { flex-wrap: wrap; row-gap: 0.75rem; }
        .tank-article-register-banner {
            display: block;
            width: clamp(220px, 46vw, 420px);
            border-radius: 12px;
            overflow: hidden;
            flex-shrink: 0;
            margin-left: auto;
            box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45), 0 0 0 2px rgba(47, 230, 217, 0.25);
            transition: transform 0.15s ease, filter 0.2s ease;
        }
        .tank-article-register-banner img { display: block; width: 100%; height: auto; }
        .tank-article-register-banner:hover { transform: translateY(-2px); filter: brightness(1.05); }
        .tank-article-register-banner:active { transform: scale(0.97); }
        .tank-article-register-banner:focus-visible { outline: 3px solid var(--hc-teal); outline-offset: 3px; }
        /* "Register, free to play" is the wrong pitch for someone already signed in.
           These pages are static (no session at build time), so the swap keys off what
           the client-side chrome actually resolved to: MapHud only renders its identity
           chip when /api/toolbar-state says logged in, and renders nothing at all while
           hydrating - so the banner is the default and simply drops out once a chip
           appears. No-JS readers and crawlers keep the banner, which is right for them.
           Logged out, MapHud shows its own "Log in" pill next to the banner, matching
           the homepage header's logged-out pairing. */
        .tank-article:has(.map-hud__chip) .tank-article-register-banner { display: none; }
    </style>
</head>
<body>
    <main class="hc-page tank-article">
        <div class="hc-topbar">
            <a class="hc-logo" href="/" aria-label="Heatchecks home">
                <img src="/assets/images/heatchecks-logo.webp" alt="Heatchecks logo" width="500" height="241">
            </a>
            <a class="tank-article-register-banner" href="${baseUrl}/login/" aria-label="Register for HeatChecks - free to play">
                <img src="/assets/images/register-banner.webp" alt="A new way to enjoy sports content - build your pet, team, franchise. Click here, free to play, to start" width="840" height="210" loading="lazy">
            </a>
        </div>

        <!-- Identity chrome slot (ContentChrome, mounted by tank-article-deck.js):
             the username + Ember chip and its mini nav for signed-in readers. Sits
             under the topbar as its own row, the placement ContentChrome.css's
             .hc-chrome-hud is written for - it reserves the chip's height so the
             article doesn't jump when hydration finishes. -->
        <div id="tank-article-chrome"></div>

        <header class="tank-article-header">
            <p>${escapeHtml(game.league)} &middot; ${escapeHtml(eventName)}</p>
            <p class="tank-article-gametime">${escapeHtml(formatGameTime(game.kickoff))}</p>
            <h1>${escapeHtml(title)}</h1>
            <div class="tank-article-divider"></div>
        </header>
${articleImageUrl ? `
        <figure class="tank-article-hero">
            <img src="${escapeHtml(articleImageUrl)}" alt="${escapeHtml(`${game.league} matchup card: ${eventName}`)}" width="1200" height="630" loading="eager">
        </figure>` : ''}

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
