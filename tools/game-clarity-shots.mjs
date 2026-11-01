// Screenshots of the clarity pass (CLARITY §2, §3, §5, §6): the objective tracker, the compass ribbon, the minimap,
// "What now?", the settlement banner, the tooltip that follows the free cursor, the journal, the day summary and the
// intro. Starts Vite on :5181, plays a real run in headless Chromium (software GL: slow but correct) with the real
// objectives module and saves docs/game/*.png (`-1920` etc. is added to the name for other sizes).
//
//   node tools/game-clarity-shots.mjs                      # everything, at 1280x720
//   node tools/game-clarity-shots.mjs hud hover            # selected shots
//   node tools/game-clarity-shots.mjs --size=1920x1080 --seed=abc
//   node tools/game-clarity-shots.mjs --fake               # the UI's stand-in objectives (`?fakeobjectives=1`) instead of the module
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'docs/game');
const PORT = 5181;
const args = process.argv.slice(2);
const opt = (name, def) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : def; };
const seed = opt('seed', 'millennia');
const quality = opt('quality', 'medium');
const [W, H] = opt('size', '1280x720').split('x').map(Number);
const suffix = opt('suffix', W === 1280 ? '' : `-${W}`);
const real = !args.includes('--fake');
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
page.on('console', (m) => { const t = m.text(); if (m.type() === 'error' || m.type() === 'warning') { if (!/GPU stall|ReadPixels|WebGL/.test(t)) console.log(`[browser ${m.type()}] ${t}`); } });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));

const base = `http://localhost:${PORT}/?seed=${encodeURIComponent(seed)}&quality=${quality}&shots=1${real ? '' : '&fakeobjectives=1'}`;

async function load(extra) {
  const t0 = Date.now();
  await page.goto(`${base}&${extra}`, { timeout: 120000 });
  await page.waitForFunction(() => window.__game !== undefined, null, { timeout: 300000, polling: 250 });
  await page.evaluate(() => window.__game.ready());
  await page.evaluate(() => window.__game.freeze(true));
  await page.evaluate(() => window.__game.host.setSettings({ hints: false }));
  console.log(`run ready in ${((Date.now() - t0) / 1000).toFixed(1)} s (${extra})`);
}

async function shot(name, { settle = true } = {}) {
  if (settle) await page.evaluate(() => window.__game.settle());
  await page.evaluate(() => window.__game.draw());
  await page.waitForTimeout(150);
  const file = resolve(OUT, `${name}${suffix}.png`);
  await page.screenshot({ path: file });
  console.log(`${name}${suffix}: ${Math.round(statSync(file).size / 1024)} KB`);
}

const advance = (seconds, input = {}) => page.evaluate(([s, i]) => window.__game.advance(s, i), [seconds, input]);
const ui = (fn, arg) => page.evaluate(fn, arg);
/** A few UI frames with the world held still (the HUD repaints in its own loop). */
const frames = (n = 4) => page.evaluate((k) => window.__game.frames(k), n);

/** Screen position (client px) of a world point, or null. */
const project = (x, y, z) => page.evaluate(([a, b, c]) => window.__game.session.controls.project(a, b, c), [x, y, z]);

/** Turns the character and the camera to face `yaw` (radians, 0 = +z). */
const face = (yaw) => page.evaluate((y) => {
  const s = window.__game.session; const p = s.services.player; const b = p.body();
  p.placeAt(b.x, b.z, y);
  const r = s.renderer; const d = Math.atan2(Math.sin(y - r.getCameraYaw()), Math.cos(y - r.getCameraYaw()));
  r.orbit(d, 0);
}, yaw);

/** Moves the real mouse over a point on the screen (the input layer sees real events) and lets the UI settle. */
async function hoverAt(x, y) {
  await page.mouse.move(x - 8, y - 8);
  await page.mouse.move(x, y, { steps: 4 });
  await page.waitForTimeout(700);
  await frames(6);
}

/** The nearest on-screen thing of a kind, as a client position: { x, y, label } or null. */
const findOnScreen = (kind) => page.evaluate((k) => {
  const g = window.__game; const s = g.session; const sim = s.sim; const z = s.services.zone; const p = s.services.player; const b = p.body();
  const project = (x, y, zz) => s.controls.project(x, y, zz);
  const W = window.innerWidth, H = window.innerHeight;
  // clear of the corner plates and the right-hand column (about 380 px wide at any size) and of the compass and the dock
  const ok = (pt) => pt && pt.x > 420 && pt.x < W - 420 && pt.y > 130 && pt.y < H - 160;
  if (k === 'person') {
    const list = [...z.agents()].filter((a) => a.visible && a.personId !== sim.state.run.playerId).sort((u, v) => Math.hypot(u.x - b.x, u.z - b.z) - Math.hypot(v.x - b.x, v.z - b.z));
    for (const a of list) { const pt = project(a.x, a.y + 0.7, a.z); if (ok(pt) && Math.hypot(a.x - b.x, a.z - b.z) < 30) return { x: pt.x, y: pt.y }; }
  }
  if (k === 'building') {
    const near = sim.world.nearestSettlement(b.x, b.z);
    const list = (sim.state.buildingsAt.get(near.id) ?? []).filter((q) => q.kind !== 'well' && q.kind !== 'market_stall').sort((u, v) => Math.hypot(u.x - b.x, u.z - b.z) - Math.hypot(v.x - b.x, v.z - b.z));
    for (const q of list) { const pt = project(q.x, sim.world.heightAt(q.x, q.z) + 2.5, q.z); if (ok(pt) && Math.hypot(q.x - b.x, q.z - b.z) > 6 && Math.hypot(q.x - b.x, q.z - b.z) < 60) return { x: pt.x, y: pt.y }; }
  }
  if (k === 'strip') {
    const near = sim.world.nearestSettlement(b.x, b.z);
    const cand = [];
    const hh = sim.state.persons.get(sim.state.run.playerId).household;
    for (const id of near.strips) {
      const st = sim.world.strips.find((q) => q.id === id);
      const cx = st.poly.reduce((a, q) => a + q.x, 0) / 4, cz = st.poly.reduce((a, q) => a + q.z, 0) / 4;
      const pt = project(cx, sim.world.heightAt(cx, cz), cz);
      // the family's own strips first, then whatever is nearest the middle of the screen
      if (ok(pt) && Math.hypot(cx - b.x, cz - b.z) < 70) cand.push({ x: pt.x, y: pt.y, off: Math.hypot(pt.x - W / 2, pt.y - H * 0.5) + (sim.state.strips.get(id)?.holder === hh ? 0 : 400) });
    }
    cand.sort((u, v) => u.off - v.off);
    if (cand.length) return { x: cand[0].x, y: cand[0].y };
  }
  if (k === 'tree') {
    const cs = 64;
    const cand = [];
    for (let cz = Math.floor((b.z - 60) / cs); cz <= Math.floor((b.z + 60) / cs); cz++) for (let cx = Math.floor((b.x - 60) / cs); cx <= Math.floor((b.x + 60) / cs); cx++) {
      for (const it of sim.world.scatterInChunk(cx, cz)) {
        if (!['oak', 'beech', 'ash', 'birch'].includes(it.kind)) continue;
        const d = Math.hypot(it.x - b.x, it.z - b.z);
        if (d < 6 || d > 60) continue;
        const pt = project(it.x, sim.world.heightAt(it.x, it.z) + 2.0, it.z);
        if (ok(pt)) cand.push({ x: pt.x, y: pt.y, off: Math.hypot(pt.x - W / 2, pt.y - H * 0.5) });
      }
    }
    cand.sort((u, v) => u.off - v.off);
    if (cand.length) return { x: cand[0].x, y: cand[0].y };
  }
  if (k === 'ground') {
    for (const [fx, fy] of [[0.5, 0.78], [0.45, 0.7], [0.55, 0.74]]) { const gp = s.renderer.screenToGround(W * fx, H * fy); if (gp) return { x: W * fx, y: H * fy }; }
  }
  return null;
}, kind);

try {
  await load('autostart=1&time=0.33');
  await advance(1.5);
  const info = await page.evaluate(() => { const b = window.__game.session.services.player.body(); return { x: b.x, z: b.z, yaw: b.yaw }; });
  console.log('player at', JSON.stringify(info));

  if (want('hud')) await shot('clarity-hud');

  if (want('whatnow')) {
    await ui(() => window.__ui.toggleWhatNow?.());
    await frames(6);
    await shot('clarity-whatnow', { settle: false });
    await ui(() => window.__ui.toggleWhatNow?.());
    await frames(3);
  }

  if (want('banner')) {
    await ui(() => window.__ui.showBanner?.());
    await page.waitForTimeout(900);
    await frames(4);
    await shot('clarity-banner', { settle: false });
    await page.waitForTimeout(6500);
  }

  if (want('hover')) {
    for (const kind of ['person', 'building', 'strip', 'tree', 'ground']) {
      if (kind === 'person') {
        // stand a few metres from the nearest grown villager and face them (at this hour most are out of sight)
        const who = await page.evaluate(() => {
          const s = window.__game.session; const sim = s.sim; const z = s.services.zone; const p = s.services.player;
          const b = p.body();
          const list = [...z.agents()].filter((a) => a.personId !== sim.state.run.playerId && a.draw?.kind !== 'child' && Math.hypot(a.x - b.x, a.z - b.z) >= 3)
            .sort((u, v) => Math.hypot(u.x - b.x, u.z - b.z) - Math.hypot(v.x - b.x, v.z - b.z));
          const a = list[0];
          if (!a) return null;
          const dx = b.x - a.x, dz = b.z - a.z; const d = Math.hypot(dx, dz) || 1;
          const yaw = Math.atan2(-dx, -dz);
          p.placeAt(a.x + (dx / d) * 5, a.z + (dz / d) * 5, yaw);
          const r = s.renderer; r.orbit(Math.atan2(Math.sin(yaw - r.getCameraYaw()), Math.cos(yaw - r.getCameraYaw())), 0);
          return { id: a.personId, d: Math.round(d) };
        });
        console.log('person spot:', JSON.stringify(who));
        await advance(0.3);
        await page.evaluate(() => window.__game.settle());
        await page.evaluate(() => window.__game.draw());
      }
      if (kind === 'strip') {
        // walk out to the family's strip (or any strip of the village) and look at it
        const spot = await page.evaluate(() => {
          const s = window.__game.session; const sim = s.sim; const p = s.services.player;
          const me = sim.state.persons.get(sim.state.run.playerId); const hh = me.household;
          const mine = sim.world.strips.filter((q) => sim.state.strips.get(q.id)?.holder === hh);
          const near = sim.world.nearestSettlement(p.body().x, p.body().z);
          const st = mine[0] ?? sim.world.strips.find((q) => q.id === near.strips[Math.floor(near.strips.length / 2)]);
          if (!st) return null;
          const cx = st.poly.reduce((a, q) => a + q.x, 0) / 4, cz = st.poly.reduce((a, q) => a + q.z, 0) / 4;
          const b = p.body();
          const dx = b.x - cx, dz = b.z - cz; const d = Math.hypot(dx, dz) || 1;
          const yaw = Math.atan2(-dx, -dz);
          p.placeAt(cx + (dx / d) * 14, cz + (dz / d) * 14, yaw);
          const r = s.renderer; r.orbit(Math.atan2(Math.sin(yaw - r.getCameraYaw()), Math.cos(yaw - r.getCameraYaw())), 0);
          return { cx, cz, mine: mine.length > 0 };
        });
        console.log('strip spot:', JSON.stringify(spot));
        await advance(0.4);
        await page.evaluate(() => window.__game.settle());
        await page.evaluate(() => window.__game.draw());
      }
      const at = await findOnScreen(kind);
      if (!at) { console.log(`hover ${kind}: nothing on screen`); continue; }
      await hoverAt(at.x, at.y);
      const h = await page.evaluate(() => { const v = window.__game.session.services.player.hover?.(); return v ? { target: v.target, label: v.label, sub: v.sublabel, action: v.action, cursor: v.cursor, preview: v.preview } : null; });
      console.log(`hover ${kind}:`, JSON.stringify(h));
      const cur = await page.evaluate(() => document.getElementById('viewport').style.cursor);
      console.log(`   cursor: ${cur ? cur.slice(0, 40) + '…' : '(arrow)'}`);
      await shot(`clarity-hover-${kind}`, { settle: false });
      await page.mouse.move(W / 2, 60);
      await frames(3);
      if (kind === 'person') {
        // back to where the other shots were framed
        await page.evaluate((i) => {
          const s = window.__game.session; const p = s.services.player; p.placeAt(i.x, i.z, i.yaw);
          const r = s.renderer; r.orbit(Math.atan2(Math.sin(i.yaw - r.getCameraYaw()), Math.cos(i.yaw - r.getCameraYaw())), 0);
        }, info);
        await advance(0.3);
        await page.evaluate(() => window.__game.settle());
      }
    }
  }

  if (want('click')) {
    // click-to-act on the family's strip: the real mouse clicks it, the body walks there along the paths (the ring marks
    // where), and on arrival does what a click on it promises
    const spot = await page.evaluate(() => {
      const s = window.__game.session; const sim = s.sim; const p = s.services.player;
      const me = sim.state.persons.get(sim.state.run.playerId); const hh = me.household;
      const st = sim.world.strips.find((q) => sim.state.strips.get(q.id)?.holder === hh);
      if (!st) return null;
      const cx = st.poly.reduce((a, q) => a + q.x, 0) / 4, cz = st.poly.reduce((a, q) => a + q.z, 0) / 4;
      const b = p.body();
      const dx = b.x - cx, dz = b.z - cz; const d = Math.hypot(dx, dz) || 1;
      const yaw = Math.atan2(-dx, -dz);
      p.placeAt(cx + (dx / d) * 22, cz + (dz / d) * 22, yaw);
      const r = s.renderer; r.orbit(Math.atan2(Math.sin(yaw - r.getCameraYaw()), Math.cos(yaw - r.getCameraYaw())), 0);
      return { id: st.id };
    });
    console.log('click spot:', JSON.stringify(spot));
    if (spot) {
      await advance(0.4);
      await page.evaluate(() => window.__game.settle());
      await page.evaluate(() => window.__game.draw());
      const at = await findOnScreen('strip');
      if (at) {
        await page.mouse.move(at.x - 6, at.y - 6);
        await page.mouse.move(at.x, at.y, { steps: 3 });
        await page.waitForTimeout(500);
        await frames(4);
        await page.mouse.click(at.x, at.y);
        await advance(2.5);
        await frames(6);
        const going = await page.evaluate(() => window.__game.session.services.player.hud()?.going ?? null);
        console.log('click: going', JSON.stringify(going));
        await shot('clarity-click-walk', { settle: false });
        await advance(14);
        await frames(6);
        console.log('click: arrived, hud', JSON.stringify(await page.evaluate(() => { const h = window.__game.session.services.player.hud(); return h ? { going: h.going ?? null, action: h.action ?? null } : null; })));
        await shot('clarity-click-act', { settle: false });
      } else console.log('click: the strip is not on screen');
      await page.mouse.move(W / 2, 60);
      await page.evaluate((i) => {
        const s = window.__game.session; const p = s.services.player; p.cancelGoTo?.(); p.placeAt(i.x, i.z, i.yaw);
        const r = s.renderer; r.orbit(Math.atan2(Math.sin(i.yaw - r.getCameraYaw()), Math.cos(i.yaw - r.getCameraYaw())), 0);
      }, info);
      await advance(0.3);
    }
  }

  if (want('drawn')) {
    await page.keyboard.press('KeyG');
    await frames(8);
    await page.waitForTimeout(400);
    await shot('clarity-drawn', { settle: false });
    await page.keyboard.press('KeyG');
    await frames(4);
  }

  if (want('edge')) {
    // look away from the task: the arrow on the screen edge points back to it
    await face(info.yaw + 2.2);
    await advance(0.3);
    await frames(4);
    await shot('clarity-edge');
    await face(info.yaw);
    await advance(0.2);
  }

  if (want('journal')) {
    for (const tab of ['objectives', 'today', 'people', 'places']) {
      await ui((t) => window.__ui.openPanel({ panel: 'journal', tab: t }), tab);
      await page.waitForTimeout(500);
      await frames(3);
      await shot(`clarity-journal-${tab}`, { settle: false });
      await ui(() => window.__ui.closePanel('journal'));
      await page.waitForTimeout(250);
    }
  }

  if (want('intro')) {
    await ui(() => window.__ui.openPanel({ panel: 'intro' }));
    await page.waitForTimeout(600);
    await frames(4);
    await shot('clarity-intro', { settle: false });
    await ui(() => window.__ui.closePanel('intro'));
    await page.waitForTimeout(250);
  }

  if (want('tour')) {
    for (const [i, stop] of ['home', 'strip', 'church'].entries()) {
      await ui((n) => window.__ui.openPanel({ panel: 'tour', stop: n }), i);
      // the camera glides in over ~1.7 s of UI time; the stop is held until the panel closes
      await page.waitForTimeout(2300);
      await page.evaluate(() => window.__game.settle());
      await frames(4);
      await shot(`clarity-tour-${stop}`, { settle: false });
      await ui(() => window.__ui.closePanel('tour'));
      await page.waitForTimeout(400);
    }
  }
  if (want('daysummary')) {
    // the stand-in closes its day on request; the real module closes it when midnight passes (or the player sleeps) on a day
    // with something in it, so give the day something (a purse that grew, a skill that rose) and let midnight come. Last,
    // because it leaves the world at night.
    const stand = await ui(() => !!window.__game.session.services.objectives.endDay);
    if (stand) await ui(() => { const o = window.__game.session.services.objectives; o.advance?.(); o.advance?.(); o.endDay?.(); });
    else {
      await ui(() => {
        const sim = window.__game.session.sim; const me = sim.state.persons.get(sim.state.run.playerId);
        me.money += 6; me.skills.farming = (me.skills.farming ?? 0) + 45;
        sim.state.clock.absDay = Math.floor(sim.state.clock.absDay) + 0.9995;
      });
      await advance(3);
      // up at midnight the card is only offered (a toast); open it as the button would
      await ui(() => window.__ui.openPanel({ panel: 'daysummary' }));
    }
    await page.waitForTimeout(700);
    await frames(4);
    console.log('open panels:', JSON.stringify(await ui(() => window.__ui.openPanels())));
    await shot('clarity-daysummary', { settle: false });
    await ui(() => window.__ui.closePanel('daysummary'));
    await page.waitForTimeout(250);
  }
} catch (e) {
  console.log('SHOT ERROR', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  if (vite) { try { process.kill(-vite.pid, 'SIGTERM'); } catch { vite.kill('SIGTERM'); } }
}
