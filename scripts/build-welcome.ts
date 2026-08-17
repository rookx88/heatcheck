// Bundles welcome-client.tsx into a standalone ES module for the static /welcome/
// page (the first-login letter from Sports McLaren). Same reasoning as
// build-login.ts: static HTML needs a fixed, unhashed URL, kept out of the main Vite
// app build.

import * as esbuild from 'esbuild';
import path from 'path';
import fs from 'fs';

const ARTIFACTS = ['welcome.js'];

export async function buildWelcome(): Promise<void> {
    const outdir = path.join(process.cwd(), 'public', 'assets');
    fs.mkdirSync(outdir, { recursive: true });

    await esbuild.build({
        entryPoints: [path.join(process.cwd(), 'welcome-client.tsx')],
        bundle: true,
        format: 'esm',
        target: 'es2019',
        minify: true,
        jsx: 'automatic',
        outdir,
        entryNames: 'welcome', // -> public/assets/welcome.js
    });

    const distOutdir = path.join(process.cwd(), 'dist', 'assets');
    fs.mkdirSync(distOutdir, { recursive: true });
    for (const file of ARTIFACTS) {
        fs.copyFileSync(path.join(outdir, file), path.join(distOutdir, file));
    }

    console.log(`✓ Built ${ARTIFACTS.map(f => `public/assets/${f}`).join(', ')} (and copied to dist/assets/)`);
}

if (process.argv[1] && process.argv[1].includes('build-welcome')) {
    buildWelcome().catch(error => {
        console.error('Fatal error building welcome bundle:', error);
        process.exit(1);
    });
}
