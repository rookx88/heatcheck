// Cloudflare's Pages Functions bundler compiles a relative `.wasm` import into a
// pre-compiled WebAssembly.Module at build time (its CompiledWasm module rule).
// TypeScript has no built-in ambient type for that, hence this declaration. Note the
// import MUST be a relative path from our own source tree - importing the same file
// via its package path (@resvg/resvg-wasm/index_bg.wasm) silently resolved to
// undefined at runtime, and fetching+instantiating raw bytes instead is blocked
// outright by the Workers runtime ("Wasm code generation disallowed by embedder").
// Only consumer: lib/pages-functions/leaderboard-image.ts -> ./resvg.wasm.
declare module '*.wasm' {
    const module: WebAssembly.Module;
    export default module;
}

// Same bundler, different rule: `.bin` imports become Data modules - raw ArrayBuffers
// baked into the worker bundle. Used for the leaderboard renderer's font files
// (lib/pages-functions/fonts/*.bin, straight copies of scripts/assets/fonts/*.ttf) -
// bundled rather than fetched because the deployed dist turned out not to carry
// public/assets/fonts/ (the CI build assembles dist selectively), and a worker that
// depends on its own site's static file layout is fragile anyway.
declare module '*.bin' {
    const data: ArrayBuffer;
    export default data;
}
