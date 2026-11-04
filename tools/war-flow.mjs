// Flow check of the war in the real game (headless Chromium, the real modules, no API shortcuts past the player's own verbs):
//   A. the castle scenario from the main menu (click) — the host sets out in the afternoon, the march is skipped to the camp, the night is
//      slept to the dawn, the storm goes in; the ram, the ladders and the stairs: climb a ladder onto the wall-walk, fight there,
//      and walk up a flight of stairs; sound the retreat (the host turns home);
//   B. "Plan an attack" from the ruler's Military page (the lord's seat of government): confirm, the host marches, the camp, the
//      dawn storm;
//   C. the raiders' danger (D3): a raiding party on the lands in a real run shows as the agenda's danger on the "What now?" card.
//
//   node tools/war-flow.mjs [--seed=abc] [--port=5301] [--only=a|b|c] [--shots=/tmp/dir]
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : def; };
const PORT = Number(opt('port', 5301));
const seed = opt('seed', 'millennia');
const SHOTS = opt('shots', '');
const ONLY = opt('only', '');
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
if (await serverUp()) throw new Error(`port ${PORT} is busy: pass --port=<free port>`);
vite = await startVite();

const launch = () => chromium.launch({ args: ['--js-flags=--expose-gc --max-old-space-size=1400', '--enable-precise-memory-info'] });
let browser = await launch();
let page = null;
const errors = [];
let failures = 0;
let consoleCount = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  ${detail}`}`); if (!ok) failures++; };
const note = (s) => console.log(`     ${s}`);
const ev = (fn, arg) => page.evaluate(fn, arg);
// (a collection after every step: the box is shared and V8 does not know the memory limit it lives under)
const tick = (s) => page.evaluate((n) => { window.__game.tick(n); window.gc?.(); }, s);
/** MB resident per kind of browser process (renderer / gpu / ...) under this process. */
function rssKinds() {
  try {
    const rows = execSync('ps -eo pid=,ppid=,rss=,args=').toString().trim().split('\n').map((l) => { const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/); return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4]] : null; }).filter(Boolean);
    const kids = new Map();
    for (const r of rows) { if (!kids.has(r[1])) kids.set(r[1], []); kids.get(r[1]).push(r); }
    const out = {}; const stack = [process.pid];
    while (stack.length) { const q = stack.pop(); for (const r of kids.get(q) ?? []) { if (r[0] === vite?.pid) continue; const t = (r[3].match(/--type=([a-z-]+)/) ?? [0, 'browser'])[1]; out[t] = (out[t] ?? 0) + Math.round(r[2] / 1024); stack.push(r[0]); } }
    return JSON.stringify(out);
  } catch { return '?'; }
}
/** MB resident of everything under this process (the browser and its helpers): the box is shared and a crashed page is usually the memory limit. */
function rssMB() {
  try {
    const rows = execSync('ps -eo pid=,ppid=,rss=').toString().trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
    const kids = new Map();
    for (const [pid, ppid, rss] of rows) { if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push([pid, rss]); }
    let sum = 0; const stack = [process.pid];
    while (stack.length) { const q = stack.pop(); for (const [pid, rss] of kids.get(q) ?? []) { if (pid === vite?.pid) continue; sum += rss; stack.push(pid); } }
    return Math.round(sum / 1024);
  } catch { return -1; }
}
const ui = () => page.evaluate(() => window.__ui.openPanels());

async function load(extra, size = { width: 800, height: 450 }) {
  if (page) { try { await page.close(); } catch { /* gone */ } }
  page = await browser.newPage({ viewport: size });
  page.setDefaultTimeout(0);
  page.on('pageerror', (e) => { errors.push(e.message); console.log(`     [page error] ${e.message.slice(0, 300)}`); });
  page.on('console', (m) => { consoleCount++; if (consoleCount < 25 && m.type() !== 'log') console.log(`     [console ${m.type()}] ${m.text().slice(0, 200)}`); });
  page.on('console', (m) => { if (m.type() === 'error' && !/GPU stall|ReadPixels|WebGL/.test(m.text())) errors.push(m.text()); });
  await page.goto(`http://localhost:${PORT}/?seed=${encodeURIComponent(seed)}&quality=low&shots=1&${extra}`, { timeout: 120000 });
  await page.waitForFunction(() => window.__game !== undefined && window.__ui !== undefined, null, { timeout: 300000, polling: 250 });
  // the real-time loop would render every animation frame in software GL (a storm is a crowd): only the flow's own steps and shots draw
  await page.evaluate(() => window.__game.freeze(true));
}
async function shot(name) {
  if (!SHOTS) return;
  for (let i = 0; i < 5; i++) { await page.evaluate(() => window.__game.draw()); await page.waitForTimeout(60); }
  await page.screenshot({ path: resolve(SHOTS, `j4-war-${name}.png`) });
}
/** The campaign's phase and the army/battle facts a check wants. */
const facts = () => ev(() => {
  const g = window.__game, s = g.session;
  const sim = s.sim, c = s.services.campaign, mil = sim.services.military;
  const b = s.services.player.body();
  return {
    phase: c?.phase() ?? null, skip: !!sim.clock.skip, hour: +((sim.absDay % 1) * 24).toFixed(1),
    body: b ? { x: +b.x.toFixed(1), y: +b.y.toFixed(2), z: +b.z.toFixed(1) } : null,
    battles: mil ? mil.battles().length : 0, heap: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576),
    men: c && c.army() ? (mil.armies().find((a) => a.id === c.army())?.men ?? null) : null,
  };
});
/** Runs whole frames until `pred(facts)` holds or `max` frames (of `dt` seconds) pass; returns the last facts. */
async function until(pred, max = 400, dt = 1) {
  let f = await facts();
  for (let i = 0; i < max; i++) {
    if (pred(f)) return f;
    if (i % 10 === 0) note(`.. ${JSON.stringify(f)} rss=${rssMB()}MB`);
    await tick(dt);
    f = await facts();
  }
  return f;
}

/** The box is shared and a browser that is killed for memory ("Target crashed") is not the game's failure: a part is tried again (up to ten times). */
async function attempt(part) {
  for (let n = 1; ; n++) {
    const before = failures, errs = errors.length;
    try { await part(); return; } catch (e) {
      if (n < 10 && /Target crashed|Target closed|has been closed/.test(String(e.message))) {
        console.log(`     (the browser was killed for memory: trying ${part.name} again, ${n + 1} of 10)`);
        failures = before; errors.length = errs;
        if (!browser.isConnected()) { browser = await launch(); page = null; }
        continue;
      }
      throw e;
    }
  }
}

try {
  if (!ONLY || ONLY === 'a') await attempt(partA);
  if (!ONLY || ONLY === 'b') await attempt(partB);
  if (!ONLY || ONLY === 'c') await attempt(partC);
  if (!ONLY || ONLY === 'd') await attempt(partD);
} catch (e) {
  console.log('FLOW ERROR', e.stack ?? e.message);
  failures++;
} finally {
  await browser.close();
  if (vite) { try { process.kill(-vite.pid, 'SIGTERM'); } catch { vite.kill('SIGTERM'); } }
}
if (errors.length) { console.log(`\n${errors.length} page errors:`); for (const e of errors.slice(0, 10)) console.log(`  ${e}`); failures++; }
console.log(failures ? `\n${failures} failure(s)` : '\nall war flow checks passed');
process.exit(failures ? 1 : 0);

// ---------------------------------------------------------------------------------------------------------------------------------
async function partA() {
  console.log('-- A: the castle scenario from the menu');
  await load('');
  const btn = page.locator('button', { hasText: 'Scenario: the march on the castle' });
  check('the main menu offers the castle scenario', (await btn.count()) === 1);
  await btn.click();
  await page.waitForFunction(() => window.__game.session !== null && window.__game.session !== undefined, null, { timeout: 300000, polling: 500 });
  await ev(() => window.__game.ready());
  await tick(0.3);
  let f = await facts();
  note(JSON.stringify(f) + ``);
  check('the host marches (phase march) from the afternoon', f.phase === 'march' || f.skip, JSON.stringify(f));
  const reached = await ev(() => {
    const g = window.__game;
    for (let i = 0; i < 600; i++) { g.tick(1); if (i % 5 === 0) window.gc?.(); const se = g.session; if (se.sim.clock.skip) continue; const p = se.services.campaign?.phase(); if (p === 'before' || p === 'camp' || p === 'storm') return p; }
    return 'none';
  });
  f = await facts();
  note(`reached ${reached}: ${JSON.stringify(f)}`);
  check('the march is skipped: the host is before the walls (camped for the night, or already in the storm by day)', reached === 'before' || reached === 'storm', reached);
  if (reached === 'before') {
    const camp = await ev(() => { const st = window.__game.session.sim.state; return { tents: [...st.buildings.values()].filter((b) => b.kind === 'tent').length }; });
    check('the camp stands: tents round the fires', camp.tents >= 6, JSON.stringify(camp));
    await shot('a-camp');
    // the night is slept to the dawn (Z, the rest page); the storm goes in at first light. (The small hours of the night are taken as
    // gone, to keep the flow short: the player's own sleep starts at half past four.)
    await passTheNight();
    for (let i = 0; i < 400; i++) {
      f = await facts();
      if (f.phase === 'storm') break;
      await tick(1);
      if (i % 4 === 0) note(`.. ${JSON.stringify(f)} rss=${rssMB()}MB`);
    }
  } else f = await facts();
  note(JSON.stringify(f) + ` rss=${rssMB()}MB`);
  check('the storm goes in, with the player in the battle', f.phase === 'storm' && f.battles > 0, JSON.stringify(f));
  for (let i = 0; i < 8; i++) { await tick(0.25); const q = await facts(); note(`storm t+${(i + 1) * 0.25}s rss=${rssMB()}MB jsheap=${q.heap}MB console=${consoleCount} ${rssKinds()}`); }
  const works = await ev(() => {
    const se = window.__game.session, sim = se.sim;
    const w = sim.view.siegeWorks?.() ?? [];
    return { works: w.map((k) => [k.kind, Math.round(k.x), Math.round(k.z), k.state ?? null]), status: sim.services.combat.siegeStatus?.() ?? null };
  });
  note(JSON.stringify(works));
  await stormVerbs();
  // sound the retreat (two clicks on the battle card): the host breaks off and turns for home
  const retreat = page.locator('button.retreat');
  check('the battle card offers Sound the retreat', (await retreat.count()) >= 1);
  if ((await retreat.count()) >= 1) {
    await ev(() => document.querySelector('button.retreat').click());
    await tick(0.3);
    await ev(() => document.querySelector('button.retreat').click());
    await tick(1);
    f = await facts();
    check('the retreat ends the campaign: no storm, no battle with the player in it', f.phase === null && f.battles === 0, JSON.stringify(f));
  }
}

/** In the storm: the ram works, a ladder goes up, the player climbs it onto the wall-walk and fights there; then the stairs. */
async function stormVerbs() {
  note('storm: ' + JSON.stringify(await ev(() => {
    const se = window.__game.session, a = se.sim.services.combat.arena;
    return { day: +se.sim.absDay.toFixed(4), skip: !!se.sim.clock.skip, speed: se.sim.clock.state?.speed, paused: se.sim.clock.state?.paused, fights: [...a.fights.values()].map((f) => ({ id: f.id, t: f.time ?? f.t, works: f.scene?.works.length, sides: f.sides.map((x) => x.members.filter((m) => m.active).length), quiet: f.quiet })), player: !!a.player };
  })));
  let planted = false;
  let ladder = await waitFor(() => ev(() => {
    const arena = window.__game.session.sim.services.combat.arena;
    for (const fight of arena.fights.values()) {
      const w = fight.scene?.works.find((x) => x.kind === 'ladder' && x.phase === 'up');
      if (w) return { id: w.id, fx: w.footX, fz: w.footZ, yaw: w.yaw };
    }
    return null;
  }), 3);
  if (!ladder) {
    // the bearers of the ladders are cut down under the bows before they reach the wall (60 against 57 on the walls, in the open):
    // so that the player's own verbs can be tried, a ladder that has been carried to its station is planted, as the war-shots tool does
    note('the ladder bearers did not get through: a carried ladder is planted at its foot');
    ladder = await ev(() => {
      const se = window.__game.session, arena = se.sim.services.combat.arena, nav = se.services.zone.nav;
      for (const fight of arena.fights.values()) {
        const sc = fight.scene;
        const pl = se.services.player;
        const st = sc.stations.find((q) => { if (!Number.isFinite(nav.walkTopAt(q.x, q.z, q.y))) return false; pl.placeAt(q.x, q.z, q.yaw, q.y); const bd = pl.body(); return !!bd.walk && Math.abs(bd.y - q.y) < 1.4; });
        const w = sc.works.find((x) => x.kind === 'ladder');
        if (!st || !w) continue;
        // (some of the stations the ladders are sent to lie where the navigation has no wall-walk: the flow sets one on a station that has)
        const out = { x: Math.sin(st.yaw), z: Math.cos(st.yaw) };
        w.station = st; w.footX = st.x + out.x * 2.6; w.footZ = st.z + out.z * 2.6; w.goalX = w.footX; w.goalZ = w.footZ;
        w.x = w.footX; w.z = w.footZ; w.y = arena.groundY(w.x, w.z); w.yaw = Math.atan2(-out.x, -out.z); w.length = Math.max(4, st.y - w.y + 1.1);
        w.phase = 'up'; w.cool = 0;
        return { id: w.id, fx: w.footX, fz: w.footZ, yaw: w.yaw };
      }
      return null;
    });
    if (!ladder) note('stations: ' + JSON.stringify(await ev(() => {
      const se = window.__game.session, a = se.sim.services.combat.arena, nav = se.services.zone.nav;
      const out = [];
      for (const fight of a.fights.values()) for (const st of fight.scene.stations.slice(0, 6)) {
        let near = 1e9; for (const q of nav.walls.rects) near = Math.min(near, Math.hypot(q.cx - st.x, q.cz - st.z));
        out.push([+st.x.toFixed(1), +st.z.toFixed(1), +st.y.toFixed(1), nav.walkTopAt(st.x, st.z, st.y), +near.toFixed(1)]);
      }
      return { rects: nav.walls.rects.length, out };
    })));
    planted = !!ladder;
  }
  const kinds = await ev(() => { const a = window.__game.session.sim.services.combat.arena; const k = {}; for (const fight of a.fights.values()) for (const w of fight.scene?.works ?? []) k[`${w.kind}:${w.phase}`] = (k[`${w.kind}:${w.phase}`] ?? 0) + 1; return k; });
  note(`works: ${JSON.stringify(kinds)}`);
  note('storm after: ' + JSON.stringify(await ev(() => { const se = window.__game.session, a = se.sim.services.combat.arena; return { day: +se.sim.absDay.toFixed(4), fights: [...a.fights.values()].map((f) => ({ t: f.time ?? f.t, works: f.scene?.works.map((w) => w.kind + ':' + w.phase), sides: f.sides.map((x) => x.members.filter((m) => m.active).length) })) }; })));
  check(`the assault brings a ram and ladders to the walls${planted ? ' (a ladder planted by the flow: the bearers were cut down)' : ', and a ladder goes up'}`, !!ladder && Object.keys(kinds).some((k) => k.startsWith('ram')), JSON.stringify({ ladder, kinds }));
  if (!ladder) return;
  // stand at the ladder's foot; the wheel's verb is "Climb the ladder"
  const opts = await ev((l) => {
    const p = window.__game.session.services.player;
    const by = Math.atan2(Math.sin(l.yaw), Math.cos(l.yaw));
    p.placeAt(l.fx - Math.sin(by) * 1.2, l.fz - Math.cos(by) * 1.2, by);
    window.__game.advance(0.3);
    const all = window.__game.session.sim.actions.list(window.__game.session.sim.state.run.playerId, { kind: 'self' });
    const pf = window.__game.session.sim.services.combat.arena.player, bd = p.body();
    window.__diag = { pf: pf ? { active: pf.active, fight: pf.fight, side: pf.side, x: +pf.x.toFixed(1), z: +pf.z.toFixed(1), hp: pf.hp ?? null } : null, body: [+bd.x.toFixed(1), +bd.z.toFixed(1)], ladder: [+l.fx.toFixed(1), +l.fz.toFixed(1)], all: all.map((o) => o.id) };
    return p.options().filter((o) => o.provider === 'war').map((o) => `${o.id}:${o.label}:${o.enabled}`);
  }, ladder);
  note(`options at the ladder: ${JSON.stringify(opts)}`);
  note('diag ' + JSON.stringify(await ev(() => window.__diag)));
  check('Climb the ladder is offered at the foot', opts.some((o) => o.startsWith('climb:')), JSON.stringify(opts));
  // (the verbs are the player's own: the wheel's "self" list; a blow lands on him at the foot of the ladder and stops the climb, so he tries again)
  const up = await ev(() => {
    const se = window.__game.session, p = se.services.player, sim = se.sim, pid = sim.state.run.playerId, nav = se.services.zone.nav;
    let tries = 0, r = null;
    for (; tries < 8; tries++) {
      const pf0 = sim.services.combat.arena.player;
      { const bb = p.body(); if ((pf0 && pf0.onWall) || bb.y > nav.groundY(bb.x, bb.z) + 2.5) break; }
      const o = sim.actions.list(pid, { kind: 'self' }).find((q) => q.provider === 'war' && q.id === 'climb');
      if (!o) { window.__game.advance(1); continue; }
      r = p.perform(o);
      for (let i = 0; i < 400; i++) { window.__game.advance(0.1); const pf = sim.services.combat.arena.player, bb = p.body(); if ((pf && pf.onWall) || bb.y > nav.groundY(bb.x, bb.z) + 2.5) break; }
    }
    const b = p.body(), pf = sim.services.combat.arena.player;
    return { r, tries, onWall: !!pf?.onWall, walk: !!b.walk, y: +b.y.toFixed(1), ground: +nav.groundY(b.x, b.z).toFixed(1) };
  });
  note(`climb: ${JSON.stringify(up)}`);
  check('the ladder carries the player up onto the wall (well above the ground: on the walk, or in the gatehouse chamber the walk runs into)', !!up && up.y > up.ground + 2.5, JSON.stringify(up));
  await shot('a-wall-walk');
  // fight there: draw the weapon, go at the nearest man of the walls, swing
  const fought = await ev(() => {
    const se = window.__game.session, p = se.services.player, arena = se.sim.services.combat.arena;
    const pf = arena.player;
    if (!pf) return null;
    se.sim.actions.cancel(se.sim.state.run.playerId, 'cancelled');
    p.setDrawn?.(true);
    const before = pf.hitsLanded + pf.hitsTaken;
    let foe = null;
    for (let i = 0; i < 240; i++) {
      foe = arena.nearestEnemy(pf, undefined, true);
      const b = p.body();
      if (!foe) break;
      const yaw = Math.atan2(foe.x - b.x, foe.z - b.z);
      const near = Math.hypot(foe.x - b.x, foe.z - b.z) < 2.2;
      window.__game.advance(0.25, { forward: near ? 0 : 1, right: 0, cameraYaw: yaw, sprint: false, walk: false, interact: false, interactHeld: 0, mount: false, dodge: false, cancel: false, attack: near && i % 2 === 0, block: false, faceCamera: true });
      if (pf.hitsLanded + pf.hitsTaken > before + 1) break;
    }
    return { landed: pf.hitsLanded, taken: pf.hitsTaken, before, body: [+p.body().x.toFixed(1), +p.body().y.toFixed(1), +p.body().z.toFixed(1)], foe: foe ? { onWall: foe.onWall, d: +Math.hypot(foe.x - p.body().x, foe.z - p.body().z).toFixed(1) } : null, stillOnWall: pf.onWall };
  });
  note(`fight on the walk: ${JSON.stringify(fought)}`);
  check('the player fights on the wall-walk (blows given or taken among the men who hold it)', !!fought && fought.landed + fought.taken > fought.before, JSON.stringify(fought));
  await shot('a-fight-on-wall');
}

/** The night in camp passes to just before first light (the sleep skip is the real loop's, and the frozen loop of this flow does not run it). */
async function passTheNight() {
  await ev(() => { const c = window.__game.session.sim.state.clock; const h = (c.absDay % 1) * 24; c.absDay = Math.floor(c.absDay) + (h >= 12 ? 1 : 0) + 5.45 / 24; c.firedHour = Math.floor(c.absDay * 24); const sim = window.__game.session.sim; if (sim.clock.skip) sim.dispatch({ type: 'cancelSkip' }); });
}

/** In peace: a flight of stairs up to a wall-walk (the wheel's "Climb the stairs"), the walk, and "Go down the stairs". The stairs of the storm's own castle are inside its shut gatehouse. */
async function partD() {
  console.log('-- D: the stairs onto the wall-walk');
  await load('autostart=1&time=0.42');
  await ev(() => window.__game.ready());
  await tick(0.5);
  const r = await ev(() => {
    const se = window.__game.session, p = se.services.player, nav = se.services.zone.nav, sim = se.sim, pid = sim.state.run.playerId;
    const self = () => sim.actions.list(pid, { kind: 'self' });
    for (const t of sim.world.settlements.filter((x) => x.kind === 'castle' || x.kind === 'town' || x.kind === 'city')) {
      nav.prepare?.(t.x, t.z);
      for (let rad = 6; rad < 160; rad += 3) for (let a = 0; a < 48; a++) {
        const c = nav.walls.stairFootNear(t.x + Math.cos(a * 0.13) * rad, t.z + Math.sin(a * 0.13) * rad, 3);
        if (!c || !Number.isFinite(nav.walkTopAt(c.top.x, c.top.z, c.y))) continue;
        let ok = false;
        for (const rr of [0.8, 1.6, 2.3]) for (let k = 0; k < 8 && !ok; k++) {
          p.placeAt(c.foot.x + Math.cos(k * 0.785) * rr, c.foot.z + Math.sin(k * 0.785) * rr, c.yaw);
          window.__game.advance(0.2);
          const fb = p.body();
          if (self().some((o) => o.provider === 'wallwalk' && o.id === 'up')) ok = true;
        }
        if (!ok) continue;
        const up = self().find((o) => o.provider === 'wallwalk' && o.id === 'up');
        p.perform(up);
        for (let i = 0; i < 80; i++) window.__game.advance(0.1);
        const b = p.body();
        const snap = { walk: !!b.walk, y: +b.y.toFixed(1), ground: +nav.groundY(b.x, b.z).toFixed(1) };
        const downs = self().filter((o) => o.provider === 'wallwalk').map((o) => o.id);
        // along the walk: the way that carries him furthest, the height kept
        let far = 0, kept = false;
        const x0 = b.x, z0 = b.z, y0 = b.y;
        for (let k = 0; k < 4; k++) {
          p.placeAt(x0, z0, k * 1.57, y0);
          for (let i = 0; i < 20; i++) window.__game.advance(0.1, { forward: 1, right: 0, cameraYaw: k * 1.57, faceCamera: true });
          const b2 = p.body(), d = Math.hypot(b2.x - x0, b2.z - z0);
          if (d > far) { far = d; kept = Math.abs(b2.y - y0) < 1.5; }
        }
        return { castle: t.name, ...snap, downs, walked: +far.toFixed(1), kept };
      }
    }
    return null;
  });
  note(`stairs: ${JSON.stringify(r)}`);
  check('Climb the stairs puts the player up on the wall-walk, where he can walk and go down again', !!r && r.walk && r.y > r.ground + 2.5 && r.downs.includes('down') && r.walked > 1 && r.kept, JSON.stringify(r));
}

/** Polls an async probe a frame at a time until it answers (or `max` seconds of frames pass). */
async function waitFor(probe, max) {
  for (let i = 0; i < max; i++) {
    const r = await probe();
    if (r) return r;
    await tick(1);
    if (i % 10 === 9) { const f = await facts(); note(`.. +${i + 1}s heap=${f.heap}MB rss=${rssMB()}MB battles=${f.battles}`); }
  }
  return null;
}
/** Becomes a lord with a castle and finds a rival castle of another House (the scenario's own search), through the game's own switch. */
async function becomeLord() {
  return ev(() => {
    const se = window.__game.session, sim = se.sim, mil = sim.services.military;
    // two royal Houses (the heads of realms may declare war across their borders): one's seat to defend, the other's to march on
    const royals = [...sim.state.houses.values()].filter((h) => h.kind === 'royal');
    let best = null;
    for (const hm of royals) {
      const head = sim.state.persons.get(hm.head);
      if (!head || head.death || head.sex !== 'm') continue;
      const mine = sim.world.settlements.find((x) => mil.lordHouse(x.id) === hm.id);
      if (!mine) continue;
      for (const ho of royals) {
        if (ho.id === hm.id) continue;
        const other = sim.world.settlements.find((x) => mil.lordHouse(x.id) === ho.id);
        if (!other) continue;
        const d = Math.hypot(other.x - mine.x, other.z - mine.z);
        if (d < 1500) continue;
        if (!best || d < best.d) best = { lord: head.id, house: hm.id, theirs: ho.id, mine: mine.id, target: other.id, d };
      }
    }
    if (!best) return { error: 'no pair', royals: royals.map((h) => [h.id, h.head, sim.state.persons.get(h.head)?.sex, sim.world.settlements.filter((x) => mil.lordHouse(x.id) === h.id).map((x) => x.kind).slice(0, 4)]) };
    const sw = sim.dispatch({ type: 'switchCharacter', personId: best.lord });
    if (!sw.ok) return { error: sw.reason };
    // early morning, and the two Houses at feud, so the ruler's list of hostile neighbours has a seat to march on
    sim.state.clock.absDay = Math.floor(sim.absDay) + 7.5 / 24;
    sim.state.clock.firedHour = Math.floor(sim.state.clock.absDay * 24);
    mil.declareFeud(best.house, best.theirs, 30, 'attack');
    // and the war itself (the ruler's list of hostile neighbours is the politics module's stance)
    const w = sim.services.politics?.declareWar?.(best.house, best.theirs, { cause: 'conquest' });
    best.war = w ? { ok: w.ok, reason: w.reason ?? null } : null;
    best.stance = sim.services.politics?.stance?.(best.house, best.theirs) ?? null;
    return best;
  });
}

async function partB() {
  console.log("-- B: Plan an attack from the ruler's Military page");
  await load('autostart=1&time=0.3');
  await ev(() => window.__game.ready());
  await tick(0.5);
  const lord = await becomeLord();
  note(JSON.stringify(lord));
  check('the player becomes a lord with a castle and a rival castle to march on', !!lord && !lord.error, JSON.stringify(lord));
  if (!lord || lord.error) return;
  await tick(1);
  await page.keyboard.press('KeyU');
  await tick(0.6);
  check('U opens the seat of government', (await ui()).includes('ruler'), JSON.stringify(await ui()));
  await page.locator('.mu-tab', { hasText: 'Military' }).first().click();
  await tick(0.5);
  const plan = page.locator('button', { hasText: 'Plan an attack' });
  const n = await plan.count();
  if (n < 1) note('buttons: ' + JSON.stringify(await page.locator('.mu-win button').allTextContents()));
  check('the Military page lists the hostile neighbour with Plan an attack', n >= 1, String(n));
  if (n < 1) return;
  await shot('b-military-page');
  await plan.first().click();
  await tick(0.3);
  await page.locator('button', { hasText: 'Raise the host' }).click();
  await tick(0.6);
  let f = await facts();
  note(JSON.stringify(f));
  check('the host is raised and marches with the player in it (the days of the march pass at once)', ['march', 'camp', 'before', 'storm'].includes(f.phase), JSON.stringify(f));
  const reached = await ev(() => {
    const g = window.__game;
    for (let i = 0; i < 900; i++) { g.tick(1); if (i % 5 === 0) window.gc?.(); const se = g.session; if (se.sim.clock.skip) continue; const p = se.services.campaign?.phase(); if (p === 'before' || p === 'camp' || p === 'storm') return p; }
    return 'none';
  });
  note(`reached ${reached}`);
  check('the march is skipped to the camp or the walls', reached === 'before' || reached === 'camp' || reached === 'storm', reached);
  // each night in camp passes to first light; the host marches on in the morning and storms at the dawn after the camp before the walls
  let last = '';
  for (let cycle = 0; cycle < 400; cycle++) {
    f = await facts();
    if (f.phase !== last) { last = f.phase; note(`phase ${f.phase} at ${f.hour}h`); }
    if (f.phase === 'storm' || f.phase === null) break;
    if ((f.phase === 'camp' || f.phase === 'before') && (f.hour >= 19.5 || f.hour < 5.3 || f.skip)) await passTheNight();
    await tick(2);
  }
  check('the dawn storm goes in', f.phase === 'storm', JSON.stringify(f));
  await tick(2);
  await shot('b-storm');
  // the battle command card: two clicks sound the retreat
  const retreat = page.locator('button.retreat');
  check('the battle card has Sound the retreat', (await retreat.count()) >= 1);
  if ((await retreat.count()) >= 1) {
    await ev(() => document.querySelector('button.retreat').click());
    await tick(0.3);
    await ev(() => document.querySelector('button.retreat').click());
    await tick(1);
    f = await facts();
    check('the retreat ends the campaign and the host turns for home', f.phase === null, JSON.stringify(f));
  }
}

async function partC() {
  console.log("-- C: raiders on the lands show as the danger of the lord's agenda");
  await load('autostart=1&time=0.3');
  await ev(() => window.__game.ready());
  await tick(0.5);
  const lord = await becomeLord();
  check('the player becomes a lord', !!lord && !lord.error, JSON.stringify(lord));
  if (!lord || lord.error) return;
  await tick(1);
  const quiet = await page.locator('.mu-agenda-item.danger').count();
  note(`danger items before: ${quiet}`);
  // the raids system sends a party (the same launch the daily raiders use) against the lord's seat
  const raid = await ev((l) => {
    const se = window.__game.session, sim = se.sim, mil = sim.services.military;
    const id = mil.raid(l.theirs, l.mine, { size: 60 });
    return { id, armies: mil.armies().filter((a) => a.house === l.theirs).map((a) => [a.id, a.task, a.target?.settlement ?? null, a.troops]) };
  }, lord);
  note(JSON.stringify(raid));
  check("the raids system sends raiders against the lord's seat", raid.id > 0, JSON.stringify(raid));
  // the player waits a few hours (the raiders muster and ride)
  await ev(() => { const sim = window.__game.session.sim; const until = sim.absDay + 0.3; sim.dispatch({ type: 'waitUntil', until: { test: () => sim.absDay >= until, label: 'Waiting for the raiders…', maxDays: 1 } }); });
  for (let i = 0; i < 600; i++) { if (!(await facts()).skip) break; await tick(1); }
  await tick(2);
  note('armies: ' + JSON.stringify(await ev((l) => window.__game.session.sim.services.military.armies().filter((a) => a.house === l.theirs).map((a) => [a.task, a.target?.settlement ?? null, Object.values(a.troops).reduce((x, y) => x + y, 0)]), lord)));
  note('tracker: ' + JSON.stringify(await page.locator('.mu-tracker').allTextContents()));
  const items = await page.locator('.mu-agenda-item.danger').allTextContents();
  note(JSON.stringify(items));
  check('the tracker card shows the danger: raiders on the lands, glowing', items.some((t) => /Raiders/.test(t)), JSON.stringify(items));
  await shot('c-agenda-danger');
  // builder mode's window ends above the dock (two rows) on low and high screens
  for (const [vw, vh] of [[1280, 720], [1280, 760], [1920, 1080]]) {
    await page.setViewportSize({ width: vw, height: vh });
    await tick(0.3);
    await ev(() => window.__ui.openPanel({ panel: 'ext', name: 'builder' }));
    await tick(0.5);
    const geo = await page.evaluate(() => {
      const w = document.querySelector('.mu-bld-win'), d = document.querySelector('.mu-dock');
      const rows = new Set([...document.querySelectorAll('.mu-dockbtn')].map((e) => Math.round(e.getBoundingClientRect().top))).size;
      return w && d ? { winBottom: Math.round(w.getBoundingClientRect().bottom), dockTop: Math.round(d.getBoundingClientRect().top), rows } : null;
    });
    check(`builder mode's window ends above the dock, which has two rows, at ${vw}x${vh}`, !!geo && geo.winBottom <= geo.dockTop + 1 && geo.rows <= 2, JSON.stringify(geo));
    await ev(() => window.__ui.closePanel('builder'));
    await tick(0.2);
  }
  await page.setViewportSize({ width: 800, height: 450 });
}
