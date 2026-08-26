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
    for (const outputPath of Object.keys(result.metafile!.outputs)) {
        const absSrc = path.resolve(process.cwd(), outputPath);
        const rel = path.relative(outdir, absSrc);
        if (rel.startsWith('..')) continue; // not one of ours (shouldn't happen)
        const dest = path.join(distOutdir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(absSrc, dest);
    }

    console.log(`✓ Built Tank bundles (${emittedCount} file(s), shared chunk extracted) and copied to dist/assets/`);
}

if (process.argv[1] && process.argv[1].includes('build-tank-bundles')) {
    buildTankBundles().catch(error => {
        console.error('Fatal error building Tank bundles:', error);
        process.exit(1);
    });
}
