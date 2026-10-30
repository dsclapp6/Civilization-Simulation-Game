// Combat screenshots for visual review: starts Vite on :5391, plays staged fights in headless Chromium (WebGL2
// via SwiftShader: slow but correct) and saves docs/combat/<name>.png.
//
//   node tools/combat-shots.mjs                      # everything
//   node tools/combat-shots.mjs road wolves          # selected shots
//   node tools/combat-shots.mjs --quality=high --size=1600x900 --seed=abc
//
// Shots: road (a road fight with outlaws: swings, blocks, blood, a man down), wolves (wolves at night),
// archery (a longbow drawn and loosed, arrows in flight and standing in the ground), charge (a couched lance),
// armour (mail and plate against steel), wounds (the wounds panel after a fight), wheel (the Fight choice).
// The scenes are staged through `sim.services.combat` (debug.skirmish / arena.setKitOverride) and the sim is
// stepped with `window.__game.advance` so every shot is deterministic.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'docs/combat');
const PORT = 5391;
const args = process.argv.slice(2);
const opt = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const quality = opt('quality', 'medium');
const seed = opt('seed', 'millennia');
const [W, H] = opt('size', '1280x720').split('x').map(Number);
const wanted = args.filter((a) => !a.startsWith('--'));
const want = (...names) => wanted.length === 0 || names.some((n) => wanted.includes(n));

async function serverUp() {
  try { return (await fetch(`http://localhost:${PORT}/`)).ok; } catch { return false; }
}
/** The server on the port serves this checkout (it has the combat module). */
async function serverIsOurs() {
  try {
    const r = await fetch(`http://localhost:${PORT}/src/combat/arena.ts`);
    return r.ok && (await r.text()).includes('class Arena');
  } catch { return false; }
}
function startVite() {
  return new Promise((resolveStart, reject) => {
    const proc = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BROWSER: 'none' }, detached: true });
    let done = false;
    const onData = (d) => { if (!done && /Local:|ready in/i.test(d.toString())) { done = true; resolveStart(proc); } };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', (d) => { onData(d); if (/error/i.test(d.toString())) process.stderr.write(d); });
    proc.on('exit', (code) => { if (!done) reject(new Error(`vite exited (${code})`)); });
    setTimeout(() => { if (!done) { done = true; resolveStart(proc); } }, 20000);
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

const vite = await acquireServer();
console.log(vite ? 'vite started' : `reusing server on :${PORT}`);
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.setDefaultTimeout(0);
page.on('console', (m) => { const t = m.text(); if (t.startsWith('[millennia]') || t.startsWith('[combat]')) console.log(t); if (m.type() === 'error' || m.type() === 'warning') { if (!/GPU stall|ReadPixels|WebGL/.test(t)) console.log(`[browser ${m.type()}] ${t}`); } });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));

const base = `http://localhost:${PORT}/?seed=${encodeURIComponent(seed)}&quality=${quality}&shots=1`;

async function load(extra) {
  const t0 = Date.now();
  await page.goto(`${base}&${extra}`, { timeout: 120000 });
  await page.waitForFunction(() => window.__game !== undefined, null, { timeout: 300000, polling: 250 });
  await page.evaluate(() => window.__game.ready());
  await page.evaluate(() => window.__game.freeze(true));
  console.log(`run ready in ${((Date.now() - t0) / 1000).toFixed(1)} s (${extra})`);
}

/** Draws `n` frames (the particles age by 1/60 s per frame) and screenshots. */
async function shot(name, { settle = true, frames = 1 } = {}) {
  if (settle) await page.evaluate(() => window.__game.settle());
  await page.evaluate((n) => { for (let i = 0; i < n; i++) window.__game.draw(); }, frames);
  const file = resolve(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`${name}: ${Math.round(statSync(file).size / 1024)} KB`);
}

const advance = (seconds, input = {}) => page.evaluate(([s, i]) => window.__game.advance(s, i), [seconds, input]);
const zoom = (steps) => page.evaluate((n) => window.__game.session.renderer.zoom(n), steps);

/** Makes the camera (and the character) face `yaw`. */
const face = (yaw) => page.evaluate((y) => {
  const s = window.__game.session; const p = s.services.player; const b = p.body();
  p.placeAt(b.x, b.z, y);
  const r = s.renderer; const d = Math.atan2(Math.sin(y - r.getCameraYaw()), Math.cos(y - r.getCameraYaw()));
  r.orbit(d, 0);
}, yaw);

/** An open stretch of level ground near the player (a clearing, a field edge), returning its centre and a free heading. */
const clearing = () => page.evaluate(() => {
  const s = window.__game.session; const nav = s.services.zone.nav; const p = s.services.player; const b0 = p.body();
  const out = { x: 0, z: 0, blocked: false, wading: false };
  let best = null;
  for (let r = 60; r <= 260 && !best; r += 20) {
    for (let k = 0; k < 24 && !best; k++) {
      const a = (k / 24) * Math.PI * 2;
      const cx = b0.x + Math.sin(a) * r, cz = b0.z + Math.cos(a) * r;
      let ok = true; const h0 = nav.groundY(cx, cz); let hmin = h0, hmax = h0;
      for (let i = 0; i < 16 && ok; i++) {
        const q = (i / 16) * Math.PI * 2; const rr = i % 2 ? 9 : 18;
        const x = cx + Math.sin(q) * rr, z = cz + Math.cos(q) * rr;
        if (!nav.walkable(x, z)) ok = false;
        const h = nav.groundY(x, z); hmin = Math.min(hmin, h); hmax = Math.max(hmax, h);
      }
      if (ok && hmax - hmin < 1.6 && h0 > 1) best = { x: cx, z: cz };
    }
  }
  return best ?? { x: b0.x, z: b0.z };
});

const put = (x, z, yaw) => page.evaluate(([px, pz, py]) => { window.__game.session.services.player.placeAt(px, pz, py); }, [x, z, yaw]);

/** Gives the player a kit and the foes theirs, then raises the fight. Returns the fight id. */
const staged = (kind, count, me, foes) => page.evaluate(([k, n, mine, theirs]) => {
  const s = window.__game.session; const sim = s.sim; const combat = sim.services.combat; const pid = sim.state.run.playerId;
  const me = sim.state.persons.get(pid);
  // a grown, fit character for the screenshots
  me.trained.str = 13; me.trained.end = 12; me.trained.agi = 12; me.skills.melee = Math.max(me.skills.melee, 40);
  combat.arena.setKitOverride(pid, mine);
  const id = combat.debug.skirmish(k, n);
  const fight = combat.arena.fights.get(id);
  if (fight && theirs) for (const side of fight.sides) for (const f of side.members) if (f.person && f.personId !== pid) combat.arena.setKitOverride(f.personId, theirs);
  return id;
}, [kind, count, me, foes]);

const fighters = () => page.evaluate(() => {
  const a = window.__game.session.sim.services.combat.arena;
  return a.fighters.filter((f) => f.fight).map((f) => ({ id: f.key, st: f.st, hp: f.person ? f.person.health.hp : f.beastHp / f.beastMax, side: f.side }));
});


/** Sets the clock (season 0..3, day fraction 0..1) without firing the hooks. */
const setClock = (season, frac) => page.evaluate(([se, fr]) => {
  const c = window.__game.session.sim.state.clock;
  c.absDay = se * 4 + 1 + fr; c.firedHour = Math.floor(c.absDay * 24);
}, [season, frac]);

/** Steps in short slices and takes a shot whenever the fight has just drawn blood or sparks (up to `max` shots). */
async function shootHits(name, { slices = 40, step = 0.1, max = 6, input = () => ({}), gap = 3 } = {}) {
  let taken = 0, since = 99;
  for (let i = 0; i < slices && taken < max; i++) {
    await advance(step, input(i));
    since++;
    const fx = await page.evaluate(() => window.__game.session.sim.services.combat.arena.env.fx.size);
    if (fx > 0 && since >= gap) {
      taken++; since = 0;
      await shot(`${name}-${taken}`, { settle: false, frames: 3 });
    } else if (fx > 0) { /* drained by the next draw */ }
    if ((await fighters()).length === 0) break;
  }
  return taken;
}

/** The camera close behind the character, looking along the fight. */
const closeIn = (n) => zoom(n);

try {
  await load('autostart=1&time=0.42');
  const c = await clearing();
  console.log('clearing at', JSON.stringify(c));
  await put(c.x, c.z, 0.6);
  await face(0.6);
  await advance(0.5);

  // -------------------------------------------------------------------------------------------
  if (want('road')) {
    await closeIn(-1.2);
    const id = await staged('bandits', 3, { weapon: 'sword', shield: 'shield_heater', armour: ['padded_armour', 'cap_helmet'] }, { weapon: 'axe', armour: [] });
    console.log('fight', id);
    await advance(1.0, { block: true });
    await shot('road-1-approach', { settle: true });
    let k = 0;
    const n = await shootHits('road', { slices: 90, step: 0.1, max: 6, input: (i) => ({ attack: i % 9 === 2 || i % 9 === 3, block: i % 9 >= 6 }) });
    console.log('road shots', n, JSON.stringify(await fighters()));
  }

  // -------------------------------------------------------------------------------------------
  if (want('wolves')) {
    await advance(8, {});
    await setClock(3, 0.96);
    await closeIn(-0.4);
    await put(c.x, c.z, 2.2); await face(2.2);
    await advance(0.4);
    await staged('wolves', 3, { weapon: 'sword', armour: ['padded_armour'] }, null);
    await advance(1.6, { block: true });
    await shot('wolves-1', { settle: true });
    await shootHits('wolves', { slices: 90, step: 0.1, max: 5, input: (i) => ({ attack: i % 8 === 1 || i % 8 === 2, block: i % 8 >= 5 }) });
    console.log('wolves', JSON.stringify(await fighters()));
  }

  // -------------------------------------------------------------------------------------------
  if (want('armour')) {
    await advance(6, {});
    await setClock(0, 0.45);
    await put(c.x, c.z, 4.0); await face(4.0);
    await advance(0.4);
    await staged('bandits', 3, { weapon: 'sword', shield: 'shield_heater', armour: ['plate_harness', 'bascinet'] }, { weapon: 'mace', armour: ['mail_hauberk', 'kettle_hat'] });
    await advance(2.0, { block: true });
    await shot('armour-1', { settle: true });
    await shootHits('armour', { slices: 90, step: 0.1, max: 4, input: (i) => ({ attack: i % 8 === 1 || i % 8 === 2, block: i % 8 >= 5 }) });
  }

  // -------------------------------------------------------------------------------------------
  if (want('archery')) {
    await advance(6, {});
    await put(c.x, c.z, 1.0); await face(1.0);
    await advance(0.4);
    await page.evaluate(() => {
      const s = window.__game.session; const sim = s.sim; const combat = sim.services.combat; const pid = sim.state.run.playerId;
      const me = sim.state.persons.get(pid); me.trained.str = 13; me.trained.per = 13; me.skills.archery = 90;
      combat.arena.setKitOverride(pid, { weapon: 'dagger', ranged: 'longbow', armour: [] });
      const b = s.services.player.body();
      const id = combat.debug.skirmish('bandits', 3);
      const fight = combat.arena.fights.get(id);
      for (const side of fight.sides) for (const f of side.members) if (f.personId !== pid) {
        combat.arena.setKitOverride(f.personId, { weapon: 'dagger', ranged: 'shortbow', armour: [] });
        f.preferRanged = true; f.shotsLeft = 20;
        f.x = b.x + Math.sin(b.yaw) * (24 + Math.random() * 4); f.z = b.z + Math.cos(b.yaw) * (24 + Math.random() * 4);
      }
    });
    const ray = () => page.evaluate(() => {
      const r = window.__game.session.renderer; const e = r.getCamera().matrixWorld.elements;
      const l = Math.hypot(-e[8], -e[9], -e[10]);
      return { x: e[12], y: e[13], z: e[14], dx: -e[8] / l, dy: -e[9] / l, dz: -e[10] / l };
    });
    await advance(0.4, { block: true, aim: await ray() });
    await shot('archery-1-draw', { settle: true });
    for (let i = 0; i < 6; i++) {
      await advance(1.0, { block: true, aim: await ray() });
      await advance(0.15, { block: true, attack: true, aim: await ray() });
      await advance(0.1, { block: true, aim: await ray() });
      await shot(`archery-${i + 2}`, { settle: false, frames: 2 });
    }
  }

  // -------------------------------------------------------------------------------------------
  if (want('charge')) {
    await advance(10, {});
    await put(c.x - 40, c.z - 30, 0.8); await face(0.8);
    await advance(0.4);
    await page.evaluate(() => window.__game.session.services.player.debug.forceMount(0x2a2220));
    await advance(2.2);
    await page.evaluate(() => {
      const s = window.__game.session; const sim = s.sim; const combat = sim.services.combat; const pid = sim.state.run.playerId;
      const me = sim.state.persons.get(pid); me.trained.str = 13; me.trained.agi = 12; me.skills.riding = 60;
      combat.arena.setKitOverride(pid, { weapon: 'lance', armour: ['mail_hauberk', 'kettle_hat'] });
      const b = s.services.player.body();
      const id = combat.debug.skirmish('bandits', 3);
      const fight = combat.arena.fights.get(id);
      let i = 0;
      for (const side of fight.sides) for (const f of side.members) if (f.personId !== pid) {
        combat.arena.setKitOverride(f.personId, { weapon: 'spear', armour: ['padded_armour'] });
        f.x = b.x + Math.sin(b.yaw) * 46 + Math.cos(b.yaw) * (i - 1) * 3; f.z = b.z + Math.cos(b.yaw) * 46 - Math.sin(b.yaw) * (i - 1) * 3; i++;
      }
    });
    const yaw = await page.evaluate(() => window.__game.session.services.player.body().yaw);
    await advance(1.5, { forward: 1, sprint: true, attack: true, cameraYaw: yaw });
    await shot('charge-1', { settle: true });
    for (let i = 0; i < 5; i++) {
      await advance(0.7, { forward: 1, sprint: true, attack: true, cameraYaw: yaw });
      await shot(`charge-${i + 2}`, { settle: false, frames: 2 });
    }
  }

  // -------------------------------------------------------------------------------------------
  if (want('wounds', 'wheel')) {
    await advance(6, {});
    await page.evaluate(() => {
      const s = window.__game.session; const sim = s.sim; const combat = sim.services.combat; const pid = sim.state.run.playerId;
      const me = sim.state.persons.get(pid);
      const mk = (location, kind, severity, extra = {}) => ({ location, kind, severity, bleeding: false, rate: 0, fracture: false, mortal: false, stun: 0, damage: severity * 70, ...extra });
      combat.book.inflict(me, mk('arm_l', 'cut', 0.34, { bleeding: true, rate: 0.0035 }), 'axe');
      combat.book.inflict(me, mk('leg_r', 'blunt', 0.5, { fracture: true }), 'cudgel');
      combat.book.inflict(me, mk('torso', 'arrow', 0.3, { bleeding: true, rate: 0.002 }), 'longbow');
      combat.book.advance(me, 30);
      sim.events.emit('ui', { panel: 'ext', name: 'wounds', id: pid });
    });
    await page.waitForTimeout(700);
    await shot('wounds', { settle: false });
  }
} finally {
  await browser.close();
  if (vite) { try { process.kill(-vite.pid, 'SIGTERM'); } catch { vite.kill('SIGTERM'); } }
}
