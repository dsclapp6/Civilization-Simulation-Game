// The content table: every building kind and level has a cost, the costs name real goods and techniques, and the ratios are
// plausible (docs/CIV.md §5 examples).
import { describe, expect, it } from 'vitest';
import goodsJson from '../../../src/content/goods.json';
import techsJson from '../../../src/content/techs.json';
import { BUILDINGS, BUILDING_KINDS } from '../../../src/content/types';
import {
  CATEGORY_NAMES, OFFICES, RULES, levelCost, maxCrew, maxPerSettlement, priceOf, rulesOf, totalCost, wageFor,
} from '../../../src/sim/construction/data';

const goods = goodsJson as unknown as Record<string, unknown>;
const techIds = new Set((techsJson as unknown as { techs: Array<{ id: string }> }).techs.map((t) => t.id));

describe('construction content', () => {
  it('has rules for every building kind, one cost per level', () => {
    for (const kind of BUILDING_KINDS) {
      const r = RULES.get(kind);
      expect(r, kind).toBeDefined();
      expect(r!.levels.length, `${kind} levels`).toBe(BUILDINGS[kind].maxLevel);
      expect(r!.does.length, `${kind} does`).toBeGreaterThan(10);
      expect(CATEGORY_NAMES[r!.cat], `${kind} cat`).toBeDefined();
    }
    expect(RULES.size).toBe(BUILDING_KINDS.length);
  });

  it('prices only goods that exist and gates only real techniques', () => {
    for (const kind of BUILDING_KINDS) {
      const r = rulesOf(kind);
      for (const l of r.levels) {
        expect(l.labour, kind).toBeGreaterThan(0);
        expect(l.pence, kind).toBeGreaterThanOrEqual(0);
        for (const [g, q] of Object.entries(l.goods)) {
          expect(goods[g], `${kind}: ${g}`).toBeDefined();
          expect(q, `${kind}: ${g}`).toBeGreaterThan(0);
        }
      }
      if (r.tech) expect(techIds.has(r.tech), `${kind} tech ${r.tech}`).toBe(true);
      if (r.terrain === 'deposit') expect((r.deposits ?? []).length, kind).toBeGreaterThan(0);
      if (r.terrain === 'river') expect(BUILDINGS[kind].needsRiver, kind).toBe(true);
    }
  });

  it('keeps the design examples (CIV §5)', () => {
    expect(levelCost('hovel').labour).toBe(2);
    expect(levelCost('cottage')).toMatchObject({ labour: 8, goods: { planks: 20, straw: 30 } });
    expect(levelCost('barn').labour).toBe(14);
    expect(levelCost('smithy')).toMatchObject({ labour: 16, goods: { stone: 6 } });
    expect(levelCost('watermill').labour).toBe(60);
    expect(rulesOf('watermill').tech).toBe('watermill');
    expect(levelCost('church')).toMatchObject({ labour: 900, goods: { stone: 400 } });
    expect(levelCost('palisade')).toMatchObject({ labour: 6, goods: { timber: 30 } });
    expect(levelCost('wall')).toMatchObject({ labour: 120, goods: { stone: 160 } });
    expect(rulesOf('wall').tech).toBe('curtain_walls');
    expect(levelCost('keep_stone')).toMatchObject({ labour: 2000, goods: { stone: 2500 } });
  });

  it('costs grow with the size of what is built, and upgrades add to the total', () => {
    const lab = (k: Parameters<typeof levelCost>[0]): number => levelCost(k).labour;
    expect(lab('hovel')).toBeLessThan(lab('cottage'));
    expect(lab('cottage')).toBeLessThan(lab('longhouse'));
    expect(lab('longhouse')).toBeLessThan(lab('manor_house'));
    expect(lab('chapel')).toBeLessThan(lab('church'));
    expect(lab('church')).toBeLessThan(lab('abbey_church'));
    expect(lab('abbey_church')).toBeLessThan(lab('cathedral'));
    expect(lab('palisade')).toBeLessThan(lab('wall'));
    expect(lab('wall')).toBeLessThan(lab('keep_stone'));
    expect(totalCost('cottage', 3).labour).toBe(levelCost('cottage', 1).labour + levelCost('cottage', 2).labour + levelCost('cottage', 3).labour);
    expect(totalCost('cottage', 2).goods.planks).toBe(20 + 14);
    // a level past the last is the last
    expect(levelCost('hovel', 5)).toEqual(levelCost('hovel', 1));
  });

  it('answers the SPEC §2 building times at a plausible crew', () => {
    // days at the largest useful crew: hut 1, house 2–3, mill 4, keep a few seasons (a season is 4 days), walls years
    const days = (k: Parameters<typeof levelCost>[0]): number => levelCost(k).labour / maxCrew(levelCost(k).labour);
    expect(days('hovel')).toBeLessThanOrEqual(1.1);
    expect(days('cottage')).toBeLessThanOrEqual(4.1);
    expect(days('watermill')).toBeLessThanOrEqual(5);
    expect(days('keep_stone')).toBeGreaterThan(40);
    expect(days('keep_stone')).toBeLessThan(90);
  });

  it('knows prices, wages and counts allowed', () => {
    expect(priceOf('planks')).toBe(2.5);
    expect(priceOf('no_such_good')).toBe(1);
    expect(wageFor('keep_stone')).toBeGreaterThan(wageFor('cottage'));
    expect(maxPerSettlement('church', 'village')).toBe(1);
    expect(maxPerSettlement('church', 'city')).toBe(6);
    expect(maxPerSettlement('cottage', 'village')).toBe(Infinity);
    expect(maxPerSettlement('smithy', undefined)).toBe(3);
  });

  it('names the offices that build for a lord', () => {
    expect(OFFICES['steward']?.agent).toBe(true);
    expect(OFFICES['reeve']?.cats).toContain('farm');
    expect(OFFICES['mayor']?.agent).toBe(false);
  });
});
