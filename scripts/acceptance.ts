// Consolidated acceptance harness - the ONE place every acceptance check for this app
// lives and re-runs together (settlement, pets/eggs/feeding, tickers, discovery,
// homepage, auth, plus the full-loop verification phases: concurrency, ledger trace,
// boundary sweep, security re-review). No test framework in this repo by design (see
// each suite file for the domain it's the acceptance suite for) - this is a plain
// tsx script.
//
//   npx tsx scripts/acceptance.ts                  # run every suite
//   npx tsx scripts/acceptance.ts tickers pets      # run only the named suites
//
// Requirements (env / .env):
//   DATABASE_URL         - a DEV/BRANCH database, NEVER prod: every suite inserts and
//                          deletes fixture rows (prefix 'acceptance-<domain>-') and some
//                          temporarily version-flip game_config.
//   ACCEPTANCE_CONFIRM   - must be "1" (explicit acknowledgement of the line above).
//   BASE_URL             - where the Pages Functions are serving (default
//                          http://localhost:8788 - `npm run dev:functions`; the dev
//                          server must be pointed at the SAME DATABASE_URL).
//   TICKER_SECRET, SETTLE_SECRET, SESSION_TOKEN_SECRET, CURATE_SECRET
//                        - must match the dev server's .dev.vars bindings. Only the
//                          union required by the suites actually selected is enforced.
//
// Environment gotchas (Windows): kill stale wrangler dev servers before running -
// orphaned workerd children keep serving old code on 8788 (kill the node parents too).
// All HTTP is driven from in-script fetch, never curl (PS5.1 curl quoting mangles JSON
// bodies). Settlement and login-email tests can trigger REAL Resend sends against the
// live RESEND_API_KEY in .dev.vars - blank it for the dev server process before running
// Phases 1/2/4, restore it after.

// dotenv MUST finish before any suite module is evaluated: several suites read
// process.env.<SECRET> into a module-top-level `const` (so it's captured once, not
// re-read per request). Static `import` statements are hoisted and execute before the
// rest of this file's own top-level code, so a plain `import dotenv from 'dotenv'` +
// later `dotenv.config()` here would run AFTER those suite modules already captured an
// empty string from process.env - the secret would silently be blank for the whole run
// (observed: every /api/ticker-tags call failing 401 "Unauthorized" despite a correct
// TICKER_SECRET in .env, because suites/tickers.ts's top-level `const TICKER_SECRET =
// process.env.TICKER_SECRET || ''` had already frozen '' before dotenv ever ran).
// Dynamic import() defers module evaluation to the point it's actually awaited, so
// calling dotenv.config() first and only THEN dynamically importing every suite closes
// this gap without having to make every suite read env lazily inside its functions.
import dotenv from 'dotenv';
dotenv.config();

import { pool, initPool, setActiveSuite, printSummary, runTeardowns, type Suite } from './acceptance/harness';

async function loadSuites(): Promise<Suite[]> {
    const [tickers, discovery, settlement, pets, auth, homepage, concurrency, ledgerTrace, boundaries, security, kalshiLive] = await Promise.all([
        import('./acceptance/suites/tickers'),
        import('./acceptance/suites/discovery'),
        import('./acceptance/suites/settlement'),
        import('./acceptance/suites/pets'),
        import('./acceptance/suites/auth'),
        import('./acceptance/suites/homepage'),
        import('./acceptance/suites/concurrency'),
        import('./acceptance/suites/ledger-trace'),
        import('./acceptance/suites/boundaries'),
        import('./acceptance/suites/security'),
        import('./acceptance/suites/kalshi-live'),
    ]);
    return [
        tickers.suite, discovery.suite, settlement.suite, pets.suite, auth.suite,
        homepage.suite, concurrency.suite, ledgerTrace.suite, boundaries.suite, security.suite,
        kalshiLive.suite,
    ];
}

if (process.env.ACCEPTANCE_CONFIRM !== '1') {
    console.error('Refusing to run: set ACCEPTANCE_CONFIRM=1 to confirm DATABASE_URL is a dev/branch DB (this script writes and deletes rows).');
    process.exit(2);
}
if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required.');
    process.exit(2);
}

initPool(process.env.DATABASE_URL);

async function printResolvedConfig(): Promise<void> {
    console.log('\n' + '#'.repeat(72));
    console.log('RESOLVED CONFIG (this run) - so no phase has to guess what was actually in force');
    console.log('#'.repeat(72));
    for (const key of ['feeding', 'discovery', 'tickers']) {
        try {
            const { rows } = await pool.query(`SELECT version, config FROM game_config WHERE key = $1 AND active`, [key]);
            console.log(`  game_config['${key}'] v${rows[0]?.version} = ${JSON.stringify(rows[0]?.config)}`);
        } catch (err) {
            console.log(`  game_config['${key}'] - could not read (${(err as Error).message})`);
        }
    }
    for (const key of ['correct_call', 'participation', 'discovery_find']) {
        try {
            const { rows } = await pool.query(`SELECT version, config FROM ember_rules WHERE key = $1 AND active`, [key]);
            console.log(`  ember_rules['${key}'] v${rows[0]?.version} = ${JSON.stringify(rows[0]?.config)}`);
        } catch (err) {
            console.log(`  ember_rules['${key}'] - could not read (${(err as Error).message})`);
        }
    }
    // DAILY_PICK_CAP has no DB row - it's an env var read fresh per-request by the dev
    // server process (functions/api/picks/today.ts:42, numEnv default 1). Observe it
    // live via a throwaway fixture rather than assuming: GET /api/picks/today's
    // `remaining` for a zero-picks user equals the effective cap.
    try {
        const email = `acceptance-config-probe@example.com`;
        const { createUser, mintSessionCookie, cleanupUsersByEmailPrefix } = await import('./acceptance/fixtures');
        const { userId } = await createUser(email, { onboarded: true });
        const cookie = await mintSessionCookie(userId);
        const { api } = await import('./acceptance/harness');
        const res = await api('GET', '/api/picks/today', { cookie });
        console.log(`  DAILY_PICK_CAP (observed via /api/picks/today.remaining on a zero-pick account) = ${res.json?.remaining ?? 'UNKNOWN - endpoint shape may have changed'}`);
        await cleanupUsersByEmailPrefix('acceptance-config-probe');
    } catch (err) {
        console.log(`  DAILY_PICK_CAP - could not observe (${(err as Error).message})`);
    }
    console.log('#'.repeat(72) + '\n');
}

async function main() {
    const ALL_SUITES = await loadSuites();

    const requestedNames = process.argv.slice(2).filter((a) => !a.startsWith('-'));
    const selected = requestedNames.length
        ? ALL_SUITES.filter((s) => requestedNames.includes(s.name))
        : ALL_SUITES;
    if (requestedNames.length) {
        const known = new Set(ALL_SUITES.map((s) => s.name));
        for (const name of requestedNames) {
            if (!known.has(name)) {
                console.error(`Unknown suite "${name}". Known suites: ${ALL_SUITES.map((s) => s.name).join(', ')}`);
                process.exit(2);
            }
        }
    }

    const requiredEnv = new Set<string>();
    for (const s of selected) for (const e of s.requiredEnv) requiredEnv.add(e);
    const missing = [...requiredEnv].filter((e) => !process.env[e]);
    if (missing.length) {
        console.error(`Missing required env for selected suites: ${missing.join(', ')}`);
        process.exit(2);
    }

    console.log(`Acceptance run against ${process.env.BASE_URL || 'http://localhost:8788'}`);
    console.log(`Suites: ${selected.map((s) => s.name).join(', ')}`);
    await printResolvedConfig();

    for (const s of selected) {
        setActiveSuite(s.name);
        try {
            await s.run();
        } catch (err) {
            console.error(`  SUITE ABORTED (${s.name}):`, err);
            // Record the abort as a failure so the summary/exit code reflect it, then
            // continue to the next suite rather than losing every remaining phase.
            const { check } = await import('./acceptance/harness');
            check(`${s.name} suite completed without throwing`, false, String(err));
        }
    }

    const totalFail = printSummary();
    process.exit(totalFail > 0 ? 1 : 0);
}

main()
    .catch(async (err) => {
        console.error('\nRunner aborted:', err);
        process.exit(1);
    })
    .finally(async () => {
        await runTeardowns();
        await pool.end();
    });
