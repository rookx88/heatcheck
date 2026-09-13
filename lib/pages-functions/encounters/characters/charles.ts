// Charles Thomas Evans - fourth rung, and the emotional turn of the ladder. Everyone
// before him is glad to see the pet. Charles is glad to see it AND aware that the game
// got bigger and faster than he did: he played when there were fewer of them and knows
// he could not make a team now.
//
// He has no happy portrait, which suits him - both of his downbeats land on 'sad' and
// the rest is composure. He is also the hand-off: his goodbye is the only thing that
// unlocks Vic, so the tease arrives from someone who cannot take the offer himself.
//
// See characters/beaks.ts for the house rules the copy follows.

import type { Character, Encounter } from '../types';

export const CHARLES: Character = {
    key: 'charles',
    name: 'Charles Thomas Evans',
    title: 'Veteran',
    portraits: {
        main: '/assets/images/characters/charles_main.webp',
        sad: '/assets/images/characters/charles_sad.webp',
    },
    alt: 'Charles Thomas Evans, a purple athlete with locs and a tentacle tail in a green number ten jersey',
    voice: 'Calm and honest. A retired athlete talking to a young one. Says the hard thing plainly and without self-pity.',
};

export const CHARLES_ENCOUNTERS: Encounter[] = [
    {
        key: 'charles_intro',
        character: 'charles',
        once: true,
        trigger: [
            { kind: 'lifetime_earned_at_least', configKey: 'charles_intro_ember' },
            { kind: 'picks_at_least', count: 10 },
        ],
        // No item and no Ember here - the quest IS the ask, and the reward comes when
        // he returns. Nothing to reveal, so no step is marked.
        effects: [
            {
                kind: 'start_quest',
                quest: { key: 'charles_keep_going', objective: { kind: 'earn_ember', amount: 150 }, rewardEncounter: 'charles_quest_done' },
            },
        ],
        dialogue: [
            { speaker: 'character', text: 'They told me there was a puppy out here taking real calls. I wanted to see for myself.' },
            { speaker: 'pet', mood: 'happy', text: "You're purple. And enormous. And you have a tail." },
            { speaker: 'character', text: 'Charles Evans. Number ten. I played back when this place was smaller and there were fewer of us.' },
            { speaker: 'pet', mood: 'happy', text: 'Is it good? Being the guy?' },
            { speaker: 'character', expression: 'sad', text: "It was. But the game got bigger and everyone got faster. I couldn't make a team now, and I've made my peace with that." },
            { speaker: 'character', text: 'So keep going while you can. Earn another hundred and fifty and I’ll introduce you to someone.' },
        ],
    },
    {
        key: 'charles_quest_done',
        character: 'charles',
        once: true,
        trigger: [
            { kind: 'quest_completed', key: 'charles_keep_going' },
            { kind: 'after_encounter', key: 'charles_intro' },
        ],
        effects: [{ kind: 'grant_ember', ruleKey: 'encounter_gift_large' }],
        dialogue: [
            { speaker: 'character', text: 'You did that without asking me how. Most people ask.' },
            { speaker: 'pet', mood: 'happy', text: 'We just kept going. Like you said.' },
            { speaker: 'character', reveal: true, text: "A hundred Ember. From me, not the club. I don't have a team to spend it on any more." },
            { speaker: 'character', expression: 'sad', text: 'I spent years wishing this place would get bigger. It did. Just a bit too late for me.' },
            { speaker: 'character', text: "There's a man who's been watching your record. He runs a front office. He doesn't say much, so don't take it personally." },
        ],
    },
];
