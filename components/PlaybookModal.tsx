// My Playbook: the characters' errands. Opened from the header menus via PlaybookHost.
// Two tabs - Current and Completed - over GET /api/plays. Read-only: a Play completes
// on the page load that satisfies it (toolbar-state), never from here, and a delivery is
// handed over by going to the character's home, which this modal links to.
//
// Completed rows open a receipt: what the pet handed over (a delivery's frozen item list)
// and what came back (the reward scene's grants). A reward that has not played yet reads
// as "on its way", never as a blank.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getPlays, type DeliveryLine, type PlayProgress, type PlayView, type PlaysResponse } from '../plays-client';
import { CHARACTERS, portraitSrc } from '../lib/pages-functions/encounters';
import type { EncounterGrants } from '../lib/pages-functions/encounters/types';
import { EmberIcon } from './MapHud';
import './TankScreen.css';
import './HatcheryModal.css';
import './PetInventoryModal.css';
import './PlaybookModal.css';

interface PlaybookModalProps {
    onClose: () => void;
}

type Tab = 'current' | 'completed';

// Where a place key sends you. Keys come from discovery.ts STATIC_PLACES; a key missing
// here still renders, just without a link.
const PLACES: Record<string, { label: string; href: string }> = {
    'the-tank': { label: 'Tank Land', href: '/the-tank/' },
    'the-tank-hq': { label: 'Tank HQ', href: '/the-tank-hq/' },
    'the-hatchery': { label: 'the Hatchery', href: '/the-hatchery/' },
    'champions-terrace': { label: 'Champions Terrace', href: '/champions-terrace/' },
    'quickboost-delicacies': { label: 'Quickboost Delicacies', href: '/quickboost-delicacies/' },
    tankdaq: { label: 'TANKDAQ', href: '/tankdaq/' },
    account: { label: 'your Account page', href: '/account/' },
    'my-portfolio': { label: 'My Portfolio', href: '/my-portfolio/' },
};

function placeLabel(key: string): string {
    return PLACES[key]?.label ?? key.replace(/-/g, ' ');
}

function dateLabel(iso: string | null): string {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// The unit each kind counts in, for the line under its bar. The moment-shaped kinds
// have no unit: they render as a single tick instead of a count.
function unitLabel(kind: PlayView['kind']): string {
    switch (kind) {
        case 'feeds': return 'feeds';
        case 'picks': return 'calls';
        case 'win_picks': return 'calls won';
        case 'earn_ember': return 'Ember earned';
        case 'read_articles': return 'Tanks read';
        case 'visit_places': return 'places';
        case 'deliver_items': return 'items';
        case 'hold_shares': return 'held';
        case 'sell_profit': return 'closed in profit';
        case 'hold_through_close': return '';
        case 'pet_sustained_satisfied': return '';
        case 'name_pet': return '';
        case 'all_of': return 'steps';
    }
}

// Moment-shaped kinds: true or false right now, so a progress bar would be a lie.
const MOMENT_KINDS = new Set<PlayView['kind']>(['hold_through_close', 'pet_sustained_satisfied', 'name_pet']);

// What a moment objective is waiting for, said plainly.
function momentLabel(kind: PlayView['kind'], done: boolean): string {
    if (kind === 'name_pet') return done ? 'Your pet has a name' : 'Give your pet a name';
    if (kind === 'pet_sustained_satisfied') return done ? 'Your pet is well fed' : 'Keep your pet fed for a few hours';
    if (kind === 'hold_through_close') return done ? 'A position survived a close' : 'Hold a position through an index close';
    return done ? 'Done' : 'Not yet';
}

const Portrait: React.FC<{ characterKey: string }> = ({ characterKey }) => {
    const character = CHARACTERS[characterKey];
    if (!character) return <span className="playbook-portrait playbook-portrait--blank" aria-hidden="true" />;
    // The portraits are full-body sprites; the round frame crops to head and shoulders.
    return (
        <span className="playbook-portrait" aria-hidden="true">
            <img
                className="playbook-portrait__img"
                src={portraitSrc(character, 'main')}
                alt=""
                loading="lazy"
                onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }}
            />
        </span>
    );
};

const ItemChip: React.FC<{ name?: string; art?: string | null; count: string; done?: boolean }> = ({ name, art, count, done }) => (
    <span className={`playbook-chip${done ? ' is-done' : ''}`}>
        {art ? (
            <img
                className="playbook-chip__art"
                src={`/assets/images/${art}`}
                alt=""
                onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }}
            />
        ) : (
            <span className="playbook-chip__art playbook-chip__art--blank" aria-hidden="true" />
        )}
        <span className="playbook-chip__name">{name || 'An item'}</span>
        <span className="playbook-chip__count">{count}</span>
    </span>
);

const GotChips: React.FC<{ got: EncounterGrants }> = ({ got }) => {
    const item = got.item;
    const ember = Number(got.ember?.amount ?? 0);
    if (!item && ember <= 0) return <p className="playbook-receipt__note">A thank-you, and nothing to carry.</p>;
    return (
        <div className="playbook-chips">
            {item && <ItemChip name={item.name} art={item.art} count="×1" />}
            {ember > 0 && (
                <span className="playbook-chip playbook-chip--ember">
                    <EmberIcon />
                    <span className="playbook-chip__name">+{ember} Ember</span>
                </span>
            )}
        </div>
    );
};

// One measured thing: a whole Play, or one part of a compound one. Deliveries draw item
// chips, moment objectives draw a tick, everything else draws a bar.
const Measure: React.FC<{
    kind: PlayView['kind'];
    progress: PlayProgress;
    objective?: PlayView['objective'];
    characterName: string;
    label?: string;
}> = ({ kind, progress, objective, characterName, label }) => {
    const done = progress.done >= progress.target;

    if (kind === 'deliver_items') {
        const lines: DeliveryLine[] = progress.items ?? [];
        const home = progress.home ?? null;
        const place = home ? PLACES[home] : undefined;
        // A shop SKU is never found on a walk, so the hint says where to buy it instead.
        const buyable = lines.some((l) => l.forceable === false);
        const many = lines.length > 1 || lines.some((l) => l.count > 1);
        return (
            <div className="playbook-progress">
                <div className="playbook-chips">
                    {lines.map((l) => (
                        <ItemChip
                            key={l.catalogKey}
                            name={l.name}
                            art={l.art}
                            count={`${Math.min(l.held, l.count)}/${l.count}`}
                            done={l.held >= l.count}
                        />
                    ))}
                </div>
                <p className={`playbook-hint${done ? ' is-ready' : ''}`}>
                    {done ? 'Ready! ' : buyable ? 'Buy what you need, then ' : `Find ${many ? 'them' : 'it'} on your walks, then `}
                    bring {many ? 'them' : 'it'} to {characterName}
                    {home && (
                        <>
                            {' at '}
                            {place ? <a href={place.href}>{place.label}</a> : placeLabel(home)}
                        </>
                    )}
                    .
                </p>
            </div>
        );
    }

    if (MOMENT_KINDS.has(kind)) {
        return (
            <p className={`playbook-tick${done ? ' is-done' : ''}`}>
                <span className="playbook-tick__mark" aria-hidden="true">{done ? '✓' : '○'}</span>
                {momentLabel(kind, done)}
            </p>
        );
    }

    const pct = progress.target > 0 ? Math.round((progress.done / progress.target) * 100) : 0;
    const places = objective?.kind === 'visit_places' ? objective.places : null;
    const unit = unitLabel(kind);
    return (
        <div className="playbook-progress">
            <div
                className="playbook-bar"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={progress.target}
                aria-valuenow={progress.done}
                aria-label={`${label ? `${label}: ` : ''}${progress.done} of ${progress.target} ${unit}`}
            >
                <span className="playbook-bar__fill" style={{ width: `${pct}%` }} />
            </div>
            <p className="playbook-hint">
                {label ? `${label} · ` : ''}{progress.done} / {progress.target} {unit}
                {places && (
                    <>
                        {' · '}
                        {places.map((p, i) => (
                            <React.Fragment key={p}>
                                {i > 0 && ', '}
                                {PLACES[p] ? <a href={PLACES[p].href}>{PLACES[p].label}</a> : placeLabel(p)}
                            </React.Fragment>
                        ))}
                    </>
                )}
            </p>
        </div>
    );
};

const Progress: React.FC<{ play: PlayView }> = ({ play }) => {
    const characterName = CHARACTERS[play.character]?.name.split(' ')[0] ?? 'them';

    // A compound beat is listed part by part. One total bar would say "7 of 43" across
    // items, wins and Ember at once, which tells the player nothing about what to do next.
    if (play.progress.parts && play.progress.parts.length > 0) {
        const parts = play.progress.parts;
        const objectiveParts = play.objective.kind === 'all_of' ? play.objective.parts : [];
        return (
            <div className="playbook-parts">
                {parts.map((part, i) => (
                    <Measure
                        key={`${part.kind}-${i}`}
                        kind={part.kind}
                        progress={part}
                        objective={objectiveParts[i]}
                        characterName={characterName}
                        label={MOMENT_KINDS.has(part.kind) || part.kind === 'deliver_items' ? undefined : part.label}
                    />
                ))}
            </div>
        );
    }

    return <Measure kind={play.kind} progress={play.progress} objective={play.objective} characterName={characterName} />;
};

const CurrentRow: React.FC<{ play: PlayView }> = ({ play }) => {
    const character = CHARACTERS[play.character];
    return (
        <li className="pet-inv-item playbook-row">
            <Portrait characterKey={play.character} />
            <div className="playbook-row__body">
                <span className="pet-inv-name">{play.title}</span>
                <span className="pet-inv-meta">
                    {character ? `For ${character.name}` : 'An errand'}
                    {play.startedAt ? ` · since ${dateLabel(play.startedAt)}` : ''}
                </span>
                <Progress play={play} />
            </div>
        </li>
    );
};

const CompletedRow: React.FC<{ play: PlayView }> = ({ play }) => {
    const [open, setOpen] = useState(false);
    const character = CHARACTERS[play.character];
    const receipt = play.receipt;
    const receiptId = `playbook-receipt-${play.id}`;
    return (
        <li className="pet-inv-item playbook-row is-complete">
            <button
                type="button"
                className="playbook-row__toggle"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                aria-controls={receiptId}
            >
                <Portrait characterKey={play.character} />
                <span className="playbook-row__body">
                    <span className="pet-inv-name">{play.title}</span>
                    <span className="pet-inv-meta">
                        {character ? `For ${character.name}` : 'An errand'} · done {dateLabel(play.completedAt)}
                    </span>
                </span>
                <span className="playbook-row__receipt-label">{open ? 'Hide' : 'Receipt'}</span>
            </button>
            {open && receipt && (
                <div className="playbook-receipt" id={receiptId}>
                    {receipt.gave.length > 0 && (
                        <div className="playbook-receipt__half">
                            <span className="playbook-receipt__heading">You gave</span>
                            <div className="playbook-chips">
                                {receipt.gave.map((g) => (
                                    <ItemChip key={g.catalogKey} name={g.name} art={g.art} count={`×${g.count}`} />
                                ))}
                            </div>
                        </div>
                    )}
                    <div className="playbook-receipt__half">
                        <span className="playbook-receipt__heading">You got</span>
                        {receipt.got
                            ? <GotChips got={receipt.got} />
                            : <p className="playbook-receipt__note">Your reward is on its way. {character ? character.name.split(' ')[0] : 'They'} will be by soon.</p>}
                    </div>
                    <span className="playbook-receipt__date">Completed {dateLabel(receipt.completedAt)}</span>
                </div>
            )}
        </li>
    );
};

export const PlaybookModal: React.FC<PlaybookModalProps> = ({ onClose }) => {
    const [data, setData] = useState<PlaysResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loggedOut, setLoggedOut] = useState(false);
    const [tab, setTab] = useState<Tab>('current');
    const closeRef = useRef<HTMLButtonElement>(null);

    const load = useCallback(async () => {
        setError(null);
        try {
            const res = await getPlays();
            if (res === null) {
                setLoggedOut(true);
                setData({ current: [], completed: [] });
            } else {
                setData(res);
            }
        } catch (e: any) {
            setError(e.message || 'Could not load your Playbook.');
            setData({ current: [], completed: [] });
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    // Same modal discipline as NotificationsModal: scroll lock, close-button focus,
    // Escape + X close only.
    useEffect(() => {
        const previous = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        closeRef.current?.focus();
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKey);
        return () => {
            document.body.style.overflow = previous;
            document.removeEventListener('keydown', onKey);
        };
    }, [onClose]);

    const current = data?.current ?? [];
    const completed = data?.completed ?? [];
    const list = tab === 'current' ? current : completed;

    return (
        <div className="tank-modal-overlay">
            <div
                className="tank-modal-panel playbook-panel"
                role="dialog"
                aria-modal="true"
                aria-label="My Playbook"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="tank-modal-header">
                    <span>My Playbook</span>
                    <button ref={closeRef} className="tank-modal-close" onClick={onClose} aria-label="Close">
                        &times;
                    </button>
                </div>
                <div className="tank-modal-body">
                    {data === null && <p className="playbook-loading">Loading…</p>}

                    {error && (
                        <>
                            <p className="hatchery-error" role="alert">{error}</p>
                            <button className="hatchery-buy" onClick={load}>Retry</button>
                        </>
                    )}

                    {loggedOut && !error && (
                        <div className="tank-modal-empty">
                            <p>Log in to see your Playbook.</p>
                            <a className="hatchery-buy" href="/login/">Log in</a>
                        </div>
                    )}

                    {data !== null && !error && !loggedOut && (
                        <>
                            <div className="tank-modal-filters" aria-label="Playbook sections">
                                {([
                                    ['current', `Current${current.length ? ` (${current.length})` : ''}`],
                                    ['completed', `Completed${completed.length ? ` (${completed.length})` : ''}`],
                                ] as [Tab, string][]).map(([t, label]) => (
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

                            {list.length === 0 ? (
                                <div className="tank-modal-empty">
                                    <p>
                                        {tab === 'current'
                                            ? 'No Plays right now. Keep exploring with your pet - someone will turn up with an errand.'
                                            : 'Nothing finished yet. Completed Plays and their receipts land here.'}
                                    </p>
                                </div>
                            ) : (
                                <ul className="pet-inv-list">
                                    {list.map((p) => (tab === 'current'
                                        ? <CurrentRow key={p.id} play={p} />
                                        : <CompletedRow key={p.id} play={p} />))}
                                </ul>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

export default PlaybookModal;
