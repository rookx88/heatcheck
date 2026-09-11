import { renderHead, footer } from './waitlist-landing-template';
import { escapeHtml } from '../utils/html-escape';
import { repairTruncatedTitle } from '../utils/seo-title';
import type { Prop, Game, TankArticle } from '../../tank-types';
import { formatMarketLabel, formatOddsLabel, formatSettleDate, formatGameTime, effectiveSettleDate, deriveTaglineFallback, truncateHeaderLabel, deriveSidesImpliedProb, hasShowablePrices, MARKET_PANEL_NOTE } from '../../tank-deck-format';
import { isYesNo, sideLabelsFor } from '../../market-movement';

export interface TankResolution {
    status: 'resolved' | 'abandoned';
    blurb?: string;
    winning_index?: number;
    winning_side?: string;
    resolved_at?: string;
    reason?: string;
}

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
    // Stage 3 (functions/api/tank-resolution-sweep.ts). Null for every Tank whose market
    // hasn't settled yet, for pre-v2 Tanks, and against a database that hasn't had
    // add_curation_and_resolution_to_tank_pages.sql run - all of which simply render no
    // resolution section.
    resolution?: TankResolution | null;
}

// "Sep 8" - the date a Tank's story was written (tank_pages.created_at, i.e. curation),
// which is when its frozen prices were taken. Not published_at: a human publishes hours
// or days after the story is written, and the prices belong to the writing.
function writtenDateLabel(value: string | Date): string {
    const d = new Date(value);
    return Number.isNaN(d.getTime())
        ? 'date unknown'
        : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
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

    // How the story ended. Rendered ONLY for a resolution that actually produced a blurb -
    // an 'abandoned' row (a market that never resolved) deliberately renders nothing at
    // all rather than admitting to the reader that we stopped checking.
    //
    // Server-rendered, not hydrated: this is the one piece of the page a crawler most
    // wants and an AI answer engine is most likely to quote, and it costs nothing to bake
    // in - the sweep writes the column, the next build (any publish rebuilds every
    // article) picks it up. Sits directly under the body so it reads as the last beat of
    // the story rather than a footnote below the deck.
    const resolutionHtml = page.resolution?.status === 'resolved' && page.resolution.blurb?.trim()
        ? `
                <aside class="tank-article-resolution">
                    <h2>How it ended</h2>
                    <p>${escapeHtml(page.resolution.blurb.trim())}</p>
                    ${page.resolution.winning_side
                        ? `<p class="tank-article-resolution-side">Resolved: <strong>${escapeHtml(page.resolution.winning_side)}</strong></p>`
                        : ''}
                </aside>`
        : '';

    // "Polymarket prices" - the live market panel's server-rendered fallback, plus the seed
    // its island (components/ArticleMarket.tsx) needs to fetch this market's current prices
    // from /api/tank-market. The fallback is the price frozen when this story was written,
    // explicitly DATED, so a no-JS reader or crawler is never shown an old number as if it
    // were current. Only Polymarket markets get the panel (their ids are numeric; Kalshi's
    // start with "KX"), and only two-outcome ones, which is every game line we curate. A
    // dead book shows no percentages at all - never a fake 50/50.
    let marketSectionHtml = '';
    if (/^\d{1,12}$/.test(String(prop.id ?? '')) && prop.odds && prop.odds.outcomes.length === 2) {
        const outcomes = prop.odds.outcomes;
        // Display names: a spread side carries its line ("Chelsea FC -2.5"), since its
        // price is the price of covering, not of winning. See sideLabelsFor.
        const labels = sideLabelsFor(prop);
        const yesNo = isYesNo(outcomes);
        const question = prop.question?.trim() || null;
        // A Yes/No market with no question on record can't say what "Yes" means, so it
        // shows no prices rather than unlabelled ones; the island fills in Gamma's wording.
        const unlabelled = yesNo && !question;
        const showable = hasShowablePrices(prop.odds, prop.book) && !unlabelled;
        let writtenPct: number[] | null = null;
        if (showable) {
            const first = Math.round(prop.odds.outcomePrices[0] * 100);
            writtenPct = [first, 100 - first];
        }
        const writtenLabel = writtenDateLabel(page.created_at);
        const seed = JSON.stringify({
            marketId: String(prop.id),
            kickoff: game.kickoff ?? null,
            writtenLabel,
            outcomes,
            labels,
            writtenPct,
            question,
        }).replace(/</g, '\\u003c');
        const rows = writtenPct
            ? labels.map((label, i) => `<li><span>${escapeHtml(label)}</span><span>${writtenPct![i]}%</span></li>`).join('')
            : '';
        const fallbackBody = writtenPct
            ? `<p class="tank-article-market-meta">When this story was written (${escapeHtml(writtenLabel)})</p>
                        <ul class="tank-article-market-rows">${rows}</ul>`
            : unlabelled
                ? ''
                : `<p class="tank-article-market-meta">Not enough trading on this market to show a price when this story was written (${escapeHtml(writtenLabel)}).</p>`;
        marketSectionHtml = `
                <section id="tank-article-market" class="tank-article-market">
                    <h2 class="tank-article-market-heading">Polymarket prices</h2>
                    <div class="tank-article-market-fallback">
                        ${yesNo && question ? `<p class="tank-article-market-question">${escapeHtml(question)}</p>` : ''}
                        ${fallbackBody}
                        <p class="tank-article-market-note">${escapeHtml(MARKET_PANEL_NOTE)}</p>
                    </div>
                    <script type="application/json" id="tank-article-market-data">${seed}</script>
                </section>
`;
    }

    const deckPayload = JSON.stringify({
        hook, cards, slug: page.slug,
        call: { ...call, sidesImpliedProb: deriveSidesImpliedProb(prop.odds, call.sides.length, prop.book) },
        tagline,
        contextLabel: truncateHeaderLabel(`${game.league} · ${prop.player}`),
        oddsOrMarketLabel: truncateHeaderLabel(formatOddsLabel(prop.odds, prop.book) ?? formatMarketLabel(prop.market)),
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
        /* "How it ended" - the settled callback. Gold rather than the page's teal, and
           set apart from the body's left rule, because it is the one block on the page
           written after the fact: it should read as a later addition to the story, not
           as part of the original piece. */
        .tank-article-resolution {
            margin-top: 1.75rem;
            padding: 1rem 1.15rem;
            border: 1px solid rgba(255,255,255,0.12);
            border-left: 3px solid var(--hc-gold);
            border-radius: 12px;
            background: rgba(255,255,255,0.04);
        }
        .tank-article-resolution h2 {
            font-family: 'Montserrat', 'Nunito', sans-serif;
            font-weight: 800;
            font-size: 0.72rem;
            letter-spacing: 0.14em;
            text-transform: uppercase;
            color: var(--hc-gold);
            margin: 0 0 0.55rem;
        }
        .tank-article-resolution p {
            margin: 0;
            font-size: 0.95rem;
            line-height: 1.6;
            color: rgba(255,255,255,0.85);
        }
        .tank-article-resolution-side {
            margin-top: 0.6rem !important;
            font-size: 0.82rem !important;
            color: rgba(255,255,255,0.55) !important;
        }
        .tank-article-resolution-side strong { color: rgba(255,255,255,0.85); }
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

        /* "Indexes this story moved" - the TANKDAQ tile look (black face, lit corner,
           neon edge by direction) in a plain wrapping row rather than a treemap: with
           2-4 tiles there is no area to encode, so tile size must not pretend to mean
           anything. Colours match tankdaq-indexes-template.ts exactly. */
        .hc-tai-heading {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.78rem;
            letter-spacing: 0.14em; text-transform: uppercase; color: var(--hc-teal);
            margin: 1.9rem 0 0.2rem;
        }
        .hc-tai-sub { margin: 0 0 0.9rem; font-size: 0.8rem; color: rgba(255,255,255,0.5); }
        .hc-tai-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.8rem; }
        .hc-tai-row { display: flex; align-items: stretch; gap: 0.85rem; }
        .hc-tai-tile {
            flex: 0 0 auto; width: 116px; min-height: 84px;
            display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.15rem;
            text-decoration: none; text-align: center;
            background:
                linear-gradient(158deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.02) 38%, rgba(0,0,0,0) 60%),
                #000000;
            border-radius: 6px; box-sizing: border-box;
            transition: filter 0.16s ease, transform 0.16s ease;
        }
        .hc-tai-tile:hover, .hc-tai-tile:focus-visible { filter: brightness(1.3); transform: translateY(-2px); outline: none; }
        .hc-tai-sym {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 900; font-size: 0.95rem;
            color: #ffffff; line-height: 1.1;
        }
        .hc-tai-val { font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.85rem; line-height: 1.1; }
        .hc-tai-label {
            font-family: 'Nunito', sans-serif; font-weight: 700; font-size: 0.56rem;
            letter-spacing: 0.06em; text-transform: uppercase; color: rgba(255,255,255,0.55); line-height: 1.15;
        }
        .hc-tai-note {
            flex: 1 1 auto; display: flex; align-items: center;
            background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1);
            border-radius: 12px; padding: 0.8rem 1rem;
            font-size: 0.9rem; line-height: 1.5; color: rgba(255,255,255,0.85);
        }
        @media (max-width: 520px) {
            .hc-tai-row { flex-direction: column; gap: 0.5rem; }
            .hc-tai-tile { width: 100%; min-height: 0; flex-direction: row; gap: 0.6rem; padding: 0.6rem; }
        }
        @media (prefers-reduced-motion: reduce) {
            .hc-tai-tile { transition: none; }
            .hc-tai-tile:hover, .hc-tai-tile:focus-visible { transform: none; }
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
        /* Pins to the topbar's right edge as one unit - margin-left:auto lives on the
           group, not on the banner, so it still works when the banner is hidden for a
           signed-in reader and the chip is the only thing in it. Centred on the logo's
           line, the way the homepage header centres its own right-hand cluster. */
        .tank-article-topbar-right {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            justify-content: flex-end;
            gap: 0.75rem 0.9rem;
            margin-left: auto;
            align-self: center;
        }
        /* MapHud pins itself absolutely (it floats over the map pages), which in a
           slot gives the slot no width of its own. That is harmless where the slot
           stands alone - the account and portfolio topbars - but here it sits beside
           the register banner: the "Log in" pill slid under the banner's edge, and,
           shrink-wrapped to the slot's 2.4rem minimum, broke onto two lines. Back in
           flow, the slot sizes to the pill or the chip and the gap between it and the
           banner is real. The mini nav then has to overlay explicitly, since it no
           longer rides an absolutely positioned parent - otherwise opening it would
           push the whole topbar down. */
        .tank-article-topbar-right .map-hud { position: relative; top: auto; right: auto; }
        .tank-article-topbar-right .map-hud__menu { position: absolute; top: 100%; right: 0; }
        .tank-article-register-banner {
            display: block;
            width: clamp(220px, 46vw, 420px);
            border-radius: 12px;
            overflow: hidden;
            flex-shrink: 0;
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

        /* Each column rides its own panel, at every width: the story on deep blue,
           the interactive rail on black - the same black the TANKDAQ tiles inside it
           already use, so the rail reads as one instrument panel rather than tiles
           floating loose on the page background.

           Both are painted here rather than in the desktop block below because the
           split is editorial, not a layout artifact: stacked on a phone the two
           panels still say "story" and "controls". */
        .tank-article-main-col,
        .tank-article-side-col {
            box-sizing: border-box;
            border-radius: 18px;
            padding: 1.35rem 1.4rem 1.75rem;
        }
        .tank-article-main-col {
            background: linear-gradient(180deg, #101d38 0%, #0b1526 100%);
            border: 1px solid rgba(125, 170, 255, 0.16);
            box-shadow: 0 18px 44px rgba(0, 0, 0, 0.42);
        }
        .tank-article-side-col {
            display: block;
            background: #000000;
            border: 1px solid rgba(255, 255, 255, 0.12);
            box-shadow: 0 18px 44px rgba(0, 0, 0, 0.55);
        }
        /* Stacked (phone) gap between the two panels; the desktop grid's column-gap
           replaces it below. */
        .tank-article-side-col { margin-top: 1.25rem; }
        /* The panels' own padding is the top inset now. These blocks carried a
           stacking margin for the old flat layout, and padding stops it collapsing
           away, so it would otherwise show as a gap inside the panel. Matched by
           class, not by :first-child, because the indexes island replaces its
           section's children after hydration. */
        .tank-article-main-col > .tank-article-header { margin-top: 0; }
        .tank-article-side-col .tank-article-cards,
        .tank-article-side-col .hc-tai-heading { margin-top: 0; }
        /* "Polymarket prices" - the market panel at the top of the rail. Deliberately flat:
           one weight and one colour for every side, no arrows or signs - a price reported,
           not a scoreboard. Sides stay in the market's own order, never sorted by price. */
        .tank-article-market {
            margin: 0 0 1.5rem;
            padding-bottom: 1.25rem;
            border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        .tank-article-market-heading {
            font-family: 'Montserrat', 'Nunito', sans-serif;
            font-weight: 800;
            font-size: 0.78rem;
            letter-spacing: 0.14em;
            text-transform: uppercase;
            color: var(--hc-teal);
            margin: 0 0 0.6rem;
        }
        .tank-article-market-question {
            margin: 0 0 0.5rem;
            font-size: 0.85rem;
            color: rgba(255,255,255,0.75);
        }
        .tank-article-market-rows {
            list-style: none;
            margin: 0.35rem 0 0;
            padding: 0;
            display: flex;
            flex-direction: column;
            gap: 0.35rem;
        }
        .tank-article-market-rows li {
            display: flex;
            justify-content: space-between;
            gap: 1rem;
            font-size: 0.95rem;
            color: rgba(255,255,255,0.9);
        }
        .tank-article-market-rows li span:last-child {
            font-variant-numeric: tabular-nums;
            font-weight: 700;
        }
        .tank-article-market-meta {
            margin: 0.6rem 0 0;
            font-size: 0.78rem;
            line-height: 1.5;
            color: rgba(255,255,255,0.55);
        }
        .tank-article-market-note {
            margin: 0.5rem 0 0;
            font-size: 0.72rem;
            color: rgba(255,255,255,0.45);
        }
        /* The deck alone spans the panel's full inner width - the index tiles above it
           keep the inset. The cube is a fixed-pixel 3D scene that paints past its
           container rather than shrinking into it, so giving the section the padding
           back is what keeps it centred on the panel instead of on a narrower box. */
        .tank-article-side-col .tank-article-artifact-section {
            margin-left: -1.4rem;
            margin-right: -1.4rem;
        }

        /* Phones: bring the page's side padding in so the panels reach within 8px of
           the screen edge - which is exactly where the deck's turn arrows stop, since
           Fishtank pins them clear of the viewport by half a button plus 8px. Any
           wider an inset and the arrows straddle the black panel's edge instead of
           sitting inside it. The roomier measure is a welcome side effect. */
        @media (max-width: 1179px) {
            .tank-article { padding-left: 0.5rem; padding-right: 0.5rem; }
            /* The deck renders smaller on a phone (deckScale in tank-article-deck-
               client.tsx), so the space reserved for it before hydration shrinks to
               match, or the smaller cube would sit in the middle of a full-height gap
               and the page would jump when it mounted. 420px times that same scale:
               105vw - 113.4px is 420 * (100vw - 108px) / 400, the client's formula
               in CSS. Change one, change both. */
            .tank-article-artifact { min-height: clamp(252px, 105vw - 113.4px, 420px); }
        }

        /* Desktop: story on the left, indexes and the Call deck stacked on the right.
           Everything above this line is the phone layout and stays untouched - the
           column wrappers carry no styles until this breakpoint, so narrow viewports
           render the same single stacked column they always did.

           1180px is not arbitrary: the rail is fixed at 480px because that is the
           Fishtank's own max width (components/Fishtank.tsx renders at width:100%,
           maxWidth:480) - a narrower rail would squeeze its fixed-pixel 3D scene
           rather than scale it. Add ~600px of prose column, the 2.75rem gutter and
           the page's 1.25rem side padding and 1180 is the first width where both
           columns get their natural size. Below it, one column is still correct.

           .tank-article's own cap has to lift here too, or the grid would be laid out
           inside the 720px reading measure and there would be nothing to split. */
        @media (min-width: 1180px) {
            .tank-article { max-width: 1180px; }
            .tank-article-columns {
                display: grid;
                grid-template-columns: minmax(0, 1fr) 480px;
                column-gap: 2.75rem;
                /* Start, not stretch: the rail is usually taller than a ~270-word
                   story, and stretching would leave the deck floating mid-column. */
                align-items: start;
            }
            /* The grid's column-gap is the gutter between the panels here, so the
               stacked layout's margin comes back off. */
            .tank-article-side-col { margin-top: 0; }
            /* The prose keeps its own comfortable measure inside the wider page -
               the extra width goes to the rail, not to 1100px-long lines of text.
               Widened by the panel's own horizontal padding (border-box) so the
               measure inside the panel is the one this number was chosen for. */
            .tank-article-main-col { max-width: 724px; }
            /* The header is centred on phones, where it spans the full width. Beside
               a rail it reads as a column, so left-align it with the prose under it. */
            .tank-article-main-col .tank-article-header { text-align: left; }
            .tank-article-main-col .tank-article-divider { margin-left: 0; }
            /* First thing in the rail, so it should sit level with the headline
               rather than inheriting the phone layout's stacking gap. */
            .tank-article-side-col > :first-child { margin-top: 0; }
            .tank-article-side-col .tank-article-artifact-section { margin-top: 2rem; }
        }
    </style>
</head>
<body>
    <main class="hc-page tank-article">
        <div class="hc-topbar">
            <a class="hc-logo" href="/" aria-label="Heatchecks home">
                <img src="/assets/images/heatchecks-logo.webp" alt="Heatchecks logo" width="500" height="241">
            </a>
            <!-- The right-hand cluster, grouped like the homepage header's
                 .hc-header-right: the register banner (logged out) and the identity
                 slot. ContentChrome portals MapHud into [data-hc-hud-slot] whenever the
                 page has one, so the username + Ember chip sits on the logo's line -
                 without it the chip fell back to a row of its own under the topbar,
                 which on these pages landed just above the rail's panel. -->
            <div class="tank-article-topbar-right">
                <a class="tank-article-register-banner" href="${baseUrl}/login/" aria-label="Register for HeatChecks - free to play">
                    <img src="/assets/images/register-banner.webp" alt="A new way to enjoy sports content - build your pet, team, franchise. Click here, free to play, to start" width="840" height="210" loading="lazy">
                </a>
                <div class="hc-topbar-hud" data-hc-hud-slot></div>
            </div>
        </div>

        <!-- ContentChrome's React root (mounted by tank-article-deck.js). The chip
             itself is portaled up into the topbar slot above; what renders here is the
             fixed captain widget and the Inbox modal host, both out of flow, so this
             takes no space. -->
        <div id="tank-article-chrome"></div>

        <!-- Two wrappers that do NOTHING below the desktop breakpoint: they carry no
             styles there, so they lay out as plain blocks and the phone view renders
             exactly the stacked order it always has. Only the media query at the
             bottom of the stylesheet turns this into a grid. Splitting the columns in
             the DOM (rather than reordering with grid placement) keeps source order
             equal to reading order for crawlers and no-JS readers. -->
        <div class="tank-article-columns">
            <div class="tank-article-main-col">
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
${resolutionHtml}
            </div>

            <aside class="tank-article-side-col">
${marketSectionHtml}
                <!-- The indexes this story moved. The cards list below is the fallback, and it
                     is the REAL content until the island proves otherwise: it stays for
                     untagged Tanks, for no-JS readers, and if the fetch fails. The island only
                     replaces these children when it has at least one tag to show. -->
                <section id="tank-article-indexes" data-slug="${escapeHtml(page.slug)}">
                    <ul class="tank-article-cards">
                        ${cardsHtml}
                    </ul>
                </section>

                <div class="tank-article-artifact-section">
                    <p class="tank-article-artifact-label">Make The Call</p>
                    <div class="tank-article-artifact">
                        <div id="tank-article-deck-root" data-hook="${escapeHtml(hook)}"></div>
                        <script type="application/json" id="tank-article-deck-data">${deckPayload}</script>
                    </div>
                </div>
            </aside>
        </div>

        <a class="tank-article-back" href="${baseUrl}/the-tank-hq/">&larr; Back to The Tank HQ</a>

        ${footer()}
    </main>
    <script type="module" src="/assets/tank-article-deck.js" defer></script>
</body>
</html>`;
}
