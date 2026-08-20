// ===================================================================================
// HOMEPAGE RENDER — full-page HTML template (lib/pages-functions/homepage/render.ts)
// ===================================================================================
// Used by BOTH functions/index.ts (request-time SSR, logged-in or logged-out) and
// scripts/generate-static-site.ts (build-time logged-out fallback written to
// dist/index.html). Everything SEO-relevant (hooks, first beats, prop tags, the
// Market Movers ticker section with its excerpts) is real server HTML here; the
// client island (homepage-client.tsx) only layers the 3D showcase, the interactive
// map, and row/tab behavior on top - it never adds content.
// ===================================================================================

// NOTE: these imports reach into scripts/ from Workers-bundled code. Safe today
// because both modules are pure string builders (no Node/DOM/React imports) - if you
// ever add a Node dependency to either, the functions build breaks; move the helpers
// into lib/pages-functions/ instead.
import { renderHead, footer } from '../../../scripts/templates/waitlist-landing-template';
import { escapeHtml } from '../../../scripts/utils/html-escape';
import { SPORT_ORDER } from '../../../sport-map';
import { marketMoversStyles, renderMarketMoversSection, renderTickerTape } from '../market-movers';
import type { HomepageData, SportSlot } from './data';

export interface HomepageUser {
    username: string;
    balance: number;
}

export interface RenderHomepageOptions {
    baseUrl: string;
    user: HomepageUser | null; // null = logged-out (the crawler-visible state)
    data: HomepageData;
}

const EMBER_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="currentColor"><path d="M12 2c.6 3.8-1.2 5.6-2.9 7.3C7.4 11 6 12.6 6 15a6 6 0 0 0 12 0c0-1.7-.6-3.1-1.5-4.5-.4 1-.9 1.7-1.8 2.3.3-3.4-1-6.5-2.7-8.8Z"/></svg>`;

function renderHeader(user: HomepageUser | null): string {
    const authArea = user
        ? `<div class="hc-auth" data-testid="hc-auth-in">
                <span class="hc-auth-name">${escapeHtml(user.username)}</span>
                <span class="hc-ember-chip" aria-label="${user.balance} Embers">${EMBER_SVG}${user.balance}</span>
            </div>`
        : `<a class="hc-cta-button hc-login-cta" href="/login/">Log in</a>`;

    return `
        <header class="hc-home-header">
            <a class="hc-logo" href="/" aria-label="Heatchecks home">
                <img src="/assets/images/heatchecks-logo.webp" alt="Heatchecks logo" width="500" height="241">
            </a>
            ${authArea}
        </header>`;
}

// One switcher button per sport, in a vertical column to the RIGHT of the 3D
// showcase: pressing a live sport's button flips the artifact to that sport's newest
// Tank (the island wires the click; the buttons are inert without JS - the showcase
// itself is JS-only anyway). Symbol buttons, not text - narrow enough to hold the
// side-by-side layout even on phones. The sport name lives in aria-label + title.
// Live sports first, in SPORT_ORDER; sports with nothing live render disabled. The
// first live sport ships is-selected/aria-pressed to match the island's initialSport.
const SPORT_ICONS: Record<string, string> = {
    Football: '🏈',
    Soccer: '⚽',
    Baseball: '⚾',
    Basketball: '🏀',
};

function renderSportRow(slots: SportSlot[]): string {
    const ordered = [...slots.filter(s => s.card), ...slots.filter(s => !s.card)];
    const firstLive = ordered.find(s => s.card)?.sport;
    const buttons = ordered.map((slot) => {
        const icon = SPORT_ICONS[slot.sport] ?? '🎯';
        if (!slot.card) {
            return `
            <button type="button" class="hc-sport-btn" data-sport="${slot.sport}" disabled title="${slot.sport}" aria-label="${slot.sport}: nothing live today"><span aria-hidden="true">${icon}</span></button>`;
        }
        const selected = slot.sport === firstLive;
        return `
            <button type="button" class="hc-sport-btn${selected ? ' is-selected' : ''}" data-sport="${slot.sport}" data-live aria-pressed="${selected}" title="${slot.sport}" aria-label="${escapeHtml(`Show the ${slot.sport.toLowerCase()} Tank: ${slot.card.hook}`)}"><span aria-hidden="true">${icon}</span></button>`;
    }).join('');

    return `
        <section id="tanks" class="hc-section" aria-labelledby="hc-tanks-heading">
            <h2 id="hc-tanks-heading">Newest Tanks Available</h2>
            <p class="hc-section-sub hc-section-sub--tanks">Tanks are Heatcheck&rsquo;s most important invention. With the wisdom of the user, it unlocks embers, the currency of the world that allows you to grow your mud puppy. Make your pick on a tank. Get it right. Earn Ember.</p>
            <div class="hc-tanks-layout">
                <div id="hc-showcase-root" aria-hidden="true"></div>
                <div class="hc-sport-row" data-hc-row role="group" aria-label="Choose a sport">
                    ${buttons}
                </div>
            </div>
            <div class="hc-tanks-footer">
                <div id="hc-picks-status" class="hc-picks-status" aria-live="polite"></div>
                <p class="hc-tanks-hq-link">More tanks to pick from are waiting at the <a href="/the-tank-hq/">Tank HQ</a> in Tank Land.</p>
            </div>
        </section>`;
}

// Static world-map picture is the no-JS/crawler fallback inside #hc-map-root; the
// island's createRoot().render() replaces it with the interactive WorldMap.
function renderExplore(): string {
    return `
        <section id="explore" class="hc-section" aria-labelledby="hc-explore-heading">
            <h2 id="hc-explore-heading" class="hc-visually-hidden">Explore the world by sport</h2>
            <div class="hc-explore-wrap">
                <img class="hc-explore-logo" src="/assets/images/explore-logo.webp" alt="" aria-hidden="true" loading="lazy" width="720" height="463">
                <div id="hc-map-root">
                    <picture>
                        <source srcset="/assets/images/world-map.webp" type="image/webp">
                        <img class="hc-world-map-static" src="/assets/images/world-map.png" alt="Illustrated map of the Heatchecks sports world, with themed islands for soccer, football, basketball, baseball, hockey, and golf surrounding a central aquarium" width="1120" height="1113" loading="lazy">
                    </picture>
                </div>
            </div>
        </section>`;
}

function homepageStyles(): string {
    return `
        /* The page must never scroll horizontally - wide content (the sport row)
           scrolls inside its own container instead. */
        html, body { overflow-x: hidden; }
        .hc-home { max-width: 1080px; margin: 0 auto; padding: 0.75rem 1.25rem 1rem; min-height: 100vh; display: flex; flex-direction: column; }
        .hc-home-header { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem 1.25rem; }
        .hc-home-header .hc-logo img { width: clamp(120px, 26vw, 240px); height: auto; display: block; }
        /* margin-left:auto (formerly on the nav, now removed) keeps the auth area
           pinned to the header's right edge. */
        .hc-login-cta { font-size: 0.95rem; padding: 0.5rem 1.4rem; flex-shrink: 0; margin-left: auto; }
        .hc-auth { display: flex; align-items: center; gap: 0.6rem; flex-shrink: 0; margin-left: auto; }
        .hc-auth-name { font-weight: 800; font-size: 0.9rem; }
        .hc-ember-chip {
            display: inline-flex; align-items: center; gap: 0.3rem;
            font-family: 'Baloo 2', 'Nunito', sans-serif; font-weight: 800; font-size: 0.9rem;
            color: var(--hc-gold); background: rgba(255, 199, 44, 0.12);
            border: 1px solid rgba(255, 199, 44, 0.4); border-radius: 999px; padding: 0.2rem 0.7rem;
        }
        .hc-section { margin-top: 2.25rem; }
        .hc-section h2 {
            font-family: 'Baloo 2', 'Nunito', sans-serif; font-weight: 800;
            font-size: clamp(1.3rem, 4.5vw, 1.7rem); margin: 0; text-transform: uppercase;
        }
        .hc-section-sub { margin: 0.35rem 0 1rem; font-size: 0.88rem; color: rgba(255,255,255,0.7); }
        /* The tanks pitch reads as fine print under the section title - smaller and
           dimmer than the standard sub line, capped for comfortable line length. */
        .hc-section-sub--tanks { font-size: 0.78rem; color: rgba(255,255,255,0.6); max-width: 640px; line-height: 1.5; }
        .hc-visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

        #hc-showcase-root:empty { display: none; }
        #hc-showcase-root { margin: 0 0 1.25rem; }

        /* Side-by-side at EVERY width: artifact left, symbol buttons in a vertical
           column to its right (the round icon buttons are narrow enough to hold this
           layout on phones). */
        .hc-tanks-layout { display: flex; flex-direction: row; align-items: center; gap: 0.75rem; }
        .hc-tanks-layout #hc-showcase-root { flex: 1 1 auto; margin: 0; min-width: 0; }
        .hc-sport-row {
            margin: 0; padding: 0; flex: 0 0 auto;
            display: flex; flex-direction: column; gap: 0.6rem; align-items: center;
        }
        @media (min-width: 760px) {
            .hc-tanks-layout { gap: 1.5rem; }
            .hc-tanks-layout #hc-showcase-root { flex: 0 1 560px; }
        }
        /* Round navy-glass symbol buttons in the house teal grammar (selected =
           committed glow). Sport name is on aria-label/title, not visible text. */
        .hc-sport-btn {
            width: 48px; height: 48px; padding: 0;
            display: flex; align-items: center; justify-content: center;
            font-size: 1.35rem; line-height: 1;
            color: var(--hc-teal); background: rgba(5, 7, 15, 0.6); cursor: pointer;
            border: 2px solid rgba(47, 230, 217, 0.35); border-radius: 50%;
            transition: background 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease, transform 0.15s ease;
        }
        .hc-sport-btn:hover:not([disabled]) { background: rgba(47, 230, 217, 0.12); transform: scale(1.06); }
        .hc-sport-btn.is-selected, .hc-sport-btn[aria-pressed="true"] {
            border-color: var(--hc-teal); background: rgba(47, 230, 217, 0.18);
            box-shadow: 0 0 14px rgba(47, 230, 217, 0.45);
        }
        .hc-sport-btn:focus-visible { outline: 2px solid var(--hc-teal); outline-offset: 2px; }
        .hc-sport-btn[disabled] { opacity: 0.35; cursor: default; }
        @media (min-width: 760px) {
            .hc-sport-btn { width: 56px; height: 56px; font-size: 1.55rem; }
        }

        /* Panel footer: picks-remaining header (island-filled; hidden while empty)
           over the crawlable Tank HQ pointer. */
        .hc-tanks-footer { margin-top: 1rem; padding-top: 0.75rem; border-top: 1px solid rgba(47, 230, 217, 0.2); }
        .hc-picks-status {
            font-family: 'Baloo 2', 'Nunito', sans-serif; font-weight: 800;
            font-size: 0.95rem; letter-spacing: 0.05em; text-transform: uppercase;
            color: var(--hc-gold);
        }
        .hc-picks-status:empty { display: none; }
        .hc-tanks-hq-link { margin: 0.35rem 0 0; font-size: 0.8rem; color: rgba(255,255,255,0.6); }
        .hc-tanks-hq-link a { color: var(--hc-teal); font-weight: 800; text-decoration: none; }
        .hc-tanks-hq-link a:hover { text-decoration: underline; }

        .hc-explore-wrap { position: relative; margin-top: 1.5rem; }
        /* The world is pulled up so the EXPLORE logo slightly overlaps its top-left
           corner - but the map (and its hover region labels) LAYER OVER the logo:
           the map stacks above (z 2 vs 1), while the layout overlap comes from the
           logo's negative bottom margin. The pet widget (fixed, z 1500) stays above
           both. */
        .hc-explore-logo {
            display: block; width: clamp(180px, 42vw, 340px); height: auto; margin: 0 0 -2.75rem;
            position: relative; z-index: 1;
            pointer-events: none; filter: drop-shadow(0 8px 16px rgba(0,0,0,0.45));
        }
        #hc-map-root { position: relative; z-index: 2; }
        .hc-world-map-static, #hc-map-root svg { display: block; width: 100%; height: auto; }

        @media (prefers-reduced-motion: reduce) {
            .hc-sport-row { scroll-behavior: auto; }
        }
        @media (max-width: 420px) {
            .hc-home { padding: 0.6rem 1rem 0.85rem; }
        }

        /* ------------------------------------------------------------------ */
        /* Desktop (mockup layout): two columns - tanks panel left, Market     */
        /* Movers panel right - over the SAME DOM order, so mobile (below the  */
        /* breakpoint) keeps the stacked layout untouched.                     */
        /* ------------------------------------------------------------------ */
        @media (min-width: 1024px) {
            .hc-home {
                max-width: 1240px;
                display: grid;
                grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
                grid-template-areas:
                    'header header'
                    'tape tape'
                    'tanks movers'
                    'explore explore'
                    'footer footer';
                column-gap: 1.5rem;
                /* Default (stretch) block alignment: the tanks and movers panels share
                   the row, so the shorter one stretches to the taller one's height. */
            }
            .hc-home-header { grid-area: header; }
            .hc-ticker-tape { grid-area: tape; }
            #tanks { grid-area: tanks; }
            #market-movers { grid-area: movers; }
            #explore { grid-area: explore; }
            .hc-footer { grid-area: footer; }

            /* Tanks: orange-bordered game panel with a white title bar, stretched to
               the movers panel's height with the footer pinned at the bottom. */
            #tanks {
                margin-top: 1.5rem;
                border: 3px solid #f89b4e;
                border-radius: 6px;
                background: #05070f;
                padding: 0 1.1rem 1.1rem;
                overflow: hidden;
                display: flex;
                flex-direction: column;
            }
            #tanks .hc-tanks-footer { margin-top: auto; padding-top: 1rem; }
            #tanks h2 {
                background: var(--hc-gold); color: #1a1200;
                margin: 0 -1.1rem 0.75rem; padding: 0.65rem 1.1rem;
            }
            .hc-section-sub--tanks { margin-top: 0; }

            /* Explore: globe seated left on the page's own navy background (one
               consistent color story all the way down); the open right half is where
               the fixed pet widget visually lives. */
            #explore { margin-top: 2rem; }
            #explore .hc-explore-wrap { margin-top: 0.5rem; }
            #hc-map-root { max-width: 620px; }
            .hc-footer { padding-top: 1.25rem; }
        }
    `;
}

export function renderHomepage(options: RenderHomepageOptions): string {
    const { baseUrl, user, data } = options;
    const title = 'Heatchecks | Live Sports Prop Stories, Every Day';
    const description = 'Daily prop storylines across baseball, basketball, football, and soccer. Read the story, explore the sports world, and make your own call in the Tank.';

    const schemaOrg = [
        {
            '@context': 'https://schema.org',
            '@type': 'Organization',
            name: 'HeatChecks',
            url: baseUrl,
            logo: { '@type': 'ImageObject', url: `${baseUrl}/assets/images/heatchecks-logo.png` },
            description,
        },
        {
            '@context': 'https://schema.org',
            '@type': 'WebSite',
            name: 'HeatChecks',
            url: baseUrl,
            description,
        },
    ];

    const head = renderHead({ title, description, path: '/', baseUrl, schemaOrg });

    // Island hydration payload. initialSport = first live sport so the showcase opens
    // on real content. The < escape keeps model prose containing "</script>" (or
    // any tag) from terminating this script block early.
    const liveSlots = data.sportSlots.filter(s => s.card);
    const payload = {
        initialSport: liveSlots[0]?.sport ?? SPORT_ORDER[0],
        // Session is server-known per request (the page is private/no-store), so the
        // showcase island can pick its 4th wall without a client-side session fetch:
        // logged out -> promo/signup wall, logged in -> the full interactive deck.
        loggedIn: Boolean(user),
        sports: data.sportSlots.map(slot => ({
            sport: slot.sport,
            live: Boolean(slot.card),
            slug: slot.card?.slug ?? null,
            href: slot.card?.href ?? null,
            deck: slot.card?.deck ?? null,
        })),
    };
    const payloadJson = JSON.stringify(payload).replace(/</g, '\\u003c');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    ${head}
    <link rel="stylesheet" href="/assets/homepage.css">
    <style>${homepageStyles()}${marketMoversStyles()}</style>
</head>
<body>
    <main class="hc-home">
        ${renderHeader(user)}
        ${renderTickerTape(data.marketMovers.movers)}
        ${renderSportRow(data.sportSlots)}
        ${renderMarketMoversSection(data.marketMovers)}
        ${renderExplore()}
        ${footer()}
    </main>
    <script type="application/json" id="homepage-data">${payloadJson}</script>
    <script type="module" src="/assets/homepage.js" defer></script>
</body>
</html>`;
}
