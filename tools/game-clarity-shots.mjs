// Screenshots of the clarity pass (CLARITY §2, §3, §5, §6): the objective tracker, the compass ribbon, the minimap,
// "What now?", the settlement banner, the tooltip that follows the free cursor, the journal, the day summary and the
// intro. Starts Vite on :5181, plays a real run in headless Chromium (software GL: slow but correct) with the UI's
// stand-in objectives (`?fakeobjectives=1`, used until the objectives module is in the build) and saves docs/game/*.png.
//
//   node tools/game-clarity-shots.mjs                      # everything, at 1280x720
//   node tools/game-clarity-shots.mjs hud hover            # selected shots
//   node tools/game-clarity-shots.mjs --size=1920x1080 --seed=abc --real   # --real: the real objectives module
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'docs/game');
const PORT = 5181;
const args = process.argv.slice(2);
const opt = (name, def) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : def; };
const seed = opt('seed', 'millennia');
const quality = opt('quality', 'medium');
const [W, H] = opt('size', '1280x720').split('x').map(Number);
const suffix = opt('suffix', W === 1280 ? '' : `-${W}`);
const real = args.includes('--real');
const wanted = args.filter((a) => !a.startsWith('--'));
const want = (...names) => wanted.length === 0 || names.some((n) => wanted.includes(n));

async function serverUp() { try { return (await fetch(`http://localhost:${PORT}/`)).ok; } catch { return false; } }
async function serverIsOurs() {
  try { const r = await fetch(`http://localhost:${PORT}/src/app/game.ts`); return r.ok && (await r.text()).includes('__game'); } catch { return false; }
}
function startVite() {
  return new Promise((res, rej) => {
    const proc = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BROWSER: 'none' }, detached: true });
    let done = false;
    proc.stdout.on('data', (d) => { if (!done && /Local:|ready in/i.test(d.toString())) { done = true; res(proc); } });
    proc.on('exit', (c) => { if (!done) rej(new Error(`vite exited (${c})`)); });
    setTimeout(() => { if (!done) { done = true; res(proc); } }, 25000);
  });
}

let vite = null;
if (!(await serverUp())) vite = await startVite();
else if (!(await serverIsOurs())) throw new Error(`port ${PORT} is busy with another server`);
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.setDefaultTimeout(0);
page.on('console', (m) => { const t = m.text(); if (m.type() === 'error' || m.type() === 'warning') { if (!/GPU stall|ReadPixels|WebGL/.test(t)) console.log(`[browser ${m.type()}] ${t}`); } });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));

const base = `http://localhost:${PORT}/?seed=${encodeURIComponent(seed)}&quality=${quality}&shots=1${real ? '' : '&fakeobjectives=1'}`;

async function load(extra) {
  const t0 = Date.now();
  await page.goto(`${base}&${extra}`, { timeout: 120000 });
  await page.waitForFunction(() => window.__game !== undefined, null, { timeout: 300000, polling: 250 });
  await page.evaluate(() => window.__game.ready());
  await page.evaluate(() => window.__game.freeze(true));
  await page.evaluate(() => window.__game.host.setSettings({ hints: false }));
  console.log(`run ready in ${((Date.now() - t0) / 1000).toFixed(1)} s (${extra})`);
}

async function shot(name, { settle = true } = {}) {
  if (settle) await page.evaluate(() => window.__game.settle());
  await page.evaluate(() => window.__game.draw());
  await page.waitForTimeout(150);
  const file = resolve(OUT, `${name}${suffix}.png`);
  await page.screenshot({ path: file });
  console.log(`${name}${suffix}: ${Math.round(statSync(file).size / 1024)} KB`);
}

const advance = (seconds, input = {}) => page.evaluate(([s, i]) => window.__game.advance(s, i), [seconds, input]);
const ui = (fn, arg) => page.evaluate(fn, arg);
/** A few UI frames with the world held still (the HUD repaints in its own loop). */
const frames = (n = 4) => page.evaluate((k) => window.__game.frames(k), n);

/** Screen position (client px) of a world point, or null. */
const project = (x, y, z) => page.evaluate(([a, b, c]) => window.__game.session.controls.project(a, b, c), [x, y, z]);

/** Turns the character and the camera to face `yaw` (radians, 0 = +z). */
const face = (yaw) => page.evaluate((y) => {
  const s = window.__game.session; const p = s.services.player; const b = p.body();
  p.placeAt(b.x, b.z, y);
  const r = s.renderer; const d = Math.atan2(Math.sin(y - r.getCameraYaw()), Math.cos(y - r.getCameraYaw()));
  r.orbit(d, 0);
}, yaw);

try {
  if (want('hud', 'hover', 'whatnow', 'banner', 'edge', 'journal', 'daysummary', 'intro', 'tour')) {
    await load('autostart=1&time=0.33');
    // stand a little way from home, looking at the village
    await advance(1.5);
    if (want('hud')) await shot('clarity-hud');
    if (want('whatnow')) {
      await ui(() => window.__ui.toggleWhatNow?.());
      await frames(6);
      await shot('clarity-whatnow', { settle: false });
      await ui(() => window.__ui.toggleWhatNow?.());
    }
  }
} catch (e) {
  console.log('SHOT ERROR', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  if (vite) { try { process.kill(-vite.pid, 'SIGTERM'); } catch { vite.kill('SIGTERM'); } }
}
