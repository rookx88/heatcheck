// NPC encounters - the vocabulary. Dependency-free on purpose: this file (and the
// character files that use it) is imported by the Worker (evaluation), the client
// bundle (the stage reads portraits and dialogue), and the static build. Nothing in
// here may import a server module.
//
// The plug-and-play contract: a CHARACTER is who shows up; an ENCOUNTER is one
// scripted visit - when it fires (every Trigger must hold), what it does (Effects,
// applied at creation), and what is said (Dialogue, both speakers). Adding a
// character is a new file under characters/ plus one line in index.ts. Adding a new
// KIND of trigger, effect, or objective is one case in evaluate.ts (server) and, for
// effects, one leg in the fire statement - the types here are the single source of
// which kinds exist.

export type Mood = 'happy' | 'sad';

export interface Character {
    key: string;
    name: string;
    title: string;
    // src MUST be a literal '/assets/images/...' string wherever it is defined: the
    // static build scans shipped bundles for those literals to prove the art was
    // copied (scripts/generate-static-site.ts verifyReferencedImages).
    portrait: { src: string; alt: string; framed: true };
    // Tone notes for whoever writes this character's next lines. Docs, not data.
    voice?: string;
}

// Every trigger on an encounter must hold (ALL-OF). Facts come from one statement in
// the toolbar-state batch (see evaluate.ts Facts).
export type Trigger =
    // Amount lives in game_config['encounters'][configKey] so it is retunable.
    | { kind: 'lifetime_earned_at_least'; configKey: string }
    | { kind: 'collectibles_at_least'; count: number }
    | { kind: 'picks_at_least'; count: number }
    | { kind: 'feeds_at_least'; count: number }
    // The page the toolbar call came from (discovery.ts placeFromPath keys). Exact
    // match, or a prefix: 'tankdaq' matches 'tankdaq:chalk'.
    | { kind: 'at_place'; place: string }
    // That encounter has been watched to the end (status 'seen').
    | { kind: 'after_encounter'; key: string }
    | { kind: 'quest_completed'; key: string };

// Quest objectives count FROM the moment the quest started (baseline snapshot).
export type Objective =
    | { kind: 'feeds'; count: number }
    | { kind: 'picks'; count: number }
    | { kind: 'visit_places'; places: string[] }
    | { kind: 'earn_ember'; amount: number };

export type Effect =
    | { kind: 'grant_item'; catalogKey: string; itemType: 'egg' | 'food' | 'collectible' }
    // ruleKey is an ember_rules source whose config.amount is the gift.
    | { kind: 'grant_ember'; ruleKey: string }
    | { kind: 'start_quest'; quest: { key: string; objective: Objective; rewardEncounter: string } };

export interface DialogueStep {
    speaker: 'character' | 'pet';
    text: string;
    // Pet steps: the face the pet pulls (PetPortrait mood). Character steps: reserved
    // for portrait variants.
    mood?: Mood;
}

export interface Encounter {
    key: string;
    character: string;
    trigger: Trigger[];
    effects: Effect[];
    dialogue: DialogueStep[];
    // The inbox row, in the PET's voice (the widget bubble speaks it later).
    inboxLine: string;
    once: true;
}

// What an encounter actually handed over (encounters.grants).
export interface EncounterGrants {
    item?: { catalogKey: string; itemType: string };
    ember?: { amount: number };
}

// Wire shape: toolbar-state.encounter. The portrait is resolved client-side from
// CHARACTERS[character.key] so the asset literal lives in the bundle.
export interface EncounterView {
    id: string;
    key: string;
    character: { key: string; name: string; title: string };
    dialogue: DialogueStep[];
    grants: EncounterGrants;
}
