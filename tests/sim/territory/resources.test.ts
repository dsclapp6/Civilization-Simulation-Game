// What a settlement's lands hold and can make: its deposits, the share of woodland, the fertility of its fields, coast and river,
// and the goods its lands can yield.
import { describe, expect, it } from 'vitest';
import { GOODS } from '../../../src/sim/economy/data';
import { LandsIndex } from '../../../src/world/lands';
import type { ResourceKind } from '../../../src/world/types';
import { mockRig, realRig } from './helpers';

const YIELD_OF: Record<ResourceKind, string> = { iron: 'iron_ore', stone: 'stone', clay: 'clay', salt: 'salt', silver: 'silver_ore', gold: 'gold_ore' };
const KNOWN_YIELDS = new Set(['grain', 'wool', 'hay', 'timber', 'firewood', 'fish', ...Object.values(YIELD_OF)]);

describe('resource profiles (stand-in world)', () => {
  const { terr, world } = mockRig({ preset: 'small', seed: 'res' });

  it('lists the deposits inside a settlement\'s lands and the goods they yield', () => {
    const holding = world.settlements.find((s) => world.deposits!.some((d) => d.settlement === s.id && d.kind === 'iron'))!;
    const p = terr.resources(holding.id);
    expect(p.settlement).toBe(holding.id);
    expect(p.deposits.every((d) => d.settlement === holding.id)).toBe(true);
    expect(p.deposits.length).toBe(world.deposits!.filter((d) => d.settlement === holding.id).length);
    expect(p.yields).toContain('iron_ore');
    for (const d of p.deposits) expect(p.yields).toContain(YIELD_OF[d.kind]);
  });

  it('says what the fields and the lie of the land are', () => {
    const p = terr.resources(world.settlements.find((s) => s.kind === 'village')!.id);
    expect(p.fertility).toBeGreaterThan(0.5);        // the stand-in map's soil is 160/255
    expect(p.fertility).toBeLessThan(0.7);
    expect(p.forest).toBe(0);                         // and has no woods
    expect(p.coast).toBe(false);
    expect(p.river).toBe(false);
    expect(p.yields).toContain('grain');
    expect(p.yields).not.toContain('fish');
    expect(p.yields).toContain('wool');               // the village has its pasture
  });

  it('shares a castle\'s resources with its parent village; the profile names the settlement asked about', () => {
    const castle = world.settlements.find((s) => s.kind === 'castle' && s.parent !== undefined)!;
    const a = terr.resources(castle.id), b = terr.resources(castle.parent!);
    expect(a.settlement).toBe(castle.id);
    expect(b.settlement).toBe(castle.parent);
    expect(a.deposits).toEqual(b.deposits);
    expect(a.yields).toEqual(b.yields);
    expect(a.fertility).toBe(b.fertility);
  });

  it('gives an empty profile for a place that does not exist, and the same answer every time', () => {
    expect(terr.resources(123456)).toEqual({ settlement: 123456, deposits: [], forest: 0, fertility: 0, coast: false, river: false, yields: [] });
    const v = world.settlements.find((s) => s.kind === 'village')!;
    expect(terr.resources(v.id)).toEqual(terr.resources(v.id));
  });
});

describe('resource profiles (real continent)', () => {
  const { terr, world } = realRig(true);
  const lands = new LandsIndex(world.settlements, { biome: world.macro.biome, res: world.macro.res, cell: world.macro.cell });
  const profiles = world.settlements.map((s) => terr.resources(s.id));

  it('is sane for every settlement: shares in 0..1, known goods, no duplicates, deposits of its own lands', () => {
    for (const p of profiles) {
      const s = world.settlements[p.settlement];
      expect(p.forest, s.name).toBeGreaterThanOrEqual(0); expect(p.forest).toBeLessThanOrEqual(1);
      expect(p.fertility).toBeGreaterThanOrEqual(0); expect(p.fertility).toBeLessThanOrEqual(1);
      expect(new Set(p.yields).size).toBe(p.yields.length);
      for (const y of p.yields) expect(KNOWN_YIELDS.has(y), y).toBe(true);
      for (const d of p.deposits) expect(d.settlement, `${s.name}: ${d.kind} #${d.id}`).toBe(lands.holderOf(s.id));
    }
  });

  it('names real goods: every yield but "grain" (a family of goods) is a good of the economy', () => {
    for (const y of KNOWN_YIELDS) expect(y === 'grain' || GOODS[y] !== undefined, y).toBe(true);
    for (const p of profiles) for (const y of p.yields) expect(y === 'grain' || GOODS[y] !== undefined, y).toBe(true);
  });

  it('lets a place with iron in its lands mine iron ore, one with clay make bricks, one with salt boil it', () => {
    for (const kind of ['iron', 'stone', 'clay', 'salt', 'silver', 'gold'] as const) {
      const holder = world.deposits!.find((d) => d.kind === kind && d.settlement >= 0);
      if (!holder) continue;
      expect(terr.resources(holder.settlement).yields, `${kind} at ${world.settlements[holder.settlement].name}`).toContain(YIELD_OF[kind]);
    }
  });

  it('puts every deposit in some place\'s profile, once (a castle\'s through its parent)', () => {
    const seen = new Map<number, number>();
    const done = new Set<number>();
    for (const s of world.settlements) {
      const holder = lands.holderOf(s.id);
      if (done.has(holder)) continue;
      done.add(holder);
      for (const d of terr.resources(holder).deposits) seen.set(d.id, (seen.get(d.id) ?? 0) + 1);
    }
    for (const d of world.deposits!) if (d.settlement >= 0) expect(seen.get(d.id), `${d.kind} #${d.id}`).toBe(1); else expect(seen.has(d.id)).toBe(false);
  });

  it('shows the coast, the rivers and the woods where they are', () => {
    const coastal = profiles.filter((p) => p.coast);
    const inland = profiles.filter((p) => !p.coast);
    expect(coastal.length).toBeGreaterThan(2);
    expect(inland.length).toBeGreaterThan(2);
    for (const p of coastal) expect(p.yields).toContain('fish');
    expect(profiles.some((p) => p.river)).toBe(true);
    const wooded = profiles.slice().sort((a, b) => b.forest - a.forest)[0];
    expect(wooded.forest).toBeGreaterThan(0.18);
    expect(wooded.yields).toContain('timber');
    const clear = profiles.filter((p) => p.forest < 0.02);
    for (const p of clear) expect(p.yields).not.toContain('timber');
  });

  it('shows who has grain (a village with open fields on good soil) and who has none (a mountain keep)', () => {
    const farming = world.settlements.filter((s) => s.kind === 'village' && s.strips.length > 60);
    expect(farming.length).toBeGreaterThan(5);
    expect(farming.filter((s) => terr.resources(s.id).yields.includes('grain')).length).toBeGreaterThan(farming.length * 0.7);
    for (const s of world.settlements.filter((q) => q.strips.length === 0 && q.kind !== 'castle')) expect(terr.resources(s.id).yields).not.toContain('grain');
  });
});
