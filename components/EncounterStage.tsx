// The encounter stage: a character arrives bottom-LEFT, opposite the captain widget,
// and the two talk. Renders nothing until /api/toolbar-state hands it a pending
// encounter (lib/pages-functions/encounters/ - the server decided it fired and already
// granted whatever it grants; this is purely the scene).
//
// Staging: a scrim dims the page (z 1600 - above the widget's resting 1500, below the
// modals' 2000); the character stands on the left as a transparent full-body sprite
// (same treatment as the pet - drop shadow, ground ellipse, no frame) with a
// left-tailed bubble for HIS lines; the PET's lines go out over ENCOUNTER_STEP_EVENT
// and the PetWidget speaks them in its own bubble with its own face (and lifts itself
// above the scrim while it does - PetWidget.css .is-scripted). Tap anywhere (scrim,
// frame, either bubble) or the Next chip to advance; the last step, or Escape at any
// point, closes the scene and POSTs seen - closing by any means counts as watched, an
// abandoned tab simply replays next load.
//
// Mounted as a sibling of <PetWidget/> at every mount point, OUTSIDE transformed
// frames (same containing-block reasoning as the widget). Hydrates through the same
// getToolbarState() call the widget makes - the in-flight dedupe collapses them.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getToolbarState } from '../toolbar-state-client';
import { PET_UPDATED_EVENT } from './PetNameForm';
import { NOTIFICATIONS_UPDATED_EVENT, dispatchNotificationsUpdated } from '../notifications-client';
import { ENCOUNTER_ADVANCE_EVENT, dispatchEncounterStep, markEncounterSeen } from '../encounters-client';
import { CHARACTERS, portraitSrc } from '../lib/pages-functions/encounters';
import type { EncounterView, Expression } from '../lib/pages-functions/encounters/types';
// The canonical Ember glyph, already shared with the Hall of Fame - this is the third
// consumer, not a third copy.
import { EmberIcon } from './MapHud';
import { petDisplayName } from './petRender';
// The character bubble reuses the widget's manga bubble text rule (and its font warm).
import './PetWidget.css';
import './EncounterStage.css';

interface EncounterStageProps {
    // Mirrors PetWidget's docking: 'card' hugs the map card's bottom-left corner,
    // 'fixed' is viewport-fixed for scrolling pages.
    variant?: 'card' | 'fixed';
}

// Copy may address the pet by name: "{{pet}}".
function fillPetName(text: string, petName: string): string {
    return text.replace(/\{\{pet\}\}/g, petName);
}

export const EncounterStage: React.FC<EncounterStageProps> = ({ variant = 'card' }) => {
    const [encounter, setEncounter] = useState<EncounterView | null>(null);
    const [petName, setPetName] = useState('your pet');
    const [playing, setPlaying] = useState(false);
    const [step, setStep] = useState(0);
    const playingRef = useRef(false);
    // Encounters this tab already finished - a hydrate racing the seen POST must not
    // replay them.
    const seenIds = useRef(new Set<string>());
    const nextRef = useRef<HTMLButtonElement>(null);
    const restoreFocus = useRef<Element | null>(null);

    const hydrate = useCallback(async () => {
        if (playingRef.current) return;
        try {
            const state = await getToolbarState();
            const next = state?.encounter ?? null;
            setEncounter(next && !seenIds.current.has(next.id) ? next : null);
            if (state?.pet) setPetName(petDisplayName(state.pet.name, state.pet.color));
        } catch {
            // Decorative chrome - never surface load errors.
        }
    }, []);

    useEffect(() => { hydrate(); }, [hydrate]);

    useEffect(() => {
        const onPageShow = (e: PageTransitionEvent) => { if (e.persisted) hydrate(); };
        window.addEventListener('pageshow', onPageShow);
        return () => window.removeEventListener('pageshow', onPageShow);
    }, [hydrate]);

    useEffect(() => {
        const onUpdated = () => hydrate();
        window.addEventListener(PET_UPDATED_EVENT, onUpdated);
        window.addEventListener(NOTIFICATIONS_UPDATED_EVENT, onUpdated);
        return () => {
            window.removeEventListener(PET_UPDATED_EVENT, onUpdated);
            window.removeEventListener(NOTIFICATIONS_UPDATED_EVENT, onUpdated);
        };
    }, [hydrate]);

    // Open a beat after the encounter arrives so the page has painted under it.
    useEffect(() => {
        if (!encounter || playingRef.current) return;
        const t = window.setTimeout(() => {
            playingRef.current = true;
            restoreFocus.current = document.activeElement;
            setStep(0);
            setPlaying(true);
        }, 600);
        return () => window.clearTimeout(t);
    }, [encounter]);

    // Broadcast the current step: the pet's lines go to the widget, the character's
    // clear it.
    useEffect(() => {
        if (!playing || !encounter) return;
        const s = encounter.dialogue[step];
        dispatchEncounterStep(
            s && s.speaker === 'pet' ? { text: fillPetName(s.text, petName), mood: s.mood ?? null } : null,
        );
    }, [playing, encounter, step, petName]);

    useEffect(() => {
        if (playing) nextRef.current?.focus();
    }, [playing, step]);

    // Warm every face this scene will show, so a mid-scene expression change swaps
    // instantly instead of blanking while the webp lands (the PetWidget mood-sprite
    // idiom). ~25KB each and at most three per character.
    useEffect(() => {
        if (!playing || !encounter) return;
        // The reward art too, and BEFORE the character guard: it pops mid-scene, and a
        // file landing a beat later would pop an empty box.
        const art = encounter.grants?.item?.art;
        if (art) {
            const reward = new Image();
            reward.src = `/assets/images/${art}`;
        }
        const character = CHARACTERS[encounter.character.key];
        if (!character) return;
        for (const s of encounter.dialogue) {
            if (s.speaker !== 'character') continue;
            const img = new Image();
            img.src = portraitSrc(character, s.expression ?? 'main');
        }
    }, [playing, encounter]);

    const close = useCallback(() => {
        if (!encounter) return;
        const id = encounter.id;
        seenIds.current.add(id);
        dispatchEncounterStep(null);
        playingRef.current = false;
        setPlaying(false);
        setEncounter(null);
        setStep(0);
        // Optimistic; idempotent server-side. The dispatch below is NOT about a badge:
        // an encounter writes no inbox row any more (the reveal on stage is the whole
        // acknowledgement). It is how this component re-hydrates - the stage listens
        // for NOTIFICATIONS_UPDATED_EVENT - so it is what plays the NEXT queued
        // encounter and pulls the widget's new Ember total in. Do not remove it.
        markEncounterSeen(id)
            .catch(() => { /* next toolbar read reconciles */ })
            .finally(() => dispatchNotificationsUpdated());
        const el = restoreFocus.current as HTMLElement | null;
        if (el && typeof el.focus === 'function') el.focus();
    }, [encounter]);

    const advance = useCallback(() => {
        if (!playing || !encounter) return;
        if (step + 1 >= encounter.dialogue.length) close();
        else setStep(step + 1);
    }, [playing, encounter, step, close]);

    useEffect(() => {
        if (!playing) return;
        const onAdvance = () => advance();
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') close();
        };
        window.addEventListener(ENCOUNTER_ADVANCE_EVENT, onAdvance);
        document.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener(ENCOUNTER_ADVANCE_EVENT, onAdvance);
            document.removeEventListener('keydown', onKey);
        };
    }, [playing, advance, close]);

    if (!playing || !encounter) return null;

    const character = CHARACTERS[encounter.character.key];
    const current = encounter.dialogue[step];
    const characterTurn = current?.speaker === 'character';
    const isLast = step + 1 >= encounter.dialogue.length;

    // He keeps the face from his most recent line while the pet answers, rather than
    // snapping back to neutral every other step.
    let expression: Expression = 'main';
    for (let i = step; i >= 0; i--) {
        const s = encounter.dialogue[i];
        if (s.speaker === 'character') {
            expression = s.expression ?? 'main';
            break;
        }
    }

    // The reward shows up on the line that hands it over (the marked step) and stays
    // for the rest of the scene. No marker anywhere falls back to the last line.
    const rewardItem = encounter.grants?.item ?? null;
    const rewardEmber = encounter.grants?.ember?.amount ?? 0;
    const hasReward = Boolean(rewardItem) || rewardEmber > 0;
    const markedStep = encounter.dialogue.findIndex((s) => s.reveal);
    const revealed = step >= (markedStep >= 0 ? markedStep : encounter.dialogue.length - 1);

    return (
        <>
            <div className="encounter-scrim" onClick={advance} aria-hidden="true" />
            <div
                className={`encounter-stage encounter-stage--${variant}`}
                role="dialog"
                aria-label={`${encounter.character.name} is talking to ${petName}`}
            >
                <div className="encounter-stage__row">
                    {characterTurn && current && (
                        <div className="encounter-stage__bubble" onClick={advance}>
                            <span className="pet-widget__bubble-text" aria-live="polite">
                                {fillPetName(current.text, petName)}
                            </span>
                        </div>
                    )}
                    <div className="encounter-stage__sprite" onClick={advance}>
                        {character ? (
                            <img className="encounter-stage__portrait" src={portraitSrc(character, expression)} alt={character.alt} />
                        ) : (
                            <div className="encounter-stage__portrait encounter-stage__portrait--missing" aria-hidden="true" />
                        )}
                    </div>
                </div>
                {hasReward && (
                    // Rendered for the WHOLE scene and toggled by visibility, never
                    // mounted mid-scene: .encounter-stage is pinned to the bottom, so
                    // inserting a row here would shove the sprite and its speech
                    // bubble upward by this element's height in a single frame.
                    <div className={`encounter-stage__reward${revealed ? ' is-revealed' : ''}`}>
                        {rewardItem && (
                            <div className="encounter-stage__reward-chip">
                                {rewardItem.art ? (
                                    <img
                                        className="encounter-stage__reward-art"
                                        src={`/assets/images/${rewardItem.art}`}
                                        alt=""
                                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                                    />
                                ) : (
                                    // Eggs have no artwork at all, so the slot gets the
                                    // inventory list's silhouette rather than a broken img.
                                    <span
                                        className={`encounter-stage__reward-art encounter-stage__reward-art--blank${rewardItem.itemType === 'egg' ? ' encounter-stage__reward-art--egg' : ''}`}
                                        aria-hidden="true"
                                    />
                                )}
                                <span className="encounter-stage__reward-name">{rewardItem.name || 'A gift'}</span>
                            </div>
                        )}
                        {rewardEmber > 0 && (
                            <div className="encounter-stage__reward-chip encounter-stage__reward-chip--ember">
                                <EmberIcon />
                                <span className="encounter-stage__reward-name">+{rewardEmber} Ember</span>
                            </div>
                        )}
                    </div>
                )}
                <div className="encounter-stage__plate">
                    <span className="encounter-stage__name">{encounter.character.name}</span>
                    <span className="encounter-stage__title">{encounter.character.title}</span>
                </div>
                <button ref={nextRef} type="button" className="encounter-stage__next" onClick={advance}>
                    {isLast ? 'Done' : 'Next'}
                </button>
            </div>
        </>
    );
};

export default EncounterStage;
