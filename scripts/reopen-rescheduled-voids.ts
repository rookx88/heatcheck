// Reopens index positions that index-settle voided because their game was RESCHEDULED,
// so they settle against the game that was actually played instead of counting as
// nothing.
//
// WHY (2026-10-09). Until the fix in functions/api/index-settle.ts landed, a position
// whose market was still open 72h after its frozen kickoff was written off as 'void',
// on the theory that Polymarket had abandoned the market. It hadn't: when a fixture is
// postponed Polymarket keeps the same market and moves gameStartTime, leaving the
// question text at the old date. Of the 36 positions ever voided, 28 were games that had
// only moved:
//   St. Louis City @ NY Red Bulls   26 Sep -> 30 Sep   12 positions (played, resolved)
//   Athletic Club @ Levante         16 Sep -> 21 Oct   12 positions
//   D.C. United @ FC Cincinnati      5 Sep -> 21 Oct    4 positions
// The other 8 are two MLB games (Red Sox @ Yankees, Cubs @ Padres, 2 Oct) that
// Polymarket closed at ["0.5","0.5"] - cancelled.
// Those are correctly void, and this script leaves them alone by construction: it only
// reopens a void whose market's live start is later than the frozen kickoff.
//
// WHAT IT DOES. For each such position: clears result / winning_index / contrib /
// settled_at and moves kickoff to the live start, in one transaction. That puts it back
// in exactly the state index-settle's new reschedule branch would have left it in, so
// the normal settle path takes over - a game already played is scored on the next pass,
// a game still to come is scored after it is played.
//
// WHY THIS ISN'T A LATE TAG. The rule "never backfill a ticker tag" exists because a tag
// measures a price move at the moment it is written. A slate position doesn't: its price
// was frozen at lock time, before the ORIGINAL kickoff, weeks before the result existed.
// Scoring it late is the same thing index-settle does for any position it settles a day
// late - it just lands in the close of the day it settles, not the day of the game.
//
// SAFETY. Voids carry no close_id (closes count only win/loss), so no historical close
// changes. The script refuses to touch a void that does have one. Gamma is read with
// fetchMarketStrict, so an outage throws instead of looking like "no new date".
//
//   npx tsx scripts/reopen-rescheduled-voids.ts            <- dry run: prints the plan
//   npx tsx scripts/reopen-rescheduled-voids.ts --apply    <- reopens, in one transaction
//
// Idempotent: a reopened position is no longer 'void', so a second run finds nothing.
//
// Env: DATABASE_URL.

import { Pool } from 'pg';
import dotenv from 'dotenv';
import { fetchMarketStrict, parseGameStartTime, resolveMarket } from '../lib/pages-functions/gamma';

dotenv.config();

const APPLY = process.argv.includes('--apply');
// Same threshold as index-settle's RESCHEDULE_MIN_MS: kickoff drift of a few minutes in
// an on-time game is not a reschedule.
const RESCHEDULE_MIN_MS = 60 * 60 * 1000;

if (!process.env.DATABASE_URL) {
    console.error('Required env: DATABASE_URL.');
    process.exit(2);
}

async function main(): Promise<void> {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const voids = await client.query(`
            SELECT id, ticker_key, market_id, league, away, home, kickoff, close_id
              FROM index_positions
             WHERE result = 'void'
             ORDER BY kickoff, market_id, ticker_key
               FOR UPDATE`);
        console.log(`Voided positions: ${voids.rows.length}`);
        if (voids.rows.length === 0) {
            console.log('Nothing to reopen.');
            await client.query('ROLLBACK');
            return;
        }

        const withClose = voids.rows.filter((r) => r.close_id !== null);
        if (withClose.length > 0) {
            throw new Error(`${withClose.length} void position(s) carry a close_id - a void should never be in a close. Refusing.`);
        }

        // One Gamma read per market, strictly: a throw aborts the whole run rather than
        // quietly leaving a market out of the plan.
        const live = new Map<string, { start: number | null; closed: boolean; status: string }>();
        for (const marketId of new Set(voids.rows.map((r) => r.market_id as string))) {
            const market = await fetchMarketStrict(marketId);
            live.set(marketId, {
                start: parseGameStartTime(market?.gameStartTime),
                closed: !!market?.closed,
                status: resolveMarket(market).status,
            });
        }

        const reopen: Array<{ id: string; kickoff: string }> = [];
        const plan: Record<string, unknown>[] = [];
        for (const r of voids.rows) {
            const m = live.get(r.market_id)!;
            const frozen = new Date(r.kickoff).getTime();
            const moved = m.start !== null && m.start - frozen > RESCHEDULE_MIN_MS;
            if (moved) reopen.push({ id: r.id, kickoff: new Date(m.start!).toISOString() });
            plan.push({
                game: `${r.away} @ ${r.home}`.slice(0, 40),
                ticker: r.ticker_key,
                market: r.market_id,
                frozen: new Date(frozen).toISOString().slice(0, 16),
                live: m.start === null ? '-' : new Date(m.start).toISOString().slice(0, 16),
                gamma: m.status,
                action: moved ? 'REOPEN' : 'keep void',
            });
        }
        console.table(plan);
        console.log(`\nReopen: ${reopen.length}   Keep void: ${voids.rows.length - reopen.length}`);

        if (reopen.length === 0) {
            console.log('Nothing to reopen.');
            await client.query('ROLLBACK');
            return;
        }
        if (!APPLY) {
            console.log('Dry run - nothing written. Re-run with --apply to reopen.');
            await client.query('ROLLBACK');
            return;
        }

        const res = await client.query(`
            UPDATE index_positions AS ip
               SET result = NULL, winning_index = NULL, contrib = NULL, settled_at = NULL,
                   kickoff = t.kickoff
              FROM unnest($1::uuid[], $2::timestamptz[]) AS t(id, kickoff)
             WHERE ip.id = t.id AND ip.result = 'void'`,
            [reopen.map((r) => r.id), reopen.map((r) => r.kickoff)]);
        if (res.rowCount !== reopen.length) {
            throw new Error(`Reopened ${res.rowCount}/${reopen.length} - count does not match the plan.`);
        }
        await client.query('COMMIT');
        console.log(`Reopened ${res.rowCount} position(s). The next index-settle pass scores any whose game has been played.`);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch((err) => {
    console.error('Reopen failed:', err instanceof Error ? err.message : err);
    process.exit(1);
});
