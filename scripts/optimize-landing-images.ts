/**
 * One-off script: the brand assets in assets/new-website/*.svg are actually
 * PNG images wrapped in an SVG (with filter defs), which is why they're 1-3MB
 * each. This extracts the embedded base64 PNG payload, resizes it to a
 * sensible display size (~2x retina), and re-encodes as WebP (+ PNG fallback)
 * into assets/images/, where generate-static-site.ts's copyImages() picks
 * up anything placed there automatically.
 *
 * Run: npx tsx scripts/optimize-landing-images.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';

const sourceDir = path.join(process.cwd(), 'assets', 'new-website');
const outDir = path.join(process.cwd(), 'assets', 'images');

interface ImageJob {
    source: string;
    outName: string;
    width: number;
    /**
     * The logo and nav-checkmark art were exported as a glow effect on a
     * solid black canvas (no alpha channel at all - confirmed via
     * sharp metadata). Re-derive alpha from per-pixel brightness so the
     * black canvas becomes transparent and the glow itself stays intact,
     * instead of shipping a black rectangle.
     */
    blackBackground?: boolean;
}

const jobs: ImageJob[] = [
    { source: 'heatcheckslogo-new.svg', outName: 'heatchecks-logo', width: 500, blackBackground: true },
    { source: 'CheckNavBar.svg', outName: 'checknav', width: 140, blackBackground: true },
    // 1120 = ~2x retina for its actual display context (waitlist-landing-template.ts's
    // .hc-world-map sits inside .hc-page, capped at max-width: 560px) - was 1600, which
    // is ~3x oversized for that container and made this the heaviest asset on the LCP
    // path for no visual benefit, since it's never displayed anywhere near that wide.
    { source: 'HeatChecksWorldMap.svg', outName: 'world-map', width: 1120, blackBackground: true },
    { source: 'MudPuppyDefault.svg', outName: 'mudpuppy-default', width: 800, blackBackground: true },
    { source: 'MudPuppyJersey.svg', outName: 'mudpuppy-jersey', width: 800, blackBackground: true },
    { source: 'MudPuppyFootball.svg', outName: 'mudpuppy-football', width: 800, blackBackground: true },
];

/**
 * Convert a "glow on black" opaque PNG into one with real alpha: alpha for
 * each pixel becomes max(R, G, B), so pure black -> fully transparent and
 * bright glow colors stay fully opaque.
 */
async function deriveAlphaFromBrightness(pngBuffer: Buffer): Promise<Buffer> {
    const img = sharp(pngBuffer).ensureAlpha();
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < data.length; i += info.channels) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        data[i + 3] = Math.max(r, g, b);
    }
    return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels as 4 } })
        .png()
        .toBuffer();
}

/**
 * These SVGs embed two base64 PNGs: a small one used purely to derive an
 * alpha mask (via a luminance feColorMatrix), and a larger one holding the
 * actual full-color artwork. We want the largest embedded image.
 */
function extractEmbeddedPng(svgPath: string): Buffer {
    const svg = fs.readFileSync(svgPath, 'utf-8');
    const re = /xlink:href="data:image\/png;base64,([^"]+)"/g;
    let match: RegExpExecArray | null;
    let largest: Buffer | null = null;
    while ((match = re.exec(svg)) !== null) {
        const buf = Buffer.from(match[1], 'base64');
        if (!largest || buf.length > largest.length) {
            largest = buf;
        }
    }
    if (!largest) {
        throw new Error(`No embedded base64 PNG found in ${svgPath}`);
    }
    return largest;
}

/**
 * Like extractEmbeddedPng, but permissive on both the attribute name (matches
 * bare href="..." as well as xlink:href="...") and the embedded format (PNG or
 * JPEG) - the game-screen backgrounds below (assets/new-website/Tanks-
 * Background.svg) embed a JPEG via a plain href, not xlink:href/PNG like the
 * older brand exports extractEmbeddedPng was written for.
 */
function extractLargestEmbeddedRaster(svgPath: string): Buffer {
    const svg = fs.readFileSync(svgPath, 'utf-8');
    const re = /href="data:image\/(?:png|jpeg);base64,([^"]+)"/g;
    let match: RegExpExecArray | null;
    let largest: Buffer | null = null;
    while ((match = re.exec(svg)) !== null) {
        const buf = Buffer.from(match[1], 'base64');
        if (!largest || buf.length > largest.length) {
            largest = buf;
        }
    }
    if (!largest) {
        throw new Error(`No embedded raster image found in ${svgPath}`);
    }
    return largest;
}

interface GameBackgroundJob {
    source: string;
    outName: string;
    /** World map only - composited over the page's own background, so the
     * black canvas needs to become real transparency (see
     * deriveAlphaFromBrightness). The Tank background is a full-bleed opaque
     * screen background (confirmed via sharp metadata: hasAlpha:false, solid
     * corner pixel) - nothing behind it, so no alpha step needed. */
    blackBackground?: boolean;
}

/**
 * The game screens' full-bleed backgrounds (the interactive world map island
 * and individual Tank pages) were never wired into this optimization
 * pipeline - each ships its raw Canva SVG export directly
 * (components/WorldMap.tsx and components/TankScreen.tsx import straight from
 * assets/new-website/*.svg), at 3.2MB and 3.1MB respectively, because the
 * lossless-PNG-or-barely-compressed-JPEG payload embedded in the SVG never
 * got re-encoded. Unlike the `jobs` loop above, this must NOT trim or resize:
 * these components hand-trace hotspot paths and hardcode a VIEWBOX against
 * the source's exact, untrimmed pixel dimensions - changing the canvas size
 * or cropping would shift every hotspot out of alignment with the artwork.
 * Only the codec changes (PNG/JPEG -> WebP); same pixels, same canvas,
 * dramatically smaller file.
 */
const gameBackgroundJobs: GameBackgroundJob[] = [
    { source: 'Tanks- Background.svg', outName: 'tanks-bg' },
    // Distinct from the trimmed/resized 'world-map' job above (that one feeds
    // the static waitlist page's <img>) - the interactive island
    // (components/WorldMap.tsx) needs the untrimmed canvas its hand-traced
    // region hotspots are calibrated to.
    { source: 'HeatChecksWorldMap.svg', outName: 'world-map-interactive', blackBackground: true },
];

async function buildGameBackgrounds(): Promise<void> {
    for (const job of gameBackgroundJobs) {
        const svgPath = path.join(sourceDir, job.source);
        let buffer = extractLargestEmbeddedRaster(svgPath);
        if (job.blackBackground) {
            buffer = await deriveAlphaFromBrightness(buffer);
        }

        const webpPath = path.join(outDir, `${job.outName}.webp`);
        const info = await sharp(buffer).webp({ quality: 82 }).toFile(webpPath);

        const webpSize = fs.statSync(webpPath).size;
        const originalSize = fs.statSync(svgPath).size;
        console.log(
            `✓ ${job.source} (${(originalSize / 1024 / 1024).toFixed(1)}MB) -> ` +
            `${job.outName}.webp (${(webpSize / 1024).toFixed(0)}KB) [${info.width}x${info.height}, unchanged]`
        );
    }
}

/**
 * The OG/Twitter share-card image (og-share-world-map.jpg) - separate from the `jobs`
 * loop above since it needs a fixed-dimension cover-crop (1200x630, the standard OG
 * card size) rather than a width-preserving resize. JPG (not WebP) deliberately -
 * several link-unfurlers (historically including Twitter/X) handle WebP OG images
 * inconsistently, so JPG is the safe universal choice here specifically.
 */
async function buildOgImage(): Promise<void> {
    const svgPath = path.join(sourceDir, 'HeatChecksWorldMap.svg');
    let pngBuffer = extractEmbeddedPng(svgPath);
    pngBuffer = await deriveAlphaFromBrightness(pngBuffer);
    pngBuffer = await sharp(pngBuffer).trim().toBuffer();

    const outPath = path.join(outDir, 'og-share-world-map.jpg');
    await sharp(pngBuffer)
        // Flatten onto the same navy the page background uses, since the source has
        // transparent padding and a JPG can't carry alpha - a transparent-turned-white
        // background would look like a bug in every link preview.
        .flatten({ background: '#0b1a45' })
        .resize(1200, 630, { fit: 'cover', position: 'attention' })
        .jpeg({ quality: 85 })
        .toFile(outPath);

    const size = fs.statSync(outPath).size;
    console.log(`✓ og-share-world-map.jpg (${(size / 1024).toFixed(0)}KB) [1200x630]`);
}

/**
 * The two settlement-email hero images (tank-email-correct/incorrect.jpg) - unlike
 * every other job here, these sources aren't SVG-wrapped exports from assets/new-
 * website/, they're plain flat 1080x1080 PNGs (no alpha channel) sitting at the repo
 * root, so no extractEmbeddedPng/deriveAlphaFromBrightness step applies. JPG (not
 * WebP or PNG) for the same reason buildOgImage() uses JPG - email clients
 * (Outlook desktop especially) have much worse WebP support than browsers do, and a
 * photographic/gradient scene like this gets little benefit from PNG's lossless
 * compression. 600px is 2x-retina-safe against the ~424px display width the email
 * template uses (see lib/pages-functions/email.ts's settlementEmailHtml).
 */
async function buildSettlementEmailImages(): Promise<void> {
    const emailImageJobs = [
        { source: 'Tank_correct_pick_email_conf.png', outName: 'tank-email-correct' },
        { source: 'Tank_incorrect_pick_email_conf.png', outName: 'tank-email-incorrect' },
    ];

    for (const job of emailImageJobs) {
        const srcPath = path.join(process.cwd(), job.source);
        const outPath = path.join(outDir, `${job.outName}.jpg`);
        await sharp(srcPath)
            .resize({ width: 600 })
            .jpeg({ quality: 82 })
            .toFile(outPath);

        const size = fs.statSync(outPath).size;
        console.log(`✓ ${job.outName}.jpg (${(size / 1024).toFixed(0)}KB) [600px wide]`);
    }
}

async function run(): Promise<void> {
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }

    await buildOgImage();
    await buildGameBackgrounds();
    await buildSettlementEmailImages();

    for (const job of jobs) {
        const svgPath = path.join(sourceDir, job.source);
        let pngBuffer = extractEmbeddedPng(svgPath);
        if (job.blackBackground) {
            pngBuffer = await deriveAlphaFromBrightness(pngBuffer);
        }

        // The source canvases have transparent/empty padding around the
        // actual artwork (e.g. the logo's wordmark sits in the middle of a
        // much taller square canvas). Trim that padding so the image's own
        // bounding box tightly wraps the visible art - otherwise that dead
        // space becomes an invisible gap wherever the image is placed.
        pngBuffer = await sharp(pngBuffer).trim().toBuffer();

        const webpPath = path.join(outDir, `${job.outName}.webp`);
        const pngPath = path.join(outDir, `${job.outName}.png`);

        await sharp(pngBuffer)
            .resize({ width: job.width, withoutEnlargement: true })
            .webp({ quality: 82 })
            .toFile(webpPath);

        const pngInfo = await sharp(pngBuffer)
            .resize({ width: job.width, withoutEnlargement: true })
            .png({ compressionLevel: 9 })
            .toFile(pngPath);

        const webpSize = fs.statSync(webpPath).size;
        const originalSize = fs.statSync(svgPath).size;
        console.log(
            `✓ ${job.source} (${(originalSize / 1024).toFixed(0)}KB) -> ` +
            `${job.outName}.webp (${(webpSize / 1024).toFixed(0)}KB) + ` +
            `${job.outName}.png (${(pngInfo.size / 1024).toFixed(0)}KB) ` +
            `[trimmed to ${pngInfo.width}x${pngInfo.height}]`
        );
    }
}

run().catch((err) => {
    console.error('Image optimization failed:', err);
    process.exit(1);
});
