// The /pvp battles hub as a rendered card - the leaderboard's visual language (navy
// card, black header plate, white row boxes with a manual shadow, logo + Discord
// watermark) with a mini /me card for the person on the other side of each battle:
// their avatar inside their tier ring, level, Skill Rating, PvP record, and where the
// battle stands.
//
// Flat hand-composed SVG through resvg, NOT satori - same route as me-card.ts and
// community-pick-image.ts, and forced by the design: a mini /me card needs a circular
// clipped avatar inside a ring/glow stack, which satori 0.10 can't express, and
// me-card.ts documents that resvg renders a BLANK image for the nested-SVG-in-data-URI
// shape satori emits for anything filtered.
//
// CPU discipline (the error-1102 lesson recorded in me-card.ts): no filters at all
// here, glow is flat concentric circles rather than a blur, avatars are drawn
// unfiltered at 128px, and MAX_IMAGE_ROWS caps the canvas - ten rows would be a
// 1856px-tall, 1.34MP render, past the 540x960 /me card that already sits near the
// ceiling. Returns null on any failure; pvp.ts falls back to the text hub, so the
// screen can never be lost.

import { Resvg } from '@resvg/resvg-wasm';
import { ensureWasmInit, toBase64, getLogoDataUri, getDiscordIconDataUri } from './leaderboard-image';
import { tierForLevel, escapeXml, FONT_BUFFERS } from './me-card';
import NUNITO_BOLD from './fonts/nunito-bold.bin';
import NUNITO_EXTRABOLD from './fonts/nunito-extrabold.bin';

// Geometry ported from the welcome card's row (leaderboard-image.ts) so this reads as
// a sibling of the leaderboard rather than a lookalike.
const W = 720;
const CARD_PAD = 26;
const ROW_W = W - CARD_PAD * 2;          // 668
const ROW_H = 128;
const ROW_SHADOW = 10;
const ROW_UNIT_H = ROW_H + ROW_SHADOW;   // 138
const ROW_GAP = 22;
const HEADER_PLATE_H = 126;
const WATERMARK_H = 56;
const BOX_LEFT = 84;                     // white box starts under the avatar disc

const NAVY = '#0e0a38';
const PLATE = '#0c0c0e';
const GREEN = '#31e874';
const WHITE = '#ffffff';
const INK = '#1b1740';
const INK_SOFT = '#3a3654';

// See the module header - six rows is ~0.88MP.
export const MAX_IMAGE_ROWS = 6;

// resvg's own text engine needs every family it will be asked for. FONT_BUFFERS covers
// Anton / Permanent Marker / Orbitron; Nunito is added here so body text matches the
// leaderboard and welcome cards instead of being forced into Orbitron.
const HUB_FONTS = [...FONT_BUFFERS, new Uint8Array(NUNITO_BOLD), new Uint8Array(NUNITO_EXTRABOLD)];

export interface PvpHubRow {
    /** Opponent display name. */
    name: string;
    /** Their avatar, already sized/format-normalized by the caller. */
    avatarUrl: string | null;
    level: number;
    sr: number;
    /** Their overall PvP record, or null when they've never settled one. */
    record: { w: number; d: number; l: number } | null;
    /** 'Picks lock in 9h', 'Waiting on them', ... - the battle's own state. */
    status: string;
    /** 'you 2/3 · them 1/3' for an active battle; empty for a pending challenge. */
    progress: string;
    /** Pending challenges get a muted treatment so live battles read first. */
    pending: boolean;
}

export interface PvpHubImageInput {
    record: string;      // your W-D-L, e.g. "4-1-2"
    rows: PvpHubRow[];
    /** Rows that exist but didn't fit the canvas - surfaced as a footer line. */
    overflow: number;
}

let lastError: string | null = null;
export function getLastPvpHubError(): string | null {
    return lastError;
}

async function avatarDataUri(url: string | null): Promise<string | null> {
    if (!url) return null;
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`status ${res.status}`);
        const buf = await res.arrayBuffer();
        return `data:${res.headers.get('content-type') || 'image/png'};base64,${toBase64(buf)}`;
    } catch (err) {
        // One bad avatar degrades one row to a flat disc - it must never fail the card.
        console.error('[pvp-hub-image] Avatar fetch failed:', err);
        return null;
    }
}

// A black pill with tinted text - the leaderboard row's core vocabulary element (its
// name/SR pills), reused here so the two cards read as one family. resvg has no text
// measurement, so the width is estimated per glyph like every other label in this repo.
function pill(x: number, y: number, text: string, color: string, size = 15): string {
    const w = Math.round(text.length * size * 0.62) + 26;
    const h = size + 14;
    // rx must be HALF THE HEIGHT, not a large sentinel: raw SVG clamps rx to width/2
    // and ry to height/2, so rx="999" renders a full ellipse. satori's borderRadius:999
    // (what the leaderboard rows use) clamps differently - this is the hand-composed
    // equivalent of that stadium shape.
    return `<rect x="${x}" y="${y - size - 5}" width="${w}" height="${h}" rx="${h / 2}" fill="${PLATE}"/>` +
        `<text x="${x + 13}" y="${y}" font-family="Orbitron" font-weight="700" font-size="${size}" letter-spacing="1" fill="${color}">${escapeXml(text)}</text>`;
}

/** Shrinks a name until it can't run into the stats column. */
function nameSize(name: string): number {
    if (name.length <= 14) return 27;
    if (name.length <= 20) return 23;
    return 19;
}

function clamp(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// The mini /me card: the ring recipe from me-card.ts scaled to disc size. Four of the
// six tiers use a white ring, so at this size the tier reads through its GLOW - which
// is why the glow colour is also the ring stroke here.
function discSvg(cx: number, cy: number, r: number, level: number, avatar: string | null, index: number): string {
    const tier = tierForLevel(level);
    const glowR = [r * 1.116, r * 1.071, r * 1.036];
    return [
        `<circle cx="${cx}" cy="${cy}" r="${glowR[0].toFixed(1)}" fill="${tier.glow}" opacity="0.25"/>`,
        `<circle cx="${cx}" cy="${cy}" r="${glowR[1].toFixed(1)}" fill="${tier.glow}" opacity="0.4"/>`,
        `<circle cx="${cx}" cy="${cy}" r="${glowR[2].toFixed(1)}" fill="${tier.glow}" opacity="0.6"/>`,
        `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${tier.ring === '#ffffff' ? tier.glow : tier.ring}"/>`,
        avatar
            ? `<g clip-path="url(#avclip${index})"><image xlink:href="${avatar}" x="${cx - (r - 4)}" y="${cy - (r - 4)}" width="${(r - 4) * 2}" height="${(r - 4) * 2}" preserveAspectRatio="xMidYMid slice"/></g>`
            : `<circle cx="${cx}" cy="${cy}" r="${r - 4}" fill="#1a1a22"/>`,
    ].join('\n');
}

export async function renderPvpHubImage(input: PvpHubImageInput): Promise<Uint8Array | null> {
    try {
        const rows = input.rows.slice(0, MAX_IMAGE_ROWS);
        if (rows.length === 0) return null;

        // Avatars in parallel WITH wasm init - the leaderboard's shape, not the
        // /me card's sequential single fetch.
        const [avatars] = await Promise.all([
            Promise.all(rows.map((r) => avatarDataUri(r.avatarUrl))),
            ensureWasmInit(),
        ]);

        const footerH = input.overflow > 0 ? 30 : 0;
        const H = CARD_PAD * 2 + HEADER_PLATE_H + 56 + rows.length * ROW_UNIT_H
            + (rows.length - 1) * ROW_GAP + footerH + 18 + WATERMARK_H;

        const recordY = CARD_PAD + HEADER_PLATE_H + 30;
        const recordText = `RECORD ${input.record}`;
        const recordW = Math.round(recordText.length * 16 * 0.62) + 26;
        const rowsTop = CARD_PAD + HEADER_PLATE_H + 56;
        const discR = 42;
        const discCx = CARD_PAD + 58;

        const clips = rows.map((_, i) => {
            const top = rowsTop + i * (ROW_UNIT_H + ROW_GAP);
            return `<clipPath id="avclip${i}"><circle cx="${discCx}" cy="${top + ROW_H / 2}" r="${discR - 4}"/></clipPath>`;
        }).join('\n');

        const rowSvg = rows.map((row, i) => {
            const top = rowsTop + i * (ROW_UNIT_H + ROW_GAP);
            const boxLeft = CARD_PAD + BOX_LEFT;
            const boxW = ROW_W - BOX_LEFT;
            const cy = top + ROW_H / 2;
            const textLeft = boxLeft + 54;
            const recordText = row.record ? `PVP ${row.record.w}-${row.record.d}-${row.record.l}` : 'PVP —';

            return [
                // Manual shadow - satori's boxShadow doesn't survive resvg, and this
                // card is hand-composed anyway.
                `<rect x="${CARD_PAD + ROW_SHADOW}" y="${top + ROW_SHADOW}" width="${ROW_W - ROW_SHADOW}" height="${ROW_H}" rx="24" fill="rgba(0,0,0,0.45)"/>`,
                `<rect x="${boxLeft}" y="${top + 6}" width="${boxW}" height="${ROW_H - 12}" rx="14" fill="${WHITE}" opacity="${row.pending ? 0.82 : 1}"/>`,
                // Name + their standing.
                `<text x="${textLeft}" y="${cy - 22}" font-family="Nunito" font-weight="800" font-size="${nameSize(row.name)}" fill="${NAVY}">${escapeXml(clamp(row.name, 26))}</text>`,
                pill(textLeft, cy + 12, `LVL ${row.level} · SR ${row.sr} · ${recordText}`, row.pending ? WHITE : GREEN),
                // This battle.
                `<text x="${textLeft}" y="${cy + 42}" font-family="Nunito" font-weight="700" font-size="16" fill="${INK}">${escapeXml(clamp([row.progress, row.status].filter(Boolean).join('  ·  '), 52))}</text>`,
                // The disc last so it overlaps the white box's left edge, the way the
                // leaderboard's rank plate does.
                discSvg(discCx, cy, discR, row.level, avatars[i], i),
            ].join('\n');
        }).join('\n');

        const footerY = rowsTop + rows.length * ROW_UNIT_H + (rows.length - 1) * ROW_GAP + 20;
        const footer = input.overflow > 0
            ? `<text x="${W / 2}" y="${footerY}" text-anchor="middle" font-family="Nunito" font-weight="700" font-size="16" fill="rgba(255,255,255,0.65)">+ ${input.overflow} more in the menu below</text>`
            : '';

        const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
${clips}
</defs>
<rect x="3" y="3" width="${W - 6}" height="${H - 6}" rx="44" fill="${NAVY}" stroke="${PLATE}" stroke-width="6"/>
<rect x="${W / 2 - 210}" y="${CARD_PAD}" width="420" height="${HEADER_PLATE_H}" rx="26" fill="${PLATE}"/>
<text x="${W / 2}" y="${CARD_PAD + 44}" text-anchor="middle" font-family="Orbitron" font-weight="700" font-size="22" letter-spacing="2" fill="${WHITE}">YOUR BATTLES</text>
<text x="${W / 2}" y="${CARD_PAD + 96}" text-anchor="middle" font-family="Orbitron" font-weight="900" font-size="46" letter-spacing="4" fill="${GREEN}">PVP</text>
${pill(W / 2 - recordW / 2, recordY, recordText, GREEN, 16)}
${rowSvg}
${footer}
<image xlink:href="${getLogoDataUri()}" x="${CARD_PAD}" y="${H - 66}" width="${Math.round(40 * (149 / 72))}" height="40"/>
<image xlink:href="${getDiscordIconDataUri()}" x="${W - CARD_PAD - 30}" y="${H - 60}" width="30" height="30" opacity="0.85"/>
</svg>`;

        const resvg = new Resvg(svg, {
            fitTo: { mode: 'width', value: W },
            font: { fontBuffers: HUB_FONTS, loadSystemFonts: false, defaultFontFamily: 'Nunito' },
        });
        return resvg.render().asPng();
    } catch (err) {
        lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        console.error('[pvp-hub-image] Render failed:', err);
        return null;
    }
}
