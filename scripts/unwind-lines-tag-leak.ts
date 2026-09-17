// Removes ticker tags (and the tag events they wrote) from Lines Tanks.
//
// THE RULE. A Lines Tank (tank_pages.kind = 'lines') carries no story, so it is not news
// and tags no ticker. Its game reaches the indexes through the slate leg like every other
// game. Any ticker_tags row pointing at a kind = 'lines' Tank is therefore wrong by
// definition, which is what makes this script safe to run at any time: it has nothing to
// judge, only a rule to enforce.
//
// WHY ONE EXISTS (2026-09-17). The kind column and the first three lines rows (MIL @ PIT)
// reached the shared database before the code that filters on kind was deployed. The
// ticker sweep runs on the auth-sessions preview, which still read every published app
// Tank as a story, so at 10:10 UTC it wrote 14 tags and 14 tag events across six tickers:
//   chalk / mlbchalk  net +0.066     dogs / mlbdogs  net -0.066
//   overs             net +0.120     unders          net -0.120
// A snapshot of all 28 rows is in lines-tag-leak-backup-2026-09-17.json.
//
// WHAT IT DOES. Deletes the ticker_events written through those tags, then the tags. Price
// is derived on read (baseline * exp(sum(delta) / scale)), there is no stored running
// value, so removing the events IS the whole correction: every chart and quote simply
// stops including them. This is a third sanctioned exception to ticker_events being
// append-only, for the reason recompute-settle-deltas.ts gives: an offsetting correction
// event would leave a move that never should have happened visible in every chart.
//
// WHAT IT DOES NOT DO. It does not reverse share trades. Any trade made on an affected
// ticker while the events were live was quoted a price up to ~0.12% off; the script lists
// them so the size of that is known, and leaves them alone.
//
// It refuses to run if a targeted event is anything other than a source = 'tank' tag
// event, or if an index position points at one as its close - neither can be true of a
// tag event, so either would mean the target query is wrong.
//
//   npx tsx scripts/unwind-lines-tag-leak.ts            <- dry run: prints the plan, writes nothing
//   npx tsx scripts/unwind-lines-tag-leak.ts --apply    <- deletes, in one transaction
//
// Idempotent: a second run finds nothing to remove.
//
// Env: DATABASE_URL.

import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const APPLY = process.argv.includes('--apply');

if (!process.env.DATABASE_URL) {
    console.error('Required env: DATABASE_URL.');
    process.exit(2);
}

async function main(): Promise<void> {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const tags = await client.query(`
            SELECT g.id, g.ticker_key, g.relevant_side, g.tagged_at, t.slug
              FROM ticker_tags g
              JOIN tank_pages t ON t.id = g.tank_id
             WHERE t.kind = 'lines'
             ORDER BY g.tagged_at
               FOR UPDATE OF g`);
        const tagIds: string[] = tags.rows.map((r) => r.id);

        // Through the tag, and belt-and-braces by tank: an event on a lines Tank with no
        // tag behind it would be just as wrong.
        const events = await client.query(`
            SELECT e.id, e.ticker_key, e.event_type, e.source, e.delta::float8 AS delta, e.occurred_at,
                   e.ticker_tag_id, t.slug
              FROM ticker_events e
              JOIN tank_pages t ON t.id = e.tank_id
             WHERE t.kind = 'lines' OR e.ticker_tag_id = ANY($1::uuid[])
             ORDER BY e.occurred_at
               FOR UPDATE OF e`, [tagIds]);
        const eventIds: string[] = events.rows.map((r) => r.id);

        console.log(`Lines Tanks carrying tags: ${new Set(tags.rows.map((r) => r.slug)).size}`);
        console.log(`  ticker_tags to remove:   ${tagIds.length}`);
        console.log(`  ticker_events to remove: ${eventIds.length}\n`);

        if (tagIds.length === 0 && eventIds.length === 0) {
            console.log('Nothing to unwind.');
            await client.query('ROLLBACK');
            return;
        }

        const foreign = events.rows.filter((r) => r.source !== 'tank' || r.event_type !== 'tag');
        if (foreign.length > 0) {
            console.table(foreign.map((r) => ({ id: r.id, ticker: r.ticker_key, type: r.event_type, source: r.source })));
            throw new Error(`${foreign.length} targeted event(s) are not source='tank' tag events - refusing to delete.`);
        }
        const closes = await client.query(
            `SELECT COUNT(*)::int AS n FROM index_positions WHERE close_id = ANY($1::uuid[])`, [eventIds]);
        if (closes.rows[0].n > 0) {
            throw new Error(`${closes.rows[0].n} index position(s) use a targeted event as their close - refusing to delete.`);
        }

        const tickers = [...new Set(events.rows.map((r) => r.ticker_key as string))].sort();
        const sums = await client.query(`
            SELECT ticker_key,
                   ROUND(SUM(delta)::numeric, 3)::float8 AS cumulative_now,
                   ROUND(SUM(delta) FILTER (WHERE id = ANY($2::uuid[]))::numeric, 3)::float8 AS removed,
                   COUNT(*) FILTER (WHERE id = ANY($2::uuid[]))::int AS events
              FROM ticker_events
             WHERE ticker_key = ANY($1::text[])
             GROUP BY ticker_key ORDER BY ticker_key`, [tickers, eventIds]);
        console.table(sums.rows.map((r) => ({
            ticker: r.ticker_key,
            events: r.events,
            cumulative_now: r.cumulative_now,
            removed: r.removed,
            cumulative_after: Math.round((r.cumulative_now - r.removed) * 1000) / 1000,
        })));

        const since = events.rows[0]?.occurred_at ?? tags.rows[0]?.tagged_at;
        const trades = await client.query(`
            SELECT ticker_key, side, COUNT(*)::int AS trades, SUM(shares)::text AS shares, SUM(ember_amount)::int AS ember
              FROM share_trades
             WHERE ticker_key = ANY($1::text[]) AND created_at >= $2
             GROUP BY ticker_key, side ORDER BY ticker_key, side`, [tickers, since]);
        if (trades.rows.length === 0) {
            console.log('Share trades on these tickers since the first stray event: none.\n');
        } else {
            console.log('Share trades made while the stray events were live (NOT reversed by this script):');
            console.table(trades.rows);
        }

        if (!APPLY) {
            console.log('Dry run - nothing written. Re-run with --apply to delete.');
            await client.query('ROLLBACK');
            return;
        }

        const delEvents = await client.query(`DELETE FROM ticker_events WHERE id = ANY($1::uuid[])`, [eventIds]);
        const delTags = await client.query(`DELETE FROM ticker_tags WHERE id = ANY($1::uuid[])`, [tagIds]);
        if (delEvents.rowCount !== eventIds.length || delTags.rowCount !== tagIds.length) {
            throw new Error(`Deleted ${delEvents.rowCount}/${eventIds.length} events and ${delTags.rowCount}/${tagIds.length} tags - counts do not match the plan.`);
        }
        await client.query('COMMIT');
        console.log(`Removed ${delEvents.rowCount} event(s) and ${delTags.rowCount} tag(s).`);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch((err) => {
    console.error('Unwind failed:', err instanceof Error ? err.message : err);
    process.exit(1);
});
