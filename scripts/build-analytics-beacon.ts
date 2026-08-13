// Bundles analytics-beacon-client.tsx into a standalone ES module, same reason as
// build-world-map.ts/build-tank-bundles.ts: static HTML needs a fixed, unhashed URL,
// separate from the main Vite app build.

import * as esbuild from 'esbuild';
import path from 'path';
import fs from 'fs';

export async function buildAnalyticsBeacon(): Promise<void> {
    const outdir = path.join(process.cwd(), 'public', 'assets');
    fs.mkdirSync(outdir, { recursive: true });

    await esbuild.build({
        entryPoints: [path.join(process.cwd(), 'analytics-beacon-client.ts')],
        bundle: true,
        format: 'esm',
        target: 'es2019',
        minify: true,
        outfile: path.join(outdir, 'analytics-beacon.js'),
    });

    const distOutdir = path.join(process.cwd(), 'dist', 'assets');
    fs.mkdirSync(distOutdir, { recursive: true });
    fs.copyFileSync(path.join(outdir, 'analytics-beacon.js'), path.join(distOutdir, 'analytics-beacon.js'));

    console.log('✓ Built public/assets/analytics-beacon.js (and copied to dist/assets/)');
}

if (process.argv[1] && process.argv[1].includes('build-analytics-beacon')) {
    buildAnalyticsBeacon().catch(error => {
        console.error('Fatal error building analytics-beacon bundle:', error);
        process.exit(1);
    });
}
