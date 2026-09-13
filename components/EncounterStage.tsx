// The encounter stage: a character arrives bottom-LEFT, opposite the captain widget,
// and the two talk. Renders nothing until /api/toolbar-state hands it a pending
// encounter (lib/pages-functions/encounters/ - the server decided it fired and already
// granted whatever it grants; this is purely the scene).
//
// Staging: a scrim dims the page (z 1600 - above the widget's resting 1500, below the
// modals' 2000); the character sits in a portrait frame on the left with a
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
import { CHARACTERS } from '../lib/pages-functions/encounters';
import type { EncounterView } from '../lib/pages-functions/encounters/types';
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

    const close = useCallback(() => {
        if (!encounter) return;
        const id = encounter.id;
        seenIds.current.add(id);
        dispatchEncounterStep(null);
        playingRef.current = false;
        setPlaying(false);
        setEncounter(null);
        setStep(0);
        // Optimistic; idempotent server-side. The inbox line landed when the encounter
        // fired, so the badge owners refetch once the seen write has settled.
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

    return (
        <>
            <div className="encounter-scrim" onClick={advance} aria-hidden="true" />
            <div
                className={`encounter-stage encounter-stage--${variant}`}
                role="dialog"
                aria-label={`${encounter.character.name} is talking to ${petName}`}
            >
                {characterTurn && current && (
                    <div className="encounter-stage__bubble" onClick={advance}>
                        <span className="pet-widget__bubble-text" aria-live="polite">
                            {fillPetName(current.text, petName)}
                        </span>
                    </div>
                )}
                <div className="encounter-stage__frame" onClick={advance}>
                    {character ? (
                        <img className="encounter-stage__portrait" src={character.portrait.src} alt={character.portrait.alt} />
                    ) : (
                        <div className="encounter-stage__portrait encounter-stage__portrait--missing" aria-hidden="true" />
                    )}
                </div>
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
