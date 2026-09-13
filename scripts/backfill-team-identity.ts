// Stamps canonical club identity onto index_positions rows written before
// add_team_identity_to_index_positions.sql existed. Run once after that migration, and
// again after any lib/pages-functions/team-identity.ts registry change (it is idempotent
// and re-resolves every row from scratch, so a corrected registry entry propagates).
//
//   npx tsx scripts/backfill-team-identity.ts --dry-run   <- ALWAYS first; review table
//   npx tsx scripts/backfill-team-identity.ts             <- write, in one transaction
//
// This is NOT an exception to append-only: away_team_id/home_team_id/subject_team_id/
// subject_src/away_abbr/home_abbr are derived attribution, never a delta or a price, and
// nothing scored by an index reads them. Rewriting them changes what a team page says
// about a game, never what the game did to an index.
//
// WHY IT MUST RUN SOON. The soccer subject team is only recoverable from
// polymarket_props.question, and the abbreviations only from polymarket_props.event_teams
// - and that table is a CACHE of open markets, upserted in place with no retention
// guarantee for a finished game. All 538 historical moneyline rows still have theirs
// today (measured 2026-09-12). Once they go, those attributions are unrecoverable, in
// exactly the way entry_prob already is.
//
// Env: DATABASE_URL.

import { Pool } from 'pg';
import dotenv from 'dotenv';
import { resolvePositionTeams, type SubjectSource } from '../lib/pages-functions/team-identity';

dotenv.config();

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

if (!process.env.DATABASE_URL) {
    console.error('Required env: DATABASE_URL.');
    process.exit(1);
}

// The four reasons a side has no club that are BUGS rather than honest refusals. A run
// that produces any of these is refused without --force: the fix is a registry entry,
// not a write. See SubjectSource in team-identity.ts.
const BUG_SOURCES: SubjectSource[] = [
    'unmapped_team',
    'unreadable_question',
    'label_matches_neither',
    'missing_teams',
];

interface Row {
    id: string;
    league: string | null;
    away: string | null;
    home: string | null;
    market_type: string | null;
    side_label: string | null;
    question: string | null;
    away_abbr: string | null;
    home_abbr: string | null;
}

async function main(): Promise<void> {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
        // Every row, not just unstamped ones: a re-run after a registry fix must be able
        // to correct rows a previous run already touched. The abbreviations come from
        // polymarket_props while it still has them; a row whose props entry is already
        // gone keeps whatever it had (COALESCE), so a second run never erases a first
        // run's capture.
        const { rows } = await pool.query<Row>(`
            SELECT ip.id,
                   ip.league, ip.away, ip.home, ip.market_type, ip.side_label,
                   pp.question,
                   COALESCE(ip.away_abbr, (
                       SELECT lower(e->>'abbreviation') FROM jsonb_array_elements(pp.event_teams) WITH ORDINALITY t(e, n)
                       WHERE e->>'ordering' = 'away' OR n = 1 ORDER BY (e->>'ordering' = 'away') DESC LIMIT 1
                   )) AS away_abbr,
                   COALESCE(ip.home_abbr, (
                       SELECT lower(e->>'abbreviation') FROM jsonb_array_elements(pp.event_teams) WITH ORDINALITY t(e, n)
                       WHERE e->>'ordering' = 'home' OR n = 2 ORDER BY (e->>'ordering' = 'home') DESC LIMIT 1
                   )) AS home_abbr
            FROM index_positions ip
            LEFT JOIN polymarket_props pp ON pp.market_id = ip.market_id
            ORDER BY ip.id
        `);

        const bySrc = new Map<string, number>();
        const unmapped = new Map<string, number>();
        const updates: Array<[string, string | null, string | null, string | null, string, string | null, string | null]> = [];

        for (const r of rows) {
            const res = resolvePositionTeams({
                league: r.league,
                away: r.away,
                home: r.home,
                marketType: r.market_type,
                sideLabel: r.side_label,
                question: r.question,
            });
            bySrc.set(res.subjectSource, (bySrc.get(res.subjectSource) ?? 0) + 1);
            for (const u of res.unmapped) unmapped.set(u, (unmapped.get(u) ?? 0) + 1);
            updates.push([
                r.id,
                res.awayTeamId,
                res.homeTeamId,
                res.subjectTeamId,
                res.subjectSource,
                r.away_abbr,
                r.home_abbr,
            ]);
        }

        console.log(`\nRows read: ${rows.length}\n`);
        console.log('subject_src breakdown');
        for (const [k, v] of [...bySrc].sort((a, b) => b[1] - a[1])) {
            const flag = BUG_SOURCES.includes(k as SubjectSource) ? '  <-- BUG' : '';
            console.log(`  ${String(v).padStart(5)}  ${k}${flag}`);
        }

        const bugs = BUG_SOURCES.reduce((n, k) => n + (bySrc.get(k) ?? 0), 0);
        const withSubject = updates.filter((u) => u[3] !== null).length;
        console.log(`\nAttributed to a club: ${withSubject}`);
        console.log(`Bug-class rows:       ${bugs}`);

        if (unmapped.size > 0) {
            console.log('\nUnmapped club names - add these to CLUB_DISPLAY in team-identity.ts:');
            for (const [n, c] of [...unmapped].sort((a, b) => b[1] - a[1])) {
                console.log(`  ${String(c).padStart(4)}x  ${JSON.stringify(n)}`);
            }
        }

        if (DRY_RUN) {
            console.log('\n--dry-run: nothing written.');
            return;
        }
        if (bugs > 0 && !FORCE) {
            console.error(
                `\nRefusing to write: ${bugs} row(s) resolved to a bug class. Map the names above in ` +
                `lib/pages-functions/team-identity.ts and re-run, or pass --force to write anyway.`,
            );
            process.exitCode = 1;
            return;
        }

        // One statement, one transaction. unnest keeps this a single round trip rather
        // than ~1000, matching how index-lock writes these rows in the first place.
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const res = await client.query(
                `UPDATE index_positions ip SET
                     away_team_id    = u.away_team_id,
                     home_team_id    = u.home_team_id,
                     subject_team_id = u.subject_team_id,
                     subject_src     = u.subject_src,
                     away_abbr       = u.away_abbr,
                     home_abbr       = u.home_abbr
                 FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
                      AS u(id, away_team_id, home_team_id, subject_team_id, subject_src, away_abbr, home_abbr)
                 WHERE ip.id = u.id`,
                [
                    updates.map((u) => u[0]),
                    updates.map((u) => u[1]),
                    updates.map((u) => u[2]),
                    updates.map((u) => u[3]),
                    updates.map((u) => u[4]),
                    updates.map((u) => u[5]),
                    updates.map((u) => u[6]),
                ],
            );
            await client.query('COMMIT');
            console.log(`\nUpdated ${res.rowCount} row(s).`);
            if (bugs === 0) {
                console.log(
                    '\nEvery row now carries a subject_src. Apply the constraints held as comments in\n' +
                    'add_team_identity_to_index_positions.sql to make that permanent:\n' +
                    "  ALTER TABLE index_positions ADD CONSTRAINT index_positions_subject_src_check CHECK (...);\n" +
                    '  ALTER TABLE index_positions ALTER COLUMN subject_src SET NOT NULL;',
                );
            }
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } finally {
        await pool.end();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
