// Flow check of "Go to…" (H1) in the real game, headless Chromium: breath comes back quickly after a sprint, ; opens the page,
// searching, "Go to the smithy" skips the walk (the clock moves on by the walking time and you stand at the door), the refusals
// (a fight near), the journal's "Go now"; and the castle scenario's march skipped (the host camped before the walls). With
// --shots=DIR it also writes the screenshots (the page, the arrival, the camp).
//
//   node tools/goto-flow.mjs [--seed=abc] [--port=5291] [--shots=/tmp/dir]
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : def; };
const PORT = Number(opt('port', 5291));
const seed = opt('seed', 'millennia');
const SHOTS = opt('shots', '');
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

async function serverUp() { try { return (await fetch(`http://localhost:${PORT}/`)).ok; } catch { return false; } }
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
if (await serverUp()) throw new Error(`port ${PORT} is busy: pass --port=<free port> (a server on it may be another worktree's)`);
vite = await startVite();

const browser = await chromium.launch();
let page = null;
const errors = [];
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  ${detail}`}`); if (!ok) failures++; };
const tick = (s) => page.evaluate((n) => window.__game.tick(n), s);
const ev = (fn, arg) => page.evaluate(fn, arg);
const panels = () => page.evaluate(() => window.__ui.openPanels());

async function load(extra) {
  if (!(await serverUp())) vite = await startVite(); // (another builder's cleanup may have taken the server)
  if (page) { try { await page.close(); } catch { /* gone */ } }
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(0);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/GPU stall|ReadPixels|WebGL/.test(m.text())) errors.push(m.text()); });
  await page.goto(`http://localhost:${PORT}/?seed=${encodeURIComponent(seed)}&quality=low&shots=1&${extra}`, { timeout: 120000 });
  await page.waitForFunction(() => window.__game !== undefined && window.__ui !== undefined, null, { timeout: 300000, polling: 250 });
  await page.evaluate(() => window.__game.ready());
}
async function shot(name) {
  if (!SHOTS) return;
  for (let i = 0; i < 5; i++) { await page.evaluate(() => window.__game.draw()); await page.waitForTimeout(60); }
  await page.screenshot({ path: resolve(SHOTS, `h1-${name}.png`) });
}
/** Runs whole frames until the clock's skip is over (the walk passing), at most `max` seconds of frames. */
async function runSkip(max = 120) {
  for (let i = 0; i < max * 4; i++) {
    const on = await ev(() => { window.__game.tick(0.25); return !!window.__game.session.sim.clock.skip; });
    if (!on && i > 1) return true;
  }
  return false;
}

try {
  // ---- breath after a sprint
  await load('autostart=1&time=0.42');
  await ev(() => window.__game.freeze(false));
  await ev(() => window.__game.host.setSettings({ labels: false }));
  await page.keyboard.down('KeyW');
  await page.keyboard.down('ShiftLeft');
  let ex = false, maxSt = 0;
  for (let i = 0; i < 40 && !ex; i++) { await tick(0.5); const h = await ev(() => window.__game.session.services.player.hud()); maxSt = h.maxStamina; ex = h.stamina < h.maxStamina * 0.2; }
  await page.keyboard.up('ShiftLeft');
  await page.keyboard.up('KeyW');
  check('a long sprint runs the wind down', ex);
  await tick(3.5);
  const rest = await ev(() => window.__game.session.services.player.hud());
  check('a few seconds standing and the breath is back to the best part of the pool', rest.stamina > maxSt * 0.5, `${rest.stamina}/${rest.maxStamina}`);

  // ---- the page
  await tick(0.3);
  await page.keyboard.press('Semicolon');
  await tick(0.3);
  check('; opens Go to…', (await panels()).join() === 'goto', (await panels()).join());
  const names = await page.locator('.mu-prow-name').allTextContents();
  check('it lists Home and the village by what they are', names.includes('Home') && names.length >= 4, names.join(' | '));
  check('and the page groups them', (await page.locator('.mu-jhead').allTextContents()).join('|').includes('Home'));
  await shot('goto-page');
  await page.locator('input[type=search]').fill('smithy');
  await tick(0.2);
  const found = await page.locator('.mu-prow-name').allTextContents();
  check('searching narrows to the smithy', found.length === 1 && /smithy/i.test(found[0]), found.join(' | '));
  const sub = await page.locator('.mu-prow-sub').first().textContent();
  console.log(`     smithy row: ${sub}`);

  // ---- go
  const target = await ev(() => { const g = window.__game.session.services.goto; const p = g.places().find((q) => /smithy/i.test(q.name)); return p ? { id: p.id, x: p.stand.x, z: p.stand.z } : null; });
  const day0 = await ev(() => window.__game.session.sim.absDay);
  const b0 = await ev(() => ({ ...window.__game.session.services.player.body() }));
  await page.locator('.mu-prow button').first().click();
  await tick(0.1);
  check('choosing it closes the page', (await panels()).length === 0);
  const done = await runSkip();
  check('the walk passes and ends', done);
  const day1 = await ev(() => window.__game.session.sim.absDay);
  const b1 = await ev(() => ({ ...window.__game.session.services.player.body() }));
  const walk = Math.hypot(b1.x - b0.x, b1.z - b0.z);
  console.log(`     ${walk.toFixed(0)} m, ${((day1 - day0) * 24 * 60).toFixed(0)} game minutes passed`);
  check('the clock moved on by about the walking time', day1 - day0 > 0.003, `${day1 - day0}`);
  check('and you stand at the smithy door', Math.hypot(b1.x - target.x, b1.z - target.z) < 4, `${Math.hypot(b1.x - target.x, b1.z - target.z)} m`);
  await tick(0.5);
  await ev(() => { const g = window.__game; const r = g.session.renderer; r.orbit(0, 0); });
  await shot('goto-arrival');

  // ---- the refusals
  await ev(() => { window.__game.session.sim.hostileNear = () => true; });
  await page.keyboard.press('Semicolon');
  await tick(0.3);
  const disabled = await page.locator('.mu-prow button:disabled').count();
  const total = await page.locator('.mu-prow button').count();
  check('with a fight near every Go is refused, with the reason', disabled === total && total > 0 && /fight|hostile/i.test(await page.locator('.mu-prow-sub').nth(1).textContent()), `${disabled}/${total}`);
  await page.keyboard.press('Escape');
  await tick(0.3);
  await ev(() => { window.__game.session.sim.hostileNear = () => false; });

  // ---- the journal's Go now
  await page.keyboard.press('KeyO');
  await tick(0.3);
  await page.locator('.mu-tab', { hasText: 'Places' }).click();
  await tick(0.2);
  const goNow = await page.locator('button', { hasText: 'Go now' }).count();
  check('the journal\'s places carry a Go now beside Find', goNow >= 2, String(goNow));
  await page.keyboard.press('Escape');
  await tick(0.3);

  // ---- the host
  await load('scenario=castle');
  await ev(() => window.__game.tick(0.3));
  const phase = await ev(() => {
    const g = window.__game;
    for (let i = 0; i < 600; i++) { g.tick(1); if (g.session.sim.clock.skip) continue; const p = g.session.services.campaign?.phase(); if (p === 'before' || p === 'camp' || p === 'storm') return p; }
    return g.session.services.campaign?.phase() ?? 'none';
  });
  check('riding with the host: the march is skipped and you are at its camp before the walls (or the storm)', phase === 'before' || phase === 'camp' || phase === 'storm', phase);
  await tick(1);
  await shot('host-camp');
} catch (e) {
  console.log('FLOW ERROR', e.message);
  failures++;
} finally {
  await browser.close();
  if (vite) { try { process.kill(-vite.pid, 'SIGTERM'); } catch { vite.kill('SIGTERM'); } }
}
if (errors.length) { console.log(`\n${errors.length} page errors:`); for (const e of errors.slice(0, 10)) console.log(`  ${e}`); failures++; }
console.log(failures ? `\n${failures} failure(s)` : '\nall goto flow checks passed');
process.exit(failures ? 1 : 0);
