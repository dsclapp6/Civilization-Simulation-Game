// Game screenshots for visual review: starts Vite on :5177, plays through the main situations of the game in
// headless Chromium (WebGL2 via SwiftShader — slow but correct) and saves docs/game/<name>.png.
//
//   node tools/game-shots.mjs                       # everything
//   node tools/game-shots.mjs village prompt map    # selected shots
//   node tools/game-shots.mjs --quality=high --size=1600x900 --seed=abc --devzone
//
// Shots (in order): menu, run-start (difficulty, shop), loading, village, street, prompt, wheel, action, riding,
// gallop, map, travel, encounter, death, successor. The game is driven through the
// developer hooks on `window.__game` (src/app/game.ts), with the real-time loop frozen so every shot is
// deterministic. `--devzone` adds stand-in villagers and a horse (use it only while the real agents module
// is not in the build); without it the shots show the real village life.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'docs/game');
const PORT = 5177;
const args = process.argv.slice(2);
const opt = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const quality = opt('quality', 'medium');
const seed = opt('seed', 'millennia');
const [W, H] = opt('size', '1280x720').split('x').map(Number);
const devzone = args.includes('--devzone');
// the text HUD stands in for the real UI (only for builds without it)
const hud = args.includes('--hud');
const wanted = args.filter((a) => !a.startsWith('--'));
const want = (...names) => wanted.length === 0 || names.some((n) => wanted.includes(n));

// ---------------------------------------------------------------------------------------------
// Vite
// ---------------------------------------------------------------------------------------------

async function serverUp() {
  try { return (await fetch(`http://localhost:${PORT}/`)).ok; } catch { return false; }
}

/** A server on the port that serves this repo's game (not another checkout's). */
async function serverIsOurs() {
  try {
    const r = await fetch(`http://localhost:${PORT}/src/app/game.ts`);
    return r.ok && (await r.text()).includes('__game');
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
    if (await serverIsOurs()) { await new Promise((r) => setTimeout(r, 1500)); if (await serverIsOurs()) return null; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`port ${PORT} is busy with another server`);
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const vite = await acquireServer();
console.log(vite ? 'vite started' : `reusing server on :${PORT}`);
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.setDefaultTimeout(0);
page.on('console', (m) => { const t = m.text(); if (t.startsWith('[millennia]')) console.log(t); if (m.type() === 'error' || m.type() === 'warning') { if (!/GPU stall|ReadPixels|WebGL/.test(t)) console.log(`[browser ${m.type()}] ${t}`); } });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));

const base = `http://localhost:${PORT}/?seed=${encodeURIComponent(seed)}&quality=${quality}&shots=1${hud ? '&hud=1' : ''}${devzone ? '&devzone=1' : ''}`;

async function load(extra) {
  const t0 = Date.now();
  await page.goto(`${base}&${extra}`, { timeout: 120000 });
  await page.waitForFunction(() => window.__game !== undefined, null, { timeout: 300000, polling: 250 });
  await page.evaluate(() => window.__game.ready());
  await page.evaluate(() => window.__game.freeze(true));
  console.log(`run ready in ${((Date.now() - t0) / 1000).toFixed(1)} s (${extra})`);
}

/** Lets the renderer finish streaming and camera transitions, then screenshots. */
async function shot(name, { settle = true } = {}) {
  if (settle) await page.evaluate(() => window.__game.settle());
  await page.evaluate(() => window.__game.draw());
  const file = resolve(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`${name}: ${Math.round(statSync(file).size / 1024)} KB`);
}

const advance = (seconds, input = {}) => page.evaluate(([s, i]) => window.__game.advance(s, i), [seconds, input]);
const state = () => page.evaluate(() => {
  const s = window.__game.session; const p = s.services.player; const h = p.hud();
  return { body: p.body(), prompt: h?.prompt?.label ?? null, action: h?.action?.label ?? null, travel: p.travel()?.phase ?? null, mounted: !!h?.mounted, mode: s.sim.view.mode(), speed: s.sim.clock.speed };
});

/** Turns the character and the camera to face `yaw` (radians, 0 = +z). */
const face = (yaw) => page.evaluate((y) => {
  const s = window.__game.session; const p = s.services.player; const b = p.body();
  p.placeAt(b.x, b.z, y);
  const r = s.renderer; const d = Math.atan2(Math.sin(y - r.getCameraYaw()), Math.cos(y - r.getCameraYaw()));
  r.orbit(d, 0);
  return y;
}, yaw);

/** The heading with the most open ground ahead of the character (probing the zone's navigation). */
const openHeading = () => page.evaluate(() => {
  const s = window.__game.session; const nav = s.services.zone.nav; const b = s.services.player.body();
  const out = { x: 0, z: 0, blocked: false, wading: false };
  let best = { yaw: b.yaw, free: 0 };
  for (let k = 0; k < 48; k++) {
    const yaw = (k / 48) * Math.PI * 2;
    let x = b.x, z = b.z, free = 0;
    for (let d = 0; d < 90; d++) {
      nav.move(x, z, Math.sin(yaw), Math.cos(yaw), 0.8, out);
      if (out.blocked || Math.hypot(out.x - x, out.z - z) < 0.5) break;
      x = out.x; z = out.z; free++;
    }
    if (free > best.free) best = { yaw, free };
  }
  return best;
});

const zoom = (steps) => page.evaluate((n) => window.__game.session.renderer.zoom(n), steps);

// ---------------------------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------------------------

try {
  if (want('menu', 'run-start', 'loading')) {
    await page.goto(`${base}`, { timeout: 120000 });
    await page.waitForFunction(() => window.__game !== undefined, null, { timeout: 300000, polling: 250 });
    await page.waitForTimeout(800);
    if (want('menu')) await shot('menu', { settle: false });
    if (want('run-start')) {
      // the UI's own menu views, when it offers them (the placeholder UI has none)
      const views = await page.evaluate(() => typeof window.__ui?.showMenu === 'function');
      if (views) {
        for (const v of ['difficulty', 'shop']) {
          await page.evaluate((view) => window.__ui.showMenu(view), v);
          await page.waitForTimeout(400);
          await shot(`run-start-${v}`, { settle: false });
        }
      }
    }
    if (want('loading')) {
      // the loading screen: start a run and look while the continent is being raised
      await page.evaluate(() => { void window.__game.host.startNewRun({ difficulty: 'knight', statUpgrades: {} }); });
      await page.waitForTimeout(300);
      await shot('loading', { settle: false });
    }
  }

  if (want('village', 'street', 'prompt', 'wheel', 'action', 'riding', 'gallop')) {
    await load('autostart=1&time=0.42');
    const t = await page.evaluate(() => {
      const s = window.__game.session; const prof = s.sim.scheduler.profile;
      return { agents: s.services.zone.agents().length, animals: s.services.zone.animals().length, stats: s.renderer.stats() };
    });
    console.log(`scene: ${t.agents} agents, ${t.animals} animals, ${t.stats.drawCalls} draw calls`);
    if (want('village')) await shot('village');
    const open = await openHeading();
    console.log(`open ground: ${open.free} m along yaw ${open.yaw.toFixed(2)}`);

    if (want('street')) {
      await face(open.yaw);
      await advance(2.4, { forward: 1 });
      await shot('street');
      await advance(1.6, { forward: 1, sprint: true });
      await shot('street-sprint');
    }

    if (want('prompt', 'wheel')) {
      // stand in front of the nearest person
      const found = await page.evaluate(() => {
        const s = window.__game.session; const z = s.services.zone; const p = s.services.player; const b = p.body();
        const a = [...z.agents()].sort((u, v) => Math.hypot(u.x - b.x, u.z - b.z) - Math.hypot(v.x - b.x, v.z - b.z))[0];
        if (!a) return null;
        const dx = b.x - a.x, dz = b.z - a.z; const d = Math.hypot(dx, dz) || 1;
        const yaw = Math.atan2(-dx, -dz);
        p.placeAt(a.x + (dx / d) * 1.7, a.z + (dz / d) * 1.7, yaw);
        return yaw;
      });
      if (found !== null) {
        await face(found);
        await zoom(-2);
        await advance(0.6);
        console.log('prompt:', JSON.stringify((await state()).prompt));
        await shot('prompt');
        if (want('wheel')) {
          await page.evaluate(() => window.__ui.openPanel({ panel: 'actions' }));
          await page.waitForTimeout(400);
          await shot('wheel', { settle: false });
          await page.evaluate(() => window.__ui.closePanel('actions'));
        }
        await zoom(2);
      } else console.log('prompt: nobody around (run with --devzone while the agents module is not built)');
    }

    if (want('action')) {
      // work on whatever can be worked on, in progress: try a few spots until the prompt offers a timed action
      const ok = await page.evaluate(() => {
        const g = window.__game; const s = g.session; const p = s.services.player; const w = s.sim.world;
        const b = p.body(); const home = w.nearestSettlement(b.x, b.z);
        const spots = [{ x: b.x + Math.sin(b.yaw) * 7, z: b.z + Math.cos(b.yaw) * 7 }];
        for (const id of home.strips.slice(0, 8)) { const st = w.strips.find((q) => q.id === id); if (st) spots.push({ x: (st.poly[0].x + st.poly[2].x) / 2, z: (st.poly[0].z + st.poly[2].z) / 2 }); }
        for (const sp of spots) {
          p.placeAt(sp.x, sp.z, b.yaw);
          g.advance(0.5);
          const o = p.options().find((q) => q.enabled && q.seconds > 0);
          if (o) return o.label;
        }
        return null;
      });
      console.log('action option:', ok);
      if (ok) {
        await zoom(-2);
        await advance(0.1, { interact: true });
        await advance(3.4);
        console.log('action:', JSON.stringify(await state()));
        await shot('action');
        await advance(0.1, { cancel: true });
        await zoom(2);
      }
    }

    if (want('riding', 'gallop')) {
      const open2 = await openHeading();
      await face(open2.yaw);
      const ok = await page.evaluate(() => {
        const s = window.__game.session; const z = s.services.zone; const p = s.services.player; const b = p.body();
        const h = z.animals().find((a) => a.kind === 'horse');
        if (h) { p.placeAt(h.x - Math.cos(b.yaw) * 1.4, h.z + Math.sin(b.yaw) * 1.4, b.yaw); return true; }
        p.debug?.forceMount(); return false;
      });
      if (ok) {
        const o2 = await openHeading();
        await face(o2.yaw);
        await advance(0.3);
        await advance(0.1, { mount: true });
      }
      await advance(2.6);
      await advance(2.4, { forward: 1 });
      if (want('riding')) await shot('riding');
      if (want('gallop')) {
        await advance(1.4, { forward: 1, sprint: true });
        await shot('gallop');
      }
    }
  }

  if (want('map', 'travel', 'encounter', 'death', 'successor')) {
    await load('autostart=1&time=0.42');
    if (want('map')) {
      // the UI's own map panel (it puts the camera on the map and lists the places)
      await page.evaluate(() => {
        const s = window.__game.session; const b = s.services.player.body();
        window.__ui.openPanel({ panel: 'map' });
        s.controls.focusMap(b.x, b.z, 6500);
      });
      await advance(0.1);
      await page.waitForTimeout(500);
      await shot('map');
      await page.evaluate(() => { window.__ui.closePanel('map'); });
    }
    if (want('travel', 'encounter')) {
      const dest = await page.evaluate(() => {
        const s = window.__game.session; const w = s.sim.world; const b = s.services.player.body();
        const c = w.settlements.filter((x) => { const d = Math.hypot(x.x - b.x, x.z - b.z); return d > 2500 && d < 6000; })
          .sort((u, v) => Math.hypot(u.x - b.x, u.z - b.z) - Math.hypot(v.x - b.x, v.z - b.z))[0];
        return c ? c.id : -1;
      });
      const res = await page.evaluate((d) => window.__game.session.services.player.travelTo(d), dest);
      console.log('travelTo', dest, JSON.stringify(res));
      for (let i = 0; i < 9; i++) {
        await advance(10);
        const t = await page.evaluate(() => {
          const p = window.__game.session.services.player; const tr = p.travel();
          if (tr?.phase === 'encounter') { p.perform(p.options().find((o) => o.enabled)); return 'encounter'; }
          return tr?.phase ?? null;
        });
        if (t === 'encounter') console.log('(an encounter came up on the way and was settled)');
      }
      console.log('travel:', JSON.stringify(await state()));
      if (want('travel')) await shot('travel');
      if (want('encounter')) {
        await page.evaluate(() => window.__game.session.services.player.debug.forceEncounter('bandits'));
        await advance(0.2);
        await page.evaluate(() => window.__game.session.sim.state.persons.get(window.__game.session.sim.state.run.playerId).money = 160);
        await shot('encounter');
      }
    }
    if (want('death', 'successor')) {
      await load('autostart=1&time=0.42&seed=' + encodeURIComponent(seed));
      await page.evaluate(() => window.__game.killPlayer());
      await advance(2.2);
      if (want('death')) await shot('death');
      if (want('successor')) {
        const heir = await page.evaluate(() => {
          const s = window.__game.session; const e = s.sim.state.run.pendingSuccession?.eligible ?? [];
          return e[0] ?? -1;
        });
        if (heir > 0) {
          await page.evaluate((id) => window.__game.session.sim.dispatch({ type: 'switchCharacter', personId: id }), heir);
          await advance(0.1);
          await page.evaluate(() => window.__game.session.renderer.render(window.__game.session.sim.view, 0.25));
          await shot('successor-rise', { settle: false });
          await advance(2.5);
          await shot('successor');
        } else console.log('successor: nobody eligible');
      }
    }
  }
} finally {
  await browser.close();
  if (vite) { try { process.kill(-vite.pid, 'SIGTERM'); } catch { vite.kill('SIGTERM'); } }
}
