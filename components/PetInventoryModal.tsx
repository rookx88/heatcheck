// The pet widget's Inventory: everything the account owns, read-only at a glance,
// in three tabs - Eggs, Food, Collectibles. Actions live where they belong (hatch at
// the Hatchery's incubator, feed from the widget's Feed modal); this is the ledger
// of stuff. Collectibles are serialized cards found by the pet (discovery drops);
// clicking one opens the full-screen CollectibleCard viewer overlay ABOVE this panel
// - one Escape closes the viewer, the next closes the inventory.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { colorwayFromCatalog } from './Egg3D';
import CollectibleCard from './CollectibleCard';
import {
    getOwnedCollectibles,
    getOwnedEggs,
    getOwnedFood,
    type OwnedCollectible,
    type OwnedEgg,
    type OwnedFood,
} from '../egg-shop-client';
import './HatcheryModal.css';
import './FoodShopModal.css';
import './PetInventoryModal.css';

type InvTab = 'eggs' | 'food' | 'collectibles';

function formatAcquired(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
        ? ''
        : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

interface PetInventoryModalProps {
    onClose: () => void;
}

export const PetInventoryModal: React.FC<PetInventoryModalProps> = ({ onClose }) => {
    const [tab, setTab] = useState<InvTab>('eggs');
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [eggs, setEggs] = useState<OwnedEgg[]>([]);
    const [food, setFood] = useState<OwnedFood[]>([]);
    const [collectibles, setCollectibles] = useState<OwnedCollectible[]>([]);
    const [viewedCard, setViewedCard] = useState<OwnedCollectible | null>(null);

    const closeButtonRef = useRef<HTMLButtonElement>(null);
    // The document-level Escape handler must see the CURRENT viewer state without
    // re-binding on every open/close - hence the ref mirror.
    const viewedCardRef = useRef<OwnedCollectible | null>(null);
    viewedCardRef.current = viewedCard;

    const hydrate = useCallback(async () => {
        setLoadError(null);
        try {
            const [e, f, c] = await Promise.all([getOwnedEggs(), getOwnedFood(), getOwnedCollectibles()]);
            setEggs(e ?? []);
            setFood(f ?? []);
            setCollectibles(c ?? []);
            setLoading(false);
        } catch (err: any) {
            setLoadError(err?.message || 'Something went wrong.');
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        hydrate();
    }, [hydrate]);

    useEffect(() => {
        document.body.style.overflow = 'hidden';
        closeButtonRef.current?.focus();
        // Escape peels one layer: the card viewer first if it's open, else the modal.
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            if (viewedCardRef.current) setViewedCard(null);
            else onClose();
        };
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.body.style.overflow = '';
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [onClose]);

    const renderEggs = () =>
        eggs.length === 0 ? (
            <div className="tank-modal-empty">
                <p>No eggs.</p>
                <p>The Hatchery sells them.</p>
            </div>
        ) : (
            <ul className="pet-inv-list">
                {eggs.map((egg) => (
                    <li key={egg.id} className="pet-inv-item">
                        <span
                            className="pet-inv-egg-dot"
                            style={{ backgroundColor: colorwayFromCatalog(egg).hex }}
                            aria-hidden="true"
                        />
                        <span className="pet-inv-name">{egg.name}</span>
                        <span className="pet-inv-meta">Acquired {formatAcquired(egg.acquiredAt)}</span>
                    </li>
                ))}
            </ul>
        );

    const renderFood = () =>
        food.length === 0 ? (
            <div className="tank-modal-empty">
                <p>The pantry is empty.</p>
                <p>Visit the Tank Land food shops.</p>
            </div>
        ) : (
            <ul className="pet-inv-list">
                {food.map((item) => (
                    <li key={item.catalogKey} className="pet-inv-item">
                        <img
                            className="pet-inv-thumb"
                            src={`/assets/images/food/${item.catalogKey}.png`}
                            alt=""
                            width={48}
                            height={48}
                            loading="lazy"
                            onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }}
                        />
                        <span className="pet-inv-name">{item.name}</span>
                        <span className="pet-inv-meta">×{item.quantity}</span>
                    </li>
                ))}
            </ul>
        );

    const renderCollectibles = () =>
        collectibles.length === 0 ? (
            <div className="tank-modal-empty">
                <p>No collectibles yet.</p>
                <p>Rare finds your pet digs up land here.</p>
            </div>
        ) : (
            <ul className="pet-inv-list">
                {collectibles.map((card) => (
                    <li key={card.id} className="pet-inv-item pet-inv-item--card">
                        <button
                            type="button"
                            className="pet-inv-card-button"
                            onClick={() => setViewedCard(card)}
                            aria-label={`View ${card.name}, number ${card.serial} of ${card.mintSize ?? '?'}`}
                        >
                            {card.coverImage && (
                                <img
                                    className="pet-inv-card-thumb"
                                    src={`/assets/images/${card.coverImage}`}
                                    alt=""
                                    width={38}
                                    height={54}
                                    loading="lazy"
                                    onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }}
                                />
                            )}
                            <span className="pet-inv-name">{card.name}</span>
                            <span className="pet-inv-meta">
                                #{card.serial}{card.mintSize ? ` / ${card.mintSize}` : ''} &middot; {formatAcquired(card.acquiredAt)}
                            </span>
                        </button>
                    </li>
                ))}
            </ul>
        );

    // Full-viewport viewer above the inventory panel. Same non-dismissing overlay
    // contract as the tank modals (the card is a mousemove-driven 3D object - stray
    // clicks and drag-ends must not close it); only the X and Escape do.
    const renderCardViewer = (card: OwnedCollectible) => (
        <div className="pet-inv-viewer" role="dialog" aria-modal="true" aria-label={card.name}>
            <button
                className="tank-modal-close pet-inv-viewer-close"
                onClick={() => setViewedCard(null)}
                aria-label="Close card viewer"
            >
                &times;
            </button>
            <CollectibleCard
                edition={card.edition === 'gold' ? 'gold' : 'neon'}
                coverSrc={`/assets/images/${card.coverImage ?? ''}`}
                coverAlt={card.name}
                videoSrc="/assets/videos/soccerbackdrop.mp4"
                serial={card.serial}
                mintSize={card.mintSize ?? 0}
                matchTitle={card.matchTitle ?? ''}
                matchCaption={card.matchCaption ?? ''}
            />
        </div>
    );

    const renderBody = () => {
        if (loading) return <div className="tank-modal-empty"><p>Opening the vault…</p></div>;
        if (loadError) {
            return (
                <div className="tank-modal-empty">
                    <p>{loadError}</p>
                    <button className="hatchery-buy" onClick={() => { setLoading(true); hydrate(); }}>Retry</button>
                </div>
            );
        }
        return (
            <>
                <div className="tank-modal-filters" aria-label="Inventory sections">
                    {([
                        ['eggs', `Eggs${eggs.length ? ` (${eggs.length})` : ''}`],
                        ['food', `Food${food.length ? ` (${food.reduce((n, f) => n + f.quantity, 0)})` : ''}`],
                        ['collectibles', `Collectibles${collectibles.length ? ` (${collectibles.length})` : ''}`],
                    ] as [InvTab, string][]).map(([t, label]) => (
                        <button
                            key={t}
                            className={`tank-modal-filter${tab === t ? ' is-active' : ''}`}
                            onClick={() => setTab(t)}
                            aria-pressed={tab === t}
                        >
                            {label}
                        </button>
                    ))}
                </div>
                {tab === 'eggs' && renderEggs()}
                {tab === 'food' && renderFood()}
                {tab === 'collectibles' && renderCollectibles()}
                <div className="hatchery-caption">Hatch at the Hatchery &middot; Feed from your pet widget</div>
            </>
        );
    };

    return (
        // Same non-dismissing overlay contract as the other tank modals.
        <div className="tank-modal-overlay">
            <div
                className="tank-modal-panel"
                role="dialog"
                aria-modal="true"
                aria-label="Inventory"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="tank-modal-header">
                    <span>Inventory</span>
                    <button ref={closeButtonRef} className="tank-modal-close" onClick={onClose} aria-label="Close">
                        &times;
                    </button>
                </div>
                <div className="tank-modal-body">{renderBody()}</div>
            </div>
            {viewedCard && renderCardViewer(viewedCard)}
        </div>
    );
};

export default PetInventoryModal;
