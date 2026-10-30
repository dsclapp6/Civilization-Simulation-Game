// Characters gallery screenshots → docs/art/characters/*.png
// Usage: node tools/chars-shots.mjs [shotName ...]
// Starts a Vite dev server on :5175, drives Playwright Chromium (WebGL2 via SwiftShader)
// through deterministic gallery captures (?mode=chars&shot=…), saves PNGs and prints stats.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const outDir = resolve(repo, 'docs/art/characters');
const PORT = 5175;
const BASE = `http://localhost:${PORT}/`;

/** name → query string (without mode=chars) and viewport. */
const SHOTS = {
  lineup: { q: 'scene=lineup&t=1.4&cam=0,2.3,13.2,0,0.95,0.3', w: 1600, h: 800 },
  lineup_low: { q: 'scene=lineup&t=1.4&cam=-5,1.55,7.2,-5,1.0,0.3', w: 1400, h: 760 },
  lineup_high: { q: 'scene=lineup&t=1.4&cam=5,1.55,7.2,5,1.0,0.3', w: 1400, h: 760 },
  walk: { q: 'scene=lineup&anim=walk&t=0.62&cam=0,1.9,9.5,-3.5,0.95,0.3', w: 1400, h: 760 },
  faces: { q: 'scene=faces&t=0.9', w: 1400, h: 760 },
  portrait: { q: 'scene=faces&t=0.4&cam=-1.25,1.52,1.55,-1.25,1.42,0', w: 1200, h: 700 },
  portrait2: { q: 'scene=faces&t=0.4&cam=1.7,1.5,1.55,1.7,1.4,0', w: 1200, h: 700 },
  highlight: { q: 'scene=faces&t=0.6&hl=1&cam=0,1.9,5.2,0,1.0,0', w: 1400, h: 700, pickAt: [0.05, -0.1] },
  smith: { q: 'scene=action&cam=smith&t=0.22' },
  scythe: { q: 'scene=action&cam=scythe&t=0.42' },
  archer: { q: 'scene=action&cam=archer&t=1.4' },
  crossbow: { q: 'scene=action&cam=crossbow&t=1.2' },
  knight: { q: 'scene=action&cam=knight&t=1.86' },
  swordfight: { q: 'scene=action&cam=swordfight&t=0.98' },
  fallen: { q: 'scene=action&cam=fallen&t=1.0' },
  labour: { q: 'scene=action&cam=labour&t=0.5', w: 1400, h: 760 },
  village: { q: 'scene=action&cam=village&t=1.1', w: 1400, h: 760 },
  riders: { q: 'scene=riders&gait=gallop&t=0.9', w: 1400, h: 760 },
  riders_walk: { q: 'scene=riders&gait=walk&t=1.3&cam=-7.5,2.4,8.5,0,1.2,0', w: 1400, h: 760 },
  anims: { q: 'scene=anims&t=0.6', w: 1600, h: 900 },
  anims0: { q: 'scene=anims&t=0.55&cam=row0', w: 1600, h: 700 },
  anims1: { q: 'scene=anims&t=0.55&cam=row1', w: 1600, h: 700 },
  anims2: { q: 'scene=anims&t=0.55&cam=row2', w: 1600, h: 700 },
  anims3: { q: 'scene=anims&t=0.45&cam=row3', w: 1600, h: 700 },
  anims4: { q: 'scene=anims&t=0.9&cam=row4', w: 1600, h: 700 },
  anims5: { q: 'scene=anims&t=0.7&cam=row5', w: 1600, h: 700 },
  anims6: { q: 'scene=anims&t=0.9&cam=row6', w: 1600, h: 700 },
  animals: { q: 'scene=animals&t=1.0', w: 1600, h: 800 },
  animals_big: { q: 'scene=animals&t=1.0&cam=big', w: 1600, h: 800, pickAt: [0, -0.1] },
  animals_small: { q: 'scene=animals&t=1.0&cam=small', w: 1600, h: 800 },
  animals_run: { q: 'scene=animals&aanim=run&t=0.7', w: 1600, h: 800 },
  animals_graze: { q: 'scene=animals&aanim=graze&t=1.2', w: 1600, h: 800 },
  animals_lie: { q: 'scene=animals&aanim=lie&t=1.2', w: 1600, h: 800 },
  animals_attack: { q: 'scene=animals&aanim=attack&t=0.55', w: 1600, h: 800 },
  crowd: { q: 'scene=crowd&t=2.0&bench=240', w: 1600, h: 900 },
  crowd_close: { q: 'scene=crowd&t=2.0&cam=6,1.8,18,0,1.0,4', w: 1600, h: 900 },
  bench_nolod: { q: 'scene=crowd&t=2.0&bench=240&lod=0&animlod=0', w: 960, h: 540, noImage: true },
};

async function waitForServer(url, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Vite did not start on ${url}`);
}

const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const names = wanted.length ? wanted : Object.keys(SHOTS);
for (const n of names) if (!SHOTS[n]) { console.error(`unknown shot ${n}; known: ${Object.keys(SHOTS).join(', ')}`); process.exit(1); }

mkdirSync(outDir, { recursive: true });
// own process group so that npx *and* the vite node process it spawns are stopped together
const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BROWSER: 'none' }, detached: true,
});
let viteLog = '';
vite.stdout.on('data', (d) => { viteLog += d; });
vite.stderr.on('data', (d) => { viteLog += d; });
const stopVite = () => {
  try { process.kill(-vite.pid, 'SIGTERM'); } catch { /* already gone */ }
  try { vite.kill('SIGTERM'); } catch { /* ignore */ }
};
process.on('exit', stopVite);
process.on('SIGINT', () => { stopVite(); process.exit(130); });

async function shoot(browser, name) {
  const s = SHOTS[name];
  const page = await browser.newPage({ viewport: { width: s.w ?? 1280, height: s.h ?? 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const url = `${BASE}?mode=chars&shot=${name}&${s.q}`;
  const t0 = Date.now();
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => window.__charsReady === true, null, { timeout: 300000, polling: 250 });
    const stats = await page.evaluate(() => window.__chars?.stats() ?? {});
    const file = resolve(outDir, `${name}.png`);
    let kb = '-';
    if (!s.noImage) { await page.screenshot({ path: file }); kb = (statSync(file).size / 1024).toFixed(0); }
    console.log(`✓ ${name.padEnd(14)} ${kb.padStart(5)} KB  ${((Date.now() - t0) / 1000).toFixed(1)}s  calls=${stats.calls} tris=${stats.triangles} chars=${stats.characters} (${(stats.charMs ?? 0).toFixed(2)} ms) animals=${stats.animals} (${(stats.animalMs ?? 0).toFixed(2)} ms)`);
    if (stats.benchFrames) console.log(`  bench ${stats.benchFrames} frames: characters avg ${stats.charAvg.toFixed(2)} / median ${stats.charMed.toFixed(2)} / p95 ${stats.charP95.toFixed(2)} ms | animals avg ${stats.animalAvg.toFixed(2)} / median ${stats.animalMed.toFixed(2)} / p95 ${stats.animalP95.toFixed(2)} ms | layer tris chars ${stats.charTris} animals ${stats.animalTris}`);
    if (s.pickAt) {
      const hit = await page.evaluate(([x, y]) => window.__chars.pick(x, y), s.pickAt);
      console.log(`  pick at (${s.pickAt}) → person ${hit.person}, animal ${hit.animal}`);
    }
    if (errors.length) console.log(`  page errors: ${errors.slice(0, 5).join(' | ')}`);
    return true;
  } catch (e) {
    console.error(`✗ ${name}: ${e.message.split('\n')[0]}`);
    if (errors.length) console.error(`  page errors: ${errors.slice(0, 8).join(' | ')}`);
    return false;
  } finally {
    await page.close();
  }
}

let failed = 0;
try {
  await waitForServer(BASE, 60000);
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  // warm-up: the first load makes Vite optimise dependencies (and possibly restart)
  {
    const page = await browser.newPage();
    try { await page.goto(`${BASE}?mode=chars&shot=warmup&scene=faces&t=0.1`, { waitUntil: 'load', timeout: 120000 }); await page.waitForFunction(() => window.__charsReady === true, null, { timeout: 120000 }); } catch { /* retried below */ }
    await page.close();
    await new Promise((r) => setTimeout(r, 1500));
    await waitForServer(BASE, 60000);
  }
  for (const name of names) {
    let ok = await shoot(browser, name);
    if (!ok) { await waitForServer(BASE, 60000); ok = await shoot(browser, name); }
    if (!ok) failed++;
  }
  await browser.close();
} catch (e) {
  failed++;
  console.error(String(e));
  console.error(viteLog.slice(-2000));
} finally {
  stopVite();
}
process.exit(failed ? 1 : 0);
