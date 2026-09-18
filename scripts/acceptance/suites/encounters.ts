// Acceptance suite for NPC encounters - lib/pages-functions/encounters/ (registry +
// evaluate), ledger.encounterGiftEmber, the toolbar-state wiring, and
// functions/api/encounters/seen.ts. Drives the real endpoints against the dev server
// and asserts DB rows + wire shape, discovery-suite style. Thresholds are flipped via
// game_config so the suite never has to earn 500 real Ember.

import crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'node:url';
import { pool, api, check, warn, section, type Suite } from '../harness';
import {
    createSessionUser, cleanupUsersByEmailPrefix, seedLifetimeEarned, ledgerTotals,
    flipConfig, restoreConfig, activeConfig, insertTank, cleanupTanksBySlugPrefix,
} from '../fixtures';
import { CHARACTERS, ENCOUNTERS, ENCOUNTER_BY_KEY, PLAY_BY_KEY, portraitSrc } from '../../../lib/pages-functions/encounters';
import { triggerSatisfied, placeMatches, type Facts } from '../../../lib/pages-functions/encounters/evaluate';
import { forcedFind, playComplete, playProgress, type PlayRow } from '../../../lib/pages-functions/encounters/plays';
import { placeFromPath } from '../../../lib/pages-functions/discovery';
import { LIFETIME_EARNED_RULE_KEYS } from '../../../lib/pages-functions/ledger';

const EMAIL_PREFIX = 'acceptance-encounters-';
const TANK_SLUG_PREFIX = 'acceptance-encounters-';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// This suite drives the BEAKS arc end to end, and along the way it makes picks and
// feeds a pet - which legitimately triggers Blobby (first pick) and Puffington (three
// feeds) mid-run and would wreck every "exactly one/two encounters" count. Those two
// are parked as already-seen for the test account (parkEarlyCharacters) and excluded
// from encounterRows, so the arc under test runs alone. Their own trigger logic is
// covered by the pure-rules section and the registry sanity section.
const PARKED = ['blobby_intro', 'puffington_intro'];

async function insertPet(userId: string): Promise<string> {
    const { rows } = await pool.query(`INSERT INTO pets (user_id, color) VALUES ($1, 'slate') RETURNING id`, [userId]);
    return rows[0].id as string;
}

async function parkEarlyCharacters(userId: string): Promise<void> {
    await pool.query(
        `INSERT INTO encounters (user_id, encounter_key, character_key, status, seen_at)
         VALUES ($1, 'blobby_intro', 'blobby', 'seen', NOW()),
                ($1, 'puffington_intro', 'puffington', 'seen', NOW())
         ON CONFLICT (user_id, encounter_key) DO NOTHING`,
        [userId],
    );
}

async function encounterRows(userId: string) {
    const { rows } = await pool.query(
        `SELECT id, encounter_key, character_key, status, grants FROM encounters
         WHERE user_id = $1 AND encounter_key <> ALL($2::text[]) ORDER BY created_at`,
        [userId, PARKED],
    );
    return rows as Array<{ id: string; encounter_key: string; character_key: string; status: string; grants: Record<string, any> }>;
}

async function playRows(userId: string) {
    const { rows } = await pool.query(
        `SELECT id, play_key, objective, baseline, visited, completed_at, reward_encounter_key FROM plays WHERE user_id = $1 ORDER BY started_at`,
        [userId],
    );
    return rows as Array<{ id: string; play_key: string; objective: any; baseline: any; visited: string[]; completed_at: string | null; reward_encounter_key: string }>;
}

// Source files that must no longer speak the old vocabulary. The patterns are assembled
// from fragments so this file does not match itself.
// Word-bounded, so 'request_key' is not mistaken for the old column.
const OLD_WORDS = ['quest' + '_completed', 'start' + '_quest', 'Quest' + 'Row', 'quest' + 'Complete', 'FROM ' + 'quests', 'INTO ' + 'quests', 'UPDATE ' + 'quests', 'quest' + '_key']
    .map((w) => new RegExp(`\\b${w}\\b`));

function sourceFilesUnder(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) sourceFilesUnder(full, out);
        else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
    return out;
}

async function cleanup() {
    await cleanupUsersByEmailPrefix(EMAIL_PREFIX);
    await cleanupTanksBySlugPrefix(TANK_SLUG_PREFIX);
}

function fakeFacts(over: Partial<Facts>): Facts {
    return {
        lifetimeEarned: 0, picks: 0, wins: 0, collectibles: 0, feeds: 0, place: null, holdings: {},
        profitSells: 0, shares: {}, heldThroughClose: false, petSustainedSatisfied: false, petNamed: false,
        encounters: [], plays: [],
        ...over,
    };
}

async function run() {
    await cleanup();

    // --- Registry sanity ---
    section('Registry - every definition is internally consistent and backed by live rows');
    const encCfg = await activeConfig('encounters');
    for (const e of ENCOUNTERS) {
        check(`${e.key}: character '${e.character}' exists`, Boolean(CHARACTERS[e.character]));
        check(`${e.key}: has dialogue with both speakers`,
            e.dialogue.length >= 2 && e.dialogue.some((d) => d.speaker === 'character') && e.dialogue.some((d) => d.speaker === 'pet'));
        check(`${e.key}: once === true`, e.once === true);
        // The reveal marker names the line that hands something over, so it only makes
        // sense on an encounter that actually grants, and only once.
        const reveals = e.dialogue.filter((d) => d.reveal).length;
        check(`${e.key}: at most one reveal step`, reveals <= 1, String(reveals));
        check(`${e.key}: a reveal step only where something is granted`,
            reveals === 0 || e.effects.some((f) => f.kind === 'grant_item' || f.kind === 'grant_ember'));
        check(`${e.key}: an encounter that grants marks the line that hands it over`,
            !e.effects.some((f) => f.kind === 'grant_item' || f.kind === 'grant_ember') || reveals === 1);
        for (const t of e.trigger) {
            if (t.kind === 'lifetime_earned_at_least') {
                check(`${e.key}: configKey '${t.configKey}' present in active game_config['encounters']`, Number.isFinite(Number(encCfg[t.configKey])), JSON.stringify(encCfg));
            }
            if (t.kind === 'after_encounter' || t.kind === 'play_completed') {
                const target = t.kind === 'after_encounter'
                    ? Boolean(ENCOUNTER_BY_KEY[t.key])
                    : Boolean(PLAY_BY_KEY[t.key]);
                check(`${e.key}: ${t.kind} '${t.key}' refers to a registered ${t.kind === 'after_encounter' ? 'encounter' : 'Play'}`, target);
            }
        }
        for (const f of e.effects) {
            if (f.kind === 'grant_item') {
                const { rows } = await pool.query(`SELECT item_type, name, config FROM items_catalog WHERE key = $1`, [f.catalogKey]);
                check(`${e.key}: grant_item '${f.catalogKey}' exists in items_catalog as '${f.itemType}'`, rows.length === 1 && rows[0].item_type === f.itemType);
                // The stage renders whatever the fire statement resolved, so a SKU whose
                // art was never imported has to trip HERE rather than as a broken image
                // in front of a player. Same derivation as fireEncounter's CASE.
                const art = rows[0] && (rows[0].item_type === 'food' ? `food/${f.catalogKey}.png`
                    : rows[0].item_type === 'memorabilia' ? rows[0].config?.image
                    : rows[0].item_type === 'collectible' ? rows[0].config?.cover_image : null);
                if (art) {
                    check(`${e.key}: reward art '${art}' exists on disk`, fs.existsSync(path.join(REPO_ROOT, 'assets/images', art)), art);
                } else {
                    check(`${e.key}: '${f.catalogKey}' is a type with no artwork (egg) - the reveal falls back to a shape`, rows[0]?.item_type === 'egg');
                }
            }
            if (f.kind === 'grant_ember') {
                const { rows } = await pool.query(`SELECT kind FROM ember_rules WHERE key = $1 AND active`, [f.ruleKey]);
                check(`${e.key}: grant_ember '${f.ruleKey}' is an active source rule`, rows.length === 1 && rows[0].kind === 'source');
                check(`${e.key}: '${f.ruleKey}' is NOT a lifetime-earned key (a gift never ranks)`, !(LIFETIME_EARNED_RULE_KEYS as readonly string[]).includes(f.ruleKey));
            }
            if (f.kind === 'start_play') {
                const p = f.play;
                const reward = ENCOUNTER_BY_KEY[p.rewardEncounter];
                check(`${e.key}: Play '${p.key}' has a title`, typeof p.title === 'string' && p.title.trim().length > 0);
                check(`${e.key}: Play '${p.key}' reward encounter '${p.rewardEncounter}' exists and waits on play_completed`,
                    Boolean(reward) && reward.trigger.some((t) => t.kind === 'play_completed' && t.key === p.key));
                // A reward that can stall leaves the receipt's "what you got" half empty,
                // so it may wait on nothing but its own Play and the scene that started it.
                check(`${e.key}: Play '${p.key}' reward carries no trigger that could block it`,
                    Boolean(reward) && reward.trigger.every((t) =>
                        (t.kind === 'play_completed' && t.key === p.key) || (t.kind === 'after_encounter' && t.key === e.key)),
                    JSON.stringify(reward?.trigger));
                // Every objective in the Play, flattened: a compound beat's parts are
                // held to exactly the same rules as a standalone objective.
                const parts = p.objective.kind === 'all_of' ? p.objective.parts : [p.objective];
                if (p.objective.kind === 'all_of') {
                    check(`${e.key}: '${p.key}' compound has 2-4 parts`,
                        parts.length >= 2 && parts.length <= 4, String(parts.length));
                    // playProgress recurses exactly one level; a nested compound would
                    // silently measure nothing.
                    check(`${e.key}: '${p.key}' compound is not nested`, parts.every((x) => x.kind !== 'all_of'));
                    check(`${e.key}: '${p.key}' asks each kind at most once`,
                        new Set(parts.map((x) => x.kind)).size === parts.length, JSON.stringify(parts.map((x) => x.kind)));
                    // One Play, one hand-over place.
                    check(`${e.key}: '${p.key}' has at most one delivery part`,
                        parts.filter((x) => x.kind === 'deliver_items').length <= 1);
                }
                for (const part of parts) {
                    if (part.kind === 'hold_shares') {
                        check(`${e.key}: '${p.key}' hold_shares sets shares or indexes`,
                            Number(part.shares ?? 0) > 0 || Number(part.indexes ?? 0) > 0, JSON.stringify(part));
                    }
                    if (part.kind === 'read_articles' || part.kind === 'win_picks' || part.kind === 'sell_profit') {
                        check(`${e.key}: '${p.key}' ${part.kind} count is a positive integer`,
                            Number.isInteger(part.count) && part.count >= 1, String(part.count));
                    }
                    if (part.kind !== 'deliver_items') continue;
                    const home = CHARACTERS[e.character]?.home;
                    check(`${e.key}: delivery '${p.key}' belongs to a character with a home`, typeof home === 'string');
                    check(`${e.key}: home '${home}' is a real place key`,
                        typeof home === 'string' && placeFromPath(`/${home}/`)?.key === home, String(home));
                    const keys = part.items.map((i) => i.catalogKey);
                    check(`${e.key}: delivery '${p.key}' asks for at least one item, no duplicates`,
                        keys.length > 0 && new Set(keys).size === keys.length, JSON.stringify(keys));
                    for (const i of part.items) {
                        check(`${e.key}: '${i.catalogKey}' count is a positive integer`, Number.isInteger(i.count) && i.count >= 1, String(i.count));
                        const { rows } = await pool.query(`SELECT item_type, active, config FROM items_catalog WHERE key = $1`, [i.catalogKey]);
                        const row = rows[0];
                        // Memorabilia or food only. Both stack and have no serial; food is
                        // allowed because the hand-over shares the feeding lock, which is
                        // what keeps a delivery and a feed from spending the same unit.
                        check(`${e.key}: '${i.catalogKey}' is active memorabilia or food`,
                            rows.length === 1 && row.active === true
                            && (row.item_type === 'memorabilia' || row.item_type === 'food'), JSON.stringify(row));
                        // Every requested item has to be OBTAINABLE one way or the other:
                        // findable (droppable with a weight, so the guarantee can deliver
                        // it) or buyable (a shop SKU, which carries a vendor). A held-back
                        // item would make the Play unfinishable.
                        const findable = row?.config?.discovery_droppable === true
                            && Number(row?.config?.discovery_weight ?? 1) > 0
                            && !('vendor' in (row?.config ?? {}));
                        const buyable = typeof row?.config?.vendor === 'string';
                        check(`${e.key}: '${i.catalogKey}' can be found or bought`, findable || buyable,
                            JSON.stringify(row?.config));
                        const art = row?.item_type === 'food' ? `food/${i.catalogKey}.png` : row?.config?.image;
                        check(`${e.key}: '${i.catalogKey}' art exists on disk`,
                            typeof art === 'string' && fs.existsSync(path.join(REPO_ROOT, 'assets/images', art)), String(art));
                    }
                }
            }
        }
    }
    const playKeys = ENCOUNTERS.flatMap((e) => e.effects.flatMap((f) => (f.kind === 'start_play' ? [f.play.key] : [])));
    check('every Play key is unique across the registry', new Set(playKeys).size === playKeys.length, JSON.stringify(playKeys));

    // --- Arc shape: every beat of every chain is reachable, and nothing loops ---
    section('Arcs - each character chain is reachable from its first scene and never cycles');
    // An encounter is reachable when every one of its triggers can eventually hold: a
    // play_completed needs a Play some reachable scene starts, an after_encounter needs a
    // reachable scene. Anything else (a threshold, a place) is reachable on its own.
    // Iterating to a fixed point is what proves there is no cycle: a scene that only
    // waits on something downstream of itself never becomes reachable.
    const reachable = new Set<string>();
    const startedPlays = new Set<string>();
    for (let pass = 0; pass < ENCOUNTERS.length + 1; pass++) {
        let grew = false;
        for (const e of ENCOUNTERS) {
            if (reachable.has(e.key)) continue;
            const ok = e.trigger.every((t) =>
                t.kind === 'after_encounter' ? reachable.has(t.key)
                : t.kind === 'play_completed' ? startedPlays.has(t.key)
                : true);
            if (!ok) continue;
            reachable.add(e.key);
            for (const f of e.effects) if (f.kind === 'start_play') startedPlays.add(f.play.key);
            grew = true;
        }
        if (!grew) break;
    }
    const unreachable = ENCOUNTERS.filter((e) => !reachable.has(e.key)).map((e) => e.key);
    check('every encounter is reachable (no cycles, no orphan beats)', unreachable.length === 0, unreachable.join(', '));
    // A Play nobody starts can never appear; a Play two scenes start would be ambiguous.
    const starters = new Map<string, string[]>();
    for (const e of ENCOUNTERS) {
        for (const f of e.effects) {
            if (f.kind !== 'start_play') continue;
            starters.set(f.play.key, [...(starters.get(f.play.key) ?? []), e.key]);
        }
    }
    const multi = [...starters.entries()].filter(([, owners]) => owners.length > 1);
    check('every Play is started by exactly one scene', multi.length === 0, JSON.stringify(multi));
    // Each arc should read as a ladder: one scene per beat, each beat gated on the last.
    for (const c of Object.values(CHARACTERS)) {
        const mine = ENCOUNTERS.filter((e) => e.character === c.key);
        const plays = mine.flatMap((e) => e.effects.flatMap((f) => (f.kind === 'start_play' ? [f.play.key] : [])));
        check(`${c.key}: every Play it starts is its own reward chain (${plays.length} Plays, ${mine.length} scenes)`,
            plays.every((k) => {
                const reward = ENCOUNTERS.find((e) => e.trigger.some((t) => t.kind === 'play_completed' && t.key === k));
                return reward?.character === c.key;
            }), JSON.stringify(plays));
    }

    // --- The quests -> plays rename ---
    section('Rename - quests are Plays in source and in the database');
    const offenders: string[] = [];
    const selfPath = fileURLToPath(import.meta.url);
    for (const dir of ['lib', 'functions', 'components', 'scripts']) {
        for (const file of sourceFilesUnder(path.join(REPO_ROOT, dir))) {
            if (path.resolve(file) === path.resolve(selfPath)) continue;
            const src = fs.readFileSync(file, 'utf8');
            for (const w of OLD_WORDS) {
                if (w.test(src)) offenders.push(`${path.relative(REPO_ROOT, file)}: ${w.source}`);
            }
        }
    }
    check('no source file still uses the quest vocabulary', offenders.length === 0, offenders.join('; '));
    const { rows: shape } = await pool.query(
        `SELECT (SELECT relkind::text FROM pg_class WHERE relname = 'plays' AND relnamespace = 'public'::regnamespace) AS plays,
                (SELECT relkind::text FROM pg_class WHERE relname = 'quests' AND relnamespace = 'public'::regnamespace) AS quests`);
    check("'plays' is a table", shape[0].plays === 'r', JSON.stringify(shape[0]));
    if (shape[0].quests === 'v') {
        warn("the 'quests' compatibility view is still present - run drop_quests_compat_view.sql once the Plays code is live everywhere");
    } else {
        check("no 'quests' relation remains", shape[0].quests === null, JSON.stringify(shape[0]));
    }
    // --- Portraits: declared, allowlisted, and actually on disk ---
    section('Portraits - every expression is a shipped, allowlisted, on-disk webp');
    const EXPRESSIONS = ['main', 'happy', 'sad', 'ecstatic'];
    // Parsed out of the build script rather than hardcoded, so art added to a
    // character without being allowlisted trips HERE instead of in a Cloudflare build
    // log (the source-read idiom from suites/security.ts).
    const buildSrc = fs.readFileSync(path.join(REPO_ROOT, 'scripts/generate-static-site.ts'), 'utf8');
    const allowlistBody = buildSrc.match(/const NEW_SITE_IMAGES = \[([\s\S]*?)\n\];/)?.[1] ?? '';
    // Match only lines that are ENTIRELY one quoted entry. A bare /'([^']+)'/g over the
    // block silently mis-pairs on the apostrophes inside the comments between entries
    // ("heatchecks-logo.webp's lettering...") and finds a third of the real list.
    const allowlisted = new Set(
        allowlistBody.split(/\r?\n/)
            .map((line) => line.match(/^\s*'([^']+)',?\s*$/)?.[1])
            .filter((v): v is string => Boolean(v)),
    );
    check('NEW_SITE_IMAGES parsed out of generate-static-site.ts', allowlisted.size > 40, `${allowlisted.size} entries`);
    for (const c of Object.values(CHARACTERS)) {
        check(`${c.key}: has a main portrait`, typeof c.portraits.main === 'string' && c.portraits.main.length > 0);
        check(`${c.key}: has an alt description`, typeof c.alt === 'string' && c.alt.length > 10, c.alt);
        for (const [exp, src] of Object.entries(c.portraits)) {
            check(`${c.key}/${exp}: is a known expression`, EXPRESSIONS.includes(exp));
            check(`${c.key}/${exp}: literal /assets/images/characters/*.webp`,
                /^\/assets\/images\/characters\/[A-Za-z0-9._-]+\.webp$/.test(src as string), src as string);
            const rel = (src as string).replace('/assets/images/', '');
            check(`${c.key}/${exp}: '${rel}' is allowlisted in NEW_SITE_IMAGES`, allowlisted.has(rel), rel);
            check(`${c.key}/${exp}: exists on disk`, fs.existsSync(path.join(REPO_ROOT, 'assets/images', rel)));
        }
    }
    // The pet's Mood and a character's Expression are separate vocabularies on
    // purpose: Mood also names the pet's sprites and shares its values with
    // notifications.mood's CHECK constraint. A step must never carry the other one's.
    for (const e of ENCOUNTERS) {
        const c = CHARACTERS[e.character];
        if (!c) continue;
        for (const [i, s] of e.dialogue.entries()) {
            if (s.speaker === 'pet') {
                check(`${e.key}[${i}]: pet step carries no character expression`, s.expression === undefined);
                check(`${e.key}[${i}]: pet mood is happy|sad or absent`,
                    s.mood === undefined || s.mood === 'happy' || s.mood === 'sad', String(s.mood));
            } else {
                check(`${e.key}[${i}]: character step carries no pet mood`, s.mood === undefined);
                check(`${e.key}[${i}]: expression '${s.expression ?? 'main'}' resolves to a shipped webp`,
                    portraitSrc(c, s.expression ?? 'main').endsWith('.webp'));
            }
        }
    }
    // The ragged sets: asking for a face a character does not own must fall back, not
    // yield undefined and a broken <img>.
    check('fallback: an expression a character lacks resolves to main',
        portraitSrc(CHARACTERS.blobby, 'sad') === CHARACTERS.blobby.portraits.main
        && portraitSrc(CHARACTERS.charles, 'happy') === CHARACTERS.charles.portraits.main
        && portraitSrc(CHARACTERS.vic, 'ecstatic') === CHARACTERS.vic.portraits.main);

    // --- Pure rules ---
    section('Pure rules - triggerSatisfied / playComplete / placeMatches');
    const cfg = { t: 500 };
    check('lifetime_earned_at_least: 499 < 500', !triggerSatisfied({ kind: 'lifetime_earned_at_least', configKey: 't' }, fakeFacts({ lifetimeEarned: 499 }), cfg));
    check('lifetime_earned_at_least: 500 >= 500', triggerSatisfied({ kind: 'lifetime_earned_at_least', configKey: 't' }, fakeFacts({ lifetimeEarned: 500 }), cfg));
    check('lifetime_earned_at_least: missing configKey never fires', !triggerSatisfied({ kind: 'lifetime_earned_at_least', configKey: 'nope' }, fakeFacts({ lifetimeEarned: 10_000 }), cfg));
    check('picks_at_least / feeds_at_least / collectibles_at_least',
        triggerSatisfied({ kind: 'picks_at_least', count: 2 }, fakeFacts({ picks: 2 }), cfg)
        && !triggerSatisfied({ kind: 'feeds_at_least', count: 3 }, fakeFacts({ feeds: 2 }), cfg)
        && triggerSatisfied({ kind: 'collectibles_at_least', count: 1 }, fakeFacts({ collectibles: 1 }), cfg));
    check("at_place: prefix 'tankdaq' matches 'tankdaq:chalk' and 'tankdaq', not 'the-tank'",
        placeMatches('tankdaq:chalk', 'tankdaq') && placeMatches('tankdaq', 'tankdaq') && !placeMatches('the-tank', 'tankdaq') && !placeMatches(null, 'tankdaq'));
    check("after_encounter: needs status 'seen'",
        !triggerSatisfied({ kind: 'after_encounter', key: 'x' }, fakeFacts({ encounters: [{ id: 'a', key: 'x', status: 'offered', grants: {} }] }), cfg)
        && triggerSatisfied({ kind: 'after_encounter', key: 'x' }, fakeFacts({ encounters: [{ id: 'a', key: 'x', status: 'seen', grants: {} }] }), cfg));
    const q = (objective: PlayRow['objective'], baseline: PlayRow['baseline'] = { feeds: 1, picks: 1, lifetime_earned: 100 }, visited: string[] = []): PlayRow =>
        ({ id: 'q', key: 'q', objective, baseline, visited, completedAt: null, rewardEncounterKey: 'r' });
    check('playComplete picks: baseline-relative (baseline 1, need 2, have 3)',
        playComplete(q({ kind: 'picks', count: 2 }), fakeFacts({ picks: 3 })) && !playComplete(q({ kind: 'picks', count: 2 }), fakeFacts({ picks: 2 })));
    check('playComplete earn_ember: baseline-relative', playComplete(q({ kind: 'earn_ember', amount: 50 }), fakeFacts({ lifetimeEarned: 150 })) && !playComplete(q({ kind: 'earn_ember', amount: 50 }), fakeFacts({ lifetimeEarned: 149 })));
    check('playComplete visit_places: every wanted place visited (prefix ok)',
        playComplete(q({ kind: 'visit_places', places: ['tankdaq', 'the-hatchery'] }, undefined, ['tankdaq:dogs', 'the-hatchery']), fakeFacts({}))
        && !playComplete(q({ kind: 'visit_places', places: ['tankdaq', 'the-hatchery'] }, undefined, ['tankdaq:dogs']), fakeFacts({})));
    check('play_completed: needs completedAt', triggerSatisfied({ kind: 'play_completed', key: 'q' }, fakeFacts({ plays: [{ ...q({ kind: 'picks', count: 1 }), completedAt: '2026-01-01' }] }), cfg));

    // --- The kinds the character arcs added ---
    check('win_picks: baseline-relative',
        playComplete(q({ kind: 'win_picks', count: 2 }, { feeds: 0, picks: 0, lifetime_earned: 0, wins: 1 }), fakeFacts({ wins: 3 }))
        && !playComplete(q({ kind: 'win_picks', count: 2 }, { feeds: 0, picks: 0, lifetime_earned: 0, wins: 1 }), fakeFacts({ wins: 2 })));
    check('read_articles: counts DISTINCT article places only',
        playComplete(q({ kind: 'read_articles', count: 2 }, undefined, ['article:a', 'article:b', 'the-tank']), fakeFacts({}))
        && !playComplete(q({ kind: 'read_articles', count: 2 }, undefined, ['article:a', 'the-tank', 'tankdaq']), fakeFacts({})));
    check('hold_shares: by total shares, and by number of indexes',
        playComplete(q({ kind: 'hold_shares', shares: 5 }), fakeFacts({ shares: { dogs: 5 } }))
        && !playComplete(q({ kind: 'hold_shares', shares: 5 }), fakeFacts({ shares: { dogs: 4 } }))
        && playComplete(q({ kind: 'hold_shares', indexes: 2 }), fakeFacts({ shares: { dogs: 1, chalk: 1 } }))
        && !playComplete(q({ kind: 'hold_shares', indexes: 2 }), fakeFacts({ shares: { dogs: 50 } })));
    check('sell_profit: baseline-relative',
        playComplete(q({ kind: 'sell_profit', count: 3 }, { feeds: 0, picks: 0, lifetime_earned: 0, profit_sells: 2 }), fakeFacts({ profitSells: 5 }))
        && !playComplete(q({ kind: 'sell_profit', count: 3 }, { feeds: 0, picks: 0, lifetime_earned: 0, profit_sells: 2 }), fakeFacts({ profitSells: 4 })));
    check('moment kinds: true only while the fact is true',
        playComplete(q({ kind: 'hold_through_close' }), fakeFacts({ heldThroughClose: true }))
        && !playComplete(q({ kind: 'hold_through_close' }), fakeFacts({}))
        && playComplete(q({ kind: 'pet_sustained_satisfied' }), fakeFacts({ petSustainedSatisfied: true }))
        && !playComplete(q({ kind: 'pet_sustained_satisfied' }), fakeFacts({}))
        && playComplete(q({ kind: 'name_pet' }), fakeFacts({ petNamed: true }))
        && !playComplete(q({ kind: 'name_pet' }), fakeFacts({})));
    // A missing baseline (a row written before the kind existed) measures from zero
    // rather than throwing.
    check('a counting kind with no baseline measures from zero',
        playComplete(q({ kind: 'win_picks', count: 2 }, { feeds: 0, picks: 0, lifetime_earned: 0 }), fakeFacts({ wins: 2 })));

    // --- Compound objectives ---
    const compound = (parts: any[], visited: string[] = []) =>
        q({ kind: 'all_of', parts }, { feeds: 0, picks: 0, lifetime_earned: 0, wins: 0 }, visited);
    check('all_of: every part must hold at the same moment',
        !playComplete(compound([{ kind: 'win_picks', count: 2 }, { kind: 'pet_sustained_satisfied' }]), fakeFacts({ wins: 5 }))
        && !playComplete(compound([{ kind: 'win_picks', count: 2 }, { kind: 'pet_sustained_satisfied' }]), fakeFacts({ petSustainedSatisfied: true }))
        && playComplete(compound([{ kind: 'win_picks', count: 2 }, { kind: 'pet_sustained_satisfied' }]), fakeFacts({ wins: 5, petSustainedSatisfied: true })));
    const compoundProgress = playProgress(
        compound([{ kind: 'win_picks', count: 4 }, { kind: 'read_articles', count: 2 }], ['article:a']),
        fakeFacts({ wins: 1 }),
    );
    check('all_of: progress lists a part per objective, with its own numbers',
        compoundProgress.parts?.length === 2
        && compoundProgress.parts?.[0].done === 1 && compoundProgress.parts?.[0].target === 4
        && compoundProgress.parts?.[1].done === 1 && compoundProgress.parts?.[1].target === 2
        && compoundProgress.done === 2 && compoundProgress.target === 6, JSON.stringify(compoundProgress));
    // A compound delivery is still gated on the character's home, like a plain one.
    const compoundDelivery = (place: string | null) => playComplete(
        {
            ...compound([
                { kind: 'deliver_items', items: [{ catalogKey: 'x', count: 1 }] },
                { kind: 'win_picks', count: 1 },
            ]),
            objective: {
                kind: 'all_of',
                home: 'the-tank',
                parts: [
                    { kind: 'deliver_items', items: [{ catalogKey: 'x', count: 1 }] },
                    { kind: 'win_picks', count: 1 },
                ],
            } as any,
        },
        fakeFacts({ wins: 1, holdings: { x: 1 }, place }),
    );
    check('all_of: a delivery part still completes only at the home', compoundDelivery('the-tank') && !compoundDelivery('tankdaq'));
    check('forcedFind: never forces a shop item, and skips a stocked one',
        forcedFind([{
            ...compound([{ kind: 'deliver_items', items: [
                { catalogKey: 'shop', count: 1, forceable: false },
                { catalogKey: 'found', count: 1, forceable: true },
            ] }]),
            baseline: { feeds: 0, picks: 0, lifetime_earned: 0, finds: 0 },
        }], fakeFacts({}), 2, 3) === 'found');

    // --- Petless ---
    section('Petless account - nothing runs, encounter: null');
    const petless = await createSessionUser(`${EMAIL_PREFIX}petless@example.com`);
    await seedLifetimeEarned(petless.userId, 100_000);
    const petlessRes = await api('GET', '/api/toolbar-state', { cookie: petless.cookie });
    check('200, encounter null despite a huge lifetime_earned', petlessRes.status === 200 && petlessRes.json?.encounter === null, JSON.stringify(petlessRes.json?.encounter));
    check('zero encounters rows', (await encounterRows(petless.userId)).length === 0);

    // --- Below threshold ---
    section('Below threshold - no row, nothing granted');
    const player = await createSessionUser(`${EMAIL_PREFIX}player@example.com`);
    const petId = await insertPet(player.userId);
    const below = await api('GET', '/api/toolbar-state', { cookie: player.cookie });
    check('encounter null at zero lifetime_earned', below.status === 200 && below.json?.encounter === null);
    check('zero encounters rows', (await encounterRows(player.userId)).length === 0);

    try {
        // --- Fire ---
        section('Fire - threshold crossed: exactly one encounter, one grant, one Play, NO inbox row, in the same response');
        await parkEarlyCharacters(player.userId);
        await flipConfig('encounters', { beaks_intro_ember: 1 });
        await seedLifetimeEarned(player.userId, 1);
        const results = await Promise.all(Array.from({ length: 10 }, () => api('GET', '/api/toolbar-state', { cookie: player.cookie })));
        const rows1 = await encounterRows(player.userId);
        check('10 concurrent GETs -> exactly one encounters row (beaks_intro, offered)',
            rows1.length === 1 && rows1[0].encounter_key === 'beaks_intro' && rows1[0].status === 'offered', JSON.stringify(rows1));
        check('grants.item carries catalogKey, itemType, the catalog name and the resolved art path',
            rows1[0]?.grants?.item?.catalogKey === 'food_ribeye'
            && rows1[0]?.grants?.item?.itemType === 'food'
            && rows1[0]?.grants?.item?.name === 'Ribeye Steak'
            && rows1[0]?.grants?.item?.art === 'food/food_ribeye.png', JSON.stringify(rows1[0]?.grants));
        const { rows: ribeye } = await pool.query(`SELECT quantity FROM inventory_items WHERE user_id = $1 AND catalog_key = 'food_ribeye' AND item_type = 'food'`, [player.userId]);
        check('exactly one Ribeye in inventory', ribeye.length === 1 && ribeye[0].quantity === 1, JSON.stringify(ribeye));
        const plays1 = await playRows(player.userId);
        check("one Play 'beaks_first_trade' with a zero baseline and reward 'beaks_quest_done'",
            plays1.length === 1 && plays1[0].play_key === 'beaks_first_trade' && Number(plays1[0].baseline.picks) === 0
            && Number(plays1[0].baseline.feeds) === 0 && Number(plays1[0].baseline.finds) === 0
            && plays1[0].reward_encounter_key === 'beaks_quest_done' && plays1[0].completed_at === null,
            JSON.stringify(plays1));
        check('the stored objective carries the registry title (frozen at start)',
            plays1[0]?.objective?.title === PLAY_BY_KEY.beaks_first_trade.title && plays1[0]?.objective?.kind === 'picks',
            JSON.stringify(plays1[0]?.objective));
        const { rows: notes1 } = await pool.query(
            `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND ref_type = 'encounter'`, [player.userId]);
        check('NO encounter notification is written (the reveal on stage is the acknowledgement)', notes1[0].n === 0, JSON.stringify(notes1));
        check('every response is 200', results.every((r) => r.status === 200));
        // Concurrency contract: the losers of the fire race took their facts snapshot
        // before the winner's row committed, so they legitimately answer `null` on THAT
        // response - the very next read (asserted below) offers it. What must never
        // happen is a response carrying some other encounter, or a second row existing.
        const carrying = results.filter((r) => r.json?.encounter?.key === 'beaks_intro');
        check('at least one concurrent response carries the encounter, and none carries a different one',
            carrying.length >= 1 && results.every((r) => r.json?.encounter === null || r.json?.encounter?.id === rows1[0].id),
            `${carrying.length}/10 carried it`);
        const view = carrying[0]?.json?.encounter;
        check('wire shape: id, character {key,name,title}, dialogue, grants.item {name, art}',
            typeof view?.id === 'string' && view?.character?.key === 'beaks' && view?.character?.name === 'Beaks'
            && Array.isArray(view?.dialogue) && view.dialogue.length === ENCOUNTER_BY_KEY.beaks_intro.dialogue.length
            && view?.grants?.item?.catalogKey === 'food_ribeye'
            && view?.grants?.item?.name === 'Ribeye Steak'
            && view?.grants?.item?.art === 'food/food_ribeye.png', JSON.stringify(view));
        const again = await api('GET', '/api/toolbar-state', { cookie: player.cookie });
        check('a later GET still offers the same encounter (not yet seen)', again.json?.encounter?.id === rows1[0].id);
        check('the notifications feed of that response carries no encounter row',
            !(again.json?.notifications ?? []).some((n: any) => n.refType === 'encounter'),
            JSON.stringify(again.json?.notifications ?? []));

        // --- Seen ---
        section('Seen - closing the dialogue flips status; idempotent; scoped');
        const seen1 = await api('POST', '/api/encounters/seen', { cookie: player.cookie, body: { id: rows1[0].id } });
        const rowsSeen = await encounterRows(player.userId);
        check('POST seen -> 200 and status seen', seen1.status === 200 && rowsSeen[0].status === 'seen', `status=${seen1.status} ${JSON.stringify(rowsSeen)}`);
        const afterSeen = await api('GET', '/api/toolbar-state', { cookie: player.cookie });
        check('next GET -> encounter null', afterSeen.json?.encounter === null);
        const seen2 = await api('POST', '/api/encounters/seen', { cookie: player.cookie, body: { id: rows1[0].id } });
        check('replay -> 200 (idempotent)', seen2.status === 200);
        const other = await createSessionUser(`${EMAIL_PREFIX}other@example.com`);
        const cross = await api('POST', '/api/encounters/seen', { cookie: other.cookie, body: { id: rows1[0].id } });
        check('cross-account seen -> 404', cross.status === 404, `status=${cross.status}`);
        const bad = await api('POST', '/api/encounters/seen', { cookie: player.cookie, body: { id: 'not-a-uuid' } });
        check('invalid id -> 400', bad.status === 400);

        // --- Quest ---
        section('Play - two picks + one real feed complete it; the reward encounter fires with the Ember gift');
        const tankA = await insertTank({ slug: `${TANK_SLUG_PREFIX}a`, marketId: `${TANK_SLUG_PREFIX}a`, outcomes: ['Yes', 'No'], outcomePrices: [0.5, 0.5] });
        const tankB = await insertTank({ slug: `${TANK_SLUG_PREFIX}b`, marketId: `${TANK_SLUG_PREFIX}b`, outcomes: ['Yes', 'No'], outcomePrices: [0.5, 0.5] });
        await pool.query(
            `INSERT INTO picks (waitlist_id, tank_page_id, tank_slug, side, outcome_index, implied_prob_at_lock) VALUES ($1, $2, $3, 'Yes', 0, 0.5)`,
            [player.userId, tankA, `${TANK_SLUG_PREFIX}a`]);
        // One pick is not enough: the Play wants 2 since its baseline of 0.
        const mid = await api('GET', '/api/toolbar-state', { cookie: player.cookie });
        check('after 1 pick: Play still open, no reward encounter', mid.json?.encounter === null && (await playRows(player.userId))[0].completed_at === null);
        await pool.query(
            `INSERT INTO picks (waitlist_id, tank_page_id, tank_slug, side, outcome_index, implied_prob_at_lock) VALUES ($1, $2, $3, 'Yes', 0, 0.5)`,
            [player.userId, tankB, `${TANK_SLUG_PREFIX}b`]);
        // A real feed (of the granted Ribeye) proves pets.feed_count increments.
        await pool.query(`UPDATE pets SET satisfaction_at_last_feed = 40, last_fed_at = NOW() WHERE id = $1`, [petId]);
        const fed = await api('POST', '/api/pets/feed', { cookie: player.cookie, body: { foodCatalogKey: 'food_ribeye', feedToken: crypto.randomUUID() } });
        const { rows: fc } = await pool.query(`SELECT feed_count FROM pets WHERE id = $1`, [petId]);
        check('POST /api/pets/feed of the granted Ribeye -> 200 and feed_count 1', fed.status === 200 && fc[0].feed_count === 1, `status=${fed.status} feed_count=${fc[0]?.feed_count}`);
        const before = await ledgerTotals(player.userId);
        const done = await api('GET', '/api/toolbar-state', { cookie: player.cookie });
        const plays2 = await playRows(player.userId);
        const rows2 = await encounterRows(player.userId);
        const reward = rows2.find((r) => r.encounter_key === 'beaks_quest_done');
        check('Play completed_at set', plays2[0].completed_at !== null, JSON.stringify(plays2));
        check("'beaks_quest_done' fired (offered) with grants.ember {amount:25} and no item leg",
            Boolean(reward) && reward!.status === 'offered' && Number(reward!.grants?.ember?.amount) === 25
            && reward!.grants?.item === undefined, JSON.stringify(rows2));
        check('that same response carries the reward encounter', done.json?.encounter?.key === 'beaks_quest_done', JSON.stringify(done.json?.encounter?.key));
        const { rows: gift } = await pool.query(
            `SELECT amount, entry_type FROM ember_ledger WHERE user_id = $1 AND rule_key = 'encounter_gift'`, [player.userId]);
        check("exactly one 'encounter_gift' ledger row of 25, entry_type 'earn'", gift.length === 1 && gift[0].amount === 25 && gift[0].entry_type === 'earn', JSON.stringify(gift));
        const after = await ledgerTotals(player.userId);
        check('balance cache +25 and == SUM(ledger)', after.balanceCache === (before.balanceCache ?? 0) + 25 && after.balanceCache === after.ledgerSum, JSON.stringify({ before, after }));
        check('lifetime_earned unchanged by the gift, cache == recompute == 1 (the seed only)',
            after.lifetimeCache === 1 && after.lifetimeRecomputed === 1, JSON.stringify(after));
        const { rows: notes2 } = await pool.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND ref_type = 'encounter'`, [player.userId]);
        check('still zero encounter notifications after the reward encounter fired', notes2[0].n === 0);
        const doneAgain = await api('GET', '/api/toolbar-state', { cookie: player.cookie });
        const { rows: gift2 } = await pool.query(`SELECT COUNT(*)::int AS n FROM ember_ledger WHERE user_id = $1 AND rule_key = 'encounter_gift'`, [player.userId]);
        check('a further GET grants nothing more (still one gift row, still 2 encounters)', doneAgain.status === 200 && gift2[0].n === 1 && (await encounterRows(player.userId)).length === 2);

        // --- Heal ---
        section('Heal - a gift that never landed is credited once on the next read, never twice');
        await pool.query(`UPDATE encounters SET grants = grants - 'ember' WHERE id = $1`, [reward!.id]);
        await api('GET', '/api/toolbar-state', { cookie: player.cookie });
        const healed = (await encounterRows(player.userId)).find((r) => r.id === reward!.id);
        const { rows: gift3 } = await pool.query(`SELECT COUNT(*)::int AS n FROM ember_ledger WHERE user_id = $1 AND rule_key = 'encounter_gift'`, [player.userId]);
        const healedTotals = await ledgerTotals(player.userId);
        check('grants.ember restored, ledger still exactly one gift row (idempotency key), balance unchanged',
            Number(healed?.grants?.ember?.amount) === 25 && gift3[0].n === 1 && healedTotals.balanceCache === after.balanceCache, JSON.stringify({ healed, gift3, healedTotals }));
    } finally {
        await restoreConfig('encounters');
    }

    await cleanup();
}

export const suite: Suite = {
    name: 'encounters',
    requiredEnv: ['SESSION_TOKEN_SECRET'],
    run,
};
