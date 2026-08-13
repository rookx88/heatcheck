// ===================================================================================
// HEATCHECKS TANK — STAGE 4 GENERATION (tank-generate.ts)
// ===================================================================================
// One Anthropic call per SelectedProp. The system prompt (tank-narrative-prompt.ts) is
// a required external input, not authored here.
//
// Deliberately environment-agnostic (no fs/path, no process.env reads): this module is
// called both from Node contexts (backend.ts, scripts/seed-tank-starter-pages.ts) and
// from functions/api/curate.ts, a Cloudflare Pages Function where neither of those
// exists. Callers pass config in explicitly instead.
// ===================================================================================

import type { Pool } from 'pg';
import Anthropic from '@anthropic-ai/sdk';
import type { Prop, Game, TankArticle } from './tank-types';
import { TANK_NARRATIVE_PROMPT } from './scripts/prompts/tank-narrative-prompt';

export interface GenerationConfig {
    apiKey: string;
    model?: string;
    maxTokens?: number;
}

const REQUIRED_KEYS = ['seo', 'body', 'tagline', 'hook', 'cards', 'call'] as const;

export function extractJson(text: string): string {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return fenced[1].trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
        return text.slice(start, end + 1);
    }
    return text.trim();
}

// Models writing a multi-paragraph "body" field sometimes emit literal newlines
// inside a JSON string value instead of escaping them as \n, which strict
// JSON.parse rejects. Walk the text tracking string/escape state and escape any
// raw control character found inside a string literal, leaving valid JSON untouched.
function repairJsonControlChars(text: string): string {
    let result = '';
    let inString = false;
    let escapeNext = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (escapeNext) {
            result += ch;
            escapeNext = false;
            continue;
        }
        if (ch === '\\' && inString) {
            result += ch;
            escapeNext = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            result += ch;
            continue;
        }
        if (inString) {
            if (ch === '\n') { result += '\\n'; continue; }
            if (ch === '\r') { result += '\\r'; continue; }
            if (ch === '\t') { result += '\\t'; continue; }
        }
        result += ch;
    }
    return result;
}

export function parseModelJson(jsonText: string): any {
    try {
        return JSON.parse(jsonText);
    } catch {
        // Fall back to the repaired text; let this throw naturally (caught by the caller) if still broken.
        return JSON.parse(repairJsonControlChars(jsonText));
    }
}

function validateTankArticle(value: any): value is TankArticle {
    if (!value || typeof value !== 'object') return false;
    for (const key of REQUIRED_KEYS) {
        if (!(key in value)) return false;
    }
    if (!value.seo?.title || !value.seo?.meta_description || !value.seo?.slug) return false;
    if (typeof value.body !== 'string' || typeof value.hook !== 'string') return false;
    if (typeof value.tagline !== 'string') return false;
    if (!Array.isArray(value.cards)) return false;
    if (!value.call?.question || !Array.isArray(value.call?.sides)) return false;
    return true;
}

export interface GenerationResult {
    parsed: TankArticle | null;
    rawText: string;
    error: string | null;
}

async function callAnthropicOnce(systemPrompt: string, userPayload: object, config: GenerationConfig): Promise<string> {
    const client = new Anthropic({ apiKey: config.apiKey });
    const model = config.model || 'claude-sonnet-5';
    const maxTokens = config.maxTokens ?? 1000;

    const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        // Extended thinking is on by default for this model and its thinking tokens
        // count against the same max_tokens budget as the actual output - since that
        // count varies per call, it was intermittently starving the JSON response of
        // room to finish (confirmed via response.usage.output_tokens_details during
        // debugging: thinking_tokens sometimes left too little budget for the text
        // block, truncating mid-JSON). Disabling it makes the full budget available
        // to the actual response every time.
        thinking: { type: 'disabled' },
        system: systemPrompt,
        messages: [{ role: 'user', content: JSON.stringify(userPayload) }],
    });

    const textBlock = response.content.find(block => block.type === 'text');
    return textBlock && 'text' in textBlock ? textBlock.text : '';
}

// Generates one TankArticle from a single selected prop. Never throws on a malformed
// model response - retries once, then returns the failure for the caller to surface
// rather than letting bad JSON render.
export async function generateTankArticle(
    prop: Prop,
    angle: string,
    game: Game,
    facts: string[] = [],
    config: GenerationConfig
): Promise<GenerationResult> {
    const userPayload = {
        prop,
        angle,
        game_context: { league: game.league, away: game.away, home: game.home, kickoff: game.kickoff },
        facts,
    };

    for (let attempt = 0; attempt < 2; attempt++) {
        let rawText = '';
        try {
            rawText = await callAnthropicOnce(TANK_NARRATIVE_PROMPT, userPayload, config);
            const jsonText = extractJson(rawText);
            const parsed = parseModelJson(jsonText);
            if (validateTankArticle(parsed)) {
                return { parsed, rawText, error: null };
            }
            console.warn(`[Tank] Generation attempt ${attempt + 1} produced invalid TankArticle shape for prop ${prop.id}`);
        } catch (err: any) {
            console.warn(`[Tank] Generation attempt ${attempt + 1} failed for prop ${prop.id}:`, err.message);
            if (attempt === 1) {
                return { parsed: null, rawText, error: err.message };
            }
        }
    }

    return { parsed: null, rawText: '', error: 'Model response did not match the required TankArticle shape after retry.' };
}

// --- DB setup -------------------------------------------------------------------------

export async function ensureTankPagesTable(pool: Pool): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS tank_pages (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            slug VARCHAR(255),
            provider VARCHAR(50) NOT NULL,
            league VARCHAR(50) NOT NULL,
            angle TEXT NOT NULL,
            game_snapshot JSONB NOT NULL,
            model_output JSONB,
            raw_output TEXT,
            generation_error TEXT,
            status VARCHAR(20) NOT NULL DEFAULT 'draft',
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            published_at TIMESTAMP WITH TIME ZONE
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tank_pages_slug ON tank_pages(slug) WHERE slug IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_tank_pages_status ON tank_pages(status);
        CREATE INDEX IF NOT EXISTS idx_tank_pages_league ON tank_pages(league);
        CREATE INDEX IF NOT EXISTS idx_tank_pages_created_at ON tank_pages(created_at DESC);
    `);
}
