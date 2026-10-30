import { beforeAll, describe, expect, it } from 'vitest';
import { BUILDINGS, type BuildingKind } from '../../src/content/types';
import { obbNearest } from '../../src/agents/geometry';
import { PathBuf } from '../../src/agents/nav/path';
import { scatterRadius, SOLID_SCATTER } from '../../src/agents/nav/obstacles';
import type { MoveResult } from '../../src/agents/types';
import type { BuildingState } from '../../src/sim/state';
import { CHUNK_SIZE, type Settlement } from '../../src/world/types';
import { makeRig, village, type Rig } from './helpers';

let rig: Rig;
let vil: Settlement;
const mr: MoveResult = { x: 0, z: 0, blocked: false, wading: false };

beforeAll(() => {
  rig = makeRig();
  vil = village(rig.world, rig.zone);
  rig.zone.nav.prepare(vil.x, vil.z);
}, 180000);

/** A large flat piece of the real continent with nothing built on it near (x, z). */
function emptyGround(): { x: number; z: number } {
  const { world } = rig;
  for (let k = 0; k < 400; k++) {
    const x = 1200 + (k % 20) * 150, z = 3000 + Math.floor(k / 20) * 150;
    if (world.settlements.some((s) => Math.hypot(s.x - x, s.z - z) < s.radius + 250)) continue;
    let flat = true, cost = 0;
    for (let a = -60; a <= 60 && flat; a += 15) for (let b = -60; b <= 60; b += 15) {
      const c = world.walkCostAt(x + a, z + b);
      if (!Number.isFinite(c) || c > 1.6) { flat = false; break; }
      cost += c;
    }
    if (flat && world.forestAt(x, z) < 0.05) return { x, z };
  }
  throw new Error('no empty ground');
}

let nextId = 900000;
function addBuilding(kind: BuildingKind, x: number, z: number, rot = 0): BuildingState {
  const st = rig.sim.state;
  const b: BuildingState = {
    id: nextId++, plot: -1, kind, level: 1, settlement: -1, construction: 1, damage: 0, onFire: false, owner: 0, household: 0,
    occupied: false, x, z, rot, culture: 'anglo', seed: 1,
  };
  st.buildings.set(b.id, b);
  st.touchBuilding(b);
  return b;
}

describe('collision', () => {
  it('never leaves a walker inside a building (thousands of random moves around a village)', () => {
    const { sim, zone } = rig;
    const blds = (sim.state.buildingsAt.get(vil.id) ?? []).filter((b) => BUILDINGS[b.kind].blocks);
    expect(blds.length).toBeGreaterThan(8);
    let moves = 0, blocked = 0;
    for (let i = 0; i < 4000; i++) {
      const b = blds[i % blds.length];
      const def = BUILDINGS[b.kind];
      // start somewhere near the footprint, outside it
      const a = (i * 2.399) % (Math.PI * 2);
      const r = Math.hypot(def.w, def.d) / 2 + 0.6 + (i % 7) * 0.5;
      let x = b.x + Math.cos(a) * r, z = b.z + Math.sin(a) * r;
      for (let s = 0; s < 6; s++) {
        const ang = ((i * 31 + s * 17) % 100) / 100 * Math.PI * 2;
        zone.nav.move(x, z, Math.cos(ang) * 0.5, Math.sin(ang) * 0.5, 0.28, mr);
        x = mr.x; z = mr.z;
        moves++;
        if (mr.blocked) blocked++;
        for (const o of blds) {
          const d = obbNearest(x, z, o.x, o.z, Math.cos(o.rot), Math.sin(o.rot), BUILDINGS[o.kind].w / 2, BUILDINGS[o.kind].d / 2, { x: 0, z: 0 });
          expect(d).toBeGreaterThan(0.2);
        }
      }
    }
    expect(moves).toBeGreaterThan(20000);
    expect(blocked).toBeGreaterThan(100);
  });

  it('slides along a wall instead of stopping dead', () => {
    const g = emptyGround();
    const b = addBuilding('barn', g.x, g.z, 0);
    rig.zone.nav.update(g.x, g.z, 50);
    const def = BUILDINGS.barn;
    // walk diagonally into the long wall on the +z side: the x component must carry on
    let x = g.x - 2, z = g.z + def.d / 2 + 2;
    for (let i = 0; i < 40; i++) {
      rig.zone.nav.move(x, z, 0.08, -0.08, 0.28, mr);
      x = mr.x; z = mr.z;
    }
    expect(x).toBeGreaterThan(g.x + 1);
    expect(z).toBeGreaterThan(g.z + def.d / 2 + 0.2);
    rig.sim.state.buildings.delete(b.id);
    rig.sim.state.touchBuilding(b);
  });

  it('keeps people out of tree trunks and large rocks, and lets them through once felled', () => {
    const { world, zone, sim } = rig;
    // find a solid scatter item near the village
    let item: { id: number; x: number; z: number; r: number } | null = null;
    const cx0 = Math.floor(vil.x / CHUNK_SIZE), cz0 = Math.floor(vil.z / CHUNK_SIZE);
    outer:
    for (let cz = cz0 - 4; cz <= cz0 + 4; cz++) for (let cx = cx0 - 4; cx <= cx0 + 4; cx++) {
      for (const it of world.scatterInChunk(cx, cz)) {
        if (SOLID_SCATTER[it.kind] !== undefined && !sim.view.felled().has(it.id)) { item = { id: it.id, x: it.x, z: it.z, r: scatterRadius(it.kind, it.scale) }; break outer; }
      }
    }
    expect(item).not.toBeNull();
    const it = item!;
    zone.nav.update(it.x, it.z, 100);
    zone.nav.move(it.x - it.r - 0.7, it.z, 1.4, 0, 0.28, mr);
    // it cannot end up on the far side of the trunk's centre
    expect(mr.x).toBeLessThan(it.x);
    expect(zone.nav.walkable(it.x, it.z)).toBe(false);
    sim.view.markFelled(it.id);
    zone.nav.update(it.x, it.z, 100);
    expect(zone.nav.walkable(it.x, it.z)).toBe(true);
  });
});

describe('path finding', () => {
  it('goes round a building, hugging it no closer than a body\'s width', () => {
    const g = emptyGround();
    const b = addBuilding('barn', g.x, g.z, 0.3);
    const { zone } = rig;
    zone.nav.update(g.x, g.z, 50);
    const from = { x: g.x - 25, z: g.z }, to = { x: g.x + 25, z: g.z };
    const path = zone.nav.findPath(from, to);
    expect(path).not.toBeNull();
    const pts = [from, ...path!];
    let len = 0;
    for (let i = 1; i < pts.length; i++) {
      len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
      // sample along each leg: never inside the footprint
      for (let t = 0; t <= 1; t += 0.05) {
        const x = pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, z = pts[i - 1].z + (pts[i].z - pts[i - 1].z) * t;
        expect(obbNearest(x, z, b.x, b.z, Math.cos(b.rot), Math.sin(b.rot), BUILDINGS.barn.w / 2, BUILDINGS.barn.d / 2, { x: 0, z: 0 })).toBeGreaterThan(0.25);
      }
    }
    expect(len).toBeGreaterThan(50);
    expect(len).toBeLessThan(75);
    expect(path![path!.length - 1]).toEqual({ x: to.x, z: to.z });
    rig.sim.state.buildings.delete(b.id);
    rig.sim.state.touchBuilding(b);
  });

  it('goes through a gap in a wall (a gate) and round the end of the wall when there is none', () => {
    const g = emptyGround();
    const { zone, sim } = rig;
    const walls: BuildingState[] = [];
    // a wall of 6 m segments along x, 160 m long, with a 10 m gate in the middle
    for (let i = -13; i <= 13; i++) {
      const x = g.x + i * 6;
      if (Math.abs(i) <= 1) continue;
      walls.push(addBuilding('wall', x, g.z, 0));
    }
    zone.nav.update(g.x, g.z, 50);
    const from = { x: g.x + 40, z: g.z - 30 }, to = { x: g.x + 40, z: g.z + 30 };
    const path = zone.nav.findPath(from, to)!;
    expect(path).not.toBeNull();
    // the path crosses the wall line inside the gap
    let crossX = NaN;
    const pts = [from, ...path];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if ((a.z - g.z) * (b.z - g.z) < 0) crossX = a.x + (b.x - a.x) * ((g.z - a.z) / (b.z - a.z));
    }
    expect(Math.abs(crossX - g.x)).toBeLessThan(9.5);
    // close the gate: the path now has to go round the end of the wall (or fail) instead of through it
    walls.push(addBuilding('wall', g.x, g.z, 0), addBuilding('wall', g.x - 6, g.z, 0), addBuilding('wall', g.x + 6, g.z, 0));
    zone.nav.update(g.x, g.z, 50);
    const closed = zone.nav.findPath(from, to);
    if (closed) {
      let len = 0;
      const cp = [from, ...closed];
      for (let i = 1; i < cp.length; i++) len += Math.hypot(cp[i].x - cp[i - 1].x, cp[i].z - cp[i - 1].z);
      expect(len).toBeGreaterThan(90);
    }
    for (const w of walls) { sim.state.buildings.delete(w.id); sim.state.touchBuilding(w); }
  });

  it('finds paths between the doors of a village quickly', () => {
    const { zone, sim } = rig;
    zone.nav.prepare(vil.x, vil.z);
    const blds = (sim.state.buildingsAt.get(vil.id) ?? []).filter((b) => BUILDINGS[b.kind].cat === 'home').slice(0, 14);
    const church = (sim.state.buildingsAt.get(vil.id) ?? []).find((b) => b.kind === 'church')!;
    const cd = zone.nav.doorOf(church.id)!;
    const buf = new PathBuf();
    const t0 = performance.now();
    let ok = 0;
    for (const b of blds) {
      const d = zone.nav.doorOf(b.id)!;
      if (zone.nav.finder.find(d.x, d.z, cd.x, cd.z, 0, buf) && buf.complete) ok++;
    }
    const ms = (performance.now() - t0) / blds.length;
    expect(ok).toBeGreaterThanOrEqual(blds.length - 1);
    expect(ms).toBeLessThan(12);
  });

  it('knows the door of a building and where to stand at it', () => {
    const { zone, sim } = rig;
    zone.nav.prepare(vil.x, vil.z);
    const church = (sim.state.buildingsAt.get(vil.id) ?? []).find((b) => b.kind === 'church')!;
    const d = zone.nav.doorOf(church.id)!;
    expect(d.yaw).toBeCloseTo(church.rot, 6);
    const def = BUILDINGS.church;
    const dist = obbNearest(d.x, d.z, church.x, church.z, Math.cos(church.rot), Math.sin(church.rot), def.w / 2, def.d / 2, { x: 0, z: 0 });
    expect(dist).toBeGreaterThan(0.8);
    expect(dist).toBeLessThan(2.5);
    expect(zone.nav.walkable(d.x, d.z)).toBe(true);
    expect(zone.nav.doorOf(-5)).toBeNull();
  });

  it('serves path requests within a time budget and in priority order', () => {
    const { zone } = rig;
    zone.nav.prepare(vil.x, vil.z);
    const order: number[] = [];
    const g = { x: vil.x, z: vil.z };
    for (let i = 0; i < 12; i++) {
      zone.nav.queue.request({
        owner: 5000 + i, fx: g.x - 20 + i, fz: g.z, tx: g.x + 20, tz: g.z + 10 + i, maxLength: 0, priority: 12 - i,
        done: () => { order.push(i); },
      });
    }
    zone.nav.queue.process(0.0001);
    expect(order.length).toBeGreaterThanOrEqual(1);
    expect(order[0]).toBe(11);
    zone.nav.queue.process(1000);
    expect(order.length).toBe(12);
  });
});

describe('terrain', () => {
  it('walks over bridges at deck height and refuses deep water', () => {
    const { world, zone } = rig;
    const br = world.bridges[0];
    expect(br).toBeDefined();
    const y = zone.nav.groundY(br.x, br.z);
    expect(Number.isFinite(y)).toBe(true);
    // the deck stands clear of the river it spans
    const river = world.rivers.find((r) => r.id === br.riverId)!;
    let surface = Infinity, best = Infinity;
    river.points.forEach((p, i) => { const d = Math.hypot(p.x - br.x, p.z - br.z); if (d < best) { best = d; surface = river.surface[i]; } });
    expect(y).toBeGreaterThan(surface + 1.5);
    expect(zone.nav.walkable(br.x, br.z)).toBe(true);
    // somewhere in the sea is not walkable
    expect(zone.nav.walkable(2, 2)).toBe(false);
  });

  it('prefers roads: faster on a road than in marsh', () => {
    const { world, zone } = rig;
    const road = world.roads.find((r) => r.kind === 'road' || r.kind === 'highway')!;
    const mid = road.points[Math.floor(road.points.length / 2)];
    zone.nav.update(mid.x, mid.z, 100);
    expect(zone.nav.speedFactor(mid.x, mid.z)).toBeGreaterThan(1);
    expect(zone.nav.speedFactor(mid.x, mid.z)).toBeLessThanOrEqual(1.26);
  });

  it('builds the window incrementally: a jump of the focus costs a few tiles a frame, never a stall', () => {
    const { zone } = rig;
    const far = { x: vil.x + 1500, z: vil.z + 900 };
    zone.nav.update(far.x, far.z, 0); // picks up the buildings the earlier tests changed
    let maxMs = 0, frames = 0;
    for (let i = 0; i < 400 && zone.nav.grid.pendingTiles(far.x, far.z) > 0; i++) {
      const t0 = performance.now();
      zone.nav.update(far.x, far.z, 1.8);
      maxMs = Math.max(maxMs, performance.now() - t0);
      frames++;
    }
    expect(zone.nav.grid.pendingTiles(far.x, far.z)).toBe(0);
    expect(frames).toBeGreaterThan(5);
    expect(maxMs).toBeLessThan(80);
  });
});
