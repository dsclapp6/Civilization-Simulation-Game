// Outlines (TerritoryApi.landsPolygon, outpostPolygons) and the tracer behind them: a settlement's lands as a polygon for the
// builder's tint and the map's borders, and the wild land an outpost claims.
import { describe, expect, it } from 'vitest';
import type { P2 } from '../../../src/core/math';
import { inPolygon, TERRITORY, traceOutline } from '../../../src/sim/territory';
import { LandsIndex } from '../../../src/world/lands';
import { WORLD_SIZE } from '../../../src/world/types';
import { mockRig, realRig, scriptedConstruction, type Rig } from './helpers';

const TAU = Math.PI * 2;

function area(poly: readonly P2[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j].x * poly[i].z - poly[i].x * poly[j].z;
  return Math.abs(a) / 2;
}

/** Vertices go once round the centre in increasing angle. */
function increasing(poly: readonly P2[], cx: number, cz: number): boolean {
  let total = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = Math.atan2(poly[i].z - cz, poly[i].x - cx), b = Math.atan2(poly[(i + 1) % poly.length].z - cz, poly[(i + 1) % poly.length].x - cx);
    const step = ((b - a + 3 * Math.PI) % TAU) - Math.PI; // -pi..pi
    if (step < 0) return false;
    total += step;
  }
  return Math.abs(total - TAU) < 1e-6;
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

const landsOf = (rig: Rig): LandsIndex => new LandsIndex(rig.world.settlements, { biome: rig.world.macro.biome, res: rig.world.macro.res, cell: rig.world.macro.cell });

describe('traceOutline', () => {
  it('traces a disc with 64 vertices on its edge, in increasing angle', () => {
    const inside = (x: number, z: number): boolean => Math.hypot(x - 100, z - 200) <= 500;
    const poly = traceOutline(100, 200, inside, { reach: 1000 });
    expect(poly).toHaveLength(64);
    for (const v of poly) expect(Math.abs(Math.hypot(v.x - 100, v.z - 200) - 500)).toBeLessThan(0.6);
    expect(area(poly) / (Math.PI * 500 * 500)).toBeGreaterThan(0.995);
    expect(increasing(poly, 100, 200)).toBe(true);
    expect(poly[0].z).toBeCloseTo(200, 0); // the first vertex lies due +x
  });

  it('finds the corners of a box, and the polygon stays inside it', () => {
    const inside = (x: number, z: number): boolean => Math.abs(x - 50) <= 300 && Math.abs(z + 20) <= 200;
    const poly = traceOutline(50, -20, inside, { reach: 1000 });
    expect(area(poly)).toBeGreaterThan(0.985 * 240000);
    expect(area(poly)).toBeLessThan(240000 * 1.001);
    for (const [x, z] of [[350, 180], [-250, 180], [350, -220], [-250, -220]]) expect(poly.some((v) => Math.hypot(v.x - x, v.z - z) < 12), `corner ${x},${z}`).toBe(true);
    for (const v of poly) expect(inside(v.x, v.z)).toBe(true);
    expect(poly.length).toBeLessThan(400);
  });

  it('stops a ray at `reach` when the region goes on', () => {
    const poly = traceOutline(0, 0, () => true, { reach: 300 });
    for (const v of poly) expect(Math.hypot(v.x, v.z)).toBeCloseTo(300, 0);
  });

  it('is empty when the centre is outside the region', () => {
    expect(traceOutline(0, 0, (x) => x > 10, { reach: 500 })).toEqual([]);
  });

  it('keeps the part of the region the centre can see in a straight line: a hole casts a shadow', () => {
    const region = (x: number, z: number): boolean => Math.hypot(x, z) <= 800 && Math.hypot(x - 400, z) > 100;
    const poly = traceOutline(0, 0, region, { reach: 1000 });
    expect(inPolygon(poly, 400, 0)).toBe(false);
    expect(inPolygon(poly, 700, 0)).toBe(false); // the land behind the hole is cut off
    expect(inPolygon(poly, -700, 0)).toBe(true);
    expect(inPolygon(poly, 0, 700)).toBe(true);
    for (const v of poly) for (const f of [0.3, 0.6, 0.95]) expect(region(v.x * f, v.z * f), `${v.x},${v.z} at ${f}`).toBe(true);
    const rnd = lcg(5);
    let inPoly = 0, bad = 0;
    for (let i = 0; i < 5000; i++) {
      const x = (rnd() * 2 - 1) * 900, z = (rnd() * 2 - 1) * 900;
      if (!inPolygon(poly, x, z)) continue;
      inPoly++;
      if (!region(x, z)) bad++;
    }
    expect(inPoly).toBeGreaterThan(1000);
    expect(bad / inPoly).toBeLessThan(0.005); // only the chords' few metres at the edge
  });

  it('starts the look at `from` when the nearer ground is known to be inside', () => {
    let calls = 0;
    const inside = (x: number, z: number): boolean => { calls++; return Math.hypot(x, z) <= 500; };
    traceOutline(0, 0, inside, { reach: 1000 });
    const all = calls;
    calls = 0;
    const poly = traceOutline(0, 0, inside, { reach: 1000, from: 400 });
    expect(calls).toBeLessThan(all);
    for (const v of poly) expect(Math.abs(Math.hypot(v.x, v.z) - 500)).toBeLessThan(0.6);
  });
});

describe('landsPolygon on a stand-in world', () => {
  const rig = mockRig({ preset: 'small', seed: 'outlines' });
  const { terr, world, sim } = rig;
  const lands = landsOf(rig);
  const holders = world.settlements.filter((s) => lands.holderOf(s.id) === s.id);

  it('gives every holder of lands a closed outline round its centre, in increasing angle', () => {
    expect(holders.length).toBeGreaterThan(5);
    for (const s of holders) {
      const poly = terr.landsPolygon(s.id);
      expect(poly.length, s.name).toBeGreaterThanOrEqual(32);
      expect(poly.length, s.name).toBeLessThan(400);
      expect(inPolygon(poly, s.x, s.z), s.name).toBe(true);
      expect(increasing(poly, s.x, s.z), s.name).toBe(true);
      for (const v of poly) expect(Math.hypot(v.x - s.x, v.z - s.z), s.name).toBeLessThanOrEqual(lands.extentOf(s.id) + 0.5);
    }
  });

  it('puts every vertex on the edge of the lands: inside, and a few metres further out not', () => {
    let beyondIn = 0, n = 0, onMapEdge = 0;
    for (const s of holders) {
      for (const v of terr.landsPolygon(s.id)) {
        expect(lands.lookup(v.x, v.z), `${s.name} ${v.x},${v.z}`).toBe(s.id);
        if (v.x < 4 || v.z < 4 || v.x > WORLD_SIZE - 4 || v.z > WORLD_SIZE - 4) { onMapEdge++; continue; } // the lands go on, the map does not
        const d = Math.hypot(v.x - s.x, v.z - s.z);
        const out = { x: s.x + (v.x - s.x) * (d + 3) / d, z: s.z + (v.z - s.z) * (d + 3) / d };
        n++;
        if (lands.lookup(out.x, out.z) === s.id) beyondIn++;
      }
    }
    expect(n).toBeGreaterThan(500);
    expect(onMapEdge).toBeLessThan(n); // Northford's lands reach over the western edge of the map
    expect(beyondIn / n).toBeLessThan(0.02);
  });

  it('is star-shaped: a line from the centre to any vertex stays in the lands', () => {
    for (const s of holders) {
      for (const v of terr.landsPolygon(s.id)) {
        for (const f of [0.2, 0.5, 0.8, 0.97]) {
          const x = s.x + (v.x - s.x) * f, z = s.z + (v.z - s.z) * f;
          expect(lands.lookup(x, z), `${s.name} ${f}`).toBe(s.id);
        }
      }
    }
  });

  it('holds only the settlement\'s lands: the points inside it are the settlement\'s by `settlementOf`', () => {
    const rnd = lcg(11);
    let inside = 0, castles = 0;
    const strangers: string[] = [];
    for (const s of holders) {
      const poly = terr.landsPolygon(s.id);
      const reach = lands.extentOf(s.id);
      for (let k = 0; k < 400; k++) {
        const a = rnd() * TAU, r = Math.sqrt(rnd()) * reach;
        const x = s.x + Math.cos(a) * r, z = s.z + Math.sin(a) * r;
        if (!inPolygon(poly, x, z)) continue;
        inside++;
        const so = terr.settlementOf(x, z);
        if (so === s.id) continue;
        if (lands.holderOf(so) === s.id) { castles++; continue; } // a castle's grounds and park, in the lands it shares
        const land = terr.landAt(x, z);
        // a strip or parcel of the neighbouring settlement that crosses the border keeps its own settlement
        if (land.strip < 0 && land.parcel < 0) strangers.push(`${s.name} ${x.toFixed(0)},${z.toFixed(0)} ${land.kind} of ${so}`);
      }
    }
    expect(inside).toBeGreaterThan(2000);
    expect(strangers).toEqual([]);
    expect(castles).toBeLessThan(inside * 0.05);
  });

  it('gives a castle that shares a village\'s lands that village\'s outline', () => {
    const castle = world.settlements.find((s) => s.kind === 'castle' && s.parent !== undefined && lands.holderOf(s.id) === s.parent);
    expect(castle).toBeDefined();
    expect(terr.landsPolygon(castle!.id)).toBe(terr.landsPolygon(castle!.parent!));
  });

  it('has nothing for a settlement that does not exist', () => {
    expect(terr.landsPolygon(99999)).toEqual([]);
    expect(terr.landsPolygon(-1)).toEqual([]);
  });

  it('is made once, shared and frozen; a change of ownership does not move it', () => {
    const s = holders[0];
    const a = terr.landsPolygon(s.id);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a[0])).toBe(true);
    const v = terr.version();
    sim.events.emit('war', { phase: 'declared', war: 1, attackers: [1], defenders: [2] });
    expect(terr.version()).toBeGreaterThan(v);
    expect(terr.landsPolygon(s.id)).toBe(a);
  });

  it('is part of the TerritoryRuntime and of the registered service', () => {
    expect(sim.services.territory?.landsPolygon).toBeTypeOf('function');
    expect(sim.services.territory?.outpostPolygons).toBeTypeOf('function');
  });
});

describe('landsPolygon on the real continent', () => {
  const rig = realRig(true);
  const { terr, world } = rig;
  const lands = landsOf(rig);
  const holders = world.settlements.filter((s) => lands.holderOf(s.id) === s.id);

  it('outlines the lands of every town, village, hamlet and abbey; the points inside are the settlement\'s', () => {
    expect(holders.length).toBeGreaterThan(30);
    const rnd = lcg(3);
    let inside = 0, notLands = 0, agree = 0;
    const odd: string[] = [];
    for (const s of holders) {
      const poly = terr.landsPolygon(s.id);
      expect(inPolygon(poly, s.x, s.z), s.name).toBe(true);
      expect(increasing(poly, s.x, s.z), s.name).toBe(true);
      const reach = lands.extentOf(s.id);
      for (let k = 0; k < 300; k++) {
        const a = rnd() * TAU, r = Math.sqrt(rnd()) * reach;
        const x = s.x + Math.cos(a) * r, z = s.z + Math.sin(a) * r;
        if (!inPolygon(poly, x, z)) continue;
        inside++;
        if (lands.lookup(x, z) !== s.id) { notLands++; continue; } // a notch of wild mountain narrower than the march
        const so = terr.settlementOf(x, z);
        if (lands.holderOf(so) === s.id) { agree++; continue; }
        const land = terr.landAt(x, z);
        if (land.strip < 0 && land.parcel < 0) odd.push(`${s.name} ${x.toFixed(0)},${z.toFixed(0)} ${land.kind} of ${so}`);
      }
    }
    expect(inside).toBeGreaterThan(3000);
    expect(notLands / inside).toBeLessThan(0.002);
    expect(odd).toEqual([]);
    // the strips and parcels that cross a border are the few that disagree
    expect(agree / (inside - notLands)).toBeGreaterThan(0.98);
  });

  it('gives a castle that stands in its village\'s lands the village\'s outline, castle and all', () => {
    const castles = world.settlements.filter((s) => s.kind === 'castle' && s.parent !== undefined && lands.holderOf(s.id) === s.parent);
    expect(castles.length).toBeGreaterThan(0);
    for (const c of castles) {
      const poly = terr.landsPolygon(c.id);
      expect(poly).toBe(terr.landsPolygon(c.parent!));
      expect(inPolygon(poly, c.x, c.z), c.name).toBe(true);
    }
  });

  it('leaves the high mountains out: wild ground near a settlement is not inside its outline', () => {
    let wild = 0, inPoly = 0;
    for (const s of holders) {
      const poly = terr.landsPolygon(s.id);
      const reach = lands.radiusOf(s.id);
      for (let i = -reach; i <= reach; i += 80) {
        for (let j = -reach; j <= reach; j += 80) {
          const x = s.x + i, z = s.z + j;
          if (Math.hypot(i, j) > reach || lands.lookup(x, z) >= 0 || !lands.isHighCountry(x, z)) continue;
          wild++;
          if (inPolygon(poly, x, z)) inPoly++;
        }
      }
    }
    expect(wild).toBeGreaterThan(200); // the abc continent has a northern range
    expect(inPoly / wild).toBeLessThan(0.02);
  });

  it('has the lands of neighbouring settlements side by side, not overlapping', () => {
    const rnd = lcg(21);
    let n = 0, both = 0;
    for (let k = 0; k < 4000; k++) {
      const s = holders[Math.floor(rnd() * holders.length)];
      const a = rnd() * TAU, r = Math.sqrt(rnd()) * lands.extentOf(s.id);
      const x = s.x + Math.cos(a) * r, z = s.z + Math.sin(a) * r;
      if (!inPolygon(terr.landsPolygon(s.id), x, z)) continue;
      for (const o of holders) {
        if (o.id === s.id || Math.hypot(o.x - x, o.z - z) > lands.extentOf(o.id)) continue;
        n++;
        if (inPolygon(terr.landsPolygon(o.id), x, z)) both++;
      }
    }
    expect(n).toBeGreaterThan(500);
    expect(both / n).toBeLessThan(0.003);
  });
});

describe('outpostPolygons', () => {
  const rig = mockRig({ preset: 'small', seed: 'outposts' });
  const { terr, sim, world } = rig;
  const lands = landsOf(rig);
  const silver = world.deposits!.find((d) => d.kind === 'silver')!;
  const parent = world.settlements.find((s) => s.kind === 'village' && sim.state.titleFor('manor', s.id))!;
  const fake = scriptedConstruction(sim, []);
  const camp = { x: silver.x + 100, z: silver.z };
  const claim = TERRITORY.outpostClaim;

  it('is empty while there are no outposts', () => {
    expect(terr.outpostPolygons()).toEqual([]);
  });

  it('gives an outpost in the wild a disc of about 600 m of wild land, which is the parent\'s', () => {
    fake.found({ id: 7, name: 'Silverbeck', settlement: parent.id, x: camp.x, z: camp.z, deposit: silver.id, founded: sim.absDay });
    const list = terr.outpostPolygons();
    expect(list).toHaveLength(1);
    expect(list[0].outpost).toBe(7);
    const poly = list[0].poly;
    expect(poly.length).toBeGreaterThanOrEqual(32);
    expect(inPolygon(poly, camp.x, camp.z)).toBe(true);
    for (const v of poly) expect(Math.hypot(v.x - camp.x, v.z - camp.z)).toBeLessThanOrEqual(claim + 0.5);
    expect(area(poly) / (Math.PI * claim * claim)).toBeGreaterThan(0.95); // nothing else lies within 600 m of it
    const rnd = lcg(9);
    for (let k = 0; k < 300; k++) {
      const a = rnd() * TAU, r = Math.sqrt(rnd()) * claim;
      const x = camp.x + Math.cos(a) * r, z = camp.z + Math.sin(a) * r;
      if (!inPolygon(poly, x, z)) continue;
      expect(terr.settlementOf(x, z), `${x.toFixed(0)},${z.toFixed(0)}`).toBe(parent.id);
    }
    // and beyond it the land is wild again
    const out = { x: camp.x + claim + 30, z: camp.z };
    expect(inPolygon(poly, out.x, out.z)).toBe(false);
    expect(terr.settlementOf(out.x, out.z)).toBe(-1);
  });

  it('is the same list until an outpost is founded or lost', () => {
    const a = terr.outpostPolygons();
    expect(terr.outpostPolygons()).toBe(a);
    sim.events.emit('war', { phase: 'declared', war: 1, attackers: [1], defenders: [2] }); // ownership changes, the claims do not
    expect(terr.outpostPolygons()).toBe(a);
  });

  it('stops at settlements\' lands: an outpost near the border claims only the wild side', () => {
    // walk out from a village until its lands end, then stand a little way beyond
    const s = world.settlements.find((q) => q.kind === 'village' && q.id !== parent.id && lands.holderOf(q.id) === q.id)!;
    let spot: P2 | null = null;
    for (let a = 0; a < TAU && !spot; a += 0.35) {
      let r = 300;
      while (r < 5000 && lands.lookup(s.x + Math.cos(a) * r, s.z + Math.sin(a) * r) === s.id) r += 20;
      const x = s.x + Math.cos(a) * (r + 150), z = s.z + Math.sin(a) * (r + 150);
      if (x > 700 && z > 700 && x < 15300 && z < 15300 && lands.lookup(x, z) < 0 && lands.lookup(s.x + Math.cos(a) * (r + 150 + 700), s.z + Math.sin(a) * (r + 150 + 700)) < 0) spot = { x, z };
    }
    expect(spot).not.toBeNull();
    fake.found({ id: 8, name: 'Edge', settlement: parent.id, x: spot!.x, z: spot!.z, deposit: -1, founded: sim.absDay });
    const entry = terr.outpostPolygons().find((o) => o.outpost === 8)!;
    expect(entry.poly.length).toBeGreaterThanOrEqual(16);
    const full = Math.PI * claim * claim;
    expect(area(entry.poly)).toBeLessThan(full * 0.9);
    expect(area(entry.poly)).toBeGreaterThan(full * 0.2);
    for (const v of entry.poly) expect(lands.lookup(v.x, v.z), `${v.x},${v.z}`).toBe(-1);
    for (const v of entry.poly) for (const f of [0.5, 0.95]) expect(lands.lookup(spot!.x + (v.x - spot!.x) * f, spot!.z + (v.z - spot!.z) * f)).toBe(-1);
    fake.outposts.pop();
    terr.refresh();
  });

  it('gives an outpost that stands inside a settlement\'s lands nothing', () => {
    const s = world.settlements.find((q) => q.kind === 'village' && q.id !== parent.id && lands.holderOf(q.id) === q.id)!;
    fake.found({ id: 9, name: 'Squatters', settlement: parent.id, x: s.x + 200, z: s.z, deposit: -1, founded: sim.absDay });
    const entry = terr.outpostPolygons().find((o) => o.outpost === 9)!;
    expect(entry).toBeDefined();
    expect(entry.poly).toEqual([]);
    fake.outposts.pop();
    terr.refresh();
  });

  it('divides the land between two outposts by which is nearer', () => {
    fake.found({ id: 10, name: 'Second', settlement: parent.id, x: camp.x + 700, z: camp.z, deposit: -1, founded: sim.absDay });
    const list = terr.outpostPolygons();
    const a = list.find((o) => o.outpost === 7)!.poly, b = list.find((o) => o.outpost === 10)!.poly;
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    const midX = camp.x + 350; // the line between them
    for (const v of a) expect(v.x, `${v.x},${v.z}`).toBeLessThanOrEqual(midX + 0.5);
    for (const v of b) expect(v.x, `${v.x},${v.z}`).toBeGreaterThanOrEqual(midX - 0.5);
    // each keeps the half of its disc on its own side of the line
    expect(area(a)).toBeGreaterThan(0.4 * Math.PI * claim * claim);
    expect(area(b)).toBeGreaterThan(0.4 * Math.PI * claim * claim);
    expect(inPolygon(a, midX - 40, camp.z)).toBe(true);
    expect(inPolygon(b, midX - 40, camp.z)).toBe(false);
    expect(inPolygon(b, midX + 40, camp.z)).toBe(true);
  });

  it('is rebuilt when an outpost is lost', () => {
    const before = terr.outpostPolygons();
    fake.outposts.length = 0;
    terr.refresh();
    const after = terr.outpostPolygons();
    expect(after).not.toBe(before);
    expect(after).toEqual([]);
  });
});
