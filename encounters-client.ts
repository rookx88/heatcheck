// Client for NPC encounters (functions/api/encounters/*, lib/pages-functions/
// encounters/). Same-origin cookie-authed, same split as notifications-client.ts.
//
// The stage (components/EncounterStage.tsx, bottom-left) and the pet widget
// (components/PetWidget.tsx, bottom-right) are siblings at every mount point with no
// shared parent state, so they talk through window events - the PET_UPDATED_EVENT /
// NOTIFICATIONS_UPDATED_EVENT idiom:
//   ENCOUNTER_STEP_EVENT    stage -> widget: "the pet is saying this now" ({text, mood})
//                           or null when the character has the line / the scene ended.
//                           The widget shows it in its own bubble with its own face.
//   ENCOUNTER_ADVANCE_EVENT widget -> stage: the pet's bubble was tapped, move on.

import type { Mood } from './lib/pages-functions/encounters/types';

export const ENCOUNTER_STEP_EVENT = 'hc:encounter-step';
export const ENCOUNTER_ADVANCE_EVENT = 'hc:encounter-advance';

export interface EncounterStepDetail {
    text: string;
    mood: Mood | null;
}

export function dispatchEncounterStep(detail: EncounterStepDetail | null): void {
    window.dispatchEvent(new CustomEvent<EncounterStepDetail | null>(ENCOUNTER_STEP_EVENT, { detail }));
}

export function dispatchEncounterAdvance(): void {
    window.dispatchEvent(new CustomEvent(ENCOUNTER_ADVANCE_EVENT));
}

async function parseJsonSafe(res: Response): Promise<any> {
    try {
        return await res.json();
    } catch {
        return {};
    }
}

// Flips the encounter to 'seen' (idempotent server-side). false when the row no longer
// exists (tolerated - the next toolbar-state read reconciles).
export async function markEncounterSeen(id: string): Promise<boolean> {
    const res = await fetch('/api/encounters/seen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
    });
    if (res.status === 404) return false;
    const data = await parseJsonSafe(res);
    if (!res.ok) throw new Error(data.message || `POST /api/encounters/seen failed: ${res.status}`);
    return true;
}
