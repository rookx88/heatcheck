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

interface HeatArticleContext {
    teamA: string;
    teamB: string;
    league: string;
    matchupDate: string;
    evidenceBundle?: {
        quotes?: Array<{ quote: string; speaker?: string; context?: string }>;
        timeline_events?: Array<{ summary: string; date_utc?: string }>;
        sources?: Array<{ title: string; url: string }>;
    };
    factPack?: {
        key_stats?: Array<{ label: string; value: string }>;
        odds?: any;
        [key: string]: any;
    };
}

interface StructuredContent {
    hook: string;
    backstory: string;
    receipts: string[];
    pressurePoint: string;
    stakes: {
        win: string[];
        lose: string[];
    };
    cta: string;
}

interface GeneratedContent {
    tweet: string;
    reddit: {
        title: string;
        body: string;
    };
}

/**
 * Phase 1: Research additional narratives, backstory, emotional evidence, stats, quotes
 */
async function researchNarrativeContext(
    ai: GoogleGenAI,
    narrative: NarrativeCard,
    context: HeatArticleContext
): Promise<string> {
    const quotes = context.evidenceBundle?.quotes?.map(q => 
        `"${q.quote}" - ${q.speaker || 'Unknown'}${q.context ? ` (${q.context})` : ''}`
    ).join('\n') || 'None';

    const timelineEvents = context.evidenceBundle?.timeline_events?.map(e => 
        `${e.date_utc || 'Date unknown'}: ${e.summary}`
    ).join('\n') || 'None';

    const keyStats = context.factPack?.key_stats?.map(s => 
        `${s.label}: ${s.value}`
    ).join('\n') || 'None';

    const researchPrompt = `
You are a sports narrative researcher. Your task is to find compelling backstory, emotional evidence, stats, and quotes for a matchup narrative.

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

**RESEARCH TASK:**
Research and compile additional:
1. Backstory: Why this matchup matters (rivalry history, previous games, trades, personal history between teams/players)
2. Emotional Evidence: Additional quotes from players, coaches, media about this matchup or situation
3. Stats: Relevant historical stats, previous matchup results, head-to-head records, recent performance trends
4. Narrative Angles: Revenge, redemption, legacy, respect, pride themes specific to this narrative
5. Transaction History: Any trades, releases, or contract situations relevant to this matchup
6. Personal Context: Injuries, milestones, career moments that add emotional weight to the narrative
7. Team Dynamics: How this narrative affects team chemistry, motivation, or strategy

Return a comprehensive research summary in JSON format:
{
  "backstory": "Detailed backstory context...",
  "quotes": ["quote 1", "quote 2", "quote 3"],
  "stats": ["stat 1", "stat 2", "stat 3"],
  "transactionHistory": "Relevant transaction details...",
  "personalContext": "Personal milestones or context...",
  "emotionalThemes": ["theme1", "theme2", "theme3"],
  "teamDynamics": "How this narrative affects the teams..."
}

Be thorough and find real, verifiable information. Build upon the existing evidence provided.
`;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-pro',
            contents: researchPrompt,
            config: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        backstory: { type: Type.STRING },
                        quotes: { type: Type.ARRAY, items: { type: Type.STRING } },
                        stats: { type: Type.ARRAY, items: { type: Type.STRING } },
                        transactionHistory: { type: Type.STRING },
                        personalContext: { type: Type.STRING },
                        emotionalThemes: { type: Type.ARRAY, items: { type: Type.STRING } },
                        teamDynamics: { type: Type.STRING }
                    },
                    required: ['backstory', 'quotes', 'stats', 'transactionHistory', 'personalContext', 'emotionalThemes', 'teamDynamics']
                }
            }
        });

        return response.text;
    } catch (error: any) {
        console.error('Error in research phase:', error);
        throw new Error(`Research phase failed: ${error.message}`);
    }
}

/**
 * Phase 2: Generate structured content using the narrative framework
 */
async function generateStructuredContent(
    ai: GoogleGenAI,
    narrative: NarrativeCard,
    context: HeatArticleContext,
    researchData: string
): Promise<StructuredContent> {
    const generationPrompt = `
You are a viral sports content creator. Generate compelling narrative-driven content using this structured framework.

**MATCHUP:**
- Teams: ${context.teamA} vs ${context.teamB}
- League: ${context.league}
- Date: ${context.matchupDate}

**NARRATIVE CARD:**
- Title: ${narrative.title || 'N/A'}
- Claim: ${narrative.claim || 'N/A'}
- Emotion Tags: ${narrative.emotion_tags?.join(', ') || 'N/A'}
- Key Characters: ${narrative.key_characters?.join(', ') || 'N/A'}

**RESEARCH DATA:**
${researchData}

**CONTENT FRAMEWORK:**

🧩 SECTION 1 — The Hook (3–4 lines max)
- Create emotional tension in < 3 seconds
- Short lines, plain language, no hashtags, no emojis
- Sounds like a human telling a secret
- Template: "This game means more to [Player/Team]. [Opponent] didn't believe in them. They moved on. Now they have to face the consequences."

🧬 SECTION 2 — The Backstory (Context Engine)
- Explain why this matters
- Template: "In [year], [brief historical moment]. [Team A] vs [Team B]. Tension was already high. But this time it's different. Because of [specific incident/trade/quote/rivalry detail]."

🧾 SECTION 3 — Receipts & Evidence
- Build credibility + fuel emotion
- 4-6 short bullet points
- Include: Stats, quotes, transaction history, previous matchup results, personal milestones
- Keep bullets short, let them stack psychologically

🔥 SECTION 4 — Pressure Point (Emotional Climax)
- Turn information into narrative gravity
- Template: "This isn't just another game. This is about: Pride. Revenge. Legacy. Respect. And someone is walking out changed."

🎯 SECTION 5 — The Stakes (Future Impact)
- Why tonight/today matters
- Template: "If [Player/Team] wins: [Consequence A], [Consequence B], [Consequence C]. If they lose: Everything looks different."

🧠 SECTION 6 — Soft CTA
- Invite engagement without selling
- Template: "Full story below." or "This one's personal."

Return ONLY a JSON object with this exact structure:
{
  "hook": "hook content here (3-4 lines)",
  "backstory": "backstory content here",
  "receipts": ["bullet 1", "bullet 2", "bullet 3", "bullet 4"],
  "pressurePoint": "pressure point content here",
  "stakes": {
    "win": ["consequence 1", "consequence 2", "consequence 3"],
    "lose": ["consequence 1", "consequence 2"]
  },
  "cta": "Full story below."
}
`;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-pro',
            contents: generationPrompt,
            config: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        hook: { type: Type.STRING },
                        backstory: { type: Type.STRING },
                        receipts: { type: Type.ARRAY, items: { type: Type.STRING } },
                        pressurePoint: { type: Type.STRING },
                        stakes: {
                            type: Type.OBJECT,
                            properties: {
                                win: { type: Type.ARRAY, items: { type: Type.STRING } },
                                lose: { type: Type.ARRAY, items: { type: Type.STRING } }
                            },
                            required: ['win', 'lose']
                        },
                        cta: { type: Type.STRING }
                    },
                    required: ['hook', 'backstory', 'receipts', 'pressurePoint', 'stakes', 'cta']
                }
            }
        });

        return JSON.parse(response.text);
    } catch (error: any) {
        console.error('Error in generation phase:', error);
        throw new Error(`Generation phase failed: ${error.message}`);
    }
}

/**
 * Phase 3: Validate facts and rewrite if needed
 */
async function validateAndRewrite(
    ai: GoogleGenAI,
    narrative: NarrativeCard,
    context: HeatArticleContext,
    structuredContent: StructuredContent,
    researchData: string
): Promise<{ tweet: string; reddit: { title: string; body: string } }> {
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

**GENERATED CONTENT:**
${JSON.stringify(structuredContent, null, 2)}

**VALIDATION TASK:**
1. Check all team names, player names, stats, dates, and quotes for accuracy
2. Verify transaction history and personal context
3. If you find ANY inaccuracies, factual errors, or unverifiable claims:
   - Rewrite the affected sections
   - Keep the same structure and emotional tone
   - Only use verified information
4. If everything is accurate, return the content as-is

**OUTPUT FORMAT:**

First, format the structured content into:

🐦 TWITTER/X VERSION:
- 220-280 words total
- Line breaks every 1-2 lines
- Feels like a live broadcast of a story
- Combine all sections into one flowing narrative

🧵 REDDIT VERSION:
- Title: Engaging title (max 300 chars) that captures the narrative angle
- Body: Start with "Thought this was an insane storyline going into tonight's game:" then expand all sections
- Add 1-2 extra stats in receipts section
- Expand stakes section with playoff/season implications
- End with: "How do you see this one playing out?"

Return ONLY a JSON object:
{
  "tweet": "formatted tweet content here",
  "reddit": {
    "title": "reddit title here",
    "body": "reddit body content here"
  },
  "validationNotes": "Any issues found and how they were fixed, or 'All facts verified'"
}
`;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-pro',
            contents: validationPrompt,
            config: {
                tools: [{ googleSearch: {} }],
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        tweet: { type: Type.STRING },
                        reddit: {
                            type: Type.OBJECT,
                            properties: {
                                title: { type: Type.STRING },
                                body: { type: Type.STRING }
                            },
                            required: ['title', 'body']
                        },
                        validationNotes: { type: Type.STRING }
                    },
                    required: ['tweet', 'reddit', 'validationNotes']
                }
            }
        });

        const result = JSON.parse(response.text);
        console.log('Validation notes:', result.validationNotes);
        
        return {
            tweet: result.tweet || '',
            reddit: {
                title: result.reddit?.title || '',
                body: result.reddit?.body || ''
            }
        };
    } catch (error: any) {
        console.error('Error in validation phase:', error);
        throw new Error(`Validation phase failed: ${error.message}`);
    }
}

/**
 * Main function: Generate Twitter and Reddit content for a Heat Article narrative
 */
export async function generateHeatArticleContent(
    narrative: NarrativeCard,
    context: HeatArticleContext
): Promise<GeneratedContent> {
    const apiKey = import.meta.env.VITE_GEMINI_API_KEY || (window as any).process?.env?.API_KEY || '';
    if (!apiKey) {
        throw new Error('API key not available');
    }

    const ai = new GoogleGenAI({ apiKey });

    try {
        // Phase 1: Research
        console.log('[Heat Article Content] Phase 1: Researching narrative context...');
        const researchData = await researchNarrativeContext(ai, narrative, context);

        // Phase 2: Generate structured content
        console.log('[Heat Article Content] Phase 2: Generating structured content...');
        const structuredContent = await generateStructuredContent(ai, narrative, context, researchData);

        // Phase 3: Validate and format
        console.log('[Heat Article Content] Phase 3: Validating facts and formatting...');
        const finalContent = await validateAndRewrite(ai, narrative, context, structuredContent, researchData);

        return finalContent;
    } catch (error: any) {
        console.error('Error generating Heat Article content:', error);
        throw new Error(`Failed to generate content: ${error.message || 'Unknown error'}`);
    }
}
