// The encounter registry. Bundle-safe (types + character files only - no server
// imports), so the client stage and the Worker read the same definitions.
//
// To add a character: create characters/<key>.ts exporting a Character and its
// Encounter[] (copy beaks.ts), then list both below. ENCOUNTERS order is fire
// priority: when several encounters become fireable on the same page load, the first
// one listed fires and the rest wait for a later load (evaluate.ts fires at most one
// per request so two characters never pile up on one screen).

import type { Character, Encounter } from './types';
import { BEAKS, BEAKS_ENCOUNTERS } from './characters/beaks';

export type { Character, Encounter, EncounterView, EncounterGrants, DialogueStep, Trigger, Effect, Objective, Mood } from './types';

const CHARACTER_LIST: Character[] = [BEAKS];

export const ENCOUNTERS: Encounter[] = [...BEAKS_ENCOUNTERS];

export const CHARACTERS: Record<string, Character> = Object.fromEntries(CHARACTER_LIST.map((c) => [c.key, c]));

export const ENCOUNTER_BY_KEY: Record<string, Encounter> = Object.fromEntries(ENCOUNTERS.map((e) => [e.key, e]));

export function getEncountersForCharacter(characterKey: string): Encounter[] {
    return ENCOUNTERS.filter((e) => e.character === characterKey);
}
