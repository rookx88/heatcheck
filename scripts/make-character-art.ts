/**
 * Builds the NPC portrait sprites the encounter stage draws
 * (components/EncounterStage.tsx).
 *
 * The masters are 1000x1000 PNGs with alpha - full-body characters on a transparent
 * background, the same treatment as the pet sprite, NOT scene crops. They live in
 * assets/images/characters/masters/ (tracked, never shipped: NEW_SITE_IMAGES is an
 * opt-in allowlist, so only the derived webp below is copied into a build - the same
 * arrangement as assets/images/pets/expression-*-src.png).
 *
 * Output: assets/images/characters/<key>_<expression>.webp at 600px, mirrored into
 * public/ and dist/ when those exist so a running dev server picks them up without a
 * static rebuild (make-pet-expressions.ts idiom). 600px is ~1.5x the largest box the
 * stage ever renders (400px on desktop), matching how the pet ships a 1158px sprite
 * for a 400px box; the whole set costs ~300KB. alphaQuality 100 keeps the cut-out
 * edges clean - a soft edge here would show as a halo against the dimmed scene.
 *
 * Each file name here must ALSO appear in NEW_SITE_IMAGES (scripts/generate-static-
 * site.ts) and in a character's `portraits` map (lib/pages-functions/encounters/
 * characters/*.ts). All three hard-fail if they disagree, which is deliberate: the
 * build refuses to ship a portrait it cannot serve.
 *
 * Run: npx tsx scripts/make-character-art.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';

type Expression = 'main' | 'happy' | 'sad' | 'ecstatic';

interface CharacterArt {
    key: string;
    // `main` is required; the rest are optional and genuinely ragged (Blobby has no
    // sad, Charles no happy, Vic only main). portraitSrc() falls back to main.
    masters: { main: string } & Partial<Record<Exclude<Expression, 'main'>, string>>;
}

const CHARACTER_ART: CharacterArt[] = [
    { key: 'beaks', masters: { main: 'beaks_main.png', happy: 'beaks_happy.png', sad: 'beaks_sad.png' } },
    { key: 'blobby', masters: { main: 'blobby_main.png', happy: 'blobby_happy.png', ecstatic: 'blobby_ecstatic.png' } },
    { key: 'puffington', masters: { main: 'puffington_main.png', happy: 'puffington_happy.png', sad: 'puffington_sad.png' } },
    { key: 'charles', masters: { main: 'charles_main.png', sad: 'charles_sad.png' } },
    { key: 'vic', masters: { main: 'vic_main.png' } },
];

const EDGE = 600;

const mastersDir = path.join(process.cwd(), 'assets', 'images', 'characters', 'masters');
const outDir = path.join(process.cwd(), 'assets', 'images', 'characters');
const mirrors = [
    path.join(process.cwd(), 'public', 'assets', 'images', 'characters'),
    path.join(process.cwd(), 'dist', 'assets', 'images', 'characters'),
];

async function buildOne(key: string, expression: string, master: string): Promise<number> {
    const src = path.join(mastersDir, master);
    if (!fs.existsSync(src)) throw new Error(`Missing master: ${src}`);

    const buf = await sharp(src)
        .resize(EDGE, EDGE, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82, alphaQuality: 100, effort: 6 })
        .toBuffer();

    const file = `${key}_${expression}.webp`;
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, file), buf);
    for (const dir of mirrors) {
        // Guard the PARENT: the characters/ leaf may not exist yet in a fresh tree.
        if (fs.existsSync(path.dirname(dir))) {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, file), buf);
        }
    }

    const meta = await sharp(buf).metadata();
    console.log(`✓ characters/${file}  ${meta.width}x${meta.height}  ${meta.hasAlpha ? 'alpha' : 'OPAQUE!'}  ${(buf.length / 1024).toFixed(0)}KB`);
    return buf.length;
}

async function main(): Promise<void> {
    let total = 0;
    let count = 0;
    for (const art of CHARACTER_ART) {
        for (const [expression, master] of Object.entries(art.masters)) {
            total += await buildOne(art.key, expression, master as string);
            count++;
        }
    }
    console.log(`\n${count} portraits, ${(total / 1024).toFixed(0)}KB total`);
}

main().catch((err) => {
    console.error('Failed to build character art:', err);
    process.exit(1);
});
