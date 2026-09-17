import { renderHead, topbar, footer } from './waitlist-landing-template';
import { escapeHtml } from '../utils/html-escape';
import type { Game, TankArticle } from '../../tank-types';
import {
    buildLinesDeckPayload,
    formatGameTime,
    lineKey,
    lineLabel,
    lineShortLabel,
    linesPagePath,
    matchupName,
    type LineKey,
    type LinesProp,
} from '../../tank-lines';

export interface LinesRowRecord {
    id: string;
    slug: string;
    league: string;
    // 'superseded' = a story was published on this row's market after the line went up.
    status: 'published' | 'superseded';
    game_snapshot: { prop: LinesProp; game: Game };
    model_output: TankArticle;
    created_at: string;
    published_at: string | null;
}

// One matchup's lines rows, grouped by page_slug in generate-static-site.ts.
export interface LinesPageGroup {
    pageSlug: string;
    rows: LinesRowRecord[];
}

const SLOT_ORDER: LineKey[] = ['ml', 'spread', 'total'];
const SLOT_TITLE: Record<LineKey, string> = { ml: 'Moneyline', spread: 'Spread', total: 'Total' };

function listedDateLabel(value: string | Date): string {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
}

// The price frozen when the line was listed, explicitly DATED so an old number is never
// read as a current one. Two-outcome markets only, which is every game line; a missing
// or malformed book shows no percentages at all - never a fake 50/50.
function renderFrozenPrices(row: LinesRowRecord): string {
    const { prop } = row.game_snapshot;
    const sides = row.model_output.call.sides;
    const prices = prop.odds?.outcomePrices;
    if (!Array.isArray(prices) || prices.length !== 2 || sides.length !== 2
        || !prices.every((p) => typeof p === 'number' && Number.isFinite(p) && p > 0 && p < 1)) {
        return '';
    }
    const rows = sides.map((side, i) => `
                            <li><span>${escapeHtml(side)}</span><span>${(prices[i] * 100).toFixed(1)}%</span></li>`).join('');
    const listed = listedDateLabel(row.created_at);
    return `
                    <div class="tank-lines-prices">
                        <p class="tank-lines-prices-heading">Polymarket prices</p>
                        <ul class="tank-lines-prices-rows">${rows}
                        </ul>
                        <p class="tank-lines-prices-meta">As of when this line was listed${listed ? `, ${escapeHtml(listed)}` : ''}. Prices move until the game starts.</p>
                    </div>`;
}

/**
 * The lines page: /the-tank/lines/<page_slug>/. One matchup, its canonical moneyline,
 * spread and total, each with its frozen price and a pick deck. No hero, no prose.
 *
 * Decorated as its own kind on purpose: the bubble accent (story pages use teal and
 * gold), a LINES pill in the eyebrow, and dashed slot borders, so a reader who has seen
 * an article knows at a glance this is the board, not a story.
 *
 * Narrative wins, line by line: a slot whose market has a story (its row moved to
 * 'superseded', or a story simply exists on that market) renders a "Read the story" card
 * instead of a deck. The other slots are untouched.
 */
export function generateTankLinesPage(
    group: LinesPageGroup,
    narrativeSlugByMarket: Map<string, string>,
    baseUrl: string = 'https://heatchecks.io',
): string {
    const game = group.rows[0].game_snapshot.game;
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
        const label = lineLabel(prop, row.model_output.call.sides);
        const storySlug = narrativeSlugByMarket.get(String(prop.id));
        const handedOff = row.status === 'superseded' || Boolean(storySlug);

        if (handedOff) {
            const href = storySlug ? `/the-tank/articles/${storySlug}/` : '/the-tank/';
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
                    <p class="tank-lines-slot-label">${escapeHtml(label)}</p>${renderFrozenPrices(row)}
                    <div class="tank-article-artifact-section">
                        <p class="tank-article-artifact-label">Make The Call</p>
                        <div class="tank-article-artifact">
                            <div class="tank-lines-deck" data-tank-deck data-line="${key}"></div>
                            <script type="application/json">${deckPayload}</script>
                        </div>
                    </div>
                </section>`;
    }).join('\n');

    const boardSummary = SLOT_ORDER
        .filter((k) => rowsByKey.has(k))
        .map((k) => escapeHtml(lineShortLabel(rowsByKey.get(k)!.game_snapshot.prop)))
        .join(' &middot; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    ${head}
    <style>
        .tank-article { max-width: 720px; margin: 0 auto; padding: 0.5rem 1.25rem 3rem; }
        .tank-article--lines { --lines-accent: var(--hc-bubble, #cfe6ff); }

        .tank-lines-header { margin-top: 1rem; text-align: center; }
        .tank-lines-eyebrow {
            display: inline-flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; justify-content: center;
            font-family: 'Nunito', sans-serif; font-weight: 700; font-size: 0.8rem;
            letter-spacing: 0.06em; text-transform: uppercase; color: var(--lines-accent); margin: 0 0 0.6rem;
        }
        .tank-lines-pill {
            display: inline-block; padding: 0.15rem 0.55rem; border-radius: 999px;
            border: 1.5px dashed var(--lines-accent); font-size: 0.68rem; letter-spacing: 0.16em;
            color: var(--hc-navy-dark, #060c22); background: var(--lines-accent);
        }
        .tank-lines-gametime {
            font-family: 'Nunito', sans-serif; font-weight: 600; font-size: 0.7rem;
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
            background: rgba(0, 0, 0, 0.55); border: 1.5px dashed rgba(207, 230, 255, 0.35);
            box-shadow: 0 18px 44px rgba(0, 0, 0, 0.55);
        }
        .tank-lines-slot--empty, .tank-lines-slot--story { background: rgba(207, 230, 255, 0.04); }
        .tank-lines-slot-title {
            font-family: 'Nunito', sans-serif; font-weight: 800; font-size: 0.72rem;
            letter-spacing: 0.16em; text-transform: uppercase; color: var(--lines-accent); margin: 0 0 0.35rem;
        }
        .tank-lines-slot-label {
            font-family: 'Baloo 2', 'Nunito', sans-serif; font-weight: 800; font-size: 1.15rem;
            line-height: 1.3; margin: 0 0 1rem; color: #ffffff;
        }
        .tank-lines-slot-note { margin: 0; font-size: 0.9rem; color: rgba(255,255,255,0.55); }

        .tank-lines-prices { margin: 0 0 1.25rem; padding-bottom: 1.1rem; border-bottom: 1px solid rgba(255,255,255,0.1); }
        .tank-lines-prices-heading {
            font-family: 'Nunito', sans-serif; font-weight: 800; font-size: 0.78rem;
            letter-spacing: 0.14em; text-transform: uppercase; color: var(--lines-accent); margin: 0 0 0.6rem;
        }
        .tank-lines-prices-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.35rem; }
        .tank-lines-prices-rows li { display: flex; justify-content: space-between; gap: 1rem; font-size: 0.95rem; color: rgba(255,255,255,0.9); }
        .tank-lines-prices-rows li span:last-child { font-variant-numeric: tabular-nums; font-weight: 700; }
        .tank-lines-prices-meta { margin: 0.6rem 0 0; font-size: 0.78rem; line-height: 1.5; color: rgba(255,255,255,0.55); }

        .tank-article-artifact-section { margin: 0.5rem -1.4rem 0; text-align: center; }
        .tank-article-artifact-label {
            font-family: 'Nunito', sans-serif; font-weight: 800; font-size: 0.75rem;
            letter-spacing: 0.1em; text-transform: uppercase; color: var(--hc-gold); margin: 0 0 1rem;
        }
        .tank-article-artifact { min-height: 420px; display: flex; align-items: center; justify-content: center; }

        .tank-lines-handoff {
            border-radius: 12px; padding: 1rem 1.15rem; background: rgba(255,255,255,0.04);
            border: 1px solid rgba(255,255,255,0.12); border-left: 3px solid var(--hc-teal);
        }
        .tank-lines-handoff-eyebrow {
            font-family: 'Nunito', sans-serif; font-weight: 800; font-size: 0.72rem;
            letter-spacing: 0.14em; text-transform: uppercase; color: var(--hc-teal); margin: 0 0 0.45rem;
        }
        .tank-lines-handoff-body { margin: 0 0 0.75rem; font-size: 0.92rem; line-height: 1.5; color: rgba(255,255,255,0.8); }
        .tank-lines-handoff-link {
            display: inline-block; font-family: 'Nunito', sans-serif; font-weight: 800; font-size: 0.85rem;
            color: var(--hc-navy-dark, #060c22); background: var(--hc-teal); padding: 0.5rem 0.9rem; border-radius: 999px; text-decoration: none;
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
        ${topbar(`${baseUrl}/beta/`)}

        <header class="tank-lines-header">
            <p class="tank-lines-eyebrow"><span class="tank-lines-pill">Lines</span> <span>${escapeHtml(game.league)} &middot; ${escapeHtml(eventName)}</span></p>
            <p class="tank-lines-gametime">${escapeHtml(formatGameTime(game.kickoff))}</p>
            <h1>${escapeHtml(eventName)}</h1>
            <p class="tank-lines-sub">The board for this game: ${boardSummary}. Pick a side on any line before it starts.</p>
            <div class="tank-lines-divider"></div>
        </header>

        <div class="tank-lines-board">
${slotsHtml}
        </div>

        <a class="tank-article-back" href="${baseUrl}/the-tank/">&larr; Back to The Tank</a>

        ${footer()}
    </main>
    <script type="module" src="/assets/tank-article-deck.js" defer></script>
</body>
</html>`;
}
