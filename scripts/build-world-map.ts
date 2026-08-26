// Bundles world-map-client.tsx (which pulls in components/WorldMap.tsx,
// components/WorldMap.css, and the pre-optimized world-map-interactive.webp
// artwork - see scripts/optimize-landing-images.ts) into a standalone ES
// module + CSS file + copied image, for embedding in the static
// claim-your-spot page. Kept separate from the main Vite app build, same
// reason as build-tank-bundles.ts: static HTML needs a fixed, unhashed URL.

import * as esbuild from 'esbuild';
import path from 'path';
import fs from 'fs';

const ARTIFACTS = ['world-map.js', 'world-map.css', 'world-map-interactive.webp'];

export async function buildWorldMap(): Promise<void> {
    const outdir = path.join(process.cwd(), 'public', 'assets');
    fs.mkdirSync(outdir, { recursive: true });

    await esbuild.build({
        entryPoints: [path.join(process.cwd(), 'world-map-client.tsx')],
        bundle: true,
        format: 'esm',
        target: 'es2019',
        minify: true,
        jsx: 'automatic',
        outdir,
        entryNames: 'world-map', // -> public/assets/world-map.js (+ sibling world-map.css)
        assetNames: '[name]', // -> public/assets/world-map-interactive.webp (no hash)
        publicPath: '/assets', // baked into the JS as the image's href
        loader: { '.svg': 'file', '.webp': 'file' }, // copy as static files, don't inline as data: URLs
    });

    // Also copy into dist/, mirroring build-tank-bundles.ts, so it survives the static build.
    const distOutdir = path.join(process.cwd(), 'dist', 'assets');
    fs.mkdirSync(distOutdir, { recursive: true });
    for (const file of ARTIFACTS) {
        fs.copyFileSync(path.join(outdir, file), path.join(distOutdir, file));
    }

    console.log(`✓ Built ${ARTIFACTS.map(f => `public/assets/${f}`).join(', ')} (and copied to dist/assets/)`);
}

if (process.argv[1] && process.argv[1].includes('build-world-map')) {
    buildWorldMap().catch(error => {
        console.error('Fatal error building world-map bundle:', error);
        process.exit(1);
    });
}
