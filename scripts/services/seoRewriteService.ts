import { GoogleGenAI, Type } from '@google/genai';

interface HeatcheckPost {
    id: string;
    league: string;
    teamA: string;
    teamB: string;
    matchupScheduledDate?: string;
    websiteStory: {
        headline: string;
        dek: string;
        theBackstory: string;
        seo: {
            slug: string;
            metaTitle: string;
            metaDescription: string;
        };
    };
    heatCheckData?: {
        factPack?: any;
        article?: {
            long_form_markdown?: string;
        };
    };
}

interface FactPack {
    key_stats?: Array<{ label: string; value: string; why_it_matters?: string }>;
    odds?: any;
    context?: {
        recent_form?: any;
        injuries?: Array<{ name: string; team: string; status: string; reason?: string }>;
        standings?: any;
        venue?: any;
    };
    [key: string]: any;
}

export interface SEORewriteOutput {
    seoSlug: string; // Format: {team-a}-vs-{team-b}-prediction-{yyyy-mm-dd}
    seoTitle: string; // ≤60 characters
    metaDescription: string; // ≤155 characters
    h1Header: string; // Narrative-driven, pressure-focused
    rewrittenBody: string; // Improved article body
    heatchecksEdge?: string; // Optional 2-3 sentence summary
}

/**
 * Generate SEO-optimized rewrite of an article
 */
export async function rewriteArticleForSEO(
    post: HeatcheckPost,
    factPack?: FactPack
): Promise<SEORewriteOutput> {
    const apiKey = import.meta.env.VITE_GEMINI_API_KEY || (window as any).process?.env?.API_KEY || '';
    if (!apiKey) {
        throw new Error('API key not available');
    }

    const ai = new GoogleGenAI({ apiKey });

    // Extract date for slug
    const gameDate = post.matchupScheduledDate 
        ? new Date(post.matchupScheduledDate).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0];

    // Build context from factPack
    const keyStats = factPack?.key_stats?.map(s => `${s.label}: ${s.value}${s.why_it_matters ? ` (${s.why_it_matters})` : ''}`).join('\n') || 'None provided';
    const recentForm = factPack?.context?.recent_form || {};
    const injuries = factPack?.context?.injuries?.map(i => `${i.name} (${i.team}): ${i.status}${i.reason ? ` - ${i.reason}` : ''}`).join('\n') || 'None';
    const odds = factPack?.odds || {};

    const rewritePrompt = `
You are an SEO-focused sports analyst and narrative editor for HeatChecks.io.

Your task is to REWRITE an existing matchup article so it ranks for high-intent search queries (e.g. "{Team A} vs {Team B} prediction") while preserving HeatChecks' core identity: pressure, momentum, emotional edges, and data-backed storytelling.

**IMPORTANT CONSTRAINTS:**
- Do NOT invent stats
- Do NOT exaggerate certainty
- Maintain analytical, credible tone (not gambling hype)
- Assume reader is smart and betting-curious

**MATCHUP:**
- League: ${post.league}
- Teams: ${post.teamA} vs ${post.teamB}
- Game Date: ${gameDate}

**EXISTING ARTICLE:**
- Headline: ${post.websiteStory.headline}
- Current Body: ${post.websiteStory.theBackstory.substring(0, 2000)}${post.websiteStory.theBackstory.length > 2000 ? '...' : ''}

**AVAILABLE DATA:**
- Key Stats: ${keyStats}
- Recent Form: ${JSON.stringify(recentForm)}
- Injuries: ${injuries}
- Odds: ${JSON.stringify(odds)}

**YOUR OUTPUT MUST INCLUDE:**

### 1. SEO URL SLUG
Format EXACTLY as: {team-a}-vs-{team-b}-prediction-preview-{yyyy-mm-dd}
- Use lowercase, hyphens only
- Example: "seahawks-vs-rams-prediction-preview-2026-01-25"

### 2. SEO TITLE TAG (≤ 60 characters)
Requirements:
- Must include "Team A vs Team B"
- Must include the word "Prediction"
- Should hint at pressure or momentum without jargon
- Example: "Seahawks vs Rams Prediction: Pressure Points That Matter"

### 3. META DESCRIPTION (≤ 155 characters)
Requirements:
- Plain English
- Mention data, pressure, or momentum
- No hype, no emojis
- Example: "Seahawks vs Rams prediction using pressure data, momentum trends, and matchup context to find edges others miss."

### 4. H1 HEADER
Requirements:
- Narrative-driven
- Not identical to title
- Pressure-focused
- Example: "Seahawks vs Rams: Where Pressure Shifts This Matchup"

### 5. REWRITTEN ARTICLE BODY
Requirements:
- Improve clarity and flow
- Front-load matchup context (who, when, what's at stake)
- Explicitly reference pressure, momentum, or situational stress
- Tie odds and data to behavioral outcomes
- Avoid filler, clichés, or generic previews
- Length: similar to original (do NOT massively expand)
- Preserve HeatChecks identity (pressure, momentum, emotional edges)

### 6. OPTIONAL (If Applicable)
Add a short section titled "HeatChecks Edge"
Summarize the pressure-based angle in 2–3 sentences.
Do NOT give a hard betting pick.

**FINAL CHECK:**
- Would this page satisfy someone searching "{Team A} vs {Team B} prediction"?
- Does it still sound like HeatChecks (not a sportsbook blog)?

Return ONLY a JSON object with this exact structure:
{
  "seoSlug": "{team-a}-vs-{team-b}-prediction-preview-{yyyy-mm-dd}",
  "seoTitle": "Team A vs Team B Prediction: [pressure/momentum hint]",
  "metaDescription": "Plain English description mentioning data/pressure/momentum",
  "h1Header": "Narrative-driven, pressure-focused header",
  "rewrittenBody": "Improved article body with front-loaded context, explicit pressure references, tied to data",
  "heatchecksEdge": "Optional 2-3 sentence pressure-based angle summary (or null if not applicable)"
}
`;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-pro',
            contents: rewritePrompt,
            config: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        seoSlug: { type: Type.STRING },
                        seoTitle: { type: Type.STRING },
                        metaDescription: { type: Type.STRING },
                        h1Header: { type: Type.STRING },
                        rewrittenBody: { type: Type.STRING },
                        heatchecksEdge: { type: Type.STRING }
                    },
                    required: ['seoSlug', 'seoTitle', 'metaDescription', 'h1Header', 'rewrittenBody']
                }
            }
        });

        const result = JSON.parse(response.text);

        // Validate lengths
        if (result.seoTitle && result.seoTitle.length > 60) {
            result.seoTitle = result.seoTitle.substring(0, 57) + '...';
        }
        if (result.metaDescription && result.metaDescription.length > 155) {
            result.metaDescription = result.metaDescription.substring(0, 152) + '...';
        }

        return {
            seoSlug: result.seoSlug || '',
            seoTitle: result.seoTitle || '',
            metaDescription: result.metaDescription || '',
            h1Header: result.h1Header || '',
            rewrittenBody: result.rewrittenBody || '',
            heatchecksEdge: result.heatchecksEdge || undefined
        };
    } catch (error: any) {
        console.error('Error in SEO rewrite:', error);
        throw new Error(`Failed to rewrite article for SEO: ${error.message || 'Unknown error'}`);
    }
}

