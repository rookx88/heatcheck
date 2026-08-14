// One-off script: creates the Resend Audience newsletter subscribers get synced into.
// Run once, then store the printed id as RESEND_AUDIENCE_ID (wrangler pages secret put,
// plus local .env for backend.ts/scripts). Safe to re-run - Resend has no "get audience
// by name" lookup, so re-running this creates a second audience rather than erroring;
// don't re-run once an id is already in use.
//
// Run: npx tsx scripts/create-resend-audience.ts

import dotenv from 'dotenv';
dotenv.config();

async function main() {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
        console.error('RESEND_API_KEY is not set.');
        process.exit(1);
    }

    const res = await fetch('https://api.resend.com/audiences', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Heatchecks Newsletter' }),
    });

    if (!res.ok) {
        console.error(`Resend API error: ${res.status} ${await res.text()}`);
        process.exit(1);
    }

    const audience = await res.json() as { id: string; name: string };
    console.log(`Created Resend Audience "${audience.name}" (${audience.id})`);
    console.log('Set this as RESEND_AUDIENCE_ID:');
    console.log(`  wrangler pages secret put RESEND_AUDIENCE_ID`);
    console.log('and add the same value to your local .env for backend.ts/scripts.');
}

main();
