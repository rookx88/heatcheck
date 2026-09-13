// Beaks the Broker - the suited seahorse from the TANKDAQ floor (he is painted into
// assets/images/tankdaq-bg.webp; the portrait is cropped from that scene by
// scripts/make-character-art.ts). First character in the registry, and the template
// for the next one: a Character, then its Encounters in the order they should be able
// to fire.

import type { Character, Encounter } from '../types';

export const BEAKS: Character = {
    key: 'beaks',
    name: 'Beaks',
    title: 'The Broker',
    portrait: {
        src: '/assets/images/characters/beaks.webp',
        alt: 'Beaks the Broker, a seahorse in a pinstripe suit leaning on a cane',
        framed: true,
    },
    voice: 'Dry, unhurried, everything is a market. Never exclaims. Calls the pet "the asset".',
};

export const BEAKS_ENCOUNTERS: Encounter[] = [
    {
        key: 'beaks_intro',
        character: 'beaks',
        once: true,
        // Fires anywhere on the site once the Captain has EARNED the threshold
        // (game_config['encounters'].beaks_intro_ember). To make him wait for a TANKDAQ
        // visit instead, add: { kind: 'at_place', place: 'tankdaq' }.
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
            { speaker: 'character', text: "I'm here because your Captain just cleared five hundred Ember. Earned, not dug up. The floor notices. The ribeye is a signing bonus." },
            { speaker: 'pet', mood: 'happy', text: 'RIBEYE. I would like to be signed forever.' },
            { speaker: 'character', text: 'Terms: two calls on the Tanks. Real ones. Come back with a record and we can discuss... liquidity.' },
        ],
        inboxLine: 'A seahorse in a suit came by. Beaks, he said. He left a ribeye and a job. I like him.',
    },
    {
        key: 'beaks_quest_done',
        character: 'beaks',
        once: true,
        // after_encounter keeps the reward from ever playing before the intro was
        // watched - the copy below refers back to that conversation.
        trigger: [
            { kind: 'quest_completed', key: 'beaks_first_trade' },
            { kind: 'after_encounter', key: 'beaks_intro' },
        ],
        effects: [{ kind: 'grant_ember', ruleKey: 'encounter_gift' }],
        dialogue: [
            { speaker: 'character', text: 'Two calls on the books. Adequate. The floor calls that a track record. I call it Tuesday.' },
            { speaker: 'pet', mood: 'happy', text: 'We did the thing! Did we get the thing?' },
            { speaker: 'character', text: "Twenty-five Ember, out of my own pocket - so it doesn't count toward the Hall of Fame. Call it a dividend on showing up." },
            { speaker: 'pet', mood: 'happy', text: "A dividend! I'm going to eat it. Wait. Can I eat it?" },
        ],
        inboxLine: "Beaks came back and slipped 25 Ember into the stash. 'Dividend,' he said. I don't know what that is but I want more.",
    },
];
