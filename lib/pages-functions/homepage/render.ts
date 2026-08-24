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
            <!-- The ember-lit cave behind the WHOLE panel interior: pitch copy, tank
                 artifact, sport buttons, and the picks-left footer all sit in it.
                 Server-rendered (not island-mounted) so it paints before hydration;
                 a negative z-index child of the isolated panel, so every in-flow
                 sibling paints above it with no per-element z-index. -->
            <div class="hc-tanks-backdrop" style="background-image: url('/assets/images/tank-homepage-backdrop.webp')" aria-hidden="true">
                <span class="hc-tanks-wind"></span>
                <span class="hc-tanks-wind hc-tanks-wind--b"></span>
            </div>
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
// island's createRoot().render() replaces it with the interactive WorldMap. Logged
// out, the section also carries the register CTA card (mobile: under the world;
// desktop: to its right) - the island wires its click to the register modal.
function renderExplore(user: HomepageUser | null): string {
    const registerCta = user ? '' : `
                <button type="button" class="hc-register-cta" data-hc-register aria-haspopup="dialog" aria-label="Register to join HeatChecks">
                    <img src="/assets/images/register-here.webp" alt="Register here to join the fun" width="800" height="800" loading="lazy">
                </button>`;
    return `
        <section id="explore" class="hc-section" aria-labelledby="hc-explore-heading">
            <h2 id="hc-explore-heading" class="hc-visually-hidden">Explore the world by sport</h2>
            <div class="hc-explore-wrap">
                <img class="hc-explore-logo" src="/assets/images/explore-logo.webp" alt="" aria-hidden="true" loading="lazy" width="720" height="463">
                <div class="hc-explore-row">
                    <div id="hc-map-root">
                        <picture>
                            <source srcset="/assets/images/world-map.webp" type="image/webp">
                            <img class="hc-world-map-static" src="/assets/images/world-map.png" alt="Illustrated map of the Heatchecks sports world, with themed islands for soccer, football, basketball, baseball, hockey, and golf surrounding a central aquarium" width="1120" height="1113" loading="lazy">
                        </picture>
                    </div>${registerCta}
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
        /* The island turns the chip into the same mini-nav trigger the map pages'
           MapHud has; the dropdown (MapHud.css classes) hangs off its right edge. */
        .hc-auth--clickable { position: relative; cursor: pointer; -webkit-tap-highlight-color: transparent; }
        .hc-auth--clickable:focus-visible { outline: 2px solid var(--hc-teal); outline-offset: 3px; border-radius: 999px; }
        .hc-auth .hc-auth-menu { position: absolute; top: calc(100% + 6px); right: 0; z-index: 600; }
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
        /* position:relative (z-index left 'auto') so this paints above
           .hc-tanks-backdrop - see that rule's comment for why. */
        .hc-tanks-layout { position: relative; display: flex; flex-direction: row; align-items: center; gap: 0.75rem; }
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

        /* The tanks section is the orange-bordered game panel with a gold title bar
           at EVERY viewport (desktop additionally stretches it to match the Market
           Movers column and pins the footer - see the grid block below).
           position:relative only (deliberately NO isolation/transform/filter here):
           #tanks contains the fixed-position PetWidget several levels down (inside
           .hc-tanks-layout > #hc-showcase-root), and isolation: isolate creates a
           new stacking context that traps a fixed descendant's paint layer inside
           it - the widget (and its Feed/Inventory modals) would then render
           correctly on-screen but get overpainted by later same-page sections that
           have their own stacking (Market Movers, the world map), instead of
           sitting above the whole document like position:fixed normally does. Ran
           into exactly this. See homepage-client.tsx's matching note on the
           showcase wrapper for the transform version of the same trap. */
        #tanks {
            position: relative;
            border: 3px solid #f89b4e;
            border-radius: 6px;
            background: #05070f;
            padding: 0 1.1rem 1.1rem;
            overflow: hidden;
            display: flex;
            flex-direction: column;
        }

        /* The ember-lit cave filling the whole panel (the navy above stays as the
           loading/no-image base). No isolation on #tanks (see above) means this
           z-index:-1 would escape and paint behind the WHOLE page, not just this
           panel, if left as the only positioned element here - so instead every
           in-flow sibling that must sit above it (h2, the pitch copy, the artifact+
           sport-row layout, the footer) is also given position:relative below,
           with z-index left at the default 'auto'. That groups them all as
           stack-level-0 positioned elements compared by DOM order alone: this
           backdrop, being first in the markup, paints first (bottom); every later
           sibling paints after (on top) - the same "first in DOM sits behind"
           result, achieved without needing negative z-index or a trapping
           stacking context. */
        .hc-tanks-backdrop {
            position: absolute;
            inset: 0;
            pointer-events: none;
            overflow: hidden;
            /* background-image is inline in the markup - /assets/* is a runtime
               path, and this block never passes through a bundler anyway. */
            background-size: cover;
            /* Keep the tunnel's ember glow behind the artifact band (upper-middle
               of the panel once the footer adds height below). */
            background-position: center 55%;
        }
        /* Legibility scrim + soft diorama vignette: darkest where the fine-print
           pitch copy sits (top) and where the picks-left footer sits (bottom), clear
           through the middle so the artifact keeps the full ember glow. */
        .hc-tanks-backdrop::after {
            content: '';
            position: absolute;
            inset: 0;
            background: linear-gradient(
                180deg,
                rgba(5, 7, 15, 0.62) 0%,
                rgba(5, 7, 15, 0.28) 26%,
                rgba(5, 7, 15, 0) 46%,
                rgba(5, 7, 15, 0) 64%,
                rgba(5, 7, 15, 0.45) 100%
            );
            box-shadow: inset 0 0 42px 16px rgba(6, 12, 34, 0.7);
        }

        /* The wind: two soft, blurred light wisps drifting across the cave at
           different speeds - moving air catching the ember light, never a scanline. */
        .hc-tanks-wind {
            position: absolute;
            top: 0;
            height: 100%;
            width: 42%;
            background: linear-gradient(
                100deg,
                transparent 0%,
                rgba(255, 214, 140, 0.07) 38%,
                rgba(255, 255, 255, 0.09) 50%,
                rgba(255, 214, 140, 0.04) 62%,
                transparent 100%
            );
            filter: blur(13px);
            opacity: 0;
            animation: hc-wind-sweep 14s linear infinite;
        }
        .hc-tanks-wind--b {
            width: 26%;
            top: 12%;
            height: 76%;
            animation-duration: 23s;
            animation-delay: 7s;
        }
        @keyframes hc-wind-sweep {
            0% { transform: translateX(-130%) skewX(-9deg); opacity: 0; }
            14% { opacity: 1; }
            72% { opacity: 0.7; }
            100% { transform: translateX(360%) skewX(-9deg); opacity: 0; }
        }
        @media (prefers-reduced-motion: reduce) {
            .hc-tanks-wind { animation: none; opacity: 0; }
        }
        /* position:relative on all four here (z-index left at 'auto') is what makes
           them paint above .hc-tanks-backdrop - see that rule's comment. */
        #tanks h2 {
            position: relative;
            background: var(--hc-gold); color: #1a1200;
            margin: 0 -1.1rem 0.75rem; padding: 0.65rem 1.1rem;
        }
        .hc-section-sub--tanks { position: relative; margin-top: 0; }

        /* Panel footer: picks-remaining header (island-filled; hidden while empty)
           over the crawlable Tank HQ pointer. */
        .hc-tanks-footer { position: relative; margin-top: 1rem; padding-top: 0.75rem; border-top: 1px solid rgba(47, 230, 217, 0.2); }
        .hc-picks-status {
            font-family: 'Baloo 2', 'Nunito', sans-serif; font-weight: 800;
            font-size: 0.95rem; letter-spacing: 0.05em; text-transform: uppercase;
            color: var(--hc-gold);
        }
        .hc-picks-status:empty { display: none; }
        .hc-tanks-hq-link { margin: 0.35rem 0 0; font-size: 0.8rem; color: rgba(255,255,255,0.6); }
        .hc-tanks-hq-link a { color: var(--hc-teal); font-weight: 800; text-decoration: none; }
        .hc-tanks-hq-link a:hover { text-decoration: underline; }

        /* Tighter seam under Market Movers (mobile especially). */
        #explore.hc-section { margin-top: 1rem; }
        .hc-explore-wrap { position: relative; margin-top: 0.75rem; }
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

        /* Register CTA card (logged-out only). Mobile: centered under the world,
           before the footer. Click movement: hover lift, active squash, and the
           island toggles .is-popping for a jiggle before the modal opens. */
        .hc-register-cta {
            display: block;
            background: none; border: none; padding: 0; cursor: pointer;
            margin: 2rem auto 0; /* clear breathing room under the world on mobile */
            width: min(420px, 92%);
            -webkit-tap-highlight-color: transparent;
            transition: transform 0.15s ease, filter 0.2s ease;
        }
        .hc-register-cta img {
            display: block; width: 100%; height: auto;
            border-radius: 18px;
            box-shadow: 0 14px 40px rgba(0, 0, 0, 0.5), 0 0 0 2px rgba(47, 230, 217, 0.25);
        }
        .hc-register-cta:hover { transform: translateY(-3px) scale(1.02); filter: brightness(1.05); }
        .hc-register-cta:active { transform: scale(0.95); }
        .hc-register-cta:focus-visible { outline: 3px solid var(--hc-teal); outline-offset: 4px; border-radius: 18px; }
        .hc-register-cta.is-popping { animation: hc-register-pop 0.35s ease; }
        @keyframes hc-register-pop {
            0% { transform: scale(1); }
            30% { transform: scale(0.92) rotate(-2deg); }
            65% { transform: scale(1.05) rotate(1.5deg); }
            100% { transform: scale(1); }
        }

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
            }
            .hc-home-header { grid-area: header; }
            .hc-ticker-tape { grid-area: tape; }
            /* align-self: start (overriding the grid row's default stretch) so Tanks
               sizes to its own content instead of being pulled down to match Market
               Movers' height - Market Movers (chart + news + results per card) is the
               naturally longer panel and should read that way, not get matched by an
               artificially stretched Tanks panel. */
            #tanks { grid-area: tanks; align-self: start; }
            #market-movers { grid-area: movers; }
            #explore { grid-area: explore; }
            .hc-footer { grid-area: footer; }

            #tanks { margin-top: 1.5rem; }

            /* Explore: globe seated left on the page's own navy background (one
               consistent color story all the way down). Logged out, the register CTA
               card sits to the world's right; logged in, the open right half is
               where the fixed pet widget visually lives. */
            #explore { margin-top: 2rem; }
            /* The logo stays IN FLOW above (so the world sits right under it, same
               slight overlap as mobile via the logo's negative bottom margin). The
               register CTA docks absolute at the wrap's TOP-RIGHT: level with the
               EXPLORE logo, its right edge on the container edge - the same edge the
               Market Movers panel above ends on. */
            #explore .hc-explore-wrap { margin-top: 0.5rem; }
            #hc-map-root { max-width: 620px; }
            .hc-register-cta { position: absolute; top: 0; right: 0; width: 340px; margin: 0; }
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
        ${renderExplore(user)}
        ${footer()}
    </main>
    <script type="application/json" id="homepage-data">${payloadJson}</script>
    <script type="module" src="/assets/homepage.js" defer></script>
</body>
</html>`;
}
