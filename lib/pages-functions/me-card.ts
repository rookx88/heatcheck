// The /me personal card - Sammy's layered art direction (reference: repo-root
// "discord Name.png"): red-lightning background, a glowing ring holding the user's
// Discord avatar in monotone, the rim-lit character silhouette over it, a translucent
// stats plate across the legs (big Community Points number, SKILL RATING, LVL), the
// display name in an orange brush font top-left, and the Community Points rank
// top-right over an orange RANK badge. Rendered through the exact same
// satori-legacy/resvg pipeline as the leaderboard card (see leaderboard-image.ts for
// why that stack and no other runs on Workers).
//
// MILESTONE TIERS: the whole card recolors as the user levels
// (lib/pages-functions/leveling.ts) - the two red-hued art layers are retinted at
// render time by wrapping their data URIs in an inline SVG carrying feColorMatrix
// hueRotate/saturate filters (satori 0.10 has no CSS filters; resvg rasterizes the
// nested SVG's filters instead), the ring/glow colors switch per tier, and Apex
// (level 27, the final level) goes black-tinted background with gold everything.
//
// Isolation reminder: renders and posts only - no DB writes, no Ember tables.

// NOTE - unlike the leaderboard/welcome cards, this one does NOT go through satori:
// the tier tinting and monotone avatar need SVG filters on <image> elements, and
// resvg cannot rasterize an SVG nested inside another SVG via data URI (confirmed
// empirically: nested renders come back blank), which is exactly the shape satori
// produces for filtered-image sources. So this card is one flat, hand-composed SVG -
// images + filters + shapes + resvg's own <text> engine, with our font buffers
// passed straight to the rasterizer.
import { Resvg } from '@resvg/resvg-wasm';
import { ensureWasmInit, toBase64 } from './leaderboard-image';
import ME_BACKGROUND from './art/me-background.bin';
import ME_CHARACTER from './art/me-character.bin';
import ANTON from './fonts/anton.bin';
import PERMANENT_MARKER from './fonts/permanent-marker.bin';
import ORBITRON_BOLD from './fonts/orbitron-bold.bin';
import ORBITRON_BLACK from './fonts/orbitron-black.bin';
import { MAX_LEVEL } from './leveling';

// Canvas matches the committed art assets (540x960 - the 1080x1920 reference scaled
// by 0.5). Half-size is deliberate CPU management, not a quality tradeoff: the first
// deployed 810x1440 render died with Cloudflare error 1102 (Worker exceeded resource
// limits) - two full-bleed color-matrix filter passes plus a megapixel PNG encode
// blow the production CPU budget that the local dev runtime doesn't enforce. At
// 540x960 every per-pixel cost drops 4x, and Discord displays attachments at ~550px
// wide anyway, so nothing visible in chat is lost.
const W = 540;
const H = 960;

const ORANGE = '#f97316';

export interface MeCardInput {
    displayName: string;
    // The user's avatar - used only for the plain-embed fallback thumbnail.
    avatarUrl: string;
    // The GUILD's icon ("server pfp") - what actually sits inside the glow circle,
    // per the design. Null (server never set one) falls back to the user's avatar.
    guildIconUrl: string | null;
    points: number;
    rank: number;
    sr: number;
    level: number;
}

// ---- Milestone tiers -------------------------------------------------------------
// hue = feColorMatrix hueRotate degrees applied to BOTH art layers (source art is
// red ≈ 0°); sat = saturate multiplier; darken = black overlay alpha on the
// background layer; ring/glow drive the drawn circle. Angles are starting points -
// retune by eye via /api/leaderboard-image-test?me=1&level=N.
interface Tier {
    name: string;
    minLevel: number;
    hue: number;
    sat: number;
    darken: number;
    ring: string;
    glow: string;
}

const TIERS: Tier[] = [
    { name: 'Ember', minLevel: 1, hue: 0, sat: 1, darken: 0, ring: '#ffffff', glow: 'rgba(255,120,90,0.55)' },
    { name: 'Volt', minLevel: 5, hue: 220, sat: 1, darken: 0, ring: '#ffffff', glow: 'rgba(90,150,255,0.55)' },
    { name: 'Toxin', minLevel: 10, hue: 120, sat: 1, darken: 0, ring: '#ffffff', glow: 'rgba(110,255,140,0.55)' },
    { name: 'Surge', minLevel: 15, hue: 270, sat: 1, darken: 0, ring: '#ffffff', glow: 'rgba(190,110,255,0.55)' },
    { name: 'Platinum', minLevel: 20, hue: 0, sat: 0.12, darken: 0, ring: '#e8e8ee', glow: 'rgba(230,230,240,0.5)' },
    { name: 'Apex', minLevel: MAX_LEVEL, hue: 48, sat: 1.15, darken: 0.5, ring: '#ffc72c', glow: 'rgba(255,199,44,0.6)' },
];

export function tierForLevel(level: number): Tier {
    let tier = TIERS[0];
    for (const t of TIERS) if (level >= t.minLevel) tier = t;
    return tier;
}

export function escapeXml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let bgDataUri: string | null = null;
let charDataUri: string | null = null;
function getArt(): { bg: string; char: string } {
    if (!bgDataUri) bgDataUri = `data:image/png;base64,${toBase64(ME_BACKGROUND)}`;
    if (!charDataUri) charDataUri = `data:image/png;base64,${toBase64(ME_CHARACTER)}`;
    return { bg: bgDataUri, char: charDataUri };
}

// Raw buffers handed straight to resvg's own text engine (CustomFontsOptions).
// Family names come from the TTFs themselves: "Anton", "Permanent Marker",
// "Orbitron"; weight selection picks between the two Orbitron buffers.
export const FONT_BUFFERS = [ANTON, PERMANENT_MARKER, ORBITRON_BOLD, ORBITRON_BLACK].map((b) => new Uint8Array(b));

async function fetchAvatarDataUri(url: string): Promise<string | null> {
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`status ${res.status}`);
        const buf = await res.arrayBuffer();
        const contentType = res.headers.get('content-type') || 'image/png';
        return `data:${contentType};base64,${toBase64(buf)}`;
    } catch (err) {
        console.error('[me-card] Avatar fetch failed:', err);
        return null;
    }
}

let lastMeError: string | null = null;
export function getLastMeError(): string | null {
    return lastMeError;
}

export async function renderMeCard(input: MeCardInput): Promise<Uint8Array | null> {
    try {
        await ensureWasmInit();
        const tier = tierForLevel(input.level);
        const { bg, char } = getArt();
        const avatarRaw = await fetchAvatarDataUri(input.guildIconUrl ?? input.avatarUrl);

        // Circle geometry (reference * 0.5): center (270, 320), ring radius 225.
        const ringR = 225;
        const cx = 270;
        const cy = 320;
        const ringWidth = 7;
        const avatarR = ringR - ringWidth;

        const tintFilter = tier.hue !== 0 || tier.sat !== 1 ? 'filter="url(#tint)"' : '';
        const name = escapeXml(input.displayName);
        // Rough per-glyph width for Permanent Marker at a given size - shrink long
        // names instead of overflowing into the rank block.
        const nameSize = Math.min(43, Math.max(20, Math.floor(373 / Math.max(1, input.displayName.length) / 0.62)));
        const lvlColor = input.level >= MAX_LEVEL ? tier.ring : '#ffffff';

        // Glow = three cheap concentric translucent circles, NOT a gaussian blur -
        // the blur was a real slice of the CPU budget that error 1102 said we don't
        // have.
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <filter id="tint"><feColorMatrix type="hueRotate" values="${tier.hue}"/><feColorMatrix type="saturate" values="${tier.sat}"/></filter>
  <filter id="mono"><feColorMatrix type="saturate" values="0"/></filter>
  <clipPath id="avclip"><circle cx="${cx}" cy="${cy}" r="${avatarR}"/></clipPath>
</defs>
<rect width="${W}" height="${H}" fill="#000000"/>
<image xlink:href="${bg}" width="${W}" height="${H}" ${tintFilter}/>
${tier.darken > 0 ? `<rect width="${W}" height="${H}" fill="#000000" opacity="${tier.darken}"/>` : ''}
<circle cx="${cx}" cy="${cy}" r="${ringR + 26}" fill="${tier.glow}" opacity="0.25"/>
<circle cx="${cx}" cy="${cy}" r="${ringR + 16}" fill="${tier.glow}" opacity="0.4"/>
<circle cx="${cx}" cy="${cy}" r="${ringR + 8}" fill="${tier.glow}" opacity="0.6"/>
<circle cx="${cx}" cy="${cy}" r="${ringR}" fill="${tier.ring}"/>
${avatarRaw
    ? `<g clip-path="url(#avclip)"><image xlink:href="${avatarRaw}" x="${cx - avatarR}" y="${cy - avatarR}" width="${avatarR * 2}" height="${avatarR * 2}" preserveAspectRatio="xMidYMid slice" filter="url(#mono)"/></g>`
    : `<circle cx="${cx}" cy="${cy}" r="${avatarR}" fill="#1a1a22"/>`}
<image xlink:href="${char}" width="${W}" height="${H}" ${tintFilter}/>
<rect x="35" y="750" width="${W - 70}" height="157" rx="6" fill="#ffffff" opacity="0.22"/>
<text x="${W / 2}" y="837" text-anchor="middle" font-family="Anton" font-size="81" fill="#ffffff">${input.points.toLocaleString('en-US')}</text>
<text x="53" y="887" font-family="Orbitron" font-weight="700" font-size="18" letter-spacing="2" fill="#ffffff">SKILL RATING: ${input.sr}</text>
<text x="${W - 52}" y="891" text-anchor="end" font-family="Orbitron" font-weight="900" font-size="31" letter-spacing="1.5" fill="${lvlColor}">LVL ${input.level}</text>
<text x="29" y="73" font-family="Permanent Marker" font-size="${nameSize}" fill="${ORANGE}" transform="rotate(-6 29 73)">${name}</text>
<text x="${W - 64}" y="100" text-anchor="middle" font-family="Anton" font-size="81" fill="#ffffff">${input.rank}</text>
<rect x="${W - 112}" y="115" width="96" height="28" fill="${ORANGE}"/>
<text x="${W - 64}" y="136" text-anchor="middle" font-family="Orbitron" font-weight="900" font-size="17" letter-spacing="2" fill="#0c0c0e">RANK</text>
</svg>`;

        const resvg = new Resvg(svg, {
            fitTo: { mode: 'width', value: W },
            font: { fontBuffers: FONT_BUFFERS, loadSystemFonts: false, defaultFontFamily: 'Anton' },
        });
        return resvg.render().asPng();
    } catch (err) {
        lastMeError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        console.error('[me-card] Render failed:', err);
        return null;
    }
}

// Delivers /me: bare attachment (largest Discord display), plain stats embed as the
// render fallback, and a final plain-content fallback so the interaction can never
// hang - same layered posture as sendLeaderboardResult.
export async function sendMeCard(applicationId: string, token: string, input: MeCardInput): Promise<void> {
    const patchUrl = `https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/@original`;
    try {
        const png = await renderMeCard(input);
        if (png) {
            const form = new FormData();
            form.append('payload_json', JSON.stringify({ content: '' }));
            form.append('files[0]', new Blob([png], { type: 'image/png' }), 'me.png');
            const res = await fetch(patchUrl, { method: 'PATCH', body: form });
            if (res.ok) return;
            console.error(`[me-card] Multipart PATCH failed (${res.status}): ${await res.text().catch(() => '')}`);
        }
        await fetch(patchUrl, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: '',
                embeds: [{
                    author: { name: input.displayName },
                    description: `**#${input.rank}** · ${input.points.toLocaleString('en-US')} points · SR ${input.sr} · LVL ${input.level}`,
                    thumbnail: { url: input.avatarUrl },
                    color: 0xf97316,
                }],
            }),
        });
    } catch (err) {
        console.error('[me-card] sendMeCard failed entirely:', err);
        try {
            await fetch(patchUrl, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: 'Could not build your card right now — try again shortly.' }),
            });
        } catch (finalErr) {
            console.error('[me-card] Final fallback PATCH also failed:', finalErr);
        }
    }
}
