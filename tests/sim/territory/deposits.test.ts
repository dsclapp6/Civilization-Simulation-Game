// The deposit queries: the list, `depositAt` (the one a point lies on) and `depositsNear` (by distance from the point to the centre).
import { describe, expect, it } from 'vitest';
import { RESOURCE_KINDS, type Deposit, type WorldModel } from '../../../src/world/types';
import { mockRig, realRig } from './helpers';

function addOverlapping(w: WorldModel): void {
  const ds = w.deposits as Deposit[];
  const base = ds.length;
  ds.push({ id: base, kind: 'iron', x: 7000, z: 7000, radius: 60, richness: 0.8, settlement: -1 });
  ds.push({ id: base + 1, kind: 'clay', x: 7040, z: 7000, radius: 60, richness: 0.4, settlement: -1 });
}

describe('deposit queries (stand-in world)', () => {
  const rig = mockRig({ preset: 'small', seed: 'deps', mutate: addOverlapping });
  const { terr, world } = rig;
  const all = world.deposits!;
  const iron = all[all.length - 2], clay = all[all.length - 1];

  it('lists the world\'s deposits', () => {
    expect(terr.deposits()).toBe(world.deposits);
    expect(terr.deposits().length).toBeGreaterThan(10);
    for (const k of RESOURCE_KINDS) expect(terr.deposits().some((d) => d.kind === k), k).toBe(true);
  });

  it('finds the deposit a point lies on: inside its radius, none outside, the one it is nearest the middle of, by kind', () => {
    const d = all[0];
    expect(terr.depositAt(d.x, d.z)).toBe(d);
    expect(terr.depositAt(d.x + d.radius * 0.99, d.z)?.id).toBe(d.id);
    expect(terr.depositAt(d.x + d.radius + 2, d.z)).toBeNull();
    expect(terr.depositAt(d.x, d.z, d.kind)).toBe(d);
    expect(terr.depositAt(d.x, d.z, d.kind === 'gold' ? 'salt' : 'gold')).toBeNull();
    expect(terr.depositAt(1, 1)).toBeNull();
    // where two overlap, the nearer centre; a kind asked for picks that kind
    expect(terr.depositAt(7010, 7000)).toBe(iron);
    expect(terr.depositAt(7030, 7000)).toBe(clay);
    expect(terr.depositAt(7030, 7000, 'iron')).toBe(iron);
    expect(terr.depositAt(7010, 7000, 'clay')).toBe(clay);
    expect(terr.depositAt(7000, 7000 + 59, 'clay')).toBeNull();
  });

  it('lists deposits near a point by distance to their centres, nearest first, optionally of one kind', () => {
    const near = terr.depositsNear(7020, 7000, 100);
    expect(near.map((d) => d.id)).toEqual([iron.id, clay.id].sort((a, b) => Math.hypot(all[a].x - 7020, all[a].z - 7000) - Math.hypot(all[b].x - 7020, all[b].z - 7000)));
    expect(terr.depositsNear(7020, 7000, 100, 'clay')).toEqual([clay]);
    expect(terr.depositsNear(7020, 7000, 10)).toEqual([]);
    expect(terr.depositsNear(7000, 7000, 0)).toEqual([iron]);
    // across the 512 m cells the index uses
    const wide = terr.depositsNear(8000, 8000, 5000);
    const brute = all.filter((d) => Math.hypot(d.x - 8000, d.z - 8000) <= 5000).sort((a, b) => Math.hypot(a.x - 8000, a.z - 8000) - Math.hypot(b.x - 8000, b.z - 8000) || a.id - b.id);
    expect(wide.map((d) => d.id)).toEqual(brute.map((d) => d.id));
  });
});

describe('deposit queries (real continent)', () => {
  const { terr, world } = realRig(true);

  it('agrees with a plain scan over the whole list for any point and radius', () => {
    const all = world.deposits!;
    for (let i = 0; i < 60; i++) {
      const x = (i * 2399.3) % 15500 + 200, z = (i * 1777.7) % 15500 + 200, r = 300 + ((i * 421) % 4000);
      const kind = i % 3 === 0 ? RESOURCE_KINDS[i % RESOURCE_KINDS.length] : undefined;
      const want = all.filter((d) => (!kind || d.kind === kind) && Math.hypot(d.x - x, d.z - z) <= r).sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z) || a.id - b.id).map((d) => d.id);
      expect(terr.depositsNear(x, z, r, kind).map((d) => d.id), `query ${i}`).toEqual(want);
    }
  });

  it('puts every deposit on itself and finds it by its middle', () => {
    for (const d of world.deposits!) expect(terr.depositAt(d.x, d.z)?.id, `${d.kind} #${d.id}`).toBe(d.id);
  });

  it('keeps the deposit\'s settlement and the lands the same thing: a deposit lies in the lands of the settlement it names (a castle\'s park is its own)', () => {
    for (const d of world.deposits!) {
      const at = terr.settlementOf(d.x, d.z);
      if (at === d.settlement) continue;
      // the only difference: a deposit in a castle's park is the castle's, whose lands are its parent village's
      const castle = world.settlements[at];
      expect(castle?.kind, `${d.kind} #${d.id}`).toBe('castle');
      expect(castle.parent).toBe(d.settlement);
    }
  });
});
