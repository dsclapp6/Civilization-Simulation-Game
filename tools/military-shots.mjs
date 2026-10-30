// Military screenshots for visual review: a muster at a castle, an army marching on the map, a battle line the
// player joins, a siege, and the command panel. Starts Vite on :5179, plays scripted situations in headless
// Chromium (software GL: slow but correct) and writes docs/military/<name>.png.
//
//   node tools/military-shots.mjs                    # everything
//   node tools/military-shots.mjs muster march       # selected shots
//   node tools/military-shots.mjs --seed=abc --size=1280x720 --quality=medium
//
// There is no war without the politics module, so the scenes start by hand through the military API on
// `window.__game.session.sim.services.military` (raise an army, declare a feud, give orders). The battle shot
// uses a stand-in combat module that only lines the two sides up (the real fight is the combat module's).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'docs/military');
const PORT = 5179;
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
page.on('console', (m) => { const t = m.text(); if (t.startsWith('battle spot')) console.log(t); if (m.type() === 'error' && !/GPU stall|ReadPixels|WebGL/.test(t)) console.log(`[browser error] ${t}`); });
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
  const file = resolve(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`${name}: ${Math.round(statSync(file).size / 1024)} KB`);
}
const advance = (seconds, input = {}) => page.evaluate(([s, i]) => window.__game.advance(s, i), [seconds, input]);

/** Common set-up inside the page: handy handles on window.__m. */
async function prepare() {
  await page.evaluate(() => {
    const g = window.__game; const s = g.session; const sim = s.sim; const mil = sim.services.military;
    const st = sim.state; const w = sim.world;
    const player = () => st.persons.get(st.run.playerId);
    const strongest = (exclude = []) => {
      let best = null, bs = -1;
      for (const h of st.houses.values()) {
        if ((h.kind !== 'noble' && h.kind !== 'royal') || h.extinct || exclude.includes(h.id)) continue;
        const f = mil.forces(h.id);
        if (f.strength > bs) { bs = f.strength; best = h.id; }
      }
      return best;
    };
    // the calendar moves with the frames (a saver may hold the hooks back in tight loops): 8x speed, simulated seconds
    const passDays = (n) => { sim.dispatch({ type: 'setSpeed', speed: 8 }); g.advance((n * 60) / 8); sim.dispatch({ type: 'setSpeed', speed: 1 }); };
    window.__m = { g, s, sim, mil, st, w, player, strongest, passDays };
  });
}

/** Stand `distance` metres outside the castle's gate (or south of the place), looking in, camera behind the player. */
async function standNear(settlementId, distance, zoom = 0) {
  await page.evaluate(([sid, d, zoomBy]) => {
    const { s, w } = window.__m; const p = s.services.player; const nav = s.services.zone.nav;
    const st = w.settlements.find((q) => q.id === sid);
    const gate = (st.gates && st.gates[0]) ?? { x: st.x, z: st.z + (st.radius ?? 60) };
    let ox = gate.x - st.x, oz = gate.z - st.z; const ol = Math.hypot(ox, oz) || 1; ox /= ol; oz /= ol;
    let best = null;
    for (let k = 0; k < 24 && !best; k++) {
      const a = Math.atan2(ox, oz) + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.22;
      const tx = gate.x + Math.sin(a) * d, tz = gate.z + Math.cos(a) * d;
      const out = { x: 0, z: 0 };
      if (nav.walkable(tx, tz)) best = { x: tx, z: tz };
      else if (nav.nearestWalkable(tx, tz, 14, out)) best = { x: out.x, z: out.z };
    }
    best = best ?? { x: gate.x + ox * d, z: gate.z + oz * d };
    const yaw = Math.atan2(gate.x - best.x, gate.z - best.z);
    p.placeAt(best.x, best.z, yaw);
    const r = s.renderer; const dd = Math.atan2(Math.sin(yaw - r.getCameraYaw()), Math.cos(yaw - r.getCameraYaw()));
    r.orbit(dd, 0);
    if (zoomBy) r.zoom(zoomBy);
  }, [settlementId, distance, zoom]);
}

try {
  // ------------------------------------------------------------------------------------------ muster
  if (want('muster', 'siege', 'battle', 'march', 'panel')) {
    await load();
    await prepare();
  }

  if (want('muster')) {
    const info = await page.evaluate(() => {
      const { mil, w, player, strongest } = window.__m;
      const p = player();
      const home = w.settlements.find((x) => x.id === p.settlement);
      const castle = w.settlements.filter((x) => x.kind === 'castle' && x.kingdom === home.kingdom)[0] ?? w.settlements.find((x) => x.kind === 'castle');
      const house = mil.lordHouse(castle.id) || strongest();
      const id = mil.raiseArmy(house, 'war', { at: castle.id, vassals: true });
      mil.order(id, { kind: 'hold' });
      const a = mil.armyDetail(id);
      return { castle: { id: castle.id, x: castle.x, z: castle.z, name: castle.name }, id, size: a.size, house: a.houseName };
    });
    console.log('muster', JSON.stringify(info));
    await standNear(info.castle.id, 44, 0.8);
    await advance(14);
    await shot('muster');
  }

  // ------------------------------------------------------------------------------------------ march on the map
  if (want('march')) {
    await load();
    await prepare();
    const info = await page.evaluate(() => {
      const { mil, w, st, sim } = window.__m;
      const out = [];
      // three Houses raise hosts and march on different roads
      const houses = [...st.houses.values()].filter((h) => (h.kind === 'royal' || h.kind === 'noble') && !h.extinct).sort((a, b) => mil.forces(b.id).strength - mil.forces(a.id).strength).slice(0, 4);
      for (const h of houses) {
        const id = mil.raiseArmy(h.id, 'war', { vassals: true });
        if (!id) continue;
        const a = mil.armyDetail(id);
        const dest = w.settlements.filter((s) => s.kind !== 'abbey' && Math.hypot(s.x - a.x, s.z - a.z) > 2200 && Math.hypot(s.x - a.x, s.z - a.z) < 5200).sort((u, v) => v.population - u.population)[0];
        if (dest) { mil.order(id, { kind: 'march', x: dest.x, z: dest.z, settlement: dest.id }); out.push({ id, to: dest.name, size: a.size }); }
      }
      window.__m.passDays(6);
      return out.map((o) => ({ ...o, at: mil.armies().find((x) => x.id === o.id) })).map((o) => ({ id: o.id, to: o.to, size: o.size, x: Math.round(o.at?.x ?? 0), z: Math.round(o.at?.z ?? 0), task: o.at?.task }));
    });
    console.log('march', JSON.stringify(info));
    const focus = info.find((i) => i.task === 'march') ?? info[0];
    if (focus) {
      await page.evaluate(([x, z]) => {
        const { s } = window.__m;
        window.__ui.openPanel({ panel: 'map' });
        s.controls.focusMap(x, z, 3600);
      }, [focus.x, focus.z]);
      await advance(0.1);
      await page.waitForTimeout(700);
      await shot('march');
      await page.evaluate(() => window.__ui.closePanel('map'));
    }
  }

  // ------------------------------------------------------------------------------------------ battle line
  if (want('battle')) {
    await load();
    await prepare();
    const info = await page.evaluate(() => {
      const { mil, st, sim, s, player } = window.__m;
      // a stand-in for the combat module: it only brings the two lines to face one another
      const zone = s.services.zone;
      let nextId = 1;
      const fights = [];
      sim.services.combat = {
        engage(sides, opts) {
          const id = nextId++;
          const at = opts?.at ?? { x: 0, z: 0 };
          sides.forEach((side, k) => {
            side.people.slice(0, 40).forEach((pid, i) => {
              if (pid === st.run.playerId) return;
              const row = Math.floor(i / 8), col = i % 8;
              const x = k === 0 ? at.x - 2.5 - row * 2.2 : at.x + 13 + row * 2.2, z = at.z + (col - 3.5) * (k === 0 ? 2.8 : 2.1);
              zone.summon?.(pid, x + (k === 0 ? -12 : 14), z, k === 0 ? Math.PI / 2 : -Math.PI / 2);
              zone.command(pid, { kind: 'goto', x, z, run: true });
            });
          });
          fights.push(id);
          return id;
        },
        isFighting: () => true, harm: () => 'unhurt', wounds: () => [], onFightEnded: () => () => undefined,
      };
      const kings = [...st.houses.values()].filter((h) => (h.kind === 'noble' || h.kind === 'royal') && !h.extinct).sort((a, b) => mil.forces(b.id).strength - mil.forces(a.id).strength);
      const mine = kings[0].id, foe = kings.find((h) => !mil.hostile(mine, h.id) && h.id !== mine).id;
      mil.declareFeud(mine, foe, 40, 'demo');
      const idA = mil.raiseArmy(mine, 'war', { vassals: true, fraction: 0.6 });
      const idB = mil.raiseArmy(foe, 'war', { vassals: true, fraction: 0.6 });
      mil.order(idA, { kind: 'hold' }); mil.order(idB, { kind: 'hold' });
      // the player has joined the first army as a sergeant
      const p = player(); p.sex = 'm'; p.birthDay = Math.round(sim.absDay - 26 * 16); p.career = 'sergeant'; p.careerStage = 2; p.rankTier = 3; st.touch(p);
      window.__m.passDays(5);
      const r = mil.joinArmy(idA);
      const A = mil.armyDetail(idA), B = mil.armyDetail(idB);
      return { r, a: A.size, b: B.size, ax: A.x, az: A.z, nameA: A.houseName, nameB: B.houseName, idA, idB };
    });
    console.log('battle', JSON.stringify(info));
    // the armies meet on open meadow well away from any settlement; the player stands in his own line facing the foe
    await page.evaluate(async ([idA, idB, x0, z0]) => {
      const m = await import('/src/sim/military/index.ts');
      const { w, s, sim } = window.__m;
      const M = m.militaryContext(sim);
      let spot = null;
      for (let r = 300; r < 3000 && !spot; r += 150) {
        for (let k = 0; k < 24 && !spot; k++) {
          const a = (k / 24) * Math.PI * 2;
          const x = x0 + Math.sin(a) * r, z = z0 + Math.cos(a) * r;
          if (x < 200 || z < 200 || x > 15800 || z > 15800) continue;
          if (w.settlements.some((q) => Math.hypot(q.x - x, q.z - z) < 380)) continue;
          const g = w.groundAt(x, z);
          if (g !== 0 && g !== 1 && g !== 2) continue;
          if (Math.abs(w.heightAt(x, z) - w.heightAt(x + 60, z)) > 2.5 || w.forestAt(x, z) > 0.25) continue;
          // no tree or rock within 30 m (a clear field to fight on)
          const cx = Math.floor(x / 64), cz = Math.floor(z / 64);
          let clear = true;
          for (let i = -1; i <= 1 && clear; i++) for (let j = -1; j <= 1 && clear; j++) {
            for (const it of w.scatterInChunk(cx + i, cz + j)) {
              if (/oak|beech|birch|ash|willow|pine|spruce|apple|rock|boulder|stump|log/.test(it.kind) && Math.hypot(it.x - x, it.z - z) < 24) { clear = false; break; }
            }
          }
          if (!clear) continue;
          spot = { x, z };
        }
      }
      console.log('battle spot', JSON.stringify(spot));
      spot = spot ?? { x: x0 + 400, z: z0 };
      // the interaction scan knows every tree and rock: nudge the spot until none is within 16 m of the lines
      const zone = s.services.zone; const hit = [];
      const trees = (x, z) => { hit.length = 0; zone.interactables(x, z, 0, 16, hit); return hit.some((c) => /beech|oak|ash|birch|willow|pine|spruce|apple|rock|boulder|stump|log|tree|bush/i.test(c.label)); };
      const p = s.services.player;
      p.placeAt(spot.x, spot.z, Math.PI / 2);
      sim.advanceHours(0); window.__m.g.advance(0.2);
      for (let k = 0; k < 60 && (trees(spot.x, spot.z) || trees(spot.x + 12, spot.z) || trees(spot.x + 26, spot.z)); k++) {
        const ang = k * 2.4, rad = 6 + k * 3;
        spot = { x: spot.x + Math.sin(ang) * rad * 0.3, z: spot.z + Math.cos(ang) * rad * 0.3 };
        p.placeAt(spot.x, spot.z, Math.PI / 2);
        window.__m.g.advance(0.15);
      }
      const A = M.army(idA), B = M.army(idB);
      A.x = spot.x; A.z = spot.z; A.px = A.x; A.pz = A.z;
      B.x = spot.x + 70; B.z = spot.z; B.px = B.x; B.pz = B.z;
      const r = s.renderer; r.orbit(Math.atan2(Math.sin(Math.PI / 2 - r.getCameraYaw()), Math.cos(Math.PI / 2 - r.getCameraYaw())), 0);
      window.__m.passDays(0.08);
    }, [info.idA, info.idB, info.ax, info.az]);
    const open = await page.evaluate(() => window.__m.sim.services.military.battles());
    console.log('battles', JSON.stringify(open));
    await advance(9);
    await page.evaluate(() => { const r = window.__game.session.renderer; r.zoom(1.8); r.orbit(-0.25, 0.1); });
    await advance(1);
    await shot('battle');
    await page.evaluate(() => { window.__ui.openPanel({ panel: 'ext', name: 'army' }); });
    await page.waitForTimeout(500);
    await shot('panel-battle', { settle: false });
    await page.evaluate(() => window.__ui.closePanel('army'));
  }

  // ------------------------------------------------------------------------------------------ siege
  if (want('siege')) {
    await load();
    await prepare();
    const info = await page.evaluate(async () => {
      const { mil, st, w, sim } = window.__m;
      const m = await import('/src/sim/military/index.ts');
      const M = m.militaryContext(sim);
      sim.services.advancement = { knows: () => true, houseHas: (_h, t) => t === 'trebuchet' };
      const castle = w.settlements.filter((s) => s.kind === 'castle')[0];
      const lord = mil.lordHouse(castle.id);
      // the strongest House of another realm besieges it
      let att = 0, bs = -1;
      for (const h of st.houses.values()) {
        if ((h.kind !== 'noble' && h.kind !== 'royal') || h.extinct || M.realm.root(h.id) === M.realm.root(lord)) continue;
        const f = mil.forces(h.id).strength; if (f > bs) { bs = f; att = h.id; }
      }
      mil.declareFeud(att, lord, 60, 'demo');
      const id = mil.raiseArmy(att, 'war', { vassals: true });
      mil.order(id, { kind: 'hold' });
      window.__m.passDays(5);
      const A = mil.armyDetail(id);
      return { id, castle: { id: castle.id, x: castle.x, z: castle.z, name: castle.name }, size: A.size, lord: A.houseName };
    });
    console.log('siege', JSON.stringify(info));
    await page.evaluate(async ([id, cx, cz, castleId]) => {
      const m = await import('/src/sim/military/index.ts');
      const M = m.militaryContext(window.__m.sim);
      // camp a few hundred metres from the walls and sit down before them
      // no relief army comes for this scene
      for (const h of window.__m.st.houses.values()) M.data.think['d' + h.id] = window.__m.sim.absDay + 99;
      const A = M.army(id); A.x = cx - 380; A.z = cz + 60; A.px = A.x; A.pz = A.z;
      A.supplies = A.men.length * 40;
      window.__m.mil.order(id, { kind: 'siege', settlement: window.__m.sim.services.military.armies().length ? castleId : castleId });
      // a patient siege: no storm for this scene, the engines and hunger do their work
      for (let i = 0; i < 12; i++) {
        window.__m.passDays(0.15);
        const rec = M.sieges.recOf(castleId);
        if (rec) { rec.lastAssault = window.__m.sim.absDay + 60; break; }
      }
      window.__m.passDays(5);
    }, [info.id, info.castle.x, info.castle.z, info.castle.id]);
    console.log('armies', JSON.stringify(await page.evaluate(() => window.__m.sim.services.military.armies().map((a) => [a.id, a.task, Math.round(a.x), Math.round(a.z), a.target]))));
    console.log('chronicle', JSON.stringify(await page.evaluate(() => window.__m.sim.state.chronicle.slice(-6).map((c) => c.text))));
    const sv = await page.evaluate((cid) => window.__m.sim.services.military.siegeAt(cid), info.castle.id);
    console.log('siege state', JSON.stringify(sv));
    // stand between the camp and the walls, looking at the keep
    const camp = await page.evaluate((id) => { const a = window.__m.sim.services.military.armies().find((x) => x.id === id); return a ? { x: a.x, z: a.z } : null; }, info.id);
    if (camp) {
      // afternoon light for the picture
      await page.evaluate(() => { const c = window.__m.sim.clock; const d = Math.floor(c.absDay); const t = c.absDay - d; c.state.absDay = d + (t > 0.3 ? 1 : 0) + 0.3; });
      await advance(1);
      // stand a little behind the camp, looking over it at the walls
      await page.evaluate(([cx, cz, kx, kz]) => {
        const { s } = window.__m; const p = s.services.player; const nav = s.services.zone.nav;
        let dx = kx - cx, dz = kz - cz; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
        let x = kx + dx * 34, z = kz + dz * 34; const out = { x: 0, z: 0 };
        if (!nav.walkable(x, z) && nav.nearestWalkable(x, z, 20, out)) { x = out.x; z = out.z; }
        const yaw = Math.atan2(cx - x, cz - z);
        p.placeAt(x, z, yaw);
        const r = s.renderer; r.orbit(Math.atan2(Math.sin(yaw - r.getCameraYaw()), Math.cos(yaw - r.getCameraYaw())), 0.12); r.zoom(1.2);
      }, [info.castle.x, info.castle.z, camp.x, camp.z]);
      await advance(12);
      await shot('siege');
      // the map with the siege marker
      await page.evaluate(([x, z]) => { const { s } = window.__m; window.__ui.openPanel({ panel: 'map' }); s.controls.focusMap(x, z, 2600); }, [info.castle.x, info.castle.z]);
      await advance(0.1);
      await page.waitForTimeout(600);
      await shot('siege-map');
      await page.evaluate(() => window.__ui.closePanel('map'));
      await page.evaluate(() => { window.__ui.openPanel({ panel: 'ext', name: 'army', data: { tab: 'armies' } }); });
      await page.waitForTimeout(500);
      await shot('panel-armies', { settle: false });
      await page.evaluate(() => window.__ui.closePanel('army'));
    }
  }

  // ------------------------------------------------------------------------------------------ the command panel
  if (want('panel')) {
    await load();
    await prepare();
    await page.evaluate(() => {
      const { mil, st, player, sim } = window.__m;
      const p = player();
      // the lord of the player's village calls the levy: the player is a man of the right age
      p.sex = 'm'; p.birthDay = Math.round(sim.absDay - 24 * 16); st.touch(p);
      const lord = mil.lordHouse(p.settlement);
      if (lord) mil.raiseArmy(lord, 'war', { fraction: 1, vassals: true });
    });
    await advance(0.2);
    await page.waitForTimeout(500);
    await shot('panel-call', { settle: false });
    await page.evaluate(() => {
      const { mil, st, player, sim } = window.__m;
      mil.answerCall(true);
      const p = player(); p.career = 'sergeant'; p.careerStage = 2; p.rankTier = 3; st.touch(p);
      sim.services.military.service();
      window.__ui.closePanel('army');
      window.__ui.openPanel({ panel: 'ext', name: 'army' });
    });
    await page.waitForTimeout(600);
    await shot('panel-command', { settle: false });
    await page.evaluate(() => { window.__ui.closePanel('army'); window.__ui.openPanel({ panel: 'ext', name: 'army', data: { tab: 'forces' } }); });
    await page.waitForTimeout(500);
    await shot('panel-forces', { settle: false });
  }
} finally {
  await browser.close();
  if (vite) { try { process.kill(-vite.pid, 'SIGTERM'); } catch { vite.kill('SIGTERM'); } }
}
