import { GoogleGenAI, Type } from '@google/genai';

interface NarrativeCard {
    narrative_id?: string;
    title?: string;
    claim?: string;
    emotion_tags?: string[];
    total_score?: number;
    key_characters?: string[];
    [key: string]: any;
}

interface ViralContentContext {
    teamA: string;
    teamB: string;
    league: string;
    matchupDate: string;
    evidenceBundle?: {
        quotes?: Array<{ quote: string; speaker?: string; context?: string; quote_id?: string }>;
        timeline_events?: Array<{ summary: string; date_utc?: string; event_type?: string }>;
        sources?: Array<{ title: string; url: string }>;
    };
    factPack?: {
        key_stats?: Array<{ label: string; value: string; why_it_matters?: string; key?: string }>;
        odds?: any;
        context?: {
            recent_form?: any;
            injuries?: Array<{ name: string; team: string; status: string; reason?: string }>;
            standings?: any;
            venue?: any;
        };
        formLeaders?: any[];
        comparisons?: any[];
        sections?: any[];
        bullets?: any[];
        raw?: {
            teamForm?: any;
            availability?: any;
            headToHead?: any;
        };
        [key: string]: any;
    };
    narrativeStrengtheners?: {
        scoreBreakdown?: any;
        totalScore?: number;
        riskNotes?: string[];
        evidenceRequirementsMet?: boolean;
        mustCiteSourceIds?: string[];
    };
    articleMarkdown?: string;
}

interface FiveStateContent {
    patternRecognition: string; // 150-200 words, no stats, human moment
    tensionEscalation: string; // Why this moment is different
    dataRevelation: {
        headlineStat: string;
        supportingStats: string[];
    };
    generalization: string; // The "Oh Sh*t" moment
    marketFailure: string; // Why everyone misses this
    actionableClose: string; // Perspective + soft CTA
}

interface ViralContentOutputs {
    longFormTweet: string; // 220-280 words, single flowing narrative
    twitterThread: string[]; // 5-7 tweets with thread markers
    redditPost: {
        title: string; // max 300 chars
        body: string;
    };
    heatSheetSegment: string; // Condensed bullet format
}

export interface GeneratedViralContent {
    longFormTweet: string;
    twitterThread: string[];
    redditPost: {
        title: string;
        body: string;
    };
    heatSheetSegment: string;
    validationNotes: string;
}

/**
 * Phase 1: Research & Context Gathering
 * Uses Gemini with Google Search to find additional backstory, quotes, and context
 */
async function researchViralContext(
    ai: GoogleGenAI,
    narrative: NarrativeCard,
    context: ViralContentContext
): Promise<string> {
    const quotes = context.evidenceBundle?.quotes?.map(q => 
        `"${q.quote}" - ${q.speaker || 'Unknown'}${q.context ? ` (${q.context})` : ''}`
    ).join('\n') || 'None';

    const timelineEvents = context.evidenceBundle?.timeline_events?.map(e => 
        `${e.date_utc || 'Date unknown'}: ${e.summary}${e.event_type ? ` [${e.event_type}]` : ''}`
    ).join('\n') || 'None';

    const keyStats = context.factPack?.key_stats?.map(s => 
        `${s.label}: ${s.value}${s.why_it_matters ? ` (${s.why_it_matters})` : ''}`
    ).join('\n') || 'None';

    const recentForm = context.factPack?.context?.recent_form || 'None';
    const injuries = context.factPack?.context?.injuries?.map(i => 
        `${i.name} (${i.team}): ${i.status}`
    ).join('\n') || 'None';

    const researchPrompt = `
You are a sports narrative researcher specializing in viral content. Your task is to find compelling backstory, emotional evidence, stats, and context for a matchup narrative following the HeatChecks Viral Article Framework.

**MATCHUP:**
- Teams: ${context.teamA} vs ${context.teamB}
- League: ${context.league}
- Date: ${context.matchupDate}

**NARRATIVE CARD:**
- Title: ${narrative.title || 'N/A'}
- Claim: ${narrative.claim || 'N/A'}
- Emotion Tags: ${narrative.emotion_tags?.join(', ') || 'N/A'}
- Key Characters: ${narrative.key_characters?.join(', ') || 'N/A'}

**EXISTING EVIDENCE:**
Quotes:
${quotes}

Timeline Events:
${timelineEvents}

Key Stats:
${keyStats}

Recent Form:
${JSON.stringify(recentForm, null, 2)}

Injuries:
${injuries}

**RESEARCH TASK:**
Research and compile additional context for the 5-state framework:

1. **Pattern Recognition Material**: Human moments, contradictions, implicit questions that make readers say "I've felt this... but I've never seen it explained"
2. **Tension Escalation Context**: Schedule compression, contract years, public quotes, media noise, fan pressure - why THIS moment is different
3. **Data/Stats**: Historical performance splits, before/after deltas, comparable cases, head-to-head records
4. **Generalization Cases**: Similar historical cases, mechanisms (loss of role clarity, ego threat, uncertainty stress, etc.)
5. **Market Failure Evidence**: Why models/odds/DFS pricing lag behind psychology

Return a comprehensive research summary in JSON format:
{
  "patternRecognition": {
    "humanMoments": ["moment 1", "moment 2"],
    "contradictions": ["contradiction 1", "contradiction 2"],
    "implicitQuestions": ["question 1", "question 2"]
  },
  "tensionContext": {
    "scheduleCompression": "context about schedule",
    "contractYear": "contract context if applicable",
    "publicQuotes": ["quote 1", "quote 2"],
    "mediaNoise": "media context",
    "fanPressure": "fan pressure context"
  },
  "stats": {
    "historicalSplits": ["split 1", "split 2"],
    "beforeAfterDeltas": ["delta 1", "delta 2"],
    "headToHead": "head-to-head record",
    "comparableCases": ["case 1", "case 2"],
    "formLeaders": ["player stat 1 from formLeaders data", "player stat 2 from formLeaders data"],
    "teamMetrics": ["metric 1 from comparisons", "metric 2 from comparisons"],
    "formDeltas": ["delta from raw teamForm data", "delta from raw teamForm data"]
  },
  "generalization": {
    "historicalCases": ["case 1", "case 2"],
    "mechanisms": ["mechanism 1", "mechanism 2"],
    "transferableInsight": "insight that applies beyond this game"
  },
  "marketFailure": {
    "modelLag": "why models lag",
    "psychologyVsEfficiency": "psychology vs efficiency gap",
    "heatchecksLens": "what Heatchecks sees that others miss"
  },
  "backstory": "Detailed backstory context",
  "transactionHistory": "Relevant transaction details",
  "personalContext": "Personal milestones or context"
}

Be thorough and find real, verifiable information. Build upon the existing evidence provided.
`;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-pro',
            contents: researchPrompt,
            config: {
                tools: [{ googleSearch: {} }]
                // Note: Cannot use responseMimeType with googleSearch tool, so we parse JSON from text
            }
        });

        // Get text from response - handle different response structures
        let text = '';
        
        // Log response structure for debugging
        console.log('[Viral Content] Research response structure:', {
            hasText: 'text' in response,
            textType: typeof response.text,
            hasCandidates: 'candidates' in response,
            responseKeys: Object.keys(response || {})
        });
        
        // Try direct text access first
        if (response.text) {
            text = typeof response.text === 'string' ? response.text : String(response.text);
        }
        
        // If no text, try to get from candidates (common with tool usage)
        if (!text && response.candidates && Array.isArray(response.candidates) && response.candidates.length > 0) {
            const candidate = response.candidates[0];
            if (candidate.content && candidate.content.parts) {
                text = candidate.content.parts
                    .map((part: any) => {
                        if (part.text) return part.text;
                        if (typeof part === 'string') return part;
                        return '';
                    })
                    .filter(Boolean)
                    .join('');
            } else if (candidate.text) {
                text = typeof candidate.text === 'string' ? candidate.text : String(candidate.text);
            }
        }
        
        // Fallback: try response.response.text
        if (!text && (response as any).response?.text) {
            text = typeof (response as any).response.text === 'string' 
                ? (response as any).response.text 
                : String((response as any).response.text);
        }

        if (!text || text.trim().length === 0) {
            console.error('[Viral Content] Empty response from research phase. Full response:', JSON.stringify(response, null, 2));
            throw new Error('Research phase returned empty response. The AI may need more context or the response format changed.');
        }

        let jsonText = text;
        
        // Try to extract JSON from markdown code blocks
        const markdownMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
        if (markdownMatch && markdownMatch[1]) {
            jsonText = markdownMatch[1].trim();
        } else {
            // Find first { and last } to extract JSON
            const firstBrace = text.indexOf('{');
            const lastBrace = text.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                jsonText = text.substring(firstBrace, lastBrace + 1);
            }
        }
        
        // Validate that we have valid JSON before returning
        try {
            JSON.parse(jsonText);
        } catch (e) {
            console.error('Failed to parse JSON from research response. Raw text:', text);
            console.error('Extracted JSON text:', jsonText);
            throw new Error('Research phase returned invalid JSON. Please try again.');
        }
        
        return jsonText;
    } catch (error: any) {
        console.error('Error in research phase:', error);
        throw new Error(`Research phase failed: ${error.message}`);
    }
}

/**
 * Phase 2: Generate Structured Content using 5-State Framework
 */
async function generateViralContent(
    ai: GoogleGenAI,
    narrative: NarrativeCard,
    context: ViralContentContext,
    researchData: string
): Promise<FiveStateContent> {
    const narrativeStrengtheners = context.narrativeStrengtheners || {};
    const generationPrompt = `
You are a VIRAL sports content creator using the HeatChecks Viral Article Framework. Generate COMPELLING, EDGY, PROVOCATIVE narrative-driven content that hits all 5 cognitive states: Recognition, Tension, Validation, Insight, Share-worthiness.

**CRITICAL TONE REQUIREMENTS:**
- BE BOLD. BE PROVOCATIVE. BE UNCOMFORTABLE.
- Don't be safe. Don't be generic. Don't be boring.
- Make people stop scrolling. Make them think. Make them share.
- Use contradictions. Expose hypocrisy. Reveal uncomfortable truths.
- Stats are weapons. Use them to prove points, not just list numbers.

**MATCHUP:**
- Teams: ${context.teamA} vs ${context.teamB}
- League: ${context.league}
- Date: ${context.matchupDate}

**NARRATIVE CARD:**
- Title: ${narrative.title || 'N/A'}
- Claim: ${narrative.claim || 'N/A'}
- Emotion Tags: ${narrative.emotion_tags?.join(', ') || 'N/A'}
- Key Characters: ${narrative.key_characters?.join(', ') || 'N/A'}
- Score: ${narrativeStrengtheners.totalScore || 0}/35
- Risk Notes: ${(narrativeStrengtheners.riskNotes || []).join('; ')}

**RESEARCH DATA:**
${researchData}

**EXISTING EVIDENCE:**
${JSON.stringify(context.evidenceBundle, null, 2)}

**COMPREHENSIVE STATS FROM DATABASE:**
${JSON.stringify({
    key_stats: context.factPack?.key_stats || [],
    formLeaders: context.factPack?.formLeaders || [],
    comparisons: context.factPack?.comparisons || [],
    sections: context.factPack?.sections || [],
    raw: context.factPack?.raw || {},
    recent_form: context.factPack?.context?.recent_form || {}
}, null, 2)}

**5-STATE FRAMEWORK - EDGY VERSION:**

1️⃣ **Pattern Recognition (The Hook)** - 150-200 words, NO STATS YET
   - Start with an UNCOMFORTABLE human moment, not a game
   - Frame a CONTRADICTION that exposes hypocrisy ("He says it doesn't matter — but it always does")
   - Ask a PROVOCATIVE implicit question that makes people uncomfortable
   - Make the reader say: "I've felt this... but I've never seen it explained"
   - BE EDGY. BE BOLD. DON'T BE SAFE.
   - Example: "Players will tell you trade rumors don't affect them. But every locker room knows the truth: uncertainty changes behavior long before rosters change."

2️⃣ **Tension Escalation (Why This Moment Is Different)**
   - Why THIS player (contract? trade deadline? personal stakes?)
   - Why THIS timing (schedule compression? playoff race? media cycle?)
   - Why THIS context (revenge? redemption? legacy?)
   - Pull from: schedule compression, contract year, REAL quotes (not PR), media noise, fan pressure
   - Build REAL stakes, not generic ones

3️⃣ **Data Revelation (Stats as Proof, Not Content)**
   - Stats are not the story. Stats are the RECEIPT.
   - Compare before vs after - show the DELTA
   - Anchor stats to BEHAVIORAL CHANGE
   - Use deltas, not raw numbers
   - Structure: One headline stat + 3-5 supporting metrics
   - USE THE FORM LEADERS DATA. USE THE COMPARISONS. USE ALL AVAILABLE STATS.
   - Show stats that CONTRADICT the public narrative

4️⃣ **Generalization (The "Oh Sh*t" Moment)**
   - Show this isn't a one-off - reference SIMILAR historical cases
   - Identify the MECHANISM (loss of role clarity, ego threat, uncertainty stress, increased self-monitoring, altered risk tolerance)
   - Now the reader learns something TRANSFERABLE
   - This is the "I need to send this to someone" point

5️⃣ **Market Failure (Why Everyone Misses This)**
   - Explain why models, odds, DFS pricing LAG
   - Show what markets see vs what they MISS
   - Frame Heatchecks as LENS, not predictor
   - Example: "Markets price efficiency. They struggle with psychology."

6️⃣ **Actionable Close (Without Killing the Story)**
   - Do NOT end with "here's the pick"
   - End with PERSPECTIVE
   - Reassert the theme (pressure, intent, human behavior)
   - One soft CTA
   - Example: "These are the moments we track every week — not because they always hit, but because they bend games. That's what Heatchecks is built to see."

Return ONLY a JSON object with this exact structure:
{
  "patternRecognition": "150-200 words, EDGY human moment, contradiction, provocative question, NO STATS",
  "tensionEscalation": "Why this moment is different - player, timing, context - BE SPECIFIC",
  "dataRevelation": {
    "headlineStat": "One headline stat that anchors to behavioral change - USE ACTUAL STATS FROM DATA",
    "supportingStats": ["supporting stat 1 from formLeaders", "supporting stat 2 from comparisons", "supporting stat 3 from sections", "supporting stat 4", "supporting stat 5"]
  },
  "generalization": "The 'Oh Sh*t' moment - historical cases, mechanisms, transferable insight",
  "marketFailure": "Why everyone misses this - models lag, psychology vs efficiency, Heatchecks lens",
  "actionableClose": "Perspective + soft CTA, no picks"
}

USE ALL THE STATS PROVIDED. BE SPECIFIC. BE EDGY. DON'T BE GENERIC.
`;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-pro',
            contents: generationPrompt,
            config: {
                tools: [{ googleSearch: {} }]
                // Note: Cannot use responseMimeType with googleSearch tool, so we parse JSON from text
            }
        });

        // Get text from response
        let text = '';
        if (response.text) {
            text = typeof response.text === 'string' ? response.text : String(response.text);
        } else if (response.candidates && Array.isArray(response.candidates) && response.candidates.length > 0) {
            const candidate = response.candidates[0];
            if (candidate.content && candidate.content.parts) {
                text = candidate.content.parts
                    .map((part: any) => part.text || '')
                    .filter(Boolean)
                    .join('');
            } else if (candidate.text) {
                text = typeof candidate.text === 'string' ? candidate.text : String(candidate.text);
            }
        }

        if (!text || text.trim().length === 0) {
            throw new Error('Generation phase returned empty response.');
        }

        // Extract JSON from text
        let jsonText = text;
        const markdownMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
        if (markdownMatch && markdownMatch[1]) {
            jsonText = markdownMatch[1].trim();
        } else {
            const firstBrace = text.indexOf('{');
            const lastBrace = text.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                jsonText = text.substring(firstBrace, lastBrace + 1);
            }
        }

        return JSON.parse(jsonText);
    } catch (error: any) {
        console.error('Error in generation phase:', error);
        throw new Error(`Generation phase failed: ${error.message}`);
    }
}

/**
 * Phase 3: Format Outputs
 * Converts 5-state content into multiple formats
 */
async function formatOutputs(
    ai: GoogleGenAI,
    narrative: NarrativeCard,
    context: ViralContentContext,
    fiveStateContent: FiveStateContent,
    researchData: string
): Promise<ViralContentOutputs> {
    const formatPrompt = `
You are formatting viral content into multiple output formats. Convert the 5-state framework content into:

**5-STATE CONTENT:**
${JSON.stringify(fiveStateContent, null, 2)}

**MATCHUP:**
- Teams: ${context.teamA} vs ${context.teamB}
- League: ${context.league}
- Date: ${context.matchupDate}

**NARRATIVE:**
- Title: ${narrative.title || 'N/A'}
- Claim: ${narrative.claim || 'N/A'}

**FORMAT REQUIREMENTS:**

1. **Long-form Tweet** (220-280 words)
   - Single flowing narrative combining all 5 states
   - Line breaks every 1-2 lines for readability
   - Feels like a live broadcast of a story
   - Natural transitions between states

2. **Twitter Thread** (5-7 tweets)
   - Number each tweet (1/7, 2/7, etc.)
   - Natural breaks at state transitions
   - Each tweet should be compelling on its own but build to the next
   - Final tweet should be the actionable close

3. **Reddit Post**
   - Title: Engaging title (max 300 chars) that captures the narrative angle
   - Body: Start with "Thought this was an insane storyline going into tonight's game:" then expand all 5 states
   - Add extra context in data revelation section
   - Expand generalization with more historical cases
   - End with: "How do you see this one playing out?"

4. **Heat Sheet Segment** (Condensed bullet format)
   - Quick scanning format
   - Key bullets from each state
   - Stats highlighted
   - Mechanism identified
   - Market failure point

Return ONLY a JSON object:
{
  "longFormTweet": "220-280 word single flowing narrative with line breaks",
  "twitterThread": ["Tweet 1/7", "Tweet 2/7", "Tweet 3/7", "Tweet 4/7", "Tweet 5/7", "Tweet 6/7", "Tweet 7/7"],
  "redditPost": {
    "title": "Engaging title max 300 chars",
    "body": "Full reddit post body starting with 'Thought this was an insane storyline...'"
  },
  "heatSheetSegment": "Condensed bullet format for quick scanning"
}
`;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-pro',
            contents: formatPrompt,
            config: {
                // Note: Not using googleSearch here, so we can use responseMimeType
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        longFormTweet: { type: Type.STRING },
                        twitterThread: { type: Type.ARRAY, items: { type: Type.STRING } },
                        redditPost: {
                            type: Type.OBJECT,
                            properties: {
                                title: { type: Type.STRING },
                                body: { type: Type.STRING }
                            },
                            required: ['title', 'body']
                        },
                        heatSheetSegment: { type: Type.STRING }
                    },
                    required: ['longFormTweet', 'twitterThread', 'redditPost', 'heatSheetSegment']
                }
            }
        });

        return JSON.parse(response.text);
    } catch (error: any) {
        console.error('Error in formatting phase:', error);
        throw new Error(`Formatting phase failed: ${error.message}`);
    }
}

/**
 * Phase 4: Validate Facts
 * Fact-check using Gemini + Google Search
 */
async function validateViralContent(
    ai: GoogleGenAI,
    narrative: NarrativeCard,
    context: ViralContentContext,
    outputs: ViralContentOutputs,
    researchData: string
): Promise<{ outputs: ViralContentOutputs; validationNotes: string }> {
    const validationPrompt = `
You are a fact-checker for sports content. Validate the following content for accuracy.

**MATCHUP:**
- Teams: ${context.teamA} vs ${context.teamB}
- League: ${context.league}
- Date: ${context.matchupDate}

**NARRATIVE:**
- Title: ${narrative.title || 'N/A'}
- Claim: ${narrative.claim || 'N/A'}

**RESEARCH DATA:**
${researchData}

**GENERATED OUTPUTS:**
${JSON.stringify(outputs, null, 2)}

**VALIDATION TASK:**
1. Check all team names, player names, stats, dates, and quotes for accuracy
2. Verify transaction history and personal context
3. Verify stats are correct (headline stat and supporting stats)
4. Check historical cases mentioned in generalization
5. If you find ANY inaccuracies, factual errors, or unverifiable claims:
   - Rewrite the affected sections
   - Keep the same structure and emotional tone
   - Only use verified information
6. If everything is accurate, return the content as-is

Return ONLY a JSON object:
{
  "longFormTweet": "validated or corrected long-form tweet",
  "twitterThread": ["validated or corrected tweet 1", "tweet 2", ...],
  "redditPost": {
    "title": "validated or corrected title",
    "body": "validated or corrected body"
  },
  "heatSheetSegment": "validated or corrected heat sheet segment",
  "validationNotes": "Any issues found and how they were fixed, or 'All facts verified'"
}
`;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-pro',
            contents: validationPrompt,
            config: {
                tools: [{ googleSearch: {} }]
                // Note: Cannot use responseMimeType with googleSearch tool, so we parse JSON from text
            }
        });

        // Get text from response - handle different response structures
        let text = '';
        
        // Log response structure for debugging
        console.log('[Viral Content] Validation response structure:', {
            hasText: 'text' in response,
            textType: typeof response.text,
            hasCandidates: 'candidates' in response,
            responseKeys: Object.keys(response || {})
        });
        
        // Try direct text access first
        if (response.text) {
            text = typeof response.text === 'string' ? response.text : String(response.text);
        }
        
        // If no text, try to get from candidates (common with tool usage)
        if (!text && response.candidates && Array.isArray(response.candidates) && response.candidates.length > 0) {
            const candidate = response.candidates[0];
            if (candidate.content && candidate.content.parts) {
                text = candidate.content.parts
                    .map((part: any) => {
                        if (part.text) return part.text;
                        if (typeof part === 'string') return part;
                        return '';
                    })
                    .filter(Boolean)
                    .join('');
            } else if (candidate.text) {
                text = typeof candidate.text === 'string' ? candidate.text : String(candidate.text);
            }
        }
        
        // Fallback: try response.response.text
        if (!text && (response as any).response?.text) {
            text = typeof (response as any).response.text === 'string' 
                ? (response as any).response.text 
                : String((response as any).response.text);
        }

        if (!text || text.trim().length === 0) {
            console.error('[Viral Content] Empty response from validation phase. Full response:', JSON.stringify(response, null, 2));
            throw new Error('Validation phase returned empty response. The AI may need more context or the response format changed.');
        }

        let jsonText = text;
        
        // Try to extract JSON from markdown code blocks
        const markdownMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
        if (markdownMatch && markdownMatch[1]) {
            jsonText = markdownMatch[1].trim();
        } else {
            // Find first { and last } to extract JSON
            const firstBrace = text.indexOf('{');
            const lastBrace = text.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                jsonText = text.substring(firstBrace, lastBrace + 1);
            }
        }
        
        const result = JSON.parse(jsonText);
        console.log('Validation notes:', result.validationNotes);
        
        return {
            outputs: {
                longFormTweet: result.longFormTweet || outputs.longFormTweet,
                twitterThread: result.twitterThread || outputs.twitterThread,
                redditPost: result.redditPost || outputs.redditPost,
                heatSheetSegment: result.heatSheetSegment || outputs.heatSheetSegment
            },
            validationNotes: result.validationNotes || 'Validation completed'
        };
    } catch (error: any) {
        console.error('Error in validation phase:', error);
        // Return original outputs if validation fails
        return {
            outputs,
            validationNotes: `Validation phase encountered an error: ${error.message}. Content returned as-is.`
        };
    }
}

/**
 * Main function: Generate viral content from a narrative card
 */
export async function generateViralContentFromNarrative(
    narrative: NarrativeCard,
    context: ViralContentContext
): Promise<GeneratedViralContent> {
    const apiKey = import.meta.env.VITE_GEMINI_API_KEY || (window as any).process?.env?.API_KEY || '';
    if (!apiKey) {
        throw new Error('API key not available');
    }

    const ai = new GoogleGenAI({ apiKey });

    try {
        // Phase 1: Research
        console.log('[Viral Content] Phase 1: Researching narrative context...');
        const researchData = await researchViralContext(ai, narrative, context);

        // Phase 2: Generate structured content (5-state framework)
        console.log('[Viral Content] Phase 2: Generating 5-state framework content...');
        const fiveStateContent = await generateViralContent(ai, narrative, context, researchData);

        // Phase 3: Format outputs
        console.log('[Viral Content] Phase 3: Formatting outputs...');
        const outputs = await formatOutputs(ai, narrative, context, fiveStateContent, researchData);

        // Phase 4: Validate facts
        console.log('[Viral Content] Phase 4: Validating facts...');
        const validated = await validateViralContent(ai, narrative, context, outputs, researchData);

        return {
            longFormTweet: validated.outputs.longFormTweet,
            twitterThread: validated.outputs.twitterThread,
            redditPost: validated.outputs.redditPost,
            heatSheetSegment: validated.outputs.heatSheetSegment,
            validationNotes: validated.validationNotes
        };
    } catch (error: any) {
        console.error('Error generating viral content:', error);
        throw new Error(`Failed to generate viral content: ${error.message || 'Unknown error'}`);
    }
}

