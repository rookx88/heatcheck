// POST /api/account/delete - deletes the calling account. A SOFT delete, by design:
// ember_ledger, ember_balances, item_ledger, share_holdings/share_trades and the
// community_* tables all reference waitlist(id) with no cascade and are append-only
// journals (their invariants are what suites/ledger-trace.ts enforces), so the row
// stays and everything that identifies a person on it is scrubbed instead:
//
//   email     -> 'deleted+<id>@deleted.heatchecks.invalid'. Keeps idx_waitlist_email
//                satisfied and, more importantly, FREES the real address: login.ts's
//                INSERT ... ON CONFLICT ((LOWER(email))) then creates a brand-new row
//                for it, so someone who deletes and comes back starts clean.
//   username  -> NULL. Frees the name (idx_waitlist_username_lower is partial on
//                non-NULL), drops the account off the Hall of Fame (its board filters
//                on username IS NOT NULL) and out of pets/name.ts's uniqueness pool.
//   prefs     -> all false, so settle.ts / notify-sweep.ts / the newsletter script stop
//                addressing the row without each needing its own deleted_at check.
//   nonces    -> NULL, so an outstanding magic link or 6-digit code can't mint a
//                session for a dead account.
//   sessions  -> revoked (getSession() also refuses deleted_at rows - two walls).
//   discord   -> discord_links row deleted, freeing the Discord account to link anew.
//   pet       -> name NULL (globally unique, so it must be released); the row itself
//                stays because notifications/discovery bookkeeping reference pets by
//                id in text, and the pet is unreachable without a session anyway.
//   inbox     -> notifications deleted (they can carry the pet's name; nothing else
//                depends on them).
// Picks, Ember, items and encounters stay: they only carry user_id, and picks feed
// per-Tank stats and community counts that must not shift when a person leaves.
//
// Confirmation is the username (case-insensitive) or the literal DELETE, checked here
// as well as in the client - a stray POST with no body does nothing. Session +
// same-origin required. Idempotent in effect: the second call finds no session (401).

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../../lib/pages-functions/db';
import {
    getSession, requireSameOrigin, buildClearSessionCookie, isSecureRequest,
} from '../../../lib/pages-functions/session';
import { logEvent } from '../../../lib/pages-functions/events';
import { unsubscribeResendAudienceContact } from '../../../lib/resend-audience';

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const csrf = requireSameOrigin(context.request);
    if (csrf) return csrf;

    let body: any;
    try {
        body = await context.request.json();
    } catch {
        return jsonResponse({ message: 'Invalid JSON body.' }, { status: 400 });
    }

    const session = await getSession(context.request, context.env);
    if (!session) return jsonResponse({ message: 'Login required.' }, { status: 401 });

    const confirm = typeof body?.confirm === 'string' ? body.confirm.trim() : '';
    const matchesUsername = session.username !== null && confirm.toLowerCase() === session.username.toLowerCase();
    if (confirm !== 'DELETE' && !matchesUsername) {
        return jsonResponse({ message: 'Type your username or DELETE to confirm.' }, { status: 400 });
    }

    const sql = getSql(context.env);
    const originalEmail = session.email;

    // Statements that must all land or none - the scrub and the revocations together.
    await sql.transaction([
        sql`
            UPDATE waitlist SET
                email = 'deleted+' || id::text || '@deleted.heatchecks.invalid',
                username = NULL,
                newsletter_opt_in = false,
                email_settlement_results = false,
                notify_pet_hungry = false,
                notify_daily_drop = false,
                login_nonce = NULL,
                login_nonce_expires_at = NULL,
                verification_code = NULL,
                verification_code_expires_at = NULL,
                deleted_at = NOW()
            WHERE id = ${session.userId} AND deleted_at IS NULL
        `,
        sql`UPDATE sessions SET revoked_at = NOW() WHERE user_id = ${session.userId} AND revoked_at IS NULL`,
        sql`DELETE FROM discord_links WHERE waitlist_id = ${session.userId}`,
        sql`UPDATE pets SET name = NULL WHERE user_id = ${session.userId}`,
        sql`DELETE FROM notifications WHERE user_id = ${session.userId}`,
    ]);

    // Fire-and-forget from here: the account is gone whatever these do.
    if (context.env.RESEND_AUDIENCE_ID) {
        try {
            await unsubscribeResendAudienceContact(context.env.RESEND_API_KEY, context.env.RESEND_AUDIENCE_ID, originalEmail);
        } catch (audienceErr) {
            console.error('[POST /api/account/delete] Resend audience unsubscribe failed:', audienceErr);
        }
    }
    try {
        await logEvent(sql, {
            visitorId: crypto.randomUUID(),
            waitlistId: session.userId,
            eventType: 'account_deleted',
        });
    } catch (eventErr) {
        console.error('[POST /api/account/delete] Failed to log account_deleted event:', eventErr);
    }

    return jsonResponse(
        { deleted: true },
        { headers: { 'Set-Cookie': buildClearSessionCookie(isSecureRequest(context.request.url)) } },
    );
};
