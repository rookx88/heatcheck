// Vic Marlow - the top of the ladder. His first scene hands over nothing, which is the
// whole point of it: there is a league above this water with franchises in it, and he
// is not offering a place in it.
//
// HIS ARC. He opens a file instead. Each beat is a line in it - a name, wins on the
// record, how the pet is looked after when nobody is watching, proof it is not a hot
// month, and one position on the board to show it understands what it is playing for.
// He closes the file, logs the pet as scouted, and hands over the silver pass, whose own
// wording promises nothing: a list that is not taking names yet. He still refuses to
// give a date, because a date is the one thing he cannot honestly give.
//
// He has NO home, so none of his Plays is a delivery - every beat is something the pet
// does out in the world rather than something carried to him. His finale is the only
// source of the silver pass (add_whitelist_items.sql), which is why he is also the one
// character who hands over memorabilia.
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
    // Beat 1. The file needs a name, and the pet's name is permanent and unique - which
    // is exactly why he treats it as paperwork rather than sentiment.
    {
        key: 'vic_file',
        character: 'vic',
        once: true,
        trigger: [{ kind: 'after_encounter', key: 'vic_intro' }],
        effects: [
            {
                kind: 'start_play',
                play: {
                    key: 'vic_name',
                    title: 'Put a name on the record',
                    objective: { kind: 'name_pet' },
                    rewardEncounter: 'vic_name_done',
                },
            },
        ],
        dialogue: [
            { speaker: 'character', text: "I'm opening a file on you. That's not a threat, it's how this works." },
            { speaker: 'pet', mood: 'happy', text: 'A file! Like a real player?' },
            { speaker: 'character', text: "Like a real player. And a file needs a name at the top, and right now yours says 'the puppy at the Tank'." },
            { speaker: 'pet', mood: 'happy', text: 'We can pick one!' },
            { speaker: 'character', text: 'Pick carefully. Nobody else in this water gets to use it afterwards, and I am not editing the file twice.' },
        ],
    },
    // Beat 2. Results on the record.
    {
        key: 'vic_name_done',
        character: 'vic',
        once: true,
        trigger: [
            { kind: 'play_completed', key: 'vic_name' },
            { kind: 'after_encounter', key: 'vic_file' },
        ],
        effects: [
            {
                kind: 'start_play',
                play: {
                    key: 'vic_three_wins',
                    title: 'Three on the record',
                    objective: { kind: 'win_picks', count: 3 },
                    rewardEncounter: 'vic_wins_done',
                },
            },
        ],
        dialogue: [
            { speaker: 'character', text: 'Name at the top. It suits the rest of the page.' },
            { speaker: 'pet', mood: 'happy', text: 'What else is on the page?' },
            { speaker: 'character', text: 'Not much yet. Three calls that came in would fill the first line. Any league. I do not care which.' },
            { speaker: 'pet', mood: 'happy', text: 'We can do three.' },
            { speaker: 'character', text: 'Everyone can do three. Do three.' },
        ],
    },
    // Beat 3. Care, which is the thing he actually watches for.
    {
        key: 'vic_wins_done',
        character: 'vic',
        once: true,
        trigger: [
            { kind: 'play_completed', key: 'vic_three_wins' },
            { kind: 'after_encounter', key: 'vic_name_done' },
        ],
        effects: [
            { kind: 'grant_ember', ruleKey: 'encounter_gift' },
            {
                kind: 'start_play',
                play: {
                    key: 'vic_kept_clean',
                    title: 'Keep it clean',
                    objective: { kind: 'pet_sustained_satisfied' },
                    rewardEncounter: 'vic_clean_done',
                },
            },
        ],
        dialogue: [
            { speaker: 'character', text: 'Three in, all on the record, none of them lucky enough to be interesting. Good.' },
            { speaker: 'pet', mood: 'happy', text: 'Is that the file filled in?' },
            { speaker: 'character', reveal: true, text: "That's one line. Here, for the trouble. Now the part most people fail." },
            { speaker: 'pet', mood: 'happy', text: 'We are very good at parts.' },
            { speaker: 'character', text: 'Be looked after. Properly fed, for hours, not a plate shoved at you when somebody remembers. A front office watches how a player is kept when nobody is scouting.' },
        ],
    },
    // Beat 4. Hard: eight wins, real Ember, and the care holding at the same moment.
    {
        key: 'vic_clean_done',
        character: 'vic',
        once: true,
        trigger: [
            { kind: 'play_completed', key: 'vic_kept_clean' },
            { kind: 'after_encounter', key: 'vic_wins_done' },
        ],
        effects: [
            { kind: 'grant_ember', ruleKey: 'encounter_gift' },
            {
                kind: 'start_play',
                play: {
                    key: 'vic_not_luck',
                    title: "Show him it isn't luck",
                    objective: {
                        kind: 'all_of',
                        parts: [
                            { kind: 'win_picks', count: 8 },
                            { kind: 'earn_ember', amount: 500 },
                            { kind: 'pet_sustained_satisfied' },
                        ],
                    },
                    rewardEncounter: 'vic_not_luck_done',
                },
            },
        ],
        dialogue: [
            { speaker: 'character', text: 'Fed, rested, nobody rushing you. I wrote "well kept" and I do not write that often.' },
            { speaker: 'pet', mood: 'happy', text: 'Does that mean the league?' },
            { speaker: 'character', text: 'It means the second line. Here is the third, and it is the hard one: do all of it at once.' },
            { speaker: 'character', text: 'Calls landing, Ember earned, and still kept properly while you do it. Anyone can be good at one thing for a week.' },
            { speaker: 'pet', mood: 'happy', text: 'That sounds like a lot of weeks.' },
            { speaker: 'character', reveal: true, text: 'It is. That is what makes it worth writing down.' },
        ],
    },
    // Beat 5. The completion bar of the whole game.
    {
        key: 'vic_not_luck_done',
        character: 'vic',
        once: true,
        trigger: [
            { kind: 'play_completed', key: 'vic_not_luck' },
            { kind: 'after_encounter', key: 'vic_clean_done' },
        ],
        effects: [
            { kind: 'grant_ember', ruleKey: 'encounter_gift_large' },
            {
                kind: 'start_play',
                play: {
                    key: 'vic_closing_file',
                    title: 'The file',
                    objective: {
                        kind: 'all_of',
                        parts: [
                            { kind: 'win_picks', count: 15 },
                            { kind: 'earn_ember', amount: 1000 },
                            { kind: 'feeds', count: 30 },
                            { kind: 'hold_shares', shares: 1 },
                        ],
                    },
                    rewardEncounter: 'vic_file_closed',
                },
            },
        ],
        dialogue: [
            { speaker: 'character', text: 'Three lines, all of them holding. I have signed players with thinner pages than this.' },
            { speaker: 'pet', mood: 'happy', text: 'Then sign us!' },
            { speaker: 'character', text: 'No. I close files, I do not open doors - not yet, and I told you I would not promise a date.' },
            { speaker: 'pet', mood: 'sad', text: 'Oh.' },
            { speaker: 'character', text: 'What I will do is finish it properly. Everything you have been doing, at a size nobody can call a hot streak. And own a piece of the board while you do it.' },
            { speaker: 'character', reveal: true, text: 'A player who owns a share understands what the games are worth. That is the last line. Take your time - it will take months of it.' },
        ],
    },
    // The end of the arc, and the only source of the silver pass.
    {
        key: 'vic_file_closed',
        character: 'vic',
        once: true,
        trigger: [
            { kind: 'play_completed', key: 'vic_closing_file' },
            { kind: 'after_encounter', key: 'vic_not_luck_done' },
        ],
        effects: [
            { kind: 'grant_ember', ruleKey: 'encounter_gift_large' },
            { kind: 'grant_item', catalogKey: 'memorabilia_gm_whitelist_silver', itemType: 'memorabilia' },
        ],
        dialogue: [
            { speaker: 'character', text: 'File closed. Logged as scouted, which in my office is a short word for a long argument I won.' },
            { speaker: 'pet', mood: 'happy', text: 'Did anyone argue?' },
            { speaker: 'character', text: 'Two of them. Then they read the page and stopped.' },
            { speaker: 'character', reveal: true, text: "Here. It's a silver pass. There's a name line on it and nobody has filled one in yet, including yours." },
            { speaker: 'pet', mood: 'happy', text: 'So it does nothing?' },
            { speaker: 'character', text: 'Today it does nothing. It means when the list starts taking names, you are already on the page in front of it.' },
            { speaker: 'character', text: "Keep the record clean. I'll know where to find you." },
        ],
    },
];
