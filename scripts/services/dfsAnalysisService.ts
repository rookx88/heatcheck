import { GoogleGenAI, Type } from "@google/genai";

// PDF Knowledge Base from the DFS player narratives example
const PDF_KNOWLEDGE_BASE = `
**Underutilized Narrative and Schematic Angles in NBA and NFL DFS**

**NBA: Emotional/Narrative Angles**
1. **Revenge/Homecoming Games:**
   - **Trend:** Favors role players/below-average players more than superstars.
   - **Data:** Below-average players see +8.7% boost facing former teams. All-Stars see -4.6% drop.
   - **Action:** Target cheap veterans or bench players in homecoming spots. Fade superstars in "revenge" games unless price is too low.

2. **"Belief" or Motivation Spikes:**
   - **Trend:** Players coming off criticism, contract snubs, or facing former coaches.
   - **Action:** Look for role players facing former teams or hometown crowds ("play harder").

**NBA: Scheme/Matchup Patterns**
1. **Team Pace:**
   - **Trend:** High pace benefits Guards (correlation +0.57) more than Wings/Centers.
   - **Action:** Overweight guards in games with two high-pace teams, even if defensive matchup is tough.

2. **Game Script (Blowouts & Rest):**
   - **Trend:** Starters sit in blowouts.
   - **Action:** In lopsided Vegas lines, look for backups (2nd half run). In close shootouts, even fringe bench players get run.

**NFL: Emotional/Narrative Angles**
1. **Revenge vs. Former Teams:**
   - **Trend:** 50% of players score above season average.
   - **Data:** WRs are most vengeful (41% outperform). Role players also see massive gains (e.g., Josh Oliver +7 points vs avg).
   - **Action:** Flag players in obvious revenge spotlights; treat as high-upside.

2. **Players vs. Former Coaches:**
   - **Trend:** Extra motivation facing a coach who benched/traded them.
   - **Action:** Lower-confidence "narrative fade-in".

**NFL: Scheme/Matchup Patterns**
1. **Shadow Coverage (CB vs WR):**
   - **Trend:** Top corners cap upside.
   - **Data:** Star WRs drop ~3-4 PPG when shadowed by elite corners.
   - **Action:** Fade expensive stud WRs likely to be shadowed. Target cheaper WR2/WR3s on the same team.

2. **Defensive Scheme Effects:**
   - **Trend:** Defenses funnel ball to unexpected players (e.g., blitz heavy = RB dump offs).
   - **Action:** Target RBs against teams with poor linebacker coverage or high "red zone receiving" allowed.

3. **Game Script (Vegas Lines):**
   - **Trend:** High favorite = Rushing/Clock Control. Underdog/High Total = Passing volume.
   - **Action:** Large spread favors RBs of winning team. High total + close spread favors Passing stacks.
`;

export enum NarrativeType {
  REVENGE = 'Revenge/Homecoming',
  MOTIVATION = 'Motivation/Belief',
  PACE = 'Scheme/Pace',
  GAME_SCRIPT = 'Game Script/Vegas',
  SHADOW = 'Shadow Coverage',
  DEFENSIVE_SCHEME = 'Defensive Scheme',
  UNKNOWN = 'General Value'
}

export interface PlayerAnalysis {
  rank: number;
  playerName: string;
  position: string;
  team: string;
  opponent: string;
  salary: string | number;
  narrativeType: string; // Using string instead of enum for flexibility
  confidenceScore: number; // 1-100
  analysis: string;
  keyStat?: string; // e.g., "+8.7% historical boost"
}

/**
 * Validate DFS players are actually playing today
 * Returns validated players and list of invalid players
 */
/**
 * Simple validation: Only check for injuries and if they played last game
 */
export const validateDFSPlayers = async (
  players: PlayerAnalysis[],
  sport: 'NBA' | 'NFL',
  originalPlayerData: any[]
): Promise<{ validPlayers: PlayerAnalysis[]; invalidPlayers: string[] }> => {
  const apiKey = (import.meta.env?.VITE_GEMINI_API_KEY as string) || 
                 (import.meta.env?.GEMINI_API_KEY as string) || 
                 (typeof process !== 'undefined' && (process.env?.API_KEY || process.env?.GEMINI_API_KEY)) || 
                 '';
  
  if (!apiKey) {
    throw new Error('Gemini API key is missing. Please set VITE_GEMINI_API_KEY in your .env.local file.');
  }

  const ai = new GoogleGenAI({ apiKey });
  const today = new Date().toDateString();

  const validationPrompt = `
You are a simple DFS validation system. For each player, check ONLY two things:

1. INJURY STATUS: Are they confirmed OUT, RULED OUT, or on IR/IL for today's game?
2. LAST GAME: Did they play in their team's most recent game?

For each player, use Google Search to check:
- "[Player Name] [Team] injury status today" or "[Player Name] ruled out"
- "[Player Name] [Team] last game" or "[Player Name] [Team] recent games"

VALIDATION RULES (SIMPLE):
- Mark as INVALID ONLY if:
  * They are confirmed "Out", "Ruled Out", "IR", "IL", or "Suspended" for today
  * They did NOT play in their team's last game AND there's no indication they're returning today
  
- Mark as VALID if:
  * They are "Active", "Questionable", "Probable", or any status other than confirmed "Out"
  * They played in their team's last game
  * Search results are unclear (default to valid)
  * No clear evidence they are out

IMPORTANT: 
- DO NOT check playing time or minutes
- DO NOT check if they're starters or bench players
- ONLY check: Are they injured/out? Did they play last game?
- When in doubt, mark as VALID

Return a JSON array with validation results for each player.
`;

  const playersToValidate = players.map(p => ({
    playerName: p.playerName,
    team: p.team,
    position: p.position
  }));

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash-exp",
      contents: `Check these players for injuries and if they played last game (${today}):\n${JSON.stringify(playersToValidate, null, 2)}`,
      config: {
        tools: [{ googleSearch: {} }],
        systemInstruction: validationPrompt,
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              playerName: { type: Type.STRING },
              team: { type: Type.STRING },
              isValid: { type: Type.BOOLEAN, description: "true if player is not confirmed out and played last game (or unclear). false ONLY if confirmed out/injured or did not play last game with no return indication." },
              status: { type: Type.STRING, description: "Current status: 'Active', 'Out', 'Played Last Game', 'Did Not Play', etc." },
              reason: { type: Type.STRING, description: "Brief reason: injury status and if they played last game." }
            },
            required: ["playerName", "isValid", "status", "reason"]
          }
        }
      }
    });

    if (response.text) {
      let jsonText = response.text.trim();
      const markdownMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (markdownMatch && markdownMatch[1]) {
        jsonText = markdownMatch[1].trim();
      }
      const firstBracket = jsonText.indexOf('[');
      const lastBracket = jsonText.lastIndexOf(']');
      if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
        jsonText = jsonText.substring(firstBracket, lastBracket + 1);
      }
      
      const validationResults = JSON.parse(jsonText);
      
      const validPlayers: PlayerAnalysis[] = [];
      const invalidPlayers: string[] = [];
      
      validationResults.forEach((result: any) => {
        // Try to match player by name (case-insensitive) and team
        const player = players.find(p => 
          p.playerName.toLowerCase().trim() === result.playerName.toLowerCase().trim() && 
          p.team.toUpperCase().trim() === result.team.toUpperCase().trim()
        );
        
        if (player) {
          if (result.isValid) {
            validPlayers.push(player);
          } else {
            invalidPlayers.push(`${result.playerName} (${result.team}) - ${result.reason || result.status || 'Invalid'}`);
          }
        } else {
          // If we can't match, try fuzzy matching
          console.warn(`Could not match validation result for ${result.playerName} (${result.team})`);
          const unmatchedPlayer = players.find(p => 
            p.playerName.toLowerCase().includes(result.playerName.toLowerCase()) ||
            result.playerName.toLowerCase().includes(p.playerName.toLowerCase())
          );
          if (unmatchedPlayer) {
            if (result.isValid) {
              validPlayers.push(unmatchedPlayer);
            } else {
              invalidPlayers.push(`${result.playerName} (${result.team}) - ${result.reason || result.status || 'Invalid'}`);
            }
          }
        }
      });
      
      // If we have fewer validated players than input, check if any weren't validated
      if (validPlayers.length + invalidPlayers.length < players.length) {
        const validatedNames = new Set([
          ...validPlayers.map(p => `${p.playerName}-${p.team}`.toLowerCase()),
          ...invalidPlayers.map(inv => {
            const match = inv.match(/^([^(]+)/);
            return match ? match[1].trim().toLowerCase() : '';
          })
        ]);
        players.forEach(player => {
          const key = `${player.playerName}-${player.team}`.toLowerCase();
          if (!validatedNames.has(key)) {
            // Player wasn't in validation results, mark as VALID (lenient mode)
            validPlayers.push(player);
          }
        });
      }
      
      console.log(`Validation complete: ${validPlayers.length} valid, ${invalidPlayers.length} invalid`);
      return { validPlayers, invalidPlayers };
    }
    
    // If validation fails to return text, mark all as valid (lenient mode)
    console.warn("Validation returned no text, defaulting to lenient mode - marking all players as valid");
    return { validPlayers: players, invalidPlayers: [] };
  } catch (error) {
    console.error("Error validating DFS players:", error);
    // On error, mark all as valid (lenient mode - trust the initial analysis)
    console.warn("Validation error occurred, defaulting to lenient mode - marking all players as valid");
    return { validPlayers: players, invalidPlayers: [] };
  }
};

export const analyzeDFSSlate = async (playerDataJSON: string, sport: 'NBA' | 'NFL'): Promise<PlayerAnalysis[]> => {
  // Get API key from environment (browser-compatible)
  const apiKey = (import.meta.env?.VITE_GEMINI_API_KEY as string) || 
                 (import.meta.env?.GEMINI_API_KEY as string) || 
                 (typeof process !== 'undefined' && (process.env?.API_KEY || process.env?.GEMINI_API_KEY)) || 
                 '';
  
  if (!apiKey) {
    throw new Error('Gemini API key is missing. Please set VITE_GEMINI_API_KEY in your .env.local file.');
  }

  const ai = new GoogleGenAI({ apiKey });
  const today = new Date().toDateString();

  const systemInstruction = `
    You are a seasoned, gritty sports beat writer and DFS analyst.
    You have a specific "edge" system based on identifying specific Narrative and Schematic angles.
    
    REFERENCE MATERIAL (THE SYSTEM):
    ${PDF_KNOWLEDGE_BASE}

    YOUR TASK:
    1. Analyze the provided list of players (JSON format) for the sport: ${sport}.
       - The player data will have fields: playerName, position, team, opponent, salary, avgPoints
       - You MUST use the exact values from the provided data for playerName, position, team, opponent, and salary
       - Do NOT use "undefined" or placeholder values - extract the actual data from the JSON
    
    2. Cross-reference the player list with your INTERNAL KNOWLEDGE of player history (former teams, former coaches, hometowns) to identify "Revenge" or "Homecoming" narratives.
    3. Analyze the matchups based on the "Schematic Patterns" in the reference material (e.g., Shadow coverage risks, Pace benefits).
    
    4. **STATUS CHECK (Date: ${today})**: 
       - You possess the 'googleSearch' tool. You SHOULD use it to verify the injury/active status of your potential candidates for today's games.
       - Search for terms like "[Player Name] injury status today", "[Player Name] active today", "[Player Name] ruled out".
       - If a player is confirmed "Out", "Ruled Out", "Suspended", or "Inactive" for today's game, **DO NOT INCLUDE THEM**. 
       - If a player is "Questionable", you may include them (assume they will play).
       - DO NOT exclude players based on playing time or minutes - only exclude if they are confirmed out or injured.
       - Focus on finding value plays with strong narrative angles, regardless of their typical playing time.

    5. Select the TOP 10 *ACTIVE* players who fit the *Reference Material's* specific criteria for high upside or value.
    
    6. **TONE & STYLE (Beat Writer Persona)**:
       - Write the 'analysis' section like a locker room scoop or a confident column snippet.
       - Use punchy sentences and insider terminology (e.g., "chip on his shoulder", "smash spot", "revenge tour", "fade the noise").
       - Be authoritative but conversational. Avoid dry, robotic, or overly formal language. Make it sound like you've been on the sideline for 20 years.
       
    7. Be specific about WHY they fit. Use terms from the reference material (e.g., "Revenge Game boost", "Pace correlation for Guards").
    8. If a player is a "Star" in a "Revenge" game for NBA, remember the reference material says to be cautious (-4.6%), whereas role players get a boost (+8.7%). Factor this into your ranking.

    OUTPUT FORMAT:
    **CRITICAL: You MUST return ONLY a valid JSON array. Do NOT include any explanatory text, comments, or text before or after the JSON array.**
    
    Return a valid JSON array of objects with these exact fields:
    - rank: integer (1-10)
    - playerName: string (from the provided data)
    - position: string (from the provided data)
    - team: string (from the provided data)
    - opponent: string (from the provided data)
    - salary: string or number (from the provided data)
    - narrativeType: string (e.g., "Revenge", "Pace", "Shadow", "Game Script", etc.)
    - confidenceScore: integer (1-100)
    - analysis: string (your beat writer analysis)
    - keyStat: string (optional, e.g., "+8.7% Boost")
    
    **IMPORTANT: Start your response with '[' and end with ']'. Do not add any text before the opening bracket or after the closing bracket.**
  `;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-pro", // Using same model as rest of codebase
      contents: `Here is the player slate data. Today's date is ${today}. Only return players active for today:\n${playerDataJSON}`,
      config: {
        tools: [{ googleSearch: {} }], // Enable Live Search for injury checking
        systemInstruction: systemInstruction,
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              rank: { type: Type.INTEGER },
              playerName: { type: Type.STRING },
              position: { type: Type.STRING },
              team: { type: Type.STRING },
              opponent: { type: Type.STRING },
              salary: { type: Type.STRING },
              narrativeType: { type: Type.STRING },
              confidenceScore: { type: Type.INTEGER, description: "1 to 100 based on narrative strength" },
              analysis: { type: Type.STRING, description: "Detailed reasoning in the style of a beat writer" },
              keyStat: { type: Type.STRING, description: "A punchy stat line, e.g., '+8.7% Boost'" }
            },
            required: ["rank", "playerName", "position", "team", "narrativeType", "analysis", "confidenceScore"]
          }
        }
      }
    });

    if (response.text) {
        // Extract JSON from response text (may be wrapped in markdown code blocks or have leading text)
        let jsonText = response.text.trim();
        
        console.log('[analyzeDFSSlate] Raw response length:', jsonText.length);
        console.log('[analyzeDFSSlate] Response preview (first 300 chars):', jsonText.substring(0, 300));
        
        // Try to extract JSON from markdown code blocks first
        const markdownMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (markdownMatch && markdownMatch[1]) {
            jsonText = markdownMatch[1].trim();
            console.log('[analyzeDFSSlate] Extracted from markdown block');
        }
        
        // Find first '[' and last ']' for array (handles text before/after JSON)
        let firstBracket = jsonText.indexOf('[');
        let lastBracket = jsonText.lastIndexOf(']');
        
        // If no brackets found, try multiple strategies
        if (firstBracket === -1 || lastBracket === -1 || lastBracket < firstBracket) {
            console.warn('[analyzeDFSSlate] No brackets found, attempting multiple extraction strategies...');
            
            // Strategy 1: Remove common prefixes and try again
            const cleanedText = jsonText.replace(/^(Alright,|Here|Here's|Here is|The|This|I|We|Sure,|Okay,)[\s\S]*?(\[)/i, '$2');
            if (cleanedText !== jsonText) {
                firstBracket = cleanedText.indexOf('[');
                lastBracket = cleanedText.lastIndexOf(']');
                if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
                    jsonText = cleanedText;
                    console.log('[analyzeDFSSlate] Found JSON after removing prefix');
                }
            }
            
            // Strategy 2: Look for JSON array pattern more flexibly
            if (firstBracket === -1 || lastBracket === -1 || lastBracket < firstBracket) {
                // Try to find any array-like structure
                const arrayPattern = /\[[\s\S]*?\]/;
                const arrayMatch = jsonText.match(arrayPattern);
                if (arrayMatch) {
                    jsonText = arrayMatch[0];
                    firstBracket = 0;
                    lastBracket = jsonText.length - 1;
                    console.log('[analyzeDFSSlate] Found JSON using pattern matching');
                }
            }
            
            // Strategy 3: Try to find JSON after common phrases
            if (firstBracket === -1 || lastBracket === -1 || lastBracket < firstBracket) {
                const phrases = [
                    /following players/i,
                    /top players/i,
                    /value plays/i,
                    /here are/i,
                    /here's/i,
                    /the players/i
                ];
                
                for (const phrase of phrases) {
                    const phraseIndex = jsonText.search(phrase);
                    if (phraseIndex !== -1) {
                        const afterPhrase = jsonText.substring(phraseIndex);
                        const foundBracket = afterPhrase.indexOf('[');
                        const foundLastBracket = afterPhrase.lastIndexOf(']');
                        if (foundBracket !== -1 && foundLastBracket !== -1 && foundLastBracket > foundBracket) {
                            jsonText = afterPhrase.substring(foundBracket, foundLastBracket + 1);
                            firstBracket = 0;
                            lastBracket = jsonText.length - 1;
                            console.log('[analyzeDFSSlate] Found JSON after phrase');
                            break;
                        }
                    }
                }
            }
            
            // Final check - if still no brackets, log and throw
            if (firstBracket === -1 || lastBracket === -1 || lastBracket < firstBracket) {
                console.error('[analyzeDFSSlate] Failed to extract JSON array from response');
                console.error('[analyzeDFSSlate] Full response (first 1000 chars):', jsonText.substring(0, 1000));
                console.error('[analyzeDFSSlate] Full response (last 500 chars):', jsonText.substring(Math.max(0, jsonText.length - 500)));
                throw new Error('No valid JSON array found in AI response. The response may contain explanatory text before the JSON or the AI may not have returned valid JSON.');
            }
        }
        
        // Extract the JSON portion
        if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
            jsonText = jsonText.substring(firstBracket, lastBracket + 1);
        }
        
        console.log('[analyzeDFSSlate] Extracted JSON length:', jsonText.length);
        console.log('[analyzeDFSSlate] Extracted JSON preview:', jsonText.substring(0, 200));
        
        // Try to parse the JSON
        let data;
        try {
            data = JSON.parse(jsonText);
        } catch (parseError) {
            console.error('[analyzeDFSSlate] JSON parse error:', parseError);
            console.error('[analyzeDFSSlate] Attempted to parse (first 500 chars):', jsonText.substring(0, 500));
            console.error('[analyzeDFSSlate] Attempted to parse (last 500 chars):', jsonText.substring(Math.max(0, jsonText.length - 500)));
            
            // Try one more time with additional cleaning
            try {
                // Remove any trailing text after the last ]
                const cleaned = jsonText.replace(/\]\s*[^\]]*$/, ']');
                data = JSON.parse(cleaned);
                console.log('[analyzeDFSSlate] Successfully parsed after additional cleaning');
            } catch (retryError) {
                throw new Error(`Failed to parse JSON from AI response: ${parseError instanceof Error ? parseError.message : 'Unknown error'}. Response may contain invalid JSON or explanatory text.`);
            }
        }
        
        // Validate that we got an array
        if (!Array.isArray(data)) {
            console.error('[analyzeDFSSlate] Response is not an array:', typeof data);
            console.error('[analyzeDFSSlate] Response value:', data);
            throw new Error('AI response is not a valid array. Expected array of player analyses.');
        }
        
        console.log(`[analyzeDFSSlate] Successfully parsed ${data.length} players`);
        
        // Map string narrative type to Enum if possible, else keep as string
        return data.map((item: any) => ({
            ...item,
            narrativeType: Object.values(NarrativeType).includes(item.narrativeType as NarrativeType) 
                ? item.narrativeType 
                : (item.narrativeType || NarrativeType.UNKNOWN)
        }));
    }
    return [];

  } catch (error) {
    console.error("Error analyzing slate:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to generate analysis: ${errorMessage}`);
  }
};

