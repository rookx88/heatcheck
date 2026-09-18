// Beaks the Broker - the suited seahorse off the TANKDAQ floor, where he is also
// painted into the background art. Third rung of the ladder: he turns up once the
// pet's EARNED column crosses a line, which is the first thing in this game that
// takes real repetition.
//
// HIS ARC. He made his name on the floor and lost it in one afternoon on a longshot,
// and he has brokered for other people ever since - always on the floor, never on the
// board. His arc walks the pet through the thing he will not do himself: read the
// indexes, take one position, close it honestly, run more than one book, and finally
// hold something through a close, which is the only ask in the game whose clock belongs
// to the board rather than the player. He tells the longshot story at the end, once the
// pet has earned the right to hear it.
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
    // Beat 2. The board, before any money touches it. Named index pages, so the player
    // learns that a style has a page of its own.
    {
        key: 'beaks_board',
        character: 'beaks',
        once: true,
        trigger: [{ kind: 'after_encounter', key: 'beaks_quest_done' }],
        effects: [
            {
                kind: 'start_play',
                play: {
                    key: 'beaks_read_board',
                    title: 'Read the board',
                    objective: {
                        kind: 'visit_places',
                        places: ['tankdaq:indexes', 'tankdaq:dogs', 'tankdaq:chalk'],
                    },
                    rewardEncounter: 'beaks_board_done',
                },
            },
        ],
        dialogue: [
            { speaker: 'character', text: "Come up to the floor for a minute. I want to show you where your calls end up." },
            { speaker: 'pet', mood: 'happy', text: 'They end up somewhere?' },
            { speaker: 'character', text: 'Every storyline feeds an index. Favourites in one, underdogs in another, and the prices move as the games land.' },
            { speaker: 'pet', mood: 'happy', text: 'So the board is just... everyone being right and wrong?' },
            { speaker: 'character', expression: 'happy', text: 'That is exactly what the board is. Go and look at it. The whole board, then the underdogs, then the favourites. Read, do not buy.' },
        ],
    },
    // Beat 3. One share. He walks it through deliberately small.
    {
        key: 'beaks_board_done',
        character: 'beaks',
        once: true,
        trigger: [
            { kind: 'play_completed', key: 'beaks_read_board' },
            { kind: 'after_encounter', key: 'beaks_board' },
        ],
        effects: [
            { kind: 'grant_ember', ruleKey: 'encounter_gift' },
            {
                kind: 'start_play',
                play: {
                    key: 'beaks_first_share',
                    title: 'Own one share',
                    objective: { kind: 'hold_shares', shares: 1 },
                    rewardEncounter: 'beaks_first_share_done',
                },
            },
        ],
        dialogue: [
            { speaker: 'character', text: 'You looked at all three. Most people look at one and buy it in the same minute.' },
            { speaker: 'pet', mood: 'happy', text: 'The underdog one keeps jumping around.' },
            { speaker: 'character', expression: 'happy', text: 'It does. That is what an underdog index is for - it does nothing for weeks and then it does everything in one night.' },
            { speaker: 'character', reveal: true, text: 'Buy one share of whichever you actually understand. One. I want you to feel what owning it is like before you own more of it.' },
        ],
    },
    // Beat 4. Hard: three books and three honest closes.
    {
        key: 'beaks_first_share_done',
        character: 'beaks',
        once: true,
        trigger: [
            { kind: 'play_completed', key: 'beaks_first_share' },
            { kind: 'after_encounter', key: 'beaks_board_done' },
        ],
        effects: [
            { kind: 'grant_ember', ruleKey: 'encounter_gift' },
            {
                kind: 'start_play',
                play: {
                    key: 'beaks_book',
                    title: 'A book, not a bet',
                    objective: {
                        kind: 'all_of',
                        parts: [
                            { kind: 'hold_shares', indexes: 3 },
                            { kind: 'sell_profit', count: 3 },
                        ],
                    },
                    rewardEncounter: 'beaks_book_done',
                },
            },
        ],
        dialogue: [
            { speaker: 'character', expression: 'happy', text: 'You own a piece of the board. How did it feel when it moved?' },
            { speaker: 'pet', mood: 'happy', text: 'We checked it eleven times.' },
            { speaker: 'character', text: 'Everybody does. Now the real lesson: one position is a bet. Three positions in three different indexes is a book.' },
            { speaker: 'pet', mood: 'happy', text: 'What is the difference?' },
            { speaker: 'character', reveal: true, text: 'A book survives being wrong somewhere. Run three, and close three of them up on what you paid. Selling well is the part nobody practises.' },
        ],
    },
    // Beat 5. The one thing a player cannot rush, and the thing he never does.
    {
        key: 'beaks_book_done',
        character: 'beaks',
        once: true,
        trigger: [
            { kind: 'play_completed', key: 'beaks_book' },
            { kind: 'after_encounter', key: 'beaks_first_share_done' },
        ],
        effects: [
            { kind: 'grant_ember', ruleKey: 'encounter_gift_large' },
            {
                kind: 'start_play',
                play: {
                    key: 'beaks_overnight',
                    title: 'Hold it through a close',
                    objective: {
                        kind: 'all_of',
                        parts: [
                            { kind: 'hold_through_close' },
                            { kind: 'sell_profit', count: 5 },
                            { kind: 'earn_ember', amount: 300 },
                        ],
                    },
                    rewardEncounter: 'beaks_overnight_done',
                },
            },
        ],
        dialogue: [
            { speaker: 'character', expression: 'happy', text: 'Three books, three clean exits. You are trading better than most of the floor and you are a puppy.' },
            { speaker: 'pet', mood: 'happy', text: 'Do you have a book?' },
            { speaker: 'character', expression: 'sad', text: 'No. I broker for other people. I take a fee, I go home, I sleep.' },
            { speaker: 'pet', mood: 'happy', text: 'Why?' },
            { speaker: 'character', text: "Ask me when you've done this: buy something and still own it after the board closes for the day. Do not sell before. Just hold it and let the close happen to you." },
            { speaker: 'character', reveal: true, text: 'Keep working while you wait. Close a few more well, keep the earned column moving. Then come and find me.' },
        ],
    },
    // The end of the arc. The longshot story, finally.
    {
        key: 'beaks_overnight_done',
        character: 'beaks',
        once: true,
        trigger: [
            { kind: 'play_completed', key: 'beaks_overnight' },
            { kind: 'after_encounter', key: 'beaks_book_done' },
        ],
        effects: [{ kind: 'grant_ember', ruleKey: 'encounter_gift_large' }],
        dialogue: [
            { speaker: 'character', text: 'You held it overnight. Tell me honestly - did you check the price before you went to sleep?' },
            { speaker: 'pet', mood: 'happy', text: 'Twice. And once in the night.' },
            { speaker: 'character', expression: 'sad', text: 'Then you know. I had a longshot once. One index, everything I had, a night like that. It came in at the wrong end and I was on the floor by morning.' },
            { speaker: 'pet', mood: 'sad', text: 'Is that why you never hold anything?' },
            { speaker: 'character', expression: 'sad', text: "That's why. I can read the board better than anyone in that building and I have not owned a share since." },
            { speaker: 'character', expression: 'happy', reveal: true, text: 'You did it properly, though. Spread out, closed clean, slept badly and held anyway. Take this - and keep a book, not a bet.' },
            { speaker: 'pet', mood: 'happy', text: 'We will hold one for you too.' },
        ],
    },
];
