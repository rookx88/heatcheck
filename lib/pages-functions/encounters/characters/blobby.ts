// Blobby - first rung of the ladder, and the first face a new pet ever sees. He turns
// up on the very first pick, which is the point: nobody comes down for a first call,
// and that is exactly why he does.
//
// His art has no sad face (main is already anxious) and his payoff is the only
// 'ecstatic' portrait in the cast, so his arc runs worried -> hopeful -> unhinged.
// See characters/beaks.ts for the house rules the copy follows.

import type { Character, Encounter } from '../types';

export const BLOBBY: Character = {
    key: 'blobby',
    name: 'Blobby',
    title: 'Junior Analyst',
    portraits: {
        main: '/assets/images/characters/blobby_main.webp',
        happy: '/assets/images/characters/blobby_happy.webp',
        ecstatic: '/assets/images/characters/blobby_ecstatic.webp',
    },
    alt: 'Blobby, a pale round creature in a navy suit and blue tie with a smiley-face pin',
    voice: 'Nervous, warm and over-invested. Apologises first, then gets carried away. Short sentences.',
};

export const BLOBBY_ENCOUNTERS: Encounter[] = [
    {
        key: 'blobby_intro',
        character: 'blobby',
        once: true,
        trigger: [{ kind: 'picks_at_least', count: 1 }],
        effects: [
            { kind: 'grant_item', catalogKey: 'food_yogurt_parfait', itemType: 'food' },
            {
                kind: 'start_quest',
                quest: { key: 'blobby_first_calls', objective: { kind: 'picks', count: 3 }, rewardEncounter: 'blobby_quest_done' },
            },
        ],
        dialogue: [
            { speaker: 'character', text: 'Hi. Sorry. I saw your first call come up on the board and I came down to say well done.' },
            { speaker: 'pet', mood: 'happy', text: 'Someone came down? For us?' },
            { speaker: 'character', text: "Nobody usually does for a first one. I'm Blobby, I'm a junior analyst upstairs." },
            { speaker: 'pet', mood: 'happy', text: 'I like him. Can we keep him?' },
            { speaker: 'character', expression: 'happy', reveal: true, text: "I brought you a parfait. It's only from the machine, but here. Make three more calls and come find me." },
        ],
    },
    {
        key: 'blobby_quest_done',
        character: 'blobby',
        once: true,
        trigger: [
            { kind: 'quest_completed', key: 'blobby_first_calls' },
            { kind: 'after_encounter', key: 'blobby_intro' },
        ],
        effects: [{ kind: 'grant_ember', ruleKey: 'encounter_gift' }],
        dialogue: [
            { speaker: 'character', expression: 'ecstatic', text: "Four calls! I told everyone upstairs. I told people who weren't listening." },
            { speaker: 'pet', mood: 'happy', text: "He's doing the fists thing." },
            { speaker: 'character', expression: 'ecstatic', reveal: true, text: "Twenty-five Ember, from me. Don't tell anyone. I just wanted to be the first one to back you." },
            { speaker: 'pet', mood: 'happy', text: 'The first one to back us.' },
        ],
    },
];
