// Charles Thomas Evans - fourth rung, and the emotional turn of the ladder. Everyone
// before him is glad to see the pet. Charles is glad to see it AND aware that the game
// got bigger and faster than he did: he played when there were fewer of them and knows
// he could not make a team now.
//
// He has no happy portrait, which suits him - both of his downbeats land on 'sad' and
// the rest is composure. He is also the hand-off: his goodbye is the only thing that
// unlocks Vic, so the tease arrives from someone who cannot take the offer himself.
//
// HIS ARC. When he stopped playing, his things scattered - lent out, left in a locker,
// carried off by somebody's cousin. The pet digs up the world's leftovers, so it is the
// only one who can bring any of it back. Ten pieces come home in rarity order, and then
// he gives the lot away: a case at Tank Land with the pieces in it and the pet's name on
// the plate, because it was the pet who found them and he would rather the room
// remembered that than remembered him.
//
// This is the long arc on purpose. The rarest pieces are a fraction of a percent of
// finds, and the find guarantee still only lands one every third find on a 45-to-120
// minute clock, so the case takes weeks. That is the point: a career is not a weekend.
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
    // The ground, not an office. Where his football errand is handed over.
    home: 'the-tank',
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
        // No item and no Ember here - the Play IS the ask, and the reward comes when
        // he returns. Nothing to reveal, so no step is marked.
        effects: [
            {
                kind: 'start_play',
                play: { key: 'charles_keep_going', title: 'Keep earning', objective: { kind: 'earn_ember', amount: 150 }, rewardEncounter: 'charles_quest_done' },
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
            { kind: 'play_completed', key: 'charles_keep_going' },
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
    // The first delivery Play, and Charles's last beat. It waits until Vic has been
    // watched, so the league tease lands first and this is the quieter note after it.
    // The item is memorabilia: it stacks, can't be bought, and discovery guarantees it
    // on every Nth find while the errand is open (encounters/plays.ts forcedFind).
    {
        key: 'charles_football',
        character: 'charles',
        once: true,
        trigger: [{ kind: 'after_encounter', key: 'vic_intro' }],
        effects: [
            {
                kind: 'start_play',
                play: {
                    key: 'charles_football',
                    title: "Find Charles's old football",
                    objective: { kind: 'deliver_items', items: [{ catalogKey: 'memorabilia_worn_football', count: 1 }] },
                    rewardEncounter: 'charles_football_done',
                },
            },
        ],
        dialogue: [
            { speaker: 'character', text: "You again. Good. I wanted to ask you something, and it's a bit of a strange one." },
            { speaker: 'pet', mood: 'happy', text: 'We like strange ones.' },
            { speaker: 'character', expression: 'sad', text: "When I stopped playing, I lost my old game ball. Worn leather, laces coming loose. I think about it more than I'd like to admit." },
            { speaker: 'pet', mood: 'happy', text: 'We dig things up all the time! We could look.' },
            { speaker: 'character', text: "If you find a worn football on your walks, bring it to me down at the Tank. That's where I'll be." },
            { speaker: 'character', text: "No rush. I've waited this long." },
        ],
    },
    {
        key: 'charles_football_done',
        character: 'charles',
        once: true,
        trigger: [
            { kind: 'play_completed', key: 'charles_football' },
            { kind: 'after_encounter', key: 'charles_football' },
        ],
        effects: [
            { kind: 'grant_ember', ruleKey: 'encounter_gift_large' },
            {
                kind: 'start_play',
                play: {
                    key: 'charles_cleats',
                    title: 'The cleats he retired in',
                    objective: {
                        kind: 'deliver_items',
                        items: [{ catalogKey: 'memorabilia_game_worn_football_cleats', count: 1 }],
                    },
                    rewardEncounter: 'charles_cleats_done',
                },
            },
        ],
        dialogue: [
            { speaker: 'character', text: 'Is that... it is. Look at those laces.' },
            { speaker: 'pet', mood: 'happy', text: 'We found it on a walk and carried it the whole way here.' },
            { speaker: 'character', expression: 'sad', text: "I threw my last pass with a ball just like this. I didn't think I'd hold one again." },
            { speaker: 'character', reveal: true, text: 'This is for bringing it back. Spend it on your own team one day.' },
            { speaker: 'pet', mood: 'happy', text: 'Thank you, Charles.' },
            { speaker: 'character', text: 'There were cleats, too. Worn through on the inside edge. If the ball turned up, they might.' },
        ],
    },
    // Beat 3. The trophy is the rarest single piece in the drop table.
    {
        key: 'charles_cleats_done',
        character: 'charles',
        once: true,
        trigger: [
            { kind: 'play_completed', key: 'charles_cleats' },
            { kind: 'after_encounter', key: 'charles_football_done' },
        ],
        effects: [
            { kind: 'grant_ember', ruleKey: 'encounter_gift' },
            {
                kind: 'start_play',
                play: {
                    key: 'charles_trophy',
                    title: 'The trophy with one arm',
                    objective: {
                        kind: 'deliver_items',
                        items: [{ catalogKey: 'memorabilia_broken_trophy', count: 1 }],
                    },
                    rewardEncounter: 'charles_trophy_done',
                },
            },
        ],
        dialogue: [
            { speaker: 'character', text: 'Studs worn to nothing on the inside. That is a whole season of cutting the same way.' },
            { speaker: 'pet', mood: 'happy', text: 'They smell like grass.' },
            { speaker: 'character', expression: 'sad', text: 'They should. I never cleaned them after the last one. Seemed like bad manners.' },
            { speaker: 'character', reveal: true, text: 'Here. And there is one more thing I would not ask anyone else for.' },
            { speaker: 'pet', mood: 'happy', text: 'Ask us.' },
            { speaker: 'character', text: 'A trophy. The figure on top lost an arm on the bus home and nobody owned up. It will be hard to find. Take your time.' },
        ],
    },
    // Beat 4. Hard: four pieces at once, and none of them his own sport.
    {
        key: 'charles_trophy_done',
        character: 'charles',
        once: true,
        trigger: [
            { kind: 'play_completed', key: 'charles_trophy' },
            { kind: 'after_encounter', key: 'charles_cleats_done' },
        ],
        effects: [
            { kind: 'grant_ember', ruleKey: 'encounter_gift_large' },
            {
                kind: 'start_play',
                play: {
                    key: 'charles_room',
                    title: 'The rest of the room',
                    objective: {
                        kind: 'deliver_items',
                        items: [
                            { catalogKey: 'memorabilia_worn_soccer_ball', count: 1 },
                            { catalogKey: 'memorabilia_worn_basketball', count: 1 },
                            { catalogKey: 'memorabilia_homerun_baseball', count: 1 },
                            { catalogKey: 'memorabilia_broken_hockey_stick', count: 1 },
                        ],
                    },
                    rewardEncounter: 'charles_room_done',
                },
            },
        ],
        dialogue: [
            { speaker: 'character', expression: 'sad', text: 'The base still says champion. That is the part that counts, my mother used to say, and she was wrong but I liked it.' },
            { speaker: 'pet', mood: 'happy', text: 'You keep getting your things back!' },
            { speaker: 'character', text: 'I have been thinking about that. I am not going to put any of it on a shelf in my flat.' },
            { speaker: 'pet', mood: 'happy', text: 'Then what?' },
            { speaker: 'character', text: 'A case. Down at the Tank where people walk past. Not just my sport either - a soccer ball, a basketball, a baseball, whatever is left of a hockey stick.' },
            { speaker: 'character', reveal: true, text: 'Four of them, and none of them mine. Kids who play something else should see their game in there too. That is a lot of digging.' },
        ],
    },
    // Beat 5. The referee's set, plus three wins - he wants the plate to say the pet can
    // actually play, not just fetch.
    {
        key: 'charles_room_done',
        character: 'charles',
        once: true,
        trigger: [
            { kind: 'play_completed', key: 'charles_room' },
            { kind: 'after_encounter', key: 'charles_trophy_done' },
        ],
        effects: [
            { kind: 'grant_ember', ruleKey: 'encounter_gift_large' },
            {
                kind: 'start_play',
                play: {
                    key: 'charles_case',
                    title: 'The case',
                    objective: {
                        kind: 'all_of',
                        parts: [
                            {
                                kind: 'deliver_items',
                                items: [
                                    { catalogKey: 'memorabilia_used_whistle', count: 1 },
                                    { catalogKey: 'memorabilia_yellow_card', count: 1 },
                                    { catalogKey: 'memorabilia_red_card', count: 1 },
                                ],
                            },
                            { kind: 'win_picks', count: 3 },
                        ],
                    },
                    rewardEncounter: 'charles_case_done',
                },
            },
        ],
        dialogue: [
            { speaker: 'character', text: 'Four sports in one crate. The man who builds the case says he can do glass on three sides.' },
            { speaker: 'pet', mood: 'happy', text: 'Is it finished?' },
            { speaker: 'character', expression: 'sad', text: 'Nearly. It needs the other half of the game. A whistle, a yellow, a red.' },
            { speaker: 'pet', mood: 'happy', text: 'Why those?' },
            { speaker: 'character', text: 'Because I saw all three more often than I like to admit, and a case that only shows the good parts is a poster, not a record.' },
            { speaker: 'character', reveal: true, text: 'And land a few calls while you are at it. Your name is going on the plate, so I want it to mean you can play, not just carry.' },
        ],
    },
    // The end of the arc. He gives it all away, with the pet's name on the plate.
    {
        key: 'charles_case_done',
        character: 'charles',
        once: true,
        trigger: [
            { kind: 'play_completed', key: 'charles_case' },
            { kind: 'after_encounter', key: 'charles_room_done' },
        ],
        effects: [{ kind: 'grant_ember', ruleKey: 'encounter_gift_large' }],
        dialogue: [
            { speaker: 'character', text: 'It is up. By the path, where everyone coming into Tank Land has to walk past it.' },
            { speaker: 'pet', mood: 'happy', text: 'Everything is in there. Even the stick.' },
            { speaker: 'character', text: 'Even the stick. Ball, cleats, trophy, the cards, the whistle. Ten pieces and not one of them found by me.' },
            { speaker: 'pet', mood: 'happy', text: 'What does the plate say?' },
            { speaker: 'character', expression: 'sad', text: 'It says the name of the puppy who brought it all back. Mine is on there too, small, at the bottom, where it belongs.' },
            { speaker: 'character', reveal: true, text: 'Take this, and do not argue. I had a career and a room full of proof, and I have spent a season learning that the proof was never the point.' },
            { speaker: 'pet', mood: 'happy', text: 'We can still come and see you though.' },
            { speaker: 'character', text: 'I am always down here. Bring me anything strange you dig up. I like the strange ones.' },
        ],
    },
];
