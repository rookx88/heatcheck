// Champion's Lakeside Terrace (/champions-terrace/) - the hearty-plates food shop
// reached from the lakeside lodge on Tank Land. The Champion's menu book on the
// counter opens the shop modal.

import React, { useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LandScreen } from './components/LandScreen';
import { FoodShopModal } from './components/FoodShopModal';
import championsShopSrc from './assets/new-website/Champions_food_shop.svg';
// The modals ride the shared .tank-modal-* chrome from TankScreen.css.
import './components/TankScreen.css';

// Hand-traced over the embedded 1008x1792 artwork (px * 0.803571 = viewBox units):
// the green "Champion's" menu book on the counter, foreground left.
const MENU_PATH = 'M121,1137 L454,1101 L490,1306 L189,1362 Z';

const ChampionsTerrace: React.FC = () => {
    const [open, setOpen] = useState(false);
    const openShop = useCallback(() => setOpen(true), []);
    return (
        <LandScreen
            backgroundSrc={championsShopSrc}
            pageAriaLabel="Champion's Lakeside Terrace - the lakeside kitchen"
            hotspots={[
                {
                    id: 'menu',
                    path: MENU_PATH,
                    ariaLabel: 'Open the Champion’s menu',
                    onActivate: openShop,
                    label: { text: 'Menu', x: 305, y: 1080 },
                },
            ]}
        >
            {open && (
                <FoodShopModal
                    title="Champion's Lakeside Terrace"
                    vendor="champions"
                    onClose={() => setOpen(false)}
                />
            )}
        </LandScreen>
    );
};

function mount() {
    const root = document.getElementById('champions-terrace-root');
    if (!root) return;
    createRoot(root).render(<ChampionsTerrace />);
}

mount();
