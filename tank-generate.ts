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
import type { TimeContext } from './tank-curation';
import { toWriterProp, toWriterMarketContext, type MarketContext } from './market-movement';
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
//
// `timeContext` is OPTIONAL and trailing on purpose: only the v2 curation path
// (functions/api/curate.ts) can compute it, while backend.ts's manual curator route and
// scripts/seed-tank-starter-pages.ts call this with no notion of when the storyline
// broke. The narrative prompt's time-anchor rule is written to fire only when this is
// present - the model has no clock of its own, so requiring an anchor without supplying
// these numbers would be instructing it to invent one, which is precisely what the
// "never invent" rule exists to stop.
//
// `marketContext` is optional and trailing for the same reason: only curation measures
// it (market-movement.ts). And the writer is shown the prop through toWriterProp, which
// drops the order book and every price - it used to receive prop.odds with its prices,
// i.e. numbers it was forbidden to quote sitting in its own input. The one price it may
// now see is market_context's.
export async function generateTankArticle(
    prop: Prop,
    angle: string,
    game: Game,
    facts: string[] = [],
    config: GenerationConfig,
    timeContext?: TimeContext,
    marketContext?: MarketContext
): Promise<GenerationResult> {
    const userPayload = {
        prop: toWriterProp(prop),
        angle,
        game_context: { league: game.league, away: game.away, home: game.home, kickoff: game.kickoff },
        facts,
        ...(timeContext ? { time_context: timeContext } : {}),
        ...(marketContext ? { market_context: toWriterMarketContext(marketContext) } : {}),
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

// CREATE IF NOT EXISTS *plus* the ALTERs, deliberately. This used to be a bare CREATE
// mirroring create_tank_pages_table.sql, which meant it silently drifted every time a
// column was added by a hand-run migration: a DB bootstrapped only through this function
// was missing `visibility` (which ~15 queries filter on) and `discord_posted_at`, and
// nothing surfaced that until a query failed. The ALTERs are all IF NOT EXISTS, so this
// stays idempotent and is a no-op against a database the .sql files already migrated -
// it just means a fresh dev/acceptance DB is correct on the first run.
//
// Adding a column to tank_pages? Add it BOTH here and in its own add_*.sql file. The
// .sql file is what gets run against production; this is what a fresh local DB gets.
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

        -- add_visibility_to_tank_pages.sql
        ALTER TABLE tank_pages ADD COLUMN IF NOT EXISTS visibility VARCHAR(20) NOT NULL DEFAULT 'app';
        -- add_discord_posted_at_to_tank_pages.sql
        ALTER TABLE tank_pages ADD COLUMN IF NOT EXISTS discord_posted_at TIMESTAMP WITH TIME ZONE;
        -- add_curation_and_resolution_to_tank_pages.sql
        ALTER TABLE tank_pages ADD COLUMN IF NOT EXISTS curation JSONB;
        ALTER TABLE tank_pages ADD COLUMN IF NOT EXISTS resolution JSONB;
        ALTER TABLE tank_pages ADD COLUMN IF NOT EXISTS resolution_attempts INT NOT NULL DEFAULT 0;
        ALTER TABLE tank_pages ADD COLUMN IF NOT EXISTS resolution_checked_at TIMESTAMP WITH TIME ZONE;

        CREATE UNIQUE INDEX IF NOT EXISTS idx_tank_pages_slug ON tank_pages(slug) WHERE slug IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_tank_pages_status ON tank_pages(status);
        CREATE INDEX IF NOT EXISTS idx_tank_pages_league ON tank_pages(league);
        CREATE INDEX IF NOT EXISTS idx_tank_pages_created_at ON tank_pages(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_tank_pages_visibility ON tank_pages(visibility);
        CREATE INDEX IF NOT EXISTS idx_tank_pages_resolution_pending
            ON tank_pages (resolution_attempts, published_at DESC)
            WHERE status = 'published' AND resolution IS NULL;
    `);
}
