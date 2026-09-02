/**
 * Derives the small world/Mud Puppy art the auth form (components/AuthForm.tsx)
 * shows above the magic-link + Discord buttons, on both the homepage register
 * modal and the /login/ page.
 *
 * Why a derived asset instead of reusing the originals: the form renders the
 * globe at ~118px and the puppy at ~134px tall, but the full-size art is
 * 1120x1116 (230KB) and 800x1233 (312KB) - over half a megabyte of decoration
 * for a box the size of a business card, on the one screen a brand-new visitor
 * sees first. These are the same images resized to ~2x their rendered size,
 * which is visually identical in the form and roughly an order of magnitude
 * smaller.
 *
 * Follows scripts/optimize-landing-images.ts's pattern: write into
 * assets/images/, which generate-static-site.ts's copyImages() picks up
 * automatically (and this script mirrors into public/ + dist/ so a dev server
 * already running sees them without a full static rebuild).
 *
 * Run: npx tsx scripts/make-auth-art.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';

interface Job {
    source: string;   // in assets/images/
    outName: string;  // written as <outName>.webp
    width: number;    // ~2x the CSS size the auth form renders it at
}

const jobs: Job[] = [
    // Rendered 118x118 (desktop) / 92x92 (phone).
    { source: 'world-map.webp', outName: 'world-map-auth', width: 240 },
    // Rendered 134px tall (~87px wide at its 800:1233 ratio).
    { source: 'mudpuppy-default.webp', outName: 'mudpuppy-auth', width: 180 },
];

const assetsImages = path.join(process.cwd(), 'assets', 'images');
// Mirrored so a running `wrangler pages dev dist` serves them immediately.
const mirrors = [
    path.join(process.cwd(), 'public', 'assets', 'images'),
    path.join(process.cwd(), 'dist', 'assets', 'images'),
];

async function main(): Promise<void> {
    for (const job of jobs) {
        const src = path.join(assetsImages, job.source);
        if (!fs.existsSync(src)) throw new Error(`Missing source image: ${src}`);

        const outFile = `${job.outName}.webp`;
        const buffer = await sharp(src)
            // fit:'inside' + withoutEnlargement: never upscale, and keep the
            // original aspect ratio rather than trusting a hardcoded height.
            .resize({ width: job.width, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 88 })
            .toBuffer();

        const before = fs.statSync(src).size;
        fs.writeFileSync(path.join(assetsImages, outFile), buffer);
        for (const dir of mirrors) {
            if (fs.existsSync(dir)) fs.writeFileSync(path.join(dir, outFile), buffer);
        }
        const kb = (n: number) => `${(n / 1024).toFixed(0)}KB`;
        console.log(`✓ ${outFile}  ${kb(before)} → ${kb(buffer.length)}`);
    }
}

main().catch((err) => {
    console.error('Failed to build auth art:', err);
    process.exit(1);
});
