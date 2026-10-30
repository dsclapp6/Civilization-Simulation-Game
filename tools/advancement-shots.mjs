// Screenshots of the advancement and happenings panels in the real game (headless Chromium, SwiftShader):
// the House tree (each branch), the journal of favours and notices, a village on fire.
//
//   node tools/advancement-shots.mjs [--seed=abc] [--size=1280x720]
//
// Starts Vite on :5179, begins a run, plays a few years so the world has history, teaches the player's House
// something, asks for a few favours and sets a fire, and saves docs/advancement/<name>.png.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'docs/advancement');
const PORT = 5179;
const args = process.argv.slice(2);
const opt = (name, def) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : def; };
const seed = opt('seed', 'tech');
const [W, H] = opt('size', '1280x720').split('x').map(Number);

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

const vite = (await serverUp()) ? null : await startVite();
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.setDefaultTimeout(0);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/GPU stall|ReadPixels|WebGL/.test(m.text())) errors.push(m.text()); });

async function shot(name) {
  await page.waitForTimeout(350);
  const file = resolve(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`${name}: ${Math.round(statSync(file).size / 1024)} KB`);
}

try {
  await page.goto(`http://localhost:${PORT}/?seed=${encodeURIComponent(seed)}&quality=low&shots=1&autostart=1&time=0.42`, { timeout: 120000 });
  await page.waitForFunction(() => window.__game !== undefined, null, { timeout: 300000, polling: 250 });
  await page.evaluate(() => window.__game.ready());
  await page.evaluate(() => window.__game.freeze(true));

  // a world with some history, and a House that has learned things
  const info = await page.evaluate(() => {
    const s = window.__game.session; const sim = s.sim; const adv = sim.services.advancement; const hap = sim.services.happenings;
    sim.advanceDays(16 * 2);
    const me = sim.state.persons.get(sim.state.run.playerId);
    for (const t of ['heavy_plough', 'watermill', 'parish_school', 'herbal_medicine']) adv.grant(me.id, t, 'practice');
    adv.addProgress('improved_rotation', 12);
    // a few favours of different kinds
    for (const type of ['fetch', 'work', 'loan', 'lost_animal', 'message']) hap.offerRequest(type);
    const open = hap.openRequests();
    if (open[0]) hap.acceptRequest(open[0].id);
    if (open[1]) hap.acceptRequest(open[1].id);
    hap.trigger('plague', me.settlement);
    return { settlement: me.settlement, open: open.length, techs: adv.tree().filter((v) => v.houseHas).length };
  });
  console.log('setup:', JSON.stringify(info));
  await page.evaluate(() => window.__game.draw());

  for (const [branch, label] of [['economy', 'tree-economy'], ['military', 'tree-military'], ['kinship', 'tree-kinship'], ['knowledge', 'tree-knowledge']]) {
    await page.evaluate(() => { window.__ui.closePanel('techs'); window.__ui.openPanel({ panel: 'ext', name: 'techs' }); });
    await page.waitForTimeout(250);
    await page.evaluate((b) => {
      const tab = [...document.querySelectorAll('.mu-tab')].find((el) => el.textContent.toLowerCase().includes(b === 'kinship' ? 'kinship' : b));
      tab?.click();
    }, branch);
    await shot(label);
  }
  await page.evaluate(() => window.__ui.closePanel('techs'));

  await page.evaluate(() => window.__ui.openPanel({ panel: 'ext', name: 'requests' }));
  await shot('requests');
  await page.evaluate(() => { [...document.querySelectorAll('.mu-tab')].find((el) => el.textContent.includes('Notices'))?.click(); });
  await shot('notices');
  await page.evaluate(() => window.__ui.closePanel('requests'));

  // a fire in the village
  await page.evaluate(() => { const s = window.__game.session; s.sim.services.happenings.trigger('fire', s.sim.state.persons.get(s.sim.state.run.playerId).settlement); window.__game.advance(0.3); });
  await page.evaluate(() => window.__game.settle());
  await page.evaluate(() => window.__game.draw());
  await shot('fire');

  console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no page errors');
} finally {
  await browser.close();
  if (vite) { try { process.kill(-vite.pid); } catch { /* already gone */ } }
}
process.exit(errors.length ? 1 : 0);
