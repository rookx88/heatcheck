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
import { Fishtank, type DeckPayload } from './components/Fishtank';
import { PetWidget } from './components/PetWidget';
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

function mount() {
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
    const cards = row ? Array.from(row.querySelectorAll<HTMLElement>('.hc-sport-card')) : [];

    function updateRowSelection(scrollRow: boolean) {
        for (const card of cards) {
            const isSelected = card.dataset.sport === selectedSport;
            card.classList.toggle('is-selected', isSelected);
            if (isSelected) {
                card.setAttribute('aria-current', 'true');
                if (scrollRow) card.scrollIntoView({ inline: 'start', block: 'nearest', behavior: scrollBehavior });
            } else {
                card.removeAttribute('aria-current');
            }
        }
    }

    function selectSport(sport: Sport, opts: { scrollRow?: boolean } = {}) {
        if (!entriesBySport.has(sport)) return;
        selectedSport = sport;
        listeners.forEach(fn => fn());
        updateRowSelection(Boolean(opts.scrollRow));
    }

    // ---- row enhancement (vanilla - the server cards ARE the UI) ----
    if (row && cards.length > 0) {
        row.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;
            if (target.closest('a')) return; // CTA keeps its normal navigation
            const card = target.closest<HTMLElement>('.hc-sport-card');
            if (card?.dataset.sport) selectSport(card.dataset.sport as Sport);
        });

        // Roving tabindex: the server renders the first card tabindex="0", rest -1;
        // arrow keys move both focus and selection.
        row.addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            const current = cards.indexOf(document.activeElement as HTMLElement);
            if (current === -1) return;
            e.preventDefault();
            const delta = e.key === 'ArrowRight' ? 1 : -1;
            const next = (current + delta + cards.length) % cards.length;
            cards[current].setAttribute('tabindex', '-1');
            cards[next].setAttribute('tabindex', '0');
            cards[next].focus();
            if (cards[next].dataset.sport) selectSport(cards[next].dataset.sport as Sport);
        });

        updateRowSelection(false);
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
        // 0.56 = the original 0.8 showcase cube shrunk a further 30%. Fishtank's
        // stage box stays 420px regardless of scale (see the note on its `scale`
        // prop), so the extra ~50px of dead space freed per side is pulled back in
        // with margins here rather than left as a gap in the page flow.
        return (
            <MotionConfig reducedMotion="user">
                {payload.loggedIn ? (
                    <div style={{ position: 'relative', marginTop: '-5.5rem', marginBottom: '-3rem' }}>
                        <Fishtank key={entry.slug} payload={entry.deck} slug={entry.slug} scale={0.56} />
                        {/* Fixed variant: rides the viewport, so the captain stays in
                            view wherever the page is scrolled. */}
                        <PetWidget variant="fixed" />
                    </div>
                ) : (
                    <div style={{ margin: '-3rem 0' }}>
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
                            scale={0.56}
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
