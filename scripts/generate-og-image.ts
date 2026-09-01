// Per-article Twitter/OG share card generator. Every Tank article previously shared the
// same generic world-map placeholder (scripts/templates/waitlist-landing-template.ts's
// hardcoded ogImage) - nothing pick-specific, and the interactive 3D Fishtank artifact
// (components/Fishtank.tsx) only ever exists as live CSS-3D DOM, so it was never going
// to render for a social crawler either. This renders a flat, static "branded data card"
// per Tank instead: matchup, the pick's storyline, both sides, odds, resolve date, and a
// marketing CTA - a real stat card, not an attempted screenshot of the wobbly cube.
//
// Satori lays the card out (a constrained flexbox-only CSS subset) and rasterizes text
// to real SVG paths using the embedded font data - no external font/network dependency
// at render time, which is why the five weights below are committed TTF files rather
// than fetched from Google Fonts on every build. The background artwork
// (assets/og-background.png) is real illustration, much brighter than the old flat navy
// gradient - the dark scrim between it and the text (see buildTree) is load-bearing for
// legibility, not decorative, since white text over open sky/water would fail contrast
// on its own.

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FONT_DIR = join(__dirname, 'assets', 'fonts');
const BACKGROUND_PATH = join(__dirname, 'assets', 'og-background.png');
const LOGO_PATH = join(__dirname, '..', 'public', 'assets', 'images', 'heatchecks-logo.webp');

const CARD_WIDTH = 1200;
const CARD_HEIGHT = 630;
const LOGO_HEIGHT = 44;
const LOGO_WIDTH = Math.round(LOGO_HEIGHT * (500 / 241)); // source logo's native aspect ratio

const COLORS = {
    navyDark: '#0b0713',
    navy: '#160c27',
    gold: '#ffc72c',
    teal: '#2fe6d9',
    white: '#ffffff',
    muted: 'rgba(255,255,255,0.75)',
    faint: 'rgba(255,255,255,0.22)',
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

// Background art is already exactly CARD_WIDTH x CARD_HEIGHT (checked at asset-drop
// time), so this is just a base64 embed, not a resize. Resvg's raster-image support is
// solid for PNG/JPEG; kept as PNG rather than passing through the source format
// unmodified so this never depends on whatever format someone drops in next time.
let cachedBackground: string | null = null;
function loadBackgroundDataUri(): string {
    if (cachedBackground) return cachedBackground;
    const png = readFileSync(BACKGROUND_PATH);
    cachedBackground = `data:image/png;base64,${png.toString('base64')}`;
    return cachedBackground;
}

// The real site logo is a .webp (topbar() in waitlist-landing-template.ts) - resvg's
// image decoding is reliably tested against PNG/JPEG, not guaranteed for WebP, so this
// re-encodes through sharp (already a project dependency) once and caches the result
// rather than risking a silently-blank logo in the rendered card.
let cachedLogo: string | null = null;
async function loadLogoDataUri(): Promise<string> {
    if (cachedLogo) return cachedLogo;
    const webp = readFileSync(LOGO_PATH);
    const png = await sharp(webp).png().toBuffer();
    cachedLogo = `data:image/png;base64,${png.toString('base64')}`;
    return cachedLogo;
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

/**
 * Which surface the card is being rendered for. Same artwork, fonts and geometry
 * either way - only what sits on top of the background changes:
 *
 *   'social'  - the full share card: matchup line, tagline headline, hook, both
 *               sides, odds/date, and the marketing CTA strip. This is the
 *               og:image a crawler unfurls, seen by people who are NOT on the site.
 *   'article' - the same card rendered to sit inside the article page itself,
 *               under the headline. Drops the three text lines the page already
 *               shows immediately above it (matchup, headline, opening sentence)
 *               and the CTA that would be pointing readers at the page they are
 *               already reading. Keeps the artwork, logo, league badge, and the
 *               sides/odds row, which is the part that isn't repeated anywhere.
 *
 * A render mode rather than card content, so it stays out of OgCardData.
 */
export type OgCardVariant = 'social' | 'article';

function pill(label: string, accent: string) {
    return {
        type: 'div',
        props: {
            style: {
                display: 'flex',
                flexGrow: 1,
                flexDirection: 'column',
                justifyContent: 'center',
                padding: '14px 24px',
                borderRadius: 14,
                background: 'rgba(11,7,19,0.45)',
                borderLeft: `4px solid ${accent}`,
                fontFamily: 'Nunito',
                fontWeight: 700,
                fontSize: 25,
                color: COLORS.white,
                lineHeight: 1.25,
            },
            children: label,
        },
    };
}

function buildTree(data: OgCardData, backgroundDataUri: string, logoDataUri: string, variant: OgCardVariant) {
    const isArticle = variant === 'article';
    return {
        type: 'div',
        props: {
            style: {
                width: CARD_WIDTH,
                height: CARD_HEIGHT,
                display: 'flex',
                position: 'relative',
                fontFamily: 'Nunito',
            },
            children: [
                // Background artwork, full-bleed.
                {
                    type: 'img',
                    props: {
                        src: backgroundDataUri,
                        width: CARD_WIDTH,
                        height: CARD_HEIGHT,
                        style: { position: 'absolute', top: 0, left: 0 },
                    },
                },
                // Legibility scrim - load-bearing, not decorative (see file header).
                // Heavier toward the bottom, where the pills/CTA sit against the
                // busiest part of the illustration; lighter at top so the sky still
                // reads as art behind the small logo/badge row.
                {
                    type: 'div',
                    props: {
                        style: {
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: CARD_WIDTH,
                            height: CARD_HEIGHT,
                            display: 'flex',
                            background: `linear-gradient(180deg, rgba(11,7,19,0.45) 0%, rgba(11,7,19,0.58) 35%, rgba(11,7,19,0.82) 75%, rgba(11,7,19,0.92) 100%)`,
                        },
                    },
                },
                // Foreground content.
                {
                    type: 'div',
                    props: {
                        style: {
                            position: 'relative',
                            width: CARD_WIDTH,
                            height: CARD_HEIGHT,
                            display: 'flex',
                            flexDirection: 'column',
                            padding: '46px 64px',
                        },
                        children: [
                            // Top row: real site logo + league badge
                            {
                                type: 'div',
                                props: {
                                    style: { display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
                                    children: [
                                        { type: 'img', props: { src: logoDataUri, width: LOGO_WIDTH, height: LOGO_HEIGHT, style: { display: 'flex' } } },
                                        {
                                            type: 'div',
                                            props: {
                                                style: {
                                                    display: 'flex',
                                                    padding: '7px 18px',
                                                    borderRadius: 999,
                                                    background: COLORS.gold,
                                                    color: COLORS.navyDark,
                                                    fontFamily: 'Nunito',
                                                    fontWeight: 800,
                                                    fontSize: 20,
                                                    letterSpacing: 1,
                                                    textTransform: 'uppercase',
                                                },
                                                children: data.league,
                                            },
                                        },
                                    ],
                                },
                            },
                            // Middle: context label, tagline headline, hook sentence.
                            // The article variant drops all three (the page prints the
                            // same matchup line and headline directly above the image,
                            // and the hook opens the body text below it) but keeps the
                            // flex growth they supplied - otherwise the bottom row
                            // rides up under the logo instead of staying pinned down.
                            isArticle ? { type: 'div', props: { style: { display: 'flex', flexGrow: 1 } } } : {
                                type: 'div',
                                props: {
                                    style: { display: 'flex', flexDirection: 'column', flexGrow: 1, justifyContent: 'center', marginTop: 6 },
                                    children: [
                                        {
                                            type: 'div',
                                            props: {
                                                style: {
                                                    display: 'flex',
                                                    fontFamily: 'Nunito',
                                                    fontWeight: 800,
                                                    fontSize: 19,
                                                    letterSpacing: 2,
                                                    textTransform: 'uppercase',
                                                    color: COLORS.teal,
                                                    marginBottom: 14,
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
                                                    fontSize: 60,
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
                                                    fontSize: 24,
                                                    lineHeight: 1.35,
                                                    color: COLORS.muted,
                                                    marginTop: 16,
                                                },
                                                children: truncate(data.hook, 100),
                                            },
                                        },
                                    ],
                                },
                            },
                            // Bottom: the two sides, odds/date, marketing CTA footer
                            {
                                type: 'div',
                                props: {
                                    style: {
                                        display: 'flex',
                                        flexDirection: 'column',
                                        marginTop: 20,
                                        paddingTop: 22,
                                        borderTop: `1px solid ${COLORS.faint}`,
                                    },
                                    children: [
                                        {
                                            type: 'div',
                                            props: {
                                                style: { display: 'flex', flexDirection: 'row', gap: 18 },
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
                                                    marginTop: 14,
                                                    fontFamily: 'Nunito',
                                                    fontWeight: 700,
                                                    fontSize: 20,
                                                    color: COLORS.muted,
                                                },
                                                children: [
                                                    { type: 'div', props: { style: { display: 'flex' }, children: data.oddsOrMarketLabel } },
                                                    { type: 'div', props: { style: { display: 'flex' }, children: data.settleDateLabel } },
                                                ],
                                            },
                                        },
                                        // Marketing CTA footer strip - social only. It
                                        // sends people to heatchecks.io, which is where
                                        // the article variant is already being read.
                                        ...(isArticle ? [] : [{
                                            type: 'div',
                                            props: {
                                                style: {
                                                    display: 'flex',
                                                    flexDirection: 'row',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    marginTop: 18,
                                                    padding: '11px 0',
                                                    borderRadius: 12,
                                                    background: 'rgba(255,255,255,0.07)',
                                                    fontFamily: 'Nunito',
                                                    fontWeight: 800,
                                                    fontSize: 19,
                                                    letterSpacing: 0.3,
                                                    color: COLORS.gold,
                                                },
                                                children: 'Visit heatchecks.io — Make Picks → Earn Ember → Build Your Team → Find Collectibles',
                                            },
                                        }]),
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

export async function generateOgImage(data: OgCardData, variant: OgCardVariant = 'social'): Promise<Buffer> {
    const [backgroundDataUri, logoDataUri] = await Promise.all([
        Promise.resolve(loadBackgroundDataUri()),
        loadLogoDataUri(),
    ]);
    const svg = await satori(buildTree(data, backgroundDataUri, logoDataUri, variant) as any, {
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        fonts: loadFonts(),
    });
    const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: CARD_WIDTH } });
    return resvg.render().asPng();
}
