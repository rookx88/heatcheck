import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import { calculateV4HeatScore } from './shared/heat-score-v4';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
    console.error('DATABASE_URL not set');
    process.exit(1);
}

async function listV4Articles() {
    const pool = new Pool({ connectionString: databaseUrl });
    
    try {
        const query = `
            SELECT id, data 
            FROM posts 
            WHERE data->'heatCheckData'->'matchPackV4' IS NOT NULL
            AND data->'heatCheckData'->'matchPackV4'->'factDrop'->'raw'->'advancedHeatStats' IS NOT NULL
            ORDER BY "updatedAt" DESC
        `;
        
        const result = await pool.query(query);
        
        if (result.rows.length === 0) {
            console.log('No V4 articles found');
            return;
        }
        
        console.log(`\nFound ${result.rows.length} V4 articles:\n`);
        console.log('ID                                    | Score | Matchup');
        console.log('--------------------------------------|-------|-------------------');
        
        for (const row of result.rows) {
            const post = row.data;
            const v4Result = calculateV4HeatScore(post);
            const matchup = `${post.teamA || '?'} vs ${post.teamB || '?'}`;
            console.log(`${row.id} | ${String(v4Result.heatScore).padStart(5)} | ${matchup}`);
        }
        
        console.log('\n');
    } catch (error) {
        console.error('Error listing articles:', error);
    } finally {
        await pool.end();
    }
}

async function analyzeV4Article(postId?: string) {
    const pool = new Pool({ connectionString: databaseUrl });
    
    try {
        let query = `
            SELECT data 
            FROM posts 
            WHERE data->'heatCheckData'->'matchPackV4' IS NOT NULL
            AND data->'heatCheckData'->'matchPackV4'->'factDrop'->'raw'->'advancedHeatStats' IS NOT NULL
        `;
        
        if (postId) {
            query += ` AND id = $1::uuid`;
        }
        
        query += ` ORDER BY "updatedAt" DESC LIMIT 1`;
        
        const params = postId ? [postId] : [];
        const result = await pool.query(query, params);
        
        if (result.rows.length === 0) {
            console.log('No V4 articles found');
            return;
        }
        
        const post = result.rows[0].data;
        const v4Result = calculateV4HeatScore(post);
        
        console.log('\n=== V4 HEAT SCORE BREAKDOWN ===\n');
        console.log(`Article: ${post.websiteStory?.headline || 'Untitled'}`);
        console.log(`Matchup: ${post.teamA} vs ${post.teamB}`);
        console.log(`\nFINAL HEAT SCORE: ${v4Result.heatScore}/100\n`);
        
        // Pillar 1: Control Stress
        console.log('🔴 PILLAR 1: CONTROL STRESS (40% weight)');
        console.log(`   Score: ${v4Result.pillars.controlStress.score}/100`);
        console.log(`   Weighted Contribution: ${(v4Result.pillars.controlStress.score * 0.40).toFixed(2)}`);
        console.log(`   Inputs:`);
        console.log(`     - Momentum Divergence: ${v4Result.pillars.controlStress.inputs.momentumDivergence}/12`);
        console.log(`     - Creation Asymmetry: ${v4Result.pillars.controlStress.inputs.creationAsymmetry}/10`);
        console.log(`     - Shot Quality Mismatch: ${v4Result.pillars.controlStress.inputs.shotQualityMismatch}/8`);
        console.log(`   Calculation:`);
        const mdPct = (v4Result.pillars.controlStress.inputs.momentumDivergence / 12) * 45;
        const caPct = (v4Result.pillars.controlStress.inputs.creationAsymmetry / 10) * 30;
        const sqmPct = (v4Result.pillars.controlStress.inputs.shotQualityMismatch / 8) * 25;
        console.log(`     = (${v4Result.pillars.controlStress.inputs.momentumDivergence}/12 × 45) + (${v4Result.pillars.controlStress.inputs.creationAsymmetry}/10 × 30) + (${v4Result.pillars.controlStress.inputs.shotQualityMismatch}/8 × 25)`);
        console.log(`     = ${mdPct.toFixed(2)} + ${caPct.toFixed(2)} + ${sqmPct.toFixed(2)}`);
        console.log(`     = ${v4Result.pillars.controlStress.score}\n`);
        
        // Pillar 2: Structural Instability
        console.log('🟠 PILLAR 2: STRUCTURAL INSTABILITY (35% weight)');
        console.log(`   Score: ${v4Result.pillars.structuralInstability.score}/100`);
        console.log(`   Weighted Contribution: ${(v4Result.pillars.structuralInstability.score * 0.35).toFixed(2)}`);
        console.log(`   Inputs:`);
        console.log(`     - Rotation Volatility: ${v4Result.pillars.structuralInstability.inputs.rotationVolatility}/8`);
        console.log(`     - Availability Imbalance: ${v4Result.pillars.structuralInstability.inputs.availabilityImbalance}/7`);
        console.log(`     - Schedule Stress: ${v4Result.pillars.structuralInstability.inputs.scheduleStress}/5`);
        console.log(`   Calculation:`);
        const rvPct = (v4Result.pillars.structuralInstability.inputs.rotationVolatility / 8) * 45;
        const aiPct = (v4Result.pillars.structuralInstability.inputs.availabilityImbalance / 7) * 35;
        const ssPct = (v4Result.pillars.structuralInstability.inputs.scheduleStress / 5) * 20;
        console.log(`     = (${v4Result.pillars.structuralInstability.inputs.rotationVolatility}/8 × 45) + (${v4Result.pillars.structuralInstability.inputs.availabilityImbalance}/7 × 35) + (${v4Result.pillars.structuralInstability.inputs.scheduleStress}/5 × 20)`);
        console.log(`     = ${rvPct.toFixed(2)} + ${aiPct.toFixed(2)} + ${ssPct.toFixed(2)}`);
        console.log(`     = ${v4Result.pillars.structuralInstability.score}\n`);
        
        // Pillar 3: Emotional Load
        console.log('🔥 PILLAR 3: EMOTIONAL LOAD (25% weight)');
        console.log(`   Score: ${v4Result.pillars.emotionalLoad.score}/100`);
        console.log(`   Weighted Contribution: ${(v4Result.pillars.emotionalLoad.score * 0.25).toFixed(2)}`);
        console.log(`   Components:`);
        console.log(`     - Revenge/Return: ${v4Result.pillars.emotionalLoad.components.revenge.score} (${v4Result.pillars.emotionalLoad.components.revenge.count} items)`);
        console.log(`     - Availability Shock: ${v4Result.pillars.emotionalLoad.components.availabilityShock.score} (${v4Result.pillars.emotionalLoad.components.availabilityShock.count} items)`);
        console.log(`     - vs Opponent History: ${v4Result.pillars.emotionalLoad.components.history.score} (${v4Result.pillars.emotionalLoad.components.history.count} items)`);
        console.log(`     - Pressure Environment: ${v4Result.pillars.emotionalLoad.components.pressureEnv.score}`);
        if (v4Result.pillars.emotionalLoad.components.pressureEnv.closeAvg !== undefined) {
            console.log(`       • Close Game Avg: ${v4Result.pillars.emotionalLoad.components.pressureEnv.closeAvg.toFixed(1)}`);
        }
        if (v4Result.pillars.emotionalLoad.components.pressureEnv.ranks) {
            console.log(`       • Standings: Team A rank ${v4Result.pillars.emotionalLoad.components.pressureEnv.ranks.A}, Team B rank ${v4Result.pillars.emotionalLoad.components.pressureEnv.ranks.B}`);
        }
        if (v4Result.pillars.emotionalLoad.components.pressureEnv.avgAbsMargin3 !== undefined) {
            console.log(`       • Avg Abs Margin (L3): ${v4Result.pillars.emotionalLoad.components.pressureEnv.avgAbsMargin3.toFixed(1)}`);
        }
        console.log(`   Total: ${v4Result.pillars.emotionalLoad.components.revenge.score} + ${v4Result.pillars.emotionalLoad.components.availabilityShock.score} + ${v4Result.pillars.emotionalLoad.components.history.score} + ${v4Result.pillars.emotionalLoad.components.pressureEnv.score} = ${v4Result.pillars.emotionalLoad.score}\n`);
        
        // Final Calculation
        console.log('📊 FINAL CALCULATION:');
        const BASE_HEAT = 40;
        const csContribution = v4Result.pillars.controlStress.score * 0.40;
        const siContribution = v4Result.pillars.structuralInstability.score * 0.35;
        const elContribution = v4Result.pillars.emotionalLoad.score * 0.25;
        const heatDelta = csContribution + siContribution + elContribution;
        console.log(`   BASE_HEAT = ${BASE_HEAT}`);
        console.log(`   HeatDelta = (Control Stress × 0.40) + (Structural Instability × 0.35) + (Emotional Load × 0.25)`);
        console.log(`   HeatDelta = (${v4Result.pillars.controlStress.score} × 0.40) + (${v4Result.pillars.structuralInstability.score} × 0.35) + (${v4Result.pillars.emotionalLoad.score} × 0.25)`);
        console.log(`   HeatDelta = ${csContribution.toFixed(2)} + ${siContribution.toFixed(2)} + ${elContribution.toFixed(2)}`);
        console.log(`   HeatDelta = ${heatDelta.toFixed(2)}`);
        console.log(`   HeatScore = clamp(round(BASE_HEAT + HeatDelta), 0, 100)`);
        console.log(`   HeatScore = clamp(round(${BASE_HEAT} + ${heatDelta.toFixed(2)}), 0, 100)`);
        console.log(`   HeatScore = clamp(round(${(BASE_HEAT + heatDelta).toFixed(2)}), 0, 100)`);
        console.log(`   HeatScore = ${v4Result.heatScore} (rounded)\n`);
        
    } catch (error) {
        console.error('Error analyzing article:', error);
    } finally {
        await pool.end();
    }
}

// Run with: 
//   npx tsx scripts/analyze-v4-heat-score.ts          (analyze most recent)
//   npx tsx scripts/analyze-v4-heat-score.ts <id>     (analyze specific post)
//   npx tsx scripts/analyze-v4-heat-score.ts --list  (list all V4 articles with scores)
const args = process.argv.slice(2);
if (args[0] === '--list') {
    listV4Articles().catch(console.error);
} else {
    const postId = args[0];
    analyzeV4Article(postId).catch(console.error);
}

