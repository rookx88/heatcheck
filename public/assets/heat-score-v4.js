/**
 * V4 Heat Score Calculation (3-Pillar System) - JavaScript Version
 * 
 * HeatScore = (ControlStressScore * 0.40) + (StructuralInstabilityScore * 0.35) + (EmotionalLoadScore * 0.25)
 * 
 * All pillar scores are 0-100, weighted and combined.
 */

/**
 * Clamp value between bounds
 */
function clamp(x, lo, hi) {
    return Math.min(hi, Math.max(lo, x));
}

/**
 * Convert value to 0-1 percentage based on max value
 */
function scorePct(value, maxValue) {
    if (maxValue <= 0) return 0;
    return clamp(value / maxValue, 0, 1);
}

/**
 * Calculate Pillar 1: Control Stress (0-100)
 */
function calculateControlStress(advancedHeatStats, matchPackV3) {
    const controlStress = (advancedHeatStats && advancedHeatStats.controlStress) || {};
    
    let momentumDivergence = controlStress.momentumDivergence || 0;
    let creationAsymmetry = controlStress.creationAsymmetry || 0;
    let shotQualityMismatch = controlStress.shotQualityMismatch || 0;
    
    // V3 fallback if V4 missing
    if (momentumDivergence === 0 && matchPackV3 && matchPackV3.factDrop && matchPackV3.factDrop.raw && matchPackV3.factDrop.raw.teamForm) {
        const teamForm = matchPackV3.factDrop.raw.teamForm;
        const margin3_A = teamForm.A && teamForm.A.margin3 ? teamForm.A.margin3 : 0;
        const margin10_A = teamForm.A && teamForm.A.margin10 ? teamForm.A.margin10 : 0;
        const margin3_B = teamForm.B && teamForm.B.margin3 ? teamForm.B.margin3 : 0;
        const margin10_B = teamForm.B && teamForm.B.margin10 ? teamForm.B.margin10 : 0;
        
        const momentumDelta_A = margin3_A - margin10_A;
        const momentumDelta_B = margin3_B - margin10_B;
        momentumDivergence = clamp(Math.abs(momentumDelta_A - momentumDelta_B) * 0.6, 0, 12);
    }
    
    // Calculate score: scorePct(momentumDivergence, 12) * 45 + scorePct(creationAsymmetry, 10) * 30 + scorePct(shotQualityMismatch, 8) * 25
    const controlStressRaw =
        scorePct(momentumDivergence, 12) * 45 +
        scorePct(creationAsymmetry, 10) * 30 +
        scorePct(shotQualityMismatch, 8) * 25;
    
    const score = clamp(Math.round(controlStressRaw), 0, 100);
    
    return {
        score: score,
        inputs: {
            momentumDivergence: momentumDivergence,
            creationAsymmetry: creationAsymmetry,
            shotQualityMismatch: shotQualityMismatch,
        },
        receipts: controlStress.receipts || {},
    };
}

/**
 * Calculate Pillar 2: Structural Instability (0-100)
 */
function calculateStructuralInstability(advancedHeatStats, matchPackV3) {
    const structuralInstability = (advancedHeatStats && advancedHeatStats.structuralInstability) || {};
    
    let rotationVolatility = structuralInstability.rotationVolatility || 0;
    let availabilityImbalance = structuralInstability.availabilityImbalance || 0;
    const scheduleStress = structuralInstability.scheduleStress || 0;
    
    // V3 fallback if V4 missing
    if (availabilityImbalance === 0 && matchPackV3 && matchPackV3.factDrop && matchPackV3.factDrop.raw && matchPackV3.factDrop.raw.availability) {
        const availability = matchPackV3.factDrop.raw.availability;
        const countA = (availability.majorAbsences && availability.majorAbsences.A && availability.majorAbsences.A.count) ? availability.majorAbsences.A.count : 0;
        const countB = (availability.majorAbsences && availability.majorAbsences.B && availability.majorAbsences.B.count) ? availability.majorAbsences.B.count : 0;
        const absDiff = Math.abs(countA - countB);
        availabilityImbalance = clamp(absDiff * 0.7, 0, 7);
    }
    
    // Calculate score: scorePct(rotationVolatility, 8) * 45 + scorePct(availabilityImbalance, 7) * 35 + scorePct(scheduleStress, 5) * 20
    const structuralRaw =
        scorePct(rotationVolatility, 8) * 45 +
        scorePct(availabilityImbalance, 7) * 35 +
        scorePct(scheduleStress, 5) * 20;
    
    const score = clamp(Math.round(structuralRaw), 0, 100);
    
    return {
        score: score,
        inputs: {
            rotationVolatility: rotationVolatility,
            availabilityImbalance: availabilityImbalance,
            scheduleStress: scheduleStress,
        },
        receipts: structuralInstability.receipts || {},
    };
}

/**
 * Calculate Pillar 3: Emotional Load (0-100)
 */
function calculateEmotionalLoad(sections, matchPackV3, narratives, evidenceBundle) {
    // 3A: Revenge/Return Triggers (0-35)
    const revengeWatch = sections.find(function(s) { return s && s.title === 'REVENGE_WATCH'; });
    const revengeItems = (revengeWatch && Array.isArray(revengeWatch.items)) ? revengeWatch.items : [];
    const revengeCount = revengeItems.length;
    
    let revengeScore = 0;
    if (revengeCount === 0) revengeScore = 0;
    else if (revengeCount === 1) revengeScore = 18;
    else if (revengeCount === 2) revengeScore = 28;
    else revengeScore = 35;
    
    // 3B: Availability Shock (0-30)
    const availabilityShock = sections.find(function(s) { return s && s.title === 'AVAILABILITY_SHOCK'; });
    const shockItems = (availabilityShock && Array.isArray(availabilityShock.items)) ? availabilityShock.items : [];
    const shockCount = shockItems.length;
    
    // Get imbalance from V3 if available
    let absDiff = 0;
    if (matchPackV3 && matchPackV3.factDrop && matchPackV3.factDrop.raw && matchPackV3.factDrop.raw.availability) {
        const availability = matchPackV3.factDrop.raw.availability;
        const countA = (availability.majorAbsences && availability.majorAbsences.A && availability.majorAbsences.A.count) ? availability.majorAbsences.A.count : 0;
        const countB = (availability.majorAbsences && availability.majorAbsences.B && availability.majorAbsences.B.count) ? availability.majorAbsences.B.count : 0;
        absDiff = Math.abs(countA - countB);
    }
    
    let shockBase = 0;
    if (shockCount === 0) shockBase = 0;
    else if (shockCount === 1) shockBase = 14;
    else if (shockCount === 2) shockBase = 22;
    else shockBase = 28;
    
    const imbalanceBonus = Math.min(2, absDiff);
    const availabilityShockScore = Math.min(30, shockBase + imbalanceBonus);
    
    // 3C: vs Opponent History Trigger (0-20)
    const vsOppHistory = sections.find(function(s) { return s && s.title === 'VS_OPP_HISTORY'; });
    const histItems = (vsOppHistory && Array.isArray(vsOppHistory.items)) ? vsOppHistory.items : [];
    const histCount = histItems.length;
    
    let historyScore = 0;
    if (histCount === 0) historyScore = 0;
    else if (histCount === 1) historyScore = 8;
    else if (histCount === 2) historyScore = 14;
    else historyScore = 20;
    
    // 3D: Pressure Environment (0-15)
    let closeDependScore = 0;
    let standingsScore = 0;
    let formCompressionScore = 0;
    let closeAvg = undefined;
    let ranks = undefined;
    let avgAbsMargin3 = undefined;
    
    if (matchPackV3 && matchPackV3.factDrop && matchPackV3.factDrop.raw) {
        const teamForm = matchPackV3.factDrop.raw.teamForm || {};
        const standings = matchPackV3.factDrop.raw.standings || {};
        
        // D1: Close-game dependence (0-6)
        const closeW10_A = (teamForm.A && teamForm.A.closeW10) ? teamForm.A.closeW10 : 0;
        const closeL10_A = (teamForm.A && teamForm.A.closeL10) ? teamForm.A.closeL10 : 0;
        const closeW10_B = (teamForm.B && teamForm.B.closeW10) ? teamForm.B.closeW10 : 0;
        const closeL10_B = (teamForm.B && teamForm.B.closeL10) ? teamForm.B.closeL10 : 0;
        const closeA = closeW10_A + closeL10_A;
        const closeB = closeW10_B + closeL10_B;
        closeAvg = (closeA + closeB) / 2;
        
        if (closeAvg >= 6) closeDependScore = 6;
        else if (closeAvg >= 4) closeDependScore = 4;
        else if (closeAvg >= 2) closeDependScore = 2;
        else closeDependScore = 0;
        
        // D2: Standings pressure (0-6)
        const rankA = (standings.A && standings.A.rank) ? standings.A.rank : 0;
        const rankB = (standings.B && standings.B.rank) ? standings.B.rank : 0;
        const rankMin = Math.min(rankA, rankB);
        const rankMax = Math.max(rankA, rankB);
        ranks = { A: rankA, B: rankB };
        
        if (rankMin <= 4 && rankMax <= 10) standingsScore = 6;
        else if (rankMin <= 6) standingsScore = 4;
        else if (rankMax >= 11) standingsScore = 2;
        else standingsScore = 0;
        
        // D3: Form compression (0-3)
        const margin3_A = Math.abs((teamForm.A && teamForm.A.margin3) ? teamForm.A.margin3 : 0);
        const margin3_B = Math.abs((teamForm.B && teamForm.B.margin3) ? teamForm.B.margin3 : 0);
        avgAbsMargin3 = (margin3_A + margin3_B) / 2;
        
        if (avgAbsMargin3 <= 3) formCompressionScore = 3;
        else if (avgAbsMargin3 <= 6) formCompressionScore = 2;
        else formCompressionScore = 0;
    }
    
    const pressureEnvScore = closeDependScore + standingsScore + formCompressionScore;
    
    // Total Emotional Load
    const emotionalLoadScore = clamp(
        Math.round(revengeScore + availabilityShockScore + historyScore + pressureEnvScore),
        0,
        100
    );
    
    return {
        score: emotionalLoadScore,
        components: {
            revenge: { score: revengeScore, count: revengeCount },
            availabilityShock: {
                score: availabilityShockScore,
                count: shockCount,
                absDiff: absDiff > 0 ? absDiff : undefined,
            },
            history: { score: historyScore, count: histCount },
            pressureEnv: {
                score: pressureEnvScore,
                closeAvg: closeAvg,
                ranks: ranks,
                avgAbsMargin3: avgAbsMargin3,
            },
        },
    };
}

/**
 * Calculate V4 Heat Score using 3-pillar system
 */
function calculateV4HeatScore(post) {
    const heatCheckData = post.heatCheckData || {};
    const matchPackV4 = heatCheckData.matchPackV4;
    const matchPackV3 = heatCheckData.matchPackV3;
    const narratives = heatCheckData.narratives || {};
    const evidenceBundle = heatCheckData.evidence_bundle || heatCheckData.evidenceBundle || {};
    
    // Get sections from V4 or V3
    const sections = (matchPackV4 && matchPackV4.factDrop && matchPackV4.factDrop.sections) 
        ? matchPackV4.factDrop.sections 
        : ((matchPackV3 && matchPackV3.factDrop && matchPackV3.factDrop.sections) 
            ? matchPackV3.factDrop.sections 
            : []);
    
    // Get advancedHeatStats from V4
    const advancedHeatStats = (matchPackV4 && matchPackV4.factDrop && matchPackV4.factDrop.raw && matchPackV4.factDrop.raw.advancedHeatStats)
        ? matchPackV4.factDrop.raw.advancedHeatStats
        : null;
    
    // Calculate pillars
    const controlStress = calculateControlStress(advancedHeatStats, matchPackV3);
    const structuralInstability = calculateStructuralInstability(advancedHeatStats, matchPackV3);
    const emotionalLoad = calculateEmotionalLoad(sections, matchPackV3, narratives, evidenceBundle);
    
    // Final weighted score: BASE_HEAT + (ControlStress * 0.40) + (StructuralInstability * 0.35) + (EmotionalLoad * 0.25)
    const BASE_HEAT = 40;
    const heatDelta =
        controlStress.score * 0.40 +
        structuralInstability.score * 0.35 +
        emotionalLoad.score * 0.25;
    const heatScore = clamp(
        Math.round(BASE_HEAT + heatDelta),
        0,
        100
    );
    
    return {
        heatScore: heatScore,
        pillars: {
            controlStress: controlStress,
            structuralInstability: structuralInstability,
            emotionalLoad: emotionalLoad,
        },
    };
}

// Export for use in static-site.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { calculateV4HeatScore, clamp, scorePct };
}

