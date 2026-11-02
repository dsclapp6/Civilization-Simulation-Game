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
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// every line of the log carries the time, so it can be set beside the machine's memory when the browser is killed
const log0 = console.log.bind(console);
console.log = (...a) => log0(new Date().toISOString().slice(11, 19), ...a);

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
let page = null;
/** A fresh page for each scene (a scene that crashes the tab does not take the next one with it). */
async function freshPage() {
  if (page) { try { await page.close(); } catch { /* already gone */ } }
  page = await browser.newPage({ viewport: { width: W, height: H } });
  page.setDefaultTimeout(0);
  page.on('console', (m) => { const t = m.text(); if (t.startsWith('war:')) console.log(t); if (m.type() === 'error' && !/GPU stall|ReadPixels|WebGL/.test(t)) console.log(`[browser error] ${t}`); });
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  page.on('crash', () => console.log('[page crashed]'));
}
const men = opt('men', '32');
const base = `http://localhost:${PORT}/?seed=${encodeURIComponent(seed)}&quality=${quality}&shots=1&men=${men}`;

async function load(extra = 'autostart=1&time=0.42') {
  await freshPage();
  await page.goto(`${base}&${extra}`, { timeout: 120000 });
  await page.waitForFunction(() => window.__game !== undefined && window.__ui !== undefined, null, { timeout: 300000, polling: 250 });
  await page.evaluate(() => window.__game.ready());
  await page.evaluate(() => window.__game.freeze(true));
  // the first-minutes guide, the toasts and the message feed would cover the scene
  await page.addStyleTag({ content: '.mu-toasts, .mu-guide, .mu-feed, .mu-whatnow { display: none !important; }' });
  // nameplates over every head cost the renderer dearly in a crowd; the picture is clearer without them
  if (!process.env.WAR_LABELS) await page.evaluate(() => window.__game.host.setSettings({ labels: false }));
}
/** Afternoon light (the calendar day stays where it is). */
const afternoon = () => page.evaluate(() => { const c = window.__m.sim.clock; const d = Math.floor(c.absDay); const t = c.absDay - d; c.state.absDay = d + (t > 0.45 ? 1 : 0) + 0.45; });
async function shot(name, { settle = true } = {}) {
  if (process.env.WAR_DEBUG) console.log('war: shot', name, 'begins');
  // the renderer's own settle() builds everything in view in one blocking call, which on a shared box with little memory to spare can
  // take the tab down; drawing frames lets it stream within its usual budget, with a pause for the garbage collector between them
  if (settle === 'full') await page.evaluate(() => window.__game.settle());
  else if (settle) for (let i = 0; i < 5; i++) { const t0 = Date.now(); await page.evaluate(() => window.__game.draw()); if (process.env.WAR_DEBUG) console.log('war: draw', i, Date.now() - t0, 'ms'); await page.waitForTimeout(60); }
  if (process.env.WAR_DEBUG) console.log('war: shot', name, 'streamed');
  // the HUD is the UI's frame: draw (the camera moves), let the UI update from that camera (banners are projected), draw again
  await page.evaluate(() => { const g = window.__game; g.draw(); g.tick(0.07); g.draw(); });
  const file = resolve(OUT, `war-${name}.png`);
  await page.screenshot({ path: file });
  console.log(`${name}: ${Math.round(statSync(file).size / 1024)} KB`);
}
const advance = async (seconds, input = {}) => {
  const t0 = Date.now();
  await page.evaluate(([s, i]) => window.__game.advance(s, i), [seconds, input]);
  if (process.env.WAR_DEBUG) console.log(`war: advance ${seconds}s took ${Date.now() - t0} ms, heap ${await page.evaluate(() => Math.round(performance.memory.usedJSHeapSize / 1e6))} MB`);
};

async function prepare() {
  await page.evaluate(async () => {
    const g = window.__game; const s = g.session; const sim = s.sim; const mil = sim.services.military;
    const st = sim.state; const w = sim.world;
    const m = await import('/src/sim/military/index.ts');
    const M = m.militaryContext(sim);
    const player = () => st.persons.get(st.run.playerId);
    // the calendar moves with the frames (a saver may hold the hooks back in tight loops): 8x speed, a day is 75 s of it
    const passHours = (n) => { sim.dispatch({ type: 'setSpeed', speed: 8 }); g.advance((n * 600) / 24 / 8 + 0.15); sim.dispatch({ type: 'setSpeed', speed: 1 }); };
    // a smaller line in the detail fight: the renderer builds every man of it at the first frame, and on a shared box that is what runs it out of memory
    const { CFG } = await import('/src/sim/military/config.ts');
    CFG.detailMax = Number(new URLSearchParams(location.search).get('men') ?? 32);
    window.__m = { g, s, sim, mil, M, st, w, player, passHours };
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

/**
 * Chromium is the first thing the kernel kills when the machine's memory runs short (a shared build box with several builders): wait for
 * room before a scene starts, so a scene is not lost half way. Reads the memory cgroup this process lives in; absent = no waiting.
 */
async function waitForRoom(limitMB = Number(process.env.WAR_ROOM_MB ?? 8200), maxMinutes = 25) {
  let dir = null;
  try {
    const line = readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((l) => /:memory:/.test(l));
    if (line) dir = `/sys/fs/cgroup/memory${line.split(':')[2]}`;
  } catch { return; }
  if (!dir) return;
  const used = () => { try { return Number(readFileSync(`${dir}/memory.usage_in_bytes`, 'utf8')) / 1048576; } catch { return 0; } };
  const t0 = Date.now();
  while (used() > limitMB && Date.now() - t0 < maxMinutes * 60000) await new Promise((r) => setTimeout(r, 15000));
  console.log(`war: memory in use ${Math.round(used())} MB (waited ${Math.round((Date.now() - t0) / 1000)} s)`);
}

// memory probe: the page idle and frozen, then with a battle running; prints the JS heap every 20 s (the process memory is watched from outside)
async function idleScene(battle) {
  await load();
  await prepare();
  const heap = () => page.evaluate(() => Math.round(performance.memory.usedJSHeapSize / 1e6));
  console.log('war: idle heap', await heap());
  for (let i = 0; i < 4; i++) { await page.waitForTimeout(20000); console.log('war: idle heap', await heap()); }
  if (battle) {
    await page.evaluate(() => { const { mil, st, sim, M } = window.__m; const houses = [...st.houses.values()].filter((h) => (h.kind === 'noble' || h.kind === 'royal') && !h.extinct).sort((a, b) => mil.forces(b.id).strength - mil.forces(a.id).strength); sim.switchTo(houses[0].head); mil.callLevy(); });
    for (let i = 0; i < 4; i++) { await page.waitForTimeout(20000); console.log('war: after levy heap', await heap()); }
  }
}

// memory probe 2: the player stands at the battle field, nothing else (is it the place or the men that costs the memory?)
async function placeScene() {
  await load();
  await prepare();
  const b = await page.evaluate(() => { const p = window.__m.s.services.player.body(); return { x: p.x, z: p.z }; });
  const spot = await findField(b.x + 600, b.z + 600);
  console.log('war: place spot', JSON.stringify(spot));
  await page.evaluate((spot) => { window.__m.s.services.player.placeAt(spot.x, spot.z, 0); window.__game.advance(0.5); }, spot);
  await page.waitForTimeout(8000);
  for (let i = 0; i < 6; i++) { await page.evaluate(() => window.__game.draw()); console.log('war: drew', i); await page.waitForTimeout(3000); }
  await shot('probe', { settle: false });
  await page.waitForTimeout(8000);
}

/** A scene that fails (the tab crashed, a hook missing) is tried again from a fresh page, then reported; the next scene still runs. */
async function scene(name, fn, tries = 6) {
  for (let i = 1; i <= tries; i++) {
    await waitForRoom();
    try { await fn(); return; } catch (e) { console.log(`war: scene ${name} failed (try ${i}/${tries}): ${e && e.message ? String(e.message).split('\n')[0] : e}`); }
  }
}

try {
  if (want('place')) await placeScene();
  if (want('idle')) await idleScene(false);
  if (want('idlelevy')) await idleScene(true);
  // ---------------------------------------------------------------------------------------------- a field battle, the player commanding
  if (want('battle', 'wheel', 'tactical', 'orders')) await scene('battle', async () => {
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
      const idA = mil.armyOf(p.id);
      // both hosts are gathered: the muster is over
      M.army(idA).readyDay = M.day - 1; M.army(idB).readyDay = M.day - 1;
      window.__m.passHours(2);
      mil.order(idA, { kind: 'hold' });
      return { call, idA, idB, me: p.first, mine: mine.name, foe: foe.name, a: mil.armyDetail(idA)?.size, b: mil.armyDetail(idB)?.size, ax: mil.armyDetail(idA)?.x, az: mil.armyDetail(idA)?.z, level: mil.commandLevel() };
    });
    console.log('battle', JSON.stringify(info));
    const spot = await findField(info.ax, info.az);
    console.log('war: field', JSON.stringify(spot));
    await page.evaluate(([idA, idB, spot]) => {
      const { s, M, g, mil, sim } = window.__m;
      const p = s.services.player;
      p.placeAt(spot.x, spot.z, Math.PI / 2);
      g.advance(0.3);
      const r = s.renderer; r.orbit(Math.atan2(Math.sin(Math.PI / 2 - r.getCameraYaw()), Math.cos(Math.PI / 2 - r.getCameraYaw())), 0);
      const A = M.army(idA), B = M.army(idB);
      A.x = spot.x; A.z = spot.z; A.px = A.x; A.pz = A.z;
      B.x = spot.x + 90; B.z = spot.z; B.px = B.x; B.pz = B.z;
      window.__m.passHours(2);
    }, [info.idA, info.idB, spot]);
    console.log('war: armies', JSON.stringify(await page.evaluate(() => window.__m.mil.armies().map((a) => [a.id, a.task, Object.values(a.troops).reduce((u, v) => u + v, 0), Math.round(a.x), Math.round(a.z)]))));
    console.log('war: battles', JSON.stringify(await page.evaluate(() => window.__m.mil.battles())));
    console.log('war: groups', JSON.stringify(await page.evaluate(() => window.__m.mil.battleGroups('own').map((g) => [g.key, g.count, g.order]))));
    await afternoon();
    // behind the player and above, so both lines show
    await page.evaluate(() => { const r = window.__m.s.renderer; r.zoom(5); r.orbit(0, 0.12); });
    await advance(2.5);
    await shot('battle');
    console.log('war: projection', JSON.stringify(await page.evaluate(() => {
      const { mil, s } = window.__m; const b = s.services.player.body(); const cam = s.renderer.getCamera(); const r = s.controls;
      const d = cam.getWorldDirection(new cam.position.constructor());
      const row = (g) => { const hy = window.__m.w.heightAt(g.x, g.z); const p = r.project(g.x, hy + 4.2, g.z); return [g.key, Math.round(g.x), Math.round(g.z), Math.round(hy), p ? [Math.round(p.x), Math.round(p.y)] : null]; };
      const pb = r.project(b.x, b.y + 1.5, b.z);
      return { cam: [cam.position.x, cam.position.y, cam.position.z].map(Math.round), dir: [d.x, d.y, d.z].map((v) => +v.toFixed(2)), yaw: +s.renderer.getCameraYaw().toFixed(2), body: [Math.round(b.x), Math.round(b.y), Math.round(b.z), +b.yaw.toFixed(2), Math.round(window.__m.w.heightAt(b.x, b.z))], bodyScreen: pb ? [Math.round(pb.x), Math.round(pb.y)] : null, own: mil.battleGroups('own').map(row), enemy: mil.battleGroups('enemy').map(row), win: [innerWidth, innerHeight] };
    })));
    console.log('war: banners', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.mu-bt-banner')].map((e) => [e.textContent, e.style.display, e.style.left, e.style.top, e.style.getPropertyValue('--lift')]))));
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
      await page.waitForTimeout(2600);
      await advance(0.6);
      await shot('tactical', { settle: 'full' });
      console.log('war: tactical open', await page.evaluate(() => window.__ui.isOpen('battle')), 'speed', await page.evaluate(() => window.__m.sim.view.clock().speed));
      await page.keyboard.press('KeyC');
      await page.waitForTimeout(400);
      console.log('war: tactical closed', !(await page.evaluate(() => window.__ui.isOpen('battle'))), 'speed', await page.evaluate(() => window.__m.sim.view.clock().speed));
    }
  });

  // ---------------------------------------------------------------------------------------------- a storm of a walled castle
  // 'assault': the player commands the besiegers (ram, ladders, the wall defended); 'defend': he is the lord inside.
  for (const role of ['assault', 'defend']) await scene(`storm-${role}`, async () => {
    if (!want('storm', role)) return;
    await load();
    await prepare();
    const info = await page.evaluate(([role]) => {
      const { mil, st, sim, M, w, passHours } = window.__m;
      const has = (s, k) => (st.buildingsAt.get(s.id) ?? []).some((b) => b.kind === k && b.construction >= 1);
      const castle = w.settlements.find((s) => s.kind === 'castle' && has(s, 'wall') && has(s, 'tower') && has(s, 'gatehouse'));
      const lord = mil.lordHouse(castle.id);
      let att = 0, bs = -1;
      for (const h of st.houses.values()) {
        if ((h.kind !== 'noble' && h.kind !== 'royal') || h.extinct || M.realm.root(h.id) === M.realm.root(lord)) continue;
        const f = mil.forces(h.id).strength; if (f > bs) { bs = f; att = h.id; }
      }
      for (const h of st.houses.values()) { M.data.think['r' + h.id] = sim.absDay + 99; M.data.think['d' + h.id] = sim.absDay + 99; }
      mil.declareFeud(att, lord, 60, 'demo');
      M.realm.invalidateEnmity();
      const id = mil.raiseArmy(att, 'war', { vassals: true });
      mil.order(id, { kind: 'hold' });
      M.army(id).readyDay = M.day - 1;
      passHours(2);
      const A = M.army(id);
      const gate = (st.buildingsAt.get(castle.id) ?? []).find((b) => b.kind === 'gatehouse');
      let ox = gate.x - castle.x, oz = gate.z - castle.z; const ol = Math.hypot(ox, oz) || 1; ox /= ol; oz /= ol;
      A.x = gate.x + ox * 75; A.z = gate.z + oz * 75; A.px = A.x; A.pz = A.z; A.supplies = A.men.length * 200; A.morale = 1;
      // the player: the host's commander (assault) or the highest man of the place (defend)
      let me = 0;
      if (role === 'assault') me = A.commander;
      else {
        const grown = (p) => !p.death && p.sex === 'm' && p.estate !== 'clergy' && (sim.absDay - p.birthDay) / 16 >= 22 && (sim.absDay - p.birthDay) / 16 <= 55 && p.health.hp > 0.7 && !M.armyOfPerson.has(p.id);
        me = st.residentsOf(castle.id).filter(grown).sort((p, q) => q.rankTier - p.rankTier)[0].id;
      }
      const sw = sim.switchTo(me);
      // the army was moved by hand: let the march that carries the player with it see the new place, then stand him where he belongs
      window.__m.g.advance(0.3);
      const pl = window.__m.s.services.player;
      if (role === 'assault') pl.placeAt(A.x - ox * 6, A.z - oz * 6, Math.atan2(-ox, -oz));
      else pl.placeAt(gate.x - ox * 16, gate.z - oz * 16, Math.atan2(ox, oz));
      window.__m.g.advance(0.3);
      mil.order(id, { kind: 'siege', settlement: castle.id });
      for (let h = 0; h < 30 && !M.sieges.recOf(castle.id); h++) passHours(1);
      const rec = M.sieges.recOf(castle.id);
      return { castle: { id: castle.id, name: castle.name, x: castle.x, z: castle.z }, gate: { x: gate.x, z: gate.z, rot: gate.rot }, out: [ox, oz], att, lord, army: id, size: A.men.length, me, switched: sw, rec: !!rec, mePlace: st.persons.get(st.run.playerId)?.settlement, level: mil.commandLevel(), garrison: st.residentsOf(castle.id).length };
    }, [role]);
    console.log(`war: storm ${role}`, JSON.stringify(info));
    await afternoon();
    await page.evaluate(([id, castleId]) => {
      const { M, mil } = window.__m;
      const rec = M.sieges.recOf(castleId);
      rec.ladders = true; rec.rams = 1;
      M.sieges.assault(rec, M.army(id));
    }, [info.army, info.castle.id]);
    console.log('war: battles', JSON.stringify(await page.evaluate(() => window.__m.mil.battles())));
    await advance(1);
    console.log('war: groups', JSON.stringify(await page.evaluate(() => window.__m.mil.battleGroups('own').map((g) => [g.key, g.count, g.order]))));
    console.log('war: sides', JSON.stringify(await page.evaluate(() => {
      const { sim } = window.__m; const arena = sim.services.combat.arena;
      const out = [];
      for (const fight of arena.fights.values()) for (const side of fight.sides) {
        const c = {};
        for (const f of side.members) { if (!f.active) continue; const k = f.gear.ranged ? 'ranged:' + f.gear.ranged.id : f.gear.weapon.id; c[k] = (c[k] ?? 0) + 1; }
        out.push(c);
      }
      return out;
    })));
    const survey = () => page.evaluate(() => {
      const { sim, s } = window.__m;
      const works = sim.view.siegeWorks?.() ?? [];
      const c = sim.services.combat;
      const b = s.services.player.body();
      return { status: c.siegeStatus?.() ?? null, works: works.map((k) => [k.kind, Math.round(k.x), Math.round(k.y), Math.round(k.z), +k.yaw.toFixed(2), k.swing ?? null, k.state ?? null]), body: b ? [Math.round(b.x), Math.round(b.z)] : null };
    });
    // heights are metres above the ground at that spot
    const place = (f, t) => page.evaluate(([f, t]) => { const { w, s } = window.__m; s.controls.setCameraPose({ x: f[0], y: w.heightAt(f[0], f[2]) + f[1], z: f[2] }, { x: t[0], y: w.heightAt(t[0], t[2]) + t[1], z: t[2] }, 0); }, [f, t]);
    // how the camera looks at the ram, a ladder or the wall
    const frames = await page.evaluate(([cid, out]) => {
      const { st, w, sim } = window.__m;
      const b = (st.buildingsAt.get(cid) ?? []);
      return b.filter((x) => x.kind === 'wall' || x.kind === 'tower' || x.kind === 'gatehouse').map((x) => [x.kind, Math.round(x.x), Math.round(x.z), +x.rot.toFixed(2)]);
    }, [info.castle.id, info.out]);
    console.log('war: walls', JSON.stringify(frames.slice(0, 10)), frames.length);
    for (let k = 0; k < 12; k++) {
      await advance(k === 0 ? 3 : 10);
      const sv = await survey();
      console.log(`war: t${k}`, JSON.stringify(sv));
      const ram = sv.works.find((x) => x[0] === 'ram');
      const lad = sv.works.find((x) => x[0] === 'ladder');
      const gx = info.gate.x, gz = info.gate.z, [ox, oz] = info.out;
      if (role === 'assault') {
        // the host and the wall from the camp's side
        if (k === 0) { await place([gx + ox * 62 + oz * 14, 5, gz + oz * 62 - ox * 14], [gx + ox * 8, 4, gz + oz * 8]); await shot(`${role}-1-approach`, { settle: true }); }
        // the player lends his shoulder: E at the beam is "Push the ram" (the verb is offered by the war actions provider)
        if (ram && k === 2) {
          const yaw = ram[4]; const fx = Math.sin(yaw), fz = Math.cos(yaw);
          const offered = await page.evaluate(([x, z, yaw]) => {
            const p = window.__m.s.services.player;
            p.placeAt(x, z, yaw);
            window.__game.advance(0.4);
            return p.options().map((o) => `${o.provider}/${o.id}:${o.label}:${o.enabled}`);
          }, [ram[1] - fx * 3, ram[3] - fz * 3, yaw]);
          console.log('war: options at the ram', JSON.stringify(offered));
          await advance(0.2, { interact: true });
          await advance(2.5);
          await place([ram[1] - fx * 9 + fz * 5, 3.2, ram[3] - fz * 9 - fx * 5], [ram[1] - fx * 1, 1.5, ram[3] - fz * 1]);
          await shot(`${role}-6-push`, { settle: false });
        }
        if (ram && [4, 8].includes(k)) {
          const yaw = ram[4]; const fx = Math.sin(yaw), fz = Math.cos(yaw);
          await place([ram[1] - fx * 11 + fz * 4, 3.6, ram[3] - fz * 11 - fx * 4], [ram[1] + fx * 5, 2.5, ram[3] + fz * 5]);
          await shot(`${role}-2-ram-t${k}`, { settle: false });
        }
        if (lad && [5, 9].includes(k)) {
          const yaw = lad[4]; const fx = Math.sin(yaw), fz = Math.cos(yaw);
          await place([lad[1] - fx * 9 + fz * 3, 3.2, lad[3] - fz * 9 - fx * 3], [lad[1] + fx * 3, 5.5, lad[3] + fz * 3]);
          await shot(`${role}-3-ladder-t${k}`, { settle: false });
        }
        if ([3, 7].includes(k)) {
          await place([gx + ox * 34 + oz * 26, 9, gz + oz * 34 - ox * 26], [gx + oz * 14, 7, gz - ox * 14]);
          await shot(`${role}-4-wall-t${k}`, { settle: false });
        }
        if (sv.status && sv.status.gate === 'broken' && !info.brokenShot) {
          info.brokenShot = true;
          await place([gx + ox * 18 + oz * 5, 4.5, gz + oz * 18 - ox * 5], [gx, 3.5, gz]);
          await shot(`${role}-5-gate-broken`, { settle: false });
        }
      } else if ([1, 4, 7].includes(k) || (sv.status && sv.status.gate === 'broken' && !info.brokenShot)) {
        // the lord inside: his own camera, the group bar and the storm card, the gate in front
        if (sv.status && sv.status.gate === 'broken') info.brokenShot = true;
        await shot(`${role}-${k}`, { settle: false });
      }
      if (!(await page.evaluate(() => window.__m.mil.battles().length))) { console.log('war: battle over at', k); break; }
    }
  });

  // ---------------------------------------------------------------------------------------------- fights: the saddle, a patrol, the sword and the bow on foot
  if (want('mounted', 'subdue', 'foot', 'fights')) await scene('fights', async () => {
    await load();
    await prepare();
    const spot = await page.evaluate(() => { const b = window.__m.s.services.player.body(); return { x: b.x, z: b.z }; }).then((b) => findField(b.x, b.z));
    console.log('war: fight field', JSON.stringify(spot));
    await page.evaluate((spot) => {
      const { s, g } = window.__m;
      s.services.player.placeAt(spot.x, spot.z, 0);
      g.advance(0.5);
    }, spot);
    await afternoon();
    const body = await page.evaluate(() => { const b = window.__m.s.services.player.body(); return { x: b.x, z: b.z, y: b.y, yaw: b.yaw }; });
    console.log('war: player at', JSON.stringify(body));
    const people = (n, skip) => page.evaluate(([n, skip]) => {
      const { st, sim, M } = window.__m;
      return [...st.persons.values()].filter((p) => !p.death && p.sex === 'm' && p.id !== st.run.playerId && p.estate !== 'clergy' && (sim.absDay - p.birthDay) / 16 >= 18 && (sim.absDay - p.birthDay) / 16 <= 40 && p.health.hp > 0.7 && !M.armyOfPerson.has(p.id)).slice(skip, skip + n).map((p) => p.id);
    }, [n, skip]);
    const look = (f, t) => page.evaluate(([f, t]) => window.__m.s.controls.setCameraPose({ x: f[0], y: f[1], z: f[2] }, { x: t[0], y: t[1], z: t[2] }, 0), [f, t]);
    const positions = (ids) => page.evaluate((ids) => {
      const arena = window.__m.sim.services.combat.arena;
      return ids.map((id) => { const f = arena.fighterOf(id); return f && f.active ? [f.x, f.y, f.z, f.mounted ? 1 : 0, f.st] : null; }).filter(Boolean);
    }, ids);
    const mean = (rows) => rows.length ? [rows.reduce((a, r) => a + r[0], 0) / rows.length, rows.reduce((a, r) => a + r[1], 0) / rows.length, rows.reduce((a, r) => a + r[2], 0) / rows.length] : null;
    const results = () => page.evaluate(() => { window.__m.sim.services.combat.onFightEnded((r) => console.log('war: result ' + JSON.stringify(r))); });
    await results();

    if (want('mounted', 'fights')) {
      const cav = await people(8, 0), foot = await people(18, 8);
      await page.evaluate(([cav, foot, at]) => {
        const { sim } = window.__m; const c = sim.services.combat; const arena = c.arena;
        for (const id of cav) arena.setKitOverride(id, { weapon: 'lance', shield: null, armour: ['mail_hauberk'] });
        foot.forEach((id, i) => arena.setKitOverride(id, { weapon: 'spear', shield: i % 3 ? 'shield' : null, armour: ['padded_armour'] }));
        const fid = c.engage([{ faction: 'house:1', people: cav, mounted: cav }, { faction: 'house:2', people: foot }], { at, reason: 'battle', yieldAllowed: true });
        console.log('war: mounted fight ' + fid);
      }, [cav, foot, { x: body.x, z: body.z }]);
      for (let k = 0; k < 9; k++) {
        await advance(k === 0 ? 3 : 2.5);
        const c = await positions(cav), f = await positions(foot);
        const mc = mean(c), mf = mean(f);
        console.log(`war: mounted t${k}`, JSON.stringify({ cav: c.length, mounted: c.filter((r) => r[3]).length, foot: f.length, mc, mf, gap: mc && mf ? Math.round(Math.hypot(mc[0] - mf[0], mc[2] - mf[2])) : null }));
        if (!mc || !mf) break;
        const mx = (mc[0] + mf[0]) / 2, mz = (mc[2] + mf[2]) / 2, my = (mc[1] + mf[1]) / 2;
        // from the side of the charge, low and close
        const ax = mf[0] - mc[0], az = mf[2] - mc[2], al = Math.hypot(ax, az) || 1;
        await look([mx - az / al * 26, my + 4.5, mz + ax / al * 26], [mx, my + 1.4, mz]);
        await shot(`mounted-t${k}`, { settle: false });
      }
    }

    if (want('subdue', 'fights')) {
      // the watch against two trespassers: struck to the ground and taken alive
      const watch = await people(3, 30), culprits = await people(2, 33);
      await page.evaluate(([watch, culprits, at]) => {
        const { sim } = window.__m; const c = sim.services.combat; const arena = c.arena;
        for (const id of watch) arena.setKitOverride(id, { weapon: 'sword', shield: 'shield', armour: ['padded_armour'] });
        for (const id of culprits) arena.setKitOverride(id, { weapon: 'axe', shield: null, armour: [] });
        const fid = c.engage([{ faction: 'house:1', people: watch }, { faction: 'outlaws', people: culprits }], { at: { x: at.x + 60, z: at.z }, reason: 'fight', intent: 'subdue', yieldAllowed: true });
        console.log('war: subdue fight ' + fid);
      }, [watch, culprits, { x: body.x, z: body.z }]);
      for (let k = 0; k < 6; k++) {
        await advance(k === 0 ? 2 : 3);
        const w = await positions(watch), c = await positions(culprits);
        console.log(`war: subdue t${k}`, JSON.stringify({ watch: w.length, culprits: c.length, culpritStates: c.map((r) => r[4]) }));
        const all = [...w, ...c]; const m = mean(all);
        if (!m) break;
        await look([m[0] - 9, m[1] + 3.2, m[2] - 11], [m[0], m[1] + 1.0, m[2]]);
        await shot(`subdue-t${k}`, { settle: false });
      }
    }

    if (want('foot', 'fights')) {
      // swords and spears meet in a line with archers behind each: the sword and the bow on foot, then the player's own
      const a = await people(7, 40), b = await people(7, 47);
      await page.evaluate(([a, b, at]) => {
        const { sim } = window.__m; const c = sim.services.combat; const arena = c.arena;
        a.forEach((id, i) => arena.setKitOverride(id, i < 4 ? { weapon: i % 2 ? 'sword' : 'spear', shield: i % 2 ? 'shield' : null, armour: ['padded_armour'] } : { weapon: 'dagger', ranged: 'longbow', armour: [] }));
        b.forEach((id, i) => arena.setKitOverride(id, i < 4 ? { weapon: i % 2 ? 'sword' : 'axe', shield: i % 2 ? 'shield' : null, armour: ['cap_helmet'] } : { weapon: 'dagger', ranged: 'shortbow', armour: [] }));
        const fid = c.engage([{ faction: 'house:1', people: a }, { faction: 'house:2', people: b }], { at: { x: at.x - 70, z: at.z }, reason: 'fight', yieldAllowed: true });
        console.log('war: foot fight ' + fid);
      }, [a, b, { x: body.x, z: body.z }]);
      for (let k = 0; k < 5; k++) {
        await advance(k === 0 ? 3 : 3);
        const pa = await positions(a), pb = await positions(b);
        const m = mean([...pa, ...pb]);
        console.log(`war: foot t${k}`, JSON.stringify({ a: pa.length, b: pb.length }));
        if (!m) break;
        await look([m[0] - 7, m[1] + 3.0, m[2] - 15], [m[0], m[1] + 1.2, m[2]]);
        await shot(`foot-t${k}`, { settle: false });
      }
    }
  });
} finally {
  await browser.close();
  if (vite) { try { process.kill(-vite.pid); } catch { /* gone */ } }
}
