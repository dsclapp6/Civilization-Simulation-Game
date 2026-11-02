// Village screenshots for visual review: starts Vite on :5191 (--port=N to change), drives headless Chromium (WebGL2 via
// SwiftShader — slow but correct) through the village viewer's scenes and saves docs/agents/<scene>.png.
//
//   node tools/village-shots.mjs                 # all scenes, medium quality
//   node tools/village-shots.mjs dawn market     # selected scenes
//   node tools/village-shots.mjs --quality=low --size=1280x720 --seed=millennia --suffix=-b
//   node tools/village-shots.mjs --list          # scene ids
//   node tools/village-shots.mjs commute site lead --out=/tmp/shots   # the civilization pass scenes, saved elsewhere
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const OUT = resolve(ROOT, opt('out', 'docs/agents'));
const PORT = Number(opt('port', '5191'));
const quality = opt('quality', 'medium');
const seed = opt('seed', 'millennia');
const [W, H] = opt('size', '1280x720').split('x').map(Number);
const suffix = opt('suffix', '');
const wanted = args.filter((a) => !a.startsWith('--'));

async function serverUp() {
  try { return (await fetch(`http://localhost:${PORT}/`)).ok; } catch { return false; }
}

/** A server on the port that serves this repo's village viewer (not another checkout's app). */
async function serverIsOurs() {
  try {
    const r = await fetch(`http://localhost:${PORT}/src/agents/dev/villageViewer.ts`);
    return r.ok && (await r.text()).includes('__village');
  } catch { return false; }
}

async function acquireServer() {
  for (let i = 0; i < 20; i++) {
    if (!(await serverUp())) return startVite();
    if (await serverIsOurs()) {
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

const vite = await acquireServer();
console.log(vite ? 'vite started' : `reusing server on :${PORT}`);
let browser;
try {
  mkdirSync(OUT, { recursive: true });
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.setDefaultTimeout(0);
  page.on('console', (m) => { const t = m.text(); if (m.type() !== 'debug' && !/GPU stall|WebGL/.test(t)) console.log(`[browser ${m.type()}] ${t}`); });
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  const t0 = Date.now();
  await page.goto(`http://localhost:${PORT}/?mode=village&shots=1&seed=${encodeURIComponent(seed)}&quality=${quality}`, { timeout: 120000 });
  await page.waitForFunction(() => window.__village !== undefined, null, { timeout: 900000, polling: 500 });
  console.log(`viewer ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const scenes = await page.evaluate(() => window.__village.scenes);
  if (args.includes('--list')) { console.log(scenes.join('\n')); process.exit(0); }
  const list = wanted.length ? wanted : scenes;
  for (const name of list) {
    const t1 = Date.now();
    const info = await page.evaluate((n) => window.__village.scene(n), name);
    const file = resolve(OUT, `${name}${suffix}.png`);
    await page.screenshot({ path: file });
    const kb = Math.round(statSync(file).size / 1024);
    console.log(`${name}: ${((Date.now() - t1) / 1000).toFixed(1)} s, ${kb} KB  ${info}`);
  }
} finally {
  await browser?.close();
  if (vite) {
    try { process.kill(-vite.pid, 'SIGTERM'); } catch { vite.kill('SIGTERM'); }
  }
}
