import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Fishtank, type DeckPayload } from './Fishtank';
import { PetWidget } from './PetWidget';
import { MapHud } from './MapHud';
import { NotificationsHost } from './NotificationsHost';
import { trackEvent } from '../tank-analytics-client';
import { SPORT_BY_LEAGUE, SPORT_ORDER, type Sport } from '../sport-map';
import tanksBackgroundSrc from '../assets/new-website/Tanks- Background.svg';
import './TankScreen.css';

// Matches the SVG's own declared viewBox (assets/new-website/Tanks- Background.svg).
const VIEWBOX = { width: 810, height: 1439.999935 };

// Hand-traced quadrilateral of the in-scene "TANKS AVAILABLE" monitor (its top
// edge tilts noticeably due to the tank's cylindrical perspective, so a plain
// axis-aligned rect doesn't cleanly follow it), converted from the raw artwork's
// pixel space through the SVG's embedding transform into viewBox units - same
// technique as components/worldMapRegions.ts.
const SCREEN_HOTSPOT_PATH = 'M24,246 L431,329 L446,675 L28,679 Z';
const SCREEN_HOTSPOT_ID = 'tank-screen-clip';

export interface TankEntry {
  slug: string;
  league: string;
  matchup: string;
  payload: DeckPayload;
}

type SportFilter = 'All' | Sport;

interface TankScreenProps {
  tanks: TankEntry[];
}

export const TankScreen: React.FC<TankScreenProps> = ({ tanks }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [index, setIndex] = useState(0);
  const [sportFilter, setSportFilter] = useState<SportFilter>('All');
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const hotspotRef = useRef<SVGGElement>(null);

  // Only sports with at least one live tank get a chip; a chip can therefore never
  // select an empty list.
  const liveSports = SPORT_ORDER.filter((s) => tanks.some((t) => SPORT_BY_LEAGUE[t.league] === s));
  const visibleTanks = sportFilter === 'All' ? tanks : tanks.filter((t) => SPORT_BY_LEAGUE[t.league] === sportFilter);
  const hasTanks = visibleTanks.length > 0;

  const open = useCallback(() => {
    setIsOpen(true);
    trackEvent('tank_opened', { tankSlug: visibleTanks[index]?.slug });
  }, [visibleTanks, index]);

  const close = useCallback(() => {
    setIsOpen(false);
    hotspotRef.current?.focus();
  }, []);

  const prev = useCallback(() => {
    setIndex((i) => (hasTanks ? (i - 1 + visibleTanks.length) % visibleTanks.length : 0));
  }, [hasTanks, visibleTanks.length]);

  const next = useCallback(() => {
    setIndex((i) => (hasTanks ? (i + 1) % visibleTanks.length : 0));
  }, [hasTanks, visibleTanks.length]);

  // Filter change restarts the carousel - index positions are meaningless across
  // different filtered lists.
  const selectFilter = useCallback((f: SportFilter) => {
    setSportFilter(f);
    setIndex(0);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    document.body.style.overflow = 'hidden';
    closeButtonRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowLeft') prev();
      if (e.key === 'ArrowRight') next();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = '';
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen, close, prev, next]);

  const handleHotspotKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      open();
    }
  }, [open]);

  const current = hasTanks ? visibleTanks[index] : null;

  return (
    <div className="tank-screen">
      <div className="tank-screen__frame">
        <svg
          className="tank-screen__svg"
          viewBox={`0 0 ${VIEWBOX.width} ${VIEWBOX.height}`}
          preserveAspectRatio="xMidYMid slice"
          role="img"
          aria-label="The Tank - HeatChecks headquarters"
        >
          <defs>
            <clipPath id={SCREEN_HOTSPOT_ID}>
              <path d={SCREEN_HOTSPOT_PATH} />
            </clipPath>
            <linearGradient id="tank-screen-scanline-gradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#7fe9ff" stopOpacity="0" />
              <stop offset="50%" stopColor="#7fe9ff" stopOpacity="0.9" />
              <stop offset="100%" stopColor="#7fe9ff" stopOpacity="0" />
            </linearGradient>
          </defs>
          <image
            href={tanksBackgroundSrc}
            x={0}
            y={0}
            width={VIEWBOX.width}
            height={VIEWBOX.height}
            className="tank-screen__background"
          />
          <g
            ref={hotspotRef}
            className={[
              'tank-screen__hotspot',
              isHovered || isFocused ? 'is-active' : '',
            ].filter(Boolean).join(' ')}
            role="button"
            tabIndex={0}
            aria-label="Tanks available - view stories"
            onClick={open}
            onKeyDown={handleHotspotKeyDown}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
          >
            <path className="tank-screen__glow" d={SCREEN_HOTSPOT_PATH} />
            <path className="tank-screen__outline" d={SCREEN_HOTSPOT_PATH} />
            <path className="tank-screen__brighten" d={SCREEN_HOTSPOT_PATH} />
            <g className="tank-screen__scanline-clip" clipPath={`url(#${SCREEN_HOTSPOT_ID})`}>
              <rect className="tank-screen__scanline" x={20} y={200} width={430} height={70} />
            </g>
            <path className="tank-screen__hit" d={SCREEN_HOTSPOT_PATH} />
          </g>
        </svg>

        {/* Identity HUD (username + Ember, mini nav) - replaces the old checkmark
            back button in the card's top-right corner. */}
        <MapHud />
      </div>

      {/* Captain widget, bottom-right. Outside the transformed frame so its fixed
          modal overlays aren't containing-block-trapped. */}
      <PetWidget />
      <NotificationsHost />

      {isOpen && (
        // Deliberately NOT closed by overlay clicks: dragging the 3D cube often ends
        // with the pointer over the overlay, which used to dismiss the whole modal
        // mid-interaction. Only the X button (and Escape) closes it now.
        <div className="tank-modal-overlay">
          <div
            className="tank-modal-panel"
            role="dialog"
            aria-modal="true"
            aria-label="Tanks available"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="tank-modal-header">
              <span>Tanks Available</span>
              <button ref={closeButtonRef} className="tank-modal-close" onClick={close} aria-label="Close">
                &times;
              </button>
            </div>

            <div className="tank-modal-body">
              {tanks.length > 0 && liveSports.length > 0 && (
                <div className="tank-modal-filters" aria-label="Filter tanks by sport">
                  {(['All', ...liveSports] as SportFilter[]).map((f) => (
                    <button
                      key={f}
                      className={`tank-modal-filter${sportFilter === f ? ' is-active' : ''}`}
                      onClick={() => selectFilter(f)}
                      aria-pressed={sportFilter === f}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              )}
              {!current ? (
                <div className="tank-modal-empty">
                  <p>No tanks available yet.</p>
                  <p>Check back soon.</p>
                </div>
              ) : (
                <>
                  <div className="tank-modal-matchup">{current.league} &middot; {current.matchup}</div>
                  <Fishtank key={current.slug} payload={current.payload} slug={current.slug} scale={0.8} />
                  {visibleTanks.length > 1 && (
                    <div className="tank-modal-nav">
                      <button className="tank-modal-arrow" onClick={prev} aria-label="Previous tank">
                        &lsaquo;
                      </button>
                      <span className="tank-modal-count">{index + 1} / {visibleTanks.length}</span>
                      <button className="tank-modal-arrow" onClick={next} aria-label="Next tank">
                        &rsaquo;
                      </button>
                    </div>
                  )}
                  <a className="tank-modal-view-story" href={`/the-tank/articles/${current.slug}/`}>
                    View Story <span aria-hidden="true">&rarr;</span>
                  </a>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TankScreen;
