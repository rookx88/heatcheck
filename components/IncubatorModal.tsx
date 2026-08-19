// The incubator's modal on The Hatchery page - the ONLY place an egg can hatch.
// Select an owned egg (same newest-first shuffle as My Eggs), tap it, and the real
// server-side hatch fires: the egg's inventory row is deleted and the pet is created
// in one transaction. The crack-open animation plays only after the server confirms -
// never as a purely cosmetic effect. One pet per account this build: with a pet
// already in the tank, the incubator shows that state instead of the hatch flow.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Egg3D, { colorwayFromCatalog } from './Egg3D';
import { PET_IMAGE_SRC, petImageFilter, petDisplayName } from './petRender';
import { trackEvent } from '../tank-analytics-client';
import {
    getOwnedEggs,
    getPet,
    hatchEgg,
    EggGoneError,
    type OwnedEgg,
    type PetInfo,
} from '../egg-shop-client';
import './HatcheryModal.css';

interface HatchOutcome {
    egg: OwnedEgg;      // snapshot - the row is deleted server-side the moment this exists
    pet: PetInfo;
    created: boolean;   // false = a pet already existed / a double-fire race was won elsewhere
}

interface IncubatorModalProps {
    onClose: () => void;
}

export const IncubatorModal: React.FC<IncubatorModalProps> = ({ onClose }) => {
    const [loading, setLoading] = useState(true);
    const [loggedOut, setLoggedOut] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);

    const [ownedEggs, setOwnedEggs] = useState<OwnedEgg[]>([]);
    const [pet, setPet] = useState<PetInfo | null>(null);
    const [index, setIndex] = useState(0);

    // pending = request in flight (taps/nav/close blocked); outcome set on server
    // confirmation starts the crack; reveal shows once the burst has played.
    const [hatchPending, setHatchPending] = useState(false);
    const [hatchOutcome, setHatchOutcome] = useState<HatchOutcome | null>(null);
    const [revealShown, setRevealShown] = useState(false);
    const [hatchError, setHatchError] = useState<string | null>(null);

    const closeButtonRef = useRef<HTMLButtonElement>(null);
    const hatchPendingRef = useRef(false);
    hatchPendingRef.current = hatchPending;

    const hydrate = useCallback(async () => {
        setLoadError(null);
        try {
            const [eggs, p] = await Promise.all([getOwnedEggs(), getPet()]);
            if (eggs === null) {
                setLoggedOut(true);
                setLoading(false);
                return;
            }
            setLoggedOut(false);
            setOwnedEggs(eggs);
            setPet(p);
            setLoading(false);
        } catch (err: any) {
            setLoadError(err?.message || 'Something went wrong loading the incubator.');
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        hydrate();
    }, [hydrate]);

    useEffect(() => {
        const onPageShow = (e: PageTransitionEvent) => {
            if (e.persisted) hydrate();
        };
        window.addEventListener('pageshow', onPageShow);
        return () => window.removeEventListener('pageshow', onPageShow);
    }, [hydrate]);

    useEffect(() => {
        setIndex((i) => Math.min(i, Math.max(0, ownedEggs.length - 1)));
    }, [ownedEggs.length]);

    const close = useCallback(() => {
        // Never mid-request: the hatch is already committed server-side and closing
        // would silently eat the confirmation/crack.
        if (hatchPendingRef.current) return;
        onClose();
    }, [onClose]);

    const shuffle = useCallback(
        (dir: -1 | 1) => {
            if (hatchPendingRef.current || hatchOutcome) return;
            if (ownedEggs.length > 1) setIndex((i) => (i + dir + ownedEggs.length) % ownedEggs.length);
        },
        [ownedEggs.length, hatchOutcome]
    );

    useEffect(() => {
        document.body.style.overflow = 'hidden';
        closeButtonRef.current?.focus();
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') close();
            if (e.key === 'ArrowLeft') shuffle(-1);
            if (e.key === 'ArrowRight') shuffle(1);
        };
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.body.style.overflow = '';
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [close, shuffle]);

    const requestHatch = useCallback(async () => {
        const egg = ownedEggs[index];
        if (!egg || hatchPending || hatchOutcome) return;
        setHatchPending(true);
        setHatchError(null);
        try {
            const result = await hatchEgg(egg.id);
            trackEvent('egg_hatched', { metadata: { catalogKey: egg.catalogKey, created: result.created } });
            setHatchOutcome({ egg, pet: result.pet, created: result.created });
            // Let the crack-open burst play before the reveal card covers it.
            window.setTimeout(() => setRevealShown(true), 1600);
            const [eggs, p] = await Promise.all([getOwnedEggs(), getPet()]);
            if (eggs !== null) setOwnedEggs(eggs);
            setPet(p);
        } catch (err: any) {
            if (err instanceof EggGoneError) {
                setHatchError('That egg is gone.');
                const eggs = await getOwnedEggs();
                if (eggs !== null) setOwnedEggs(eggs);
            } else {
                setHatchError(err?.message || 'The hatch didn’t go through — try again.');
            }
        } finally {
            setHatchPending(false);
        }
    }, [ownedEggs, index, hatchPending, hatchOutcome]);

    const finishReveal = useCallback(() => {
        setHatchOutcome(null);
        setRevealShown(false);
    }, []);

    const renderBody = () => {
        if (loading) return <div className="tank-modal-empty"><p>Warming up the incubator…</p></div>;
        if (loggedOut) {
            return (
                <div className="tank-modal-empty">
                    <p>The incubator is members-only.</p>
                    <p><a className="hatchery-login-link" href="/login/">Log in</a> to hatch eggs.</p>
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
        // A completed hatch renders from its snapshot (the row is gone from the list).
        if (hatchOutcome) {
            return !revealShown ? (
                <Egg3D
                    key={`hatched-${hatchOutcome.egg.id}`}
                    colorway={colorwayFromCatalog(hatchOutcome.egg)}
                    hatchEnabled={false}
                    hatched={true}
                    size={136}
                />
            ) : (
                <div className="hatchery-reveal-card">
                    <img
                        className="hatchery-reveal-pet"
                        src={PET_IMAGE_SRC}
                        style={{ filter: petImageFilter(hatchOutcome.pet.render_mode, hatchOutcome.pet.render_config) }}
                        alt={`${hatchOutcome.pet.color} mud puppy`}
                        width={160}
                        height={160}
                    />
                    {hatchOutcome.created ? (
                        <>
                            <div className="hatchery-reveal-title">It hatched!</div>
                            <div className="hatchery-caption">
                                {petDisplayName(hatchOutcome.pet.name, hatchOutcome.pet.color)} is now your captain.
                            </div>
                        </>
                    ) : (
                        <>
                            <div className="hatchery-reveal-title">Your tank already has a captain</div>
                            <div className="hatchery-caption">
                                {petDisplayName(hatchOutcome.pet.name, hatchOutcome.pet.color)} is holding the spot.
                            </div>
                        </>
                    )}
                    <button className="hatchery-buy" onClick={finishReveal}>Done</button>
                </div>
            );
        }
        if (pet) {
            return (
                <div className="tank-modal-empty">
                    <p>Your tank already has a captain{pet.name ? ` — ${pet.name}` : ''}.</p>
                    <p>One pet per tank for now, so the incubator is resting.</p>
                </div>
            );
        }
        const egg = ownedEggs[index];
        if (!egg) {
            return (
                <div className="tank-modal-empty">
                    <p>Nothing to incubate.</p>
                    <p>The egg shop can fix that.</p>
                </div>
            );
        }
        return (
            <>
                <Egg3D
                    key={egg.id}
                    colorway={colorwayFromCatalog(egg)}
                    hatchEnabled={true}
                    hatched={false}
                    pending={hatchPending}
                    onHatchRequest={requestHatch}
                    size={136}
                />
                <div className="hatchery-egg-name">{egg.name}</div>
                <div className="hatchery-caption">
                    {hatchPending ? 'Hatching…' : 'Tap the egg to hatch it. This is the real thing — no take-backs.'}
                </div>
                {ownedEggs.length > 1 && (
                    <div className="tank-modal-nav">
                        <button className="tank-modal-arrow" onClick={() => shuffle(-1)} aria-label="Previous egg" disabled={hatchPending}>
                            &lsaquo;
                        </button>
                        <span className="tank-modal-count">{index + 1} / {ownedEggs.length}</span>
                        <button className="tank-modal-arrow" onClick={() => shuffle(1)} aria-label="Next egg" disabled={hatchPending}>
                            &rsaquo;
                        </button>
                    </div>
                )}
                {hatchError && <div className="hatchery-error" role="alert">{hatchError}</div>}
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
                aria-label="Incubator"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="tank-modal-header">
                    <span>Incubator</span>
                    <button ref={closeButtonRef} className="tank-modal-close" onClick={close} aria-label="Close">
                        &times;
                    </button>
                </div>
                <div className="tank-modal-body hatchery-body">{renderBody()}</div>
            </div>
        </div>
    );
};

export default IncubatorModal;
