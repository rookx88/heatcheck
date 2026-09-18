import { renderLegalDocument, type Part } from './legal-page';

/**
 * /privacy/ - the Privacy Policy, linked from the shared footer() and from the Terms.
 * Same document-as-data arrangement as terms-template.ts; see legal-page.ts.
 *
 * A privacy policy has to describe what the code actually does, so when any of these
 * change, change the matching section in the same commit:
 *   - what identifies a person: email (magic link, no passwords), optional Discord link
 *   - the session cookie (lib/pages-functions/session.ts) and the first-party analytics
 *     id (tank-analytics-client.ts -> /api/track)
 *   - processors: Cloudflare, Neon, Resend, Discord; Polymarket is read-only
 *   - deletion: functions/api/account/delete.ts de-identifies the row immediately
 *     (Section 5's window is the outer bound, not the usual case)
 */
const IS_DRAFT = false;

/**
 * Part B (the GM Card NFT data addendum) is written but, in its own words, "not yet
 * active". While false it is not rendered and the intro's "two parts" sentences are
 * dropped - the same switch, for the same reason, as INCLUDE_GM_CARD in the Terms.
 * Flip both together at GM Card launch.
 */
const INCLUDE_GM_CARD = false;

const EFFECTIVE_DATE = 'September 17, 2026';
const LAST_UPDATED = 'September 17, 2026';

const INTRO_BASE = 'This Privacy Policy explains what information Heatchecks ("Heatchecks," "we," "us," or "our") collects, how we use it, and the choices you have, in connection with your use of the Heatchecks website and services (the "Platform").';
const INTRO_PARTS = ' This policy is organized in two parts: **Part A** covers our current, live platform. **Part B** is a separate addendum covering the Heatchecks "GM Card" NFT collection and does not apply yet — it will be activated and you will be notified when the GM Card becomes available for purchase.';

const ALL_PARTS: Part[] = [
    {
        id: 'part-a',
        label: 'Part A',
        title: 'Current Platform Privacy Practices',
        sections: [
            {
                num: 1,
                title: 'Information We Collect',
                blocks: [
                    '**1.1 Information you provide directly.**',
                    { list: [
                        '**Email address** — required to create an account and receive your sign-in link ("magic link"). We do not use or store passwords.',
                        '**Discord information (optional)** — if you choose to link or sign in with Discord, we receive your Discord user ID, username, and (if made available by Discord) a verified email address.',
                        '**Username and agreement record** — the username you choose when you sign the welcome letter, and the date and version of the Terms of Service and Privacy Policy you agreed to at that time.',
                        '**Communications** — if you contact us for support, we retain that correspondence.',
                    ] },
                    '**1.2 Information collected automatically.**',
                    { list: [
                        '**Device and log data** — IP address, browser type, and standard request logs, collected through our hosting infrastructure (Cloudflare) as part of normal web traffic handling and security.',
                        '**Session data** — a signed session cookie that keeps you logged in. This cookie is functional only; we do not use advertising or cross-site tracking cookies.',
                        '**Gameplay and account activity** — the picks you make, prediction outcomes, your Ember balance and transaction history, pet-related interactions, and similar in-Platform activity, tied to your account so the Platform can function (e.g., enforcing daily limits, calculating Ember, displaying your history).',
                    ] },
                    '**1.3 What we do not collect.** We do not collect payment card information (we do not process real-money payments on the Platform today), government ID numbers, precise geolocation, or biometric data.',
                ],
            },
            {
                num: 2,
                title: 'How We Use Information',
                blocks: [
                    'We use the information above to: operate and maintain your account and the Ember economy; authenticate you via magic-link or Discord sign-in; send you transactional emails (e.g., sign-in links, settlement notifications) and, if you opt in, our newsletter; understand how the Platform is used so we can improve it; maintain security and prevent abuse (e.g., detecting multiple-account or automation abuse); and communicate with you if you contact us.',
                ],
            },
            {
                num: 3,
                title: 'Who We Share Information With',
                blocks: [
                    'We do not sell your personal information. We share limited information with the following service providers, solely to operate the Platform:',
                    { list: [
                        '**Cloudflare** — hosting, content delivery, and security infrastructure.',
                        '**Neon** — our database provider, which stores your account and gameplay data.',
                        '**Resend** — our email delivery provider, used to send sign-in links, transactional notifications, and (if you opt in) our newsletter.',
                        '**Discord** — if you choose to link or sign in with Discord, Discord processes that authentication under its own privacy policy; we receive only your Discord user ID, username, and (if available) verified email.',
                    ] },
                    'We also use Polymarket\'s publicly available market-data feeds to display real sports odds and outcomes on the Platform. This is a one-way, read-only data fetch — we do not send any of your personal information to Polymarket, and no user data is shared in this process.',
                    'We may also disclose information if required by law, to protect the rights, property, or safety of Heatchecks or others, or in connection with a merger, acquisition, or sale of business assets (in which case we will provide notice before your information becomes subject to a different privacy policy).',
                ],
            },
            {
                num: 4,
                title: 'Cookies and Tracking',
                blocks: [
                    // Counsel's draft said "a basic analytics cookie". The site sets no such
                    // cookie: tank-analytics-client.ts keeps a random id in localStorage and
                    // verify-email.ts / login link it to the account at sign-in. Worded to match.
                    'We use a functional session cookie to keep you signed in. To understand how the Platform is used, we also run our own first-party analytics: a randomly generated identifier is stored in your browser\'s local storage (not a cookie) and sent with page-view and in-Platform activity events to our own servers. It is not shared with any third party or advertising network, and it is associated with your account once you sign in. You can remove it at any time by clearing your browser\'s site data for heatchecks.io. We do not currently use advertising cookies, cross-site tracking pixels, or third-party ad networks. If this changes in the future, we will update this policy and provide any disclosures or choices required by law at that time.',
                ],
            },
            {
                num: 5,
                title: 'Data Retention',
                blocks: [
                    'We retain your account information and gameplay history for as long as your account is active. If you delete your account, we will delete or de-identify your personal information within 30 days, except where we are required to retain certain records for security, fraud-prevention, or legal purposes.',
                ],
            },
            {
                num: 6,
                title: 'Children\'s Privacy',
                blocks: [
                    'The Platform is a general-audience service and is not directed to children under 13. We do not knowingly collect personal information from children under 13. If we learn that we have collected personal information from a child under 13 without verifiable parental consent, we will delete it promptly. If you believe a child under 13 has provided us with personal information, please contact us at support@heatchecks.io so we can address it.',
                    { note: 'If Heatchecks permits supervised accounts for users aged 13–17, consistent with the Terms of Service, note here that such use requires a parent or guardian\'s consent and that real-money features are unavailable to users under 18.' },
                ],
            },
            {
                num: 7,
                title: 'Data Security',
                blocks: [
                    'We use reasonable administrative, technical, and organizational measures designed to protect your information, including relying on established infrastructure providers (Cloudflare, Neon) with their own security practices. No method of transmission or storage is completely secure, and we cannot guarantee absolute security. We do not currently hold specific third-party security certifications, and we do not claim to.',
                ],
            },
            {
                num: 8,
                title: 'Your Choices and Rights',
                blocks: [
                    'Regardless of where you live, you may contact us at support@heatchecks.io to: request a copy of the personal information we hold about you; request that we correct inaccurate information; request that we delete your account and associated personal information; or opt out of the newsletter (a link is included in every newsletter email). We will respond to verified requests within a reasonable time, generally within 45 days.',
                    // The draft pointed at an internal scoping note ("see scoping note above")
                    // that is not part of the published policy, so the pointer is dropped.
                    '*California residents:* Because Heatchecks does not currently meet the CCPA\'s statutory thresholds for a "covered business", the formal CCPA-specific mechanisms (e.g., a dedicated "Do Not Sell or Share My Personal Information" link, Global Privacy Control signal recognition) are not yet required and are not implemented. California residents may still exercise the general rights described in this section by contacting us directly. **This section will be revisited and expanded with legal counsel if and when Heatchecks\' revenue or user base approaches the CCPA\'s applicability thresholds.**',
                ],
            },
            {
                num: 9,
                title: 'International Users',
                blocks: [
                    'The Platform is intended primarily for users in the United States, and our servers and service providers are located in the United States. If you access the Platform from outside the United States, you understand that your information will be transferred to and processed in the United States.',
                ],
            },
            {
                num: 10,
                title: 'Changes to This Policy',
                blocks: [
                    'We may update this Privacy Policy from time to time. If we make material changes, we will provide reasonable notice — for example, by posting the updated policy with a new "Last Updated" date and/or by in-Platform or email notice. Your continued use of the Platform after changes take effect constitutes your acceptance of the revised policy.',
                ],
            },
            {
                num: 11,
                title: 'Contact Us',
                blocks: [
                    'Questions about this Privacy Policy, or requests regarding your information, may be directed to support@heatchecks.io.',
                ],
            },
        ],
    },
    {
        id: 'part-b',
        label: 'Part B',
        title: 'GM Card NFT Data Addendum',
        sections: [
            {
                num: 12,
                title: 'Additional Information Collected for GM Card Purchases',
                blocks: [
                    'When the GM Card becomes available, purchasing one will require us to collect additional information not described in Part A, including: your blockchain wallet address; transaction and payment information processed through our payment processor and/or crypto on-ramp [vendor to be named at activation]; and, if required for geographic or sanctions-eligibility screening consistent with our Terms of Service, limited identity-verification information.',
                ],
            },
            {
                num: 13,
                title: 'Blockchain Transparency',
                blocks: [
                    'Blockchain transactions, including wallet addresses and the transfer history of a GM Card, are recorded on a public, permanent ledger outside our control. This information may be publicly visible to anyone, indefinitely, regardless of any request you make to us to delete your account or personal information. We cannot delete, alter, or control information once it is recorded on the blockchain.',
                ],
            },
            {
                num: 14,
                title: 'Payment Processor / Wallet-Connection Data Sharing',
                blocks: [
                    { note: 'To be completed at activation, once a specific payment processor and/or wallet-connection provider is chosen.' },
                    'We will share the minimum information necessary with our payment processor and/or wallet-connection provider to complete your purchase. That provider\'s own privacy policy will govern its handling of your payment information.',
                ],
            },
            {
                num: 15,
                title: 'Retention of Financial/Transaction Data',
                blocks: [
                    'We will retain real-money and cryptocurrency transaction records for as long as required by applicable tax, accounting, and anti-money-laundering laws, which may be longer than the retention period described in Part A for general account data.',
                ],
            },
        ],
    },
];

export function generatePrivacyPageHtml(baseUrl: string): string {
    return renderLegalDocument({
        path: '/privacy/',
        title: 'Privacy Policy | Heatchecks',
        description: 'What Heatchecks collects (an email, your gameplay, an optional Discord link), how it is used, who processes it, and how to get a copy or delete your account. We do not sell personal information.',
        heading: 'Privacy Policy',
        effectiveDate: EFFECTIVE_DATE,
        lastUpdated: LAST_UPDATED,
        isDraft: IS_DRAFT,
        draftNoun: 'This policy is',
        intro: [INTRO_BASE + (INCLUDE_GM_CARD ? INTRO_PARTS : '')],
        callout: 'We do not sell your personal information, and we do not use advertising or cross-site tracking cookies.',
        parts: INCLUDE_GM_CARD ? ALL_PARTS : ALL_PARTS.slice(0, 1),
        contact: 'Questions about this Privacy Policy may be directed to support@heatchecks.io. See also our [Terms of Service](/terms/).',
    }, baseUrl);
}
