# MagicShop

A free, browser-based editor that bridges Photoshop, Canva and Figma. Plain HTML, CSS and JavaScript — no build step.

Open `index.html` in a browser, or deploy the folder as a static site (for example on Vercel).

Tools: select, marquee, text, shapes, pen, rotate, Camera Raw adjustments (exposure, contrast, tone, colour, clarity, sharpen, vignette, grain).

## Desktop app (Mac and Windows)

The same editor also runs as a small desktop app, built with [Tauri](https://tauri.app) (Rust). The editor files are not changed. The app is built by GitHub: open the **Actions** tab, pick **Desktop app**, press **Run workflow**, then download the `.dmg` (Mac) or `.exe` (Windows) from the finished run.

To try it on your own computer you need Node and Rust:

```
node scripts/prepare-app.mjs
npx @tauri-apps/cli@2 icon app-icon.png
npx @tauri-apps/cli@2 dev
```
