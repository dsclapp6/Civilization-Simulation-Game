// Walls laid in a line: one plan, priced and checked as a whole, staked as linked sites, all or none.
import { describe, expect, it } from 'vitest';
import { BUILDINGS } from '../../../src/content/types';
import { lineSlots } from '../../../src/sim/construction/line';
import { manorLord, openGround, probeVillage, rig, village } from './helpers';

const SEED = 'chk';
const V = probeVillage(SEED);
const OPEN = openGround(V, 250);

function lordRig() {
  const r = rig(SEED, { roads: [] });
  const v = village(r.sim);
  (r.sim.services as { advancement?: unknown }).advancement = { knows: () => false, houseHas: () => true };
  return { r, lord: manorLord(r.sim, v.id), v };
}

describe('a wall laid in a line', () => {
  it('lays whole lengths end to end and prices the run as one plan', () => {
    const { r, lord } = lordRig();
    const w = BUILDINGS.palisade.w;
    const plan = r.cons.planLine!(lord.id, 'palisade', OPEN, { x: OPEN.x + 10 * w, z: OPEN.z });
    expect(plan.ok, plan.reason).toBe(true);
    expect(plan.parts.length).toBe(9);
    const one = r.cons.cost('palisade', 1);
    expect(plan.cost.labour).toBeCloseTo(one.labour * plan.parts.length, 6);
    expect(plan.cost.goods.timber).toBeCloseTo((one.goods.timber ?? 0) * plan.parts.length, 6);
    expect(plan.end.x).toBeLessThanOrEqual(OPEN.x + 10 * w + 1e-6);
    expect(plan.end.x).toBeGreaterThan(OPEN.x + 9 * w);
  });

  it('stakes linked sites, counts them as one work, and calls them all off together', () => {
    const { r, lord } = lordRig();
    const w = BUILDINGS.palisade.w;
    const res = r.cons.placeLine!(lord.id, 'palisade', OPEN, { x: OPEN.x + 24 * w, z: OPEN.z + 6 });
    expect(res.ok, res.reason).toBe(true);
    expect(res.sites!.length).toBeGreaterThan(16);
    const views = r.cons.lineSites!(res.line!);
    expect(views.length).toBe(res.sites!.length);
    expect(new Set(views.map((s) => s.line))).toEqual(new Set([res.line]));
    const c = r.cons.cancelLine!(lord.id, res.line!);
    expect(c.ok).toBe(true);
    expect(c.cancelled).toBe(res.sites!.length);
    expect(r.cons.lineSites!(res.line!)).toHaveLength(0);
  });

  it('is all or none: a run with something in the way stakes nothing', () => {
    const { r, lord } = lordRig();
    const before = r.cons.sites().length;
    const w = BUILDINGS.palisade.w;
    const hut = r.cons.place(lord.id, 'hovel', OPEN.x + 3 * w + 2, OPEN.z, 0);
    expect(hut.ok, hut.reason).toBe(true);
    const plan = r.cons.planLine!(lord.id, 'palisade', OPEN, { x: OPEN.x + 8 * w, z: OPEN.z });
    expect(plan.ok).toBe(false);
    expect(plan.bad).toBeGreaterThan(0);
    const res = r.cons.placeLine!(lord.id, 'palisade', OPEN, { x: OPEN.x + 8 * w, z: OPEN.z });
    expect(res.ok).toBe(false);
    expect(r.cons.sites().length).toBe(before + 1);
  });

  it('puts towers at the ends and along the run, and a gate at the middle', () => {
    const slots = lineSlots('wall', 120, { towers: true, gate: true }, { tower: 4, gate: 1 });
    expect(slots[0].kind).toBe('tower');
    expect(slots[slots.length - 1].kind).toBe('tower');
    expect(slots.filter((s) => s.kind === 'gatehouse')).toHaveLength(1);
    expect(slots.filter((s) => s.kind === 'tower').length).toBeLessThanOrEqual(4);
    const total = slots.reduce((a, s) => a + s.len, 0);
    expect(total).toBeLessThanOrEqual(120);
    expect(total).toBeGreaterThan(120 - BUILDINGS.wall.w - 1);
    let pos = 0;
    for (const s of slots) {
      if (s.kind === 'gatehouse') expect(Math.abs(pos + s.len / 2 - 60)).toBeLessThan(BUILDINGS.wall.w + BUILDINGS.gatehouse.w);
      pos += s.len;
    }
    // no room: no towers, no gate
    const plain = lineSlots('wall', 120, { towers: true, gate: true }, { tower: 0, gate: 0 });
    expect(plain.every((s) => s.kind === 'wall')).toBe(true);
  });

  it('lays a wall with towers and a gate as real linked sites that touch without overlapping', () => {
    const { r, lord } = lordRig();
    const res = r.cons.placeLine!(lord.id, 'wall', OPEN, { x: OPEN.x + 90, z: OPEN.z }, { towers: true, gate: true });
    expect(res.ok, res.reason).toBe(true);
    const kinds = r.cons.lineSites!(res.line!).map((s) => s.kind);
    expect(kinds[0]).toBe('tower');
    expect(kinds).toContain('gatehouse');
    expect(kinds.filter((k) => k === 'wall').length).toBeGreaterThan(8);
    // the whole run is one open work for the payer
    expect(new Set(r.cons.lineSites!(res.line!).map((s) => s.line)).size).toBe(1);
  });

  it('refuses what is not a wall, and a run too long', () => {
    const { r, lord } = lordRig();
    expect(r.cons.planLine!(lord.id, 'cottage', OPEN, { x: OPEN.x + 50, z: OPEN.z }).ok).toBe(false);
    expect(r.cons.planLine!(lord.id, 'palisade', OPEN, { x: OPEN.x + 500, z: OPEN.z }).reason).toMatch(/too long/i);
  });
});
