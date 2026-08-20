// Quickboost Delicacies (/quickboost-delicacies/) - the light-bites-and-shakes food
// shop reached from the hut beside the Tank HQ on Tank Land. The hanging ORDER HERE
// sign opens the shop modal.

import React, { useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LandScreen } from './components/LandScreen';
import { FoodShopModal } from './components/FoodShopModal';
import quickboostShopSrc from './assets/new-website/Quickboost_food_shop.svg';
// The modals ride the shared .tank-modal-* chrome from TankScreen.css.
import './components/TankScreen.css';

// Hand-traced over the embedded 1008x1792 artwork (px * 0.803571 = viewBox units):
// the hanging "Order Here" sign at the top of the window.
const ORDER_SIGN_PATH = 'M193,96 L715,24 L723,205 L199,256 Z';

const QuickboostDelicacies: React.FC = () => {
    const [open, setOpen] = useState(false);
    const openShop = useCallback(() => setOpen(true), []);
    return (
        <LandScreen
            backgroundSrc={quickboostShopSrc}
            pageAriaLabel="Quickboost Delicacies - the smoothie counter"
            hotspots={[
                {
                    id: 'order-here',
                    path: ORDER_SIGN_PATH,
                    ariaLabel: 'Order Here - open the Quickboost menu',
                    onActivate: openShop,
                    label: { text: 'Order', x: 458, y: 300 },
                },
            ]}
        >
            {open && (
                <FoodShopModal
                    title="Quickboost Delicacies"
                    vendor="quickboost"
                    onClose={() => setOpen(false)}
                />
            )}
        </LandScreen>
    );
};

function mount() {
    const root = document.getElementById('quickboost-root');
    if (!root) return;
    createRoot(root).render(<QuickboostDelicacies />);
}

mount();
