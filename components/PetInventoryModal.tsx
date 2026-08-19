// The pet widget's Inventory: everything the account owns, read-only at a glance,
// in three tabs - Eggs, Food, Collectibles. Actions live where they belong (hatch at
// the Hatchery's incubator, feed from the widget's Feed modal); this is the ledger
// of stuff. Collectibles are a declared-but-unshipped item_type: the tab renders its
// empty state until collectible SKUs exist.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { colorwayFromCatalog } from './Egg3D';
import {
    getOwnedEggs,
    getOwnedFood,
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

    const closeButtonRef = useRef<HTMLButtonElement>(null);

    const hydrate = useCallback(async () => {
        setLoadError(null);
        try {
            const [e, f] = await Promise.all([getOwnedEggs(), getOwnedFood()]);
            setEggs(e ?? []);
            setFood(f ?? []);
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
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
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

    const renderCollectibles = () => (
        <div className="tank-modal-empty">
            <p>Collectibles are coming soon.</p>
            <p>Keep an eye on Tank Land.</p>
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
                        ['collectibles', 'Collectibles'],
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
        </div>
    );
};

export default PetInventoryModal;
