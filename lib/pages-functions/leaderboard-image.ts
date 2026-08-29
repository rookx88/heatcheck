// Renders /leaderboard as one real PNG banner (rank rows with real Discord avatars,
// tiered colored bars) instead of the muted embed-only version (discord-leaderboard-
// card.ts) - Discord embeds can only ever show a thin left-edge color accent, never a
// full colored bar, so a real generated image is the only way to get the bold,
// tiered-banner look Sammy wants. Same satori render approach scripts/generate-og-
// image.ts already uses for Tank article OG cards, but that script runs at Node
// build-time (native fs/canvas deps) - this runs live inside a Cloudflare Pages
// Function, so it uses satori's plain-object element-tree API (same style, no JSX/tsx
// tooling needed) plus @resvg/resvg-wasm (the Workers-compatible WASM rasterizer;
// @resvg/resvg-js is a native Node binding and cannot run here).
//
// Defensive by design: renderLeaderboardImage returns null on ANY failure (wasm init,
// font/avatar fetch, render exception) rather than throwing - sendLeaderboardResult
// always falls back to the already-shipped colored-embed-rows version in that case,
// so a rendering hiccup can never make /leaderboard reply worse than it did before
// this file existed.

// satori-legacy is an npm alias for satori@0.10.9, NOT the repo's main satori
// (0.33.x, used by the Node build-time OG generator). 0.33 hard-depends on
// harfbuzzjs, whose Emscripten loader both reads self.location.href (undefined in
// workerd - the "reading 'href'" crash seen live) and compiles its own wasm from
// bytes at runtime, which Workers bans outright ("Wasm code generation disallowed by
// embedder"). 0.10.x predates harfbuzz and is the satori generation the
// workers-og ecosystem runs on Cloudflare Workers: its /wasm entry ships no wasm of
// its own - we hand it a yoga layout engine we initialize ourselves from a
// pre-compiled module (initYoga uses the allowed instantiate(module, imports) form).
import satori, { init as initSatori } from 'satori-legacy/wasm';
import initYoga from 'yoga-wasm-web';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import type { Env } from './db';
// Relative imports are load-bearing: the Pages bundler's CompiledWasm rule turns
// these into pre-compiled WebAssembly.Modules (the ONLY form the Workers runtime
// accepts - compiling from raw bytes at runtime is blocked, and importing via a
// package path resolves to undefined instead of a Module). The files are straight
// copies of node_modules/@resvg/resvg-wasm/index_bg.wasm and
// node_modules/yoga-wasm-web/dist/yoga.wasm - re-copy if either package is upgraded.
import RESVG_WASM from './resvg.wasm';
import YOGA_WASM from './yoga.wasm';
// Fonts are bundled as Data modules (raw ArrayBuffers) rather than fetched from the
// site's own static assets - the CI build assembles dist selectively and didn't carry
// public/assets/fonts/, and baking them in removes a whole failure mode (plus a
// network round-trip) regardless. Straight copies of scripts/assets/fonts/*.ttf,
// renamed .bin for the bundler's Data rule.
import BALOO2_EXTRABOLD from './fonts/baloo2-extrabold.bin';
import NUNITO_REGULAR from './fonts/nunito-regular.bin';
import NUNITO_BOLD from './fonts/nunito-bold.bin';
import NUNITO_EXTRABOLD from './fonts/nunito-extrabold.bin';
// Orbitron (Google Fonts, latin subset) - the techno face for the header plate, rank
// numerals, and score pill, per the mockup's LCD-style look.
import ORBITRON_BOLD from './fonts/orbitron-bold.bin';
import ORBITRON_BLACK from './fonts/orbitron-black.bin';
// The real site logo, pre-converted to PNG (resvg can't rasterize webp - the OG
// generator does the same webp->png conversion, via sharp at build time; this one was
// converted once with sharp locally and committed: 149x72, from
// public/assets/images/heatchecks-logo.webp).
import HEATCHECKS_LOGO from './heatchecks-logo.bin';
// Discord's mark (simple-icons SVG, rasterized once locally to a white 80x80 PNG) -
// the footer's visual pointer to the invite, replacing the old URL text.
import DISCORD_ICON from './discord-icon.bin';
import { buildLeaderboardRowEmbeds, colorForRank, type LeaderboardRowInput } from './discord-leaderboard-card';

// Heatchecks' own community server - the footer's Discord icon points at it visually
// (pixels can't be clicked, but a screenshot/re-share keeps the association) AND it's
// the clickable url on the Discord embed that carries the image (see
// sendLeaderboardResult).
export const HEATCHECKS_DISCORD_INVITE = 'https://discord.gg/cv8yPDAEy';

const IMAGE_WIDTH = 720;
const CARD_PAD = 26;
const CARD_RADIUS = 44;
const HEADER_PLATE_H = 126;
const ROW_W = IMAGE_WIDTH - CARD_PAD * 2;
const ROW_BOX_H = 120; // the visible rank unit (plate + white box)
const ROW_SHADOW_OFFSET = 10; // manual shadow layer offset below/right of each box
const ROW_UNIT_H = ROW_BOX_H + ROW_SHADOW_OFFSET; // layout slot incl. shadow room
const ROW_GAP = 22;
const RANK_PLATE_W = 96;
const WHITE_BOX_LEFT = 84; // white box starts under the plate's right edge (overlap)
const WATERMARK_HEIGHT = 56;
const WATERMARK_LOGO_HEIGHT = 48;
const WATERMARK_LOGO_WIDTH = Math.round(WATERMARK_LOGO_HEIGHT * (149 / 72)); // source PNG's native aspect ratio
const DISCORD_ICON_SIZE = 36;

const COLOR_CARD_BLUE = '#0e0a38'; // very dark navy (was the mockup's royal #2712d8 - Sammy asked for really dark)
const COLOR_PLATE_BLACK = '#0c0c0e';
const COLOR_GREEN = '#31e874'; // the mockup's bright green
const COLOR_WHITE = '#ffffff';

// Podium treatment for the big rank numeral: gold/silver/bronze for 1-3 (same hexes
// as discord-leaderboard-card.ts's embed tier colors), green for everyone else.
function rankNumeralColor(rank: number): string {
    if (rank === 1) return '#ffc72c';
    if (rank === 2) return '#c0c0c0';
    if (rank === 3) return '#cd7f32';
    return COLOR_GREEN;
}

let wasmInitPromise: Promise<void> | null = null;
function ensureWasmInit(): Promise<void> {
    // Guarded by this module-level promise so init only ever runs once per warm
    // isolate, not once per request. Both inputs are already compiled
    // WebAssembly.Modules (see the import comments above) - initYoga/initWasm only
    // instantiate them, which the Workers runtime allows (unlike compiling bytes).
    if (!wasmInitPromise) {
        wasmInitPromise = Promise.all([
            initYoga(YOGA_WASM).then((yoga) => initSatori(yoga)),
            initWasm(RESVG_WASM),
        ]).then(() => undefined);
    }
    return wasmInitPromise;
}

const FONTS: { name: string; data: ArrayBuffer; weight: 400 | 700 | 800 | 900; style: 'normal' }[] = [
    { name: 'Baloo 2', data: BALOO2_EXTRABOLD, weight: 800, style: 'normal' },
    { name: 'Nunito', data: NUNITO_REGULAR, weight: 400, style: 'normal' },
    { name: 'Nunito', data: NUNITO_BOLD, weight: 700, style: 'normal' },
    { name: 'Nunito', data: NUNITO_EXTRABOLD, weight: 800, style: 'normal' },
    { name: 'Orbitron', data: ORBITRON_BOLD, weight: 700, style: 'normal' },
    { name: 'Orbitron', data: ORBITRON_BLACK, weight: 900, style: 'normal' },
];

// Chunked base64 - spreading a whole Uint8Array into String.fromCharCode can blow the
// argument-count limit on larger buffers (the 28KB logo is already pushing it).
function toBase64(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let binary = '';
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

// Built lazily once per isolate, not per request - the bytes never change.
let logoDataUri: string | null = null;
function getLogoDataUri(): string {
    if (!logoDataUri) logoDataUri = `data:image/png;base64,${toBase64(HEATCHECKS_LOGO)}`;
    return logoDataUri;
}
let discordIconDataUri: string | null = null;
function getDiscordIconDataUri(): string {
    if (!discordIconDataUri) discordIconDataUri = `data:image/png;base64,${toBase64(DISCORD_ICON)}`;
    return discordIconDataUri;
}

// One failed avatar can't take down the whole render - falls back to a plain tier-
// colored fill for that row.
async function loadAvatarDataUri(url: string, fallbackColor: string): Promise<string> {
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`status ${res.status}`);
        const buf = await res.arrayBuffer();
        const contentType = res.headers.get('content-type') || 'image/png';
        const base64 = toBase64(buf);
        return `data:${contentType};base64,${base64}`;
    } catch {
        // Solid-color SVG data URI as a last resort - satori still needs a valid
        // image src, an empty/broken one would fail the whole render.
        return `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="100%" height="100%" fill="${fallbackColor}"/></svg>`)}`;
    }
}

// A small black pill (used for the name and SR labels floating over the avatar).
function pillNode(text: string, fontSize: number) {
    return {
        type: 'div',
        props: {
            style: {
                display: 'flex',
                background: COLOR_PLATE_BLACK,
                borderRadius: 999,
                padding: '5px 18px',
                fontFamily: 'Nunito',
                fontWeight: 800,
                fontSize,
                color: COLOR_WHITE,
            },
            children: text,
        },
    };
}

// One rank unit, mockup-style: a manual shadow layer (an offset dark rounded rect -
// guaranteed to rasterize, unlike relying on satori 0.10's boxShadow through resvg),
// a white rounded box filled edge-to-edge by the user's avatar (cover-cropped) with
// the name/SR pills and the green score pill floating on top, and the big black rank
// plate painted last so it overlaps the white box's left edge like the mock.
function buildRowNode(row: LeaderboardRowInput, avatarDataUri: string) {
    const whiteBoxW = ROW_W - WHITE_BOX_LEFT;
    return {
        type: 'div',
        props: {
            style: { display: 'flex', position: 'relative', width: ROW_W, height: ROW_UNIT_H },
            children: [
                // Shadow layer - offset down/right, under everything.
                {
                    type: 'div',
                    props: {
                        style: {
                            display: 'flex',
                            position: 'absolute',
                            left: ROW_SHADOW_OFFSET,
                            top: ROW_SHADOW_OFFSET,
                            width: ROW_W - ROW_SHADOW_OFFSET,
                            height: ROW_BOX_H,
                            borderRadius: 24,
                            background: 'rgba(0,0,0,0.45)',
                        },
                    },
                },
                // White box with avatar fill + floating pills.
                {
                    type: 'div',
                    props: {
                        style: {
                            display: 'flex',
                            position: 'absolute',
                            left: WHITE_BOX_LEFT,
                            top: 6,
                            width: whiteBoxW,
                            height: ROW_BOX_H - 12,
                            borderRadius: 14,
                            background: COLOR_WHITE,
                            overflow: 'hidden',
                        },
                        children: [
                            {
                                type: 'img',
                                props: {
                                    src: avatarDataUri,
                                    width: whiteBoxW,
                                    height: ROW_BOX_H - 12,
                                    style: { position: 'absolute', left: 0, top: 0, objectFit: 'cover' },
                                },
                            },
                            // Name pill, top-right.
                            {
                                type: 'div',
                                props: {
                                    style: { display: 'flex', position: 'absolute', right: 12, top: 8 },
                                    children: [pillNode(row.displayName, 24)],
                                },
                            },
                            // SR pill, under the name.
                            {
                                type: 'div',
                                props: {
                                    style: { display: 'flex', position: 'absolute', right: 12, top: 58 },
                                    children: [pillNode(`SR: ${row.sr}`, 20)],
                                },
                            },
                            // Green-outlined score pill, bottom-left.
                            {
                                type: 'div',
                                props: {
                                    style: {
                                        display: 'flex',
                                        position: 'absolute',
                                        left: 14,
                                        bottom: 10,
                                        background: COLOR_PLATE_BLACK,
                                        border: `3px solid ${COLOR_GREEN}`,
                                        borderRadius: 12,
                                        padding: '4px 14px',
                                        fontFamily: 'Orbitron',
                                        fontWeight: 900,
                                        fontSize: 24,
                                        color: COLOR_GREEN,
                                    },
                                    children: row.scoreValue,
                                },
                            },
                        ],
                    },
                },
                // Rank plate - painted last so it sits on top of the white box edge.
                {
                    type: 'div',
                    props: {
                        style: {
                            display: 'flex',
                            position: 'absolute',
                            left: 0,
                            top: 0,
                            width: RANK_PLATE_W,
                            height: ROW_BOX_H,
                            borderRadius: 22,
                            background: COLOR_PLATE_BLACK,
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontFamily: 'Orbitron',
                            fontWeight: 900,
                            fontSize: 56,
                            color: rankNumeralColor(row.rank),
                        },
                        children: String(row.rank),
                    },
                },
            ],
        },
    };
}

// TEMPORARY diagnostic - log tailing isn't working reliably in this environment, so
// this surfaces the actual failure reason directly in the Discord fallback message
// instead. Remove once the render path is confirmed working.
let lastRenderError: string | null = null;
export function getLastRenderError(): string | null {
    return lastRenderError;
}

export async function renderLeaderboardImage(headerLabel: string, rows: LeaderboardRowInput[]): Promise<Uint8Array | null> {
    if (rows.length === 0) return null;
    try {
        const [avatarDataUris] = await Promise.all([
            Promise.all(rows.map((r) => loadAvatarDataUri(r.avatarUrl, `#${colorForRank(r.rank).toString(16).padStart(6, '0')}`))),
            ensureWasmInit(),
        ]);

        const totalHeight =
            CARD_PAD * 2 + HEADER_PLATE_H + 26 + rows.length * ROW_UNIT_H + (rows.length - 1) * ROW_GAP + 18 + WATERMARK_HEIGHT;
        // The whole image IS the blue card - rounded corners render transparent in
        // the PNG, so Discord's own message background shows through them.
        const tree = {
            type: 'div',
            props: {
                style: {
                    width: IMAGE_WIDTH,
                    height: totalHeight,
                    display: 'flex',
                    flexDirection: 'column',
                    background: COLOR_CARD_BLUE,
                    borderRadius: CARD_RADIUS,
                    border: `6px solid ${COLOR_PLATE_BLACK}`,
                    padding: CARD_PAD,
                },
                children: [
                    // Header plate: black rounded block, view label small on top,
                    // big green LEADERBOARD under it.
                    {
                        type: 'div',
                        props: {
                            style: {
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                justifyContent: 'center',
                                alignSelf: 'center',
                                height: HEADER_PLATE_H,
                                padding: '10px 40px',
                                borderRadius: 26,
                                background: COLOR_PLATE_BLACK,
                                marginBottom: 26,
                            },
                            children: [
                                {
                                    type: 'div',
                                    props: {
                                        style: {
                                            display: 'flex',
                                            fontFamily: 'Orbitron',
                                            fontWeight: 700,
                                            fontSize: 27,
                                            letterSpacing: 2,
                                            color: COLOR_WHITE,
                                            textTransform: 'uppercase',
                                        },
                                        children: headerLabel,
                                    },
                                },
                                {
                                    type: 'div',
                                    props: {
                                        style: {
                                            display: 'flex',
                                            fontFamily: 'Orbitron',
                                            fontWeight: 900,
                                            fontSize: 52,
                                            letterSpacing: 4,
                                            color: COLOR_GREEN,
                                        },
                                        children: 'LEADERBOARD',
                                    },
                                },
                            ],
                        },
                    },
                    {
                        type: 'div',
                        props: {
                            style: { display: 'flex', flexDirection: 'column', gap: ROW_GAP },
                            children: rows.map((row, i) => buildRowNode(row, avatarDataUris[i])),
                        },
                    },
                    // Watermark footer: real site logo + the Discord mark (the
                    // embed's clickable title carries the actual invite link).
                    {
                        type: 'div',
                        props: {
                            style: {
                                display: 'flex',
                                flexDirection: 'row',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                height: WATERMARK_HEIGHT,
                                width: ROW_W,
                                marginTop: 18,
                            },
                            children: [
                                {
                                    type: 'img',
                                    props: {
                                        src: getLogoDataUri(),
                                        width: WATERMARK_LOGO_WIDTH,
                                        height: WATERMARK_LOGO_HEIGHT,
                                        style: { display: 'flex' },
                                    },
                                },
                                {
                                    type: 'img',
                                    props: {
                                        src: getDiscordIconDataUri(),
                                        width: DISCORD_ICON_SIZE,
                                        height: DISCORD_ICON_SIZE,
                                        style: { display: 'flex', opacity: 0.85 },
                                    },
                                },
                            ],
                        },
                    },
                ],
            },
        };

        const svg = await satori(tree as any, { width: IMAGE_WIDTH, height: totalHeight, fonts: FONTS });
        const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: IMAGE_WIDTH } });
        return resvg.render().asPng();
    } catch (err) {
        lastRenderError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        console.error('[leaderboard-image] Render failed, falling back to embeds:', err);
        return null;
    }
}

// ===================================================================================
// The setup wizard's welcome card, rendered in the same visual language as the
// leaderboard (navy card, black plates, Orbitron + green, watermark footer). Three
// "feature rows" mirror the rank-row anatomy - black tag plate overlapping a white
// box - but carry explainer copy instead of a ranked user. Returns null on any
// failure; the wizard falls back to the plain embed version so the permission
// smoke test still happens either way.
// ===================================================================================

const WELCOME_ROW_H = 118;
const WELCOME_ROWS: { tag: string; title: string; body: string }[] = [
    { tag: 'PICK', title: 'Daily Tank cards', body: 'Real sports storylines with pick buttons. Picking links your Discord to a free heatchecks.io account and earns Ember when you call it right.' },
    { tag: 'VOTE', title: 'Community Picks', body: 'Quick market votes anyone can join — no account needed. Correct calls earn points toward this server’s leaderboard.' },
    { tag: 'RANK', title: 'Track your run', body: '/leaderboard — server standings  ·  /me — your rank card  ·  /my-results — your recent calls, visible only to you.' },
];

function buildWelcomeRowNode(row: { tag: string; title: string; body: string }) {
    const whiteBoxW = ROW_W - WHITE_BOX_LEFT;
    return {
        type: 'div',
        props: {
            style: { display: 'flex', position: 'relative', width: ROW_W, height: WELCOME_ROW_H + ROW_SHADOW_OFFSET },
            children: [
                {
                    type: 'div',
                    props: {
                        style: {
                            display: 'flex', position: 'absolute', left: ROW_SHADOW_OFFSET, top: ROW_SHADOW_OFFSET,
                            width: ROW_W - ROW_SHADOW_OFFSET, height: WELCOME_ROW_H, borderRadius: 24, background: 'rgba(0,0,0,0.45)',
                        },
                    },
                },
                {
                    type: 'div',
                    props: {
                        style: {
                            display: 'flex', position: 'absolute', left: WHITE_BOX_LEFT, top: 6,
                            width: whiteBoxW, height: WELCOME_ROW_H - 12, borderRadius: 14, background: COLOR_WHITE,
                            flexDirection: 'column', justifyContent: 'center', padding: '0 22px 0 34px', gap: 4,
                        },
                        children: [
                            { type: 'div', props: { style: { display: 'flex', fontFamily: 'Nunito', fontWeight: 800, fontSize: 21, color: COLOR_CARD_BLUE }, children: row.title } },
                            { type: 'div', props: { style: { display: 'flex', fontFamily: 'Nunito', fontWeight: 700, fontSize: 14.5, lineHeight: 1.35, color: '#3a3654' }, children: row.body } },
                        ],
                    },
                },
                {
                    type: 'div',
                    props: {
                        style: {
                            display: 'flex', position: 'absolute', left: 0, top: 0,
                            width: RANK_PLATE_W, height: WELCOME_ROW_H, borderRadius: 22, background: COLOR_PLATE_BLACK,
                            alignItems: 'center', justifyContent: 'center',
                            fontFamily: 'Orbitron', fontWeight: 900, fontSize: 21, color: COLOR_GREEN, letterSpacing: 1,
                        },
                        children: row.tag,
                    },
                },
            ],
        },
    };
}

export async function renderWelcomeImage(): Promise<Uint8Array | null> {
    try {
        await ensureWasmInit();
        const trustLineH = 34;
        const totalHeight = CARD_PAD * 2 + HEADER_PLATE_H + 26
            + WELCOME_ROWS.length * (WELCOME_ROW_H + ROW_SHADOW_OFFSET) + (WELCOME_ROWS.length - 1) * ROW_GAP
            + 14 + trustLineH + 12 + WATERMARK_HEIGHT;

        const tree = {
            type: 'div',
            props: {
                style: {
                    width: IMAGE_WIDTH, height: totalHeight, display: 'flex', flexDirection: 'column',
                    background: COLOR_CARD_BLUE, borderRadius: CARD_RADIUS, border: `6px solid ${COLOR_PLATE_BLACK}`, padding: CARD_PAD,
                },
                children: [
                    {
                        type: 'div',
                        props: {
                            style: {
                                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                                alignSelf: 'center', height: HEADER_PLATE_H, padding: '10px 40px', borderRadius: 26,
                                background: COLOR_PLATE_BLACK, marginBottom: 26,
                            },
                            children: [
                                { type: 'div', props: { style: { display: 'flex', fontFamily: 'Orbitron', fontWeight: 700, fontSize: 20, letterSpacing: 2, color: COLOR_WHITE }, children: 'THIS SERVER NOW RUNS' } },
                                { type: 'div', props: { style: { display: 'flex', fontFamily: 'Orbitron', fontWeight: 900, fontSize: 52, letterSpacing: 4, color: COLOR_GREEN }, children: 'HEATCHECKS' } },
                            ],
                        },
                    },
                    {
                        type: 'div',
                        props: {
                            style: { display: 'flex', flexDirection: 'column', gap: ROW_GAP },
                            children: WELCOME_ROWS.map(buildWelcomeRowNode),
                        },
                    },
                    {
                        type: 'div',
                        props: {
                            style: {
                                display: 'flex', alignItems: 'center', justifyContent: 'center', height: trustLineH, marginTop: 14,
                                fontFamily: 'Nunito', fontWeight: 700, fontSize: 13.5, color: 'rgba(255,255,255,0.6)',
                            },
                            children: 'Entertainment only — no real-money wagering. Heatchecks never supplies or distributes prizes.',
                        },
                    },
                    {
                        type: 'div',
                        props: {
                            style: {
                                display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                                height: WATERMARK_HEIGHT, width: ROW_W, marginTop: 12,
                            },
                            children: [
                                { type: 'img', props: { src: getLogoDataUri(), width: WATERMARK_LOGO_WIDTH, height: WATERMARK_LOGO_HEIGHT, style: { display: 'flex' } } },
                                { type: 'img', props: { src: getDiscordIconDataUri(), width: DISCORD_ICON_SIZE, height: DISCORD_ICON_SIZE, style: { display: 'flex', opacity: 0.85 } } },
                            ],
                        },
                    },
                ],
            },
        };

        const svg = await satori(tree as any, { width: IMAGE_WIDTH, height: totalHeight, fonts: FONTS });
        const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: IMAGE_WIDTH } });
        return resvg.render().asPng();
    } catch (err) {
        console.error('[leaderboard-image] Welcome render failed, falling back to embed:', err);
        return null;
    }
}

// Posts the rendered welcome card to a channel. IMPORTANT contract for the wizard's
// permission smoke test: a render failure quietly returns 'embed_needed' (caller
// posts the plain-embed version instead), but a channel POST failure THROWS - that's
// the signal the wizard's catch turns into permission guidance.
export async function postWelcomeImageToChannel(env: Env, channelId: string): Promise<'posted' | 'embed_needed'> {
    const png = await renderWelcomeImage();
    if (!png) return 'embed_needed';

    const form = new FormData();
    form.append('payload_json', JSON.stringify({
        content: '',
        embeds: [{ title: 'Heatchecks', url: HEATCHECKS_DISCORD_INVITE, image: { url: 'attachment://welcome.png' } }],
    }));
    form.append('files[0]', new Blob([png], { type: 'image/png' }), 'welcome.png');
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
        body: form,
    });
    if (!res.ok) throw new Error(`Welcome image post failed: ${res.status} ${await res.text().catch(() => '')}`);
    return 'posted';
}

// Channel-post variant for the weekly auto-post (functions/api/
// weekly-leaderboard-sweep.ts): same image-first/embeds-fallback posture as
// sendLeaderboardResult, but delivered as a bot channel message (multipart with Bot
// auth) instead of an interaction-webhook PATCH.
export async function postLeaderboardToChannel(
    env: Env,
    channelId: string,
    content: string,
    headerLabel: string,
    rows: LeaderboardRowInput[]
): Promise<void> {
    const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
    const png = rows.length > 0 ? await renderLeaderboardImage(headerLabel, rows) : null;

    if (png) {
        const form = new FormData();
        form.append('payload_json', JSON.stringify({
            content: '',
            embeds: [{ title: 'Heatchecks', url: HEATCHECKS_DISCORD_INVITE, image: { url: 'attachment://leaderboard.png' } }],
        }));
        form.append('files[0]', new Blob([png], { type: 'image/png' }), 'leaderboard.png');
        const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` }, body: form });
        if (res.ok) return;
        console.error(`[leaderboard-image] Weekly multipart post failed (${res.status}): ${await res.text().catch(() => '')}`);
    }

    const embeds = buildLeaderboardRowEmbeds(rows);
    const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, embeds }),
    });
    if (!res.ok) throw new Error(`Weekly leaderboard post failed: ${res.status} ${await res.text().catch(() => '')}`);
}

// The one place all three /leaderboard views funnel through for final delivery -
// tries the generated image first, falls back to the JSON+embeds PATCH
// (buildLeaderboardRowEmbeds) on any failure so this can never reply worse than the
// already-shipped embed version.
export async function sendLeaderboardResult(
    applicationId: string,
    token: string,
    content: string,
    headerLabel: string,
    rows: LeaderboardRowInput[]
): Promise<void> {
    const patchUrl = `https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/@original`;

    // Top-level guard: renderLeaderboardImage already catches its own failures, but
    // this wraps EVERYTHING else too (FormData/Blob construction, the multipart PATCH
    // itself) - a Discord interaction that never gets its follow-up PATCH shows the
    // user "The application did not respond" with no way to retry, which is worse
    // than any fallback content this function could send instead. Nothing here should
    // ever throw past this function.
    try {
        const png = rows.length > 0 ? await renderLeaderboardImage(headerLabel, rows) : null;

        if (png) {
            const form = new FormData();
            // The image's Discord-icon watermark can't be clickable (pixels never
            // are). Belt and suspenders for the invite: a style-5 link button
            // (payload shape verified accepted by Discord's API directly), the
            // clickable embed title, AND the raw link in the message content -
            // Discord linkifies content URLs in every client with no components-API
            // subtleties, wrapped in <> so it doesn't unfurl a second invite embed.
            form.append('payload_json', JSON.stringify({
                content: `-# Join the Heatchecks Discord → <${HEATCHECKS_DISCORD_INVITE}>`,
                embeds: [{ title: 'Heatchecks', url: HEATCHECKS_DISCORD_INVITE, image: { url: 'attachment://leaderboard.png' } }],
                components: [{
                    type: 1,
                    components: [{ type: 2, style: 5, label: 'Join the Heatchecks Discord', url: HEATCHECKS_DISCORD_INVITE }],
                }],
            }));
            form.append('files[0]', new Blob([png], { type: 'image/png' }), 'leaderboard.png');
            const res = await fetch(patchUrl, { method: 'PATCH', body: form });
            if (res.ok) return;
            const bodyText = await res.text().catch(() => '');
            lastRenderError = `Multipart PATCH ${res.status}: ${bodyText.slice(0, 300)}`;
            console.error(`[leaderboard-image] Multipart PATCH failed (${res.status}): ${bodyText}`);
        }

        const embeds = buildLeaderboardRowEmbeds(rows);
        const debugSuffix = lastRenderError ? `\n-# debug: ${lastRenderError}` : '';
        await fetch(patchUrl, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: content + debugSuffix, embeds }),
        });
    } catch (err) {
        console.error('[leaderboard-image] sendLeaderboardResult failed entirely, sending plain content:', err);
        try {
            await fetch(patchUrl, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: content || 'Could not build the leaderboard right now — try again shortly.' }),
            });
        } catch (finalErr) {
            console.error('[leaderboard-image] Final fallback PATCH also failed:', finalErr);
        }
    }
}
