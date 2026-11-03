// Interiors screenshots (docs/INTERIORS.md): doors opening, walking through a cottage, a townhouse upstairs, the manor hall, the
// church, a workshop, a keep's stair and the wall-walk, by day and at night. Vite on a private port, headless Chromium, the game
// driven through `window.__game` with the real-time loop frozen. Saves docs/interiors/<name>.png.
//
//   PORT=5191 node tools/interiors-shots.mjs                 # everything
//   PORT=5191 node tools/interiors-shots.mjs cottage church  # selected shots
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'docs/interiors');
const PORT = Number(process.env.PORT ?? 5191);
const args = process.argv.slice(2);
const wanted = args.filter((a) => !a.startsWith('--'));
const want = (...n) => wanted.length === 0 || n.some((x) => wanted.includes(x));
const seed = (args.find((a) => a.startsWith('--seed=')) ?? '--seed=millennia').slice(7);

function startVite() {
  return new Promise((ok, bad) => {
    const proc = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BROWSER: 'none' }, detached: true });
    let done = false;
    const on = (d) => { if (!done && /Local:|ready in/i.test(d.toString())) { done = true; ok(proc); } };
    proc.stdout.on('data', on);
    proc.stderr.on('data', on);
    proc.on('exit', (c) => { if (!done) bad(new Error(`vite exited ${c}`)); });
    setTimeout(() => { if (!done) { done = true; ok(proc); } }, 20000);
  });
}

const vite = await startVite();
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(0);
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') console.log(`[browser] ${m.text()}`); });

async function load(time) {
  await page.goto(`http://localhost:${PORT}/?seed=${seed}&quality=medium&shots=1&autostart=1&time=${time}`, { timeout: 120000 });
  await page.waitForFunction(() => window.__game !== undefined, null, { timeout: 300000, polling: 250 });
  await page.evaluate(() => window.__game.ready());
  await page.evaluate(() => window.__game.freeze(true));
  await page.evaluate(() => window.__game.host.setSettings({ hints: false }));
  // helpers in the page
  await page.evaluate(() => {
    const G = window.__game;
    const S = () => G.session;
    const zone = () => S().services.zone;
    const ix = () => zone().nav.interiors;
    window.__ix = {
      /** The nearest building of these kinds (with an inside) to the player, or to (x, z). */
      find(kinds, x, z, skip = 0) {
        const st = S().sim.state;
        const b0 = S().services.player.body();
        const fx = x ?? b0.x, fz = z ?? b0.z;
        const list = [...st.buildings.values()].filter((b) => kinds.includes(b.kind) && b.construction >= 1 && b.damage < 0.5)
          .sort((a, c) => Math.hypot(a.x - fx, a.z - fz) - Math.hypot(c.x - fx, c.z - fz));
        let n = 0;
        for (const b of list) { const l = ix().placed(b); if (l && l.plan.main >= 0) { if (n++ >= skip) return { id: b.id, kind: b.kind, level: b.level, culture: b.culture, x: b.x, z: b.z }; } }
        return null;
      },
      /** Stand at a door (the main one by default), `back` m out, facing in; the camera behind. */
      atDoor(id, back = 1.6, door = -1) {
        const st = S().sim.state;
        const b = st.buildings.get(id);
        // the household lets the visitor in (night shots)
        zone().doors.invite(st.run.playerId, id, S().sim.absDay + 1);
        const l = ix().placed(b);
        const d = l.plan.doors[door < 0 ? l.plan.main : door];
        const loc = { x: d.x + d.nx * back, z: d.z + d.nz * back };
        const w = ix().toWorld(l, loc.x, loc.z, { x: 0, z: 0 });
        const yaw = Math.atan2(-d.nx, -d.nz) + l.rot;
        S().services.player.placeAt(w.x, w.z, yaw, d.sy > 0.5 ? l.y + d.sy : undefined);
        window.__ix.camera(yaw);
        return { yaw };
      },
      /** Put the player at a local point of a building's plan at a level, facing `lyaw` (local). */
      at(id, lx, lz, level, lyaw = Math.PI) {
        const b = S().sim.state.buildings.get(id);
        zone().doors.invite(S().sim.state.run.playerId, id, S().sim.absDay + 1);
        const l = ix().placed(b);
        const w = ix().toWorld(l, lx, lz, { x: 0, z: 0 });
        const yaw = lyaw + l.rot;
        S().services.player.placeAt(w.x, w.z, yaw, l.y + l.plan.levels[level].y);
        window.__ix.camera(yaw);
        return { yaw, y: l.y + l.plan.levels[level].y };
      },
      camera(yaw, pitch) {
        const r = S().renderer;
        const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
        r.orbit(wrap(yaw - r.getCameraYaw()), 0);
        if (pitch !== undefined) r.orbit(0, pitch);
      },
      plan(id) { const b = S().sim.state.buildings.get(id); const l = ix().placed(b); return l ? { levels: l.plan.levels, stairs: l.plan.stairs, rooms: l.plan.rooms.map((r) => ({ name: r.name, level: r.level, x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1 })), main: l.plan.main, doors: l.plan.doors.map((d) => ({ x: d.x, z: d.z, y: d.y, outer: d.outer, kind: d.kind })) } : null; },
      where() { const b = S().services.player.body(); const id = zone().nav.interiorAt(b.x, b.z, b.y); return { x: b.x, y: b.y, z: b.z, inside: id }; },
      teleport(x, z) { S().services.player.placeAt(x, z, 0); },
      castle() {
        const w = S().sim.world;
        const p = S().services.player.body();
        const cs = w.settlements.filter((s) => s.kind === 'castle').sort((a, c) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(c.x - p.x, c.z - p.z));
        return cs[0] ? { x: cs[0].x, z: cs[0].z, name: cs[0].name } : null;
      },
    };
  });
}

const shot = async (name) => {
  await page.evaluate(() => window.__game.settle());
  await page.evaluate(() => window.__game.draw());
  await page.screenshot({ path: resolve(OUT, `${name}.png`) });
  console.log(`  ${name}.png`, JSON.stringify(await page.evaluate(() => window.__ix.where())));
};
const advance = (s, input = {}) => page.evaluate(([t, i]) => window.__game.advance(t, i), [s, input]);
const ev = (fn, ...a) => page.evaluate(fn, ...a);

try {
  for (const [time, tag] of [[0.45, 'day'], [0.93, 'night']]) {
    if (!wanted.length || wanted.some((w) => !w.endsWith('-day') && !w.endsWith('-night')) || wanted.some((w) => w.endsWith(tag))) await load(time);
    else continue;
    console.log(`${tag}:`);
    if (want('door', `door-${tag}`)) {
      const b = await ev(() => window.__ix.find(['cottage', 'hovel', 'longhouse']));
      if (b) {
        const st = await ev((id) => window.__ix.atDoor(id, 2.4), b.id);
        await ev((y) => window.__ix.camera(y + 0.7, 0.25), st.yaw);
        await advance(0.6);
        // walk into the door: it opens before him
        await advance(1.1, { forward: 1, cameraYaw: st.yaw });
        await shot(`door-opening-${tag}`);
        await advance(1.4, { forward: 1, cameraYaw: st.yaw });
        await shot(`door-through-${tag}`);
      }
    }
    if (want('cottage', `cottage-${tag}`)) {
      const b = await ev(() => window.__ix.find(['cottage']));
      if (b) {
        const st = await ev((id) => window.__ix.atDoor(id, 1.2), b.id);
        await advance(2.6, { forward: 1, cameraYaw: st.yaw });
        await advance(0.5);
        await shot(`cottage-${tag}`);
      }
    }
    if (want('townhouse', `townhouse-${tag}`)) {
      const b = await ev(() => window.__ix.find(['townhouse']));
      if (b) {
        const p = await ev((id) => window.__ix.plan(id), b.id);
        const st = p.stairs.find((s) => s.from === 0);
        if (st) {
          // to the foot of the stair, and up it
          const footX = st.axis === 'x' ? (st.dir > 0 ? st.x0 - 0.4 : st.x1 + 0.4) : (st.x0 + st.x1) / 2;
          const footZ = st.axis === 'z' ? (st.dir > 0 ? st.z0 - 0.4 : st.z1 + 0.4) : (st.z0 + st.z1) / 2;
          const lyaw = st.axis === 'x' ? (st.dir > 0 ? Math.PI / 2 : -Math.PI / 2) : (st.dir > 0 ? 0 : Math.PI);
          const t = await ev(([id, x, z, yw]) => window.__ix.at(id, x, z, 0, yw), [b.id, footX, footZ, lyaw]);
          await advance(0.4);
          await shot(`townhouse-stair-${tag}`);
          await advance(3.2, { forward: 1, cameraYaw: t.yaw });
          await advance(0.5);
          await shot(`townhouse-upstairs-${tag}`);
        }
      }
    }
    if (want('manor', `manor-${tag}`)) {
      const b = await ev(() => window.__ix.find(['manor_house', 'great_hall']));
      if (b) {
        const st = await ev((id) => window.__ix.atDoor(id, 1.2), b.id);
        await advance(3.0, { forward: 1, cameraYaw: st.yaw });
        await advance(0.5);
        await shot(`manor-hall-${tag}`);
      }
    }
    if (want('church', `church-${tag}`)) {
      const b = await ev(() => window.__ix.find(['church', 'chapel', 'abbey_church', 'cathedral']));
      if (b) {
        const st = await ev((id) => window.__ix.atDoor(id, 1.2), b.id);
        await advance(3.4, { forward: 1, cameraYaw: st.yaw });
        await advance(0.5);
        await shot(`church-${tag}`);
      }
    }
    if (want('workshop', `workshop-${tag}`)) {
      const b = await ev(() => window.__ix.find(['smithy', 'carpenter', 'bakehouse', 'weaver', 'brewhouse']));
      if (b) {
        const st = await ev((id) => window.__ix.atDoor(id, 1.2), b.id);
        await advance(2.4, { forward: 1, cameraYaw: st.yaw });
        await advance(0.5);
        await shot(`workshop-${b.kind}-${tag}`);
      }
    }
    if (want('keep', `keep-${tag}`)) {
      const c = await ev(() => window.__ix.castle());
      if (c) {
        await ev(([x, z]) => window.__ix.teleport(x, z), [c.x, c.z]);
        await advance(1.0);
        const b = await ev(([x, z]) => window.__ix.find(['keep_stone', 'tower'], x, z), [c.x, c.z]);
        if (b) {
          const p = await ev((id) => window.__ix.plan(id), b.id);
          const st = p.stairs.find((s) => s.from >= 0) ?? null;
          if (st) {
            const footX = st.axis === 'x' ? (st.dir > 0 ? st.x0 - 0.4 : st.x1 + 0.4) : (st.x0 + st.x1) / 2;
            const footZ = st.axis === 'z' ? (st.dir > 0 ? st.z0 - 0.4 : st.z1 + 0.4) : (st.z0 + st.z1) / 2;
            const lyaw = st.axis === 'x' ? (st.dir > 0 ? Math.PI / 2 : -Math.PI / 2) : (st.dir > 0 ? 0 : Math.PI);
            const t = await ev(([id, x, z, l, yw]) => window.__ix.at(id, x, z, l, yw), [b.id, footX, footZ, st.from, lyaw]);
            await advance(0.4);
            await shot(`keep-stair-${b.kind}-${tag}`);
            await advance(2.4, { forward: 1, cameraYaw: t.yaw });
            await shot(`keep-stair-up-${b.kind}-${tag}`);
          }
          const top = p.levels.length - 1;
          const r = p.rooms.find((q) => q.level === top);
          if (r) {
            await ev(([id, x, z, l]) => window.__ix.at(id, x, z, l, 0), [b.id, (r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2, top]);
            await advance(0.6);
            await shot(`keep-top-${b.kind}-${tag}`);
          }
        }
      }
    }
  }
} finally {
  await browser.close();
  try { process.kill(-vite.pid); } catch { /* gone */ }
}
