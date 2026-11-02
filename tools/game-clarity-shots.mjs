// Screenshots of the clarity pass (CLARITY §2, §3, §5, §6): the objective tracker, the compass ribbon, the minimap,
// "What now?", the settlement banner, the tooltip that follows the free cursor, the journal, the day summary and the
// intro. Starts Vite on :5181, plays a real run in headless Chromium (software GL: slow but correct) with the real
// objectives module and saves docs/game/*.png (`-1920.jpg` etc. for other sizes).
//
//   node tools/game-clarity-shots.mjs                      # everything, at 1280x720
//   node tools/game-clarity-shots.mjs hud hover            # selected shots
//   node tools/game-clarity-shots.mjs --size=1920x1080 --seed=abc
//   node tools/game-clarity-shots.mjs --fake               # the UI's stand-in objectives (`?fakeobjectives=1`) instead of the module
//   node tools/game-clarity-shots.mjs lives --out=docs/ui  # civilization pass, B6: living as anyone, quest marks, steps, wounds, the accolade (docs/ui/lives-*.png)
//   PORT=5190 node …                                       # another port (a private Vite server of this worktree)
//   --format=jpg                                           # JPEG shots even at 1280x720 (what docs/ui/lives-*.jpg are)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 5181);
const args = process.argv.slice(2);
const opt = (name, def) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : def; };
// `--out=docs/ui` for the shots of the civilization pass's lives UI (the clarity shots go to docs/game)
const OUT = resolve(ROOT, opt('out', 'docs/game'));
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
  // 1280x720 is the reference set (lossless); other sizes (and `--format=jpg`) are saved as JPEG (quality 90) to keep the folder small
  const jpeg = W !== 1280 || H !== 720 || opt('format', 'png') === 'jpg';
  const file = resolve(OUT, `${name}${suffix}.${jpeg ? 'jpg' : 'png'}`);
  await (jpeg ? page.screenshot({ path: file, type: 'jpeg', quality: 90 }) : page.screenshot({ path: file }));
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
    // the family's own strip first: any screen point whose ground point lies inside it (so the pitch of the camera does not matter),
    // nearest the middle of the screen; else a strip of the place near the middle
    const hh = sim.state.persons.get(sim.state.run.playerId).household;
    const inside = (x, zz, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { if ((poly[i].z > zz) !== (poly[j].z > zz) && x < ((poly[j].x - poly[i].x) * (zz - poly[i].z)) / (poly[j].z - poly[i].z) + poly[i].x) c = !c; } return c; };
    const mine = sim.world.strips.filter((q) => sim.state.strips.get(q.id)?.holder === hh);
    let best = null;
    // not on the player's own body (the pick would find them): clear of where they stand on the screen
    const me3 = project(b.x, sim.world.heightAt(b.x, b.z) + 1, b.z);
    for (let fy = 0.25; fy <= 0.8; fy += 0.04) for (let fx = 0.36; fx <= 0.64; fx += 0.04) {
      const x = W * fx, y = H * fy;
      if (me3 && Math.abs(x - me3.x) < 110 && Math.abs(y - me3.y) < 150) continue;
      const g = s.renderer.screenToGround(x, y);
      if (!g) continue;
      const own = mine.some((q) => inside(g.x, g.z, q.poly));
      const off = Math.hypot(x - W / 2, y - H * 0.55) + (own ? 0 : 1000);
      if (own && (!best || off < best.off)) best = { x, y, off };
    }
    if (best) return { x: best.x, y: best.y };
    const near = sim.world.nearestSettlement(b.x, b.z);
    const cand = [];
    for (const id of near.strips) {
      const st = sim.world.strips.find((q) => q.id === id);
      const n = st.poly.length;
      const cx = st.poly.reduce((a, q) => a + q.x, 0) / n, cz = st.poly.reduce((a, q) => a + q.z, 0) / n;
      const pt = project(cx, sim.world.heightAt(cx, cz), cz);
      if (ok(pt) && Math.hypot(cx - b.x, cz - b.z) < 70) cand.push({ x: pt.x, y: pt.y, off: Math.hypot(pt.x - W / 2, pt.y - H * 0.5) });
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

  if (want('click')) {
    // click-to-act on the person the first task points at: the real mouse clicks them, the body walks there along the
    // paths (a ring marks where), and on arrival does what a click on them promises (a conversation opens)
    let at = null, who = null;
    for (const dist of [11, 8, 14, 6, 17]) {
      who = await page.evaluate((dd) => {
        const s = window.__game.session; const sim = s.sim; const z = s.services.zone; const p = s.services.player;
        const o = s.services.objectives.tracked?.();
        const step = o?.steps.find((x) => !x.done);
        let a = step?.target?.kind === 'person' ? z.agent(step.target.id) : null;
        const b = p.body();
        if (!a) a = [...z.agents()].filter((q) => q.personId !== sim.state.run.playerId && Math.hypot(q.x - b.x, q.z - b.z) >= 3).sort((u, v) => Math.hypot(u.x - b.x, u.z - b.z) - Math.hypot(v.x - b.x, v.z - b.z))[0] ?? null;
        if (!a) return null;
        const dx = b.x - a.x, dz = b.z - a.z; const d = Math.hypot(dx, dz) || 1;
        const ux = d < 1 ? 0 : dx / d, uz = d < 1 ? 1 : dz / d;
        const yaw = Math.atan2(-ux, -uz);
        p.placeAt(a.x + ux * dd, a.z + uz * dd, yaw);
        const r = s.renderer; r.orbit(Math.atan2(Math.sin(yaw - r.getCameraYaw()), Math.cos(yaw - r.getCameraYaw())), 0);
        return { id: a.personId };
      }, dist);
      if (!who) break;
      await advance(0.3);
      await page.evaluate(() => window.__game.settle());
      await page.evaluate(() => window.__game.draw());
      at = await page.evaluate(([id, w, h]) => {
        const s = window.__game.session; const a = s.services.zone.agent(id);
        const pt = a ? s.controls.project(a.x, a.y + 0.65, a.z) : null;
        // clear of the plates, the compass and the dock
        return pt && pt.x > 420 && pt.x < w - 420 && pt.y > 130 && pt.y < h - 160 ? pt : null;
      }, [who.id, W, H]);
      if (at) { console.log('click target:', JSON.stringify(who), 'at', dist, 'm'); break; }
    }
    if (who && at) {
      await hoverAt(at.x, at.y);
      await page.mouse.click(at.x, at.y);
      await advance(2);
      await frames(6);
      console.log('click: going', JSON.stringify(await page.evaluate(() => window.__game.session.services.player.hud()?.going ?? null)));
      await shot('clarity-click-walk', { settle: false });
      await advance(9);
      await frames(8);
      console.log('click: open panels', JSON.stringify(await ui(() => window.__ui.openPanels())));
      await shot('clarity-click-act', { settle: false });
      for (const id of await ui(() => window.__ui.openPanels())) await ui((x) => window.__ui.closePanel(x), id);
      await page.waitForTimeout(300);
    } else console.log('click: nobody to click on screen');
    await page.mouse.move(150, 300);
    await page.evaluate((i) => {
      const s = window.__game.session; const p = s.services.player; p.cancelGoTo?.(); p.placeAt(i.x, i.z, i.yaw);
      const r = s.renderer; r.orbit(Math.atan2(Math.sin(i.yaw - r.getCameraYaw()), Math.cos(i.yaw - r.getCameraYaw())), 0);
    }, info);
    await advance(0.3);
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
      if (kind === 'tree') {
        // stand ten metres from the nearest broadleaf tree and face it
        const t = await page.evaluate(() => {
          const s = window.__game.session; const sim = s.sim; const p = s.services.player; const b = p.body();
          const cs = 64; let best = null; let bd = Infinity;
          for (let cz = Math.floor((b.z - 90) / cs); cz <= Math.floor((b.z + 90) / cs); cz++) for (let cx = Math.floor((b.x - 90) / cs); cx <= Math.floor((b.x + 90) / cs); cx++) {
            for (const it of sim.world.scatterInChunk(cx, cz)) {
              if (!['oak', 'beech', 'ash', 'birch'].includes(it.kind)) continue;
              const d = Math.hypot(it.x - b.x, it.z - b.z);
              if (d > 14 && d < bd) { bd = d; best = it; }
            }
          }
          if (!best) return null;
          const dx = b.x - best.x, dz = b.z - best.z; const d = Math.hypot(dx, dz) || 1;
          const yaw = Math.atan2(-dx, -dz);
          p.placeAt(best.x + (dx / d) * 10, best.z + (dz / d) * 10, yaw);
          const r = s.renderer; r.orbit(Math.atan2(Math.sin(yaw - r.getCameraYaw()), Math.cos(yaw - r.getCameraYaw())), 0);
          return { kind: best.kind, d: Math.round(d) };
        });
        console.log('tree spot:', JSON.stringify(t));
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
      await page.mouse.move(150, 300);
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

  if (want('find')) {
    // "Find" on a place in the journal's Places page: the module marks it (compass, minimap, a beacon in the world); seen from afar
    const f = await page.evaluate(() => {
      const s = window.__game.session; const o = s.services.objectives; const p = s.services.player;
      const places = o.places?.() ?? [];
      const church = places.find((q) => /church|chapel/i.test(q.label)) ?? places[1];
      if (!church || !o.trackPlace) return null;
      o.trackPlace(church);
      const b = p.body(); const dx = b.x - church.x, dz = b.z - church.z; const d = Math.hypot(dx, dz) || 1;
      const yaw = Math.atan2(-dx, -dz);
      p.placeAt(church.x + (dx / d) * 75, church.z + (dz / d) * 75, yaw);
      const r = s.renderer; r.orbit(Math.atan2(Math.sin(yaw - r.getCameraYaw()), Math.cos(yaw - r.getCameraYaw())), 0);
      return { label: church.label };
    });
    console.log('find:', JSON.stringify(f));
    if (f) {
      await advance(0.6);
      await page.evaluate(() => window.__game.settle());
      await frames(6);
      await shot('clarity-find');
      await ui(() => window.__ui.openPanel({ panel: 'journal', tab: 'places' }));
      await page.waitForTimeout(500);
      await frames(3);
      await shot('clarity-journal-places-found', { settle: false });
      await ui(() => window.__ui.closePanel('journal'));
      await page.waitForTimeout(250);
      await page.evaluate((i) => {
        const s = window.__game.session; s.services.objectives.trackPlace?.(null);
        const p = s.services.player; p.placeAt(i.x, i.z, i.yaw);
        const r = s.renderer; r.orbit(Math.atan2(Math.sin(i.yaw - r.getCameraYaw()), Math.cos(i.yaw - r.getCameraYaw())), 0);
      }, info);
      await advance(0.3);
    }
  }

  if (want('beacon')) {
    // the tracked task's marker seen from a distance: the beacon in the world, the gold disc on the compass, the dot on the minimap
    const m = await page.evaluate(() => {
      const s = window.__game.session; const p = s.services.player;
      const mk = (s.sim.view.worldMarkers?.() ?? []).find((q) => q.primary);
      if (!mk) return null;
      const b = p.body(); const dx = b.x - mk.x, dz = b.z - mk.z; const d = Math.hypot(dx, dz) || 1;
      const yaw = Math.atan2(-dx, -dz);
      p.placeAt(mk.x + (dx / d) * 45, mk.z + (dz / d) * 45, yaw);
      const r = s.renderer; r.orbit(Math.atan2(Math.sin(yaw - r.getCameraYaw()), Math.cos(yaw - r.getCameraYaw())), 0);
      return { label: mk.label, kind: mk.kind };
    });
    console.log('beacon:', JSON.stringify(m));
    if (m) {
      await advance(0.6);
      await page.evaluate(() => window.__game.settle());
      await frames(6);
      await shot('clarity-beacon');
      await page.evaluate((i) => {
        const s = window.__game.session; const p = s.services.player; p.placeAt(i.x, i.z, i.yaw);
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
  if (want('lives')) {
    const person = (not = [], k = 0) => page.evaluate(([skip, k]) => {
      // the k-th nearest villager in view that is not one of `skip`, 6 m ahead of the player, who faces them
      const g = window.__game; const se = g.session; const z = se.services.zone; const p = se.services.player; const b = p.body(); const me = se.sim.state.run.playerId;
      const a = [...z.agents()].filter((x) => x.visible && x.personId !== me && !skip.includes(x.personId)).sort((u, v) => Math.hypot(u.x - b.x, u.z - b.z) - Math.hypot(v.x - b.x, v.z - b.z))[k];
      if (!a) return null;
      const dx = b.x - a.x, dz = b.z - a.z; const d = Math.hypot(dx, dz) || 1;
      const yaw = Math.atan2(-dx, -dz);
      p.placeAt(a.x + (dx / d) * 6, a.z + (dz / d) * 6, yaw);
      const r = se.renderer; r.orbit(Math.atan2(Math.sin(yaw - r.getCameraYaw()), Math.cos(yaw - r.getCameraYaw())), 0);
      return { id: a.personId, name: se.sim.state.persons.get(a.personId).first };
    }, [not, k]);
    const frame = async () => { await advance(0.4); await page.evaluate(() => window.__game.settle()); await page.evaluate(() => window.__game.draw()); };
    // a villager the real mouse is over (the first of the nearest few with a clear view of them, clear of the plates), the world held still
    const hovered = async (not = []) => {
      for (let k = 0; k < 8; k++) {
        const a = await person(not, k);
        if (!a) return null;
        await frame();
        const at = await page.evaluate(([id, w, h]) => {
          const s = window.__game.session; const x = s.services.zone.agent(id);
          const pt = x ? s.controls.project(x.x, x.y + 0.65, x.z) : null;
          return pt && pt.x > 420 && pt.x < w - 420 && pt.y > 130 && pt.y < h - 160 ? pt : null;
        }, [a.id, W, H]);
        if (!at) continue;
        await hoverAt(at.x, at.y);
        await page.evaluate(() => window.__game.tick(0.02));
        const hv = await page.evaluate(() => { const h = window.__game.session.services.player.hover?.(); return h && h.target.kind === 'person' ? h.target.id : null; });
        if (hv === a.id) return { ...a, at };
      }
      return null;
    };
    const tickUi = (sec) => page.evaluate((n) => window.__game.tick(n), sec);
    const close = async () => { for (const id of [...(await ui(() => window.__ui.openPanels()))].reverse()) await ui((x) => window.__ui.closePanel(x), id); await page.waitForTimeout(250); };

    // the plain HUD: the dock now has the builder's and ruler's buttons (B, U)
    await shot('lives-hud');

    // ---- quest marks: a gold "!" and a silver "?", the compass, the minimap's dots, the hover card's words
    const a = await hovered();
    if (a) {
      await page.evaluate(([id]) => {
        const se = window.__game.session; const z = se.services.zone; const o = se.services.objectives; const me = se.sim.state.run.playerId; const b = se.services.player.body();
        const other = [...z.agents()].filter((x) => x.personId !== me && x.personId !== id && Math.hypot(x.x - b.x, x.z - b.z) > 8).sort((u, v) => Math.hypot(u.x - b.x, u.z - b.z) - Math.hypot(v.x - b.x, v.z - b.z))[0];
        const nm = (pid) => se.sim.state.persons.get(pid).first;
        const list = [{ person: id, kind: 'quest', text: `${nm(id)} wants 7 bundles of firewood`, objective: 1 }];
        if (other) list.push({ person: other.personId, kind: 'turnin', text: `Hand the firewood to ${nm(other.personId)}`, objective: 1 });
        o.marks = () => list;
        z.setQuestMarks(list.map((m) => ({ person: m.person, kind: m.kind })));
      }, [a.id]);
      await tickUi(0.05); // the zone takes the marks at its next step
      await page.waitForTimeout(900); // and the HUD reads the words twice a second
      await frames(6);
      await shot('lives-marks', { settle: false });
      await page.mouse.move(150, 300);
      await ui(() => window.__ui.openPanel({ panel: 'journal', tab: 'objectives' }));
      await page.waitForTimeout(600);
      await frames(3);
      await shot('lives-marks-journal', { settle: false });
      await close();
      await page.evaluate(() => { const se = window.__game.session; se.services.zone.setQuestMarks([]); se.services.objectives.marks = () => []; });
    } else console.log('lives: nobody under the mouse for the marks');

    // ---- hands-on work: the bar says which step the bout is at
    await page.evaluate(() => {
      const se = window.__game.session; const sm = se.sim; const me = sm.state.run.playerId;
      sm.actions.register({
        id: 'shots.forge',
        list(_c, _a, target, out) {
          if (target.kind !== 'self') return;
          out.push({ id: 'forge.shots', provider: '', label: 'Forge a sword', category: 'work', target, enabled: true, seconds: 14, range: 99, priority: 1, anim: 'work_hammer', mainHand: 'hammer',
            steps: [{ share: 0.25, label: 'Heat the bar', sfx: 'bellows' }, { share: 0.4, label: 'Draw it out', sfx: 'hammer' }, { share: 0.15, label: 'Quench', sfx: 'quench' }, { share: 0.2, label: 'Grind and hilt', sfx: 'grind' }] });
        },
        complete() { return { ok: true, message: 'You forge a sword.' }; },
      });
      sm.actions.start(me, sm.actions.list(me, { kind: 'self' }).find((o) => o.id === 'forge.shots'));
    });
    await tickUi(6.5);
    await frames(3);
    await shot('lives-steps');
    await page.evaluate(() => { const sm = window.__game.session.sim; sm.actions.cancel(sm.state.run.playerId); });
    await tickUi(0.4);

    // ---- the action wheel with an icon per option
    const wheel = await page.evaluate(() => {
      const se = window.__game.session; const me = se.sim.state.persons.get(se.sim.state.run.playerId); const z = se.services.zone; const p = se.services.player; const b = p.body();
      const pet = [...z.animals()].filter((q) => q.owner === me.household && ['pig', 'sheep', 'goat', 'cow', 'ox', 'horse'].includes(q.kind)).sort((u, v) => Math.hypot(u.x - b.x, u.z - b.z) - Math.hypot(v.x - b.x, v.z - b.z))[0];
      if (!pet) return null;
      const dx = b.x - pet.x, dz = b.z - pet.z; const d = Math.hypot(dx, dz) || 1;
      p.placeAt(pet.x + (dx / d) * 1.2, pet.z + (dz / d) * 1.2, Math.atan2(-dx, -dz));
      return { kind: pet.kind };
    });
    if (wheel) {
      await advance(0.5);
      await ui(() => window.__ui.open({ panel: 'actions' }));
      await page.waitForTimeout(500);
      await frames(3);
      const labels = await page.locator('.mu-wheel-label').allTextContents();
      console.log('lives: wheel on a', wheel.kind, JSON.stringify(labels));
      await shot('lives-wheel', { settle: false });
      await close();
    } else {
      // no animal of the household in the zone: the wheel on a person (with *Live as …* and an icon on every option), one in the open
      // (a door near them would be the thing in front of you)
      let w = null;
      for (let k = 0; k < 8 && !w; k++) {
        const got = await page.evaluate((k) => {
          const se = window.__game.session; const z = se.services.zone; const p = se.services.player; const b = p.body(); const sm = se.sim; const me = sm.state.run.playerId;
          const bl = sm.state.buildingsAt.get(sm.world.nearestSettlement(b.x, b.z).id) ?? [];
          const doorDist = (x, zz) => Math.min(...bl.map((q) => Math.hypot(q.x - x, q.z - zz)), 1e9);
          const x = [...z.agents()].filter((q) => q.visible && q.personId !== me).sort((u, v) => doorDist(v.x, v.z) - doorDist(u.x, u.z))[k];
          if (!x) return null;
          const dx = b.x - x.x, dz = b.z - x.z; const d = Math.hypot(dx, dz) || 1;
          p.placeAt(x.x + (dx / d) * 1.0, x.z + (dz / d) * 1.0, Math.atan2(-dx, -dz));
          const r = se.renderer; const yaw = Math.atan2(-dx, -dz); r.orbit(Math.atan2(Math.sin(yaw - r.getCameraYaw()), Math.cos(yaw - r.getCameraYaw())), 0);
          return { id: x.personId, name: sm.state.persons.get(x.personId).first };
        }, k);
        if (!got) break;
        await advance(0.15);
        const tgt = await page.evaluate(() => { const t = window.__game.session.services.player.target(); return t && t.target.kind === 'person' ? t.target.id : null; });
        if (tgt === got.id) w = got;
      }
      if (w) {
        await ui(() => window.__ui.open({ panel: 'actions' }));
        await page.waitForTimeout(500);
        await frames(3);
        console.log('lives: wheel on', w.name, JSON.stringify(await page.locator('.mu-wheel-label').allTextContents()));
        await shot('lives-wheel', { settle: false });
        await close();
      } else console.log('lives: nobody near for the wheel');
    }

    // ---- wounds: the mark on the plate, the page of the character sheet
    await page.evaluate(() => {
      const se = window.__game.session; const sm = se.sim; const combat = sm.services.combat; const me = sm.state.persons.get(sm.state.run.playerId);
      const mk = (location, kind, severity, extra = {}) => ({ location, kind, severity, bleeding: false, rate: 0, fracture: false, mortal: false, stun: 0, damage: severity * 70, ...extra });
      // a boy's health is about 60: hurt, not dead
      combat.book.inflict(me, mk('arm_l', 'cut', 0.22, { bleeding: true, rate: 0.0035 }), 'axe');
      combat.book.inflict(me, mk('leg_r', 'blunt', 0.25, { fracture: true }), 'cudgel');
      combat.book.inflict(me, mk('torso', 'arrow', 0.1), 'longbow');
    });
    await tickUi(0.6);
    await frames(3);
    await shot('lives-wound-mark', { settle: false });
    await ui(() => window.__ui.openPanel({ panel: 'character', tab: 'wounds' }));
    await page.waitForTimeout(600);
    await frames(3);
    await shot('lives-wounds-tab', { settle: false });
    await close();

    // ---- the accolade, and "Sir …" on the plate
    await page.evaluate(() => {
      const sm = window.__game.session.sim; const me = sm.state.persons.get(sm.state.run.playerId);
      me.sex = 'm'; me.career = 'knight'; me.estate = 'noble'; me.rankTier = 5; sm.state.touch(me);
      sm.state.log(sm.absDay, 'career', `${me.first} has been knighted by his liege.`, [me.id, me.id]);
      sm.events.emit('careerChanged', { person: me.id, from: 'squire', to: 'knight', stage: 2 });
    });
    await tickUi(0.4);
    await page.waitForTimeout(6500); // the scene tells itself line by line
    await frames(3);
    await shot('lives-accolade', { settle: false });
    await close();
    await shot('lives-sir', { settle: false });

    // ---- living as someone: the card, the glide (mid-way), the "who you are now" card
    const vt = await hovered();
    if (vt) {
      await page.keyboard.press('KeyV');
      await page.waitForTimeout(500);
      await tickUi(0.2);
      console.log('lives: the card for', vt.name, JSON.stringify(await ui(() => window.__ui.openPanels())));
      await page.mouse.move(150, 300);
      await shot('lives-liveas', { settle: false });
      await page.getByRole('button', { name: /^Live as / }).last().click();
      await tickUi(0.15);
      // the camera glides: draw a few dozen frames of it
      await page.evaluate(() => { for (let i = 0; i < 40; i++) window.__game.draw(); });
      console.log('lives: switching', JSON.stringify(await ui(() => window.__ui.debugState().switching)));
      await shot('lives-glide', { settle: false });
      await tickUi(1.6);
      await page.evaluate(() => window.__game.settle());
      await page.waitForTimeout(400);
      await frames(3);
      await shot('lives-arrival');
    } else console.log('lives: nobody to live as in view');

    // ---- far away: the screen fades, the change is made at the black
    const far = await page.evaluate(() => {
      const se = window.__game.session; const w = se.sim.world; const b = se.services.player.body(); const me = se.sim.state.run.playerId;
      const home = se.sim.state.persons.get(me).settlement;
      const q = [...se.sim.state.persons.values()].find((x) => !x.death && x.id !== me && x.settlement !== home && w.settlements.find((s) => s.id === x.settlement) && Math.hypot(w.settlements.find((s) => s.id === x.settlement).x - b.x, w.settlements.find((s) => s.id === x.settlement).z - b.z) > 1500);
      return q ? q.id : null;
    });
    if (far) {
      await ui((id) => window.__ui.openPanel({ panel: 'ext', name: 'liveAs', id, data: { reason: 'choose' } }), far);
      await page.waitForTimeout(500);
      await frames(3);
      await shot('lives-liveas-far', { settle: false });
      // (the veil runs on the UI's own clock: the half-closed screen is the gallery's lives-fade; here the change is only made)
      await page.getByRole('button', { name: /^Live as / }).last().click();
      await page.waitForFunction(() => window.__ui.debugState().switching === 'idle', null, { timeout: 60000 });
      await tickUi(1.5);
    }

    // ---- death: family and House, people near, anyone alive
    await page.evaluate(() => window.__game.killPlayer());
    await tickUi(0.6);
    await page.waitForTimeout(600);
    await frames(3);
    await shot('lives-death', { settle: false });
    const q = await page.evaluate(() => {
      const sm = window.__game.session.sim; const run = sm.state.run;
      const dead = sm.state.persons.get(run.pendingSuccession.person); const kin = new Set(run.pendingSuccession.eligible);
      const p = [...sm.state.persons.values()].find((x) => !x.death && !kin.has(x.id) && x.id !== dead.id && x.settlement !== dead.settlement && x.first.length > 4);
      return p ? p.first.slice(0, 3).toLowerCase() : 'smith';
    });
    await page.locator('.mu-succ-search input').fill(q);
    await tickUi(0.3);
    await page.locator('.mu-succ-list .mu-succ.compact').first().click();
    await frames(3);
    await shot('lives-death-search', { settle: false });
    await page.getByRole('button', { name: /Carry on as/ }).click();
    await tickUi(2);
    await frames(3);
    await shot('lives-after-death');
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
