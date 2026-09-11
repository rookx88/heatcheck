// Tank Land - the hub page at /the-tank/. The world map's tank region lands here;
// from here the structures lead onward: the Tank HQ (story browser), The Hatchery
// (eggs + incubator), the two food shops and TANKDAQ. The Hall of Fame rotunda is the
// one structure that opens in place (a modal leaderboard) rather than navigating; the
// rest is pure navigation - the artwork is the content. Structure names appear on
// hover (LandScreen labels).

import React, { useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LandScreen } from './components/LandScreen';
import { HallOfFameModal } from './components/HallOfFameModal';
import tankLandSrc from './assets/images/tank-land-bg.webp';
// The modal rides the shared .tank-modal-* chrome from TankScreen.css.
import './components/TankScreen.css';

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
// The grey columned building with the dome and flags, top right - TANKDAQ.
const TANKDAQ_PATH = 'M545,430 L575,345 L640,300 L662,250 L700,240 L724,250 L744,296 L792,330 L792,468 L724,500 L600,500 L545,470 Z';
// The golden "HALL OF FAME" rotunda with the statue and its round plaza, top left:
// spire, dome, the sign band, the plaza's rim, down to the foot of the stairs.
const HALL_OF_FAME_PATH = 'M241,186 L293,211 L317,265 L329,321 L358,378 L362,450 L346,490 L309,526 L269,563 L213,563 L173,526 L137,490 L125,450 L129,378 L157,321 L173,265 L193,211 Z';

const TankLand: React.FC = () => {
    const [hallOpen, setHallOpen] = useState(false);
    const openHall = useCallback(() => setHallOpen(true), []);
    const closeHall = useCallback(() => setHallOpen(false), []);
    return (
        <LandScreen
            backgroundSrc={tankLandSrc}
            pageAriaLabel="Tank Land - the HeatChecks island"
            hotspots={[
                {
                    id: 'hall-of-fame',
                    path: HALL_OF_FAME_PATH,
                    ariaLabel: 'Hall of Fame - top Ember earners',
                    onActivate: openHall,
                    // Above the spire (top edge y=186), centered on the rotunda.
                    label: { text: 'Hall of Fame', x: 245, y: 168 },
                },
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
                    // Anchored ABOVE the lodge polygon (top edge y=1065): below it the
                    // text sat in the bottom-right corner under the PetWidget. x stays
                    // left of the polygon's center so the long label fits the viewBox.
                    label: { text: 'Champion’s Lakeside Terrace', x: 540, y: 1040 },
                },
                {
                    id: 'tankdaq',
                    path: TANKDAQ_PATH,
                    ariaLabel: 'TANKDAQ - the exchange floor',
                    href: '/tankdaq/',
                    // Anchored above the building; x pulled left of the polygon's
                    // center so the label clears the right viewBox edge.
                    label: { text: 'TANKDAQ', x: 640, y: 215 },
                },
            ]}
        >
            {hallOpen && <HallOfFameModal onClose={closeHall} />}
        </LandScreen>
    );
};

function mount() {
    const root = document.getElementById('tank-land-root');
    if (!root) return;
    createRoot(root).render(<TankLand />);
}

mount();
