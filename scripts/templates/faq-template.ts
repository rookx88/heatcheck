import { renderHead, topbar, footer } from './waitlist-landing-template';
import { documentStyles, inline } from './legal-page';
import { escapeHtml } from '../utils/html-escape';

/**
 * /faq/ - set in the same document card as /terms/ and /privacy/ (legal-page.ts).
 *
 * Every answer describes what the code does today, and deliberately stays off exact
 * numbers that are tunable (the daily call cap is an env var, payouts and shop prices
 * are config rows) - "a daily limit", not "1 a day" - so a rebalance doesn't turn this
 * page into a lie. When a feature's behaviour changes, its answer changes with it.
 *
 * Answers use inline() marks: **bold**, *italic*, [text](/url).
 */
export const DISCORD_INVITE = 'https://discord.gg/z3XUVvG4Nh';

interface Faq { q: string; a: string[] }
interface FaqGroup { id: string; title: string; faqs: Faq[] }

const GROUPS: FaqGroup[] = [
    {
        id: 'basics',
        title: 'The basics',
        faqs: [
            {
                q: 'What is Heatchecks?',
                a: ['Heatchecks is a free-to-play sports world. You read stories about real games, make a call on how they will go, and earn Ember — our in-world currency — which you use to hatch and raise a Mud Puppy pet, trade storyline indexes on TANKDAQ, and climb the Hall of Fame.'],
            },
            {
                q: 'Is it really free?',
                a: ['Yes. There is nothing to buy on Heatchecks today — no subscriptions, no packs, no checkout. Ember is earned by playing and cannot be purchased.'],
            },
            {
                q: 'Is this gambling or sports betting?',
                a: [
                    'No. You never put money in, and you can never take money out. Calls are made with no stakes, Ember has no cash value, and nothing on the site can be redeemed for money or prizes.',
                    'The odds you see are there to tell the story of a game — who is favoured and by how much — not as betting advice. The full detail is in Section 3 of our [Terms of Service](/terms/#section-3).',
                ],
            },
            {
                q: 'Who can play?',
                a: ['Heatchecks is for adults: you need to be 18 or older (or the age of majority where you live, if that is higher) to have an account.'],
            },
        ],
    },
    {
        id: 'account',
        title: 'Signing in and your account',
        faqs: [
            {
                q: 'How do I sign up or log in?',
                a: ['Enter your email on the [login page](/login/) and we will send you a sign-in link. Click it and you are in — the same box works whether you are new or returning. New players choose a username on their first visit.'],
            },
            {
                q: 'Why is there no password?',
                a: ['We do not use passwords at all, so there is nothing to forget, reuse or leak. Each sign-in link works once and expires after a few minutes, and you stay signed in on that device afterwards.'],
            },
            {
                q: 'I did not get my sign-in email. What now?',
                a: ['Give it a minute, then check your spam or promotions folder and make sure the address was typed correctly. You can request a fresh link from the [login page](/login/) — only the newest link works. If it still does not arrive, write to support@heatchecks.io from the address you signed up with.'],
            },
            {
                q: 'Can I use Discord with my account?',
                a: ['Yes. You can sign in with Discord, or link Discord to an existing account from the Connections tab of your [account page](/account/). You can unlink it there at any time.'],
            },
            {
                q: 'How do I sign out of other devices?',
                a: ['Open the Security tab of your [account page](/account/). It shows how many devices are signed in and lets you log out everywhere except the device you are using.'],
            },
            {
                q: 'How do I delete my account?',
                a: [
                    'From the Security tab of your [account page](/account/). You will be asked to type your username to confirm.',
                    'Deleting removes what identifies you — your email, username, pet name, Discord link, sessions and notifications — straight away, and frees your email and username to be used again. Your past calls stay in the game\'s totals, with nothing on them that points to you. It cannot be undone. More in our [Privacy Policy](/privacy/).',
                ],
            },
        ],
    },
    {
        id: 'ember',
        title: 'Ember',
        faqs: [
            {
                q: 'What is Ember?',
                a: ['Ember is the currency of the Heatchecks world. It exists only inside the game: it has no cash value and cannot be bought, sold, gifted or cashed out.'],
            },
            {
                q: 'How do I earn Ember?',
                a: [
                    'Mostly by making calls. A correct call pays Ember, and calling an underdog correctly pays more than calling a heavy favourite. A call that misses still earns a small amount for taking part.',
                    'Your pet also digs up Ember as you explore, characters you meet around the world sometimes hand out gifts, and selling TANKDAQ shares returns Ember too. Every new account also gets a one-time welcome gift of 100 Ember when you sign the welcome letter — enough for your first egg. There is nothing to buy or claim beyond that.',
                ],
            },
            {
                q: 'What can I spend Ember on?',
                a: ['Eggs at [the Hatchery](/the-hatchery/), food for your pet at [Champion\'s Lakeside Terrace](/champions-terrace/) and [Quickboost Delicacies](/quickboost-delicacies/), and shares of storyline indexes on [TANKDAQ](/tankdaq/).'],
            },
        ],
    },
    {
        id: 'tanks',
        title: 'Tanks and calls',
        faqs: [
            {
                q: 'What is a Tank?',
                a: ['A Tank is a story about a real upcoming game — the storylines, the numbers, what is at stake — with a call attached: pick the side you think it goes. Our stories inform; they never tell you which side to take. Find today\'s at [Tank HQ](/the-tank-hq/).'],
            },
            {
                q: 'How many calls can I make?',
                a: ['One per Tank, up to a daily limit. The homepage shows how many you have left today, and the count resets each day.'],
            },
            {
                q: 'When does my call lock, and when is it settled?',
                a: ['Calls close when the game starts. Once the game is over the result is settled and any Ember is added to your balance — usually by the next morning. You can follow open and settled calls in [My Portfolio](/my-portfolio/), and we can email you the result.'],
            },
            {
                q: 'Which sports are covered?',
                a: ['Baseball (MLB), basketball (NBA, WNBA and college), football (NFL and college) and soccer (the Premier League, La Liga, Serie A, Bundesliga, Ligue 1, the Champions League and MLS). What is on the board on a given day depends on the schedule.'],
            },
            {
                q: 'Where do the odds come from?',
                a: ['From Polymarket\'s public market data. It is a one-way read: we display the prices, and none of your information is ever sent to Polymarket.'],
            },
        ],
    },
    {
        id: 'tankdaq',
        title: 'TANKDAQ',
        faqs: [
            {
                q: 'What is TANKDAQ?',
                a: ['[TANKDAQ](/tankdaq/) is the world\'s exchange. Each index follows a sports storyline — underdogs, favourites, overs, a league, a club — and you buy and sell whole shares of it with Ember.'],
            },
            {
                q: 'What moves an index\'s price?',
                a: ['Real results. Each index takes a position on the games that fit its storyline before they start, scores those positions once the games finish, and rolls the day into a single price move. The [indexes board](/tankdaq/indexes/) shows every index and its chart.'],
            },
            {
                q: 'Where do I see what I hold?',
                a: ['The Indexes tab of [My Portfolio](/my-portfolio/) lists your positions and your trade history. Shares are bought and sold in Ember only, like everything else here.'],
            },
        ],
    },
    {
        id: 'pets',
        title: 'Your Mud Puppy',
        faqs: [
            {
                q: 'How do I get a pet?',
                a: ['Earn enough Ember, buy an egg at [the Hatchery](/the-hatchery/) and hatch it in the incubator. Then give it a name — names are unique, so yours is the only one. Each account raises one Mud Puppy.'],
            },
            {
                q: 'How do I look after it?',
                a: ['Buy food with Ember at [Champion\'s Lakeside Terrace](/champions-terrace/) or [Quickboost Delicacies](/quickboost-delicacies/) and feed it when it is hungry. Feeding itself costs nothing beyond the food. If you like, we will let you know when it gets hungry — that is a switch on your [account page](/account/?tab=notifications).'],
            },
            {
                q: 'What does my pet find?',
                a: ['As you move around the world your pet digs things up: Ember, food, sports memorabilia, and — rarely — numbered collectible cards. Everything it finds is kept in your inventory.'],
            },
            {
                q: 'What is the Hall of Fame?',
                a: ['The public board of the top players by lifetime Ember earned through play, shown with their pets. Gifts do not count towards it — only what you earned.'],
            },
        ],
    },
    {
        id: 'email',
        title: 'Emails and privacy',
        faqs: [
            {
                q: 'What emails will I get?',
                a: ['Sign-in links and codes when you ask for them, results when your calls settle, and — only if you opted in — the weekly newsletter.'],
            },
            {
                q: 'How do I turn emails off?',
                a: ['Every results email and newsletter has a one-click unsubscribe link that works without logging in. For the full set of switches, use the Notifications tab of your [account page](/account/?tab=notifications). Sign-in emails are only ever sent when you request one.'],
            },
            {
                q: 'What do you do with my data?',
                a: ['We collect what the game needs to work — your email, your activity in the game, and a Discord link if you add one. We do not sell personal information and we do not run advertising trackers. The whole picture, including how to get a copy of your data, is in our [Privacy Policy](/privacy/).'],
            },
        ],
    },
    {
        id: 'discord',
        title: 'Discord',
        faqs: [
            {
                q: 'Is there a Heatchecks Discord?',
                a: [`Yes — [join the Heatchecks Discord](${DISCORD_INVITE}) to talk games, compare calls and hear about new features first.`],
            },
            {
                q: 'Is there a Discord bot?',
                a: ['Yes. Servers that add the Heatchecks bot get Tanks posted to a channel, community picks and leaderboards, and members can make their calls right from Discord. Link your Discord on your [account page](/account/) and the Ember you earn there lands on your Heatchecks account. It is free for every server — [see everything it does](/discord-bot/).'],
            },
        ],
    },
];

/** inline() marks -> plain text, for the FAQPage structured data. */
function plain(text: string): string {
    return text
        .replace(/\[([^\[\]]+)\]\([^)\s]+\)/g, '$1')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\*(.+?)\*/g, '$1');
}

export function generateFaqPageHtml(baseUrl: string): string {
    const title = 'FAQ | Heatchecks';
    const description = 'Answers about Heatchecks: how it is free and not gambling, signing in without a password, earning and spending Ember, Tanks and calls, TANKDAQ, your Mud Puppy, emails and your data.';
    const schemaOrg = {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: GROUPS.flatMap((g) => g.faqs).map((faq) => ({
            '@type': 'Question',
            name: faq.q,
            acceptedAnswer: { '@type': 'Answer', text: faq.a.map(plain).join(' ') },
        })),
    };
    const head = renderHead({ title, description, path: '/faq/', baseUrl, schemaOrg });

    return `<!DOCTYPE html>
<html lang="en">
<head>
    ${head}
    <style>${documentStyles()}
        .hc-faq-lede { font-size: 1rem !important; color: rgba(255, 255, 255, 0.88) !important; }
        /* .hc-doc prefix: has to out-rank the document card's own ul/li rules. */
        .hc-doc .hc-faq-jump { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 1.25rem 0 0; padding: 0; list-style: none; }
        .hc-doc .hc-faq-jump li { margin: 0; line-height: 1; }
        .hc-faq-jump a {
            display: inline-block; padding: 0.35rem 0.8rem; border-radius: 999px;
            border: 1px solid rgba(47, 230, 217, 0.45); background: rgba(47, 230, 217, 0.08);
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.7rem;
            letter-spacing: 0.06em; text-transform: uppercase; text-decoration: none;
        }
        .hc-faq-jump a:hover { background: rgba(47, 230, 217, 0.2); }

        .hc-faq-group { margin-top: 2.25rem; scroll-margin-top: 1rem; }
        .hc-faq-group h2 { color: var(--hc-gold); font-size: 1.3rem; margin: 0 0 0.6rem; }
        .hc-faq-item {
            margin-top: 0.6rem; border-radius: 14px;
            background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.12);
            transition: border-color 0.15s ease;
        }
        .hc-faq-item[open] { border-color: rgba(47, 230, 217, 0.5); background: rgba(47, 230, 217, 0.05); }
        .hc-faq-item > summary {
            display: flex; align-items: center; justify-content: space-between; gap: 1rem;
            cursor: pointer; list-style: none; padding: 0.85rem 1.1rem;
            font-family: 'Baloo 2', 'Nunito', sans-serif; font-weight: 800; font-size: 1.05rem;
            line-height: 1.3; color: #ffffff;
        }
        .hc-faq-item > summary::-webkit-details-marker { display: none; }
        .hc-faq-item > summary::after {
            content: '+'; flex-shrink: 0; color: var(--hc-teal);
            font-family: 'Montserrat', sans-serif; font-weight: 800; font-size: 1.2rem; line-height: 1;
        }
        .hc-faq-item[open] > summary::after { content: '\\2212'; }
        .hc-faq-item > summary:focus-visible { outline: 2px solid var(--hc-teal); outline-offset: 2px; border-radius: 14px; }
        .hc-faq-answer { padding: 0 1.1rem 1rem; }
        .hc-faq-answer p:first-child { margin-top: 0; }

        .hc-faq-more {
            margin-top: 2.5rem; padding: 1.1rem 1.25rem; border-radius: 14px; text-align: center;
            border: 1px solid rgba(255, 199, 44, 0.45); background: rgba(255, 199, 44, 0.08);
        }
        .hc-faq-more p { margin: 0; color: #ffffff; }
        .hc-faq-more a { color: var(--hc-gold); font-weight: 800; }
        @media print { .hc-faq-jump { display: none; } }
    </style>
</head>
<body>
    <main class="hc-page hc-page--doc">
        ${topbar('/beta/')}

        <article class="hc-doc" id="top">
            <p class="hc-doc-eyebrow">Help</p>
            <h1>Frequently asked questions</h1>
            <p class="hc-faq-lede">How Heatchecks works, in plain terms. Can’t find it here? <a href="/contact/">Get in touch</a>.</p>

            <ul class="hc-faq-jump" aria-label="Jump to a topic">
                ${GROUPS.map((g) => `<li><a href="#${g.id}">${escapeHtml(g.title)}</a></li>`).join('\n                ')}
            </ul>
            ${GROUPS.map((g, gi) => `
            <section class="hc-faq-group" id="${g.id}">
                <h2>${escapeHtml(g.title)}</h2>${g.faqs.map((faq, fi) => `
                <details class="hc-faq-item"${gi === 0 && fi === 0 ? ' open' : ''}>
                    <summary>${escapeHtml(faq.q)}</summary>
                    <div class="hc-faq-answer">${faq.a.map((p) => `<p>${inline(p)}</p>`).join('')}</div>
                </details>`).join('')}
            </section>`).join('')}

            <div class="hc-faq-more">
                <p>Still stuck? Write to <a href="mailto:support@heatchecks.io">support@heatchecks.io</a> or see the <a href="/contact/">contact page</a>.</p>
            </div>
            <a class="hc-doc-top" href="#top">&uarr; Back to top</a>
        </article>

        ${footer()}
    </main>
</body>
</html>`;
}
