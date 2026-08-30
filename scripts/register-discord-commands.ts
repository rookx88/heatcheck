// One-time (or whenever command definitions change) script to register this bot's
// slash commands globally with Discord. Global, not per-guild: this bot is
// installable on servers we don't control ahead of time, so there's no fixed guild id
// to register against - PUT /applications/{id}/commands replaces the bot's entire
// global command set in one call. Propagates to all servers within ~1 hour per
// Discord's own docs; don't expect it to show up instantly after running this.
//
// Run: npx tsx scripts/register-discord-commands.ts

import dotenv from 'dotenv';
dotenv.config();

const APPLICATION_COMMAND_TYPE_CHAT_INPUT = 1;
const APPLICATION_COMMAND_TYPE_SUB_COMMAND = 1;
const OPTION_TYPE_STRING = 3;
const OPTION_TYPE_BOOLEAN = 5;
const OPTION_TYPE_CHANNEL = 7;
const CHANNEL_TYPE_GUILD_TEXT = 0;
// Discord permission bit for "Manage Server", sent as a stringified bitfield -
// default_member_permissions hides the command from members without it in Discord's
// own UI. lib/pages-functions/discord-commands.ts re-checks this at request time too
// (server-authoritative - never trust the UI-level gate alone).
const MANAGE_GUILD_PERMISSION = '32';

// Mirrors lib/pages-functions/discord-commands.ts's SUPPORTED_SPORTS (duplicated
// rather than imported - this script stays a standalone Node/tsx entry point, not
// coupled to the Workers-oriented lib/pages-functions module graph).
const SUPPORTED_SPORTS = ['NBA', 'NFL', 'MLB', 'EPL', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1'];
const sportChoices = SUPPORTED_SPORTS.map((s) => ({ name: s, value: s }));

// Mirrors lib/pages-functions/discord-commands.ts's SUPPORTED_LEAGUE_SPORTS -
// season-long leagues start NFL-only, a deliberately narrower list than the sports
// above.
const LEAGUE_SPORTS = ['NFL'];
const leagueSportChoices = LEAGUE_SPORTS.map((s) => ({ name: s, value: s }));

const commands = [
    {
        name: 'heatchecks-setup',
        description: 'Guided setup — get Heatchecks running in this server in a couple of minutes',
        type: APPLICATION_COMMAND_TYPE_CHAT_INPUT,
        default_member_permissions: MANAGE_GUILD_PERMISSION,
        options: [
            {
                name: 'channel',
                // Optional quick path: with a channel it just sets the channel like
                // before; bare, it runs the full guided wizard.
                description: 'Quick-set the post channel (leave empty for the full guided setup)',
                type: OPTION_TYPE_CHANNEL,
                required: false,
                channel_types: [CHANNEL_TYPE_GUILD_TEXT],
            },
        ],
    },
    {
        name: 'heatchecks-config',
        description: 'Configure sports, auto-draw, and display names for this server',
        type: APPLICATION_COMMAND_TYPE_CHAT_INPUT,
        default_member_permissions: MANAGE_GUILD_PERMISSION,
        options: [
            { name: 'sport', description: 'Sport to toggle (pair with enabled)', type: OPTION_TYPE_STRING, required: false, choices: sportChoices },
            { name: 'enabled', description: 'Enable or disable that sport', type: OPTION_TYPE_BOOLEAN, required: false },
            { name: 'auto_draw', description: 'Automatically draw a giveaway winner when something settles', type: OPTION_TYPE_BOOLEAN, required: false },
            { name: 'points_name', description: 'Custom display name for "Community Points" in this server', type: OPTION_TYPE_STRING, required: false },
            { name: 'leaderboard_name', description: 'Custom display name for "Leaderboard" in this server', type: OPTION_TYPE_STRING, required: false },
            {
                name: 'settlement_visibility',
                description: 'Post settlement results to the channel, or keep them private (members use /my-results)',
                type: OPTION_TYPE_STRING,
                required: false,
                choices: [
                    { name: 'Channel', value: 'channel' },
                    { name: 'Private', value: 'private' },
                ],
            },
        ],
    },
    {
        name: 'heatchecks-post',
        description: 'Post a Tank or create a Community Pick on demand',
        type: APPLICATION_COMMAND_TYPE_CHAT_INPUT,
        default_member_permissions: MANAGE_GUILD_PERMISSION,
        options: [
            {
                name: 'tank',
                description: 'Post an existing real Tank right now',
                type: APPLICATION_COMMAND_TYPE_SUB_COMMAND,
                options: [
                    { name: 'search', description: 'Keyword to search Tanks', type: OPTION_TYPE_STRING, required: true },
                ],
            },
            {
                name: 'community-pick',
                description: 'Create a Community Pick from a live Polymarket market',
                type: APPLICATION_COMMAND_TYPE_SUB_COMMAND,
                options: [
                    { name: 'sport', description: 'Sport to search', type: OPTION_TYPE_STRING, required: true, choices: sportChoices },
                    { name: 'keyword', description: 'Optional keyword filter', type: OPTION_TYPE_STRING, required: false },
                    { name: 'channel', description: 'Post to an approved Community Pick channel (default: main channel)', type: OPTION_TYPE_CHANNEL, required: false, channel_types: [CHANNEL_TYPE_GUILD_TEXT] },
                ],
            },
            {
                name: 'leaderboard',
                description: 'Post the leaderboard card publicly right now',
                type: APPLICATION_COMMAND_TYPE_SUB_COMMAND,
                options: [
                    {
                        name: 'view', description: 'Which leaderboard to post', type: OPTION_TYPE_STRING, required: true,
                        choices: [
                            { name: 'Community Points', value: 'community' },
                            { name: 'Accuracy', value: 'accuracy' },
                            { name: 'Skill Rating', value: 'sr' },
                            { name: 'League', value: 'league' },
                        ],
                    },
                    { name: 'sport', description: 'Sport (required for view:League)', type: OPTION_TYPE_STRING, required: false, choices: leagueSportChoices },
                    { name: 'channel', description: 'Post to an approved channel (default: main channel)', type: OPTION_TYPE_CHANNEL, required: false, channel_types: [CHANNEL_TYPE_GUILD_TEXT] },
                ],
            },
        ],
    },
    {
        name: 'heatchecks-draw',
        description: 'Randomly draw a giveaway winner from a settled Tank or Community Pick',
        type: APPLICATION_COMMAND_TYPE_CHAT_INPUT,
        default_member_permissions: MANAGE_GUILD_PERMISSION,
    },
    {
        name: 'heatchecks-league',
        description: 'Join or leave a season-long league leaderboard',
        type: APPLICATION_COMMAND_TYPE_CHAT_INPUT,
        // No default_member_permissions - joining/leaving a league is a member
        // action, not an admin one (unlike every other heatchecks-* command).
        options: [
            {
                name: 'join',
                description: 'Join this server\'s league for a sport',
                type: APPLICATION_COMMAND_TYPE_SUB_COMMAND,
                options: [
                    { name: 'sport', description: 'Sport league to join', type: OPTION_TYPE_STRING, required: true, choices: leagueSportChoices },
                ],
            },
            {
                name: 'leave',
                description: 'Leave this server\'s league for a sport',
                type: APPLICATION_COMMAND_TYPE_SUB_COMMAND,
                options: [
                    { name: 'sport', description: 'Sport league to leave', type: OPTION_TYPE_STRING, required: true, choices: leagueSportChoices },
                ],
            },
        ],
    },
    {
        name: 'me',
        description: 'Your personal rank card — rank, points, accuracy, and Skill Rating in this server',
        type: APPLICATION_COMMAND_TYPE_CHAT_INPUT,
        // No default_member_permissions - a member command, like /my-results.
    },
    {
        name: 'my-results',
        description: 'Privately check your own recent settled results and points in this server',
        type: APPLICATION_COMMAND_TYPE_CHAT_INPUT,
        // No default_member_permissions - available to every member, not an admin
        // command. Always ephemeral (visible only to the caller) regardless of the
        // server's settlement_visibility setting.
    },
    {
        name: 'leaderboard',
        description: "Show this server's Heatchecks leaderboard",
        type: APPLICATION_COMMAND_TYPE_CHAT_INPUT,
        options: [
            {
                name: 'view',
                description: 'Which leaderboard to show (default: accuracy)',
                type: OPTION_TYPE_STRING,
                required: false,
                choices: [
                    { name: 'Accuracy', value: 'accuracy' },
                    { name: 'Community Points', value: 'community' },
                    { name: 'League', value: 'league' },
                    { name: 'Skill Rating', value: 'sr' },
                ],
            },
            {
                name: 'sport',
                description: 'Sport league to view (required for view:League)',
                type: OPTION_TYPE_STRING,
                required: false,
                choices: leagueSportChoices,
            },
        ],
    },
];

async function main(): Promise<void> {
    const applicationId = process.env.DISCORD_CLIENT_ID;
    const botToken = process.env.DISCORD_BOT_TOKEN;
    if (!applicationId || !botToken) {
        console.error('Missing DISCORD_CLIENT_ID or DISCORD_BOT_TOKEN in the environment (.env).');
        process.exit(1);
    }

    const res = await fetch(`https://discord.com/api/v10/applications/${applicationId}/commands`, {
        method: 'PUT',
        headers: {
            Authorization: `Bot ${botToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(commands),
    });

    if (!res.ok) {
        console.error(`Command registration failed: ${res.status} ${await res.text()}`);
        process.exit(1);
    }

    const registered = (await res.json()) as { name: string }[];
    console.log(`✓ Registered ${registered.length} global command(s): ${registered.map((c) => c.name).join(', ')}`);
    console.log('Discord can take up to ~1 hour to propagate these to every server.');
}

main().catch((err) => {
    console.error('Fatal error registering Discord commands:', err);
    process.exit(1);
});
