// Puffington - second rung. He is the only character who arrives because of how the
// pet is looked after rather than how it plays, which is why his trigger is feeds and
// his Play is a tour of both food counters. It doubles as the thing that teaches a
// new player that the Terrace and Quickboost exist.
//
// HIS ARC. He has followed the same club since he was small and will not name them.
// Every collapse he has eaten through at the Terrace, and the staff stopped asking what
// he wants years ago. His shirt does not fit. What turns it is noticing that the pet is
// fed better than he feeds himself: one deliberate farewell spread, then the salad, and
// a promise he asks the pet to hold him to. He never stops supporting the club - that
// was never the problem.
//
// The club stays unnamed on purpose. A real crest here would age into a joke about a
// team that later wins everything, and would read as a take. Leagues are fine; clubs
// are not.
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
    // Beat 2. The first honest thing he says, and the first time the pet's routine
    // lands on him as a comparison rather than a curiosity.
    {
        key: 'puffington_your_bowl',
        character: 'puffington',
        once: true,
        trigger: [{ kind: 'after_encounter', key: 'puffington_quest_done' }],
        effects: [
            {
                kind: 'start_play',
                play: {
                    key: 'puffington_fed_well',
                    title: 'Feed your pet properly',
                    objective: { kind: 'feeds', count: 3 },
                    rewardEncounter: 'puffington_fed_done',
                },
            },
        ],
        dialogue: [
            { speaker: 'character', text: 'You eat on a schedule. I noticed. Somebody puts food in front of you and you finish it and that is that.' },
            { speaker: 'pet', mood: 'happy', text: 'We have a bowl.' },
            { speaker: 'character', expression: 'sad', text: 'I eat when the match goes badly. Which, with my club, is a lot of eating and not a lot of matches going well.' },
            { speaker: 'pet', mood: 'happy', text: 'Which club?' },
            { speaker: 'character', text: "Not saying. They know what they did." },
            { speaker: 'character', text: 'Go and get fed a few more times. I want to watch somebody do it properly for a while.' },
        ],
    },
    // Beat 3. The last honest blowout, and the first delivery he asks for. Found-only
    // concession food, so it comes out of the mud rather than a shop.
    {
        key: 'puffington_fed_done',
        character: 'puffington',
        once: true,
        trigger: [
            { kind: 'play_completed', key: 'puffington_fed_well' },
            { kind: 'after_encounter', key: 'puffington_your_bowl' },
        ],
        effects: [
            { kind: 'grant_ember', ruleKey: 'encounter_gift' },
            {
                kind: 'start_play',
                play: {
                    key: 'puffington_last_plate',
                    title: 'One last plate',
                    objective: {
                        kind: 'deliver_items',
                        items: [
                            { catalogKey: 'food_loaded_nachos', count: 1 },
                            { catalogKey: 'food_chicken_wings', count: 1 },
                        ],
                    },
                    rewardEncounter: 'puffington_last_plate_done',
                },
            },
        ],
        dialogue: [
            { speaker: 'character', text: 'Three meals, all on time. You did not once eat standing up over a bin.' },
            { speaker: 'pet', mood: 'happy', text: 'Is that a thing people do?' },
            { speaker: 'character', expression: 'sad', text: "It's a thing I do. Second leg, down two, standing behind the counter with the nachos." },
            { speaker: 'character', reveal: true, text: 'Take this. And do me a favour first - bring me nachos and wings, the concession kind you dig up out there.' },
            { speaker: 'pet', mood: 'happy', text: 'We find those all the time!' },
            { speaker: 'character', text: "One last proper plate. Then I'm going to try something." },
        ],
    },
    // Beat 4. Hard: the three rarest concession foods, plus ten feeds while he works
    // himself up to it. Days of walking even with the find guarantee.
    {
        key: 'puffington_last_plate_done',
        character: 'puffington',
        once: true,
        trigger: [
            { kind: 'play_completed', key: 'puffington_last_plate' },
            { kind: 'after_encounter', key: 'puffington_fed_done' },
        ],
        effects: [
            { kind: 'grant_ember', ruleKey: 'encounter_gift' },
            {
                kind: 'start_play',
                play: {
                    key: 'puffington_farewell',
                    title: 'The farewell spread',
                    objective: {
                        kind: 'all_of',
                        parts: [
                            {
                                kind: 'deliver_items',
                                items: [
                                    { catalogKey: 'food_sampler_platter', count: 1 },
                                    { catalogKey: 'food_mint_julep', count: 1 },
                                    { catalogKey: 'food_craft_beer', count: 1 },
                                ],
                            },
                            { kind: 'feeds', count: 10 },
                        ],
                    },
                    rewardEncounter: 'puffington_farewell_done',
                },
            },
        ],
        dialogue: [
            { speaker: 'character', expression: 'happy', text: 'That was excellent and I regret none of it.' },
            { speaker: 'pet', mood: 'happy', text: 'You had sauce on your shirt.' },
            { speaker: 'character', text: "The shirt doesn't fit anyway. Hasn't for two seasons. I keep telling myself it shrank in the wash." },
            { speaker: 'character', expression: 'sad', text: 'Here is what I want. One real send-off, the whole spread - the platter, the julep, the beer. Hard to come by, all three.' },
            { speaker: 'pet', mood: 'happy', text: 'We can look for ages. We are very good at looking.' },
            { speaker: 'character', reveal: true, text: 'Then look. And keep eating properly yourself while I say goodbye to mine. I want to see it done right in front of me.' },
        ],
    },
    // Beat 5. The turn: a bought order from the light counter, a pet that has been kept
    // fed rather than topped up once, and twenty-five feeds of habit behind it.
    {
        key: 'puffington_farewell_done',
        character: 'puffington',
        once: true,
        trigger: [
            { kind: 'play_completed', key: 'puffington_farewell' },
            { kind: 'after_encounter', key: 'puffington_last_plate_done' },
        ],
        effects: [
            { kind: 'grant_ember', ruleKey: 'encounter_gift_large' },
            {
                kind: 'start_play',
                play: {
                    key: 'puffington_diet',
                    title: 'Match day, sober plate',
                    objective: {
                        kind: 'all_of',
                        parts: [
                            {
                                kind: 'deliver_items',
                                items: [
                                    { catalogKey: 'food_fresh_salad', count: 1 },
                                    { catalogKey: 'food_protein_shake', count: 1 },
                                    { catalogKey: 'food_banana_shake', count: 1 },
                                ],
                            },
                            { kind: 'pet_sustained_satisfied' },
                            { kind: 'feeds', count: 25 },
                        ],
                    },
                    rewardEncounter: 'puffington_diet_done',
                },
            },
        ],
        dialogue: [
            { speaker: 'character', text: 'Platter, julep, beer. Finished the lot and shook the plate out for the birds.' },
            { speaker: 'pet', mood: 'happy', text: 'You went quiet at the end.' },
            { speaker: 'character', expression: 'sad', text: "Because it wasn't the food. The food was never the thing. I just needed somewhere to put a bad night." },
            { speaker: 'character', text: 'So. Next one. Buy me the salad, the protein shake, the banana one - the light counter, the stuff I have walked past for years.' },
            { speaker: 'pet', mood: 'happy', text: 'Those cost Ember. We have Ember!' },
            { speaker: 'character', reveal: true, text: "Then spend it on me, and keep your own bowl full while you do it. Properly full, for hours, not a quick top-up. If you can hold to that, I can." },
        ],
    },
    // The end of the arc. He commits, and he keeps the club.
    {
        key: 'puffington_diet_done',
        character: 'puffington',
        once: true,
        trigger: [
            { kind: 'play_completed', key: 'puffington_diet' },
            { kind: 'after_encounter', key: 'puffington_farewell_done' },
        ],
        effects: [
            { kind: 'grant_ember', ruleKey: 'encounter_gift_large' },
            { kind: 'grant_item', catalogKey: 'food_ribeye', itemType: 'food' },
        ],
        dialogue: [
            { speaker: 'character', expression: 'happy', text: 'Salad. On match day. Conceded in the ninetieth and I ate the salad anyway.' },
            { speaker: 'pet', mood: 'happy', text: 'Was it good?' },
            { speaker: 'character', text: 'It was leaves. But I watched the whole second half instead of the counter, and I have not done that in years.' },
            { speaker: 'character', expression: 'happy', text: 'The staff asked if I was ill. I said I was on a diet and they laughed, and then they wrote it on the board.' },
            { speaker: 'character', expression: 'happy', reveal: true, text: "Here - the ribeye I'd been saving for the next collapse. I'm not eating it. You are, and I want to hear about it." },
            { speaker: 'pet', mood: 'happy', text: 'Are you still going to support them?' },
            { speaker: 'character', text: 'Every week until I die. That part was never up for discussion.' },
        ],
    },
];
