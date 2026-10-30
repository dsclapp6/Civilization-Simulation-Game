#!/usr/bin/env node
// Capture asset-gallery screenshots (contact sheets and close-ups) to docs/art/*.png.
// Starts a Vite dev server on port 5174 (JS API, HMR off so edits can't reload pages mid-shot;
// falls back to `npx vite --port 5174 --strictPort`), drives Playwright Chromium (WebGL2 via
// SwiftShader), waits for window.__galleryReady and saves each view. Each shot retries once.
//
//   node tools/gallery-shots.mjs                   # all shots
//   node tools/gallery-shots.mjs cottage church    # only shots whose name contains a filter
//   SHOTS_OUT=/tmp/x node tools/gallery-shots.mjs  # write elsewhere (iteration)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.SHOTS_OUT ? resolve(process.env.SHOTS_OUT) : join(ROOT, 'docs', 'art');
const PORT = 5174;
const BASE = `http://localhost:${PORT}/?mode=gallery&shot=1`;
const MAX_BYTES = 1.5 * 1024 * 1024;

/** [name, query, width, height] */
export const SHOTS = [
  ['village', 'cat=sheets&sheet=village', 1600, 900],
  ['village-night', 'cat=sheets&sheet=village-night', 1600, 900],
  ['village-winter', 'cat=sheets&sheet=village-winter', 1600, 900],
  ['village-norse', 'cat=sheets&sheet=village&culture=norse', 1600, 900],
  ['village-teuton', 'cat=sheets&sheet=village&culture=teuton', 1600, 900],
  ['village-gael', 'cat=sheets&sheet=village&culture=gael&season=2&sp=0.4', 1600, 900],
  ['homes-anglo', 'cat=sheets&sheet=culture-home&culture=anglo&level=3', 1600, 900],
  ['farm-anglo', 'cat=sheets&sheet=culture-farm&culture=anglo&level=3', 1600, 900],
  ['work-anglo', 'cat=sheets&sheet=culture-work&culture=anglo&level=3', 1600, 900],
  ['social-anglo', 'cat=sheets&sheet=culture-social&culture=anglo&level=3', 1600, 900],
  ['church-anglo', 'cat=sheets&sheet=culture-church&culture=anglo&level=3', 1600, 900],
  ['defence-anglo', 'cat=sheets&sheet=culture-defence&culture=anglo&level=3', 1600, 900],
  ['homes-franc', 'cat=sheets&sheet=culture-home&culture=franc&level=3', 1600, 900],
  ['defence-franc', 'cat=sheets&sheet=culture-defence&culture=franc&level=3', 1600, 900],
  ['cottage-levels-cultures', 'cat=sheets&sheet=levels&item=cottage', 1600, 1000],
  ['townhouse-levels-cultures', 'cat=sheets&sheet=levels&item=townhouse', 1600, 1000],
  ['manor-levels-cultures', 'cat=sheets&sheet=levels&item=manor_house', 1600, 1000],
  ['longhouse-levels-cultures', 'cat=sheets&sheet=levels&item=longhouse', 1600, 1000],
  ['church-cultures', 'cat=sheets&sheet=cultures&item=church&level=3', 1600, 700],
  ['keep-cultures', 'cat=sheets&sheet=cultures&item=keep_stone&level=3', 1600, 700],
  ['cottage-states', 'cat=sheets&sheet=states&item=cottage&level=2', 1600, 800],
  ['church-states', 'cat=sheets&sheet=states&item=church&level=2', 1600, 800],
  ['vegetation-seasons', 'cat=sheets&sheet=vegetation-seasons', 1600, 1000],
  ['vegetation-lods', 'cat=sheets&sheet=vegetation-lods', 1600, 1000],
  ['crops', 'cat=sheets&sheet=crops', 1400, 1000],
  ['props', 'cat=sheets&sheet=props', 1600, 1000],
  ['fx', 'cat=sheets&sheet=fx', 1600, 700],
  ['closeup-cottage', 'cat=buildings&item=cottage&level=2', 1200, 800],
  ['closeup-cathedral', 'cat=buildings&item=cathedral&level=2', 1400, 900],
  ['closeup-keep', 'cat=buildings&item=keep_stone&level=3', 1200, 900],
  ['closeup-windmill', 'cat=buildings&item=windmill&level=2', 1000, 900],
  ['closeup-watermill', 'cat=buildings&item=watermill&level=2&az=150', 1200, 800],
  ['closeup-tavern', 'cat=buildings&item=tavern&level=3', 1200, 800],
  ['closeup-smithy-night', 'cat=buildings&item=smithy&level=3&time=0.88', 1200, 800],
];

async function waitForServer(url, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('vite did not start');
}

async function startVite() {
  try {
    const { createServer } = await import('vite');
    const server = await createServer({ root: ROOT, logLevel: 'warn', server: { port: PORT, strictPort: true, hmr: false } });
    await server.listen();
    return { stop: () => server.close() };
  } catch (e) {
    console.warn('vite JS API failed, spawning CLI:', String(e).slice(0, 200));
    const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
    return { stop: () => { try { child.kill('SIGTERM'); } catch { /* ignore */ } } };
  }
}

async function shoot(browser, name, query, w, h) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  try {
    const t0 = Date.now();
    await page.goto(`${BASE}&${query}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__galleryReady === true, null, { timeout: 240000, polling: 250 });
    const file = join(OUT, `${name}.png`);
    await page.screenshot({ path: file });
    const stats = await page.evaluate(() => window.__galleryStats);
    const bytes = statSync(file).size;
    const big = bytes > MAX_BYTES ? '  ⚠ over 1.5 MB' : '';
    console.log(`✓ ${name} (${Math.round(bytes / 1024)} KB, ${((Date.now() - t0) / 1000).toFixed(1)}s)${stats ? ` calls=${stats.calls} tris=${stats.frameTris} bldTris=${stats.buildingTris}` : ''}${big}${errors.length ? `\n   errors: ${errors.slice(0, 3).join(' | ')}` : ''}`);
    return true;
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const filters = process.argv.slice(2);
  const shots = SHOTS.filter(([name]) => !filters.length || filters.some((f) => name.includes(f)));
  mkdirSync(OUT, { recursive: true });
  const vite = await startVite();
  const failed = [];
  try {
    await waitForServer(`http://localhost:${PORT}/`);
    const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    for (const [name, query, w, h] of shots) {
      let ok = false;
      for (let attempt = 0; attempt < 2 && !ok; attempt++) {
        try { ok = await shoot(browser, name, query, w, h); }
        catch (e) { console.error(`✗ ${name} attempt ${attempt + 1}: ${String(e).split('\n')[0]}`); }
      }
      if (!ok) failed.push(name);
    }
    await browser.close();
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    await vite.stop();
  }
  console.log(failed.length ? `done with failures: ${failed.join(', ')}` : `done: ${shots.length} shots in ${OUT}`);
  if (failed.length) process.exitCode = 1;
  process.exit();
}

main();
