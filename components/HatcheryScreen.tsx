// The Hatchery page (/the-hatchery/): the egg-shop interior artwork with two
// hotspots - the "Eggs for Sale" sign opens the shop modal (buy + owned eggs), the
// incubator machine opens the hatch modal. Back goes to Tank Land.

import React, { useCallback, useState } from 'react';
import { LandScreen } from './LandScreen';
import { EggShopModal } from './EggShopModal';
import { IncubatorModal } from './IncubatorModal';
import { trackEvent } from '../tank-analytics-client';
import eggShopSrc from '../assets/new-website/egg-shop.svg';

// Hand-traced over the embedded 1008x1792 artwork (px * 0.803571 = viewBox units).
// The domed "Incubator" display case, left side of the room (sign baked into the art).
const INCUBATOR_PATH = 'M60,723 L113,522 L257,434 L402,522 L454,723 L454,1004 L386,1125 L129,1125 L60,1004 Z';
// The wooden "Eggs for Sale" sign board, right side.
const EGGS_SIGN_PATH = 'M510,743 L783,743 L783,968 L510,968 Z';

type OpenModal = null | 'shop' | 'incubator';

export const HatcheryScreen: React.FC = () => {
    const [openModal, setOpenModal] = useState<OpenModal>(null);

    const openShop = useCallback(() => {
        setOpenModal('shop');
        trackEvent('hatchery_opened', { metadata: { section: 'shop' } });
    }, []);

    const openIncubator = useCallback(() => {
        setOpenModal('incubator');
        trackEvent('hatchery_opened', { metadata: { section: 'incubator' } });
    }, []);

    const close = useCallback(() => setOpenModal(null), []);

    return (
        <LandScreen
            backgroundSrc={eggShopSrc}
            pageAriaLabel="The Hatchery - egg shop and incubator"
            hotspots={[
                {
                    id: 'eggs-for-sale',
                    path: EGGS_SIGN_PATH,
                    ariaLabel: 'Eggs for Sale - open the egg shop',
                    onActivate: openShop,
                },
                {
                    id: 'incubator',
                    path: INCUBATOR_PATH,
                    ariaLabel: 'Incubator - hatch your eggs',
                    onActivate: openIncubator,
                },
            ]}
        >
            {openModal === 'shop' && <EggShopModal onClose={close} />}
            {openModal === 'incubator' && <IncubatorModal onClose={close} />}
        </LandScreen>
    );
};

export default HatcheryScreen;
