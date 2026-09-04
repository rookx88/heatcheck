// Shared food-vendor modal - one component for both Tank Land food shops
// (Quickboost Delicacies, Champion's Lakeside Terrace), parameterized by `vendor`,
// which filters the catalog to that shop's menu. A compact list (not the egg
// shuffle): thumbnail, name, satisfaction, owned count, price, Buy -> inline confirm.
//
// Same commerce contract as the egg shop: server-authoritative atomic Ember spend,
// idempotent on a purchaseToken minted once per confirm intent; food stacks in
// inventory (quantity upsert), and the response's new stack size updates the owned
// badge. Same tank-modal chrome: overlay clicks don't close, only X and Escape.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { trackEvent } from '../tank-analytics-client';
import { dispatchBalanceUpdated } from '../toolbar-state-client';
import {
    getShopFood,
    getOwnedFood,
    getEmberBalance,
    buyFood,
    InsufficientEmberError,
    EggUnavailableError,
    type ShopFood,
} from '../egg-shop-client';
// Shares the hatchery's balance/error/notice/login/action classes; food-specific
// list styles live in FoodShopModal.css.
import './HatcheryModal.css';
import './FoodShopModal.css';

interface FoodShopModalProps {
    title: string;
    vendor: string; // 'quickboost' | 'champions'
    onClose: () => void;
}

export const FoodShopModal: React.FC<FoodShopModalProps> = ({ title, vendor, onClose }) => {
    const [loading, setLoading] = useState(true);
    const [loggedOut, setLoggedOut] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);

    const [items, setItems] = useState<ShopFood[]>([]);
    const [ownedByKey, setOwnedByKey] = useState<Record<string, number>>({});
    const [balance, setBalance] = useState<number | null>(null);

    // One confirm at a time; its token is minted when the confirm opens and reused on
    // retries of that same intent (double-submit debits once), discarded on dismiss.
    const [confirming, setConfirming] = useState<{ catalogKey: string; token: string } | null>(null);
    const [buying, setBuying] = useState(false);
    const [buyError, setBuyError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    const closeButtonRef = useRef<HTMLButtonElement>(null);

    const hydrate = useCallback(async () => {
        setLoadError(null);
        try {
            const [menu, owned, bal] = await Promise.all([getShopFood(vendor), getOwnedFood(), getEmberBalance()]);
            if (menu === null || owned === null) {
                setLoggedOut(true);
                setLoading(false);
                return;
            }
            setLoggedOut(false);
            setItems(menu);
            setOwnedByKey(Object.fromEntries(owned.map((f) => [f.catalogKey, f.quantity])));
            setBalance(bal ?? 0);
            setLoading(false);
        } catch (err: any) {
            setLoadError(err?.message || 'Something went wrong loading the menu.');
            setLoading(false);
        }
    }, [vendor]);

    useEffect(() => {
        hydrate();
    }, [hydrate]);

    // bfcache: Back restores the page without remounting React - refresh counts.
    useEffect(() => {
        const onPageShow = (e: PageTransitionEvent) => {
            if (e.persisted) hydrate();
        };
        window.addEventListener('pageshow', onPageShow);
        return () => window.removeEventListener('pageshow', onPageShow);
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

    const startBuy = useCallback((catalogKey: string) => {
        setBuyError(null);
        setNotice(null);
        setConfirming({ catalogKey, token: crypto.randomUUID() });
    }, []);

    const confirmBuy = useCallback(async () => {
        if (!confirming || buying) return;
        setBuying(true);
        setBuyError(null);
        try {
            const { quantity } = await buyFood(confirming.catalogKey, confirming.token);
            trackEvent('food_purchased', { metadata: { catalogKey: confirming.catalogKey, vendor } });
            setOwnedByKey((m) => ({ ...m, [confirming.catalogKey]: quantity }));
            setConfirming(null);
            setNotice('Added to your pantry!');
            const bal = await getEmberBalance();
            if (bal !== null) setBalance(bal);
            // The HUD chip above this modal shows the same balance - tell it.
            dispatchBalanceUpdated();
        } catch (err: any) {
            if (err instanceof InsufficientEmberError) {
                setBalance(err.balance);
                setBuyError('Not enough Ember.');
                setConfirming(null);
            } else if (err instanceof EggUnavailableError) {
                setBuyError('That item is no longer available.');
                setConfirming(null);
                const menu = await getShopFood(vendor);
                if (menu !== null) setItems(menu);
            } else {
                // Network/unknown: keep the confirm (and its token) so a retry stays
                // idempotent.
                setBuyError(err?.message || 'Purchase failed — try again.');
            }
        } finally {
            setBuying(false);
        }
    }, [confirming, buying, vendor]);

    const renderBody = () => {
        if (loading) return <div className="tank-modal-empty"><p>Firing up the kitchen…</p></div>;
        if (loggedOut) {
            return (
                <div className="tank-modal-empty">
                    <p>This kitchen serves members only.</p>
                    <p><a className="hatchery-login-link" href="/login/">Log in</a> to see the menu.</p>
                </div>
            );
        }
        if (loadError) {
            return (
                <div className="tank-modal-empty">
                    <p>{loadError}</p>
                    <button className="hatchery-buy" onClick={() => { setLoading(true); hydrate(); }}>Retry</button>
                </div>
            );
        }
        if (items.length === 0) {
            return (
                <div className="tank-modal-empty">
                    <p>The kitchen is restocking.</p>
                    <p>Check back soon.</p>
                </div>
            );
        }
        return (
            <>
                <div className="hatchery-balance" aria-live="polite">
                    Ember: <strong>{balance ?? '—'}</strong>
                </div>
                <ul className="food-shop-list">
                    {items.map((item) => {
                        const owned = ownedByKey[item.catalogKey] ?? 0;
                        const isConfirming = confirming?.catalogKey === item.catalogKey;
                        return (
                            <li key={item.catalogKey} className="food-shop-item">
                                <img
                                    className="food-shop-thumb"
                                    src={`/assets/images/food/${item.catalogKey}.png`}
                                    alt=""
                                    width={72}
                                    height={72}
                                    loading="lazy"
                                />
                                <div className="food-shop-info">
                                    <div className="food-shop-name">{item.name}</div>
                                    <div className="food-shop-meta">
                                        {item.satisfactionPoints != null && <span>+{item.satisfactionPoints} satisfaction</span>}
                                        {owned > 0 && <span className="food-shop-owned">Owned: {owned}</span>}
                                    </div>
                                </div>
                                <div className="food-shop-action">
                                    <div className="food-shop-price">{item.price} Ember</div>
                                    {!isConfirming ? (
                                        <button className="food-shop-buy" onClick={() => startBuy(item.catalogKey)}>
                                            Buy
                                        </button>
                                    ) : (
                                        <div className="food-shop-confirm-row">
                                            <button className="food-shop-confirm" onClick={confirmBuy} disabled={buying}>
                                                {buying ? 'Buying…' : 'Confirm'}
                                            </button>
                                            <button
                                                className="food-shop-cancel"
                                                onClick={() => { setConfirming(null); setBuyError(null); }}
                                                disabled={buying}
                                            >
                                                Cancel
                                            </button>
                                        </div>
                                    )}
                                </div>
                            </li>
                        );
                    })}
                </ul>
                {buyError && <div className="hatchery-error" role="alert">{buyError}</div>}
                {notice && <div className="hatchery-notice" role="status">{notice}</div>}
            </>
        );
    };

    return (
        // Not closed by overlay clicks - see the Tank modal's comment.
        <div className="tank-modal-overlay">
            <div
                className="tank-modal-panel"
                role="dialog"
                aria-modal="true"
                aria-label={title}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="tank-modal-header">
                    <span>{title}</span>
                    <button ref={closeButtonRef} className="tank-modal-close" onClick={onClose} aria-label="Close">
                        &times;
                    </button>
                </div>
                <div className="tank-modal-body">{renderBody()}</div>
            </div>
        </div>
    );
};

export default FoodShopModal;
