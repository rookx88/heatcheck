// Blobby - first rung of the ladder, and the first face a new Captain ever sees. He
// turns up on the very first pick, which is the point: nobody comes down for a first
// call, and that is exactly why he does.
//
// His art has no sad face (main is already anxious) and his payoff is the only
// 'ecstatic' portrait in the cast, so his arc runs worried -> hopeful -> unhinged.

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
    voice: 'Earnest and anxious. Apologises for existing. Over-invested in you specifically. Short bursts, then a rush.',
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
            { speaker: 'character', text: 'Oh. Hi. Hello. Sorry. I saw your call come through on the board and I, um. I came down.' },
            { speaker: 'pet', mood: 'happy', text: 'Someone came DOWN? For us?' },
            { speaker: 'character', text: "I'm Blobby. Junior analyst. Nobody comes down for a first call. That's the thing. That's why I did." },
            { speaker: 'pet', mood: 'happy', text: 'I like him. Can we keep him.' },
            { speaker: 'character', expression: 'happy', text: "I brought a parfait. It's from the machine on four, it isn't much. Make three more calls. I want to see what you do." },
        ],
        inboxLine: 'A very nervous blob in a suit came down to see us. He left a parfait and he BELIEVES IN US.',
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
            { speaker: 'character', expression: 'ecstatic', text: 'FOUR CALLS. Four. I told the whole floor. I told people who did not ask.' },
            { speaker: 'pet', mood: 'happy', text: "He's doing the fists thing." },
            { speaker: 'character', expression: 'ecstatic', text: "Twenty-five Ember. Mine, out of my own pocket, don't tell payroll. I wanted to be early on you." },
            { speaker: 'pet', mood: 'happy', text: "Early on us. We're a THING to be early on." },
        ],
        inboxLine: 'Blobby came back and he was SO LOUD. He gave us 25 Ember out of his own pocket. He says he was early on us.',
    },
];
