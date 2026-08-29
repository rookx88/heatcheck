// TANKDAQ (/tankdaq/) - the exchange floor, reached from the grey columned
// building on Tank Land. Pure scene for now: the hanging INDEX PRICES sign and
// Beaks the Broker are hover-only previews (glow + label, no navigation) until
// their pages ship in a later phase - then swap each to an href hotspot and
// mirror it in the page's fallback nav.

import React from 'react';
import { createRoot } from 'react-dom/client';
import { LandScreen } from './components/LandScreen';
import tankdaqSrc from './assets/images/tankdaq-bg.webp';

// Hand-traced over the embedded 1008x1792 artwork (px * 0.803571 = viewBox units).
// The circular INDEX PRICES sign band plus its light ring and chandelier.
const INDEX_PRICES_PATH = 'M212,131 L262,96 L410,80 L560,96 L611,131 L611,290 L575,330 L480,342 L455,390 L412,402 L370,390 L345,342 L248,330 L212,290 Z';
// Beaks the Broker - the suited seahorse: snout left, coiled tail right.
const BEAKS_PATH = 'M455,575 L470,560 L515,558 L540,580 L545,640 L540,680 L545,770 L588,790 L592,900 L580,935 L620,990 L648,1060 L640,1130 L600,1170 L560,1165 L575,1230 L585,1255 L515,1260 L510,1235 L500,1258 L445,1255 L455,1160 L450,1000 L465,985 L438,978 L430,920 L433,845 L445,782 L498,748 L403,726 L400,706 L450,668 L430,645 L438,600 Z';

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
