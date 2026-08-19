// Tank Land - the hub page at /the-tank/. The world map's tank region lands here;
// from here the structures lead onward: the Tank HQ (story browser), The Hatchery
// (eggs + incubator), and the two food shops. Pure navigation - no data, no session;
// the artwork is the content. Structure names appear on hover (LandScreen labels).

import React from 'react';
import { createRoot } from 'react-dom/client';
import { LandScreen } from './components/LandScreen';
import tankLandSrc from './assets/new-website/Tank-land.svg';

// All paths hand-traced over the embedded 1008x1792 artwork (px * 0.803571 =
// viewBox units).
// The glass-domed "THE TANK HQ" building, center of the scene.
const TANK_HQ_PATH = 'M269,763 L289,643 L354,599 L514,599 L579,643 L603,763 L603,956 L546,1009 L338,1009 L269,956 Z';
// The steampunk egg-nest machine, lower left.
const HATCHERY_PATH = 'M16,924 L48,828 L88,804 L225,804 L265,852 L265,1004 L241,1085 L185,1157 L48,1157 L16,1069 Z';
// The hut between the Tank HQ and the big building top-right - Quickboost Delicacies.
const QUICKBOOST_PATH = 'M607,571 L623,542 L671,540 L682,571 L679,596 L611,599 Z';
// The two-story lodge by the lake, bottom right - Champion's Lakeside Terrace.
const CHAMPIONS_PATH = 'M659,1109 L679,1069 L727,1065 L755,1101 L751,1157 L667,1165 Z';

function mount() {
    const root = document.getElementById('tank-land-root');
    if (!root) return;
    createRoot(root).render(
        <LandScreen
            backgroundSrc={tankLandSrc}
            pageAriaLabel="Tank Land - the HeatChecks island"
            backHref="/"
            hotspots={[
                {
                    id: 'tank-hq',
                    path: TANK_HQ_PATH,
                    ariaLabel: 'The Tank HQ - browse today’s tanks',
                    href: '/the-tank-hq/',
                    label: { text: 'The Tank HQ', x: 436, y: 570 },
                },
                {
                    id: 'hatchery',
                    path: HATCHERY_PATH,
                    ariaLabel: 'The Hatchery - eggs and incubator',
                    href: '/the-hatchery/',
                    label: { text: 'The Hatchery', x: 150, y: 1210 },
                },
                {
                    id: 'quickboost',
                    path: QUICKBOOST_PATH,
                    ariaLabel: 'Quickboost Delicacies - light bites and shakes',
                    href: '/quickboost-delicacies/',
                    label: { text: 'Quickboost Delicacies', x: 580, y: 520 },
                },
                {
                    id: 'champions-terrace',
                    path: CHAMPIONS_PATH,
                    ariaLabel: 'Champion’s Lakeside Terrace - hearty plates',
                    href: '/champions-terrace/',
                    label: { text: 'Champion’s Lakeside Terrace', x: 540, y: 1210 },
                },
            ]}
        />
    );
}

mount();
