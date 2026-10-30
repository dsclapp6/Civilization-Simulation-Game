// UI screenshots for visual review: starts Vite on :5177, opens the UI gallery (?mode=ui) in headless
// Chromium and saves docs/ui/<name>-<WxH>.jpg (or .png) for every screen and panel.
//
//   node tools/ui-shots.mjs                       # all entries at 1280x720 and 1920x1080
//   node tools/ui-shots.mjs hud trade --size=1280x720
//   node tools/ui-shots.mjs --list                # the entry names
//   node tools/ui-shots.mjs --check               # exit 1 on page errors or layout overflow
//   node tools/ui-shots.mjs --scale=1.25 --out=/tmp/ui   # other UI scale / output folder
//   node tools/ui-shots.mjs --format=png          # lossless (default: full-chroma JPEG via ImageMagick, 6x smaller)
//   node tools/ui-shots.mjs --bench               # JS timing of the HUD and of opening each panel
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5177;
const args = process.argv.slice(2);
const opt = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const OUT = resolve(ROOT, opt('out', 'docs/ui'));
const sizes = opt('size', '1280x720,1920x1080').split(',').map((s) => s.split('x').map(Number));
const scale = opt('scale', '');
const check = args.includes('--check');
const format = opt('format', 'jpg');
const extraQuery = opt('query', '');
const wanted = args.filter((a) => !a.startsWith('--'));

async function serverUp() {
  try { return (await fetch(`http://localhost:${PORT}/`)).ok; } catch { return false; }
}
async function serverIsOurs() {
  try {
    const r = await fetch(`http://localhost:${PORT}/src/ui/dev/gallery.ts`);
    return r.ok && (await r.text()).includes('__ui');
  } catch { return false; }
}
function startVite() {
  return new Promise((resolveStart, reject) => {
    const proc = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BROWSER: 'none' }, detached: true });
    let done = false;
    const onData = (d) => {
      if (!done && /Local:|ready in/i.test(d.toString())) { done = true; resolveStart(proc); }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', (d) => { onData(d); if (/error/i.test(d.toString())) process.stderr.write(d); });
    proc.on('exit', (code) => { if (!done) reject(new Error(`vite exited (${code})`)); });
    setTimeout(() => { if (!done) { done = true; resolveStart(proc); } }, 25000);
  });
}
async function acquireServer() {
  for (let i = 0; i < 20; i++) {
    if (!(await serverUp())) return startVite();
    if (await serverIsOurs()) return null;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`port ${PORT} is busy with another server`);
}

/** Runs inside the page: finds windows that do not fit the viewport and text that overflows its box. */
function audit() {
  const problems = [];
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const root = document.querySelector('.mu-root');
  if (!root) return problems;
  const s = root.getBoundingClientRect().width / root.offsetWidth || 1;
  for (const win of root.querySelectorAll('.mu-win')) {
    const r = win.getBoundingClientRect();
    if (r.width === 0) continue;
    if (r.bottom > vh + 2 || r.top < -2 || r.right > vw + 2 || r.left < -2) problems.push(`window outside the viewport: ${win.getAttribute('aria-label') ?? win.className} (${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} in ${vw}x${vh})`);
    const body = win.querySelector('.mu-win-body');
    if (body && body.scrollWidth > body.clientWidth + 2) problems.push(`horizontal overflow in ${win.getAttribute('aria-label')}: ${body.scrollWidth} > ${body.clientWidth}`);
  }
  for (const el of root.querySelectorAll('.mu-btn, .mu-chip, .mu-tab, .mu-li, .mu-card h4')) {
    if (el.offsetWidth === 0) continue;
    if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflow === 'hidden' && getComputedStyle(el).textOverflow !== 'ellipsis') {
      problems.push(`clipped text in .${[...el.classList].join('.')}: "${(el.textContent ?? '').trim().slice(0, 40)}"`);
    }
  }
  void s;
  return problems;
}

const vite = await acquireServer();
console.log(vite ? 'vite started' : `reusing server on :${PORT}`);
const errors = [];
const warnings = [];
let browser;
try {
  mkdirSync(OUT, { recursive: true });
  browser = await chromium.launch();
  for (const [W, H] of sizes) {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    page.setDefaultTimeout(0);
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') { const t = `[${W}x${H} ${m.type()}] ${m.text()}`; if (m.type() === 'error') errors.push(t); console.log(t); } });
    page.on('pageerror', (e) => { errors.push(`[${W}x${H} pageerror] ${e.message}`); console.log(`[pageerror] ${e.message}`); });
    const t0 = Date.now();
    await page.goto(`http://localhost:${PORT}/?mode=ui&still=1&chrome=0${scale ? `&scale=${scale}` : ''}${extraQuery ? `&${extraQuery}` : ''}`, { timeout: 120000 });
    await page.waitForFunction(() => window.__ui && window.__ui.ready, null, { timeout: 300000, polling: 300 });
    console.log(`gallery ready at ${W}x${H} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const all = await page.evaluate(() => window.__ui.entries);
    if (args.includes('--list')) { console.log(all.join('\n')); break; }
    if (args.includes('--bench')) {
      // JS cost of the UI itself (HUD per frame, opening each panel); layout and paint are the browser's
      const r = await page.evaluate(() => window.__ui.bench());
      const f = r.frameMs;
      console.log(`HUD update at ${W}x${H}: mean ${f.mean.toFixed(3)} ms, p95 ${f.p95.toFixed(3)} ms, max ${f.max.toFixed(3)} ms`);
      for (const [name, v] of Object.entries(r.panels)) console.log(`  ${name.padEnd(10)} open ${v.open.toFixed(2)} ms   first update ${v.update.toFixed(2)} ms`);
      await page.close();
      continue;
    }
    const names = wanted.length ? wanted : all.filter((n) => n !== 'icons');
    for (const name of names) {
      if (!all.includes(name)) { console.log(`unknown entry ${name}`); continue; }
      const t1 = Date.now();
      try {
        await page.evaluate((id) => window.__ui.run(id), name);
      } catch (e) {
        errors.push(`[${W}x${H} ${name}] ${e.message}`);
        console.log(`${name}: FAILED ${e.message}`);
        continue;
      }
      await page.waitForTimeout(120);
      let file = resolve(OUT, `${name}-${W}x${H}.png`);
      await page.screenshot({ path: file });
      if (format === 'jpg') {
        // the 3D backdrops make PNGs huge; full-chroma JPEG keeps text crisp at a sixth of the size
        const jpg = file.replace(/\.png$/, '.jpg');
        try {
          execFileSync('convert', [file, '-sampling-factor', '4:4:4', '-quality', '86', jpg]);
          unlinkSync(file);
          file = jpg;
        } catch { /* ImageMagick missing: keep the PNG */ }
      }
      const problems = await page.evaluate(audit);
      for (const p of problems) warnings.push(`[${W}x${H} ${name}] ${p}`);
      console.log(`${name}: ${((Date.now() - t1) / 1000).toFixed(1)} s, ${Math.round(statSync(file).size / 1024)} KB${problems.length ? `  (${problems.length} layout warnings)` : ''}`);
    }
    await page.close();
  }
} finally {
  await browser?.close();
  if (vite) { try { process.kill(-vite.pid, 'SIGTERM'); } catch { vite.kill('SIGTERM'); } }
}
if (warnings.length) { console.log('\nLayout warnings:'); for (const w of warnings) console.log(`  ${w}`); }
if (errors.length) { console.log(`\n${errors.length} errors`); if (check) process.exit(1); }
else console.log('\nno page errors');
if (check && warnings.length) process.exit(1);
