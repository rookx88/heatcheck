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
import { buildLeaderboardRowEmbeds, colorForRank, type LeaderboardRowInput } from './discord-leaderboard-card';

const IMAGE_WIDTH = 720;
const HEADER_HEIGHT = 84;
const ROW_HEIGHT = 92;
const ROW_GAP = 12;
const PADDING = 28;
const AVATAR_SIZE = 60;

const COLOR_BG = '#0b0713'; // this codebase's existing dark brand base (scripts/generate-og-image.ts)
const COLOR_WHITE = '#ffffff';
const COLOR_DARK_TEXT = '#0b0713';

// Rank 1-2 (gold/silver) are light backgrounds - dark text reads better, same
// gold-bg/dark-text pairing generate-og-image.ts's own league badge already uses.
// Rank 3+ (bronze/slate) are darker - white text.
function textColorForRank(rank: number): string {
    return rank <= 2 ? COLOR_DARK_TEXT : COLOR_WHITE;
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

const FONTS: { name: string; data: ArrayBuffer; weight: 400 | 700 | 800; style: 'normal' }[] = [
    { name: 'Baloo 2', data: BALOO2_EXTRABOLD, weight: 800, style: 'normal' },
    { name: 'Nunito', data: NUNITO_REGULAR, weight: 400, style: 'normal' },
    { name: 'Nunito', data: NUNITO_BOLD, weight: 700, style: 'normal' },
    { name: 'Nunito', data: NUNITO_EXTRABOLD, weight: 800, style: 'normal' },
];

// One failed avatar can't take down the whole render - falls back to a plain tier-
// colored circle for that row.
async function loadAvatarDataUri(url: string, fallbackColor: string): Promise<string> {
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`status ${res.status}`);
        const buf = await res.arrayBuffer();
        const contentType = res.headers.get('content-type') || 'image/png';
        const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        return `data:${contentType};base64,${base64}`;
    } catch {
        // 1x1 solid-color PNG data URI as a last resort - satori still needs a valid
        // image src, an empty/broken one would fail the whole render.
        return `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="${AVATAR_SIZE}" height="${AVATAR_SIZE}"><rect width="100%" height="100%" fill="${fallbackColor}"/></svg>`)}`;
    }
}

function buildRowNode(row: LeaderboardRowInput, avatarDataUri: string) {
    const hexColor = `#${colorForRank(row.rank).toString(16).padStart(6, '0')}`;
    const textColor = textColorForRank(row.rank);
    return {
        type: 'div',
        props: {
            style: {
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                width: IMAGE_WIDTH - PADDING * 2,
                height: ROW_HEIGHT,
                borderRadius: 16,
                background: hexColor,
                padding: '0 24px',
                gap: 20,
            },
            children: [
                {
                    type: 'div',
                    props: {
                        style: { display: 'flex', width: 36, fontFamily: 'Baloo 2', fontWeight: 800, fontSize: 30, color: textColor },
                        children: `#${row.rank}`,
                    },
                },
                {
                    type: 'img',
                    props: {
                        src: avatarDataUri,
                        width: AVATAR_SIZE,
                        height: AVATAR_SIZE,
                        style: { borderRadius: '50%', display: 'flex' },
                    },
                },
                {
                    type: 'div',
                    props: {
                        style: { display: 'flex', flexDirection: 'column', justifyContent: 'center', flexGrow: 1 },
                        children: [
                            { type: 'div', props: { style: { display: 'flex', fontFamily: 'Nunito', fontWeight: 800, fontSize: 22, color: textColor }, children: row.displayName } },
                            { type: 'div', props: { style: { display: 'flex', fontFamily: 'Nunito', fontWeight: 700, fontSize: 17, color: textColor, opacity: 0.85 }, children: row.scoreLine } },
                        ],
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

        const totalHeight = PADDING * 2 + HEADER_HEIGHT + rows.length * ROW_HEIGHT + (rows.length - 1) * ROW_GAP;
        const tree = {
            type: 'div',
            props: {
                style: {
                    width: IMAGE_WIDTH,
                    height: totalHeight,
                    display: 'flex',
                    flexDirection: 'column',
                    background: COLOR_BG,
                    padding: PADDING,
                    gap: ROW_GAP,
                },
                children: [
                    {
                        type: 'div',
                        props: {
                            style: {
                                display: 'flex',
                                height: HEADER_HEIGHT,
                                alignItems: 'center',
                                fontFamily: 'Baloo 2',
                                fontWeight: 800,
                                fontSize: 30,
                                color: COLOR_WHITE,
                            },
                            children: headerLabel,
                        },
                    },
                    ...rows.map((row, i) => buildRowNode(row, avatarDataUris[i])),
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

// The one place all three /leaderboard views funnel through for final delivery -
// tries the generated image first, falls back to the JSON+embeds PATCH
// (buildLeaderboardRowEmbeds) on any failure so this can never reply worse than the
// already-shipped embed version.
export async function sendLeaderboardResult(
    applicationId: string,
    token: string,
    content: string,
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
        const headerLabel = content.replace(/\*\*/g, '');
        const png = rows.length > 0 ? await renderLeaderboardImage(headerLabel, rows) : null;

        if (png) {
            const form = new FormData();
            form.append('payload_json', JSON.stringify({ content: '', embeds: [{ image: { url: 'attachment://leaderboard.png' } }] }));
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
