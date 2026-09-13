/**
 * Imports the item art drop in new_items/ into the two directories the app serves
 * from: assets/images/food/ and assets/images/memorabilia/.
 *
 * Why this exists rather than a plain copy:
 *
 *  1. TRANSPARENCY. The eight food PNGs that shipped before this script were
 *     1024x1024 OPAQUE RGB - no alpha channel at all. Every surface that renders
 *     them (.food-shop-thumb at 72px, .pet-inv-thumb at 48px) puts them on a
 *     translucent row under a drop-shadow() filter, and drop-shadow on an opaque
 *     image traces the image BOX, so each item wore a hard rectangular shadow.
 *     The replacements carry real alpha; assertAlpha() below refuses to import a
 *     source that doesn't, because a single opaque file silently brings the
 *     rectangle back and nothing downstream would flag it.
 *
 *  2. SIZE. The sources are 1024x1024 at ~900KB each - 24MB for 27 files, to be
 *     displayed at 48-72px. They go out at 256px, which is still >3x the largest
 *     display size (the 72px shop thumb, retina).
 *
 *  3. NAMING. The source filenames are NOT the catalog keys and cannot be derived
 *     from them - balanced_breakfast.png is food_breakfast, ribeye_steak.png is
 *     food_ribeye. Components build their URLs as
 *     `/assets/images/food/${item.catalogKey}.png`, and a miss there is a 404
 *     MASKED by the onError->visibility:hidden guard in PetInventoryModal: an
 *     invisible thumbnail and no error anywhere. Hence the explicit table below -
 *     never a prefix rule.
 *
 * Like optimize-landing-images.ts and make-pet-expressions.ts this is a manual
 * one-off, NOT part of build:static. Cloudflare builds from source and
 * copyNewSiteImages() only COPIES assets/images - so the outputs must be
 * committed, and every filename must also be listed in NEW_SITE_IMAGES
 * (scripts/generate-static-site.ts), which is the only gate protecting them:
 * verifyReferencedImages() can't see these paths because its regex stops at the
 * `${` in the template literal that builds them.
 *
 * Run: npx tsx scripts/import-item-art.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';

// Longest edge of the emitted art. The largest on-screen use is the 72px shop
// thumb; 256 keeps it crisp at 2x/3x with room for a bigger viewer later.
const OUT_SIZE = 256;

const sourceDir = path.join(process.cwd(), 'new_items');

interface Job {
    /** Filename in new_items/. */
    source: string;
    /** Subpath under assets/images/ - also the catalog's `image`/key contract. */
    out: string;
}

/**
 * Food art is addressed BY CATALOG KEY (the components interpolate
 * item.catalogKey straight into the URL), so `out` here must match
 * items_catalog.key exactly. Memorabilia is addressed by config.image, so those
 * are free-form - they just have to match what the migration writes.
 */
const JOBS: Job[] = [
    // --- Re-renders of the eight shop foods. Same keys as migrate_food_shops.sql;
    // these OVERWRITE the opaque originals (reason 1 in the header).
    { source: 'yogurt_parfait.png', out: 'food/food_yogurt_parfait.png' },
    { source: 'banana_shake.png', out: 'food/food_banana_shake.png' },
    { source: 'fresh_salad.png', out: 'food/food_fresh_salad.png' },
    { source: 'protein_shake.png', out: 'food/food_protein_shake.png' },
    { source: 'stadium_dog.png', out: 'food/food_stadium_dog.png' },
    { source: 'balanced_breakfast.png', out: 'food/food_breakfast.png' },
    { source: 'worm_delicacy.png', out: 'food/food_worm_delicacy.png' },
    { source: 'ribeye_steak.png', out: 'food/food_ribeye.png' },

    // --- The seven discovery-only foods. Never stocked by a shop (no
    // config.vendor); the pet's find pool is exactly this set.
    { source: 'caramel_popcorn.png', out: 'food/food_caramel_popcorn.png' },
    { source: 'chicken_wings.png', out: 'food/food_chicken_wings.png' },
    { source: 'cotton_candy.png', out: 'food/food_cotton_candy.png' },
    { source: 'craft_beer.png', out: 'food/food_craft_beer.png' },
    { source: 'loaded_nachos.png', out: 'food/food_loaded_nachos.png' },
    { source: 'mint_julep.png', out: 'food/food_mint_julep.png' },
    { source: 'sampler_platter.png', out: 'food/food_sampler_platter.png' },

    // --- Sports memorabilia: the new item_type, discovery-only, never sold.
    // game_worn_soccer_cleats_2 is a DIFFERENT pair, not a numbered duplicate -
    // it ships as away_kit_soccer_cleats so the two read as distinct objects.
    { source: 'worn_soccer_ball.png', out: 'memorabilia/worn_soccer_ball.png' },
    { source: 'worn_football.png', out: 'memorabilia/worn_football.png' },
    { source: 'worn_basketball.png', out: 'memorabilia/worn_basketball.png' },
    { source: 'homerun_baseball.png', out: 'memorabilia/homerun_baseball.png' },
    { source: 'broken_hockey_stick.png', out: 'memorabilia/broken_hockey_stick.png' },
    { source: 'broken_trophy.png', out: 'memorabilia/broken_trophy.png' },
    { source: 'game_worn_football_cleats.png', out: 'memorabilia/game_worn_football_cleats.png' },
    { source: 'game_worn_soccer_cleats.png', out: 'memorabilia/game_worn_soccer_cleats.png' },
    { source: 'game_worn_soccer_cleats_2.png', out: 'memorabilia/away_kit_soccer_cleats.png' },
    { source: 'red_card.png', out: 'memorabilia/red_card.png' },
    { source: 'yellow_card.png', out: 'memorabilia/yellow_card.png' },
    { source: 'used_whistle.png', out: 'memorabilia/used_whistle.png' },
];

const transparent = { r: 0, g: 0, b: 0, alpha: 0 };

/**
 * Where the output lands: the tracked source dir, plus public/ and dist/ when
 * they exist so a running dev server picks the art up without a static rebuild
 * (make-pet-expressions.ts idiom). public/assets/images IS committed, so this is
 * also what keeps it in step with assets/images.
 */
function destinationsFor(out: string): string[] {
    const roots = [
        path.join(process.cwd(), 'assets', 'images'),
        path.join(process.cwd(), 'public', 'assets', 'images'),
        path.join(process.cwd(), 'dist', 'assets', 'images'),
    ];
    // assets/ is authoritative and always written; the mirrors only when present.
    return roots
        .filter((root, i) => i === 0 || fs.existsSync(root))
        .map((root) => path.join(root, out));
}

/**
 * Refuses an opaque source. This is the whole point of the import (header reason
 * 1) and it cannot be checked later: an opaque PNG renders perfectly well, it
 * just wears a rectangular drop-shadow that looks like a styling bug.
 */
async function assertAlpha(file: string, buffer: Buffer): Promise<void> {
    const meta = await sharp(buffer).metadata();
    if (!meta.hasAlpha) {
        throw new Error(
            `${file} has no alpha channel (${meta.width}x${meta.height}, ${meta.channels}ch). ` +
                `Item art must be a cut-out with a transparent background - an opaque file ` +
                `renders a hard rectangular drop-shadow in the shop and inventory thumbs. ` +
                `Re-export it with transparency and run this again.`,
        );
    }
}

async function main(): Promise<void> {
    if (!fs.existsSync(sourceDir)) {
        throw new Error(`Source drop not found: ${sourceDir}`);
    }

    // Fail before writing anything if the drop is incomplete - a half-applied
    // import leaves the catalog pointing at files that don't exist yet.
    const missing = JOBS.filter((j) => !fs.existsSync(path.join(sourceDir, j.source)));
    if (missing.length) {
        throw new Error(`Missing from new_items/: ${missing.map((m) => m.source).join(', ')}`);
    }

    for (const job of JOBS) {
        const sourceFile = path.join(sourceDir, job.source);
        const input = fs.readFileSync(sourceFile);
        await assertAlpha(job.source, input);

        // `contain` on a transparent background: never crop the item, never
        // letterbox it onto a colour. Square output keeps every thumb's
        // object-fit:contain box predictable.
        const output = await sharp(input)
            .resize(OUT_SIZE, OUT_SIZE, { fit: 'contain', background: transparent })
            .png({ compressionLevel: 9 })
            .toBuffer();

        for (const dest of destinationsFor(job.out)) {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, output);
        }
        console.log(
            `✓ ${job.source.padEnd(32)} -> ${job.out.padEnd(44)} ${(output.length / 1024).toFixed(0)}KB`,
        );
    }

    console.log(`\n${JOBS.length} files imported at ${OUT_SIZE}px.`);
    console.log('Reminder: every new filename must also be added to NEW_SITE_IMAGES');
    console.log('in scripts/generate-static-site.ts, or it 404s in production.');
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
