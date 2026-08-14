// One Anthropic call to draft the newsletter's Character/Lore Spotlight section. Mirrors
// tank-generate.ts's shape (same retry-once-then-surface-the-failure behavior, same
// environment-agnostic no fs/process.env design so it can run from backend.ts today and
// a Pages Function later without changes) but is deliberately its own module rather than
// reusing tank-generate.ts's internals - the output shape (title/body, no cards/call) is
// different enough that folding it into TankArticle's validation would just add branching.
//
// This never auto-publishes: the draft it returns is for a human to edit and approve via
// the Newsletter Issue admin panel (backend.ts), same discipline as functions/api/curate.ts.

import Anthropic from '@anthropic-ai/sdk';
import { NEWSLETTER_LORE_PROMPT } from './scripts/prompts/newsletter-lore-prompt';
import { extractJson, parseModelJson } from './tank-generate';

export interface LoreGenerationConfig {
    apiKey: string;
    model?: string;
    maxTokens?: number;
}

export interface LoreSpotlight {
    title: string;
    body: string;
}

export interface LoreGenerationResult {
    parsed: LoreSpotlight | null;
    rawText: string;
    error: string | null;
}

function validateLoreSpotlight(value: any): value is LoreSpotlight {
    return !!value && typeof value === 'object'
        && typeof value.title === 'string' && value.title.trim().length > 0
        && typeof value.body === 'string' && value.body.trim().length > 0;
}

async function callAnthropicOnce(userPayload: object, config: LoreGenerationConfig): Promise<string> {
    const client = new Anthropic({ apiKey: config.apiKey });
    const response = await client.messages.create({
        model: config.model || 'claude-sonnet-5',
        max_tokens: config.maxTokens ?? 600,
        thinking: { type: 'disabled' },
        system: NEWSLETTER_LORE_PROMPT,
        messages: [{ role: 'user', content: JSON.stringify(userPayload) }],
    });
    const textBlock = response.content.find(block => block.type === 'text');
    return textBlock && 'text' in textBlock ? textBlock.text : '';
}

export async function generateLoreSpotlight(
    topic: string,
    facts: string[] = [],
    config: LoreGenerationConfig
): Promise<LoreGenerationResult> {
    const userPayload = { topic, facts };

    for (let attempt = 0; attempt < 2; attempt++) {
        let rawText = '';
        try {
            rawText = await callAnthropicOnce(userPayload, config);
            const parsed = parseModelJson(extractJson(rawText));
            if (validateLoreSpotlight(parsed)) {
                return { parsed, rawText, error: null };
            }
            console.warn(`[Newsletter] Lore generation attempt ${attempt + 1} produced invalid shape for topic "${topic}"`);
        } catch (err: any) {
            console.warn(`[Newsletter] Lore generation attempt ${attempt + 1} failed:`, err.message);
            if (attempt === 1) {
                return { parsed: null, rawText, error: err.message };
            }
        }
    }

    return { parsed: null, rawText: '', error: 'Model response did not match the required {title, body} shape after retry.' };
}
