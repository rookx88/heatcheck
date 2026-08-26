// POST /api/discord-settlement-sweep - protected, machine-to-machine only. Rides
// worker-settle's cron as a sibling call right after /api/settle (same posture as
// worker-curate's sweep chain: own request, own subrequest budget, fires regardless
// of the settle call's own outcome) - it depends on settlement having just run, which
// only happens on worker-settle's schedule, not worker-curate's.
//
// Settlement itself (functions/api/settle.ts) tracks outcomes per PICK (picks.result),
// not per Tank - there's no single "this Tank is settled" flag anywhere. A Tank counts
// as settled here the moment any pick against it has a non-null result.
// discord_guild_posts.settlement_posted_at is this feature's own idempotency marker,
// set once a guild's announcement for a given Tank goes out, same posted-once posture
// as posted_at itself.
//
// Each guild that had a Tank posted gets its OWN summary, scoped to that guild's
// members only (live-fetched, same mechanism as the /leaderboard command) - not a
// DM per picker, and not one global summary blasted to every guild regardless of who
// actually picked there.
//
// Data-honesty note: picks.result only says whether each picker was right, not what
// the resolved outcome actually was. If at least one of this guild's pickers is
// 'correct', that pick's own `side` IS the winning side and the summary names it. If
// every one of them got it wrong, the summary reports the aggregate only - there is
// no stored "the answer was X" fact to report in that case, and inventing one would
// be worse than omitting it.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../lib/pages-functions/db';
import { postDiscordChannelMessage, fetchGuildMembers } from '../../lib/pages-functions/discord-api';
import { deriveTaglineFallback } from '../../tank-deck-format';

const MAX_ANNOUNCEMENTS_PER_RUN = 20;

interface ModelOutput {
    tagline?: string;
    hook: string;
}

interface CandidateRow {
    guild_id: string;
    tank_page_id: string;
    channel_id: string;
    slug: string;
    model_output: ModelOutput | string;
}

interface PickerRow {
    side: string;
    result: string;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const secret = context.request.headers.get('X-Settle-Secret');
    if (!secret || secret !== context.env.SETTLE_SECRET) {
        return jsonResponse({ message: 'Unauthorized' }, { status: 401 });
    }

    const baseUrl = new URL(context.request.url).origin;
    const sql = getSql(context.env);

    const candidates = (await sql`
        SELECT dgp.guild_id, dgp.tank_page_id, dgc.channel_id, t.slug, t.model_output
        FROM discord_guild_posts dgp
        JOIN discord_guild_configs dgc ON dgc.guild_id = dgp.guild_id
        JOIN tank_pages t ON t.id = dgp.tank_page_id
        WHERE dgp.settlement_posted_at IS NULL
          AND EXISTS (SELECT 1 FROM picks p WHERE p.tank_page_id = dgp.tank_page_id AND p.result IS NOT NULL)
        ORDER BY dgp.posted_at ASC
        LIMIT ${MAX_ANNOUNCEMENTS_PER_RUN}
    `) as unknown as CandidateRow[];

    let posted = 0;
    let skippedNoPickers = 0;
    const errors: string[] = [];

    for (const row of candidates) {
        try {
            const members = await fetchGuildMembers(context.env, row.guild_id);
            const memberIds = members.filter((m) => !m.user.bot).map((m) => m.user.id);

            const pickers = memberIds.length === 0 ? [] : ((await sql`
                SELECT p.side, p.result
                FROM picks p
                JOIN discord_links dl ON dl.waitlist_id = p.waitlist_id
                WHERE p.tank_page_id = ${row.tank_page_id} AND dl.discord_user_id = ANY(${memberIds}::text[])
            `) as unknown as PickerRow[]);

            if (pickers.length === 0) {
                // Nobody from this guild actually picked it (they may have just seen
                // the post, or this guild's overlap with the pickers is elsewhere) -
                // mark it done anyway so this pair never gets re-checked, but there's
                // nothing worth announcing.
                await sql`
                    UPDATE discord_guild_posts SET settlement_posted_at = NOW()
                    WHERE guild_id = ${row.guild_id} AND tank_page_id = ${row.tank_page_id}
                `;
                skippedNoPickers++;
                continue;
            }

            const total = pickers.length;
            const correct = pickers.filter((p) => p.result === 'correct').length;
            const winningSide = pickers.find((p) => p.result === 'correct')?.side ?? null;

            const modelOutput: ModelOutput | null = typeof row.model_output === 'string'
                ? JSON.parse(row.model_output)
                : row.model_output;
            const tagline = modelOutput?.tagline?.trim() || (modelOutput ? deriveTaglineFallback(modelOutput.hook) : row.slug);
            const tankUrl = `${baseUrl}/the-tank/articles/${row.slug}/`;

            const summary = winningSide
                ? `**${winningSide}** was right. ${correct}/${total} of this server's pickers got it.`
                : `Tough one — 0/${total} of this server's pickers got it this time.`;

            const embed = {
                title: `${tagline} — settled`,
                url: tankUrl,
                description: summary,
                color: 0x2fe6d9,
            };

            await postDiscordChannelMessage(context.env, row.channel_id, { embeds: [embed] });
            await sql`
                UPDATE discord_guild_posts SET settlement_posted_at = NOW()
                WHERE guild_id = ${row.guild_id} AND tank_page_id = ${row.tank_page_id}
            `;
            posted++;
        } catch (err) {
            console.error(`[POST /api/discord-settlement-sweep] Failed for guild ${row.guild_id}, tank ${row.tank_page_id}:`, err);
            errors.push(`${row.guild_id}:${row.tank_page_id}`);
        }
    }

    return jsonResponse({ candidates: candidates.length, posted, skippedNoPickers, errors });
};
