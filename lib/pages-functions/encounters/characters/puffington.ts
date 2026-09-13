// Puffington - second rung. He is the only character who arrives because of how you
// treat the PET rather than how you play, which is why his trigger is feeds and his
// quest is a tour of both food counters. It doubles as the thing that teaches a new
// Captain that the Terrace and Quickboost exist.

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
    voice: 'Smug and unhurried. Treats eating as a competitive discipline. Respects a good feeder and says so like a verdict.',
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
                kind: 'start_quest',
                quest: {
                    key: 'puffington_tour',
                    objective: { kind: 'visit_places', places: ['champions-terrace', 'quickboost-delicacies'] },
                    rewardEncounter: 'puffington_quest_done',
                },
            },
        ],
        dialogue: [
            { speaker: 'character', text: "You feed that thing properly. I notice. It's mostly the only thing I notice." },
            { speaker: 'pet', mood: 'happy', text: "He's looking at my bowl." },
            { speaker: 'character', text: 'Puffington. I hold the Terrace record and I intend to die holding it. A well fed asset is a serious asset.' },
            { speaker: 'pet', mood: 'happy', text: 'I AM a serious asset.' },
            { speaker: 'character', text: "Worm delicacy. Don't thank me, thank the chef. Go and see both counters, the Terrace and Quickboost. Then we'll talk about a real meal." },
        ],
        inboxLine: 'A pufferfish in gym clothes inspected my bowl and approved. He left a worm delicacy. He wants us to go and see the food.',
    },
    {
        key: 'puffington_quest_done',
        character: 'puffington',
        once: true,
        trigger: [
            { kind: 'quest_completed', key: 'puffington_tour' },
            { kind: 'after_encounter', key: 'puffington_intro' },
        ],
        effects: [{ kind: 'grant_item', catalogKey: 'food_ribeye', itemType: 'food' }],
        dialogue: [
            { speaker: 'character', expression: 'happy', text: "Both counters. In one lifetime. You've seen more of the menu than most fish see of the ocean." },
            { speaker: 'pet', mood: 'happy', text: 'The Terrace smells like BUTTER.' },
            { speaker: 'character', expression: 'happy', text: 'Ribeye. The good one. Eat it slowly and think about me.' },
        ],
        inboxLine: 'Puffington gave us a RIBEYE for touring the food shops. He said to eat it slowly and think about him.',
    },
];
