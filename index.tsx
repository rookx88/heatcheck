import React, { useState, useCallback, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Type } from '@google/genai';
import { apiClient } from './apiClient';
import { PublicHomePage } from './pages/index';
import { parseExcelFile } from './scripts/utils/excelParser';
import { analyzeDFSSlate } from './scripts/services/dfsAnalysisService';
import { generateDFSContent } from './scripts/services/dfsTweetService';
import { generateHeatArticleContent } from './scripts/services/heatArticleContentService';

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
    heatchecksEdge: HeatchecksEdge;
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
            model: "gemini-2.5-pro", contents: tweetPrompt,
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

  const handleGenerateArticle = async () => {
    // Load available matchups and show selection modal
    try {
      setError(null);
      const matchups = await apiClient.getMatchups();
      setAvailableMatchups(matchups);
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

  const handleToggleMatchup = (matchupId: string) => {
    setSelectedMatchupIds(prev => 
      prev.includes(matchupId) 
        ? prev.filter(id => id !== matchupId)
        : [...prev, matchupId]
    );
  };

  const handleEditMatchup = (matchup: typeof availableMatchups[0]) => {
    setEditingMatchupId(matchup.id);
    setEditDate(matchup.scheduledDate);
    setEditTime(matchup.scheduledTime || '');
    setError(null);
  };

  const handleSaveMatchup = async (matchupId: string) => {
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
    // League filter
    if (matchupFilterLeague.length > 0 && !matchupFilterLeague.includes(matchup.league.toUpperCase())) {
      return false;
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
          
          if (rosterWarnings.length > 0) {
            console.log(`[${matchupLabel}] [${i + 1}/${selectedMatchups.length}] ${rosterWarnings.length} roster validation warning(s) found - Applying AI Editor corrections...`);
            setGenerationProgress(prev => prev ? { ...prev, step: `AI Editor: Correcting ${matchupLabel} (replacing ${rosterWarnings.length} invalid reference(s)...` } : null);
            
            try {
              const correctionResult = await correctArticleWithAI(
                article.long_form_markdown,
                rosterWarnings,
                matchup.teamA,
                matchup.teamB,
                matchup.league
              );
              
              correctedArticleMarkdown = correctionResult.correctedMarkdown;
              aiCorrections.corrections_applied = correctionResult.correctionsSummary;
              
              // Update validation warnings to mark roster issues as fixed
              validationWarnings = validationWarnings.map(w => {
                if (w.startsWith('⚠️') && rosterWarnings.includes(w)) {
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
          
          if (rosterWarnings.length > 0) {
            console.log(`[${matchupLabel}] [${i + 1}/${selectedMatchups.length}] ${rosterWarnings.length} roster validation warning(s) found - Applying AI Editor corrections...`);
            setGenerationProgress(prev => prev ? { ...prev, step: `AI Editor: Correcting ${matchupLabel} (replacing ${rosterWarnings.length} invalid reference(s)...` } : null);
            
            try {
              const correctionResult = await correctArticleWithAI(
                article.long_form_markdown,
                rosterWarnings,
                matchup.teamA,
                matchup.teamB,
                matchup.league
              );
              
              correctedArticleMarkdown = correctionResult.correctedMarkdown;
              aiCorrections.corrections_applied = correctionResult.correctionsSummary;
              
              // Update validation warnings to mark roster issues as fixed
              validationWarnings = validationWarnings.map(w => {
                if (w.startsWith('⚠️') && rosterWarnings.includes(w)) {
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
            <button className="scan-button" onClick={handleGenerateArticle} disabled={isLoading || isGeneratingHeatArticle || isGeneratingHeatArticleV2}>
                {isGeneratingHeatArticle ? 'Generating...' : 'Heat Article Generator'}
            </button>
            <button className="scan-button" onClick={handleGenerateArticleV2} disabled={isLoading || isGeneratingHeatArticle || isGeneratingHeatArticleV2}>
                {isGeneratingHeatArticleV2 ? 'Generating...' : 'Heat Article v2'}
            </button>
            <button className="scan-button" onClick={() => setShowDFSModal(true)} disabled={isLoading || isGeneratingDFSArticle}>
                DFS Article Generator
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
                            {['NBA', 'NFL', 'EPL'].map(league => (
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

                    <div style={{ display: 'flex', gap: '1rem', justifyContent: 'flex-end' }}>
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
                        <button 
                            className="action-button" 
                            onClick={handleProcessImport} 
                            disabled={isLoading || !importStartDate || !importEndDate || selectedLeagues.length === 0}
                        >
                            {isLoading ? 'Importing...' : 'Import Matchups'}
                        </button>
                    </div>
                </div>
            </div>
        )}

        {/* Matchup Selection Modal for Heat Article Generator */}
        {showMatchupModal && (
            <div className="modal-overlay" onClick={() => { if (!isGeneratingHeatArticle) setShowMatchupModal(false); }}>
                <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '900px', maxHeight: '90vh', overflowY: 'auto' }}>
                    <h3>Select Matchups for Heat Article Generation</h3>
                    <p style={{ marginBottom: '1rem', color: '#666' }}>
                        Select one or more matchups to generate heat articles. Each matchup will be processed sequentially.
                    </p>

                    {/* Filter Section */}
                    {availableMatchups.length > 0 && (
                        <div style={{ marginBottom: '1.5rem', padding: '1rem', background: '#f9f9f9', borderRadius: '4px', border: '1px solid #e0e0e0' }}>
                            <div style={{ fontWeight: 'bold', marginBottom: '0.75rem', fontSize: '0.95rem' }}>Filters</div>
                            
                            {/* League Filter */}
                            <div style={{ marginBottom: '0.75rem' }}>
                                <div style={{ fontSize: '0.85rem', color: '#666', marginBottom: '0.5rem', fontWeight: '500' }}>League:</div>
                                <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
                                    {['NBA', 'NFL', 'EPL', 'MLB', 'NHL'].map(league => (
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
                                                disabled={isGeneratingHeatArticle}
                                                style={{ width: '16px', height: '16px', cursor: isGeneratingHeatArticle ? 'not-allowed' : 'pointer' }}
                                            />
                                            <span>{league}</span>
                                        </label>
                                    ))}
                                    {matchupFilterLeague.length > 0 && (
                                        <button
                                            onClick={() => setMatchupFilterLeague([])}
                                            disabled={isGeneratingHeatArticle}
                                            style={{
                                                padding: '0.25rem 0.5rem',
                                                background: 'transparent',
                                                color: '#666',
                                                border: '1px solid #ccc',
                                                borderRadius: '4px',
                                                cursor: isGeneratingHeatArticle ? 'not-allowed' : 'pointer',
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
                                    disabled={isGeneratingHeatArticle}
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
                                            disabled={isGeneratingHeatArticle}
                                            style={{ cursor: isGeneratingHeatArticle ? 'not-allowed' : 'pointer' }}
                                        />
                                        <span>All</span>
                                    </label>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer', fontSize: '0.85rem' }}>
                                        <input
                                            type="radio"
                                            name="dateFilter"
                                            checked={matchupFilterDate === 'today'}
                                            onChange={() => setMatchupFilterDate('today')}
                                            disabled={isGeneratingHeatArticle}
                                            style={{ cursor: isGeneratingHeatArticle ? 'not-allowed' : 'pointer' }}
                                        />
                                        <span>Today</span>
                                    </label>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer', fontSize: '0.85rem' }}>
                                        <input
                                            type="radio"
                                            name="dateFilter"
                                            checked={matchupFilterDate === 'tomorrow'}
                                            onChange={() => setMatchupFilterDate('tomorrow')}
                                            disabled={isGeneratingHeatArticle}
                                            style={{ cursor: isGeneratingHeatArticle ? 'not-allowed' : 'pointer' }}
                                        />
                                        <span>Tomorrow</span>
                                    </label>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer', fontSize: '0.85rem' }}>
                                        <input
                                            type="radio"
                                            name="dateFilter"
                                            checked={matchupFilterDate === 'thisWeek'}
                                            onChange={() => setMatchupFilterDate('thisWeek')}
                                            disabled={isGeneratingHeatArticle}
                                            style={{ cursor: isGeneratingHeatArticle ? 'not-allowed' : 'pointer' }}
                                        />
                                        <span>This Week</span>
                                    </label>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer', fontSize: '0.85rem' }}>
                                        <input
                                            type="radio"
                                            name="dateFilter"
                                            checked={matchupFilterDate === 'custom'}
                                            onChange={() => setMatchupFilterDate('custom')}
                                            disabled={isGeneratingHeatArticle}
                                            style={{ cursor: isGeneratingHeatArticle ? 'not-allowed' : 'pointer' }}
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
                                            disabled={isGeneratingHeatArticle}
                                            placeholder="Start date"
                                            style={{ padding: '0.4rem', fontSize: '0.85rem', border: '1px solid #ccc', borderRadius: '4px' }}
                                        />
                                        <span style={{ fontSize: '0.85rem', color: '#666' }}>to</span>
                                        <input
                                            type="date"
                                            value={matchupFilterCustomEnd}
                                            onChange={(e) => setMatchupFilterCustomEnd(e.target.value)}
                                            disabled={isGeneratingHeatArticle}
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
                                                    disabled={isGeneratingHeatArticle}
                                                    style={{ 
                                                        padding: '0.5rem 1rem', 
                                                        background: '#4caf50', 
                                                        color: 'white', 
                                                        border: 'none', 
                                                        borderRadius: '4px', 
                                                        cursor: isGeneratingHeatArticle ? 'not-allowed' : 'pointer',
                                                        fontSize: '0.9rem',
                                                        fontWeight: '500',
                                                        opacity: isGeneratingHeatArticle ? 0.5 : 1
                                                    }}
                                                >
                                                    Save
                                                </button>
                                                <button
                                                    onClick={handleCancelEdit}
                                                    disabled={isGeneratingHeatArticle}
                                                    style={{ 
                                                        padding: '0.5rem 1rem', 
                                                        background: '#999', 
                                                        color: 'white', 
                                                        border: 'none', 
                                                        borderRadius: '4px', 
                                                        cursor: isGeneratingHeatArticle ? 'not-allowed' : 'pointer',
                                                        fontSize: '0.9rem',
                                                        fontWeight: '500',
                                                        opacity: isGeneratingHeatArticle ? 0.5 : 1
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
                                                disabled={isGeneratingHeatArticle}
                                                style={{ marginRight: '1rem', width: '18px', height: '18px', cursor: isGeneratingHeatArticle ? 'not-allowed' : 'pointer' }}
                                            />
                                            <div style={{ flex: 1 }}>
                                                <div style={{ fontWeight: 'bold' }}>
                                                    {matchup.teamA} vs {matchup.teamB}
                                                </div>
                                                <div style={{ fontSize: '0.9rem', color: '#666' }}>
                                                    {matchup.league} • {new Date(matchup.scheduledDate).toLocaleDateString()}
                                                    {matchup.scheduledTime && ` • ${matchup.scheduledTime}`}
                                                </div>
                                            </div>
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    e.preventDefault();
                                                    handleEditMatchup(matchup);
                                                }}
                                                disabled={isGeneratingHeatArticle}
                                                style={{
                                                    padding: '0.5rem 1rem',
                                                    background: '#ff9800',
                                                    color: 'white',
                                                    border: 'none',
                                                    borderRadius: '4px',
                                                    cursor: isGeneratingHeatArticle ? 'not-allowed' : 'pointer',
                                                    fontSize: '0.85rem',
                                                    fontWeight: '500',
                                                    opacity: isGeneratingHeatArticle ? 0.5 : 1,
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

                    {isGeneratingHeatArticle && generationProgress && (
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
                                if (!isGeneratingHeatArticle) {
                                    setShowMatchupModal(false);
                                    setSelectedMatchupIds([]);
                                    setEditingMatchupId(null);
                                    setEditDate('');
                                    setEditTime('');
                                    setError(null);
                                }
                            }}
                            disabled={isGeneratingHeatArticle}
                        >
                            Cancel
                        </button>
                        <button
                            className="action-button"
                            onClick={handleProcessHeatArticle}
                            disabled={isGeneratingHeatArticle || isGeneratingHeatArticleV2 || selectedMatchupIds.length === 0}
                        >
                            {isGeneratingHeatArticle ? 'Generating...' : `Generate ${selectedMatchupIds.length} Article(s)`}
                        </button>
                        <button
                            className="action-button"
                            onClick={handleProcessHeatArticleV2}
                            disabled={isGeneratingHeatArticle || isGeneratingHeatArticleV2 || selectedMatchupIds.length === 0}
                            style={{ background: '#9c27b0', marginLeft: '0.5rem' }}
                        >
                            {isGeneratingHeatArticleV2 ? 'Generating V2...' : `Generate ${selectedMatchupIds.length} V2 Article(s)`}
                        </button>
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
    </div>
  );
};

const HeatchecksFeed: React.FC<{ refreshKey: boolean, setEditingPost: (post: HeatcheckPost) => void }> = ({ refreshKey, setEditingPost }) => {
    const [posts, setPosts] = useState<HeatcheckPost[]>([]);
    const [loading, setLoading] = useState(true);
    const [deletingPostId, setDeletingPostId] = useState<string | null>(null);
    
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

    useEffect(() => {
        setLoading(true);
        apiClient.listPosts().then(data => {
            setPosts(data);
            setLoading(false);
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

    return (
        <div className="results-grid">
            {posts.map(post => {
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
                                    {post.matchupScheduledDate && ` • ${new Date(post.matchupScheduledDate).toLocaleDateString()}`}
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
                                'MLB': 'mlb',
                                'NHL': 'nhl'
                            };
                            const league = leagueMap[post.league] || post.league.toLowerCase().replace(/\s+/g, '-');
                            
                            // Format date consistently - extract YYYY-MM-DD from date string
                            const dateStr = post.matchupScheduledDate || post.createdAt || '';
                            const dateMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
                            const date = dateMatch ? dateMatch[0] : new Date(dateStr).toISOString().split('T')[0];
                            
                            const slug = post.websiteStory.seo?.slug || post.websiteStory.headline
                                .toLowerCase()
                                .trim()
                                .replace(/[^a-z0-9\s-]/g, '')
                                .replace(/\s+/g, '-')
                                .replace(/-+/g, '-')
                                .replace(/^-|-$/g, '') || 'article';
                            const articleUrl = `/${league}/${date}/${slug}.html`;
                            
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
    const [aiFeedback, setAiFeedback] = useState<string>('');
    const [isApplyingFeedback, setIsApplyingFeedback] = useState(false);
    
    // DFS AI Assistant state
    const [selectedPlayerToReplace, setSelectedPlayerToReplace] = useState<number | null>(null);
    const [dfsReplacementInstructions, setDfsReplacementInstructions] = useState<string>('');
    const [isReplacingPlayer, setIsReplacingPlayer] = useState(false);

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
        }
    }, [post]);

    const handleFieldChange = (fieldPath: string, value: any) => {
        if (!editedPost) return;
        setEditedPost(prev => {
            if (!prev) return null;
            const newPost = JSON.parse(JSON.stringify(prev));
            let current: any = newPost;
            const nameParts = fieldPath.split('.');
            for (let i = 0; i < nameParts.length - 1; i++) {
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
    
    const handleSave = async (newStatus: "draft" | "published") => {
        if (!editedPost) return;
        setIsSaving(true);
        try {
            // CRITICAL FIX: Ensure websiteStory object exists and is properly structured
            // Deep merge to preserve all websiteStory properties
            const imageToSave = articleImage || editedPost.websiteStory?.image || editedPost.websiteStory?.imageUrl || '';
            
            const postToSave = {
                ...editedPost,
                websiteStory: {
                    ...(editedPost.websiteStory || {}), // Ensure websiteStory exists
                    image: imageToSave
                },
                status: newStatus
            };
            
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
            
            await apiClient.updatePost(postToSave.id, postToSave);
            
            // Verify the save worked by checking the response
            console.log('[EditorModal] Post saved successfully');
            
            onSave();
            onClose();
        } catch (error) {
            console.error("Failed to save post:", error);
            alert(`Failed to save post: ${error instanceof Error ? error.message : 'Unknown error'}`);
        } finally {
            setIsSaving(false);
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
                model: 'gemini-2.5-pro',
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
                        <button className="save-draft" onClick={() => handleSave("draft")} disabled={isSaving} style={{ background: '#2196f3', color: '#fff', border: 'none', padding: '0.5rem 1rem', borderRadius: '4px', cursor: 'pointer' }}>
                            {isSaving ? 'Saving...' : 'Save Draft'}
                        </button>
                        <button className="publish" onClick={() => handleSave("published")} disabled={isSaving} style={{ background: '#4caf50', color: '#fff', border: 'none', padding: '0.5rem 1rem', borderRadius: '4px', cursor: 'pointer' }}>
                            {isSaving ? 'Publishing...' : 'Publish'}
                        </button>
                        <button className="cancel" onClick={onClose} disabled={isSaving} style={{ background: '#666', color: '#fff', border: 'none', padding: '0.5rem 1rem', borderRadius: '4px', cursor: 'pointer' }}>
                            Cancel
                        </button>
                    </div>
                </div>

                {/* Main Content - Two Column Layout */}
                <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
                    {/* Left Column - Article Editor */}
                    <div style={{ flex: '1 1 60%', padding: '2rem', overflowY: 'auto', borderRight: '1px solid #333' }}>
                        <div style={{ marginBottom: '2rem' }}>
                            <h3 style={{ marginBottom: '0.5rem', fontSize: '1.2rem' }}>Article (Markdown)</h3>
                            
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
                                        {availableImages.map(img => (
                                            <div
                                                key={img}
                                                onClick={() => handleSelectImage(img)}
                                                style={{ padding: '0.5rem', cursor: 'pointer', borderRadius: '4px', marginBottom: '0.25rem', background: articleImage.includes(img) ? '#4caf50' : 'transparent' }}
                                                onMouseEnter={(e) => e.currentTarget.style.background = '#333'}
                                                onMouseLeave={(e) => e.currentTarget.style.background = articleImage.includes(img) ? '#4caf50' : 'transparent'}
                                            >
                                                {img}
                                            </div>
                                        ))}
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
                                        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                                            {/* Lean Dropdown */}
                                            <select
                                                value={editedPost.heatchecksEdge.lean || 'NO_EDGE'}
                                                onChange={(e) => handleFieldChange('heatchecksEdge.lean', e.target.value as "FAVOR" | "FADE" | "NO_EDGE")}
                                                style={{
                                                    padding: '0.25rem 0.75rem',
                                                    background: editedPost.heatchecksEdge.lean === 'FAVOR' ? 'rgba(76, 175, 80, 0.2)' : editedPost.heatchecksEdge.lean === 'FADE' ? 'rgba(248, 66, 66, 0.2)' : 'rgba(255, 255, 255, 0.1)',
                                                    border: `1px solid ${editedPost.heatchecksEdge.lean === 'FAVOR' ? 'rgba(76, 175, 80, 0.5)' : editedPost.heatchecksEdge.lean === 'FADE' ? 'rgba(248, 66, 66, 0.5)' : 'rgba(255, 255, 255, 0.3)'}`,
                                                    borderRadius: '4px',
                                                    fontSize: '0.75rem',
                                                    fontWeight: 'bold',
                                                    color: editedPost.heatchecksEdge.lean === 'FAVOR' ? '#4caf50' : editedPost.heatchecksEdge.lean === 'FADE' ? '#f84242' : 'rgba(255, 255, 255, 0.7)',
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
                                                value={editedPost.heatchecksEdge.confidence || 'medium'}
                                                onChange={(e) => handleFieldChange('heatchecksEdge.confidence', e.target.value as "low" | "medium" | "high")}
                                                style={{
                                                    padding: '0.25rem 0.75rem',
                                                    background: 'rgba(255, 255, 255, 0.1)',
                                                    border: '1px solid rgba(255, 255, 255, 0.3)',
                                                    borderRadius: '4px',
                                                    fontSize: '0.75rem',
                                                    fontWeight: 'bold',
                                                    color: editedPost.heatchecksEdge.confidence === 'high' ? '#4caf50' : editedPost.heatchecksEdge.confidence === 'medium' ? '#ffc107' : '#ff9800',
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
                                    </div>
                                    
                                    {/* Betting Lines (Read-only - from API) */}
                                    {editedPost.heatchecksEdge.lines && editedPost.heatchecksEdge.lines.length > 0 && (
                                        <div style={{ marginBottom: '1rem', paddingBottom: '1rem', borderBottom: '1px solid rgba(255, 255, 255, 0.2)' }}>
                                            <div style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.7)', marginBottom: '0.5rem', fontFamily: "'Courier New', monospace" }}>BETTING LINES:</div>
                                            {editedPost.heatchecksEdge.lines.map((line: any, idx: number) => (
                                                <div key={idx} style={{ fontSize: '0.85rem', color: 'rgba(255, 255, 255, 0.9)', marginBottom: '0.25rem', fontFamily: "'Courier New', monospace" }}>
                                                    {line.marketType}: {line.label} {line.line} ({line.price}) - {line.book}
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    
                                    {/* Rationale Bullets (Editable) */}
                                    <div style={{ marginBottom: '1rem', paddingBottom: '1rem', borderBottom: '1px solid rgba(255, 255, 255, 0.2)' }}>
                                        <label style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.7)', marginBottom: '0.5rem', fontFamily: "'Courier New', monospace", display: 'block' }}>RATIONALE:</label>
                                        {(editedPost.heatchecksEdge.rationaleBullets || []).map((bullet: string, idx: number) => (
                                            <div key={idx} style={{ marginBottom: '0.5rem', display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                                                <span style={{ color: '#f84242', fontSize: '1.2rem', lineHeight: '1.5' }}>•</span>
                                                <textarea
                                                    value={bullet}
                                                    onChange={(e) => {
                                                        const newBullets = [...(editedPost.heatchecksEdge.rationaleBullets || [])];
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
                                                        const newBullets = [...(editedPost.heatchecksEdge.rationaleBullets || [])];
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
                                                const newBullets = [...(editedPost.heatchecksEdge.rationaleBullets || []), ''];
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
                                            value={editedPost.heatchecksEdge.finalCall || ''}
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
                                        {(editedPost.heatchecksEdge.riskCounterpoints || []).map((risk: string, idx: number) => (
                                            <div key={idx} style={{ marginBottom: '0.5rem', display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                                                <span style={{ color: 'rgba(255, 152, 0, 0.9)', fontSize: '1.2rem', lineHeight: '1.5' }}>⚠</span>
                                                <textarea
                                                    value={risk}
                                                    onChange={(e) => {
                                                        const newRisks = [...(editedPost.heatchecksEdge.riskCounterpoints || [])];
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
                                                        const newRisks = [...(editedPost.heatchecksEdge.riskCounterpoints || [])];
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
                                                const newRisks = [...(editedPost.heatchecksEdge.riskCounterpoints || []), ''];
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

Be VERY strict - it's better to flag someone as invalid incorrectly than to allow an invalid reference in the article.
`;
    
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-pro',
      contents: validationPrompt,
      config: {
        tools: [{ googleSearch: {} }],
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
      
      // Mark invalid results with full details
      if (!result.is_valid && result.warning) {
        const injuryInfo = result.injury_status && result.injury_status !== 'N/A' 
          ? `, Injury: ${result.injury_status}` 
          : '';
        const confidenceInfo = result.verification_confidence === 'low'
          ? ` [Low Confidence]`
          : '';
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
      model: 'gemini-2.5-pro',
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

    // Parse the JSON response
    let edgeData: HeatchecksEdge;
    try {
      edgeData = JSON.parse(text);
    } catch (parseError: any) {
      console.error('[generateHeatChecksEdge] Failed to parse JSON:', parseError);
      console.error('[generateHeatChecksEdge] Response text:', text.substring(0, 500));
      // Fallback: try extractJson approach
      edgeData = extractJson<HeatchecksEdge>(text);
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
    const parsed = JSON.parse(jsonString);
    return parsed;
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