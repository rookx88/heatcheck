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

// The PET's face while it speaks a line. Deliberately NOT the same type as a
// character's Expression: this one also names the pet's mood sprites
// (components/petRender.ts PET_MOOD_IMAGE_SRC) and shares its vocabulary with
// notifications.mood, whose CHECK constraint allows only these two values. Widening
// it would break both.
export type Mood = 'happy' | 'sad';

// A CHARACTER's face. Client-side only - it never reaches the database. Sets are
// ragged on purpose (Blobby has no sad, Charles no happy, Vic only main), so always
// resolve through portraitSrc(), which falls back to main.
export type Expression = 'main' | 'happy' | 'sad' | 'ecstatic';

export type CharacterPortraits = { main: string } & Partial<Record<Exclude<Expression, 'main'>, string>>;

export interface Character {
    key: string;
    name: string;
    title: string;
    // EVERY value MUST be a literal '/assets/images/...' string: the static build
    // scans shipped bundles for those literals to prove the art was copied
    // (scripts/generate-static-site.ts verifyReferencedImages), and each one must
    // also be listed in NEW_SITE_IMAGES. Built by scripts/make-character-art.ts.
    portraits: CharacterPortraits;
    // One description of who this is; the expression doesn't change it.
    alt: string;
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
    // PET steps only: the face the pet pulls (PetPortrait mood).
    mood?: Mood;
    // CHARACTER steps only: which portrait to show. Absent means 'main'. The stage
    // holds the last character expression across the pet's turns, so a face set here
    // stays up until the character says something else.
    expression?: Expression;
    // The step at which this encounter's grants appear on stage - mark the line that
    // actually hands the thing over. At most one per encounter; none anywhere means
    // the last step. The reveal is `step >= revealAt`, so once it is out it STAYS out
    // for the rest of the scene instead of blinking away on the next line.
    reveal?: true;
}

export interface Encounter {
    key: string;
    character: string;
    trigger: Trigger[];
    effects: Effect[];
    dialogue: DialogueStep[];
    once: true;
}

// What an encounter actually handed over (encounters.grants), and everything the
// stage needs to SHOW it. `name` and `art` are resolved from items_catalog by the
// fire statement, because no endpoint exposes an UNOWNED catalog row - the payload is
// the only way the client can learn them. `art` follows the notifications.art
// contract (add_art_to_notifications.sql): a subpath under /assets/images/, or null
// when the type has no artwork at all (eggs are drawn procedurally, never from a file).
export interface EncounterGrants {
    item?: { catalogKey: string; itemType: string; name: string; art: string | null };
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
