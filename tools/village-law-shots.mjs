// Screenshots of the law and the watch in the whole game, for visual review: the plaque of the lord's land, the patrol riding in, the halt and
// its card, the escort off the land, the walk to the lock-up in bonds, the prisoner's card, a walled city on alert (the watch on its walls, by
// day and at night), and the horse that comes at a call. Starts Vite on :5193 (--port=N), plays each situation in headless Chromium (software
// GL: slow but correct) and writes docs/agents/law-<scene>.png.
//
//   node tools/village-law-shots.mjs                       # all scenes
//   node tools/village-law-shots.mjs plaque riders halt    # selected scenes (they run in the order of the list below)
//   node tools/village-law-shots.mjs --quality=medium --size=1280x720 --seed=millennia --out=/tmp/shots
//
// Scenes (each builds on the one before it where it can): plaque, riders, halt (halt-world, halt), escort, led, cell (cell, bound), alert
// (alert), night (night, after alert), horse.
// The game is driven through `window.__game` (src/app/game.ts) with the real-time loop frozen; the law, the territory and the zone are the
// real modules, the alert level of a city is a stand-in for the war module (`military.alertOf`).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : def; };
const OUT = resolve(ROOT, opt('out', 'docs/agents'));
const PORT = Number(opt('port', '5193'));
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
page.on('console', (m) => { const t = m.text(); if (m.type() === 'error' && !/GPU stall|ReadPixels|WebGL/.test(t)) console.log(`[browser error] ${t}`); });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
const base = `http://localhost:${PORT}/?seed=${encodeURIComponent(seed)}&quality=${quality}&shots=1`;

async function load(extra = 'autostart=1&season=1&day=2&time=0.42') {
  await page.goto(`${base}&${extra}`, { timeout: 120000 });
  await page.waitForFunction(() => window.__game !== undefined && window.__ui !== undefined, null, { timeout: 600000, polling: 250 });
  await page.evaluate(() => window.__game.ready());
  await page.evaluate(() => window.__game.freeze(true));
}
const advance = (seconds, input = {}) => page.evaluate(([s, i]) => window.__game.advance(s, i), [seconds, input]);
/** The whole frame (UI, HUD, panels) for a moment, without drawing: lets the interface catch up with the world. */
const tick = (seconds) => page.evaluate((n) => window.__game.tick(n), seconds);
async function shot(name) {
  await page.evaluate(() => window.__game.settle());
  await tick(0.4);
  await page.evaluate(() => window.__game.draw());
  const file = resolve(OUT, `law-${name}.png`);
  await page.screenshot({ path: file });
  console.log(`law-${name}: ${Math.round(statSync(file).size / 1024)} KB`);
}
const ok = [];
const failed = [];
async function scene(name, fn) {
  if (!want(name)) return;
  try { await fn(); ok.push(name); } catch (err) { failed.push(name); console.log(`[scene ${name} failed] ${err.message}`); }
}

/** Handles inside the page (window.__l). */
async function prepare() {
  await page.evaluate(async () => {
    const g = window.__game; const s = g.session; const sim = s.sim; const st = sim.state; const w = sim.world;
    const lawMod = await import('/src/sim/law/index.ts');
    const me = () => st.run.playerId;
    const body = () => s.services.player.body();
    const face = (yaw) => { const r = s.renderer; r.orbit(Math.atan2(Math.sin(yaw - r.getCameraYaw()), Math.cos(yaw - r.getCameraYaw())), 0); };
    window.__l = { g, s, sim, st, w, lawMod, me, body, face, law: s.services.law, terr: s.services.territory, player: s.services.player, zone: s.services.zone };
  });
}

/** A point of the lord's closes where the player is a trespasser — well inside them, in the open, in sight of the manor — and the player put there. */
async function stand() {
  return page.evaluate(() => {
    const { s, st, w, me, terr, player, zone } = window.__l;
    const p = st.persons.get(me());
    const home = w.settlements.find((x) => x.id === p.settlement);
    const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
    const places = w.settlements.filter((x) => x.kind === 'village' || x.kind === 'hamlet').sort((a, b) => dist(a, home) - dist(b, home));
    // the stage is kept once found, so that the second case happens where the first did
    if (window.__l.stage) {
      const g = window.__l.stage;
      player.placeAt(g.x, g.z, g.yaw);
      zone.resync();
      for (let i = 0; i < 40; i++) s.sim.step(1 / 20);
      return { ...g.info };
    }
    let overall = null, overallScore = -1;
    for (const v of places.slice(0, 10)) {
      const manor = (st.buildingsAt.get(v.id) ?? []).find((b) => b.kind === 'manor_house' && b.construction >= 1);
      if (!manor) continue;
      // go there, so that the navigation has the ground
      player.placeAt(manor.x + 30, manor.z + 30, 0);
      zone.resync();
      for (let i = 0; i < 40; i++) s.sim.step(1 / 20);
      for (let r = 30; r <= 130; r += 10) {
        for (let k = 0; k < 24; k++) {
          const x = manor.x + Math.sin(k * 0.262) * r, z = manor.z + Math.cos(k * 0.262) * r;
          if (terr.trespass(me(), x, z).level !== 'private' || !zone.nav.walkable(x, z)) continue;
          const e = terr.exitFrom ? terr.exitFrom(me(), x, z) : null;
          const d = e ? Math.hypot(e.x - x, e.z - z) : 0;
          // in the open (nothing between him and the manor, the way the men come) and well inside the lord's land
          const open = zone.nav.lineClear(x, z, manor.x, manor.z) && zone.nav.lineClear(x, z, x + (manor.x - x) * 0.5, z + (manor.z - z) * 0.5);
          const score = (open ? 1000 : 0) + Math.min(d, 110) + Math.min(r, 90) * 0.1;
          if (score > overallScore) { overallScore = score; overall = { village: v.name, manor: { x: manor.x, z: manor.z }, x, z, exit: d, open }; }
        }
      }
      if (overallScore >= 1100) break;
    }
    if (!overall) return null;
    const b = overall;
    const yaw = Math.atan2(b.manor.x - b.x, b.manor.z - b.z);
    player.placeAt(b.x, b.z, yaw);
    zone.resync();
    const info = { village: b.village, manor: { x: Math.round(b.manor.x), z: Math.round(b.manor.z) }, x: Math.round(b.x), z: Math.round(b.z), exit: Math.round(b.exit), open: b.open, lord: terr.trespass(me(), b.x, b.z).reason };
    window.__l.stage = { x: b.x, z: b.z, yaw, info };
    return info;
  });
}

/** The camera: looking along `yaw`, at an elevation of `pitch` radians (0.9 is high enough to see over a hedge), `zoom` further out (+) or in (−). */
async function camera(yaw, pitch, zoom = 0) {
  await page.evaluate(([y, p, z]) => {
    const { s, face } = window.__l;
    face(y);
    s.renderer.orbit(0, -3);
    s.renderer.orbit(0, p + 0.35);
    if (z) s.renderer.zoom(z);
  }, [yaw, pitch, zoom]);
}

/** Lets the law finish with the player (in game seconds) and forget the memory of an escort, so that the next case is heard. */
async function clearCase() {
  await page.evaluate(() => {
    const { law, me, g, lawMod, sim } = window.__l;
    let t = 0;
    while (law.patrolFor(me()) && t < 200) { g.advance(1); t += 1; }
    lawMod.lawContext(sim).patrol.escorted.clear();
    lawMod.lawContext(sim).law.store.data.offences.length = 0;
  });
}

/** From outside the wall, a few metres off, the camera on a man who stands on it (a wall-walk by preference, else a tower). */
async function lookAtWatch(name) {
  const r = await page.evaluate(() => {
    const { player, zone } = window.__l;
    const pb = player.body();
    const dist = (a) => Math.hypot(a.x - pb.x, a.z - pb.z);
    const walls = zone.agentsArr.filter((a) => a.elev > 5 && a.elev < 11).sort((a, b) => dist(a) - dist(b));
    const towers = zone.agentsArr.filter((a) => a.elev >= 11).sort((a, b) => dist(a) - dist(b));
    const a = walls[0] ?? towers[0];
    if (!a) return null;
    // outside the wall: the posts face out
    let px = a.x + Math.sin(a.yaw) * 13, pz = a.z + Math.cos(a.yaw) * 13;
    const out = { x: 0, z: 0 };
    if (!zone.nav.walkable(px, pz) && zone.nav.nearestWalkable(px, pz, 16, out)) { px = out.x; pz = out.z; }
    player.placeAt(px, pz, Math.atan2(a.x - px, a.z - pz));
    zone.resync();
    return { man: a.person.first, career: a.person.career, height: Math.round(a.elev), activity: a.activity, yaw: Math.atan2(a.x - px, a.z - pz), dx: Math.round(a.x - px), dz: Math.round(a.z - pz), others: walls.length + towers.length };
  });
  console.log(`${name} watch`, JSON.stringify(r));
  if (!r) throw new Error('nobody on the walls');
  await advance(2);
  await camera(r.yaw, -0.1, -0.6);
  await shot(name);
}

/** In the streets: the camera on the nearest man who carries a torch. */
async function lookAtTorch(name) {
  const r = await page.evaluate(() => {
    const { player, zone } = window.__l;
    const pb = player.body();
    const dist = (a) => Math.hypot(a.x - pb.x, a.z - pb.z);
    const lit = zone.agentsArr.filter((a) => a.draw.mainHand === 'torch' && a.elev < 1).sort((a, b) => dist(a) - dist(b));
    const a = lit[0];
    if (!a) return null;
    const yaw = a.yaw + Math.PI;
    let px = a.x + Math.sin(yaw) * 9, pz = a.z + Math.cos(yaw) * 9;
    const out = { x: 0, z: 0 };
    if (!zone.nav.walkable(px, pz) && zone.nav.nearestWalkable(px, pz, 10, out)) { px = out.x; pz = out.z; }
    player.placeAt(px, pz, Math.atan2(a.x - px, a.z - pz));
    zone.resync();
    return { man: a.person.first, career: a.person.career, activity: a.activity, yaw: Math.atan2(a.x - px, a.z - pz), watchers: lit.length };
  });
  console.log(`${name} torch`, JSON.stringify(r));
  if (!r) throw new Error('no torches in the streets');
  await advance(1.5);
  await camera(r.yaw, 0.35, -0.3);
  await shot(name);
}

try {
  await load();
  await prepare();
  let at = null;

  await scene('plaque', async () => {
    at = await stand();
    if (!at) throw new Error('no manor court to trespass in');
    console.log('stage', JSON.stringify(at));
    await page.evaluate(() => { const { sim, me } = window.__l; sim.state.persons.get(me()).money = 80; });
    await advance(2);
    await tick(0.8);
    await shot('plaque');
  });

  await scene('riders', async () => {
    if (!at) at = await stand();
    // the case is reported at once (the watch would take ten seconds more), and the men ride in
    const info = await page.evaluate(() => {
      const { sim, me, law, body, zone, face } = window.__l;
      const b = body();
      const ok = law.report(me(), b.x, b.z);
      const pv = law.patrolFor(me());
      for (let i = 0; i < 10; i++) sim.step(1 / 20);
      const lead = pv ? zone.agent(pv.leader) : null;
      if (lead) face(Math.atan2(lead.x - b.x, lead.z - b.z));
      return { ok, men: pv ? pv.men.length : 0, mounted: pv ? pv.mounted : false, at: lead ? { dx: Math.round(lead.x - b.x), dz: Math.round(lead.z - b.z) } : null };
    });
    console.log('patrol', JSON.stringify(info));
    // they gallop in: when the leader is fifty metres off, the camera is on him (high enough to see over the hedges)
    const d = await page.evaluate(() => {
      const { law, me, body, zone, g } = window.__l;
      let t = 0, dd = 999, yaw = 0;
      for (; t < 40; t += 0.25) {
        g.advance(0.25);
        const pv = law.patrolFor(me());
        const lead = pv ? zone.agent(pv.leader) : null;
        const b = body();
        if (lead) { dd = Math.hypot(lead.x - b.x, lead.z - b.z); yaw = Math.atan2(lead.x - b.x, lead.z - b.z); if (dd < 50) break; }
      }
      return { t, dd: Math.round(dd), yaw };
    });
    console.log('riders at', JSON.stringify(d));
    await camera(d.yaw, 0.8, 0.5);
    await shot('riders');
  });

  await scene('halt', async () => {
    const phase = await page.evaluate(() => {
      const { law, me, g, body, zone } = window.__l;
      let t = 0;
      while (law.patrolFor(me()) && law.patrolFor(me()).phase === 'coming' && t < 90) { g.advance(0.5); t += 0.5; }
      const pv = law.patrolFor(me());
      const lead = pv ? zone.agent(pv.leader) : null; const b = body();
      return pv ? { phase: pv.phase, line: pv.line, t, yaw: lead ? Math.atan2(lead.x - b.x, lead.z - b.z) : 0 } : null;
    });
    console.log('halt', JSON.stringify(phase));
    await advance(0.5);
    await camera(phase ? phase.yaw : 0, 0.55, 0.2);
    await tick(1.2);
    // the world first (the panel put away for a moment), then the card
    await page.evaluate(() => window.__ui.closePanel('law'));
    await tick(0.4);
    await shot('halt-world');
    await page.evaluate(() => window.__ui.openPanel({ panel: 'ext', name: 'law', data: { mode: 'patrol' } }));
    await tick(1);
    await shot('halt');
  });

  await scene('escort', async () => {
    const r = await page.evaluate(() => {
      const { law, me } = window.__l;
      const res = law.answerPatrol(me(), 'leave');
      const pv = law.patrolFor(me());
      return { res, phase: pv && pv.phase, deadline: pv && pv.deadline, exit: pv && pv.exit };
    });
    console.log('escort', JSON.stringify(r));
    await page.evaluate(() => window.__ui.closePanel('law'));
    await tick(0.5);
    // walk towards the edge of the land, the men following behind him; a moment on, the camera looks back at them
    const prog = await page.evaluate(() => {
      const { law, me, body, g, zone } = window.__l;
      let t = 0, widest = 0, yaw = 0;
      for (; t < 60; t += 1) {
        const pv = law.patrolFor(me()); const b = body();
        if (!pv || pv.phase !== 'escort') break;
        const ex = pv.exit; if (!ex) break;
        const way = Math.atan2(ex.x - b.x, ex.z - b.z);
        const left = Math.hypot(ex.x - b.x, ex.z - b.z);
        if (t > 3 && left < 22) break;
        g.advance(1, { forward: 1, cameraYaw: way });
      }
      const pv = law.patrolFor(me()); const b = body();
      const lead = pv ? zone.agent(pv.leader) : null;
      if (lead) { widest = Math.hypot(lead.x - b.x, lead.z - b.z); yaw = Math.atan2(lead.x - b.x, lead.z - b.z); }
      return { t, phase: pv && pv.phase, behind: Math.round(widest), deadline: pv && Math.round(pv.deadline), yaw };
    });
    console.log('escort walk', JSON.stringify(prog));
    // the camera looks back along the way he came: the men are close behind him
    await camera(prog.yaw, 0.7, 0.3);
    await tick(0.8);
    await shot('escort');
    // and out of it: the riders turn back
    const left = await page.evaluate(() => {
      const { law, me, body, g } = window.__l;
      let t = 0;
      while (law.patrolFor(me()) && law.patrolFor(me()).phase === 'escort' && t < 200) {
        const pv = law.patrolFor(me()); const b = body();
        const yaw = pv && pv.exit ? Math.atan2(pv.exit.x - b.x, pv.exit.z - b.z) : 0;
        g.advance(1, { forward: 1, cameraYaw: yaw });
        t += 1;
      }
      const pv = law.patrolFor(me());
      return { t, phase: pv && pv.phase };
    });
    console.log('escort ended', JSON.stringify(left));
  });

  await scene('led', async () => {
    // a second case, this time he yields (the first patrol is let finish and the memory of the escort cleared, so that the talk is heard)
    await clearCase();
    at = await stand();
    if (!at) throw new Error('no stage');
    console.log('stage 2', JSON.stringify(at));
    const r = await page.evaluate(() => {
      const { sim, me, law, body, g } = window.__l;
      const b = body();
      const ok = law.report(me(), b.x, b.z);
      let t = 0;
      while (law.patrolFor(me()) && law.patrolFor(me()).phase === 'coming' && t < 90) { g.advance(0.5); t += 0.5; }
      window.__ui.closePanel('law');
      const res = law.answerPatrol(me(), 'yield');
      const pv = law.patrolFor(me());
      for (let i = 0; i < 60; i++) sim.step(1 / 20);
      return { ok, res, phase: pv && pv.phase, bound: window.__l.player.restraint && window.__l.player.restraint(), t };
    });
    console.log('yield', JSON.stringify(r));
    // behind the prisoner, looking along the way to the lock-up
    await advance(5);
    const yawLead = await page.evaluate(() => {
      const { law, me, body, zone } = window.__l;
      const pv = law.patrolFor(me());
      const lead = pv ? zone.agent(pv.leader) : null;
      const b = body();
      return lead ? Math.atan2(lead.x - b.x, lead.z - b.z) : 0;
    });
    await camera(yawLead, 0.7, 0.3);
    await shot('led');
    // and from the front: the bound hands and the bound walk
    await camera(yawLead + Math.PI, 0.35, -0.3);
    await shot('led-front');
  });

  await scene('cell', async () => {
    const r = await page.evaluate(() => {
      const { law, me, g } = window.__l;
      let t = 0;
      while (law.patrolFor(me()) && t < 400) { g.advance(2); t += 2; }
      const c = law.captivity(me());
      return { t, held: !!c, text: c && c.text, led: c && c.led, choices: law.captivityChoices(me()).map((x) => x.id + (x.ok ? '' : '(no)')) };
    });
    console.log('cell', JSON.stringify(r));
    await tick(1.5);
    const open = await page.evaluate(() => window.__ui.openPanels());
    if (!open.includes('law')) await page.evaluate(() => window.__ui.openPanel({ panel: 'ext', name: 'law', data: { mode: 'captive' } }));
    await tick(1);
    await shot('cell');
    // the world as the prisoner sees it: bound at the door of the lock-up
    await page.evaluate(() => window.__ui.closePanel('law'));
    await tick(0.5);
    await shot('bound');
    // the fine is paid: free again
    const out = await page.evaluate(() => {
      const { sim, me, law } = window.__l;
      sim.state.persons.get(me()).money = 500;
      return law.chooseInCaptivity(me(), 'pay');
    });
    console.log('pay', JSON.stringify(out));
    await advance(1);
  });

  await scene('alert', async () => {
    const info = await page.evaluate(() => {
      const { st, w, sim, player, zone } = window.__l;
      // a walled city (or castle) with the most wall in it
      const walls = (id) => (st.buildingsAt.get(id) ?? []).filter((b) => b.kind === 'wall' && b.construction >= 1).length;
      const pick = w.settlements.filter((x) => x.kind === 'castle' || x.kind === 'city' || x.kind === 'town').sort((a, b) => walls(b.id) - walls(a.id))[0];
      const prev = sim.services.military;
      window.__l.level = 'peace';
      window.__l.target = pick.id;
      sim.services.military = new Proxy(prev ?? {}, { get: (t, k) => (k === 'alertOf' ? (id) => (id === window.__l.target ? window.__l.level : 'peace') : k === 'fortState' ? () => null : t[k]) });
      // at the gate, so that the people of the place are about
      const gate = (pick.gates && pick.gates[0]) ?? { x: pick.x, z: pick.z + (pick.radius ?? 80) };
      let ox = gate.x - pick.x, oz = gate.z - pick.z; const ol = Math.hypot(ox, oz) || 1; ox /= ol; oz /= ol;
      let best = null;
      for (let k = 0; k < 24 && !best; k++) {
        const a = Math.atan2(ox, oz) + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.22;
        const tx = gate.x + Math.sin(a) * 30, tz = gate.z + Math.cos(a) * 30;
        const out = { x: 0, z: 0 };
        if (zone.nav.walkable(tx, tz)) best = { x: tx, z: tz }; else if (zone.nav.nearestWalkable(tx, tz, 14, out)) best = { x: out.x, z: out.z };
      }
      best = best ?? { x: gate.x + ox * 30, z: gate.z + oz * 30 };
      player.placeAt(best.x, best.z, Math.atan2(gate.x - best.x, gate.z - best.z));
      zone.resync();
      return { name: pick.name, kind: pick.kind, walls: walls(pick.id) };
    });
    console.log('alert stage', JSON.stringify(info));
    await advance(8);
    await page.evaluate(() => { window.__l.level = 'alarm'; });
    await advance(40);
    const posts = await page.evaluate(() => {
      const { zone } = window.__l;
      return { agents: zone.agentsArr.length, onWalls: zone.agentsArr.filter((a) => a.elev > 3).length, stations: zone.wallStations(window.__l.target).length };
    });
    console.log('alarm', JSON.stringify(posts));
    await lookAtWatch('alert');
  });

  await scene('night', async () => {
    await page.evaluate(() => {
      const { sim, zone } = window.__l;
      const c = sim.state.clock;
      c.absDay = Math.floor(c.absDay) + 0.04;
      c.firedHour = Math.floor(c.absDay * 24);
      zone.resync();
    });
    await advance(30);
    // by night at the alarm the wall is manned (the second half of the garrison rests)...
    await lookAtWatch('night');
    // ...and at the watch the night watch is doubled, torch in hand: the bailey of the castle with the most men-at-arms
    const castle = await page.evaluate(() => {
      const { st, w, player, zone } = window.__l;
      const arms = new Set(['knight', 'sergeant', 'man_at_arms', 'soldier', 'archer', 'squire']);
      const men = (id) => (st.residentsOf(id) ?? []).filter((p) => arms.has(p.career)).length;
      const pick = w.settlements.filter((x) => x.kind === 'castle').sort((a, b) => men(b.id) - men(a.id))[0];
      window.__l.level = 'watch';
      window.__l.target = pick.id;
      player.placeAt(pick.x, pick.z, 0);
      zone.resync();
      return { name: pick.name, men: men(pick.id) };
    });
    console.log('night-watch castle', JSON.stringify(castle));
    await advance(45);
    await lookAtTorch('night-watch');
  });

  await scene('horse', async () => {
    const info = await page.evaluate(() => {
      const { sim, st, w, me, player, zone, face } = window.__l;
      const p = st.persons.get(me());
      const hh = st.households.get(p.household);
      hh.stores['horse#1'] = 1;
      st.touchHousehold(hh);
      const home = st.buildings.get(hh.home) ?? w.settlements.find((x) => x.id === p.settlement);
      const c = sim.state.clock;
      c.absDay = Math.floor(c.absDay) + 0.42;
      c.firedHour = Math.floor(c.absDay * 24);
      // the pasture is where the horse is by day; stand eighty metres from it
      const spec = zone.fauna.livestockOf(hh, hh.settlement).find((q) => q.kind === 'horse');
      const gx = spec && spec.hasGraze ? spec.grazeX : home.x, gz = spec && spec.hasGraze ? spec.grazeZ : home.z;
      player.placeAt(gx, gz, 0);
      zone.resync();
      for (let i = 0; i < 80; i++) sim.step(1 / 20);
      const horse = zone.animals().find((a) => a.kind === 'horse' && a.owner === hh.id);
      const hx = horse ? horse.x : gx, hz = horse ? horse.z : gz;
      let tx = hx + 80, tz = hz + 20;
      const out = { x: 0, z: 0 };
      if (!zone.nav.walkable(tx, tz) && zone.nav.nearestWalkable(tx, tz, 20, out)) { tx = out.x; tz = out.z; }
      player.placeAt(tx, tz, Math.atan2(hx - tx, hz - tz));
      face(Math.atan2(hx - tx, hz - tz));
      for (let i = 0; i < 20; i++) sim.step(1 / 20);
      const res = player.callHorse();
      window.__l.horse = horse ? horse.id : 0;
      return { horse: !!horse, res, hud: player.hud().horseCall };
    });
    console.log('horse', JSON.stringify(info));
    // it trots in; when it is ten metres off, the camera is on it
    const d = await page.evaluate(() => {
      const { zone, body, g } = window.__l;
      let t = 0, dd = 999, yaw = 0, speed = 0;
      for (; t < 60; t += 0.25) {
        g.advance(0.25);
        const h = zone.animals().find((a) => a.id === window.__l.horse);
        const b = body();
        if (h) { dd = Math.hypot(h.x - b.x, h.z - b.z); yaw = Math.atan2(h.x - b.x, h.z - b.z); speed = h.draw.moveSpeed; if (dd < 11) break; }
      }
      return { t, dd: Math.round(dd), yaw, speed: Math.round(speed * 10) / 10 };
    });
    console.log('horse at', JSON.stringify(d));
    await camera(d.yaw, 0.45, 0.2);
    await shot('horse');
  });

  // hands-on work you can watch (CIV §8): a smith at his forge; the body plays each step and the work throws up steam and sparks
  await scene('steps', async () => {
    const info = await page.evaluate(() => {
      const { sim, st, w, player, zone, face, s } = window.__l;
      // a smith of a place that has a smithy, and the smithy
      let pick = null;
      for (const p of st.persons.values()) {
        if (p.death || p.career !== 'smith' || p.sex !== 'm' || p.id === st.run.playerId) continue;
        const b = (st.buildingsAt.get(p.settlement) ?? []).find((q) => q.kind === 'smithy' && q.construction >= 1);
        if (b) { pick = { p, b }; break; }
      }
      if (!pick) return { error: 'no smith with a smithy' };
      const sw = sim.switchTo(pick.p.id);
      const c = sim.state.clock;
      c.absDay = Math.floor(c.absDay) + 0.4;
      c.firedHour = Math.floor(c.absDay * 24);
      const door = zone.nav.doorOf(pick.b.id);
      player.placeAt(door.x, door.z, door.yaw + Math.PI);
      zone.resync();
      for (let i = 0; i < 60; i++) sim.step(1 / 20);
      face(door.yaw + Math.PI);
      const t = player.target();
      const opts = player.options();
      const withSteps = opts.filter((o) => o.steps && o.steps.length);
      return { switched: sw.ok, smith: pick.p.first, target: t && t.label, options: opts.map((o) => `${o.id}${o.enabled ? '' : '(' + (o.reason || 'no') + ')'}`).slice(0, 12), withSteps: withSteps.map((o) => o.id + (o.enabled ? '' : ' disabled')).slice(0, 8) };
    });
    console.log('steps stage', JSON.stringify(info));
    if (info.error) throw new Error(info.error);
    // give him what the bench wants, then start the first enabled bout with steps
    const started = await page.evaluate(() => {
      const { player, st, sim } = window.__l;
      const me = st.persons.get(st.run.playerId);
      for (const g of ['iron', 'charcoal', 'iron_bar', 'wood', 'coal']) me.inventory[g] = (me.inventory[g] || 0) + 20;
      st.touch(me);
      const o = player.options().find((x) => x.steps && x.steps.length && x.enabled);
      if (!o) return { error: 'no enabled option with steps', reasons: player.options().filter((x) => x.steps && x.steps.length).map((x) => x.id + ': ' + x.reason) };
      const out = player.perform(o);
      void sim;
      return { id: o.id, seconds: o.seconds, steps: o.steps.map((q) => `${q.label}:${q.share}:${q.sfx || ''}`), out };
    });
    console.log('steps start', JSON.stringify(started));
    if (started.error) throw new Error(`${started.error} ${JSON.stringify(started.reasons || [])}`);
    // one shot in each step that throws something up
    const seen = new Set();
    for (let i = 0; i < 40 && seen.size < 3; i++) {
      await advance(0.6);
      const h = await page.evaluate(() => { const a = window.__l.player.hud().action; return a ? { step: a.step || null, anim: window.__l.body().anim } : null; });
      if (!h || !h.step) continue;
      const key = h.step.label || JSON.stringify(h.step);
      if (seen.has(key)) continue;
      seen.add(key);
      console.log('step', JSON.stringify(h));
      await page.evaluate(() => window.__l.s.renderer.zoom(0.6));
      await shot(`steps-${seen.size}`);
    }
  });
} finally {
  console.log(`done: ${ok.join(', ') || '-'}${failed.length ? `; failed: ${failed.join(', ')}` : ''}`);
  await browser.close();
  if (vite) { try { process.kill(-vite.pid, 'SIGTERM'); } catch { vite.kill('SIGTERM'); } }
}
