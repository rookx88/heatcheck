/**
 * Builds the pet's expression sprites - full-body variants of the base Mud Puppy
 * art with a different head, swapped in by components/PetPortrait.tsx while the
 * PetWidget speech bubble "speaks" a notification with a mood (happy / sad).
 *
 * Why full-body sprites rather than a head overlay: the portrait is ONE <img>
 * carrying the per-pet hue-rotate filter (components/petRender.ts) and the
 * widget's drop-shadow rule. Swapping its src keeps the tint, the shadow, the
 * aura layering and every responsive size for free; a second layered <img>
 * would need its own filter, would double the drop-shadow along the neck seam,
 * and would still let the base's hair tips peek out around a different
 * silhouette.
 *
 * Inputs (assets/images/pets/, tracked, never shipped - generate-static-site's
 * NEW_SITE_IMAGES allowlist is opt-in):
 *   expression-happy-src.png / expression-sad-src.png - head-only, 1080x1080,
 *   drawn at the SAME scale as the base head (measured row-for-row), just
 *   translated. Both carry a stray opaque speck near (796,338); cropping to the
 *   head's bounding box drops it.
 *
 * Method per expression: clear every base row above the neck line (the base has
 * nothing but the head up there - the tail starts ~90px lower), crop the source
 * head, feather the bottom of its neck stub to transparent, and composite it at
 * 1:1 so the stub dissolves into the base neck. Same-hue skin on both sides of
 * the seam, so the hue-rotate filter can't split it.
 *
 * Outputs: assets/images/pets/mud_puppy_{happy,sad}.png (1158x1158, the base
 * canvas), mirrored into public/ and dist/ when present (make-auth-art.ts idiom)
 * so a running dev server picks them up without a static rebuild.
 *
 * Run: npx tsx scripts/make-pet-expressions.ts [--sheet <dir>]
 *   --sheet writes a contact sheet (base | happy | sad, neck-seam 2x crops, and
 *   a hue-rotated copy) into <dir> for eyeballing the seam.
 */
import * as fs from 'fs';
import * as path from 'path';
import sharp, { type OverlayOptions } from 'sharp';

const BASE_FILE = 'mud_puppy_base_axol.png';
const CANVAS = 1158;

interface Expression {
    mood: 'happy' | 'sad';
    source: string;
    // Head bounding box in the source (also what excludes the stray speck).
    crop: { left: number; top: number; width: number; height: number };
    // Where the crop's top-left lands on the base canvas.
    place: { left: number; top: number };
    // Base rows above this are cleared; the head's stub covers the cut.
    neckY: number;
    // Fraction of the crop's height (from the top) where the alpha feather starts.
    featherFrom: number;
}

const EXPRESSIONS: Expression[] = [
    {
        mood: 'happy',
        source: 'expression-happy-src.png',
        crop: { left: 399, top: 22, width: 270, height: 278 },
        // Measured: the happy head is the base head shifted (+1, +40).
        place: { left: 400, top: 62 },
        neckY: 315,
        featherFrom: 0.92,
    },
    {
        mood: 'sad',
        source: 'expression-sad-src.png',
        // Drooped pose: the head tilts forward so the chin hangs BELOW the base's
        // jaw line, over the upper neck - which is what a slump looks like, so the
        // chin is drawn fully opaque on top of the neck (no feather: a feathered
        // chin let the base's throat shading bleed through and read as a double
        // jaw). The base is cut two rows lower than for happy so none of its own
        // chin outline peeks past the narrower sad jaw.
        crop: { left: 372, top: 13, width: 275, height: 280 },
        // Chin centred over the base neck (~48px right of where the source drew
        // it; the face ends up a hair off the body's axis, which reads as the slump).
        place: { left: 418, top: 63 },
        neckY: 317,
        featherFrom: 1,
    },
];

const petsDir = path.join(process.cwd(), 'assets', 'images', 'pets');
const mirrors = [
    path.join(process.cwd(), 'public', 'assets', 'images', 'pets'),
    path.join(process.cwd(), 'dist', 'assets', 'images', 'pets'),
];

const transparent = { r: 0, g: 0, b: 0, alpha: 0 };

// A white rect whose opacity fades to 0 over the bottom of the crop. Composited
// with blend 'dest-in' it multiplies the head's alpha, so the neck stub's cut edge
// never draws a line across the base neck beneath it.
function featherMask(width: number, height: number, from: number): Buffer {
    return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="${from}" stop-color="#fff" stop-opacity="1"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#g)"/>
</svg>`);
}

async function buildExpression(exp: Expression): Promise<Buffer> {
    const basePath = path.join(petsDir, BASE_FILE);
    const srcPath = path.join(petsDir, exp.source);
    for (const p of [basePath, srcPath]) {
        if (!fs.existsSync(p)) throw new Error(`Missing source image: ${p}`);
    }

    // Headless body: keep everything from the neck line down, pad the top back
    // out with transparency so the canvas stays 1158x1158.
    const body = await sharp(basePath)
        .ensureAlpha()
        .extract({ left: 0, top: exp.neckY, width: CANVAS, height: CANVAS - exp.neckY })
        .extend({ top: exp.neckY, background: transparent })
        .png()
        .toBuffer();

    const head = await sharp(srcPath)
        .ensureAlpha()
        .extract(exp.crop)
        .composite([{ input: featherMask(exp.crop.width, exp.crop.height, exp.featherFrom), blend: 'dest-in' }])
        .png()
        .toBuffer();

    return sharp(body)
        .composite([{ input: head, left: exp.place.left, top: exp.place.top }])
        .png({ compressionLevel: 9 })
        .toBuffer();
}

async function writeContactSheet(dir: string, base: Buffer, built: Record<string, Buffer>): Promise<void> {
    fs.mkdirSync(dir, { recursive: true });
    const panels = [{ name: 'base', buf: base }, ...Object.entries(built).map(([name, buf]) => ({ name, buf }))];

    const third = Math.round(CANVAS / 3);
    // Neck seam region, 2x.
    const seam = { left: 380, top: 250, width: 300, height: 140 };
    const seamW = seam.width * 2;
    const seamH = seam.height * 2;
    const rowH = third + seamH + 8;
    const sheetW = panels.length * (third + 8);
    // Two rows: natural green, then hue-rotated (a blue pet) to prove the seam
    // survives the CSS filter.
    const sheetH = rowH * 2 + 8;

    const layers: OverlayOptions[] = [];
    for (const [row, hue] of [[0, 0], [1, 127]] as const) {
        for (let i = 0; i < panels.length; i++) {
            const x = i * (third + 8);
            const y = row * rowH;
            let img = sharp(panels[i].buf);
            if (hue) img = img.modulate({ hue });
            const full = await img.png().toBuffer();
            layers.push({ input: await sharp(full).resize(third, third).png().toBuffer(), left: x, top: y });
            layers.push({
                input: await sharp(full).extract(seam).resize(seamW, seamH, { kernel: 'nearest' }).png().toBuffer(),
                left: x,
                top: y + third + 4,
            });
        }
    }
    const sheet = await sharp({ create: { width: sheetW, height: sheetH, channels: 4, background: { r: 40, g: 40, b: 48, alpha: 1 } } })
        .composite(layers)
        .png()
        .toBuffer();
    const out = path.join(dir, 'pet-expressions-sheet.png');
    fs.writeFileSync(out, sheet);
    console.log(`✓ contact sheet → ${out}`);
}

async function main(): Promise<void> {
    const sheetIdx = process.argv.indexOf('--sheet');
    const sheetDir = sheetIdx >= 0 ? process.argv[sheetIdx + 1] : null;

    const built: Record<string, Buffer> = {};
    for (const exp of EXPRESSIONS) {
        const buffer = await buildExpression(exp);
        const outFile = `mud_puppy_${exp.mood}.png`;
        fs.writeFileSync(path.join(petsDir, outFile), buffer);
        for (const dir of mirrors) {
            if (fs.existsSync(dir)) fs.writeFileSync(path.join(dir, outFile), buffer);
        }
        const meta = await sharp(buffer).metadata();
        console.log(`✓ ${outFile}  ${meta.width}x${meta.height}  ${(buffer.length / 1024).toFixed(0)}KB`);
        built[exp.mood] = buffer;
    }

    if (sheetDir) {
        await writeContactSheet(sheetDir, fs.readFileSync(path.join(petsDir, BASE_FILE)), built);
    }
}

main().catch((err) => {
    console.error('Failed to build pet expressions:', err);
    process.exit(1);
});
