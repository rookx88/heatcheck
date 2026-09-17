// Puffington - second rung. He is the only character who arrives because of how the
// pet is looked after rather than how it plays, which is why his trigger is feeds and
// his Play is a tour of both food counters. It doubles as the thing that teaches a
// new player that the Terrace and Quickboost exist.
//
// See characters/beaks.ts for the house rules the copy follows.

import type { Character, Encounter } from '../types';

export const PUFFINGTON: Character = {
    key: 'puffington',
    name: 'Puffington',
    title: 'Terrace Regular',
    portraits: {
        main: '/assets/images/characters/puffington_main.webp',
        happy: '/assets/images/characters/puffington_happy.webp',
        sad: '/assets/images/characters/puffington_sad.webp',
    },
    alt: 'Puffington, a large pufferfish in a white sports shirt and navy shorts',
    voice: 'Blunt and comfortable. Cares about food above everything and assumes everyone else does too.',
    home: 'champions-terrace',
};

export const PUFFINGTON_ENCOUNTERS: Encounter[] = [
    {
        key: 'puffington_intro',
        character: 'puffington',
        once: true,
        trigger: [{ kind: 'feeds_at_least', count: 3 }],
        effects: [
            { kind: 'grant_item', catalogKey: 'food_worm_delicacy', itemType: 'food' },
            {
                kind: 'start_play',
                play: {
                    key: 'puffington_tour',
                    title: 'Try both food counters',
                    objective: { kind: 'visit_places', places: ['champions-terrace', 'quickboost-delicacies'] },
                    rewardEncounter: 'puffington_quest_done',
                },
            },
        ],
        dialogue: [
            { speaker: 'character', text: "I'm Puffington. You eat well. I can always tell just by looking." },
            { speaker: 'pet', mood: 'happy', text: "He's looking at my bowl." },
            { speaker: 'character', text: 'I eat at the Terrace most days. I hold the record there.' },
            { speaker: 'pet', mood: 'happy', text: 'What record?' },
            { speaker: 'character', reveal: true, text: 'Most plates in one sitting. Here, take a worm delicacy. Check out a couple of the restaurants around Tank HQ. They got some goodies.' },
        ],
    },
    {
        key: 'puffington_quest_done',
        character: 'puffington',
        once: true,
        trigger: [
            { kind: 'play_completed', key: 'puffington_tour' },
            { kind: 'after_encounter', key: 'puffington_intro' },
        ],
        effects: [{ kind: 'grant_item', catalogKey: 'food_ribeye', itemType: 'food' }],
        dialogue: [
            { speaker: 'character', expression: 'happy', text: 'Both counters. Good. Most people only ever try the one nearest them.' },
            { speaker: 'pet', mood: 'happy', text: 'The Terrace smells like butter.' },
            { speaker: 'character', expression: 'happy', reveal: true, text: "It does. Here's a ribeye, the good one. Eat it slowly." },
        ],
    },
];
