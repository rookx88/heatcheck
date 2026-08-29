// TANKDAQ (/tankdaq/) - the exchange floor, reached from the grey columned
// building on Tank Land. Pure scene for now: the hanging INDEX PRICES sign and
// Beaks the Broker are hover-only previews (glow + label, no navigation) until
// their pages ship in a later phase - then swap each to an href hotspot and
// mirror it in the page's fallback nav.

import React from 'react';
import { createRoot } from 'react-dom/client';
import { LandScreen } from './components/LandScreen';
import tankdaqSrc from './assets/images/tankdaq-bg.webp';

// Simple rectangles over the 1008x1792 artwork (px * 0.803571 = viewBox units) -
// traced silhouettes read as tacky here, so the hover areas are boxed out instead.
// The hanging INDEX PRICES sign, light ring, and chandelier.
const INDEX_PRICES_PATH = 'M212,80 L611,80 L611,400 L212,400 Z';
// Beaks the Broker - the suited seahorse, snout to shoes, tail included.
const BEAKS_PATH = 'M400,558 L648,558 L648,1260 L400,1260 Z';

const Tankdaq: React.FC = () => (
    <LandScreen
        backgroundSrc={tankdaqSrc}
        pageAriaLabel="TANKDAQ - the exchange floor"
        hotspots={[
            {
                id: 'index-prices',
                path: INDEX_PRICES_PATH,
                ariaLabel: 'Index Prices - coming soon',
                label: { text: 'Index Prices', x: 412, y: 440 },
            },
            {
                id: 'beaks-the-broker',
                path: BEAKS_PATH,
                ariaLabel: 'Beaks the Broker - coming soon',
                label: { text: 'Beaks the Broker', x: 512, y: 1310 },
            },
        ]}
    />
);

function mount() {
    const root = document.getElementById('tankdaq-root');
    if (!root) return;
    createRoot(root).render(<Tankdaq />);
}

mount();
