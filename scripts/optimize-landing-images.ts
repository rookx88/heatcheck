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
    { source: 'HeatChecksWorldMap.svg', outName: 'world-map', width: 1600, blackBackground: true },
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

async function run(): Promise<void> {
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }

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
