// Beaks the Broker - the suited seahorse off the TANKDAQ floor, where he is also
// painted into the background art. Third rung of the ladder: he turns up once the
// pet's EARNED column crosses a line, which is the first thing in this game that
// takes real repetition.
//
// House rules for every character's copy:
//   - Talk like a person. No aphorisms, no metaphors carrying the plot. Characters
//     differ by what they CARE about, not by how ornately they speak.
//   - Speak TO THE PET. It is the one on stage and the one who did the work, so it is
//     "you", never "your Captain". The Captain is not a character in the scene.
//   - Never name a threshold figure. They live in game_config and are meant to be
//     retuned; a line that quotes one becomes a lie the moment it is.
//   - Mark the line that actually hands something over with `reveal: true` - that is
//     when the item art or the Ember pill appears on stage, and it stays up after.

import type { Character, Encounter } from '../types';

export const BEAKS: Character = {
    key: 'beaks',
    name: 'Beaks',
    title: 'The Broker',
    portraits: {
        main: '/assets/images/characters/beaks_main.webp',
        happy: '/assets/images/characters/beaks_happy.webp',
        sad: '/assets/images/characters/beaks_sad.webp',
    },
    alt: 'Beaks the Broker, a seahorse in a black three-piece suit leaning on a cane',
    voice: 'Friendly and straightforward. Works the trading floor and says so plainly. Interested in how the pet is doing, not in sounding clever.',
    home: 'tankdaq',
};

export const BEAKS_ENCOUNTERS: Encounter[] = [
    {
        key: 'beaks_intro',
        character: 'beaks',
        once: true,
        trigger: [{ kind: 'lifetime_earned_at_least', configKey: 'beaks_intro_ember' }],
        effects: [
            { kind: 'grant_item', catalogKey: 'food_ribeye', itemType: 'food' },
            {
                kind: 'start_play',
                play: { key: 'beaks_first_trade', title: 'Keep making calls', objective: { kind: 'picks', count: 2 }, rewardEncounter: 'beaks_quest_done' },
            },
        ],
        dialogue: [
            { speaker: 'character', text: "Hey. I'm Beaks. I work the trading floor over at TANKDAQ." },
            { speaker: 'pet', mood: 'happy', text: "You're a seahorse. In a suit. Why are you here?" },
            { speaker: 'character', text: "Because I've seen you've been making some strides in your ember investments." },
            { speaker: 'pet', mood: 'happy', text: 'We have! We work very hard.' },
            { speaker: 'character', reveal: true, text: "I'm quite impressed. Here, take this steak. Look, keep making those calls and I'll be back with something better." },
        ],
    },
    {
        key: 'beaks_quest_done',
        character: 'beaks',
        once: true,
        trigger: [
            { kind: 'play_completed', key: 'beaks_first_trade' },
            { kind: 'after_encounter', key: 'beaks_intro' },
        ],
        effects: [{ kind: 'grant_ember', ruleKey: 'encounter_gift' }],
        dialogue: [
            { speaker: 'character', text: "Two calls, both on the record. That's a start." },
            { speaker: 'pet', mood: 'happy', text: 'We did the thing! Did we get the thing?' },
            { speaker: 'character', expression: 'happy', reveal: true, text: "Twenty-five Ember. It's out of my own pocket, so it won't count toward the Hall of Fame. Spend it how you like." },
            { speaker: 'pet', mood: 'happy', text: "I'm going to eat it. Can I eat it?" },
        ],
    },
];
