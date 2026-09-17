import { renderHead, topbar, footer } from './waitlist-landing-template';
import { documentStyles } from './legal-page';
import { DISCORD_INVITE } from './faq-template';

/**
 * /contact/ - two inboxes, no form. A form would need an endpoint, spam handling and a
 * place to read submissions; mailto: needs none of that and the reply lands in a real
 * thread. Both addresses are Cloudflare Email Routing rules on heatchecks.io - an
 * address added here has to exist there first, or it bounces.
 */
const CHANNELS = [
    {
        id: 'support',
        label: 'Players',
        title: 'Support',
        email: 'support@heatchecks.io',
        blurb: 'Trouble signing in, a call that settled wrong, a missing pet or Ember, a bug, or a question about your account or your data.',
        tip: 'Write from the email you play with, and include your username and the page you were on — it lets us find the problem without a back-and-forth.',
    },
    {
        id: 'partnerships',
        label: 'Business',
        title: 'Partnerships',
        email: 'partnerships@heatchecks.io',
        blurb: 'Creators, communities and Discord servers, leagues and teams, sponsors, press and anyone who wants to build something with Heatchecks.',
        tip: 'Tell us who you are and what you have in mind. A link to your community or work helps.',
    },
];

export function generateContactPageHtml(baseUrl: string): string {
    const title = 'Contact Us | Heatchecks';
    const description = 'Get in touch with Heatchecks: support@heatchecks.io for help with your account, and partnerships@heatchecks.io for creators, communities, sponsors and press.';
    const schemaOrg = {
        '@context': 'https://schema.org',
        '@type': 'ContactPage',
        name: 'Contact Heatchecks',
        url: `${baseUrl}/contact/`,
        mainEntity: {
            '@type': 'Organization',
            name: 'HeatChecks',
            url: baseUrl,
            contactPoint: [
                { '@type': 'ContactPoint', contactType: 'customer support', email: 'support@heatchecks.io', availableLanguage: 'English' },
                { '@type': 'ContactPoint', contactType: 'partnerships', email: 'partnerships@heatchecks.io', availableLanguage: 'English' },
            ],
        },
    };
    const head = renderHead({ title, description, path: '/contact/', baseUrl, schemaOrg });

    return `<!DOCTYPE html>
<html lang="en">
<head>
    ${head}
    <style>${documentStyles()}
        .hc-contact-lede { font-size: 1rem !important; color: rgba(255, 255, 255, 0.88) !important; }
        .hc-contact-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-top: 1.5rem; }
        .hc-contact-card {
            display: flex; flex-direction: column;
            padding: 1.35rem 1.25rem 1.4rem; border-radius: 16px;
            background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(47, 230, 217, 0.35);
        }
        .hc-contact-card--partnerships { border-color: rgba(255, 199, 44, 0.45); }
        .hc-contact-label {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.68rem !important;
            letter-spacing: 0.14em; text-transform: uppercase; color: var(--hc-teal) !important; margin: 0 !important;
        }
        .hc-contact-card--partnerships .hc-contact-label { color: var(--hc-gold) !important; }
        .hc-contact-card h2 { margin-top: 0.1rem; }
        .hc-contact-card p { font-size: 0.9rem; line-height: 1.55; }
        .hc-contact-card .hc-contact-tip { font-size: 0.82rem; color: rgba(255, 255, 255, 0.6); }
        .hc-contact-spacer { flex: 1; min-height: 1rem; }
        /* The address is the button: readable and copyable as text, tappable as mailto. */
        .hc-doc a.hc-contact-email {
            display: block; text-align: center; padding: 0.7rem 0.75rem; border-radius: 12px;
            background: var(--hc-teal); color: #06231f;
            font-family: 'Baloo 2', 'Nunito', sans-serif; font-weight: 800; font-size: 0.98rem;
            text-decoration: none; overflow-wrap: anywhere;
            box-shadow: 0 4px 0 rgba(20, 150, 140, 0.9);
        }
        .hc-doc .hc-contact-card--partnerships a.hc-contact-email {
            background: var(--hc-gold); color: #1a1200; box-shadow: 0 4px 0 var(--hc-gold-dark);
        }
        .hc-doc a.hc-contact-email:hover { color: inherit; filter: brightness(1.08); }
        .hc-doc a.hc-contact-email:active { transform: translateY(2px); box-shadow: none; }

        .hc-contact-first { margin-top: 2.25rem; }
        .hc-contact-first h2 { font-size: 1.2rem; }
        @media (max-width: 620px) { .hc-contact-grid { grid-template-columns: 1fr; } }
    </style>
</head>
<body>
    <main class="hc-page hc-page--doc">
        ${topbar('/beta/')}

        <article class="hc-doc" id="top">
            <p class="hc-doc-eyebrow">Get in touch</p>
            <h1>Contact us</h1>
            <p class="hc-contact-lede">A real person reads every message. Pick the inbox that fits and we’ll get back to you as soon as we can.</p>

            <div class="hc-contact-grid">${CHANNELS.map((c) => `
                <section class="hc-contact-card hc-contact-card--${c.id}" aria-labelledby="contact-${c.id}">
                    <p class="hc-contact-label">${c.label}</p>
                    <h2 id="contact-${c.id}">${c.title}</h2>
                    <p>${c.blurb}</p>
                    <p class="hc-contact-tip">${c.tip}</p>
                    <div class="hc-contact-spacer"></div>
                    <a class="hc-contact-email" href="mailto:${c.email}">${c.email}</a>
                </section>`).join('')}
            </div>

            <section class="hc-contact-first">
                <h2>Before you write</h2>
                <ul>
                    <li><strong>Quick answers</strong> — how Ember, calls, TANKDAQ and pets work is covered in the <a href="/faq/">FAQ</a>.</li>
                    <li><strong>Want to talk to other players?</strong> Join the <a href="${DISCORD_INVITE}" rel="noopener">Heatchecks Discord</a>.</li>
                    <li><strong>Too many emails?</strong> Every results email and newsletter has a one-click unsubscribe, and all the switches are on your <a href="/account/?tab=notifications">account page</a>.</li>
                    <li><strong>Deleting your account</strong> is self-serve, from the Security tab of your <a href="/account/">account page</a> — no need to wait on us.</li>
                    <li><strong>Privacy requests and legal notices</strong> go to <a href="mailto:support@heatchecks.io">support@heatchecks.io</a>. See our <a href="/privacy/">Privacy Policy</a> and <a href="/terms/">Terms of Service</a>.</li>
                </ul>
            </section>
        </article>

        ${footer()}
    </main>
</body>
</html>`;
}
