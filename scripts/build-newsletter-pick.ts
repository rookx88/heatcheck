// Bundles newsletter-pick-client.tsx into a standalone ES module for the static
// /newsletter-pick/ page. Same reasoning as build-world-map.ts: static HTML needs a
// fixed, unhashed URL, kept out of the main Vite app build.

import * as esbuild from 'esbuild';
import path from 'path';
import fs from 'fs';

const ARTIFACTS = ['newsletter-pick.js'];

export async function buildNewsletterPick(): Promise<void> {
    const outdir = path.join(process.cwd(), 'public', 'assets');
    fs.mkdirSync(outdir, { recursive: true });

    await esbuild.build({
        entryPoints: [path.join(process.cwd(), 'newsletter-pick-client.tsx')],
        bundle: true,
        format: 'esm',
        target: 'es2019',
        minify: true,
        jsx: 'automatic',
        outdir,
        entryNames: 'newsletter-pick', // -> public/assets/newsletter-pick.js
    });

    const distOutdir = path.join(process.cwd(), 'dist', 'assets');
    fs.mkdirSync(distOutdir, { recursive: true });
    for (const file of ARTIFACTS) {
        fs.copyFileSync(path.join(outdir, file), path.join(distOutdir, file));
    }

    console.log(`✓ Built ${ARTIFACTS.map(f => `public/assets/${f}`).join(', ')} (and copied to dist/assets/)`);
}

if (process.argv[1] && process.argv[1].includes('build-newsletter-pick')) {
    buildNewsletterPick().catch(error => {
        console.error('Fatal error building newsletter-pick bundle:', error);
        process.exit(1);
    });
}
