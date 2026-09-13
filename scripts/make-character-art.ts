/**
 * Builds NPC portrait art for the encounter stage (components/EncounterStage.tsx).
 *
 * Beaks the Broker has no standalone sprite: he is painted into the TANKDAQ scene.
 * Until a true cut-out exists, the stage shows him inside a rounded portrait frame,
 * so a plain crop of the scene (no alpha) is all the art needs. The crop box comes
 * from the TANKDAQ hotspot (tankdaq-client.tsx BEAKS_PATH, viewBox = artwork px *
 * 0.803571, i.e. x ~498-806, y ~694-1568 in the 1008x1792 artwork) widened a little
 * so the cane and tail curl are inside the frame.
 *
 * Source: TANKDAQ.jpg at the repo root (the full-quality original; assets/images/
 * tankdaq-bg.webp is the same 1008x1792 canvas, lossier). Output:
 * assets/images/characters/beaks.webp, mirrored into public/ and dist/ when present
 * so a running dev server picks it up without a static rebuild
 * (make-pet-expressions.ts idiom). WebP only, deliberately: it is the one format the
 * registry references, it carries alpha whenever a real cut-out replaces it, and the
 * lossless master is already in the repo (TANKDAQ.jpg) - a committed PNG beside it
 * would be several hundred KB nothing loads. The output filename is what the registry
 * references (lib/pages-functions/encounters/characters/beaks.ts) - a future cut-out
 * with alpha is a drop-in replacement of the same file, no code change.
 *
 * Run: npx tsx scripts/make-character-art.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';

interface PortraitJob {
    // Path relative to the repo root.
    source: string;
    // Output basename under assets/images/characters/.
    out: string;
    crop: { left: number; top: number; width: number; height: number };
}

const JOBS: PortraitJob[] = [
    {
        source: 'TANKDAQ.jpg',
        out: 'beaks',
        crop: { left: 470, top: 680, width: 360, height: 920 },
    },
];

const outDir = path.join(process.cwd(), 'assets', 'images', 'characters');
const mirrors = [
    path.join(process.cwd(), 'public', 'assets', 'images', 'characters'),
    path.join(process.cwd(), 'dist', 'assets', 'images', 'characters'),
];

async function buildPortrait(job: PortraitJob): Promise<void> {
    const src = path.join(process.cwd(), job.source);
    if (!fs.existsSync(src)) throw new Error(`Missing source image: ${src}`);
    const meta = await sharp(src).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    const crop = {
        left: Math.max(0, job.crop.left),
        top: Math.max(0, job.crop.top),
        width: Math.min(job.crop.width, w - Math.max(0, job.crop.left)),
        height: Math.min(job.crop.height, h - Math.max(0, job.crop.top)),
    };

    fs.mkdirSync(outDir, { recursive: true });
    const buf = await sharp(src).extract(crop).webp({ quality: 85 }).toBuffer();

    const file = `${job.out}.webp`;
    fs.writeFileSync(path.join(outDir, file), buf);
    for (const dir of mirrors) {
        if (fs.existsSync(path.dirname(dir))) {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, file), buf);
        }
    }
    console.log(`✓ characters/${file}  ${crop.width}x${crop.height}  ${(buf.length / 1024).toFixed(0)}KB`);
}

async function main(): Promise<void> {
    for (const job of JOBS) await buildPortrait(job);
}

main().catch((err) => {
    console.error('Failed to build character art:', err);
    process.exit(1);
});
