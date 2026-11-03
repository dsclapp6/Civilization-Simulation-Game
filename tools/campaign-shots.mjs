// Screenshots of wave D1 (docs/WAR.md §11–13): the duel's reading on the HUD, the army campaign (the castle scenario: the companies card,
// the night camp before the walls), and the wall-walk (the player on a tower). Starts Vite on :5187, plays the scenes in headless
// Chromium (software GL) and writes docs/military/d1-<name>.png.
//
//   node tools/campaign-shots.mjs                 # everything
//   node tools/campaign-shots.mjs duel campaign   # selected shots   (duel campaign camp wall)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const log0 = console.log.bind(console);
console.log = (...a) => log0(new Date().toISOString().slice(11, 19), ...a);
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'docs/military');
const PORT = Number(process.env.PORT ?? 5187);
const args = process.argv.slice(2);
const opt = (name, def) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : def; };
const quality = opt('quality', 'low');
const seed = opt('seed', 'millennia');
const [W, H] = opt('size', '1280x720').split('x').map(Number);
const wanted = args.filter((a) => !a.startsWith('--'));
const want = (n) => wanted.length === 0 || wanted.includes(n);

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
if (!(await serverUp())) vite = await startVite();
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
let page = null;
async function freshPage() {
  if (page) { try { await page.close(); } catch { /* gone */ } }
  page = await browser.newPage({ viewport: { width: W, height: H } });
  page.setDefaultTimeout(0);
  page.on('console', (m) => { if (m.type() === 'error' && !/GPU stall|ReadPixels|WebGL/.test(m.text())) console.log(`[browser error] ${m.text()}`); });
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
}
const base = `http://localhost:${PORT}/?seed=${encodeURIComponent(seed)}&quality=${quality}&shots=1`;
async function load(extra) {
  await freshPage();
  await page.goto(`${base}&${extra}`, { timeout: 120000 });
  await page.waitForFunction(() => window.__game !== undefined && window.__ui !== undefined, null, { timeout: 300000, polling: 250 });
  await page.evaluate(() => window.__game.ready());
  await page.evaluate(() => window.__game.freeze(true));
  await page.addStyleTag({ content: '.mu-toasts, .mu-guide, .mu-feed, .mu-whatnow { display: none !important; }' });
  await page.evaluate(() => window.__game.host.setSettings({ labels: false }));
}
async function shot(name) {
  for (let i = 0; i < 5; i++) { await page.evaluate(() => window.__game.draw()); await page.waitForTimeout(60); }
  await page.evaluate(() => { const g = window.__game; g.draw(); g.tick(0.07); g.draw(); });
  const file = resolve(OUT, `d1-${name}.png`);
  await page.screenshot({ path: file });
  console.log(`${name}: ${Math.round(statSync(file).size / 1024)} KB`);
}

try {
  if (want('duel')) {
    await load('autostart=1&time=0.42');
    await page.evaluate(() => {
      const g = window.__game, s = g.session, sim = s.sim, st = sim.state;
      const pid = st.run.playerId, c = sim.services.combat;
      const foe = [...st.persons.values()].find((p) => !p.death && p.sex === 'm' && p.id !== pid && p.estate !== 'clergy' && (sim.absDay - p.birthDay) / 16 >= 18 && (sim.absDay - p.birthDay) / 16 <= 40);
      c.arena.setKitOverride(pid, { weapon: 'sword', shield: null, armour: ['padded_armour'] });
      c.arena.setKitOverride(foe.id, { weapon: 'sword', armour: [] });
      const b = s.services.player.body();
      c.engage([{ faction: 'player', people: [pid] }, { faction: 'bandits', people: [foe.id] }], { at: { x: b.x, z: b.z } });
      const f = c.arena.fighterOf(foe.id);
      f.x = b.x + Math.sin(b.yaw) * 2.2; f.z = b.z + Math.cos(b.yaw) * 2.2;
      s.services.player.setDrawn(true);
    });
    for (let i = 0; i < 12; i++) { await page.evaluate(() => window.__game.advance(0.25)); const t = await page.evaluate(() => !document.querySelector('.mu-duel')?.classList.contains('mu-hide') && document.querySelector('.mu-duel')?.textContent); if (i > 3 && t && /Blow|Guarded|Riposte/.test(t)) break; }
    await shot('duel');
  }
  if (want('campaign') || want('camp')) {
    // (the march itself is a skipped wait: the screen is dark with "On the march…"; the camp before the walls is the picture)
    await load('scenario=castle');
    // the march: the host sets out in the afternoon (the days pass on the road: a wait that ends at nightfall or at the walls)
    await page.evaluate(() => { const g = window.__game; g.tick(0.3); });
    {
      // run the world on until the host is camped before the walls for the night
      const phase = await page.evaluate(() => {
        const g = window.__game;
        const seen = [];
        for (let i = 0; i < 400; i++) { g.tick(1); if (i < 12) seen.push(g.session.services.campaign?.phase() + '@' + (g.session.sim.absDay % 1 * 24).toFixed(1) + (g.session.sim.clock.skip ? 's' : '')); if (g.session.sim.clock.skip) continue; const p = g.session.services.campaign?.phase(); if (p === 'before' || p === 'camp') return p; }
        return seen.join(' ') + ' => ' + (g.session.services.campaign?.phase() ?? 'none');
      });
      console.log('camp phase:', phase);
      await page.evaluate(() => window.__game.tick(1.0));
      await shot('campaign-camp');
    }
  }
  if (want('wall')) {
    await load('autostart=1&time=0.42');
    // a castle with walls: stand the player at the foot of a flight of stairs, climb, and look along the walk
    const info = await page.evaluate(() => {
      const g = window.__game, s = g.session, sim = s.sim;
      const nav = s.services.zone.nav;
      const castles = sim.world.settlements.filter((x) => x.kind === 'castle');
      for (const c of castles) {
        nav.prepare(c.x, c.z);
        if (!nav.walls.anyNear(c.x, c.z, 90)) continue;
        // find a flight of stairs near the castle
        for (let r = 10; r < 90; r += 6) for (let a = 0; a < 16; a++) {
          const x = c.x + Math.cos(a) * r, z = c.z + Math.sin(a) * r;
          const st = nav.walls.stairFootNear(x, z, 6);
          if (st) {
            s.services.player.placeAt(st.top.x, st.top.z, st.yaw + Math.PI, st.y);
            s.renderer.focusMap?.(st.top.x, st.top.z, 0);
            return { castle: c.name, at: [Math.round(st.top.x), Math.round(st.top.z)], y: Math.round(st.y), body: s.services.player.body() };
          }
        }
      }
      return null;
    });
    console.log('wall:', JSON.stringify(info));
    if (info) {
      await page.evaluate(() => {
        const s = window.__game.session; window.__game.advance(0.5);
        // from outside and above, looking along the wall at the player on the walk
        const b = s.services.player.body();
        // high above and a little back, looking down: the walk, the parapet and the ground far below
        s.controls.setCameraPose({ x: b.x - Math.sin(b.yaw) * 3.5, y: b.y + 8, z: b.z - Math.cos(b.yaw) * 3.5 }, { x: b.x, y: b.y + 0.5, z: b.z }, 0);
      });
      await shot('wall-walk');
    }
  }
} finally {
  await browser.close();
  if (vite) { try { process.kill(-vite.pid); } catch { /* gone */ } }
}
