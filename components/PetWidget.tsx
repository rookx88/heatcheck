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
import { PetNameForm, PET_UPDATED_EVENT } from './PetNameForm';
import { getPet, type PetInfo } from '../egg-shop-client';
import {
    getNotifications,
    markNotificationRead,
    dispatchNotificationsUpdated,
    NOTIFICATIONS_UPDATED_EVENT,
    type NotificationItem,
} from '../notifications-client';
// The Feed/Inventory modals render the shared .tank-modal-* chrome. Imported HERE,
// not left to the host bundle, so every page that mounts the widget (including the
// homepage, which never renders TankScreen) gets the modal styling.
import './TankScreen.css';
import './PetWidget.css';

type OpenModal = null | 'feed' | 'inventory' | 'name';

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
    const [notifications, setNotifications] = useState<NotificationItem[]>([]);
    // The notification currently being "spoken" in the pet's bubble.
    const [bubble, setBubble] = useState<NotificationItem | null>(null);

    const hydrate = useCallback(async () => {
        try {
            setPet(await getPet());
        } catch {
            // Widget is decorative chrome - never surface load errors.
        }
    }, []);

    const hydrateNotifications = useCallback(async () => {
        try {
            setNotifications((await getNotifications()) ?? []);
        } catch {
            // Same rule as the pet fetch: chrome fails quiet.
        }
    }, []);

    useEffect(() => {
        hydrate();
        hydrateNotifications();
    }, [hydrate, hydrateNotifications]);

    // bfcache: Back restores the page without remounting React.
    useEffect(() => {
        const onPageShow = (e: PageTransitionEvent) => {
            if (e.persisted) {
                hydrate();
                hydrateNotifications();
            }
        };
        window.addEventListener('pageshow', onPageShow);
        return () => window.removeEventListener('pageshow', onPageShow);
    }, [hydrate, hydrateNotifications]);

    // Same-page pet changes (a hatch in the incubator modal, a naming) announce
    // themselves - re-hydrate so the widget appears/renames without a reload.
    useEffect(() => {
        const onPetUpdated = () => hydrate();
        window.addEventListener(PET_UPDATED_EVENT, onPetUpdated);
        return () => window.removeEventListener(PET_UPDATED_EVENT, onPetUpdated);
    }, [hydrate]);

    // Read-state changes elsewhere (the inbox modal) drop the badge count live.
    useEffect(() => {
        const onUpdated = () => hydrateNotifications();
        window.addEventListener(NOTIFICATIONS_UPDATED_EVENT, onUpdated);
        return () => window.removeEventListener(NOTIFICATIONS_UPDATED_EVENT, onUpdated);
    }, [hydrateNotifications]);

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || openModal) return;
            // Escape peels back one layer at a time: bubble first, then the row.
            if (bubble) setBubble(null);
            else if (expanded) setExpanded(false);
        };
        if (!expanded && !bubble) return;
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [expanded, openModal, bubble]);

    // Feed is newest-first, so the oldest unread is the LAST unread element.
    const unread = notifications.filter((n) => n.readAt === null);

    const speakOldestUnread = () => {
        const oldest = unread[unread.length - 1];
        if (!oldest) return;
        setBubble(oldest);
        // Mark read the moment it's shown (user decision). Optimistic; the write is
        // idempotent and chrome-quiet on failure.
        setNotifications((prev) =>
            prev.map((n) => (n.id === oldest.id ? { ...n, readAt: new Date().toISOString() } : n)),
        );
        markNotificationRead(oldest.id)
            .catch(() => { /* next fetch reconciles */ })
            .finally(() => dispatchNotificationsUpdated());
    };

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
                {unread.length > 0 && !bubble && (
                    // The alert sits over the pet but is its own button (sibling, not
                    // child, of .pet-widget__pet - nested buttons are invalid HTML and
                    // the click must not toggle the action row).
                    <button
                        type="button"
                        className="pet-widget__alert"
                        onClick={(e) => {
                            e.stopPropagation();
                            speakOldestUnread();
                        }}
                        aria-label={`${unread.length} unread notification${unread.length === 1 ? '' : 's'} - hear the oldest`}
                    >
                        !
                    </button>
                )}
                {bubble && (
                    <div className="pet-widget__bubble" role="status">
                        <span className="pet-widget__bubble-text">{bubble.message}</span>
                        <button
                            type="button"
                            className="pet-widget__bubble-close"
                            onClick={() => setBubble(null)}
                            aria-label="Dismiss"
                        >
                            &times;
                        </button>
                    </div>
                )}
            </div>
            {pet.name ? (
                <div className="pet-widget__name">{name}</div>
            ) : (
                // Unnamed (the hatch reveal was dismissed early): the label doubles as
                // the way back into naming.
                <button
                    type="button"
                    className="pet-widget__name pet-widget__name--prompt"
                    onClick={() => setOpenModal('name')}
                >
                    Name your pet ✏️
                </button>
            )}

            {openModal === 'feed' && (
                <FeedModal
                    onClose={() => setOpenModal(null)}
                    onPetChange={(p) => setPet(p)}
                />
            )}
            {openModal === 'inventory' && <PetInventoryModal onClose={() => setOpenModal(null)} />}
            {openModal === 'name' && (
                <div className="tank-modal-overlay">
                    <div
                        className="tank-modal-panel"
                        role="dialog"
                        aria-modal="true"
                        aria-label="Name your pet"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="tank-modal-header">
                            <span>Name Your Pet</span>
                            <button className="tank-modal-close" onClick={() => setOpenModal(null)} aria-label="Close">
                                &times;
                            </button>
                        </div>
                        <div className="tank-modal-body">
                            <img
                                src={PET_IMAGE_SRC}
                                style={{ filter, width: 120, height: 120, objectFit: 'contain' }}
                                alt=""
                            />
                            <PetNameForm
                                onNamed={(p) => { setPet(p); setOpenModal(null); }}
                            />
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default PetWidget;
