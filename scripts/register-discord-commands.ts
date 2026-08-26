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

const commands = [
    {
        name: 'heatchecks-setup',
        description: "Choose which channel gets this server's Tank posts and picks",
        type: APPLICATION_COMMAND_TYPE_CHAT_INPUT,
        default_member_permissions: MANAGE_GUILD_PERMISSION,
        options: [
            {
                name: 'channel',
                description: 'The channel to post Tanks in',
                type: OPTION_TYPE_CHANNEL,
                required: true,
                channel_types: [CHANNEL_TYPE_GUILD_TEXT],
            },
        ],
    },
    {
        name: 'heatchecks-config',
        description: 'Configure which sports post to this server, and auto-draw',
        type: APPLICATION_COMMAND_TYPE_CHAT_INPUT,
        default_member_permissions: MANAGE_GUILD_PERMISSION,
        options: [
            { name: 'sport', description: 'Sport to toggle (pair with enabled)', type: OPTION_TYPE_STRING, required: false, choices: sportChoices },
            { name: 'enabled', description: 'Enable or disable that sport', type: OPTION_TYPE_BOOLEAN, required: false },
            { name: 'auto_draw', description: 'Automatically draw a giveaway winner when something settles', type: OPTION_TYPE_BOOLEAN, required: false },
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
                ],
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
