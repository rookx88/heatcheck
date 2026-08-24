// Bundles account-client.tsx into a standalone ES module for the static /account/
// page. Same reasoning as build-welcome.ts: static HTML needs a fixed, unhashed URL,
// kept out of the main Vite app build.

import * as esbuild from 'esbuild';
import path from 'path';
import fs from 'fs';

const ARTIFACTS = ['account.js'];

export async function buildAccount(): Promise<void> {
    const outdir = path.join(process.cwd(), 'public', 'assets');
    fs.mkdirSync(outdir, { recursive: true });

    await esbuild.build({
        entryPoints: [path.join(process.cwd(), 'account-client.tsx')],
        bundle: true,
        format: 'esm',
        target: 'es2019',
        minify: true,
        jsx: 'automatic',
        outdir,
        entryNames: 'account', // -> public/assets/account.js
    });

    const distOutdir = path.join(process.cwd(), 'dist', 'assets');
    fs.mkdirSync(distOutdir, { recursive: true });
    for (const file of ARTIFACTS) {
        fs.copyFileSync(path.join(outdir, file), path.join(distOutdir, file));
    }

    console.log(`✓ Built ${ARTIFACTS.map(f => `public/assets/${f}`).join(', ')} (and copied to dist/assets/)`);
}

if (process.argv[1] && process.argv[1].includes('build-account')) {
    buildAccount().catch(error => {
        console.error('Fatal error building account bundle:', error);
        process.exit(1);
    });
}
