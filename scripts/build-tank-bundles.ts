// Single esbuild build for both Tank client bundles - tank-article-deck-client.tsx
// (single-tank widget on an article page) and tank-page-client.tsx (the-tank's
// carousel) - built TOGETHER with code splitting so the ~330KB of shared
// React/react-dom/motion/lucide-react/Fishtank code they both depend on ships once
// as a common chunk instead of being duplicated in full inside each bundle. A visitor
// who loads both an article and /the-tank/ in one session downloads that shared
// weight only once (and the browser can cache it across page loads).
//
// Replaces the former separate build-tank-article-deck.ts / build-tank-page.ts
// scripts, which each ran their own independent esbuild.build() call - splitting only
// extracts a shared chunk across entry points built in the SAME call, so they had to
// be merged into one script to fix the duplication.

import * as esbuild from 'esbuild';
import path from 'path';
import fs from 'fs';

// Both chunkNames and assetNames below are content-hashed ('tank-shared-[hash]',
// 'tank-asset-[hash]') so a changed dependency graph or a re-optimized SVG/webp gets a
// brand new filename - but esbuild only ever WRITES the current build's output, it never
// deletes a previous run's now-unreferenced hash file. Since public/assets/ is a
// persistent, git-committed directory (not a wiped-per-build dist/ dir), that garbage
// silently accumulates release over release. Observed live 2026-08: 14 of 20
// tank-shared-*.js files in public/assets/ were orphaned, referenced by nothing.
const ORPHAN_PATTERNS = [/^tank-shared-.*\.(js|css)$/, /^tank-asset-.*\.[a-z0-9]+$/];

// Deletes any file in `dir` matching one of ORPHAN_PATTERNS whose name isn't in
// `keepBasenames` - i.e. wasn't just emitted by this build. Never touches fixed-name
// entry outputs (tank-page.js, homepage.js, etc.) or anything outside the two hashed
// prefixes this script itself owns.
function pruneOrphanedHashedFiles(dir: string, keepBasenames: Set<string>): void {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
        if (keepBasenames.has(name)) continue;
        if (!ORPHAN_PATTERNS.some((re) => re.test(name))) continue;
        fs.unlinkSync(path.join(dir, name));
        console.log(`  pruned orphaned build artifact: ${path.join(path.basename(dir), name)}`);
    }
}

export async function buildTankBundles(): Promise<void> {
    const outdir = path.join(process.cwd(), 'public', 'assets');
    fs.mkdirSync(outdir, { recursive: true });

    const result = await esbuild.build({
        entryPoints: [
            { in: path.join(process.cwd(), 'tank-article-deck-client.tsx'), out: 'tank-article-deck' },
            { in: path.join(process.cwd(), 'tank-page-client.tsx'), out: 'tank-page' },
            // Homepage island (showcase Fishtank + interactive world map + row
            // behavior) - built in the same call so it shares the React/motion/
            // Fishtank chunk with the two Tank bundles above.
            { in: path.join(process.cwd(), 'homepage-client.tsx'), out: 'homepage' },
            // Tank Land hub (/the-tank/) and The Hatchery (/the-hatchery/) - same
            // deal: they share React (and, for the hatchery, Egg3D/motion) with the
            // rest of the tank-world bundles.
            { in: path.join(process.cwd(), 'tank-land-client.tsx'), out: 'tank-land' },
            { in: path.join(process.cwd(), 'hatchery-page-client.tsx'), out: 'hatchery-page' },
            // The two Tank Land food shops.
            { in: path.join(process.cwd(), 'champions-terrace-client.tsx'), out: 'champions-terrace' },
            { in: path.join(process.cwd(), 'quickboost-client.tsx'), out: 'quickboost-delicacies' },
        ],
        bundle: true,
        splitting: true, // requires format: 'esm'; this is what extracts the shared chunk
        format: 'esm',
        target: 'es2019',
        minify: true,
        jsx: 'automatic',
        outdir,
        entryNames: '[name]', // -> tank-article-deck.js / tank-page.js (+ sibling tank-page.css)
        chunkNames: 'tank-shared-[hash]', // the extracted common code, fixed prefix + content hash
        // The source filenames ("Tanks- Background.svg", "HeatChecksWorldMap.svg")
        // include a stray space / mixed casing; use a clean fixed prefix + content
        // hash instead of deriving names from them. A hash (not a single fixed name)
        // because the homepage entry brings a SECOND svg into this build - two assets
        // can't share one fixed output path.
        assetNames: 'tank-asset-[hash]',
        publicPath: '/assets', // baked into the JS as the SVG/webp's href
        // Copy as static files, don't inline as data: URLs - .webp joined .svg here once
        // the game-screen backgrounds (Tank Land, Hatchery, food shops, Tank pages, the
        // interactive world map) moved off raw multi-MB SVG-wrapped exports onto
        // pre-optimized WebP (scripts/optimize-landing-images.ts).
        loader: { '.svg': 'file', '.webp': 'file' },
        metafile: true, // needed below to discover the shared chunk's hashed filename
    });

    // Copy every emitted file (both entries, the shared chunk, the CSS, the SVG) into
    // dist/, mirroring build-world-map.ts. Driven by the metafile rather than a
    // hardcoded list since the shared chunk's name includes a content hash.
    const distOutdir = path.join(process.cwd(), 'dist', 'assets');
    fs.mkdirSync(distOutdir, { recursive: true });
    const emittedCount = Object.keys(result.metafile!.outputs).length;
    const emittedBasenames = new Set<string>();
    for (const outputPath of Object.keys(result.metafile!.outputs)) {
        const absSrc = path.resolve(process.cwd(), outputPath);
        const rel = path.relative(outdir, absSrc);
        if (rel.startsWith('..')) continue; // not one of ours (shouldn't happen)
        emittedBasenames.add(rel);
        const dest = path.join(distOutdir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(absSrc, dest);
    }

    // Prune stale hash-named chunks/assets left behind by PREVIOUS runs - this build's
    // own fresh output is always kept (emittedBasenames), only now-unreferenced leftovers
    // get removed. See ORPHAN_PATTERNS' comment for why this is needed at all.
    pruneOrphanedHashedFiles(outdir, emittedBasenames);
    pruneOrphanedHashedFiles(distOutdir, emittedBasenames);

    console.log(`✓ Built Tank bundles (${emittedCount} file(s), shared chunk extracted) and copied to dist/assets/`);
}

if (process.argv[1] && process.argv[1].includes('build-tank-bundles')) {
    buildTankBundles().catch(error => {
        console.error('Fatal error building Tank bundles:', error);
        process.exit(1);
    });
}
