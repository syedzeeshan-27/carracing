# Road Rush (C:\carracing)

Top-down endless dodge game. Plain HTML/CSS/JS, no build step.

- `index.html`, `style.css`, `game.js`: the game (1600x900 logical stage scaled to the window).
- `assets/road.png`, `car.png`, `controls.png`: raw AI pictures (green-screen for car and controls).
- `python tools/prep_assets.py`: cuts the pictures into `assets/cut/` (sprites, traffic recolours, `info.js` with road edges). Rerun after replacing any raw picture.
- `assets/intro.mp4` (title loop), `assets/crash.mp4` (game over, ends on its own baked-in GAME OVER so our title hides), `assets/best.mp4` (game over when the run beat the saved best). All optional.
- Speed feel lives in the tuning block of `game.js`: road scrolls at ~real scale (`PX_PER_KMH`), traffic closes slower (`TRAFFIC_PX_PER_KMH`), camera pulls back to `MIN_ZOOM` at top speed.
- Run: `python tools/serve.py` then open http://localhost:8080 (or the `road-rush` launch config).

## Lessons learned (do not repeat)
- `python -I` hides user site-packages, so Pillow "isn't installed"; only use `-I` on untrusted downloads, not for our own asset scripts.
- A fixed `dt` clamp made the game run in slow motion when frames dropped (hidden pane ran at 3 fps); physics uses a fixed-step accumulator now, keep it.
- The unscaled 1600px stage widened the page layout on phones (zoomed out, off-centre hint); it must stay inside the fixed `#wrap` with `overflow: hidden`.
- `python -m http.server` let the browser serve a stale cached `index.html`; use `tools/serve.py` (sends `Cache-Control: no-store`).
- The browser pane cannot run `file://` pages (static snapshot only); test through the local server.
