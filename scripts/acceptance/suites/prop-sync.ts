// Acceptance suite for the Polymarket prop sync's FRESHNESS (2026-09-11). DB only - no
// HTTP, no fixtures, no cleanup.
//
// WHY THIS EXISTS: the props table is filled by the admin backend's in-process
// scheduler (polymarket.ts startPolymarketScheduler, every 15 minutes), which only runs
// while that machine is on. Nothing else writes polymarket_props, and every slate lock
// (functions/api/index-lock.ts) reads it - so a stalled sync silently empties the next
// lock window. Polymarket lists Champions League fixtures only for the imminent
// matchday, so a stall around a matchday means those games are never locked and never
// scored. Sammy chose (2026-09-11) to keep the sync on the admin backend rather than
// move it onto a Worker; this suite is the tripwire that makes a stall visible.
//
// FAILS, not warns, on a stale league: a full cycle across the leagues takes ~8-10
// minutes, so an hour of silence is a stopped scheduler, not a slow one.

import { pool, check, section, warn, type Suite } from '../harness';
import { SUPPORTED_LEAGUES } from '../../../polymarket';

const MAX_STALE_MINUTES = 60;

async function run() {
    section('Polymarket prop sync - every supported league has synced within the hour');
    const { rows } = await pool.query(`
        SELECT league,
               MAX(synced_at) AS last_synced,
               EXTRACT(EPOCH FROM (NOW() - MAX(synced_at))) / 60 AS minutes_ago,
               COUNT(*)::int AS props
        FROM polymarket_props
        GROUP BY league`);
    const byLeague = new Map(rows.map((r) => [r.league as string, r]));

    const missing = SUPPORTED_LEAGUES.filter((l) => !byLeague.has(l));
    check('every league in LEAGUE_TAGS has rows in polymarket_props', missing.length === 0, `never synced: ${missing.join(', ')}`);

    const stale = SUPPORTED_LEAGUES.filter((l) => {
        const r = byLeague.get(l);
        return r && Number(r.minutes_ago) > MAX_STALE_MINUTES;
    });
    check(`every league synced within the last ${MAX_STALE_MINUTES} minutes (admin backend scheduler is running)`,
        stale.length === 0,
        stale.map((l) => `${l}: ${Math.round(Number(byLeague.get(l)!.minutes_ago))} min ago`).join(', '));

    // The sync targets closed=false events, so a league with a live schedule should hold
    // at least one open, upcoming game-line market between passes; a league out of season
    // legitimately holds none. Reported, never failed - the freshness check above is the
    // contract, this is the diagnostic that says which leagues the next lock can see.
    const { rows: upcoming } = await pool.query(`
        SELECT league, COUNT(DISTINCT event_id)::int AS games
        FROM polymarket_props
        WHERE closed IS DISTINCT FROM TRUE AND market_type IN ('totals', 'moneyline')
          AND event_start_time > NOW() AND event_start_time < NOW() + INTERVAL '9 hours'
        GROUP BY league ORDER BY games DESC`);
    const inWindow = upcoming.map((r) => `${r.league}=${r.games}`).join(' ');
    console.log(`  next lock window (9h) sees: ${inWindow || 'no games'}`);

    const ucl = byLeague.get('Champions League');
    check('Champions League tag has been ingested', !!ucl && Number(ucl.props) > 0);
    if (!upcoming.some((r) => r.league === 'Champions League')) {
        warn('no Champions League fixture inside the next 9h lock window - normal between matchdays (Polymarket lists UCL only for the imminent matchday)');
    }
}

export const suite: Suite = {
    name: 'prop-sync',
    requiredEnv: [],
    run,
};
