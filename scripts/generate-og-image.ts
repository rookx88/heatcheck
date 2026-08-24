// Per-article Twitter/OG share card generator. Every Tank article previously shared the
// same generic world-map placeholder (scripts/templates/waitlist-landing-template.ts's
// hardcoded ogImage) - nothing pick-specific, and the interactive 3D Fishtank artifact
// (components/Fishtank.tsx) only ever exists as live CSS-3D DOM, so it was never going
// to render for a social crawler either. This renders a flat, static "branded data card"
// per Tank instead: matchup, the pick's storyline, both sides, odds, resolve date - a
// real stat card, not an attempted screenshot of the wobbly cube.
//
// Satori lays the card out (a constrained flexbox-only CSS subset) and rasterizes text
// to real SVG paths using the embedded font data - no external font/network dependency
// at render time, which is why the five weights below are committed TTF files rather
// than fetched from Google Fonts on every build.

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FONT_DIR = join(__dirname, 'assets', 'fonts');

const CARD_WIDTH = 1200;
const CARD_HEIGHT = 630;

const COLORS = {
    navyDark: '#060c22',
    navy: '#0b1a45',
    navyLight: '#14275f',
    gold: '#ffc72c',
    teal: '#2fe6d9',
    white: '#ffffff',
    muted: 'rgba(255,255,255,0.68)',
    faint: 'rgba(255,255,255,0.15)',
};

let cachedFonts: { name: string; data: Buffer; weight: 400 | 700 | 800; style: 'normal' }[] | null = null;
function loadFonts() {
    if (cachedFonts) return cachedFonts;
    cachedFonts = [
        { name: 'Baloo 2', data: readFileSync(join(FONT_DIR, 'Baloo2-Bold.ttf')), weight: 700, style: 'normal' },
        { name: 'Baloo 2', data: readFileSync(join(FONT_DIR, 'Baloo2-ExtraBold.ttf')), weight: 800, style: 'normal' },
        { name: 'Nunito', data: readFileSync(join(FONT_DIR, 'Nunito-Regular.ttf')), weight: 400, style: 'normal' },
        { name: 'Nunito', data: readFileSync(join(FONT_DIR, 'Nunito-Bold.ttf')), weight: 700, style: 'normal' },
        { name: 'Nunito', data: readFileSync(join(FONT_DIR, 'Nunito-ExtraBold.ttf')), weight: 800, style: 'normal' },
    ];
    return cachedFonts;
}

// Keeps a string to a rough character budget without cutting mid-word - used for the
// hook sentence, the one field here with no existing length guarantee (tagline is
// already model-constrained to 2-6 words per TankArticle's own contract).
function truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    const cut = text.slice(0, maxChars);
    const lastSpace = cut.lastIndexOf(' ');
    return `${cut.slice(0, lastSpace > 0 ? lastSpace : maxChars)}…`;
}

export interface OgCardData {
    league: string;
    contextLabel: string;      // "{league} · {subject}" - already computed for the deck payload
    tagline: string;           // 2-6 words, model-constrained
    hook: string;              // one sentence
    sides: string[];           // call.sides, length 2
    oddsOrMarketLabel: string; // live odds or market label
    settleDateLabel: string;   // "Resolves {date}"
}

function pill(label: string, accent: string) {
    return {
        type: 'div',
        props: {
            style: {
                display: 'flex',
                flexGrow: 1,
                flexDirection: 'column',
                justifyContent: 'center',
                padding: '18px 26px',
                borderRadius: 14,
                background: 'rgba(255,255,255,0.05)',
                borderLeft: `4px solid ${accent}`,
                fontFamily: 'Nunito',
                fontWeight: 700,
                fontSize: 26,
                color: COLORS.white,
                lineHeight: 1.25,
            },
            children: label,
        },
    };
}

function buildTree(data: OgCardData) {
    return {
        type: 'div',
        props: {
            style: {
                width: CARD_WIDTH,
                height: CARD_HEIGHT,
                display: 'flex',
                flexDirection: 'column',
                padding: '56px 68px',
                background: `linear-gradient(135deg, ${COLORS.navyDark} 0%, ${COLORS.navy} 55%, ${COLORS.navyLight} 100%)`,
                fontFamily: 'Nunito',
                position: 'relative',
            },
            children: [
                // Soft corner glow - the one decorative flourish, kept subtle per the
                // "legible stat card, not illustration" brief.
                {
                    type: 'div',
                    props: {
                        style: {
                            position: 'absolute',
                            top: -160,
                            right: -160,
                            width: 480,
                            height: 480,
                            borderRadius: 480,
                            background: COLORS.teal,
                            opacity: 0.14,
                            display: 'flex',
                        },
                    },
                },
                // Top row: wordmark + league badge
                {
                    type: 'div',
                    props: {
                        style: { display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
                        children: [
                            {
                                type: 'div',
                                props: {
                                    style: {
                                        display: 'flex',
                                        fontFamily: 'Nunito',
                                        fontWeight: 800,
                                        fontSize: 24,
                                        letterSpacing: 3,
                                        textTransform: 'uppercase',
                                        color: COLORS.teal,
                                    },
                                    children: 'HEATCHECKS · THE TANK',
                                },
                            },
                            {
                                type: 'div',
                                props: {
                                    style: {
                                        display: 'flex',
                                        padding: '8px 20px',
                                        borderRadius: 999,
                                        background: COLORS.gold,
                                        color: COLORS.navyDark,
                                        fontFamily: 'Nunito',
                                        fontWeight: 800,
                                        fontSize: 22,
                                        letterSpacing: 1,
                                        textTransform: 'uppercase',
                                    },
                                    children: data.league,
                                },
                            },
                        ],
                    },
                },
                // Middle: context label, tagline headline, hook sentence
                {
                    type: 'div',
                    props: {
                        style: { display: 'flex', flexDirection: 'column', flexGrow: 1, justifyContent: 'center', marginTop: 8 },
                        children: [
                            {
                                type: 'div',
                                props: {
                                    style: {
                                        display: 'flex',
                                        fontFamily: 'Nunito',
                                        fontWeight: 800,
                                        fontSize: 22,
                                        letterSpacing: 2,
                                        textTransform: 'uppercase',
                                        color: COLORS.muted,
                                        marginBottom: 18,
                                    },
                                    children: data.contextLabel,
                                },
                            },
                            {
                                type: 'div',
                                props: {
                                    style: {
                                        display: 'flex',
                                        fontFamily: 'Baloo 2',
                                        fontWeight: 800,
                                        fontSize: 68,
                                        lineHeight: 1.12,
                                        color: COLORS.white,
                                    },
                                    children: data.tagline,
                                },
                            },
                            {
                                type: 'div',
                                props: {
                                    style: {
                                        display: 'flex',
                                        fontFamily: 'Nunito',
                                        fontWeight: 600,
                                        fontSize: 27,
                                        lineHeight: 1.4,
                                        color: COLORS.muted,
                                        marginTop: 20,
                                    },
                                    children: truncate(data.hook, 120),
                                },
                            },
                        ],
                    },
                },
                // Bottom: the two sides, odds/market label, resolve date
                {
                    type: 'div',
                    props: {
                        style: {
                            display: 'flex',
                            flexDirection: 'column',
                            marginTop: 24,
                            paddingTop: 28,
                            borderTop: `1px solid ${COLORS.faint}`,
                        },
                        children: [
                            {
                                type: 'div',
                                props: {
                                    style: { display: 'flex', flexDirection: 'row', gap: 20 },
                                    children: [
                                        pill(truncate(data.sides[0] ?? '', 40), COLORS.teal),
                                        pill(truncate(data.sides[1] ?? '', 40), COLORS.gold),
                                    ],
                                },
                            },
                            {
                                type: 'div',
                                props: {
                                    style: {
                                        display: 'flex',
                                        flexDirection: 'row',
                                        justifyContent: 'space-between',
                                        marginTop: 18,
                                        fontFamily: 'Nunito',
                                        fontWeight: 700,
                                        fontSize: 22,
                                        color: COLORS.muted,
                                    },
                                    children: [
                                        { type: 'div', props: { style: { display: 'flex' }, children: data.oddsOrMarketLabel } },
                                        { type: 'div', props: { style: { display: 'flex' }, children: data.settleDateLabel } },
                                    ],
                                },
                            },
                        ],
                    },
                },
            ],
        },
    };
}

export async function generateOgImage(data: OgCardData): Promise<Buffer> {
    const svg = await satori(buildTree(data) as any, {
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        fonts: loadFonts(),
    });
    const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: CARD_WIDTH } });
    return resvg.render().asPng();
}
