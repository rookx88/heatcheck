import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Type } from '@google/genai';
import Chart from 'chart.js/auto';
import { apiClient } from './apiClient';
import { PublicHomePage } from './pages/index';
import { parseExcelFile } from './scripts/utils/excelParser';
import { analyzeDFSSlate } from './scripts/services/dfsAnalysisService';
import { generateDFSContent } from './scripts/services/dfsTweetService';
import { generateHeatArticleContent } from './scripts/services/heatArticleContentService';
import { generateViralContentFromNarrative } from './scripts/services/viralContentGeneratorService';
import { rewriteArticleForSEO, SEORewriteOutput } from './scripts/services/seoRewriteService';
import { markdownToHtml } from './scripts/utils/markdown-converter';

// ===================================================================================
// TYPE DEFINITIONS (Unchanged, but now shared with backend)
// ===================================================================================

interface ViralTweetThread {
  tweet1: string;
  tweet2: string;
}

interface Narrative {
  league: string;
  teamA: string;
  teamB: string;
  narrative: string;
  storyType: string;
  searchedPlayers?: string[];
  searchedQueries?: string[];
}

interface Matchup {
    league: string;
    teamA: string;
    teamB: string;
}

interface HeatcheckStory {
    formatStyle: "QUOTE_LEDE" | "TIMELINE" | "UNSPOKEN" | "TRAP_GAME";
    headline: string;
    dek: string;
    whyItMatters: string[];
    theBackstory: string;
    theData: string[];
    keyMomentsTimeline: {date: string, event: string}[];
    theReceipts: {quote: string, speaker?: string, context?: string, sourceUrl?: string}[];
    pressurePoints: string[];
    whatToWatch: string[];
    edgeAngle: string;
    tags: string[];
    sources: {title: string, url: string, publisher?: string, publishedAt?: string}[];
    seo: {slug: string, metaTitle: string, metaDescription: string};
    image?: string;
    imageUrl?: string;
}

interface HeatchecksEdge {
    subjectType: "player" | "team";
    subjectName: string;
    game: string;
    marketSnapshot: { retrievedAt: string, books: { book: string, url?: string }[] };
    lines: { marketType: string, label: string, line: string, price?: string, book: string, sourceUrl: string }[];
    lean: "FAVOR" | "FADE" | "NO_EDGE";
    confidence: "low" | "medium" | "high";
    rationaleBullets: string[];
    riskCounterpoints: string[];
    historicalAnalog: { claim: string, sourceUrl: string | null };
    finalCall: string;
}

interface HeatchecksEdgeV2 {
    game: {
        market: "moneyline" | "spread" | "total" | "none";
        selection: "TEAM_A" | "TEAM_B" | "OVER" | "UNDER" | "none";
        line: number | null;
        price_american: number | null;
        book: string | null;
        confidence: "low" | "medium" | "high";
        receipts: [string, string, string];
        risks: [string, string];
        one_sentence_call: string;
    };
    player_props: Array<{
        player_name: string;
        market: string;
        selection: "OVER" | "UNDER";
        line: number;
        price_american: number;
        book: string;
        confidence: "low" | "medium" | "high";
        receipts: [string, string, string];
        risks: [string, string];
    }>;
    no_edge_reason: string | null;
}

export interface HeatcheckPost {
    id: string;
    createdAt: string;
    updatedAt: string;
    league: string;
    teamA: string;
    teamB: string;
    storyType: string;
    scanNarrative: string;
    status: "draft" | "published";
    websiteStory: HeatcheckStory;
    heatchecksEdge: HeatchecksEdge | HeatchecksEdgeV2;
    matchupScheduledDate?: string;
    heatCheckData?: {
        factPack?: any;
        evidenceBundle?: any;
        evidence_bundle?: any;
        narratives?: {
            candidate_cards?: any[];
            selected?: any;
        };
        qualityReport?: any;
        article?: {
            long_form_markdown?: string;
        };
        validation_warnings?: string[];
        ai_corrections?: any;
        dfsPlayers?: any[];
        emotional_map?: any;
    };
}

// ===================================================================================
// SHARED INSTANCES & UTILS
// ===================================================================================

// Get API key from environment - Vite exposes VITE_ prefixed vars via import.meta.env
// Also check process.env for backwards compatibility (defined in vite.config.ts)
const apiKey = import.meta.env.VITE_GEMINI_API_KEY || 
               import.meta.env.GEMINI_API_KEY || 
               (typeof process !== 'undefined' && process.env?.API_KEY) || 
               (typeof process !== 'undefined' && process.env?.GEMINI_API_KEY) || 
               '';

if (!apiKey) {
  const errorMsg = 'VITE_GEMINI_API_KEY is not set. Please check your .env.local file has: VITE_GEMINI_API_KEY=your_api_key_here\n\nGet your API key from: https://aistudio.google.com/app/apikey';
  console.error(errorMsg);
}

// Initialize AI client - GoogleGenAI requires a non-empty API key
const ai = new GoogleGenAI({ apiKey });

/**
 * Extracts a JSON object from a string, which might be wrapped in markdown or have leading/trailing text.
 * @param text The text response from the model.
 * @returns The parsed JSON object.
 */
function extractJson<T>(text: string): T {
    // First, try to find a markdown-style JSON block
    const markdownMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (markdownMatch && markdownMatch[1]) {
        try {
            return JSON.parse(markdownMatch[1]);
        } catch (e) {
            console.error("Failed to parse JSON from markdown block, falling back.", e);
        }
    }

    // If no markdown, find the first '{' or '[' and last '}' or ']'
    const firstBracket = text.indexOf('{');
    const firstSquare = text.indexOf('[');
    
    let start = -1;
    if (firstBracket === -1) start = firstSquare;
    else if (firstSquare === -1) start = firstBracket;
    else start = Math.min(firstBracket, firstSquare);

    if (start === -1) throw new Error("No JSON object or array found in the response.");
    
    const lastBracket = text.lastIndexOf('}');
    const lastSquare = text.lastIndexOf(']');
    const end = Math.max(lastBracket, lastSquare);

    if (end === -1) throw new Error("No closing bracket for JSON object or array found.");

    const jsonString = text.substring(start, end + 1);
    
    try {
        return JSON.parse(jsonString);
    } catch (e) {
        console.error("Failed to parse extracted JSON string:", jsonString, e);
        throw new Error("Failed to parse JSON from the model's response.");
    }
}

// ===================================================================================
// REACT COMPONENTS
// ===================================================================================

// Helper function to detect if a league is a soccer league
const isSoccerLeague = (league: string): boolean => {
  if (!league) return false;
  const upper = league.toUpperCase().trim();
  return upper === 'EPL' || upper === 'LA LIGA' || upper === 'SERIE A' || upper === 'BUNDESLIGA' || upper === 'LIGUE 1' || upper === 'PREMIER LEAGUE';
};

// ===================================================================================
// HEAT PICKS GENERATION FUNCTIONS
// ===================================================================================

/**
 * Generate chartCatalog from matchPackV3 data
 */
function generateChartCatalog(matchPackV3: any): Array<{
  chartId: string;
  chartType: string;
  dataSource: string;
  teamsIncluded: string[];
  description: string;
  whatQuestionItAnswers: string;
}> {
  const catalog: Array<{
    chartId: string;
    chartType: string;
    dataSource: string;
    teamsIncluded: string[];
    description: string;
    whatQuestionItAnswers: string;
  }> = [];

  if (!matchPackV3 || !matchPackV3.factDrop) return catalog;

  const factDrop = matchPackV3.factDrop;
  const teamForm = factDrop.raw?.teamForm;
  const comparisons = factDrop.comparisons || [];
  const sections = factDrop.sections || [];
  const availability = factDrop.raw?.availability;

  // 1. Rolling margin trend (last 10/15 games)
  if (teamForm?.A && teamForm?.B) {
    catalog.push({
      chartId: 'rolling_margin_last10',
      chartType: 'line',
      dataSource: 'teamForm',
      teamsIncluded: ['A', 'B'],
      description: 'Rolling margin trend over last 10 games',
      whatQuestionItAnswers: 'Who is controlling games lately?'
    });
  }

  // 2. Usage vs minutes stress (star load)
  const formLeaders = sections.find((s: any) => s?.key === 'formLeaders');
  if (formLeaders?.priorityPlayers && Array.isArray(formLeaders.priorityPlayers) && formLeaders.priorityPlayers.length > 0) {
    catalog.push({
      chartId: 'star_load',
      chartType: 'scatter',
      dataSource: 'formLeaders',
      teamsIncluded: ['A', 'B'],
      description: 'Usage vs minutes stress for key players',
      whatQuestionItAnswers: 'Which stars are under the most load?'
    });
  }

  // 3. Close-game execution split
  const closeMargin = comparisons.find((c: any) => c?.key === 'closeMargin');
  if (closeMargin) {
    catalog.push({
      chartId: 'close_game_execution',
      chartType: 'bar',
      dataSource: 'comparisons',
      teamsIncluded: ['A', 'B'],
      description: 'Close-game win rate differential',
      whatQuestionItAnswers: 'Who executes better in tight games?'
    });
  }

  // 4. Rotation availability timeline
  if (availability?.majorAbsences) {
    catalog.push({
      chartId: 'rotation_availability',
      chartType: 'timeline',
      dataSource: 'availability',
      teamsIncluded: ['A', 'B'],
      description: 'Rotation availability and major absences',
      whatQuestionItAnswers: 'Which team has more rotation strain?'
    });
  }

  // 5. Pace vs efficiency mismatch
  const paceComp = comparisons.find((c: any) => c?.key?.toLowerCase().includes('pace'));
  if (paceComp) {
    catalog.push({
      chartId: 'pace_efficiency',
      chartType: 'scatter',
      dataSource: 'comparisons',
      teamsIncluded: ['A', 'B'],
      description: 'Pace vs efficiency mismatch',
      whatQuestionItAnswers: 'Which team controls tempo better?'
    });
  }

  // 6. Turnover pressure differential
  const tovComp = comparisons.find((c: any) => c?.key?.toLowerCase().includes('turnover') || c?.key?.toLowerCase().includes('tov'));
  if (tovComp) {
    catalog.push({
      chartId: 'turnover_pressure',
      chartType: 'bar',
      dataSource: 'comparisons',
      teamsIncluded: ['A', 'B'],
      description: 'Turnover pressure differential',
      whatQuestionItAnswers: 'Which team forces more mistakes?'
    });
  }

  // 7. Late-game usage concentration
  if (formLeaders?.priorityPlayers && Array.isArray(formLeaders.priorityPlayers) && formLeaders.priorityPlayers.length > 0) {
    catalog.push({
      chartId: 'late_game_usage',
      chartType: 'line',
      dataSource: 'formLeaders',
      teamsIncluded: ['A', 'B'],
      description: 'Late-game usage concentration',
      whatQuestionItAnswers: 'Who gets the ball in crunch time?'
    });
  }

  return catalog;
}

/**
 * Step 1: Deterministic Scoring + Classification (Algorithm Decides)
 * NO LLM INVOLVED - This is the "truth layer" that is backtestable.
 */
interface ClassifiedMatchup {
  classification: 'HEAT_PICK' | 'WARM_LEAN' | 'NO_HEAT';
  heatScore: number;
  signalsHit: Array<{ signalKey: string; evidence: string; score: number }>;
  marketLag: number | null;
  evidenceChart: { chartId: string; chartType: string; dataSource: string; questionAnswered: string } | null;
  matchup: string;
  teamA: string;
  teamB: string;
  matchPackV3: any;
  pickType?: string;
  pick?: string;
}

async function computeHeatPicksClassification(
  post: HeatcheckPost,
  oddsData?: any
): Promise<ClassifiedMatchup | null> {
  const matchPackV3 = post.heatCheckData?.matchPackV3;
  if (!matchPackV3 || !matchPackV3.factDrop) {
    return null;
  }

  const factDrop = matchPackV3.factDrop;
  const teamForm = factDrop.raw?.teamForm || {};
  const comparisons = factDrop.comparisons || [];
  const availability = factDrop.raw?.availability;
  const teamA = post.teamA || '';
  const teamB = post.teamB || '';
  const matchup = `${teamA} @ ${teamB}`;

  // 1. Compute Signal Scores
  const signalsHit: Array<{ signalKey: string; evidence: string; score: number }> = [];

  // Momentum signal
  const aLast10 = teamForm.A?.w10 || 0;
  const aLast3 = teamForm.A?.w3 || 0;
  const bLast10 = teamForm.B?.w10 || 0;
  const bLast3 = teamForm.B?.w3 || 0;
  
  // For NBA: use margin data; for soccer: use xgDiff
  const aMargin10 = teamForm.A?.margin10 || teamForm.A?.xgDiff10 || 0;
  const aMargin3 = teamForm.A?.margin3 || teamForm.A?.xgDiff3 || 0;
  const bMargin10 = teamForm.B?.margin10 || teamForm.B?.xgDiff10 || 0;
  const bMargin3 = teamForm.B?.margin3 || teamForm.B?.xgDiff3 || 0;

  const momentumDivergence = Math.abs((aMargin3 - aMargin10) - (bMargin3 - bMargin10));
  const momentumScore = Math.min(100, momentumDivergence * 10);
  if (momentumScore > 20) {
    const direction = (aMargin3 - aMargin10) > (bMargin3 - bMargin10) ? teamA : teamB;
    signalsHit.push({
      signalKey: 'momentum',
      evidence: `${direction} last3 margin ${direction === teamA ? (aMargin3 - aMargin10).toFixed(1) : (bMargin3 - bMargin10).toFixed(1)} vs ${direction === teamA ? teamB : teamA} ${(direction === teamA ? (bMargin3 - bMargin10) : (aMargin3 - aMargin10)).toFixed(1)}`,
      score: momentumScore
    });
  }

  // Availability signal
  const aAbsences = availability?.majorAbsences?.A?.count || 0;
  const bAbsences = availability?.majorAbsences?.B?.count || 0;
  const availabilityDiff = Math.abs(aAbsences - bAbsences);
  const availabilityScore = Math.min(100, availabilityDiff * 25);
  if (availabilityScore > 20) {
    const direction = aAbsences > bAbsences ? teamB : teamA;
    signalsHit.push({
      signalKey: 'availability',
      evidence: `${direction === teamA ? teamB : teamA} missing ${availabilityDiff} more key player(s)`,
      score: availabilityScore
    });
  }

  // Close games signal
  const closeMarginComp = comparisons.find((c: any) => c?.key === 'closeMargin');
  if (closeMarginComp) {
    const aCloseW = teamForm.A?.closeW10 || 0;
    const aCloseL = teamForm.A?.closeL10 || 0;
    const bCloseW = teamForm.B?.closeW10 || 0;
    const bCloseL = teamForm.B?.closeL10 || 0;
    const aCloseRate = aCloseW + aCloseL > 0 ? aCloseW / (aCloseW + aCloseL) : 0;
    const bCloseRate = bCloseW + bCloseL > 0 ? bCloseW / (bCloseW + bCloseL) : 0;
    const closeGameDiff = Math.abs(aCloseRate - bCloseRate);
    const closeGameScore = Math.min(100, closeGameDiff * 200);
    if (closeGameScore > 20) {
      const direction = aCloseRate > bCloseRate ? teamA : teamB;
      signalsHit.push({
        signalKey: 'closeGames',
        evidence: `${direction} close-game win rate ${(direction === teamA ? aCloseRate : bCloseRate).toFixed(1)} vs ${(direction === teamA ? bCloseRate : aCloseRate).toFixed(1)}`,
        score: closeGameScore
      });
    }
  }

  // Comparisons signal (aggregate)
  let comparisonsScore = 0;
  const comparisonSignals: string[] = [];
  comparisons.forEach((comp: any) => {
    if (comp?.key && comp?.key !== 'closeMargin') {
      const aVal = comp?.A || 0;
      const bVal = comp?.B || 0;
      const diff = Math.abs(aVal - bVal);
      if (diff > 0.1) {
        comparisonsScore += Math.min(20, diff * 10);
        const direction = aVal > bVal ? teamA : teamB;
        comparisonSignals.push(`${comp.key}: ${direction} +${diff.toFixed(2)}`);
      }
    }
  });
  if (comparisonsScore > 20) {
    signalsHit.push({
      signalKey: 'comparisons',
      evidence: comparisonSignals.slice(0, 2).join('; '),
      score: Math.min(100, comparisonsScore)
    });
  }

  // 2. Calculate Base HeatScore from Statistical Signals (scaled for temperature-like range)
  // Temperature model: 40 = baseline, 70 = warm, 90 = hot, 100 = scorching
  const momentumWeight = 0.3;
  const availabilityWeight = 0.25;
  const closeGamesWeight = 0.25;
  const comparisonsWeight = 0.2;

  const momentumContrib = signalsHit.find(s => s.signalKey === 'momentum')?.score || 0;
  const availabilityContrib = signalsHit.find(s => s.signalKey === 'availability')?.score || 0;
  const closeGamesContrib = signalsHit.find(s => s.signalKey === 'closeGames')?.score || 0;
  const comparisonsContrib = signalsHit.find(s => s.signalKey === 'comparisons')?.score || 0;

  // Scale signal scores with higher multipliers for temperature-like range
  // Each signal can contribute more to reach 70-90 range
  const momentumScoreScaled = Math.min(25, (momentumContrib / 100) * 25); // Increased from 20
  const availabilityScoreScaled = Math.min(20, (availabilityContrib / 100) * 20); // Increased from 15
  const closeGamesScoreScaled = Math.min(20, (closeGamesContrib / 100) * 20); // Increased from 15
  const comparisonsScoreScaled = Math.min(15, (comparisonsContrib / 100) * 15); // Increased from 10

  const baseScore = Math.round(
    momentumScoreScaled +
    availabilityScoreScaled +
    closeGamesScoreScaled +
    comparisonsScoreScaled
  );

  // 3. Add Narrative Strength (scaled up for temperature model)
  let narrativeScore = 0;
  const narratives = post.heatCheckData?.narratives;
  if (narratives?.candidate_cards && narratives.candidate_cards.length > 0) {
    // Primary narrative score (0-20 points, increased from 15)
    const primaryNarrativeId = narratives.selected?.primary_narrative_id;
    const primaryCard = narratives.candidate_cards.find(
      (c: any) => c.narrative_id === primaryNarrativeId
    );
    
    if (primaryCard) {
      // Use total_score if available (0-35 scale), normalize to 0-20
      if (primaryCard.total_score !== undefined) {
        narrativeScore += Math.min(20, (primaryCard.total_score / 35) * 20);
      } else {
        // Fallback: use score_breakdown if available
        const breakdown = primaryCard.score_breakdown || {};
        const breakdownScore = (breakdown.factual_support || 0) + 
                              (breakdown.stakes || 0) + 
                              (breakdown.performance_alignment || 0);
        narrativeScore += Math.min(20, (breakdownScore / 20) * 20);
      }
    }
    
    // Secondary narratives boost (0-8 points, increased from 5)
    const secondaryIds = narratives.selected?.secondary_narrative_ids || [];
    if (secondaryIds.length >= 2) narrativeScore += 8;
    else if (secondaryIds.length === 1) narrativeScore += 4;
    
    // Emotion tags diversity (0-7 points, increased from 5)
    const allEmotionTags = narratives.candidate_cards
      .flatMap((c: any) => c.emotion_tags || []);
    const uniqueEmotionTags = [...new Set(allEmotionTags)];
    if (uniqueEmotionTags.length >= 4) narrativeScore += 7;
    else if (uniqueEmotionTags.length >= 3) narrativeScore += 5;
    else if (uniqueEmotionTags.length >= 2) narrativeScore += 2;
  }
  
  narrativeScore = Math.min(35, Math.round(narrativeScore)); // Increased from 25

  // 4. Add Evidence Quality (scaled up for temperature model)
  let evidenceScore = 0;
  const evidenceBundle = post.heatCheckData?.evidence_bundle || post.heatCheckData?.evidenceBundle || {};
  const quotes = evidenceBundle.quotes || [];
  const timelineEvents = evidenceBundle.timeline_events || [];
  
  // Quotes quality (0-12 points, increased from 8)
  if (quotes.length >= 5) evidenceScore += 12;
  else if (quotes.length >= 3) evidenceScore += 9;
  else if (quotes.length >= 2) evidenceScore += 6;
  else if (quotes.length === 1) evidenceScore += 3;
  
  // Timeline events (0-6 points, increased from 4)
  if (timelineEvents.length >= 5) evidenceScore += 6;
  else if (timelineEvents.length >= 3) evidenceScore += 5;
  else if (timelineEvents.length >= 2) evidenceScore += 3;
  else if (timelineEvents.length === 1) evidenceScore += 2;
  
  // Recent evidence bonus (0-5 points, increased from 3)
  const now = new Date();
  const recentQuotes = quotes.filter((q: any) => {
    if (!q.date_utc) return false;
    try {
      const quoteDate = new Date(q.date_utc);
      const daysAgo = Math.floor((now.getTime() - quoteDate.getTime()) / (1000 * 60 * 60 * 24));
      return daysAgo <= 30;
    } catch {
      return false;
    }
  });
  if (recentQuotes.length >= 3) evidenceScore += 5;
  else if (recentQuotes.length >= 2) evidenceScore += 3;
  else if (recentQuotes.length >= 1) evidenceScore += 2;
  
  evidenceScore = Math.min(23, evidenceScore); // Increased from 15

  // 5. Calculate Unified HeatScore with base temperature (40 = baseline, like room temp)
  // Base temperature: Every matchup starts at 40 degrees
  // Then add signals (0-80) + narratives (0-35) + evidence (0-23) = max 188, but we cap at 100
  // This ensures: decent matchup = ~70, strong = ~90, exceptional = 100
  const baseTemperature = 40; // Baseline temperature
  const rawHeatScore = baseTemperature + baseScore + narrativeScore + evidenceScore;
  const heatScore = Math.round(Math.min(100, Math.max(40, rawHeatScore))); // Cap between 40-100

  // 6. Market Lag Numeric
  let marketLag: number | null = null;
  if (oddsData?.gameMarkets) {
    // Simple heuristic: compare HeatScore to spread
    // If HeatScore is high but spread is close, market lag exists
    const spread = oddsData.gameMarkets?.bookmakers?.[0]?.markets?.find((m: any) => m.key === 'spreads')?.outcomes?.[0]?.point;
    if (spread !== undefined) {
      // Higher heatScore with tighter spread = more lag
      const spreadAbs = Math.abs(spread);
      marketLag = Math.min(100, Math.max(0, heatScore - (spreadAbs * 5)));
    }
  }

  // 7. Chart Selection
  const chartCatalog = generateChartCatalog(matchPackV3);
  let evidenceChart: { chartId: string; chartType: string; dataSource: string; questionAnswered: string } | null = null;
  
  // Select chart that supports the strongest signal
  if (chartCatalog.length > 0 && signalsHit.length > 0) {
    const strongestSignal = signalsHit.reduce((prev, curr) => curr.score > prev.score ? curr : prev);
    const relevantChart = chartCatalog.find(c => {
      if (strongestSignal.signalKey === 'momentum') return c.chartId === 'rolling_margin_last10';
      if (strongestSignal.signalKey === 'availability') return c.chartId === 'rotation_availability';
      if (strongestSignal.signalKey === 'closeGames') return c.chartId === 'close_game_execution';
      return true;
    }) || chartCatalog[0];
    
    evidenceChart = {
      chartId: relevantChart.chartId,
      chartType: relevantChart.chartType,
      dataSource: relevantChart.dataSource,
      questionAnswered: relevantChart.whatQuestionItAnswers
    };
  }

  // 8. Classification (updated thresholds for unified scoring)
  let classification: 'HEAT_PICK' | 'WARM_LEAN' | 'NO_HEAT' = 'NO_HEAT';
  
  // Check if at least 2 signals support the same side
  const signalsBySide = signalsHit.reduce((acc, s) => {
    const side = s.evidence.includes(teamA) ? 'A' : s.evidence.includes(teamB) ? 'B' : 'neutral';
    if (!acc[side]) acc[side] = [];
    acc[side].push(s);
    return acc;
  }, {} as Record<string, typeof signalsHit>);
  
  const hasTwoSignalsSameSide = Object.values(signalsBySide).some(signals => signals.length >= 2);

  // Temperature-based thresholds: 70 = warm, 90 = hot
  // HEAT_PICK: Hot matchups (85+) with strong signals and narrative/evidence
  // WARM_LEAN: Warm matchups (70+) with decent signals
  const hasStrongNarrativeOrEvidence = narrativeScore >= 15 || evidenceScore >= 12;
  const hasOneStrongSignal = signalsHit.length >= 1 && signalsHit.some(s => s.score >= 50);
  
  if (heatScore >= 85 && (hasTwoSignalsSameSide || (hasOneStrongSignal && hasStrongNarrativeOrEvidence)) && evidenceChart) {
    classification = 'HEAT_PICK';
  } else if (heatScore >= 70 && signalsHit.length > 0) {
    classification = 'WARM_LEAN';
  } else {
    classification = 'NO_HEAT';
  }

  // Determine pick direction and type
  let pickType: string | undefined;
  let pick: string | undefined;
  
  if (classification === 'HEAT_PICK' || classification === 'WARM_LEAN') {
    // Determine which side has the advantage
    const aSignals = signalsBySide['A']?.length || 0;
    const bSignals = signalsBySide['B']?.length || 0;
    const favoredSide = aSignals > bSignals ? teamA : teamB;
    
    if (oddsData?.gameMarkets) {
      const spread = oddsData.gameMarkets?.bookmakers?.[0]?.markets?.find((m: any) => m.key === 'spreads')?.outcomes?.find((o: any) => o.name === favoredSide)?.point;
      if (spread !== undefined) {
        pickType = 'spread';
        pick = `${favoredSide} ${spread > 0 ? '+' : ''}${spread}`;
      } else {
        pickType = 'moneyline';
        pick = favoredSide;
      }
    } else {
      pickType = 'moneyline';
      pick = favoredSide;
    }
  }

  return {
    classification,
    heatScore,
    signalsHit,
    marketLag,
    evidenceChart,
    matchup,
    teamA,
    teamB,
    matchPackV3,
    pickType,
    pick
  };
}

/**
 * Step 2: LLM as Renderer (LLM Explains)
 * LLM ONLY ADDS READABILITY - It does NOT control classification.
 */
async function renderHeatPicksWithLLM(
  classified: ClassifiedMatchup,
  narratives?: any[]
): Promise<{
  whyHot: string[];
  narrativesUsed: Array<{ type: string; strength: number; direction: string; whyItFitsData: string }>;
  marketLag: string;
  riskNote: string;
  chartCaption: string;
}> {
  const allowedNarratives = ['revenge/return', 'role_surge/star_load', 'fatigue/travel/schedule', 'coach_bounce', 'rivalry', 'bounceback'];
  
  const prompt = `You are the HeatChecks "Heat Picks" renderer. Your job is to explain what the algorithm decided, NOT to change it.

CLASSIFICATION: ${classified.classification}
HEAT SCORE: ${classified.heatScore}
PICK: ${classified.pick || 'N/A'} (${classified.pickType || 'moneyline'})
MATCHUP: ${classified.matchup}
SIGNALS HIT: ${JSON.stringify(classified.signalsHit)}
MARKET LAG (numeric): ${classified.marketLag ?? 'N/A'}
EVIDENCE CHART: ${classified.evidenceChart ? JSON.stringify(classified.evidenceChart) : 'None'}
${narratives && narratives.length > 0 ? `AVAILABLE NARRATIVES: ${JSON.stringify(narratives)}` : ''}

IMPORTANT: The PICK is ${classified.pick || 'N/A'}. This means the algorithm favors ${classified.pick?.includes('+') ? 'the underdog' : classified.pick?.includes('-') ? 'the favorite' : classified.pick || 'one team'}. Your "why hot" bullets must explain why THIS SPECIFIC PICK is justified by the signals, NOT why the game is interesting in general.

Generate EXACTLY:
1. Three "why hot" bullets (max 12 words each) - explain why THIS SPECIFIC PICK (${classified.pick || 'the pick'}) is justified by the signals. Focus on why the picked team has the edge.
2. 1-2 narrative alignments (ONLY from this allowed list: ${allowedNarratives.join(', ')}) - if narratives match the data
3. Market lag explanation in plain English (1-2 sentences)
4. Risk note (1 sentence)
5. Chart caption explaining "what this proves" in support of the pick (1 sentence)

Return ONLY valid JSON:
{
  "whyHot": ["bullet1", "bullet2", "bullet3"],
  "narrativesUsed": [{"type": "revenge/return", "strength": 0.7, "direction": "TeamA", "whyItFitsData": "explanation"}],
  "marketLag": "plain English explanation",
  "riskNote": "one sentence risk",
  "chartCaption": "what this chart proves"
}`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-pro',
      contents: prompt,
      config: {
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            whyHot: { type: Type.ARRAY, items: { type: Type.STRING } },
            narrativesUsed: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  type: { type: Type.STRING },
                  strength: { type: Type.NUMBER },
                  direction: { type: Type.STRING },
                  whyItFitsData: { type: Type.STRING }
                },
                required: ['type', 'strength', 'direction', 'whyItFitsData']
              }
            },
            marketLag: { type: Type.STRING },
            riskNote: { type: Type.STRING },
            chartCaption: { type: Type.STRING }
          },
          required: ['whyHot', 'narrativesUsed', 'marketLag', 'riskNote', 'chartCaption']
        }
      }
    });

    const result = extractJson(response.text);
    return {
      whyHot: result.whyHot || [],
      narrativesUsed: result.narrativesUsed || [],
      marketLag: result.marketLag || 'Market lag unclear',
      riskNote: result.riskNote || 'Standard game risk applies',
      chartCaption: result.chartCaption || 'Chart supports the pressure signal'
    };
  } catch (error: any) {
    console.error('[renderHeatPicksWithLLM] Error:', error);
    return {
      whyHot: ['Algorithm detected pressure signals', 'Multiple data points align', 'Market may not be fully priced'],
      narrativesUsed: [],
      marketLag: classified.marketLag !== null ? 'Market lag detected' : 'Market lag unclear',
      riskNote: 'Standard game risk applies',
      chartCaption: 'Chart supports the pressure signal'
    };
  }
}

/**
 * Sync V2 edge with Heat Pick - updates receipts and risks to match Heat Pick story
 */
function syncV2EdgeWithHeatPick(
  edge: HeatchecksEdgeV2,
  heatPick: any,
  article: HeatcheckPost
): HeatchecksEdgeV2 | null {
  const pick = heatPick.pick || '';
  const pickType = heatPick.pickType || 'moneyline';
  const teamA = article.teamA || '';
  const teamB = article.teamB || '';

  // Parse the Heat Pick to extract team and line
  // Format: "Team Name +8.5" or "Team Name" or "Team Name -3.5"
  const pickMatch = pick.match(/^(.+?)\s*([+-]?\d+\.?\d*)?$/);
  if (!pickMatch) {
    console.warn(`[syncV2EdgeWithHeatPick] Could not parse pick: ${pick}`);
    return null;
  }

  const [, teamName, lineStr] = pickMatch;
  const line = lineStr ? parseFloat(lineStr) : null;
  const isSpread = pickType === 'spread' && line !== null;
  const isMoneyline = pickType === 'moneyline' || line === null;
  
  // Determine which team is being picked
  const isTeamA = teamName.includes(teamA) || pick.includes(teamA);
  const isTeamB = teamName.includes(teamB) || pick.includes(teamB);
  
  if (!isTeamA && !isTeamB) {
    console.warn(`[syncV2EdgeWithHeatPick] Could not match team from pick: ${pick}`);
    return null;
  }

  // Build receipts from Heat Pick data (whyHot + signalsHit)
  const receipts: [string, string, string] = ['', '', ''];
  const whyHot = heatPick.whyHot || [];
  const signalsHit = heatPick.signalsHit || [];
  
  // Combine whyHot bullets and signal evidence for receipts
  const receiptSources: string[] = [];
  whyHot.forEach((bullet: string) => {
    if (bullet && bullet.trim()) receiptSources.push(bullet.trim());
  });
  signalsHit.forEach((signal: any) => {
    if (signal.evidence && signal.evidence.trim()) {
      receiptSources.push(`Signal: ${signal.evidence.trim()}`);
    }
  });
  
  // Fill receipts array (max 3)
  for (let i = 0; i < Math.min(3, receiptSources.length); i++) {
    receipts[i] = receiptSources[i];
  }
  // If we have fewer than 3, keep existing ones or use defaults
  if (receiptSources.length < 3) {
    const existingReceipts = edge.game.receipts || ['', '', ''];
    for (let i = receiptSources.length; i < 3; i++) {
      if (existingReceipts[i] && existingReceipts[i].trim()) {
        receipts[i] = existingReceipts[i];
      }
    }
  }

  // Build risks from Heat Pick riskNote and marketLag
  const risks: [string, string] = ['', ''];
  const riskSources: string[] = [];
  
  if (heatPick.riskNote && heatPick.riskNote.trim()) {
    riskSources.push(heatPick.riskNote.trim());
  }
  if (heatPick.marketLag && heatPick.marketLag.trim()) {
    riskSources.push(`Market consideration: ${heatPick.marketLag.trim()}`);
  }
  
  // Fill risks array (max 2)
  for (let i = 0; i < Math.min(2, riskSources.length); i++) {
    risks[i] = riskSources[i];
  }
  // If we have fewer than 2, keep existing ones
  if (riskSources.length < 2) {
    const existingRisks = edge.game.risks || ['', ''];
    for (let i = riskSources.length; i < 2; i++) {
      if (existingRisks[i] && existingRisks[i].trim()) {
        risks[i] = existingRisks[i];
      }
    }
  }

  // Update edge game selection - update receipts and risks from Heat Pick
  const updatedEdge: HeatchecksEdgeV2 = {
    ...edge,
    game: {
      ...edge.game,
      market: isSpread ? 'spread' : isMoneyline ? 'moneyline' : edge.game.market,
      selection: isTeamA ? 'TEAM_A' : 'TEAM_B',
      line: isSpread ? line : (isMoneyline ? null : edge.game.line),
      // Preserve existing price, book, confidence
      price_american: edge.game.price_american,
      book: edge.game.book,
      confidence: edge.game.confidence || 'medium',
      // Update receipts and risks from Heat Pick story
      receipts: receipts,
      risks: risks,
      // Update one_sentence_call to reference Heat Pick if not already mentioned
      one_sentence_call: edge.game.one_sentence_call?.includes(heatPick.pick) 
        ? edge.game.one_sentence_call 
        : `${edge.game.one_sentence_call || ''} Heat Pick: ${pick}.`.trim()
    }
  };

  return updatedEdge;
}

/**
 * Sync V1 edge with Heat Pick - updates rationaleBullets and riskCounterpoints to match Heat Pick story
 */
function syncV1EdgeWithHeatPick(
  edge: HeatchecksEdge,
  heatPick: any,
  article: HeatcheckPost
): HeatchecksEdge | null {
  const pick = heatPick.pick || '';
  const teamA = article.teamA || '';
  const teamB = article.teamB || '';

  // Parse the Heat Pick
  const pickMatch = pick.match(/^(.+?)\s*([+-]?\d+\.?\d*)?$/);
  if (!pickMatch) {
    console.warn(`[syncV1EdgeWithHeatPick] Could not parse pick: ${pick}`);
    return null;
  }

  const [, teamName] = pickMatch;
  const isTeamA = teamName.includes(teamA) || pick.includes(teamA);
  const isTeamB = teamName.includes(teamB) || pick.includes(teamB);
  
  if (!isTeamA && !isTeamB) {
    console.warn(`[syncV1EdgeWithHeatPick] Could not match team from pick: ${pick}`);
    return null;
  }

  // Build rationaleBullets from Heat Pick data (whyHot + signalsHit)
  const rationaleBullets: string[] = [];
  const whyHot = heatPick.whyHot || [];
  const signalsHit = heatPick.signalsHit || [];
  
  // Combine whyHot bullets and signal evidence for rationale
  whyHot.forEach((bullet: string) => {
    if (bullet && bullet.trim()) rationaleBullets.push(bullet.trim());
  });
  signalsHit.forEach((signal: any) => {
    if (signal.evidence && signal.evidence.trim()) {
      rationaleBullets.push(`Signal evidence: ${signal.evidence.trim()}`);
    }
  });
  
  // If we have fewer than 3, keep existing ones
  if (rationaleBullets.length < 3) {
    const existingBullets = edge.rationaleBullets || [];
    for (let i = rationaleBullets.length; i < Math.min(3, existingBullets.length); i++) {
      if (existingBullets[i] && existingBullets[i].trim()) {
        rationaleBullets.push(existingBullets[i]);
      }
    }
  }
  // Limit to 5 bullets max
  const finalRationaleBullets = rationaleBullets.slice(0, 5);

  // Build riskCounterpoints from Heat Pick riskNote and marketLag
  const riskCounterpoints: string[] = [];
  
  if (heatPick.riskNote && heatPick.riskNote.trim()) {
    riskCounterpoints.push(heatPick.riskNote.trim());
  }
  if (heatPick.marketLag && heatPick.marketLag.trim()) {
    riskCounterpoints.push(`Market consideration: ${heatPick.marketLag.trim()}`);
  }
  
  // If we have fewer than 2, keep existing ones
  if (riskCounterpoints.length < 2) {
    const existingRisks = edge.riskCounterpoints || [];
    for (let i = riskCounterpoints.length; i < Math.min(2, existingRisks.length); i++) {
      if (existingRisks[i] && existingRisks[i].trim()) {
        riskCounterpoints.push(existingRisks[i]);
      }
    }
  }
  // Limit to 3 risks max
  const finalRiskCounterpoints = riskCounterpoints.slice(0, 3);

  // Update edge - update rationaleBullets and riskCounterpoints from Heat Pick
  const updatedEdge: HeatchecksEdge = {
    ...edge,
    subjectType: 'team',
    subjectName: isTeamA ? teamA : teamB,
    lean: 'FAVOR',
    // Preserve existing confidence
    confidence: edge.confidence || 'medium',
    // Update rationaleBullets and riskCounterpoints from Heat Pick story
    rationaleBullets: finalRationaleBullets,
    riskCounterpoints: finalRiskCounterpoints,
    // Update finalCall to reference Heat Pick if not already mentioned
    finalCall: edge.finalCall?.includes(heatPick.pick)
      ? edge.finalCall
      : `${edge.finalCall || ''} Heat Pick: ${pick}.`.trim()
  };

  return updatedEdge;
}

/**
 * Sync heatchecksEdge on all matching matchup articles when Heat Picks are published
 * Updates pick/selection, receipts, and risks to match Heat Pick story
 * Preserves price, book, confidence, and other edge metadata
 */
async function syncMatchupEdgesWithHeatPicks(heatPicksPost: HeatcheckPost): Promise<void> {
  // Only sync for Heat Picks articles
  if (heatPicksPost.storyType !== 'heat_picks') {
    return;
  }
  
  // Note: We sync based on the Heat Picks data, not the article status
  // This allows syncing from drafts too

  const heatPicksData = heatPicksPost.heatCheckData?.heatPicks;
  if (!heatPicksData) {
    console.warn('[syncMatchupEdgesWithHeatPicks] No heatPicks data found');
    return;
  }

  const date = heatPicksData.date;
  const league = heatPicksData.sport;
  const allPicks = [
    ...(heatPicksData.heatPicks || []),
    ...(heatPicksData.warmLeans || [])
  ];

  if (allPicks.length === 0) {
    console.log('[syncMatchupEdgesWithHeatPicks] No picks to sync');
    return;
  }

  console.log(`[syncMatchupEdgesWithHeatPicks] Syncing ${allPicks.length} picks for ${league} on ${date}`);

  try {
    // Get all published matchup articles for this date/league
    const matchupPosts = await apiClient.getPublishedPostsByDateLeague(date, league);
    
    // Filter to only regular matchup articles (not DFS, not Heat Picks)
    const articlesToUpdate = matchupPosts.filter(
      post => post.storyType !== 'dfs_article' && 
              post.storyType !== 'heat_picks' &&
              post.heatchecksEdge // Only update articles that have an edge
    );

    let updatedCount = 0;

    for (const pick of allPicks) {
      // Find matching matchup article
      const matchingArticle = articlesToUpdate.find(post => {
        const matchup = pick.matchup || '';
        return matchup.includes(post.teamA || '') && matchup.includes(post.teamB || '');
      });

      if (!matchingArticle || !matchingArticle.heatchecksEdge) {
        continue;
      }

      const edge = matchingArticle.heatchecksEdge as any;
      const isV2 = edge && typeof edge === 'object' && 'game' in edge;

      try {
        if (isV2) {
          // Update V2 edge
          const edgeV2 = edge as HeatchecksEdgeV2;
          const updatedEdge = syncV2EdgeWithHeatPick(edgeV2, pick, matchingArticle);
          
          if (updatedEdge) {
            // Update the post
            await apiClient.updatePost(matchingArticle.id, {
              ...matchingArticle,
              heatchecksEdge: updatedEdge
            });
            updatedCount++;
            console.log(`[syncMatchupEdgesWithHeatPicks] Updated edge for ${matchingArticle.teamA} vs ${matchingArticle.teamB}`);
          }
        } else {
          // Update V1 edge (legacy)
          const edgeV1 = edge as HeatchecksEdge;
          const updatedEdge = syncV1EdgeWithHeatPick(edgeV1, pick, matchingArticle);
          
          if (updatedEdge) {
            await apiClient.updatePost(matchingArticle.id, {
              ...matchingArticle,
              heatchecksEdge: updatedEdge
            });
            updatedCount++;
            console.log(`[syncMatchupEdgesWithHeatPicks] Updated edge for ${matchingArticle.teamA} vs ${matchingArticle.teamB}`);
          }
        }
      } catch (error: any) {
        console.error(`[syncMatchupEdgesWithHeatPicks] Error updating ${matchingArticle.teamA} vs ${matchingArticle.teamB}:`, error);
      }
    }

    console.log(`[syncMatchupEdgesWithHeatPicks] Successfully synced ${updatedCount} matchup edges`);
  } catch (error: any) {
    console.error('[syncMatchupEdgesWithHeatPicks] Error fetching matchup posts:', error);
  }
}

const ScannerConsole: React.FC<{ setEditingPost: (post: HeatcheckPost) => void }> = ({ setEditingPost }) => {
  const [narratives, setNarratives] = useState<Narrative[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [loadingMessage, setLoadingMessage] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [cardState, setCardState] = useState<{ [key: string]: { isProcessing?: boolean; isGeneratingTweet?: boolean; error?: string; generatedTweet?: ViralTweetThread; } }>({});
  const [showImportModal, setShowImportModal] = useState<boolean>(false);
  const [isGeneratingArticle, setIsGeneratingArticle] = useState<boolean>(false);
  const [importStartDate, setImportStartDate] = useState<string>('');
  const [importEndDate, setImportEndDate] = useState<string>('');
  const [selectedLeagues, setSelectedLeagues] = useState<string[]>([]);
  const [importResults, setImportResults] = useState<Array<{ league: string; teamA: string; teamB: string; date: string }> | null>(null);
  const [showMatchupModal, setShowMatchupModal] = useState<boolean>(false);
  const [availableMatchups, setAvailableMatchups] = useState<Array<{ id: string; league: string; teamA: string; teamB: string; scheduledDate: string; scheduledTime: string | null }>>([]);
  const [selectedMatchupIds, setSelectedMatchupIds] = useState<string[]>([]);
  const [isGeneratingHeatArticle, setIsGeneratingHeatArticle] = useState<boolean>(false);
  const [isGeneratingHeatArticleV2, setIsGeneratingHeatArticleV2] = useState<boolean>(false);
  const [isGeneratingHeatArticleV3, setIsGeneratingHeatArticleV3] = useState<boolean>(false);
  const [isGeneratingHeatArticleV4, setIsGeneratingHeatArticleV4] = useState<boolean>(false);
  const [generationProgress, setGenerationProgress] = useState<{ current: number; total: number; step: string; matchup: string } | null>(null);
  const [editingMatchupId, setEditingMatchupId] = useState<string | null>(null);
  const [editDate, setEditDate] = useState<string>('');
  const [editTime, setEditTime] = useState<string>('');
  const [matchupFilterLeague, setMatchupFilterLeague] = useState<string[]>([]);
  const [matchupFilterSearch, setMatchupFilterSearch] = useState<string>('');
  const [matchupFilterDate, setMatchupFilterDate] = useState<string>('all'); // 'all', 'today', 'tomorrow', 'thisWeek', 'custom'
  const [matchupFilterCustomStart, setMatchupFilterCustomStart] = useState<string>('');
  const [matchupFilterCustomEnd, setMatchupFilterCustomEnd] = useState<string>('');
  const [showDFSModal, setShowDFSModal] = useState<boolean>(false);
  const [isGeneratingDFSArticle, setIsGeneratingDFSArticle] = useState<boolean>(false);
  const [dfsSport, setDfsSport] = useState<'NBA' | 'NFL'>('NBA');
  const [showHeatPicksModal, setShowHeatPicksModal] = useState<boolean>(false);
  const [isGeneratingHeatPicks, setIsGeneratingHeatPicks] = useState<boolean>(false);
  const [heatPicksDate, setHeatPicksDate] = useState<string>('');
  const [heatPicksLeague, setHeatPicksLeague] = useState<string>('NBA');

  const isGeneratingAnyHeatArticle = isGeneratingHeatArticle || isGeneratingHeatArticleV2 || isGeneratingHeatArticleV3 || isGeneratingHeatArticleV4;
  const [matchupModalSource, setMatchupModalSource] = useState<'oddsapi' | 'v3' | 'v4'>('oddsapi');
  const [articleApiSource, setArticleApiSource] = useState<'theoddsapi' | 'gemini'>('theoddsapi');

  const formatDateYmdForDisplay = (ymd: string) => {
    // Treat YYYY-MM-DD as a calendar date (no timezone shifting).
    // Format directly from the date string to avoid timezone issues with toLocaleDateString()
    const parts = (ymd || '').split('-');
    if (parts.length !== 3) return ymd;
    const y = Number(parts[0]);
    const m = Number(parts[1]);
    const d = Number(parts[2]);
    if (!y || !m || !d) return ymd;
    // Format as M/D/YYYY directly from the date parts to avoid timezone shifting
    return `${m}/${d}/${y}`;
  };

  const fetchNarratives = useCallback(async () => {
    setIsLoading(true); setError(null); setNarratives([]); setCardState({});
    let foundNarratives: Narrative[] = [];
    try {
      setLoadingMessage('Step 1/2: Finding upcoming matchups...');
      const matchupsPrompt = `Identify 3-4 key upcoming professional sports matchups in the NBA, NFL, and EPL scheduled within the next 48 hours. Focus on games with high viewership potential or existing rivalries. Return findings as a JSON array of objects with "league", "teamA", and "teamB". Your entire response must be only the raw JSON array, with no other text or explanation.`;
      const matchupResponse = await ai.models.generateContent({
          model: 'gemini-2.5-pro', contents: matchupsPrompt,
          config: { tools: [{googleSearch: {}}], responseSchema: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { league: {type: Type.STRING}, teamA: {type: Type.STRING}, teamB: {type: Type.STRING} }, required: ['league', 'teamA', 'teamB']}}}
      });
      const matchups: Matchup[] = extractJson(matchupResponse.text);
      
      if (!matchups || matchups.length === 0) {
        setError("Could not find any upcoming matchups to analyze."); setIsLoading(false); return;
      }

      setLoadingMessage('Step 2/2: Researching narratives for each matchup...');
      for (const matchup of matchups) {
        const narrative = await analyzeMatchup(matchup);
        if (narrative && narrative.narrative) {
            foundNarratives.push(narrative);
            setNarratives([...foundNarratives]);
        }
      }
      if (foundNarratives.length === 0) setError("Scan complete. No compelling narratives found.");
    } catch (e: any)
{
      console.error(e);
      setError(e.message || 'Failed to call the Gemini API. Please try again.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const analyzeMatchup = async (matchup: Matchup): Promise<Narrative | null> => {
    const prompt = `You are a "Sports Revenge Finder" analyst. Find a compelling emotional narrative for the upcoming ${matchup.league} game between ${matchup.teamA} and ${matchup.teamB}. Research player histories and use Google Search to find context on rivalries or conflicts. If a compelling story is found, synthesize it. If not, return an empty narrative. Return a single JSON object with schema {league, teamA, teamB, narrative, storyType, searchedPlayers, searchedQueries}. CRITICAL: Your response must be only the raw JSON object itself.`;
    const response = await ai.models.generateContent({
        model: 'gemini-2.5-pro', contents: prompt,
        config: {
          tools: [{googleSearch: {}}],
          responseSchema: { type: Type.OBJECT, properties: { league: { type: Type.STRING }, teamA: { type: Type.STRING }, teamB: { type: Type.STRING }, narrative: { type: Type.STRING }, storyType: { type: Type.STRING }, searchedPlayers: { type: Type.ARRAY, items: { type: Type.STRING } }, searchedQueries: { type: Type.ARRAY, items: { type: Type.STRING } }}, required: ['league', 'teamA', 'teamB', 'narrative', 'storyType'] },
        },
    });
    return extractJson(response.text);
  };

  const performDeepResearch = async (narrative: Narrative): Promise<{ websiteStory: HeatcheckStory, heatchecksEdge: HeatchecksEdge }> => {
    const prompt = getWebsiteReadyPrompt(narrative);
    const response = await ai.models.generateContent({
        model: "gemini-2.5-pro", contents: prompt,
        config: { tools: [{googleSearch: {}}], responseSchema: getWebsiteReadySchema() }
    });
    return extractJson(response.text);
  };

  const handleReadyForWebsite = async (narrative: Narrative) => {
    const cardKey = `${narrative.league}-${narrative.teamA}-${narrative.teamB}`;
    setCardState(s => ({ ...s, [cardKey]: { isProcessing: true } }));

    try {
        const { websiteStory, heatchecksEdge } = await performDeepResearch(narrative);
        if (!websiteStory.headline) throw new Error("Validation failed: Headline is missing.");
        if (!heatchecksEdge.lines || heatchecksEdge.lines.length < 1) throw new Error("Validation failed: Must have at least 1 betting line.");

        const newDraftPost = await apiClient.createDraft({ league: narrative.league, teamA: narrative.teamA, teamB: narrative.teamB, storyType: narrative.storyType, scanNarrative: narrative.narrative, websiteStory, heatchecksEdge });
        setEditingPost(newDraftPost);
        setCardState(s => ({ ...s, [cardKey]: { isProcessing: false } }));
    } catch (e: any) {
        console.error("Failed to generate or save website content:", e);
        setCardState(s => ({ ...s, [cardKey]: { isProcessing: false, error: e.message || "An unknown error occurred." } }));
    }
  };

  const handleGenerateTweet = async (narrative: Narrative) => {
    const cardKey = `${narrative.league}-${narrative.teamA}-${narrative.teamB}`;
    setCardState(s => ({ ...s, [cardKey]: { isGeneratingTweet: true, generatedTweet: undefined, error: undefined } }));
    try {
        const { websiteStory, heatchecksEdge } = await performDeepResearch(narrative);
        const tweetPrompt = getViralTweetPrompt(websiteStory, heatchecksEdge);
        const tweetResponse = await ai.models.generateContent({
            model: "gemini-2.0-flash-exp", contents: tweetPrompt,
            config: { responseMimeType: "application/json", responseSchema: { type: Type.OBJECT, properties: { tweet1: {type: Type.STRING}, tweet2: {type: Type.STRING}}, required: ["tweet1", "tweet2"]}}
        });
        // FIX: Provide an explicit type to `extractJson` to prevent `generatedTweet` from being `unknown`.
        const generatedTweet = extractJson<ViralTweetThread>(tweetResponse.text);
        setCardState(s => ({ ...s, [cardKey]: { isGeneratingTweet: false, generatedTweet } }));
    } catch (e: any) {
        console.error("Failed to generate tweet:", e);
        setCardState(s => ({ ...s, [cardKey]: { isGeneratingTweet: false, error: e.message || "Tweet generation failed." } }));
    }
  };

  const handleImportMatchups = () => {
    // Set default dates (today and 7 days from now)
    const today = new Date();
    const nextWeek = new Date();
    nextWeek.setDate(today.getDate() + 7);
    
    setImportStartDate(today.toISOString().split('T')[0]);
    setImportEndDate(nextWeek.toISOString().split('T')[0]);
    setSelectedLeagues([]);
    setImportResults(null);
    setShowImportModal(true);
  };

  const handleToggleLeague = (league: string) => {
    setSelectedLeagues(prev => 
      prev.includes(league) 
        ? prev.filter(l => l !== league)
        : [...prev, league]
    );
  };

  const handleProcessImport = async () => {
    if (!importStartDate || !importEndDate) {
      setError("Please select both start and end dates.");
      return;
    }

    if (selectedLeagues.length === 0) {
      setError("Please select at least one league.");
      return;
    }

    setIsLoading(true);
    setError(null);
    setLoadingMessage('Importing matchups from OddsAPI...');

    try {
      const result = await apiClient.importMatchups(importStartDate, importEndDate, selectedLeagues);
      
      setImportResults(result.games);
      setLoadingMessage(`Successfully imported ${result.imported} matchup(s).`);
      
      // Close modal after a short delay to show results
      setTimeout(() => {
        setShowImportModal(false);
        setIsLoading(false);
        setImportResults(null);
      }, 3000);
    } catch (e: any) {
      console.error(e);
      setError(e.message || 'Failed to import matchups from OddsAPI.');
      setIsLoading(false);
    }
  };

  const handleImportSoccerMatchups = async () => {
    if (!importStartDate || !importEndDate) {
      setError("Please select both start and end dates.");
      return;
    }

    // Filter to only soccer leagues
    const soccerLeagues = selectedLeagues.filter(l => 
      ['EPL', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1'].includes(l)
    );

    if (soccerLeagues.length === 0) {
      setError("Please select at least one soccer league (EPL, La Liga, Serie A, Bundesliga, or Ligue 1).");
      return;
    }

    setIsLoading(true);
    setError(null);
    setLoadingMessage('Importing soccer matchups from database...');

    try {
      const result = await apiClient.importSoccerMatchups(importStartDate, importEndDate, soccerLeagues);
      
      setImportResults(result.games);
      setLoadingMessage(`Successfully imported ${result.imported} soccer matchup(s). ${result.skipped} skipped.`);
      
      // Close modal after a short delay to show results
      setTimeout(() => {
        setShowImportModal(false);
        setIsLoading(false);
        setImportResults(null);
      }, 3000);
    } catch (e: any) {
      console.error(e);
      setError(e.message || 'Failed to import soccer matchups from database.');
      setIsLoading(false);
    }
  };

  const handleGenerateArticle = async () => {
    // Load available matchups and show selection modal
    try {
      setError(null);
      const matchups = await apiClient.getMatchups();
      setAvailableMatchups(matchups);
      setMatchupModalSource('oddsapi');
      setSelectedMatchupIds([]);
      setEditingMatchupId(null);
      setEditDate('');
      setEditTime('');
      // Reset filters
      setMatchupFilterLeague([]);
      setMatchupFilterSearch('');
      setMatchupFilterDate('all');
      setMatchupFilterCustomStart('');
      setMatchupFilterCustomEnd('');
      setShowMatchupModal(true);
    } catch (e: any) {
      console.error("Failed to load matchups:", e);
      setError(e.message || "Failed to load matchups from database.");
    }
  };

  const handleGenerateArticleV2 = async () => {
    // Load available matchups and show selection modal (same as V1)
    try {
      setError(null);
      const matchups = await apiClient.getMatchups();
      setAvailableMatchups(matchups);
      setMatchupModalSource('oddsapi');
      setSelectedMatchupIds([]);
      setEditingMatchupId(null);
      setEditDate('');
      setEditTime('');
      // Reset filters
      setMatchupFilterLeague([]);
      setMatchupFilterSearch('');
      setMatchupFilterDate('all');
      setMatchupFilterCustomStart('');
      setMatchupFilterCustomEnd('');
      setShowMatchupModal(true);
    } catch (e: any) {
      console.error("Failed to load matchups:", e);
      setError(e.message || "Failed to load matchups from database.");
    }
  };

  const handleGenerateArticleV3 = async () => {
    // Load available matchups and show selection modal
    // Load both NBA and soccer matchups
    try {
      setError(null);
      // Load NBA matchups from v3 endpoint (nba_heat_sheet DB)
      const nbaMatchups = await apiClient.getMatchupsV3();
      
      // Load ALL matchups from main matchups table (includes imported soccer matchups)
      const allMatchupsFromMain = await apiClient.getMatchups();
      
      // Filter for soccer leagues from main table
      const soccerLeagues = ['EPL', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1'];
      const soccerMatchupsFromMain = allMatchupsFromMain.filter(m => 
        soccerLeagues.includes(m.league)
      );
      
      // Also try to load from soccerdata DB as fallback (for matchups not yet imported)
      const allSoccerMatchups: any[] = [...soccerMatchupsFromMain];
      for (const league of soccerLeagues) {
        try {
          const soccerMatchups = await apiClient.getMatchupsV3Soccer(league);
          // Only add if not already in main table (avoid duplicates)
          for (const matchup of soccerMatchups) {
            const exists = allSoccerMatchups.some(m => 
              m.teamA === matchup.teamA && 
              m.teamB === matchup.teamB && 
              m.scheduledDate === matchup.scheduledDate
            );
            if (!exists) {
              allSoccerMatchups.push(matchup);
            }
          }
        } catch (e: any) {
          console.warn(`Failed to load ${league} matchups from soccerdata DB:`, e.message || e);
          // Continue loading other leagues even if one fails
        }
      }
      
      // Combine all matchups
      const allMatchups = [...nbaMatchups, ...allSoccerMatchups];
      setAvailableMatchups(allMatchups);
      setMatchupModalSource('v3');
      setSelectedMatchupIds([]);
      setEditingMatchupId(null);
      setEditDate('');
      setEditTime('');
      // Reset filters
      setMatchupFilterLeague([]);
      setMatchupFilterSearch('');
      setMatchupFilterDate('all');
      setMatchupFilterCustomStart('');
      setMatchupFilterCustomEnd('');
      setShowMatchupModal(true);
    } catch (e: any) {
      console.error("Failed to load matchups:", e);
      setError(e.message || "Failed to load matchups from database.");
    }
  };

  const handleGenerateArticleV4 = async () => {
    // Load NBA matchups only for V4
    try {
      setError(null);
      // Load NBA matchups from v3 endpoint (nba_heat_sheet DB) - V4 only supports NBA
      const nbaMatchups = await apiClient.getMatchupsV3();
      
      setAvailableMatchups(nbaMatchups);
      setMatchupModalSource('v4');
      setSelectedMatchupIds([]);
      setEditingMatchupId(null);
      setEditDate('');
      setEditTime('');
      // Reset filters
      setMatchupFilterLeague([]);
      setMatchupFilterSearch('');
      setMatchupFilterDate('all');
      setMatchupFilterCustomStart('');
      setMatchupFilterCustomEnd('');
      setShowMatchupModal(true);
    } catch (e: any) {
      console.error("Failed to load NBA matchups for V4:", e);
      setError(e.message || "Failed to load NBA matchups from database.");
    }
  };

  const handleToggleMatchup = (matchupId: string) => {
    setSelectedMatchupIds(prev => 
      prev.includes(matchupId) 
        ? prev.filter(id => id !== matchupId)
        : [...prev, matchupId]
    );
  };

  const handleEditMatchup = (matchup: typeof availableMatchups[0]) => {
    if (matchupModalSource === 'v3') {
      setError('V3 matchups are sourced from the stats DB and cannot be edited here.');
      return;
    }
    setEditingMatchupId(matchup.id);
    setEditDate(matchup.scheduledDate);
    setEditTime(matchup.scheduledTime || '');
    setError(null);
  };

  const handleSaveMatchup = async (matchupId: string) => {
    if (matchupModalSource === 'v3' || matchupModalSource === 'v4') {
      setError('V3/V4 matchups are sourced from the stats DB and cannot be edited here.');
      return;
    }
    try {
      setError(null);
      // Normalize time: HTML time input returns HH:MM format, but ensure it's properly formatted
      const normalizedTime = editTime && editTime.trim() ? editTime.trim() : null;
      const result = await apiClient.updateMatchup(matchupId, editDate, normalizedTime);
      
      // Update the matchup in the list
      setAvailableMatchups(prev => prev.map(m => 
        m.id === matchupId 
          ? { ...m, scheduledDate: result.matchup.scheduledDate, scheduledTime: result.matchup.scheduledTime }
          : m
      ));
      
      setEditingMatchupId(null);
      setEditDate('');
      setEditTime('');
    } catch (e: any) {
      console.error("Failed to update matchup:", e);
      setError(e.message || "Failed to update matchup date.");
    }
  };

  const handleCancelEdit = () => {
    setEditingMatchupId(null);
    setEditDate('');
    setEditTime('');
    setError(null);
  };

  // Get today and tomorrow in NY timezone for filtering
  const getTodayDateNY = () => {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const y = parts.find(p => p.type === "year")?.value;
    const m = parts.find(p => p.type === "month")?.value;
    const d = parts.find(p => p.type === "day")?.value;
    return `${y}-${m}-${d}`;
  };

  const getTomorrowDateNY = () => {
    const today = getTodayDateNY();
    const [y, m, d] = today.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + 1);
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(dt.getUTCDate()).padStart(2, "0");
    return `${yy}-${mm}-${dd}`;
  };

  // Filter matchups based on filter criteria
  const filteredMatchups = availableMatchups.filter(matchup => {
    // League filter (case-insensitive comparison)
    if (matchupFilterLeague.length > 0) {
      const matchupLeagueUpper = matchup.league.toUpperCase();
      const hasMatch = matchupFilterLeague.some(filterLeague => 
        filterLeague.toUpperCase() === matchupLeagueUpper
      );
      if (!hasMatch) {
        return false;
      }
    }

    // Team name search filter
    if (matchupFilterSearch.trim()) {
      const searchLower = matchupFilterSearch.toLowerCase();
      const matchesTeam = matchup.teamA.toLowerCase().includes(searchLower) || 
                         matchup.teamB.toLowerCase().includes(searchLower);
      if (!matchesTeam) {
        return false;
      }
    }

    // Date filter
    if (matchupFilterDate === 'today') {
      const today = getTodayDateNY();
      if (matchup.scheduledDate !== today) return false;
    } else if (matchupFilterDate === 'tomorrow') {
      const tomorrow = getTomorrowDateNY();
      if (matchup.scheduledDate !== tomorrow) return false;
    } else if (matchupFilterDate === 'thisWeek') {
      const today = getTodayDateNY();
      const [y, m, d] = today.split("-").map(Number);
      const todayDate = new Date(Date.UTC(y, m - 1, d));
      const weekEnd = new Date(Date.UTC(y, m - 1, d));
      weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
      
      const matchupDate = new Date(matchup.scheduledDate + 'T00:00:00Z');
      if (matchupDate < todayDate || matchupDate > weekEnd) return false;
    } else if (matchupFilterDate === 'custom') {
      if (matchupFilterCustomStart && matchup.scheduledDate < matchupFilterCustomStart) return false;
      if (matchupFilterCustomEnd && matchup.scheduledDate > matchupFilterCustomEnd) return false;
    }
    // 'all' means no date filtering

    return true;
  });

  const handleProcessHeatArticle = async () => {
    if (selectedMatchupIds.length === 0) {
      setError("Please select at least one matchup.");
      return;
    }

    // Keep modal open to show progress
    setIsGeneratingHeatArticle(true);
    setError(null);

    const selectedMatchups = filteredMatchups.filter(m => selectedMatchupIds.includes(m.id));
    const completedArticles: string[] = [];
    const failedArticles: Array<{ matchup: string; error: string }> = [];
    
    try {
      // Process each matchup sequentially
      for (let i = 0; i < selectedMatchups.length; i++) {
        const matchup = selectedMatchups[i];
        const matchupLabel = `${matchup.teamA} vs ${matchup.teamB}`;
        
        setGenerationProgress({
          current: i + 1,
          total: selectedMatchups.length,
          step: `Processing ${matchupLabel}...`,
          matchup: matchupLabel
        });

        try {
          // Generate comprehensive heat check (all phases in one call)
          setGenerationProgress(prev => prev ? { ...prev, step: `Generating comprehensive heat check for ${matchupLabel}...` } : null);
          console.log(`[${matchupLabel}] [${i + 1}/${selectedMatchups.length}] Starting comprehensive generation`);
          
          const heatCheckData = await generateHeatCheckNarrative(matchup);
          console.log(`[${matchupLabel}] [${i + 1}/${selectedMatchups.length}] Generation complete`);
          
          // Extract data from response
          const factPack = heatCheckData.fact_pack;
          const evidenceBundle = heatCheckData.evidence_bundle;
          const candidateCards = heatCheckData.narratives.candidate_cards;
          const selectedNarrative = heatCheckData.narratives.selected;
          const qualityReport = heatCheckData.quality_report;
          const article = heatCheckData.article;

          // Validate key characters (players/coaches) are on correct teams
          setGenerationProgress(prev => prev ? { ...prev, step: `Validating key characters for ${matchupLabel}...` } : null);
          console.log(`[${matchupLabel}] [${i + 1}/${selectedMatchups.length}] Validating key characters`);
          let validationWarnings = await validateKeyCharacters(candidateCards, matchup.teamA, matchup.teamB, matchup.league);
          
          // Add quality report corrections to validation warnings
          if (qualityReport?.corrections_applied && Array.isArray(qualityReport.corrections_applied)) {
            qualityReport.corrections_applied.forEach((correction: string) => {
              if (correction && correction.trim()) {
                validationWarnings.push(`ℹ️ ${correction}`);
              }
            });
          }
          
          // AI Editor: Correct article if validation warnings exist
          let correctedArticleMarkdown = article.long_form_markdown;
          const aiCorrections: any = {
            original_warnings: [...validationWarnings],
            corrections_applied: [],
            invalid_players_replaced: []
          };
          
          // Filter to only roster-related warnings (not info messages)
          const rosterWarnings = validationWarnings.filter(w => w.startsWith('⚠️'));
          
          // Filter to only HIGH confidence invalidations for auto-correction
          // Low/medium confidence warnings will be logged but require manual review
          // Warnings without confidence info are treated as requiring review (not auto-corrected)
          const highConfidenceWarnings = rosterWarnings.filter(w => 
            w.includes('[High Confidence]') && 
            !w.includes('LOW CONFIDENCE') &&
            !w.includes('Medium Confidence') &&
            !w.includes('Low Confidence')
          );
          
          const lowMediumConfidenceWarnings = rosterWarnings.filter(w => 
            w.includes('[Low Confidence') || 
            w.includes('[Medium Confidence') ||
            w.includes('LOW CONFIDENCE') ||
            (!w.includes('[High Confidence]') && !w.includes('LOW CONFIDENCE') && !w.includes('Medium Confidence') && !w.includes('Low Confidence') && !w.includes('injury status'))
          );
          
          // Log low/medium confidence warnings but don't auto-correct
          if (lowMediumConfidenceWarnings.length > 0) {
            console.log(`[${matchupLabel}] [${i + 1}/${selectedMatchups.length}] ${lowMediumConfidenceWarnings.length} low/medium confidence validation warning(s) - Skipping auto-correction, manual review recommended:`, lowMediumConfidenceWarnings);
            validationWarnings.push(`ℹ️ ${lowMediumConfidenceWarnings.length} validation warning(s) require manual review due to low/medium confidence`);
          }
          
          if (highConfidenceWarnings.length > 0) {
            console.log(`[${matchupLabel}] [${i + 1}/${selectedMatchups.length}] ${highConfidenceWarnings.length} high-confidence roster validation warning(s) found - Applying AI Editor corrections...`);
            setGenerationProgress(prev => prev ? { ...prev, step: `AI Editor: Correcting ${matchupLabel} (replacing ${highConfidenceWarnings.length} invalid reference(s)...` } : null);
            
            try {
              const correctionResult = await correctArticleWithAI(
                article.long_form_markdown,
                highConfidenceWarnings,
                matchup.teamA,
                matchup.teamB,
                matchup.league
              );
              
              correctedArticleMarkdown = correctionResult.correctedMarkdown;
              aiCorrections.corrections_applied = correctionResult.correctionsSummary;
              
              // Update validation warnings to mark roster issues as fixed
              validationWarnings = validationWarnings.map(w => {
                if (w.startsWith('⚠️') && highConfidenceWarnings.includes(w)) {
                  return `${w} [Fixed by AI Editor]`;
                }
                return w;
              });
              
              // Add corrections summary to validation warnings
              correctionResult.correctionsSummary.forEach((summary: string) => {
                validationWarnings.push(summary);
              });
              
              console.log(`[${matchupLabel}] [${i + 1}/${selectedMatchups.length}] AI Editor corrections applied:`, correctionResult.correctionsSummary);
              
            } catch (error: any) {
              console.error(`[${matchupLabel}] [${i + 1}/${selectedMatchups.length}] AI Editor correction failed:`, error);
              validationWarnings.push(`⚠️ AI Editor correction failed: ${error.message || 'Unknown error'} - Using original article`);
            }
          }
          
          if (validationWarnings.length > 0) {
            console.log(`[${matchupLabel}] [${i + 1}/${selectedMatchups.length}] Final validation warnings:`, validationWarnings);
          }

          // Create draft post with all the data (using corrected article markdown)
          const primaryCard = candidateCards.find(c => c.narrative_id === selectedNarrative.primary_narrative_id);
          if (!primaryCard) throw new Error("Primary narrative card not found");

          // Generate HeatChecks Edge betting recommendation
          setGenerationProgress(prev => prev ? { ...prev, step: `Generating HeatChecks Edge for ${matchupLabel}...` } : null);
          console.log(`[${matchupLabel}] [${i + 1}/${selectedMatchups.length}] Generating HeatChecks Edge...`);
          
          const heatChecksEdge = await generateHeatChecksEdge(
            {
              candidate_cards: candidateCards,
              selected: selectedNarrative
            },
            factPack,
            primaryCard,
            matchup.teamA,
            matchup.teamB,
            matchup.league
          );
          
          console.log(`[${matchupLabel}] [${i + 1}/${selectedMatchups.length}] HeatChecks Edge generated:`, {
            lean: heatChecksEdge.lean,
            confidence: heatChecksEdge.confidence,
            finalCallPreview: heatChecksEdge.finalCall.substring(0, 100) + '...'
          });

          setGenerationProgress(prev => prev ? { ...prev, step: `Creating draft post for ${matchupLabel}...` } : null);
          
          const newDraftPost = await apiClient.createDraft({
            league: matchup.league,
            teamA: matchup.teamA,
            teamB: matchup.teamB,
            matchupScheduledDate: matchup.scheduledDate,
            storyType: 'heat_article',
            scanNarrative: primaryCard.claim,
            websiteStory: {
              formatStyle: "QUOTE_LEDE",
              headline: primaryCard.title,
              dek: primaryCard.claim,
              whyItMatters: [],
              theBackstory: correctedArticleMarkdown,
              theData: factPack.key_stats?.map(s => `${s.label}: ${s.value}`) || [],
              keyMomentsTimeline: evidenceBundle.timeline_events?.map(e => ({
                date: new Date(e.date_utc).toLocaleDateString(),
                event: e.summary
              })) || [],
              theReceipts: evidenceBundle.quotes?.map(q => ({
                quote: q.quote,
                speaker: q.speaker,
                context: q.context,
                sourceUrl: evidenceBundle.sources?.find(s => s.source_id === q.source_id)?.url || ''
              })) || [],
              pressurePoints: [],
              whatToWatch: [],
              edgeAngle: primaryCard.claim,
              tags: primaryCard.emotion_tags || [],
              sources: evidenceBundle.sources?.map(s => ({
                title: s.title,
                url: s.url,
                publisher: s.publisher,
                publishedAt: s.published_utc
              })) || [],
              seo: {
                slug: article.seo?.primary_keyword?.toLowerCase().replace(/\s+/g, '-') || '',
                metaTitle: article.seo?.title_options?.[0] || primaryCard.title,
                metaDescription: article.seo?.meta_description || primaryCard.claim
              },
              image: '',
              imageUrl: undefined
            },
            heatchecksEdge: heatChecksEdge,
            heatCheckData: {
              factPack,
              evidenceBundle,
              narratives: {
                candidate_cards: candidateCards,
                selected: selectedNarrative
              },
              qualityReport,
              article: {
                ...article,
                long_form_markdown: correctedArticleMarkdown
              },
              validation_warnings: validationWarnings,
              ai_corrections: aiCorrections
            }
          });

          // Log completion for this article
          completedArticles.push(matchupLabel);
          console.log(`✅ [${matchupLabel}] [${i + 1}/${selectedMatchups.length}] Article completed successfully! Draft ID: ${newDraftPost.id}`);
          setGenerationProgress(prev => prev ? { 
            ...prev, 
            step: `✅ Completed ${i + 1}/${selectedMatchups.length}: ${matchupLabel}` 
          } : null);
          
        } catch (articleError: any) {
          // Log error for this specific article but continue with next
          const errorMessage = articleError.message || 'Unknown error';
          failedArticles.push({ matchup: matchupLabel, error: errorMessage });
          console.error(`❌ [${matchupLabel}] [${i + 1}/${selectedMatchups.length}] Failed to generate article:`, articleError);
          setGenerationProgress(prev => prev ? { 
            ...prev, 
            step: `❌ Failed ${i + 1}/${selectedMatchups.length}: ${matchupLabel} - ${errorMessage}` 
          } : null);
          
          // Continue to next matchup instead of stopping
          continue;
        }
      }

      // All matchups processed - show completion message
      setGenerationProgress({
        current: selectedMatchups.length,
        total: selectedMatchups.length,
        step: completedArticles.length === selectedMatchups.length 
          ? `✅ All ${completedArticles.length} article(s) completed successfully!` 
          : `Completed ${completedArticles.length}/${selectedMatchups.length} article(s). ${failedArticles.length} failed.`,
        matchup: ''
      });

      // Log final summary
      console.log('=== HEAT ARTICLE GENERATION SUMMARY ===');
      console.log(`Total matchups: ${selectedMatchups.length}`);
      console.log(`✅ Completed: ${completedArticles.length}`);
      completedArticles.forEach((matchup, idx) => {
        console.log(`  ${idx + 1}. ${matchup}`);
      });
      if (failedArticles.length > 0) {
        console.log(`❌ Failed: ${failedArticles.length}`);
        failedArticles.forEach((failure, idx) => {
          console.log(`  ${idx + 1}. ${failure.matchup}: ${failure.error}`);
        });
      }
      console.log('========================================');

      // Wait a moment to show completion message, then close modal
      setTimeout(() => {
        setGenerationProgress(null);
        setShowMatchupModal(false);
        setSelectedMatchupIds([]);
        
        // Show success/error message
        if (completedArticles.length === selectedMatchups.length) {
          setError(null); // Clear any previous errors
          // You could also show a success toast here if you have one
          console.log('All articles generated successfully. Access them in the Content Feed tab.');
        } else {
          setError(`Generated ${completedArticles.length} of ${selectedMatchups.length} articles. ${failedArticles.length} failed. Check console for details.`);
        }
      }, 2000); // 2 second delay to show completion message
      
    } catch (e: any) {
      console.error("Fatal error in heat article generation:", e);
      setError(e.message || "Article generation failed. Check console for details.");
      setGenerationProgress(null);
      // Keep modal open on error so user can see the error
    } finally {
      setIsGeneratingHeatArticle(false);
    }
  };

  const handleProcessHeatArticleV2 = async () => {
    if (selectedMatchupIds.length === 0) {
      setError("Please select at least one matchup.");
      return;
    }

    // Keep modal open to show progress
    setIsGeneratingHeatArticleV2(true);
    setError(null);

    const selectedMatchups = filteredMatchups.filter(m => selectedMatchupIds.includes(m.id));
    const completedArticles: string[] = [];
    const failedArticles: Array<{ matchup: string; error: string }> = [];
    
    try {
      // Process each matchup sequentially
      for (let i = 0; i < selectedMatchups.length; i++) {
        const matchup = selectedMatchups[i];
        const matchupLabel = `${matchup.teamA} vs ${matchup.teamB}`;
        
        // Add delay between requests (except before first) to avoid rate limiting
        if (i > 0) {
          const delaySeconds = 3; // 3 second delay between requests
          setGenerationProgress({
            current: i,
            total: selectedMatchups.length,
            step: `Waiting ${delaySeconds} seconds before next article (rate limit protection)...`,
            matchup: ''
          });
          await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
        }
        
        setGenerationProgress({
          current: i + 1,
          total: selectedMatchups.length,
          step: `Processing ${matchupLabel}...`,
          matchup: matchupLabel
        });

        try {
          // Generate comprehensive heat check using V2 enhanced logic
          setGenerationProgress(prev => prev ? { ...prev, step: `Generating enhanced heat check for ${matchupLabel}...` } : null);
          console.log(`[${matchupLabel}] [${i + 1}/${selectedMatchups.length}] Starting V2 enhanced generation`);
          
          const heatCheckData = await generateHeatCheckNarrativeV2(matchup);
          console.log(`[${matchupLabel}] [${i + 1}/${selectedMatchups.length}] V2 generation complete`);
          
          // Extract data from response
          const factPack = heatCheckData.fact_pack;
          const evidenceBundle = heatCheckData.evidence_bundle;
          const candidateCards = heatCheckData.narratives.candidate_cards;
          const selectedNarrative = heatCheckData.narratives.selected;
          const qualityReport = heatCheckData.quality_report;
          const article = heatCheckData.article;
          const emotionalMap = heatCheckData.emotional_map; // NEW: Extract emotional map

          // Validate key characters (players/coaches) are on correct teams
          setGenerationProgress(prev => prev ? { ...prev, step: `Validating key characters for ${matchupLabel}...` } : null);
          console.log(`[${matchupLabel}] [${i + 1}/${selectedMatchups.length}] Validating key characters`);
          let validationWarnings = await validateKeyCharacters(candidateCards, matchup.teamA, matchup.teamB, matchup.league);
          
          // Add quality report corrections to validation warnings
          if (qualityReport?.corrections_applied && Array.isArray(qualityReport.corrections_applied)) {
            qualityReport.corrections_applied.forEach((correction: string) => {
              if (correction && correction.trim()) {
                validationWarnings.push(`ℹ️ ${correction}`);
              }
            });
          }
          
          // AI Editor: Correct article if validation warnings exist
          let correctedArticleMarkdown = article.long_form_markdown;
          const aiCorrections: any = {
            original_warnings: [...validationWarnings],
            corrections_applied: [],
            invalid_players_replaced: []
          };
          
          // Filter to only roster-related warnings (not info messages)
          const rosterWarnings = validationWarnings.filter(w => w.startsWith('⚠️'));
          
          // Filter to only HIGH confidence invalidations for auto-correction
          // Low/medium confidence warnings will be logged but require manual review
          // Warnings without confidence info are treated as requiring review (not auto-corrected)
          const highConfidenceWarnings = rosterWarnings.filter(w => 
            w.includes('[High Confidence]') && 
            !w.includes('LOW CONFIDENCE') &&
            !w.includes('Medium Confidence') &&
            !w.includes('Low Confidence')
          );
          
          const lowMediumConfidenceWarnings = rosterWarnings.filter(w => 
            w.includes('[Low Confidence') || 
            w.includes('[Medium Confidence') ||
            w.includes('LOW CONFIDENCE') ||
            (!w.includes('[High Confidence]') && !w.includes('LOW CONFIDENCE') && !w.includes('Medium Confidence') && !w.includes('Low Confidence') && !w.includes('injury status'))
          );
          
          // Log low/medium confidence warnings but don't auto-correct
          if (lowMediumConfidenceWarnings.length > 0) {
            console.log(`[${matchupLabel}] [${i + 1}/${selectedMatchups.length}] ${lowMediumConfidenceWarnings.length} low/medium confidence validation warning(s) - Skipping auto-correction, manual review recommended:`, lowMediumConfidenceWarnings);
            validationWarnings.push(`ℹ️ ${lowMediumConfidenceWarnings.length} validation warning(s) require manual review due to low/medium confidence`);
          }
          
          if (highConfidenceWarnings.length > 0) {
            console.log(`[${matchupLabel}] [${i + 1}/${selectedMatchups.length}] ${highConfidenceWarnings.length} high-confidence roster validation warning(s) found - Applying AI Editor corrections...`);
            setGenerationProgress(prev => prev ? { ...prev, step: `AI Editor: Correcting ${matchupLabel} (replacing ${highConfidenceWarnings.length} invalid reference(s)...` } : null);
            
            try {
              const correctionResult = await correctArticleWithAI(
                article.long_form_markdown,
                highConfidenceWarnings,
                matchup.teamA,
                matchup.teamB,
                matchup.league
              );
              
              correctedArticleMarkdown = correctionResult.correctedMarkdown;
              aiCorrections.corrections_applied = correctionResult.correctionsSummary;
              
              // Check if corrections were actually applied
              if (correctionResult.correctionsSummary.length === 0) {
                validationWarnings.push(`⚠️ CRITICAL: ${highConfidenceWarnings.length} invalid player/coach reference(s) could not be automatically corrected. Manual review required before publishing.`);
                console.warn(`[${matchupLabel}] [${i + 1}/${selectedMatchups.length}] ⚠️ CRITICAL: No corrections were applied for invalid references.`);
              }
              
              // Update validation warnings to mark roster issues as fixed
              validationWarnings = validationWarnings.map(w => {
                if (w.startsWith('⚠️') && highConfidenceWarnings.includes(w)) {
                  return `${w} [Fixed by AI Editor]`;
                }
                return w;
              });
              
              // Add corrections summary to validation warnings
              correctionResult.correctionsSummary.forEach((summary: string) => {
                validationWarnings.push(summary);
              });
              
              console.log(`[${matchupLabel}] [${i + 1}/${selectedMatchups.length}] AI Editor corrections applied:`, correctionResult.correctionsSummary);
              
            } catch (error: any) {
              console.error(`[${matchupLabel}] [${i + 1}/${selectedMatchups.length}] AI Editor correction failed:`, error);
              validationWarnings.push(`⚠️ CRITICAL: AI Editor correction failed: ${error.message || 'Unknown error'} - Invalid player/coach references remain in article. Manual review required.`);
            }
          } else {
            // Also check for any invalidations that weren't high confidence but should still be flagged
            const invalidWarnings = rosterWarnings.filter(w => 
              !w.includes('[Fixed') && 
              (w.includes('not on') || w.includes('Invalid') || w.includes('traded') || w.includes('released'))
            );
            
            if (invalidWarnings.length > 0) {
              validationWarnings.push(`⚠️ WARNING: ${invalidWarnings.length} player/coach validation issue(s) found with medium/low confidence. Manual review recommended.`);
            }
          }
          
          if (validationWarnings.length > 0) {
            console.log(`[${matchupLabel}] [${i + 1}/${selectedMatchups.length}] Final validation warnings:`, validationWarnings);
          }

          // Create draft post with all the data (using corrected article markdown)
          const primaryCard = candidateCards.find(c => c.narrative_id === selectedNarrative.primary_narrative_id);
          if (!primaryCard) throw new Error("Primary narrative card not found");

          // Generate HeatChecks Edge betting recommendation
          setGenerationProgress(prev => prev ? { ...prev, step: `Generating HeatChecks Edge for ${matchupLabel}...` } : null);
          console.log(`[${matchupLabel}] [${i + 1}/${selectedMatchups.length}] Generating HeatChecks Edge...`);
          
          const heatChecksEdge = await generateHeatChecksEdge(
            {
              candidate_cards: candidateCards,
              selected: selectedNarrative
            },
            factPack,
            primaryCard,
            matchup.teamA,
            matchup.teamB,
            matchup.league
          );
          
          console.log(`[${matchupLabel}] [${i + 1}/${selectedMatchups.length}] HeatChecks Edge generated:`, {
            lean: heatChecksEdge.lean,
            confidence: heatChecksEdge.confidence,
            finalCallPreview: heatChecksEdge.finalCall.substring(0, 100) + '...'
          });

          setGenerationProgress(prev => prev ? { ...prev, step: `Creating draft post for ${matchupLabel}...` } : null);
          
          const newDraftPost = await apiClient.createDraft({
            league: matchup.league,
            teamA: matchup.teamA,
            teamB: matchup.teamB,
            matchupScheduledDate: matchup.scheduledDate,
            storyType: 'heat_article',
            scanNarrative: primaryCard.claim,
            websiteStory: {
              formatStyle: "QUOTE_LEDE",
              headline: primaryCard.title,
              dek: primaryCard.claim,
              whyItMatters: [],
              theBackstory: correctedArticleMarkdown,
              theData: factPack.key_stats?.map(s => `${s.label}: ${s.value}`) || [],
              keyMomentsTimeline: evidenceBundle.timeline_events?.map(e => ({
                date: new Date(e.date_utc).toLocaleDateString(),
                event: e.summary
              })) || [],
              theReceipts: evidenceBundle.quotes?.map(q => ({
                quote: q.quote,
                speaker: q.speaker,
                context: q.context,
                sourceUrl: evidenceBundle.sources?.find(s => s.source_id === q.source_id)?.url || ''
              })) || [],
              pressurePoints: [],
              whatToWatch: [],
              edgeAngle: primaryCard.claim,
              tags: primaryCard.emotion_tags || [],
              sources: evidenceBundle.sources?.map(s => ({
                title: s.title,
                url: s.url,
                publisher: s.publisher,
                publishedAt: s.published_utc
              })) || [],
              seo: {
                slug: article.seo?.primary_keyword?.toLowerCase().replace(/\s+/g, '-') || '',
                metaTitle: article.seo?.title_options?.[0] || primaryCard.title,
                metaDescription: article.seo?.meta_description || primaryCard.claim
              },
              image: '',
              imageUrl: undefined
            },
            heatchecksEdge: heatChecksEdge,
            heatCheckData: {
              factPack,
              evidenceBundle,
              narratives: {
                candidate_cards: candidateCards,
                selected: selectedNarrative
              },
              emotional_map: emotionalMap, // NEW: Include emotional map
              qualityReport,
              article: {
                ...article,
                long_form_markdown: correctedArticleMarkdown
              },
              validation_warnings: validationWarnings,
              ai_corrections: aiCorrections
            }
          });

          // Log completion for this article
          completedArticles.push(matchupLabel);
          console.log(`✅ [${matchupLabel}] [${i + 1}/${selectedMatchups.length}] V2 Article completed successfully! Draft ID: ${newDraftPost.id}`);
          setGenerationProgress(prev => prev ? { 
            ...prev, 
            step: `✅ Completed ${i + 1}/${selectedMatchups.length}: ${matchupLabel}` 
          } : null);
          
        } catch (articleError: any) {
          // Log error for this specific article but continue with next
          const errorMessage = articleError.message || 'Unknown error';
          failedArticles.push({ matchup: matchupLabel, error: errorMessage });
          console.error(`❌ [${matchupLabel}] [${i + 1}/${selectedMatchups.length}] Failed to generate V2 article:`, articleError);
          setGenerationProgress(prev => prev ? { 
            ...prev, 
            step: `❌ Failed ${i + 1}/${selectedMatchups.length}: ${matchupLabel} - ${errorMessage}` 
          } : null);
          
          // Continue to next matchup instead of stopping
          continue;
        }
      }

      // All matchups processed - show completion message
      setGenerationProgress({
        current: selectedMatchups.length,
        total: selectedMatchups.length,
        step: completedArticles.length === selectedMatchups.length 
          ? `✅ All ${completedArticles.length} V2 article(s) completed successfully!` 
          : `Completed ${completedArticles.length}/${selectedMatchups.length} V2 article(s). ${failedArticles.length} failed.`,
        matchup: ''
      });

      // Log final summary
      console.log('=== HEAT ARTICLE V2 GENERATION SUMMARY ===');
      console.log(`Total matchups: ${selectedMatchups.length}`);
      console.log(`✅ Completed: ${completedArticles.length}`);
      completedArticles.forEach((matchup, idx) => {
        console.log(`  ${idx + 1}. ${matchup}`);
      });
      if (failedArticles.length > 0) {
        console.log(`❌ Failed: ${failedArticles.length}`);
        failedArticles.forEach((failure, idx) => {
          console.log(`  ${idx + 1}. ${failure.matchup}: ${failure.error}`);
        });
      }
      console.log('========================================');

      // Wait a moment to show completion message, then close modal
      setTimeout(() => {
        setGenerationProgress(null);
        setShowMatchupModal(false);
        setSelectedMatchupIds([]);
        
        // Show success/error message
        if (completedArticles.length === selectedMatchups.length) {
          setError(null); // Clear any previous errors
          console.log('All V2 articles generated successfully. Access them in the Content Feed tab.');
        } else {
          setError(`Generated ${completedArticles.length} of ${selectedMatchups.length} V2 articles. ${failedArticles.length} failed. Check console for details.`);
        }
      }, 2000); // 2 second delay to show completion message
      
    } catch (e: any) {
      console.error("Fatal error in V2 heat article generation:", e);
      setError(e.message || "V2 Article generation failed. Check console for details.");
      setGenerationProgress(null);
      // Keep modal open on error so user can see the error
    } finally {
      setIsGeneratingHeatArticleV2(false);
    }
  };

  const handleProcessHeatArticleV3 = async () => {
    if (selectedMatchupIds.length === 0) {
      setError("Please select at least one matchup.");
      return;
    }

    setIsGeneratingHeatArticleV3(true);
    setError(null);

    const selectedMatchups = filteredMatchups.filter(m => selectedMatchupIds.includes(m.id));
    const completed: string[] = [];
    const failed: Array<{ matchup: string; error: string }> = [];

    try {
      for (let i = 0; i < selectedMatchups.length; i++) {
        const matchup = selectedMatchups[i];
        const matchupLabel = `${matchup.teamA} vs ${matchup.teamB}`;

        setGenerationProgress({
          current: i + 1,
          total: selectedMatchups.length,
          step: `Fetching MatchPackV3 for ${matchupLabel}...`,
          matchup: matchupLabel
        });

        try {
          // Normalize scheduledDate to YYYY-MM-DD format
          let normalizedDate: string | null = null;
          if (matchup.scheduledDate) {
            // If it's already in YYYY-MM-DD format, use it
            if (/^\d{4}-\d{2}-\d{2}$/.test(matchup.scheduledDate)) {
              normalizedDate = matchup.scheduledDate;
            } else {
              // Try to parse and format it
              try {
                const date = new Date(matchup.scheduledDate);
                if (!isNaN(date.getTime())) {
                  const year = date.getFullYear();
                  const month = String(date.getMonth() + 1).padStart(2, '0');
                  const day = String(date.getDate()).padStart(2, '0');
                  normalizedDate = `${year}-${month}-${day}`;
                }
              } catch (e) {
                console.warn(`Could not parse scheduledDate: ${matchup.scheduledDate}`, e);
              }
            }
          }
          
          // Route to correct endpoint based on league
          // EPL and other soccer leagues use the soccer endpoint (matchpack, charts, etc.)
          const league = matchup.league || '';
          const isSoccer = isSoccerLeague(league);
          console.log(`[V3] League: "${league}", isSoccer: ${isSoccer}, routing to ${isSoccer ? 'getMatchPackV3Soccer' : 'getMatchPackV3'}`);
          
          const { pack } = isSoccer
            ? await apiClient.getMatchPackV3Soccer(
                matchup.teamA,
                matchup.teamB,
                normalizedDate,
                null
              )
            : await apiClient.getMatchPackV3(
                matchup.teamA,
                matchup.teamB,
                normalizedDate,
                null
              );

          if (!pack) throw new Error('MatchPackV3 returned null pack');
          if (pack.error) throw new Error(`${pack.error}: ${pack.message || 'MatchPack generation failed'}`);
          
          // Verify pack structure for EPL/soccer leagues
          if (isSoccer) {
            console.log(`[V3] Soccer MatchPack received for ${matchupLabel}:`, {
              hasFactDrop: !!pack.factDrop,
              hasCharts: !!pack.factDrop?.charts,
              hasMatchup: !!pack.matchup,
              source: pack.source || 'unknown'
            });
          }

          setGenerationProgress(prev => prev ? { ...prev, step: `Researching evidence + odds for ${matchupLabel}...` } : null);
          const v2Research = await generateHeatCheckNarrativeV2(matchup);
          const factPack = v2Research.fact_pack || {};
          const evidenceBundleRaw = v2Research.evidence_bundle || {};

          // Normalize evidence for V3 (adds quoteIds, timeline ids, relatedPlayers placeholder)
          const evidenceForV3 = normalizeEvidenceForV3(evidenceBundleRaw);

          setGenerationProgress(prev => prev ? { ...prev, step: `V3 Narrative Engine: building story for ${matchupLabel}...` } : null);
          const v3Narrative = await generateHeatArticleV3Narrative(pack, evidenceForV3);

          // Temperature Check (summary + small AI takeaways)
          setGenerationProgress(prev => prev ? { ...prev, step: `Temperature Check: assembling ${matchupLabel}...` } : null);
          const tempSummary = buildTemperatureCheckSummary(pack);
          let tempAI: any = null;
          try {
            tempAI = await generateTemperatureCheckV3AI(pack, evidenceForV3);
          } catch (e: any) {
            console.warn('[V3 TemperatureCheck] AI takeaways failed, proceeding with summary only:', e?.message || e);
            tempAI = { tempScore: 0, takeaways: [], risks: [], usedStatAnchors: [], usedQuoteIds: [], warnings: [`AI takeaways failed: ${e?.message || 'unknown error'}`] };
          }
          const tempRenderedMarkdown = buildTemperatureCheckRenderedMarkdown(pack, tempSummary, tempAI);

          // Render markdown article from V3 narrative JSON
          const v3Markdown = renderHeatArticleV3Markdown(v3Narrative, evidenceForV3);

          // Map narrative cards to existing narrative rack structure
          const cards = Array.isArray(v3Narrative?.narrativeCards) ? v3Narrative.narrativeCards : [];
          const primaryAngleId = v3Narrative?.selectedAngles?.primary?.id || cards?.[0]?.id || 'N_1';
          const candidateCards = cards.map((c: any) => ({
            narrative_id: String(c.id || ''),
            title: String(c.title || ''),
            claim: String(c.claim || ''),
            emotion_tags: Array.isArray(c.emotionTags) ? c.emotionTags : [],
            total_score: Number.isFinite(c.score) ? c.score : 0,
          }));

          // Build narratives container
          const narrativesForPost = {
            candidate_cards: candidateCards,
            selected: { primary_narrative_id: String(primaryAngleId) }
          };

          // Edge generation: use new 3-layer system for V3
          setGenerationProgress(prev => prev ? { ...prev, step: `Finding Edge candidates for ${matchupLabel}...` } : null);
          
          let heatChecksEdge: HeatchecksEdgeV2 = {
            game: { market: 'none', selection: 'none', line: null, price_american: null, book: null, confidence: 'low', receipts: ['', '', ''], risks: ['', ''], one_sentence_call: '' },
            player_props: [],
            no_edge_reason: null
          };

          try {
            let oddsData: { gameMarkets: any; playerProps: any } | null = null;

            // Determine sport based on league (same logic as Heat Picks)
            const league = matchup.league || '';
            const leagueUpper = league.toUpperCase();
            let sport = 'basketball_nba'; // default
            if (isSoccerLeague(league)) {
                if (leagueUpper === 'EPL' || leagueUpper === 'PREMIER LEAGUE') {
                    sport = 'soccer_epl';
                } else if (leagueUpper === 'BUNDESLIGA') {
                    sport = 'soccer_germany_bundesliga';
                } else if (leagueUpper === 'LA LIGA') {
                    sport = 'soccer_spain_la_liga';
                } else if (leagueUpper === 'SERIE A') {
                    sport = 'soccer_italy_serie_a';
                } else if (leagueUpper === 'LIGUE 1') {
                    sport = 'soccer_france_ligue_one';
                } else {
                    sport = 'soccer_germany_bundesliga'; // fallback for other soccer leagues
                }
            } else if (leagueUpper === 'NBA') {
                sport = 'basketball_nba';
            } else if (leagueUpper === 'NFL') {
                sport = 'americanfootball_nfl';
            }

            if (articleApiSource === 'gemini') {
              // Use Gemini to search for odds (no event ID needed)
              setGenerationProgress(prev => prev ? { ...prev, step: `Searching for odds using Gemini AI for ${matchupLabel}...` } : null);
              try {
                oddsData = await searchOddsWithGemini(pack, matchup.teamA, matchup.teamB, matchup.league, matchup.scheduledDate || pack?.matchup?.gameDateEst || null);
                console.log(`[V3 Edge] Fetched odds using Gemini for ${matchupLabel}`);
              } catch (geminiError: any) {
                console.warn(`[V3 Edge] Gemini odds search failed for ${matchupLabel}:`, geminiError.message || geminiError);
                // Fallback to TheOddsAPI if Gemini fails
                setGenerationProgress(prev => prev ? { ...prev, step: `Falling back to TheOddsAPI for ${matchupLabel}...` } : null);
                
                // Try to get event ID for fallback
                let eventId: string | null = null;
                if (factPack.odds?.event_id) {
                  eventId = factPack.odds.event_id;
                } else {
                  try {
                    // Normalize date to YYYY-MM-DD format for fallback
                    let gameDateForFallback: string | null = null;
                    const dateSource = matchup.scheduledDate || pack?.matchup?.gameDateEst || null;
                    if (dateSource) {
                      if (/^\d{4}-\d{2}-\d{2}$/.test(dateSource)) {
                        gameDateForFallback = dateSource;
                      } else {
                        try {
                          const date = new Date(dateSource);
                          if (!isNaN(date.getTime())) {
                            gameDateForFallback = date.toISOString().split('T')[0];
                          }
                        } catch (e) {
                          console.warn(`Could not parse date for fallback OddsAPI: ${dateSource}`, e);
                        }
                      }
                    }
                    const eventInfo = await apiClient.findOddsEventId(
                      matchup.teamA,
                      matchup.teamB,
                      gameDateForFallback,
                      sport
                    );
                    eventId = eventInfo.eventId;
                    console.log(`[V3 Edge] Found event ID for fallback: ${eventId} for ${matchupLabel}`);
                  } catch (findError: any) {
                    console.warn(`[V3 Edge] Could not find event ID for fallback:`, findError.message || findError);
                  }
                }

                if (eventId) {
                  oddsData = await apiClient.getOddsForGame(eventId, sport);
                  console.log(`[V3 Edge] Fallback to TheOddsAPI successful for ${matchupLabel}`);
                } else {
                  heatChecksEdge.no_edge_reason = `Gemini odds search failed and could not find OddsAPI event ID for fallback. ${geminiError.message || 'Unknown error'}`;
                  console.warn(`[V3 Edge] ${heatChecksEdge.no_edge_reason}`);
                }
              }
            } else {
              // Use TheOddsAPI - need to find event ID first
              let eventId: string | null = null;
              if (factPack.odds?.event_id) {
                eventId = factPack.odds.event_id;
              } else {
                // Try to find event ID by querying OddsAPI with team names and date
                setGenerationProgress(prev => prev ? { ...prev, step: `Finding OddsAPI event ID for ${matchupLabel}...` } : null);
                try {
                  // Normalize date to YYYY-MM-DD format
                  let gameDateForOdds: string | null = null;
                  if (matchup.scheduledDate) {
                    if (/^\d{4}-\d{2}-\d{2}$/.test(matchup.scheduledDate)) {
                      gameDateForOdds = matchup.scheduledDate;
                    } else {
                      try {
                        const date = new Date(matchup.scheduledDate);
                        if (!isNaN(date.getTime())) {
                          gameDateForOdds = date.toISOString().split('T')[0];
                        }
                      } catch (e) {
                        console.warn(`Could not parse scheduledDate for OddsAPI: ${matchup.scheduledDate}`, e);
                      }
                    }
                  } else if (pack?.matchup?.gameDateEst) {
                    // Normalize gameDateEst to YYYY-MM-DD
                    try {
                      const date = new Date(pack.matchup.gameDateEst);
                      if (!isNaN(date.getTime())) {
                        gameDateForOdds = date.toISOString().split('T')[0];
                      }
                    } catch (e) {
                      console.warn(`Could not parse gameDateEst for OddsAPI: ${pack.matchup.gameDateEst}`, e);
                    }
                  }
                  
                  console.log(`[V3 Edge] Searching OddsAPI for: ${matchup.teamA} vs ${matchup.teamB} on ${gameDateForOdds || 'any date'} (sport: ${sport})`);
                  const eventInfo = await apiClient.findOddsEventId(
                    matchup.teamA,
                    matchup.teamB,
                    gameDateForOdds,
                    sport
                  );
                  eventId = eventInfo.eventId;
                  console.log(`[V3 Edge] Found event ID: ${eventId} for ${matchupLabel}`);
                } catch (findError: any) {
                  const errorMessage = findError.message || String(findError);
                  const isQuotaError = errorMessage.includes('quota') || 
                                      errorMessage.includes('OUT_OF_USAGE_CREDITS') ||
                                      (findError as any)?.isQuotaError;
                  
                  if (isQuotaError) {
                    console.warn(`[V3 Edge] TheOddsAPI quota exceeded for ${matchupLabel}. Article will be created without Edge recommendations.`);
                    heatChecksEdge.no_edge_reason = `TheOddsAPI usage quota has been reached. Please upgrade your plan at https://the-odds-api.com or wait for quota reset.`;
                  } else {
                    console.warn(`[V3 Edge] Could not find event ID for ${matchupLabel}:`, errorMessage);
                    heatChecksEdge.no_edge_reason = `Could not find OddsAPI event ID for ${matchupLabel}. Team names may not match OddsAPI format, or game may not be available yet.`;
                  }
                  // Continue without event ID - will set no_edge_reason above
                }
              }

              if (eventId) {
                setGenerationProgress(prev => prev ? { ...prev, step: `Fetching odds from TheOddsAPI for ${matchupLabel}...` } : null);
                try {
                  oddsData = await apiClient.getOddsForGame(eventId, sport);
                  console.log(`[V3 Edge] Fetched odds using TheOddsAPI for ${matchupLabel}`);
                } catch (oddsError: any) {
                  const errorMessage = oddsError.message || String(oddsError);
                  const isQuotaError = errorMessage.includes('quota') || 
                                      errorMessage.includes('OUT_OF_USAGE_CREDITS') ||
                                      (oddsError as any)?.isQuotaError;
                  
                  if (isQuotaError) {
                    heatChecksEdge.no_edge_reason = `TheOddsAPI usage quota has been reached. Please upgrade your plan at https://the-odds-api.com or wait for quota reset.`;
                    console.warn(`[V3 Edge] TheOddsAPI quota exceeded for ${matchupLabel}`);
                  } else {
                    heatChecksEdge.no_edge_reason = `Failed to fetch odds from TheOddsAPI for ${matchupLabel}: ${errorMessage}`;
                    console.warn(`[V3 Edge] Failed to fetch odds:`, errorMessage);
                  }
                }
              }
              
              // If no_edge_reason is set but oddsData is null, log it
              if (heatChecksEdge.no_edge_reason && !oddsData) {
                console.warn(`[V3 Edge] ${heatChecksEdge.no_edge_reason}`);
              }
            }

            if (oddsData) {
              // Layer 1: Edge Finder
              setGenerationProgress(prev => prev ? { ...prev, step: `Scoring Edge candidates for ${matchupLabel}...` } : null);
              const candidates = await findEdgeCandidates(
                pack,
                oddsData.gameMarkets,
                oddsData.playerProps,
                matchup.teamA,
                matchup.teamB,
                matchup.league
              );

              // Layer 2: Edge Validator
              setGenerationProgress(prev => prev ? { ...prev, step: `Validating Edge candidates for ${matchupLabel}...` } : null);
              const validated = await validateEdgeCandidates(candidates, pack);

              // Layer 3: Edge Writer
              setGenerationProgress(prev => prev ? { ...prev, step: `Writing HeatChecks Edge for ${matchupLabel}...` } : null);
              heatChecksEdge = await generateHeatChecksEdgeV3(
                validated,
                pack,
                matchup.teamA,
                matchup.teamB,
                matchup.league
              );
            }
          } catch (edgeError: any) {
            console.error(`[V3 Edge] Error generating Edge for ${matchupLabel}:`, edgeError);
            // Don't fail completely - just set a reason
            heatChecksEdge.no_edge_reason = `Edge generation failed: ${edgeError.message || 'Unknown error'}. Article will be created without Edge recommendations.`;
          }

          const headline = v3Narrative?.deepDive?.headline || `${matchup.teamA} vs ${matchup.teamB} — HeatChecks V3`;
          const dek = v3Narrative?.narrativeThesis || `A story-first deep dive powered by local stats + evidence logs.`;

          const newDraftPost = await apiClient.createDraft({
            league: matchup.league,
            teamA: matchup.teamA,
            teamB: matchup.teamB,
            matchupScheduledDate: matchup.scheduledDate,
            storyType: 'heat_article_v3',
            scanNarrative: v3Narrative?.selectedAngles?.primary?.title || dek,
            websiteStory: {
              formatStyle: "QUOTE_LEDE",
              headline,
              dek,
              whyItMatters: [],
              theBackstory: v3Markdown,
              theData: [],
              keyMomentsTimeline: [],
              theReceipts: [],
              pressurePoints: [],
              whatToWatch: [],
              edgeAngle: dek,
              tags: ['HeatArticleV3', matchup.league],
              sources: [],
              seo: {
                slug: `${matchup.teamA}-vs-${matchup.teamB}-matchpack-v3`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
                metaTitle: `${headline} | HeatChecks`,
                metaDescription: dek
              },
              image: '',
              imageUrl: undefined
            },
            heatchecksEdge: heatChecksEdge,
            heatCheckData: {
              matchPackV3: pack,
              temperatureCheck: { summary: tempSummary, ai: tempAI, renderedMarkdown: tempRenderedMarkdown },
              v3Narrative,
              narratives: narrativesForPost,
              article: { long_form_markdown: v3Markdown, long_form_markdown_original: v3Markdown },
              // store evidence + odds for template + edge
              evidence_bundle: {
                sources: evidenceForV3.sources.map(s => ({
                  source_id: s.sourceId,
                  title: s.title || '',
                  publisher: s.publisher || '',
                  url: s.url || '',
                  published_utc: s.publishedUtc || '',
                  reliability_tier: s.reliabilityTier || ''
                })),
                quotes: evidenceForV3.quotes.map(q => ({
                  quote_id: q.quoteId,
                  quote: q.quote,
                  speaker: q.speaker || '',
                  team: q.team || '',
                  source_id: q.sourceId || '',
                  context: ''
                })),
                timeline_events: evidenceForV3.timeline.map(t => ({
                  event_id: t.eventId,
                  event_type: 'other',
                  date_utc: t.dateUtc || '',
                  summary: t.summary,
                  source_id: ''
                }))
              },
              fact_pack: factPack
            }
          });

          completed.push(matchupLabel);
          console.log(`✅ [${matchupLabel}] [${i + 1}/${selectedMatchups.length}] V3 MatchPack draft created: ${newDraftPost.id}`);
          setGenerationProgress(prev => prev ? { ...prev, step: `✅ Completed ${i + 1}/${selectedMatchups.length}: ${matchupLabel}` } : null);
        } catch (articleError: any) {
          const errorMessage = articleError.message || 'Unknown error';
          failed.push({ matchup: matchupLabel, error: errorMessage });
          console.error(`❌ [${matchupLabel}] [${i + 1}/${selectedMatchups.length}] Failed to generate V3 MatchPack draft:`, articleError);
          setGenerationProgress(prev => prev ? { ...prev, step: `❌ Failed ${i + 1}/${selectedMatchups.length}: ${matchupLabel} - ${errorMessage}` } : null);
          continue;
        }
      }

      setGenerationProgress({
        current: selectedMatchups.length,
        total: selectedMatchups.length,
        step: completed.length === selectedMatchups.length
          ? `✅ All ${completed.length} V3 pack(s) created successfully!`
          : `Completed ${completed.length}/${selectedMatchups.length} V3 pack(s). ${failed.length} failed.`,
        matchup: ''
      });

      console.log('=== HEAT ARTICLE V3 MATCHPACK SUMMARY ===');
      console.log(`✅ Completed: ${completed.length}`);
      completed.forEach((m, idx) => console.log(`  ${idx + 1}. ${m}`));
      if (failed.length > 0) {
        console.log(`❌ Failed: ${failed.length}`);
        failed.forEach((f, idx) => console.log(`  ${idx + 1}. ${f.matchup}: ${f.error}`));
      }
      console.log('========================================');

      setTimeout(() => {
        setGenerationProgress(null);
        setShowMatchupModal(false);
        setSelectedMatchupIds([]);
        setError(failed.length > 0 ? `Created ${completed.length} of ${selectedMatchups.length} V3 pack drafts. ${failed.length} failed. Check console for details.` : null);
      }, 2000);
    } catch (e: any) {
      console.error("Fatal error in V3 MatchPack generation:", e);
      setError(e.message || "V3 MatchPack generation failed. Check console for details.");
      setGenerationProgress(null);
    } finally {
      setIsGeneratingHeatArticleV3(false);
    }
  };

  const handleProcessHeatArticleV4 = async () => {
    if (selectedMatchupIds.length === 0) {
      setError("Please select at least one matchup.");
      return;
    }

    setIsGeneratingHeatArticleV4(true);
    setError(null);

    const selectedMatchups = filteredMatchups.filter(m => selectedMatchupIds.includes(m.id));
    const completed: string[] = [];
    const failed: Array<{ matchup: string; error: string }> = [];

    try {
      for (let i = 0; i < selectedMatchups.length; i++) {
        const matchup = selectedMatchups[i];
        const matchupLabel = `${matchup.teamA} vs ${matchup.teamB}`;

        setGenerationProgress({
          current: i + 1,
          total: selectedMatchups.length,
          step: `Fetching MatchPackV4 for ${matchupLabel}...`,
          matchup: matchupLabel
        });

        try {
          // Normalize scheduledDate to YYYY-MM-DD format
          let normalizedDate: string | null = null;
          if (matchup.scheduledDate) {
            // If it's already in YYYY-MM-DD format, use it
            if (/^\d{4}-\d{2}-\d{2}$/.test(matchup.scheduledDate)) {
              normalizedDate = matchup.scheduledDate;
            } else {
              // Try to parse and format it
              try {
                const date = new Date(matchup.scheduledDate);
                if (!isNaN(date.getTime())) {
                  const year = date.getFullYear();
                  const month = String(date.getMonth() + 1).padStart(2, '0');
                  const day = String(date.getDate()).padStart(2, '0');
                  normalizedDate = `${year}-${month}-${day}`;
                }
              } catch (e) {
                console.warn(`Could not parse scheduledDate: ${matchup.scheduledDate}`, e);
              }
            }
          }
          
          // V4 only supports NBA - verify league
          const league = matchup.league || '';
          if (league.toUpperCase() !== 'NBA') {
            throw new Error(`V4 only supports NBA matchups. Found: ${league}`);
          }
          
          console.log(`[V4] Fetching MatchPackV4 for ${matchupLabel}...`);
          
          const { pack } = await apiClient.getMatchPackV4(
            matchup.teamA,
            matchup.teamB,
            normalizedDate,
            null
          );

          if (!pack) throw new Error('MatchPackV4 returned null pack');
          if (pack.error) throw new Error(`${pack.error}: ${pack.message || 'MatchPack generation failed'}`);
          
          console.log(`[V4] MatchPackV4 received for ${matchupLabel}:`, {
            hasFactDrop: !!pack.factDrop,
            hasAdvancedHeatStats: !!pack.factDrop?.raw?.advancedHeatStats,
            hasCharts: !!pack.factDrop?.charts,
            hasMatchup: !!pack.matchup,
            source: pack.source || 'unknown'
          });

          setGenerationProgress(prev => prev ? { ...prev, step: `Researching evidence + odds for ${matchupLabel}...` } : null);
          const v2Research = await generateHeatCheckNarrativeV2(matchup);
          const factPack = v2Research.fact_pack || {};
          const evidenceBundleRaw = v2Research.evidence_bundle || {};

          // Normalize evidence for V3 (adds quoteIds, timeline ids, relatedPlayers placeholder)
          const evidenceForV3 = normalizeEvidenceForV3(evidenceBundleRaw);

          setGenerationProgress(prev => prev ? { ...prev, step: `V3 Narrative Engine: building story for ${matchupLabel}...` } : null);
          const v3Narrative = await generateHeatArticleV3Narrative(pack, evidenceForV3);

          // Temperature Check (summary + small AI takeaways)
          setGenerationProgress(prev => prev ? { ...prev, step: `Temperature Check: assembling ${matchupLabel}...` } : null);
          const tempSummary = buildTemperatureCheckSummary(pack);
          let tempAI: any = null;
          try {
            tempAI = await generateTemperatureCheckV3AI(pack, evidenceForV3);
          } catch (e: any) {
            console.warn('[V4 TemperatureCheck] AI takeaways failed, proceeding with summary only:', e?.message || e);
            tempAI = { tempScore: 0, takeaways: [], risks: [], usedStatAnchors: [], usedQuoteIds: [], warnings: [`AI takeaways failed: ${e?.message || 'unknown error'}`] };
          }
          const tempRenderedMarkdown = buildTemperatureCheckRenderedMarkdown(pack, tempSummary, tempAI);

          // Render markdown article from V3 narrative JSON
          const v3Markdown = renderHeatArticleV3Markdown(v3Narrative, evidenceForV3);

          // Map narrative cards to existing narrative rack structure
          const cards = Array.isArray(v3Narrative?.narrativeCards) ? v3Narrative.narrativeCards : [];
          const primaryAngleId = v3Narrative?.selectedAngles?.primary?.id || cards?.[0]?.id || 'N_1';
          const candidateCards = cards.map((c: any) => ({
            narrative_id: String(c.id || ''),
            title: String(c.title || ''),
            claim: String(c.claim || ''),
            emotion_tags: Array.isArray(c.emotionTags) ? c.emotionTags : [],
            total_score: Number.isFinite(c.score) ? c.score : 0,
          }));

          // Build narratives container
          const narrativesForPost = {
            candidate_cards: candidateCards,
            selected: { primary_narrative_id: String(primaryAngleId) }
          };

          // Edge generation: use new 3-layer system for V3
          setGenerationProgress(prev => prev ? { ...prev, step: `Finding Edge candidates for ${matchupLabel}...` } : null);
          
          let heatChecksEdge: HeatchecksEdgeV2 = {
            game: { market: 'none', selection: 'none', line: null, price_american: null, book: null, confidence: 'low', receipts: ['', '', ''], risks: ['', ''], one_sentence_call: '' },
            player_props: [],
            no_edge_reason: null
          };

          try {
            let oddsData: { gameMarkets: any; playerProps: any } | null = null;

            // Determine sport based on league (NBA for V4)
            const leagueUpper = league.toUpperCase();
            let sport = 'basketball_nba';
            if (leagueUpper === 'NBA') {
              sport = 'basketball_nba';
            }

            if (articleApiSource === 'gemini') {
              // Use Gemini to search for odds (no event ID needed)
              setGenerationProgress(prev => prev ? { ...prev, step: `Searching for odds using Gemini AI for ${matchupLabel}...` } : null);
              try {
                oddsData = await searchOddsWithGemini(pack, matchup.teamA, matchup.teamB, matchup.league, matchup.scheduledDate || pack?.matchup?.gameDateEst || null);
                console.log(`[V4 Edge] Fetched odds using Gemini for ${matchupLabel}`);
              } catch (geminiError: any) {
                console.warn(`[V4 Edge] Gemini odds search failed for ${matchupLabel}:`, geminiError.message || geminiError);
                // Fallback to TheOddsAPI if Gemini fails
                setGenerationProgress(prev => prev ? { ...prev, step: `Falling back to TheOddsAPI for ${matchupLabel}...` } : null);
                
                // Try to get event ID for fallback
                let eventId: string | null = null;
                if (factPack.odds?.event_id) {
                  eventId = factPack.odds.event_id;
                } else {
                  try {
                    // Normalize date to YYYY-MM-DD format for fallback
                    let gameDateForFallback: string | null = null;
                    const dateSource = matchup.scheduledDate || pack?.matchup?.gameDateEst || null;
                    if (dateSource) {
                      if (/^\d{4}-\d{2}-\d{2}$/.test(dateSource)) {
                        gameDateForFallback = dateSource;
                      } else {
                        try {
                          const date = new Date(dateSource);
                          if (!isNaN(date.getTime())) {
                            gameDateForFallback = date.toISOString().split('T')[0];
                          }
                        } catch (e) {
                          console.warn(`Could not parse date for fallback OddsAPI: ${dateSource}`, e);
                        }
                      }
                    }
                    const eventInfo = await apiClient.findOddsEventId(
                      matchup.teamA,
                      matchup.teamB,
                      gameDateForFallback,
                      sport
                    );
                    eventId = eventInfo.eventId;
                    console.log(`[V4 Edge] Found event ID for fallback: ${eventId} for ${matchupLabel}`);
                  } catch (findError: any) {
                    console.warn(`[V4 Edge] Could not find event ID for fallback:`, findError.message || findError);
                  }
                }

                if (eventId) {
                  oddsData = await apiClient.getOddsForGame(eventId, sport);
                  console.log(`[V4 Edge] Fallback to TheOddsAPI successful for ${matchupLabel}`);
                } else {
                  heatChecksEdge.no_edge_reason = `Gemini odds search failed and could not find OddsAPI event ID for fallback. ${geminiError.message || 'Unknown error'}`;
                  console.warn(`[V4 Edge] ${heatChecksEdge.no_edge_reason}`);
                }
              }
            } else {
              // Use TheOddsAPI - need to find event ID first
              let eventId: string | null = null;
              if (factPack.odds?.event_id) {
                eventId = factPack.odds.event_id;
              } else {
                // Try to find event ID by querying OddsAPI with team names and date
                setGenerationProgress(prev => prev ? { ...prev, step: `Finding OddsAPI event ID for ${matchupLabel}...` } : null);
                try {
                  // Normalize date to YYYY-MM-DD format
                  let gameDateForOdds: string | null = null;
                  if (matchup.scheduledDate) {
                    if (/^\d{4}-\d{2}-\d{2}$/.test(matchup.scheduledDate)) {
                      gameDateForOdds = matchup.scheduledDate;
                    } else {
                      try {
                        const date = new Date(matchup.scheduledDate);
                        if (!isNaN(date.getTime())) {
                          gameDateForOdds = date.toISOString().split('T')[0];
                        }
                      } catch (e) {
                        console.warn(`Could not parse scheduledDate for OddsAPI: ${matchup.scheduledDate}`, e);
                      }
                    }
                  } else if (pack?.matchup?.gameDateEst) {
                    // Normalize gameDateEst to YYYY-MM-DD
                    try {
                      const date = new Date(pack.matchup.gameDateEst);
                      if (!isNaN(date.getTime())) {
                        gameDateForOdds = date.toISOString().split('T')[0];
                      }
                    } catch (e) {
                      console.warn(`Could not parse gameDateEst for OddsAPI: ${pack.matchup.gameDateEst}`, e);
                    }
                  }
                  
                  console.log(`[V4 Edge] Searching OddsAPI for: ${matchup.teamA} vs ${matchup.teamB} on ${gameDateForOdds || 'any date'} (sport: ${sport})`);
                  const eventInfo = await apiClient.findOddsEventId(
                    matchup.teamA,
                    matchup.teamB,
                    gameDateForOdds,
                    sport
                  );
                  eventId = eventInfo.eventId;
                  console.log(`[V4 Edge] Found event ID: ${eventId} for ${matchupLabel}`);
                } catch (findError: any) {
                  const errorMessage = findError.message || String(findError);
                  const isQuotaError = errorMessage.includes('quota') || 
                                      errorMessage.includes('OUT_OF_USAGE_CREDITS') ||
                                      (findError as any)?.isQuotaError;
                  
                  if (isQuotaError) {
                    console.warn(`[V4 Edge] TheOddsAPI quota exceeded for ${matchupLabel}. Article will be created without Edge recommendations.`);
                    heatChecksEdge.no_edge_reason = `TheOddsAPI usage quota has been reached. Please upgrade your plan at https://the-odds-api.com or wait for quota reset.`;
                  } else {
                    console.warn(`[V4 Edge] Could not find event ID for ${matchupLabel}:`, errorMessage);
                    heatChecksEdge.no_edge_reason = `Could not find OddsAPI event ID for ${matchupLabel}. Team names may not match OddsAPI format, or game may not be available yet.`;
                  }
                  // Continue without event ID - will set no_edge_reason above
                }
              }

              if (eventId) {
                setGenerationProgress(prev => prev ? { ...prev, step: `Fetching odds from TheOddsAPI for ${matchupLabel}...` } : null);
                try {
                  oddsData = await apiClient.getOddsForGame(eventId, sport);
                  console.log(`[V4 Edge] Fetched odds using TheOddsAPI for ${matchupLabel}`);
                } catch (oddsError: any) {
                  const errorMessage = oddsError.message || String(oddsError);
                  const isQuotaError = errorMessage.includes('quota') || 
                                      errorMessage.includes('OUT_OF_USAGE_CREDITS') ||
                                      (oddsError as any)?.isQuotaError;
                  
                  if (isQuotaError) {
                    heatChecksEdge.no_edge_reason = `TheOddsAPI usage quota has been reached. Please upgrade your plan at https://the-odds-api.com or wait for quota reset.`;
                    console.warn(`[V4 Edge] TheOddsAPI quota exceeded for ${matchupLabel}`);
                  } else {
                    heatChecksEdge.no_edge_reason = `Failed to fetch odds from TheOddsAPI for ${matchupLabel}: ${errorMessage}`;
                    console.warn(`[V4 Edge] Failed to fetch odds:`, errorMessage);
                  }
                }
              }
              
              // If no_edge_reason is set but oddsData is null, log it
              if (heatChecksEdge.no_edge_reason && !oddsData) {
                console.warn(`[V4 Edge] ${heatChecksEdge.no_edge_reason}`);
              }
            }

            if (oddsData) {
              // Layer 1: Edge Finder
              setGenerationProgress(prev => prev ? { ...prev, step: `Scoring Edge candidates for ${matchupLabel}...` } : null);
              const candidates = await findEdgeCandidates(
                pack,
                oddsData.gameMarkets,
                oddsData.playerProps,
                matchup.teamA,
                matchup.teamB,
                matchup.league
              );

              // Layer 2: Edge Validator
              setGenerationProgress(prev => prev ? { ...prev, step: `Validating Edge candidates for ${matchupLabel}...` } : null);
              const validated = await validateEdgeCandidates(candidates, pack);

              // Layer 3: Edge Writer
              setGenerationProgress(prev => prev ? { ...prev, step: `Writing HeatChecks Edge for ${matchupLabel}...` } : null);
              heatChecksEdge = await generateHeatChecksEdgeV3(
                validated,
                pack,
                matchup.teamA,
                matchup.teamB,
                matchup.league
              );
            }
          } catch (edgeError: any) {
            console.error(`[V4 Edge] Error generating Edge for ${matchupLabel}:`, edgeError);
            // Don't fail completely - just set a reason
            heatChecksEdge.no_edge_reason = `Edge generation failed: ${edgeError.message || 'Unknown error'}. Article will be created without Edge recommendations.`;
          }

          const headline = v3Narrative?.deepDive?.headline || `${matchup.teamA} vs ${matchup.teamB} — HeatChecks V4`;
          const dek = v3Narrative?.narrativeThesis || `A story-first deep dive powered by local stats + evidence logs.`;

          const newDraftPost = await apiClient.createDraft({
            league: matchup.league,
            teamA: matchup.teamA,
            teamB: matchup.teamB,
            matchupScheduledDate: matchup.scheduledDate,
            storyType: 'heat_article_v3', // Same as V3 for compatibility
            scanNarrative: v3Narrative?.selectedAngles?.primary?.title || dek,
            websiteStory: {
              formatStyle: "QUOTE_LEDE",
              headline,
              dek,
              whyItMatters: [],
              theBackstory: v3Markdown,
              theData: [],
              keyMomentsTimeline: [],
              theReceipts: [],
              pressurePoints: [],
              whatToWatch: [],
              edgeAngle: dek,
              tags: ['HeatArticleV4', matchup.league],
              sources: [],
              seo: {
                slug: `${matchup.teamA}-vs-${matchup.teamB}-matchpack-v4`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
                metaTitle: `${headline} | HeatChecks`,
                metaDescription: dek
              },
              image: '',
              imageUrl: undefined
            },
            heatchecksEdge: heatChecksEdge,
            heatCheckData: {
              matchPackV4: pack, // Store as matchPackV4 to distinguish from V3
              temperatureCheck: { summary: tempSummary, ai: tempAI, renderedMarkdown: tempRenderedMarkdown },
              v3Narrative,
              narratives: narrativesForPost,
              article: { long_form_markdown: v3Markdown, long_form_markdown_original: v3Markdown },
              // store evidence + odds for template + edge
              evidence_bundle: {
                sources: evidenceForV3.sources.map(s => ({
                  source_id: s.sourceId,
                  title: s.title || '',
                  publisher: s.publisher || '',
                  url: s.url || '',
                  published_utc: s.publishedUtc || '',
                  reliability_tier: s.reliabilityTier || ''
                })),
                quotes: evidenceForV3.quotes.map(q => ({
                  quote_id: q.quoteId,
                  quote: q.quote,
                  speaker: q.speaker || '',
                  team: q.team || '',
                  source_id: q.sourceId || '',
                  context: ''
                })),
                timeline_events: evidenceForV3.timeline.map(t => ({
                  event_id: t.eventId,
                  event_type: 'other',
                  date_utc: t.dateUtc || '',
                  summary: t.summary,
                  source_id: ''
                }))
              },
              fact_pack: factPack
            }
          });

          completed.push(matchupLabel);
          console.log(`✅ [${matchupLabel}] [${i + 1}/${selectedMatchups.length}] V4 MatchPack draft created: ${newDraftPost.id}`);
          setGenerationProgress(prev => prev ? { ...prev, step: `✅ Completed ${i + 1}/${selectedMatchups.length}: ${matchupLabel}` } : null);
        } catch (articleError: any) {
          const errorMessage = articleError.message || 'Unknown error';
          failed.push({ matchup: matchupLabel, error: errorMessage });
          console.error(`❌ [${matchupLabel}] [${i + 1}/${selectedMatchups.length}] Failed to generate V4 MatchPack draft:`, articleError);
          setGenerationProgress(prev => prev ? { ...prev, step: `❌ Failed ${i + 1}/${selectedMatchups.length}: ${matchupLabel} - ${errorMessage}` } : null);
          continue;
        }
      }

      setGenerationProgress({
        current: selectedMatchups.length,
        total: selectedMatchups.length,
        step: completed.length === selectedMatchups.length
          ? `✅ All ${completed.length} V4 pack(s) created successfully!`
          : `Completed ${completed.length}/${selectedMatchups.length} V4 pack(s). ${failed.length} failed.`,
        matchup: ''
      });

      // Log final summary
      console.log('=== HEAT ARTICLE V4 GENERATION SUMMARY ===');
      console.log(`Total matchups: ${selectedMatchups.length}`);
      console.log(`✅ Completed: ${completed.length}`);
      completed.forEach((matchup, idx) => {
        console.log(`  ${idx + 1}. ${matchup}`);
      });
      if (failed.length > 0) {
        console.log(`❌ Failed: ${failed.length}`);
        failed.forEach((failure, idx) => {
          console.log(`  ${idx + 1}. ${failure.matchup}: ${failure.error}`);
        });
      }
      console.log('========================================');

      // Wait a moment to show completion message, then close modal
      setTimeout(() => {
        setGenerationProgress(null);
        setShowMatchupModal(false);
        setSelectedMatchupIds([]);
        
        // Show success/error message
        if (completed.length === selectedMatchups.length) {
          setError(null); // Clear any previous errors
          console.log('All V4 articles generated successfully. Access them in the Content Feed tab.');
        } else {
          setError(`Generated ${completed.length} of ${selectedMatchups.length} V4 articles. ${failed.length} failed. Check console for details.`);
        }
      }, 2000); // 2 second delay to show completion message
      
    } catch (e: any) {
      console.error("Fatal error in V4 heat article generation:", e);
      setError(e.message || "V4 Article generation failed. Check console for details.");
      setGenerationProgress(null);
      // Keep modal open on error so user can see the error
    } finally {
      setIsGeneratingHeatArticleV4(false);
    }
  };

  const handleGenerateDFSArticle = async (file: File) => {
    setIsGeneratingDFSArticle(true);
    setError(null);

    try {
      // Parse Excel/CSV file
      const rawData = await parseExcelFile(file);
      const slicedData = rawData.slice(0, 150); // Limit to 150 players
      
      // Transform CSV data to normalized format for AI
      const normalizedData = slicedData.map((row: any) => {
        // Extract opponent from Game Info (format: "SF@PHI 01/11/2026 04:30PM ET")
        let opponent = '';
        const gameInfo = row['Game Info'] || row['GameInfo'] || '';
        const teamAbbrev = row['TeamAbbrev'] || row['Team'] || '';
        
        if (gameInfo && teamAbbrev) {
          // Game Info format: "SF@PHI 01/11/2026 04:30PM ET" or "BUF@JAX 01/11/2026 01:00PM ET"
          const matchupMatch = gameInfo.match(/^([A-Z]+)@([A-Z]+)/);
          if (matchupMatch) {
            const [, awayTeam, homeTeam] = matchupMatch;
            // If player's team is the away team, opponent is home team, and vice versa
            opponent = teamAbbrev === awayTeam ? homeTeam : awayTeam;
          }
        }
        
        return {
          playerName: row['Name'] || row['Player Name'] || row['name'] || '',
          position: row['Position'] || row['position'] || '',
          team: teamAbbrev || row['Team'] || '',
          opponent: opponent || row['Opponent'] || row['opponent'] || '',
          salary: row['Salary'] || row['salary'] || row['Salary'] || 0,
          avgPoints: row['AvgPointsPerGame'] || row['Avg Points Per Game'] || row['avgPoints'] || 0
        };
      }).filter((player: any) => player.playerName && player.position); // Filter out invalid rows
      
      const jsonString = JSON.stringify(normalizedData);

      // Analyze slate with AI
      let playerAnalyses = await analyzeDFSSlate(jsonString, dfsSport);

      if (playerAnalyses.length === 0) {
        throw new Error("No players found in analysis. Please check your Excel file format.");
      }

      // Use top 10 players from analysis (no validation)
      const REQUIRED_PLAYER_COUNT = 10;
      if (playerAnalyses.length > REQUIRED_PLAYER_COUNT) {
        playerAnalyses = playerAnalyses.slice(0, REQUIRED_PLAYER_COUNT);
      }
      
      console.log(`✅ Generated ${playerAnalyses.length} players for article`);

      // Generate article content from top 10 players
      const today = new Date();
      const dateStr = today.toISOString().split('T')[0]; // YYYY-MM-DD format
      // Use the dateStr to calculate day of week to ensure consistency
      const dateForDayOfWeek = new Date(dateStr + 'T12:00:00'); // Use noon to avoid timezone issues
      const dayOfWeek = dateForDayOfWeek.toLocaleDateString('en-US', { weekday: 'long' }); // e.g., "Monday"
      
      const headline = `${dayOfWeek} ${dfsSport} DFS`;
      const dek = `Top 10 value plays with narrative angles for today's ${dfsSport} slate`;

      // Generate markdown article content
      let articleMarkdown = `# ${headline}\n\n${dek}\n\n`;
      articleMarkdown += `## Top Value Plays\n\n`;

      playerAnalyses.forEach((player, index) => {
        articleMarkdown += `### ${index + 1}. ${player.playerName} (${player.position}) - ${player.team} vs ${player.opponent}\n\n`;
        articleMarkdown += `**Salary:** $${player.salary} | **Confidence:** ${player.confidenceScore}% | **Narrative:** ${player.narrativeType}\n\n`;
        if (player.keyStat) {
          articleMarkdown += `**Key Stat:** ${player.keyStat}\n\n`;
        }
        articleMarkdown += `${player.analysis}\n\n`;
        articleMarkdown += `---\n\n`;
      });

      // Generate SEO slug
      const slug = `dfs-value-narratives-${dateStr}`;

      // Create draft post (DFS articles don't use HeatChecks Edge)
      const newDraftPost = await apiClient.createDraft({
        league: dfsSport,
        teamA: '', // DFS articles don't have specific matchups
        teamB: '',
        matchupScheduledDate: dateStr,
        storyType: 'dfs_article',
        scanNarrative: dek, // Use dek as scanNarrative for DFS articles
        websiteStory: {
          formatStyle: "QUOTE_LEDE",
          headline: headline,
          dek: dek,
          whyItMatters: [],
          theBackstory: articleMarkdown,
          theData: [],
          keyMomentsTimeline: [],
          theReceipts: [],
          pressurePoints: [],
          whatToWatch: [],
          edgeAngle: dek,
          tags: ['DFS', dfsSport, 'Value Plays', 'Narratives'],
          sources: [],
          seo: {
            slug: slug,
            metaTitle: `${headline} | HeatChecks`,
            metaDescription: dek
          },
          image: '',
          imageUrl: undefined
        },
        heatchecksEdge: undefined, // DFS articles don't use HeatChecks Edge
        heatCheckData: {
          dfsPlayers: playerAnalyses,
          article: {
            long_form_markdown: articleMarkdown
          }
        }
      });

      console.log('[DFS Article Generation] Backend returned post:', {
        id: newDraftPost.id,
        league: newDraftPost.league,
        storyType: newDraftPost.storyType
      });

      // Open post in editor (no validation)
      setEditingPost(newDraftPost);

      setShowDFSModal(false);
    } catch (e: any) {
      console.error("Failed to generate DFS article:", e);
      setError(e.message || "DFS article generation failed. Please check the console for details.");
    } finally {
      setIsGeneratingDFSArticle(false);
    }
  };

  const handleGenerateHeatPicks = async () => {
    setIsGeneratingHeatPicks(true);
    setError(null);

    try {
      if (!heatPicksDate || !heatPicksLeague) {
        throw new Error('Please select both date and league');
      }

      // Fetch published posts for the selected date and league
      const posts = await apiClient.getPublishedPostsByDateLeague(heatPicksDate, heatPicksLeague);
      
      if (posts.length === 0) {
        throw new Error(`No published articles found for ${heatPicksLeague} on ${heatPicksDate}`);
      }

      console.log(`[Heat Picks] Found ${posts.length} published posts for ${heatPicksLeague} on ${heatPicksDate}`);

      // Step 1: Compute classifications for each matchup
      const classifiedMatchups: ClassifiedMatchup[] = [];
      const noHeatMatchups: Array<{ matchup: string; whyNot: string }> = [];

      for (const post of posts) {
        if (!post.heatCheckData?.matchPackV3) {
          console.warn(`[Heat Picks] Post ${post.id} missing matchPackV3, skipping`);
          continue;
        }

        // Try to fetch odds
        let oddsData: any = null;
        try {
          // Map league to TheOddsAPI sport key
          const leagueUpper = heatPicksLeague.toUpperCase();
          let sport = 'basketball_nba'; // default
          if (isSoccerLeague(heatPicksLeague)) {
            if (leagueUpper === 'EPL' || leagueUpper === 'PREMIER LEAGUE') {
              sport = 'soccer_epl';
            } else if (leagueUpper === 'BUNDESLIGA') {
              sport = 'soccer_germany_bundesliga';
            } else if (leagueUpper === 'LA LIGA') {
              sport = 'soccer_spain_la_liga';
            } else if (leagueUpper === 'SERIE A') {
              sport = 'soccer_italy_serie_a';
            } else if (leagueUpper === 'LIGUE 1') {
              sport = 'soccer_france_ligue_1';
            } else {
              sport = 'soccer_germany_bundesliga'; // fallback for other soccer leagues
            }
          } else if (leagueUpper === 'NBA') {
            sport = 'basketball_nba';
          } else if (leagueUpper === 'NFL') {
            sport = 'americanfootball_nfl';
          }
          
          const eventIdResult = await apiClient.findOddsEventId(
            post.teamA || '',
            post.teamB || '',
            heatPicksDate,
            sport
          );
          
          if (eventIdResult?.eventId) {
            oddsData = await apiClient.getOddsForGame(eventIdResult.eventId, sport);
          }
        } catch (oddsError: any) {
          console.warn(`[Heat Picks] Could not fetch odds for ${post.teamA} vs ${post.teamB}:`, oddsError.message);
          // Continue without odds
        }

        const classified = await computeHeatPicksClassification(post, oddsData);
        
        if (!classified) {
          noHeatMatchups.push({
            matchup: `${post.teamA} @ ${post.teamB}`,
            whyNot: 'Missing matchPackV3 data'
          });
          continue;
        }

        if (classified.classification === 'NO_HEAT') {
          noHeatMatchups.push({
            matchup: classified.matchup,
            whyNot: `HeatScore ${classified.heatScore} below threshold or market already priced in`
          });
        } else {
          classifiedMatchups.push(classified);
        }
      }

      // Sort by heatScore (highest first) and limit to max 5 picks
      classifiedMatchups.sort((a, b) => b.heatScore - a.heatScore);
      const heatPicks = classifiedMatchups.filter(c => c.classification === 'HEAT_PICK').slice(0, 5);
      const warmLeans = classifiedMatchups.filter(c => c.classification === 'WARM_LEAN').slice(0, 3);

      // Step 2: Render with LLM
      const heatPicksRendered = await Promise.all(
        heatPicks.map(async (classified) => {
          const rendered = await renderHeatPicksWithLLM(classified, posts.find(p => p.teamA === classified.teamA && p.teamB === classified.teamB)?.heatCheckData?.narratives?.candidate_cards);
          return {
            matchup: classified.matchup,
            pickType: classified.pickType || 'moneyline',
            pick: classified.pick || classified.teamA,
            heatScore: classified.heatScore,
            signalsHit: classified.signalsHit.map(s => ({
              signalKey: s.signalKey,
              evidence: s.evidence
            })),
            narrativesUsed: rendered.narrativesUsed,
            marketLag: rendered.marketLag,
            evidenceChart: classified.evidenceChart,
            whyHot: rendered.whyHot,
            riskNote: rendered.riskNote,
            chartCaption: rendered.chartCaption
          };
        })
      );

      const warmLeansRendered = await Promise.all(
        warmLeans.map(async (classified) => {
          const rendered = await renderHeatPicksWithLLM(classified, posts.find(p => p.teamA === classified.teamA && p.teamB === classified.teamB)?.heatCheckData?.narratives?.candidate_cards);
          return {
            matchup: classified.matchup,
            pickType: classified.pickType || 'moneyline',
            pick: classified.pick || classified.teamA,
            heatScore: classified.heatScore,
            signalsHit: classified.signalsHit.map(s => ({
              signalKey: s.signalKey,
              evidence: s.evidence
            })),
            narrativesUsed: rendered.narrativesUsed,
            marketLag: rendered.marketLag,
            evidenceChart: classified.evidenceChart,
            whyHot: rendered.whyHot,
            riskNote: rendered.riskNote,
            chartCaption: rendered.chartCaption
          };
        })
      );

      const noHeatZoneRendered = await Promise.all(
        noHeatMatchups.map(async (item) => {
          // Simple LLM explanation for why not
          try {
            const response = await ai.models.generateContent({
              model: 'gemini-2.5-pro',
              contents: `Explain in one sentence why this matchup is in the No-Heat Zone: ${item.matchup}. Reason: ${item.whyNot}`,
              config: {
                responseSchema: {
                  type: Type.OBJECT,
                  properties: {
                    whyNot: { type: Type.STRING }
                  },
                  required: ['whyNot']
                }
              }
            });
            const result = extractJson(response.text);
            return {
              matchup: item.matchup,
              whyNot: result.whyNot || item.whyNot
            };
          } catch {
            return item;
          }
        })
      );

      // Generate final JSON structure
      const heatPicksJson = {
        date: heatPicksDate,
        sport: heatPicksLeague,
        heatPicks: heatPicksRendered,
        warmLeans: warmLeansRendered,
        noHeatZone: noHeatZoneRendered
      };

      // Generate chart catalog for all matchups
      const allChartCatalogs: Record<string, any[]> = {};
      posts.forEach(post => {
        if (post.heatCheckData?.matchPackV3) {
          const key = `${post.teamA}-${post.teamB}`;
          allChartCatalogs[key] = generateChartCatalog(post.heatCheckData.matchPackV3);
        }
      });

      // Format date for slug (MM-DD-YYYY)
      const dateParts = heatPicksDate.split('-');
      const slugDate = `${dateParts[1]}-${dateParts[2]}-${dateParts[0]}`;
      const leagueLower = heatPicksLeague.toLowerCase();
      const slug = `${leagueLower}-heat-picks-today-${slugDate}`;

      // Create draft post
      const newDraftPost = await apiClient.createDraft({
        league: heatPicksLeague,
        teamA: 'Multiple',
        teamB: '',
        matchupScheduledDate: heatPicksDate,
        storyType: 'heat_picks',
        scanNarrative: `Heat Picks for ${heatPicksLeague} on ${heatPicksDate}`,
        websiteStory: {
          formatStyle: 'QUOTE_LEDE',
          headline: `Heat Picks Today — Pressure-Based Picks Backed by Data`,
          dek: `The games where momentum, narrative pressure, and market lag intersect — with one chart of proof per pick.`,
          whyItMatters: [],
          theBackstory: JSON.stringify(heatPicksJson, null, 2),
          theData: [],
          keyMomentsTimeline: [],
          theReceipts: [],
          pressurePoints: [],
          whatToWatch: [],
          edgeAngle: `Heat Picks for ${heatPicksLeague} on ${heatPicksDate}`,
          tags: ['Heat Picks', heatPicksLeague],
          sources: [],
          seo: {
            slug: slug,
            metaTitle: `Heat Picks Today — ${heatPicksLeague} | HeatChecks`,
            metaDescription: `Pressure-based picks backed by data for ${heatPicksLeague} on ${heatPicksDate}`
          },
          image: '',
          imageUrl: undefined
        },
        heatchecksEdge: undefined,
        heatCheckData: {
          heatPicks: heatPicksJson,
          chartCatalog: allChartCatalogs,
          matchPacks: posts.map(p => ({
            teamA: p.teamA,
            teamB: p.teamB,
            matchPackV3: p.heatCheckData?.matchPackV3
          }))
        }
      });

      console.log('[Heat Picks] Created draft post:', newDraftPost.id);
      
      // Open post in editor
      setEditingPost(newDraftPost);
      setShowHeatPicksModal(false);
    } catch (e: any) {
      console.error("Failed to generate Heat Picks:", e);
      setError(e.message || "Heat Picks generation failed. Please check the console for details.");
    } finally {
      setIsGeneratingHeatPicks(false);
    }
  };
    
  const renderContent = () => {
    if (isLoading) return <div className="loader">{loadingMessage}</div>;
    if (error && narratives.length === 0) return <div className="error">{error}</div>;
    if (narratives.length > 0) {
      return (
        <div className="results-grid">
          {narratives.map((item) => {
            const cardKey = `${item.league}-${item.teamA}-${item.teamB}`;
            const state = cardState[cardKey] || {};
            return (
                <div className="card" key={cardKey}>
                    <div className="card-header"><h2>{item.teamA} vs. {item.teamB}</h2><span className="league">{item.league}</span></div>
                    <div className="card-body"><span className="story-type">{item.storyType}</span><p>{item.narrative}</p></div>
                    <div className="card-actions">
                        <button className="action-button" onClick={() => handleReadyForWebsite(item)} disabled={state.isProcessing || state.isGeneratingTweet}>{state.isProcessing ? 'Processing...' : 'Ready for Website'}</button>
                        <button className="tweet-button" onClick={() => handleGenerateTweet(item)} disabled={state.isProcessing || state.isGeneratingTweet}>{state.isGeneratingTweet ? 'Generating...' : 'Generate Tweet'}</button>
                    </div>
                    {state.isProcessing && <div className="loader" style={{fontSize: '1rem', marginTop: '1rem'}}>Performing deep research...</div>}
                    {state.isGeneratingTweet && <div className="loader" style={{fontSize: '1rem', marginTop: '1rem'}}>Generating tweet thread...</div>}
                    {state.error && <div className="error" style={{marginTop: '1rem'}}>{state.error}</div>}
                    {state.generatedTweet && (
                        <div className="tweet-container">
                             <div className="tweet-box">
                                <div className="tweet-container-header"><h4>Tweet 1 of 2</h4><button className="copy-button" onClick={() => navigator.clipboard.writeText(state.generatedTweet!.tweet1)}>Copy</button></div>
                                <p className="tweet-content">{state.generatedTweet.tweet1}</p>
                            </div>
                            <div className="tweet-box">
                                <div className="tweet-container-header"><h4>Tweet 2 of 2</h4><button className="copy-button" onClick={() => navigator.clipboard.writeText(state.generatedTweet!.tweet2)}>Copy</button></div>
                                <p className="tweet-content">{state.generatedTweet.tweet2}</p>
                            </div>
                        </div>
                    )}
                </div>
            )
          })}
        </div>
      );
    }
    return <div className="initial-message">Click the button to find potential revenge games and heated matchups.</div>;
  };

  return (
    <div>
        <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
            <button className="scan-button" onClick={fetchNarratives} disabled={isLoading}>{isLoading ? 'Scanning...' : 'Find Revenge Narratives'}</button>
            <button className="scan-button" onClick={handleImportMatchups} disabled={isLoading}>Import Matchups</button>
            <button className="scan-button" onClick={handleGenerateArticle} disabled={isLoading || isGeneratingHeatArticle || isGeneratingHeatArticleV2 || isGeneratingHeatArticleV3 || isGeneratingHeatArticleV4}>
                {isGeneratingHeatArticle ? 'Generating...' : 'Heat Article Generator'}
            </button>
            <button className="scan-button" onClick={handleGenerateArticleV2} disabled={isLoading || isGeneratingHeatArticle || isGeneratingHeatArticleV2 || isGeneratingHeatArticleV3 || isGeneratingHeatArticleV4}>
                {isGeneratingHeatArticleV2 ? 'Generating...' : 'Heat Article v2'}
            </button>
            <button className="scan-button" onClick={handleGenerateArticleV3} disabled={isLoading || isGeneratingHeatArticle || isGeneratingHeatArticleV2 || isGeneratingHeatArticleV3 || isGeneratingHeatArticleV4}>
                {isGeneratingHeatArticleV3 ? 'Generating...' : 'Heat Article v3 (MatchPack)'}
            </button>
            <button className="scan-button" onClick={handleGenerateArticleV4} disabled={isLoading || isGeneratingHeatArticle || isGeneratingHeatArticleV2 || isGeneratingHeatArticleV3 || isGeneratingHeatArticleV4}>
                {isGeneratingHeatArticleV4 ? 'Generating...' : 'Heat Article v4 (MatchPack V4)'}
            </button>
            <button className="scan-button" onClick={() => setShowDFSModal(true)} disabled={isLoading || isGeneratingDFSArticle}>
                DFS Article Generator
            </button>
            <button className="scan-button" onClick={() => setShowHeatPicksModal(true)} disabled={isLoading || isGeneratingHeatPicks}>
                Heat Picks Generation
            </button>
        </div>
        <div className="content-area">{renderContent()}</div>
        
        {showImportModal && (
            <div className="modal-overlay" onClick={() => { if (!isLoading) setShowImportModal(false); }}>
                <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '700px', maxHeight: '90vh', overflowY: 'auto' }}>
                    <h3>Import Matchups from OddsAPI</h3>
                    
                    <div style={{ marginBottom: '1.5rem' }}>
                        <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>Date Range</label>
                        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                            <div style={{ flex: 1 }}>
                                <label style={{ display: 'block', fontSize: '0.9rem', marginBottom: '0.25rem', color: '#666' }}>Start Date</label>
                                <input
                                    type="date"
                                    value={importStartDate}
                                    onChange={(e) => setImportStartDate(e.target.value)}
                                    disabled={isLoading}
                                    style={{ width: '100%', padding: '0.5rem', fontSize: '1rem' }}
                                />
                            </div>
                            <div style={{ flex: 1 }}>
                                <label style={{ display: 'block', fontSize: '0.9rem', marginBottom: '0.25rem', color: '#666' }}>End Date</label>
                                <input
                                    type="date"
                                    value={importEndDate}
                                    onChange={(e) => setImportEndDate(e.target.value)}
                                    disabled={isLoading}
                                    style={{ width: '100%', padding: '0.5rem', fontSize: '1rem' }}
                                />
                            </div>
                        </div>
                    </div>

                    <div style={{ marginBottom: '1.5rem' }}>
                        <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>Leagues</label>
                        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                            {['NBA', 'NFL', 'EPL', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1'].map(league => (
                                <label key={league} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: isLoading ? 'not-allowed' : 'pointer' }}>
                                    <input
                                        type="checkbox"
                                        checked={selectedLeagues.includes(league)}
                                        onChange={() => handleToggleLeague(league)}
                                        disabled={isLoading}
                                        style={{ width: '18px', height: '18px', cursor: isLoading ? 'not-allowed' : 'pointer' }}
                                    />
                                    <span>{league}</span>
                                </label>
                            ))}
                        </div>
                    </div>

                    {isLoading && (
                        <div style={{ marginBottom: '1rem', padding: '1rem', background: '#f0f0f0', borderRadius: '4px' }}>
                            <div className="loader" style={{ margin: 0 }}>{loadingMessage}</div>
                        </div>
                    )}

                    {importResults && importResults.length > 0 && (
                        <div style={{ marginBottom: '1rem', padding: '1rem', background: '#e8f5e9', borderRadius: '4px', maxHeight: '300px', overflowY: 'auto' }}>
                            <h4 style={{ marginTop: 0, marginBottom: '0.5rem' }}>Imported Games ({importResults.length}):</h4>
                            <div style={{ fontFamily: 'monospace', fontSize: '0.9rem' }}>
                                {importResults.map((game, idx) => (
                                    <div key={idx} style={{ padding: '0.25rem 0', borderBottom: idx < importResults.length - 1 ? '1px solid #ccc' : 'none' }}>
                                        <strong>{game.league}</strong>: {game.teamA} vs {game.teamB} ({game.date})
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {error && (
                        <div style={{ marginBottom: '1rem', padding: '1rem', background: '#ffebee', color: '#c62828', borderRadius: '4px' }}>
                            {error}
                        </div>
                    )}

                    <div style={{ display: 'flex', gap: '1rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                        <button 
                            className="cancel" 
                            onClick={() => { 
                                if (!isLoading) {
                                    setShowImportModal(false);
                                    setImportResults(null);
                                    setError(null);
                                }
                            }}
                            disabled={isLoading}
                        >
                            {isLoading ? 'Importing...' : 'Cancel'}
                        </button>
                        {selectedLeagues.some(l => ['EPL', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1'].includes(l)) && (
                            <button 
                                className="action-button" 
                                onClick={handleImportSoccerMatchups}
                                disabled={isLoading || !importStartDate || !importEndDate || selectedLeagues.filter(l => ['EPL', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1'].includes(l)).length === 0}
                                style={{ background: '#00ff41', color: '#000' }}
                            >
                                {isLoading ? 'Importing...' : 'Import from Soccer DB'}
                            </button>
                        )}
                        <button 
                            className="action-button" 
                            onClick={handleProcessImport} 
                            disabled={isLoading || !importStartDate || !importEndDate || selectedLeagues.length === 0}
                        >
                            {isLoading ? 'Importing...' : 'Import from OddsAPI'}
                        </button>
                    </div>
                </div>
            </div>
        )}

        {/* Matchup Selection Modal for Heat Article Generator */}
        {showMatchupModal && (
            <div className="modal-overlay" onClick={() => { if (!isGeneratingAnyHeatArticle) setShowMatchupModal(false); }}>
                <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '900px', maxHeight: '90vh', overflowY: 'auto' }}>
                    <h3>Select Matchups for Heat Article Generation</h3>
                    <p style={{ marginBottom: '1rem', color: '#666' }}>
                        Select one or more matchups to generate heat articles. Each matchup will be processed sequentially.
                    </p>
                    {matchupModalSource === 'v3' && (
                      <div style={{ marginBottom: '1rem', padding: '0.75rem', background: '#fff8e1', border: '1px solid #ffe082', borderRadius: '6px', color: '#6d4c41' }}>
                        <div style={{ fontWeight: 'bold' }}>V3 Matchups Source</div>
                        <div style={{ fontSize: '0.9rem' }}>
                          These matchups are loaded from the local stats DB (`nba_heat_sheet`). Date/time edits are disabled here to keep published state aligned to the schedule.
                        </div>
                      </div>
                    )}

                    {/* API Source Selector for V3 Edge Generation */}
                    {matchupModalSource === 'v3' && (
                      <div style={{ marginBottom: '1rem', padding: '0.75rem', background: '#e3f2fd', border: '1px solid #90caf9', borderRadius: '6px' }}>
                        <div style={{ fontWeight: 'bold', marginBottom: '0.5rem', fontSize: '0.9rem' }}>Odds Source for Edge Generation:</div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.85rem' }}>
                            <input
                              type="radio"
                              name="articleApiSource"
                              value="theoddsapi"
                              checked={articleApiSource === 'theoddsapi'}
                              onChange={(e) => setArticleApiSource(e.target.value as 'theoddsapi' | 'gemini')}
                              disabled={isGeneratingAnyHeatArticle}
                              style={{ cursor: isGeneratingAnyHeatArticle ? 'not-allowed' : 'pointer' }}
                            />
                            <span>TheOddsAPI</span>
                          </label>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.85rem' }}>
                            <input
                              type="radio"
                              name="articleApiSource"
                              value="gemini"
                              checked={articleApiSource === 'gemini'}
                              onChange={(e) => setArticleApiSource(e.target.value as 'theoddsapi' | 'gemini')}
                              disabled={isGeneratingAnyHeatArticle}
                              style={{ cursor: isGeneratingAnyHeatArticle ? 'not-allowed' : 'pointer' }}
                            />
                            <span>Gemini (AI Search)</span>
                          </label>
                          <span style={{ fontSize: '0.75rem', color: '#666', fontStyle: 'italic' }}>
                            {articleApiSource === 'gemini' ? 'Uses AI to search for current odds' : 'Uses TheOddsAPI service'}
                          </span>
                        </div>
                      </div>
                    )}

                    {/* Filter Section */}
                    {availableMatchups.length > 0 && (
                        <div style={{ marginBottom: '1.5rem', padding: '1rem', background: '#f9f9f9', borderRadius: '4px', border: '1px solid #e0e0e0' }}>
                            <div style={{ fontWeight: 'bold', marginBottom: '0.75rem', fontSize: '0.95rem' }}>Filters</div>
                            
                            {/* League Filter */}
                            <div style={{ marginBottom: '0.75rem' }}>
                                <div style={{ fontSize: '0.85rem', color: '#666', marginBottom: '0.5rem', fontWeight: '500' }}>League:</div>
                                <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
                                    {['NBA', 'NFL', 'EPL', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1', 'MLB', 'NHL'].map(league => (
                                        <label key={league} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer', fontSize: '0.85rem' }}>
                                            <input
                                                type="checkbox"
                                                checked={matchupFilterLeague.includes(league)}
                                                onChange={(e) => {
                                                    if (e.target.checked) {
                                                        setMatchupFilterLeague([...matchupFilterLeague, league]);
                                                    } else {
                                                        setMatchupFilterLeague(matchupFilterLeague.filter(l => l !== league));
                                                    }
                                                }}
                                                disabled={isGeneratingAnyHeatArticle}
                                                style={{ width: '16px', height: '16px', cursor: isGeneratingAnyHeatArticle ? 'not-allowed' : 'pointer' }}
                                            />
                                            <span>{league}</span>
                                        </label>
                                    ))}
                                    {matchupFilterLeague.length > 0 && (
                                        <button
                                            onClick={() => setMatchupFilterLeague([])}
                                            disabled={isGeneratingAnyHeatArticle}
                                            style={{
                                                padding: '0.25rem 0.5rem',
                                                background: 'transparent',
                                                color: '#666',
                                                border: '1px solid #ccc',
                                                borderRadius: '4px',
                                                cursor: isGeneratingAnyHeatArticle ? 'not-allowed' : 'pointer',
                                                fontSize: '0.75rem'
                                            }}
                                        >
                                            Clear
                                        </button>
                                    )}
                                </div>
                            </div>

                            {/* Search Filter */}
                            <div style={{ marginBottom: '0.75rem' }}>
                                <label style={{ fontSize: '0.85rem', color: '#666', marginBottom: '0.5rem', fontWeight: '500', display: 'block' }}>Search by Team:</label>
                                <input
                                    type="text"
                                    placeholder="Enter team name (e.g., Lakers, Packers)..."
                                    value={matchupFilterSearch}
                                    onChange={(e) => setMatchupFilterSearch(e.target.value)}
                                    disabled={isGeneratingAnyHeatArticle}
                                    style={{
                                        width: '100%',
                                        padding: '0.5rem',
                                        fontSize: '0.9rem',
                                        border: '1px solid #ccc',
                                        borderRadius: '4px',
                                        boxSizing: 'border-box'
                                    }}
                                />
                            </div>

                            {/* Date Filter */}
                            <div>
                                <div style={{ fontSize: '0.85rem', color: '#666', marginBottom: '0.5rem', fontWeight: '500' }}>Date Range (EST/EDT):</div>
                                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer', fontSize: '0.85rem' }}>
                                        <input
                                            type="radio"
                                            name="dateFilter"
                                            checked={matchupFilterDate === 'all'}
                                            onChange={() => setMatchupFilterDate('all')}
                                            disabled={isGeneratingAnyHeatArticle}
                                            style={{ cursor: isGeneratingAnyHeatArticle ? 'not-allowed' : 'pointer' }}
                                        />
                                        <span>All</span>
                                    </label>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer', fontSize: '0.85rem' }}>
                                        <input
                                            type="radio"
                                            name="dateFilter"
                                            checked={matchupFilterDate === 'today'}
                                            onChange={() => setMatchupFilterDate('today')}
                                            disabled={isGeneratingAnyHeatArticle}
                                            style={{ cursor: isGeneratingAnyHeatArticle ? 'not-allowed' : 'pointer' }}
                                        />
                                        <span>Today</span>
                                    </label>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer', fontSize: '0.85rem' }}>
                                        <input
                                            type="radio"
                                            name="dateFilter"
                                            checked={matchupFilterDate === 'tomorrow'}
                                            onChange={() => setMatchupFilterDate('tomorrow')}
                                            disabled={isGeneratingAnyHeatArticle}
                                            style={{ cursor: isGeneratingAnyHeatArticle ? 'not-allowed' : 'pointer' }}
                                        />
                                        <span>Tomorrow</span>
                                    </label>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer', fontSize: '0.85rem' }}>
                                        <input
                                            type="radio"
                                            name="dateFilter"
                                            checked={matchupFilterDate === 'thisWeek'}
                                            onChange={() => setMatchupFilterDate('thisWeek')}
                                            disabled={isGeneratingAnyHeatArticle}
                                            style={{ cursor: isGeneratingAnyHeatArticle ? 'not-allowed' : 'pointer' }}
                                        />
                                        <span>This Week</span>
                                    </label>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer', fontSize: '0.85rem' }}>
                                        <input
                                            type="radio"
                                            name="dateFilter"
                                            checked={matchupFilterDate === 'custom'}
                                            onChange={() => setMatchupFilterDate('custom')}
                                            disabled={isGeneratingAnyHeatArticle}
                                            style={{ cursor: isGeneratingAnyHeatArticle ? 'not-allowed' : 'pointer' }}
                                        />
                                        <span>Custom Range</span>
                                    </label>
                                </div>
                                {matchupFilterDate === 'custom' && (
                                    <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem', alignItems: 'center' }}>
                                        <input
                                            type="date"
                                            value={matchupFilterCustomStart}
                                            onChange={(e) => setMatchupFilterCustomStart(e.target.value)}
                                            disabled={isGeneratingAnyHeatArticle}
                                            placeholder="Start date"
                                            style={{ padding: '0.4rem', fontSize: '0.85rem', border: '1px solid #ccc', borderRadius: '4px' }}
                                        />
                                        <span style={{ fontSize: '0.85rem', color: '#666' }}>to</span>
                                        <input
                                            type="date"
                                            value={matchupFilterCustomEnd}
                                            onChange={(e) => setMatchupFilterCustomEnd(e.target.value)}
                                            disabled={isGeneratingAnyHeatArticle}
                                            placeholder="End date"
                                            style={{ padding: '0.4rem', fontSize: '0.85rem', border: '1px solid #ccc', borderRadius: '4px' }}
                                        />
                                    </div>
                                )}
                            </div>

                            {/* Results count */}
                            <div style={{ marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid #e0e0e0', fontSize: '0.85rem', color: '#666' }}>
                                Showing {filteredMatchups.length} of {availableMatchups.length} matchups
                            </div>
                        </div>
                    )}

                    {availableMatchups.length === 0 ? (
                        <div style={{ padding: '2rem', textAlign: 'center', color: '#666' }}>
                            No matchups found. Please import matchups first.
                        </div>
                    ) : filteredMatchups.length === 0 ? (
                        <div style={{ padding: '2rem', textAlign: 'center', color: '#666' }}>
                            No matchups match your filters. Try adjusting your filter criteria.
                        </div>
                    ) : (
                        <div style={{ maxHeight: '400px', overflowY: 'auto', marginBottom: '1rem' }}>
                            {filteredMatchups.map(matchup => (
                                <div
                                    key={matchup.id}
                                    style={{
                                        padding: '0.75rem',
                                        marginBottom: '0.5rem',
                                        background: selectedMatchupIds.includes(matchup.id) ? '#e3f2fd' : '#f5f5f5',
                                        borderRadius: '4px',
                                        border: selectedMatchupIds.includes(matchup.id) ? '2px solid #2196f3' : '2px solid transparent'
                                    }}
                                >
                                    {editingMatchupId === matchup.id ? (
                                        // Edit mode
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                                            <div style={{ fontWeight: 'bold', fontSize: '1rem' }}>
                                                {matchup.teamA} vs {matchup.teamB}
                                            </div>
                                            <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                                                <label style={{ fontSize: '0.9rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                                                    <span style={{ color: '#666', fontWeight: '500' }}>Date (EST/EDT - America/New_York):</span>
                                                    <input
                                                        type="date"
                                                        value={editDate}
                                                        onChange={(e) => setEditDate(e.target.value)}
                                                        style={{ padding: '0.5rem', fontSize: '0.9rem', border: '1px solid #ccc', borderRadius: '4px', width: '200px' }}
                                                    />
                                                    <span style={{ fontSize: '0.75rem', color: '#999', marginTop: '0.1rem' }}>Enter the date as it appears in NY timezone</span>
                                                </label>
                                                <label style={{ fontSize: '0.9rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                                                    <span style={{ color: '#666', fontWeight: '500' }}>Time (EST/EDT - HH:MM, optional):</span>
                                                    <input
                                                        type="time"
                                                        value={editTime}
                                                        onChange={(e) => setEditTime(e.target.value)}
                                                        style={{ padding: '0.5rem', fontSize: '0.9rem', border: '1px solid #ccc', borderRadius: '4px', width: '140px' }}
                                                    />
                                                    <span style={{ fontSize: '0.75rem', color: '#999', marginTop: '0.1rem' }}>24-hour format (e.g., 20:00 for 8pm)</span>
                                                </label>
                                            </div>
                                            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
                                                <button
                                                    onClick={() => handleSaveMatchup(matchup.id)}
                                                    disabled={isGeneratingAnyHeatArticle}
                                                    style={{ 
                                                        padding: '0.5rem 1rem', 
                                                        background: '#4caf50', 
                                                        color: 'white', 
                                                        border: 'none', 
                                                        borderRadius: '4px', 
                                                        cursor: isGeneratingAnyHeatArticle ? 'not-allowed' : 'pointer',
                                                        fontSize: '0.9rem',
                                                        fontWeight: '500',
                                                        opacity: isGeneratingAnyHeatArticle ? 0.5 : 1
                                                    }}
                                                >
                                                    Save
                                                </button>
                                                <button
                                                    onClick={handleCancelEdit}
                                                    disabled={isGeneratingAnyHeatArticle}
                                                    style={{ 
                                                        padding: '0.5rem 1rem', 
                                                        background: '#999', 
                                                        color: 'white', 
                                                        border: 'none', 
                                                        borderRadius: '4px', 
                                                        cursor: isGeneratingAnyHeatArticle ? 'not-allowed' : 'pointer',
                                                        fontSize: '0.9rem',
                                                        fontWeight: '500',
                                                        opacity: isGeneratingAnyHeatArticle ? 0.5 : 1
                                                    }}
                                                >
                                                    Cancel
                                                </button>
                                            </div>
                                        </div>
                                    ) : (
                                        // Display mode with edit button
                                        <label
                                            style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                cursor: 'pointer'
                                            }}
                                        >
                                            <input
                                                type="checkbox"
                                                checked={selectedMatchupIds.includes(matchup.id)}
                                                onChange={() => handleToggleMatchup(matchup.id)}
                                                disabled={isGeneratingAnyHeatArticle}
                                                style={{ marginRight: '1rem', width: '18px', height: '18px', cursor: isGeneratingAnyHeatArticle ? 'not-allowed' : 'pointer' }}
                                            />
                                            <div style={{ flex: 1 }}>
                                                <div style={{ fontWeight: 'bold' }}>
                                                    {matchup.teamA} vs {matchup.teamB}
                                                </div>
                                                <div style={{ fontSize: '0.9rem', color: '#666' }}>
                                                    {matchup.league} • {formatDateYmdForDisplay(matchup.scheduledDate)}
                                                    {matchup.scheduledTime && ` • ${matchup.scheduledTime}`}
                                                </div>
                                            </div>
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    e.preventDefault();
                                                    handleEditMatchup(matchup);
                                                }}
                                                disabled={isGeneratingAnyHeatArticle || matchupModalSource === 'v3'}
                                                style={{
                                                    padding: '0.5rem 1rem',
                                                    background: '#ff9800',
                                                    color: 'white',
                                                    border: 'none',
                                                    borderRadius: '4px',
                                                    cursor: (isGeneratingAnyHeatArticle || matchupModalSource === 'v3') ? 'not-allowed' : 'pointer',
                                                    fontSize: '0.85rem',
                                                    fontWeight: '500',
                                                    opacity: (isGeneratingAnyHeatArticle || matchupModalSource === 'v3') ? 0.5 : 1,
                                                    marginLeft: '0.5rem'
                                                }}
                                            >
                                                Edit Date
                                            </button>
                                        </label>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}

                    {isGeneratingAnyHeatArticle && generationProgress && (
                        <div style={{ marginBottom: '1rem', padding: '1rem', background: '#f0f0f0', borderRadius: '4px' }}>
                            <div style={{ fontWeight: 'bold', marginBottom: '0.5rem' }}>
                                Processing: {generationProgress.matchup} ({generationProgress.current}/{generationProgress.total})
                            </div>
                            <div style={{ color: '#666' }}>{generationProgress.step}</div>
                        </div>
                    )}

                    {error && (
                        <div style={{ marginBottom: '1rem', padding: '1rem', background: '#ffebee', color: '#c62828', borderRadius: '4px' }}>
                            {error}
                        </div>
                    )}

                    <div style={{ display: 'flex', gap: '1rem', justifyContent: 'flex-end' }}>
                        <button
                            className="cancel"
                            onClick={() => {
                                if (!isGeneratingAnyHeatArticle) {
                                    setShowMatchupModal(false);
                                    setSelectedMatchupIds([]);
                                    setEditingMatchupId(null);
                                    setEditDate('');
                                    setEditTime('');
                                    setError(null);
                                }
                            }}
                            disabled={isGeneratingAnyHeatArticle}
                        >
                            Cancel
                        </button>
                        <button
                            className="action-button"
                            onClick={handleProcessHeatArticle}
                            disabled={isGeneratingAnyHeatArticle || selectedMatchupIds.length === 0}
                        >
                            {isGeneratingHeatArticle ? 'Generating...' : `Generate ${selectedMatchupIds.length} Article(s)`}
                        </button>
                        <button
                            className="action-button"
                            onClick={handleProcessHeatArticleV2}
                            disabled={isGeneratingAnyHeatArticle || selectedMatchupIds.length === 0}
                            style={{ background: '#9c27b0', marginLeft: '0.5rem' }}
                        >
                            {isGeneratingHeatArticleV2 ? 'Generating V2...' : `Generate ${selectedMatchupIds.length} V2 Article(s)`}
                        </button>
                        <button
                            className="action-button"
                            onClick={handleProcessHeatArticleV3}
                            disabled={isGeneratingAnyHeatArticle || selectedMatchupIds.length === 0}
                            style={{ background: '#1976d2', marginLeft: '0.5rem' }}
                        >
                            {isGeneratingHeatArticleV3 ? 'Generating V3...' : `Generate ${selectedMatchupIds.length} V3 Pack(s)`}
                        </button>
                        {matchupModalSource === 'v4' && (
                            <button
                                className="action-button"
                                onClick={handleProcessHeatArticleV4}
                                disabled={isGeneratingAnyHeatArticle || selectedMatchupIds.length === 0}
                                style={{ background: '#ff6b35', marginLeft: '0.5rem' }}
                            >
                                {isGeneratingHeatArticleV4 ? 'Generating V4...' : `Generate ${selectedMatchupIds.length} V4 Pack(s)`}
                            </button>
                        )}
                    </div>
                </div>
            </div>
        )}
        
        {showDFSModal && (
            <div className="modal-overlay" onClick={() => { if (!isGeneratingDFSArticle) setShowDFSModal(false); }}>
                <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                        <h2>DFS Article Generator</h2>
                        <button
                            className="cancel"
                            onClick={() => {
                                if (!isGeneratingDFSArticle) {
                                    setShowDFSModal(false);
                                    setError(null);
                                }
                            }}
                            disabled={isGeneratingDFSArticle}
                            style={{ background: 'transparent', border: 'none', fontSize: '1.5rem', cursor: 'pointer' }}
                        >
                            ×
                        </button>
                    </div>

                    {error && (
                        <div style={{ padding: '1rem', background: 'rgba(248, 66, 66, 0.1)', border: '1px solid rgba(248, 66, 66, 0.5)', borderRadius: '4px', marginBottom: '1rem', color: '#f84242' }}>
                            {error}
                        </div>
                    )}

                    <div style={{ marginBottom: '1.5rem' }}>
                        <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>Select League:</label>
                        <div style={{ display: 'flex', gap: '1rem' }}>
                            <button
                                className={dfsSport === 'NBA' ? 'action-button' : 'cancel'}
                                onClick={() => setDfsSport('NBA')}
                                disabled={isGeneratingDFSArticle}
                                style={{ flex: 1 }}
                            >
                                NBA
                            </button>
                            <button
                                className={dfsSport === 'NFL' ? 'action-button' : 'cancel'}
                                onClick={() => setDfsSport('NFL')}
                                disabled={isGeneratingDFSArticle}
                                style={{ flex: 1 }}
                            >
                                NFL
                            </button>
                        </div>
                    </div>

                    <div style={{ marginBottom: '1.5rem' }}>
                        <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>Upload Excel File:</label>
                        <input
                            type="file"
                            accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv"
                            onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) {
                                    handleGenerateDFSArticle(file);
                                }
                            }}
                            disabled={isGeneratingDFSArticle}
                            style={{ width: '100%', padding: '0.5rem', border: '1px solid #ccc', borderRadius: '4px' }}
                        />
                        <div style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: '#666' }}>
                            Upload an Excel file with player data (Player Name, Position, Team, Opponent, Salary, etc.)
                        </div>
                    </div>

                    {isGeneratingDFSArticle && (
                        <div style={{ textAlign: 'center', padding: '2rem' }}>
                            <div className="loader">Analyzing slate and generating article...</div>
                        </div>
                    )}

                    <div style={{ display: 'flex', gap: '1rem', justifyContent: 'flex-end' }}>
                        <button
                            className="cancel"
                            onClick={() => {
                                if (!isGeneratingDFSArticle) {
                                    setShowDFSModal(false);
                                    setError(null);
                                }
                            }}
                            disabled={isGeneratingDFSArticle}
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            </div>
        )}

        {/* Heat Picks Generation Modal */}
        {showHeatPicksModal && (
            <div className="modal-overlay" onClick={() => { if (!isGeneratingHeatPicks) setShowHeatPicksModal(false); }}>
                <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                        <h2>Heat Picks Generation</h2>
                        <button
                            className="cancel"
                            onClick={() => {
                                if (!isGeneratingHeatPicks) {
                                    setShowHeatPicksModal(false);
                                    setError(null);
                                }
                            }}
                            disabled={isGeneratingHeatPicks}
                            style={{ background: 'transparent', border: 'none', fontSize: '1.5rem', cursor: 'pointer' }}
                        >
                            ×
                        </button>
                    </div>

                    {error && (
                        <div style={{ padding: '1rem', background: 'rgba(248, 66, 66, 0.1)', border: '1px solid rgba(248, 66, 66, 0.5)', borderRadius: '4px', marginBottom: '1rem', color: '#f84242' }}>
                            {error}
                        </div>
                    )}

                    <div style={{ marginBottom: '1.5rem' }}>
                        <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>Select Date:</label>
                        <input
                            type="date"
                            value={heatPicksDate}
                            onChange={(e) => setHeatPicksDate(e.target.value)}
                            disabled={isGeneratingHeatPicks}
                            style={{ width: '100%', padding: '0.5rem', border: '1px solid #ccc', borderRadius: '4px' }}
                        />
                    </div>

                    <div style={{ marginBottom: '1.5rem' }}>
                        <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>Select League:</label>
                        <select
                            value={heatPicksLeague}
                            onChange={(e) => setHeatPicksLeague(e.target.value)}
                            disabled={isGeneratingHeatPicks}
                            style={{ width: '100%', padding: '0.5rem', border: '1px solid #ccc', borderRadius: '4px' }}
                        >
                            <option value="NBA">NBA</option>
                            <option value="NFL">NFL</option>
                            <option value="EPL">EPL</option>
                            <option value="BUNDESLIGA">Bundesliga</option>
                            <option value="LIGUE 1">Ligue 1</option>
                            <option value="PREMIER LEAGUE">Premier League</option>
                        </select>
                    </div>

                    {isGeneratingHeatPicks && (
                        <div style={{ textAlign: 'center', padding: '2rem' }}>
                            <div className="loader">Generating Heat Picks...</div>
                        </div>
                    )}

                    <div style={{ display: 'flex', gap: '1rem', justifyContent: 'flex-end' }}>
                        <button
                            className="cancel"
                            onClick={() => {
                                if (!isGeneratingHeatPicks) {
                                    setShowHeatPicksModal(false);
                                    setError(null);
                                }
                            }}
                            disabled={isGeneratingHeatPicks}
                        >
                            Cancel
                        </button>
                        <button
                            className="action-button"
                            onClick={handleGenerateHeatPicks}
                            disabled={isGeneratingHeatPicks || !heatPicksDate || !heatPicksLeague}
                        >
                            Generate Heat Picks
                        </button>
                    </div>
                </div>
            </div>
        )}
    </div>
  );
};

const HeatchecksFeed: React.FC<{ refreshKey: boolean, setEditingPost: (post: HeatcheckPost) => void }> = ({ refreshKey, setEditingPost }) => {
    const [posts, setPosts] = useState<HeatcheckPost[]>([]);
    const [loading, setLoading] = useState(true);
    const [deletingPostId, setDeletingPostId] = useState<string | null>(null);
    const [currentPage, setCurrentPage] = useState(1);
    const postsPerPage = 10;
    
    // Twitter/Reddit generation state for DFS articles
    const [showTweetModal, setShowTweetModal] = useState(false);
    const [selectedPostForTweet, setSelectedPostForTweet] = useState<HeatcheckPost | null>(null);
    const [selectedPlayerIndex, setSelectedPlayerIndex] = useState<number>(0);
    const [generatedTweet, setGeneratedTweet] = useState<string>('');
    const [generatedReddit, setGeneratedReddit] = useState<{ title: string; body: string } | null>(null);
    const [isGeneratingTweet, setIsGeneratingTweet] = useState(false);
    const [activeTab, setActiveTab] = useState<'tweet' | 'reddit'>('tweet');
    
    // Heat Article content generation state
    const [showHeatArticleModal, setShowHeatArticleModal] = useState(false);
    const [selectedPostForHeatArticle, setSelectedPostForHeatArticle] = useState<HeatcheckPost | null>(null);
    const [selectedNarrativeIndex, setSelectedNarrativeIndex] = useState<number>(0);
    const [generatedHeatTweet, setGeneratedHeatTweet] = useState<string>('');
    const [generatedHeatReddit, setGeneratedHeatReddit] = useState<{ title: string; body: string } | null>(null);
    const [isGeneratingHeatContent, setIsGeneratingHeatContent] = useState(false);
    const [activeHeatTab, setActiveHeatTab] = useState<'tweet' | 'reddit'>('tweet');
    
    // Viral content generation state
    const [showNarrativeSelectionModal, setShowNarrativeSelectionModal] = useState(false);
    const [showContentPreviewModal, setShowContentPreviewModal] = useState(false);
    const [selectedPostForViral, setSelectedPostForViral] = useState<HeatcheckPost | null>(null);
    const [selectedNarrativeCard, setSelectedNarrativeCard] = useState<any>(null);
    const [generatedViralContent, setGeneratedViralContent] = useState<{
        longFormTweet: string;
        twitterThread: string[];
        redditPost: { title: string; body: string };
        heatSheetSegment: string;
        validationNotes: string;
    } | null>(null);
    const [isGeneratingViralContent, setIsGeneratingViralContent] = useState(false);
    const [activeViralTab, setActiveViralTab] = useState<'tweet' | 'thread' | 'reddit' | 'heatsheet'>('tweet');
    
    // SEO Rewrite state
    const [showSEORewriteModal, setShowSEORewriteModal] = useState(false);
    const [selectedPostForSEORewrite, setSelectedPostForSEORewrite] = useState<HeatcheckPost | null>(null);
    const [seoRewritePreview, setSeoRewritePreview] = useState<SEORewriteOutput | null>(null);
    const [isGeneratingSEORewrite, setIsGeneratingSEORewrite] = useState(false);
    const [seoRewriteEditable, setSeoRewriteEditable] = useState<SEORewriteOutput | null>(null);
    
    // Search/filter state
    const [searchFilter, setSearchFilter] = useState<string>('');
    const [leagueFilter, setLeagueFilter] = useState<string>('');
    const [dateFilter, setDateFilter] = useState<string>('');

    useEffect(() => {
        setLoading(true);
        apiClient.listPosts().then(data => {
            console.log(`[Content Feed] Loaded ${data.length} total posts from API`);
            
            // Debug: Log NBA posts from 1-27
            const nbaPosts127 = data.filter(post => {
                const league = (post.league || '').toUpperCase();
                const date = post.matchupScheduledDate || post.createdAt;
                const dateStr = date ? new Date(date).toISOString().split('T')[0] : '';
                return league === 'NBA' && dateStr === '2026-01-27';
            });
            console.log(`[Content Feed] Found ${nbaPosts127.length} NBA posts from 2026-01-27:`, nbaPosts127.map(p => ({
                id: p.id,
                headline: p.websiteStory?.headline?.substring(0, 40),
                league: p.league,
                matchupScheduledDate: p.matchupScheduledDate,
                createdAt: p.createdAt,
                updatedAt: p.updatedAt,
                status: p.status
            })));
            
            // Debug: Log Bundesliga posts from 1-27 for comparison
            const bundesligaPosts127 = data.filter(post => {
                const league = (post.league || '').toUpperCase();
                const date = post.matchupScheduledDate || post.createdAt;
                const dateStr = date ? new Date(date).toISOString().split('T')[0] : '';
                return league === 'BUNDESLIGA' && dateStr === '2026-01-27';
            });
            console.log(`[Content Feed] Found ${bundesligaPosts127.length} Bundesliga posts from 2026-01-27:`, bundesligaPosts127.map(p => ({
                id: p.id,
                headline: p.websiteStory?.headline?.substring(0, 40),
                league: p.league,
                matchupScheduledDate: p.matchupScheduledDate,
                createdAt: p.createdAt,
                updatedAt: p.updatedAt,
                status: p.status
            })));
            
            // Sort by latest first (by updatedAt, then createdAt)
            const sorted = [...data].sort((a, b) => {
                const dateA = new Date(a.updatedAt || a.createdAt).getTime();
                const dateB = new Date(b.updatedAt || b.createdAt).getTime();
                return dateB - dateA; // Descending order (newest first)
            });
            
            // Debug: Check where NBA posts from 1-27 end up in sorted array
            const sortedNba127 = sorted.map((post, index) => {
                const league = (post.league || '').toUpperCase();
                const date = post.matchupScheduledDate || post.createdAt;
                const dateStr = date ? new Date(date).toISOString().split('T')[0] : '';
                if (league === 'NBA' && dateStr === '2026-01-27') {
                    return { index, post: { id: post.id, headline: post.websiteStory?.headline?.substring(0, 40), updatedAt: post.updatedAt } };
                }
                return null;
            }).filter(Boolean);
            console.log(`[Content Feed] NBA posts from 1-27 positions in sorted array:`, sortedNba127);
            
            setPosts(sorted);
            setLoading(false);
            // Reset to page 1 when data changes
            setCurrentPage(1);
        }).catch(err => {
            console.error("Failed to load posts:", err);
            setLoading(false);
        });
    }, [refreshKey]);

    const handleDeletePost = async (postId: string, headline: string) => {
        if (!window.confirm(`Are you sure you want to delete "${headline}"?\n\nThis action cannot be undone.`)) {
            return;
        }

        setDeletingPostId(postId);
        try {
            const result = await apiClient.deletePost(postId);
            console.log('Delete result:', result);
            // Remove the post from the list
            setPosts(prevPosts => prevPosts.filter(p => p.id !== postId));
        } catch (error: any) {
            console.error("Failed to delete post:", error);
            const errorMessage = error?.message || error?.toString() || 'Unknown error';
            alert(`Failed to delete post: ${errorMessage}\n\nPlease check that the backend server is running and the API key is correct.`);
        } finally {
            setDeletingPostId(null);
        }
    };

    const handleGenerateTweet = async () => {
        if (!selectedPostForTweet) return;
        
        const dfsPlayers = selectedPostForTweet.heatCheckData?.dfsPlayers || [];
        if (dfsPlayers.length === 0) {
            alert('No players found in this DFS article.');
            return;
        }
        
        const selectedPlayer = dfsPlayers[selectedPlayerIndex];
        setIsGeneratingTweet(true);
        setGeneratedTweet('');
        setGeneratedReddit(null);
        
        try {
            // Show progress message
            setGeneratedTweet('🔍 Researching additional narratives for this player...\n\nThis may take 30-60 seconds...');
            
            const { tweet, reddit } = await generateDFSContent(
                selectedPlayer,
                selectedPostForTweet.league as 'NBA' | 'NFL',
                selectedPostForTweet.matchupScheduledDate || selectedPostForTweet.createdAt
            );
            setGeneratedTweet(tweet);
            setGeneratedReddit(reddit);
        } catch (error: any) {
            console.error("Failed to generate content:", error);
            alert(`Failed to generate content: ${error.message || 'Unknown error'}`);
            setGeneratedTweet('');
            setGeneratedReddit(null);
        } finally {
            setIsGeneratingTweet(false);
        }
    };

    const handleCopyTweet = () => {
        if (generatedTweet) {
            navigator.clipboard.writeText(generatedTweet).then(() => {
                alert('Tweet copied to clipboard!');
            }).catch(err => {
                console.error('Failed to copy:', err);
                alert('Failed to copy tweet. Please select and copy manually.');
            });
        }
    };

    const handleCopyReddit = () => {
        if (generatedReddit) {
            const redditText = `${generatedReddit.title}\n\n${generatedReddit.body}`;
            navigator.clipboard.writeText(redditText).then(() => {
                alert('Reddit post copied to clipboard!');
            }).catch(err => {
                console.error('Failed to copy:', err);
                alert('Failed to copy Reddit post. Please select and copy manually.');
            });
        }
    };

    // Heat Article content generation handlers
    const handleGenerateHeatArticleContent = async () => {
        if (!selectedPostForHeatArticle) return;
        
        const narrativeCards = selectedPostForHeatArticle.heatCheckData?.narratives?.candidate_cards || [];
        if (narrativeCards.length === 0) {
            alert('No narratives found in this Heat Article.');
            return;
        }
        
        const selectedNarrative = narrativeCards[selectedNarrativeIndex];
        setIsGeneratingHeatContent(true);
        setGeneratedHeatTweet('');
        setGeneratedHeatReddit(null);
        
        try {
            // Show progress message
            setGeneratedHeatTweet('🔍 Researching additional story context for this narrative...\n\nThis may take 30-60 seconds...');
            
            const { tweet, reddit } = await generateHeatArticleContent(
                selectedNarrative,
                {
                    teamA: selectedPostForHeatArticle.teamA,
                    teamB: selectedPostForHeatArticle.teamB,
                    league: selectedPostForHeatArticle.league,
                    matchupDate: selectedPostForHeatArticle.matchupScheduledDate || selectedPostForHeatArticle.createdAt,
                    evidenceBundle: selectedPostForHeatArticle.heatCheckData?.evidenceBundle || selectedPostForHeatArticle.heatCheckData?.evidence_bundle,
                    factPack: selectedPostForHeatArticle.heatCheckData?.factPack
                }
            );
            setGeneratedHeatTweet(tweet);
            setGeneratedHeatReddit(reddit);
        } catch (error: any) {
            console.error("Failed to generate Heat Article content:", error);
            alert(`Failed to generate content: ${error.message || 'Unknown error'}`);
            setGeneratedHeatTweet('');
            setGeneratedHeatReddit(null);
        } finally {
            setIsGeneratingHeatContent(false);
        }
    };

    const handleCopyHeatTweet = () => {
        if (generatedHeatTweet) {
            navigator.clipboard.writeText(generatedHeatTweet).then(() => {
                alert('Tweet copied to clipboard!');
            }).catch(err => {
                console.error('Failed to copy:', err);
                alert('Failed to copy tweet. Please select and copy manually.');
            });
        }
    };

    // SEO Rewrite handlers
    const handleGenerateSEORewrite = async () => {
        if (!selectedPostForSEORewrite) return;
        
        setIsGeneratingSEORewrite(true);
        setSeoRewritePreview(null);
        setSeoRewriteEditable(null);
        
        try {
            const factPack = selectedPostForSEORewrite.heatCheckData?.factPack;
            const rewrite = await rewriteArticleForSEO(selectedPostForSEORewrite, factPack);
            setSeoRewritePreview(rewrite);
            setSeoRewriteEditable({ ...rewrite });
        } catch (error: any) {
            console.error("Failed to generate SEO rewrite:", error);
            alert(`Failed to generate SEO rewrite: ${error.message || 'Unknown error'}`);
        } finally {
            setIsGeneratingSEORewrite(false);
        }
    };

    const handleSaveSEORewrite = async () => {
        if (!selectedPostForSEORewrite || !seoRewriteEditable) return;
        
        try {
            // Get current slug to track as previous
            const currentSlug = selectedPostForSEORewrite.websiteStory.seo.slug || '';
            const newSlug = seoRewriteEditable.seoSlug;
            
            // Build previousSlugs array
            const previousSlugs = selectedPostForSEORewrite.websiteStory.seo.previousSlugs || [];
            if (currentSlug && currentSlug !== newSlug && !previousSlugs.includes(currentSlug)) {
                previousSlugs.push(currentSlug);
            }
            
            // Update the post
            const updatedPost = {
                ...selectedPostForSEORewrite,
                websiteStory: {
                    ...selectedPostForSEORewrite.websiteStory,
                    headline: seoRewriteEditable.h1Header,
                    theBackstory: seoRewriteEditable.rewrittenBody,
                    seo: {
                        slug: newSlug,
                        metaTitle: seoRewriteEditable.seoTitle,
                        metaDescription: seoRewriteEditable.metaDescription,
                        previousSlugs: previousSlugs
                    }
                },
                heatCheckData: {
                    ...selectedPostForSEORewrite.heatCheckData,
                    article: {
                        ...selectedPostForSEORewrite.heatCheckData?.article,
                        long_form_markdown: seoRewriteEditable.rewrittenBody // Sync from theBackstory
                    }
                }
            };
            
            await apiClient.updatePost(selectedPostForSEORewrite.id, updatedPost);
            alert('SEO rewrite saved successfully! Static site will regenerate.');
            setShowSEORewriteModal(false);
            setSeoRewritePreview(null);
            setSeoRewriteEditable(null);
            setSelectedPostForSEORewrite(null);
            
            // Refresh the feed
            const refreshedPosts = await apiClient.listPosts();
            setPosts(refreshedPosts.sort((a, b) => {
                const dateA = new Date(a.updatedAt || a.createdAt).getTime();
                const dateB = new Date(b.updatedAt || b.createdAt).getTime();
                return dateB - dateA;
            }));
        } catch (error: any) {
            console.error("Failed to save SEO rewrite:", error);
            alert(`Failed to save SEO rewrite: ${error.message || 'Unknown error'}`);
        }
    };

    const handleCopyHeatReddit = () => {
        if (generatedHeatReddit) {
            const redditText = `${generatedHeatReddit.title}\n\n${generatedHeatReddit.body}`;
            navigator.clipboard.writeText(redditText).then(() => {
                alert('Reddit post copied to clipboard!');
            }).catch(err => {
                console.error('Failed to copy:', err);
                alert('Failed to copy Reddit post. Please select and copy manually.');
            });
        }
    };

    if (loading) return <div className="loader">Loading feed...</div>;
    if (posts.length === 0) return <div className="initial-message">No posts found. Create one from the Scanner Console.</div>;

    // Calculate pagination
    const totalPages = Math.ceil(posts.length / postsPerPage);
    const startIndex = (currentPage - 1) * postsPerPage;
    const endIndex = startIndex + postsPerPage;
    const currentPosts = posts.slice(startIndex, endIndex);

    return (
        <div>
            <div style={{ marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem', background: 'rgba(255, 255, 255, 0.05)', borderRadius: '4px' }}>
                <div style={{ fontSize: '0.85rem', color: 'rgba(255, 255, 255, 0.7)' }}>
                    Showing {startIndex + 1}-{Math.min(endIndex, posts.length)} of {posts.length} posts
                </div>
                {totalPages > 1 && (
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                        <button
                            onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                            disabled={currentPage === 1}
                            style={{
                                padding: '0.5rem 1rem',
                                background: currentPage === 1 ? 'rgba(255, 255, 255, 0.1)' : 'rgba(255, 255, 255, 0.2)',
                                border: '1px solid rgba(255, 255, 255, 0.3)',
                                borderRadius: '4px',
                                color: currentPage === 1 ? 'rgba(255, 255, 255, 0.3)' : '#fff',
                                cursor: currentPage === 1 ? 'not-allowed' : 'pointer',
                                fontSize: '0.75rem',
                                fontWeight: 'bold',
                                transition: 'all 0.2s'
                            }}
                        >
                            ← Previous
                        </button>
                        <div style={{ fontSize: '0.85rem', color: 'rgba(255, 255, 255, 0.7)', minWidth: '80px', textAlign: 'center' }}>
                            Page {currentPage} of {totalPages}
                        </div>
                        <button
                            onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                            disabled={currentPage === totalPages}
                            style={{
                                padding: '0.5rem 1rem',
                                background: currentPage === totalPages ? 'rgba(255, 255, 255, 0.1)' : 'rgba(255, 255, 255, 0.2)',
                                border: '1px solid rgba(255, 255, 255, 0.3)',
                                borderRadius: '4px',
                                color: currentPage === totalPages ? 'rgba(255, 255, 255, 0.3)' : '#fff',
                                cursor: currentPage === totalPages ? 'not-allowed' : 'pointer',
                                fontSize: '0.75rem',
                                fontWeight: 'bold',
                                transition: 'all 0.2s'
                            }}
                        >
                            Next →
                        </button>
                    </div>
                )}
            </div>
        <div className="results-grid">
            {currentPosts.map(post => {
                const statusColor = post.status === 'published' ? 'var(--secondary-color)' : '#f0e68c';
                const heatCheckData = (post as any).heatCheckData;
                const narrativeCards = heatCheckData?.narratives?.candidate_cards || [];
                const primaryNarrativeId = heatCheckData?.narratives?.selected?.primary_narrative_id || '';
                const evidenceBundle = heatCheckData?.evidenceBundle || heatCheckData?.evidence_bundle || { quotes: [], timeline_events: [] };
                const validationWarnings = heatCheckData?.validation_warnings || [];
                const primaryCard = narrativeCards.find((c: any) => c.narrative_id === primaryNarrativeId);
                
                return (
                    <div 
                        className="card expandable" 
                        key={post.id} 
                        onClick={(e) => {
                            // Don't open editor if clicking delete button
                            if ((e.target as HTMLElement).closest('.delete-button')) {
                                return;
                            }
                            setEditingPost(post);
                        }}
                        style={{
                            background: '#1a1a1a',
                            border: '1px solid #333',
                            borderRadius: '8px',
                            padding: '1.5rem',
                            cursor: 'pointer',
                            transition: 'all 0.2s',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '1rem',
                            position: 'relative'
                        }}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.borderColor = '#4caf50';
                            e.currentTarget.style.transform = 'translateY(-2px)';
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.borderColor = '#333';
                            e.currentTarget.style.transform = 'translateY(0)';
                        }}
                    >
                        {/* Header */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem', position: 'relative' }}>
                            <div style={{ flex: 1, paddingRight: post.status === 'published' ? '100px' : '0' }}>
                                <h2 style={{ margin: 0, fontSize: '1.25rem', color: '#fff', marginBottom: '0.25rem' }}>
                                    {post.websiteStory.headline}
                                </h2>
                                <div style={{ fontSize: '0.85rem', color: '#999' }}>
                                    {post.teamA} vs {post.teamB} • {post.league}
                                    {(() => {
                                        const dateStr = post.matchupScheduledDate || post.createdAt;
                                        if (!dateStr) return '';
                                        // Extract YYYY-MM-DD from the date string to avoid timezone issues
                                        const dateMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
                                        if (dateMatch) {
                                            const [, year, month, day] = dateMatch;
                                            return ` • ${month}/${day}/${year}`;
                                        }
                                        // Fallback to original method if format is unexpected
                                        try {
                                            const date = new Date(dateStr);
                                            return ` • ${date.toLocaleDateString()}`;
                                        } catch {
                                            return '';
                                        }
                                    })()}
                                </div>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <span 
                                    className="league" 
                                    style={{
                                        backgroundColor: statusColor, 
                                        color: '#121212',
                                        padding: '0.25rem 0.75rem',
                                        borderRadius: '4px',
                                        fontSize: '0.75rem',
                                        fontWeight: 'bold'
                                    }}
                                >
                                    {post.status}
                                </span>
                                {/* Generate Content Button */}
                                {narrativeCards.length > 0 && (
                                    <button
                                        className="generate-content-button"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setSelectedPostForViral(post);
                                            setShowNarrativeSelectionModal(true);
                                        }}
                                        style={{
                                            background: 'rgba(76, 175, 80, 0.8)',
                                            color: '#fff',
                                            border: 'none',
                                            borderRadius: '4px',
                                            padding: '0.5rem 0.75rem',
                                            cursor: 'pointer',
                                            fontSize: '0.75rem',
                                            fontWeight: 'bold',
                                            transition: 'all 0.2s',
                                            whiteSpace: 'nowrap'
                                        }}
                                        onMouseEnter={(e) => {
                                            e.currentTarget.style.background = 'rgba(76, 175, 80, 1)';
                                            e.currentTarget.style.transform = 'scale(1.05)';
                                        }}
                                        onMouseLeave={(e) => {
                                            e.currentTarget.style.background = 'rgba(76, 175, 80, 0.8)';
                                            e.currentTarget.style.transform = 'scale(1)';
                                        }}
                                    >
                                        Generate Content
                                    </button>
                                )}
                                {/* SEO Rewrite Button - Only for published posts */}
                                {post.status === 'published' && post.storyType !== 'dfs_article' && (
                                    <button
                                        className="seo-rewrite-button"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setSelectedPostForSEORewrite(post);
                                            setSeoRewritePreview(null);
                                            setSeoRewriteEditable(null);
                                            setShowSEORewriteModal(true);
                                        }}
                                        style={{
                                            background: 'rgba(33, 150, 243, 0.8)',
                                            color: '#fff',
                                            border: 'none',
                                            borderRadius: '4px',
                                            padding: '0.5rem 0.75rem',
                                            cursor: 'pointer',
                                            fontSize: '0.75rem',
                                            fontWeight: 'bold',
                                            transition: 'all 0.2s',
                                            whiteSpace: 'nowrap'
                                        }}
                                        onMouseEnter={(e) => {
                                            e.currentTarget.style.background = 'rgba(33, 150, 243, 1)';
                                            e.currentTarget.style.transform = 'scale(1.05)';
                                        }}
                                        onMouseLeave={(e) => {
                                            e.currentTarget.style.background = 'rgba(33, 150, 243, 0.8)';
                                            e.currentTarget.style.transform = 'scale(1)';
                                        }}
                                    >
                                        SEO Rewrite
                                    </button>
                                )}
                                {/* Delete Button - Only for published posts */}
                                {post.status === 'published' && (
                                    <button
                                        className="delete-button"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handleDeletePost(post.id, post.websiteStory.headline);
                                        }}
                                        disabled={deletingPostId === post.id}
                                        style={{
                                            background: deletingPostId === post.id ? '#666' : '#dc3545',
                                            color: '#fff',
                                            border: 'none',
                                            borderRadius: '4px',
                                            padding: '0.5rem 0.75rem',
                                            cursor: deletingPostId === post.id ? 'not-allowed' : 'pointer',
                                            fontSize: '0.75rem',
                                            fontWeight: 'bold',
                                            transition: 'all 0.2s',
                                            opacity: deletingPostId === post.id ? 0.6 : 1,
                                            whiteSpace: 'nowrap'
                                        }}
                                        onMouseEnter={(e) => {
                                            if (deletingPostId !== post.id) {
                                                e.currentTarget.style.background = '#c82333';
                                                e.currentTarget.style.transform = 'scale(1.05)';
                                            }
                                        }}
                                        onMouseLeave={(e) => {
                                            if (deletingPostId !== post.id) {
                                                e.currentTarget.style.background = '#dc3545';
                                                e.currentTarget.style.transform = 'scale(1)';
                                            }
                                        }}
                                    >
                                        {deletingPostId === post.id ? 'Deleting...' : 'Delete'}
                                    </button>
                                )}
                            </div>
                        </div>

                        {/* Primary Narrative Card Preview */}
                        {primaryCard && (
                            <div style={{
                                padding: '1rem',
                                background: 'rgba(255, 255, 255, 0.05)',
                                border: '1px solid rgba(248, 66, 66, 0.3)',
                                borderLeft: '3px solid rgba(248, 66, 66, 0.6)',
                                borderRadius: '4px'
                            }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                                    <span style={{ color: '#4caf50' }}>✓</span>
                                    <strong style={{ fontSize: '0.95rem', color: '#fff' }}>{primaryCard.title}</strong>
                                </div>
                                <p style={{ fontSize: '0.85rem', color: '#ccc', marginBottom: '0.5rem', lineHeight: '1.5' }}>
                                    {primaryCard.claim}
                                </p>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.75rem', color: '#999' }}>
                                    <span>Score: <strong style={{ color: '#f84242' }}>{primaryCard.total_score}/35</strong></span>
                                    <span>{primaryCard.emotion_tags?.slice(0, 3).join(', ') || ''}</span>
                                </div>
                            </div>
                        )}

                        {/* Evidence Board Preview */}
                        <div style={{ 
                            padding: '0.75rem', 
                            background: 'rgba(0, 0, 0, 0.3)', 
                            borderRadius: '4px',
                            border: '1px solid #333'
                        }}>
                            <div style={{ fontSize: '0.75rem', color: '#999', marginBottom: '0.75rem', fontWeight: 'bold' }}>
                                EVIDENCE BOARD
                            </div>
                            
                            {/* Validation Warnings Preview */}
                            {validationWarnings.length > 0 && (
                                <div style={{ marginBottom: '0.75rem' }}>
                                    <div style={{ fontSize: '0.7rem', color: '#ff9800', marginBottom: '0.25rem' }}>
                                        ⚠️ {validationWarnings.length} validation warning{validationWarnings.length > 1 ? 's' : ''}
                                    </div>
                                </div>
                            )}

                            {/* Quotes Preview */}
                            {evidenceBundle.quotes && evidenceBundle.quotes.length > 0 && (
                                <div style={{ marginBottom: '0.75rem' }}>
                                    <div style={{ fontSize: '0.7rem', color: '#999', marginBottom: '0.25rem' }}>QUOTES ({evidenceBundle.quotes.length})</div>
                                    {evidenceBundle.quotes.slice(0, 1).map((quote: any, idx: number) => (
                                        <div key={idx} style={{ fontSize: '0.75rem', fontStyle: 'italic', color: '#ccc', lineHeight: '1.4' }}>
                                            "{quote.quote.substring(0, 100)}{quote.quote.length > 100 ? '...' : ''}"
                                        </div>
                                    ))}
                                </div>
                            )}

                            {/* Timeline Preview */}
                            {evidenceBundle.timeline_events && evidenceBundle.timeline_events.length > 0 && (
                                <div>
                                    <div style={{ fontSize: '0.7rem', color: '#999', marginBottom: '0.25rem' }}>
                                        TIMELINE ({evidenceBundle.timeline_events.length} events)
                                    </div>
                                    {evidenceBundle.timeline_events.slice(0, 1).map((event: any, idx: number) => (
                                        <div key={idx} style={{ fontSize: '0.75rem', color: '#ccc', lineHeight: '1.4' }}>
                                            {event.summary.substring(0, 120)}{event.summary.length > 120 ? '...' : ''}
                                        </div>
                                    ))}
                                </div>
                            )}

                            {/* Empty State */}
                            {validationWarnings.length === 0 && (!evidenceBundle.quotes || evidenceBundle.quotes.length === 0) && (!evidenceBundle.timeline_events || evidenceBundle.timeline_events.length === 0) && (
                                <div style={{ fontSize: '0.75rem', color: '#666', fontStyle: 'italic' }}>
                                    No evidence data available
                                </div>
                            )}
                        </div>

                        {/* Article Image Preview - Only for published articles */}
                        {post.status === 'published' && (() => {
                            const hasImage = !!(post.websiteStory?.image || post.websiteStory?.imageUrl);
                            const imageValue = post.websiteStory?.image || post.websiteStory?.imageUrl;
                            
                            // Debug: Log the structure of posts to see differences between old and new articles
                            if (!hasImage) {
                                console.warn('[Feed] Published article without image:', {
                                    postId: post.id,
                                    headline: post.websiteStory?.headline,
                                    websiteStoryKeys: Object.keys(post.websiteStory || {}),
                                    hasImageField: 'image' in (post.websiteStory || {}),
                                    hasImageUrlField: 'imageUrl' in (post.websiteStory || {}),
                                    imageValue: imageValue,
                                    imageType: typeof imageValue,
                                    createdAt: post.createdAt,
                                    updatedAt: post.updatedAt,
                                    fullWebsiteStory: post.websiteStory
                                });
                            } else {
                                console.log('[Feed] Published article WITH image:', {
                                    postId: post.id,
                                    headline: post.websiteStory?.headline,
                                    image: imageValue,
                                    imageField: post.websiteStory?.image,
                                    imageUrlField: post.websiteStory?.imageUrl
                                });
                            }
                            
                            return hasImage;
                        })() && (
                            <div style={{ 
                                width: '100%', 
                                height: '200px', 
                                borderRadius: '4px', 
                                overflow: 'hidden',
                                marginBottom: '0.75rem',
                                border: '1px solid rgba(255, 255, 255, 0.2)'
                            }}>
                                <img 
                                    src={(() => {
                                        const img = post.websiteStory.image || post.websiteStory.imageUrl || '';
                                        if (!img) return '';
                                        
                                        // Handle full URLs
                                        if (img.startsWith('http')) return img;
                                        
                                        // Handle paths that already start with /
                                        if (img.startsWith('/')) return img;
                                        
                                        // Handle paths containing /assets/images/
                                        if (img.includes('/assets/images/')) {
                                            const filename = img.split('/assets/images/').pop() || img.split('/').pop();
                                            return `/assets/images/${filename}`;
                                        }
                                        
                                        // Otherwise treat as filename
                                        return `/assets/images/${img}`;
                                    })()}
                                    alt={post.websiteStory.headline}
                                    style={{ 
                                        width: '100%', 
                                        height: '100%', 
                                        objectFit: 'cover', 
                                        objectPosition: 'top',
                                        display: 'block'
                                    }}
                                    onError={(e) => {
                                        console.error('Image failed to load:', {
                                            attemptedPath: e.currentTarget.src,
                                            postId: post.id,
                                            headline: post.websiteStory.headline,
                                            storedImage: post.websiteStory.image || post.websiteStory.imageUrl
                                        });
                                        e.currentTarget.style.display = 'none';
                                        (e.currentTarget.parentElement as HTMLElement)!.innerHTML = '<div style="width: 100%; height: 100%; background: rgba(255, 255, 255, 0.1); display: flex; align-items: center; justify-content: center; color: rgba(255, 255, 255, 0.5); font-size: 0.75rem;">Image not found</div>';
                                    }}
                                />
                            </div>
                        )}

                        {/* Article Preview Snippet */}
                        {post.websiteStory.theBackstory && (
                            <div style={{
                                padding: '0.75rem',
                                background: 'rgba(0, 0, 0, 0.2)',
                                borderRadius: '4px',
                                fontSize: '0.8rem',
                                color: '#999',
                                lineHeight: '1.5',
                                maxHeight: '60px',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis'
                            }}>
                                {post.websiteStory.theBackstory.substring(0, 150).replace(/#{1,6}\s/g, '').replace(/\*\*/g, '')}...
                            </div>
                        )}

                        {/* View Published Article Link - Only for published articles */}
                        {post.status === 'published' && (() => {
                            // Normalize league name to match static site generation
                            const leagueMap: Record<string, string> = {
                                'NBA': 'nba',
                                'NFL': 'nfl',
                                'EPL': 'epl',
                                'Premier League': 'epl',
                                'LaLiga': 'laliga',
                                'La Liga': 'laliga',
                                'Serie A': 'serie-a',
                                'Bundesliga': 'bundesliga',
                                'Ligue 1': 'ligue-1',
                                'MLB': 'mlb',
                                'NHL': 'nhl',
                                'UFC': 'ufc',
                                'Soccer': 'soccer',
                                'DFS': 'dfs'
                            };
                            const league = leagueMap[post.league] || post.league.toLowerCase().replace(/\s+/g, '-');
                            
                            // Check if SEO slug is in prediction format (new SEO-optimized format)
                            const storedSlug = post.websiteStory.seo?.slug || '';
                            const isPredictionFormat = storedSlug.includes('-prediction-preview-') && storedSlug.match(/\d{4}-\d{2}-\d{2}$/);
                            
                            let articleUrl: string;
                            if (isPredictionFormat) {
                                // Use prediction format: /{league}/{prediction-slug}/
                                articleUrl = `/${league}/${storedSlug}/`;
                            } else {
                                // Fallback to old format
                                const dateStr = post.matchupScheduledDate || post.createdAt || '';
                                const dateMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
                                const date = dateMatch ? dateMatch[0] : new Date(dateStr).toISOString().split('T')[0];
                                
                                if (storedSlug.includes('/') && storedSlug.split('/').length === 2) {
                                    // Old format: matchup-slug/narrative-slug
                                    articleUrl = `/${league}/${date}/${storedSlug}/`;
                                } else {
                                    // Fallback: Generate slug from headline
                                    const slug = post.websiteStory.headline
                                        .toLowerCase()
                                        .trim()
                                        .replace(/[^a-z0-9\s-]/g, '')
                                        .replace(/\s+/g, '-')
                                        .replace(/-+/g, '-')
                                        .replace(/^-|-$/g, '') || 'article';
                                    articleUrl = `/${league}/${date}/${slug}/`;
                                }
                            }
                            
                            return (
                                <a
                                    href={articleUrl}
                                    onClick={(e) => {
                                        e.stopPropagation(); // Don't open editor when clicking link
                                        // Open in new tab for published articles (unless already in new tab context)
                                        if (e.ctrlKey || e.metaKey || e.shiftKey) {
                                            // Allow Ctrl+Click, Cmd+Click, or Shift+Click to use default behavior
                                            return;
                                        }
                                        e.preventDefault();
                                        // Try to open in new tab, but if on React dev server, the static file won't exist yet
                                        // User will need to build static site first
                                        window.open(articleUrl, '_blank');
                                    }}
                                    title="Note: Static site must be built for this link to work. Run 'npm run build:static' after publishing."
                                    style={{
                                        display: 'inline-block',
                                        marginTop: '0.75rem',
                                        padding: '0.5rem 1rem',
                                        background: '#000',
                                        border: '2px solid #f84242',
                                        color: '#fff',
                                        textDecoration: 'none',
                                        borderRadius: '4px',
                                        fontSize: '0.75rem',
                                        fontWeight: 'bold',
                                        textTransform: 'uppercase',
                                        letterSpacing: '0.1em',
                                        transition: 'all 0.3s ease',
                                        textAlign: 'center',
                                        width: '100%',
                                        boxSizing: 'border-box'
                                    }}
                                    onMouseEnter={(e) => {
                                        e.currentTarget.style.background = '#f84242';
                                        e.currentTarget.style.borderColor = '#ff6666';
                                    }}
                                    onMouseLeave={(e) => {
                                        e.currentTarget.style.background = '#000';
                                        e.currentTarget.style.borderColor = '#f84242';
                                    }}
                                >
                                    View Published Article →
                                </a>
                            );
                        })()}

                        {/* Create Tweet & Reddit Button - Only for published DFS articles */}
                        {post.status === 'published' && post.storyType === 'dfs_article' && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedPostForTweet(post);
                                    setShowTweetModal(true);
                                    setSelectedPlayerIndex(0);
                                    setGeneratedTweet('');
                                    setGeneratedReddit(null);
                                    setActiveTab('tweet');
                                }}
                                style={{
                                    display: 'inline-block',
                                    marginTop: '0.75rem',
                                    padding: '0.5rem 1rem',
                                    background: '#000',
                                    border: '2px solid #00ff41',
                                    color: '#fff',
                                    textDecoration: 'none',
                                    borderRadius: '4px',
                                    fontSize: '0.75rem',
                                    fontWeight: 'bold',
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.1em',
                                    transition: 'all 0.3s ease',
                                    textAlign: 'center',
                                    width: '100%',
                                    boxSizing: 'border-box',
                                    cursor: 'pointer'
                                }}
                                onMouseEnter={(e) => {
                                    e.currentTarget.style.background = '#00ff41';
                                    e.currentTarget.style.borderColor = '#00ff41';
                                    e.currentTarget.style.color = '#000';
                                }}
                                onMouseLeave={(e) => {
                                    e.currentTarget.style.background = '#000';
                                    e.currentTarget.style.borderColor = '#00ff41';
                                    e.currentTarget.style.color = '#fff';
                                }}
                            >
                                🐦 Create Tweet & Reddit Post →
                            </button>
                        )}

                        {/* Create Tweet & Reddit Button - Only for published Heat Articles */}
                        {post.status === 'published' && post.storyType === 'heat_article' && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedPostForHeatArticle(post);
                                    setShowHeatArticleModal(true);
                                    setSelectedNarrativeIndex(0);
                                    setGeneratedHeatTweet('');
                                    setGeneratedHeatReddit(null);
                                    setActiveHeatTab('tweet');
                                }}
                                style={{
                                    display: 'inline-block',
                                    marginTop: '0.75rem',
                                    padding: '0.5rem 1rem',
                                    background: '#000',
                                    border: '2px solid #f84242',
                                    color: '#fff',
                                    textDecoration: 'none',
                                    borderRadius: '4px',
                                    fontSize: '0.75rem',
                                    fontWeight: 'bold',
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.1em',
                                    transition: 'all 0.3s ease',
                                    textAlign: 'center',
                                    width: '100%',
                                    boxSizing: 'border-box',
                                    cursor: 'pointer'
                                }}
                                onMouseEnter={(e) => {
                                    e.currentTarget.style.background = '#f84242';
                                    e.currentTarget.style.borderColor = '#f84242';
                                    e.currentTarget.style.color = '#fff';
                                }}
                                onMouseLeave={(e) => {
                                    e.currentTarget.style.background = '#000';
                                    e.currentTarget.style.borderColor = '#f84242';
                                    e.currentTarget.style.color = '#fff';
                                }}
                            >
                                🐦 Create Tweet & Reddit Post →
                            </button>
                        )}
                    </div>
                );
            })}
            </div>
            
            {/* Pagination Footer */}
            {totalPages > 1 && (
                <div style={{ marginTop: '1.5rem', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '0.5rem', padding: '0.75rem', background: 'rgba(255, 255, 255, 0.05)', borderRadius: '4px' }}>
                    <button
                        onClick={() => setCurrentPage(1)}
                        disabled={currentPage === 1}
                        style={{
                            padding: '0.5rem 1rem',
                            background: currentPage === 1 ? 'rgba(255, 255, 255, 0.1)' : 'rgba(255, 255, 255, 0.2)',
                            border: '1px solid rgba(255, 255, 255, 0.3)',
                            borderRadius: '4px',
                            color: currentPage === 1 ? 'rgba(255, 255, 255, 0.3)' : '#fff',
                            cursor: currentPage === 1 ? 'not-allowed' : 'pointer',
                            fontSize: '0.75rem',
                            fontWeight: 'bold'
                        }}
                    >
                        First
                    </button>
                    {Array.from({ length: totalPages }, (_, i) => i + 1)
                        .filter(page => {
                            // Show first page, last page, current page, and pages around current
                            return page === 1 || 
                                   page === totalPages || 
                                   (page >= currentPage - 1 && page <= currentPage + 1);
                        })
                        .map((page, idx, arr) => {
                            // Add ellipsis if there's a gap
                            const showEllipsisBefore = idx > 0 && arr[idx] - arr[idx - 1] > 1;
                            return (
                                <React.Fragment key={page}>
                                    {showEllipsisBefore && (
                                        <span style={{ color: 'rgba(255, 255, 255, 0.5)', padding: '0 0.25rem' }}>...</span>
                                    )}
                                    <button
                                        onClick={() => setCurrentPage(page)}
                                        style={{
                                            padding: '0.5rem 0.75rem',
                                            background: currentPage === page ? 'rgba(0, 255, 65, 0.3)' : 'rgba(255, 255, 255, 0.1)',
                                            border: `1px solid ${currentPage === page ? 'rgba(0, 255, 65, 0.5)' : 'rgba(255, 255, 255, 0.3)'}`,
                                            borderRadius: '4px',
                                            color: currentPage === page ? '#00ff41' : '#fff',
                                            cursor: 'pointer',
                                            fontSize: '0.75rem',
                                            fontWeight: 'bold',
                                            minWidth: '40px'
                                        }}
                                    >
                                        {page}
                                    </button>
                                </React.Fragment>
                            );
                        })}
                    <button
                        onClick={() => setCurrentPage(totalPages)}
                        disabled={currentPage === totalPages}
                        style={{
                            padding: '0.5rem 1rem',
                            background: currentPage === totalPages ? 'rgba(255, 255, 255, 0.1)' : 'rgba(255, 255, 255, 0.2)',
                            border: '1px solid rgba(255, 255, 255, 0.3)',
                            borderRadius: '4px',
                            color: currentPage === totalPages ? 'rgba(255, 255, 255, 0.3)' : '#fff',
                            cursor: currentPage === totalPages ? 'not-allowed' : 'pointer',
                            fontSize: '0.75rem',
                            fontWeight: 'bold'
                        }}
                    >
                        Last
                    </button>
                </div>
            )}

            {/* Tweet Generation Modal */}
            {showTweetModal && selectedPostForTweet && (
                <div
                    style={{
                        position: 'fixed',
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        backgroundColor: 'rgba(0, 0, 0, 0.8)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        zIndex: 10000,
                        padding: '2rem'
                    }}
                    onClick={(e) => {
                        if (e.target === e.currentTarget) {
                            setShowTweetModal(false);
                        }
                    }}
                >
                    <div
                        style={{
                            background: '#1a1a1a',
                            border: '2px solid #00ff41',
                            borderRadius: '8px',
                            padding: '2rem',
                            maxWidth: '800px',
                            width: '100%',
                            maxHeight: '90vh',
                            overflow: 'auto',
                            position: 'relative'
                        }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Close Button */}
                        <button
                            onClick={() => setShowTweetModal(false)}
                            style={{
                                position: 'absolute',
                                top: '1rem',
                                right: '1rem',
                                background: '#dc3545',
                                color: '#fff',
                                border: 'none',
                                borderRadius: '4px',
                                padding: '0.5rem 0.75rem',
                                cursor: 'pointer',
                                fontSize: '0.75rem',
                                fontWeight: 'bold'
                            }}
                        >
                            ✕ Close
                        </button>

                        <h2 style={{ color: '#00ff41', marginTop: 0, marginBottom: '1.5rem' }}>
                            Create Tweet & Reddit Post for DFS Article
                        </h2>

                        {/* Player Selector */}
                        <div style={{ marginBottom: '1.5rem' }}>
                            <label style={{ display: 'block', color: '#fff', marginBottom: '0.5rem', fontWeight: 'bold' }}>
                                Select Player:
                            </label>
                            <select
                                value={selectedPlayerIndex}
                                onChange={(e) => {
                                    setSelectedPlayerIndex(parseInt(e.target.value));
                                    setGeneratedTweet('');
                                    setGeneratedReddit(null);
                                }}
                                style={{
                                    width: '100%',
                                    padding: '0.75rem',
                                    background: '#000',
                                    border: '1px solid #00ff41',
                                    color: '#fff',
                                    borderRadius: '4px',
                                    fontSize: '1rem',
                                    cursor: 'pointer'
                                }}
                            >
                                {(selectedPostForTweet.heatCheckData?.dfsPlayers || []).map((player: any, index: number) => (
                                    <option key={index} value={index}>
                                        #{player.rank} - {player.playerName} ({player.position}) - {player.team} vs {player.opponent} - ${player.salary}
                                    </option>
                                ))}
                            </select>
                        </div>

                        {/* Generate Button */}
                        <button
                            onClick={handleGenerateTweet}
                            disabled={isGeneratingTweet}
                            style={{
                                width: '100%',
                                padding: '0.75rem',
                                background: isGeneratingTweet ? '#666' : '#00ff41',
                                color: '#000',
                                border: 'none',
                                borderRadius: '4px',
                                fontSize: '1rem',
                                fontWeight: 'bold',
                                cursor: isGeneratingTweet ? 'not-allowed' : 'pointer',
                                marginBottom: '1.5rem',
                                transition: 'all 0.2s'
                            }}
                        >
                            {isGeneratingTweet ? 'Generating Content...' : 'Generate Tweet & Reddit Post'}
                        </button>

                        {/* Generated Content Display with Tabs */}
                        {(generatedTweet || generatedReddit) && (
                            <div>
                                {/* Tab Headers */}
                                <div style={{ 
                                    display: 'flex', 
                                    gap: '0.5rem', 
                                    marginBottom: '1rem',
                                    borderBottom: '2px solid #333'
                                }}>
                                    <button
                                        onClick={() => setActiveTab('tweet')}
                                        disabled={!generatedTweet}
                                        style={{
                                            padding: '0.75rem 1.5rem',
                                            background: activeTab === 'tweet' ? '#00ff41' : 'transparent',
                                            color: activeTab === 'tweet' ? '#000' : generatedTweet ? '#00ff41' : '#666',
                                            border: 'none',
                                            borderBottom: activeTab === 'tweet' ? '2px solid #00ff41' : '2px solid transparent',
                                            borderRadius: '4px 4px 0 0',
                                            fontSize: '0.9rem',
                                            fontWeight: 'bold',
                                            cursor: generatedTweet ? 'pointer' : 'not-allowed',
                                            transition: 'all 0.2s',
                                            marginBottom: '-2px'
                                        }}
                                    >
                                        🐦 Tweet
                                    </button>
                                    <button
                                        onClick={() => setActiveTab('reddit')}
                                        disabled={!generatedReddit}
                                        style={{
                                            padding: '0.75rem 1.5rem',
                                            background: activeTab === 'reddit' ? '#ff4500' : 'transparent',
                                            color: activeTab === 'reddit' ? '#fff' : generatedReddit ? '#ff4500' : '#666',
                                            border: 'none',
                                            borderBottom: activeTab === 'reddit' ? '2px solid #ff4500' : '2px solid transparent',
                                            borderRadius: '4px 4px 0 0',
                                            fontSize: '0.9rem',
                                            fontWeight: 'bold',
                                            cursor: generatedReddit ? 'pointer' : 'not-allowed',
                                            transition: 'all 0.2s',
                                            marginBottom: '-2px'
                                        }}
                                    >
                                        📱 Reddit Post
                                    </button>
                                </div>

                                {/* Tab Content */}
                                <div>
                                    {/* Tweet Tab Content */}
                                    {activeTab === 'tweet' && generatedTweet && (
                                        <div>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                                                <label style={{ color: '#00ff41', fontWeight: 'bold', fontSize: '1rem' }}>
                                                    Generated Tweet
                                                </label>
                                                <button
                                                    onClick={handleCopyTweet}
                                                    style={{
                                                        padding: '0.5rem 1rem',
                                                        background: '#000',
                                                        border: '1px solid #00ff41',
                                                        color: '#00ff41',
                                                        borderRadius: '4px',
                                                        fontSize: '0.75rem',
                                                        fontWeight: 'bold',
                                                        cursor: 'pointer',
                                                        transition: 'all 0.2s'
                                                    }}
                                                    onMouseEnter={(e) => {
                                                        e.currentTarget.style.background = '#00ff41';
                                                        e.currentTarget.style.color = '#000';
                                                    }}
                                                    onMouseLeave={(e) => {
                                                        e.currentTarget.style.background = '#000';
                                                        e.currentTarget.style.color = '#00ff41';
                                                    }}
                                                >
                                                    📋 Copy to Clipboard
                                                </button>
                                            </div>
                                            <textarea
                                                value={generatedTweet}
                                                readOnly
                                                style={{
                                                    width: '100%',
                                                    minHeight: '400px',
                                                    padding: '1rem',
                                                    background: '#000',
                                                    border: '1px solid #00ff41',
                                                    color: '#fff',
                                                    borderRadius: '4px',
                                                    fontSize: '0.9rem',
                                                    fontFamily: 'monospace',
                                                    lineHeight: '1.6',
                                                    resize: 'vertical'
                                                }}
                                            />
                                        </div>
                                    )}

                                    {/* Reddit Tab Content */}
                                    {activeTab === 'reddit' && generatedReddit && (
                                        <div>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                                                <label style={{ color: '#ff4500', fontWeight: 'bold', fontSize: '1rem' }}>
                                                    Generated Reddit Post
                                                </label>
                                                <button
                                                    onClick={handleCopyReddit}
                                                    style={{
                                                        padding: '0.5rem 1rem',
                                                        background: '#000',
                                                        border: '1px solid #ff4500',
                                                        color: '#ff4500',
                                                        borderRadius: '4px',
                                                        fontSize: '0.75rem',
                                                        fontWeight: 'bold',
                                                        cursor: 'pointer',
                                                        transition: 'all 0.2s'
                                                    }}
                                                    onMouseEnter={(e) => {
                                                        e.currentTarget.style.background = '#ff4500';
                                                        e.currentTarget.style.color = '#fff';
                                                    }}
                                                    onMouseLeave={(e) => {
                                                        e.currentTarget.style.background = '#000';
                                                        e.currentTarget.style.color = '#ff4500';
                                                    }}
                                                >
                                                    📋 Copy to Clipboard
                                                </button>
                                            </div>
                                            
                                            {/* Reddit Title */}
                                            <div style={{ marginBottom: '1rem' }}>
                                                <label style={{ display: 'block', color: '#fff', marginBottom: '0.5rem', fontWeight: 'bold', fontSize: '0.9rem' }}>
                                                    Title:
                                                </label>
                                                <textarea
                                                    value={generatedReddit.title}
                                                    readOnly
                                                    style={{
                                                        width: '100%',
                                                        minHeight: '60px',
                                                        padding: '0.75rem',
                                                        background: '#000',
                                                        border: '1px solid #ff4500',
                                                        color: '#fff',
                                                        borderRadius: '4px',
                                                        fontSize: '0.9rem',
                                                        fontFamily: 'monospace',
                                                        resize: 'vertical'
                                                    }}
                                                />
                                            </div>

                                            {/* Reddit Body */}
                                            <div>
                                                <label style={{ display: 'block', color: '#fff', marginBottom: '0.5rem', fontWeight: 'bold', fontSize: '0.9rem' }}>
                                                    Body:
                                                </label>
                                                <textarea
                                                    value={generatedReddit.body}
                                                    readOnly
                                                    style={{
                                                        width: '100%',
                                                        minHeight: '400px',
                                                        padding: '1rem',
                                                        background: '#000',
                                                        border: '1px solid #ff4500',
                                                        color: '#fff',
                                                        borderRadius: '4px',
                                                        fontSize: '0.9rem',
                                                        fontFamily: 'monospace',
                                                        lineHeight: '1.6',
                                                        resize: 'vertical'
                                                    }}
                                                />
                                            </div>
                                        </div>
                                    )}

                                    {/* Loading/Empty State */}
                                    {!generatedTweet && !generatedReddit && (
                                        <div style={{ 
                                            padding: '2rem', 
                                            textAlign: 'center', 
                                            color: '#999',
                                            fontStyle: 'italic'
                                        }}>
                                            Content will appear here after generation...
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Heat Article Content Generation Modal */}
            {showHeatArticleModal && selectedPostForHeatArticle && (
                <div
                    style={{
                        position: 'fixed',
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        backgroundColor: 'rgba(0, 0, 0, 0.8)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        zIndex: 10000,
                        padding: '2rem'
                    }}
                    onClick={(e) => {
                        if (e.target === e.currentTarget) {
                            setShowHeatArticleModal(false);
                        }
                    }}
                >
                    <div
                        style={{
                            background: '#1a1a1a',
                            border: '2px solid #f84242',
                            borderRadius: '8px',
                            padding: '2rem',
                            maxWidth: '800px',
                            width: '100%',
                            maxHeight: '90vh',
                            overflow: 'auto',
                            position: 'relative'
                        }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Close Button */}
                        <button
                            onClick={() => setShowHeatArticleModal(false)}
                            style={{
                                position: 'absolute',
                                top: '1rem',
                                right: '1rem',
                                background: '#dc3545',
                                color: '#fff',
                                border: 'none',
                                borderRadius: '4px',
                                padding: '0.5rem 0.75rem',
                                cursor: 'pointer',
                                fontSize: '0.75rem',
                                fontWeight: 'bold'
                            }}
                        >
                            ✕ Close
                        </button>

                        <h2 style={{ color: '#f84242', marginTop: 0, marginBottom: '1.5rem' }}>
                            Create Tweet & Reddit Post for Heat Article
                        </h2>

                        {/* Narrative Selector */}
                        <div style={{ marginBottom: '1.5rem' }}>
                            <label style={{ display: 'block', color: '#fff', marginBottom: '0.5rem', fontWeight: 'bold' }}>
                                Select Narrative:
                            </label>
                            <select
                                value={selectedNarrativeIndex}
                                onChange={(e) => {
                                    setSelectedNarrativeIndex(parseInt(e.target.value));
                                    setGeneratedHeatTweet('');
                                    setGeneratedHeatReddit(null);
                                }}
                                style={{
                                    width: '100%',
                                    padding: '0.75rem',
                                    background: '#000',
                                    border: '1px solid #f84242',
                                    color: '#fff',
                                    borderRadius: '4px',
                                    fontSize: '1rem',
                                    cursor: 'pointer'
                                }}
                            >
                                {(selectedPostForHeatArticle.heatCheckData?.narratives?.candidate_cards || []).map((narrative: any, index: number) => {
                                    const isPrimary = narrative.narrative_id === (selectedPostForHeatArticle.heatCheckData?.narratives?.selected?.primary_narrative_id || '');
                                    return (
                                        <option key={index} value={index}>
                                            {isPrimary ? '⭐ ' : ''}{narrative.title} - {narrative.claim.substring(0, 60)}...
                                        </option>
                                    );
                                })}
                            </select>
                        </div>

                        {/* Generate Button */}
                        <button
                            onClick={handleGenerateHeatArticleContent}
                            disabled={isGeneratingHeatContent}
                            style={{
                                width: '100%',
                                padding: '0.75rem',
                                background: isGeneratingHeatContent ? '#666' : '#f84242',
                                color: '#fff',
                                border: 'none',
                                borderRadius: '4px',
                                fontSize: '1rem',
                                fontWeight: 'bold',
                                cursor: isGeneratingHeatContent ? 'not-allowed' : 'pointer',
                                marginBottom: '1.5rem',
                                transition: 'all 0.2s'
                            }}
                        >
                            {isGeneratingHeatContent ? 'Generating Content...' : 'Generate Tweet & Reddit Post'}
                        </button>

                        {/* Generated Content Display with Tabs */}
                        {(generatedHeatTweet || generatedHeatReddit) && (
                            <div>
                                {/* Tab Headers */}
                                <div style={{ 
                                    display: 'flex', 
                                    gap: '0.5rem', 
                                    marginBottom: '1rem',
                                    borderBottom: '2px solid #333'
                                }}>
                                    <button
                                        onClick={() => setActiveHeatTab('tweet')}
                                        disabled={!generatedHeatTweet}
                                        style={{
                                            padding: '0.75rem 1.5rem',
                                            background: activeHeatTab === 'tweet' ? '#f84242' : 'transparent',
                                            color: activeHeatTab === 'tweet' ? '#fff' : generatedHeatTweet ? '#f84242' : '#666',
                                            border: 'none',
                                            borderBottom: activeHeatTab === 'tweet' ? '2px solid #f84242' : '2px solid transparent',
                                            borderRadius: '4px 4px 0 0',
                                            fontSize: '0.9rem',
                                            fontWeight: 'bold',
                                            cursor: generatedHeatTweet ? 'pointer' : 'not-allowed',
                                            transition: 'all 0.2s',
                                            marginBottom: '-2px'
                                        }}
                                    >
                                        🐦 Tweet
                                    </button>
                                    <button
                                        onClick={() => setActiveHeatTab('reddit')}
                                        disabled={!generatedHeatReddit}
                                        style={{
                                            padding: '0.75rem 1.5rem',
                                            background: activeHeatTab === 'reddit' ? '#ff4500' : 'transparent',
                                            color: activeHeatTab === 'reddit' ? '#fff' : generatedHeatReddit ? '#ff4500' : '#666',
                                            border: 'none',
                                            borderBottom: activeHeatTab === 'reddit' ? '2px solid #ff4500' : '2px solid transparent',
                                            borderRadius: '4px 4px 0 0',
                                            fontSize: '0.9rem',
                                            fontWeight: 'bold',
                                            cursor: generatedHeatReddit ? 'pointer' : 'not-allowed',
                                            transition: 'all 0.2s',
                                            marginBottom: '-2px'
                                        }}
                                    >
                                        🔴 Reddit
                                    </button>
                                </div>

                                {/* Tab Content */}
                                <div style={{ 
                                    padding: '1.5rem',
                                    background: '#000',
                                    borderRadius: '0 0 4px 4px',
                                    border: '1px solid #333',
                                    borderTop: 'none'
                                }}>
                                    {activeHeatTab === 'tweet' && generatedHeatTweet && (
                                        <div>
                                            <div style={{ 
                                                display: 'flex', 
                                                justifyContent: 'space-between', 
                                                alignItems: 'center',
                                                marginBottom: '1rem'
                                            }}>
                                                <label style={{ color: '#fff', fontWeight: 'bold', fontSize: '0.9rem' }}>
                                                    Tweet Content:
                                                </label>
                                                <button
                                                    onClick={handleCopyHeatTweet}
                                                    style={{
                                                        padding: '0.5rem 1rem',
                                                        background: '#f84242',
                                                        color: '#fff',
                                                        border: 'none',
                                                        borderRadius: '4px',
                                                        fontSize: '0.85rem',
                                                        fontWeight: 'bold',
                                                        cursor: 'pointer',
                                                        transition: 'all 0.2s'
                                                    }}
                                                    onMouseEnter={(e) => {
                                                        e.currentTarget.style.background = '#ff6666';
                                                    }}
                                                    onMouseLeave={(e) => {
                                                        e.currentTarget.style.background = '#f84242';
                                                    }}
                                                >
                                                    📋 Copy Tweet
                                                </button>
                                            </div>
                                            <textarea
                                                value={generatedHeatTweet}
                                                readOnly
                                                style={{
                                                    width: '100%',
                                                    minHeight: '300px',
                                                    padding: '1rem',
                                                    background: '#000',
                                                    border: '1px solid #f84242',
                                                    color: '#fff',
                                                    borderRadius: '4px',
                                                    fontSize: '0.9rem',
                                                    fontFamily: 'monospace',
                                                    lineHeight: '1.6',
                                                    resize: 'vertical'
                                                }}
                                            />
                                        </div>
                                    )}

                                    {activeHeatTab === 'reddit' && generatedHeatReddit && (
                                        <div>
                                            <div style={{ 
                                                display: 'flex', 
                                                justifyContent: 'space-between', 
                                                alignItems: 'center',
                                                marginBottom: '1rem'
                                            }}>
                                                <label style={{ color: '#fff', fontWeight: 'bold', fontSize: '0.9rem' }}>
                                                    Reddit Post:
                                                </label>
                                                <button
                                                    onClick={handleCopyHeatReddit}
                                                    style={{
                                                        padding: '0.5rem 1rem',
                                                        background: '#ff4500',
                                                        color: '#fff',
                                                        border: 'none',
                                                        borderRadius: '4px',
                                                        fontSize: '0.85rem',
                                                        fontWeight: 'bold',
                                                        cursor: 'pointer',
                                                        transition: 'all 0.2s'
                                                    }}
                                                    onMouseEnter={(e) => {
                                                        e.currentTarget.style.background = '#ff6633';
                                                    }}
                                                    onMouseLeave={(e) => {
                                                        e.currentTarget.style.background = '#ff4500';
                                                    }}
                                                >
                                                    📋 Copy Reddit Post
                                                </button>
                                            </div>

                                            {/* Reddit Title */}
                                            <div style={{ marginBottom: '1rem' }}>
                                                <label style={{ display: 'block', color: '#fff', marginBottom: '0.5rem', fontWeight: 'bold', fontSize: '0.9rem' }}>
                                                    Title:
                                                </label>
                                                <textarea
                                                    value={generatedHeatReddit.title}
                                                    readOnly
                                                    style={{
                                                        width: '100%',
                                                        minHeight: '60px',
                                                        padding: '0.75rem',
                                                        background: '#000',
                                                        border: '1px solid #ff4500',
                                                        color: '#fff',
                                                        borderRadius: '4px',
                                                        fontSize: '0.9rem',
                                                        fontFamily: 'monospace',
                                                        resize: 'vertical'
                                                    }}
                                                />
                                            </div>

                                            {/* Reddit Body */}
                                            <div>
                                                <label style={{ display: 'block', color: '#fff', marginBottom: '0.5rem', fontWeight: 'bold', fontSize: '0.9rem' }}>
                                                    Body:
                                                </label>
                                                <textarea
                                                    value={generatedHeatReddit.body}
                                                    readOnly
                                                    style={{
                                                        width: '100%',
                                                        minHeight: '400px',
                                                        padding: '1rem',
                                                        background: '#000',
                                                        border: '1px solid #ff4500',
                                                        color: '#fff',
                                                        borderRadius: '4px',
                                                        fontSize: '0.9rem',
                                                        fontFamily: 'monospace',
                                                        lineHeight: '1.6',
                                                        resize: 'vertical'
                                                    }}
                                                />
                                            </div>
                                        </div>
                                    )}

                                    {/* Loading/Empty State */}
                                    {!generatedHeatTweet && !generatedHeatReddit && (
                                        <div style={{ 
                                            padding: '2rem', 
                                            textAlign: 'center', 
                                            color: '#999',
                                            fontStyle: 'italic'
                                        }}>
                                            Content will appear here after generation...
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Narrative Selection Modal for Viral Content */}
            {showNarrativeSelectionModal && selectedPostForViral && (
                <div
                    style={{
                        position: 'fixed',
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        backgroundColor: 'rgba(0, 0, 0, 0.8)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        zIndex: 10000,
                        padding: '2rem'
                    }}
                    onClick={(e) => {
                        if (e.target === e.currentTarget) {
                            setShowNarrativeSelectionModal(false);
                        }
                    }}
                >
                    <div
                        style={{
                            background: '#1a1a1a',
                            border: '2px solid #4caf50',
                            borderRadius: '8px',
                            padding: '2rem',
                            maxWidth: '700px',
                            width: '100%',
                            maxHeight: '90vh',
                            overflow: 'auto',
                            position: 'relative'
                        }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <button
                            onClick={() => setShowNarrativeSelectionModal(false)}
                            style={{
                                position: 'absolute',
                                top: '1rem',
                                right: '1rem',
                                background: '#dc3545',
                                color: '#fff',
                                border: 'none',
                                borderRadius: '4px',
                                padding: '0.5rem 0.75rem',
                                cursor: 'pointer',
                                fontSize: '0.75rem',
                                fontWeight: 'bold'
                            }}
                        >
                            ✕ Close
                        </button>

                        <h2 style={{ color: '#4caf50', marginTop: 0, marginBottom: '1.5rem' }}>
                            Select Narrative for Content Generation
                        </h2>

                        <div style={{ marginBottom: '1.5rem' }}>
                            <p style={{ color: '#ccc', fontSize: '0.9rem', marginBottom: '1rem' }}>
                                Choose a narrative card to generate viral content using the 5-state framework:
                            </p>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                                {(selectedPostForViral.heatCheckData?.narratives?.candidate_cards || []).map((card: any, index: number) => {
                                    const isPrimary = card.narrative_id === (selectedPostForViral.heatCheckData?.narratives?.selected?.primary_narrative_id || '');
                                    return (
                                        <div
                                            key={index}
                                            onClick={() => {
                                                setSelectedNarrativeCard(card);
                                            }}
                                            style={{
                                                padding: '1rem',
                                                background: selectedNarrativeCard?.narrative_id === card.narrative_id ? 'rgba(76, 175, 80, 0.2)' : 'rgba(255, 255, 255, 0.05)',
                                                border: selectedNarrativeCard?.narrative_id === card.narrative_id ? '2px solid #4caf50' : '1px solid #333',
                                                borderRadius: '4px',
                                                cursor: 'pointer',
                                                transition: 'all 0.2s'
                                            }}
                                            onMouseEnter={(e) => {
                                                if (selectedNarrativeCard?.narrative_id !== card.narrative_id) {
                                                    e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
                                                }
                                            }}
                                            onMouseLeave={(e) => {
                                                if (selectedNarrativeCard?.narrative_id !== card.narrative_id) {
                                                    e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)';
                                                }
                                            }}
                                        >
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                                                {isPrimary && <span style={{ color: '#4caf50', fontWeight: 'bold' }}>⭐ PRIMARY</span>}
                                                <strong style={{ color: '#fff', fontSize: '1rem' }}>{card.title}</strong>
                                            </div>
                                            <p style={{ color: '#ccc', fontSize: '0.85rem', marginBottom: '0.5rem', lineHeight: '1.5' }}>
                                                {card.claim}
                                            </p>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.75rem', color: '#999' }}>
                                                <span>Score: <strong style={{ color: '#f84242' }}>{card.total_score || 0}/35</strong></span>
                                                <span>{card.emotion_tags?.slice(0, 3).join(', ') || ''}</span>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        <button
                            onClick={async () => {
                                if (!selectedNarrativeCard) {
                                    alert('Please select a narrative card');
                                    return;
                                }
                                setShowNarrativeSelectionModal(false);
                                setShowContentPreviewModal(true);
                                setIsGeneratingViralContent(true);
                                setGeneratedViralContent(null);
                                
                                try {
                                    const heatCheckData = selectedPostForViral.heatCheckData || {};
                                    const evidenceBundle = heatCheckData.evidenceBundle || heatCheckData.evidence_bundle || {};
                                    
                                    // For V3 articles, use matchPackV3 data (from stats DB) - it has richer stats
                                    const matchPackV3 = heatCheckData.matchPackV3;
                                    let factPack = heatCheckData.factPack || {};
                                    
                                    // Extract ALL available stats from matchPackV3
                                    if (matchPackV3?.factDrop) {
                                        const factDrop = matchPackV3.factDrop;
                                        const bullets = Array.isArray(factDrop.bullets) ? factDrop.bullets : [];
                                        const comparisons = Array.isArray(factDrop.comparisons) ? factDrop.comparisons : [];
                                        const sections = Array.isArray(factDrop.sections) ? factDrop.sections : [];
                                        
                                        // Build comprehensive key_stats from ALL sources
                                        const keyStats = [
                                            ...bullets.map((b: any) => ({
                                                label: b.label || '',
                                                value: b.display || '',
                                                why_it_matters: b.context || b.note || '',
                                                key: b.key || ''
                                            })),
                                            ...comparisons.map((c: any) => ({
                                                label: c.label || '',
                                                value: c.display || '',
                                                why_it_matters: c.context || c.note || '',
                                                key: c.key || ''
                                            }))
                                        ];
                                        
                                        // Extract form leaders with detailed stats
                                        const formLeadersSection = sections.find((s: any) => s.key === 'formLeaders');
                                        const formLeaders = formLeadersSection?.priorityPlayers || formLeadersSection?.itemsDetailed || [];
                                        
                                        // Extract team form with detailed metrics
                                        const teamFormA = factDrop.raw?.teamForm?.A || {};
                                        const teamFormB = factDrop.raw?.teamForm?.B || {};
                                        const recentForm = {
                                            home: teamFormA.winLoss10 || teamFormA.record || '',
                                            away: teamFormB.winLoss10 || teamFormB.record || '',
                                            // Add detailed metrics
                                            margin10: {
                                                A: teamFormA.margin10 || 0,
                                                B: teamFormB.margin10 || 0
                                            },
                                            margin3: {
                                                A: teamFormA.margin3 || 0,
                                                B: teamFormB.margin3 || 0
                                            },
                                            offensiveRating: {
                                                A: teamFormA.offensiveRating10 || 0,
                                                B: teamFormB.offensiveRating10 || 0
                                            },
                                            defensiveRating: {
                                                A: teamFormA.defensiveRating10 || 0,
                                                B: teamFormB.defensiveRating10 || 0
                                            }
                                        };
                                        
                                        // Extract injuries/availability with more detail
                                        const availability = factDrop.raw?.availability || {};
                                        const majorAbsences = availability.majorAbsences || {};
                                        const injuries: Array<{ name: string; team: string; status: string; reason?: string }> = [];
                                        
                                        if (majorAbsences.A?.players) {
                                            majorAbsences.A.players.forEach((p: any) => {
                                                injuries.push({
                                                    name: p.player_name || p.name || '',
                                                    team: selectedPostForViral.teamA,
                                                    status: p.status || p.availability_status || 'OUT',
                                                    reason: p.reason || ''
                                                });
                                            });
                                        }
                                        if (majorAbsences.B?.players) {
                                            majorAbsences.B.players.forEach((p: any) => {
                                                injuries.push({
                                                    name: p.player_name || p.name || '',
                                                    team: selectedPostForViral.teamB,
                                                    status: p.status || p.availability_status || 'OUT',
                                                    reason: p.reason || ''
                                                });
                                            });
                                        }
                                        
                                        // Build comprehensive factPack with ALL available data
                                        factPack = {
                                            key_stats: keyStats,
                                            context: {
                                                recent_form: recentForm,
                                                injuries: injuries,
                                                standings: matchPackV3.standings || {},
                                                venue: matchPackV3.matchup?.venue || {}
                                            },
                                            odds: matchPackV3.odds || {},
                                            // Include ALL sections for rich context
                                            formLeaders: formLeaders,
                                            comparisons: comparisons,
                                            sections: sections,
                                            bullets: bullets,
                                            // Include raw data for deep stats
                                            raw: {
                                                teamForm: factDrop.raw?.teamForm || {},
                                                availability: availability,
                                                headToHead: factDrop.raw?.headToHead || {}
                                            }
                                        };
                                    }
                                    
                                    // Extract narrative strengtheners from the narrative card
                                    const narrativeStrengtheners = {
                                        scoreBreakdown: selectedNarrativeCard.score_breakdown || {},
                                        totalScore: selectedNarrativeCard.total_score || 0,
                                        riskNotes: selectedNarrativeCard.risk_notes || [],
                                        evidenceRequirementsMet: selectedNarrativeCard.evidence_requirements_met || false,
                                        mustCiteSourceIds: selectedNarrativeCard.must_cite_source_ids || []
                                    };
                                    
                                    const context = {
                                        teamA: selectedPostForViral.teamA,
                                        teamB: selectedPostForViral.teamB,
                                        league: selectedPostForViral.league,
                                        matchupDate: selectedPostForViral.matchupScheduledDate || new Date().toISOString().split('T')[0],
                                        evidenceBundle: {
                                            quotes: evidenceBundle.quotes || [],
                                            timeline_events: evidenceBundle.timeline_events || [],
                                            sources: evidenceBundle.sources || []
                                        },
                                        factPack: factPack,
                                        narrativeStrengtheners: narrativeStrengtheners, // NEW: Add narrative strengtheners
                                        articleMarkdown: heatCheckData.article?.long_form_markdown
                                    };
                                    
                                    const content = await generateViralContentFromNarrative(selectedNarrativeCard, context);
                                    setGeneratedViralContent(content);
                                } catch (error: any) {
                                    console.error('Error generating viral content:', error);
                                    alert(`Failed to generate content: ${error.message}`);
                                } finally {
                                    setIsGeneratingViralContent(false);
                                }
                            }}
                            disabled={!selectedNarrativeCard || isGeneratingViralContent}
                            style={{
                                width: '100%',
                                padding: '0.75rem',
                                background: (!selectedNarrativeCard || isGeneratingViralContent) ? '#666' : '#4caf50',
                                color: '#fff',
                                border: 'none',
                                borderRadius: '4px',
                                fontSize: '1rem',
                                fontWeight: 'bold',
                                cursor: (!selectedNarrativeCard || isGeneratingViralContent) ? 'not-allowed' : 'pointer',
                                transition: 'all 0.2s'
                            }}
                        >
                            {isGeneratingViralContent ? 'Generating...' : 'Generate Content'}
                        </button>
                    </div>
                </div>
            )}

            {/* Content Preview Modal */}
            {showContentPreviewModal && selectedPostForViral && (
                <div
                    style={{
                        position: 'fixed',
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        backgroundColor: 'rgba(0, 0, 0, 0.8)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        zIndex: 10001,
                        padding: '2rem'
                    }}
                    onClick={(e) => {
                        if (e.target === e.currentTarget) {
                            setShowContentPreviewModal(false);
                        }
                    }}
                >
                    <div
                        style={{
                            background: '#1a1a1a',
                            border: '2px solid #4caf50',
                            borderRadius: '8px',
                            padding: '2rem',
                            maxWidth: '900px',
                            width: '100%',
                            maxHeight: '90vh',
                            overflow: 'auto',
                            position: 'relative'
                        }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <button
                            onClick={() => setShowContentPreviewModal(false)}
                            style={{
                                position: 'absolute',
                                top: '1rem',
                                right: '1rem',
                                background: '#dc3545',
                                color: '#fff',
                                border: 'none',
                                borderRadius: '4px',
                                padding: '0.5rem 0.75rem',
                                cursor: 'pointer',
                                fontSize: '0.75rem',
                                fontWeight: 'bold'
                            }}
                        >
                            ✕ Close
                        </button>

                        <h2 style={{ color: '#4caf50', marginTop: 0, marginBottom: '1.5rem' }}>
                            Generated Viral Content
                        </h2>

                        {isGeneratingViralContent ? (
                            <div style={{ textAlign: 'center', padding: '3rem' }}>
                                <div className="loader">Generating viral content...</div>
                                <p style={{ color: '#ccc', marginTop: '1rem' }}>
                                    This may take 30-60 seconds. Please wait...
                                </p>
                            </div>
                        ) : generatedViralContent ? (
                            <>
                                {/* Tab Headers */}
                                <div style={{ 
                                    display: 'flex', 
                                    gap: '0.5rem', 
                                    marginBottom: '1rem',
                                    borderBottom: '2px solid #333',
                                    flexWrap: 'wrap'
                                }}>
                                    <button
                                        onClick={() => setActiveViralTab('tweet')}
                                        style={{
                                            padding: '0.75rem 1.5rem',
                                            background: activeViralTab === 'tweet' ? '#1da1f2' : 'transparent',
                                            color: activeViralTab === 'tweet' ? '#fff' : '#1da1f2',
                                            border: 'none',
                                            borderBottom: activeViralTab === 'tweet' ? '2px solid #1da1f2' : '2px solid transparent',
                                            borderRadius: '4px 4px 0 0',
                                            fontSize: '0.9rem',
                                            fontWeight: 'bold',
                                            cursor: 'pointer',
                                            transition: 'all 0.2s',
                                            marginBottom: '-2px'
                                        }}
                                    >
                                        🐦 Long-form Tweet
                                    </button>
                                    <button
                                        onClick={() => setActiveViralTab('thread')}
                                        style={{
                                            padding: '0.75rem 1.5rem',
                                            background: activeViralTab === 'thread' ? '#1da1f2' : 'transparent',
                                            color: activeViralTab === 'thread' ? '#fff' : '#1da1f2',
                                            border: 'none',
                                            borderBottom: activeViralTab === 'thread' ? '2px solid #1da1f2' : '2px solid transparent',
                                            borderRadius: '4px 4px 0 0',
                                            fontSize: '0.9rem',
                                            fontWeight: 'bold',
                                            cursor: 'pointer',
                                            transition: 'all 0.2s',
                                            marginBottom: '-2px'
                                        }}
                                    >
                                        🧵 Twitter Thread
                                    </button>
                                    <button
                                        onClick={() => setActiveViralTab('reddit')}
                                        style={{
                                            padding: '0.75rem 1.5rem',
                                            background: activeViralTab === 'reddit' ? '#ff4500' : 'transparent',
                                            color: activeViralTab === 'reddit' ? '#fff' : '#ff4500',
                                            border: 'none',
                                            borderBottom: activeViralTab === 'reddit' ? '2px solid #ff4500' : '2px solid transparent',
                                            borderRadius: '4px 4px 0 0',
                                            fontSize: '0.9rem',
                                            fontWeight: 'bold',
                                            cursor: 'pointer',
                                            transition: 'all 0.2s',
                                            marginBottom: '-2px'
                                        }}
                                    >
                                        🔴 Reddit Post
                                    </button>
                                    <button
                                        onClick={() => setActiveViralTab('heatsheet')}
                                        style={{
                                            padding: '0.75rem 1.5rem',
                                            background: activeViralTab === 'heatsheet' ? '#f84242' : 'transparent',
                                            color: activeViralTab === 'heatsheet' ? '#fff' : '#f84242',
                                            border: 'none',
                                            borderBottom: activeViralTab === 'heatsheet' ? '2px solid #f84242' : '2px solid transparent',
                                            borderRadius: '4px 4px 0 0',
                                            fontSize: '0.9rem',
                                            fontWeight: 'bold',
                                            cursor: 'pointer',
                                            transition: 'all 0.2s',
                                            marginBottom: '-2px'
                                        }}
                                    >
                                        📊 Heat Sheet
                                    </button>
                                </div>

                                {/* Tab Content */}
                                <div style={{ 
                                    padding: '1.5rem',
                                    background: '#000',
                                    borderRadius: '0 0 4px 4px',
                                    border: '1px solid #333',
                                    borderTop: 'none'
                                }}>
                                    {activeViralTab === 'tweet' && (
                                        <div>
                                            <div style={{ 
                                                display: 'flex', 
                                                justifyContent: 'space-between', 
                                                alignItems: 'center',
                                                marginBottom: '1rem'
                                            }}>
                                                <label style={{ color: '#fff', fontWeight: 'bold', fontSize: '0.9rem' }}>
                                                    Long-form Tweet:
                                                </label>
                                                <button
                                                    onClick={() => {
                                                        navigator.clipboard.writeText(generatedViralContent.longFormTweet).then(() => {
                                                            alert('Copied to clipboard!');
                                                        }).catch(err => {
                                                            console.error('Failed to copy:', err);
                                                            alert('Failed to copy. Please select and copy manually.');
                                                        });
                                                    }}
                                                    style={{
                                                        padding: '0.5rem 1rem',
                                                        background: '#1da1f2',
                                                        color: '#fff',
                                                        border: 'none',
                                                        borderRadius: '4px',
                                                        fontSize: '0.85rem',
                                                        fontWeight: 'bold',
                                                        cursor: 'pointer'
                                                    }}
                                                >
                                                    📋 Copy
                                                </button>
                                            </div>
                                            <textarea
                                                value={generatedViralContent.longFormTweet}
                                                readOnly
                                                style={{
                                                    width: '100%',
                                                    minHeight: '300px',
                                                    padding: '1rem',
                                                    background: '#000',
                                                    border: '1px solid #1da1f2',
                                                    color: '#fff',
                                                    borderRadius: '4px',
                                                    fontSize: '0.9rem',
                                                    fontFamily: 'monospace',
                                                    lineHeight: '1.6',
                                                    resize: 'vertical'
                                                }}
                                            />
                                        </div>
                                    )}

                                    {activeViralTab === 'thread' && (
                                        <div>
                                            <div style={{ 
                                                display: 'flex', 
                                                justifyContent: 'space-between', 
                                                alignItems: 'center',
                                                marginBottom: '1rem'
                                            }}>
                                                <label style={{ color: '#fff', fontWeight: 'bold', fontSize: '0.9rem' }}>
                                                    Twitter Thread ({generatedViralContent.twitterThread.length} tweets):
                                                </label>
                                                <button
                                                    onClick={() => {
                                                        const threadText = generatedViralContent.twitterThread.join('\n\n');
                                                        navigator.clipboard.writeText(threadText).then(() => {
                                                            alert('Copied to clipboard!');
                                                        }).catch(err => {
                                                            console.error('Failed to copy:', err);
                                                            alert('Failed to copy. Please select and copy manually.');
                                                        });
                                                    }}
                                                    style={{
                                                        padding: '0.5rem 1rem',
                                                        background: '#1da1f2',
                                                        color: '#fff',
                                                        border: 'none',
                                                        borderRadius: '4px',
                                                        fontSize: '0.85rem',
                                                        fontWeight: 'bold',
                                                        cursor: 'pointer'
                                                    }}
                                                >
                                                    📋 Copy All
                                                </button>
                                            </div>
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                                                {generatedViralContent.twitterThread.map((tweet, index) => (
                                                    <div key={index} style={{
                                                        padding: '1rem',
                                                        background: 'rgba(29, 161, 242, 0.1)',
                                                        border: '1px solid #1da1f2',
                                                        borderRadius: '4px'
                                                    }}>
                                                        <div style={{ 
                                                            display: 'flex', 
                                                            justifyContent: 'space-between', 
                                                            alignItems: 'center',
                                                            marginBottom: '0.5rem'
                                                        }}>
                                                            <span style={{ color: '#1da1f2', fontSize: '0.75rem', fontWeight: 'bold' }}>
                                                                Tweet {index + 1}/{generatedViralContent.twitterThread.length}
                                                            </span>
                                                            <button
                                                                onClick={() => {
                                                                    navigator.clipboard.writeText(tweet).then(() => {
                                                                        alert('Copied to clipboard!');
                                                                    }).catch(err => {
                                                                        console.error('Failed to copy:', err);
                                                                        alert('Failed to copy. Please select and copy manually.');
                                                                    });
                                                                }}
                                                                style={{
                                                                    padding: '0.25rem 0.5rem',
                                                                    background: '#1da1f2',
                                                                    color: '#fff',
                                                                    border: 'none',
                                                                    borderRadius: '4px',
                                                                    fontSize: '0.75rem',
                                                                    cursor: 'pointer'
                                                                }}
                                                            >
                                                                Copy
                                                            </button>
                                                        </div>
                                                        <textarea
                                                            value={tweet}
                                                            readOnly
                                                            style={{
                                                                width: '100%',
                                                                minHeight: '80px',
                                                                padding: '0.75rem',
                                                                background: '#000',
                                                                border: '1px solid #1da1f2',
                                                                color: '#fff',
                                                                borderRadius: '4px',
                                                                fontSize: '0.85rem',
                                                                fontFamily: 'monospace',
                                                                lineHeight: '1.5',
                                                                resize: 'vertical'
                                                            }}
                                                        />
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {activeViralTab === 'reddit' && (
                                        <div>
                                            <div style={{ 
                                                display: 'flex', 
                                                justifyContent: 'space-between', 
                                                alignItems: 'center',
                                                marginBottom: '1rem'
                                            }}>
                                                <label style={{ color: '#fff', fontWeight: 'bold', fontSize: '0.9rem' }}>
                                                    Reddit Post:
                                                </label>
                                                <button
                                                    onClick={() => {
                                                        const redditText = `${generatedViralContent.redditPost.title}\n\n${generatedViralContent.redditPost.body}`;
                                                        navigator.clipboard.writeText(redditText).then(() => {
                                                            alert('Copied to clipboard!');
                                                        }).catch(err => {
                                                            console.error('Failed to copy:', err);
                                                            alert('Failed to copy. Please select and copy manually.');
                                                        });
                                                    }}
                                                    style={{
                                                        padding: '0.5rem 1rem',
                                                        background: '#ff4500',
                                                        color: '#fff',
                                                        border: 'none',
                                                        borderRadius: '4px',
                                                        fontSize: '0.85rem',
                                                        fontWeight: 'bold',
                                                        cursor: 'pointer'
                                                    }}
                                                >
                                                    📋 Copy All
                                                </button>
                                            </div>
                                            <div style={{ marginBottom: '1rem' }}>
                                                <label style={{ display: 'block', color: '#fff', marginBottom: '0.5rem', fontWeight: 'bold', fontSize: '0.9rem' }}>
                                                    Title:
                                                </label>
                                                <textarea
                                                    value={generatedViralContent.redditPost.title}
                                                    readOnly
                                                    style={{
                                                        width: '100%',
                                                        minHeight: '60px',
                                                        padding: '0.75rem',
                                                        background: '#000',
                                                        border: '1px solid #ff4500',
                                                        color: '#fff',
                                                        borderRadius: '4px',
                                                        fontSize: '0.9rem',
                                                        fontFamily: 'monospace',
                                                        resize: 'vertical'
                                                    }}
                                                />
                                            </div>
                                            <div>
                                                <label style={{ display: 'block', color: '#fff', marginBottom: '0.5rem', fontWeight: 'bold', fontSize: '0.9rem' }}>
                                                    Body:
                                                </label>
                                                <textarea
                                                    value={generatedViralContent.redditPost.body}
                                                    readOnly
                                                    style={{
                                                        width: '100%',
                                                        minHeight: '400px',
                                                        padding: '1rem',
                                                        background: '#000',
                                                        border: '1px solid #ff4500',
                                                        color: '#fff',
                                                        borderRadius: '4px',
                                                        fontSize: '0.9rem',
                                                        fontFamily: 'monospace',
                                                        lineHeight: '1.6',
                                                        resize: 'vertical'
                                                    }}
                                                />
                                            </div>
                                        </div>
                                    )}

                                    {activeViralTab === 'heatsheet' && (
                                        <div>
                                            <div style={{ 
                                                display: 'flex', 
                                                justifyContent: 'space-between', 
                                                alignItems: 'center',
                                                marginBottom: '1rem'
                                            }}>
                                                <label style={{ color: '#fff', fontWeight: 'bold', fontSize: '0.9rem' }}>
                                                    Heat Sheet Segment:
                                                </label>
                                                <button
                                                    onClick={() => {
                                                        navigator.clipboard.writeText(generatedViralContent.heatSheetSegment).then(() => {
                                                            alert('Copied to clipboard!');
                                                        }).catch(err => {
                                                            console.error('Failed to copy:', err);
                                                            alert('Failed to copy. Please select and copy manually.');
                                                        });
                                                    }}
                                                    style={{
                                                        padding: '0.5rem 1rem',
                                                        background: '#f84242',
                                                        color: '#fff',
                                                        border: 'none',
                                                        borderRadius: '4px',
                                                        fontSize: '0.85rem',
                                                        fontWeight: 'bold',
                                                        cursor: 'pointer'
                                                    }}
                                                >
                                                    📋 Copy
                                                </button>
                                            </div>
                                            <textarea
                                                value={generatedViralContent.heatSheetSegment}
                                                readOnly
                                                style={{
                                                    width: '100%',
                                                    minHeight: '300px',
                                                    padding: '1rem',
                                                    background: '#000',
                                                    border: '1px solid #f84242',
                                                    color: '#fff',
                                                    borderRadius: '4px',
                                                    fontSize: '0.9rem',
                                                    fontFamily: 'monospace',
                                                    lineHeight: '1.6',
                                                    resize: 'vertical'
                                                }}
                                            />
                                        </div>
                                    )}

                                    {/* Validation Notes */}
                                    {generatedViralContent.validationNotes && (
                                        <div style={{
                                            marginTop: '1.5rem',
                                            padding: '1rem',
                                            background: 'rgba(255, 255, 255, 0.05)',
                                            border: '1px solid #333',
                                            borderRadius: '4px'
                                        }}>
                                            <div style={{ color: '#999', fontSize: '0.75rem', fontWeight: 'bold', marginBottom: '0.5rem' }}>
                                                VALIDATION NOTES:
                                            </div>
                                            <div style={{ color: '#ccc', fontSize: '0.85rem', lineHeight: '1.5' }}>
                                                {generatedViralContent.validationNotes}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </>
                        ) : (
                            <div style={{ textAlign: 'center', padding: '2rem', color: '#999' }}>
                                No content generated yet. Please select a narrative and generate content.
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* SEO Rewrite Modal */}
            {showSEORewriteModal && selectedPostForSEORewrite && (
                <div
                    style={{
                        position: 'fixed',
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        backgroundColor: 'rgba(0, 0, 0, 0.8)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        zIndex: 10000,
                        padding: '2rem'
                    }}
                    onClick={(e) => {
                        if (e.target === e.currentTarget) {
                            setShowSEORewriteModal(false);
                        }
                    }}
                >
                    <div
                        style={{
                            background: '#1a1a1a',
                            border: '2px solid #2196f3',
                            borderRadius: '8px',
                            padding: '2rem',
                            maxWidth: '900px',
                            width: '100%',
                            maxHeight: '90vh',
                            overflow: 'auto',
                            position: 'relative'
                        }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <button
                            onClick={() => {
                                setShowSEORewriteModal(false);
                                setSeoRewritePreview(null);
                                setSeoRewriteEditable(null);
                                setSelectedPostForSEORewrite(null);
                            }}
                            style={{
                                position: 'absolute',
                                top: '1rem',
                                right: '1rem',
                                background: '#dc3545',
                                color: '#fff',
                                border: 'none',
                                borderRadius: '4px',
                                padding: '0.5rem 0.75rem',
                                cursor: 'pointer',
                                fontSize: '0.75rem',
                                fontWeight: 'bold'
                            }}
                        >
                            ✕ Close
                        </button>

                        <h2 style={{ color: '#2196f3', marginTop: 0, marginBottom: '1.5rem' }}>
                            SEO Rewrite: {selectedPostForSEORewrite.teamA} vs {selectedPostForSEORewrite.teamB}
                        </h2>

                        {!seoRewriteEditable ? (
                            <div style={{ textAlign: 'center', padding: '3rem' }}>
                                <p style={{ color: '#ccc', marginBottom: '1.5rem' }}>
                                    Generate an SEO-optimized rewrite of this article to rank for "{selectedPostForSEORewrite.teamA} vs {selectedPostForSEORewrite.teamB} prediction" searches.
                                </p>
                                <button
                                    onClick={handleGenerateSEORewrite}
                                    disabled={isGeneratingSEORewrite}
                                    style={{
                                        padding: '1rem 2rem',
                                        background: isGeneratingSEORewrite ? '#666' : '#2196f3',
                                        color: '#fff',
                                        border: 'none',
                                        borderRadius: '4px',
                                        fontSize: '1rem',
                                        fontWeight: 'bold',
                                        cursor: isGeneratingSEORewrite ? 'not-allowed' : 'pointer',
                                        transition: 'all 0.2s'
                                    }}
                                    onMouseEnter={(e) => {
                                        if (!isGeneratingSEORewrite) {
                                            e.currentTarget.style.background = '#1976d2';
                                        }
                                    }}
                                    onMouseLeave={(e) => {
                                        if (!isGeneratingSEORewrite) {
                                            e.currentTarget.style.background = '#2196f3';
                                        }
                                    }}
                                >
                                    {isGeneratingSEORewrite ? 'Generating...' : 'Generate SEO Rewrite'}
                                </button>
                            </div>
                        ) : (
                            <div>
                                <div style={{ marginBottom: '1.5rem' }}>
                                    <label style={{ display: 'block', color: '#fff', marginBottom: '0.5rem', fontWeight: 'bold' }}>
                                        SEO URL Slug:
                                    </label>
                                    <input
                                        type="text"
                                        value={seoRewriteEditable.seoSlug}
                                        onChange={(e) => setSeoRewriteEditable({ ...seoRewriteEditable, seoSlug: e.target.value })}
                                        style={{
                                            width: '100%',
                                            padding: '0.75rem',
                                            background: '#000',
                                            border: '1px solid #2196f3',
                                            color: '#fff',
                                            borderRadius: '4px',
                                            fontSize: '0.9rem',
                                            fontFamily: 'monospace'
                                        }}
                                    />
                                    <div style={{ fontSize: '0.75rem', color: '#999', marginTop: '0.25rem' }}>
                                        Format: {selectedPostForSEORewrite.league.toLowerCase()}/{seoRewriteEditable.seoSlug}/
                                    </div>
                                </div>

                                <div style={{ marginBottom: '1.5rem' }}>
                                    <label style={{ display: 'block', color: '#fff', marginBottom: '0.5rem', fontWeight: 'bold' }}>
                                        SEO Title ({seoRewriteEditable.seoTitle.length}/60 characters):
                                    </label>
                                    <input
                                        type="text"
                                        value={seoRewriteEditable.seoTitle}
                                        onChange={(e) => {
                                            const val = e.target.value;
                                            if (val.length <= 60) {
                                                setSeoRewriteEditable({ ...seoRewriteEditable, seoTitle: val });
                                            }
                                        }}
                                        style={{
                                            width: '100%',
                                            padding: '0.75rem',
                                            background: '#000',
                                            border: '1px solid #2196f3',
                                            color: '#fff',
                                            borderRadius: '4px',
                                            fontSize: '0.9rem'
                                        }}
                                    />
                                </div>

                                <div style={{ marginBottom: '1.5rem' }}>
                                    <label style={{ display: 'block', color: '#fff', marginBottom: '0.5rem', fontWeight: 'bold' }}>
                                        Meta Description ({seoRewriteEditable.metaDescription.length}/155 characters):
                                    </label>
                                    <textarea
                                        value={seoRewriteEditable.metaDescription}
                                        onChange={(e) => {
                                            const val = e.target.value;
                                            if (val.length <= 155) {
                                                setSeoRewriteEditable({ ...seoRewriteEditable, metaDescription: val });
                                            }
                                        }}
                                        style={{
                                            width: '100%',
                                            minHeight: '80px',
                                            padding: '0.75rem',
                                            background: '#000',
                                            border: '1px solid #2196f3',
                                            color: '#fff',
                                            borderRadius: '4px',
                                            fontSize: '0.9rem',
                                            fontFamily: 'monospace',
                                            resize: 'vertical'
                                        }}
                                    />
                                </div>

                                <div style={{ marginBottom: '1.5rem' }}>
                                    <label style={{ display: 'block', color: '#fff', marginBottom: '0.5rem', fontWeight: 'bold' }}>
                                        H1 Header:
                                    </label>
                                    <input
                                        type="text"
                                        value={seoRewriteEditable.h1Header}
                                        onChange={(e) => setSeoRewriteEditable({ ...seoRewriteEditable, h1Header: e.target.value })}
                                        style={{
                                            width: '100%',
                                            padding: '0.75rem',
                                            background: '#000',
                                            border: '1px solid #2196f3',
                                            color: '#fff',
                                            borderRadius: '4px',
                                            fontSize: '0.9rem'
                                        }}
                                    />
                                </div>

                                <div style={{ marginBottom: '1.5rem' }}>
                                    <label style={{ display: 'block', color: '#fff', marginBottom: '0.5rem', fontWeight: 'bold' }}>
                                        Rewritten Article Body:
                                    </label>
                                    <textarea
                                        value={seoRewriteEditable.rewrittenBody}
                                        onChange={(e) => setSeoRewriteEditable({ ...seoRewriteEditable, rewrittenBody: e.target.value })}
                                        style={{
                                            width: '100%',
                                            minHeight: '400px',
                                            padding: '1rem',
                                            background: '#000',
                                            border: '1px solid #2196f3',
                                            color: '#fff',
                                            borderRadius: '4px',
                                            fontSize: '0.9rem',
                                            fontFamily: 'monospace',
                                            lineHeight: '1.6',
                                            resize: 'vertical'
                                        }}
                                    />
                                </div>

                                {seoRewriteEditable.heatchecksEdge && (
                                    <div style={{ marginBottom: '1.5rem' }}>
                                        <label style={{ display: 'block', color: '#fff', marginBottom: '0.5rem', fontWeight: 'bold' }}>
                                            HeatChecks Edge (Optional):
                                        </label>
                                        <textarea
                                            value={seoRewriteEditable.heatchecksEdge}
                                            onChange={(e) => setSeoRewriteEditable({ ...seoRewriteEditable, heatchecksEdge: e.target.value })}
                                            style={{
                                                width: '100%',
                                                minHeight: '100px',
                                                padding: '0.75rem',
                                                background: '#000',
                                                border: '1px solid #2196f3',
                                                color: '#fff',
                                                borderRadius: '4px',
                                                fontSize: '0.9rem',
                                                fontFamily: 'monospace',
                                                resize: 'vertical'
                                            }}
                                        />
                                    </div>
                                )}

                                <div style={{ display: 'flex', gap: '1rem', justifyContent: 'flex-end', marginTop: '2rem' }}>
                                    <button
                                        onClick={() => {
                                            setShowSEORewriteModal(false);
                                            setSeoRewritePreview(null);
                                            setSeoRewriteEditable(null);
                                            setSelectedPostForSEORewrite(null);
                                        }}
                                        style={{
                                            padding: '0.75rem 1.5rem',
                                            background: '#666',
                                            color: '#fff',
                                            border: 'none',
                                            borderRadius: '4px',
                                            fontSize: '0.9rem',
                                            fontWeight: 'bold',
                                            cursor: 'pointer'
                                        }}
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        onClick={handleSaveSEORewrite}
                                        style={{
                                            padding: '0.75rem 1.5rem',
                                            background: '#2196f3',
                                            color: '#fff',
                                            border: 'none',
                                            borderRadius: '4px',
                                            fontSize: '0.9rem',
                                            fontWeight: 'bold',
                                            cursor: 'pointer',
                                            transition: 'all 0.2s'
                                        }}
                                        onMouseEnter={(e) => {
                                            e.currentTarget.style.background = '#1976d2';
                                        }}
                                        onMouseLeave={(e) => {
                                            e.currentTarget.style.background = '#2196f3';
                                        }}
                                    >
                                        Save Changes
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

const EditorModal: React.FC<{ post: HeatcheckPost | null; onClose: () => void; onSave: () => void; }> = ({ post, onClose, onSave }) => {
    const [editedPost, setEditedPost] = useState<HeatcheckPost | null>(null);
    const [isOptimizingSeo, setIsOptimizingSeo] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [articleImage, setArticleImage] = useState<string>('');
    const [availableImages, setAvailableImages] = useState<string[]>([]);
    const [showImageSelector, setShowImageSelector] = useState(false);
    const [imageDateFilter, setImageDateFilter] = useState<string>('');
    const [aiFeedback, setAiFeedback] = useState<string>('');
    const [isApplyingFeedback, setIsApplyingFeedback] = useState(false);
    
    // DFS AI Assistant state
    const [selectedPlayerToReplace, setSelectedPlayerToReplace] = useState<number | null>(null);
    const [dfsReplacementInstructions, setDfsReplacementInstructions] = useState<string>('');
    const [isReplacingPlayer, setIsReplacingPlayer] = useState(false);
    const [v3NarrativeJson, setV3NarrativeJson] = useState<string>('');
    const [v3TempAiJson, setV3TempAiJson] = useState<string>('');
    const [v3EvidenceJson, setV3EvidenceJson] = useState<string>('');
    const [showV3Advanced, setShowV3Advanced] = useState<boolean>(false);
    const v3ChartInstancesRef = useRef<any[]>([]);
    const [isRegeneratingEdge, setIsRegeneratingEdge] = useState(false);
    const [edgeApiSource, setEdgeApiSource] = useState<'theoddsapi' | 'gemini'>('theoddsapi');

    // V4 state variables
    const [v4NarrativeJson, setV4NarrativeJson] = useState<string>('');
    const [v4TempAiJson, setV4TempAiJson] = useState<string>('');
    const [v4EvidenceJson, setV4EvidenceJson] = useState<string>('');
    const [v4AdvancedHeatStatsJson, setV4AdvancedHeatStatsJson] = useState<string>('');
    const [showV4Advanced, setShowV4Advanced] = useState<boolean>(false);
    const v4ChartInstancesRef = useRef<any[]>([]);

    const v3ChartsPayload: any = (editedPost as any)?.storyType === 'heat_article_v3'
        ? (editedPost as any)?.heatCheckData?.matchPackV3?.factDrop?.charts
        : null;

    // V4 detection: check for matchPackV4 in heatCheckData
    const isV4Article = !!(editedPost as any)?.heatCheckData?.matchPackV4;
    const v4ChartsPayload: any = isV4Article
        ? (editedPost as any)?.heatCheckData?.matchPackV4?.factDrop?.charts
        : null;

    const v3ChartsKey = useMemo(() => {
        try {
            return JSON.stringify(v3ChartsPayload || null);
        } catch {
            return '';
        }
    }, [v3ChartsPayload]);

    useEffect(() => {
        if (post) {
            console.log('[EditorModal] Received post to edit:', {
                id: post.id,
                league: post.league,
                storyType: post.storyType
            });
            
            setEditedPost(JSON.parse(JSON.stringify(post)));
            // Initialize articleImage from post's image
            const existingImage = post.websiteStory?.image || post.websiteStory?.imageUrl || '';
            setArticleImage(existingImage);

            // Initialize V3 JSON editors (only for V3 posts)
            if ((post as any).storyType === 'heat_article_v3') {
                const hc: any = (post as any).heatCheckData || {};
                setV3NarrativeJson(JSON.stringify(hc.v3Narrative || {}, null, 2));
                setV3TempAiJson(JSON.stringify(hc.temperatureCheck?.ai || {}, null, 2));
                setV3EvidenceJson(JSON.stringify(hc.evidence_bundle || hc.evidenceBundle || {}, null, 2));
            } else {
                setV3NarrativeJson('');
                setV3TempAiJson('');
                setV3EvidenceJson('');
            }

            // Initialize V4 JSON editors (check for matchPackV4)
            const hc: any = (post as any).heatCheckData || {};
            if (hc.matchPackV4) {
                setV4NarrativeJson(JSON.stringify(hc.v3Narrative || {}, null, 2));
                setV4TempAiJson(JSON.stringify(hc.temperatureCheck?.ai || {}, null, 2));
                setV4EvidenceJson(JSON.stringify(hc.evidence_bundle || hc.evidenceBundle || {}, null, 2));
                setV4AdvancedHeatStatsJson(JSON.stringify(hc.matchPackV4?.factDrop?.raw?.advancedHeatStats || {}, null, 2));
            } else {
                setV4NarrativeJson('');
                setV4TempAiJson('');
                setV4EvidenceJson('');
                setV4AdvancedHeatStatsJson('');
            }
            
            // Load available images dynamically from backend
            apiClient.getImages()
                .then(images => {
                    setAvailableImages(images);
                    console.log(`[EditorModal] Loaded ${images.length} images from backend`);
                })
                .catch(error => {
                    console.error('[EditorModal] Failed to load images from backend:', error);
                    // Fallback to empty array if API fails
                    setAvailableImages([]);
                });
        } else {
            setEditedPost(null);
            setArticleImage('');
            setImageDateFilter('');
            setV3NarrativeJson('');
            setV3TempAiJson('');
            setV3EvidenceJson('');
            setV4NarrativeJson('');
            setV4TempAiJson('');
            setV4EvidenceJson('');
            setV4AdvancedHeatStatsJson('');
        }
    }, [post]);

    // V3 charts preview (Chart.js canvas) in the editor
    useEffect(() => {
        // cleanup previous charts
        try {
            for (const c of v3ChartInstancesRef.current) {
                try { c?.destroy?.(); } catch {}
            }
        } finally {
            v3ChartInstancesRef.current = [];
        }

        if (!editedPost || (editedPost as any).storyType !== 'heat_article_v3') return;
        const charts: any = v3ChartsPayload;
        if (!charts) return;

        const idSuffix = editedPost.id;
        const momentumCanvasId = `v3-editor-chart-momentum-${idSuffix}`;
        const starLoadCanvasId = `v3-editor-chart-starload-${idSuffix}`;
        const pressureCanvasId = `v3-editor-chart-pressure-${idSuffix}`;
        const volatilityCanvasId = `v3-editor-chart-volatility-${idSuffix}`;

        const padFront = (arr: any[], len: number) => {
            const a = Array.isArray(arr) ? arr.slice() : [];
            while (a.length < len) a.unshift(null);
            return a;
        };
        const buildLabels = (len: number) => Array.from({ length: len }, (_, i) => `G${i + 1}`);
        const colorForVol = (v: any) => {
            if (typeof v !== 'number' || !Number.isFinite(v)) return 'rgba(255,255,255,0.25)';
            return v >= 0 ? 'rgba(255,26,26,0.85)' : 'rgba(255,230,109,0.80)';
        };

        const commonOptions: any = {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 0 },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(0,0,0,0.92)',
                    borderColor: 'rgba(0,255,65,0.25)',
                    borderWidth: 1,
                    titleColor: 'rgba(255,255,255,0.92)',
                    bodyColor: 'rgba(255,255,255,0.85)',
                },
            },
            scales: {
                x: {
                    ticks: { color: 'rgba(255,255,255,0.65)', font: { family: 'Courier New', size: 10 } },
                    grid: { color: 'rgba(255,255,255,0.08)' },
                },
                y: {
                    ticks: { color: 'rgba(255,255,255,0.65)', font: { family: 'Courier New', size: 10 } },
                    grid: {
                        color: (ctx: any) =>
                            ctx?.tick?.value === 0 ? 'rgba(0,255,65,0.25)' : 'rgba(255,255,255,0.08)',
                    },
                },
            },
        };

        // 1) Momentum line
        try {
            const m = charts?.momentumLine;
            if (m?.series) {
                // Handle both NBA (margins) and soccer (xgDiff) data structures
                const a = m?.series?.A?.margins || m?.series?.A?.xgDiff || [];
                const b = m?.series?.B?.margins || m?.series?.B?.xgDiff || [];
                const aLabel = m?.series?.A?.label || 'A';
                const bLabel = m?.series?.B?.label || 'B';
                const len = Math.max(a.length, b.length, 1);

                const el = document.getElementById(momentumCanvasId) as HTMLCanvasElement | null;
                if (el && (a.length > 0 || b.length > 0)) {
                    const chart = new Chart(el, {
                        type: 'line',
                        data: {
                            labels: buildLabels(len),
                            datasets: [
                                { label: aLabel, data: padFront(a, len), borderColor: 'rgba(255,26,26,0.95)', backgroundColor: 'rgba(255,26,26,0.15)', tension: 0.25, pointRadius: 0, borderWidth: 2 },
                                { label: bLabel, data: padFront(b, len), borderColor: 'rgba(255,230,109,0.95)', backgroundColor: 'rgba(255,230,109,0.12)', tension: 0.25, pointRadius: 0, borderWidth: 2 },
                            ],
                        },
                        options: commonOptions,
                    });
                    v3ChartInstancesRef.current.push(chart);
                }
            }
        } catch {}

        // 2) Star load (USG10 vs MIN10 for NBA, xG5 vs min5 for soccer)
        try {
            const s = charts?.starLoad;
            const players: any[] = Array.isArray(s?.players) ? s.players : [];
            if (players.length > 0) {
                // Handle both NBA (teamAbbr) and soccer (teamName) structures
                const labels = players.map(p => {
                    const teamAbbr = p?.teamAbbr || p?.teamName || '';
                    const playerName = p?.playerName || '';
                    return `${String(teamAbbr).trim()} ${String(playerName).trim()}`.trim();
                });
                // Handle both NBA (USG10/MIN10) and soccer (xG5/min5) field names
                const usg = players.map(p => {
                    const val = p?.USG10 ?? p?.xG5;
                    return (typeof val === 'number' && Number.isFinite(val)) ? val : null;
                });
                const min = players.map(p => {
                    const val = p?.MIN10 ?? p?.MIN5 ?? p?.min5;
                    return (typeof val === 'number' && Number.isFinite(val)) ? val : null;
                });

                const el = document.getElementById(starLoadCanvasId) as HTMLCanvasElement | null;
                if (el && (usg.some(v => v !== null) || min.some(v => v !== null))) {
                    const chart = new Chart(el, {
                        type: 'bar',
                        data: {
                            labels,
                            datasets: [
                                { label: 'USG10/xG5', data: usg, yAxisID: 'yUSG', backgroundColor: 'rgba(255,26,26,0.80)', borderColor: 'rgba(0,0,0,0.65)', borderWidth: 1 },
                                { label: 'MIN10/MIN5', data: min, yAxisID: 'yMIN', backgroundColor: 'rgba(255,230,109,0.78)', borderColor: 'rgba(0,0,0,0.65)', borderWidth: 1 },
                            ],
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            animation: { duration: 0 },
                            plugins: { legend: { display: false }, tooltip: commonOptions.plugins.tooltip },
                            scales: {
                                x: { ticks: { color: 'rgba(255,255,255,0.65)', font: { family: 'Courier New', size: 10 } }, grid: { color: 'rgba(255,255,255,0.08)' } },
                                yUSG: { position: 'left', beginAtZero: true, ticks: { color: 'rgba(255,255,255,0.65)', font: { family: 'Courier New', size: 10 } }, grid: { color: 'rgba(255,255,255,0.08)' } },
                                yMIN: { position: 'right', beginAtZero: true, ticks: { color: 'rgba(255,255,255,0.65)', font: { family: 'Courier New', size: 10 } }, grid: { drawOnChartArea: false } },
                            },
                        } as any,
                    });
                    v3ChartInstancesRef.current.push(chart);
                }
            }
        } catch {}

        // 3) Pressure bar (close-game record)
        try {
            const p = charts?.pressureBar;
            if (p?.A && p?.B) {
                const labels = [String(p?.A?.label || 'A'), String(p?.B?.label || 'B')];
                const wins = [Number(p?.A?.wins || 0), Number(p?.B?.wins || 0)];
                const losses = [Number(p?.A?.losses || 0), Number(p?.B?.losses || 0)];

                const el = document.getElementById(pressureCanvasId) as HTMLCanvasElement | null;
                if (el) {
                    const chart = new Chart(el, {
                        type: 'bar',
                        data: {
                            labels,
                            datasets: [
                                { label: 'Wins', data: wins, backgroundColor: 'rgba(255,26,26,0.78)', borderColor: 'rgba(0,0,0,0.65)', borderWidth: 1, stack: 's' },
                                { label: 'Losses', data: losses, backgroundColor: 'rgba(255,255,255,0.18)', borderColor: 'rgba(0,0,0,0.65)', borderWidth: 1, stack: 's' },
                            ],
                        },
                        options: {
                            indexAxis: 'y',
                            responsive: true,
                            maintainAspectRatio: false,
                            animation: { duration: 0 },
                            plugins: { legend: { display: false }, tooltip: commonOptions.plugins.tooltip },
                            scales: {
                                x: { stacked: true, beginAtZero: true, ticks: { color: 'rgba(255,255,255,0.65)', font: { family: 'Courier New', size: 10 } }, grid: { color: 'rgba(255,255,255,0.08)' } },
                                y: { stacked: true, ticks: { color: 'rgba(255,255,255,0.70)', font: { family: 'Courier New', size: 10 } }, grid: { color: 'rgba(255,255,255,0.08)' } },
                            },
                        } as any,
                    });
                    v3ChartInstancesRef.current.push(chart);
                }
            }
        } catch {}

        // 4) Role volatility (ΔUSG3 vs season for NBA, xGChange for soccer)
        try {
            const rv = charts?.roleVolatility;
            const rvPlayers: any[] = Array.isArray(rv?.players) ? rv.players : [];
            if (rvPlayers.length > 0) {
                // Handle both NBA (teamAbbr) and soccer (teamName) structures
                const labels = rvPlayers.map(p => {
                    const teamAbbr = p?.teamAbbr || p?.teamName || '';
                    const playerName = p?.playerName || '';
                    return `${String(teamAbbr).trim()} ${String(playerName).trim()}`.trim();
                });
                // Handle both NBA (deltaUSG3vsSeason) and soccer (xGChange) field names
                const vals = rvPlayers.map(p => {
                    const v = p?.deltaUSG3vsSeason ?? p?.xGChange;
                    return (typeof v === 'number' && Number.isFinite(v)) ? v : 0;
                });
                const maxAbs = Math.max(1, ...vals.map(v => Math.abs(Number(v) || 0)));

                const el = document.getElementById(volatilityCanvasId) as HTMLCanvasElement | null;
                if (el && vals.some(v => v !== 0)) {
                    const chart = new Chart(el, {
                        type: 'bar',
                        data: {
                            labels,
                            datasets: [
                                {
                                    label: 'ΔUSG3/ΔxG',
                                    data: vals,
                                    backgroundColor: rvPlayers.map(p => {
                                        const val = p?.deltaUSG3vsSeason ?? p?.xGChange ?? 0;
                                        return colorForVol(val);
                                    }),
                                    borderColor: 'rgba(0,0,0,0.65)',
                                    borderWidth: 1,
                                },
                            ],
                        },
                        options: {
                            indexAxis: 'y',
                            responsive: true,
                            maintainAspectRatio: false,
                            animation: { duration: 0 },
                            plugins: { legend: { display: false }, tooltip: commonOptions.plugins.tooltip },
                            scales: {
                                x: {
                                    suggestedMin: -maxAbs,
                                    suggestedMax: maxAbs,
                                    ticks: { color: 'rgba(255,255,255,0.65)', font: { family: 'Courier New', size: 10 } },
                                    grid: { color: (ctx: any) => ctx?.tick?.value === 0 ? 'rgba(0,255,65,0.25)' : 'rgba(255,255,255,0.08)' },
                                },
                                y: { ticks: { color: 'rgba(255,255,255,0.70)', font: { family: 'Courier New', size: 10 } }, grid: { color: 'rgba(255,255,255,0.08)' } },
                            },
                        } as any,
                    });
                    v3ChartInstancesRef.current.push(chart);
                }
            }
        } catch {}

        return () => {
            for (const c of v3ChartInstancesRef.current) {
                try { c?.destroy?.(); } catch {}
            }
            v3ChartInstancesRef.current = [];
        };
    }, [editedPost?.id, v3ChartsKey]);

    // V4 charts preview (Chart.js canvas) in the editor - same logic as V3 but using matchPackV4
    useEffect(() => {
        // cleanup previous charts
        try {
            for (const c of v4ChartInstancesRef.current) {
                try { c?.destroy?.(); } catch {}
            }
        } finally {
            v4ChartInstancesRef.current = [];
        }

        if (!editedPost || !isV4Article) return;
        const charts: any = v4ChartsPayload;
        if (!charts) return;

        const idSuffix = editedPost.id;
        const momentumCanvasId = `v4-editor-chart-momentum-${idSuffix}`;
        const starLoadCanvasId = `v4-editor-chart-starload-${idSuffix}`;
        const pressureCanvasId = `v4-editor-chart-pressure-${idSuffix}`;
        const volatilityCanvasId = `v4-editor-chart-volatility-${idSuffix}`;

        const padFront = (arr: any[], len: number) => {
            const a = Array.isArray(arr) ? arr.slice() : [];
            while (a.length < len) a.unshift(null);
            return a;
        };
        const buildLabels = (len: number) => Array.from({ length: len }, (_, i) => `G${i + 1}`);
        const colorForVol = (v: any) => {
            if (typeof v !== 'number' || !Number.isFinite(v)) return 'rgba(255,255,255,0.25)';
            return v >= 0 ? 'rgba(255,26,26,0.85)' : 'rgba(255,230,109,0.80)';
        };

        const commonOptions: any = {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 0 },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(0,0,0,0.92)',
                    borderColor: 'rgba(0,255,65,0.25)',
                    borderWidth: 1,
                    titleColor: 'rgba(255,255,255,0.92)',
                    bodyColor: 'rgba(255,255,255,0.85)',
                },
            },
            scales: {
                x: {
                    ticks: { color: 'rgba(255,255,255,0.65)', font: { family: 'Courier New', size: 10 } },
                    grid: { color: 'rgba(255,255,255,0.08)' },
                },
                y: {
                    ticks: { color: 'rgba(255,255,255,0.65)', font: { family: 'Courier New', size: 10 } },
                    grid: {
                        color: (ctx: any) =>
                            ctx?.tick?.value === 0 ? 'rgba(0,255,65,0.25)' : 'rgba(255,255,255,0.08)',
                    },
                },
            },
        };

        // 1) Momentum line
        try {
            const m = charts?.momentumLine;
            if (m?.series) {
                const a = m?.series?.A?.margins || m?.series?.A?.xgDiff || [];
                const b = m?.series?.B?.margins || m?.series?.B?.xgDiff || [];
                const aLabel = m?.series?.A?.label || 'A';
                const bLabel = m?.series?.B?.label || 'B';
                const len = Math.max(a.length, b.length, 1);

                const el = document.getElementById(momentumCanvasId) as HTMLCanvasElement | null;
                if (el && (a.length > 0 || b.length > 0)) {
                    const chart = new Chart(el, {
                        type: 'line',
                        data: {
                            labels: buildLabels(len),
                            datasets: [
                                { label: aLabel, data: padFront(a, len), borderColor: 'rgba(255,26,26,0.95)', backgroundColor: 'rgba(255,26,26,0.15)', tension: 0.25, pointRadius: 0, borderWidth: 2 },
                                { label: bLabel, data: padFront(b, len), borderColor: 'rgba(255,230,109,0.95)', backgroundColor: 'rgba(255,230,109,0.12)', tension: 0.25, pointRadius: 0, borderWidth: 2 },
                            ],
                        },
                        options: commonOptions,
                    });
                    v4ChartInstancesRef.current.push(chart);
                }
            }
        } catch {}

        // 2) Star load
        try {
            const s = charts?.starLoad;
            const players: any[] = Array.isArray(s?.players) ? s.players : [];
            if (players.length > 0) {
                const labels = players.map(p => {
                    const teamAbbr = p?.teamAbbr || p?.teamName || '';
                    const playerName = p?.playerName || '';
                    return `${String(teamAbbr).trim()} ${String(playerName).trim()}`.trim();
                });
                const usg = players.map(p => {
                    const val = p?.USG10 ?? p?.xG5;
                    return (typeof val === 'number' && Number.isFinite(val)) ? val : null;
                });
                const min = players.map(p => {
                    const val = p?.MIN10 ?? p?.MIN5 ?? p?.min5;
                    return (typeof val === 'number' && Number.isFinite(val)) ? val : null;
                });

                const el = document.getElementById(starLoadCanvasId) as HTMLCanvasElement | null;
                if (el && (usg.some(v => v !== null) || min.some(v => v !== null))) {
                    const chart = new Chart(el, {
                        type: 'bar',
                        data: {
                            labels,
                            datasets: [
                                { label: 'USG10/xG5', data: usg, yAxisID: 'yUSG', backgroundColor: 'rgba(255,26,26,0.80)', borderColor: 'rgba(0,0,0,0.65)', borderWidth: 1 },
                                { label: 'MIN10/min5', data: min, yAxisID: 'yMIN', backgroundColor: 'rgba(255,230,109,0.80)', borderColor: 'rgba(0,0,0,0.65)', borderWidth: 1 },
                            ],
                        },
                        options: {
                            ...commonOptions,
                            scales: {
                                ...commonOptions.scales,
                                yUSG: { position: 'left', ticks: { color: 'rgba(255,26,26,0.70)', font: { family: 'Courier New', size: 10 } }, grid: { color: 'rgba(255,255,255,0.08)' } },
                                yMIN: { position: 'right', ticks: { color: 'rgba(255,230,109,0.70)', font: { family: 'Courier New', size: 10 } }, grid: { display: false } },
                            },
                        } as any,
                    });
                    v4ChartInstancesRef.current.push(chart);
                }
            }
        } catch {}

        // 3) Pressure bar (close-game record) - V3 structure: { A: { wins, losses, label }, B: { wins, losses, label } }
        try {
            const p = charts?.pressureBar;
            if (p?.A && p?.B) {
                const labels = [String(p?.A?.label || 'A'), String(p?.B?.label || 'B')];
                const wins = [Number(p?.A?.wins || 0), Number(p?.B?.wins || 0)];
                const losses = [Number(p?.A?.losses || 0), Number(p?.B?.losses || 0)];

                const el = document.getElementById(pressureCanvasId) as HTMLCanvasElement | null;
                if (el) {
                    const chart = new Chart(el, {
                        type: 'bar',
                        data: {
                            labels,
                            datasets: [
                                { label: 'Wins', data: wins, backgroundColor: 'rgba(255,26,26,0.78)', borderColor: 'rgba(0,0,0,0.65)', borderWidth: 1, stack: 's' },
                                { label: 'Losses', data: losses, backgroundColor: 'rgba(255,255,255,0.18)', borderColor: 'rgba(0,0,0,0.65)', borderWidth: 1, stack: 's' },
                            ],
                        },
                        options: {
                            indexAxis: 'y',
                            responsive: true,
                            maintainAspectRatio: false,
                            animation: { duration: 0 },
                            plugins: { legend: { display: false }, tooltip: commonOptions.plugins.tooltip },
                            scales: {
                                x: { stacked: true, beginAtZero: true, ticks: { color: 'rgba(255,255,255,0.65)', font: { family: 'Courier New', size: 10 } }, grid: { color: 'rgba(255,255,255,0.08)' } },
                                y: { stacked: true, ticks: { color: 'rgba(255,255,255,0.70)', font: { family: 'Courier New', size: 10 } }, grid: { color: 'rgba(255,255,255,0.08)' } },
                            },
                        } as any,
                    });
                    v4ChartInstancesRef.current.push(chart);
                }
            }
        } catch {}

        // 4) Role volatility (ΔUSG3 vs season for NBA, xGChange for soccer)
        try {
            const rv = charts?.roleVolatility;
            const rvPlayers: any[] = Array.isArray(rv?.players) ? rv.players : [];
            if (rvPlayers.length > 0) {
                // Handle both NBA (teamAbbr) and soccer (teamName) structures
                const labels = rvPlayers.map(p => {
                    const teamAbbr = p?.teamAbbr || p?.teamName || '';
                    const playerName = p?.playerName || '';
                    return `${String(teamAbbr).trim()} ${String(playerName).trim()}`.trim();
                });
                // Handle both NBA (deltaUSG3vsSeason) and soccer (xGChange) field names
                const vals = rvPlayers.map(p => {
                    const v = p?.deltaUSG3vsSeason ?? p?.xGChange;
                    return (typeof v === 'number' && Number.isFinite(v)) ? v : 0;
                });
                const maxAbs = Math.max(1, ...vals.map(v => Math.abs(Number(v) || 0)));

                const el = document.getElementById(volatilityCanvasId) as HTMLCanvasElement | null;
                if (el && vals.some(v => v !== 0)) {
                    const chart = new Chart(el, {
                        type: 'bar',
                        data: {
                            labels,
                            datasets: [
                                {
                                    label: 'ΔUSG3/ΔxG',
                                    data: vals,
                                    backgroundColor: rvPlayers.map(p => {
                                        const val = p?.deltaUSG3vsSeason ?? p?.xGChange ?? 0;
                                        return colorForVol(val);
                                    }),
                                    borderColor: 'rgba(0,0,0,0.65)',
                                    borderWidth: 1,
                                },
                            ],
                        },
                        options: {
                            indexAxis: 'y',
                            responsive: true,
                            maintainAspectRatio: false,
                            animation: { duration: 0 },
                            plugins: { legend: { display: false }, tooltip: commonOptions.plugins.tooltip },
                            scales: {
                                x: {
                                    suggestedMin: -maxAbs,
                                    suggestedMax: maxAbs,
                                    ticks: { color: 'rgba(255,255,255,0.65)', font: { family: 'Courier New', size: 10 } },
                                    grid: { color: (ctx: any) => ctx?.tick?.value === 0 ? 'rgba(0,255,65,0.25)' : 'rgba(255,255,255,0.08)' },
                                },
                                y: { ticks: { color: 'rgba(255,255,255,0.70)', font: { family: 'Courier New', size: 10 } }, grid: { color: 'rgba(255,255,255,0.08)' } },
                            },
                        } as any,
                    });
                    v4ChartInstancesRef.current.push(chart);
                }
            }
        } catch {}

        return () => {
            for (const c of v4ChartInstancesRef.current) {
                try { c?.destroy?.(); } catch {}
            }
            v4ChartInstancesRef.current = [];
        };
    }, [editedPost?.id, isV4Article, v4ChartsPayload]);

    const handleFieldChange = (fieldPath: string, value: any) => {
        if (!editedPost) return;
        setEditedPost(prev => {
            if (!prev) return null;
            const newPost = JSON.parse(JSON.stringify(prev));
            let current: any = newPost;
            const nameParts = fieldPath.split('.');
            for (let i = 0; i < nameParts.length - 1; i++) {
                if (current[nameParts[i]] == null || typeof current[nameParts[i]] !== 'object') {
                    current[nameParts[i]] = {};
                }
                current = current[nameParts[i]];
            }
            current[nameParts[nameParts.length - 1]] = value;
            return newPost;
        });
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        handleFieldChange(e.target.name, e.target.value);
    };

    const handleArrayChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        handleFieldChange(e.target.name, e.target.value.split('\n'));
    };

    const handleRegenerateEdge = async () => {
        if (!editedPost) return;
        
        setIsRegeneratingEdge(true);
        try {
            const teamA = editedPost.teamA;
            const teamB = editedPost.teamB;
            const league = editedPost.league;
            
            // Get matchPack from heatCheckData (V4 extends V3, so use V4 if available, otherwise V3)
            const heatCheckData = (editedPost as any).heatCheckData || {};
            const matchPackV4 = heatCheckData.matchPackV4;
            const matchPackV3 = heatCheckData.matchPackV3;
            const matchPack = matchPackV4 || matchPackV3; // V4 extends V3, so V4 has all V3 data
            
            if (!matchPack) {
                alert('MatchPack data not found. Cannot regenerate edge without match data.');
                setIsRegeneratingEdge(false);
                return;
            }

            let oddsData: { gameMarkets: any; playerProps: any };

            // Determine sport based on league (same logic as Heat Picks)
            const leagueUpper = league.toUpperCase();
            let sport = 'basketball_nba'; // default
            if (isSoccerLeague(league)) {
                if (leagueUpper === 'EPL' || leagueUpper === 'PREMIER LEAGUE') {
                    sport = 'soccer_epl';
                } else if (leagueUpper === 'BUNDESLIGA') {
                    sport = 'soccer_germany_bundesliga';
                } else if (leagueUpper === 'LA LIGA') {
                    sport = 'soccer_spain_la_liga';
                } else if (leagueUpper === 'SERIE A') {
                    sport = 'soccer_italy_serie_a';
                } else if (leagueUpper === 'LIGUE 1') {
                    sport = 'soccer_france_ligue_one';
                } else {
                    sport = 'soccer_germany_bundesliga'; // fallback for other soccer leagues
                }
            } else if (leagueUpper === 'NBA') {
                sport = 'basketball_nba';
            } else if (leagueUpper === 'NFL') {
                sport = 'americanfootball_nfl';
            }

            if (edgeApiSource === 'gemini') {
                // Use Gemini to search for odds
                const scheduledDate = editedPost.matchupScheduledDate || matchPack?.matchup?.gameDateEst || null;
                oddsData = await searchOddsWithGemini(matchPack, teamA, teamB, league, scheduledDate);
                console.log('[Editor] Fetched odds using Gemini');
            } else {
                // Use TheOddsAPI
                // Try to get event ID from factPack or find it
                let eventId: string | null = null;
                const factPack = heatCheckData.factPack || {};
                if (factPack.odds?.event_id) {
                    eventId = factPack.odds.event_id;
                } else {
                    // Try to find event ID by querying OddsAPI
                    try {
                        const scheduledDate = editedPost.matchupScheduledDate || matchPack?.matchup?.gameDateEst || null;
                        console.log(`[Editor] Searching OddsAPI for: ${teamA} vs ${teamB} (sport: ${sport})`);
                        const eventInfo = await apiClient.findOddsEventId(
                            teamA,
                            teamB,
                            scheduledDate,
                            sport
                        );
                        eventId = eventInfo.eventId;
                        console.log(`[Editor] Found event ID: ${eventId} for ${teamA} vs ${teamB}`);
                    } catch (findError: any) {
                        console.warn(`[Editor] Could not find event ID:`, findError.message || findError);
                        alert(`Could not find OddsAPI event ID for ${teamA} vs ${teamB}. Team names may not match OddsAPI format, or game may not be available yet.`);
                        setIsRegeneratingEdge(false);
                        return;
                    }
                }

                if (!eventId) {
                    alert('Could not find OddsAPI event ID. Cannot regenerate edge.');
                    setIsRegeneratingEdge(false);
                    return;
                }

                // Fetch odds from OddsAPI
                oddsData = await apiClient.getOddsForGame(eventId, sport);
                console.log('[Editor] Fetched odds using TheOddsAPI');
            }
            
            // Layer 1: Edge Finder
            const candidates = await findEdgeCandidates(
                matchPack,
                oddsData.gameMarkets,
                oddsData.playerProps,
                teamA,
                teamB,
                league
            );

            // Layer 2: Edge Validator
            const validated = await validateEdgeCandidates(candidates, matchPack);

            // Layer 3: Edge Writer
            const newEdge = await generateHeatChecksEdgeV3(
                validated,
                matchPack,
                teamA,
                teamB,
                league
            );

            // Update the edited post with the new edge
            handleFieldChange('heatchecksEdge', newEdge);
            
            console.log('[Editor] Edge regenerated successfully');
        } catch (error: any) {
            console.error('[Editor] Error regenerating edge:', error);
            alert(`Failed to regenerate edge: ${error.message || 'Unknown error'}`);
        } finally {
            setIsRegeneratingEdge(false);
        }
    };
    
    const handleSave = async (newStatus: "draft" | "published") => {
        if (!editedPost) return;
        setIsSaving(true);
        try {
            // CRITICAL FIX: Ensure websiteStory object exists and is properly structured
            // Deep merge to preserve all websiteStory properties
            const imageToSave = articleImage || editedPost.websiteStory?.image || editedPost.websiteStory?.imageUrl || '';
            
            const postToSave: any = {
                ...editedPost,
                websiteStory: {
                    ...(editedPost.websiteStory || {}), // Ensure websiteStory exists
                    image: imageToSave
                },
                status: newStatus
            };

            // V4: apply JSON editors if present (check for matchPackV4)
            const hcData: any = postToSave.heatCheckData || {};
            if (hcData.matchPackV4) {
                postToSave.heatCheckData = postToSave.heatCheckData || {};

                if (showV4Advanced) {
                    try {
                        postToSave.heatCheckData.v3Narrative = v4NarrativeJson.trim() ? JSON.parse(v4NarrativeJson) : postToSave.heatCheckData.v3Narrative;
                    } catch (e: any) {
                        throw new Error(`V4 Narrative JSON invalid: ${e.message}`);
                    }
                    try {
                        postToSave.heatCheckData.temperatureCheck = postToSave.heatCheckData.temperatureCheck || {};
                        postToSave.heatCheckData.temperatureCheck.ai = v4TempAiJson.trim() ? JSON.parse(v4TempAiJson) : postToSave.heatCheckData.temperatureCheck.ai;
                    } catch (e: any) {
                        throw new Error(`V4 Temperature Check AI JSON invalid: ${e.message}`);
                    }
                    try {
                        postToSave.heatCheckData.evidence_bundle = v4EvidenceJson.trim() ? JSON.parse(v4EvidenceJson) : postToSave.heatCheckData.evidence_bundle;
                    } catch (e: any) {
                        throw new Error(`V4 Evidence Bundle JSON invalid: ${e.message}`);
                    }
                    try {
                        // Save advancedHeatStats
                        if (!postToSave.heatCheckData.matchPackV4) postToSave.heatCheckData.matchPackV4 = {};
                        if (!postToSave.heatCheckData.matchPackV4.factDrop) postToSave.heatCheckData.matchPackV4.factDrop = {};
                        if (!postToSave.heatCheckData.matchPackV4.factDrop.raw) postToSave.heatCheckData.matchPackV4.factDrop.raw = {};
                        postToSave.heatCheckData.matchPackV4.factDrop.raw.advancedHeatStats = v4AdvancedHeatStatsJson.trim() ? JSON.parse(v4AdvancedHeatStatsJson) : postToSave.heatCheckData.matchPackV4.factDrop.raw.advancedHeatStats;
                    } catch (e: any) {
                        throw new Error(`V4 Advanced Heat Stats JSON invalid: ${e.message}`);
                    }
                }
            }

            // V3: apply JSON editors if present
            if (postToSave.storyType === 'heat_article_v3' && !hcData.matchPackV4) {
                postToSave.heatCheckData = postToSave.heatCheckData || {};

                if (showV3Advanced) {
                    try {
                        postToSave.heatCheckData.v3Narrative = v3NarrativeJson.trim() ? JSON.parse(v3NarrativeJson) : postToSave.heatCheckData.v3Narrative;
                    } catch (e: any) {
                        throw new Error(`V3 Narrative JSON invalid: ${e.message}`);
                    }
                    try {
                        postToSave.heatCheckData.temperatureCheck = postToSave.heatCheckData.temperatureCheck || {};
                        postToSave.heatCheckData.temperatureCheck.ai = v3TempAiJson.trim() ? JSON.parse(v3TempAiJson) : postToSave.heatCheckData.temperatureCheck.ai;
                    } catch (e: any) {
                        throw new Error(`Temperature Check AI JSON invalid: ${e.message}`);
                    }
                    try {
                        postToSave.heatCheckData.evidence_bundle = v3EvidenceJson.trim() ? JSON.parse(v3EvidenceJson) : postToSave.heatCheckData.evidence_bundle;
                    } catch (e: any) {
                        throw new Error(`Evidence JSON invalid: ${e.message}`);
                    }
                }
            }
            
            // Remove imageUrl if image is set (to avoid confusion and match old articles structure)
            if (postToSave.websiteStory.image && postToSave.websiteStory.imageUrl) {
                delete postToSave.websiteStory.imageUrl;
            }
            
            console.log('[EditorModal] Saving post with image:', {
                postId: postToSave.id,
                image: postToSave.websiteStory.image,
                status: newStatus,
                websiteStoryKeys: Object.keys(postToSave.websiteStory || {}),
                articleImageState: articleImage,
                editedPostWebsiteStory: editedPost.websiteStory,
                fullWebsiteStory: postToSave.websiteStory
            });
            
            const updatedPost = await apiClient.updatePost(postToSave.id, postToSave);
            
            // Verify the save worked by checking the response
            console.log('[EditorModal] Post saved successfully');
            
            // NEW: If Heat Picks article is being published, sync matching matchup edges
            if (newStatus === 'published' && postToSave.storyType === 'heat_picks') {
                console.log('[EditorModal] Heat Picks published - syncing matchup edges...');
                // Run sync in background (don't block save)
                syncMatchupEdgesWithHeatPicks(updatedPost).catch(error => {
                    console.error('[EditorModal] Error syncing matchup edges:', error);
                });
            }
            
            onSave();
            onClose();
        } catch (error) {
            console.error("Failed to save post:", error);
            alert(`Failed to save post: ${error instanceof Error ? error.message : 'Unknown error'}`);
        } finally {
            setIsSaving(false);
        }
    };

    const handleApplyV3NarrativeToArticle = () => {
        if (!editedPost) return;
        if ((editedPost as any).storyType !== 'heat_article_v3') return;
        try {
            const hc: any = (editedPost as any).heatCheckData || {};
            const v3 = showV3Advanced ? (v3NarrativeJson.trim() ? JSON.parse(v3NarrativeJson) : hc.v3Narrative) : hc.v3Narrative;
            if (!v3) throw new Error('No v3Narrative available');

            // Extract evidence bundle for speaker lookup
            const evidenceBundle = hc.evidence_bundle || hc.evidenceBundle || {};
            const evidenceForV3 = normalizeEvidenceForV3(evidenceBundle);
            const markdown = renderHeatArticleV3Markdown(v3, evidenceForV3);

            // Map narrative cards into Narrative.log structure
            const cards = Array.isArray(v3?.narrativeCards) ? v3.narrativeCards : [];
            const primaryAngleId = v3?.selectedAngles?.primary?.id || cards?.[0]?.id || 'N_1';
            const candidateCards = cards.map((c: any) => ({
                narrative_id: String(c.id || ''),
                title: String(c.title || ''),
                claim: String(c.claim || ''),
                emotion_tags: Array.isArray(c.emotionTags) ? c.emotionTags : [],
                total_score: Number.isFinite(c.score) ? c.score : 0,
            }));

            setEditedPost(prev => {
                if (!prev) return prev;
                const newPost: any = JSON.parse(JSON.stringify(prev));
                newPost.websiteStory = newPost.websiteStory || {};
                newPost.websiteStory.theBackstory = markdown;

                newPost.heatCheckData = newPost.heatCheckData || {};
                newPost.heatCheckData.article = newPost.heatCheckData.article || {};
                newPost.heatCheckData.article.long_form_markdown = markdown;
                newPost.heatCheckData.v3Narrative = v3;
                newPost.heatCheckData.narratives = {
                    candidate_cards: candidateCards,
                    selected: { primary_narrative_id: String(primaryAngleId) }
                };
                return newPost;
            });

            alert('Applied V3 Narrative JSON → Article markdown + Narrative.log cards. Remember to Save Draft.');
        } catch (e: any) {
            alert(`Failed to apply V3 narrative: ${e.message || 'Unknown error'}`);
        }
    };

    const handleApplyV4NarrativeToArticle = () => {
        if (!editedPost) return;
        const hc: any = (editedPost as any).heatCheckData || {};
        if (!hc.matchPackV4) return;
        try {
            const v3 = showV4Advanced ? (v4NarrativeJson.trim() ? JSON.parse(v4NarrativeJson) : hc.v3Narrative) : hc.v3Narrative;
            if (!v3) throw new Error('No v3Narrative available');

            // Extract evidence bundle for speaker lookup
            const evidenceBundle = hc.evidence_bundle || hc.evidenceBundle || {};
            const evidenceForV3 = normalizeEvidenceForV3(evidenceBundle);
            const markdown = renderHeatArticleV3Markdown(v3, evidenceForV3);

            // Map narrative cards into Narrative.log structure
            const cards = Array.isArray(v3?.narrativeCards) ? v3.narrativeCards : [];
            const primaryAngleId = v3?.selectedAngles?.primary?.id || cards?.[0]?.id || 'N_1';
            const candidateCards = cards.map((c: any) => ({
                narrative_id: String(c.id || ''),
                title: String(c.title || ''),
                claim: String(c.claim || ''),
                emotion_tags: Array.isArray(c.emotionTags) ? c.emotionTags : [],
                total_score: Number.isFinite(c.score) ? c.score : 0,
            }));

            setEditedPost(prev => {
                if (!prev) return prev;
                const newPost: any = JSON.parse(JSON.stringify(prev));
                newPost.websiteStory = newPost.websiteStory || {};
                newPost.websiteStory.theBackstory = markdown;

                newPost.heatCheckData = newPost.heatCheckData || {};
                newPost.heatCheckData.article = newPost.heatCheckData.article || {};
                newPost.heatCheckData.article.long_form_markdown = markdown;
                newPost.heatCheckData.v3Narrative = v3;
                newPost.heatCheckData.narratives = {
                    candidate_cards: candidateCards,
                    selected: { primary_narrative_id: String(primaryAngleId) }
                };
                return newPost;
            });

            alert('Applied V4 Narrative JSON → Article markdown + Narrative.log cards. Remember to Save Draft.');
        } catch (e: any) {
            alert(`Failed to apply V4 narrative: ${e.message || 'Unknown error'}`);
        }
    };


    const handleApplyFeedback = async () => {
        if (!editedPost || !aiFeedback.trim()) return;
        setIsApplyingFeedback(true);
        try {
            // Extract current data
            const heatCheckData = (editedPost as any).heatCheckData || {};
            const narrativeCards = heatCheckData.narratives?.candidate_cards || [];
            const primaryNarrativeId = heatCheckData.narratives?.selected?.primary_narrative_id || '';
            const primaryCard = narrativeCards.find((card: any) => card.narrative_id === primaryNarrativeId) || narrativeCards[0] || {};
            const evidenceBundle = heatCheckData.evidenceBundle || heatCheckData.evidence_bundle || {};
            const quotes = evidenceBundle.quotes || [];
            const timelineEvents = evidenceBundle.timeline_events || [];
            const heatchecksEdge = editedPost.heatchecksEdge || {};

            const prompt = `You are an AI editor for a sports analysis article. Apply this feedback to improve ALL components of the article: "${aiFeedback}"

CURRENT ARTICLE CONTENT:
${editedPost.websiteStory.theBackstory || 'No article content'}

PRIMARY NARRATIVE CARD:
Title: ${primaryCard.title || 'N/A'}
Claim: ${primaryCard.claim || 'N/A'}
Emotion Tags: ${primaryCard.emotion_tags?.join(', ') || 'N/A'}

EVIDENCE QUOTES:
${quotes.map((q: any, i: number) => `${i + 1}. "${q.quote}" - ${q.speaker} (${q.team || 'N/A'})`).join('\n') || 'No quotes'}

TIMELINE EVENTS:
${timelineEvents.map((e: any, i: number) => `${i + 1}. ${e.summary} (${e.date_utc || 'N/A'})`).join('\n') || 'No timeline events'}

HEATCHECKS EDGE:
Final Call: ${heatchecksEdge.finalCall || 'N/A'}
Rationale Bullets: ${heatchecksEdge.rationaleBullets?.join('\n- ') || 'N/A'}
Risk Counterpoints: ${heatchecksEdge.riskCounterpoints?.join('\n- ') || 'N/A'}

TASK: Apply the feedback to improve ALL of these components. Return a JSON object with the following structure:
{
  "article": "improved article markdown text",
  "narrativeCard": {
    "title": "improved title",
    "claim": "improved claim",
    "emotion_tags": ["tag1", "tag2"]
  },
  "quotes": [
    {"quote": "improved quote text", "speaker": "speaker name", "team": "team name"}
  ],
  "timelineEvents": [
    {"summary": "improved event summary", "date_utc": "date string"}
  ],
  "heatchecksEdge": {
    "finalCall": "improved final call text",
    "rationaleBullets": ["bullet 1", "bullet 2"],
    "riskCounterpoints": ["risk 1", "risk 2"]
  }
}

IMPORTANT:
- Only include fields that need to be changed based on the feedback
- If a component doesn't need changes, you can omit it or keep it the same
- Preserve the structure and formatting of all components
- Make improvements that align with the feedback provided`;

            const response = await ai.models.generateContent({
                model: 'gemini-2.5-pro',
                contents: prompt,
                config: { 
                    tools: [{ googleSearch: {} }]
                }
            });

            const result = extractJson<any>(response.text);
            
            // Update all components using functional state update to ensure we have latest state
            setEditedPost(prev => {
                if (!prev) return prev;
                const newPost = JSON.parse(JSON.stringify(prev));
                
                // Update article if provided
                if (result.article) {
                    newPost.websiteStory = newPost.websiteStory || {};
                    newPost.websiteStory.theBackstory = result.article;
                }

                // Update narrative card if provided
                if (result.narrativeCard && primaryCard) {
                    newPost.heatCheckData = newPost.heatCheckData || {};
                    newPost.heatCheckData.narratives = newPost.heatCheckData.narratives || {};
                    newPost.heatCheckData.narratives.candidate_cards = newPost.heatCheckData.narratives.candidate_cards || [];
                    const updatedCards = [...newPost.heatCheckData.narratives.candidate_cards];
                    const cardIndex = updatedCards.findIndex((card: any) => card.narrative_id === primaryNarrativeId);
                    if (cardIndex >= 0) {
                        updatedCards[cardIndex] = {
                            ...updatedCards[cardIndex],
                            title: result.narrativeCard.title || updatedCards[cardIndex].title,
                            claim: result.narrativeCard.claim || updatedCards[cardIndex].claim,
                            emotion_tags: result.narrativeCard.emotion_tags || updatedCards[cardIndex].emotion_tags
                        };
                        newPost.heatCheckData.narratives.candidate_cards = updatedCards;
                    }
                }

                // Update quotes if provided
                if (result.quotes && Array.isArray(result.quotes)) {
                    newPost.heatCheckData = newPost.heatCheckData || {};
                    newPost.heatCheckData.evidence_bundle = newPost.heatCheckData.evidence_bundle || {};
                    newPost.heatCheckData.evidence_bundle.quotes = result.quotes.map((q: any) => ({
                        quote: q.quote,
                        speaker: q.speaker || '',
                        team: q.team || '',
                        context: q.context || '',
                        source_id: q.source_id || '',
                        quote_id: q.quote_id || `Q_${Date.now()}_${Math.random()}`
                    }));
                }

                // Update timeline events if provided
                if (result.timelineEvents && Array.isArray(result.timelineEvents)) {
                    newPost.heatCheckData = newPost.heatCheckData || {};
                    newPost.heatCheckData.evidence_bundle = newPost.heatCheckData.evidence_bundle || {};
                    newPost.heatCheckData.evidence_bundle.timeline_events = result.timelineEvents.map((e: any) => ({
                        summary: e.summary,
                        date_utc: e.date_utc || new Date().toISOString(),
                        event_type: e.event_type || 'other',
                        event_id: e.event_id || `E_${Date.now()}_${Math.random()}`,
                        source_id: e.source_id || ''
                    }));
                }

                // Update HeatChecks Edge if provided
                if (result.heatchecksEdge) {
                    newPost.heatchecksEdge = newPost.heatchecksEdge || {};
                    if (result.heatchecksEdge.finalCall) {
                        newPost.heatchecksEdge.finalCall = result.heatchecksEdge.finalCall;
                    }
                    if (result.heatchecksEdge.rationaleBullets) {
                        newPost.heatchecksEdge.rationaleBullets = result.heatchecksEdge.rationaleBullets;
                    }
                    if (result.heatchecksEdge.riskCounterpoints) {
                        newPost.heatchecksEdge.riskCounterpoints = result.heatchecksEdge.riskCounterpoints;
                    }
                }

                return newPost;
            });

            setAiFeedback('');
        } catch (error) {
            console.error("Failed to apply feedback:", error);
            alert(`Failed to apply feedback: ${error instanceof Error ? error.message : 'Unknown error'}`);
        } finally {
            setIsApplyingFeedback(false);
        }
    };

    const handleSelectImage = (imageName: string) => {
        const imagePath = `/assets/images/${imageName}`;
        setArticleImage(imagePath);
        handleFieldChange('websiteStory.image', imagePath); // Save to editedPost
        setShowImageSelector(false);
        setImageDateFilter(''); // Reset filter when closing
    };

    // DFS AI Assistant: Replace a player
    const handleReplaceDFSPlayer = async () => {
        if (!editedPost || selectedPlayerToReplace === null || !dfsReplacementInstructions.trim()) return;
        setIsReplacingPlayer(true);
        
        try {
            const apiKey = import.meta.env.VITE_GEMINI_API_KEY || (window as any).process?.env?.API_KEY || '';
            if (!apiKey) {
                throw new Error('API key not available');
            }

            const ai = new GoogleGenAI({ apiKey });
            const playerToReplace = dfsPlayers[selectedPlayerToReplace];
            const currentMarkdown = editedPost.websiteStory.theBackstory || '';
            
            // Find the section for this player in the markdown
            // Look for the player section starting with ### [rank]. [Player Name]
            const rank = selectedPlayerToReplace + 1;
            const playerNameEscaped = playerToReplace.playerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const playerSectionPattern = new RegExp(
                `###\\s+${rank}\\.\\s+${playerNameEscaped}[\\s\\S]*?(?=###\\s+\\d+\\.|$)`,
                'i'
            );
            const playerSection = currentMarkdown.match(playerSectionPattern)?.[0] || '';
            
            if (!playerSection) {
                throw new Error(`Could not find player section for ${playerToReplace.playerName} in the article.`);
            }

            const prompt = `You are an AI assistant for editing DFS articles. Replace the following player section with a NEW player based on the instructions.

CURRENT PLAYER TO REPLACE:
${playerSection}

INSTRUCTIONS: ${dfsReplacementInstructions}

LEAGUE: ${editedPost.league}
DATE: ${editedPost.matchupScheduledDate || editedPost.createdAt}

TASK:
1. Find a suitable replacement player from the same league that fits the instructions
2. Generate a new player section in the EXACT same format as the current one
3. Maintain the same markdown structure:
   - ### [rank]. [Player Name] ([Position]) - [Team] vs [Opponent]
   - **Salary:** $[salary] | **Confidence:** [score]% | **Narrative:** [type]
   - **Key Stat:** [stat] (if applicable)
   - [Analysis text]
   - ---

4. The new player should:
   - Have a similar salary range or be a value play
   - Have a strong narrative angle (Revenge, Pace, Game Script, etc.)
   - Include compelling analysis in the same beat writer style
   - Match the tone and format of the existing article

Return ONLY the new player section in markdown format, exactly matching the structure above.`;

            const response = await ai.models.generateContent({
                model: 'gemini-2.0-flash-exp',
                contents: prompt,
                config: {
                    tools: [{ googleSearch: {} }]
                }
            });

            let newPlayerSection = response.text.trim();
            
            // Clean up the response - remove any markdown code blocks if present
            const codeBlockMatch = newPlayerSection.match(/```(?:markdown)?\s*([\s\S]*?)\s*```/);
            if (codeBlockMatch) {
                newPlayerSection = codeBlockMatch[1].trim();
            }
            
            // Ensure the section ends with --- separator
            if (!newPlayerSection.trim().endsWith('---')) {
                newPlayerSection = newPlayerSection.trim() + '\n\n---\n\n';
            }
            
            // Extract player data from the new section
            const playerNameMatch = newPlayerSection.match(/###\s+\d+\.\s+([^(]+)\s+\(/);
            const positionMatch = newPlayerSection.match(/\(([^)]+)\)/);
            const teamMatch = newPlayerSection.match(/\s+-\s+([A-Z]+)\s+vs/);
            const opponentMatch = newPlayerSection.match(/vs\s+([A-Z]+)/);
            const salaryMatch = newPlayerSection.match(/\*\*Salary:\*\*\s+\$(\d+)/);
            const confidenceMatch = newPlayerSection.match(/\*\*Confidence:\*\*\s+(\d+)%/);
            const narrativeMatch = newPlayerSection.match(/\*\*Narrative:\*\*\s+([^\n|]+)/);
            const keyStatMatch = newPlayerSection.match(/\*\*Key Stat:\*\*\s+([^\n]+)/);
            
            // Extract analysis text (everything after the metadata lines, before ---)
            const analysisStart = newPlayerSection.indexOf('**Key Stat:**') > -1 
                ? newPlayerSection.indexOf('**Key Stat:**') + newPlayerSection.substring(newPlayerSection.indexOf('**Key Stat:**')).indexOf('\n\n') + 2
                : newPlayerSection.indexOf('**Narrative:**') > -1
                ? newPlayerSection.indexOf('**Narrative:**') + newPlayerSection.substring(newPlayerSection.indexOf('**Narrative:**')).indexOf('\n\n') + 2
                : newPlayerSection.indexOf('\n\n') + 2;
            const analysisEnd = newPlayerSection.lastIndexOf('---');
            const analysis = newPlayerSection.substring(analysisStart, analysisEnd > -1 ? analysisEnd : newPlayerSection.length).trim();
            
            const newPlayer = {
                rank: selectedPlayerToReplace + 1,
                playerName: playerNameMatch?.[1]?.trim() || 'Unknown Player',
                position: positionMatch?.[1] || 'N/A',
                team: teamMatch?.[1] || 'N/A',
                opponent: opponentMatch?.[1] || 'N/A',
                salary: salaryMatch?.[1] || playerToReplace.salary,
                narrativeType: narrativeMatch?.[1]?.trim() || 'General Value',
                confidenceScore: parseInt(confidenceMatch?.[1] || '75'),
                analysis: analysis || 'Analysis will be generated.',
                keyStat: keyStatMatch?.[1]?.trim()
            };

            // Replace the player section in markdown
            const updatedMarkdown = currentMarkdown.replace(playerSectionPattern, newPlayerSection);
            
            // Update the editedPost
            setEditedPost(prev => {
                if (!prev) return prev;
                const newPost = JSON.parse(JSON.stringify(prev));
                
                // Update markdown
                newPost.websiteStory.theBackstory = updatedMarkdown;
                
                // Update dfsPlayers array
                newPost.heatCheckData = newPost.heatCheckData || {};
                newPost.heatCheckData.dfsPlayers = newPost.heatCheckData.dfsPlayers || [];
                newPost.heatCheckData.dfsPlayers[selectedPlayerToReplace] = newPlayer;
                
                // Update long_form_markdown if it exists
                if (newPost.heatCheckData.article) {
                    newPost.heatCheckData.article.long_form_markdown = updatedMarkdown;
                }
                
                return newPost;
            });

            // Reset form
            setSelectedPlayerToReplace(null);
            setDfsReplacementInstructions('');
            
            alert('Player replaced successfully! Remember to save the article.');
        } catch (error: any) {
            console.error('Failed to replace player:', error);
            alert(`Failed to replace player: ${error.message || 'Unknown error'}`);
        } finally {
            setIsReplacingPlayer(false);
        }
    };

    if (!editedPost) return null;

    // Extract heatCheckData if available
    const heatCheckData = (editedPost as any).heatCheckData;
    const narrativeCards = heatCheckData?.narratives?.candidate_cards || [];
    const primaryNarrativeId = heatCheckData?.narratives?.selected?.primary_narrative_id || '';
    // Fix: Check both evidenceBundle and evidence_bundle for compatibility
    const evidenceBundle = heatCheckData?.evidenceBundle || heatCheckData?.evidence_bundle || { quotes: [], timeline_events: [] };
    const qualityReport = heatCheckData?.quality_report;
    // Get validation warnings from stored data (validated during generation)
    const validationWarnings = heatCheckData?.validation_warnings || [];
    
    // Extract DFS players if this is a DFS article
    const isDFSArticle = editedPost.storyType === 'dfs_article';
    const dfsPlayers = heatCheckData?.dfsPlayers || [];

    return (
        <div className="modal-overlay" style={{ background: 'rgba(0,0,0,0.9)', zIndex: 1000 }}>
            <div style={{ 
                position: 'fixed', 
                top: 0, 
                left: 0, 
                right: 0, 
                bottom: 0, 
                display: 'flex', 
                flexDirection: 'column',
                background: '#1a1a1a',
                color: '#fff'
            }}>
                {/* Header */}
                <div style={{ padding: '1rem 2rem', borderBottom: '1px solid #333', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                        <h2 style={{ margin: 0, fontSize: '1.5rem' }}>HeatCheck Editor: {editedPost.teamA} vs {editedPost.teamB}</h2>
                        <p style={{ margin: '0.25rem 0 0 0', color: '#999', fontSize: '0.9rem' }}>This is your content creation and management dashboard.</p>
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                        {editedPost.status === 'published' ? (
                            <>
                                <button className="save-draft" onClick={() => handleSave("draft")} disabled={isSaving} style={{ background: '#ff9800', color: '#fff', border: 'none', padding: '0.5rem 1rem', borderRadius: '4px', cursor: 'pointer' }}>
                                    {isSaving ? 'Saving...' : 'Unpublish'}
                                </button>
                                <button className="publish" onClick={() => handleSave("published")} disabled={isSaving} style={{ background: '#4caf50', color: '#fff', border: 'none', padding: '0.5rem 1rem', borderRadius: '4px', cursor: 'pointer' }}>
                                    {isSaving ? 'Updating...' : 'Update Published'}
                                </button>
                            </>
                        ) : (
                            <>
                        <button className="save-draft" onClick={() => handleSave("draft")} disabled={isSaving} style={{ background: '#2196f3', color: '#fff', border: 'none', padding: '0.5rem 1rem', borderRadius: '4px', cursor: 'pointer' }}>
                            {isSaving ? 'Saving...' : 'Save Draft'}
                        </button>
                        <button className="publish" onClick={() => handleSave("published")} disabled={isSaving} style={{ background: '#4caf50', color: '#fff', border: 'none', padding: '0.5rem 1rem', borderRadius: '4px', cursor: 'pointer' }}>
                            {isSaving ? 'Publishing...' : 'Publish'}
                                </button>
                            </>
                        )}
                        <button
                            className="delete"
                            onClick={async () => {
                                if (!editedPost || isSaving) return;
                                const ok = confirm(`Delete this post?\\n\\n${editedPost.websiteStory?.headline || editedPost.id}`);
                                if (!ok) return;
                                try {
                                    setIsSaving(true);
                                    await apiClient.deletePost(editedPost.id);
                                    onSave();
                                    onClose();
                                } catch (e: any) {
                                    alert(`Failed to delete: ${e.message || 'Unknown error'}`);
                                } finally {
                                    setIsSaving(false);
                                }
                            }}
                            disabled={isSaving}
                            style={{ background: '#c62828', color: '#fff', border: 'none', padding: '0.5rem 1rem', borderRadius: '4px', cursor: 'pointer' }}
                        >
                            {isSaving ? 'Working...' : 'Delete'}
                        </button>
                        <button className="cancel" onClick={onClose} disabled={isSaving} style={{ background: '#666', color: '#fff', border: 'none', padding: '0.5rem 1rem', borderRadius: '4px', cursor: 'pointer' }}>
                            Cancel
                        </button>
                        {/* Sync Matchup Edges button for Heat Picks articles */}
                        {(editedPost as any).storyType === 'heat_picks' && (
                            <button
                                onClick={async () => {
                                    if (!editedPost) return;
                                    try {
                                        await syncMatchupEdgesWithHeatPicks(editedPost);
                                        alert('Matchup edges synced successfully! Check console for details.');
                                    } catch (error: any) {
                                        console.error('[Sync Button] Error:', error);
                                        alert(`Failed to sync: ${error.message || 'Unknown error'}`);
                                    }
                                }}
                                disabled={isSaving}
                                style={{ 
                                    padding: '0.5rem 1rem', 
                                    background: '#00ff41', 
                                    color: '#000', 
                                    border: 'none', 
                                    borderRadius: '4px', 
                                    cursor: 'pointer',
                                    fontWeight: 'bold'
                                }}
                                title="Sync heatchecksEdge on all matching matchup articles with Heat Picks"
                            >
                                Sync Matchup Edges
                            </button>
                        )}
                    </div>
                </div>

                {/* Main Content - Two Column Layout */}
                <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
                    {/* Left Column - Article Editor */}
                    <div style={{ flex: '1 1 60%', padding: '2rem', overflowY: 'auto', borderRight: '1px solid #333' }}>
                        <div style={{ marginBottom: '2rem' }}>
                            <h3 style={{ marginBottom: '0.5rem', fontSize: '1.2rem' }}>Article (Markdown)</h3>

                            {/* V3 Editor (Temperature Check + Advanced JSON) */}
                            {(editedPost as any).storyType === 'heat_article_v3' && (
                                <div style={{ marginBottom: '1.5rem', padding: '1rem', background: '#222', border: '1px solid rgba(255, 230, 109, 0.35)', borderRadius: '6px' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
                                        <div>
                                            <div style={{ fontWeight: 'bold', color: '#ffe66d' }}>HeatArticleV3 Editor</div>
                                            <div style={{ color: '#aaa', fontSize: '0.85rem' }}>Edit Temperature Check + (optional) raw V3 JSON before publishing.</div>
                                        </div>
                                        <button
                                            onClick={() => setShowV3Advanced(v => !v)}
                                            style={{ padding: '0.4rem 0.75rem', background: showV3Advanced ? '#444' : '#333', color: '#fff', border: '1px solid #555', borderRadius: '4px', cursor: 'pointer' }}
                                        >
                                            {showV3Advanced ? 'Hide Advanced' : 'Show Advanced'}
                                        </button>
                                    </div>

                                    <div style={{ marginTop: '1rem' }}>
                                        <div style={{ fontWeight: 'bold', marginBottom: '0.5rem' }}>Temperature Check (Published Text)</div>
                                        <div style={{ color: '#aaa', fontSize: '0.85rem', marginBottom: '0.5rem' }}>
                                            This is the exact text that will display in the Temperature Check section on the published page.
                                        </div>
                                        <textarea
                                            value={String(((editedPost as any).heatCheckData?.temperatureCheck?.renderedMarkdown) || '')}
                                            onChange={(e) => handleFieldChange('heatCheckData.temperatureCheck.renderedMarkdown', e.target.value)}
                                            placeholder="Write the Temperature Check exactly how you want it to appear..."
                                            style={{ width: '100%', minHeight: '160px', padding: '0.75rem', background: '#111', border: '1px solid rgba(255, 230, 109, 0.35)', color: '#fff', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.9rem', lineHeight: '1.5' }}
                                        />

                                        <div style={{ marginTop: '0.75rem' }}>
                                            <div style={{ fontWeight: 'bold', marginBottom: '0.4rem' }}>Preview (Published)</div>
                                            <div
                                                style={{ padding: '0.75rem', background: '#0d0d0d', border: '1px solid #333', borderRadius: '4px' }}
                                                dangerouslySetInnerHTML={{
                                                    __html: (() => {
                                                        const raw = String(((editedPost as any).heatCheckData?.temperatureCheck?.renderedMarkdown) || '');
                                                        const looksHtml = /<\s*(div|section|span|canvas|table|p|ul|ol|h[1-6]|br)\b/i.test(raw);
                                                        return looksHtml ? raw : markdownToHtml(raw);
                                                    })()
                                                }}
                                            />
                                        </div>

                                        {(() => {
                                            const charts: any = (editedPost as any).heatCheckData?.matchPackV3?.factDrop?.charts || null;
                                            const hasCharts =
                                                charts &&
                                                (charts?.momentumLine || charts?.starLoad || charts?.pressureBar || charts?.roleVolatility);
                                            if (!hasCharts) return null;
                                            const idSuffix = editedPost.id;
                                            return (
                                                <div style={{ marginTop: '0.75rem' }}>
                                                    <div style={{ fontWeight: 'bold', marginBottom: '0.4rem' }}>Charts Preview (Canvas)</div>
                                                    <div style={{ color: '#aaa', fontSize: '0.85rem', marginBottom: '0.5rem' }}>
                                                        These charts render from MatchPackV3 data (canvas). SEO still comes from the surrounding written analysis.
                                                    </div>
                                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                                                        <div style={{ padding: '0.75rem', background: '#0d0d0d', border: '1px solid #333', borderRadius: '6px' }}>
                                                            <div style={{ color: '#ddd', fontSize: '0.85rem', marginBottom: '0.5rem' }}>Rolling Margin Trend</div>
                                                            {(() => {
                                                                const m = (editedPost as any).heatCheckData?.matchPackV3?.factDrop?.charts?.momentumLine;
                                                                const aLabel = String(m?.series?.A?.label || (editedPost as any).heatCheckData?.matchPackV3?.matchup?.teamAAbbr || 'A');
                                                                const bLabel = String(m?.series?.B?.label || (editedPost as any).heatCheckData?.matchPackV3?.matchup?.teamBAbbr || 'B');
                                                                return (
                                                                    <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap', fontFamily: 'Courier New, monospace', fontSize: '0.75rem', color: 'rgba(255,255,255,0.72)', marginBottom: '0.5rem' }}>
                                                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                                                                            <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 999, background: 'rgba(255,26,26,0.95)', boxShadow: '0 0 10px rgba(255,26,26,0.18)' }} />
                                                                            <span>{aLabel}</span>
                                                                        </div>
                                                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                                                                            <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 999, background: 'rgba(255,230,109,0.95)', boxShadow: '0 0 10px rgba(255,230,109,0.12)' }} />
                                                                            <span>{bLabel}</span>
                                                                        </div>
                                                                    </div>
                                                                );
                                                            })()}
                                                            <div style={{ height: 170 }}>
                                                                <canvas id={`v3-editor-chart-momentum-${idSuffix}`} style={{ width: '100%', height: '100%' }} />
                                                            </div>
                                                        </div>
                                                        <div style={{ padding: '0.75rem', background: '#0d0d0d', border: '1px solid #333', borderRadius: '6px' }}>
                                                            <div style={{ color: '#ddd', fontSize: '0.85rem', marginBottom: '0.5rem' }}>Usage vs Minutes Stress</div>
                                                            <div style={{ height: 200 }}>
                                                                <canvas id={`v3-editor-chart-starload-${idSuffix}`} style={{ width: '100%', height: '100%' }} />
                                                            </div>
                                                        </div>
                                                        <div style={{ padding: '0.75rem', background: '#0d0d0d', border: '1px solid #333', borderRadius: '6px' }}>
                                                            <div style={{ color: '#ddd', fontSize: '0.85rem', marginBottom: '0.5rem' }}>Close-Game Record</div>
                                                            <div style={{ height: 140 }}>
                                                                <canvas id={`v3-editor-chart-pressure-${idSuffix}`} style={{ width: '100%', height: '100%' }} />
                                                            </div>
                                                        </div>
                                                        <div style={{ padding: '0.75rem', background: '#0d0d0d', border: '1px solid #333', borderRadius: '6px' }}>
                                                            <div style={{ color: '#ddd', fontSize: '0.85rem', marginBottom: '0.5rem' }}>Role Volatility (ΔUSG3 vs Season)</div>
                                                            <div style={{ height: 220 }}>
                                                                <canvas id={`v3-editor-chart-volatility-${idSuffix}`} style={{ width: '100%', height: '100%' }} />
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                            );
                                        })()}

                                        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
                                            <button
                                                onClick={handleApplyV3NarrativeToArticle}
                                                style={{ padding: '0.5rem 0.75rem', background: '#ffe66d', color: '#000', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
                                            >
                                                Apply V3 Narrative JSON → Article
                                            </button>
                                        </div>
                                    </div>

                                    {showV3Advanced && (
                                        <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid #333' }}>
                                            <div style={{ fontWeight: 'bold', marginBottom: '0.5rem' }}>Advanced (Raw JSON)</div>
                                            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '0.75rem' }}>
                                                <div style={{ padding: '0.75rem', background: '#151515', border: '1px solid #333', borderRadius: '4px' }}>
                                                    <div style={{ fontWeight: 'bold', marginBottom: '0.5rem' }}>Temperature Check (Auto-build settings)</div>
                                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                                                        <div>
                                                            <label style={{ display: 'block', fontSize: '0.85rem', color: '#bbb', marginBottom: '0.25rem' }}>Highlight comparison key</label>
                                                            <input
                                                                type="text"
                                                                value={((editedPost as any).heatCheckData?.temperatureCheck?.summary?.highlightComparisonKey) || ''}
                                                                onChange={(e) => handleFieldChange('heatCheckData.temperatureCheck.summary.highlightComparisonKey', e.target.value)}
                                                                placeholder="e.g., margin10"
                                                                style={{ width: '100%', padding: '0.5rem', background: '#111', border: '1px solid #444', color: '#fff', borderRadius: '4px' }}
                                                            />
                                                        </div>
                                                        <div>
                                                            <label style={{ display: 'block', fontSize: '0.85rem', color: '#bbb', marginBottom: '0.25rem' }}>Availability display override</label>
                                                            <input
                                                                type="text"
                                                                value={((editedPost as any).heatCheckData?.temperatureCheck?.summary?.availabilityDisplayOverride) || ''}
                                                                onChange={(e) => handleFieldChange('heatCheckData.temperatureCheck.summary.availabilityDisplayOverride', e.target.value)}
                                                                placeholder="Optional: custom text to display"
                                                                style={{ width: '100%', padding: '0.5rem', background: '#111', border: '1px solid #444', color: '#fff', borderRadius: '4px' }}
                                                            />
                                                        </div>
                                                        <div style={{ gridColumn: '1 / -1' }}>
                                                            <label style={{ display: 'block', fontSize: '0.85rem', color: '#bbb', marginBottom: '0.25rem' }}>Visible bullet keys (one per line)</label>
                                                            <textarea
                                                                value={Array.isArray((editedPost as any).heatCheckData?.temperatureCheck?.summary?.visibleBulletKeys) ? (editedPost as any).heatCheckData.temperatureCheck.summary.visibleBulletKeys.join('\\n') : ''}
                                                                onChange={(e) => handleFieldChange('heatCheckData.temperatureCheck.summary.visibleBulletKeys', e.target.value.split('\\n').map(s => s.trim()).filter(Boolean))}
                                                                style={{ width: '100%', minHeight: '80px', padding: '0.5rem', background: '#111', border: '1px solid #444', color: '#fff', borderRadius: '4px', fontFamily: 'monospace' }}
                                                            />
                                                        </div>
                                                        <div style={{ gridColumn: '1 / -1' }}>
                                                            <label style={{ display: 'block', fontSize: '0.85rem', color: '#bbb', marginBottom: '0.25rem' }}>Priority players override (displayText, one per line)</label>
                                                            <textarea
                                                                value={Array.isArray((editedPost as any).heatCheckData?.temperatureCheck?.summary?.priorityPlayersOverride) ? (editedPost as any).heatCheckData.temperatureCheck.summary.priorityPlayersOverride.join('\\n') : ''}
                                                                onChange={(e) => handleFieldChange('heatCheckData.temperatureCheck.summary.priorityPlayersOverride', e.target.value.split('\\n').map(s => s.trim()).filter(Boolean))}
                                                                style={{ width: '100%', minHeight: '80px', padding: '0.5rem', background: '#111', border: '1px solid #444', color: '#fff', borderRadius: '4px', fontFamily: 'monospace' }}
                                                            />
                                                        </div>
                                                    </div>
                                                </div>
                                                <div>
                                                    <label style={{ display: 'block', fontSize: '0.85rem', color: '#bbb', marginBottom: '0.25rem' }}>V3 Narrative JSON (editable)</label>
                                                    <textarea
                                                        value={v3NarrativeJson}
                                                        onChange={(e) => setV3NarrativeJson(e.target.value)}
                                                        style={{ width: '100%', minHeight: '180px', padding: '0.5rem', background: '#111', border: '1px solid #444', color: '#fff', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.85rem' }}
                                                    />
                                                </div>
                                                <div>
                                                    <label style={{ display: 'block', fontSize: '0.85rem', color: '#bbb', marginBottom: '0.25rem' }}>Temperature Check AI JSON (editable)</label>
                                                    <textarea
                                                        value={v3TempAiJson}
                                                        onChange={(e) => setV3TempAiJson(e.target.value)}
                                                        style={{ width: '100%', minHeight: '140px', padding: '0.5rem', background: '#111', border: '1px solid #444', color: '#fff', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.85rem' }}
                                                    />
                                                </div>
                                                <div>
                                                    <label style={{ display: 'block', fontSize: '0.85rem', color: '#bbb', marginBottom: '0.25rem' }}>Evidence Bundle JSON (editable)</label>
                                                    <textarea
                                                        value={v3EvidenceJson}
                                                        onChange={(e) => setV3EvidenceJson(e.target.value)}
                                                        style={{ width: '100%', minHeight: '140px', padding: '0.5rem', background: '#111', border: '1px solid #444', color: '#fff', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.85rem' }}
                                                    />
                                                </div>
                                            </div>
                                            <div style={{ color: '#999', fontSize: '0.8rem', marginTop: '0.5rem' }}>
                                                Tip: After editing V3 Narrative JSON, click <span style={{ color: '#ffe66d', fontWeight: 'bold' }}>Apply V3 Narrative JSON → Article</span> to sync markdown + Narrative.log.
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* V4 Editor Section */}
                            {isV4Article && (
                                <div style={{ marginBottom: '1.5rem', padding: '1rem', background: '#222', border: '1px solid rgba(255, 107, 53, 0.35)', borderRadius: '6px' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
                                        <div>
                                            <div style={{ fontWeight: 'bold', color: '#ff6b35' }}>HeatArticleV4 Editor</div>
                                            <div style={{ color: '#aaa', fontSize: '0.85rem' }}>Edit Temperature Check + (optional) raw V4 JSON before publishing.</div>
                                        </div>
                                        <button
                                            onClick={() => setShowV4Advanced(v => !v)}
                                            style={{ padding: '0.4rem 0.75rem', background: showV4Advanced ? '#444' : '#333', color: '#fff', border: '1px solid #555', borderRadius: '4px', cursor: 'pointer' }}
                                        >
                                            {showV4Advanced ? 'Hide Advanced' : 'Show Advanced'}
                                        </button>
                                    </div>

                                    <div style={{ marginTop: '1rem' }}>
                                        <div style={{ fontWeight: 'bold', marginBottom: '0.5rem' }}>Temperature Check (Published Text)</div>
                                        <div style={{ color: '#aaa', fontSize: '0.85rem', marginBottom: '0.5rem' }}>
                                            This is the exact text that will display in the Temperature Check section on the published page.
                                        </div>
                                        <textarea
                                            value={String(((editedPost as any).heatCheckData?.temperatureCheck?.renderedMarkdown) || '')}
                                            onChange={(e) => handleFieldChange('heatCheckData.temperatureCheck.renderedMarkdown', e.target.value)}
                                            placeholder="Write the Temperature Check exactly how you want it to appear..."
                                            style={{ width: '100%', minHeight: '160px', padding: '0.75rem', background: '#111', border: '1px solid rgba(255, 107, 53, 0.35)', color: '#fff', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.9rem', lineHeight: '1.5' }}
                                        />

                                        <div style={{ marginTop: '0.75rem' }}>
                                            <div style={{ fontWeight: 'bold', marginBottom: '0.4rem' }}>Preview (Published)</div>
                                            <div
                                                style={{ padding: '0.75rem', background: '#0d0d0d', border: '1px solid #333', borderRadius: '4px' }}
                                                dangerouslySetInnerHTML={{
                                                    __html: (() => {
                                                        const raw = String(((editedPost as any).heatCheckData?.temperatureCheck?.renderedMarkdown) || '');
                                                        const looksHtml = /<\s*(div|section|span|canvas|table|p|ul|ol|h[1-6]|br)\b/i.test(raw);
                                                        return looksHtml ? raw : markdownToHtml(raw);
                                                    })()
                                                }}
                                            />
                                        </div>

                                        {(() => {
                                            const charts: any = (editedPost as any).heatCheckData?.matchPackV4?.factDrop?.charts || null;
                                            const hasCharts =
                                                charts &&
                                                (charts?.momentumLine || charts?.starLoad || charts?.pressureBar || charts?.roleVolatility);
                                            if (!hasCharts) return null;
                                            const idSuffix = editedPost.id;
                                            return (
                                                <div style={{ marginTop: '0.75rem' }}>
                                                    <div style={{ fontWeight: 'bold', marginBottom: '0.4rem' }}>Charts Preview (Canvas)</div>
                                                    <div style={{ color: '#aaa', fontSize: '0.85rem', marginBottom: '0.5rem' }}>
                                                        These charts render from MatchPackV4 data (canvas). SEO still comes from the surrounding written analysis.
                                                    </div>
                                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                                                        <div style={{ padding: '0.75rem', background: '#0d0d0d', border: '1px solid #333', borderRadius: '6px' }}>
                                                            <div style={{ color: '#ddd', fontSize: '0.85rem', marginBottom: '0.5rem' }}>Rolling Margin Trend</div>
                                                            {(() => {
                                                                const m = (editedPost as any).heatCheckData?.matchPackV4?.factDrop?.charts?.momentumLine;
                                                                const aLabel = String(m?.series?.A?.label || (editedPost as any).heatCheckData?.matchPackV4?.matchup?.teamAAbbr || 'A');
                                                                const bLabel = String(m?.series?.B?.label || (editedPost as any).heatCheckData?.matchPackV4?.matchup?.teamBAbbr || 'B');
                                                                return (
                                                                    <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap', fontFamily: 'Courier New, monospace', fontSize: '0.75rem', color: 'rgba(255,255,255,0.72)', marginBottom: '0.5rem' }}>
                                                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                                                                            <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 999, background: 'rgba(255,26,26,0.95)', boxShadow: '0 0 10px rgba(255,26,26,0.18)' }} />
                                                                            <span>{aLabel}</span>
                                                                        </div>
                                                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                                                                            <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 999, background: 'rgba(255,230,109,0.95)', boxShadow: '0 0 10px rgba(255,230,109,0.12)' }} />
                                                                            <span>{bLabel}</span>
                                                                        </div>
                                                                    </div>
                                                                );
                                                            })()}
                                                            <div style={{ height: 170 }}>
                                                                <canvas id={`v4-editor-chart-momentum-${idSuffix}`} style={{ width: '100%', height: '100%' }} />
                                                            </div>
                                                        </div>
                                                        <div style={{ padding: '0.75rem', background: '#0d0d0d', border: '1px solid #333', borderRadius: '6px' }}>
                                                            <div style={{ color: '#ddd', fontSize: '0.85rem', marginBottom: '0.5rem' }}>Usage vs Minutes Stress</div>
                                                            <div style={{ height: 200 }}>
                                                                <canvas id={`v4-editor-chart-starload-${idSuffix}`} style={{ width: '100%', height: '100%' }} />
                                                            </div>
                                                        </div>
                                                        <div style={{ padding: '0.75rem', background: '#0d0d0d', border: '1px solid #333', borderRadius: '6px' }}>
                                                            <div style={{ color: '#ddd', fontSize: '0.85rem', marginBottom: '0.5rem' }}>Close-Game Record</div>
                                                            <div style={{ height: 140 }}>
                                                                <canvas id={`v4-editor-chart-pressure-${idSuffix}`} style={{ width: '100%', height: '100%' }} />
                                                            </div>
                                                        </div>
                                                        <div style={{ padding: '0.75rem', background: '#0d0d0d', border: '1px solid #333', borderRadius: '6px' }}>
                                                            <div style={{ color: '#ddd', fontSize: '0.85rem', marginBottom: '0.5rem' }}>Role Volatility (ΔUSG3 vs Season)</div>
                                                            <div style={{ height: 220 }}>
                                                                <canvas id={`v4-editor-chart-volatility-${idSuffix}`} style={{ width: '100%', height: '100%' }} />
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                            );
                                        })()}

                                        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
                                            <button
                                                onClick={handleApplyV4NarrativeToArticle}
                                                style={{ padding: '0.5rem 0.75rem', background: '#ff6b35', color: '#000', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
                                            >
                                                Apply V4 Narrative JSON → Article
                                            </button>
                                        </div>
                                    </div>

                                    {showV4Advanced && (
                                        <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid #333' }}>
                                            <div style={{ fontWeight: 'bold', marginBottom: '0.5rem' }}>Advanced (Raw JSON)</div>
                                            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '0.75rem' }}>
                                                <div style={{ padding: '0.75rem', background: '#151515', border: '1px solid #333', borderRadius: '4px' }}>
                                                    <div style={{ fontWeight: 'bold', marginBottom: '0.5rem' }}>Temperature Check (Auto-build settings)</div>
                                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                                                        <div>
                                                            <label style={{ display: 'block', fontSize: '0.85rem', color: '#bbb', marginBottom: '0.25rem' }}>Highlight comparison key</label>
                                                            <input
                                                                type="text"
                                                                value={((editedPost as any).heatCheckData?.temperatureCheck?.summary?.highlightComparisonKey) || ''}
                                                                onChange={(e) => handleFieldChange('heatCheckData.temperatureCheck.summary.highlightComparisonKey', e.target.value)}
                                                                placeholder="e.g., margin10"
                                                                style={{ width: '100%', padding: '0.5rem', background: '#111', border: '1px solid #444', color: '#fff', borderRadius: '4px' }}
                                                            />
                                                        </div>
                                                        <div>
                                                            <label style={{ display: 'block', fontSize: '0.85rem', color: '#bbb', marginBottom: '0.25rem' }}>Availability display override</label>
                                                            <input
                                                                type="text"
                                                                value={((editedPost as any).heatCheckData?.temperatureCheck?.summary?.availabilityDisplayOverride) || ''}
                                                                onChange={(e) => handleFieldChange('heatCheckData.temperatureCheck.summary.availabilityDisplayOverride', e.target.value)}
                                                                placeholder="Optional: custom text to display"
                                                                style={{ width: '100%', padding: '0.5rem', background: '#111', border: '1px solid #444', color: '#fff', borderRadius: '4px' }}
                                                            />
                                                        </div>
                                                        <div style={{ gridColumn: '1 / -1' }}>
                                                            <label style={{ display: 'block', fontSize: '0.85rem', color: '#bbb', marginBottom: '0.25rem' }}>Visible bullet keys (one per line)</label>
                                                            <textarea
                                                                value={Array.isArray((editedPost as any).heatCheckData?.temperatureCheck?.summary?.visibleBulletKeys) ? (editedPost as any).heatCheckData.temperatureCheck.summary.visibleBulletKeys.join('\\n') : ''}
                                                                onChange={(e) => handleFieldChange('heatCheckData.temperatureCheck.summary.visibleBulletKeys', e.target.value.split('\\n').map(s => s.trim()).filter(Boolean))}
                                                                style={{ width: '100%', minHeight: '80px', padding: '0.5rem', background: '#111', border: '1px solid #444', color: '#fff', borderRadius: '4px', fontFamily: 'monospace' }}
                                                            />
                                                        </div>
                                                        <div style={{ gridColumn: '1 / -1' }}>
                                                            <label style={{ display: 'block', fontSize: '0.85rem', color: '#bbb', marginBottom: '0.25rem' }}>Priority players override (displayText, one per line)</label>
                                                            <textarea
                                                                value={Array.isArray((editedPost as any).heatCheckData?.temperatureCheck?.summary?.priorityPlayersOverride) ? (editedPost as any).heatCheckData.temperatureCheck.summary.priorityPlayersOverride.join('\\n') : ''}
                                                                onChange={(e) => handleFieldChange('heatCheckData.temperatureCheck.summary.priorityPlayersOverride', e.target.value.split('\\n').map(s => s.trim()).filter(Boolean))}
                                                                style={{ width: '100%', minHeight: '80px', padding: '0.5rem', background: '#111', border: '1px solid #444', color: '#fff', borderRadius: '4px', fontFamily: 'monospace' }}
                                                            />
                                                        </div>
                                                    </div>
                                                </div>
                                                <div>
                                                    <label style={{ display: 'block', fontSize: '0.85rem', color: '#bbb', marginBottom: '0.25rem' }}>V4 Narrative JSON (editable)</label>
                                                    <textarea
                                                        value={v4NarrativeJson}
                                                        onChange={(e) => setV4NarrativeJson(e.target.value)}
                                                        style={{ width: '100%', minHeight: '180px', padding: '0.5rem', background: '#111', border: '1px solid #444', color: '#fff', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.85rem' }}
                                                    />
                                                </div>
                                                <div>
                                                    <label style={{ display: 'block', fontSize: '0.85rem', color: '#bbb', marginBottom: '0.25rem' }}>Temperature Check AI JSON (editable)</label>
                                                    <textarea
                                                        value={v4TempAiJson}
                                                        onChange={(e) => setV4TempAiJson(e.target.value)}
                                                        style={{ width: '100%', minHeight: '140px', padding: '0.5rem', background: '#111', border: '1px solid #444', color: '#fff', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.85rem' }}
                                                    />
                                                </div>
                                                <div>
                                                    <label style={{ display: 'block', fontSize: '0.85rem', color: '#bbb', marginBottom: '0.25rem' }}>Evidence Bundle JSON (editable)</label>
                                                    <textarea
                                                        value={v4EvidenceJson}
                                                        onChange={(e) => setV4EvidenceJson(e.target.value)}
                                                        style={{ width: '100%', minHeight: '140px', padding: '0.5rem', background: '#111', border: '1px solid #444', color: '#fff', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.85rem' }}
                                                    />
                                                </div>
                                                <div>
                                                    <label style={{ display: 'block', fontSize: '0.85rem', color: '#bbb', marginBottom: '0.25rem' }}>Advanced Heat Stats JSON (editable)</label>
                                                    <textarea
                                                        value={v4AdvancedHeatStatsJson}
                                                        onChange={(e) => setV4AdvancedHeatStatsJson(e.target.value)}
                                                        style={{ width: '100%', minHeight: '140px', padding: '0.5rem', background: '#111', border: '1px solid #444', color: '#fff', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.85rem' }}
                                                    />
                                                </div>
                                            </div>
                                            <div style={{ color: '#999', fontSize: '0.8rem', marginTop: '0.5rem' }}>
                                                Tip: After editing V4 Narrative JSON, click <span style={{ color: '#ff6b35', fontWeight: 'bold' }}>Apply V4 Narrative JSON → Article</span> to sync markdown + Narrative.log.
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                            
                            {/* Article Image */}
                            <div style={{ marginBottom: '1.5rem' }}>
                                <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>
                                    <span style={{ color: '#4caf50' }}>🖼️</span> Article Image
                                </label>
                                <div style={{ display: 'flex', gap: '0.5rem' }}>
                                    <input
                                        type="text"
                                        value={articleImage}
                                        onChange={(e) => {
                                            const value = e.target.value;
                                            setArticleImage(value);
                                            handleFieldChange('websiteStory.image', value); // Sync with editedPost
                                        }}
                                        placeholder="Enter image URL (https://example.com/image.jpg or /assets/images/filename.png)"
                                        style={{ flex: 1, padding: '0.5rem', background: '#2a2a2a', border: '1px solid #444', color: '#fff', borderRadius: '4px' }}
                                    />
                                    <button
                                        onClick={() => setShowImageSelector(!showImageSelector)}
                                        style={{ padding: '0.5rem 1rem', background: '#444', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
                                    >
                                        Browse
                                    </button>
                                </div>
                                {showImageSelector && (
                                    <div style={{ marginTop: '0.5rem', padding: '1rem', background: '#2a2a2a', borderRadius: '4px', maxHeight: '200px', overflowY: 'auto' }}>
                                        <div style={{ marginBottom: '0.75rem' }}>
                                            <input
                                                type="text"
                                                value={imageDateFilter}
                                                onChange={(e) => setImageDateFilter(e.target.value)}
                                                placeholder="Filter by date (YYYY-MM-DD)"
                                                style={{ 
                                                    width: '100%', 
                                                    padding: '0.5rem', 
                                                    background: '#1a1a1a', 
                                                    border: '1px solid #444', 
                                                    color: '#fff', 
                                                    borderRadius: '4px',
                                                    fontFamily: 'monospace',
                                                    fontSize: '0.85rem'
                                                }}
                                            />
                                        </div>
                                        {(() => {
                                            // Filter images by date if filter is provided
                                            const filteredImages = imageDateFilter.trim() 
                                                ? availableImages.filter(img => {
                                                    // Extract date from filename (YYYY-MM-DD pattern at the end)
                                                    const dateMatch = img.match(/(\d{4}-\d{2}-\d{2})/);
                                                    if (!dateMatch) return false;
                                                    const imageDate = dateMatch[1];
                                                    // Support partial matches (e.g., "2026-01" matches "2026-01-20")
                                                    return imageDate.includes(imageDateFilter.trim());
                                                })
                                                : availableImages;
                                            
                                            if (filteredImages.length === 0) {
                                                return (
                                                    <div style={{ padding: '0.5rem', color: '#888', fontStyle: 'italic', textAlign: 'center' }}>
                                                        No images found for date: {imageDateFilter}
                                                    </div>
                                                );
                                            }
                                            
                                            return filteredImages.map(img => {
                                                // Extract date from filename for display
                                                const dateMatch = img.match(/(\d{4}-\d{2}-\d{2})/);
                                                const imageDate = dateMatch ? dateMatch[1] : '';
                                                
                                                return (
                                            <div
                                                key={img}
                                                onClick={() => handleSelectImage(img)}
                                                style={{ padding: '0.5rem', cursor: 'pointer', borderRadius: '4px', marginBottom: '0.25rem', background: articleImage.includes(img) ? '#4caf50' : 'transparent' }}
                                                onMouseEnter={(e) => e.currentTarget.style.background = '#333'}
                                                onMouseLeave={(e) => e.currentTarget.style.background = articleImage.includes(img) ? '#4caf50' : 'transparent'}
                                            >
                                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                            <span>{img}</span>
                                                            {imageDate && (
                                                                <span style={{ color: '#888', fontSize: '0.75rem', marginLeft: '0.5rem', fontFamily: 'monospace' }}>
                                                                    {imageDate}
                                                                </span>
                                                            )}
                                            </div>
                                                    </div>
                                                );
                                            });
                                        })()}
                                    </div>
                                )}
                            </div>

                            {/* Markdown Editor */}
                            <textarea
                                name="websiteStory.theBackstory"
                                value={editedPost.websiteStory.theBackstory}
                                onChange={handleChange}
                                style={{ 
                                    width: '100%', 
                                    minHeight: '400px', 
                                    padding: '1rem', 
                                    background: '#1a1a1a', 
                                    border: '1px solid #444', 
                                    color: '#fff', 
                                    borderRadius: '4px',
                                    fontFamily: 'monospace',
                                    fontSize: '0.9rem',
                                    lineHeight: '1.6'
                                }}
                                placeholder="Write your article in Markdown..."
                            />

                            {/* DFS AI Assistant - Player Replacement */}
                            {isDFSArticle && dfsPlayers.length > 0 && (
                                <div style={{ marginTop: '2rem', padding: '1.5rem', background: '#2a2a2a', borderRadius: '4px', border: '2px solid #00ff41' }}>
                                    <label style={{ display: 'block', marginBottom: '1rem', fontWeight: 'bold', fontSize: '1.1rem', color: '#00ff41' }}>
                                        🤖 DFS AI Assistant - Replace Player
                                    </label>
                                    
                                    {/* Player Selector */}
                                    <div style={{ marginBottom: '1rem' }}>
                                        <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold', fontSize: '0.9rem' }}>
                                            Select Player to Replace:
                                        </label>
                                        <select
                                            value={selectedPlayerToReplace ?? ''}
                                            onChange={(e) => setSelectedPlayerToReplace(e.target.value ? parseInt(e.target.value) : null)}
                                            style={{
                                                width: '100%',
                                                padding: '0.75rem',
                                                background: '#1a1a1a',
                                                border: '1px solid #00ff41',
                                                color: '#fff',
                                                borderRadius: '4px',
                                                fontSize: '0.9rem',
                                                cursor: 'pointer'
                                            }}
                                        >
                                            <option value="">-- Select a player --</option>
                                            {dfsPlayers.map((player: any, index: number) => (
                                                <option key={index} value={index}>
                                                    #{player.rank} - {player.playerName} ({player.position}) - {player.team} vs {player.opponent} - ${player.salary}
                                                </option>
                                            ))}
                                        </select>
                                    </div>

                                    {/* Replacement Instructions */}
                                    {selectedPlayerToReplace !== null && (
                                        <>
                                            <div style={{ marginBottom: '1rem' }}>
                                                <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold', fontSize: '0.9rem' }}>
                                                    Replacement Instructions:
                                                </label>
                                                <textarea
                                                    value={dfsReplacementInstructions}
                                                    onChange={(e) => setDfsReplacementInstructions(e.target.value)}
                                                    placeholder="E.g., 'Replace with a value play under $6000 with a revenge narrative' or 'Find a player from the same team with better matchup'..."
                                                    style={{ 
                                                        width: '100%', 
                                                        minHeight: '100px', 
                                                        padding: '0.75rem', 
                                                        background: '#1a1a1a', 
                                                        border: '1px solid #00ff41', 
                                                        color: '#fff', 
                                                        borderRadius: '4px',
                                                        fontSize: '0.9rem',
                                                        fontFamily: 'monospace'
                                                    }}
                                                />
                                            </div>
                                            
                                            <button
                                                onClick={handleReplaceDFSPlayer}
                                                disabled={isReplacingPlayer || !dfsReplacementInstructions.trim()}
                                                style={{ 
                                                    width: '100%',
                                                    padding: '0.75rem 1rem', 
                                                    background: isReplacingPlayer ? '#666' : '#00ff41', 
                                                    color: isReplacingPlayer ? '#999' : '#000', 
                                                    border: 'none', 
                                                    borderRadius: '4px', 
                                                    cursor: isReplacingPlayer ? 'not-allowed' : 'pointer',
                                                    fontWeight: 'bold',
                                                    fontSize: '0.9rem',
                                                    textTransform: 'uppercase',
                                                    letterSpacing: '0.1em'
                                                }}
                                            >
                                                {isReplacingPlayer ? 'Replacing Player...' : 'Replace Player with AI'}
                                            </button>
                                        </>
                                    )}
                                </div>
                            )}

                            {/* AI Feedback Agent (for non-DFS articles) */}
                            {!isDFSArticle && (
                            <div style={{ marginTop: '2rem', padding: '1rem', background: '#2a2a2a', borderRadius: '4px' }}>
                                <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>
                                    AI Feedback Agent
                                </label>
                                <textarea
                                    value={aiFeedback}
                                    onChange={(e) => setAiFeedback(e.target.value)}
                                    placeholder="Enter your feedback or instructions for improving the article..."
                                    style={{ 
                                        width: '100%', 
                                        minHeight: '80px', 
                                        padding: '0.5rem', 
                                        background: '#1a1a1a', 
                                        border: '1px solid #444', 
                                        color: '#fff', 
                                        borderRadius: '4px',
                                        marginBottom: '0.5rem'
                                    }}
                                />
                                <button
                                    onClick={handleApplyFeedback}
                                    disabled={isApplyingFeedback || !aiFeedback.trim()}
                                    style={{ 
                                        padding: '0.5rem 1rem', 
                                        background: isApplyingFeedback ? '#666' : '#4caf50', 
                                        color: '#fff', 
                                        border: 'none', 
                                        borderRadius: '4px', 
                                        cursor: isApplyingFeedback ? 'not-allowed' : 'pointer'
                                    }}
                                >
                                    {isApplyingFeedback ? 'Applying...' : 'Apply Feedback'}
                                </button>
                            </div>
                            )}
                        </div>
                    </div>

                    {/* Right Column - Narrative Cards & Evidence Board */}
                    <div style={{ flex: '1 1 40%', padding: '2rem', overflowY: 'auto', background: '#1a1a1a' }}>
                        {/* Narrative Cards */}
                        {narrativeCards.length > 0 && (
                            <div style={{ marginBottom: '2rem' }}>
                                <h3 style={{ marginBottom: '1rem', fontSize: '1.2rem' }}>Narrative Cards</h3>
                                {narrativeCards.map((card: any) => {
                                    const isPrimary = card.narrative_id === primaryNarrativeId;
                                    return (
                                        <div
                                            key={card.narrative_id}
                                            style={{
                                                padding: '1rem',
                                                marginBottom: '1rem',
                                                background: isPrimary ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.3)',
                                                border: `1px solid ${isPrimary ? 'rgba(255, 255, 255, 0.3)' : 'rgba(255, 255, 255, 0.1)'}`,
                                                borderLeft: `3px solid ${isPrimary ? 'rgba(248, 66, 66, 0.6)' : 'rgba(255, 255, 255, 0.15)'}`,
                                                borderRadius: '4px'
                                            }}
                                        >
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                                                {isPrimary && <span style={{ color: '#4caf50' }}>✓</span>}
                                                <strong style={{ fontSize: '0.95rem' }}>{card.title}</strong>
                                            </div>
                                            <p style={{ fontSize: '0.85rem', color: '#ccc', marginBottom: '0.5rem', lineHeight: '1.5' }}>
                                                {card.claim}
                                            </p>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.5rem' }}>
                                                <div style={{ fontSize: '0.75rem', color: '#999' }}>
                                                    Score: <strong style={{ color: isPrimary ? '#f84242' : '#4caf50' }}>{card.total_score}/35</strong>
                                                </div>
                                                <div style={{ fontSize: '0.75rem', color: '#999' }}>
                                                    {card.emotion_tags?.join(', ') || ''}
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}

                        {/* Evidence Board */}
                        <div>
                            <h3 style={{ marginBottom: '1rem', fontSize: '1.2rem' }}>Evidence Board</h3>
                            
                            {/* Validation Warnings */}
                            {validationWarnings.length > 0 && (
                                <div style={{ marginBottom: '1.5rem' }}>
                                    <h4 style={{ fontSize: '1rem', marginBottom: '0.75rem', color: '#ff9800' }}>Validation Warnings</h4>
                                    {validationWarnings.map((warning, idx) => {
                                        const isFixed = warning.includes('[Fixed by AI Editor]');
                                        const isCorrectionSummary = warning.startsWith('✅');
                                        const isInfo = warning.startsWith('ℹ️');
                                        
                                        // Determine styling based on warning type
                                        let bgColor = 'rgba(255, 152, 0, 0.1)';
                                        let borderColor = 'rgba(255, 152, 0, 0.6)';
                                        let textColor = '#ff9800';
                                        
                                        if (isFixed) {
                                            bgColor = 'rgba(76, 175, 80, 0.1)';
                                            borderColor = 'rgba(76, 175, 80, 0.6)';
                                            textColor = '#4caf50';
                                        } else if (isCorrectionSummary) {
                                            bgColor = 'rgba(76, 175, 80, 0.1)';
                                            borderColor = 'rgba(76, 175, 80, 0.6)';
                                            textColor = '#4caf50';
                                        } else if (isInfo) {
                                            bgColor = 'rgba(33, 150, 243, 0.1)';
                                            borderColor = 'rgba(33, 150, 243, 0.6)';
                                            textColor = '#2196f3';
                                        }
                                        
                                        return (
                                            <div
                                                key={idx}
                                                style={{
                                                    padding: '0.75rem',
                                                    marginBottom: '0.5rem',
                                                    background: bgColor,
                                                    borderLeft: `3px solid ${borderColor}`,
                                                    borderRadius: '4px'
                                                }}
                                            >
                                                <div style={{ fontSize: '0.85rem', color: textColor, lineHeight: '1.5' }}>
                                                    {warning}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                            
                            {/* Quotes */}
                            {evidenceBundle.quotes && evidenceBundle.quotes.length > 0 && (
                                <div style={{ marginBottom: '1.5rem' }}>
                                    <h4 style={{ fontSize: '1rem', marginBottom: '0.75rem', color: '#999' }}>Quotes</h4>
                                    {evidenceBundle.quotes.map((quote: any, idx: number) => (
                                        <div
                                            key={idx}
                                            style={{
                                                padding: '0.75rem',
                                                marginBottom: '0.75rem',
                                                background: 'rgba(0, 0, 0, 0.3)',
                                                borderLeft: '3px solid rgba(255, 193, 7, 0.6)',
                                                borderRadius: '4px'
                                            }}
                                        >
                                            <p style={{ fontSize: '0.85rem', fontStyle: 'italic', color: '#fff', marginBottom: '0.5rem', lineHeight: '1.5' }}>
                                                "{quote.quote}"
                                            </p>
                                            <div style={{ fontSize: '0.75rem', color: '#999' }}>
                                                — {quote.speaker} ({quote.team || ''})
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}

                            {/* Timeline */}
                            {evidenceBundle.timeline_events && evidenceBundle.timeline_events.length > 0 && (
                                <div>
                                    <h4 style={{ fontSize: '1rem', marginBottom: '0.75rem', color: '#999' }}>Timeline</h4>
                                    <div style={{ fontSize: '0.75rem', color: '#999', marginBottom: '0.5rem' }}>rivalry</div>
                                    {evidenceBundle.timeline_events.map((event: any, idx: number) => (
                                        <div
                                            key={idx}
                                            style={{
                                                padding: '0.5rem 0',
                                                borderBottom: idx < evidenceBundle.timeline_events.length - 1 ? '1px solid #333' : 'none'
                                            }}
                                        >
                                            <div style={{ fontSize: '0.85rem', color: '#fff' }}>
                                                {event.summary}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                            
                            {/* Empty State */}
                            {validationWarnings.length === 0 && (!evidenceBundle.quotes || evidenceBundle.quotes.length === 0) && (!evidenceBundle.timeline_events || evidenceBundle.timeline_events.length === 0) && (
                                <div style={{ padding: '2rem', textAlign: 'center', color: '#666' }}>
                                    <div style={{ fontSize: '0.9rem' }}>No evidence data available</div>
                                    <div style={{ fontSize: '0.75rem', marginTop: '0.5rem' }}>Evidence will appear here after generation</div>
                                </div>
                            )}
                        </div>

                        {/* HeatChecks Edge - Hidden for DFS articles */}
                        {editedPost.heatchecksEdge && editedPost.storyType !== 'dfs_article' && (
                            <div style={{ marginTop: '2rem' }}>
                                <h3 style={{ marginBottom: '1rem', fontSize: '1.2rem' }}>HeatChecks Edge</h3>
                                {(() => {
                                    const edge = editedPost.heatchecksEdge as any;
                                    const isV2 = edge && typeof edge === 'object' && 'game' in edge && 'player_props' in edge;
                                    
                                    if (isV2) {
                                        // V2 Schema Editor
                                        return (
                                            <div style={{
                                                padding: '1.5rem',
                                                background: 'rgba(255, 255, 255, 0.08)',
                                                border: '2px solid rgba(255, 255, 255, 0.3)',
                                                borderLeft: '4px solid rgba(248, 66, 66, 0.6)',
                                                borderRadius: '4px',
                                                position: 'relative'
                                            }}>
                                                {/* Decorative dots */}
                                                <div style={{ position: 'absolute', top: '0.75rem', right: '0.75rem', width: '12px', height: '12px', background: 'rgba(255, 255, 255, 0.6)', borderRadius: '50%', boxShadow: '0 0 15px rgba(255, 255, 255, 0.4), 0 0 25px rgba(255, 255, 255, 0.2)' }}></div>
                                                <div style={{ position: 'absolute', bottom: '0.75rem', right: '0.75rem', width: '12px', height: '12px', background: 'rgba(255, 255, 255, 0.6)', borderRadius: '50%', boxShadow: '0 0 15px rgba(255, 255, 255, 0.4), 0 0 25px rgba(255, 255, 255, 0.2)' }}></div>
                                                <div style={{ position: 'absolute', top: '0.75rem', left: '0.75rem', width: '12px', height: '12px', background: 'rgba(255, 255, 255, 0.6)', borderRadius: '50%', boxShadow: '0 0 15px rgba(255, 255, 255, 0.4), 0 0 25px rgba(255, 255, 255, 0.2)' }}></div>
                                                
                                                {/* Header */}
                                                <div style={{ marginBottom: '1.5rem', paddingBottom: '1rem', borderBottom: '2px solid rgba(255, 255, 255, 0.3)' }}>
                                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.75rem' }}>
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                                                            <div style={{ width: '4px', height: '30px', background: 'rgba(255, 255, 255, 0.5)', boxShadow: '0 0 10px rgba(255, 255, 255, 0.3)' }}></div>
                                                            <div style={{ color: 'rgba(255, 255, 255, 0.95)', fontSize: '0.9rem', fontFamily: "'Courier New', monospace", fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.2em', textShadow: '0 0 10px rgba(255, 255, 255, 0.3), 0 0 20px rgba(255, 255, 255, 0.1)' }}>
                                                                &gt; HEATCHECKS EDGE (V2)
                                                            </div>
                                                        </div>
                                                        <button
                                                            onClick={handleRegenerateEdge}
                                                            disabled={isRegeneratingEdge}
                                                            style={{
                                                                padding: '0.5rem 1rem',
                                                                background: isRegeneratingEdge ? 'rgba(255, 255, 255, 0.2)' : 'rgba(248, 66, 66, 0.8)',
                                                                border: '1px solid rgba(248, 66, 66, 0.6)',
                                                                borderRadius: '4px',
                                                                color: '#fff',
                                                                fontSize: '0.75rem',
                                                                fontFamily: "'Courier New', monospace",
                                                                fontWeight: 'bold',
                                                                cursor: isRegeneratingEdge ? 'not-allowed' : 'pointer',
                                                                opacity: isRegeneratingEdge ? 0.6 : 1,
                                                                transition: 'all 0.2s',
                                                                textTransform: 'uppercase',
                                                                letterSpacing: '0.1em'
                                                            }}
                                                            onMouseEnter={(e) => {
                                                                if (!isRegeneratingEdge) {
                                                                    e.currentTarget.style.background = 'rgba(248, 66, 66, 1)';
                                                                    e.currentTarget.style.boxShadow = '0 0 10px rgba(248, 66, 66, 0.5)';
                                                                }
                                                            }}
                                                            onMouseLeave={(e) => {
                                                                if (!isRegeneratingEdge) {
                                                                    e.currentTarget.style.background = 'rgba(248, 66, 66, 0.8)';
                                                                    e.currentTarget.style.boxShadow = 'none';
                                                                }
                                                            }}
                                                        >
                                                            {isRegeneratingEdge ? 'Regenerating...' : 'Regenerate Edge'}
                                                        </button>
                                                    </div>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', fontSize: '0.8rem', color: 'rgba(255, 255, 255, 0.7)' }}>
                                                        <label style={{ fontFamily: "'Courier New', monospace", fontWeight: 'bold' }}>Odds Source:</label>
                                                        <select
                                                            value={edgeApiSource}
                                                            onChange={(e) => setEdgeApiSource(e.target.value as 'theoddsapi' | 'gemini')}
                                                            disabled={isRegeneratingEdge}
                                                            style={{
                                                                padding: '0.35rem 0.75rem',
                                                                background: 'rgba(0, 0, 0, 0.3)',
                                                                border: '1px solid rgba(255, 255, 255, 0.3)',
                                                                borderRadius: '4px',
                                                                color: '#fff',
                                                                fontSize: '0.8rem',
                                                                fontFamily: "'Courier New', monospace",
                                                                cursor: isRegeneratingEdge ? 'not-allowed' : 'pointer',
                                                                opacity: isRegeneratingEdge ? 0.5 : 1
                                                            }}
                                                        >
                                                            <option value="theoddsapi">TheOddsAPI</option>
                                                            <option value="gemini">Gemini (AI Search)</option>
                                                        </select>
                                                        <span style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.5)', fontStyle: 'italic' }}>
                                                            {edgeApiSource === 'gemini' ? 'Searches for odds using AI' : 'Uses TheOddsAPI service'}
                                                        </span>
                                                    </div>
                                                </div>
                                                
                                                {/* Game Edge Section */}
                                                <div style={{ marginBottom: '1.5rem', paddingBottom: '1.5rem', borderBottom: '1px solid rgba(255, 255, 255, 0.2)' }}>
                                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                                                        <label style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.7)', fontFamily: "'Courier New', monospace", fontWeight: 'bold' }}>GAME EDGE:</label>
                                                        {edge.game?.market && edge.game.market !== 'none' && (
                                                            <button
                                                                onClick={() => {
                                                                    const newEdge = { ...edge };
                                                                    newEdge.game = { ...(newEdge.game || {}), market: 'none', selection: 'none' };
                                                                    handleFieldChange('heatchecksEdge', newEdge);
                                                                }}
                                                                style={{
                                                                    padding: '0.35rem 0.75rem',
                                                                    background: 'rgba(255, 0, 0, 0.3)',
                                                                    border: '1px solid rgba(255, 0, 0, 0.5)',
                                                                    borderRadius: '4px',
                                                                    color: '#ff6b6b',
                                                                    fontSize: '0.7rem',
                                                                    fontFamily: "'Courier New', monospace",
                                                                    fontWeight: 'bold',
                                                                    cursor: 'pointer',
                                                                    transition: 'all 0.2s',
                                                                    textTransform: 'uppercase'
                                                                }}
                                                                onMouseEnter={(e) => {
                                                                    e.currentTarget.style.background = 'rgba(255, 0, 0, 0.5)';
                                                                    e.currentTarget.style.borderColor = 'rgba(255, 0, 0, 0.7)';
                                                                }}
                                                                onMouseLeave={(e) => {
                                                                    e.currentTarget.style.background = 'rgba(255, 0, 0, 0.3)';
                                                                    e.currentTarget.style.borderColor = 'rgba(255, 0, 0, 0.5)';
                                                                }}
                                                            >
                                                                Delete Game Edge
                                                            </button>
                                                        )}
                                                    </div>
                                                    <div style={{ padding: '1rem', background: 'rgba(0, 0, 0, 0.3)', borderRadius: '4px' }}>
                                                        <div style={{ marginBottom: '0.75rem', display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                                                            <label style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.7)' }}>Market:</label>
                                                            <select
                                                                value={edge.game?.market || 'none'}
                                                                onChange={(e) => {
                                                                    const newEdge = { ...edge };
                                                                    newEdge.game = { ...(newEdge.game || {}), market: e.target.value };
                                                                    if (e.target.value === 'none') {
                                                                        newEdge.game.selection = 'none';
                                                                    }
                                                                    handleFieldChange('heatchecksEdge', newEdge);
                                                                }}
                                                                style={{ padding: '0.25rem 0.5rem', background: '#2a2a2a', border: '1px solid #444', color: '#fff', borderRadius: '4px', fontSize: '0.75rem' }}
                                                            >
                                                                <option value="none">None</option>
                                                                <option value="moneyline">Moneyline</option>
                                                                <option value="spread">Spread</option>
                                                                <option value="total">Total</option>
                                                            </select>
                                                            
                                                            {edge.game?.market !== 'none' && (
                                                                <>
                                                                    <label style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.7)', marginLeft: '0.5rem' }}>Selection:</label>
                                                                    <select
                                                                        value={edge.game?.selection || 'none'}
                                                                        onChange={(e) => {
                                                                            const newEdge = { ...edge };
                                                                            newEdge.game = { ...newEdge.game, selection: e.target.value };
                                                                            handleFieldChange('heatchecksEdge', newEdge);
                                                                        }}
                                                                        style={{ padding: '0.25rem 0.5rem', background: '#2a2a2a', border: '1px solid #444', color: '#fff', borderRadius: '4px', fontSize: '0.75rem' }}
                                                                    >
                                                                        <option value="none">None</option>
                                                                        {edge.game?.market === 'moneyline' || edge.game?.market === 'spread' ? (
                                                                            <>
                                                                                <option value="TEAM_A">Team A</option>
                                                                                <option value="TEAM_B">Team B</option>
                                                                            </>
                                                                        ) : (
                                                                            <>
                                                                                <option value="OVER">Over</option>
                                                                                <option value="UNDER">Under</option>
                                                                            </>
                                                                        )}
                                                                    </select>
                                                                    
                                                                    <label style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.7)', marginLeft: '0.5rem' }}>Confidence:</label>
                                                                    <select
                                                                        value={edge.game?.confidence || 'low'}
                                                                        onChange={(e) => {
                                                                            const newEdge = { ...edge };
                                                                            newEdge.game = { ...newEdge.game, confidence: e.target.value };
                                                                            handleFieldChange('heatchecksEdge', newEdge);
                                                                        }}
                                                                        style={{ padding: '0.25rem 0.5rem', background: '#2a2a2a', border: '1px solid #444', color: '#fff', borderRadius: '4px', fontSize: '0.75rem' }}
                                                                    >
                                                                        <option value="low">Low</option>
                                                                        <option value="medium">Medium</option>
                                                                        <option value="high">High</option>
                                                                    </select>
                                                                </>
                                                            )}
                                                        </div>
                                                        
                                                        {edge.game?.market !== 'none' && (
                                                            <>
                                                                <div style={{ marginBottom: '0.75rem' }}>
                                                                    <label style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.7)', marginBottom: '0.25rem', display: 'block' }}>One Sentence Call:</label>
                                                                    <textarea
                                                                        value={edge.game?.one_sentence_call || ''}
                                                                        onChange={(e) => {
                                                                            const newEdge = { ...edge };
                                                                            newEdge.game = { ...newEdge.game, one_sentence_call: e.target.value };
                                                                            handleFieldChange('heatchecksEdge', newEdge);
                                                                        }}
                                                                        style={{ width: '100%', padding: '0.5rem', background: 'rgba(0, 0, 0, 0.3)', border: '1px solid rgba(255, 255, 255, 0.2)', color: '#fff', borderRadius: '4px', minHeight: '60px', fontSize: '0.85rem', fontFamily: "'Courier New', monospace" }}
                                                                    />
                                                                </div>
                                                                
                                                                <div style={{ marginBottom: '0.75rem' }}>
                                                                    <label style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.7)', marginBottom: '0.25rem', display: 'block' }}>Receipts:</label>
                                                                    {(edge.game?.receipts || ['', '', '']).map((receipt: string, idx: number) => (
                                                                        <textarea
                                                                            key={idx}
                                                                            value={receipt}
                                                                            onChange={(e) => {
                                                                                const newEdge = { ...edge };
                                                                                const newReceipts = [...(newEdge.game.receipts || ['', '', ''])];
                                                                                newReceipts[idx] = e.target.value;
                                                                                newEdge.game.receipts = newReceipts as [string, string, string];
                                                                                handleFieldChange('heatchecksEdge', newEdge);
                                                                            }}
                                                                            style={{ width: '100%', marginBottom: '0.25rem', padding: '0.5rem', background: 'rgba(0, 0, 0, 0.3)', border: '1px solid rgba(255, 255, 255, 0.2)', color: '#fff', borderRadius: '4px', minHeight: '40px', fontSize: '0.85rem', fontFamily: "'Courier New', monospace" }}
                                                                        />
                                                                    ))}
                                                                </div>
                                                                
                                                                <div>
                                                                    <label style={{ fontSize: '0.75rem', color: 'rgba(255, 152, 0, 0.9)', marginBottom: '0.25rem', display: 'block' }}>Risks:</label>
                                                                    {(edge.game?.risks || ['', '']).map((risk: string, idx: number) => (
                                                                        <textarea
                                                                            key={idx}
                                                                            value={risk}
                                                                            onChange={(e) => {
                                                                                const newEdge = { ...edge };
                                                                                const newRisks = [...(newEdge.game.risks || ['', ''])];
                                                                                newRisks[idx] = e.target.value;
                                                                                newEdge.game.risks = newRisks as [string, string];
                                                                                handleFieldChange('heatchecksEdge', newEdge);
                                                                            }}
                                                                            style={{ width: '100%', marginBottom: '0.25rem', padding: '0.5rem', background: 'rgba(0, 0, 0, 0.3)', border: '1px solid rgba(255, 152, 0, 0.3)', color: 'rgba(255, 152, 0, 0.9)', borderRadius: '4px', minHeight: '40px', fontSize: '0.85rem', fontFamily: "'Courier New', monospace" }}
                                                                        />
                                                                    ))}
                                                                </div>
                                                            </>
                                                        )}
                                                    </div>
                                                </div>
                                                
                                                {/* Player Props Section */}
                                                <div style={{ marginBottom: '1.5rem', paddingBottom: '1.5rem', borderBottom: '1px solid rgba(255, 255, 255, 0.2)' }}>
                                                    <label style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.7)', marginBottom: '0.5rem', fontFamily: "'Courier New', monospace", display: 'block', fontWeight: 'bold' }}>PLAYER PROPS:</label>
                                                    {(edge.player_props || []).map((prop: any, idx: number) => (
                                                        <div key={idx} style={{ marginBottom: '1rem', padding: '1rem', background: 'rgba(0, 0, 0, 0.3)', borderRadius: '4px', border: '1px solid rgba(0, 255, 65, 0.3)', position: 'relative' }}>
                                                            <div style={{ position: 'absolute', top: '0.75rem', right: '0.75rem' }}>
                                                                <button
                                                                    onClick={() => {
                                                                        const newEdge = { ...edge };
                                                                        const newProps = [...(newEdge.player_props || [])];
                                                                        newProps.splice(idx, 1);
                                                                        newEdge.player_props = newProps;
                                                                        handleFieldChange('heatchecksEdge', newEdge);
                                                                    }}
                                                                    style={{
                                                                        padding: '0.35rem 0.75rem',
                                                                        background: 'rgba(255, 0, 0, 0.3)',
                                                                        border: '1px solid rgba(255, 0, 0, 0.5)',
                                                                        borderRadius: '4px',
                                                                        color: '#ff6b6b',
                                                                        fontSize: '0.7rem',
                                                                        fontFamily: "'Courier New', monospace",
                                                                        fontWeight: 'bold',
                                                                        cursor: 'pointer',
                                                                        transition: 'all 0.2s',
                                                                        textTransform: 'uppercase'
                                                                    }}
                                                                    onMouseEnter={(e) => {
                                                                        e.currentTarget.style.background = 'rgba(255, 0, 0, 0.5)';
                                                                        e.currentTarget.style.borderColor = 'rgba(255, 0, 0, 0.7)';
                                                                    }}
                                                                    onMouseLeave={(e) => {
                                                                        e.currentTarget.style.background = 'rgba(255, 0, 0, 0.3)';
                                                                        e.currentTarget.style.borderColor = 'rgba(255, 0, 0, 0.5)';
                                                                    }}
                                                                >
                                                                    Delete
                                                                </button>
                                                            </div>
                                                            <div style={{ marginBottom: '0.75rem', display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', paddingRight: '100px' }}>
                                                                <span style={{ fontSize: '0.85rem', color: '#00ff41', fontWeight: 'bold' }}>{prop.player_name}</span>
                                                                <span style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.7)' }}>{prop.market}</span>
                                                                <span style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.7)' }}>{prop.selection} {prop.line}</span>
                                                                <span style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.5)' }}>({prop.price_american > 0 ? '+' : ''}{prop.price_american})</span>
                                                                <span style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.5)' }}>@{prop.book}</span>
                                                                
                                                                <label style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.7)', marginLeft: '0.5rem' }}>Confidence:</label>
                                                                <select
                                                                    value={prop.confidence || 'low'}
                                                                    onChange={(e) => {
                                                                        const newEdge = { ...edge };
                                                                        const newProps = [...(newEdge.player_props || [])];
                                                                        newProps[idx] = { ...newProps[idx], confidence: e.target.value };
                                                                        newEdge.player_props = newProps;
                                                                        handleFieldChange('heatchecksEdge', newEdge);
                                                                    }}
                                                                    style={{ padding: '0.25rem 0.5rem', background: '#2a2a2a', border: '1px solid #444', color: '#fff', borderRadius: '4px', fontSize: '0.75rem' }}
                                                                >
                                                                    <option value="low">Low</option>
                                                                    <option value="medium">Medium</option>
                                                                    <option value="high">High</option>
                                                                </select>
                                                            </div>
                                                            
                                                            <div style={{ marginBottom: '0.75rem' }}>
                                                                <label style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.7)', marginBottom: '0.25rem', display: 'block' }}>One Sentence Call:</label>
                                                                <textarea
                                                                    value={prop.one_sentence_call || ''}
                                                                    onChange={(e) => {
                                                                        const newEdge = { ...edge };
                                                                        const newProps = [...(newEdge.player_props || [])];
                                                                        newProps[idx] = { ...newProps[idx], one_sentence_call: e.target.value };
                                                                        newEdge.player_props = newProps;
                                                                        handleFieldChange('heatchecksEdge', newEdge);
                                                                    }}
                                                                    style={{ width: '100%', padding: '0.5rem', background: 'rgba(0, 0, 0, 0.3)', border: '1px solid rgba(255, 255, 255, 0.2)', color: '#fff', borderRadius: '4px', minHeight: '60px', fontSize: '0.85rem', fontFamily: "'Courier New', monospace" }}
                                                                />
                                                            </div>
                                                            
                                                            <div style={{ marginBottom: '0.75rem' }}>
                                                                <label style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.7)', marginBottom: '0.25rem', display: 'block' }}>Receipts:</label>
                                                                {(prop.receipts || ['', '', '']).map((receipt: string, rIdx: number) => (
                                                                    <textarea
                                                                        key={rIdx}
                                                                        value={receipt}
                                                                        onChange={(e) => {
                                                                            const newEdge = { ...edge };
                                                                            const newProps = [...(newEdge.player_props || [])];
                                                                            const newReceipts = [...(newProps[idx].receipts || ['', '', ''])];
                                                                            newReceipts[rIdx] = e.target.value;
                                                                            newProps[idx] = { ...newProps[idx], receipts: newReceipts as [string, string, string] };
                                                                            newEdge.player_props = newProps;
                                                                            handleFieldChange('heatchecksEdge', newEdge);
                                                                        }}
                                                                        style={{ width: '100%', marginBottom: '0.25rem', padding: '0.5rem', background: 'rgba(0, 0, 0, 0.3)', border: '1px solid rgba(255, 255, 255, 0.2)', color: '#fff', borderRadius: '4px', minHeight: '40px', fontSize: '0.85rem', fontFamily: "'Courier New', monospace" }}
                                                                    />
                                                                ))}
                                                            </div>
                                                            
                                                            <div>
                                                                <label style={{ fontSize: '0.75rem', color: 'rgba(255, 152, 0, 0.9)', marginBottom: '0.25rem', display: 'block' }}>Risks:</label>
                                                                {(prop.risks || ['', '']).map((risk: string, rIdx: number) => (
                                                                    <textarea
                                                                        key={rIdx}
                                                                        value={risk}
                                                                        onChange={(e) => {
                                                                            const newEdge = { ...edge };
                                                                            const newProps = [...(newEdge.player_props || [])];
                                                                            const newRisks = [...(newProps[idx].risks || ['', ''])];
                                                                            newRisks[rIdx] = e.target.value;
                                                                            newProps[idx] = { ...newProps[idx], risks: newRisks as [string, string] };
                                                                            newEdge.player_props = newProps;
                                                                            handleFieldChange('heatchecksEdge', newEdge);
                                                                        }}
                                                                        style={{ width: '100%', marginBottom: '0.25rem', padding: '0.5rem', background: 'rgba(0, 0, 0, 0.3)', border: '1px solid rgba(255, 152, 0, 0.3)', color: 'rgba(255, 152, 0, 0.9)', borderRadius: '4px', minHeight: '40px', fontSize: '0.85rem', fontFamily: "'Courier New', monospace" }}
                                                                    />
                                                                ))}
                                                            </div>
                                                        </div>
                                                    ))}
                                                    
                                                    {(!edge.player_props || edge.player_props.length === 0) && (
                                                        <div style={{ padding: '1rem', background: 'rgba(255, 255, 255, 0.05)', borderRadius: '4px', color: 'rgba(255, 255, 255, 0.5)', textAlign: 'center', fontStyle: 'italic', fontSize: '0.85rem' }}>
                                                            No player props selected
                                                        </div>
                                                    )}
                                                </div>
                                                
                                                {/* No Edge Reason */}
                                                {edge.no_edge_reason && (
                                                    <div style={{ padding: '1rem', background: 'rgba(255, 152, 0, 0.1)', borderRadius: '4px', border: '1px solid rgba(255, 152, 0, 0.3)' }}>
                                                        <label style={{ fontSize: '0.75rem', color: 'rgba(255, 152, 0, 0.9)', marginBottom: '0.5rem', display: 'block', fontWeight: 'bold' }}>NO EDGE REASON:</label>
                                                        <textarea
                                                            value={edge.no_edge_reason}
                                                            onChange={(e) => {
                                                                const newEdge = { ...edge };
                                                                newEdge.no_edge_reason = e.target.value;
                                                                handleFieldChange('heatchecksEdge', newEdge);
                                                            }}
                                                            style={{ width: '100%', padding: '0.5rem', background: 'rgba(0, 0, 0, 0.3)', border: '1px solid rgba(255, 152, 0, 0.3)', color: 'rgba(255, 152, 0, 0.9)', borderRadius: '4px', minHeight: '60px', fontSize: '0.85rem', fontFamily: "'Courier New', monospace" }}
                                                        />
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    } else {
                                        // Old Schema Editor
                                        return (
                                <div style={{
                                    padding: '1.5rem',
                                    background: 'rgba(255, 255, 255, 0.08)',
                                    border: '2px solid rgba(255, 255, 255, 0.3)',
                                    borderLeft: '4px solid rgba(248, 66, 66, 0.6)',
                                    borderRadius: '4px',
                                    position: 'relative'
                                }}>
                                    {/* Decorative dots */}
                                    <div style={{ position: 'absolute', top: '0.75rem', right: '0.75rem', width: '12px', height: '12px', background: 'rgba(255, 255, 255, 0.6)', borderRadius: '50%', boxShadow: '0 0 15px rgba(255, 255, 255, 0.4), 0 0 25px rgba(255, 255, 255, 0.2)' }}></div>
                                    <div style={{ position: 'absolute', bottom: '0.75rem', right: '0.75rem', width: '12px', height: '12px', background: 'rgba(255, 255, 255, 0.6)', borderRadius: '50%', boxShadow: '0 0 15px rgba(255, 255, 255, 0.4), 0 0 25px rgba(255, 255, 255, 0.2)' }}></div>
                                    <div style={{ position: 'absolute', top: '0.75rem', left: '0.75rem', width: '12px', height: '12px', background: 'rgba(255, 255, 255, 0.6)', borderRadius: '50%', boxShadow: '0 0 15px rgba(255, 255, 255, 0.4), 0 0 25px rgba(255, 255, 255, 0.2)' }}></div>
                                    
                                    {/* Header with Lean and Confidence Selectors */}
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.5rem', paddingBottom: '1rem', borderBottom: '2px solid rgba(255, 255, 255, 0.3)' }}>
                                        <div style={{ width: '4px', height: '30px', background: 'rgba(255, 255, 255, 0.5)', boxShadow: '0 0 10px rgba(255, 255, 255, 0.3)' }}></div>
                                        <div style={{ color: 'rgba(255, 255, 255, 0.95)', fontSize: '0.9rem', fontFamily: "'Courier New', monospace", fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.2em', textShadow: '0 0 10px rgba(255, 255, 255, 0.3), 0 0 20px rgba(255, 255, 255, 0.1)' }}>
                                            &gt; HEATCHECKS EDGE
                                        </div>
                                        <div style={{ flex: 1, height: '1px', background: 'linear-gradient(90deg, rgba(255, 255, 255, 0.3) 0%, transparent 100%)' }}></div>
                                                    <button
                                                        onClick={handleRegenerateEdge}
                                                        disabled={isRegeneratingEdge}
                                                        style={{
                                                            padding: '0.5rem 1rem',
                                                            background: isRegeneratingEdge ? 'rgba(255, 255, 255, 0.2)' : 'rgba(248, 66, 66, 0.8)',
                                                            border: '1px solid rgba(248, 66, 66, 0.6)',
                                                            borderRadius: '4px',
                                                            color: '#fff',
                                                            fontSize: '0.75rem',
                                                            fontFamily: "'Courier New', monospace",
                                                            fontWeight: 'bold',
                                                            cursor: isRegeneratingEdge ? 'not-allowed' : 'pointer',
                                                            opacity: isRegeneratingEdge ? 0.6 : 1,
                                                            transition: 'all 0.2s',
                                                            textTransform: 'uppercase',
                                                            letterSpacing: '0.1em'
                                                        }}
                                                        onMouseEnter={(e) => {
                                                            if (!isRegeneratingEdge) {
                                                                e.currentTarget.style.background = 'rgba(248, 66, 66, 1)';
                                                                e.currentTarget.style.boxShadow = '0 0 10px rgba(248, 66, 66, 0.5)';
                                                            }
                                                        }}
                                                        onMouseLeave={(e) => {
                                                            if (!isRegeneratingEdge) {
                                                                e.currentTarget.style.background = 'rgba(248, 66, 66, 0.8)';
                                                                e.currentTarget.style.boxShadow = 'none';
                                                            }
                                                        }}
                                                    >
                                                        {isRegeneratingEdge ? 'Regenerating...' : 'Regenerate Edge'}
                                                    </button>
                                        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                                            {/* Lean Dropdown */}
                                            <select
                                                            value={edge.lean || 'NO_EDGE'}
                                                onChange={(e) => handleFieldChange('heatchecksEdge.lean', e.target.value as "FAVOR" | "FADE" | "NO_EDGE")}
                                                style={{
                                                    padding: '0.25rem 0.75rem',
                                                                background: edge.lean === 'FAVOR' ? 'rgba(76, 175, 80, 0.2)' : edge.lean === 'FADE' ? 'rgba(248, 66, 66, 0.2)' : 'rgba(255, 255, 255, 0.1)',
                                                                border: `1px solid ${edge.lean === 'FAVOR' ? 'rgba(76, 175, 80, 0.5)' : edge.lean === 'FADE' ? 'rgba(248, 66, 66, 0.5)' : 'rgba(255, 255, 255, 0.3)'}`,
                                                    borderRadius: '4px',
                                                    fontSize: '0.75rem',
                                                    fontWeight: 'bold',
                                                                color: edge.lean === 'FAVOR' ? '#4caf50' : edge.lean === 'FADE' ? '#f84242' : 'rgba(255, 255, 255, 0.7)',
                                                    textTransform: 'uppercase',
                                                    cursor: 'pointer',
                                                    fontFamily: "'Courier New', monospace"
                                                }}
                                            >
                                                <option value="NO_EDGE">NO EDGE</option>
                                                <option value="FAVOR">FAVOR</option>
                                                <option value="FADE">FADE</option>
                                            </select>
                                            {/* Confidence Dropdown */}
                                            <select
                                                            value={edge.confidence || 'medium'}
                                                onChange={(e) => handleFieldChange('heatchecksEdge.confidence', e.target.value as "low" | "medium" | "high")}
                                                style={{
                                                    padding: '0.25rem 0.75rem',
                                                    background: 'rgba(255, 255, 255, 0.1)',
                                                    border: '1px solid rgba(255, 255, 255, 0.3)',
                                                    borderRadius: '4px',
                                                    fontSize: '0.75rem',
                                                    fontWeight: 'bold',
                                                                color: edge.confidence === 'high' ? '#4caf50' : edge.confidence === 'medium' ? '#ffc107' : '#ff9800',
                                                    textTransform: 'uppercase',
                                                    cursor: 'pointer',
                                                    fontFamily: "'Courier New', monospace"
                                                }}
                                            >
                                                <option value="low">LOW</option>
                                                <option value="medium">MEDIUM</option>
                                                <option value="high">HIGH</option>
                                            </select>
                                        </div>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', fontSize: '0.8rem', color: 'rgba(255, 255, 255, 0.7)', marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid rgba(255, 255, 255, 0.2)' }}>
                                                        <label style={{ fontFamily: "'Courier New', monospace", fontWeight: 'bold' }}>Odds Source:</label>
                                                        <select
                                                            value={edgeApiSource}
                                                            onChange={(e) => setEdgeApiSource(e.target.value as 'theoddsapi' | 'gemini')}
                                                            disabled={isRegeneratingEdge}
                                                            style={{
                                                                padding: '0.35rem 0.75rem',
                                                                background: 'rgba(0, 0, 0, 0.3)',
                                                                border: '1px solid rgba(255, 255, 255, 0.3)',
                                                                borderRadius: '4px',
                                                                color: '#fff',
                                                                fontSize: '0.8rem',
                                                                fontFamily: "'Courier New', monospace",
                                                                cursor: isRegeneratingEdge ? 'not-allowed' : 'pointer',
                                                                opacity: isRegeneratingEdge ? 0.5 : 1
                                                            }}
                                                        >
                                                            <option value="theoddsapi">TheOddsAPI</option>
                                                            <option value="gemini">Gemini (AI Search)</option>
                                                        </select>
                                                        <span style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.5)', fontStyle: 'italic' }}>
                                                            {edgeApiSource === 'gemini' ? 'Searches for odds using AI' : 'Uses TheOddsAPI service'}
                                                        </span>
                                                    </div>
                                    </div>
                                    
                                    {/* Betting Lines */}
                                                {edge.lines && edge.lines.length > 0 && (
                                        <div style={{ marginBottom: '1rem', paddingBottom: '1rem', borderBottom: '1px solid rgba(255, 255, 255, 0.2)' }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                                                <div style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.7)', fontFamily: "'Courier New', monospace" }}>BETTING LINES:</div>
                                                <button
                                                    onClick={() => {
                                                        const newEdge = { ...edge };
                                                        newEdge.lines = [];
                                                        newEdge.lean = 'NO_EDGE';
                                                        handleFieldChange('heatchecksEdge', newEdge);
                                                    }}
                                                    style={{
                                                        padding: '0.35rem 0.75rem',
                                                        background: 'rgba(255, 0, 0, 0.3)',
                                                        border: '1px solid rgba(255, 0, 0, 0.5)',
                                                        borderRadius: '4px',
                                                        color: '#ff6b6b',
                                                        fontSize: '0.7rem',
                                                        fontFamily: "'Courier New', monospace",
                                                        fontWeight: 'bold',
                                                        cursor: 'pointer',
                                                        transition: 'all 0.2s',
                                                        textTransform: 'uppercase'
                                                    }}
                                                    onMouseEnter={(e) => {
                                                        e.currentTarget.style.background = 'rgba(255, 0, 0, 0.5)';
                                                        e.currentTarget.style.borderColor = 'rgba(255, 0, 0, 0.7)';
                                                    }}
                                                    onMouseLeave={(e) => {
                                                        e.currentTarget.style.background = 'rgba(255, 0, 0, 0.3)';
                                                        e.currentTarget.style.borderColor = 'rgba(255, 0, 0, 0.5)';
                                                    }}
                                                >
                                                    Delete All Lines
                                                </button>
                                            </div>
                                                        {edge.lines.map((line: any, idx: number) => (
                                                <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem', padding: '0.5rem', background: 'rgba(0, 0, 0, 0.2)', borderRadius: '4px' }}>
                                                    <div style={{ fontSize: '0.85rem', color: 'rgba(255, 255, 255, 0.9)', fontFamily: "'Courier New', monospace" }}>
                                                        {line.marketType}: {line.label} {line.line} ({line.price}) - {line.book}
                                                    </div>
                                                    <button
                                                        onClick={() => {
                                                            const newEdge = { ...edge };
                                                            const newLines = [...(newEdge.lines || [])];
                                                            newLines.splice(idx, 1);
                                                            newEdge.lines = newLines;
                                                            if (newLines.length === 0) {
                                                                newEdge.lean = 'NO_EDGE';
                                                            }
                                                            handleFieldChange('heatchecksEdge', newEdge);
                                                        }}
                                                        style={{
                                                            padding: '0.25rem 0.5rem',
                                                            background: 'rgba(255, 0, 0, 0.3)',
                                                            border: '1px solid rgba(255, 0, 0, 0.5)',
                                                            borderRadius: '4px',
                                                            color: '#ff6b6b',
                                                            fontSize: '0.7rem',
                                                            fontFamily: "'Courier New', monospace",
                                                            fontWeight: 'bold',
                                                            cursor: 'pointer',
                                                            transition: 'all 0.2s'
                                                        }}
                                                        onMouseEnter={(e) => {
                                                            e.currentTarget.style.background = 'rgba(255, 0, 0, 0.5)';
                                                            e.currentTarget.style.borderColor = 'rgba(255, 0, 0, 0.7)';
                                                        }}
                                                        onMouseLeave={(e) => {
                                                            e.currentTarget.style.background = 'rgba(255, 0, 0, 0.3)';
                                                            e.currentTarget.style.borderColor = 'rgba(255, 0, 0, 0.5)';
                                                        }}
                                                    >
                                                        ×
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    
                                    {/* Rationale Bullets (Editable) */}
                                    <div style={{ marginBottom: '1rem', paddingBottom: '1rem', borderBottom: '1px solid rgba(255, 255, 255, 0.2)' }}>
                                        <label style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.7)', marginBottom: '0.5rem', fontFamily: "'Courier New', monospace", display: 'block' }}>RATIONALE:</label>
                                                    {(edge.rationaleBullets || []).map((bullet: string, idx: number) => (
                                            <div key={idx} style={{ marginBottom: '0.5rem', display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                                                <span style={{ color: '#f84242', fontSize: '1.2rem', lineHeight: '1.5' }}>•</span>
                                                <textarea
                                                    value={bullet}
                                                    onChange={(e) => {
                                                                    const newBullets = [...(edge.rationaleBullets || [])];
                                                        newBullets[idx] = e.target.value;
                                                        handleFieldChange('heatchecksEdge.rationaleBullets', newBullets);
                                                    }}
                                                    style={{
                                                        flex: 1,
                                                        padding: '0.5rem',
                                                        background: 'rgba(0, 0, 0, 0.3)',
                                                        border: '1px solid rgba(255, 255, 255, 0.2)',
                                                        borderRadius: '4px',
                                                        color: 'rgba(255, 255, 255, 0.9)',
                                                        fontSize: '0.85rem',
                                                        fontFamily: "'Courier New', monospace",
                                                        resize: 'vertical',
                                                        minHeight: '2rem'
                                                    }}
                                                    rows={2}
                                                />
                                                <button
                                                    onClick={() => {
                                                                    const newBullets = [...(edge.rationaleBullets || [])];
                                                        newBullets.splice(idx, 1);
                                                        handleFieldChange('heatchecksEdge.rationaleBullets', newBullets);
                                                    }}
                                                    style={{
                                                        padding: '0.25rem 0.5rem',
                                                        background: 'rgba(248, 66, 66, 0.2)',
                                                        border: '1px solid rgba(248, 66, 66, 0.5)',
                                                        borderRadius: '4px',
                                                        color: '#f84242',
                                                        cursor: 'pointer',
                                                        fontSize: '0.75rem'
                                                    }}
                                                >
                                                    ×
                                                </button>
                                            </div>
                                        ))}
                                        <button
                                            onClick={() => {
                                                            const newBullets = [...(edge.rationaleBullets || []), ''];
                                                handleFieldChange('heatchecksEdge.rationaleBullets', newBullets);
                                            }}
                                            style={{
                                                marginTop: '0.5rem',
                                                padding: '0.5rem 1rem',
                                                background: 'rgba(76, 175, 80, 0.2)',
                                                border: '1px solid rgba(76, 175, 80, 0.5)',
                                                borderRadius: '4px',
                                                color: '#4caf50',
                                                cursor: 'pointer',
                                                fontSize: '0.75rem',
                                                fontFamily: "'Courier New', monospace"
                                            }}
                                        >
                                            + Add Rationale Bullet
                                        </button>
                                    </div>
                                    
                                    {/* Final Call (Editable) */}
                                    <div style={{ marginBottom: '1rem' }}>
                                        <label style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.7)', marginBottom: '0.5rem', fontFamily: "'Courier New', monospace", display: 'block' }}>FINAL CALL:</label>
                                        <textarea
                                                        value={edge.finalCall || ''}
                                            onChange={(e) => handleFieldChange('heatchecksEdge.finalCall', e.target.value)}
                                            style={{
                                                width: '100%',
                                                minHeight: '200px',
                                                padding: '1rem',
                                                background: 'rgba(0, 0, 0, 0.3)',
                                                border: '1px solid rgba(248, 66, 66, 0.4)',
                                                borderRadius: '2px',
                                                color: 'rgba(255, 255, 255, 0.95)',
                                                fontSize: '1rem',
                                                lineHeight: '1.8',
                                                fontFamily: "'Courier New', monospace",
                                                fontWeight: 'bold',
                                                resize: 'vertical'
                                            }}
                                            placeholder="Enter the final call/recommendation..."
                                        />
                                    </div>
                                    
                                    {/* Risk Counterpoints (Editable) */}
                                    <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid rgba(255, 255, 255, 0.2)' }}>
                                        <label style={{ fontSize: '0.75rem', color: 'rgba(255, 152, 0, 0.8)', marginBottom: '0.5rem', fontFamily: "'Courier New', monospace", display: 'block' }}>RISKS:</label>
                                                    {(edge.riskCounterpoints || []).map((risk: string, idx: number) => (
                                            <div key={idx} style={{ marginBottom: '0.5rem', display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                                                <span style={{ color: 'rgba(255, 152, 0, 0.9)', fontSize: '1.2rem', lineHeight: '1.5' }}>⚠</span>
                                                <textarea
                                                    value={risk}
                                                    onChange={(e) => {
                                                                    const newRisks = [...(edge.riskCounterpoints || [])];
                                                        newRisks[idx] = e.target.value;
                                                        handleFieldChange('heatchecksEdge.riskCounterpoints', newRisks);
                                                    }}
                                                    style={{
                                                        flex: 1,
                                                        padding: '0.5rem',
                                                        background: 'rgba(0, 0, 0, 0.3)',
                                                        border: '1px solid rgba(255, 152, 0, 0.3)',
                                                        borderRadius: '4px',
                                                        color: 'rgba(255, 152, 0, 0.9)',
                                                        fontSize: '0.85rem',
                                                        fontFamily: "'Courier New', monospace",
                                                        resize: 'vertical',
                                                        minHeight: '2rem'
                                                    }}
                                                    rows={2}
                                                />
                                                <button
                                                    onClick={() => {
                                                                    const newRisks = [...(edge.riskCounterpoints || [])];
                                                        newRisks.splice(idx, 1);
                                                        handleFieldChange('heatchecksEdge.riskCounterpoints', newRisks);
                                                    }}
                                                    style={{
                                                        padding: '0.25rem 0.5rem',
                                                        background: 'rgba(248, 66, 66, 0.2)',
                                                        border: '1px solid rgba(248, 66, 66, 0.5)',
                                                        borderRadius: '4px',
                                                        color: '#f84242',
                                                        cursor: 'pointer',
                                                        fontSize: '0.75rem'
                                                    }}
                                                >
                                                    ×
                                                </button>
                                            </div>
                                        ))}
                                        <button
                                            onClick={() => {
                                                            const newRisks = [...(edge.riskCounterpoints || []), ''];
                                                handleFieldChange('heatchecksEdge.riskCounterpoints', newRisks);
                                            }}
                                            style={{
                                                marginTop: '0.5rem',
                                                padding: '0.5rem 1rem',
                                                background: 'rgba(255, 152, 0, 0.2)',
                                                border: '1px solid rgba(255, 152, 0, 0.5)',
                                                borderRadius: '4px',
                                                color: 'rgba(255, 152, 0, 0.9)',
                                                cursor: 'pointer',
                                                fontSize: '0.75rem',
                                                fontFamily: "'Courier New', monospace"
                                            }}
                                        >
                                            + Add Risk Counterpoint
                                        </button>
                                    </div>
                                </div>
                                        );
                                    }
                                })()}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

// ===================================================================================
// PROMPT & SCHEMA HELPERS
// ===================================================================================
const getSeoOptimizePrompt = (headline: string, dek: string, backstory: string): string => `
You are an expert sports SEO strategist. Based on the following article content, generate a highly optimized SEO package.
**Content Summary:**
- **Headline:** ${headline}
- **Dek:** ${dek}
- **Backstory:** ${backstory}
**Your Task:** Create a JSON object with keys: "slug", "metaTitle", "metaDescription".
**Constraints:**
- **slug**: A URL-friendly, lowercase, hyphenated string.
- **metaTitle**: A compelling, keyword-rich title (50-60 characters).
- **metaDescription**: An engaging summary (150-160 characters) with a strong hook.
CRITICAL: Your response must only contain this JSON object.
`;

const getViralTweetPrompt = (story: HeatcheckStory, edge: HeatchecksEdge): string => `
You are a viral sports content strategist. Create a two-part Twitter thread based on this content.
**STORY**: ${story.headline}. ${story.theBackstory}
**EDGE**: ${edge.finalCall}
Generate a JSON object with keys "tweet1" and "tweet2".
- Tweet 1 is a short, powerful hook ending with "(Full story below) 🧵".
- Tweet 2 is a longer follow-up with context and stats.
- Use emojis like 🧵, ✔️, 🎯.
CRITICAL: Your response must only be this JSON object.
`;

// ===================================================================================
// VALIDATION FUNCTION - Validates players/coaches are on correct teams
// ===================================================================================

async function validateKeyCharacters(
  candidateCards: any[],
  teamA: string,
  teamB: string,
  league: string
): Promise<string[]> {
  const warnings: string[] = [];
  
  // Extract all key characters from narrative cards
  const allKeyCharacters = new Set<string>();
  candidateCards.forEach((card: any) => {
    if (card.key_characters && Array.isArray(card.key_characters)) {
      card.key_characters.forEach((char: string) => allKeyCharacters.add(char.trim()));
    }
  });
  
  if (allKeyCharacters.size === 0) {
    return warnings;
  }
  
  // Use AI to validate each character is on the correct team
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY || (window as any).process?.env?.API_KEY || '';
  if (!apiKey) {
    warnings.push('⚠️ Cannot validate: API key not available');
    return warnings;
  }
  
  try {
    const ai = new GoogleGenAI({ apiKey });
    const currentDate = new Date().toLocaleDateString();
    const currentYear = new Date().getFullYear();
    
    const leagueContext = league === 'NBA' 
      ? 'Basketball - check NBA rosters, injury reports (IL, out, doubtful, questionable), and trade deadlines'
      : league === 'NFL'
      ? 'Football - check NFL rosters, injury reports (IR, PUP, questionable, doubtful), and trade deadlines'
      : league === 'EPL' || league === 'Premier League'
      ? 'Soccer - check Premier League squads, transfer status, and injury reports'
      : 'Check current rosters and injury reports';
    
    const validationPrompt = `
You are a sports fact-checker. Validate that the following people are CURRENTLY ACTIVE and associated with the correct teams.

Matchup: ${teamA} vs ${teamB} (${league})
Current Date: ${currentDate}
${leagueContext}
Key Characters Mentioned: ${Array.from(allKeyCharacters).join(', ')}

CRITICAL VALIDATION REQUIREMENTS:
For each person listed, you MUST:
1. Verify they are CURRENTLY on the roster of ${teamA} or ${teamB} (as of ${currentDate})
2. Check their CURRENT injury status:
   - If they are injured and will NOT play in upcoming games: Mark as INVALID
   - If they are on IL (Injured List), IR (Injured Reserve), or have a season-ending injury: Mark as INVALID
   - If they have a minor injury but are expected to play: Mark as VALID
   - If they are healthy and active: Mark as VALID
3. Check if they were recently traded, released, or fired:
   - If traded to another team: Mark as INVALID
   - If released/waived: Mark as INVALID  
   - If coach was fired: Mark as INVALID
4. Verify current employment/active status using Google Search:
   - Query: "[Player Name] ${teamA}" current roster status ${currentYear}
   - Query: "[Player Name] ${teamB}" current roster status ${currentYear}
   - Query: "[Player Name] injury status ${currentDate}"
   - Query: "[Player Name] trade ${currentYear}"

IMPORTANT: Many players have similar names. If you find multiple players with the same name, verify which specific player is mentioned by:
- Checking team context
- Verifying position/role
- Cross-referencing with other key characters mentioned
- If ambiguous, mark as INVALID with low confidence

Return a JSON array of validation results:
[
  {
    "name": "Person Name",
    "team_mentioned": "${teamA}" or "${teamB}",
    "is_valid": true/false,
    "current_status": "Detailed status (e.g., 'On ${teamA} roster, active', 'Traded to X team', 'Injured - out for season', 'Not on roster')",
    "warning": "Warning message if invalid (or empty string if valid)",
    "injury_status": "Active" | "Injured - Playing" | "Injured - Out" | "Season-Ending Injury" | "N/A",
    "verification_confidence": "high" | "medium" | "low"
  }
]

VALIDATION RULES:
- Mark as INVALID if: traded/released/fired, season-ending injury, on IL/IR, not on current roster, injured and won't play
- Mark as VALID only if: currently on roster AND active/healthy (minor injuries that don't prevent playing are OK)
- If uncertain, mark as INVALID with confidence: "low" and provide clear status description

CRITICAL: When a player/coach is clearly NOT on the team (traded, released, fired, or on another team):
- Set verification_confidence to "high"
- Set is_valid to false
- Provide a clear warning explaining why they're invalid (e.g., "Traded to [Team] on [Date]", "Released/waived on [Date]", "Not on current roster")

When uncertain or search results are ambiguous:
- Set verification_confidence to "low" or "medium"
- Set is_valid based on best available information
- Always include detailed explanation in warning field

Be VERY strict - it's better to flag someone as invalid incorrectly than to allow an invalid reference in the article.
`;
    
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-pro',
      contents: validationPrompt,
      config: {
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              team_mentioned: { type: Type.STRING },
              is_valid: { type: Type.BOOLEAN },
              current_status: { type: Type.STRING },
              warning: { type: Type.STRING },
              injury_status: { 
                type: Type.STRING,
                enum: ['Active', 'Injured - Playing', 'Injured - Out', 'Season-Ending Injury', 'N/A']
              },
              verification_confidence: {
                type: Type.STRING,
                enum: ['high', 'medium', 'low']
              }
            },
            required: ['name', 'is_valid', 'current_status', 'warning', 'injury_status', 'verification_confidence']
          }
        }
      }
    });
    
    const validationResults = JSON.parse(response.text);
    validationResults.forEach((result: any) => {
      // Flag low-confidence validations for manual review
      if (result.is_valid && result.verification_confidence === 'low') {
        warnings.push(`⚠️ LOW CONFIDENCE: ${result.name} marked as valid but verification confidence is low. Status: ${result.current_status}${result.injury_status && result.injury_status !== 'N/A' ? `, Injury: ${result.injury_status}` : ''}`);
      }
      
      // Mark invalid results with full details, including confidence level
      if (!result.is_valid && result.warning) {
        const injuryInfo = result.injury_status && result.injury_status !== 'N/A' 
          ? `, Injury: ${result.injury_status}` 
          : '';
        const confidenceLevel = result.verification_confidence || 'medium';
        const confidenceInfo = confidenceLevel === 'low'
          ? ` [Low Confidence - Manual Review Required]`
          : confidenceLevel === 'medium'
          ? ` [Medium Confidence - Review Recommended]`
          : ` [High Confidence]`;
        warnings.push(`⚠️ ${result.name}: ${result.warning} (Current: ${result.current_status}${injuryInfo})${confidenceInfo}`);
      }
      
      // Also flag valid results with injuries that might prevent playing
      if (result.is_valid && (result.injury_status === 'Injured - Out' || result.injury_status === 'Season-Ending Injury')) {
        warnings.push(`⚠️ ${result.name}: Marked as valid but has injury status: ${result.injury_status}. Please verify they are actually playing.`);
      }
    });
    
  } catch (error: any) {
    console.error('Validation error:', error);
    warnings.push('⚠️ Validation check failed: ' + (error.message || 'Unknown error'));
  }
  
  return warnings;
}

// ===================================================================================
// AI EDITOR FUNCTION - Corrects roster validation errors in articles
// ===================================================================================

async function correctArticleWithAI(
  articleMarkdown: string,
  validationWarnings: string[],
  teamA: string,
  teamB: string,
  league: string
): Promise<{ correctedMarkdown: string; correctionsSummary: string[] }> {
  const correctionsSummary: string[] = [];
  
  // Extract invalid players/coaches from validation warnings
  // Updated to handle new format: "⚠️ {Name}: {warning} (Current: {status}, Injury: {injury_status})"
  const invalidCharacters: Array<{ name: string; team: string; status: string }> = [];
  validationWarnings.forEach(warning => {
    // Skip low confidence warnings (they're informational, not actionable)
    if (warning.includes('LOW CONFIDENCE')) {
      return;
    }
    
    // Parse warning format: "⚠️ {Name}: {warning} (Current: {status}[, Injury: {injury}])"
    // Handle both old and new formats
    const match = warning.match(/⚠️\s+([^:]+):\s+(.+?)\s+\(Current:\s+([^,)]+)(?:,\s+Injury:\s+([^)]+))?\)/);
    if (match) {
      const name = match[1].trim();
      const warningMsg = match[2].trim();
      let status = match[3].trim();
      const injuryStatus = match[4] ? match[4].trim() : '';
      
      // Include injury status in the status field if present
      if (injuryStatus) {
        status = `${status} (${injuryStatus})`;
      }
      
      // Determine which team was mentioned (if possible from warning or default to teamA)
      let team = teamA; // Default
      if (warningMsg.toLowerCase().includes(teamB.toLowerCase())) {
        team = teamB;
      } else if (warningMsg.toLowerCase().includes(teamA.toLowerCase())) {
        team = teamA;
      }
      
      invalidCharacters.push({ name, team, status });
    }
  });

  if (invalidCharacters.length === 0) {
    return { correctedMarkdown: articleMarkdown, correctionsSummary: [] };
  }

  const apiKey = import.meta.env.VITE_GEMINI_API_KEY || (window as any).process?.env?.API_KEY || '';
  if (!apiKey) {
    correctionsSummary.push('⚠️ AI correction skipped: API key not available');
    return { correctedMarkdown: articleMarkdown, correctionsSummary };
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    
    // Build list of invalid characters with their details
    const invalidList = invalidCharacters.map(char => 
      `- ${char.name} (mentioned on ${char.team}): ${char.status}`
    ).join('\n');

    const correctionPrompt = `
You are a sports article editor. Correct the following article by replacing invalid player/coach references with valid alternatives.

MATCHUP: ${teamA} vs ${teamB} (${league})
CURRENT DATE: ${new Date().toLocaleDateString()}

INVALID CHARACTERS FOUND (not currently on the teams, injured, or inactive):
${invalidList}

CRITICAL REQUIREMENTS:
1. Use Google Search to find the CURRENT roster (players and coaches) for both ${teamA} and ${teamB}
2. Verify replacement candidates are:
   - Currently on the team's active roster
   - NOT injured or on IL/IR
   - Available to play (not suspended or inactive)
   - In a similar role/position as the invalid character
3. For each invalid character mentioned in the article:
   - If they are mentioned as a player: Replace them with a CURRENT, ACTIVE, HEALTHY player from the same team who plays a similar role/position
   - If they are mentioned as a coach: Replace them with the CURRENT head coach or assistant coach from the same team
   - If they are injured/out: Replace with a healthy, active player in a similar role
   - If they were traded/released: Replace with their replacement on the roster (check recent trades/transactions)
   - Maintain the narrative flow and context (e.g., if discussing a star player, replace with another star player)
   - If discussing an injured player's impact, you may pivot to discuss the impact of their absence
4. Rewrite the affected sections naturally, ensuring the replacement makes sense contextually
5. Preserve all other content (stats, quotes, timeline events, narrative structure)
6. Do NOT remove sections entirely - always replace with valid alternatives OR pivot the narrative
7. Before making replacements, verify via Google Search: "[Replacement Name] ${teamA} roster ${new Date().getFullYear()}" or "[Replacement Name] ${teamB} roster ${new Date().getFullYear()}"
8. Verify injury status: "[Replacement Name] injury status ${new Date().toLocaleDateString()}"

ARTICLE TO CORRECT:
${articleMarkdown}

INSTRUCTIONS:
- Return ONLY the corrected article markdown
- Do not include any explanation or JSON wrapper
- Preserve markdown formatting (headings, lists, bold, etc.)
- Keep all valid player/coach names unchanged
- Make replacements natural and contextually appropriate
- If a player/coach name appears multiple times, replace ALL occurrences consistently
- If you cannot find a suitable replacement, pivot the narrative to discuss the absence/impact instead
`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash-exp',
      contents: correctionPrompt,
      config: {
        tools: [{ googleSearch: {} }],
      }
    });

    const correctedMarkdown = response.text.trim();
    
    if (!correctedMarkdown || correctedMarkdown.length < 100) {
      throw new Error('AI correction returned empty or too short result');
    }

    // Build corrections summary
    invalidCharacters.forEach(char => {
      correctionsSummary.push(`✅ Fixed: Replaced ${char.name} (${char.status}) with valid ${char.team} roster member`);
    });
    
    correctionsSummary.push(`✅ Article corrected: ${invalidCharacters.length} invalid player/coach reference(s) replaced`);

    return { correctedMarkdown, correctionsSummary };

  } catch (error: any) {
    console.error('AI Editor correction error:', error);
    correctionsSummary.push(`⚠️ AI correction failed: ${error.message || 'Unknown error'} - Using original article`);
    return { correctedMarkdown: articleMarkdown, correctionsSummary };
  }
}

// ===================================================================================
// HEATCHECKS EDGE V3 - 3-Layer System (Edge Finder, Edge Validator, Edge Writer)
// ===================================================================================

// Layer 1: Edge Finder (Deterministic Scoring)
interface EdgeCandidate {
    type: 'game' | 'prop';
    market?: string; // 'moneyline' | 'spread' | 'total'
    selection?: string; // 'TEAM_A' | 'TEAM_B' | 'OVER' | 'UNDER'
    line?: number;
    price_american?: number;
    book?: string;
    // For props
    player_name?: string;
    prop_market?: string; // 'player_points', 'player_assists', etc.
    prop_selection?: 'OVER' | 'UNDER';
    // Scoring
    score: number;
    signals?: any;
}

// Search for odds using Gemini AI
async function searchOddsWithGemini(
    matchPackV3: any,
    teamA: string,
    teamB: string,
    league: string,
    scheduledDate: string | null
): Promise<{ gameMarkets: any; playerProps: any }> {
    const apiKey = import.meta.env.VITE_GEMINI_API_KEY || '';
    if (!apiKey) {
        throw new Error('Gemini API key not available');
    }

    const ai = new GoogleGenAI({ apiKey });

    // Extract form leaders (top 4)
    const factDrop = matchPackV3?.factDrop || {};
    const formLeadersSection = factDrop.sections?.find((s: any) => 
        s.key === 'formLeaders' || s.title === 'FORM_LEADERS' || s.title === 'formLeaders'
    );
    const formLeaders = formLeadersSection?.priorityPlayers || 
                        formLeadersSection?.itemsDetailed || 
                        formLeadersSection?.items || 
                        [];
    
    // Get top 4 form leaders
    const top4Players = formLeaders.slice(0, 4).map((p: any) => p.playerName || '').filter(Boolean);
    
    const gameDate = scheduledDate || matchPackV3?.matchup?.gameDateEst || new Date().toISOString().split('T')[0];
    
    const prompt = `
You are a sports betting odds researcher. Use Google Search to find current betting odds for the following NBA game.

MATCHUP: ${teamA} vs ${teamB}
LEAGUE: ${league}
GAME DATE: ${gameDate}

TASKS:
1. Search for and find current betting lines for this game:
   - Moneyline odds for both teams
   - Point spread (if available)
   - Total points over/under (if available)
   - Include the sportsbook name and American odds format (+100, -110, etc.)

2. Return your findings as a JSON object with this exact structure:
{
  "gameMarkets": {
    "bookmakers": [
      {
        "title": "Sportsbook Name",
        "markets": [
          {
            "key": "h2h",
            "outcomes": [
              {"name": "Team Name", "price": -110},
              {"name": "Team Name", "price": -110}
            ]
          },
          {
            "key": "spreads",
            "outcomes": [
              {"name": "Team Name", "point": -5.5, "price": -110},
              {"name": "Team Name", "point": 5.5, "price": -110}
            ]
          },
          {
            "key": "totals",
            "outcomes": [
              {"name": "Over", "point": 220.5, "price": -110},
              {"name": "Under", "point": 220.5, "price": -110}
            ]
          }
        ]
      }
    ],
    "home_team": "${teamA}",
    "away_team": "${teamB}"
  },
  "playerProps": null
}

CRITICAL REQUIREMENTS:
- Use Google Search to find REAL, CURRENT betting odds from reputable sportsbooks
- Only include odds that actually exist - do not invent or estimate
- If you cannot find odds for a specific market, omit it from the response
- Player props are disabled - always set "playerProps" to null
- Return ONLY valid JSON, no markdown, no explanations
`;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-pro',
            contents: prompt,
            config: {
                tools: [{ googleSearch: {} }],
            }
        });

        const text = response.text;
        if (!text) throw new Error("No response from Gemini for odds search");

        // Parse JSON from response
        let oddsData: any;
        try {
            // Try to extract JSON from markdown code blocks
            const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (jsonMatch) {
                oddsData = JSON.parse(jsonMatch[1].trim());
            } else {
                // Try to find JSON object directly
                const firstBrace = text.indexOf('{');
                const lastBrace = text.lastIndexOf('}');
                if (firstBrace !== -1 && lastBrace !== -1) {
                    oddsData = JSON.parse(text.substring(firstBrace, lastBrace + 1));
                } else {
                    throw new Error("No JSON found in response");
                }
            }
        } catch (parseError: any) {
            console.error('[searchOddsWithGemini] Failed to parse JSON:', parseError);
            console.error('[searchOddsWithGemini] Response text:', text.substring(0, 500));
            throw new Error(`Failed to parse odds data from Gemini: ${parseError.message}`);
        }

        // Ensure structure matches expected format
        // Player props are disabled - always return null
        return {
            gameMarkets: oddsData.gameMarkets || { bookmakers: [] },
            playerProps: null
        };
    } catch (error: any) {
        console.error('[searchOddsWithGemini] Error:', error);
        throw new Error(`Failed to search odds with Gemini: ${error.message || 'Unknown error'}`);
    }
}

async function findEdgeCandidates(
    matchPackV3: any,
    gameMarkets: any,
    playerProps: any,
    teamA: string,
    teamB: string,
    league?: string
): Promise<{ gameCandidate: EdgeCandidate | null; propCandidates: EdgeCandidate[] }> {
    const candidates: EdgeCandidate[] = [];

    // Detect if this is a soccer match
    const isSoccer = league ? isSoccerLeague(league) : (matchPackV3?.source === 'soccer_stats_db' || matchPackV3?.factDrop?.raw?.teamForm?.A?.xgDiff10 !== undefined);

    // Extract team form from MatchPackV3
    const factDrop = matchPackV3?.factDrop || {};
    const teamFormA = factDrop.raw?.teamForm?.A || {};
    const teamFormB = factDrop.raw?.teamForm?.B || {};
    const availability = factDrop.raw?.availability || {};
    
    // Extract formLeaders - try multiple possible locations and field names
    const formLeadersSection = factDrop.sections?.find((s: any) => 
        s.key === 'formLeaders' || s.title === 'FORM_LEADERS' || s.title === 'formLeaders'
    );
    const formLeaders = formLeadersSection?.priorityPlayers || 
                        formLeadersSection?.itemsDetailed || 
                        formLeadersSection?.items || 
                        matchPackV3?.formLeaders || 
                        [];

    // Score game markets
    // Extract team names from gameMarkets (could be in different places depending on OddsAPI response)
    const homeTeamName = gameMarkets?.home_team || gameMarkets?.sport_title?.includes('NBA') ? teamA : teamA;
    const awayTeamName = gameMarkets?.away_team || gameMarkets?.sport_title?.includes('NBA') ? teamB : teamB;
    
    if (gameMarkets && gameMarkets.bookmakers) {
        for (const bookmaker of gameMarkets.bookmakers) {
            // Moneyline
            if (bookmaker.markets) {
                for (const market of bookmaker.markets) {
                    if (market.key === 'h2h' && market.outcomes) {
                        const homeOutcome = market.outcomes.find((o: any) => 
                            o.name === homeTeamName || o.name === teamA || o.name?.includes(teamA.split(' ').pop() || '')
                        );
                        const awayOutcome = market.outcomes.find((o: any) => 
                            o.name === awayTeamName || o.name === teamB || o.name?.includes(teamB.split(' ').pop() || '')
                        );
                        
                        if (homeOutcome && awayOutcome) {
                            // Simple scoring: favor team with better recent form
                            // For NBA: use margin10/margin3 (point differential)
                            // For Soccer: use xgDiff10/xgDiff3 (expected goal differential)
                            const marginA = isSoccer 
                                ? (teamFormA.xgDiff10 || teamFormA.margin10 || 0)
                                : (teamFormA.margin10 || teamFormA.xgDiff10 || 0);
                            const marginB = isSoccer
                                ? (teamFormB.xgDiff10 || teamFormB.margin10 || 0)
                                : (teamFormB.margin10 || teamFormB.xgDiff10 || 0);
                            const isHomeA = gameMarkets.home_team === teamA;
                            // Home advantage: ~3 points for NBA, ~0.4 goals for soccer
                            const homeAdvantage = isSoccer 
                                ? (isHomeA ? 0.4 : -0.4)
                                : (isHomeA ? 3 : -3);
                            const scoreA = marginA + homeAdvantage;
                            const scoreB = marginB - homeAdvantage;
                            
                            if (scoreA > scoreB) {
                                candidates.push({
                                    type: 'game',
                                    market: 'moneyline',
                                    selection: isHomeA ? 'TEAM_A' : 'TEAM_B',
                                    line: null,
                                    price_american: isHomeA ? homeOutcome.price : awayOutcome.price,
                                    book: bookmaker.title,
                                    score: Math.abs(scoreA - scoreB),
                                    signals: { marginA, marginB, homeAdvantage }
                                });
                            } else {
                                candidates.push({
                                    type: 'game',
                                    market: 'moneyline',
                                    selection: isHomeA ? 'TEAM_B' : 'TEAM_A',
                                    line: null,
                                    price_american: isHomeA ? awayOutcome.price : homeOutcome.price,
                                    book: bookmaker.title,
                                    score: Math.abs(scoreB - scoreA),
                                    signals: { marginA, marginB, homeAdvantage }
                                });
                            }
                        }
                    }
                    
                    // Spread
                    if (market.key === 'spreads' && market.outcomes) {
                        const homeOutcome = market.outcomes.find((o: any) => 
                            o.name === homeTeamName || o.name === teamA || o.name?.includes(teamA.split(' ').pop() || '')
                        );
                        const awayOutcome = market.outcomes.find((o: any) => 
                            o.name === awayTeamName || o.name === teamB || o.name?.includes(teamB.split(' ').pop() || '')
                        );
                        
                        if (homeOutcome && awayOutcome && homeOutcome.point !== undefined) {
                            // For NBA: use margin10 (point differential)
                            // For Soccer: use xgDiff10 (expected goal differential)
                            const marginA = isSoccer 
                                ? (teamFormA.xgDiff10 || teamFormA.margin10 || 0)
                                : (teamFormA.margin10 || teamFormA.xgDiff10 || 0);
                            const marginB = isSoccer
                                ? (teamFormB.xgDiff10 || teamFormB.margin10 || 0)
                                : (teamFormB.margin10 || teamFormB.xgDiff10 || 0);
                            const isHomeA = gameMarkets.home_team === teamA;
                            // Home advantage: ~3 points for NBA, ~0.4 goals for soccer
                            const homeAdvantage = isSoccer 
                                ? (isHomeA ? 0.4 : -0.4)
                                : (isHomeA ? 3 : -3);
                            const projectedMargin = (marginA - marginB) + (isHomeA ? homeAdvantage : -homeAdvantage);
                            const spread = homeOutcome.point;
                            const edge = Math.abs(projectedMargin - spread);
                            
                            candidates.push({
                                type: 'game',
                                market: 'spread',
                                selection: projectedMargin > spread ? (isHomeA ? 'TEAM_A' : 'TEAM_B') : (isHomeA ? 'TEAM_B' : 'TEAM_A'),
                                line: spread,
                                price_american: projectedMargin > spread ? homeOutcome.price : awayOutcome.price,
                                book: bookmaker.title,
                                score: edge,
                                signals: { marginA, marginB, projectedMargin, spread }
                            });
                        }
                    }
                    
                    // Total
                    if (market.key === 'totals' && market.outcomes) {
                        const overOutcome = market.outcomes.find((o: any) => o.name === 'Over');
                        const underOutcome = market.outcomes.find((o: any) => o.name === 'Under');
                        
                        if (overOutcome && underOutcome && overOutcome.point !== undefined) {
                            // Simple scoring: use team pace/offense metrics if available, otherwise neutral
                            const total = overOutcome.point;
                            // For now, use a simple heuristic - can be enhanced with actual pace data
                            candidates.push({
                                type: 'game',
                                market: 'total',
                                selection: 'OVER', // Default to OVER, can be refined
                                line: total,
                                price_american: overOutcome.price,
                                book: bookmaker.title,
                                score: 1.0, // Neutral score
                                signals: { total }
                            });
                        }
                    }
                }
            }
        }
    }

    // Player props are disabled - skip processing entirely
    // Score player props (DISABLED - no longer fetching player props from OddsAPI)
    // NOTE: Player props processing is disabled - always skip this block
    const shouldProcessPlayerProps = false; // Player props disabled
    if (shouldProcessPlayerProps && !isSoccer && playerProps && playerProps.bookmakers && Array.isArray(playerProps.bookmakers) && playerProps.bookmakers.length > 0) {
        // Create a map of player name to form leader data
        const playerDataMap = new Map<string, any>();
        for (const leader of formLeaders) {
            if (leader.playerName) {
                playerDataMap.set(leader.playerName.toLowerCase(), leader);
            }
        }

        // Also check availability for injury status
        const availabilityMap = new Map<string, string>();
        const majorAbsences = availability.majorAbsences || {};
        for (const [teamId, data] of Object.entries(majorAbsences)) {
            if (data && typeof data === 'object' && 'players' in data) {
                const players = (data as any).players || [];
                for (const player of players) {
                    if (player.playerName) {
                        availabilityMap.set(player.playerName.toLowerCase(), player.status || 'OUT');
                    }
                }
            }
        }

        for (const bookmaker of playerProps.bookmakers) {
            if (bookmaker.markets) {
                for (const market of bookmaker.markets) {
                    const marketKey = market.key || '';
                    if (!marketKey.startsWith('player_')) continue;

                    if (market.outcomes) {
                        for (const outcome of market.outcomes) {
                            const playerName = outcome.description || outcome.name || '';
                            if (!playerName) continue;

                            const playerData = playerDataMap.get(playerName.toLowerCase());
                            if (!playerData) {
                                console.log(`[Edge Finder] Skipping prop for ${playerName}: not in form leaders (formLeaders count: ${formLeaders.length})`);
                                continue; // Skip if player not in form leaders
                            }

                            // Get signals
                            const minutesDelta = playerData.deltaMIN10vsSeason || 0;
                            const usageDelta = playerData.deltaUSG10vsSeason || 0;
                            const minutesAvg3 = playerData.minutesAvg3 || 0;
                            const gamesCount10 = playerData.gamesCount10 || 0;

                            // Prop fit mapping
                            let propScore = 0;
                            if (marketKey === 'player_points') {
                                propScore = usageDelta + minutesDelta;
                            } else if (marketKey === 'player_assists' || marketKey === 'player_rebounds' || marketKey === 'player_threes') {
                                propScore = minutesDelta;
                            } else if (marketKey === 'player_points_rebounds_assists') {
                                propScore = (usageDelta + minutesDelta) * 1.2; // Boost for PRA
                            } else {
                                propScore = minutesDelta; // Default
                            }

                            // Only consider OVER props for now (can add UNDER logic later)
                            if (outcome.name === 'Over' && outcome.point !== undefined && propScore > 0) {
                                candidates.push({
                                    type: 'prop',
                                    player_name: playerName,
                                    prop_market: marketKey,
                                    prop_selection: 'OVER',
                                    line: outcome.point,
                                    price_american: outcome.price,
                                    book: bookmaker.title,
                                    score: propScore,
                                    signals: {
                                        minutesDelta,
                                        usageDelta,
                                        minutesAvg3,
                                        gamesCount10,
                                        marketKey
                                    }
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    // Select top game candidate (exactly one)
    const gameCandidates = candidates.filter(c => c.type === 'game').sort((a, b) => b.score - a.score);
    const gameCandidate = gameCandidates.length > 0 ? gameCandidates[0] : null;

    // Select top 1 prop candidate (exactly one)
    const propCandidates = candidates
        .filter(c => c.type === 'prop')
        .sort((a, b) => b.score - a.score)
        .slice(0, 1);

    console.log(`[Edge Finder] Found ${candidates.filter(c => c.type === 'prop').length} prop candidates, selected top ${propCandidates.length}`);
    if (propCandidates.length > 0) {
        propCandidates.forEach((prop, idx) => {
            console.log(`[Edge Finder] Prop candidate ${idx + 1}: ${prop.player_name} ${prop.prop_market} ${prop.prop_selection} ${prop.line} (score: ${prop.score})`);
        });
    }

    return { gameCandidate, propCandidates };
}

// Layer 2: Edge Validator (Rules Only)
async function validateEdgeCandidates(
    candidates: { gameCandidate: EdgeCandidate | null; propCandidates: EdgeCandidate[] },
    matchPackV3: any
): Promise<{ validatedGame: EdgeCandidate | null; validatedProps: EdgeCandidate[] }> {
    const validatedProps: EdgeCandidate[] = [];

    // Validate game candidate (basic checks)
    let validatedGame = candidates.gameCandidate;
    if (validatedGame) {
        // Verify line exists if needed
        if (validatedGame.market === 'spread' || validatedGame.market === 'total') {
            if (validatedGame.line === undefined || validatedGame.line === null) {
                validatedGame = null;
            }
        }
        // Verify price exists
        if (validatedGame.price_american === undefined || validatedGame.price_american === null) {
            validatedGame = null;
        }
        // Verify book exists
        if (!validatedGame.book) {
            validatedGame = null;
        }
    }

    // Validate prop candidates
    const formLeaders = matchPackV3?.factDrop?.sections?.find((s: any) => s.title === 'FORM_LEADERS')?.itemsDetailed || [];
    const availability = matchPackV3?.factDrop?.raw?.availability || {};
    const majorAbsences = availability.majorAbsences || {};
    
    // Build availability map
    const availabilityMap = new Map<string, string>();
    for (const [teamId, data] of Object.entries(majorAbsences)) {
        if (data && typeof data === 'object' && 'players' in data) {
            const players = (data as any).players || [];
            for (const player of players) {
                if (player.playerName) {
                    availabilityMap.set(player.playerName.toLowerCase(), player.status || 'OUT');
                }
            }
        }
    }

    for (const prop of candidates.propCandidates) {
        if (!prop.player_name) {
            console.log(`[Edge Validator] Skipping prop: missing player_name`);
            continue;
        }

        // Find player data
        const playerData = formLeaders.find((l: any) => 
            l.playerName && l.playerName.toLowerCase() === prop.player_name!.toLowerCase()
        );
        
        if (!playerData) {
            console.log(`[Edge Validator] Skipping prop for ${prop.player_name}: player not found in form leaders`);
            continue; // Skip if player not found
        }

        // Eligibility rules - try multiple field name variations
        const minutesAvg3 = Number(playerData.minutesAvg3) || 
                            Number(playerData.min3) || 
                            Number(playerData.MIN3) || 
                            Number(playerData.minutes_avg_3) || 
                            0;
        const gamesCount10 = Number(playerData.gamesCount10) || 
                             Number(playerData.games10) || 
                             Number(playerData.GAMES10) || 
                             Number(playerData.games_count_10) || 
                             0;
        const playerStatus = availabilityMap.get(prop.player_name.toLowerCase()) || 'ACTIVE';

        // Check eligibility
        if (minutesAvg3 < 24) {
            console.log(`[Edge Validator] Skipping prop for ${prop.player_name}: minutesAvg3 (${minutesAvg3}) < 24`);
            continue; // Skip if not enough minutes
        }
        if (gamesCount10 < 6) {
            console.log(`[Edge Validator] Skipping prop for ${prop.player_name}: gamesCount10 (${gamesCount10}) < 6`);
            continue; // Skip if not enough games
        }
        if (playerStatus.toUpperCase().includes('OUT')) {
            console.log(`[Edge Validator] Skipping prop for ${prop.player_name}: player status is OUT`);
            continue; // Block OUT players
        }

        // Verify prop data
        if (prop.line === undefined || prop.line === null) {
            console.log(`[Edge Validator] Skipping prop for ${prop.player_name}: missing line`);
            continue;
        }
        if (prop.price_american === undefined || prop.price_american === null) {
            console.log(`[Edge Validator] Skipping prop for ${prop.player_name}: missing price_american`);
            continue;
        }
        if (!prop.book) {
            console.log(`[Edge Validator] Skipping prop for ${prop.player_name}: missing book`);
            continue;
        }

        // Downgrade confidence if QUESTIONABLE
        if (playerStatus.toUpperCase().includes('QUESTIONABLE')) {
            prop.signals = { ...prop.signals, confidenceDowngrade: true };
        }

        console.log(`[Edge Validator] Validated prop for ${prop.player_name}: ${prop.prop_market} ${prop.prop_selection} ${prop.line} (${prop.price_american > 0 ? '+' : ''}${prop.price_american}) @${prop.book}`);
        validatedProps.push(prop);
    }
    
    console.log(`[Edge Validator] Total validated props: ${validatedProps.length} out of ${candidates.propCandidates.length} candidates`);

    return { validatedGame, validatedProps };
}

// Layer 3: Edge Writer (Gemini)
async function generateHeatChecksEdgeV3(
    validatedCandidates: { validatedGame: EdgeCandidate | null; validatedProps: EdgeCandidate[] },
    matchPackV3: any,
    teamA: string,
    teamB: string,
    league: string
): Promise<HeatchecksEdgeV2> {
    const apiKey = import.meta.env.VITE_GEMINI_API_KEY || '';
    if (!apiKey) {
        console.warn('API key not available for Edge V3 generation, returning no edge');
        return {
            game: { market: 'none', selection: 'none', line: null, price_american: null, book: null, confidence: 'low', receipts: ['', '', ''], risks: ['', ''], one_sentence_call: '' },
            player_props: [],
            no_edge_reason: 'API key not available'
        };
    }

    try {
        const ai = new GoogleGenAI({ apiKey });

        // Extract context from MatchPackV3
        const factDrop = matchPackV3?.factDrop || {};
        const teamFormA = factDrop.raw?.teamForm?.A || {};
        const teamFormB = factDrop.raw?.teamForm?.B || {};
        const availability = factDrop.raw?.availability || {};
        const matchup = matchPackV3?.matchup || {};

        // Build narrative tags
        const narrativeTags = {
            revenge_game: false, // Can be enhanced with MatchPackV3 data
            role_surge: validatedCandidates.validatedProps.length > 0,
            injury_consolidation: (availability.majorAbsences?.A?.count || 0) > 0 || (availability.majorAbsences?.B?.count || 0) > 0,
            fatigue_stack: false, // Can be enhanced
            must_win: false // Can be enhanced
        };

        // Build prop shortlist - ensure we have exactly one prop (use first validated or create fallback)
        let propShortlist: any[] = [];
        if (validatedCandidates.validatedProps.length > 0) {
            // Use the first (and only) validated prop
            const prop = validatedCandidates.validatedProps[0];
            propShortlist = [{
                player_name: prop.player_name || '',
                market_key: prop.prop_market || '',
                selection: prop.prop_selection || 'OVER',
                line: prop.line || 0,
                price_american: prop.price_american || 0,
                book: prop.book || '',
                supporting_signals: {
                    minutes_avg_3: prop.signals?.minutesAvg3 || 0,
                    minutes_delta_3_vs_season: prop.signals?.minutesDelta || 0,
                    usage_proxy_avg_3: 0, // Not in current data
                    usage_delta_3_vs_season: prop.signals?.usageDelta || 0,
                    injury_context: '',
                    rest_flags: { back_to_back: false, three_in_four: false }
                }
            }];
        } else {
            // Fallback: Create a generic prop if none were validated
            // Try to get a form leader to suggest a prop
            const formLeadersSection = factDrop.sections?.find((s: any) => 
                s.key === 'formLeaders' || s.title === 'FORM_LEADERS' || s.title === 'formLeaders'
            );
            const formLeaders = formLeadersSection?.priorityPlayers || 
                                formLeadersSection?.itemsDetailed || 
                                formLeadersSection?.items || 
                                [];
            
            if (formLeaders.length > 0) {
                const topPlayer = formLeaders[0];
                propShortlist = [{
                    player_name: topPlayer.playerName || 'Unknown Player',
                    market_key: 'player_points',
                    selection: 'OVER',
                    line: 20, // Generic fallback line
                    price_american: -110, // Generic fallback price
                    book: 'OddsAPI',
                    supporting_signals: {
                        minutes_avg_3: topPlayer.minutesAvg3 || topPlayer.min3 || 0,
                        minutes_delta_3_vs_season: topPlayer.deltaMIN10vsSeason || 0,
                        usage_proxy_avg_3: 0,
                        usage_delta_3_vs_season: topPlayer.deltaUSG10vsSeason || 0,
                        injury_context: 'No validated props available from API',
                        rest_flags: { back_to_back: false, three_in_four: false }
                    }
                }];
            }
        }

        // Build game markets - ensure we have exactly one game edge (use validated or create fallback)
        const gameMarkets: any = {};
        if (validatedCandidates.validatedGame) {
            const game = validatedCandidates.validatedGame;
            gameMarkets[game.market || 'none'] = {
                selection: game.selection,
                line: game.line,
                price_american: game.price_american,
                book: game.book
            };
        } else {
            // Fallback: Create a generic game edge if none were validated
            // Use moneyline as default fallback
            // Detect if this is a soccer match
            const isSoccer = isSoccerLeague(league);
            // For NBA: use margin10 (point differential)
            // For Soccer: use xgDiff10 (expected goal differential)
            const marginA = isSoccer 
                ? (teamFormA.xgDiff10 || teamFormA.margin10 || 0)
                : (teamFormA.margin10 || teamFormA.xgDiff10 || 0);
            const marginB = isSoccer
                ? (teamFormB.xgDiff10 || teamFormB.margin10 || 0)
                : (teamFormB.margin10 || teamFormB.xgDiff10 || 0);
            const isHomeA = matchup.homeAway?.A === 'HOME';
            // Home advantage: ~3 points for NBA, ~0.4 goals for soccer
            const homeAdvantage = isSoccer 
                ? (isHomeA ? 0.4 : -0.4)
                : (isHomeA ? 3 : -3);
            const projectedWinner = (marginA + homeAdvantage) > marginB ? 'TEAM_A' : 'TEAM_B';
            
            gameMarkets.moneyline = {
                selection: projectedWinner,
                line: null,
                price_american: -110, // Generic fallback price
                book: 'OddsAPI'
            };
        }

        // Detect if this is a soccer match for proper data display
        const isSoccer = isSoccerLeague(league);
        const formMetricLabel = isSoccer ? 'xG diff' : 'margin';
        const formA10 = isSoccer 
            ? (teamFormA.xgDiff10 || teamFormA.margin10 || 0)
            : (teamFormA.margin10 || teamFormA.xgDiff10 || 0);
        const formA3 = isSoccer
            ? (teamFormA.xgDiff3 || teamFormA.margin3 || 0)
            : (teamFormA.margin3 || teamFormA.xgDiff3 || 0);
        const formB10 = isSoccer
            ? (teamFormB.xgDiff10 || teamFormB.margin10 || 0)
            : (teamFormB.margin10 || teamFormB.xgDiff10 || 0);
        const formB3 = isSoccer
            ? (teamFormB.xgDiff3 || teamFormB.margin3 || 0)
            : (teamFormB.margin3 || teamFormB.xgDiff3 || 0);

        const edgePrompt = `
You are HeatChecks Edge Writer.

Goal:
Create a concise, credible betting "Edge" summary for a ${isSoccer ? 'soccer' : 'basketball'} matchup using ONLY the provided data.
You are NOT allowed to invent lines, odds, injuries, or stats.

Inputs you will receive:
1) matchup: teams, date, event_id
2) game_markets: moneyline/spread/total with best available line + price + book
3) prop_shortlist: up to 2 props (${isSoccer ? 'NOTE: Soccer matches typically do not have player props, so this may be empty' : 'each with player_name, market_key, selection, line, price_american, book, and supporting signals'})
4) narrative_tags: revenge_game, role_surge, injury_consolidation, fatigue_stack, must_win (booleans)

MATCHUP: ${teamA} vs ${teamB} (${league})
GAME DATE: ${matchup.gameDateEst || matchup.gameDate || 'Unknown'}

GAME MARKETS:
${JSON.stringify(gameMarkets, null, 2)}

PROP SHORTLIST:
${JSON.stringify(propShortlist, null, 2)}

TEAM FORM:
Team A (${teamA}): L10 ${formMetricLabel} ${formA10.toFixed(2)}, L3 ${formMetricLabel} ${formA3.toFixed(2)}
Team B (${teamB}): L10 ${formMetricLabel} ${formB10.toFixed(2)}, L3 ${formMetricLabel} ${formB3.toFixed(2)}
${isSoccer ? '(Note: For soccer, margin refers to expected goal differential, not point differential)' : ''}

NARRATIVE TAGS:
${JSON.stringify(narrativeTags, null, 2)}

Output STRICT JSON matching this schema:

{
  "game": {
    "market": "moneyline"|"spread"|"total"|"none",
    "selection": "TEAM_A"|"TEAM_B"|"OVER"|"UNDER"|"none",
    "line": number|null,
    "price_american": number|null,
    "book": string|null,
    "confidence": "low"|"medium"|"high",
    "receipts": [string, string, string],
    "risks": [string, string],
    "one_sentence_call": string
  },
  "player_props": [
    {
      "player_name": string,
      "market": string,
      "selection": "OVER"|"UNDER",
      "line": number,
      "price_american": number,
      "book": string,
      "confidence": "low"|"medium"|"high",
      "receipts": [string, string, string],
      "risks": [string, string]
    }
  ],
  "no_edge_reason": string|null
}

Rules:
- You MUST return exactly ONE game edge${isSoccer ? ' (soccer matches typically do not have player props)' : ' and exactly ONE player prop'}.
${isSoccer ? '- For soccer matches, focus on game markets (moneyline, spread, total) only. Player props are not typically available.' : '- If the provided game_markets or prop_shortlist are fallbacks (indicated by generic values), acknowledge this in the receipts/risks.'}
- Receipts must reference the provided signals${isSoccer ? ' (team form, xG differential, injuries)' : ' (minutes_delta, usage_delta, injuries, rest)'}, not vague claims.
- Keep receipts short, punchy, and measurable.
- For soccer: Use goal-based terminology (e.g., "goals", "expected goals", "xG differential") instead of point-based terminology.
- TEAM_A refers to ${teamA}, TEAM_B refers to ${teamB}.
${isSoccer ? '- For soccer matches, player_props array should be empty (soccer does not have player props).' : '- Always return exactly one prop in player_props array (even if it\'s a fallback).'}
- Always return a game edge (even if market="none" for fallback cases, still provide one_sentence_call).
`;

        console.log(`[generateHeatChecksEdgeV3] Generating Edge V3 for ${teamA} vs ${teamB}...`);

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-pro',
            contents: edgePrompt,
            config: {
                // Note: Cannot use responseMimeType with tools enabled
                // Rely on prompt to ensure JSON output, then parse manually
                tools: [{ googleSearch: {} }],
            }
        });

        const text = response.text;
        if (!text) throw new Error("No response from AI for Edge V3 generation");

        // Parse the JSON response
        let edgeData: HeatchecksEdgeV2;
        try {
            edgeData = extractJson<HeatchecksEdgeV2>(text);
        } catch (parseError: any) {
            console.error('[generateHeatChecksEdgeV3] Failed to parse JSON:', parseError);
            console.error('[generateHeatChecksEdgeV3] Response text:', text.substring(0, 500));
            try {
                edgeData = JSON.parse(text);
            } catch (e) {
                throw new Error(`Failed to parse Edge V3 JSON response: ${parseError.message}`);
            }
        }

        // Validate and ensure required fields
        // For soccer: only game edge (no player props)
        // For NBA: game edge + one player prop
        const playerProps = Array.isArray(edgeData.player_props) ? edgeData.player_props : [];
        
        // Ensure we have exactly one prop (NBA only - soccer doesn't have player props)
        let finalProps: any[] = [];
        if (isSoccer) {
            // Soccer matches don't have player props - leave empty
            finalProps = [];
        } else if (playerProps.length > 0) {
            // Use the first prop
            finalProps = [playerProps[0]];
        } else {
            // Fallback prop if AI didn't return one (NBA only)
            const formLeadersSection = factDrop.sections?.find((s: any) => 
                s.key === 'formLeaders' || s.title === 'FORM_LEADERS' || s.title === 'formLeaders'
            );
            const formLeaders = formLeadersSection?.priorityPlayers || 
                                formLeadersSection?.itemsDetailed || 
                                formLeadersSection?.items || 
                                [];
            
            if (formLeaders.length > 0) {
                const topPlayer = formLeaders[0];
                finalProps = [{
                    player_name: topPlayer.playerName || 'Unknown Player',
                    market: 'player_points',
                    selection: 'OVER',
                    line: 20,
                    price_american: -110,
                    book: 'OddsAPI',
                    confidence: 'low',
                    receipts: ['Fallback prop - API did not provide validated prop', 'Based on form leader data', ''],
                    risks: ['No validated prop data available from API', '']
                }];
            } else {
                // Ultimate fallback
                finalProps = [{
                    player_name: 'Unknown Player',
                    market: 'player_points',
                    selection: 'OVER',
                    line: 20,
                    price_american: -110,
                    book: 'OddsAPI',
                    confidence: 'low',
                    receipts: ['No prop data available', '', ''],
                    risks: ['No validated prop data available', '']
                }];
            }
        }

        // Ensure we have a game edge (even if it's a fallback)
        let finalGame = edgeData.game;
        if (!finalGame || finalGame.market === 'none') {
            // Fallback game edge
            const marginA = teamFormA.margin10 || 0;
            const marginB = teamFormB.margin10 || 0;
            const isHomeA = matchup.homeAway?.A === 'HOME';
            const homeAdvantage = isHomeA ? 3 : -3;
            const projectedWinner = (marginA + homeAdvantage) > marginB ? 'TEAM_A' : 'TEAM_B';
            
            finalGame = {
                market: 'moneyline',
                selection: projectedWinner,
                line: null,
                price_american: -110,
                book: 'OddsAPI',
                confidence: 'low',
                receipts: ['Fallback game edge - API did not provide validated game market', 'Based on team form and home advantage', ''],
                risks: ['No validated game market data available from API', ''],
                one_sentence_call: `Fallback recommendation: ${projectedWinner === 'TEAM_A' ? teamA : teamB} based on recent form.`
            };
        }

        return {
            game: {
                market: finalGame.market || 'none',
                selection: finalGame.selection || 'none',
                line: finalGame.line ?? null,
                price_american: finalGame.price_american ?? null,
                book: finalGame.book || null,
                confidence: finalGame.confidence || 'low',
                receipts: finalGame.receipts || ['', '', ''],
                risks: finalGame.risks || ['', ''],
                one_sentence_call: finalGame.one_sentence_call || ''
            },
            player_props: finalProps,
            no_edge_reason: edgeData.no_edge_reason || null
        };

    } catch (error: any) {
        console.error('[generateHeatChecksEdgeV3] Error generating Edge V3:', error);
        return {
            game: { market: 'none', selection: 'none', line: null, price_american: null, book: null, confidence: 'low', receipts: ['', '', ''], risks: ['', ''], one_sentence_call: '' },
            player_props: [],
            no_edge_reason: `Edge generation failed: ${error.message || 'Unknown error'}`
        };
  }
}

// ===================================================================================
// HEATCHECKS EDGE GENERATOR - Creates betting recommendation from narratives and odds
// ===================================================================================

async function generateHeatChecksEdge(
  narratives: { candidate_cards: any[], selected: any },
  factPack: any,
  primaryCard: any,
  teamA: string,
  teamB: string,
  league: string
): Promise<HeatchecksEdge> {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY || '';
  if (!apiKey) {
    console.warn('API key not available for Edge generation, using defaults');
    return {
      subjectType: "team",
      subjectName: teamA,
      game: `${teamA} vs ${teamB}`,
      marketSnapshot: {
        retrievedAt: factPack.odds?.last_updated_utc || new Date().toISOString(),
        books: []
      },
      lines: factPack.odds?.markets?.map((m: any) => ({
        marketType: m.market,
        label: m.outcomes.join(' vs '),
        line: m.point?.toString() || '',
        price: m.price?.toString() || '',
        book: m.book || '',
        sourceUrl: ''
      })) || [],
      lean: "NO_EDGE",
      confidence: "medium",
      rationaleBullets: [],
      riskCounterpoints: [],
      historicalAnalog: { claim: '', sourceUrl: null },
      finalCall: ''
    };
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    
    // Extract key narrative information
    const primaryNarrative = primaryCard?.title || '';
    const narrativeClaim = primaryCard?.claim || '';
    const allNarratives = narratives.candidate_cards?.map((c: any) => `${c.title}: ${c.claim}`).join('\n') || '';
    
    // Extract odds information
    const oddsInfo = factPack.odds ? `
    Current Betting Lines:
    - Source: ${factPack.odds.source || 'Unknown'}
    - Last Updated: ${factPack.odds.last_updated_utc || 'Unknown'}
    - Markets: ${JSON.stringify(factPack.odds.markets || [], null, 2)}
    ` : 'No betting odds available';
    
    // Extract context (form, injuries, stats)
    const contextInfo = factPack.context ? `
    Recent Form:
    - ${teamA}: ${factPack.context.recent_form?.home || 'Unknown'}
    - ${teamB}: ${factPack.context.recent_form?.away || 'Unknown'}
    
    Injuries: ${JSON.stringify(factPack.context.injuries || [], null, 2)}
    ` : 'No context data available';
    
    const keyStats = factPack.key_stats?.map((s: any) => `${s.label}: ${s.value} (${s.why_it_matters})`).join('\n') || 'No key stats available';

    const edgePrompt = `
You are an elite sports betting analyst operating in the "HeatChecks War Room." Your job is to synthesize narratives, odds, and data into a decisive betting recommendation.

MATCHUP: ${teamA} vs ${teamB} (${league})
CURRENT DATE: ${new Date().toLocaleDateString()}

PRIMARY NARRATIVE: "${primaryNarrative}"
NARRATIVE CLAIM: "${narrativeClaim}"

ALL NARRATIVE CARDS:
${allNarratives}

${oddsInfo}

${contextInfo}

KEY STATISTICS:
${keyStats}

TASK: Analyze the narratives, betting lines, and context to create a decisive betting recommendation.

GUIDELINES:
- **Be clinical and decisive** - No hedging
- **Synthesize the narrative with the odds** - The narrative should inform your betting angle
- **Subject Type**: Determine if the bet is about a "player" or "team"
- **Subject Name**: Name the specific player or team you're betting on
- **The Lines**: Use the markets provided above. Format each line clearly.
- **Lean**: State your position: FAVOR (betting on), FADE (betting against), or NO_EDGE (no strong position)
- **Confidence**: Low / Medium / High - based on narrative strength and data support
- **Rationale Bullets**: 3-5 bullet points explaining WHY this is the bet, connecting narrative to odds
- **Risk Counterpoints**: 2-3 counterarguments that could make this bet fail
- **Historical Analog**: Find a similar historical moment/pattern that supports this bet (optional but powerful)
- **Final Call**: Write a compelling, confident betting recommendation in the style of the example:
   "The world is in love with C.J. Stroud and the Texans' 9-game heater, but they are walking into a frozen buzzsaw. Mike Tomlin is at his most dangerous when the national media starts writing his retirement obituary. In a sub-40-point slugfest, I'm taking the Steelers (+3.5) and the Moneyline. Aaron Rodgers has one more January miracle in his arm, and the Acrisure crowd on a Monday night is worth 4 points alone. The Standard doesn't break—it just gets colder. Take the Steelers in a 'last dance' upset."
   
   Make it specific, reference the narrative, reference the odds/line, and be decisive.

Return ONLY a valid JSON object matching this schema:
{
  "subjectType": "team" or "player",
  "subjectName": "string",
  "game": "${teamA} vs ${teamB}",
  "marketSnapshot": {
    "retrievedAt": "${factPack.odds?.last_updated_utc || new Date().toISOString()}",
    "books": []
  },
  "lines": [
    {
      "marketType": "Moneyline|Spread|Total",
      "label": "string (e.g., 'Steelers vs Texans')",
      "line": "string (e.g., '+3.5' or 'o/u 42.5')",
      "price": "string (e.g., '+150' or '-110')",
      "book": "string",
      "sourceUrl": "string or empty string"
    }
  ],
  "lean": "FAVOR" or "FADE" or "NO_EDGE",
  "confidence": "low" or "medium" or "high",
  "rationaleBullets": ["bullet 1", "bullet 2", "bullet 3"],
  "riskCounterpoints": ["risk 1", "risk 2"],
  "historicalAnalog": {
    "claim": "string describing historical comparison",
    "sourceUrl": "string or null"
  },
  "finalCall": "string (your full betting recommendation paragraph)"
}
`;

    console.log(`[generateHeatChecksEdge] Generating Edge for ${teamA} vs ${teamB}...`);
    
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-pro',
      contents: edgePrompt,
      config: {
        tools: [{ googleSearch: {} }],
      }
    });

    const text = response.text;
    if (!text) throw new Error("No response from AI for Edge generation");

    // Parse the JSON response - use extractJson first to handle markdown code fences
    let edgeData: HeatchecksEdge;
    try {
      // Try extractJson first (handles markdown code fences)
      edgeData = extractJson<HeatchecksEdge>(text);
    } catch (parseError: any) {
      console.error('[generateHeatChecksEdge] Failed to parse JSON:', parseError);
      console.error('[generateHeatChecksEdge] Response text:', text.substring(0, 500));
      // Fallback: try direct JSON.parse if extractJson fails
      try {
        edgeData = JSON.parse(text);
      } catch (e) {
        throw new Error(`Failed to parse Edge JSON response: ${parseError.message}`);
      }
    }

    // Validate required fields
    if (!edgeData.finalCall || edgeData.finalCall.trim() === '') {
      throw new Error('Edge generation returned empty finalCall');
    }

    // Ensure all required fields are present with defaults
    return {
      subjectType: edgeData.subjectType || "team",
      subjectName: edgeData.subjectName || teamA,
      game: edgeData.game || `${teamA} vs ${teamB}`,
      marketSnapshot: edgeData.marketSnapshot || {
        retrievedAt: factPack.odds?.last_updated_utc || new Date().toISOString(),
        books: []
      },
      lines: edgeData.lines || factPack.odds?.markets?.map((m: any) => ({
        marketType: m.market,
        label: m.outcomes.join(' vs '),
        line: m.point?.toString() || '',
        price: m.price?.toString() || '',
        book: m.book || '',
        sourceUrl: ''
      })) || [],
      lean: edgeData.lean || "NO_EDGE",
      confidence: edgeData.confidence || "medium",
      rationaleBullets: edgeData.rationaleBullets || [],
      riskCounterpoints: edgeData.riskCounterpoints || [],
      historicalAnalog: edgeData.historicalAnalog || { claim: '', sourceUrl: null },
      finalCall: edgeData.finalCall
    };

  } catch (error: any) {
    console.error('[generateHeatChecksEdge] Error generating Edge:', error);
    // Return a default Edge with error message in finalCall
    return {
      subjectType: "team",
      subjectName: teamA,
      game: `${teamA} vs ${teamB}`,
      marketSnapshot: {
        retrievedAt: factPack.odds?.last_updated_utc || new Date().toISOString(),
        books: []
      },
      lines: factPack.odds?.markets?.map((m: any) => ({
        marketType: m.market,
        label: m.outcomes.join(' vs '),
        line: m.point?.toString() || '',
        price: m.price?.toString() || '',
        book: m.book || '',
        sourceUrl: ''
      })) || [],
      lean: "NO_EDGE",
      confidence: "low",
      rationaleBullets: [`Edge generation failed: ${error.message || 'Unknown error'}`],
      riskCounterpoints: [],
      historicalAnalog: { claim: '', sourceUrl: null },
      finalCall: `Edge generation encountered an error. Please manually create the betting recommendation based on the narrative: "${primaryCard?.claim || 'No narrative available'}"`
    };
  }
}

// ===================================================================================
// HEAT ARTICLE V3 HELPERS (MatchPack-driven narrative + Temperature Check)
// ===================================================================================
type MatchPackV3 = any;

type EvidenceForV3 = {
  sources: Array<{ sourceId: string; title?: string; publisher?: string; url?: string; publishedUtc?: string; reliabilityTier?: string }>;
  quotes: Array<{ quoteId: string; quote: string; speaker?: string | null; team?: string | null; sourceId?: string | null; sourceName?: string | null }>;
  timeline: Array<{ eventId: string; dateUtc?: string | null; summary: string; relatedPlayers: string[] }>;
};

function normalizeEvidenceForV3(evidenceBundle: any): EvidenceForV3 {
  const sourcesIn = Array.isArray(evidenceBundle?.sources) ? evidenceBundle.sources : [];
  const quotesIn = Array.isArray(evidenceBundle?.quotes) ? evidenceBundle.quotes : [];
  const timelineIn = Array.isArray(evidenceBundle?.timeline_events) ? evidenceBundle.timeline_events : [];

  const sources = sourcesIn.map((s: any, idx: number) => ({
    sourceId: String(s.source_id || s.sourceId || `SRC_${idx + 1}`),
    title: s.title || undefined,
    publisher: s.publisher || undefined,
    url: s.url || undefined,
    publishedUtc: s.published_utc || s.publishedUtc || undefined,
    reliabilityTier: s.reliability_tier || s.reliabilityTier || undefined,
  }));

  const sourceNameById = new Map<string, string>();
  sources.forEach(s => {
    if (s.sourceId) sourceNameById.set(s.sourceId, s.publisher || s.title || '');
  });

  const quotes = quotesIn
    .filter((q: any) => q && typeof q.quote === 'string' && q.quote.trim())
    .slice(0, 8)
    .map((q: any, idx: number) => {
      const quoteId = String(q.quote_id || q.quoteId || `Q_${idx + 1}`);
      const sourceId = q.source_id ? String(q.source_id) : (q.sourceId ? String(q.sourceId) : null);
      return {
        quoteId,
        quote: String(q.quote).trim(),
        speaker: q.speaker ? String(q.speaker) : null,
        team: q.team ? String(q.team) : null,
        sourceId,
        sourceName: sourceId ? (sourceNameById.get(sourceId) || null) : null,
      };
    });

  const timeline = timelineIn
    .filter((e: any) => e && typeof e.summary === 'string' && e.summary.trim())
    .slice(0, 12)
    .map((e: any, idx: number) => ({
      eventId: String(e.event_id || e.eventId || `E_${idx + 1}`),
      dateUtc: e.date_utc ? String(e.date_utc) : null,
      summary: String(e.summary).trim(),
      relatedPlayers: Array.isArray(e.relatedPlayers) ? e.relatedPlayers.map((p: any) => String(p)) : [],
    }));

  return { sources, quotes, timeline };
}

function buildTemperatureCheckSummary(matchPack: MatchPackV3) {
  const bullets = Array.isArray(matchPack?.factDrop?.bullets) ? matchPack.factDrop.bullets : [];
  const comparisons = Array.isArray(matchPack?.factDrop?.comparisons) ? matchPack.factDrop.comparisons : [];
  const sections = Array.isArray(matchPack?.factDrop?.sections) ? matchPack.factDrop.sections : [];

  const margin10 = comparisons.find((c: any) => c?.key === 'margin10') || comparisons[0] || null;
  const formLeaders = sections.find((s: any) => s?.key === 'formLeaders') || null;
  const availability = matchPack?.factDrop?.raw?.availability?.majorAbsences || null;

  return {
    visibleBulletKeys: bullets.map((b: any) => b?.key).filter(Boolean),
    highlightComparisonKey: margin10?.key || null,
    availabilityDisplayOverride: '',
    priorityPlayersOverride: [] as string[],
    computed: {
      homeAway: matchPack?.matchup?.homeAway || null,
      bullets: bullets.map((b: any) => ({ key: b.key, label: b.label, display: b.display })),
      highlightComparison: margin10,
      availabilityCounts: availability
        ? { A: availability?.A?.count ?? 0, B: availability?.B?.count ?? 0 }
        : null,
      priorityPlayers: Array.isArray(formLeaders?.priorityPlayers) ? formLeaders.priorityPlayers : [],
    }
  };
}

async function generateTemperatureCheckV3AI(matchPack: MatchPackV3, evidence: EvidenceForV3): Promise<any> {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY || (window as any).process?.env?.API_KEY || '';
  if (!apiKey) throw new Error('API key not available');
  const ai = new GoogleGenAI({ apiKey });

  const prompt = `
SYSTEM
You are HeatChecks V3 Temperature Check engine.

DATA DISCIPLINE (HARD RULES)
- Do not invent statistics, injuries, or quotes.
- Any numbers must be copied from:
  - factDrop.bullets[].display
  - factDrop.comparisons[].display
  - factDrop.sections[key=formLeaders].priorityPlayers[].displayText
- Any quote used must be copied exactly from evidence.quotes[].quote.

USER
MATCHPACK (AUTHORITATIVE)
${JSON.stringify({ matchPack, evidence }, null, 2)}

TASK
Return a tight pre-game readout:
- tempScore (0-100)
- 3 takeaways
- 2 risks
- optionally 0-1 quote anchor (verbatim)

RETURN JSON ONLY:
{
  "tempScore": 0-100,
  "takeaways": ["..."],
  "risks": ["..."],
  "usedStatAnchors": ["exact display strings used"],
  "usedQuoteIds": ["quoteId"],
  "warnings": []
}
`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-pro',
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          tempScore: { type: Type.NUMBER },
          takeaways: { type: Type.ARRAY, items: { type: Type.STRING } },
          risks: { type: Type.ARRAY, items: { type: Type.STRING } },
          usedStatAnchors: { type: Type.ARRAY, items: { type: Type.STRING } },
          usedQuoteIds: { type: Type.ARRAY, items: { type: Type.STRING } },
          warnings: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ['tempScore', 'takeaways', 'risks', 'usedStatAnchors', 'usedQuoteIds', 'warnings']
      }
    }
  });

  return JSON.parse(response.text);
}

function buildTemperatureCheckRenderedMarkdown(matchPack: MatchPackV3, summary: any, tempAI: any) {
  const escapeHtmlSimple = (s: string) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');

  const buildPriorityPlayersChartHtml = (players: any[], title: string) => {
    if (!Array.isArray(players) || players.length === 0) return '';

    const clean = players
      .map(p => ({
        teamAbbr: String(p?.teamAbbr || ''),
        playerName: String(p?.playerName || '').trim(),
        usg10: Number(p?.USG10),
        min10: Number(p?.MIN10),
        usgSeason: Number(p?.USGSeason),
        minSeason: Number(p?.MINSeason),
        deltaUSG10vsSeason: Number(p?.deltaUSG10vsSeason),
      }))
      .filter(p => p.playerName);

    if (clean.length === 0) return '';

    const maxUsg = Math.max(
      1,
      ...clean.map(p => (Number.isFinite(p.usg10) ? p.usg10 : 0)),
      ...clean.map(p => (Number.isFinite(p.usgSeason) ? p.usgSeason : 0))
    );
    const maxMin = Math.max(
      1,
      ...clean.map(p => (Number.isFinite(p.min10) ? p.min10 : 0)),
      ...clean.map(p => (Number.isFinite(p.minSeason) ? p.minSeason : 0))
    );

    const groups = new Map<string, typeof clean>();
    for (const p of clean) {
      const k = p.teamAbbr || 'TEAM';
      const arr = groups.get(k) || [];
      arr.push(p);
      groups.set(k, arr);
    }

    const groupHtml = [...groups.entries()].map(([teamAbbr, arr]) => {
      const rows = arr.slice(0, 4).map((p, idx) => {
        const usgW = Math.round(((Number.isFinite(p.usg10) ? p.usg10 : 0) / maxUsg) * 100);
        const minW = Math.round(((Number.isFinite(p.min10) ? p.min10 : 0) / maxMin) * 100);
        const usgSeasonW = Math.round(((Number.isFinite(p.usgSeason) ? p.usgSeason : 0) / maxUsg) * 100);
        const minSeasonW = Math.round(((Number.isFinite(p.minSeason) ? p.minSeason : 0) / maxMin) * 100);
        const du = Number.isFinite(p.deltaUSG10vsSeason)
          ? (p.deltaUSG10vsSeason > 0 ? `+${p.deltaUSG10vsSeason.toFixed(1)}` : p.deltaUSG10vsSeason.toFixed(1))
          : '';

        const rowStyle = idx === 0
          ? 'padding:0.35rem 0 0.45rem 0;'
          : 'padding:0.45rem 0; border-top:1px dashed rgba(255,255,255,0.12);';

        return `
<div style="${rowStyle}">
  <div style="display:flex; justify-content:space-between; gap:0.75rem;">
    <div style="color:rgba(255,255,255,0.92); font-weight:900;">${escapeHtmlSimple(p.playerName)}</div>
    ${du ? `<div style="font-family:'Courier New', monospace; font-size:0.75rem; color:#ffe66d; border:1px solid rgba(255,230,109,0.35); padding:0.05rem 0.35rem; border-radius:999px;">ΔUSG10 ${escapeHtmlSimple(du)}</div>` : ``}
  </div>

  <div style="margin-top:0.35rem; display:grid; grid-template-columns:54px 1fr 76px; gap:0.5rem; align-items:center;">
    <div style="font-family:'Courier New', monospace; font-size:0.75rem; color:rgba(255,255,255,0.7);">USG10</div>
    <div style="height:10px; position:relative; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.12); border-radius:999px; overflow:hidden;">
      <div style="height:100%; width:${usgSeasonW}%; background:linear-gradient(90deg, rgba(255,26,26,0.35), rgba(248,66,66,0.18));"></div>
      <div style="height:100%; width:${usgW}%; position:absolute; left:0; top:0; background:linear-gradient(90deg, rgba(255,26,26,0.95), rgba(248,66,66,0.65));"></div>
    </div>
    <div style="font-family:'Courier New', monospace; font-size:0.75rem; color:rgba(255,255,255,0.75); text-align:right;">
      ${Number.isFinite(p.usg10) ? p.usg10.toFixed(1) : '—'}${Number.isFinite(p.usgSeason) ? `/${p.usgSeason.toFixed(1)}` : ''}
    </div>
  </div>

  <div style="margin-top:0.25rem; display:grid; grid-template-columns:54px 1fr 76px; gap:0.5rem; align-items:center;">
    <div style="font-family:'Courier New', monospace; font-size:0.75rem; color:rgba(255,255,255,0.7);">MIN10</div>
    <div style="height:10px; position:relative; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.12); border-radius:999px; overflow:hidden;">
      <div style="height:100%; width:${minSeasonW}%; background:linear-gradient(90deg, rgba(255,230,109,0.35), rgba(255,230,109,0.18));"></div>
      <div style="height:100%; width:${minW}%; position:absolute; left:0; top:0; background:linear-gradient(90deg, rgba(255,230,109,0.95), rgba(255,230,109,0.55));"></div>
    </div>
    <div style="font-family:'Courier New', monospace; font-size:0.75rem; color:rgba(255,255,255,0.75); text-align:right;">
      ${Number.isFinite(p.min10) ? p.min10.toFixed(1) : '—'}${Number.isFinite(p.minSeason) ? `/${p.minSeason.toFixed(1)}` : ''}
    </div>
  </div>
</div>
        `;
      }).join('');

      return `
<div style="padding:0.4rem 0.45rem; background:transparent; border-left:2px solid rgba(0,255,65,0.28);">
  <div style="color:rgba(255,230,109,0.92); font-weight:900; letter-spacing:0.12em; margin-bottom:0.1rem;">${escapeHtmlSimple(teamAbbr)}</div>
  ${rows}
</div>
      `;
    }).join('');

    return `
<div style="margin-top:0.45rem; padding:0.55rem; background:rgba(0, 12, 6, 0.96); border:1px solid rgba(0, 255, 65, 0.18); border-radius:10px; box-shadow:0 0 14px rgba(0, 255, 65, 0.10), inset 0 0 14px rgba(0, 255, 65, 0.04); position:relative; overflow:hidden;">
  <div style="position:absolute; inset:0; pointer-events:none; opacity:0.22; background-image: radial-gradient(circle at center, rgba(0, 255, 65, 0.16) 1px, transparent 1px), radial-gradient(circle at center, rgba(0, 255, 65, 0.08) 2px, transparent 2px); background-size: 52px 52px, 104px 104px; background-position:center;"></div>
  <div style="position:absolute; inset:0; pointer-events:none; opacity:0.06; background: linear-gradient(180deg, rgba(0,255,65,0.0) 0%, rgba(0,255,65,0.12) 50%, rgba(0,255,65,0.0) 100%);"></div>
  <div style="position:relative; display:flex; flex-direction:column; gap:0.6rem;">
    ${groupHtml}
  </div>
</div>
    `;
  };

  const bullets: any[] = Array.isArray(matchPack?.factDrop?.bullets) ? matchPack.factDrop.bullets : [];
  const comparisons: any[] = Array.isArray(matchPack?.factDrop?.comparisons) ? matchPack.factDrop.comparisons : [];
  const sections: any[] = Array.isArray(matchPack?.factDrop?.sections) ? matchPack.factDrop.sections : [];

  const visibleKeys: string[] = Array.isArray(summary?.visibleBulletKeys) && summary.visibleBulletKeys.length > 0
    ? summary.visibleBulletKeys
    : bullets.map((b: any) => b?.key).filter(Boolean);

  const visibleBullets = bullets
    .filter((b: any) => visibleKeys.includes(b?.key))
    .map((b: any) => ({
      key: b?.key,
      label: b.label || b.key || 'BULLET',
      display: b.display || '',
      raw: b?.raw,
    }));

  const highlightComparisonKey = summary?.highlightComparisonKey || 'margin10';
  const highlightComparison = comparisons.find((c: any) => c?.key === highlightComparisonKey) || comparisons[0] || null;

  const formLeaders = sections.find((s: any) => s?.key === 'formLeaders') || null;
  const priorityPlayers = Array.isArray(summary?.priorityPlayersOverride) && summary.priorityPlayersOverride.length > 0
    ? summary.priorityPlayersOverride
    : (Array.isArray((formLeaders as any)?.priorityPlayers) ? (formLeaders as any).priorityPlayers.map((p: any) => p.displayText || '').filter(Boolean) : []);

  const availabilityOverride = typeof summary?.availabilityDisplayOverride === 'string' && summary.availabilityDisplayOverride.trim()
    ? summary.availabilityDisplayOverride.trim()
    : null;

  const availability = (matchPack as any)?.factDrop?.raw?.availability?.majorAbsences || null;
  const availabilityCounts = availability ? {
    A: availability?.A?.count ?? 0,
    B: availability?.B?.count ?? 0
  } : null;

  const aiTakeaways = Array.isArray(tempAI?.takeaways) ? tempAI.takeaways : [];
  const aiRisks = Array.isArray(tempAI?.risks) ? tempAI.risks : [];
  const tempScore = Number.isFinite(tempAI?.tempScore) ? tempAI.tempScore : null;

  const teamA = String((matchPack as any)?.matchup?.teamA || (matchPack as any)?.matchup?.teamAAbbr || 'Team A');
  const teamB = String((matchPack as any)?.matchup?.teamB || (matchPack as any)?.matchup?.teamBAbbr || 'Team B');
  const haA = String((matchPack as any)?.matchup?.homeAway?.A || '');
  const haB = String((matchPack as any)?.matchup?.homeAway?.B || '');

  const lines: string[] = [];
  if (tempScore !== null) {
    const label = tempScore >= 70 ? 'HOT' : tempScore >= 45 ? 'WARM' : 'COOL';
    lines.push(`<div style="color:rgba(255,255,255,0.78); font-family:'Courier New', monospace; font-size:0.8rem; letter-spacing:0.08em;">TEMP: <span style="color:#00ff41; font-weight:900; text-shadow:0 0 10px rgba(0,255,65,0.25);">${escapeHtmlSimple(label)}</span></div>`);
  }
  if (haA || haB) {
    lines.push(`<div style="margin-top:0.15rem; color:rgba(255,255,255,0.72); font-family:'Courier New', monospace; font-size:0.78rem;">HOME/AWAY: <span style="color:rgba(255,255,255,0.9); font-weight:700;">${escapeHtmlSimple(teamA)}</span> (${escapeHtmlSimple(haA || 'n/a')}) | <span style="color:rgba(255,255,255,0.9); font-weight:700;">${escapeHtmlSimple(teamB)}</span> (${escapeHtmlSimple(haB || 'n/a')})</div>`);
  }
  if (availabilityOverride) {
    lines.push(`<div style="margin-top:0.35rem; padding:0.45rem 0.55rem; background:rgba(0,0,0,0.25); border:1px solid rgba(0,255,65,0.18); border-left:2px solid rgba(0,255,65,0.45); border-radius:8px; color:rgba(255,255,255,0.82); font-family:'Courier New', monospace; font-size:0.78rem;"><span style="color:#00ff41; font-weight:900; letter-spacing:0.1em;">AVAIL</span> ${escapeHtmlSimple(availabilityOverride)}</div>`);
  }
  if (visibleBullets.length > 0) {
    lines.push(`<div style="margin-top:0.55rem; color:#00ff41; font-weight:900; letter-spacing:0.14em; font-family:'Courier New', monospace; font-size:0.75rem; text-transform:uppercase;">FACTDROP</div>`);

    const getWinner = (key: string, raw: any): 'A' | 'B' | 'even' | null => {
      try {
        if (!raw) return null;
        const k = String(key || '').toLowerCase();
        const num = (v: any) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v));
        const isFiniteNum = (v: any) => typeof v === 'number' && Number.isFinite(v);

        if (k === 'last10') {
          // Check margin (basketball) or xgDiff (soccer) first
          const aM = num(raw?.A?.margin10) || num(raw?.A?.xgDiff10);
          const bM = num(raw?.B?.margin10) || num(raw?.B?.xgDiff10);
          if (isFiniteNum(aM) && isFiniteNum(bM) && aM !== bM) return aM > bM ? 'A' : 'B';
          // Fall back to wins
          const aW = num(raw?.A?.w10);
          const bW = num(raw?.B?.w10);
          if (isFiniteNum(aW) && isFiniteNum(bW) && aW !== bW) return aW > bW ? 'A' : 'B';
          return 'even';
        }

        if (k === 'last3') {
          // Check margin (basketball) or xgDiff (soccer) first
          const aM = num(raw?.A?.margin3) || num(raw?.A?.xgDiff3);
          const bM = num(raw?.B?.margin3) || num(raw?.B?.xgDiff3);
          if (isFiniteNum(aM) && isFiniteNum(bM) && aM !== bM) return aM > bM ? 'A' : 'B';
          // Fall back to wins
          const aW = num(raw?.A?.w3);
          const bW = num(raw?.B?.w3);
          if (isFiniteNum(aW) && isFiniteNum(bW) && aW !== bW) return aW > bW ? 'A' : 'B';
          return 'even';
        }

        if (k === 'momentum') {
          const a = num(raw?.A);
          const b = num(raw?.B);
          if (isFiniteNum(a) && isFiniteNum(b) && a !== b) return a > b ? 'A' : 'B';
          return 'even';
        }

        if (k === 'closegames') {
          const aW = num(raw?.A?.closeW10);
          const bW = num(raw?.B?.closeW10);
          if (isFiniteNum(aW) && isFiniteNum(bW) && aW !== bW) return aW > bW ? 'A' : 'B';
          const aL = num(raw?.A?.closeL10);
          const bL = num(raw?.B?.closeL10);
          if (isFiniteNum(aL) && isFiniteNum(bL) && aL !== bL) return aL < bL ? 'A' : 'B';
          return 'even';
        }

        if (k === 'standings') {
          // Check rank (basketball) or position (soccer) first
          const aR = num(raw?.A?.rank) || num(raw?.A?.position);
          const bR = num(raw?.B?.rank) || num(raw?.B?.position);
          // Smaller rank/position is better
          if (isFiniteNum(aR) && isFiniteNum(bR) && aR !== bR) return aR < bR ? 'A' : 'B';
          // Fall back to points (soccer) or wins (basketball)
          const aP = num(raw?.A?.points) || num(raw?.A?.wins);
          const bP = num(raw?.B?.points) || num(raw?.B?.wins);
          if (isFiniteNum(aP) && isFiniteNum(bP) && aP !== bP) return aP > bP ? 'A' : 'B';
          return 'even';
        }

        return null;
      } catch {
        return null;
      }
    };

    const renderWinnerSplit = (b: any) => {
      const winner = getWinner(String(b?.key || ''), b?.raw);
      const disp = String(b?.display || '');
      const parts = disp.split(' | ');
      if (parts.length < 2 || !winner) return escapeHtmlSimple(disp);

      const left = escapeHtmlSimple(parts[0]);
      const right = escapeHtmlSimple(parts.slice(1).join(' | '));

      const base = 'padding:0.22rem 0.35rem; border-radius:8px; border:1px solid rgba(255,255,255,0.10);';
      const win = 'background:rgba(0,255,65,0.10); border:1px solid rgba(0,255,65,0.28); color:rgba(255,255,255,0.92); font-weight:900; box-shadow:0 0 12px rgba(0,255,65,0.10);';
      const lose = 'background:transparent; border:1px solid rgba(255,255,255,0.08); color:rgba(255,255,255,0.72); font-weight:700;';
      const even = 'background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.10); color:rgba(255,255,255,0.80); font-weight:800;';

      const leftStyle = base + (winner === 'A' ? win : winner === 'B' ? lose : even);
      const rightStyle = base + (winner === 'B' ? win : winner === 'A' ? lose : even);

      return `<span style="display:inline-flex; gap:0.35rem; flex-wrap:wrap; align-items:center;"><span style="${leftStyle}">${left}</span><span style="color:rgba(255,255,255,0.35); font-weight:900;">|</span><span style="${rightStyle}">${right}</span></span>`;
    };

    lines.push(`<div style="margin-top:0.25rem; display:flex; flex-direction:column; gap:0.25rem;">${
      visibleBullets.map(b => `
        <div style="padding:0.35rem 0.45rem; background:rgba(0,0,0,0.18); border:1px solid rgba(0,255,65,0.14); border-radius:8px;">
          <div style="color:rgba(255,255,255,0.9); font-weight:800; font-family:'Courier New', monospace; font-size:0.78rem;">${escapeHtmlSimple(b.label)}:</div>
          <div style="margin-top:0.12rem; color:rgba(255,255,255,0.76); font-family:'Courier New', monospace; font-size:0.78rem; line-height:1.35;">${renderWinnerSplit(b)}</div>
        </div>
      `).join('')
    }</div>`);
  }
  if (highlightComparison) {
    const metric = escapeHtmlSimple(String(highlightComparison.metric || highlightComparison.key || 'comparison'));
    const aDisp = escapeHtmlSimple(String(highlightComparison.display?.A || String(highlightComparison.A || '')));
    const bDisp = escapeHtmlSimple(String(highlightComparison.display?.B || String(highlightComparison.B || '')));
    const winnerRaw = String(highlightComparison.winner || 'even');
    
    // Get short team names for display
    const getShortTeamName = (fullName: string): string => {
      if (!fullName) return '';
      const trimmed = fullName.trim();
      if (!trimmed) return '';
      const parts = trimmed.split(/\s+/);
      if (parts.length === 1) return parts[0];
      const lastWord = parts[parts.length - 1];
      const suffixes = ['FC', 'United', 'City', 'Town'];
      if (suffixes.includes(lastWord) && parts.length > 1) {
        return parts[parts.length - 2] + ' ' + lastWord;
      }
      return lastWord;
    };
    
    const teamAName = escapeHtmlSimple(getShortTeamName(teamA));
    const teamBName = escapeHtmlSimple(getShortTeamName(teamB));
    
    // Map winner to team name
    let winnerDisplay = winnerRaw;
    if (winnerRaw === 'A') {
      winnerDisplay = teamAName;
    } else if (winnerRaw === 'B') {
      winnerDisplay = teamBName;
    } else {
      winnerDisplay = escapeHtmlSimple(winnerRaw);
    }
    
    lines.push(`<div style="margin-top:0.55rem; color:#00ff41; font-weight:900; letter-spacing:0.14em; font-family:'Courier New', monospace; font-size:0.75rem; text-transform:uppercase;">KEY_COMP</div>`);
    lines.push(`<div style="margin-top:0.2rem; padding:0.45rem 0.55rem; background:rgba(0,0,0,0.22); border:1px solid rgba(0,255,65,0.16); border-radius:10px; color:rgba(255,255,255,0.82); font-family:'Courier New', monospace; font-size:0.78rem;">${metric}: ${teamAName}=${aDisp} | ${teamBName}=${bDisp} <span style="color:rgba(255,255,255,0.6);">(winner: ${winnerDisplay})</span></div>`);
  }
  // NOTE: charts now render via Chart.js in the published Temperature_Check panel.
  // We intentionally do not inject the old priority-player HTML chart here anymore.

  // Replace "AI_TAKEAWAYS / AI_RISKS" with a human-first impact block
  const hook = (aiTakeaways.find((t: string) => t && t.trim().length <= 130) || '').trim();
  const watchFor = (aiRisks.find((r: string) => r && r.trim().length <= 140) || '').trim();

  lines.push(`<div style="margin-top:0.65rem; color:#00ff41; font-weight:900; letter-spacing:0.14em; font-family:'Courier New', monospace; font-size:0.75rem; text-transform:uppercase;">IMPACT</div>`);
  if (hook) {
    lines.push(`<div style="margin-top:0.2rem; color:rgba(255,255,255,0.82); font-family:'Courier New', monospace; font-size:0.8rem; line-height:1.35;">${escapeHtmlSimple(hook)}</div>`);
  }
  if (highlightComparison) {
    const metric = (highlightComparison.metric || highlightComparison.key || 'edge');
    const aDisp = highlightComparison.display?.A || String(highlightComparison.A || '');
    const bDisp = highlightComparison.display?.B || String(highlightComparison.B || '');
    const winner =
      highlightComparison.winner === 'A' ? teamA :
      highlightComparison.winner === 'B' ? teamB : 'Neither side';
    lines.push(`<div style="margin-top:0.25rem; color:rgba(255,255,255,0.78); font-family:'Courier New', monospace; font-size:0.78rem;">EDGE: <span style="color:rgba(255,255,255,0.92); font-weight:800;">${escapeHtmlSimple(winner)}</span> ${escapeHtmlSimple(metric)} (${escapeHtmlSimple(aDisp)} vs ${escapeHtmlSimple(bDisp)})</div>`);
  }

  const swing =
    availabilityOverride ||
    ((availabilityCounts && (availabilityCounts.A > 0 || availabilityCounts.B > 0))
      ? 'Availability is the swing—late scratches can flip the entire script.'
      : 'Health looks stable—this swings on execution and shot-making.');
  lines.push(`<div style="margin-top:0.25rem; color:rgba(255,255,255,0.78); font-family:'Courier New', monospace; font-size:0.78rem;">SWING: ${escapeHtmlSimple(swing)}</div>`);

  if (watchFor) {
    lines.push(`<div style="margin-top:0.25rem; color:rgba(255,255,255,0.7); font-family:'Courier New', monospace; font-size:0.78rem;">WATCH: ${escapeHtmlSimple(watchFor)}</div>`);
  }
  return lines.join('');
}

async function generateHeatArticleV3Narrative(matchPack: MatchPackV3, evidence: EvidenceForV3): Promise<any> {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY || (window as any).process?.env?.API_KEY || '';
  if (!apiKey) throw new Error('API key not available');
  const ai = new GoogleGenAI({ apiKey });

  const prompt = `
SYSTEM
You are HeatChecks V3 Narrative Engine.

You will receive a MatchPack JSON generated from HeatChecks’ local stats database plus an evidence bundle.

DATA DISCIPLINE (HARD RULES)
- Do not invent statistics, injuries, or quotes.
- Any numbers must be copied from:
  - factDrop.bullets[].display
  - factDrop.comparisons[].display
  - factDrop.sections[key=formLeaders].priorityPlayers[].displayText
- Any quote used must be copied exactly from evidence.quotes[].quote.
- You may paraphrase what a quote implies, but do not alter the quote text.

PLAYER MENTION RULE
- You may only name players that appear in:
  - factDrop.sections[key=formLeaders].itemsDetailed or priorityPlayers
  - factDrop.sections[key=revengeWatch].items
  - evidence.timeline[].relatedPlayers

STYLE
HeatChecks terminal vibe: tense, cinematic, sharp. Avoid ESPN clichés.

USER
MATCHPACK (AUTHORITATIVE)
${JSON.stringify({ matchPack, evidence }, null, 2)}

TASK
Write a story-first matchup narrative with a deep dive angle.
Use quotes to make the narrative feel lived-in and documented.

OUTPUT (VALID JSON ONLY)
{
  "selectedAngles": {
    "primary": {
      "id": "string",
      "title": "string",
      "supportedBy": { "bullets": ["bulletKey"], "comparisons": ["comparisonKey"], "sections": ["sectionKey"], "quoteIds": ["quoteId"] }
    },
    "secondary": [
      {
        "id": "string",
        "title": "string",
        "supportedBy": { "bullets": ["bulletKey"], "comparisons": ["comparisonKey"], "sections": ["sectionKey"], "quoteIds": ["quoteId"] }
      }
    ]
  },
  "narrativeThesis": "2–4 sentences. Establish conflict. Include at most ONE quoted stat display OR ONE quote.",
  "deepDive": {
    "headline": "string",
    "lede": "One punchy paragraph.",
    "acts": [
      {
        "actTitle": "ACT I — Setup",
        "whatItMeans": "Explain the tension and what’s at stake.",
        "anchors": [
          { "type": "stat", "text": "copy exact bullets[].display OR comparisons[].display OR player displayText" },
          { "type": "quote", "text": "copy exact evidence.quotes[].quote", "quoteId": "string" }
        ]
      },
      {
        "actTitle": "ACT II — Pressure",
        "whatItMeans": "Late-game nerves, close-game identity, standings pressure.",
        "anchors": [
          { "type": "stat", "text": "copy exact display string" }
        ]
      },
      {
        "actTitle": "ACT III — Break",
        "whatItMeans": "Two scripts: A controls it if… B flips it if…",
        "anchors": [
          { "type": "quote", "text": "copy exact quote", "quoteId": "string" }
        ]
      }
    ],
    "pressurePoints": [
      "3–6 concrete moments that could swing the game (no new stats)."
    ],
    "quotesUsed": [
      { "quoteId": "string", "quote": "exact quote", "speaker": "string|null", "sourceName": "string|null" }
    ]
  },
  "narrativeCards": [
    {
      "id": "string",
      "title": "string",
      "claim": "one-sentence claim tied to selectedAngles.supportedBy",
      "emotionTags": ["pressure","momentum","control","volatility","revenge","urgency","expectation","instability","confidence"],
      "score": 0
    }
  ],
  "matchupMeaning": "1 paragraph, no numbers, what this reveals about both teams",
  "quality": {
    "usedStatAnchors": ["exact display strings used"],
    "usedQuoteIds": ["quoteId", "..."],
    "warnings": ["If evidence.quotes is empty, say so and proceed without quotes."]
  }
}

QUOTE RULES
- Use 0–2 quotes total. If none exist, proceed with no quotes.
- Quotes must be copied verbatim.
- Don’t stack quotes back-to-back; space them as anchors.

RETURN JSON ONLY.
`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-pro',
    contents: prompt,
    config: { responseMimeType: "application/json" }
  });

  return JSON.parse(response.text);
}

// ===================================================================================
// HEAT ARTICLE V3: HUMAN PASS (post-processing pulse layer)
// ===================================================================================
type HumanPassOutput = {
  humanPass: {
    overlayParagraphs: string[];
    recognitionLines: string[];
    tensionLeans: Array<{ direction: 'teamA' | 'teamB' | 'neither'; line: string }>;
    closingBeat: string;
  };
};

function escapeHtmlSimple(s: string) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Render QUOTE or STAT anchor as HTML directly
 * This bypasses markdown conversion to prevent nesting issues
 */
function renderQuoteStatAnchor(type: 'QUOTE' | 'STAT', text: string, speaker?: string | null): string {
  const t = escapeHtmlSimple(String(text || '').trim());
  const labelColor = type === 'STAT' ? '#00ff41' : '#ffe66d';
  const leftColor = type === 'STAT' ? 'rgba(0, 255, 65, 0.75)' : 'rgba(255, 230, 109, 0.85)';
  const textStyle = type === 'QUOTE'
    ? `color:rgba(255,255,255,0.82); font-family:'Courier New', monospace; font-size:0.74rem; line-height:1.45; font-style:italic;`
    : `color:rgba(255,255,255,0.82); font-family:'Courier New', monospace; font-size:0.74rem; line-height:1.45;`;
  
  // For QUOTE, add speaker attribution if available
  const speakerHtml = (type === 'QUOTE' && speaker) 
    ? `<span style="color:rgba(255,255,255,0.65); font-size:0.70rem; margin-left:0.4rem; white-space:nowrap;">— ${escapeHtmlSimple(speaker)}</span>` 
    : '';
  
  // Render the HTML block (minified, no literal newlines)
  const htmlBlock = (
    `<div style="margin:0.45rem 0; padding:0.5rem 0.65rem; background:rgba(0, 20, 10, 0.92); border:1px solid rgba(255,255,255,0.14); border-left:3px solid ${leftColor}; border-radius:10px; box-shadow:0 0 12px rgba(0,0,0,0.35), inset 0 0 14px rgba(255,255,255,0.04);">` +
    `<div style="display:flex; align-items:flex-start; gap:0.5rem;">` +
    `<div style="font-family:'Courier New', monospace; font-size:0.70rem; letter-spacing:0.16em; font-weight:900; color:${labelColor}; flex-shrink:0; white-space:nowrap;">${type}:</div>` +
    `<div style="${textStyle} flex:1; word-wrap:break-word; overflow-wrap:break-word;">${t}${speakerHtml}</div>` +
    `</div>` +
    `</div>`
  );
  
  // Wrap in HTML block markers so markdownToHtml preserves it as-is
  return `<!-- HTML_BLOCK_START -->${htmlBlock}<!-- HTML_BLOCK_END -->`;
}

async function generateHeatArticleV3HumanPass(
  articleMarkdown: string,
  teamA: string,
  teamB: string
): Promise<HumanPassOutput> {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY || (window as any).process?.env?.API_KEY || '';
  if (!apiKey) throw new Error('API key not available');

  const ai = new GoogleGenAI({ apiKey });

  const prompt = `
system
You are the Human Pass for HeatChecks.

You are not the analyst.
You are the voice that shows up after the analysis is written.

You have read the article.
You agree with the facts.
You do not try to improve structure or correctness.

Your job is to give the piece a pulse.

RULES:
- Do NOT add new statistics, records, or numbers.
- Do NOT introduce new players or teams.
- Do NOT contradict the article.
- Do NOT explain concepts again.
- Do NOT summarize the article.

You may:
- add emotional recognition
- add tension
- lean into doubt
- sound unfinished
- speak directly to the reader
- leave questions hanging

user
ORIGINAL ARTICLE (AUTHORITATIVE)
${articleMarkdown}

TASK
Apply a Human Pass.

OUTPUT:
Return JSON only, with this exact shape:

{
  "humanPass": {
    "overlayParagraphs": [
      "1–3 short paragraphs (2–4 sentences each). These should feel like thoughts that interrupt the article, not replace it."
    ],
    "recognitionLines": [
      "2–4 single-sentence lines that name a feeling fans already have."
    ],
    "tensionLeans": [
      {
        "direction": "teamA | teamB | neither",
        "line": "A slightly opinionated line that leans emotionally, not statistically."
      }
    ],
    "closingBeat": "One unresolved line that lingers after the article ends."
  }
}

STYLE GUIDANCE
- Fragments are encouraged.
- Short sentences are better than polished ones.
- Avoid formal transitions.
- Avoid buzzwords.
- Write like this will be screenshot and shared.
- If it feels slightly uncomfortable, you’re doing it right.
`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-pro',
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          humanPass: {
            type: Type.OBJECT,
            properties: {
              overlayParagraphs: { type: Type.ARRAY, items: { type: Type.STRING } },
              recognitionLines: { type: Type.ARRAY, items: { type: Type.STRING } },
              tensionLeans: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    direction: { type: Type.STRING },
                    line: { type: Type.STRING }
                  },
                  required: ['direction', 'line']
                }
              },
              closingBeat: { type: Type.STRING }
            },
            required: ['overlayParagraphs', 'recognitionLines', 'tensionLeans', 'closingBeat']
          }
        },
        required: ['humanPass']
      }
    }
  });

  // responseMimeType should guarantee JSON; still guard just in case.
  try {
    return JSON.parse(response.text);
  } catch {
    return extractJson<HumanPassOutput>(response.text);
  }
}

function applyHumanPassToMarkdown(
  originalMarkdown: string,
  humanPass: HumanPassOutput['humanPass'],
  teamA: string,
  teamB: string
): { markdown: string; htmlBlocks: { early?: string; mid?: string; closing?: string } } {
  if (!originalMarkdown || !humanPass) {
    return { markdown: originalMarkdown, htmlBlocks: {} };
  }

  const overlayParagraphs = Array.isArray(humanPass.overlayParagraphs) ? humanPass.overlayParagraphs.filter(Boolean).slice(0, 3) : [];
  const recognitionLines = Array.isArray(humanPass.recognitionLines) ? humanPass.recognitionLines.filter(Boolean).slice(0, 4) : [];
  const tensionLeans = Array.isArray(humanPass.tensionLeans) ? humanPass.tensionLeans.slice(0, 3) : [];
  const closingBeat = (humanPass.closingBeat || '').trim();

  const formatDirection = (d: any) => {
    if (d === 'teamA') return teamA;
    if (d === 'teamB') return teamB;
    return null; // Return null instead of 'Neither' to skip these
  };

  const buildHtmlBlock = (title: string, lines: string[]) => {
    const cleanLines = Array.isArray(lines) ? lines.map(l => String(l || '').trim()).filter(Boolean) : [];
    if (cleanLines.length === 0) return '';
    const first = cleanLines[0];
    const rest = cleanLines.slice(1);
    const titleText = escapeHtmlSimple(title);

    // Make the "OUR TAKE" body text small (quote-log scale); label stays bold.
    const firstHtml = `<div style="color:rgba(255,255,255,0.88); font-family:'Courier New', monospace; font-size:0.75rem; line-height:1.55; font-weight:700; word-wrap:break-word; overflow-wrap:break-word;">${escapeHtmlSimple(first)}</div>`;
    const restHtml = rest.length > 0
      ? `<div style="margin-top:0.25rem; display:flex; flex-direction:column; gap:0.2rem;">${rest
          .map(l => `<div style="color:rgba(255,255,255,0.78); font-family:'Courier New', monospace; font-size:0.74rem; line-height:1.45; word-wrap:break-word; overflow-wrap:break-word;">${escapeHtmlSimple(l)}</div>`)
          .join('')}</div>`
      : '';

    // Return clean HTML block (no comment markers - will be injected directly in template)
    return (
      `<div style="margin:0.35rem 0 0.55rem 0; padding:0.55rem 0.75rem; background:linear-gradient(180deg, rgba(255,255,255,0.06), rgba(0,0,0,0.22)); border:1px solid rgba(255,255,255,0.20); border-left:3px solid rgba(255,230,109,0.90); border-radius:10px; box-shadow:0 0 18px rgba(0,0,0,0.5), inset 0 0 18px rgba(255,255,255,0.06);">` +
      `<div style="display:flex; align-items:flex-start; gap:0.5rem; margin-bottom:0.15rem; flex-wrap:nowrap;">` +
      `<div style="width:6px; height:6px; border-radius:50%; background:rgba(255,230,109,0.95); box-shadow:0 0 14px rgba(255,230,109,0.55); flex-shrink:0; margin-top:0.2rem;"></div>` +
      `<span style="color:rgba(255,230,109,0.98); font-weight:900; letter-spacing:0.12em; font-family:'Courier New', monospace; flex-shrink:0; white-space:nowrap; display:inline-block;">${titleText}:</span>` +
      `<div style="flex:1; min-width:0;">${firstHtml}</div>` +
      `</div>` +
      `${restHtml}` +
      `</div>`
    );
  };

  const earlyLines: string[] = [];
  overlayParagraphs.forEach(p => {
    const t = String(p).trim();
    if (t) earlyLines.push(t);
  });
  if (recognitionLines.length > 0) {
    earlyLines.push(...recognitionLines.map(r => `— ${String(r).trim()}`).filter(Boolean));
  }

  const midLines: string[] = [];
  for (const t of tensionLeans) {
    const dir = formatDirection((t as any)?.direction);
    const line = String((t as any)?.line || '').trim();
    if (!line || !dir) continue; // Skip if direction is null (Neither)
    midLines.push(`${dir}: ${line}`);
  }

  // Build HTML blocks but DON'T insert them into markdown
  // Store them separately so template can inject them directly
  const earlyBlock = earlyLines.length > 0 ? buildHtmlBlock('OUR TAKE', earlyLines) : '';
  const midBlock = midLines.length > 0 ? buildHtmlBlock('OUR TAKE', midLines) : '';
  const closingBlock = closingBeat ? buildHtmlBlock('OUR TAKE', [closingBeat]) : '';

  // Return markdown unchanged and HTML blocks separately
  return {
    markdown: String(originalMarkdown),
    htmlBlocks: {
      early: earlyBlock || undefined,
      mid: midBlock || undefined,
      closing: closingBlock || undefined
    }
  };
}

function renderHeatArticleV3Markdown(v3: any, evidence?: EvidenceForV3): string {
  const dd = v3?.deepDive || {};
  const acts = Array.isArray(dd.acts) ? dd.acts : [];
  
  // Build a map of quoteId to speaker for quick lookup
  const quoteSpeakerMap = new Map<string, string>();
  if (evidence?.quotes) {
    for (const q of evidence.quotes) {
      if (q.quoteId && q.speaker) {
        quoteSpeakerMap.set(q.quoteId, q.speaker);
      }
    }
  }
  // Also check quotesUsed in v3 narrative
  if (Array.isArray(dd.quotesUsed)) {
    for (const q of dd.quotesUsed) {
      if (q.quoteId && q.speaker) {
        quoteSpeakerMap.set(q.quoteId, q.speaker);
      }
    }
  }

  const lines: string[] = [];
  if (dd.headline) lines.push(`# ${dd.headline}`);
  if (dd.lede) lines.push('', dd.lede);

  if (v3?.narrativeThesis) {
    lines.push('', '## Thesis', '', v3.narrativeThesis);
  }

  lines.push('', '## Deep Dive');
  for (const act of acts) {
    lines.push('', `### ${act.actTitle || 'ACT'}`, '', act.whatItMeans || '');
    const anchors = Array.isArray(act.anchors) ? act.anchors : [];
    if (anchors.length > 0) {
      for (const a of anchors) {
        if (a?.type === 'quote') {
          const speaker = a.quoteId ? quoteSpeakerMap.get(a.quoteId) : null;
          const quoteText = String(a.text || '').trim();
          // Render QUOTE as HTML directly instead of markdown
          lines.push('', renderQuoteStatAnchor('QUOTE', quoteText, speaker || undefined));
        } else if (a?.type === 'stat') {
          const statText = String(a.text || '').trim();
          // Render STAT as HTML directly instead of markdown
          lines.push('', renderQuoteStatAnchor('STAT', statText));
        }
      }
    }
  }

  if (Array.isArray(dd.pressurePoints) && dd.pressurePoints.length > 0) {
    lines.push('', '## Pressure Points', '', ...dd.pressurePoints.map((p: string) => `- ${p}`));
  }

  if (v3?.matchupMeaning) {
    lines.push('', '## What This Means', '', v3.matchupMeaning);
  }

  return lines.join('\n');
}

// ===================================================================================
// HEAT ARTICLE GENERATOR - COMPREHENSIVE SINGLE CALL (Based on example)
// ===================================================================================

// Parse JSON helper (from example) - Improved to handle edge cases
const parseHeatCheckJSON = (text: string) => {
  try {
    // First, try to find a markdown-style JSON block
    const markdownMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (markdownMatch && markdownMatch[1]) {
      try {
        return JSON.parse(markdownMatch[1].trim());
      } catch (e) {
        console.error("Failed to parse JSON from markdown block, trying fallback:", e);
      }
    }

    // Try to find any JSON object (first { to last })
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    
    if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
      // Try cleaning and parsing the whole thing
      const cleaned = text.replace(/```json/g, '').replace(/```/g, '').replace(/^[^{]*/, '').replace(/[^}]*$/, '').trim();
      if (cleaned) {
        try {
          return JSON.parse(cleaned);
        } catch (e) {
          console.error("Failed to parse cleaned text:", e);
        }
      }
      throw new Error(`No valid JSON object found in response. First brace: ${firstBrace}, Last brace: ${lastBrace}`);
    }

    const jsonString = text.substring(firstBrace, lastBrace + 1);
    try {
    const parsed = JSON.parse(jsonString);
    return parsed;
    } catch (e) {
        // If parsing fails, try to find the actual JSON end more carefully
        // Look for the last complete JSON object by counting braces
        let braceCount = 0;
        let actualEnd = firstBrace;
        for (let i = firstBrace; i < text.length; i++) {
            if (text[i] === '{') braceCount++;
            if (text[i] === '}') {
                braceCount--;
                if (braceCount === 0 && i > firstBrace) {
                    actualEnd = i;
                    break;
                }
            }
        }
        // If we found a complete JSON object, try parsing it
        if (actualEnd > firstBrace) {
            const correctedJsonString = text.substring(firstBrace, actualEnd + 1);
            try {
                return JSON.parse(correctedJsonString);
            } catch (e2) {
                // If still fails, try to extract just the first valid JSON object
                // by finding where the first complete object ends
                let balance = 0;
                let endPos = firstBrace;
                for (let i = firstBrace; i < Math.min(firstBrace + 50000, text.length); i++) {
                    if (text[i] === '{') balance++;
                    if (text[i] === '}') {
                        balance--;
                        if (balance === 0) {
                            endPos = i;
                            break;
                        }
                    }
                }
                if (endPos > firstBrace) {
                    const finalJsonString = text.substring(firstBrace, endPos + 1);
                    return JSON.parse(finalJsonString);
                }
                throw e2;
            }
        }
        throw e;
    }
  } catch (e: any) {
    console.error("Failed to parse JSON", e);
    console.error("Response text (first 1000 chars):", text.substring(0, 1000));
    console.error("Response text (last 500 chars):", text.substring(Math.max(0, text.length - 500)));
    throw new Error(`Invalid response format from AI. The model generated text that could not be parsed. Error: ${e.message || 'Unknown error'}`);
  }
};

// Map league names to sport types
const mapLeagueToSport = (league: string): 'NBA' | 'NFL' | 'Premier League' | 'MLB' | 'NHL' | 'UFC' | 'Other' => {
  const upper = league.toUpperCase();
  if (upper === 'NBA') return 'NBA';
  if (upper === 'NFL') return 'NFL';
  if (upper === 'EPL' || upper.includes('PREMIER')) return 'Premier League';
  return 'Other';
};

// Generate comprehensive heat check narrative (all phases in one call - based on example)
async function generateHeatCheckNarrative(matchup: { league: string; teamA: string; teamB: string }): Promise<any> {
  // Get API key (same way as top-level, in case it's not available globally)
  const localApiKey = import.meta.env.VITE_GEMINI_API_KEY || 
                      import.meta.env.GEMINI_API_KEY || 
                      (typeof process !== 'undefined' && process.env?.API_KEY) || 
                      (typeof process !== 'undefined' && process.env?.GEMINI_API_KEY) || 
                      apiKey || 
                      '';
  
  if (!localApiKey || localApiKey.trim() === '') {
    throw new Error('Gemini API key is missing. Please set VITE_GEMINI_API_KEY in your .env.local file.\n\nGet your API key from: https://aistudio.google.com/app/apikey');
  }
  
  // Create a new AI instance with the validated API key
  const localAi = new GoogleGenAI({ apiKey: localApiKey });
  
  const sport = mapLeagueToSport(matchup.league);
  
  const prompt = `
    You are the HEATCHECK AI, an expert sports systems architect.
    CURRENT DATE: ${new Date().toLocaleDateString()}
    
    GOAL: Build a "Hidden Narrative" engine output for the matchup: ${matchup.teamA} vs ${matchup.teamB} (${sport}).

    WORKFLOW (Simulated):
    
    PHASE 1: ORCHESTRATE
    - Assume no cached data exists. You must fetch fresh data.
    
    PHASE 2: ODDS & FACTS (Simulate via Search)
    - Use Google Search to find current betting lines (Moneyline, Spread) and implied totals.
    - Check injuries and recent form.
    - **CRITICAL STATUS CHECK**: You MUST search for the current employment/active status of the Head Coaches and Top 2 Star Players for both teams.
      - Query: "[Coach Name] current team status [Current Month Year]"
      - Query: "[Star Player] injury report [Current Month Year]"
    
    PHASE 3: EVIDENCE MINING
    - Search for specific quotes, "beef", tweets, or press conference soundbites from the last 3 years.
    - Reliability Tiering (A/B/C) is mandatory.
    
    PHASE 4: NARRATIVE GENERATION
    - Generate 3-5 "Narrative Cards" (Candidates).
    - Score them 0-5.
    
    PHASE 5: THE AUDITOR (FACTUAL INTEGRITY LAYER) - *** MOST IMPORTANT STEP ***
    - Before generating the final article, review your selected narrative key figures.
    - **MANDATORY CHECKS FOR EACH KEY CHARACTER:**
      1. Verify they are CURRENTLY on the roster (as of ${new Date().toLocaleDateString()})
      2. Check injury status - do NOT include players who are out with season-ending injuries or on IL/IR
      3. Verify they haven't been traded/released/fired since the narrative was created
      4. If a coach was mentioned, verify they are still the head coach
      5. Use Google Search to verify: "[Name] ${matchup.teamA} roster ${new Date().getFullYear()}" OR "[Name] ${matchup.teamB} roster ${new Date().getFullYear()}"
      6. Use Google Search to check injuries: "[Name] injury status ${new Date().toLocaleDateString()}"
    
    - **RULE:** If a Narrative Card relies on a person (e.g., "Nuno's Revenge") and Phase 2 revealed they are:
      * NO LONGER with the team (fired/traded): MODIFY the narrative or discard it
      * INJURED and won't play: Either remove them from key_characters OR pivot the narrative to discuss their absence
      * NOT on current roster: REMOVE them from key_characters immediately
      * SEASON-ENDING INJURY: Remove them from key_characters or pivot narrative
    
    - Do NOT write an article assuming:
      - A fired coach is still on the sidelines
      - An injured player will be playing (unless minor injury with expected return)
      - A traded player is still on the team
      - A player on IL/IR will be available
    
    - Before listing someone in key_characters, you MUST verify their current status via Google Search
    - If you cannot verify with high confidence, DO NOT include them in key_characters
    - Log all verification checks and pivots in the "corrections_applied" field.
    
    PHASE 6: OUTPUT
    - Generate the Article in Markdown that tells the narrative story behind the matchup.
    - **CRITICAL ARTICLE GUIDELINES:**
      * **DO NOT MAKE PREDICTIONS OR PICK WINNERS** - Save predictions for the separate "HeatChecks Edge" component
      * **FOCUS ON GAME LINES ANALYSIS** - Instead of predictions, discuss important betting lines:
        - Moneyline odds: Who is favored and why? What do the odds suggest about public perception?
        - Point spread: If applicable, discuss the spread and what factors influenced its setting
        - Over/Under totals: Analyze the total line and factors that could push it over or under
        - Key prop bets or interesting lines: Highlight noteworthy betting markets
      * **ANALYSIS, NOT PREDICTION** - Explain what the lines mean, why they're set where they are, and what factors (injuries, recent form, historical matchups) might influence them
      * **CONTEXT AND STORY** - Use the narrative, facts, evidence, and odds to build the story - but stop short of saying "Team X will win" or "Take the under"
    - The article should provide intelligent context and analysis of the betting landscape WITHOUT making betting recommendations
    - All predictions and betting recommendations belong exclusively in the "HeatChecks Edge" component
    - Return the EXACT JSON SCHEMA below.
    
    REQUIRED JSON SCHEMA:
    {
      "run_meta": { "timestamp_utc": "string", "notes": "string" },
      "matchups": [
        {
          "match_id": "string",
          "league": "${sport}",
          "teams": { "home": "${matchup.teamA}", "away": "${matchup.teamB}" },
          "fact_pack": {
            "odds": {
              "source": "string",
              "last_updated_utc": "string",
              "markets": [ { "market": "Moneyline|Spread|Total", "outcomes": ["string"], "price": number, "point": number, "book": "string" } ],
              "movement_summary": ["string"]
            },
            "context": {
              "recent_form": { "home": "string", "away": "string" },
              "injuries": [ { "name": "string", "team": "string", "status": "string" } ]
            },
            "key_stats": [
              { "label": "string", "value": "string", "why_it_matters": "string" }
            ]
          },
          "evidence_bundle": {
            "sources": [
              { "source_id": "SRC_1", "title": "string", "publisher": "string", "url": "string", "published_utc": "string", "reliability_tier": "A" }
            ],
            "quotes": [
              { "quote_id": "Q_1", "speaker": "string", "team": "string", "quote": "string", "context": "string", "date_utc": "string", "source_id": "SRC_1" }
            ],
            "timeline_events": [
              { "event_id": "E_1", "event_type": "trade|rivalry|other", "date_utc": "string", "summary": "string", "source_id": "SRC_1" }
            ]
          },
          "narratives": {
            "candidate_cards": [
              {
                "narrative_id": "N_1",
                "title": "string",
                "claim": "string",
                "emotion_tags": ["string"],
                "key_characters": ["string"],
                "evidence_requirements_met": true,
                "score_breakdown": {
                  "factual_support": 0,
                  "recency": 0,
                  "stakes": 0,
                  "performance_alignment": 0,
                  "uniqueness": 0,
                  "audience_resonance": 0,
                  "volatility_optional": 0
                },
                "total_score": 0,
                "risk_notes": ["string"],
                "must_cite_source_ids": ["SRC_1"]
              }
            ],
            "selected": {
              "primary_narrative_id": "N_1",
              "secondary_narrative_ids": ["N_2"]
            },
            "fallback_lane_used": "none"
          },
          "article": {
            "seo": {
              "primary_keyword": "string",
              "title_options": ["string"],
              "meta_description": "string"
            },
            "long_form_markdown": "string"
          },
          "quality_report": {
            "missing_data_warnings": ["string"],
            "hallucination_checks_passed": true,
            "corrections_applied": ["string (e.g. 'Detected Nuno Espirito Santo is fired, pivoted narrative to legacy impact')"]
          }
        }
      ]
    }
  `;

  console.log(`[generateHeatCheckNarrative] Starting for ${matchup.teamA} vs ${matchup.teamB}`);
  console.log(`[generateHeatCheckNarrative] API Key available:`, !!localApiKey);
  console.log(`[generateHeatCheckNarrative] API Key length:`, localApiKey ? localApiKey.length : 0);
  console.log(`[generateHeatCheckNarrative] API Key preview:`, localApiKey ? `${localApiKey.substring(0, 10)}...${localApiKey.substring(localApiKey.length - 4)}` : 'N/A');
  
  try {
    console.log(`[generateHeatCheckNarrative] Making API call to Gemini...`);
    const response = await localAi.models.generateContent({
      model: 'gemini-2.5-pro',
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
      }
    });

    const text = response.text;
    if (!text) throw new Error("No response from AI");

    console.log(`[generateHeatCheckNarrative] Response received, length:`, text.length);
    console.log(`[generateHeatCheckNarrative] Response preview (first 200 chars):`, text.substring(0, 200));
    
    const result = parseHeatCheckJSON(text);
    console.log(`[generateHeatCheckNarrative] Parsed successfully`);
    
    if (!result.matchups || result.matchups.length === 0) {
      throw new Error("No matchups in response");
    }
    
    return result.matchups[0]; // Return the first (and only) matchup

  } catch (error: any) {
    console.error("[generateHeatCheckNarrative] Error:", error);
    console.error("[generateHeatCheckNarrative] Error details:", {
      message: error.message,
      stack: error.stack,
      responseText: error.response?.text || 'N/A',
      errorName: error.name,
      errorType: error.constructor?.name || typeof error
    });
    
    // Provide more specific error messages
    let errorMessage = error.message || 'Unknown error';
    
    if (errorMessage.includes('Failed to fetch') || errorMessage.includes('network') || errorMessage.includes('NetworkError')) {
      errorMessage = `Network error: Unable to connect to Gemini API. This could be due to:
1. No internet connection
2. CORS issues (check browser console)
3. API key is invalid or expired
4. Gemini API is temporarily unavailable

Please check your VITE_GEMINI_API_KEY in .env.local and ensure your internet connection is working.`;
    } else if (errorMessage.includes('API key') || errorMessage.includes('authentication') || errorMessage.includes('401') || errorMessage.includes('403')) {
      errorMessage = `API authentication error: ${errorMessage}

Please verify your VITE_GEMINI_API_KEY is correct in your .env.local file.
Get your API key from: https://aistudio.google.com/app/apikey`;
    } else if (errorMessage.includes('quota') || errorMessage.includes('rate limit')) {
      errorMessage = `API quota/rate limit error: ${errorMessage}

You may have exceeded your Gemini API quota. Please check your usage at https://aistudio.google.com/app/apikey`;
    }
    
    throw new Error(`Failed to generate heat check narrative: ${errorMessage}`);
  }
}

// ===================================================================================
// ENHANCED HEAT CHECK NARRATIVE GENERATOR V2 (with Emotional Spine™)
// ===================================================================================

async function generateHeatCheckNarrativeV2(matchup: { league: string; teamA: string; teamB: string }, retries = 3): Promise<any> {
  const localApiKey = import.meta.env.VITE_GEMINI_API_KEY || 
                      import.meta.env.GEMINI_API_KEY || 
                      (typeof process !== 'undefined' && process.env?.API_KEY) || 
                      (typeof process !== 'undefined' && process.env?.GEMINI_API_KEY) || 
                      apiKey || 
                      '';
  
  if (!localApiKey || localApiKey.trim() === '') {
    throw new Error('Gemini API key is missing. Please set VITE_GEMINI_API_KEY in your .env.local file.\n\nGet your API key from: https://aistudio.google.com/app/apikey');
  }
  
  const localAi = new GoogleGenAI({ apiKey: localApiKey });
  const sport = mapLeagueToSport(matchup.league);
  
  const prompt = `
You are HeatChecks, an elite sports narrative intelligence system.
Your task is to uncover the emotional truth of the matchup and transform it into a compelling HeatChecks article.

CURRENT DATE: ${new Date().toLocaleDateString()}
MATCHUP: ${matchup.teamA} vs ${matchup.teamB} (${sport})

🧬 SYSTEM DIRECTIVE

Your output must be:
- Emotionally charged
- Evidence-backed
- Factually accurate
- Structured for betting insight
- Written for fans, DFS players, and bettors

🧱 MANDATORY EXECUTION PHASES

PHASE 1 — ORCHESTRATE (Fresh Data)
Use live data via Google Search:
- Current rosters, injuries, lineups
- Recent results and form (last 5-10 games)
- Betting odds & movement (opening vs current)
- Recent quotes & press conferences (last 2 weeks)
- Contract situations, trade rumors, role changes
- Coaching context and recent decisions

PHASE 2 — ODDS & FACTS
Build factPack with:
- Opening & current betting lines (Moneyline, Spread, Total)
- Injury report (status + impact on game)
- Recent performance (last 5-10 games for each team)
- Key advanced stats (efficiency, pace, etc.)
- Coaching context (recent decisions, pressure situations)
- Line movement summary (if significant shifts occurred)

PHASE 3 — EVIDENCE MINING
Build evidenceBundle with:
- Quotes from players/coaches/media (last 3 years, prioritize recent)
- Timeline of key events (last 3 seasons)
- Sources required for every claim (reliability tiering: A/B/C)
- Press conference soundbites
- Social media context (if relevant)
- Transaction history (trades, signings, releases)

PHASE 4 — NARRATIVE CANDIDATES
Generate 3-5 narrative cards, each with:

{
  "narrative_id": "N_1",
  "title": "Short, punchy title (3-5 words)",
  "claim": "One sentence claim explaining the narrative",
  "key_characters": ["Player/Coach names involved"],
  "heat_score": {
    "emotion": 0-5,           // Emotional intensity (revenge, pressure, etc.)
    "conflict": 0-5,          // Level of conflict/tension
    "stakes": 0-5,            // What's at stake (playoffs, legacy, etc.)
    "evidence": 0-5,          // Quality and quantity of evidence
    "audience_relevance": 0-5  // Relevance to DFS/betting/fan audience
  },
  "total": 0-25              // Sum of heat_score dimensions
}

Select the narrative with the highest total score as primary.

PHASE 4.5 — EMOTIONAL MAP (NEW CORE LAYER)
For the TOP narrative only, create an emotional blueprint:

"emotional_map": {
  "primary_emotion": "revenge | pressure | redemption | collapse | survival | arrival",
  "secondary_emotion": "fear | pride | urgency | doubt | confidence",
  "audience_identity": "DFS grinder | bettor | fan | rival fan | casual",
  "emotional_question": "What happens if ___ fails today?",
  "one_sentence_hook": "The opening 1-2 lines that capture the emotional core"
}

This map becomes the emotional blueprint for the entire article.

PHASE 5 — THE AUDITOR (FACTUAL INTEGRITY)
Verify all key characters from the selected narrative:
- On current roster? (as of ${new Date().toLocaleDateString()})
- Active and healthy?
- Injury status? (exclude season-ending injuries, IL/IR)
- No trades, firings, or releases?
- Use Google Search to verify: "[Name] ${matchup.teamA} roster ${new Date().getFullYear()}"
- Use Google Search to check injuries: "[Name] injury status ${new Date().toLocaleDateString()}"

If any key character is invalid:
- Remove them from key_characters OR
- Pivot the narrative to discuss their absence
- Log all corrections in quality_report.corrections_applied

PHASE 6 — HEATCHECKS ARTICLE OUTPUT
Generate article.long_form_markdown using the HeatChecks Emotional Spine™ in this EXACT order:

1. **Hook** (1-2 emotionally explosive lines)
   - Use the one_sentence_hook from emotional_map
   - Must create immediate emotional tension
   - No setup, no context—just raw emotion

2. **Ignition** — Why this matchup matters right now
   - What makes THIS game different?
   - What's happening TODAY that amplifies the narrative?
   - Connect to current context (standings, recent events, etc.)

3. **Tension Build** — Pressure, conflict, stakes
   - What's at stake for each side?
   - What happens if they win? If they lose?
   - Build the emotional pressure

4. **Receipts** — Evidence & timeline
   - Key quotes that prove the tension
   - Timeline of events that led here
   - Stats that support the narrative
   - Format as bullet points or short paragraphs

5. **Human Moment** — One emotional focal point
   - Focus on ONE key character or moment
   - Make it personal and relatable
   - This is where the reader connects emotionally

6. **Edge Transition** — Set up betting analysis (NO PICKS)
   - Discuss betting lines and what they mean
   - Analyze moneyline, spread, totals
   - Explain what factors influence the lines
   - DO NOT make predictions or recommendations
   - Transition to: "The HeatChecks Edge analysis below..."

CRITICAL ARTICLE RULES:
- DO NOT make predictions or pick winners
- Focus on betting line ANALYSIS, not recommendations
- All predictions belong in HeatChecks Edge component
- Use the emotional_map to guide the emotional flow
- Every section must serve the emotional narrative

PHASE 7 — EMOTIONAL INTEGRITY CHECK
Review the article and confirm:
- ✅ The hook reflects the emotional_map.primary_emotion
- ✅ The emotional_question is clearly explored in the article
- ✅ The human moment exists and is emotionally resonant
- ✅ The article resolves emotional tension (even if outcome is uncertain)

If ANY condition fails:
- Revise the article to meet all conditions
- Log revisions in quality_report.corrections_applied

PHASE 8 — OUTPUT FORMAT
Return ONLY valid JSON matching this schema:

{
  "factPack": {
    "odds": {
      "source": "string",
      "last_updated_utc": "string",
      "opening_markets": [
        { "market": "Moneyline|Spread|Total", "outcomes": ["string"], "price": number, "point": number, "book": "string" }
      ],
      "current_markets": [
        { "market": "Moneyline|Spread|Total", "outcomes": ["string"], "price": number, "point": number, "book": "string" }
      ],
      "movement_summary": ["string"]
    },
    "context": {
      "recent_form": { "home": "string (last 5-10 games)", "away": "string (last 5-10 games)" },
      "injuries": [
        { "name": "string", "team": "string", "status": "string", "impact": "string" }
      ],
      "coaching_context": "string"
    },
    "key_stats": [
      { "label": "string", "value": "string", "why_it_matters": "string" }
    ]
  },
  "evidenceBundle": {
    "sources": [
      { "source_id": "SRC_1", "title": "string", "publisher": "string", "url": "string", "published_utc": "string", "reliability_tier": "A|B|C" }
    ],
    "quotes": [
      { "quote_id": "Q_1", "speaker": "string", "team": "string", "quote": "string", "context": "string", "date_utc": "string", "source_id": "SRC_1" }
    ],
    "timeline_events": [
      { "event_id": "E_1", "event_type": "trade|rivalry|injury|coaching|other", "date_utc": "string", "summary": "string", "source_id": "SRC_1" }
    ]
  },
  "candidateCards": [
    {
      "narrative_id": "N_1",
      "title": "string",
      "claim": "string",
      "key_characters": ["string"],
      "heat_score": {
        "emotion": 0-5,
        "conflict": 0-5,
        "stakes": 0-5,
        "evidence": 0-5,
        "audience_relevance": 0-5
      },
      "total": 0-25
    }
  ],
  "selectedNarrative": {
    "primary_narrative_id": "N_1",
    "secondary_narrative_ids": ["N_2"]
  },
  "emotional_map": {
    "primary_emotion": "revenge | pressure | redemption | collapse | survival | arrival",
    "secondary_emotion": "fear | pride | urgency | doubt | confidence",
    "audience_identity": "DFS grinder | bettor | fan | rival fan | casual",
    "emotional_question": "What happens if ___ fails today?",
    "one_sentence_hook": "string"
  },
  "qualityReport": {
    "missing_data_warnings": ["string"],
    "hallucination_checks_passed": true,
    "corrections_applied": ["string"]
  },
  "article": {
    "long_form_markdown": "string (must follow HeatChecks Emotional Spine™ structure)",
    "seo": {
      "primary_keyword": "string",
      "title_options": ["string"],
      "meta_description": "string"
    }
  }
}

CRITICAL: Return ONLY the JSON object. No markdown, no explanations, no code blocks.
`;

  console.log(`[generateHeatCheckNarrativeV2] Starting enhanced generation for ${matchup.teamA} vs ${matchup.teamB}`);
  
  try {
    const response = await localAi.models.generateContent({
      model: 'gemini-2.5-pro',
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
      }
    });

    const text = response.text;
    if (!text) throw new Error("No response from AI");

    // Clean response (remove markdown code blocks if present)
    let cleanedText = text.trim();
    const codeBlockMatch = cleanedText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch) {
      cleanedText = codeBlockMatch[1].trim();
    }

    const result = parseHeatCheckJSON(cleanedText);
    
    if (!result.candidateCards || result.candidateCards.length === 0) {
      throw new Error("No candidate cards in response");
    }
    
    if (!result.emotional_map) {
      throw new Error("Missing emotional_map in response");
    }
    
    if (!result.article?.long_form_markdown) {
      throw new Error("Missing article markdown in response");
    }

    // Transform to match existing structure for compatibility
    return {
      fact_pack: result.factPack,
      evidence_bundle: result.evidenceBundle,
      narratives: {
        candidate_cards: result.candidateCards.map((card: any) => ({
          narrative_id: card.narrative_id,
          title: card.title,
          claim: card.claim,
          key_characters: card.key_characters,
          emotion_tags: [result.emotional_map.primary_emotion, result.emotional_map.secondary_emotion],
          score_breakdown: {
            factual_support: card.heat_score.evidence,
            recency: 5, // Assume recent if selected
            stakes: card.heat_score.stakes,
            performance_alignment: card.heat_score.emotion,
            uniqueness: card.heat_score.conflict,
            audience_resonance: card.heat_score.audience_relevance,
            volatility_optional: 0
          },
          total_score: card.total,
          evidence_requirements_met: card.heat_score.evidence >= 3,
          risk_notes: [],
          must_cite_source_ids: []
        })),
        selected: {
          primary_narrative_id: result.selectedNarrative.primary_narrative_id,
          secondary_narrative_ids: result.selectedNarrative.secondary_narrative_ids || []
        }
      },
      emotional_map: result.emotional_map, // NEW: Add emotional map
      quality_report: result.qualityReport,
      article: {
        long_form_markdown: result.article.long_form_markdown,
        seo: {
          primary_keyword: result.article.seo?.primary_keyword || '',
          title_options: result.article.seo?.title_options || [],
          meta_description: result.article.seo?.meta_description || ''
        }
      }
    };

  } catch (error: any) {
    console.error("[generateHeatCheckNarrativeV2] Error:", error);
    
    // Retry logic for rate limiting or network errors
    const errorMessage = error.message || error.toString() || '';
    const isRetryableError = 
      errorMessage.includes('rate limit') || 
      errorMessage.includes('quota') ||
      errorMessage.includes('fetch') || 
      errorMessage.includes('network') ||
      errorMessage.includes('timeout') ||
      errorMessage.includes('Failed to fetch') ||
      error instanceof TypeError;
    
    if (retries > 0 && isRetryableError) {
      const delayMs = (4 - retries) * 2000; // Exponential backoff: 2s, 4s, 6s
      console.log(`[generateHeatCheckNarrativeV2] Retrying in ${delayMs}ms (${retries} retries left)... Error: ${errorMessage}`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      return generateHeatCheckNarrativeV2(matchup, retries - 1);
    }
    
    throw new Error(`Failed to generate V2 heat check narrative: exception ${errorMessage}`);
  }
}

const getWebsiteReadyPrompt = (narrative: Narrative) => `
You are an elite sports analyst operating in the "Heatchecks War Room." Your voice is edgy and controversial. Transform this initial angle into a full story using the "WAR ROOM STORY FORMAT."
**Initial Angle:** For the ${narrative.league} game (${narrative.teamA} vs. ${narrative.teamB}), the core narrative is: "${narrative.narrative}".
Generate a comprehensive JSON object with keys "websiteStory" and "heatchecksEdge".
---
**🔥 HEATCHECKS: WAR ROOM STORY FORMAT & STYLE GUIDE**
---
**⚔️ THE SETUP**
- **Headline**: Make it short, aggressive, and emotionally loaded. Think newspaper headlines. Max 5-7 words. Examples: "He Owns Them.", "The Betrayal.", "Payback's A Bill.", "The Master vs. The Apprentice."
- **The Stakes (dek)**: 1-2 sentences explaining why this situation could blow the game up.
**🧬 THE HISTORY**
- **The File (theBackstory)**: Hard facts only. Dates, names, receipts. Weave in stats. Write it like an intelligence briefing.
- **The Receipts (theReceipts)**: Find direct quotes that prove the tension. Include source URL.
**📊 THE DATA**
- Isolate the most powerful, needle-moving statistics into this dedicated section.
**🧠 THE PRESSURE**
- **Pressure Points (pressurePoints)**: Identify where the tension will spike in-game.
- **What To Watch (whatToWatch)**: Explain how the drama will manifest in gameplay.
- **The Edge (edgeAngle)**: Your core thesis. Make a bold claim.
**🧷 INTEL**
- **Tags (tags)**: Use sharp, evocative, lowercase tags.
- **Sources (sources)**: Find and list verified media and reporting.
- **SEO Hook (seo)**: Create a highly-optimized SEO package (slug, metaTitle, metaDescription).
---
**💥 THE HEATCHECKS EDGE (Betting Analysis)**
---
Be clinical and decisive.
- **Target (subjectName)**: Name the player or team.
- **The Lines (lines)**: List what the market is offering. Find source URLs.
- **Lean (lean)**: State your position: FAVOR / FADE / NO EDGE.
- **Confidence (confidence)**: Low / Medium / High.
- **Why (rationaleBullets)**: Bullet points explaining the bet.
- **Risk (riskCounterpoints)**: The counter-argument.
- **The Comp (historicalAnalog)**: Find a historical mirror moment.
- **Final Call (finalCall)**: One clean verdict. No hedging.
**CRITICAL CONSTRAINTS:**
- **Voice**: Aggressive, insightful, and confident.
- **Data**: All claims must be backed by Google Search results with source URLs. If no reliable lines are found, return 'lines: []' and 'lean: "NO_EDGE"'. DO NOT INVENT DATA.
- **Output**: Ensure the final output is a perfectly valid JSON object that matches the required schema. Do not include any other text, markdown, or commentary in your response.
`;

const getWebsiteReadySchema = () => ({ type: Type.OBJECT, properties: { websiteStory: { type: Type.OBJECT, required: ["formatStyle", "headline", "dek", "whyItMatters", "theBackstory", "theData", "keyMomentsTimeline", "theReceipts", "pressurePoints", "whatToWatch", "edgeAngle", "tags", "sources", "seo"], properties: { formatStyle: { type: Type.STRING, enum: ["QUOTE_LEDE", "TIMELINE", "UNSPOKEN", "TRAP_GAME"] }, headline: { type: Type.STRING }, dek: { type: Type.STRING }, whyItMatters: { type: Type.ARRAY, items: { type: Type.STRING } }, theBackstory: { type: Type.STRING }, theData: { type: Type.ARRAY, items: { type: Type.STRING } }, keyMomentsTimeline: { type: Type.ARRAY, items: { type: Type.OBJECT, required: ["date", "event"], properties: { date: { type: Type.STRING }, event: { type: Type.STRING } } } }, theReceipts: { type: Type.ARRAY, items: { type: Type.OBJECT, required: ["quote"], properties: { quote: { type: Type.STRING }, speaker: { type: Type.STRING }, context: { type: Type.STRING }, sourceUrl: { type: Type.STRING } } } }, pressurePoints: { type: Type.ARRAY, items: { type: Type.STRING } }, whatToWatch: { type: Type.ARRAY, items: { type: Type.STRING } }, edgeAngle: { type: Type.STRING }, tags: { type: Type.ARRAY, items: { type: Type.STRING } }, sources: { type: Type.ARRAY, items: { type: Type.OBJECT, required: ["title", "url"], properties: { title: { type: Type.STRING }, url: { type: Type.STRING }, publisher: { type: Type.STRING }, publishedAt: { type: Type.STRING } } } }, seo: { type: Type.OBJECT, required: ["slug", "metaTitle", "metaDescription"], properties: { slug: { type: Type.STRING }, metaTitle: { type: Type.STRING }, metaDescription: { type: Type.STRING } } } } }, heatchecksEdge: { type: Type.OBJECT, required: ["subjectType", "subjectName", "game", "marketSnapshot", "lines", "lean", "confidence", "rationaleBullets", "riskCounterpoints", "historicalAnalog", "finalCall"], properties: { subjectType: { type: Type.STRING, enum: ["player", "team"] }, subjectName: { type: Type.STRING }, game: { type: Type.STRING }, marketSnapshot: { type: Type.OBJECT, required: ["retrievedAt", "books"], properties: { retrievedAt: { type: Type.STRING }, books: { type: Type.ARRAY, items: { type: Type.OBJECT, required: ["book"], properties: { book: { type: Type.STRING }, url: { type: Type.STRING } } } } } }, lines: { type: Type.ARRAY, items: { type: Type.OBJECT, required: ["marketType", "label", "line", "book", "sourceUrl"], properties: { marketType: { type: Type.STRING }, label: { type: Type.STRING }, line: { type: Type.STRING }, price: { type: Type.STRING }, book: { type: Type.STRING }, sourceUrl: { type: Type.STRING } } } }, lean: { type: Type.STRING, enum: ["FAVOR", "FADE", "NO_EDGE"] }, confidence: { type: Type.STRING, enum: ["low", "medium", "high"] }, rationaleBullets: { type: Type.ARRAY, items: { type: Type.STRING } }, riskCounterpoints: { type: Type.ARRAY, items: { type: Type.STRING } }, historicalAnalog: { type: Type.OBJECT, required: ["claim"], properties: { claim: { type: Type.STRING }, sourceUrl: { type: Type.STRING } } }, finalCall: { type: Type.STRING } } } }, required: ["websiteStory", "heatchecksEdge"]});

// ===================================================================================
// ROOT APP COMPONENT
// ===================================================================================

const App: React.FC = () => {
  type Tab = 'scanner' | 'feed' | 'preview';
  const [activeTab, setActiveTab] = useState<Tab>('scanner');
  const [editingPost, setEditingPost] = useState<HeatcheckPost | null>(null);
  const [refreshFeed, setRefreshFeed] = useState(false);

  const handleSave = () => {
    setRefreshFeed(f => !f);
  };

  return (
    <div className="container" style={activeTab === 'preview' ? { position: 'relative' } : {}}>
      {activeTab !== 'preview' && (
        <>
          <header className="header">
            <h1>Heat Checks Narrative Engine</h1>
            <p>This is your content creation and management dashboard.</p>
          </header>
          
          <nav className="tab-nav">
              <button className={`tab-button ${activeTab === 'scanner' ? 'active' : ''}`} onClick={() => setActiveTab('scanner')}>Scanner Console</button>
              <button className={`tab-button ${activeTab === 'feed' ? 'active' : ''}`} onClick={() => setActiveTab('feed')}>Content Feed</button>
              <button className={`tab-button ${activeTab === 'preview' ? 'active' : ''}`} onClick={() => setActiveTab('preview')}>Website Preview</button>
          </nav>
        </>
      )}

      <main style={activeTab === 'preview' ? { position: 'relative', width: '100vw', height: '100vh', margin: 0, padding: 0 } : {}}>
        {activeTab === 'scanner' && <ScannerConsole setEditingPost={setEditingPost} />}
        {activeTab === 'feed' && <HeatchecksFeed refreshKey={refreshFeed} setEditingPost={setEditingPost} />}
        {activeTab === 'preview' && <PublicHomePage onExit={() => setActiveTab('scanner')} />}
      </main>

      <EditorModal post={editingPost} onClose={() => setEditingPost(null)} onSave={handleSave} />
    </div>
  );
};

const container = document.getElementById('root');
const root = createRoot(container!);
root.render(<App />);