// Blobby - first rung of the ladder, and the first face a new pet ever sees. He turns
// up on the very first pick, which is the point: nobody comes down for a first call,
// and that is exactly why he does.
//
// HIS ARC. He logs every call that comes into Tank HQ on a board in the basement, and
// nobody upstairs reads his notes. His theory is that the board only makes sense if you
// read the story first, and he cannot prove it with his own record because he is not
// allowed to make calls. So the pet's record becomes his evidence: read the Tanks, then
// call them, then keep doing it until a month of it is impossible to argue with. It
// ends with him presenting the report and getting a desk with a window.
//
// Each beat is its own encounter rather than an effect bolted onto an earlier scene,
// because effects apply when a scene FIRES: a player who watched the old goodbye months
// ago would never get beat two if the beat lived inside it.
//
// His art has no sad face (main is already anxious) and his payoff is the only
// 'ecstatic' portrait in the cast, so his arc runs worried -> hopeful -> unhinged.
// See characters/beaks.ts for the house rules the copy follows.

import type { Character, Encounter } from '../types';

export const BLOBBY: Character = {
    key: 'blobby',
    name: 'Blobby',
    title: 'Junior Analyst',
    portraits: {
        main: '/assets/images/characters/blobby_main.webp',
        happy: '/assets/images/characters/blobby_happy.webp',
        ecstatic: '/assets/images/characters/blobby_ecstatic.webp',
    },
    alt: 'Blobby, a pale round creature in a navy suit and blue tie with a smiley-face pin',
    voice: 'Nervous, warm and over-invested. Apologises first, then gets carried away. Short sentences.',
    home: 'the-tank-hq',
};

export const BLOBBY_ENCOUNTERS: Encounter[] = [
    {
        key: 'blobby_intro',
        character: 'blobby',
        once: true,
        trigger: [{ kind: 'picks_at_least', count: 1 }],
        effects: [
            { kind: 'grant_item', catalogKey: 'food_yogurt_parfait', itemType: 'food' },
            {
                kind: 'start_play',
                play: { key: 'blobby_first_calls', title: 'Make three more calls', objective: { kind: 'picks', count: 3 }, rewardEncounter: 'blobby_quest_done' },
            },
        ],
        dialogue: [
            { speaker: 'character', text: 'Hi. Sorry. I saw your first call come up on the board and I came down to say well done.' },
            { speaker: 'pet', mood: 'happy', text: 'Someone came down? For us?' },
            { speaker: 'character', text: "Nobody usually does for a first one. I'm Blobby, I'm a junior analyst upstairs." },
            { speaker: 'pet', mood: 'happy', text: 'I like him. Can we keep him?' },
            { speaker: 'character', expression: 'happy', reveal: true, text: "I brought you a parfait. It's only from the machine, but here. Make three more calls and come find me." },
        ],
    },
    {
        key: 'blobby_quest_done',
        character: 'blobby',
        once: true,
        trigger: [
            { kind: 'play_completed', key: 'blobby_first_calls' },
            { kind: 'after_encounter', key: 'blobby_intro' },
        ],
        effects: [{ kind: 'grant_ember', ruleKey: 'encounter_gift' }],
        dialogue: [
            { speaker: 'character', expression: 'ecstatic', text: "Four calls! I told everyone upstairs. I told people who weren't listening." },
            { speaker: 'pet', mood: 'happy', text: "He's doing the fists thing." },
            { speaker: 'character', expression: 'ecstatic', reveal: true, text: "Twenty-five Ember, from me. Don't tell anyone. I just wanted to be the first one to back you." },
            { speaker: 'pet', mood: 'happy', text: 'The first one to back us.' },
        ],
    },
    // Beat 2. The theory, and the first thing he has ever asked anyone for.
    {
        key: 'blobby_theory',
        character: 'blobby',
        once: true,
        trigger: [{ kind: 'after_encounter', key: 'blobby_quest_done' }],
        effects: [
            {
                kind: 'start_play',
                play: {
                    key: 'blobby_read_first',
                    title: 'Read the story before you call it',
                    objective: { kind: 'read_articles', count: 3 },
                    rewardEncounter: 'blobby_read_done',
                },
            },
        ],
        dialogue: [
            { speaker: 'character', text: 'Can I show you something? I have a board downstairs. Every call that comes in, I write it up.' },
            { speaker: 'pet', mood: 'happy', text: 'A whole board? For calls?' },
            { speaker: 'character', text: "Nobody upstairs looks at it. They think the numbers are the whole story, and I think the story is most of it." },
            { speaker: 'pet', mood: 'happy', text: 'We like stories.' },
            { speaker: 'character', expression: 'happy', text: "Then read a few Tanks properly before you call anything. Not the numbers. The write-up. I want to see what happens." },
        ],
    },
    // Beat 3. Reading is free; a win is not.
    {
        key: 'blobby_read_done',
        character: 'blobby',
        once: true,
        trigger: [
            { kind: 'play_completed', key: 'blobby_read_first' },
            { kind: 'after_encounter', key: 'blobby_theory' },
        ],
        effects: [
            { kind: 'grant_ember', ruleKey: 'encounter_gift' },
            {
                kind: 'start_play',
                play: {
                    key: 'blobby_first_win',
                    title: 'Land one after reading it',
                    objective: { kind: 'win_picks', count: 1 },
                    rewardEncounter: 'blobby_win_done',
                },
            },
        ],
        dialogue: [
            { speaker: 'character', expression: 'happy', text: 'You actually read them. I checked what you opened. That is not normal.' },
            { speaker: 'pet', mood: 'happy', text: 'One of them was about a goalkeeper who never misses on Tuesdays.' },
            { speaker: 'character', reveal: true, text: "Take this. Now land one. Any league, any game, but read it first. One that comes in is worth more to me than ten that don't." },
        ],
    },
    // Beat 4. The hard turn: five wins and ten Tanks, at once.
    {
        key: 'blobby_win_done',
        character: 'blobby',
        once: true,
        trigger: [
            { kind: 'play_completed', key: 'blobby_first_win' },
            { kind: 'after_encounter', key: 'blobby_read_done' },
        ],
        effects: [
            { kind: 'grant_ember', ruleKey: 'encounter_gift' },
            {
                kind: 'start_play',
                play: {
                    key: 'blobby_pattern',
                    title: 'Give him a pattern, not an anecdote',
                    objective: {
                        kind: 'all_of',
                        parts: [
                            { kind: 'win_picks', count: 5 },
                            { kind: 'read_articles', count: 10 },
                        ],
                    },
                    rewardEncounter: 'blobby_pattern_done',
                },
            },
        ],
        dialogue: [
            { speaker: 'character', expression: 'happy', text: 'It came in. I wrote it on the board in pen, which I am not supposed to do.' },
            { speaker: 'pet', mood: 'happy', text: 'Pen is serious.' },
            { speaker: 'character', text: 'But one is an anecdote. A man upstairs told me that once and he was right, which was annoying.' },
            { speaker: 'character', reveal: true, text: 'So keep going. Read properly, keep landing them, and let it stack up. I need a column of them, not a line.' },
        ],
    },
    // Beat 5. A month of calls at the daily cap, the Ember to match, and the reading.
    {
        key: 'blobby_pattern_done',
        character: 'blobby',
        once: true,
        trigger: [
            { kind: 'play_completed', key: 'blobby_pattern' },
            { kind: 'after_encounter', key: 'blobby_win_done' },
        ],
        effects: [
            { kind: 'grant_ember', ruleKey: 'encounter_gift_large' },
            {
                kind: 'start_play',
                play: {
                    key: 'blobby_report',
                    title: 'The report',
                    objective: {
                        kind: 'all_of',
                        parts: [
                            { kind: 'picks', count: 25 },
                            { kind: 'win_picks', count: 10 },
                            { kind: 'earn_ember', amount: 400 },
                        ],
                    },
                    rewardEncounter: 'blobby_report_done',
                },
            },
        ],
        dialogue: [
            { speaker: 'character', expression: 'happy', text: 'I have a column. I have a column and a highlighter and a title page.' },
            { speaker: 'pet', mood: 'happy', text: 'Is the title page us?' },
            { speaker: 'character', text: "It's you. And here's the part I'm embarrassed about: a column isn't a season. They'll say you got hot." },
            { speaker: 'character', reveal: true, text: "So keep calling. Weeks of it, not days, and make it pay. Then I'll put the whole thing in front of them and they can say what they like." },
        ],
    },
    // The end of the arc. No new Play; he leaves the basement.
    {
        key: 'blobby_report_done',
        character: 'blobby',
        once: true,
        trigger: [
            { kind: 'play_completed', key: 'blobby_report' },
            { kind: 'after_encounter', key: 'blobby_pattern_done' },
        ],
        effects: [{ kind: 'grant_ember', ruleKey: 'encounter_gift_large' }],
        dialogue: [
            { speaker: 'character', expression: 'ecstatic', text: 'I presented it. Out loud. To the room. My hands did a thing but I got through it.' },
            { speaker: 'pet', mood: 'happy', text: 'Did they read the board?' },
            { speaker: 'character', expression: 'ecstatic', text: "They read the board. There's a desk by the window with my name on a card and the card is spelled right." },
            { speaker: 'character', expression: 'ecstatic', reveal: true, text: 'This is yours. Every line in that report was your work. I just wrote it down neatly.' },
            { speaker: 'pet', mood: 'happy', text: 'We are going to miss the basement.' },
            { speaker: 'character', expression: 'happy', text: "Come up any time. I'll keep a chair." },
        ],
    },
];
