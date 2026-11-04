// Live checks of the interiors in the real game (docs/INTERIORS.md): people inside walk up and down the stairs, a corner tower's door
// is off the ends of the wall, led animals come with the player across a zone change, and the frame time inside buildings against
// outside. Vite on a private port, headless Chromium, the game driven through `window.__game`.
//
//   PORT=5295 node tools/interiors-live.mjs [stairs] [tower] [led] [perf]      (all by default; prints JSON lines, exit 1 on a failed check)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = process.env.GAME_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 5295);
const wanted = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const want = (n) => wanted.length === 0 || wanted.includes(n);
const seed = process.env.SEED ?? 'millennia';
let failed = 0;
const check = (name, ok, info) => { if (!ok) failed++; console.log(JSON.stringify({ ...(info ?? {}), check: name, ok: !!ok })); };

const vite = await new Promise((ok, bad) => {
  const proc = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BROWSER: 'none' }, detached: true });
  let done = false;
  const on = (d) => { if (!done && /Local:|ready in/i.test(d.toString())) { done = true; ok(proc); } };
  proc.stdout.on('data', on); proc.stderr.on('data', on);
  proc.on('exit', (c) => { if (!done) bad(new Error(`vite exited ${c}`)); });
  setTimeout(() => { if (!done) { done = true; ok(proc); } }, 20000);
});
const browser = await chromium.launch({ args: ['--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--js-flags=--max-old-space-size=6144'] });
let page;
async function fresh() {
  if (page) await page.close().catch(() => {});
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(0);
  page.on('crash', () => console.log('[page crashed]'));
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[browser] ${m.text()}`); });
}
await fresh();
const ev = (fn, ...a) => page.evaluate(fn, ...a);
const advance = (s, input = {}) => page.evaluate(([t, i]) => window.__game.advance(t, i), [s, input]);

async function load(time) {
  await fresh();
  await page.goto(`http://localhost:${PORT}/?seed=${seed}&quality=medium&shots=1&autostart=1&time=${time}`, { timeout: 120000 });
  await page.waitForFunction(() => window.__game !== undefined, null, { timeout: 300000, polling: 250 });
  await ev(() => window.__game.ready());
  await ev(() => window.__game.freeze(true));
  await ev(() => window.__game.host.setSettings({ hints: false }));
  await ev(() => {
    const G = window.__game;
    const S = () => G.session;
    const zone = () => S().services.zone;
    const ix = () => zone().nav.interiors;
    window.__ix = {
      find(kinds, x, z, skip = 0, pred) {
        const st = S().sim.state;
        const b0 = S().services.player.body();
        const fx = x ?? b0.x, fz = z ?? b0.z;
        const list = [...st.buildings.values()].filter((b) => kinds.includes(b.kind) && b.construction >= 1 && b.damage < 0.5)
          .sort((a, c) => Math.hypot(a.x - fx, a.z - fz) - Math.hypot(c.x - fx, c.z - fz));
        let n = 0;
        for (const b of list) { const l = ix().placed(b); if (l && l.plan.main >= 0 && (!pred || pred(b, l))) { if (n++ >= skip) return { id: b.id, kind: b.kind, level: b.level, culture: b.culture, x: b.x, z: b.z }; } }
        return null;
      },
      atDoor(id, back = 1.6) {
        const st = S().sim.state;
        const b = st.buildings.get(id);
        zone().doors.invite(st.run.playerId, id, S().sim.absDay + 1);
        const l = ix().placed(b);
        const d = l.plan.doors[l.plan.main];
        const sd = Math.hypot(d.sx - d.x, d.sz - d.z);
        const loc = { x: d.sx + d.nx * Math.max(0, back - sd), z: d.sz + d.nz * Math.max(0, back - sd) };
        const w = ix().toWorld(l, loc.x, loc.z, { x: 0, z: 0 });
        const yaw = Math.atan2(d.x - loc.x, d.z - loc.z) + l.rot;
        S().services.player.placeAt(w.x, w.z, yaw, d.sy > 0.5 ? l.y + d.sy : undefined);
        return { yaw };
      },
      at(id, lx, lz, level, lyaw = Math.PI) {
        const b = S().sim.state.buildings.get(id);
        zone().doors.invite(S().sim.state.run.playerId, id, S().sim.absDay + 1);
        const l = ix().placed(b);
        const w = ix().toWorld(l, lx, lz, { x: 0, z: 0 });
        S().services.player.placeAt(w.x, w.z, lyaw + l.rot, l.y + l.plan.levels[level].y);
      },
      people() { return [...zone().indoors.people()].map((o) => ({ person: o.person, building: o.building, spot: o.spot, y: Math.round(o.y * 100) / 100, x: Math.round(o.x * 100) / 100, z: Math.round(o.z * 100) / 100, anim: o.anim, pi: o.pi, n: o.path.length })); },
      plan(id) { const l = ix().placed(S().sim.state.buildings.get(id)); return l ? { levels: l.plan.levels.map((q) => q.y), spots: l.plan.spots, stairs: l.plan.stairs, main: l.plan.main } : null; },
      teleport(x, z) { S().services.player.placeAt(x, z, 0); },
      castle() { const w = S().sim.world; const p = S().services.player.body(); const cs = w.settlements.filter((s) => s.kind === 'castle').sort((a, c) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(c.x - p.x, c.z - p.z)); return cs[0] ? { x: cs[0].x, z: cs[0].z, name: cs[0].name } : null; },
      setDay(frac) { const c = S().sim.state.clock; const d = Math.floor(c.absDay); c.absDay = d + frac; c.firedHour = Math.floor(c.absDay * 24); },
    };
  });
}

try {
  if (want('stairs')) {
    // a townhouse or manor: at night the household sleeps upstairs, in the morning they come down the stairs
    await load(0.97);
    const b = await ev(() => window.__ix.find(['townhouse', 'manor_house', 'cottage', 'tavern', 'alehouse'], undefined, undefined, 0, (bb, l) => l.plan.spots.some((s) => s.use === 'sleep' && s.y > l.plan.levels[0].y + 1.5) && [...window.__game.session.sim.state.households.values()].some((h) => h.home === bb.id && h.members.length >= 2)));
    check('stairs: a building with beds upstairs is near', !!b, b ?? {});
    if (b) {
      const st = await ev((id) => window.__ix.atDoor(id, 1.0), b.id);
      await advance(1.6, { forward: 1, cameraYaw: st.yaw });
      check('stairs: the player is inside', await ev((id) => { const S = window.__game.session, p = S.services.player.body(); return S.services.zone.nav.interiorAt(p.x, p.z, p.y) === id; }, b.id));
      const plan = await ev((id) => window.__ix.plan(id), b.id);
      let night = [];
      for (let i = 0; i < 6; i++) { if (process.env.DBG) console.log('advance', i); await advance(1.0); night = (await ev(() => window.__ix.people())).filter((o) => o.building === b.id); if (night.length) break; }
      const up = night.filter((o) => o.y > plan.levels[0] + 1.5);
      check('stairs: at night the household is asleep upstairs, on a floor of the plan', up.length > 0 && up.every((o) => plan.levels.some((l) => Math.abs(l - o.y) < 0.05)), { people: night.length, upstairs: up.length, anims: up.map((o) => o.anim) });
      // morning: the household gets up and comes down the stairs, the feet on the flight
      await ev(() => window.__ix.setDay(0.215));
      const seen = new Map();
      for (let t = 0; t < 160; t++) {
        await advance(0.5);
        if (process.env.DBG && t % 20 === 0) console.log('t', t, JSON.stringify(await ev(() => ({ heap: Math.round(performance.memory.usedJSHeapSize / 1e6), day: window.__game.session.sim.absDay, occ: window.__ix.people().length }))));
        for (const o of (await ev(() => window.__ix.people())).filter((q) => q.building === b.id)) {
          const r = seen.get(o.person) ?? { ys: [], anims: new Set() };
          r.ys.push(o.y); r.anims.add(o.anim); seen.set(o.person, r);
        }
      }
      const lo = plan.levels[0];
      const climbers = [...seen.values()].filter((r) => r.ys.some((y) => y > lo + 1.5) && r.ys.some((y) => y < lo + 0.6) && r.ys.some((y) => y > lo + 0.6 && y < Math.max(...r.ys) - 0.3));
      check('stairs: someone walked down the stairs (heights between the floors)', climbers.length > 0, { seen: seen.size, climbers: climbers.length, sample: climbers[0] ? { ys: climbers[0].ys.filter((_, i, a) => i % 3 === 0).slice(0, 24), anims: [...climbers[0].anims] } : null });
    }
  }
  if (want('tower')) {
    // the wall towers of a castle: nobody's door looks into the end of a wall, and one walks in from the ground
    await load(0.45);
    const c = await ev(() => window.__ix.castle());
    check('tower: a castle is in the world', !!c, c ?? {});
    if (c) {
      await ev(([x, z]) => window.__ix.teleport(x, z), [c.x, c.z]);
      await advance(1.0);
      const towers = await ev(([x, z]) => {
        const G = window.__game, S = G.session, st = S.sim.state, ix = S.services.zone.nav.interiors;
        const pieces = [...st.buildings.values()].filter((b) => ['wall', 'palisade', 'gatehouse'].includes(b.kind) && b.construction >= 1);
        const inside = (px, pz, b, def) => { const dx = px - b.x, dz = pz - b.z, cs = Math.cos(b.rot), sn = Math.sin(b.rot); const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs; return Math.abs(lx) <= def.w / 2 + 0.3 && Math.abs(lz) <= def.d / 2 + 0.3; };
        const DEF = { wall: { w: 6, d: 3 }, palisade: { w: 4, d: 1 }, gatehouse: { w: 10, d: 8 } };
        const out = [];
        for (const b of st.buildings.values()) {
          if (b.kind !== 'tower' || b.construction < 1 || Math.hypot(b.x - x, b.z - z) > 400) continue;
          const l = ix.placed(b);
          if (!l) continue;
          const d = l.plan.doors[l.plan.main];
          const w = ix.toWorld(l, d.sx, d.sz, { x: 0, z: 0 });
          const w2 = ix.toWorld(l, d.x + d.nx * 2.2, d.z + d.nz * 2.2, { x: 0, z: 0 });
          const blocked = pieces.some((q) => inside(w.x, w.z, q, DEF[q.kind]) || inside(w2.x, w2.z, q, DEF[q.kind]));
          out.push({ id: b.id, blocked, x: Math.round(b.x), z: Math.round(b.z) });
        }
        return out;
      }, [c.x, c.z]);
      check('tower: no tower door stands against a length of wall', towers.length > 0 && towers.every((t) => !t.blocked), { towers: towers.length, blocked: towers.filter((t) => t.blocked).map((t) => t.id) });
      // and one can walk in at each from the ground
      let entered = 0, tried = 0;
      for (const t of towers.slice(0, 8)) {
        const st = await ev((id) => window.__ix.atDoor(id, 1.6), t.id);
        tried++;
        await advance(2.4, { forward: 1, cameraYaw: st.yaw });
        const inId = await ev((id) => { const S = window.__game.session; const b = S.services.player.body(); return S.services.zone.nav.interiorAt(b.x, b.z, b.y) === id; }, t.id);
        if (inId) entered++;
      }
      check('tower: walking up to the door of each tower from the ground gets one in', tried > 0 && entered === tried, { tried, entered });
    }
  }
  if (want('led')) {
    // a led animal comes with the player across a zone change
    await load(0.45);
    const r = await ev(() => {
      const G = window.__game, S = G.session, z = S.services.zone, me = S.sim.state.run.playerId;
      const p = S.sim.state.persons.get(me);
      const a = z.animals().find((q) => q.owner === p.household && ['pig', 'sheep', 'cow', 'horse', 'ox', 'goat'].includes(q.kind));
      if (!a) return { ok: false, why: 'no animal of the household in the zone' };
      S.services.player.placeAt(a.x + 2, a.z, 0);
      const res = z.leadAnimal(a.id, me);
      return { ok: res.ok, why: res.reason, id: a.id, kind: a.kind };
    });
    check('led: the household animal is taken on a halter', r.ok, r);
    if (r.ok) {
      const far = await ev(() => {
        const S = window.__game.session, b = S.services.player.body();
        const w = S.sim.world;
        const o = w.settlements.filter((s) => Math.hypot(s.x - b.x, s.z - b.z) > 1500).sort((p, q) => Math.hypot(p.x - b.x, p.z - b.z) - Math.hypot(q.x - b.x, q.z - b.z))[0];
        return { x: o.x + o.radius + 8, z: o.z };
      });
      await ev(([x, z]) => window.__game.session.services.player.placeAt(x, z, 1), [far.x, far.z]);
      await advance(1.0);
      const d = await ev(() => {
        const S = window.__game.session, z = S.services.zone, me = S.sim.state.run.playerId, b = S.services.player.body();
        const led = z.ledBy(me);
        return { n: led.length, dist: led.map((a) => Math.round(Math.hypot(a.x - b.x, a.z - b.z) * 10) / 10) };
      });
      check('led: after being set down kilometres away the animal is still led and beside the player', d.n === 1 && d.dist[0] < 8, d);
      // the Go-to skip of the places of one's lands
      const g = await ev(() => {
        const S = window.__game.session, go = S.services.goto;
        if (!go) return { ok: false, why: 'no goto service' };
        const places = go.places().filter((p) => p.kind === 'building');
        const b = S.services.player.body();
        const far2 = places.map((p) => ({ p, d: Math.hypot(p.x - b.x, p.z - b.z) })).filter((q) => q.d > 60).sort((x, y) => y.d - x.d)[0];
        if (!far2) return { ok: false, why: 'no place to go to' };
        const c = go.check(far2.p, places);
        if (!c.ok) return { ok: false, why: c.reason };
        const res = go.go(far2.p);
        return { ok: res.ok, why: res.reason, name: far2.p.name, d: Math.round(far2.d) };
      });
      if (g.ok) {
        for (let i = 0; i < 400 && (await ev(() => window.__game.session.services.goto.busy())); i++) await advance(0.5);
        await advance(1.0);
        const e = await ev(() => {
          const S = window.__game.session, z = S.services.zone, me = S.sim.state.run.playerId, b = S.services.player.body();
          const led = z.ledBy(me);
          return { n: led.length, dist: led.map((a) => Math.round(Math.hypot(a.x - b.x, a.z - b.z) * 10) / 10) };
        });
        check('led: after the Go-to skip the animal is still led and beside the player', e.n === 1 && e.dist[0] < 8, { ...e, to: g.name, metres: g.d });
      } else check('led: a Go-to is possible from here', false, g);
    }
  }
  if (want('yard')) {
    // a home raised in play: its household's yard reads as its own ground (territory.landAt), as a croft garden does
    await load(0.45);
    const r = await ev(() => {
      const S = window.__game.session, st = S.sim.state, me = st.persons.get(st.run.playerId), t = S.sim.services.territory;
      const hh = st.households.get(me.household), home = st.buildings.get(hh.home);
      // ten metres from the old home, along a line with nothing to stop it, a new cottage of the household's, raised in play
      const spots = [[40, 0], [-40, 0], [0, 40], [0, -40], [60, 30], [-60, -30]];
      for (const [dx, dz] of spots) {
        const x = home.x + dx, z = home.z + dz;
        const before = t.landAt(x, z);
        if (before.settlement < 0 || before.kind === 'field' || before.kind === 'road' || before.kind === 'water' || before.building >= 0) continue;
        const b = { id: 9_900_001, plot: -1, kind: 'cottage', level: 1, settlement: before.settlement, construction: 1, damage: 0, onFire: false, owner: 0, household: hh.id, occupied: true, x, z, rot: 0, culture: home.culture, seed: 5 };
        st.buildings.set(b.id, b); st.buildingsAt.get(before.settlement).push(b); st.touchBuilding(b);
        // (as the construction module does when a building is raised: the territory takes its footprint in)
        S.sim.events.emit('construction', { phase: 'done', site: 0, building: b.id, settlement: before.settlement, kind: 'cottage', work: 'build', house: 0 });
        const near = t.landAt(x + 4 + 3, z), far = t.landAt(x + 4 + 15, z);
        return { ok: true, before: { kind: before.kind, household: before.household }, near: { kind: near.kind, household: near.household }, far: { kind: far.kind, household: far.household }, hh: hh.id };
      }
      return { ok: false };
    });
    check('yard: the ground by a home raised in play is its household\'s garden, and not further off', r.ok && r.near.kind === 'garden' && r.near.household === r.hh && r.far.household !== r.hh, r);
  }
  if (wanted.includes('dbgtick')) {
    await load(0.45);
    for (let i = 0; i < 40; i++) { await ev(() => window.__game.tick(1)); if (i % 5 === 0) console.log('tick', i, JSON.stringify(await ev(() => ({ heap: Math.round(performance.memory.usedJSHeapSize / 1e6), day: window.__game.session.sim.absDay })))); }
  }
  if (wanted.includes('dbgperf')) {
    await load(0.45);
    await ev(() => window.__game.settle());
    const r = await ev(() => {
      const G = window.__game, R = G.session.renderer;
      const out = [];
      for (let i = 0; i < 4; i++) { const t0 = performance.now(); G.draw(); out.push(performance.now() - t0); }
      const proto = WebGL2RenderingContext.prototype;
      const names = ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'drawRangeElements', 'clear'];
      const saved = names.map((n) => proto[n]);
      names.forEach((n) => { proto[n] = function () {}; });
      const out2 = [];
      for (let i = 0; i < 4; i++) { const t0 = performance.now(); G.draw(); out2.push(performance.now() - t0); }
      names.forEach((n, i) => { proto[n] = saved[i]; });
      return { plain: out, noDraw: out2, stats: R.stats() };
    });
    console.log(JSON.stringify(r));
    const b = await ev(() => window.__ix.find(['cottage', 'hovel', 'longhouse']));
    const st = await ev((id) => window.__ix.atDoor(id, 12), b.id);
    await advance(0.6);
    await ev(() => window.__game.settle());
    for (let k = 0; k < 3; k++) {
      const r2 = await ev(() => {
        const G = window.__game, R = G.session.renderer;
        const proto = WebGL2RenderingContext.prototype;
        const names = ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'drawRangeElements', 'clear'];
        const saved = names.map((n) => proto[n]);
        names.forEach((n) => { proto[n] = function () {}; });
        const out = [], adv = [];
        for (let i = 0; i < 6; i++) { const t0 = performance.now(); G.advance(0.05, {}); const t1 = performance.now(); G.draw(); out.push(Math.round(performance.now() - t1)); adv.push(Math.round(t1 - t0)); }
        names.forEach((n, i) => { proto[n] = saved[i]; });
        const s = R.stats();
        return { out, adv, frameMs: s.frameMs, calls: s.drawCalls, tris: s.triangles, gen: s.generationMs };
      });
      console.log(JSON.stringify(r2));
    }
  }
  if (want('perf')) {
    // frame time and counts inside buildings against outside (docs/INTERIORS.md; budgets of ARCHITECTURE section 13: JS frame < 8 ms, draw calls < 600, triangles < 2.5 M)
    const rows = [];
    const cases = [
      ['cottage', ['cottage', 'hovel', 'longhouse'], 0], ['townhouse', ['townhouse'], 1], ['manor hall', ['manor_house', 'great_hall'], 0],
      ['church', ['church', 'chapel'], 0], ['keep', ['keep_stone', 'motte', 'tower'], 0],
    ];
    const measure = async (label) => {
      await ev(() => window.__game.settle());
      const r = await ev(() => {
        const G = window.__game, R = G.session.renderer;
        const frame = [], step = [], calls = [], tris = [];
        for (let i = 0; i < 48; i++) {
          const t0 = performance.now(); G.advance(0.05, {}); const t1 = performance.now(); G.draw(); const t2 = performance.now();
          if (i >= 8) { const s = R.stats(); step.push(t1 - t0); frame.push(t2 - t1); calls.push(s.drawCalls); tris.push(s.triangles); }
        }
        const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
        const p90 = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.9)];
        return { drawMs: med(frame), drawP90: p90(frame), stepMs: med(step), calls: med(calls), tris: med(tris) };
      });
      const o = { label, drawMs: +r.drawMs.toFixed(2), drawP90: +r.drawP90.toFixed(2), stepMs: +r.stepMs.toFixed(2), calls: r.calls, tris: r.tris };
      console.log(JSON.stringify({ perf: o }));
      return o;
    };
    for (const [name, kinds, level] of cases) {
      if (process.env.CASES && !process.env.CASES.split(',').includes(name.split(' ')[0])) continue;
      let done = null;
      for (let attempt = 0; attempt < 3 && !done; attempt++) {
        try {
          await load(0.45);
          // the software GL (SwiftShader) runs every draw on the CPU, seconds a frame, and brings a shared machine's browser down: the
          // draw and clear calls of the context do nothing, so what is timed is the JS of a frame (the scene update, culling,
          // uniforms, state changes); the counts of draw calls and triangles are the renderer's own and are unaffected
          await ev(() => {
            const proto = WebGL2RenderingContext.prototype;
            for (const n of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'drawRangeElements', 'clear']) proto[n] = function () {};
          });
          let b = await ev((k) => window.__ix.find(k), kinds);
          if (!b && name === 'keep') {
            const c = await ev(() => window.__ix.castle());
            if (c) { await ev(([x, z]) => window.__ix.teleport(x, z), [c.x, c.z]); await advance(1.0); b = await ev((k) => window.__ix.find(k), kinds); }
          }
          if (!b) { console.log(JSON.stringify({ perf: { label: name, missing: true } })); done = {}; break; }
          // outside: twelve metres from the door, then in at it
          // (twice round, taking the quieter of each: the machine is shared and one round's median can be another builder's load)
          let outside = null, inside = null;
          const best = (a, c) => (!a || c.drawMs < a.drawMs ? c : a);
          for (let round = 0; round < 2; round++) {
            const st = await ev((id) => window.__ix.atDoor(id, 12), b.id);
            await advance(0.6);
            outside = best(outside, await measure(`${name} outside`));
            await ev((id) => window.__ix.atDoor(id, 1.2), b.id);
            await advance(3.0, { forward: 1, cameraYaw: st.yaw });
            inside = best(inside, await measure(`${name} inside`));
          }
          if (level > 0) {
            const p = await ev((id) => window.__ix.plan(id), b.id);
            const stair = p.stairs.find((q) => q.from === 0);
            if (stair) {
              const x = stair.axis === 'x' ? (stair.dir > 0 ? stair.x0 - 0.4 : stair.x1 + 0.4) : (stair.x0 + stair.x1) / 2;
              const z = stair.axis === 'z' ? (stair.dir > 0 ? stair.z0 - 0.4 : stair.z1 + 0.4) : (stair.z0 + stair.z1) / 2;
              const yw = stair.axis === 'x' ? (stair.dir > 0 ? Math.PI / 2 : -Math.PI / 2) : (stair.dir > 0 ? 0 : Math.PI);
              await ev(([id, x2, z2, yy]) => window.__ix.at(id, x2, z2, 0, yy), [b.id, x, z, yw]);
              await advance(3.4, { forward: 1, cameraYaw: yw });
              inside = await measure(`${name} upstairs`);
            }
          }
          done = { name, outside, inside };
        } catch (e) { console.log(`[perf ${name}: attempt ${attempt} failed: ${String(e.message).split('\n')[0]}]`); }
      }
      if (done && done.name) rows.push(done);
    }
    const worst = rows.reduce((m, r) => Math.max(m, r.inside.drawMs / Math.max(0.1, r.outside.drawMs)), 0);
    check('perf: no inside costs more than twice an outside view, and none exceeds the draw-call and triangle budgets', rows.length > 0 && rows.every((r) => r.inside.calls < 600 && r.inside.tris < 2.5e6) && worst < 2, { worst: +worst.toFixed(2), rows: rows.length });
  }
} finally {
  await browser.close();
  try { process.kill(-vite.pid); } catch { /* gone */ }
}
process.exit(failed ? 1 : 0);
