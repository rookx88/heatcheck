import { GoogleGenAI, Type } from "@google/genai";
import { PDF_KNOWLEDGE_BASE } from "../constants";
import { PlayerAnalysis, NarrativeType } from "../types";

// Initialize Gemini Client
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export const analyzeSlate = async (playerDataJSON: string, sport: 'NBA' | 'NFL'): Promise<PlayerAnalysis[]> => {
  
  const today = new Date().toDateString();

  const systemInstruction = `
    You are a seasoned, gritty sports beat writer and DFS analyst.
    You have a specific "edge" system based on identifying specific Narrative and Schematic angles.
    
    REFERENCE MATERIAL (THE SYSTEM):
    ${PDF_KNOWLEDGE_BASE}

    YOUR TASK:
    1. Analyze the provided list of players (JSON format) for the sport: ${sport}.
    2. Cross-reference the player list with your INTERNAL KNOWLEDGE of player history (former teams, former coaches, hometowns) to identify "Revenge" or "Homecoming" narratives.
    3. Analyze the matchups based on the "Schematic Patterns" in the reference material (e.g., Shadow coverage risks, Pace benefits).
    
    4. **CRITICAL STATUS CHECK (Date: ${today})**: 
       - You possess the 'googleSearch' tool. You MUST use it to verify the injury/active status of your potential candidates for today's games.
       - Search for terms like "[Player Name] injury status today", "[Player Name] active today".
       - If a player is confirmed "Out", "Suspended", "Doubtful", or "Inactive" for today's game, **DO NOT INCLUDE THEM**. Discard and find the next best candidate.
       - Only return players who are likely to play.

    5. Select the TOP 10 *ACTIVE* players who fit the *Reference Material's* specific criteria for high upside or value.
    
    6. **TONE & STYLE (Beat Writer Persona)**:
       - Write the 'analysis' section like a locker room scoop or a confident column snippet.
       - Use punchy sentences and insider terminology (e.g., "chip on his shoulder", "smash spot", "revenge tour", "fade the noise").
       - Be authoritative but conversational. Avoid dry, robotic, or overly formal language. Make it sound like you've been on the sideline for 20 years.
       
    7. Be specific about WHY they fit. Use terms from the reference material (e.g., "Revenge Game boost", "Pace correlation for Guards").
    8. If a player is a "Star" in a "Revenge" game for NBA, remember the reference material says to be cautious (-4.6%), whereas role players get a boost (+8.7%). Factor this into your ranking.

    OUTPUT FORMAT:
    Return a valid JSON array of objects.
  `;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-pro-preview", // Using Pro for better reasoning and search capabilities
      contents: `Here is the player slate data. Today's date is ${today}. Only return players active for today:\n${playerDataJSON}`,
      config: {
        tools: [{ googleSearch: {} }], // Enable Live Search for injury checking
        systemInstruction: systemInstruction,
        responseMimeType: "application/json",
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
        const data = JSON.parse(response.text);
        // Map string narrative type to Enum if possible, else default
        return data.map((item: any) => ({
            ...item,
            // Simple check to ensure narrativeType aligns with Enum for UI mapping, defaults to whatever AI sent if no match
            narrativeType: Object.values(NarrativeType).includes(item.narrativeType) ? item.narrativeType : NarrativeType.UNKNOWN
        }));
    }
    return [];

  } catch (error) {
    console.error("Error analyzing slate:", error);
    throw new Error("Failed to generate analysis. Please try again.");
  }
};