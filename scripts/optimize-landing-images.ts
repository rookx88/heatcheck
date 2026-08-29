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
 * These Canva exports don't embed the raster at a plain 1:1 scale - each
 * wraps it in a `<g transform="matrix(a,0,0,d,e,f)">` that maps raw pixel
 * space onto the SVG's OWN top-level viewBox (its declared `viewBox="0 0 W
 * H"`, which is the correct reference frame here - NOT whatever size the
 * consuming React component later requests when it embeds the whole file;
 * that's a separate, later uniform rescale that only avoids distorting
 * anything when this inner step is already right). HeatChecksWorldMap.svg
 * happens to embed its raster at exactly 1:1 with its own viewBox (no crop
 * needed - verified by computing this and finding the visible region equals
 * the full raster), but Tanks- Background.svg does not: its raster is
 * oversized and off-center relative to the viewBox, so only a cropped
 * sub-region is ever actually visible. Extracting the FULL raster unchanged
 * (as an earlier version of this script did) reproduced the wrong pixels at
 * the wrong scale once esbuild stopped going through the SVG's own viewBox
 * math and started embedding the raster directly - same file size win, but
 * it silently shifted the artwork relative to the hand-traced hotspot on the
 * Tank screen. Computing and applying this crop up front means the output
 * file's own aspect ratio already matches the target viewBox exactly, so a
 * plain `<image width height>` embed needs no further scaling to reproduce
 * the original placement.
 */
function computeVisibleRasterCrop(
    svgPath: string,
    nativeWidth: number,
    nativeHeight: number,
): { left: number; top: number; width: number; height: number } {
    const svg = fs.readFileSync(svgPath, 'utf-8');
    const viewBoxMatch = svg.match(/<svg[^>]*viewBox="0 0 ([\d.]+) ([\d.]+)"/);
    const gMatch = svg.match(/<g transform="matrix\(([^)]+)\)">/);
    if (!viewBoxMatch || !gMatch) {
        throw new Error(`Could not find the outer viewBox / embedding transform in ${svgPath}`);
    }
    const [, vbWStr, vbHStr] = viewBoxMatch;
    const [a, , , d, e, f] = gMatch[1].split(',').map(Number);
    const vbW = Number(vbWStr);
    const vbH = Number(vbHStr);

    // Invert the transform: which raw-pixel range maps onto the visible
    // [0,vbW] x [0,vbH] window?
    const pxMin = -e / a;
    const pxMax = (vbW - e) / a;
    const pyMin = -f / d;
    const pyMax = (vbH - f) / d;

    const left = Math.round(pxMin);
    const top = Math.round(pyMin);
    const width = Math.round(pxMax - pxMin);
    const height = Math.round(pyMax - pyMin);

    if (left < 0 || top < 0 || left + width > nativeWidth || top + height > nativeHeight) {
        throw new Error(
            `${svgPath}: computed crop [${left},${top},${width}x${height}] falls outside the ` +
            `native raster (${nativeWidth}x${nativeHeight}) - this source needs padding, not `+
            `cropping; extend the script rather than guessing.`
        );
    }
    return { left, top, width, height };
}

/**
 * The game screens' full-bleed backgrounds (individual Tank pages) were
 * never wired into this optimization pipeline - each ships its raw Canva
 * SVG export directly (components/TankScreen.tsx imports straight from
 * assets/new-website/*.svg), at 3.1MB, because the
 * lossless-PNG-or-barely-compressed-JPEG payload embedded in the SVG never
 * got re-encoded. Unlike the `jobs` loop above, this must NOT trim or resize
 * beyond the exact visible-region crop computed above: these components
 * hand-trace hotspot paths and hardcode a VIEWBOX against the source's exact
 * pixel framing - cropping any differently (or not at all, when the source
 * needs it) shifts every hotspot out of alignment with the artwork. Only the
 * codec changes (PNG/JPEG -> WebP) and the crop that reproduces the SVG's own
 * original framing; dramatically smaller file, identical picture.
 */
const gameBackgroundJobs: GameBackgroundJob[] = [
    { source: 'Tanks- Background.svg', outName: 'tanks-bg' },
];

async function buildGameBackgrounds(): Promise<void> {
    for (const job of gameBackgroundJobs) {
        const svgPath = path.join(sourceDir, job.source);
        let buffer = extractLargestEmbeddedRaster(svgPath);
        const nativeMeta = await sharp(buffer).metadata();
        const crop = computeVisibleRasterCrop(svgPath, nativeMeta.width!, nativeMeta.height!);
        buffer = await sharp(buffer).extract(crop).toBuffer();
        if (job.blackBackground) {
            buffer = await deriveAlphaFromBrightness(buffer);
        }

        const webpPath = path.join(outDir, `${job.outName}.webp`);
        const info = await sharp(buffer).webp({ quality: 82 }).toFile(webpPath);

        const webpSize = fs.statSync(webpPath).size;
        const originalSize = fs.statSync(svgPath).size;
        const cropped = crop.width !== nativeMeta.width || crop.height !== nativeMeta.height;
        console.log(
            `âœ“ ${job.source} (${(originalSize / 1024 / 1024).toFixed(1)}MB) -> ` +
            `${job.outName}.webp (${(webpSize / 1024).toFixed(0)}KB) [${info.width}x${info.height}` +
            `${cropped ? `, cropped from native ${nativeMeta.width}x${nativeMeta.height}` : ', native size'}]`
        );
    }
}

/**
 * All three world-map outputs, derived from the redesigned planet artwork at
 * assets/new-website/world_map_nav.png (1500x1500, real alpha channel - unlike
 * the retired HeatChecksWorldMap.svg Canva export, no embedded-PNG extraction,
 * visible-region crop, or brightness-derived alpha applies):
 *
 * - world-map-interactive.webp: the interactive island (components/WorldMap.tsx).
 *   MUST stay untrimmed/unresized at the native 1500x1500 - worldMapRegions.ts's
 *   hand-placed hotspots and WORLD_MAP_VIEWBOX are calibrated to exactly this
 *   framing; any trim or resize shifts every hotspot off the artwork.
 * - world-map.webp/.png: trimmed + resized static <picture> fallback for the
 *   homepage SSR (lib/pages-functions/homepage/render.ts). 1120 = ~2x retina
 *   for its display context (capped well below that width everywhere).
 * - og-share-world-map.jpg: the OG/Twitter share card, fixed 1200x630 cover
 *   crop. JPG (not WebP) deliberately - several link-unfurlers (historically
 *   including Twitter/X) handle WebP OG images inconsistently.
 */
async function buildWorldMapImages(): Promise<void> {
    const srcPath = path.join(sourceDir, 'world_map_nav.png');

    // Interactive canvas: codec change only, framing untouched (see above).
    const interactivePath = path.join(outDir, 'world-map-interactive.webp');
    const interactiveInfo = await sharp(srcPath).webp({ quality: 82 }).toFile(interactivePath);
    console.log(
        `âœ“ world_map_nav.png -> world-map-interactive.webp ` +
        `(${(fs.statSync(interactivePath).size / 1024).toFixed(0)}KB) ` +
        `[${interactiveInfo.width}x${interactiveInfo.height}, native framing]`
    );

    // Static fallback pair: trim the transparent padding, then cap the width.
    const trimmedBuffer = await sharp(srcPath).trim().toBuffer();
    const webpPath = path.join(outDir, 'world-map.webp');
    const pngPath = path.join(outDir, 'world-map.png');
    await sharp(trimmedBuffer).resize({ width: 1120, withoutEnlargement: true }).webp({ quality: 82 }).toFile(webpPath);
    const pngInfo = await sharp(trimmedBuffer).resize({ width: 1120, withoutEnlargement: true }).png({ compressionLevel: 9 }).toFile(pngPath);
    console.log(
        `âœ“ world_map_nav.png -> world-map.webp (${(fs.statSync(webpPath).size / 1024).toFixed(0)}KB) + ` +
        `world-map.png (${(pngInfo.size / 1024).toFixed(0)}KB) [trimmed to ${pngInfo.width}x${pngInfo.height}]`
    );

    // OG card: flatten onto the same midnight-purple the page background uses,
    // since the source has transparent padding and a JPG can't carry alpha - a
    // transparent-turned-white background would look like a bug in every link
    // preview.
    const ogPath = path.join(outDir, 'og-share-world-map.jpg');
    await sharp(trimmedBuffer)
        .flatten({ background: '#160c27' })
        .resize(1200, 630, { fit: 'cover', position: 'attention' })
        .jpeg({ quality: 85 })
        .toFile(ogPath);
    console.log(`âœ“ og-share-world-map.jpg (${(fs.statSync(ogPath).size / 1024).toFixed(0)}KB) [1200x630]`);
}

/**
 * The two settlement-email hero images (tank-email-correct/incorrect.jpg) - unlike
 * every other job here, these sources aren't SVG-wrapped exports from assets/new-
 * website/, they're plain flat 1080x1080 PNGs (no alpha channel) sitting at the repo
 * root, so no extractEmbeddedPng/deriveAlphaFromBrightness step applies. JPG (not
 * WebP or PNG) for the same reason buildWorldMapImages() uses JPG for the OG card - email clients
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
        console.log(`âœ“ ${job.outName}.jpg (${(size / 1024).toFixed(0)}KB) [600px wide]`);
    }
}

async function run(): Promise<void> {
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }

    await buildWorldMapImages();
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
            `âœ“ ${job.source} (${(originalSize / 1024).toFixed(0)}KB) -> ` +
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
