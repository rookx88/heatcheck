// Renders emails/NewsletterIssue.tsx with fake data to a static HTML file for visual QA,
// per the newsletter build order's "static preview with fake data" step. For the
// interactive React Email dev server instead, use `npm run email:dev`.
//
// Run: npx tsx scripts/preview-newsletter-email.ts
// Then open scratch/newsletter-preview.html in a browser.

import fs from 'fs';
import path from 'path';
import { render } from '@react-email/render';
import NewsletterIssueEmail, { type NewsletterIssue } from '../emails/NewsletterIssue';

const fakeIssue: NewsletterIssue = {
    weekKey: '2026-W34',
    exclusiveTank: {
        slug: 'fake-exclusive-tank-prop',
        hook: 'He said he\'d never play a Game 7 in this building again. Tonight he has to.',
        pickUrl: 'https://heatchecks.io/newsletter-pick?token=fake&issue=fake',
    },
    thisWeek: 'Three calls settled correct, two settled incorrect. The board flipped twice on a ' +
        'last-second cover. New props are live in the app all week.',
    loreSpotlight: {
        title: 'The Rivalry That Started in a Parking Lot',
        body: 'Long before either team hung a banner, two head coaches got into it outside a ' +
            'preseason scrimmage over a parking spot. Neither team has forgotten a single meeting ' +
            'since.\n\nEvery matchup now carries that first grudge, whether the players on the floor ' +
            'know the story or not.',
    },
};

async function main() {
    const html = await render(NewsletterIssueEmail(fakeIssue));
    const outDir = path.join(process.cwd(), 'scratch');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'newsletter-preview.html');
    fs.writeFileSync(outPath, html);
    console.log(`Wrote preview to ${outPath}`);
}

main();
