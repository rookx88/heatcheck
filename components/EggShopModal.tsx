// The "Eggs for Sale" modal on The Hatchery page: two tabs - Shop (browse and buy)
// and My Eggs (owned, unhatched eggs). Hatching is deliberately NOT here - that's the
// incubator's modal (IncubatorModal.tsx), so every Egg3D in this modal renders with
// hatchEnabled={false} and taps are inert.
//
// Same tank-modal chrome contract as the Tank modal: overlay clicks do NOT close
// (3D egg drags end with the pointer over the overlay), only X and Escape do.
// Server-authoritative buying through the atomic Ember spend, idempotent on a
// purchaseToken minted once per confirm intent. Known-outcome only: one fixed
// colorway per listing, no picker.
//
// Every colour is also a finite run shared by the whole user base - 500 each
// (add_egg_supply_caps.sql) - so each listing shows how many are left, a colour that
// runs out stays on the shelf marked sold out rather than vanishing, and the listing is
// refetched after every purchase. The count here is display only: the cap is held by
// the purchase statement, and losing the race for the last one comes back as a 409
// (SoldOutError) even with the button showing stock.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Egg3D, { colorwayFromCatalog } from './Egg3D';
import { trackEvent } from '../tank-analytics-client';
import { dispatchBalanceUpdated } from '../toolbar-state-client';
import {
    getShopEggs,
    getOwnedEggs,
    getEmberBalance,
    buyEgg,
    InsufficientEmberError,
    EggUnavailableError,
    SoldOutError,
    type ShopEgg,
    type OwnedEgg,
} from '../egg-shop-client';
import './HatcheryModal.css';

type ShopTab = 'shop' | 'eggs';

export function formatAcquired(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
        ? ''
        : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

interface EggShopModalProps {
    onClose: () => void;
}

export const EggShopModal: React.FC<EggShopModalProps> = ({ onClose }) => {
    const [tab, setTab] = useState<ShopTab>('shop');
    const [loading, setLoading] = useState(true);
    const [loggedOut, setLoggedOut] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);

    const [shopEggs, setShopEggs] = useState<ShopEgg[]>([]);
    const [ownedEggs, setOwnedEggs] = useState<OwnedEgg[]>([]);
    const [balance, setBalance] = useState<number | null>(null);

    const [shopIndex, setShopIndex] = useState(0);
    const [eggsIndex, setEggsIndex] = useState(0);

    // The purchaseToken is minted ONCE when the confirm step opens and reused on any
    // retry of that same intent (that's what makes a double-submit debit once);
    // dismissing the confirm discards it.
    const [confirming, setConfirming] = useState<{ catalogKey: string; token: string } | null>(null);
    const [buying, setBuying] = useState(false);
    const [buyError, setBuyError] = useState<string | null>(null);
    const [buyNotice, setBuyNotice] = useState<string | null>(null);

    const closeButtonRef = useRef<HTMLButtonElement>(null);

    const hydrate = useCallback(async () => {
        setLoadError(null);
        try {
            const [shop, eggs, bal] = await Promise.all([getShopEggs(), getOwnedEggs(), getEmberBalance()]);
            if (shop === null || eggs === null) {
                setLoggedOut(true);
                setLoading(false);
                return;
            }
            setLoggedOut(false);
            setShopEggs(shop);
            setOwnedEggs(eggs);
            setBalance(bal ?? 0);
            setLoading(false);
        } catch (err: any) {
            setLoadError(err?.message || 'Something went wrong loading the shop.');
            setLoading(false);
        }
    }, []);

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
        setEggsIndex((i) => Math.min(i, Math.max(0, ownedEggs.length - 1)));
    }, [ownedEggs.length]);
    useEffect(() => {
        setShopIndex((i) => Math.min(i, Math.max(0, shopEggs.length - 1)));
    }, [shopEggs.length]);

    const shuffle = useCallback(
        (dir: -1 | 1) => {
            if (tab === 'shop') {
                if (shopEggs.length > 1) {
                    setShopIndex((i) => (i + dir + shopEggs.length) % shopEggs.length);
                    setConfirming(null);
                    setBuyError(null);
                    setBuyNotice(null);
                }
            } else if (ownedEggs.length > 1) {
                setEggsIndex((i) => (i + dir + ownedEggs.length) % ownedEggs.length);
            }
        },
        [tab, shopEggs.length, ownedEggs.length]
    );

    useEffect(() => {
        document.body.style.overflow = 'hidden';
        closeButtonRef.current?.focus();
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowLeft') shuffle(-1);
            if (e.key === 'ArrowRight') shuffle(1);
        };
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.body.style.overflow = '';
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [onClose, shuffle]);

    const selectTab = useCallback((t: ShopTab) => {
        setTab(t);
        setConfirming(null);
        setBuyError(null);
        setBuyNotice(null);
    }, []);

    const startBuy = useCallback((catalogKey: string) => {
        setBuyError(null);
        setBuyNotice(null);
        setConfirming({ catalogKey, token: crypto.randomUUID() });
    }, []);

    const confirmBuy = useCallback(async () => {
        if (!confirming || buying) return;
        setBuying(true);
        setBuyError(null);
        try {
            await buyEgg(confirming.catalogKey, confirming.token);
            trackEvent('egg_purchased', { metadata: { catalogKey: confirming.catalogKey } });
            setConfirming(null);
            setBuyNotice('Added to your eggs!');
            // The shop listing is refetched alongside the owned eggs, not just on open:
            // every colour is a finite run shared with everyone, so the count on the
            // shelf has to move the moment this buyer takes one of them (and it also
            // picks up whatever everyone ELSE bought while this modal was open).
            const [shop, eggs, bal] = await Promise.all([getShopEggs(), getOwnedEggs(), getEmberBalance()]);
            if (shop !== null) setShopEggs(shop);
            if (eggs !== null) setOwnedEggs(eggs);
            if (bal !== null) setBalance(bal);
            // The HUD chip above this modal shows the same balance - tell it.
            dispatchBalanceUpdated();
        } catch (err: any) {
            if (err instanceof InsufficientEmberError) {
                setBalance(err.balance);
                setBuyError('Not enough Ember.');
                setConfirming(null);
            } else if (err instanceof SoldOutError) {
                // Lost the race for the last one of this colour. Re-list so the shelf
                // agrees with the refusal instead of still offering a Buy button.
                setBuyError(err.message);
                setConfirming(null);
                const shop = await getShopEggs();
                if (shop !== null) setShopEggs(shop);
            } else if (err instanceof EggUnavailableError) {
                setBuyError('That egg is no longer available.');
                setConfirming(null);
                const shop = await getShopEggs();
                if (shop !== null) setShopEggs(shop);
            } else {
                // Network/unknown: keep the confirm (and its token) so a retry of the
                // same intent stays idempotent.
                setBuyError(err?.message || 'Purchase failed — try again.');
            }
        } finally {
            setBuying(false);
        }
    }, [confirming, buying]);

    const renderShop = () => {
        const listing = shopEggs[shopIndex];
        if (!listing) {
            return (
                <div className="tank-modal-empty">
                    <p>The shop shelf is empty.</p>
                    <p>Check back soon.</p>
                </div>
            );
        }
        const isConfirming = confirming?.catalogKey === listing.catalogKey;
        // Capped colour (supply non-null) with nothing left. Only the server actually
        // enforces this - the Buy button below is a courtesy, and a hand-rolled POST
        // still gets a 409 from /api/shop/buy.
        const soldOut = listing.supply !== null && (listing.remaining ?? 0) <= 0;
        return (
            <>
                <div className="hatchery-balance" aria-live="polite">
                    Ember: <strong>{balance ?? '—'}</strong>
                </div>
                <Egg3D
                    key={listing.catalogKey}
                    colorway={colorwayFromCatalog(listing)}
                    hatchEnabled={false}
                    hatched={false}
                    size={136}
                />
                <div className="hatchery-egg-name">{listing.name}</div>
                <div className="hatchery-price">{listing.price} Ember</div>
                {listing.supply !== null && (
                    // The count is the whole scarcity story: no tiers, no rarity, just
                    // how many of these there will ever be and how many are still here.
                    <div className={`hatchery-stock${soldOut ? ' is-out' : ''}`} aria-live="polite">
                        {soldOut
                            ? `Sold out — all ${listing.supply} claimed`
                            : `${listing.remaining} of ${listing.supply} left`}
                    </div>
                )}
                {listing.availableUntil && (
                    <div className="hatchery-limited">Limited — gone after {formatAcquired(listing.availableUntil)}</div>
                )}
                {shopEggs.length > 1 && (
                    <div className="tank-modal-nav">
                        <button className="tank-modal-arrow" onClick={() => shuffle(-1)} aria-label="Previous egg">
                            &lsaquo;
                        </button>
                        <span className="tank-modal-count">{shopIndex + 1} / {shopEggs.length}</span>
                        <button className="tank-modal-arrow" onClick={() => shuffle(1)} aria-label="Next egg">
                            &rsaquo;
                        </button>
                    </div>
                )}
                {!isConfirming ? (
                    <button
                        className="hatchery-buy"
                        onClick={() => startBuy(listing.catalogKey)}
                        disabled={soldOut}
                    >
                        {soldOut ? 'Sold out' : 'Buy'}
                    </button>
                ) : (
                    <div className="hatchery-confirm-row">
                        <button className="hatchery-confirm" onClick={confirmBuy} disabled={buying}>
                            {buying ? 'Buying…' : `Confirm — ${listing.price} Ember`}
                        </button>
                        <button
                            className="hatchery-cancel"
                            onClick={() => { setConfirming(null); setBuyError(null); }}
                            disabled={buying}
                        >
                            Cancel
                        </button>
                    </div>
                )}
                {buyError && <div className="hatchery-error" role="alert">{buyError}</div>}
                {buyNotice && <div className="hatchery-notice" role="status">{buyNotice}</div>}
            </>
        );
    };

    const renderEggs = () => {
        const egg = ownedEggs[eggsIndex];
        if (!egg) {
            return (
                <div className="tank-modal-empty">
                    <p>No eggs yet.</p>
                    <p>The shop shelf is right there.</p>
                </div>
            );
        }
        return (
            <>
                <Egg3D
                    key={egg.id}
                    colorway={colorwayFromCatalog(egg)}
                    hatchEnabled={false}
                    hatched={false}
                    size={136}
                />
                <div className="hatchery-egg-name">{egg.name}</div>
                <div className="hatchery-caption">Acquired {formatAcquired(egg.acquiredAt)}</div>
                {ownedEggs.length > 1 && (
                    <div className="tank-modal-nav">
                        <button className="tank-modal-arrow" onClick={() => shuffle(-1)} aria-label="Previous egg">
                            &lsaquo;
                        </button>
                        <span className="tank-modal-count">{eggsIndex + 1} / {ownedEggs.length}</span>
                        <button className="tank-modal-arrow" onClick={() => shuffle(1)} aria-label="Next egg">
                            &rsaquo;
                        </button>
                    </div>
                )}
                <div className="hatchery-caption">Ready to hatch one? The incubator is across the room.</div>
            </>
        );
    };

    const renderBody = () => {
        if (loading) return <div className="tank-modal-empty"><p>Stocking the shelves…</p></div>;
        if (loggedOut) {
            return (
                <div className="tank-modal-empty">
                    <p>The shop is members-only.</p>
                    <p><a className="hatchery-login-link" href="/login/">Log in</a> to browse eggs.</p>
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
        return (
            <>
                <div className="tank-modal-filters" aria-label="Shop sections">
                    {([
                        ['shop', 'Shop'],
                        ['eggs', `My Eggs${ownedEggs.length ? ` (${ownedEggs.length})` : ''}`],
                    ] as [ShopTab, string][]).map(([t, label]) => (
                        <button
                            key={t}
                            className={`tank-modal-filter${tab === t ? ' is-active' : ''}`}
                            onClick={() => selectTab(t)}
                            aria-pressed={tab === t}
                        >
                            {label}
                        </button>
                    ))}
                </div>
                {tab === 'shop' ? renderShop() : renderEggs()}
            </>
        );
    };

    return (
        // Not closed by overlay clicks - see the Tank modal's comment (3D drags end
        // with the pointer over the overlay).
        <div className="tank-modal-overlay">
            <div
                className="tank-modal-panel"
                role="dialog"
                aria-modal="true"
                aria-label="Eggs for Sale"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="tank-modal-header">
                    <span>Eggs for Sale</span>
                    <button ref={closeButtonRef} className="tank-modal-close" onClick={onClose} aria-label="Close">
                        &times;
                    </button>
                </div>
                <div className="tank-modal-body hatchery-body">{renderBody()}</div>
            </div>
        </div>
    );
};

export default EggShopModal;
