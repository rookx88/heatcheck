# HEATCHECKS Trading Cards

Two editions of the HEATCHECKS holographic tri-fold trading card. Each folder is a
complete, standalone Vite + React app — copy an edition folder anywhere and it runs.

- **gold-edition/** — gold-plated cover art (`gold_plated_card.jpg`)
- **neon-edition/** — neon stadium cover art (`neon_og_card.jpg`) with a
  fuchsia cover border and cool-toned gloss to match

Everything else is identical: the glossy animated cover, the HEATCHECKS gold back
panel with the GENESIS COLLECTION inscription, the tri-fold unfold animation, the
synced video backdrop, and the rotating holo-sphere carrying the match texts.

## Run standalone

```
cd gold-edition   # or neon-edition
npm install
npm run dev
```

Then open the printed localhost URL (the script asks for port 3000; Vite picks the
next free port if it's taken). Click SOCCER, then click the card to unfold.

## Drop into an existing project

1. Copy `src/App.tsx` into your project and render `<App />`.
2. Copy the `public/images/` and `public/videos/` files into your project's
   `public/` folder (the code references `/images/...` and `/videos/...`).
3. Make sure `src/index.css` (or your global CSS) contains the `glossSweep`
   keyframes — the cover shine animation depends on it:

   ```css
   @keyframes glossSweep {
     0% { left: -60%; opacity: 0; }
     10% { opacity: 1; }
     45% { left: 115%; opacity: 1; }
     46%, 100% { left: 115%; opacity: 0; }
   }
   ```

4. Required dependencies: `react` ^19, `react-dom` ^19, `motion` (Motion for
   React), and Tailwind CSS v4 via `@tailwindcss/vite` (the component uses
   Tailwind utility classes throughout, including arbitrary values).

## Asset notes

- `public/videos/soccerbackdrop.mp4` — silent H.264, 846x482, 30fps, ~5s loop,
  `yuv420p`, faststart. It renders with `mix-blend-screen` + a brightness boost,
  so black pixels in the footage become transparent over the card's dark void.
  Any replacement clip should follow the same recipe:
  `ffmpeg -i in.mov -an -vf "scale=1440:680,fps=30" -c:v libx264 -crf 27 -pix_fmt yuv420p -movflags +faststart out.mp4`
- Cover art is portrait, displayed 240x340 with `object-cover` — roughly 3:4
  images crop best.
