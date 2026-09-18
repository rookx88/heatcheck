import { renderHead, topbar, footer } from './waitlist-landing-template';
import { documentStyles, inline } from './legal-page';
import { DISCORD_INVITE } from './faq-template';
import { escapeHtml } from '../utils/html-escape';

/**
 * /discord-bot/ - what the Heatchecks Discord bot does for a server, and how it plugs
 * into a member's Heatchecks account. Set in the same document card as the footer pages
 * (legal-page.ts) so it reads as part of the same site.
 *
 * Same rule as the FAQ: every line describes what the code does today
 * (functions/api/discord/interactions.ts, lib/pages-functions/discord-*.ts), and stays
 * off tunable numbers - the daily call cap is an env var and payouts are config rows,
 * so "the same daily limit as the site", never "1 a day". Two distinctions are
 * load-bearing and must stay true:
 *   - Anyone can call a Tank card for server points (discord_tank_votes). Only a linked,
 *     onboarded account with an Ember pick left today gets an Ember pick (submitPick) -
 *     which earns server points too. Community Pick votes need no account either.
 *   - Community Points, PvP, leagues and draws never touch Ember, and Heatchecks never
 *     supplies prizes - a draw only names a winner.
 */

/** Public application id - it's in every "add to server" link, not a secret. */
const DISCORD_APPLICATION_ID = '1541513532393136269';
/** View Channel + Send Messages + Embed Links + Attach Files - what /heatchecks setup checks for. */
const BOT_PERMISSIONS = 1024 + 2048 + 16384 + 32768;
export const DISCORD_BOT_INSTALL_URL =
    `https://discord.com/oauth2/authorize?client_id=${DISCORD_APPLICATION_ID}&permissions=${BOT_PERMISSIONS}&integration_type=0&scope=bot+applications.commands`;

interface Feature { icon: string; title: string; body: string }

const FEATURES: Feature[] = [
    {
        icon: '📰',
        title: 'Tanks in your channel',
        body: 'The bot posts each new Tank (our story about a real upcoming game) to the channel you choose, with a button for every side. Anyone in the server can make the call for points, no account needed. You choose the sports and how many per day, and admins can post any Tank on demand.',
    },
    {
        icon: '🗳️',
        title: 'Community Picks',
        body: 'Admins pick any live market on an upcoming game and turn it into a vote for the whole server. Anyone can vote, with no account needed: one vote each, locked at kickoff. Calling an underdog correctly pays more points than calling a favourite.',
    },
    {
        icon: '🏆',
        title: 'Leaderboards and rank cards',
        body: 'Your server keeps its own points and leaderboard, and you can rename both. `/leaderboard` ranks the server’s members by points, accuracy or Skill Rating. `/me` shows a personal rank card with level and record. A weekly leaderboard can post on Mondays.',
    },
    {
        icon: '⚔️',
        title: 'PvP battles',
        body: 'Challenge another member head-to-head. You each call up to three props on upcoming games, and neither of you sees the other’s picks until they settle. Whoever’s calls score higher takes the battle, and every win and loss goes on your record.',
    },
    {
        icon: '🏈',
        title: 'Season leagues',
        body: 'Run an NFL league inside your server with `/heatchecks-league join`. Each week the bot posts a Community Pick for every game, and the league table only counts points earned after you join.',
    },
    {
        icon: '🎲',
        title: 'Winner draws',
        body: 'After a Tank or Community Pick settles, draw one random winner from the members who called it right. You can do it with a button or have it happen automatically. Useful if your server runs its own giveaways.',
    },
];

interface Command { name: string; who: string; what: string }

const COMMANDS: Command[] = [
    { name: '/heatchecks setup', who: 'Admins', what: 'A guided setup: channels, sports, how often Tanks post, point names and leaderboard views.' },
    { name: '/heatchecks settings', who: 'Admins', what: 'Change any of those settings later from one panel.' },
    { name: '/heatchecks post', who: 'Admins', what: 'Post a Tank, a Community Pick or a leaderboard right now.' },
    { name: '/heatchecks draw', who: 'Admins', what: 'Draw a random winner from members who called a settled pick correctly.' },
    { name: '/leaderboard', who: 'Everyone', what: 'The server’s top 10 by points, accuracy, Skill Rating or league standing.' },
    { name: '/me', who: 'Everyone', what: 'Your rank card: points, rank, Skill Rating, level and PvP record.' },
    { name: '/my-results', who: 'Everyone', what: 'Your latest settled picks and votes, shown only to you.' },
    { name: '/pvp', who: 'Everyone', what: 'Challenge a member to a battle, or check your open ones.' },
    { name: '/heatchecks-league', who: 'Everyone', what: 'Join or leave your server’s NFL season league.' },
];

interface Faq { q: string; a: string }

const FAQS: Faq[] = [
    {
        q: 'Does it really cost nothing?',
        a: 'Nothing, ever. No premium tier, no locked commands, no member limits and no charge per server. Your members don’t pay anything either. Heatchecks itself has nothing to buy.',
    },
    {
        q: 'Do my members need a Heatchecks account?',
        a: 'No. Tank calls, Community Picks, leaderboards, PvP and leagues all work with just a Discord account. A free Heatchecks account only adds **Ember**: once a member links, their Tank calls earn Ember as well as server points.',
    },
    {
        q: 'What is the difference between server points and Ember?',
        a: 'Server points belong to your server and power its leaderboards, leagues and draws. Anyone can earn them. **Ember** is the Heatchecks currency. It is earned by making Tank calls with a linked account and goes on your Heatchecks account, where you use it to hatch a pet, feed it and trade on [TANKDAQ](/tankdaq/). Neither one has any cash value.',
    },
    {
        q: 'Does Heatchecks provide prizes for draws?',
        a: 'No. A draw simply names a random winner from the members who called it right. Whatever your server does with that is up to you, and Heatchecks is not part of it.',
    },
    {
        q: 'What permissions does the bot need?',
        a: 'To view the channels you point it at, send messages, embed links and attach files, because leaderboards and rank cards are images. Setup posts a welcome card as a test and tells you if anything is missing. Only members with **Manage Server** can use the admin commands.',
    },
];

/** inline() marks -> plain text, for the FAQPage structured data. */
function plain(text: string): string {
    return text
        .replace(/\[([^\[\]]+)\]\([^)\s]+\)/g, '$1')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1');
}

/** inline() plus `code` spans for command names. */
function rich(text: string): string {
    return inline(text).replace(/`([^`]+)`/g, '<code>$1</code>');
}

function ctaRow(): string {
    return `
            <div class="hc-bot-ctas">
                <a class="hc-bot-btn hc-bot-btn--add" href="${DISCORD_BOT_INSTALL_URL}" rel="noopener" target="_blank">Add to your server — free</a>
                <a class="hc-bot-btn hc-bot-btn--join" href="${DISCORD_INVITE}" rel="noopener" target="_blank">Join the Heatchecks Discord</a>
            </div>`;
}

export function generateDiscordBotPageHtml(baseUrl: string): string {
    const title = 'Heatchecks Discord Bot — free for every server | Heatchecks';
    const description = 'Add the free Heatchecks bot to your Discord server: Tanks posted to your channel, Community Picks, leaderboards, PvP battles and leagues. Link your account to make calls from Discord and earn Ember.';
    const schemaOrg = {
        '@context': 'https://schema.org',
        '@graph': [
            {
                '@type': 'SoftwareApplication',
                name: 'Heatchecks Discord Bot',
                applicationCategory: 'GameApplication',
                operatingSystem: 'Discord',
                url: `${baseUrl}/discord-bot/`,
                description,
                offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
            },
            {
                '@type': 'FAQPage',
                mainEntity: FAQS.map((faq) => ({
                    '@type': 'Question',
                    name: faq.q,
                    acceptedAnswer: { '@type': 'Answer', text: plain(faq.a) },
                })),
            },
        ],
    };
    const head = renderHead({ title, description, path: '/discord-bot/', baseUrl, schemaOrg });

    return `<!DOCTYPE html>
<html lang="en">
<head>
    ${head}
    <style>${documentStyles()}
        .hc-bot-lede { font-size: 1.05rem !important; color: rgba(255, 255, 255, 0.9) !important; }
        .hc-bot-free {
            display: inline-block; margin: 0.9rem 0 0; padding: 0.3rem 0.75rem; border-radius: 999px;
            background: rgba(255, 199, 44, 0.14); border: 1px solid rgba(255, 199, 44, 0.6);
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 900; font-size: 0.72rem;
            letter-spacing: 0.1em; text-transform: uppercase; color: var(--hc-gold);
        }

        .hc-bot-ctas { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 1.4rem; }
        .hc-doc a.hc-bot-btn {
            display: inline-flex; align-items: center; justify-content: center; min-height: 48px;
            padding: 0.7rem 1.3rem; border-radius: 14px; text-decoration: none;
            font-family: 'Baloo 2', 'Nunito', sans-serif; font-weight: 800; font-size: 1.05rem; line-height: 1.1;
            transition: transform 0.12s ease, box-shadow 0.12s ease;
        }
        .hc-doc a.hc-bot-btn:hover { transform: translateY(-1px); }
        .hc-doc a.hc-bot-btn:focus-visible { outline: 2px solid var(--hc-teal); outline-offset: 3px; }
        .hc-doc a.hc-bot-btn--add { background: #5865f2; color: #ffffff; box-shadow: 0 6px 20px rgba(88, 101, 242, 0.45); }
        .hc-doc a.hc-bot-btn--add:hover { color: #ffffff; box-shadow: 0 8px 26px rgba(88, 101, 242, 0.6); }
        .hc-doc a.hc-bot-btn--join { background: transparent; color: #ffffff; border: 2px solid rgba(255, 255, 255, 0.3); }
        .hc-doc a.hc-bot-btn--join:hover { border-color: var(--hc-teal); color: #ffffff; }

        /* A mock of a Tank card as Discord renders it - illustrative, aria-hidden. */
        .hc-bot-preview { margin: 1.75rem 0 0; }
        .hc-bot-msg {
            display: grid; grid-template-columns: 40px 1fr; gap: 0.75rem;
            padding: 1rem; border-radius: 14px; background: #313338; border: 1px solid rgba(255, 255, 255, 0.08);
            font-family: 'Nunito', system-ui, sans-serif;
        }
        .hc-bot-avatar {
            width: 40px; height: 40px; border-radius: 50%; overflow: hidden;
            background: var(--hc-navy-light); display: grid; place-items: center;
        }
        .hc-bot-avatar img { width: 34px; height: auto; display: block; }
        .hc-bot-name { font-weight: 800; color: #ffffff; font-size: 0.95rem; }
        .hc-bot-tag {
            margin-left: 0.35rem; padding: 0.05rem 0.3rem; border-radius: 4px; vertical-align: 2px;
            background: #5865f2; color: #ffffff; font-size: 0.62rem; font-weight: 800; letter-spacing: 0.02em;
        }
        .hc-bot-embed {
            margin-top: 0.4rem; padding: 0.7rem 0.9rem; border-radius: 4px;
            background: #2b2d31; border-left: 4px solid var(--hc-gold);
        }
        .hc-bot-embed-author { font-size: 0.75rem; font-weight: 800; color: rgba(255, 255, 255, 0.85); }
        .hc-bot-embed-title { margin-top: 0.3rem; font-weight: 800; color: #00a8fc; font-size: 0.98rem; line-height: 1.3; }
        .hc-bot-embed-desc { margin-top: 0.25rem; color: #dbdee1; font-size: 0.88rem; }
        .hc-bot-embed-foot { margin-top: 0.55rem; color: rgba(219, 222, 225, 0.65); font-size: 0.7rem; }
        .hc-bot-buttons { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.55rem; }
        .hc-bot-buttons span {
            padding: 0.4rem 0.9rem; border-radius: 4px; font-size: 0.85rem; font-weight: 700; color: #ffffff;
            background: #4e5058;
        }
        .hc-bot-buttons span:first-child { background: #5865f2; }
        .hc-doc p.hc-bot-caption { margin-top: 0.5rem; font-size: 0.8rem; color: rgba(255, 255, 255, 0.55); text-align: center; }

        .hc-bot-section { margin-top: 2.6rem; scroll-margin-top: 1rem; }
        .hc-bot-section > h2 { color: var(--hc-gold); }
        .hc-bot-section > p.hc-bot-intro { margin-top: 0.5rem; }

        .hc-bot-features { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.85rem; margin-top: 1.1rem; }
        .hc-bot-feature {
            padding: 1rem 1.1rem 1.1rem; border-radius: 14px;
            background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.12);
        }
        .hc-bot-feature-icon { font-size: 1.5rem; line-height: 1; }
        .hc-doc .hc-bot-feature h3 { margin-top: 0.5rem; font-size: 1.1rem; }
        .hc-doc .hc-bot-feature p { margin-top: 0.35rem; font-size: 0.9rem; line-height: 1.55; }

        .hc-doc code {
            padding: 0.05rem 0.35rem; border-radius: 6px; white-space: nowrap;
            background: rgba(47, 230, 217, 0.12); color: #ffffff;
            font-family: ui-monospace, 'SFMono-Regular', Consolas, monospace; font-size: 0.85em;
        }

        .hc-doc ol.hc-bot-steps { list-style: none; counter-reset: step; margin: 1.1rem 0 0; padding: 0; }
        .hc-bot-steps li {
            counter-increment: step; position: relative;
            margin-top: 0.75rem; padding: 0.85rem 1rem 0.9rem 3.4rem; border-radius: 14px;
            background: rgba(47, 230, 217, 0.06); border: 1px solid rgba(47, 230, 217, 0.3);
        }
        .hc-bot-steps li::before {
            content: counter(step); position: absolute; left: 1rem; top: 0.85rem;
            width: 1.7rem; height: 1.7rem; border-radius: 50%; display: grid; place-items: center;
            background: var(--hc-teal); color: var(--hc-navy-dark);
            font-family: 'Montserrat', sans-serif; font-weight: 900; font-size: 0.85rem;
        }
        .hc-bot-steps strong { display: block; font-family: 'Baloo 2', 'Nunito', sans-serif; font-size: 1.05rem; }

        .hc-bot-compare { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.85rem; margin-top: 1.25rem; }
        .hc-bot-compare > div { padding: 1rem 1.1rem; border-radius: 14px; border: 1px solid rgba(255, 255, 255, 0.14); background: rgba(255, 255, 255, 0.03); }
        .hc-bot-compare > div.hc-bot-compare--ember { border-color: rgba(255, 199, 44, 0.55); background: rgba(255, 199, 44, 0.07); }
        .hc-bot-compare-label {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 900; font-size: 0.68rem;
            letter-spacing: 0.12em; text-transform: uppercase; color: var(--hc-teal);
        }
        .hc-bot-compare--ember .hc-bot-compare-label { color: var(--hc-gold); }
        .hc-doc .hc-bot-compare h3 { margin-top: 0.3rem; }
        .hc-doc .hc-bot-compare ul { margin-top: 0.4rem; }
        .hc-doc .hc-bot-compare li { font-size: 0.88rem; margin-top: 0.3rem; }

        .hc-bot-table-wrap { margin-top: 1.1rem; overflow-x: auto; border-radius: 14px; border: 1px solid rgba(255, 255, 255, 0.12); }
        .hc-bot-table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
        .hc-bot-table th, .hc-bot-table td { padding: 0.65rem 0.85rem; text-align: left; vertical-align: top; color: rgba(255, 255, 255, 0.85); line-height: 1.45; }
        .hc-bot-table th {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.68rem;
            letter-spacing: 0.1em; text-transform: uppercase; color: var(--hc-teal); background: rgba(255, 255, 255, 0.04);
        }
        .hc-bot-table tr + tr td { border-top: 1px solid rgba(255, 255, 255, 0.08); }
        .hc-bot-who { white-space: nowrap; font-size: 0.78rem; font-weight: 800; }
        .hc-bot-who--admin { color: var(--hc-gold) !important; }

        .hc-bot-faq {
            margin-top: 0.6rem; border-radius: 14px;
            background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.12);
        }
        .hc-bot-faq[open] { border-color: rgba(47, 230, 217, 0.5); background: rgba(47, 230, 217, 0.05); }
        .hc-bot-faq > summary {
            display: flex; align-items: center; justify-content: space-between; gap: 1rem;
            cursor: pointer; list-style: none; padding: 0.85rem 1.1rem;
            font-family: 'Baloo 2', 'Nunito', sans-serif; font-weight: 800; font-size: 1.05rem; line-height: 1.3; color: #ffffff;
        }
        .hc-bot-faq > summary::-webkit-details-marker { display: none; }
        .hc-bot-faq > summary::after { content: '+'; flex-shrink: 0; color: var(--hc-teal); font-family: 'Montserrat', sans-serif; font-weight: 800; font-size: 1.2rem; line-height: 1; }
        .hc-bot-faq[open] > summary::after { content: '\\2212'; }
        .hc-bot-faq > summary:focus-visible { outline: 2px solid var(--hc-teal); outline-offset: 2px; border-radius: 14px; }
        .hc-bot-faq > p { margin: 0; padding: 0 1.1rem 1rem; }

        .hc-bot-final {
            margin-top: 2.75rem; padding: 1.5rem 1.25rem; border-radius: 16px; text-align: center;
            border: 1px solid rgba(88, 101, 242, 0.6); background: rgba(88, 101, 242, 0.12);
        }
        .hc-doc .hc-bot-final h2 { margin: 0; }
        .hc-doc .hc-bot-final p { margin-top: 0.4rem; }
        .hc-bot-final .hc-bot-ctas { justify-content: center; }

        @media (max-width: 560px) {
            .hc-bot-features, .hc-bot-compare { grid-template-columns: 1fr; }
            .hc-doc a.hc-bot-btn { flex: 1 1 100%; }
            .hc-bot-table .hc-bot-who { display: block; margin-top: 0.15rem; }
            .hc-bot-table thead { display: none; }
            .hc-bot-table td { display: block; padding: 0.15rem 0.85rem; }
            .hc-bot-table td:first-child { padding-top: 0.7rem; }
            .hc-bot-table td:last-child { padding-bottom: 0.7rem; }
            .hc-bot-table tr + tr td { border-top: 0; }
            .hc-bot-table tr + tr td:first-child { border-top: 1px solid rgba(255, 255, 255, 0.08); }
        }
        @media (prefers-reduced-motion: reduce) { .hc-doc a.hc-bot-btn { transition: none; } .hc-doc a.hc-bot-btn:hover { transform: none; } }
        @media print { .hc-bot-ctas, .hc-bot-preview, .hc-bot-final { display: none; } }
    </style>
</head>
<body>
    <main class="hc-page hc-page--doc">
        ${topbar('/beta/')}

        <article class="hc-doc" id="top">
            <p class="hc-doc-eyebrow">Discord bot</p>
            <h1>Heatchecks, right inside your Discord server</h1>
            <span class="hc-bot-free">100% free · every feature · every server</span>
            <p class="hc-bot-lede">The Heatchecks bot brings game-day stories, server-wide picks, leaderboards and head-to-head battles into your channels. Members who link their account can make their Heatchecks calls without leaving Discord and earn Ember on their account for them.</p>
            ${ctaRow()}

            <figure class="hc-bot-preview">
                <div class="hc-bot-msg" aria-hidden="true">
                    <div class="hc-bot-avatar"><img src="/assets/images/mudpuppy-default.png" alt="" width="34" height="34"></div>
                    <div>
                        <span class="hc-bot-name">Heatchecks</span><span class="hc-bot-tag">APP</span>
                        <div class="hc-bot-embed">
                            <div class="hc-bot-embed-author">The Tank</div>
                            <div class="hc-bot-embed-title">A rivalry, a road trip and a rotation running on fumes</div>
                            <div class="hc-bot-embed-desc">Who wins tonight?</div>
                            <div class="hc-bot-embed-foot">Link Discord at heatchecks.io to earn Ember!</div>
                        </div>
                        <div class="hc-bot-buttons"><span>Home (54%)</span><span>Away (46%)</span></div>
                    </div>
                </div>
                <p class="hc-bot-caption">A Tank as it appears in your channel: read the story, then tap a side.</p>
            </figure>

            <section class="hc-bot-section" id="features">
                <h2>What it brings to your server</h2>
                <p class="hc-bot-intro">Something to talk about on every game day, and a scoreboard that is your server’s own.</p>
                <div class="hc-bot-features">${FEATURES.map((f) => `
                    <div class="hc-bot-feature">
                        <div class="hc-bot-feature-icon" aria-hidden="true">${f.icon}</div>
                        <h3>${escapeHtml(f.title)}</h3>
                        <p>${rich(f.body)}</p>
                    </div>`).join('')}
                </div>
            </section>

            <section class="hc-bot-section" id="ember">
                <h2>Play from Discord, earn Ember</h2>
                <p class="hc-bot-intro">Anyone can tap a side on a Tank card and play for server points. Link your Discord to a free Heatchecks account and that same tap becomes a real Heatchecks call, the same as one made on the site: it earns <strong>Ember</strong> on your account as well. Ember calls share the site’s daily limit. Once you’ve used them, you can keep calling Tanks for server points.</p>
                <ol class="hc-bot-steps">
                    <li><strong>Link your Discord</strong>Use <a href="/api/discord/link">Continue with Discord</a> or the Connections tab of your <a href="/account/">account page</a>. If you don’t have an account yet, linking creates a free one for you.</li>
                    <li><strong>Tap a side on a Tank</strong>Your call locks straight away, and the bot tells you how many Ember calls you have left today.</li>
                    <li><strong>Earn when it settles</strong>A correct call earns Ember, and calling an underdog pays more than calling a favourite. A miss still earns a little for taking part. You also pick up your server’s points on the same call.</li>
                    <li><strong>Spend it on Heatchecks</strong>Hatch and feed a Mud Puppy at <a href="/the-hatchery/">the Hatchery</a>, trade storylines on <a href="/tankdaq/">TANKDAQ</a> and climb the Hall of Fame. Check <code>/my-results</code> any time.</li>
                </ol>

                <div class="hc-bot-compare">
                    <div class="hc-bot-compare--ember">
                        <div class="hc-bot-compare-label">Linked account</div>
                        <h3>Everything, plus Ember</h3>
                        <ul>
                            <li>Tank calls earn <strong>Ember</strong> on your Heatchecks account, up to the daily limit</li>
                            <li>Plus your server’s points on every call</li>
                            <li>Count towards your site-wide record and the Hall of Fame</li>
                        </ul>
                    </div>
                    <div>
                        <div class="hc-bot-compare-label">Just Discord</div>
                        <h3>Tank calls, Community Picks, PvP and leagues</h3>
                        <ul>
                            <li>Earn your server’s points and climb its leaderboard</li>
                            <li>No Heatchecks account needed</li>
                            <li>No Ember</li>
                        </ul>
                    </div>
                </div>
            </section>

            <section class="hc-bot-section" id="setup">
                <h2>Up and running in a couple of minutes</h2>
                <ol class="hc-bot-steps">
                    <li><strong>Add the bot</strong><a href="${DISCORD_BOT_INSTALL_URL}" rel="noopener" target="_blank">Add it to your server</a> and approve the permissions it asks for.</li>
                    <li><strong>Run <code>/heatchecks setup</code></strong>A short walkthrough covers which channel to post in, which sports, how many Tanks a day, whether results post publicly and what to call your points and leaderboard.</li>
                    <li><strong>Post your first Tanks</strong>Setup ends with a button that posts the latest Tanks. After that the bot posts new ones and results by itself.</li>
                </ol>
            </section>

            <section class="hc-bot-section" id="commands">
                <h2>Commands</h2>
                <div class="hc-bot-table-wrap">
                    <table class="hc-bot-table">
                        <thead><tr><th scope="col">Command</th><th scope="col">Who</th><th scope="col">What it does</th></tr></thead>
                        <tbody>${COMMANDS.map((c) => `
                            <tr><td><code>${escapeHtml(c.name)}</code></td><td class="hc-bot-who${c.who === 'Admins' ? ' hc-bot-who--admin' : ''}">${escapeHtml(c.who)}</td><td>${escapeHtml(c.what)}</td></tr>`).join('')}
                        </tbody>
                    </table>
                </div>
            </section>

            <section class="hc-bot-section" id="faq">
                <h2>Good to know</h2>${FAQS.map((faq, i) => `
                <details class="hc-bot-faq"${i === 0 ? ' open' : ''}>
                    <summary>${escapeHtml(faq.q)}</summary>
                    <p>${rich(faq.a)}</p>
                </details>`).join('')}
            </section>

            <div class="hc-bot-final">
                <h2>Bring Heatchecks to your server</h2>
                <p>Free for every server, for good. Questions? Ask us in the Heatchecks Discord or see the <a href="/faq/#discord">FAQ</a>.</p>
                ${ctaRow()}
            </div>
            <a class="hc-doc-top" href="#top">&uarr; Back to top</a>
        </article>

        ${footer()}
    </main>
</body>
</html>`;
}
