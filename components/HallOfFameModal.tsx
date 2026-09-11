// Hall of Fame - the leaderboard behind the golden rotunda on Tank Land. Top 100
// accounts by lifetime Ember EARNED (GET /api/hall-of-fame: settlement payouts, pet
// finds, TANKDAQ profit - never share-sell proceeds or seeds), ten to a page, with the
// viewer's own rank pinned under the list when they're logged in and have earned any.
//
// Rides the shared .tank-modal-* chrome from TankScreen.css (same non-dismissing
// overlay contract as every other tank modal: only the X and Escape close it) plus
// this file's own row styling. Pages are cached in component state once fetched so
// paging back is instant; the endpoint edge-caches the ranked half for a minute anyway.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { EmberIcon } from './MapHud';
import { PET_IMAGE_SRC, petImageFilter } from './petRender';
import './TankScreen.css';
import './HallOfFameModal.css';

interface HallOfFameRow {
    rank: number;
    username: string;
    earned: number;
    // The account's Captain pet, drawn as the avatar with the same tint recipe every
    // other surface uses (petRender.ts); null = no pet yet, fall back to an initial.
    pet: { renderMode: string; renderConfig: Record<string, unknown> } | null;
}

interface HallOfFamePage {
    page: number;
    pageSize: number;
    totalPages: number;
    totalRanked: number;
    rows: HallOfFameRow[];
    loggedIn: boolean;
    me: HallOfFameRow | null;
}

interface HallOfFameModalProps {
    onClose: () => void;
}

const PAGE_SIZE = 10;

function tierFor(rank: number): 'gold' | 'silver' | 'bronze' | 'base' {
    if (rank === 1) return 'gold';
    if (rank === 2) return 'silver';
    if (rank === 3) return 'bronze';
    return 'base';
}

function formatEmber(n: number): string {
    return n.toLocaleString('en-US');
}

const Row: React.FC<{ row: HallOfFameRow; isMe: boolean; pinned?: boolean }> = ({ row, isMe, pinned }) => (
    <li className={`hof-row hof-row--${tierFor(row.rank)}${isMe ? ' is-me' : ''}${pinned ? ' hof-row--pinned' : ''}`}>
        <span className="hof-row__rank" aria-label={`Rank ${row.rank}`}>{row.rank}</span>
        <span className={`hof-row__avatar${row.pet ? ' hof-row__avatar--pet' : ''}`} aria-hidden="true">
            {row.pet ? (
                // Head crop of the shared body sprite: the disc clips it, the CSS
                // scales and anchors it so the face fills the circle.
                <img
                    className="hof-row__pet"
                    src={PET_IMAGE_SRC}
                    alt=""
                    decoding="async"
                    loading="lazy"
                    style={{ filter: petImageFilter(row.pet.renderMode, row.pet.renderConfig) }}
                />
            ) : (
                row.username.charAt(0).toUpperCase()
            )}
        </span>
        <span className="hof-row__name">
            {row.username}
            {isMe && <span className="hof-row__you">You</span>}
        </span>
        <span className="hof-row__ember"><EmberIcon />{formatEmber(row.earned)}</span>
    </li>
);

export const HallOfFameModal: React.FC<HallOfFameModalProps> = ({ onClose }) => {
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    const [page, setPage] = useState(1);
    const [pages, setPages] = useState<Record<number, HallOfFamePage>>({});
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Bumped on retry so the effect re-runs for the same page after a failure.
    const [attempt, setAttempt] = useState(0);

    const current = pages[page] ?? null;
    // totalPages comes from whichever page has loaded; until one has, keep paging
    // possible so the arrows aren't dead during the very first load.
    const known = current ?? Object.values(pages)[0] ?? null;
    const totalPages = known?.totalPages ?? 1;

    useEffect(() => {
        if (pages[page]) return;
        let cancelled = false;
        setLoading(true);
        setError(null);
        fetch(`/api/hall-of-fame?page=${page}`, { credentials: 'same-origin' })
            .then(async (res) => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return (await res.json()) as HallOfFamePage;
            })
            .then((data) => {
                if (cancelled) return;
                setPages((prev) => ({ ...prev, [data.page]: data }));
            })
            .catch(() => {
                if (!cancelled) setError('The Hall of Fame is unreachable right now.');
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
        // `pages` is deliberately not a dependency: a fetched page landing must not
        // re-run this for the page that just landed.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [page, attempt]);

    const prev = useCallback(() => setPage((p) => Math.max(1, p - 1)), []);
    const next = useCallback(() => setPage((p) => Math.min(totalPages, p + 1)), [totalPages]);

    useEffect(() => {
        document.body.style.overflow = 'hidden';
        closeButtonRef.current?.focus();
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowLeft') prev();
            if (e.key === 'ArrowRight') next();
        };
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.body.style.overflow = '';
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [onClose, prev, next]);

    const me = known?.me ?? null;
    const loggedIn = known?.loggedIn ?? false;
    const rows = current?.rows ?? [];
    // Pin the viewer's row under the list only when it isn't already on this page.
    const meOnThisPage = me !== null && rows.some((r) => r.username === me.username);

    return (
        // Same non-dismissing overlay contract as the other tank modals.
        <div className="tank-modal-overlay">
            <div
                className="tank-modal-panel hof-modal"
                role="dialog"
                aria-modal="true"
                aria-label="Hall of Fame - top Ember earners"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="tank-modal-header">
                    {/* Wordmark stacked above the ribbon and overlapping its top edge,
                        layered on top - the reference art's banner-under-crest stack.
                        The -solid variant: the standard wordmark's lettering is mostly
                        semi-transparent pixels, so the ribbon showed through it here. */}
                    <span className="hof-title">
                        <span className="hof-ribbon">Hall of Fame</span>
                        <img
                            className="hof-logo"
                            src="/assets/images/heatchecks-logo-solid.webp"
                            alt="HeatChecks"
                            width="500"
                            height="241"
                            decoding="async"
                        />
                    </span>
                    <button ref={closeButtonRef} className="tank-modal-close" onClick={onClose} aria-label="Close">
                        &times;
                    </button>
                </div>
                <div className="tank-modal-body hof-body">
                    <p className="hof-subtitle">Top 100 by Ember earned</p>

                    {error ? (
                        <div className="tank-modal-empty hof-error">
                            {error}
                            <div>
                                <button type="button" className="tank-modal-filter" onClick={() => setAttempt((a) => a + 1)}>
                                    Try again
                                </button>
                            </div>
                        </div>
                    ) : current === null ? (
                        <ol className="hof-list" aria-busy="true" aria-label="Loading the leaderboard">
                            {Array.from({ length: PAGE_SIZE }, (_, i) => (
                                <li key={i} className="hof-row hof-row--skeleton" aria-hidden="true">
                                    <span className="hof-row__rank" />
                                    <span className="hof-row__avatar" />
                                    <span className="hof-row__name" />
                                    <span className="hof-row__ember" />
                                </li>
                            ))}
                        </ol>
                    ) : rows.length === 0 ? (
                        <div className="tank-modal-empty">
                            {page === 1 ? 'No Ember earned yet. The first call to settle takes the top spot.' : 'Nothing on this page yet.'}
                        </div>
                    ) : (
                        <ol className="hof-list" start={rows[0].rank}>
                            {rows.map((row) => (
                                <Row key={row.username} row={row} isMe={me !== null && row.username === me.username} />
                            ))}
                        </ol>
                    )}

                    <div className="tank-modal-nav hof-nav">
                        <button className="tank-modal-arrow" onClick={prev} disabled={page <= 1 || loading} aria-label="Previous page">
                            &lsaquo;
                        </button>
                        <span className="tank-modal-count">{page} / {totalPages}</span>
                        <button className="tank-modal-arrow" onClick={next} disabled={page >= totalPages || loading} aria-label="Next page">
                            &rsaquo;
                        </button>
                    </div>

                    {known !== null && (
                        me !== null ? (
                            !meOnThisPage && (
                                <ol className="hof-list hof-list--me" aria-label="Your rank">
                                    <Row row={me} isMe pinned />
                                </ol>
                            )
                        ) : (
                            <p className="hof-me-note">
                                {loggedIn ? 'Earn Ember to take a place in the Hall of Fame.' : 'Log in to see your rank.'}
                            </p>
                        )
                    )}

                    {/* What the ranking figure is - mirrors the definition in
                        add_lifetime_earned_to_ember_balances.sql, in plain words. */}
                    <p className="hof-disclaimer">
                        <strong>Ember earned</strong> counts Ember paid out on settled picks (wins and the
                        participation Ember on losses), Ember your Mud Puppy finds, and profit from selling
                        TANKDAQ shares above what you paid. It does not include starting balances,
                        adjustments, or the sale proceeds themselves, and spending never lowers it.
                    </p>
                </div>
            </div>
        </div>
    );
};

export default HallOfFameModal;
