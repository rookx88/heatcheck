import { GoogleGenAI, Type } from '@google/genai';

interface DFSPlayer {
    rank: number;
    playerName: string;
    position: string;
    team: string;
    opponent: string;
    salary: number;
    narrative?: string;
    analysis?: string;
    edge?: string;
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
async function researchPlayerNarrative(
    ai: GoogleGenAI,
    player: DFSPlayer,
    league: 'NBA' | 'NFL',
    matchupDate: string
): Promise<string> {
    const researchPrompt = `
You are a sports narrative researcher. Your task is to find compelling backstory, emotional evidence, stats, and quotes for a player.

**PLAYER DATA:**
- Name: ${player.playerName}
- Position: ${player.position}
- Team: ${player.team}
- Opponent: ${player.opponent}
- Salary: $${player.salary}
- Date: ${matchupDate}
- League: ${league}
${player.narrative ? `- Existing Narrative: ${player.narrative}` : ''}
${player.analysis ? `- Existing Analysis: ${player.analysis}` : ''}
${player.edge ? `- Existing Edge: ${player.edge}` : ''}

**RESEARCH TASK:**
Research and compile:
1. Backstory: Why this matchup matters to the player (trades, previous games, personal history, team history)
2. Emotional Evidence: Quotes from player, coach, media about this matchup or situation
3. Stats: Relevant historical stats, previous matchup results, recent performance trends
4. Narrative Angles: Revenge, redemption, legacy, respect, pride themes
5. Transaction History: Any trades, releases, or contract situations relevant to this matchup
6. Personal Context: Injuries, milestones, career moments that add emotional weight

Return a comprehensive research summary in JSON format:
{
  "backstory": "Detailed backstory context...",
  "quotes": ["quote 1", "quote 2", "quote 3"],
  "stats": ["stat 1", "stat 2", "stat 3"],
  "transactionHistory": "Relevant transaction details...",
  "personalContext": "Personal milestones or context...",
  "emotionalThemes": ["theme1", "theme2", "theme3"]
}

Be thorough and find real, verifiable information. If you cannot find specific information, note that clearly.
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
                        emotionalThemes: { type: Type.ARRAY, items: { type: Type.STRING } }
                    },
                    required: ['backstory', 'quotes', 'stats', 'transactionHistory', 'personalContext', 'emotionalThemes']
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
    player: DFSPlayer,
    league: 'NBA' | 'NFL',
    matchupDate: string,
    researchData: string
): Promise<StructuredContent> {
    const generationPrompt = `
You are a viral sports content creator. Generate compelling narrative-driven content using this structured framework.

**PLAYER DATA:**
- Name: ${player.playerName}
- Position: ${player.position}
- Team: ${player.team}
- Opponent: ${player.opponent}
- Salary: $${player.salary}
- Date: ${matchupDate}
- League: ${league}

**RESEARCH DATA:**
${researchData}

**CONTENT FRAMEWORK:**

🧩 SECTION 1 — The Hook (3–4 lines max)
- Create emotional tension in < 3 seconds
- Short lines, plain language, no hashtags, no emojis
- Sounds like a human telling a secret
- Template: "[Player] didn't want this. They were never supposed to be here. [Organization/Opponent] let them walk. And now with [stakes] on the line, they get a chance to change everything."

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
    player: DFSPlayer,
    league: 'NBA' | 'NFL',
    structuredContent: StructuredContent,
    researchData: string
): Promise<{ tweet: string; reddit: { title: string; body: string } }> {
    const validationPrompt = `
You are a fact-checker for sports content. Validate the following content for accuracy.

**PLAYER DATA:**
- Name: ${player.playerName}
- Position: ${player.position}
- Team: ${player.team}
- Opponent: ${player.opponent}
- League: ${league}

**RESEARCH DATA:**
${researchData}

**GENERATED CONTENT:**
${JSON.stringify(structuredContent, null, 2)}

**VALIDATION TASK:**
1. Check all player names, team names, stats, dates, and quotes for accuracy
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
- Title: Engaging title (max 300 chars) starting with "[${league}]" or similar
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
            model: 'gemini-2.0-flash-exp',
            contents: validationPrompt,
            config: {
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
 * Main function: Generate Twitter and Reddit content for a DFS player
 */
export async function generateDFSContent(
    player: DFSPlayer,
    league: 'NBA' | 'NFL',
    matchupDate: string
): Promise<GeneratedContent> {
    const apiKey = import.meta.env.VITE_GEMINI_API_KEY || (window as any).process?.env?.API_KEY || '';
    if (!apiKey) {
        throw new Error('API key not available');
    }

    const ai = new GoogleGenAI({ apiKey });

    try {
        // Phase 1: Research
        console.log('[DFS Content] Phase 1: Researching player narrative...');
        const researchData = await researchPlayerNarrative(ai, player, league, matchupDate);

        // Phase 2: Generate structured content
        console.log('[DFS Content] Phase 2: Generating structured content...');
        const structuredContent = await generateStructuredContent(ai, player, league, matchupDate, researchData);

        // Phase 3: Validate and format
        console.log('[DFS Content] Phase 3: Validating facts and formatting...');
        const finalContent = await validateAndRewrite(ai, player, league, structuredContent, researchData);

        return finalContent;
    } catch (error: any) {
        console.error('Error generating DFS content:', error);
        throw new Error(`Failed to generate content: ${error.message || 'Unknown error'}`);
    }
}
