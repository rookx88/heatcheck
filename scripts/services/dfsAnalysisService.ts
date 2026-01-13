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
You are a STRICT DFS validation system. Your job is to verify that each player in the provided list is CONFIRMED ACTIVE, PLAYING, and GETTING REGULAR PLAYING TIME in today's games (${today}).

For each player, you MUST:
1. Use Google Search to check their injury/active status for TODAY
2. Search for: "[Player Name] [Team] injury status today" or "[Player Name] active today [Date]" or "[Player Name] [Team] game status" or "[Player Name] minutes per game" or "[Player Name] playing time"
3. Verify they are on the ACTIVE ROSTER and NOT on IR/IL/Inactive List
4. Check if they are suspended, ruled out, or inactive
5. **CRITICAL: Check their recent playing time/minutes**
   - For NBA: Players should be getting at least 15-20 minutes per game regularly
   - For NFL: Players should be getting regular snaps/touches (not just special teams)
   - Look for recent game logs, minutes played, or snap counts
6. Look for official team injury reports or game status updates

VALIDATION RULES (STRICT - Require clear evidence of active status AND playing time):
- Mark as VALID ONLY if you find CLEAR evidence of:
  * "Active", "Expected to Play", "Probable", "Will Play", "Cleared to Play", "No Injury", "Healthy", or official roster confirmation
  * AND they are getting regular playing time (NBA: 15+ min/game, NFL: regular offensive/defensive snaps)
  * AND they are not in a "DNP - Coach's Decision" or "healthy scratch" situation
  
- Mark as INVALID if you find ANY evidence of:
  * "Out", "Suspended", "Doubtful", "Inactive", "IR", "IL", "Not Active", "Won't Play", "Ruled Out"
  * "Questionable" (unless explicitly stated they will play)
  * "Injury Report: Out", "Not Expected to Play"
  * **Low playing time**: NBA players averaging < 15 minutes per game, NFL players only on special teams
  * **DNP - Coach's Decision**: Players who are healthy but not getting minutes
  * **Healthy scratch**: Players who are active but not in the rotation
  * **G-League/Two-way players**: Players who are primarily in minor leagues
  * **End of bench players**: Players who rarely see the field/court
  
- If status is "Questionable" and you cannot find confirmation they WILL play, mark as INVALID
- If you cannot find clear evidence they are ACTIVE AND GETTING PLAYING TIME, mark as INVALID (default to invalid when uncertain)
- If search results are unavailable or unclear, mark as INVALID (we need confirmation)
- **If a player is technically "active" but hasn't played meaningful minutes in recent games, mark as INVALID**

IMPORTANT: This is a STRICT validation for DFS purposes. Only mark players as VALID if you have CONFIRMED evidence they are:
1. Playing today (not just active on roster)
2. Getting regular playing time/minutes (not bench warmers or emergency backups)

When in doubt about playing time, mark as INVALID. DFS requires players who actually contribute, not just players who are technically on the roster.

Return a JSON array with validation results for each player.
`;

  const playersToValidate = players.map(p => ({
    playerName: p.playerName,
    team: p.team,
    position: p.position
  }));

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-pro",
      contents: `Validate these players for today's ${sport} slate (${today}). Check if they are actually playing:\n${JSON.stringify(playersToValidate, null, 2)}`,
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
              isValid: { type: Type.BOOLEAN, description: "true ONLY if player is CONFIRMED ACTIVE, playing today, AND getting regular playing time/minutes. false if inactive, injured, or not getting meaningful minutes." },
              status: { type: Type.STRING, description: "Current status: 'Active', 'Out', 'Doubtful', 'Questionable', 'Suspended', 'Low Minutes', 'DNP', etc." },
              reason: { type: Type.STRING, description: "Detailed reason for validation result including playing time/minutes evidence found. If invalid, explain why (injury, low minutes, DNP, etc.)" }
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
            // Player wasn't in validation results, mark as INVALID (strict mode)
            invalidPlayers.push(`${player.playerName} (${player.team}) - Not found in validation results`);
          }
        });
      }
      
      console.log(`Validation complete: ${validPlayers.length} valid, ${invalidPlayers.length} invalid`);
      return { validPlayers, invalidPlayers };
    }
    
    // If validation fails to return text, mark all as invalid (strict mode)
    console.warn("Validation returned no text, marking all players as invalid (strict mode)");
    return { validPlayers: [], invalidPlayers: players.map(p => `${p.playerName} (${p.team}) - Validation failed`) };
  } catch (error) {
    console.error("Error validating DFS players:", error);
    // On error, mark all as invalid (strict mode)
    console.warn("Validation error occurred, marking all players as invalid (strict mode)");
    return { validPlayers: [], invalidPlayers: players.map(p => `${p.playerName} (${p.team}) - Validation error`) };
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
    
    4. **CRITICAL STATUS AND PLAYING TIME CHECK (Date: ${today})**: 
       - You possess the 'googleSearch' tool. You MUST use it to verify BOTH the injury/active status AND playing time of your potential candidates for today's games.
       - Search for terms like "[Player Name] injury status today", "[Player Name] active today", "[Player Name] minutes per game", "[Player Name] playing time", "[Player Name] recent games".
       - If a player is confirmed "Out", "Suspended", "Doubtful", or "Inactive" for today's game, **DO NOT INCLUDE THEM**. Discard and find the next best candidate.
       - **CRITICAL: Check playing time/minutes**:
         * For NBA: Only include players who are getting at least 15-20 minutes per game regularly. Exclude players who are "DNP - Coach's Decision", healthy scratches, or end-of-bench players.
         * For NFL: Only include players who are getting regular offensive/defensive snaps (not just special teams). Exclude players who are primarily special teams or emergency backups.
       - If a player is technically "active" but not getting meaningful playing time, **DO NOT INCLUDE THEM**.
       - Only return players who are likely to play AND likely to get meaningful minutes/snaps.

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

