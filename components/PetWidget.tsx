// The captain widget: the user's pet, docked bottom-right of whatever screen hosts
// it (the map pages mount it inside their fixed frame; the homepage mounts it inside
// the showcase section). Renders NOTHING until a session with a pet exists - the
// widget is the pet's presence, not a promo for one.
//
// Interaction: click the pet -> [Feed] [Inventory] buttons slide in to its LEFT on
// one line; click again (or Escape) collapses. Feed and Inventory open their modals.

import React, { useCallback, useEffect, useState } from 'react';
import { PET_IMAGE_SRC, petImageFilter, petDisplayName } from './petRender';
import { FeedModal } from './FeedModal';
import { PetInventoryModal } from './PetInventoryModal';
import { getPet, type PetInfo } from '../egg-shop-client';
// The Feed/Inventory modals render the shared .tank-modal-* chrome. Imported HERE,
// not left to the host bundle, so every page that mounts the widget (including the
// homepage, which never renders TankScreen) gets the modal styling.
import './TankScreen.css';
import './PetWidget.css';

type OpenModal = null | 'feed' | 'inventory';

interface PetWidgetProps {
    // 'card': docked to the bottom-right corner of the aspect-fit map card (the
    //         LandScreen/TankScreen frame math), slightly overlapping it.
    // 'fixed': viewport-fixed bottom-right - for scrolling pages (homepage), so the
    //          captain rides along and stays in view.
    variant?: 'card' | 'fixed';
}

export const PetWidget: React.FC<PetWidgetProps> = ({ variant = 'card' }) => {
    const [pet, setPet] = useState<PetInfo | null>(null);
    const [expanded, setExpanded] = useState(false);
    const [openModal, setOpenModal] = useState<OpenModal>(null);

    const hydrate = useCallback(async () => {
        try {
            setPet(await getPet());
        } catch {
            // Widget is decorative chrome - never surface load errors.
        }
    }, []);

    useEffect(() => {
        hydrate();
    }, [hydrate]);

    // bfcache: Back restores the page without remounting React.
    useEffect(() => {
        const onPageShow = (e: PageTransitionEvent) => {
            if (e.persisted) hydrate();
        };
        window.addEventListener('pageshow', onPageShow);
        return () => window.removeEventListener('pageshow', onPageShow);
    }, [hydrate]);

    useEffect(() => {
        if (!expanded) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !openModal) setExpanded(false);
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [expanded, openModal]);

    if (!pet) return null;

    const name = petDisplayName(pet.name, pet.color);
    const filter = petImageFilter(pet.render_mode, pet.render_config);

    return (
        <div className={`pet-widget pet-widget--${variant}${expanded ? ' is-expanded' : ''}`}>
            <div className="pet-widget__row">
                {expanded && (
                    <div className="pet-widget__actions">
                        <button className="pet-widget__action" onClick={() => setOpenModal('feed')}>
                            Feed
                        </button>
                        <button className="pet-widget__action" onClick={() => setOpenModal('inventory')}>
                            Inventory
                        </button>
                    </div>
                )}
                <button
                    className="pet-widget__pet"
                    onClick={() => setExpanded((e) => !e)}
                    aria-expanded={expanded}
                    aria-label={`${name} - pet actions`}
                >
                    <img src={PET_IMAGE_SRC} style={{ filter }} alt="" width={110} height={110} />
                </button>
            </div>
            <div className="pet-widget__name">{name}</div>

            {openModal === 'feed' && (
                <FeedModal
                    onClose={() => setOpenModal(null)}
                    onPetChange={(p) => setPet(p)}
                />
            )}
            {openModal === 'inventory' && <PetInventoryModal onClose={() => setOpenModal(null)} />}
        </div>
    );
};

export default PetWidget;
