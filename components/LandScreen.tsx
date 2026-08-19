// Shared full-screen "location" page: a portrait background artwork with glowing
// interactive hotspots traced over it - the pattern TankScreen established, factored
// out so Tank Land and The Hatchery don't each re-implement the frame, the hotspot
// layer stack, or the back button. A hotspot either navigates (href) or triggers an
// action like opening a modal (onActivate); modals render via children.
//
// All hotspot paths/label positions are in the artwork SVG's viewBox space
// (810 x 1439.999935 for the current backgrounds). The embedded artwork is a raster,
// so paths are hand-traced: artwork pixel x 0.803571 = viewBox unit (the new
// backgrounds' embedding transform is a pure uniform scale with no offset).

import React from 'react';
import { PetWidget } from './PetWidget';
import './LandScreen.css';

export const LAND_VIEWBOX = { width: 810, height: 1439.999935 };

export interface LandHotspot {
    id: string;
    path: string;       // viewBox-space outline of the structure
    ariaLabel: string;
    href?: string;      // navigation hotspot...
    onActivate?: () => void; // ...or action hotspot (modal open). Exactly one should be set.
    // Hover/focus-revealed name (worldmap-style) - hidden at rest, see LandScreen.css.
    label?: { text: string; x: number; y: number };
}

interface LandScreenProps {
    backgroundSrc: string;
    pageAriaLabel: string;
    backHref: string;
    hotspots: LandHotspot[];
    children?: React.ReactNode; // modals and other overlays
}

const HotspotLayers: React.FC<{ hotspot: LandHotspot }> = ({ hotspot }) => (
    <>
        <path className="land-screen__glow" d={hotspot.path} />
        <path className="land-screen__outline" d={hotspot.path} />
        <path className="land-screen__brighten" d={hotspot.path} />
        {hotspot.label && (
            <text className="land-screen__label" x={hotspot.label.x} y={hotspot.label.y} textAnchor="middle">
                {hotspot.label.text}
            </text>
        )}
        <path className="land-screen__hit" d={hotspot.path} />
    </>
);

export const LandScreen: React.FC<LandScreenProps> = ({ backgroundSrc, pageAriaLabel, backHref, hotspots, children }) => (
    <div className="land-screen">
        <div className="land-screen__frame">
            <svg
                className="land-screen__svg"
                viewBox={`0 0 ${LAND_VIEWBOX.width} ${LAND_VIEWBOX.height}`}
                preserveAspectRatio="xMidYMid slice"
                role="img"
                aria-label={pageAriaLabel}
            >
                <image
                    href={backgroundSrc}
                    x={0}
                    y={0}
                    width={LAND_VIEWBOX.width}
                    height={LAND_VIEWBOX.height}
                    className="land-screen__background"
                />
                {hotspots.map((h) =>
                    h.href ? (
                        // SVG <a>: real link semantics (middle-click, crawlable when the
                        // page's fallback nav mirrors it) with the glow treatment on hover.
                        <a key={h.id} href={h.href} className="land-screen__hotspot" aria-label={h.ariaLabel}>
                            <HotspotLayers hotspot={h} />
                        </a>
                    ) : (
                        <g
                            key={h.id}
                            className="land-screen__hotspot"
                            role="button"
                            tabIndex={0}
                            aria-label={h.ariaLabel}
                            onClick={h.onActivate}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                                    e.preventDefault();
                                    h.onActivate?.();
                                }
                            }}
                        >
                            <HotspotLayers hotspot={h} />
                        </g>
                    )
                )}
            </svg>

            <a className="land-screen__back" href={backHref} aria-label="Back">
                <span className="land-screen__back-box">
                    <img src="/assets/images/checknav.webp" alt="" width={34} height={34} />
                </span>
            </a>
        </div>
        {/* Captain widget, bottom-right of the screen. Mounted OUTSIDE the frame:
            the frame's translateX transform would trap the widget's position:fixed
            modal overlays (transformed ancestors become their containing block). */}
        <PetWidget />
        {children}
    </div>
);

export default LandScreen;
