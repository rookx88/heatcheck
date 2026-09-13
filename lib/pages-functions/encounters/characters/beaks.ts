// Beaks the Broker - the suited seahorse off the TANKDAQ floor, where he is also
// painted into the background art. Third rung of the ladder: he turns up once the
// Captain's EARNED column crosses a line, which is the first thing in this game that
// takes real repetition.
//
// Copy rule for every character: never name the threshold figure. It lives in
// game_config['encounters'] and is meant to be retuned, and a line that says "five
// hundred" becomes a lie the moment it is.

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
    voice: 'Dry, unhurried, everything is a market. Never exclaims. Calls the pet "the asset".',
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
                kind: 'start_quest',
                quest: { key: 'beaks_first_trade', objective: { kind: 'picks', count: 2 }, rewardEncounter: 'beaks_quest_done' },
            },
        ],
        dialogue: [
            { speaker: 'character', text: "Beaks. The Broker. I don't make house calls, so consider this a listing event." },
            { speaker: 'pet', mood: 'happy', text: 'A SEAHORSE. In a SUIT. Are you here to feed me?' },
            { speaker: 'character', text: "I'm here because your Captain's earned column crossed a line that shows up on my floor. Earned, not dug up. The ribeye is a signing bonus." },
            { speaker: 'pet', mood: 'happy', text: 'RIBEYE. I would like to be signed forever.' },
            { speaker: 'character', text: 'Terms: two calls on the Tanks. Real ones. Come back with a record and we can discuss liquidity.' },
        ],
        inboxLine: 'A seahorse in a suit came by. Beaks, he said. He left a ribeye and a job. I like him.',
    },
    {
        key: 'beaks_quest_done',
        character: 'beaks',
        once: true,
        trigger: [
            { kind: 'quest_completed', key: 'beaks_first_trade' },
            { kind: 'after_encounter', key: 'beaks_intro' },
        ],
        effects: [{ kind: 'grant_ember', ruleKey: 'encounter_gift' }],
        dialogue: [
            { speaker: 'character', text: 'Two calls on the books. Adequate. The floor calls that a track record. I call it Tuesday.' },
            { speaker: 'pet', mood: 'happy', text: 'We did the thing! Did we get the thing?' },
            { speaker: 'character', expression: 'happy', text: "Twenty-five Ember, out of my own pocket - so it doesn't count toward the Hall of Fame. Call it a dividend on showing up." },
            { speaker: 'pet', mood: 'happy', text: "A dividend! I'm going to eat it. Wait. Can I eat it?" },
        ],
        inboxLine: "Beaks came back and slipped 25 Ember into the stash. 'Dividend,' he said. I don't know what that is but I want more.",
    },
];
