// What the clarity pass costs per frame (CLARITY / ARCHITECTURE §13): the UI's own JavaScript with the tracker, compass,
// minimap, edge arrows and the cursor tooltip running in a real village, and what finding the thing under the mouse costs.
// Headless Chromium with software GL, so the numbers are the UI's CPU time only (the 3D drawing is not in them).
//
//   node tools/ui-clarity-bench.mjs [--seed=eta]
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5183;
const args = process.argv.slice(2);
const opt = (name, def) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : def; };
const seed = opt('seed', 'eta');

async function serverUp() { try { return (await fetch(`http://localhost:${PORT}/`)).ok; } catch { return false; } }
let vite = null;
if (!(await serverUp())) {
  vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BROWSER: 'none' }, detached: true });
  await new Promise((res) => { vite.stdout.on('data', (d) => { if (/Local:|ready in/i.test(d.toString())) res(); }); setTimeout(res, 25000); });
}
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(0);
try {
  await page.goto(`http://localhost:${PORT}/?seed=${seed}&quality=low&shots=1&autostart=1&fakeobjectives=1&time=0.4`, { timeout: 120000 });
  await page.waitForFunction(() => window.__game !== undefined, null, { timeout: 300000, polling: 250 });
  await page.evaluate(() => window.__game.ready());
  await page.evaluate(() => window.__game.freeze(true));
  await page.evaluate(() => window.__game.host.setSettings({ hints: false }));
  await page.evaluate(() => window.__game.advance(1));
  await page.evaluate(() => window.__game.settle());
  await page.evaluate(() => window.__game.draw());

  const r = await page.evaluate(async () => {
    const g = window.__game; const s = g.session; const ui = window.__ui; const p = s.services.player;
    const stat = (xs) => { const a = [...xs].sort((u, v) => u - v); return { mean: +(xs.reduce((n, x) => n + x, 0) / xs.length).toFixed(3), p95: +a[Math.floor(a.length * 0.95)].toFixed(3), max: +a[a.length - 1].toFixed(3) }; };
    const out = {};
    // the whole UI update, as the main loop calls it (60 fps worth of frames: the minimap redraws about every 7th)
    const frame = [];
    for (let i = 0; i < 600; i++) { const t0 = performance.now(); ui.update(1 / 60); frame.push(performance.now() - t0); }
    out.uiUpdateMs = stat(frame);
    // the renderer's pick at a point in the village
    const pk = [];
    for (let i = 0; i < 300; i++) { const t0 = performance.now(); s.renderer.pick(640 + (i % 20) * 7, 360 + (i % 11) * 9); pk.push(performance.now() - t0); }
    out.rendererPickMs = stat(pk);
    // the whole hover resolution (pick + trees + zone + actions), once per 100 ms as in play
    const hv = [];
    for (let i = 0; i < 25; i++) {
      await new Promise((res) => setTimeout(res, 110));
      const t0 = performance.now(); p.pointerMove(560 + i * 6, 400 - (i % 5) * 20); hv.push(performance.now() - t0);
    }
    out.pointerMoveMs = stat(hv);
    return out;
  });
  console.log(JSON.stringify(r, null, 1));
} finally {
  await browser.close();
  if (vite) { try { process.kill(-vite.pid, 'SIGTERM'); } catch { vite.kill('SIGTERM'); } }
}
