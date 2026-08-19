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
import { SPORT_ORDER, type Sport } from '../../../sport-map';
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

// Island colors from components/worldMapRegions.ts, so the row's sport badges and the
// map speak the same visual language.
const SPORT_COLORS: Record<Sport, string> = {
    Baseball: '#ef4444',
    Basketball: '#f59e0b',
    Football: '#a855f7',
    Soccer: '#84cc16',
};

const EMBER_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="currentColor"><path d="M12 2c.6 3.8-1.2 5.6-2.9 7.3C7.4 11 6 12.6 6 15a6 6 0 0 0 12 0c0-1.7-.6-3.1-1.5-4.5-.4 1-.9 1.7-1.8 2.3.3-3.4-1-6.5-2.7-8.8Z"/></svg>`;

function sportBadge(sport: Sport): string {
    return `<span class="hc-sport-badge"><span class="hc-sport-dot" style="background:${SPORT_COLORS[sport]}"></span>${sport}</span>`;
}

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

// One card per sport. Live sports first (in SPORT_ORDER), placeholder sports pushed to
// the end - most useful content lands in the first swipe. Placeholders are real,
// visible cards, never collapsed slots, so the row reads the same every day.
function renderSportRow(slots: SportSlot[]): string {
    const ordered = [...slots.filter(s => s.card), ...slots.filter(s => !s.card)];
    const cards = ordered.map((slot, i) => {
        const tabindex = i === 0 ? '0' : '-1'; // roving tabindex; island moves it with arrow keys
        if (!slot.card) {
            return `
            <li class="hc-sport-card is-empty" data-sport="${slot.sport}" tabindex="${tabindex}" aria-label="${slot.sport}: nothing live today">
                ${sportBadge(slot.sport)}
                <p class="hc-empty-note">Nothing live in ${slot.sport.toLowerCase()} today.</p>
                <p class="hc-empty-sub">New stories drop as games approach.</p>
            </li>`;
        }
        const c = slot.card;
        return `
            <li class="hc-sport-card" data-sport="${slot.sport}" data-live tabindex="${tabindex}" aria-label="${escapeHtml(`${slot.sport}: ${c.hook}`)}">
                ${sportBadge(slot.sport)}
                <h3 class="hc-hook">${escapeHtml(c.hook)}</h3>
                <p class="hc-beat">${escapeHtml(c.firstBeat)}</p>
                <span class="hc-prop-tag">${escapeHtml(c.propTag)}</span>
                <a class="hc-card-cta" href="${escapeHtml(c.href)}">Read the story <span aria-hidden="true">&rarr;</span></a>
            </li>`;
    }).join('');

    return `
        <section id="tanks" class="hc-section" aria-labelledby="hc-tanks-heading">
            <h2 id="hc-tanks-heading">Today&rsquo;s Tanks</h2>
            <p class="hc-section-sub">One live story per sport. Read it, then make your call in the Tank.</p>
            <div id="hc-showcase-root" aria-hidden="true"></div>
            <ul class="hc-sport-row" data-hc-row>
                ${cards}
            </ul>
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
        .hc-visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

        #hc-showcase-root:empty { display: none; }
        #hc-showcase-root { margin: 0 0 1.25rem; }

        .hc-sport-row {
            list-style: none; margin: 0; padding: 0 0 0.75rem;
            display: flex; gap: 0.75rem;
            overflow-x: auto; scroll-snap-type: x mandatory; scroll-padding: 1.25rem;
            -webkit-overflow-scrolling: touch;
        }
        .hc-sport-card {
            flex: 0 0 78%; max-width: 340px; scroll-snap-align: start;
            display: flex; flex-direction: column; align-items: flex-start; gap: 0.55rem;
            background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12);
            border-radius: 18px; padding: 1.1rem 1.1rem 1.2rem;
        }
        .hc-sport-card.is-selected, .hc-sport-card[aria-current="true"] {
            border-color: rgba(47, 230, 217, 0.65); box-shadow: 0 0 18px rgba(47, 230, 217, 0.25);
        }
        .hc-sport-card:focus-visible { outline: 2px solid var(--hc-teal); outline-offset: 2px; }
        .hc-sport-badge {
            display: inline-flex; align-items: center; gap: 0.4rem;
            font-weight: 800; font-size: 0.72rem; letter-spacing: 0.08em; text-transform: uppercase;
            color: rgba(255,255,255,0.85);
        }
        .hc-sport-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; box-shadow: 0 0 8px currentColor; }
        .hc-hook { font-family: 'Baloo 2', 'Nunito', sans-serif; font-weight: 800; font-size: 1.05rem; line-height: 1.25; margin: 0; }
        .hc-beat { font-size: 0.85rem; line-height: 1.45; color: rgba(255,255,255,0.82); margin: 0; }
        .hc-prop-tag {
            font-family: 'Nunito', sans-serif; font-weight: 800; font-size: 0.72rem;
            letter-spacing: 0.05em; text-transform: uppercase;
            color: var(--hc-teal); background: rgba(47, 230, 217, 0.1);
            border: 1px solid rgba(47, 230, 217, 0.45); border-radius: 999px; padding: 0.25rem 0.7rem;
        }
        .hc-card-cta {
            margin-top: auto; font-weight: 800; font-size: 0.85rem;
            color: var(--hc-gold); text-decoration: none;
        }
        .hc-card-cta:hover { text-decoration: underline; }
        .hc-sport-card.is-empty { justify-content: center; border-style: dashed; background: rgba(255,255,255,0.03); }
        .hc-empty-note { font-weight: 800; font-size: 0.9rem; margin: 0; color: rgba(255,255,255,0.75); }
        .hc-empty-sub { font-size: 0.78rem; margin: 0; color: rgba(255,255,255,0.5); }

        @media (min-width: 760px) {
            .hc-sport-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); overflow: visible; }
            .hc-sport-card { flex: initial; max-width: none; }
        }

        .hc-explore-wrap { position: relative; margin-top: 1.5rem; }
        .hc-explore-logo {
            position: absolute; top: -4.5%; left: -3%; width: clamp(130px, 26%, 250px); height: auto;
            z-index: 2; pointer-events: none; filter: drop-shadow(0 8px 16px rgba(0,0,0,0.45));
        }
        .hc-world-map-static, #hc-map-root svg { display: block; width: 100%; height: auto; }

        @media (prefers-reduced-motion: reduce) {
            .hc-sport-row { scroll-behavior: auto; }
        }
        @media (max-width: 420px) {
            .hc-home { padding: 0.6rem 1rem 0.85rem; }
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
