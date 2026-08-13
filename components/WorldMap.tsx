import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  WORLD_MAP_REGIONS,
  WORLD_MAP_VIEWBOX,
  type WorldMapRegion,
} from './worldMapRegions';
import worldMapSrc from '../assets/new-website/HeatChecksWorldMap.svg';
import './WorldMap.css';

// Flip to true (or pass the `debugHotspots` prop) to visualize every SVG
// hotspot region as a filled, labeled outline - useful for tuning the
// hand-traced coastline paths against the artwork.
export const DEBUG_HOTSPOTS = false;

const AQUARIUM_CENTER = { x: 630, y: 600 };
const WATERFALLS: Array<{ x: number; y: number }> = [
  { x: 428, y: 555 },
  { x: 792, y: 560 },
];

interface WorldMapProps {
  /** Called instead of a real navigation when a region is activated. Defaults to window.location.href. */
  onNavigate?: (route: string, region: WorldMapRegion) => void;
  /** Overrides the default WORLD_MAP_REGIONS list, e.g. to mark regions disabled or retarget routes. */
  regions?: WorldMapRegion[];
  /** Force debug hotspot visualization regardless of the DEBUG_HOTSPOTS constant. */
  debugHotspots?: boolean;
  className?: string;
}

type InteractionId = string | null;

function regionShapeProps(region: WorldMapRegion) {
  const { shape } = region;
  if (shape.kind === 'circle') {
    return { Tag: 'circle' as const, props: { cx: shape.cx, cy: shape.cy, r: shape.r } };
  }
  if (shape.kind === 'ellipse') {
    const transform = shape.rotate
      ? `rotate(${shape.rotate} ${shape.cx} ${shape.cy})`
      : undefined;
    return {
      Tag: 'ellipse' as const,
      props: { cx: shape.cx, cy: shape.cy, rx: shape.rx, ry: shape.ry, transform },
    };
  }
  return { Tag: 'path' as const, props: { d: shape.d } };
}

export const WorldMap: React.FC<WorldMapProps> = ({
  onNavigate,
  regions = WORLD_MAP_REGIONS,
  debugHotspots = false,
  className,
}) => {
  const [hoveredId, setHoveredId] = useState<InteractionId>(null);
  const [focusedId, setFocusedId] = useState<InteractionId>(null);
  const [lockedId, setLockedId] = useState<InteractionId>(null);
  const lastPointerType = useRef<string>('mouse');
  const navTimeout = useRef<number | undefined>(undefined);

  const showDebug = debugHotspots || DEBUG_HOTSPOTS;
  // Hover wins over a stale focus: a mouse click can leave a previous region
  // focused (browsers may focus an activated <a>/button), and a sighted mouse
  // user expects the label to follow the cursor, not a no-longer-relevant focus.
  // Keyboard-only users are unaffected since hoveredId stays null for them.
  const activeId = lockedId ?? hoveredId ?? focusedId;
  const activeRegion = useMemo(
    () => regions.find((r) => r.id === activeId) ?? null,
    [regions, activeId]
  );

  const navigate = useCallback(
    (region: WorldMapRegion) => {
      if (onNavigate) {
        onNavigate(region.route, region);
      } else if (typeof window !== 'undefined') {
        window.location.href = region.route;
      }
    },
    [onNavigate]
  );

  const activateRegion = useCallback(
    (region: WorldMapRegion) => {
      const isTouch = lastPointerType.current === 'touch';
      // First tap on a touch device previews the region instead of navigating
      // immediately, since there is no hover state to reveal the label first.
      if (isTouch && hoveredId !== region.id && lockedId !== region.id) {
        setHoveredId(region.id);
        return;
      }

      if (region.disabled) {
        // Inert: hover/focus already reveal the "Coming Soon" label; never lock/navigate.
        return;
      }

      setLockedId(region.id);
      const duration = region.type === 'central' ? 700 : 380;
      window.clearTimeout(navTimeout.current);
      navTimeout.current = window.setTimeout(() => navigate(region), duration);
    },
    [hoveredId, lockedId, navigate]
  );

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    lastPointerType.current = e.pointerType || 'mouse';
  }, []);

  const handleClick = useCallback(
    (region: WorldMapRegion) => (e: React.MouseEvent) => {
      e.preventDefault();
      if (lockedId) return; // already navigating
      activateRegion(region);
    },
    [activateRegion, lockedId]
  );

  const handleKeyDown = useCallback(
    (region: WorldMapRegion) => (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        if (lockedId) return;
        lastPointerType.current = 'keyboard';
        activateRegion(region);
      }
    },
    [activateRegion, lockedId]
  );

  const handleMouseEnter = useCallback(
    (id: string) => () => {
      lastPointerType.current = 'mouse';
      setHoveredId(id);
    },
    []
  );

  const handleMouseLeave = useCallback((id: string) => () => {
    setHoveredId((cur) => (cur === id ? null : cur));
  }, []);

  const handleFocus = useCallback((id: string) => () => setFocusedId(id), []);
  const handleBlur = useCallback(
    (id: string) => () => setFocusedId((cur) => (cur === id ? null : cur)),
    []
  );

  const isNavigatingCentral =
    lockedId != null && regions.find((r) => r.id === lockedId)?.type === 'central';

  const labelStyle = activeRegion
    ? ({
        left: `${(activeRegion.center.x / WORLD_MAP_VIEWBOX.width) * 100}%`,
        top: `${(activeRegion.center.y / WORLD_MAP_VIEWBOX.height) * 100}%`,
        ['--region-color' as any]: activeRegion.color,
      } as React.CSSProperties)
    : undefined;

  return (
    <div
      className={[
        'world-map',
        isNavigatingCentral ? 'world-map--zoom-aquarium' : '',
        showDebug ? 'world-map--debug' : '',
        className || '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={
        isNavigatingCentral
          ? ({
              // Zoom the whole map toward the aquarium on activation.
              '--zoom-origin-x': `${(AQUARIUM_CENTER.x / WORLD_MAP_VIEWBOX.width) * 100}%`,
              '--zoom-origin-y': `${(AQUARIUM_CENTER.y / WORLD_MAP_VIEWBOX.height) * 100}%`,
            } as React.CSSProperties)
          : undefined
      }
    >
      <svg
        className="world-map__svg"
        viewBox={`0 0 ${WORLD_MAP_VIEWBOX.width} ${WORLD_MAP_VIEWBOX.height}`}
        role="img"
        aria-label="HeatCheck world map - select a sport to enter"
        preserveAspectRatio="xMidYMid meet"
      >
        <image
          href={worldMapSrc}
          x={0}
          y={0}
          width={WORLD_MAP_VIEWBOX.width}
          height={WORLD_MAP_VIEWBOX.height}
          className="world-map__background"
        />

        {regions.map((region) => {
          const { Tag, props } = regionShapeProps(region);
          const isHovered = hoveredId === region.id;
          const isFocused = focusedId === region.id;
          const isLocked = lockedId === region.id;
          const isDimmed =
            lockedId != null && !isLocked && (isNavigatingCentral || region.type !== 'central');
          const isActive = isHovered || isFocused || isLocked;
          const isCentral = region.type === 'central';

          return (
            <a
              key={region.id}
              href={region.disabled ? undefined : region.route}
              tabIndex={region.disabled ? 0 : undefined}
              role={region.disabled ? 'button' : undefined}
              aria-disabled={region.disabled ? true : undefined}
              className={[
                'world-map__region',
                isCentral ? 'world-map__region--central' : 'world-map__region--island',
                region.disabled ? 'world-map__region--disabled' : '',
                isActive ? 'is-active' : '',
                isLocked ? 'is-locked' : '',
                isDimmed ? 'is-dimmed' : '',
                isFocused ? 'is-focused' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={{ ['--region-color' as any]: region.color }}
              data-region={region.id}
              onPointerDown={handlePointerDown}
              onClick={handleClick(region)}
              onKeyDown={handleKeyDown(region)}
              onMouseEnter={handleMouseEnter(region.id)}
              onMouseLeave={handleMouseLeave(region.id)}
              onFocus={handleFocus(region.id)}
              onBlur={handleBlur(region.id)}
              aria-label={region.disabled ? `${region.name} - coming soon` : `${region.name} - enter world`}
            >
              {/* soft blurred halo, brightens on hover/focus/active */}
              <Tag {...(props as any)} className="world-map__glow" />
              {/* crisp coastline outline */}
              <Tag {...(props as any)} className="world-map__outline" />
              {/* actual pointer hit target (kept transparent unless debugging) */}
              <Tag {...(props as any)} className="world-map__hit" />

              {isCentral && (
                <g className="world-map__aquarium-fx" aria-hidden="true">
                  <ellipse
                    className="world-map__aquarium-illumination"
                    cx={AQUARIUM_CENTER.x}
                    cy={AQUARIUM_CENTER.y}
                    rx={220}
                    ry={200}
                  />
                  <ellipse
                    className="world-map__aquarium-brighten"
                    cx={AQUARIUM_CENTER.x}
                    cy={AQUARIUM_CENTER.y - 10}
                    rx={145}
                    ry={115}
                  />
                  <ellipse
                    className="world-map__aquarium-shimmer"
                    cx={AQUARIUM_CENTER.x}
                    cy={AQUARIUM_CENTER.y + 40}
                    rx={120}
                    ry={90}
                  />
                  {WATERFALLS.map((w, i) => (
                    <circle
                      key={i}
                      className="world-map__waterfall-glow"
                      cx={w.x}
                      cy={w.y}
                      r={46}
                    />
                  ))}
                  {Array.from({ length: 7 }).map((_, i) => (
                    <circle
                      key={i}
                      className="world-map__bubble"
                      style={{ ['--bubble-i' as any]: i }}
                      cx={AQUARIUM_CENTER.x - 60 + ((i * 37) % 140)}
                      cy={AQUARIUM_CENTER.y + 90}
                      r={2 + (i % 3)}
                    />
                  ))}
                </g>
              )}

              {showDebug && (
                <Tag {...(props as any)} className="world-map__debug-fill" />
              )}
            </a>
          );
        })}
      </svg>

      {activeRegion && (
        <div
          className={[
            'world-map__label',
            activeRegion.type === 'central' ? 'world-map__label--central' : '',
            activeRegion.disabled ? 'world-map__label--disabled' : '',
            lockedId === activeRegion.id ? 'world-map__label--locked' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          style={labelStyle}
        >
          <span className="world-map__label-name">{activeRegion.name}</span>
          <span className="world-map__label-cta">
            {activeRegion.disabled ? 'Coming Soon' : (activeRegion.tagline ?? 'Enter World')}
            {!activeRegion.disabled && <span aria-hidden="true"> &rarr;</span>}
          </span>
        </div>
      )}

      {showDebug && (
        <div className="world-map__debug-badge">DEBUG_HOTSPOTS ON &mdash; {regions.length} regions</div>
      )}
    </div>
  );
};

export default WorldMap;
