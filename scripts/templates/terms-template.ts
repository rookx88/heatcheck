import { renderLegalDocument, type Part } from './legal-page';
import { TERMS_VERSION } from '../../lib/pages-functions/terms';

/**
 * /terms/ - the Terms of Service, linked from the shared footer().
 *
 * The document lives here as data rather than as hand-written HTML so a round of
 * attorney edits is a text change: every string below is the legal copy verbatim, with
 * three bits of inline markup the formatter understands - **bold**, *italic*, and
 * [square-bracket placeholders] that counsel still has to fill.
 *
 * IS_DRAFT is the one switch to flip at sign-off. While true the page carries a
 * "pending legal review" banner, highlights every unfilled placeholder, shows the
 * bracketed drafting notes, and is noindex (it is also deliberately absent from
 * sitemap.ts - add it there in the same change that flips this).
 */
const IS_DRAFT = false;

/**
 * Part II (the GM Card / NFT terms) is written but the GM Card has not launched, so it
 * stays out of the published page. While false: Part II is not rendered, the "two
 * parts" preamble is dropped, and the handful of Part I sentences that mention the GM
 * Card use their gm() alternate - a contract shouldn't lean on a term it never defines.
 * Flip to true at GM Card launch and the document is the original text again, word
 * for word.
 */
const INCLUDE_GM_CARD = false;

/** Pick the wording for a sentence that reads differently once GM Cards exist. */
const gm = (withGmCard: string, without: string): string => (INCLUDE_GM_CARD ? withGmCard : without);

// Derived from TERMS_VERSION (the version the welcome letter records at signing), so a
// new effective date and a new recorded version are one edit, never two.
const EFFECTIVE_DATE = new Date(`${TERMS_VERSION}T00:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
});
const LAST_UPDATED = 'September 17, 2026';

const INTRO: string[] = [
    'Welcome to Heatchecks. These Terms of Service ("Terms") are a legally binding agreement between you and Heatchecks ("Heatchecks," "we," "us," or "our") governing your access to and use of the Heatchecks website, applications, and services (collectively, the "Platform").',
    'By creating an account, accessing, or using the Platform, you acknowledge that you have read, understood, and agree to be bound by these Terms and our [Privacy Policy](/privacy/). If you do not agree, you may not use the Platform.',
];

const ARBITRATION_CALLOUT = 'These Terms contain a binding arbitration agreement and a class action waiver in Section 10 that affect how disputes between you and us are resolved.';

const STRUCTURE_NOTE = 'These Terms are organized in two parts: **Part I** applies to your general use of the Platform. **Part II** applies specifically if you purchase a Heatchecks GM Card (defined below). If there is any conflict between Part I and Part II regarding the GM Card, Part II controls.';

const ALL_PARTS: Part[] = [
    {
        id: 'part-1',
        label: 'Part I',
        title: 'General Terms of Service',
        sections: [
            {
                num: 1,
                title: 'Account Eligibility and Age Requirements',
                blocks: [
                    '**1.1 Minimum age.** The Platform is intended for users who are at least 18 years old. You may register for an account and use interactive features only if you are 18 or older (or the age of majority in your jurisdiction, if higher).',
                    '**1.2 No accounts for children under 13.** The Platform is a general-audience service and is not directed to children under 13. We do not knowingly create accounts for, or collect personal information from, children under 13 in violation of the Children\'s Online Privacy Protection Act (COPPA). If we learn that we have collected personal information from a child under 13 without required verifiable parental consent, we will delete it.',
                    { note: 'If Heatchecks elects to permit minors aged 13–17 to hold accounts, insert: *Minors aged 13–17 may use the Platform only under the supervision of a parent or legal guardian who agrees to these Terms on their behalf. Such minors may not ' + gm('purchase a GM Card or ', '') + 'make any real-money purchase.*' },
                    '**1.3 Real-money purchases restricted to adults.** Any real-money transaction on the Platform' + gm(', including purchase of a GM Card,', '') + ' requires the purchaser to be at least 18 and to represent that they are authorized to use the payment method provided.',
                    '**1.4 Account accuracy and security.** You agree to provide accurate registration information, keep it current, maintain the confidentiality of your login credentials, and accept responsibility for all activity under your account.',
                    '**1.5 One account per person; no automation.** You may not maintain multiple accounts to gain an unfair advantage in earning or spending Ember, and you may not use bots, scripts, or other automated means to access the Platform or accrue Ember.',
                ],
            },
            {
                num: 2,
                title: 'Ember — Virtual Currency',
                blocks: [
                    '**2.1 What Ember is.** "Ember" is a closed-loop, in-Platform virtual currency earned by engaging with content and making no-stakes predictions. Ember is provided for your personal entertainment only.',
                    '**2.2 No monetary value; not purchasable.** Ember has no monetary value and no equivalent value in real currency. Ember cannot be purchased with real money, cannot be exchanged for cash, and is not a substitute for currency, e-money, a gift card, stored value, or any bank instrument.',
                    '**2.3 Non-redeemable.** Ember cannot be redeemed, cashed out, withdrawn, or exchanged for money, prizes, goods, or anything of real-world value, inside or outside the Platform.',
                    '**2.4 Non-transferable.** Ember is personal to your account and cannot be sold, gifted, traded, transferred, or moved between users or accounts. We do not recognize and take no responsibility for any third-party service purporting to buy, sell, or transfer Ember; any such use violates these Terms and may result in forfeiture of Ember and suspension or termination of your account.',
                    '**2.5 Limited, revocable license; no ownership.** When you earn Ember, you receive only a limited, personal, non-transferable, revocable license to use Ember within the Platform in the ways we permit. You do not own Ember and acquire no property right or other enforceable interest in it. Your license to use Ember may end if you violate these Terms, if your account is suspended or terminated, or if the Platform or the Ember feature is discontinued.',
                    '**2.6 We may modify or discontinue Ember.** We may, at our discretion and to the extent permitted by law, manage, regulate, control, modify, revalue, cap, expire, or eliminate Ember and any items purchasable with Ember at any time, with or without notice, and we will have no liability to you for doing so.',
                    '**2.7 Ember spending.** Ember may be spent only on in-game items and features we make available (e.g., virtual pets, cosmetic items, and other in-game currency sinks). All such items are likewise licensed, not sold, have no monetary value, and are non-transferable and non-redeemable.',
                ],
            },
            {
                num: 3,
                title: 'No Real-Money Gambling; No Cash Prizes',
                blocks: [
                    '**3.1 No wagering.** The Platform is a free-to-play entertainment and prediction game. It does not offer, facilitate, or permit real-money gambling, wagering, betting, sports betting, or any activity in which real money or anything of real-world value is staked, risked, or won.',
                    '**3.2 No real money at risk.** Predictions on real-world sports outcomes are made using no-stakes mechanics. No real money is ever wagered, staked, deposited into a betting pool, or placed at risk based on the outcome of any prediction.',
                    '**3.3 No cash prizes.** No cash, cash equivalents, prizes, or items of real-world value are awarded based on the accuracy or outcome of any prediction.',
                    '**3.4 Not a sportsbook or sweepstakes.** The Platform is not a sportsbook, daily-fantasy operator, lottery, or sweepstakes. Because no prize of real-world value is offered, no purchase is ever necessary to participate, and no consideration is required to earn or use Ember.',
                    '**3.5 Informational only.** Sports data, odds-style figures, and narrative content are provided for entertainment and informational purposes and are not betting advice.',
                ],
            },
            {
                num: 4,
                title: 'User Conduct and Intellectual Property',
                blocks: [
                    '**4.1 License to use the Platform.** We grant you a personal, revocable, non-transferable, non-exclusive, limited license to access and use the Platform for lawful, personal, non-commercial purposes in accordance with these Terms.',
                    '**4.2 Our intellectual property.** We and our licensors retain all right, title, and interest in and to the Platform and all of its content, including all game assets, characters, artwork, world and narrative content, ' + gm('GM Card artwork and traits, ', '') + 'software, trademarks, logos, and designs (collectively, "Heatchecks IP"). Except for the limited licenses expressly granted in these Terms, no rights are transferred to you.',
                    '**4.3 Prohibited conduct.** You agree not to: (a) violate any law; (b) infringe another\'s rights; (c) cheat, exploit, or manipulate the Ember economy or prediction mechanics; (d) use bots or scrapers; (e) reverse engineer the Platform; (f) resell or commercialize any part of the Platform without authorization; (g) harass other users; or (h) upload unlawful, infringing, or harmful content. You agree not to use the Platform to exploit or harm minors in any way.',
                    '**4.4 User-generated content.** If the Platform permits you to post content ("User Content"), you retain ownership of your User Content but grant us a worldwide, non-exclusive, royalty-free, sublicensable license to host, store, reproduce, modify, adapt, publish, translate, publicly display, and distribute your User Content in connection with operating and promoting the Platform. You represent that you have the rights to grant this license and that your User Content does not infringe third-party rights or violate law.',
                ],
            },
            {
                num: 5,
                title: 'Disclaimer of Warranties',
                blocks: [
                    { caps: 'THE PLATFORM AND ALL CONTENT, EMBER, ' + gm('VIRTUAL ITEMS, AND GM CARDS', 'AND VIRTUAL ITEMS') + ' ARE PROVIDED "AS IS" AND "AS AVAILABLE," WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS, IMPLIED, OR STATUTORY, INCLUDING IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE PLATFORM WILL BE UNINTERRUPTED, SECURE, ERROR-FREE, OR THAT ANY ' + gm('FEATURE, EMBER, OR GM CARD UTILITY', 'FEATURE OR EMBER') + ' WILL REMAIN AVAILABLE. SOME JURISDICTIONS DO NOT ALLOW CERTAIN WARRANTY EXCLUSIONS, SO SOME OF THE ABOVE MAY NOT APPLY TO YOU.' },
                ],
            },
            {
                num: 6,
                title: 'Limitation of Liability',
                blocks: [
                    { caps: 'TO THE FULLEST EXTENT PERMITTED BY LAW, IN NO EVENT WILL HEATCHECKS OR ITS AFFILIATES, OFFICERS, EMPLOYEES, OR LICENSORS BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, OR ANY LOSS OF PROFITS, DATA, GOODWILL, ' + gm('EMBER, VIRTUAL ITEMS, OR GM CARD VALUE', 'EMBER, OR VIRTUAL ITEMS') + ', ARISING OUT OF OR RELATING TO THESE TERMS OR THE PLATFORM. OUR TOTAL AGGREGATE LIABILITY FOR ALL CLAIMS WILL NOT EXCEED THE GREATER OF (A) THE AMOUNT YOU ACTUALLY PAID US IN THE 12 MONTHS BEFORE THE CLAIM, OR (B) USD $100. BECAUSE EMBER HAS NO MONETARY VALUE, WE HAVE NO LIABILITY FOR ANY LOSS, REDUCTION, OR REMOVAL OF EMBER.' },
                ],
            },
            {
                num: 7,
                title: 'Indemnification',
                blocks: [
                    'You agree to defend, indemnify, and hold harmless Heatchecks and its affiliates, officers, directors, employees, licensors, and agents from and against any claims, damages, losses, liabilities, costs, and expenses (including reasonable attorneys\' fees) arising out of or relating to: your use of the Platform; your User Content; your violation of these Terms; ' + gm('your violation of any law or third-party right; or your purchase, use, or transfer of a GM Card', 'or your violation of any law or third-party right') + '.',
                ],
            },
            {
                num: 8,
                title: 'Term and Termination',
                blocks: [
                    '**8.1 Your rights.** You may stop using the Platform and close your account at any time.',
                    '**8.2 Our rights.** We may suspend, restrict, or terminate your account or access, and/or void or remove Ember and virtual items, at any time, with or without notice, for any reason, including if we reasonably believe you have violated these Terms or engaged in fraud or abuse.',
                    '**8.3 Effect of termination.** Upon termination, your licenses (including your license to use Ember and virtual items) end and any Ember and virtual items are forfeited without compensation. Sections relating to intellectual property, disclaimers, limitation of liability, indemnification, and dispute resolution survive termination.' + gm(' Termination of your Platform account does not, by itself, transfer or destroy any GM Card you hold in your own external wallet, but may terminate the in-game utility associated with it.', ''),
                ],
            },
            {
                num: 9,
                title: 'Governing Law',
                blocks: [
                    'These Terms are governed by the laws of the State of California, without regard to conflict-of-laws principles, and applicable U.S. federal law. The Federal Arbitration Act governs the interpretation and enforcement of the arbitration provisions in Section 10.',
                ],
            },
            {
                num: 10,
                title: 'Dispute Resolution — Arbitration and Class Action Waiver',
                blocks: [
                    '**10.1 Informal resolution first.** Before starting arbitration, you agree to contact us at support@heatchecks.io and attempt to resolve the dispute informally for at least 60 days.',
                    '**10.2 Binding individual arbitration.** Except for qualifying small-claims matters and claims for injunctive relief to protect intellectual property, any dispute arising out of or relating to these Terms or the Platform will be resolved by final and binding individual arbitration administered by the American Arbitration Association (AAA) under its applicable rules, rather than in court.',
                    { caps: '**10.3 CLASS ACTION WAIVER.** ANY ARBITRATION OR PROCEEDING WILL BE CONDUCTED ONLY ON AN INDIVIDUAL BASIS. YOU AND HEATCHECKS EACH WAIVE THE RIGHT TO A JURY TRIAL AND THE RIGHT TO PARTICIPATE AS A PLAINTIFF OR CLASS MEMBER IN ANY CLASS, COLLECTIVE, OR REPRESENTATIVE ACTION.' },
                    // An open suggestion from counsel, not an adopted term: the heading goes
                    // with its note, so a final page never shows an empty 10.4.
                    ...(IS_DRAFT ? [
                        '**10.4 Opt-out right.**',
                        { note: 'Consider including: you may opt out of this arbitration agreement by sending written notice to [address/email] within 30 days of first accepting these Terms.' },
                    ] : []),
                ],
            },
            {
                num: 11,
                title: 'Modifications to These Terms',
                blocks: [
                    'We may modify these Terms from time to time. If we make material changes, we will provide reasonable notice — for example, by posting the updated Terms with a new "Last Updated" date and/or by in-Platform or email notice. Changes are effective on the date posted unless otherwise stated. Your continued use of the Platform after changes take effect constitutes your acceptance of the revised Terms. If you do not agree, you must stop using the Platform.',
                ],
            },
        ],
    },
    {
        id: 'part-2',
        label: 'Part II',
        title: 'GM Card Terms',
        sections: [
            {
                num: 12,
                title: 'Scope of This Part',
                blocks: [
                    'This Part II applies specifically to the purchase, ownership, and use of a Heatchecks "GM Card" (General Manager card), a modular, trait-based generative digital-art collection sold for real money or cryptocurrency ("GM Card"). The GM Card is separate and distinct from Ember: Ember cannot be used to purchase a GM Card, and a GM Card cannot be redeemed for Ember, cash, or any prize.',
                ],
            },
            {
                num: 13,
                title: 'What Your Purchase Grants and Does Not Grant',
                blocks: [
                    '**13.1 What you get.** A GM Card is a non-fungible token recorded on [blockchain] associated with a piece of generative, trait-based digital artwork. Your purchase gives you: (a) ownership of the specific token as recorded on the blockchain; (b) a limited license to the associated artwork as described in Section 17; and (c) access to specific in-game utility — a franchise/team-management feature set within Heatchecks — as described in Section 16.',
                    '**13.2 What you do not get.** Your purchase of a GM Card does **not** grant: any equity, shares, or ownership interest in [Company Legal Name] or its business; any revenue share, royalty, dividend, or profit participation; any voting or governance rights in the company; any debt or financial instrument; any guaranteed or permanent set of features or perks; or any promise, representation, or guarantee of resale value, future value, price appreciation, return, or profit.',
                    '**13.3 Purpose of purchase.** By purchasing a GM Card, you represent that you are acquiring it for personal use, collection, and enjoyment, and to access its in-game utility — not as an investment or for a speculative purpose.',
                ],
            },
            {
                num: 14,
                title: 'No Investment; No Expectation of Profit or Appreciation',
                blocks: [
                    '**14.1** A GM Card is a digital collectible and access credential. It is **not** an investment, security, financial product, or a share, note, or interest in any common enterprise.',
                    '**14.2** We make **no** representation, promise, or guarantee that a GM Card has, will retain, or will increase in value. Digital-asset prices are volatile and subjective, and a GM Card may lose all value. You assume all risk associated with acquiring, holding, and disposing of a GM Card.',
                    '**14.3** Nothing on the Platform or in our marketing is or should be construed as investment, financial, legal, or tax advice, or as an offer or solicitation of a security in any jurisdiction. We do not give advice or recommendations regarding any investment strategy related to the GM Card.',
                    '**14.4** You acknowledge that any expectation of profit you may form is your own, is not based on any promise by us, and is not derived from the managerial or entrepreneurial efforts of Heatchecks.',
                ],
            },
            {
                num: 15,
                title: 'Blockchain and Digital Asset Risks',
                blocks: [
                    'By purchasing or holding a GM Card, you acknowledge and accept the following risks, for which we are not responsible:',
                    '**15.1 Irreversibility.** Blockchain transactions are generally irreversible once confirmed. Losses from fraudulent, mistaken, or accidental transactions may be unrecoverable.',
                    '**15.2 Wallet and private-key custody.** You are solely responsible for the security of your wallet, private keys, seed phrases, and credentials. We do not hold your keys and cannot recover lost, stolen, or compromised keys, wallets, or GM Cards.',
                    '**15.3 Smart-contract risk.** Smart contracts, blockchains, and related software may contain bugs, vulnerabilities, or be subject to hacks, exploits, forks, or failures. We do not warrant that the smart contract or blockchain will operate without error.',
                    '**15.4 Network fees.** You are responsible for all applicable transaction ("gas") and network fees.',
                    '**15.5 Cryptocurrency volatility.** The value of any cryptocurrency used to purchase a GM Card is volatile and outside our control.',
                    '**15.6 Regulatory risk.** The regulatory regime for NFTs, blockchain, and cryptocurrencies is evolving and uncertain. New laws, regulations, or enforcement actions may adversely affect the GM Card, its utility, its value, or our ability to offer related services, and we may modify or cease NFT-related services if it becomes unlawful or commercially impracticable to continue.',
                ],
            },
            {
                num: 16,
                title: 'In-Game Utility',
                blocks: [
                    '**16.1 Utility.** Ownership of a GM Card grants access to the Heatchecks franchise/team-management feature set and any other perks we designate for holders, subject to these Terms.',
                    '**16.2 Utility is not guaranteed and may change.** The form, nature, and availability of a GM Card\'s utility and perks may change over time. We may add, modify, suspend, limit, or discontinue any utility or perk. We will provide [reasonable/advance] notice of any material adverse change or discontinuation of utility via [in-Platform notice and/or email], except where changes are required by law, security, or exigent circumstances.',
                    '**16.3 No dependence for value.** Because utility may change, you should not purchase a GM Card in expectation of any particular perk persisting indefinitely, and no perk constitutes a promise of value or return.',
                ],
            },
            {
                num: 17,
                title: 'Intellectual Property in the GM Artwork',
                blocks: [
                    '**17.1 You own the token; we own the IP.** You own the GM Card token itself. We (and our licensors) retain all copyright and other intellectual property rights in and to the underlying artwork, traits, characters, and all Heatchecks IP. Purchasing a GM Card does not transfer any copyright or IP ownership to you.',
                    '**17.2 License granted to holders.** For as long as you lawfully own a GM Card, we grant you a worldwide, non-exclusive, non-sublicensable, limited license to use, copy, and display the artwork associated solely with your GM Card for your personal, non-commercial purposes, and as necessary to list and effectuate a lawful resale or transfer of that GM Card.',
                    '**17.3 Restrictions.** This license does not include the Heatchecks name, logos, or trademarks, or any trait, character, or artwork other than the specific art associated with your GM Card. Unless we expressly authorize it in writing, you may not use the artwork for any commercial purpose, create derivative works, or use it in connection with unlawful, hateful, or infringing content.',
                    '**17.4 Termination of license on transfer.** Your artwork license terminates automatically when you no longer own the GM Card.',
                ],
            },
            {
                num: 18,
                title: 'Secondary Market',
                blocks: [
                    '**18.1 We do not control secondary markets.** GM Cards may be resold on third-party marketplaces we neither operate nor control. We do not endorse, guarantee, or take responsibility for any third-party marketplace, and any purchase or sale you make outside the Platform is entirely at your own risk.',
                    '**18.2 No guarantee of market or price.** We do not guarantee the existence, liquidity, continuity, or price of any secondary market for GM Cards, or that any GM Card can be resold or will command any particular price.',
                    '**18.3 Resale royalty.**',
                    { note: 'If applicable, disclose the exact percentage and mechanism here.' },
                    '**18.4 Utility reservation.** We reserve the right to modify or discontinue the in-game utility associated with GM Cards as set out in Section 16; secondary-market participants acquire GM Cards subject to that reservation.',
                ],
            },
            {
                num: 19,
                title: 'Geographic and Regulatory Eligibility',
                blocks: [
                    '**19.1 Eligibility.** You may purchase a GM Card only if you are at least 18, are legally permitted to do so in your jurisdiction, and are not located in or a resident of any jurisdiction where the purchase or holding of NFTs or cryptocurrency is prohibited or restricted.',
                    '**19.2 Sanctions and anti-money-laundering.** You represent that you are not subject to sanctions or listed on any U.S. or applicable government restricted-party or Specially Designated Nationals list, and that you will not use the GM Card for money laundering, terrorist financing, or other unlawful activity.',
                    '**19.3 Jurisdictional restrictions.** We may restrict or refuse sales to users in certain jurisdictions (including certain U.S. states) at our discretion to comply with securities, money-transmission, consumer-protection, or other laws, and we may implement identity-verification or anti-money-laundering checks where required.',
                ],
            },
            {
                num: 20,
                title: 'Taxes',
                blocks: [
                    'You are solely responsible for determining and paying any and all taxes (including sales, use, value-added, income, capital gains, and other taxes or duties) arising from your purchase, ownership, use, sale, transfer, or other disposition of a GM Card. We are not responsible for withholding or reporting your taxes, and nothing here is tax advice.',
                ],
            },
            {
                num: 21,
                title: 'Additional Disclaimers',
                blocks: [
                    'All disclaimers, limitations of liability, and indemnification obligations in Sections 5–7 apply fully to the GM Card. By purchasing a GM Card, you acknowledge that you have read and understood Sections 12–20, that the GM Card is a collectible and utility item and not an investment, and that you assume all risks of purchasing and holding it.',
                ],
            },
        ],
    },
];

const CONTACT = 'Questions about these Terms may be directed to support@heatchecks.io.';

export function generateTermsPageHtml(baseUrl: string): string {
    return renderLegalDocument({
        path: '/terms/',
        title: 'Terms of Service | Heatchecks',
        description: 'The Heatchecks Terms of Service: account eligibility, how Ember works (free, no cash value, no gambling), conduct, and dispute resolution.',
        heading: 'Terms of Service',
        effectiveDate: EFFECTIVE_DATE,
        lastUpdated: LAST_UPDATED,
        isDraft: IS_DRAFT,
        draftNoun: 'These Terms are',
        intro: INTRO,
        callout: ARBITRATION_CALLOUT,
        afterCallout: INCLUDE_GM_CARD ? [STRUCTURE_NOTE] : [],
        parts: INCLUDE_GM_CARD ? ALL_PARTS : ALL_PARTS.slice(0, 1),
        contact: CONTACT,
    }, baseUrl);
}
