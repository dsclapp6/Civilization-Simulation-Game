// Renderer screenshots for visual review: starts Vite on :5176, drives headless Chromium
// (WebGL2 via SwiftShader — slow but correct) through the world viewer presets and saves
// docs/render/<preset>.png.
//
//   node tools/render-shots.mjs                 # all presets but the civilization pass's, medium quality
//   node tools/render-shots.mjs village night   # selected presets
//   node tools/render-shots.mjs civ             # the civilization pass's scenes (civ-*) → docs/render/civ/*.jpg
//   node tools/render-shots.mjs --civ-art       # its art sheets from the asset gallery → docs/art/civ/*.jpg
//   node tools/render-shots.mjs --quality=high --size=1600x900 --seed=millennia --port=5176
//   flags: --ui (viewer with its dev overlay), --bench (fly-through timings),
//          --breakdown (draw calls / triangles per system; re-renders each shot several times)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'docs/render');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
// --port=N: a private port when several checkouts shoot at once (a server on the port is reused only if it serves
// this viewer, which another checkout's would too)
const PORT = Number(opt('port', '5176'));
const quality = opt('quality', 'medium');
const seed = opt('seed', 'millennia');
const [W, H] = opt('size', '1280x720').split('x').map(Number);
const suffix = opt('suffix', '');
const wanted = args.filter((a) => !a.startsWith('--'));
const civArt = args.includes('--civ-art');

/** Civilization pass (wave B) art from the asset gallery: [name, query, width, height] → docs/art/civ/<name>.png. */
const CIV_ART = [
  ['models-work-anglo', 'cat=sheets&sheet=culture-work&culture=anglo&level=2', 1600, 900],
  ['slaughterhouse-cultures', 'cat=sheets&sheet=cultures&item=slaughterhouse&level=2', 1600, 700],
  ['clay-pit-cultures', 'cat=sheets&sheet=cultures&item=clay_pit&level=1', 1600, 700],
  ['salt-pan-cultures', 'cat=sheets&sheet=cultures&item=salt_pan&level=1', 1600, 700],
  ['lumber-camp-cultures', 'cat=sheets&sheet=cultures&item=lumber_camp&level=1', 1600, 700],
  ['gaol-cultures', 'cat=sheets&sheet=cultures&item=gaol&level=1', 1600, 700],
  ['closeup-slaughterhouse', 'cat=buildings&item=slaughterhouse&level=2&az=30&el=24', 1200, 800],
  ['closeup-clay-pit', 'cat=buildings&item=clay_pit&level=1&az=24&el=30', 1200, 800],
  ['closeup-salt-pan', 'cat=buildings&item=salt_pan&level=1&az=-28&el=28', 1200, 800],
  ['closeup-lumber-camp', 'cat=buildings&item=lumber_camp&level=1&az=20&el=26', 1200, 800],
  ['closeup-gaol', 'cat=buildings&item=gaol&level=1&az=26&el=18', 1000, 800],
  ['stages-home', 'cat=sheets&sheet=stages-home', 2000, 1100],
  ['stages-work', 'cat=sheets&sheet=stages-work', 2000, 1100],
  ['stages-defence', 'cat=sheets&sheet=stages-defence', 2000, 1100],
  ['stages-close-homes', 'cat=sheets&sheet=stages&kinds=cottage,townhouse,smithy&k=0.45', 2000, 1100],
  ['stages-close-mills', 'cat=sheets&sheet=stages&kinds=windmill,watermill,quarry,motte&k=0.42', 2000, 1100],
  ['stages-close-church', 'cat=sheets&sheet=stages&kinds=chapel,church,keep_stone&k=0.5', 2000, 1100],
  ['cottage-states', 'cat=sheets&sheet=states&item=cottage&level=2', 1600, 800],
  ['forts', 'cat=sheets&sheet=forts', 1600, 900],
  ['siege', 'cat=sheets&sheet=siege', 1600, 900],
  ['props', 'cat=sheets&sheet=props', 1600, 1000],
  ['fx', 'cat=sheets&sheet=fx', 1600, 700],
];

async function serverUp() {
  try {
    const r = await fetch(`http://localhost:${PORT}/`);
    return r.ok;
  } catch {
    return false;
  }
}

/** A server on the port that serves this repo's world viewer (not another checkout's app). */
async function serverIsOurs() {
  try {
    const r = await fetch(`http://localhost:${PORT}/src/render/worldViewer.ts`);
    return r.ok && (await r.text()).includes('__viewer');
  } catch {
    return false;
  }
}

async function acquireServer() {
  for (let i = 0; i < 20; i++) {
    if (!(await serverUp())) return startVite();
    if (await serverIsOurs()) {
      // make sure it is not a server that is just shutting down
      await new Promise((r) => setTimeout(r, 1500));
      if (await serverIsOurs()) return null;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`port ${PORT} is busy with another server`);
}

function startVite() {
  return new Promise((resolveStart, reject) => {
    // own process group so the whole npx → vite tree can be stopped afterwards
    const proc = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BROWSER: 'none' }, detached: true });
    let done = false;
    const onData = (d) => {
      const s = d.toString();
      if (!done && /Local:|ready in/i.test(s)) { done = true; resolveStart(proc); }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', (d) => { onData(d); if (/error/i.test(d.toString())) process.stderr.write(d); });
    proc.on('exit', (code) => { if (!done) reject(new Error(`vite exited (${code})`)); });
    setTimeout(() => { if (!done) { done = true; resolveStart(proc); } }, 20000);
  });
}

// reuse a dev server that is already serving on the port (e.g. a previous run), else start one
const vite = await acquireServer();
console.log(vite ? 'vite started' : `reusing server on :${PORT}`);
let browser;
try {
  mkdirSync(OUT, { recursive: true });
  browser = await chromium.launch();
  console.log('browser launched');
  // --civ-art alone (its words filter the art sheets) needs no world
  const world = !civArt || args.includes('--ui') || args.includes('--bench');
  const page = world ? await browser.newPage({ viewport: { width: W, height: H } }) : null;
  let list = [];
  if (page) {
    page.setDefaultTimeout(0);
    page.on('console', (m) => console.log(`[browser ${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
    const t0 = Date.now();
    await page.goto(`http://localhost:${PORT}/?mode=world&shots=1&seed=${encodeURIComponent(seed)}&quality=${quality}`, { timeout: 120000 });
    await page.waitForFunction(() => window.__viewer !== undefined, null, { timeout: 600000, polling: 500 });
    console.log(`viewer ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const presets = await page.evaluate(() => window.__viewer.presets);
    // `civ` stands for every civilization-pass scene; those go to their own folder and are not in the default set
    list = civArt ? [] : wanted.length ? wanted.flatMap((w) => (w === 'civ' ? presets.filter((p) => p.startsWith('civ-')) : [w]))
      : presets.filter((p) => !p.startsWith('civ-'));
  }
  for (const name of list) {
    const t1 = Date.now();
    const info = await page.evaluate(([n, b]) => window.__viewer.preset(n, b), [name, args.includes('--breakdown')]);
    // the civilization pass's scenes go to their own folder as JPEG (quality 90) to keep the folder small
    const civ = name.startsWith('civ-');
    const dir = civ ? resolve(OUT, 'civ') : OUT;
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, `${name}${suffix}.${civ ? 'jpg' : 'png'}`);
    await (civ ? page.screenshot({ path: file, type: 'jpeg', quality: 90 }) : page.screenshot({ path: file }));
    const kb = Math.round(statSync(file).size / 1024);
    console.log(`${name}: ${((Date.now() - t1) / 1000).toFixed(1)} s, ${kb} KB  ${info}`);
  }
  if (args.includes('--ui')) {
    // the interactive viewer with its dev overlay (real-time loop, no shots mode), in a fresh page
    const ui = await browser.newPage({ viewport: { width: W, height: H } });
    ui.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
    await ui.goto(`http://localhost:${PORT}/?mode=world&seed=${encodeURIComponent(seed)}&quality=${quality}&preset=village`, { timeout: 180000 });
    await ui.waitForFunction(() => window.__viewer !== undefined, null, { timeout: 600000, polling: 500 });
    try {
      await ui.waitForFunction(() => (document.querySelector('pre')?.textContent ?? '').includes('draw calls'), null, { timeout: 300000, polling: 1000 });
      await ui.waitForTimeout(1500);
    } catch {
      console.log('viewer-ui: overlay stats not ready in time, capturing anyway');
    }
    const file = resolve(OUT, `viewer-ui${suffix}.png`);
    await ui.screenshot({ path: file });
    console.log(`viewer-ui: ${Math.round(statSync(file).size / 1024)} KB`);
    await ui.close();
  }
  if (civArt) {
    const artDir = resolve(ROOT, 'docs/art/civ');
    mkdirSync(artDir, { recursive: true });
    for (const [name, q, w, h] of CIV_ART) {
      if (wanted.length && !wanted.some((x) => name.includes(x))) continue;
      const t1 = Date.now();
      const gp = await browser.newPage({ viewport: { width: w, height: h } });
      gp.setDefaultTimeout(0);
      gp.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
      await gp.goto(`http://localhost:${PORT}/?mode=gallery&shot=1&${q}`, { waitUntil: 'load', timeout: 120000 });
      await gp.waitForFunction(() => window.__galleryReady === true, null, { timeout: 1200000, polling: 500 });
      const file = resolve(artDir, `${name}.jpg`);
      await gp.screenshot({ path: file, type: 'jpeg', quality: 90 });
      console.log(`art ${name}: ${((Date.now() - t1) / 1000).toFixed(1)} s, ${Math.round(statSync(file).size / 1024)} KB`);
      await gp.close();
    }
  }
  if (args.includes('--bench') && page) {
    const b = await page.evaluate(() => window.__viewer.benchmark(240, 22));
    console.log(`benchmark (street-level fly-through, ${quality}): ${JSON.stringify(b)}`);
  }
} finally {
  await browser?.close();
  if (vite) {
    try { process.kill(-vite.pid, 'SIGTERM'); } catch { vite.kill('SIGTERM'); }
  }
}
