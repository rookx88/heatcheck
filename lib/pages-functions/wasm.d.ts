// Cloudflare Pages Functions compile a `.wasm` import into a WebAssembly.Module
// directly at build time - TypeScript has no built-in ambient type for that, hence
// this declaration. First (and only, as of this file) .wasm import in this codebase:
// lib/pages-functions/leaderboard-image.ts's @resvg/resvg-wasm usage.
declare module '*.wasm' {
    const module: WebAssembly.Module;
    export default module;
}
