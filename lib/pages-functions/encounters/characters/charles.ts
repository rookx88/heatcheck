// Charles Thomas Evans - fourth rung, and the emotional turn of the ladder. Everyone
// before him is glad to see you. Charles is glad to see you AND aware that the water
// got bigger and faster than he did: he played when the competition was thinner and
// knows he would not make a roster in the game as it is now.
//
// He has no happy portrait, which suits him - both of his downbeats land on 'sad' and
// the rest is composure. He is also the hand-off: his goodbye is the only thing that
// unlocks Vic, so the tease arrives from someone who cannot take the offer himself.

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
    voice: 'Measured, tired, generous. Talks about the work and the arithmetic, never the glory. Never bitter, and says so out loud.',
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
        effects: [
            {
                kind: 'start_quest',
                quest: { key: 'charles_keep_going', objective: { kind: 'earn_ember', amount: 150 }, rewardEncounter: 'charles_quest_done' },
            },
        ],
        dialogue: [
            { speaker: 'character', text: 'They told me there was a puppy out here taking real calls. I wanted to see one for myself.' },
            { speaker: 'pet', mood: 'happy', text: "You're PURPLE. And enormous. And you have a TAIL." },
            { speaker: 'character', text: 'Charles Thomas Evans. Ten. I played when this water was smaller and the competition was thinner.' },
            { speaker: 'pet', mood: 'happy', text: 'Is it good? Being the guy?' },
            { speaker: 'character', expression: 'sad', text: "It was. The world's grown since. More of them every season, every one faster than I was at my best. I'd not make a roster now. That isn't bitterness, it's arithmetic." },
            { speaker: 'character', text: "Which is why I came down. Keep going. A hundred and fifty more Ember, earned the hard way. You've got the years for it and I haven't." },
        ],
        inboxLine: 'A giant purple footballer came to see US. Number ten. He said the world got faster than he did. He wants us to keep going.',
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
            { speaker: 'character', text: "You did it without asking me how. That's the part nobody can teach and the part that lasts." },
            { speaker: 'pet', mood: 'happy', text: 'We just kept going. Like you said.' },
            { speaker: 'character', text: "A hundred Ember. From me, not the house. I've no roster to spend it on any more." },
            { speaker: 'character', expression: 'sad', text: 'Funny thing. I spent fifteen years wanting this water to get bigger. It did. Just late.' },
            { speaker: 'character', text: "There's a man who's been watching your column. Runs a front office. When he comes he won't say much, he never does. Let him look." },
        ],
        inboxLine: 'Charles gave us 100 Ember and said someone from a FRONT OFFICE has been watching our column. He told us to let the man look.',
    },
];
