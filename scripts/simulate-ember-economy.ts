// One-off script: stress-tests the Ember payout formula (see
// update_ember_rules_payout_formula.sql) before it ships, per the settlement spec's
// explicit gate: "Confirm honest play nets more Ember over 30 days than pure
// longshot-chasing. If it doesn't, lower cap before shipping, not after."
//
// Not part of the regular pipeline - run by hand:
//   npx tsx scripts/simulate-ember-economy.ts
//
// Formula under test (mirrors lib/pages-functions/ledger.ts's settleCall):
//   correct_payout(p)  = round(base * min(1/p, cap))
//   participation      = flat SMALL_BASE (always paid on a loss)
//
// Strategy model:
//   - Each simulated day offers a pool of N_AVAILABLE distinct prop probabilities
//     (one live Tank's pick-side implied probability each) drawn from the realistic
//     distribution - real historical picks.implied_prob_at_lock if enough exist,
//     otherwise the spec's stated fallback: "assume props cluster 20%-70%".
//   - "Honest": each of the day's 3 picks is a random draw from that pool - a real
//     bettor picking on genuine analysis, not selected for extremity either way.
//   - "Longest shot": each of the day's 3 picks is the LOWEST-probability entry in
//     that day's pool - someone deliberately hunting the biggest underdog available
//     every single time.
//   - A pick's outcome is a Bernoulli trial at its own true probability (the standard
//     "market-implied probability is well-calibrated" assumption any EV comparison
//     like this rests on).
//
// Run many independent simulated months (not one) since a single 30-day/90-pick
// sample is noisy enough to flip the comparison by chance alone even when the
// underlying EV difference is real.

import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const DAYS = 30;
const PICKS_PER_DAY = 3;
const N_AVAILABLE = 6; // candidate props/day a "hunt for the longest shot" strategy chooses among
const TRIALS = 20000; // independent simulated 30-day months, for a stable expected-value estimate

interface EmberRuleConfig {
    correctBase: number;
    correctCap: number;
    participationAmount: number;
}

const STARTING_PARAMS: EmberRuleConfig = { correctBase: 20, correctCap: 6, participationAmount: 5 };

function correctPayout(prob: number, cfg: EmberRuleConfig): number {
    return Math.round(cfg.correctBase * Math.min(1 / prob, cfg.correctCap));
}

function samplePick(prob: number, rng: () => number): boolean {
    return rng() < prob;
}

// Fallback synthetic distribution per the spec: "assume props cluster 20%-70%".
function fallbackProb(rng: () => number): number {
    return 0.2 + rng() * 0.5;
}

async function loadRealDistribution(): Promise<number[] | null> {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) return null;
    const pool = new Pool({ connectionString: databaseUrl });
    try {
        const { rows } = await pool.query<{ implied_prob_at_lock: string }>(
            `SELECT implied_prob_at_lock FROM picks WHERE implied_prob_at_lock IS NOT NULL`
        );
        await pool.end();
        const probs = rows.map((r) => Number(r.implied_prob_at_lock)).filter((p) => p > 0 && p < 1);
        // Need enough real data for the distribution to be meaningful, not just noise.
        return probs.length >= 30 ? probs : null;
    } catch {
        await pool.end().catch(() => {});
        return null;
    }
}

function makeSampler(pool: number[] | null): (rng: () => number) => number {
    if (!pool || pool.length === 0) return fallbackProb;
    return (rng: () => number) => pool[Math.floor(rng() * pool.length)];
}

// Simple deterministic PRNG (mulberry32) so a run is reproducible given a seed -
// useful for debugging a specific unlucky/lucky trial without re-running everything.
function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function simulateOneMonth(
    cfg: EmberRuleConfig,
    sampleProb: (rng: () => number) => number,
    strategy: 'honest' | 'longshot',
    rng: () => number
): number {
    let total = 0;
    for (let day = 0; day < DAYS; day++) {
        const pool = Array.from({ length: N_AVAILABLE }, () => sampleProb(rng));
        const dayProbs =
            strategy === 'honest'
                ? Array.from({ length: PICKS_PER_DAY }, () => pool[Math.floor(rng() * pool.length)])
                : [...pool].sort((a, b) => a - b).slice(0, PICKS_PER_DAY);

        for (const prob of dayProbs) {
            const won = samplePick(prob, rng);
            total += won ? correctPayout(prob, cfg) : cfg.participationAmount;
        }
    }
    return total;
}

function runComparison(
    cfg: EmberRuleConfig,
    sampleProb: (rng: () => number) => number,
    label: string
): { honestMean: number; longshotMean: number; honestWinsFraction: number } {
    let honestSum = 0;
    let longshotSum = 0;
    let honestWins = 0;
    // Independent seed stream per trial so honest/longshot for the SAME trial share
    // the same day-pool draws (fairer comparison - both strategies face the same
    // "board" each simulated day, they just choose differently from it) while
    // different trials are independent of each other.
    for (let trial = 0; trial < TRIALS; trial++) {
        const seed = trial * 2654435761 + 1;
        const honestTotal = simulateOneMonth(cfg, sampleProb, 'honest', mulberry32(seed));
        const longshotTotal = simulateOneMonth(cfg, sampleProb, 'longshot', mulberry32(seed));
        honestSum += honestTotal;
        longshotSum += longshotTotal;
        if (honestTotal > longshotTotal) honestWins++;
    }
    const honestMean = honestSum / TRIALS;
    const longshotMean = longshotSum / TRIALS;
    console.log(
        `[${label}] honest mean: ${honestMean.toFixed(1)} Ember/mo | longshot mean: ${longshotMean.toFixed(1)} Ember/mo | ` +
        `honest wins ${((honestWins / TRIALS) * 100).toFixed(1)}% of trials | ` +
        `${honestMean > longshotMean ? '✓ honest beats longshot on average' : '✗ LONGSHOT BEATS HONEST ON AVERAGE'}`
    );
    return { honestMean, longshotMean, honestWinsFraction: honestWins / TRIALS };
}

async function run(): Promise<void> {
    const realDistribution = await loadRealDistribution();
    console.log(
        realDistribution
            ? `Using ${realDistribution.length} real historical implied_prob_at_lock values from picks.`
            : `Not enough real pick history yet - using the spec's fallback: props uniform over 20%-70%.`
    );
    const sampleProb = makeSampler(realDistribution);

    console.log(`\n=== Starting parameters: base=${STARTING_PARAMS.correctBase}, cap=${STARTING_PARAMS.correctCap}, participation=${STARTING_PARAMS.participationAmount} ===`);
    const startingResult = runComparison(STARTING_PARAMS, sampleProb, 'starting params');

    if (startingResult.honestMean <= startingResult.longshotMean) {
        console.log(`\n⚠ Starting parameters FAIL the gate. Scanning lower cap values to find where honest play wins:`);
        for (const cap of [5, 4, 3.5, 3, 2.5, 2]) {
            const cfg = { ...STARTING_PARAMS, correctCap: cap };
            runComparison(cfg, sampleProb, `cap=${cap}`);
        }
    } else {
        console.log(`\n✓ Starting parameters (base=20, cap=6) pass the gate - safe to apply the migration as specified.`);
    }
}

run().catch((err) => {
    console.error('Simulation failed:', err);
    process.exit(1);
});
