// Vic Marlow - the top of the ladder and the only character who hands over nothing.
// He exists to say that there is a league above this water with franchises in it, and
// to not offer you a place in it. That is the whole encounter.
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

import type { Character, Encounter } from '../types';

export const VIC: Character = {
    key: 'vic',
    name: 'Vic Marlow',
    title: 'General Manager',
    portraits: {
        main: '/assets/images/characters/vic_main.webp',
    },
    alt: 'Vic Marlow, a bald bearded man in dark sunglasses, a black suit and a red shirt',
    voice: 'Institutional and unhurried. All implication, no offer. Speaks about the league as a fact that exists somewhere else.',
};

export const VIC_ENCOUNTERS: Encounter[] = [
    {
        key: 'vic_intro',
        character: 'vic',
        once: true,
        trigger: [{ kind: 'after_encounter', key: 'charles_quest_done' }],
        // Conversational only. No item, no Ember, no quest - the tease IS the payload.
        effects: [],
        dialogue: [
            { speaker: 'character', text: "Don't get up. I've seen the column. That's why I'm here and that's the whole of it." },
            { speaker: 'pet', mood: 'happy', text: 'Are you a GM? You LOOK like a GM.' },
            { speaker: 'character', text: 'Vic Marlow. I run a front office. Not this one. There’s a league above this water, franchises in it, and a table where they argue about names like yours.' },
            { speaker: 'pet', mood: 'happy', text: 'Names like MINE?' },
            { speaker: 'character', text: "There will be a day when a puppy with a record signs somewhere and plays for something. Not today. I don't sell futures I can't deliver." },
            { speaker: 'character', text: "Keep the column clean. When the doors open I'd rather not have to explain you to anybody." },
        ],
        inboxLine: 'A man in sunglasses came, said almost nothing, and left. There is a LEAGUE. With franchises. He said to keep our column clean.',
    },
];
