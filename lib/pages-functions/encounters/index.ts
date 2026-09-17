// The encounter registry. Bundle-safe (types + character files only - no server
// imports), so the client stage and the Worker read the same definitions.
//
// To add a character: create characters/<key>.ts exporting a Character and its
// Encounter[] (copy any existing one), then list both below. ENCOUNTERS order is fire
// priority: when several encounters become fireable on the same page load, the first
// one listed fires and the rest wait for a later load (evaluate.ts fires at most one
// per request so two characters never pile up on one screen). They are listed in
// LADDER order - earliest character first - so a player who arrives already qualified
// meets them in the intended sequence, one per page load.

import type { Character, Encounter, Expression, PlayDefinition } from './types';
import { BEAKS, BEAKS_ENCOUNTERS } from './characters/beaks';
import { BLOBBY, BLOBBY_ENCOUNTERS } from './characters/blobby';
import { PUFFINGTON, PUFFINGTON_ENCOUNTERS } from './characters/puffington';
import { CHARLES, CHARLES_ENCOUNTERS } from './characters/charles';
import { VIC, VIC_ENCOUNTERS } from './characters/vic';

export type {
    Character, CharacterPortraits, Encounter, EncounterView, EncounterGrants,
    DialogueStep, Trigger, Effect, Objective, Mood, Expression, PlayDefinition, DeliverItem,
} from './types';

const CHARACTER_LIST: Character[] = [BLOBBY, PUFFINGTON, BEAKS, CHARLES, VIC];

export const ENCOUNTERS: Encounter[] = [
    ...BLOBBY_ENCOUNTERS,
    ...PUFFINGTON_ENCOUNTERS,
    ...BEAKS_ENCOUNTERS,
    ...CHARLES_ENCOUNTERS,
    ...VIC_ENCOUNTERS,
];

export const CHARACTERS: Record<string, Character> = Object.fromEntries(CHARACTER_LIST.map((c) => [c.key, c]));

export const ENCOUNTER_BY_KEY: Record<string, Encounter> = Object.fromEntries(ENCOUNTERS.map((e) => [e.key, e]));

// Every Play the registry can start, keyed by Play key, with the character who owns it.
// The stored objective is the source of truth for a Play in progress; this is only the
// fallback for rows written before titles were frozen into them.
export const PLAY_BY_KEY: Record<string, PlayDefinition & { character: string }> = Object.fromEntries(
    ENCOUNTERS.flatMap((e) =>
        e.effects.flatMap((f) => (f.kind === 'start_play' ? [[f.play.key, { ...f.play, character: e.character }]] : [])),
    ),
);

// The one place expression fallback happens. Sets are ragged (Blobby has no sad,
// Charles no happy, Vic only main), so asking for a face a character doesn't own
// must never yield undefined and a broken <img>.
export function portraitSrc(character: Character, expression: Expression = 'main'): string {
    return character.portraits[expression] ?? character.portraits.main;
}

export function getEncountersForCharacter(characterKey: string): Encounter[] {
    return ENCOUNTERS.filter((e) => e.character === characterKey);
}
