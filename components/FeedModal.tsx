// Feed the captain: pick an owned food, feed, see the pet's state. Satisfaction is
// deliberately a two-state label (Hungry/Satisfied) - the numeric value never leaves
// the server. Feeding is idempotent per feedToken; a full pet rejects the feed with
// a friendly 409 BEFORE consuming anything.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PET_IMAGE_SRC, petImageFilter, petDisplayName } from './petRender';
import {
    getPet,
    getOwnedFood,
    getShopFood,
    feedPet,
    PetFullError,
    type PetInfo,
    type OwnedFood,
} from '../egg-shop-client';
import './HatcheryModal.css';
import './FoodShopModal.css';
import './FeedModal.css';

interface FeedModalProps {
    onClose: () => void;
    // Keeps the widget's copy of the pet in sync after a successful feed.
    onPetChange?: (pet: PetInfo) => void;
}

export const FeedModal: React.FC<FeedModalProps> = ({ onClose, onPetChange }) => {
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [pet, setPet] = useState<PetInfo | null>(null);
    const [food, setFood] = useState<OwnedFood[]>([]);
    const [pointsByKey, setPointsByKey] = useState<Record<string, number>>({});
    const [feeding, setFeeding] = useState<string | null>(null); // catalogKey in flight
    const [notice, setNotice] = useState<string | null>(null);
    const [feedError, setFeedError] = useState<string | null>(null);

    const closeButtonRef = useRef<HTMLButtonElement>(null);

    const hydrate = useCallback(async () => {
        setLoadError(null);
        try {
            const [p, owned, quickboost, champions] = await Promise.all([
                getPet(),
                getOwnedFood(),
                getShopFood('quickboost'),
                getShopFood('champions'),
            ]);
            setPet(p);
            setFood(owned ?? []);
            const points: Record<string, number> = {};
            for (const item of [...(quickboost ?? []), ...(champions ?? [])]) {
                if (item.satisfactionPoints != null) points[item.catalogKey] = item.satisfactionPoints;
            }
            setPointsByKey(points);
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

    const doFeed = useCallback(
        async (catalogKey: string) => {
            if (feeding) return;
            setFeeding(catalogKey);
            setNotice(null);
            setFeedError(null);
            try {
                const { pet: updated } = await feedPet(catalogKey, crypto.randomUUID());
                setPet(updated);
                onPetChange?.(updated);
                setFood((rows) =>
                    rows
                        .map((r) => (r.catalogKey === catalogKey ? { ...r, quantity: r.quantity - 1 } : r))
                        .filter((r) => r.quantity > 0)
                );
                setNotice(`Nom! ${petDisplayName(updated.name, updated.color)} is ${updated.state}.`);
            } catch (err: any) {
                if (err instanceof PetFullError) {
                    setFeedError('Already full — no need to feed right now.');
                } else {
                    setFeedError(err?.message || 'That feed didn’t go through.');
                    const owned = await getOwnedFood();
                    if (owned !== null) setFood(owned);
                }
            } finally {
                setFeeding(null);
            }
        },
        [feeding, onPetChange]
    );

    const renderBody = () => {
        if (loading) return <div className="tank-modal-empty"><p>Setting the table…</p></div>;
        if (loadError) {
            return (
                <div className="tank-modal-empty">
                    <p>{loadError}</p>
                    <button className="hatchery-buy" onClick={() => { setLoading(true); hydrate(); }}>Retry</button>
                </div>
            );
        }
        if (!pet) {
            return (
                <div className="tank-modal-empty">
                    <p>No pet to feed yet.</p>
                    <p>Hatch an egg at the Hatchery first.</p>
                </div>
            );
        }
        return (
            <>
                <div className="feed-modal-pet">
                    <img
                        src={PET_IMAGE_SRC}
                        style={{ filter: petImageFilter(pet.render_mode, pet.render_config) }}
                        alt=""
                        width={96}
                        height={96}
                    />
                    <div>
                        <div className="feed-modal-pet-name">{petDisplayName(pet.name, pet.color)}</div>
                        <span className={`feed-modal-state feed-modal-state--${pet.state}`}>
                            {pet.state === 'satisfied' ? 'Satisfied' : 'Hungry'}
                        </span>
                    </div>
                </div>
                {food.length === 0 ? (
                    <div className="tank-modal-empty">
                        <p>The pantry is empty.</p>
                        <p>The Tank Land food shops can fix that.</p>
                    </div>
                ) : (
                    <ul className="food-shop-list">
                        {food.map((item) => (
                            <li key={item.catalogKey} className="food-shop-item">
                                <img
                                    className="food-shop-thumb"
                                    src={`/assets/images/food/${item.catalogKey}.png`}
                                    alt=""
                                    width={72}
                                    height={72}
                                    loading="lazy"
                                    // Retired SKUs (food_basic/premium) have no sticker art.
                                    onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }}
                                />
                                <div className="food-shop-info">
                                    <div className="food-shop-name">{item.name}</div>
                                    <div className="food-shop-meta">
                                        {pointsByKey[item.catalogKey] != null && <span>+{pointsByKey[item.catalogKey]} satisfaction</span>}
                                        <span className="food-shop-owned">×{item.quantity}</span>
                                    </div>
                                </div>
                                <div className="food-shop-action">
                                    <button
                                        className="food-shop-buy"
                                        onClick={() => doFeed(item.catalogKey)}
                                        disabled={feeding !== null}
                                    >
                                        {feeding === item.catalogKey ? 'Feeding…' : 'Feed'}
                                    </button>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
                {feedError && <div className="hatchery-error" role="alert">{feedError}</div>}
                {notice && <div className="hatchery-notice" role="status">{notice}</div>}
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
                aria-label="Feed your pet"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="tank-modal-header">
                    <span>Feed</span>
                    <button ref={closeButtonRef} className="tank-modal-close" onClick={onClose} aria-label="Close">
                        &times;
                    </button>
                </div>
                <div className="tank-modal-body">{renderBody()}</div>
            </div>
        </div>
    );
};

export default FeedModal;
