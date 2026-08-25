// Standalone bundle (third entry in scripts/build-tank-bundles.ts, not the main Vite
// app) that progressively enhances the server-rendered homepage. The server HTML is
// canonical - header, sport cards, feed, and static map picture are all real content
// without JS. This island only adds: (1) the 3D Fishtank showcase for the selected
// sport, (2) the interactive world map (replacing the static picture), and (3) row
// behavior (click-to-select, roving-tabindex arrow keys, selection highlight). If the
// payload is missing or malformed, nothing mounts and the page stays fully usable.

import React, { useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import { Fishtank, formatTimeUntilReset, type DeckPayload } from './components/Fishtank';
import { PetWidget } from './components/PetWidget';
import { RegisterModal } from './components/RegisterModal';
import { NotificationsHost } from './components/NotificationsHost';
import { dispatchInboxOpen } from './notifications-client';
import { getTodayStatus, logout, PICKS_UPDATED_EVENT } from './tank-pick-client';
// The header chip's mini nav reuses the map pages' MapHud menu styling.
import './components/MapHud.css';
import { WorldMap } from './components/WorldMap';
import { WORLD_MAP_REGIONS, type WorldMapRegion } from './components/worldMapRegions';
import type { Sport } from './sport-map';

interface HomepageSportEntry {
    sport: Sport;
    live: boolean;
    slug: string | null;
    href: string | null;
    deck: DeckPayload | null;
}

interface HomepagePayload {
    initialSport: Sport;
    // Server-known per request (the page renders private/no-store with the session
    // in hand) - decides the showcase's 4th wall without any client session fetch.
    loggedIn?: boolean;
    sports: HomepageSportEntry[];
}

// Map island id → sport slot. baseballBat and baseball are two islands for the same
// sport - both select Baseball. hockey/golf are absent: no league feeds them yet, so
// they stay disabled "Coming Soon" islands (same treatment as /claim-your-spot/).
const REGION_SPORT: Record<string, Sport> = {
    football: 'Football',
    soccer: 'Soccer',
    basketball: 'Basketball',
    baseball: 'Baseball',
    baseballBat: 'Baseball',
};

function readPayload(): HomepagePayload | null {
    const el = document.getElementById('homepage-data');
    if (!el || !el.textContent) return null;
    try {
        const parsed = JSON.parse(el.textContent);
        if (!parsed || !Array.isArray(parsed.sports)) return null;
        return parsed as HomepagePayload;
    } catch (err) {
        console.error('[Homepage] Failed to parse payload:', err);
        return null;
    }
}

// Market Movers gainers/losers toggle - vanilla like the sport row, and deliberately
// payload-independent: the section's HTML is complete server-side (all cards render;
// filtering is pure CSS keyed on the grid's data-mm-view). JS only reveals the tab
// strip (shipped `hidden`) and flips the attribute + aria-pressed.
function mountMarketMoversToggle() {
    const tabs = document.querySelector<HTMLElement>('[data-hc-mm-tabs]');
    const grid = document.querySelector<HTMLElement>('[data-hc-mm-grid]');
    if (!tabs || !grid) return;
    tabs.hidden = false;
    // The mockup's default view is Top Gainers; the server renders "all" so the no-JS
    // page shows everything. Flip to gainers here, matching the pre-rendered
    // aria-pressed state on the gainers button.
    grid.dataset.mmView = 'gainers';
    tabs.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLElement>('button[data-mm-view]');
        if (!btn || !btn.dataset.mmView) return;
        grid.dataset.mmView = btn.dataset.mmView;
        for (const b of tabs.querySelectorAll<HTMLElement>('button[data-mm-view]')) {
            b.setAttribute('aria-pressed', String(b === btn));
        }
    });
}

// Register CTA (logged-out only; the server renders the card only then). Click
// plays the pop jiggle, then mounts the RegisterModal into a lazily-created body
// root - body-level so the modal's fixed overlay isn't trapped by any ancestor.
// The server renders TWO copies on the homepage (header for desktop, its own
// row between the ticker and Tanks panel for mobile - see renderHomepage()),
// CSS shows exactly one per breakpoint, so every match gets wired; only the
// visible one is ever actually clickable, and both share one modal host.
function mountRegisterCta() {
    const ctas = document.querySelectorAll<HTMLElement>('[data-hc-register]');
    if (!ctas.length) return;
    let modalHost: ReturnType<typeof createRoot> | null = null;
    let hostEl: HTMLDivElement | null = null;

    const closeModal = () => {
        modalHost?.render(null);
    };
    const openModal = () => {
        if (!hostEl) {
            hostEl = document.createElement('div');
            document.body.appendChild(hostEl);
            modalHost = createRoot(hostEl);
        }
        modalHost!.render(<RegisterModal onClose={closeModal} />);
    };

    ctas.forEach((cta) => {
        cta.addEventListener('click', () => {
            cta.classList.remove('is-popping');
            // Force a reflow so re-adding the class replays the animation.
            void cta.offsetWidth;
            cta.classList.add('is-popping');
            window.setTimeout(openModal, 200); // mid-jiggle, so the movement reads
        });
        cta.addEventListener('animationend', () => cta.classList.remove('is-popping'));
    });
}

// Header identity chip -> the same mini nav the map pages' MapHud has (Home /
// Log out). The chip itself is server-rendered (.hc-auth, logged-in only); this
// just makes it clickable and hangs the dropdown off it. Vanilla, like the other
// header/row enhancements.
function mountHeaderMenu() {
    const auth = document.querySelector<HTMLElement>('.hc-auth');
    if (!auth) return; // logged out - the header shows the Log in button instead

    auth.setAttribute('role', 'button');
    auth.setAttribute('tabindex', '0');
    auth.setAttribute('aria-haspopup', 'menu');
    auth.setAttribute('aria-expanded', 'false');
    auth.classList.add('hc-auth--clickable');

    const menu = document.createElement('div');
    menu.className = 'map-hud__menu hc-auth-menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    menu.innerHTML = `
        <a class="map-hud__item" role="menuitem" href="/">Home</a>
        <button type="button" class="map-hud__item" role="menuitem" data-hc-inbox>Inbox</button>
        <button type="button" class="map-hud__item" role="menuitem" data-hc-logout>Log out</button>`;
    auth.appendChild(menu);

    const setOpen = (open: boolean) => {
        menu.hidden = !open;
        auth.setAttribute('aria-expanded', String(open));
    };
    auth.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.hc-auth-menu')) return; // menu clicks act, not toggle
        setOpen(menu.hidden);
    });
    auth.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !(e.target as HTMLElement).closest('.hc-auth-menu')) {
            e.preventDefault();
            setOpen(menu.hidden);
        }
        if (e.key === 'Escape') setOpen(false);
    });
    document.addEventListener('pointerdown', (e) => {
        if (!auth.contains(e.target as Node)) setOpen(false);
    });
    menu.querySelector<HTMLButtonElement>('[data-hc-inbox]')?.addEventListener('click', () => {
        setOpen(false);
        dispatchInboxOpen();
    });
    menu.querySelector<HTMLButtonElement>('[data-hc-logout]')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget as HTMLButtonElement;
        btn.disabled = true;
        btn.textContent = 'Logging out…';
        try { await logout(); } catch { /* leave anyway - the server re-checks */ }
        window.location.href = '/';
    });
}

// The inbox modal's mount point on the homepage: a body-level root, so it exists for
// every logged-in visitor (with or without a pet/showcase) and can never be trapped
// by a transformed ancestor.
function mountNotificationsHost() {
    const root = document.createElement('div');
    document.body.appendChild(root);
    createRoot(root).render(<NotificationsHost />);
}

// Picks-remaining footer in the tanks panel (vanilla, session-driven). Logged out
// (getTodayStatus -> null) leaves the element empty, which CSS hides (:empty) - the
// crawlable Tank HQ line below it always shows. When the cap is hit, the countdown
// to the UTC-midnight reset re-renders every minute; a bfcache restore re-fetches.
// Also re-fetches on PICKS_UPDATED_EVENT: the showcase's own Fishtank/CallContent
// tracks today's picks in its own React state (independent of this footer's fetch),
// so without this listener a pick made in the artifact updates the artifact's own
// count immediately but leaves this footer showing the stale pre-pick number until a
// full reload.
function mountPicksStatus() {
    const el = document.getElementById('hc-picks-status');
    if (!el) return;
    let timer: number | null = null;

    const render = (remaining: number, picksToday: number) => {
        if (timer !== null) { window.clearInterval(timer); timer = null; }
        if (remaining > 0) {
            el.textContent = `${remaining} pick${remaining === 1 ? '' : 's'} left today`;
            return;
        }
        const tick = () => {
            el.textContent = `All ${picksToday} pick${picksToday === 1 ? '' : 's'} used — next pick in ${formatTimeUntilReset(Date.now())}`;
        };
        tick();
        timer = window.setInterval(tick, 60_000);
    };

    const refresh = () => {
        getTodayStatus()
            .then((status) => { if (status) render(status.remaining, status.picksToday); })
            .catch(() => { /* footer is a nicety - never surface errors */ });
    };

    refresh();
    window.addEventListener('pageshow', (e) => { if (e.persisted) refresh(); });
    window.addEventListener(PICKS_UPDATED_EVENT, refresh);
}

function mount() {
    mountMarketMoversToggle();
    mountNotificationsHost();
    mountPicksStatus();
    mountHeaderMenu();
    mountRegisterCta();

    const payload = readPayload();
    if (!payload) return;

    const entriesBySport = new Map<Sport, HomepageSportEntry>(
        payload.sports.map(entry => [entry.sport, entry])
    );
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const scrollBehavior: ScrollBehavior = prefersReducedMotion ? 'auto' : 'smooth';

    // ---- module-level micro-store shared by both roots and the vanilla row ----
    let selectedSport: Sport = payload.initialSport;
    const listeners = new Set<() => void>();
    const subscribe = (fn: () => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
    };
    const getSelected = () => selectedSport;

    const row = document.querySelector<HTMLElement>('[data-hc-row]');
    const sportButtons = row ? Array.from(row.querySelectorAll<HTMLElement>('.hc-sport-btn')) : [];

    function updateRowSelection() {
        for (const btn of sportButtons) {
            const isSelected = btn.dataset.sport === selectedSport;
            btn.classList.toggle('is-selected', isSelected);
            if (btn.hasAttribute('aria-pressed') || isSelected) {
                btn.setAttribute('aria-pressed', String(isSelected));
            }
        }
    }

    function selectSport(sport: Sport, _opts: { scrollRow?: boolean } = {}) {
        if (!entriesBySport.has(sport)) return;
        selectedSport = sport;
        listeners.forEach(fn => fn());
        updateRowSelection();
    }

    // ---- sport buttons (vanilla): pressing a live sport's button flips the 3D
    // showcase to that sport's newest Tank. Native <button>s, so no roving-tabindex
    // machinery - disabled placeholders aren't clickable or focusable by default.
    if (row && sportButtons.length > 0) {
        row.addEventListener('click', (e) => {
            const btn = (e.target as HTMLElement).closest<HTMLElement>('.hc-sport-btn[data-live]');
            if (btn?.dataset.sport) selectSport(btn.dataset.sport as Sport);
        });
        updateRowSelection();
    }

    // ---- showcase root: the selected sport's tank as the 3D artifact ----
    const Showcase: React.FC = () => {
        const sport = useSyncExternalStore(subscribe, getSelected);
        const entry = entriesBySport.get(sport);
        if (!entry || !entry.live || !entry.deck || !entry.slug || !entry.href) {
            // Quiet placeholder - showcase root is aria-hidden, so purely visual.
            return (
                <div style={{
                    maxWidth: 480, margin: '0 auto', padding: '2.5rem 1rem', textAlign: 'center',
                    background: 'rgba(255,255,255,0.03)', border: '1px dashed rgba(255,255,255,0.15)',
                    borderRadius: 18, color: 'rgba(255,255,255,0.6)', fontSize: '0.9rem', fontWeight: 700,
                }}>
                    Nothing live in {sport.toLowerCase()} today.
                </div>
            );
        }
        // Logged in: the full Tank-modal experience - two takes + the interactive
        // pick wall (CallContent self-hydrates from the session cookie) - pulled up
        // toward the section sub-header (the shrunken cube leaves dead space in its
        // 420px stage), with the captain widget docked at the showcase's bottom
        // right in the freed room. Logged out: read-the-story link wall + the
        // signup pitch wall as the 4th side (/login/ IS signup - email-only magic
        // link, no separate register).
        //
        // 0.64 mobile / 0.77 desktop (+20% for the roomier two-column panel).
        // Fishtank's stage box stays 420px regardless of scale (see the note on its
        // `scale` prop), so the desktop bump changes only the painted cube - the
        // panel keeps its height and stays matched to the Market Movers column. The
        // dead stage space is pulled back in with margins rather than left as a gap.
        // Deliberately NOT a CSS transform on a wrapper: that would turn the wrapper
        // into the containing block for the fixed PetWidget and its modal overlays.
        const showcaseScale = window.matchMedia('(min-width: 1024px)').matches ? 0.77 : 0.64;
        return (
            <MotionConfig reducedMotion="user">
                {payload.loggedIn ? (
                    <div style={{ position: 'relative', marginTop: '-4.25rem', marginBottom: '-2.5rem' }}>
                        {/* The cave backdrop is no longer mounted here - it's the
                            server-rendered .hc-tanks-backdrop behind the whole #tanks
                            panel (homepage/render.ts). */}
                        <Fishtank key={entry.slug} payload={entry.deck} slug={entry.slug} scale={showcaseScale} />
                        {/* Fixed variant: rides the viewport, so the captain stays in
                            view wherever the page is scrolled. */}
                        <PetWidget variant="fixed" />
                    </div>
                ) : (
                    <div style={{ position: 'relative', margin: '-2.5rem 0' }}>
                        <Fishtank
                            key={entry.slug}
                            payload={entry.deck}
                            slug={entry.slug}
                            linkCall={{ href: entry.href }}
                            promoWall={{
                                label: 'Join HeatChecks',
                                body: 'Experience a new way to enjoy the sports content you love. Make your picks, grow your Mud Puppy, and compete in a new sports world.',
                                ctaHref: '/login/',
                                ctaLabel: 'Sign Up',
                            }}
                            openWall="promo"
                            scale={showcaseScale}
                        />
                    </div>
                )}
            </MotionConfig>
        );
    };

    const showcaseRoot = document.getElementById('hc-showcase-root');
    if (showcaseRoot) createRoot(showcaseRoot).render(<Showcase />);

    // ---- map root: interactive world map replaces the static picture ----
    const HOMEPAGE_REGIONS: WorldMapRegion[] = WORLD_MAP_REGIONS.map((region) => {
        if (region.type === 'central') return { ...region, name: 'The Tank', route: '/the-tank/' };
        if (REGION_SPORT[region.id]) return region;
        return { ...region, disabled: true }; // hockey, golf - no content pipeline yet
    });

    const handleNavigate = (route: string, region: WorldMapRegion) => {
        const sport = REGION_SPORT[region.id];
        if (sport) {
            selectSport(sport, { scrollRow: true });
            document.getElementById('tanks')?.scrollIntoView({ block: 'start', behavior: scrollBehavior });
            return;
        }
        // Central region (The Tank) keeps real navigation.
        window.location.href = route;
    };

    const mapRoot = document.getElementById('hc-map-root');
    if (mapRoot) {
        // createRoot().render() appends rather than replacing, so drop the static
        // no-JS world-map <picture> fallback before mounting the interactive map.
        mapRoot.replaceChildren();
        createRoot(mapRoot).render(<WorldMap regions={HOMEPAGE_REGIONS} onNavigate={handleNavigate} />);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
} else {
    mount();
}
