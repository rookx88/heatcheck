import { GoogleGenAI } from "@google/genai";
import { HeatCheckResponse, MatchupRequest } from "../types";

const parseJSON = (text: string) => {
  try {
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    
    if (firstBrace === -1 || lastBrace === -1) {
       const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
       return JSON.parse(cleaned);
    }

    const jsonString = text.substring(firstBrace, lastBrace + 1);
    return JSON.parse(jsonString);
  } catch (e) {
    console.error("Failed to parse JSON", e);
    throw new Error("Invalid response format from AI. The model generated text that could not be parsed.");
  }
};

export const generateNarrative = async (request: MatchupRequest): Promise<HeatCheckResponse> => {
  if (!process.env.API_KEY) {
    throw new Error("API Key is missing");
  }

  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

  // The System Architect Prompt
  const prompt = `
    You are the HEATCHECK AI, an expert sports systems architect.
    CURRENT DATE: ${new Date().toLocaleDateString()}
    
    GOAL: Build a "Hidden Narrative" engine output for the matchup: ${request.teamA} vs ${request.teamB} (${request.sport}).
    ${request.context ? `CONTEXT: ${request.context}` : ''}

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
    - **RULE:** If a Narrative Card relies on a person (e.g., "Nuno's Revenge") and Phase 2 revealed they are NO LONGER with the team (fired/traded), you MUST:
      1. MODIFY the narrative to reflect the *aftermath* (e.g., "The Shadow of Nuno" or "The Post-Nuno Chaos").
      2. OR discard the narrative entirely if it no longer makes sense.
    - Do NOT write an article assuming a fired coach is still on the sidelines.
    - Log any pivots you made in the "corrections_applied" field.
    
    PHASE 6: OUTPUT
    - Generate the Article in Markdown.
    - Return the EXACT JSON SCHEMA below.
    
    REQUIRED JSON SCHEMA:
    {
      "run_meta": { "timestamp_utc": "string", "notes": "string" },
      "matchups": [
        {
          "match_id": "string",
          "league": "${request.sport}",
          "teams": { "home": "${request.teamA}", "away": "${request.teamB}" },
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

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
      }
    });

    const text = response.text;
    if (!text) throw new Error("No response from AI");

    return parseJSON(text);

  } catch (error) {
    console.error("Gemini API Error:", error);
    throw error;
  }
};