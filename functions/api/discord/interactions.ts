// POST /api/discord/interactions - Discord's Interactions Endpoint URL. Every request
// must be Ed25519-verified BEFORE the body is trusted at all (verifyDiscordRequest),
// using the exact raw body bytes Discord signed - hence reading text() first rather
// than json(). Discord also requires this endpoint to answer a bare PING with a PONG
// before it will even save the URL in the Developer Portal (see the plan's setup
// steps), so that has to work standalone with no other config in place yet.
//
// The only real interaction handled is a MESSAGE_COMPONENT button click on a Tank
// post from functions/api/discord-sweep.ts, custom_id "pick:<slug>:<sideIndex>". The
// clicking Discord user is resolved to a Heatchecks account via discord_links (set by
// the /api/discord/link + /api/discord/callback OAuth flow) and the pick runs through
// the exact same lib/pages-functions/picks.ts#submitPick the website itself uses -
// same daily cap, same per-Tank conflict, same odds/kickoff validation.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, type Env } from '../../../lib/pages-functions/db';
import { verifyDiscordRequest } from '../../../lib/pages-functions/discord-verify';
import { submitPick, type SubmitPickResult } from '../../../lib/pages-functions/picks';

const DISCORD_PING = 1;
const DISCORD_MESSAGE_COMPONENT = 3;
const RESPONSE_PONG = 1;
const RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE = 4;
const EPHEMERAL_FLAG = 64;

function ephemeral(content: string): Response {
    return new Response(
        JSON.stringify({ type: RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE, data: { content, flags: EPHEMERAL_FLAG } }),
        { headers: { 'Content-Type': 'application/json' } }
    );
}

function messageForResult(result: SubmitPickResult): string {
    switch (result.status) {
        case 'not_found': return "Couldn't find that Tank anymore - it may have been unpublished.";
        case 'not_settleable': return 'This Tank is not accepting picks.';
        case 'side_mismatch': return "That side doesn't match this Tank's call.";
        case 'game_started': return 'This game has already started - picks are closed.';
        case 'no_odds': return 'This prop has no odds on record and cannot be picked.';
        case 'odds_mismatch': return "Call sides do not match recorded odds for this prop.";
        case 'side_index_out_of_range': return 'Something went wrong with that button - try again from the Tank page.';
        case 'malformed_odds': return 'Recorded odds are malformed and cannot be picked.';
        case 'cap_reached': return "You've used today's picks — back tomorrow.";
        case 'conflict': return `You already made this call: **${result.pick?.side ?? 'your pick'}**.`;
        case 'ok': return `Locked in: **${result.pick.side}**. (${result.picksToday}/${result.dailyCap} picks used today)`;
    }
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const rawBody = await context.request.text();
    const verified = await verifyDiscordRequest(
        rawBody,
        context.request.headers.get('X-Signature-Ed25519'),
        context.request.headers.get('X-Signature-Timestamp'),
        context.env.DISCORD_PUBLIC_KEY
    );
    if (!verified) return new Response('Invalid request signature.', { status: 401 });

    let interaction: any;
    try {
        interaction = JSON.parse(rawBody);
    } catch {
        return new Response('Invalid JSON body.', { status: 400 });
    }

    if (interaction.type === DISCORD_PING) {
        return new Response(JSON.stringify({ type: RESPONSE_PONG }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (interaction.type !== DISCORD_MESSAGE_COMPONENT) {
        return new Response('Unhandled interaction type.', { status: 400 });
    }

    const customId = typeof interaction.data?.custom_id === 'string' ? interaction.data.custom_id : '';
    const parts = customId.split(':');
    if (parts.length !== 3 || parts[0] !== 'pick') {
        return ephemeral("Couldn't process that button.");
    }
    const slug = parts[1];
    const sideIndex = Number(parts[2]);
    if (!slug || !Number.isInteger(sideIndex)) {
        return ephemeral("Couldn't process that button.");
    }

    const discordUserId: string | undefined = interaction.member?.user?.id ?? interaction.user?.id;
    if (!discordUserId) return ephemeral("Couldn't identify your Discord account.");

    const sql = getSql(context.env);
    const linkRows = await sql`
        SELECT dl.waitlist_id, w.onboarded_at
        FROM discord_links dl
        JOIN waitlist w ON w.id = dl.waitlist_id
        WHERE dl.discord_user_id = ${discordUserId}
        LIMIT 1
    `;
    if (linkRows.length === 0) {
        return ephemeral('Connect your Heatchecks account first: log in at heatchecks.io, then visit heatchecks.io/account/ to link Discord.');
    }
    const link = linkRows[0] as unknown as { waitlist_id: string; onboarded_at: string | null };
    if (!link.onboarded_at) {
        return ephemeral('Finish setting up your Heatchecks account at heatchecks.io/welcome/ before picking from Discord.');
    }

    // custom_id only carries the slug + sideIndex (kept short - Discord caps custom_id
    // at 100 chars, and slugs here can run long). sideIndex is the authoritative signal
    // anyway (same convention functions/api/picks.ts's client relies on), so the side
    // text is resolved server-side from the Tank's own recorded call.sides rather than
    // trusting anything out of the interaction payload itself.
    const sidesRows = await sql`
        SELECT model_output->'call'->'sides' AS sides
        FROM tank_pages WHERE slug = ${slug} AND status = 'published' AND visibility = 'app' LIMIT 1
    `;
    if (sidesRows.length === 0) {
        return ephemeral("Couldn't find that Tank anymore - it may have been unpublished.");
    }
    const rawSides = sidesRows[0].sides as unknown;
    const sides: string[] = Array.isArray(rawSides)
        ? (rawSides as string[])
        : (typeof rawSides === 'string' ? JSON.parse(rawSides) : []);
    const side = sides[sideIndex];
    if (!side) return ephemeral("Couldn't process that button.");

    let result: SubmitPickResult;
    try {
        result = await submitPick(sql, context.env, { waitlistId: link.waitlist_id, slug, side, sideIndex, source: 'app' });
    } catch (err) {
        console.error('[POST /api/discord/interactions] submitPick failed:', err);
        return ephemeral('Something went wrong recording that pick. Try again shortly.');
    }

    return ephemeral(messageForResult(result));
};
