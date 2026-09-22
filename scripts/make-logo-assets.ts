/**
 * One-off script: derives every shipped variant of the Heatchecks wordmark from a
 * single source PNG (assets/new-website/Heatchecks_one_line_header.png).
 *
 * Why this exists separately from optimize-landing-images.ts: that script's job is
 * digging base64 PNGs out of wrapper SVGs (extractEmbeddedPng) and re-deriving alpha
 * from brightness, because the old brand art was exported as a glow on a solid black
 * canvas. The one-line header is a plain RGBA PNG with real alpha, so none of that
 * applies - all this one has to do is trim and re-encode at the sizes each consumer
 * needs.
 *
 * On contrast: the lockup's "HEAT" is black slab lettering and every surface it lands
 * on is dark (site starfield, transactional emails on #000000, the Discord card
 * images on #0e0a38), so a soft white halo behind the mark was tried first. It does
 * not work on this art: the letters are packed tightly enough inside their bounding
 * box (~43% ink coverage) that any blur- or dilate-based glow bleeds across the
 * counters and the letter gaps and renders as a solid white slab, whatever the radius
 * or opacity. It also isn't needed - the source art already carries a baked-in cream
 * outline on every letter, which is what separates it from a black background. So the
 * mark ships exactly as drawn.
 *
 * Run: npx tsx scripts/make-logo-assets.ts
 *
 * Manual, NOT part of build:static - Cloudflare never regenerates these, it only
 * copies assets/images -> public/assets/images. Re-run it by hand if the source art
 * changes, then rebuild so the intrinsic width/height attributes still match.
 */
import * as fs from 'fs';
import * as path from 'path';
import sharp, { type Sharp } from 'sharp';

const SOURCE = path.join(process.cwd(), 'assets', 'new-website', 'Heatchecks_one_line_header.png');
const IMAGE_DIR = path.join(process.cwd(), 'assets', 'images');
const FUNCTIONS_DIR = path.join(process.cwd(), 'lib', 'pages-functions');

/** Display width of the web logo - 2x its largest rendered size, the existing convention. */
const WEB_WIDTH = 500;
/** Email clients cap out well below the web size, and this one is palettised. */
const EMAIL_WIDTH = 400;
/** Source width for the satori/resvg watermark, which renders it ~160px wide. */
const BIN_WIDTH = 240;

function report(file: string, width: number, height: number): void {
    const size = (fs.statSync(file).size / 1024).toFixed(1);
    const rel = path.relative(process.cwd(), file).replace(/\\/g, '/');
    console.log(`  ${rel.padEnd(46)} ${width}x${height}  ${size} KB`);
}

/** Resize to a target width and report the height the aspect ratio lands on. */
async function emit(
    source: Buffer,
    width: number,
    file: string,
    encode: (pipeline: Sharp) => Sharp,
): Promise<{ width: number; height: number }> {
    const info = await encode(sharp(source).resize({ width })).toFile(file);
    report(file, info.width, info.height);
    return { width: info.width, height: info.height };
}

async function main(): Promise<void> {
    if (!fs.existsSync(SOURCE)) {
        throw new Error(`Source art not found: ${SOURCE}`);
    }

    // Strip the source's transparent margin so every derived size is framed on the
    // ink itself - otherwise the padding eats into the width the CSS budgets for it.
    const { data: mark, info } = await sharp(SOURCE)
        .ensureAlpha()
        .trim({ threshold: 1 })
        .png()
        .toBuffer({ resolveWithObject: true });
    console.log(
        `Source ${path.basename(SOURCE)} trimmed to ${info.width}x${info.height} ` +
            `(aspect ${(info.width / info.height).toFixed(3)})\n`,
    );

    const web = await emit(mark, WEB_WIDTH, path.join(IMAGE_DIR, 'heatchecks-logo.webp'), (p) =>
        p.webp({ quality: 82 }),
    );
    await emit(mark, WEB_WIDTH, path.join(IMAGE_DIR, 'heatchecks-logo.png'), (p) =>
        p.png({ compressionLevel: 9 }),
    );

    // The Hall of Fame crest's own copy (components/HallOfFameModal.tsx). It exists
    // because the OLD script mark's letters were mostly semi-transparent, so the gold
    // ribbon behind them showed through and it needed a version with the alpha lifted
    // to solid. This art is already opaque inside the letters - only the antialiased
    // edges are partial - so the variant is currently the same art. Kept as its own
    // file so the crest can diverge again without touching the component.
    const solid = await emit(mark, WEB_WIDTH, path.join(IMAGE_DIR, 'heatchecks-logo-solid.webp'), (p) =>
        p.webp({ quality: 82 }),
    );

    // Palettised, matching the previous email asset's encoding - some clients still
    // handle an 8-bit PNG more reliably than a full-colour one, and it keeps the
    // absolute-URL fetch small.
    const email = await emit(mark, EMAIL_WIDTH, path.join(IMAGE_DIR, 'heatchecks-logo-email.png'), (p) =>
        p.png({ palette: true, colours: 255, dither: 1 }),
    );

    // resvg (the satori card images) can't decode WebP, so the watermark ships as a
    // pre-converted PNG imported as a binary module.
    const bin = await emit(mark, BIN_WIDTH, path.join(FUNCTIONS_DIR, 'heatchecks-logo.bin'), (p) =>
        p.png({ compressionLevel: 9 }),
    );

    console.log('\nIntrinsic dimensions to use in markup:');
    console.log(`  web + crest <img width height>   ${web.width} ${web.height} / ${solid.width} ${solid.height}`);
    console.log(`  email <img width>                ${email.width} (height auto)`);
    console.log(`  LOGO_ASPECT                      ${bin.width} / ${bin.height}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
