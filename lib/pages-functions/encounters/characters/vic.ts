// Vic Marlow - the top of the ladder and the only character who hands over nothing.
// He exists to say that there is a league above this water with franchises in it, and
// to not offer a place in it. That is the whole encounter, and since the inbox row is
// gone he leaves nothing behind at all once the scene is watched. That is correct: it
// was a conversation, not a transaction.
//
// He carries NO threshold of his own: his single trigger is that Charles's goodbye has
// been watched, which lands around 650 earned on its own. That means the tease paces
// itself with no number to retune, and - because evaluate.ts fires at most one
// encounter per page load - he can never arrive before the man who introduces him.
//
// What he says is deliberately consistent with what the site already promises (the
// homepage banner and the Mud Puppy promo both mention a team and an eventual
// franchise) and deliberately free of dates and specifics, so nothing here can age
// into a broken promise.
//
// See characters/beaks.ts for the house rules the copy follows.

import type { Character, Encounter } from '../types';

export const VIC: Character = {
    key: 'vic',
    name: 'Vic Marlow',
    title: 'General Manager',
    portraits: {
        main: '/assets/images/characters/vic_main.webp',
    },
    alt: 'Vic Marlow, a bald bearded man in dark sunglasses, a black suit and a red shirt',
    voice: 'Quiet and matter-of-fact. Says less than he knows. Never promises anything.',
};

export const VIC_ENCOUNTERS: Encounter[] = [
    {
        key: 'vic_intro',
        character: 'vic',
        once: true,
        trigger: [{ kind: 'after_encounter', key: 'charles_quest_done' }],
        // Conversational only. No item, no Ember, no Play - the tease IS the payload,
        // so there is nothing to reveal and no step is marked.
        effects: [],
        dialogue: [
            { speaker: 'character', text: "Don't get up. I've seen your record. That's why I'm here." },
            { speaker: 'pet', mood: 'happy', text: 'Are you a GM? You look like a GM.' },
            { speaker: 'character', text: 'Vic Marlow. I run a front office, though not this one. There’s a league above this water, with real franchises in it.' },
            { speaker: 'pet', mood: 'happy', text: 'A league?' },
            { speaker: 'character', text: "One day a puppy with a record like yours signs with a team and plays there. Not today. I'm not going to promise you a date." },
            { speaker: 'character', text: "Just keep your record clean. When the doors do open, I don't want anything to argue about." },
        ],
    },
];
