// GET /api/discord/callback - Discord's OAuth2 redirect target. Verifies the signed
// `state` param minted by GET /api/discord/link (that's the CSRF protection for this
// leg - see link.ts), exchanges the code for the user's Discord identity, and either
// links Discord to the session that started the flow, or - when no session existed -
// signs the visitor into (or creates) a Heatchecks account by their Discord-verified
// email. Always redirects (a top-level browser navigation, not a fetch()) rather than
// returning JSON.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, type Env } from '../../../lib/pages-functions/db';
import { resolveLoginOrigin, createSession } from '../../../lib/pages-functions/session';
import { verifyAuthToken } from '../../../lib/pages-functions/auth-tokens';
import { exchangeDiscordCode } from '../../../lib/pages-functions/discord-api';
import type { DiscordLinkTokenPayload } from '../../../lib/auth-token-payloads';

function redirectTo(url: string, extraHeaders?: Record<string, string>): Response {
    return new Response(null, { status: 302, headers: { Location: url, ...extraHeaders } });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const origin = resolveLoginOrigin(context.request.url, context.env);
    const url = new URL(context.request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) return redirectTo(`${origin}/account/?discord=error`);

    const payload = await verifyAuthToken<DiscordLinkTokenPayload>(state, context.env.SESSION_TOKEN_SECRET, 'discord_link');
    if (!payload) return redirectTo(`${origin}/account/?discord=error`);

    // Neither branch below has anywhere sensible to send a failure yet - the
    // session-present branch's error destination (/account/) only makes sense once we
    // know whether a session existed, and the session-absent branch's is /login/. Fall
    // back to /account/ for an exchange failure regardless; a logged-out visitor there
    // just gets redirected to /login/ by that page itself, same as any other 401.
    let discordUser;
    try {
        discordUser = await exchangeDiscordCode(context.env, code, `${origin}/api/discord/callback`);
    } catch (err) {
        console.error('[GET /api/discord/callback] Discord code exchange failed:', err);
        return redirectTo(`${origin}/account/?discord=error`);
    }

    const sql = getSql(context.env);

    // --- Branch A: flow started with an existing session - link Discord to it. -------
    if (payload.userId) {
        try {
            await sql`
                INSERT INTO discord_links (waitlist_id, discord_user_id, discord_username)
                VALUES (${payload.userId}, ${discordUser.id}, ${discordUser.username})
                ON CONFLICT (waitlist_id) DO UPDATE
                    SET discord_user_id = EXCLUDED.discord_user_id,
                        discord_username = EXCLUDED.discord_username,
                        linked_at = NOW()
            `;
        } catch (err: any) {
            if (err.code === '23505') { // idx_discord_links_discord_user_id - this Discord account is already linked elsewhere
                return redirectTo(`${origin}/account/?discord=taken`);
            }
            console.error('[GET /api/discord/callback] Error upserting discord_links row:', err);
            return redirectTo(`${origin}/account/?discord=error`);
        }
        return redirectTo(`${origin}/account/?discord=linked`);
    }

    // --- Branch B: no session - sign in (if already linked) or create an account. ----

    // 1. Already linked on a different device/browser -> just sign back in.
    const existingLink = await sql`
        SELECT dl.waitlist_id, w.onboarded_at
        FROM discord_links dl
        JOIN waitlist w ON w.id = dl.waitlist_id
        WHERE dl.discord_user_id = ${discordUser.id}
        LIMIT 1
    `;
    if (existingLink.length > 0) {
        const row = existingLink[0] as unknown as { waitlist_id: string; onboarded_at: string | null };
        const { setCookie } = await createSession(sql, context.env, row.waitlist_id, context.request.url);
        const destination = row.onboarded_at ? `${origin}/?discord=linked` : `${origin}/welcome/?discord=linked`;
        return redirectTo(destination, { 'Set-Cookie': setCookie });
    }

    // 2. Not linked yet - need a verified email to safely create/match an account.
    // emailVerified is Discord's own flag; an unverified address proves nothing.
    if (!discordUser.emailVerified || !discordUser.email) {
        return redirectTo(`${origin}/login/?discord=no_email`);
    }

    // 3. Upsert the waitlist row by that email (same shape functions/api/login.ts
    // already uses for the magic-link funnel), marking it verified - Discord's OAuth
    // proof of ownership is at least as strong as clicking a magic link, the same
    // trust bar functions/api/login/consume.ts applies. This can match an EXISTING
    // account created via the ordinary email flow, deliberately: signing in with
    // Discord using a verified email you already used for a Heatchecks account should
    // link into that account, not create a duplicate.
    let waitlistId: string;
    let onboardedAt: string | null;
    try {
        const rows = await sql`
            INSERT INTO waitlist (email, email_verified) VALUES (${discordUser.email}, true)
            ON CONFLICT ((LOWER(email))) DO UPDATE SET email = waitlist.email, email_verified = true
            RETURNING id, onboarded_at
        `;
        waitlistId = rows[0].id as string;
        onboardedAt = rows[0].onboarded_at as string | null;

        await sql`
            INSERT INTO discord_links (waitlist_id, discord_user_id, discord_username)
            VALUES (${waitlistId}, ${discordUser.id}, ${discordUser.username})
        `;
    } catch (err: any) {
        if (err.code === '23505') {
            // A concurrent callback for the same brand-new Discord user won the race
            // and inserted discord_links first - retrying this same flow will now hit
            // the "already linked" branch above and sign in cleanly.
            return redirectTo(`${origin}/login/?discord=error`);
        }
        console.error('[GET /api/discord/callback] Error creating account from Discord:', err);
        return redirectTo(`${origin}/login/?discord=error`);
    }

    const { setCookie } = await createSession(sql, context.env, waitlistId, context.request.url);
    const destination = onboardedAt ? `${origin}/?discord=linked` : `${origin}/welcome/?discord=linked`;
    return redirectTo(destination, { 'Set-Cookie': setCookie });
};
