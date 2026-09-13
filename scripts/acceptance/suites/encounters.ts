// Acceptance suite for NPC encounters - lib/pages-functions/encounters/ (registry +
// evaluate), ledger.encounterGiftEmber, the toolbar-state wiring, and
// functions/api/encounters/seen.ts. Drives the real endpoints against the dev server
// and asserts DB rows + wire shape, discovery-suite style. Thresholds are flipped via
// game_config so the suite never has to earn 500 real Ember.

import crypto from 'crypto';
import { pool, api, check, section, type Suite } from '../harness';
import {
    createSessionUser, cleanupUsersByEmailPrefix, seedLifetimeEarned, ledgerTotals,
    flipConfig, restoreConfig, activeConfig, insertTank, cleanupTanksBySlugPrefix,
} from '../fixtures';
import { CHARACTERS, ENCOUNTERS, ENCOUNTER_BY_KEY } from '../../../lib/pages-functions/encounters';
import { triggerSatisfied, questComplete, placeMatches, type Facts, type QuestRow } from '../../../lib/pages-functions/encounters/evaluate';
import { LIFETIME_EARNED_RULE_KEYS } from '../../../lib/pages-functions/ledger';

const EMAIL_PREFIX = 'acceptance-encounters-';
const TANK_SLUG_PREFIX = 'acceptance-encounters-';

async function insertPet(userId: string): Promise<string> {
    const { rows } = await pool.query(`INSERT INTO pets (user_id, color) VALUES ($1, 'slate') RETURNING id`, [userId]);
    return rows[0].id as string;
}

async function encounterRows(userId: string) {
    const { rows } = await pool.query(
        `SELECT id, encounter_key, character_key, status, grants FROM encounters WHERE user_id = $1 ORDER BY created_at`,
        [userId],
    );
    return rows as Array<{ id: string; encounter_key: string; character_key: string; status: string; grants: Record<string, any> }>;
}

async function questRows(userId: string) {
    const { rows } = await pool.query(
        `SELECT id, quest_key, objective, baseline, visited, completed_at, reward_encounter_key FROM quests WHERE user_id = $1 ORDER BY started_at`,
        [userId],
    );
    return rows as Array<{ id: string; quest_key: string; objective: any; baseline: any; visited: string[]; completed_at: string | null; reward_encounter_key: string }>;
}

async function cleanup() {
    await cleanupUsersByEmailPrefix(EMAIL_PREFIX);
    await cleanupTanksBySlugPrefix(TANK_SLUG_PREFIX);
}

function fakeFacts(over: Partial<Facts>): Facts {
    return {
        lifetimeEarned: 0, picks: 0, collectibles: 0, feeds: 0, place: null, encounters: [], quests: [],
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
        for (const t of e.trigger) {
            if (t.kind === 'lifetime_earned_at_least') {
                check(`${e.key}: configKey '${t.configKey}' present in active game_config['encounters']`, Number.isFinite(Number(encCfg[t.configKey])), JSON.stringify(encCfg));
            }
            if (t.kind === 'after_encounter' || t.kind === 'quest_completed') {
                const target = t.kind === 'after_encounter'
                    ? Boolean(ENCOUNTER_BY_KEY[t.key])
                    : ENCOUNTERS.some((o) => o.effects.some((f) => f.kind === 'start_quest' && f.quest.key === t.key));
                check(`${e.key}: ${t.kind} '${t.key}' refers to a registered ${t.kind === 'after_encounter' ? 'encounter' : 'quest'}`, target);
            }
        }
        for (const f of e.effects) {
            if (f.kind === 'grant_item') {
                const { rows } = await pool.query(`SELECT item_type FROM items_catalog WHERE key = $1`, [f.catalogKey]);
                check(`${e.key}: grant_item '${f.catalogKey}' exists in items_catalog as '${f.itemType}'`, rows.length === 1 && rows[0].item_type === f.itemType);
            }
            if (f.kind === 'grant_ember') {
                const { rows } = await pool.query(`SELECT kind FROM ember_rules WHERE key = $1 AND active`, [f.ruleKey]);
                check(`${e.key}: grant_ember '${f.ruleKey}' is an active source rule`, rows.length === 1 && rows[0].kind === 'source');
                check(`${e.key}: '${f.ruleKey}' is NOT a lifetime-earned key (a gift never ranks)`, !(LIFETIME_EARNED_RULE_KEYS as readonly string[]).includes(f.ruleKey));
            }
            if (f.kind === 'start_quest') {
                const reward = ENCOUNTER_BY_KEY[f.quest.rewardEncounter];
                check(`${e.key}: quest '${f.quest.key}' reward encounter '${f.quest.rewardEncounter}' exists and waits on quest_completed`,
                    Boolean(reward) && reward.trigger.some((t) => t.kind === 'quest_completed' && t.key === f.quest.key));
            }
        }
    }
    for (const c of Object.values(CHARACTERS)) {
        check(`${c.key}: portrait src is a literal /assets/images/ path`, /^\/assets\/images\/[A-Za-z0-9._/-]+\.(webp|png|jpe?g|svg)$/.test(c.portrait.src), c.portrait.src);
    }

    // --- Pure rules ---
    section('Pure rules - triggerSatisfied / questComplete / placeMatches');
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
    const q = (objective: QuestRow['objective'], baseline = { feeds: 1, picks: 1, lifetime_earned: 100 }, visited: string[] = []): QuestRow =>
        ({ id: 'q', key: 'q', objective, baseline, visited, completedAt: null, rewardEncounterKey: 'r' });
    check('questComplete picks: baseline-relative (baseline 1, need 2, have 3)',
        questComplete(q({ kind: 'picks', count: 2 }), fakeFacts({ picks: 3 })) && !questComplete(q({ kind: 'picks', count: 2 }), fakeFacts({ picks: 2 })));
    check('questComplete earn_ember: baseline-relative', questComplete(q({ kind: 'earn_ember', amount: 50 }), fakeFacts({ lifetimeEarned: 150 })) && !questComplete(q({ kind: 'earn_ember', amount: 50 }), fakeFacts({ lifetimeEarned: 149 })));
    check('questComplete visit_places: every wanted place visited (prefix ok)',
        questComplete(q({ kind: 'visit_places', places: ['tankdaq', 'the-hatchery'] }, undefined, ['tankdaq:dogs', 'the-hatchery']), fakeFacts({}))
        && !questComplete(q({ kind: 'visit_places', places: ['tankdaq', 'the-hatchery'] }, undefined, ['tankdaq:dogs']), fakeFacts({})));
    check('quest_completed: needs completedAt', triggerSatisfied({ kind: 'quest_completed', key: 'q' }, fakeFacts({ quests: [{ ...q({ kind: 'picks', count: 1 }), completedAt: '2026-01-01' }] }), cfg));

    // --- Petless ---
    section('Petless account - nothing runs, encounter: null');
    const petless = await createSessionUser(`${EMAIL_PREFIX}petless@example.com`);
    await seedLifetimeEarned(petless.userId, 100_000);
    const petlessRes = await api('GET', '/api/toolbar-state', { cookie: petless.cookie });
    check('200, encounter null despite a huge lifetime_earned', petlessRes.status === 200 && petlessRes.json?.encounter === null, JSON.stringify(petlessRes.json?.encounter));
    check('zero encounters rows', (await encounterRows(petless.userId)).length === 0);

    // --- Below threshold ---
    section('Below threshold - no row, no notification');
    const player = await createSessionUser(`${EMAIL_PREFIX}player@example.com`);
    const petId = await insertPet(player.userId);
    const below = await api('GET', '/api/toolbar-state', { cookie: player.cookie });
    check('encounter null at zero lifetime_earned', below.status === 200 && below.json?.encounter === null);
    check('zero encounters rows', (await encounterRows(player.userId)).length === 0);

    try {
        // --- Fire ---
        section('Fire - threshold crossed: exactly one encounter, one grant, one quest, one notification, in the same response');
        await flipConfig('encounters', { beaks_intro_ember: 1 });
        await seedLifetimeEarned(player.userId, 1);
        const results = await Promise.all(Array.from({ length: 10 }, () => api('GET', '/api/toolbar-state', { cookie: player.cookie })));
        const rows1 = await encounterRows(player.userId);
        check('10 concurrent GETs -> exactly one encounters row (beaks_intro, offered)',
            rows1.length === 1 && rows1[0].encounter_key === 'beaks_intro' && rows1[0].status === 'offered', JSON.stringify(rows1));
        check("grants records the item {catalogKey:'food_ribeye', itemType:'food'}",
            rows1[0]?.grants?.item?.catalogKey === 'food_ribeye' && rows1[0]?.grants?.item?.itemType === 'food', JSON.stringify(rows1[0]?.grants));
        const { rows: ribeye } = await pool.query(`SELECT quantity FROM inventory_items WHERE user_id = $1 AND catalog_key = 'food_ribeye' AND item_type = 'food'`, [player.userId]);
        check('exactly one Ribeye in inventory', ribeye.length === 1 && ribeye[0].quantity === 1, JSON.stringify(ribeye));
        const quests1 = await questRows(player.userId);
        check("one quest 'beaks_first_trade' with a zero baseline and reward 'beaks_quest_done'",
            quests1.length === 1 && quests1[0].quest_key === 'beaks_first_trade' && Number(quests1[0].baseline.picks) === 0
            && Number(quests1[0].baseline.feeds) === 0 && quests1[0].reward_encounter_key === 'beaks_quest_done' && quests1[0].completed_at === null,
            JSON.stringify(quests1));
        const { rows: notes1 } = await pool.query(
            `SELECT type, ref_type, ref_id, mood, message FROM notifications WHERE user_id = $1 AND ref_type = 'encounter'`, [player.userId]);
        check("exactly one 'informational' notification, ref_type 'encounter', ref_id 'beaks_intro', mood 'happy'",
            notes1.length === 1 && notes1[0].type === 'informational' && notes1[0].ref_id === 'beaks_intro' && notes1[0].mood === 'happy', JSON.stringify(notes1));
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
        check('wire shape: id, character {key,name,title}, dialogue, grants.item',
            typeof view?.id === 'string' && view?.character?.key === 'beaks' && view?.character?.name === 'Beaks'
            && Array.isArray(view?.dialogue) && view.dialogue.length === ENCOUNTER_BY_KEY.beaks_intro.dialogue.length
            && view?.grants?.item?.catalogKey === 'food_ribeye', JSON.stringify(view));
        const again = await api('GET', '/api/toolbar-state', { cookie: player.cookie });
        check('a later GET still offers the same encounter (not yet seen)', again.json?.encounter?.id === rows1[0].id);
        check('the inbox line is in the notifications feed of that response',
            (again.json?.notifications ?? []).some((n: any) => n.refType === 'encounter' && n.refId === 'beaks_intro'));

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
        section('Quest - two picks + one real feed complete it; the reward encounter fires with the Ember gift');
        const tankA = await insertTank({ slug: `${TANK_SLUG_PREFIX}a`, marketId: `${TANK_SLUG_PREFIX}a`, outcomes: ['Yes', 'No'], outcomePrices: [0.5, 0.5] });
        const tankB = await insertTank({ slug: `${TANK_SLUG_PREFIX}b`, marketId: `${TANK_SLUG_PREFIX}b`, outcomes: ['Yes', 'No'], outcomePrices: [0.5, 0.5] });
        await pool.query(
            `INSERT INTO picks (waitlist_id, tank_page_id, tank_slug, side, outcome_index, implied_prob_at_lock) VALUES ($1, $2, $3, 'Yes', 0, 0.5)`,
            [player.userId, tankA, `${TANK_SLUG_PREFIX}a`]);
        // One pick is not enough: the quest wants 2 since its baseline of 0.
        const mid = await api('GET', '/api/toolbar-state', { cookie: player.cookie });
        check('after 1 pick: quest still open, no reward encounter', mid.json?.encounter === null && (await questRows(player.userId))[0].completed_at === null);
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
        const quests2 = await questRows(player.userId);
        const rows2 = await encounterRows(player.userId);
        const reward = rows2.find((r) => r.encounter_key === 'beaks_quest_done');
        check('quest completed_at set', quests2[0].completed_at !== null, JSON.stringify(quests2));
        check("'beaks_quest_done' fired (offered) with grants.ember.amount === 25",
            Boolean(reward) && reward!.status === 'offered' && Number(reward!.grants?.ember?.amount) === 25, JSON.stringify(rows2));
        check('that same response carries the reward encounter', done.json?.encounter?.key === 'beaks_quest_done', JSON.stringify(done.json?.encounter?.key));
        const { rows: gift } = await pool.query(
            `SELECT amount, entry_type FROM ember_ledger WHERE user_id = $1 AND rule_key = 'encounter_gift'`, [player.userId]);
        check("exactly one 'encounter_gift' ledger row of 25, entry_type 'earn'", gift.length === 1 && gift[0].amount === 25 && gift[0].entry_type === 'earn', JSON.stringify(gift));
        const after = await ledgerTotals(player.userId);
        check('balance cache +25 and == SUM(ledger)', after.balanceCache === (before.balanceCache ?? 0) + 25 && after.balanceCache === after.ledgerSum, JSON.stringify({ before, after }));
        check('lifetime_earned unchanged by the gift, cache == recompute == 1 (the seed only)',
            after.lifetimeCache === 1 && after.lifetimeRecomputed === 1, JSON.stringify(after));
        const { rows: notes2 } = await pool.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND ref_type = 'encounter'`, [player.userId]);
        check('two encounter notifications total', notes2[0].n === 2);
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
