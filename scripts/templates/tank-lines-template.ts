import { renderHead, footer } from './waitlist-landing-template';
import { escapeHtml } from '../utils/html-escape';
import { renderMarketSection } from './tank-article-template';
import type { Game, Prop, TankArticle } from '../../tank-types';
import { formatGameTime } from '../../tank-deck-format';
import {
    buildLinesDeckPayload,
    lineKey,
    lineLabel,
    lineShortLabel,
    linesPagePath,
    matchupName,
    type LineKey,
} from '../../tank-lines';

export interface LinesRowRecord {
    id: string;
    slug: string;
    league: string;
    status: 'published' | 'superseded';
    game_snapshot: { prop: Prop; game: Game };
    model_output: TankArticle;
    created_at: string;
    published_at: string | null;
}

// One matchup's lines rows, grouped by page_slug in generate-static-site.ts.
export interface LinesPageGroup {
    pageSlug: string;
    rows: LinesRowRecord[];
}

// A lines page names no data source anywhere - same footnote as a story's price panel,
// minus the name.
const LINES_PRICE_NOTE = 'Midpoint prices, shown as percentages. Not a forecast and not a recommendation.';

const SLOT_ORDER: LineKey[] = ['ml', 'spread', 'total'];
const SLOT_TITLE: Record<LineKey, string> = { ml: 'Moneyline', spread: 'Spread', total: 'Total' };

/**
 * The lines page: /the-tank/lines/<page_slug>/. One matchup, its canonical moneyline,
 * spread and total side by side, each with its frozen price, the live-price island and a
 * pick deck. No hero, no prose, no "indexes this story moved" - a lines Tank tags nothing.
 *
 * Decorated as its own kind on purpose: the bubble accent (unused by narrative pages,
 * whose eyebrows are teal and accents gold), a LINES pill in the eyebrow, and dashed
 * slot borders, so a reader who has seen an article knows at a glance this is the board,
 * not a story.
 *
 * Narrative wins, line by line: a slot whose market has an app story (its row moved to
 * 'superseded', or a story simply exists on that market) renders a "Read the story"
 * card instead of a deck. The other slots are untouched.
 */
export function generateTankLinesPage(
    group: LinesPageGroup,
    narrativeSlugByMarket: Map<string, string>,
    baseUrl: string = 'https://heatchecks.io',
): string {
    const first = group.rows[0];
    const game = first.game_snapshot.game;
    const eventName = matchupName(game);
    const path = linesPagePath(group.pageSlug);
    const url = `${baseUrl}${path}`;
    const title = `${eventName} — The Lines`;
    const description = `${game.league}: the moneyline, spread and total for ${eventName}, ${formatGameTime(game.kickoff)}. Make your call - no story, just the lines.`;

    const rowsByKey = new Map<LineKey, LinesRowRecord>();
    for (const row of group.rows) {
        const key = lineKey(row.game_snapshot.prop.market);
        if (key && !rowsByKey.has(key)) rowsByKey.set(key, row);
    }
    const publishedMs = (r: LinesRowRecord) => new Date(r.published_at || r.created_at).getTime();
    const publishedTime = new Date(Math.min(...group.rows.map(publishedMs))).toISOString();

    const schemaOrg = [
        {
            '@context': 'https://schema.org',
            '@type': 'WebPage',
            name: title,
            url,
            datePublished: publishedTime,
            publisher: { '@type': 'Organization', name: 'HeatChecks', url: baseUrl },
            // Facts only, straight off the frozen snapshot - same rule as the article page.
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

    const head = renderHead({ title, description, path, baseUrl, schemaOrg });

    const slotsHtml = SLOT_ORDER.map((key) => {
        const row = rowsByKey.get(key);
        if (!row) {
            return `
                <section class="tank-lines-slot tank-lines-slot--empty">
                    <h2 class="tank-lines-slot-title">${SLOT_TITLE[key]}</h2>
                    <p class="tank-lines-slot-note">No ${SLOT_TITLE[key].toLowerCase()} listed for this game yet.</p>
                </section>`;
        }
        const { prop } = row.game_snapshot;
        const storySlug = narrativeSlugByMarket.get(String(prop.id));
        const handedOff = row.status === 'superseded' || Boolean(storySlug);
        const label = lineLabel(prop);

        if (handedOff) {
            const href = storySlug ? `/the-tank/articles/${storySlug}/` : '/the-tank-hq/';
            return `
                <section class="tank-lines-slot tank-lines-slot--story">
                    <h2 class="tank-lines-slot-title">${SLOT_TITLE[key]}</h2>
                    <p class="tank-lines-slot-label">${escapeHtml(label)}</p>
                    <div class="tank-lines-handoff">
                        <p class="tank-lines-handoff-eyebrow">This line has a story</p>
                        <p class="tank-lines-handoff-body">Make this call where the storyline lives - the pick counts there, once.</p>
                        <a class="tank-lines-handoff-link" href="${escapeHtml(href)}">Read the story <span aria-hidden="true">&rarr;</span></a>
                    </div>
                </section>`;
        }

        const deckPayload = JSON.stringify(buildLinesDeckPayload(row)).replace(/</g, '\\u003c');
        return `
                <section class="tank-lines-slot">
                    <h2 class="tank-lines-slot-title">${SLOT_TITLE[key]}</h2>
                    <p class="tank-lines-slot-label">${escapeHtml(label)}</p>
${renderMarketSection(prop, game, row.created_at, { writtenVerb: 'this line was listed', heading: 'Market prices', note: LINES_PRICE_NOTE })}
                    <div class="tank-article-artifact-section">
                        <p class="tank-article-artifact-label">Make The Call</p>
                        <div class="tank-article-artifact">
                            <div class="tank-lines-deck" data-tank-deck data-line="${key}"></div>
                            <script type="application/json">${deckPayload}</script>
                        </div>
                    </div>
                </section>`;
    }).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    ${head}
    <link rel="stylesheet" href="/assets/tank-article-deck.css">
    <style>
        .tank-article { max-width: 720px; margin: 0 auto; padding: 0.5rem 1.25rem 3rem; }
        .tank-article--lines { --lines-accent: var(--hc-bubble); }
        .hc-topbar { flex-wrap: wrap; row-gap: 0.75rem; }
        .tank-article-topbar-right {
            display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end;
            gap: 0.75rem 0.9rem; margin-left: auto; align-self: center;
        }
        .tank-article-topbar-right .map-hud { position: relative; top: auto; right: auto; }
        .tank-article-topbar-right .map-hud__menu { position: absolute; top: 100%; right: 0; }
        .tank-article-register-banner {
            display: block; width: clamp(220px, 46vw, 420px); border-radius: 12px; overflow: hidden; flex-shrink: 0;
            box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45), 0 0 0 2px rgba(207, 230, 255, 0.25);
            transition: transform 0.15s ease, filter 0.2s ease;
        }
        .tank-article-register-banner img { display: block; width: 100%; height: auto; }
        .tank-article-register-banner:hover { transform: translateY(-2px); filter: brightness(1.05); }
        .tank-article-register-banner:focus-visible { outline: 3px solid var(--lines-accent); outline-offset: 3px; }
        .tank-article:has(.map-hud__chip) .tank-article-register-banner { display: none; }

        .tank-lines-header { margin-top: 1rem; text-align: center; }
        .tank-lines-eyebrow {
            display: inline-flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; justify-content: center;
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 700; font-size: 0.8rem;
            letter-spacing: 0.06em; text-transform: uppercase; color: var(--lines-accent); margin: 0 0 0.6rem;
        }
        .tank-lines-pill {
            display: inline-block; padding: 0.15rem 0.55rem; border-radius: 999px;
            border: 1.5px dashed var(--lines-accent); font-size: 0.68rem; letter-spacing: 0.16em;
            color: var(--hc-navy-dark); background: var(--lines-accent);
        }
        .tank-lines-gametime {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 600; font-size: 0.7rem;
            letter-spacing: 0.04em; color: rgba(255,255,255,0.55); margin: 0 0 0.6rem;
        }
        .tank-lines-header h1 {
            font-family: 'Baloo 2', 'Nunito', sans-serif; font-weight: 800; font-size: clamp(1.4rem, 5.5vw, 2rem);
            line-height: 1.2; margin: 0;
        }
        .tank-lines-sub { margin: 0.6rem 0 0; font-size: 0.85rem; color: rgba(255,255,255,0.6); }
        .tank-lines-divider {
            width: 64px; height: 3px; margin: 1.1rem auto 0; border-radius: 999px;
            background: linear-gradient(90deg, transparent, var(--lines-accent), transparent); opacity: 0.7;
        }

        .tank-lines-board { display: grid; gap: 1.25rem; margin-top: 1.75rem; }
        .tank-lines-slot {
            box-sizing: border-box; border-radius: 18px; padding: 1.25rem 1.4rem 1.6rem;
            background: #000000; border: 1.5px dashed rgba(207, 230, 255, 0.35);
            box-shadow: 0 18px 44px rgba(0, 0, 0, 0.55);
        }
        .tank-lines-slot--empty, .tank-lines-slot--story { background: rgba(207, 230, 255, 0.04); }
        .tank-lines-slot-title {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.72rem;
            letter-spacing: 0.16em; text-transform: uppercase; color: var(--lines-accent); margin: 0 0 0.35rem;
        }
        .tank-lines-slot-label {
            font-family: 'Baloo 2', 'Nunito', sans-serif; font-weight: 800; font-size: 1.15rem;
            line-height: 1.3; margin: 0 0 1rem; color: #ffffff;
        }
        .tank-lines-slot-note { margin: 0; font-size: 0.9rem; color: rgba(255,255,255,0.55); }

        .tank-article-market { margin: 0 0 1.25rem; padding-bottom: 1.1rem; border-bottom: 1px solid rgba(255,255,255,0.1); }
        .tank-article-market-heading {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.78rem;
            letter-spacing: 0.14em; text-transform: uppercase; color: var(--lines-accent); margin: 0 0 0.6rem;
        }
        .tank-article-market-question { margin: 0 0 0.5rem; font-size: 0.85rem; color: rgba(255,255,255,0.75); }
        .tank-article-market-rows { list-style: none; margin: 0.35rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.35rem; }
        .tank-article-market-rows li { display: flex; justify-content: space-between; gap: 1rem; font-size: 0.95rem; color: rgba(255,255,255,0.9); }
        .tank-article-market-rows li span:last-child { font-variant-numeric: tabular-nums; font-weight: 700; }
        .tank-article-market-meta { margin: 0.6rem 0 0; font-size: 0.78rem; line-height: 1.5; color: rgba(255,255,255,0.55); }
        .tank-article-market-note { margin: 0.5rem 0 0; font-size: 0.72rem; color: rgba(255,255,255,0.45); }

        .tank-article-artifact-section { margin: 0.5rem -1.4rem 0; text-align: center; }
        .tank-article-artifact-label {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.75rem;
            letter-spacing: 0.1em; text-transform: uppercase; color: var(--hc-gold); margin: 0 0 1rem;
        }
        .tank-article-artifact { min-height: 420px; display: flex; align-items: center; justify-content: center; }
        @media (max-width: 1179px) {
            .tank-article { padding-left: 0.5rem; padding-right: 0.5rem; }
            .tank-article-artifact { min-height: clamp(252px, 105vw - 113.4px, 420px); }
        }

        .tank-lines-handoff {
            border-radius: 12px; padding: 1rem 1.15rem; background: rgba(255,255,255,0.04);
            border: 1px solid rgba(255,255,255,0.12); border-left: 3px solid var(--hc-teal);
        }
        .tank-lines-handoff-eyebrow {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.72rem;
            letter-spacing: 0.14em; text-transform: uppercase; color: var(--hc-teal); margin: 0 0 0.45rem;
        }
        .tank-lines-handoff-body { margin: 0 0 0.75rem; font-size: 0.92rem; line-height: 1.5; color: rgba(255,255,255,0.8); }
        .tank-lines-handoff-link {
            display: inline-block; font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.85rem;
            color: var(--hc-navy-dark); background: var(--hc-teal); padding: 0.5rem 0.9rem; border-radius: 999px; text-decoration: none;
        }
        .tank-lines-handoff-link:hover { filter: brightness(1.08); }

        .tank-article-back { display: inline-block; margin-top: 2.5rem; font-size: 0.85rem; color: rgba(255,255,255,0.6); text-decoration: none; }
        .tank-article-back:hover { color: #ffffff; }

        @media (min-width: 1180px) {
            .tank-article { max-width: 1180px; }
            .tank-lines-board { grid-template-columns: repeat(3, minmax(0, 1fr)); align-items: start; }
        }
    </style>
</head>
<body>
    <main class="hc-page tank-article tank-article--lines">
        <div class="hc-topbar">
            <a class="hc-logo" href="/" aria-label="Heatchecks home">
                <img src="/assets/images/heatchecks-logo.webp" alt="Heatchecks logo" width="500" height="241">
            </a>
            <div class="tank-article-topbar-right">
                <a class="tank-article-register-banner" href="${baseUrl}/login/" aria-label="Register for HeatChecks - free to play">
                    <img src="/assets/images/register-banner.webp" alt="A new way to enjoy sports content - build your pet, team, franchise. Click here, free to play, to start" width="840" height="210" loading="lazy">
                </a>
                <div class="hc-topbar-hud" data-hc-hud-slot></div>
            </div>
        </div>

        <div id="tank-article-chrome"></div>

        <header class="tank-lines-header">
            <p class="tank-lines-eyebrow"><span class="tank-lines-pill">Lines</span> <span>${escapeHtml(game.league)} &middot; ${escapeHtml(eventName)}</span></p>
            <p class="tank-lines-gametime">${escapeHtml(formatGameTime(game.kickoff))}</p>
            <h1>${escapeHtml(eventName)}</h1>
            <p class="tank-lines-sub">The board for this game: ${SLOT_ORDER.filter(k => rowsByKey.has(k)).map(k => lineShortLabel(rowsByKey.get(k)!.game_snapshot.prop)).map(escapeHtml).join(' &middot; ')}. Pick a side on any line before kickoff.</p>
            <div class="tank-lines-divider"></div>
        </header>

        <div class="tank-lines-board">
${slotsHtml}
        </div>

        <a class="tank-article-back" href="${baseUrl}/the-tank-hq/">&larr; Back to The Tank HQ</a>

        ${footer()}
    </main>
    <script type="module" src="/assets/tank-article-deck.js" defer></script>
</body>
</html>`;
}
