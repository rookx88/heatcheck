// The Community Pick card as a rendered image - the brand system's card language
// (navy card, black plate, white box, watermark) with purple as the community
// identity. Flat hand-composed SVG through resvg's own text engine, same approach
// and shared pieces as me-card.ts. Landscape 720x420 - roughly half the pixel work
// of the proven-under-CPU-budget me-card. Returns null on any failure; the caller
// (community-pick-creation.ts) falls back to the branded purple embed so a pick can
// never fail to post.

import { Resvg } from '@resvg/resvg-wasm';
import { ensureWasmInit, getLogoDataUri, getDiscordIconDataUri } from './leaderboard-image';
import { FONT_BUFFERS, escapeXml } from './me-card';

const W = 720;
const H = 420;

const NAVY = '#0e0a38';
const PLATE = '#0c0c0e';
const GREEN = '#31e874';
const PURPLE = '#a986ff';
const WHITE = '#ffffff';

export interface CommunityPickImageInput {
    questionText: string;
    sideALabel: string;
    sideBLabel: string;
    sideAPoints: number;
    sideBPoints: number;
    resolveDate: string; // ISO 8601
}

// Greedy word-wrap into at most maxLines lines of ~maxChars, ellipsizing overflow.
function wrapLines(text: string, maxChars: number, maxLines: number): string[] {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
        if ((current + ' ' + word).trim().length <= maxChars) {
            current = (current + ' ' + word).trim();
        } else {
            lines.push(current);
            current = word;
            if (lines.length === maxLines) break;
        }
    }
    if (lines.length < maxLines && current) lines.push(current);
    if (lines.length > maxLines || (lines.length === maxLines && current && !lines.includes(current))) {
        lines.length = maxLines;
        lines[maxLines - 1] = lines[maxLines - 1].slice(0, maxChars - 1) + '…';
    }
    return lines;
}

let lastCpError: string | null = null;
export function getLastCpImageError(): string | null {
    return lastCpError;
}

export async function renderCommunityPickImage(input: CommunityPickImageInput): Promise<Uint8Array | null> {
    try {
        await ensureWasmInit();

        const resolveDateLabel = new Date(input.resolveDate).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
        });
        const qLines = wrapLines(input.questionText, 38, 2);
        const qSize = qLines.length > 1 || input.questionText.length > 30 ? 26 : 30;

        // Side pills: green-outlined black pills, one per side, stacked - labels can
        // be long team names, so full-width rows beat side-by-side squeezing.
        const pill = (y: number, label: string, pts: number) => {
            const text = escapeXml(`${label}  ·  ${pts} pts`);
            const size = text.length > 34 ? 19 : 22;
            return `<rect x="70" y="${y}" width="${W - 140}" height="52" rx="12" fill="${PLATE}" stroke="${GREEN}" stroke-width="3"/>` +
                `<text x="${W / 2}" y="${y + 34}" text-anchor="middle" font-family="Anton" font-size="${size}" fill="${GREEN}">${text}</text>`;
        };

        const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect x="3" y="3" width="${W - 6}" height="${H - 6}" rx="30" fill="${NAVY}" stroke="${PLATE}" stroke-width="6"/>
<rect x="${W / 2 - 170}" y="26" width="340" height="52" rx="16" fill="${PLATE}"/>
<text x="${W / 2}" y="61" text-anchor="middle" font-family="Orbitron" font-weight="900" font-size="24" letter-spacing="3" fill="${PURPLE}">COMMUNITY PICK</text>
<rect x="40" y="100" width="${W - 80}" height="${qLines.length > 1 ? 104 : 74}" rx="14" fill="${WHITE}"/>
${qLines.map((line, i) => `<text x="${W / 2}" y="${qLines.length > 1 ? 144 + i * 38 : 147}" text-anchor="middle" font-family="Anton" font-size="${qSize}" fill="${NAVY}">${escapeXml(line)}</text>`).join('\n')}
${pill(qLines.length > 1 ? 226 : 200, input.sideALabel, input.sideAPoints)}
${pill(qLines.length > 1 ? 292 : 266, input.sideBLabel, input.sideBPoints)}
<text x="${W / 2}" y="${H - 44}" text-anchor="middle" font-family="Orbitron" font-weight="700" font-size="16" letter-spacing="1" fill="rgba(255,255,255,0.6)">RESOLVES ${escapeXml(resolveDateLabel.toUpperCase())} · VOTE BELOW · NO ACCOUNT NEEDED</text>
<image xlink:href="${getLogoDataUri()}" x="34" y="${H - 66}" width="${Math.round(40 * (149 / 72))}" height="40"/>
<image xlink:href="${getDiscordIconDataUri()}" x="${W - 64}" y="${H - 60}" width="30" height="30" opacity="0.85"/>
</svg>`;

        const resvg = new Resvg(svg, {
            fitTo: { mode: 'width', value: W },
            font: { fontBuffers: FONT_BUFFERS, loadSystemFonts: false, defaultFontFamily: 'Orbitron' },
        });
        return resvg.render().asPng();
    } catch (err) {
        lastCpError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        console.error('[community-pick-image] Render failed:', err);
        return null;
    }
}
