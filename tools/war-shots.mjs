// War-in-the-zone screenshots for visual review (docs/WAR.md): a field battle with the player commanding (group bar, banners, the
// order wheel, the tactical view with orders on the ground), and a storm of a walled castle (archers on the wall-walk, the ram,
// ladders, the gate). Starts Vite on :5186, plays the scenes in headless Chromium (software GL: slow but correct) and writes
// docs/military/war-<name>.png. The REAL combat and military modules run; the scenes are set up through their APIs.
//
//   node tools/war-shots.mjs                    # everything
//   node tools/war-shots.mjs battle wheel       # selected shots
//   node tools/war-shots.mjs --seed=abc --size=1280x720 --quality=medium
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'docs/military');
const PORT = 5186;
const args = process.argv.slice(2);
const opt = (name, def) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : def; };
const quality = opt('quality', 'medium');
const seed = opt('seed', 'millennia');
const [W, H] = opt('size', '1280x720').split('x').map(Number);
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
page.on('console', (m) => { const t = m.text(); if (t.startsWith('war:')) console.log(t); if (m.type() === 'error' && !/GPU stall|ReadPixels|WebGL/.test(t)) console.log(`[browser error] ${t}`); });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
const base = `http://localhost:${PORT}/?seed=${encodeURIComponent(seed)}&quality=${quality}&shots=1`;

async function load(extra = 'autostart=1&time=0.42') {
  await page.goto(`${base}&${extra}`, { timeout: 120000 });
  await page.waitForFunction(() => window.__game !== undefined && window.__ui !== undefined, null, { timeout: 300000, polling: 250 });
  await page.evaluate(() => window.__game.ready());
  await page.evaluate(() => window.__game.freeze(true));
}
async function shot(name, { settle = true } = {}) {
  if (settle) await page.evaluate(() => window.__game.settle());
  await page.evaluate(() => window.__game.draw());
  const file = resolve(OUT, `war-${name}.png`);
  await page.screenshot({ path: file });
  console.log(`${name}: ${Math.round(statSync(file).size / 1024)} KB`);
}
const advance = (seconds, input = {}) => page.evaluate(([s, i]) => window.__game.advance(s, i), [seconds, input]);

async function prepare() {
  await page.evaluate(async () => {
    const g = window.__game; const s = g.session; const sim = s.sim; const mil = sim.services.military;
    const st = sim.state; const w = sim.world;
    const m = await import('/src/sim/military/index.ts');
    const M = m.militaryContext(sim);
    const player = () => st.persons.get(st.run.playerId);
    const passDays = (n) => { sim.dispatch({ type: 'setSpeed', speed: 8 }); g.advance((n * 60) / 8); sim.dispatch({ type: 'setSpeed', speed: 1 }); };
    window.__m = { g, s, sim, mil, M, st, w, player, passDays };
  });
}

/** A clear field (no trees or rocks near) not far from `x0, z0`. */
async function findField(x0, z0) {
  return page.evaluate(([x0, z0]) => {
    const { w, s } = window.__m;
    const zone = s.services.zone;
    const hit = [];
    const trees = (x, z) => { hit.length = 0; zone.interactables(x, z, 0, 16, hit); return hit.some((c) => /beech|oak|ash|birch|willow|pine|spruce|apple|rock|boulder|stump|log|tree|bush/i.test(c.label)); };
    for (let r = 300; r < 3500; r += 150) {
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        const x = x0 + Math.sin(a) * r, z = z0 + Math.cos(a) * r;
        if (x < 400 || z < 400 || x > 15600 || z > 15600) continue;
        if (w.settlements.some((q) => Math.hypot(q.x - x, q.z - z) < 420)) continue;
        const g = w.groundAt(x, z);
        if (g !== 0 && g !== 1 && g !== 2) continue;
        if (Math.abs(w.heightAt(x, z) - w.heightAt(x + 80, z)) > 2.2 || Math.abs(w.heightAt(x, z) - w.heightAt(x - 80, z)) > 2.2 || w.forestAt(x, z) > 0.2) continue;
        return { x, z };
      }
    }
    return { x: x0 + 400, z: z0 };
  }, [x0, z0]);
}

try {
  // ---------------------------------------------------------------------------------------------- a field battle, the player commanding
  if (want('battle', 'wheel', 'tactical', 'orders')) {
    await load();
    await prepare();
    const info = await page.evaluate(() => {
      const { mil, st, sim, M } = window.__m;
      const houses = [...st.houses.values()].filter((h) => (h.kind === 'noble' || h.kind === 'royal') && !h.extinct).sort((a, b) => mil.forces(b.id).strength - mil.forces(a.id).strength);
      const mine = houses[0], foe = houses.find((h) => h.id !== mine.id && !mil.hostile(mine.id, h.id) && M.realm.root(h.id) !== M.realm.root(mine.id)) ?? houses[1];
      // the player takes up the strongest House's lord
      sim.switchTo(mine.head);
      const p = st.persons.get(st.run.playerId);
      mil.declareFeud(mine.id, foe.id, 60, 'demo');
      for (const h of st.houses.values()) { M.data.think['r' + h.id] = sim.absDay + 99; M.data.think['d' + h.id] = sim.absDay + 99; }
      const call = mil.callLevy();
      const idB = mil.raiseArmy(foe.id, 'war', { vassals: true, fraction: 0.7 });
      mil.order(idB, { kind: 'hold' });
      window.__m.passDays(5);
      const idA = mil.armyOf(p.id);
      return { call, idA, idB, me: p.first, mine: mine.name, foe: foe.name, a: mil.armyDetail(idA)?.size, b: mil.armyDetail(idB)?.size, ax: mil.armyDetail(idA)?.x, az: mil.armyDetail(idA)?.z, level: mil.commandLevel() };
    });
    console.log('battle', JSON.stringify(info));
    const spot = await findField(info.ax, info.az);
    console.log('war: field', JSON.stringify(spot));
    await page.evaluate(([idA, idB, spot]) => {
      const { s, M, g, mil } = window.__m;
      const p = s.services.player;
      p.placeAt(spot.x, spot.z, Math.PI / 2);
      g.advance(0.3);
      const r = s.renderer; r.orbit(Math.atan2(Math.sin(Math.PI / 2 - r.getCameraYaw()), Math.cos(Math.PI / 2 - r.getCameraYaw())), 0);
      const A = M.army(idA), B = M.army(idB);
      A.x = spot.x; A.z = spot.z; A.px = A.x; A.pz = A.z;
      B.x = spot.x + 90; B.z = spot.z; B.px = B.x; B.pz = B.z;
      window.__m.passDays(0.1);
    }, [info.idA, info.idB, spot]);
    console.log('battles', JSON.stringify(await page.evaluate(() => window.__m.mil.battles())));
    console.log('war: groups', JSON.stringify(await page.evaluate(() => window.__m.mil.battleGroups('own').map((g) => [g.key, g.count, g.order]))));
    await advance(2.5);
    await shot('battle-start');
    await advance(10);
    await page.evaluate(() => { window.__m.s.renderer.zoom(1.2); });
    await advance(1);
    await shot('battle');
    if (want('wheel', 'orders')) {
      await page.keyboard.press('Digit5');
      await page.waitForTimeout(150);
      await page.keyboard.press('Digit8');
      await page.waitForTimeout(250);
      await shot('wheel', { settle: false });
      await page.keyboard.press('Digit2');
      await page.waitForTimeout(200);
      console.log('war: after hold', JSON.stringify(await page.evaluate(() => window.__m.mil.battleGroups('own').map((g) => [g.key, g.count, g.order]))));
    }
    if (want('tactical', 'orders')) {
      await page.keyboard.press('KeyC');
      await page.waitForTimeout(700);
      await advance(1.2);
      await shot('tactical', { settle: false });
      console.log('war: tactical open', await page.evaluate(() => window.__ui.isOpen('battle')), 'speed', await page.evaluate(() => window.__m.sim.view.clock().speed));
      await page.keyboard.press('KeyC');
      await page.waitForTimeout(400);
      console.log('war: tactical closed', !(await page.evaluate(() => window.__ui.isOpen('battle'))), 'speed', await page.evaluate(() => window.__m.sim.view.clock().speed));
    }
  }
} finally {
  await browser.close();
  if (vite) { try { process.kill(-vite.pid); } catch { /* gone */ } }
}
