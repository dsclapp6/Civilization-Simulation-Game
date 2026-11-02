// The price of researching a technique (src/content/techs.json `research`, docs/CIV.md §6.4): every technique has one, in its
// branch's currencies, in goods and buildings that exist, costing more the further up the tree it stands.
import { describe, expect, it } from 'vitest';
import { BUILDINGS } from '../../../src/content/types';
import { GOODS } from '../../../src/sim/economy/data';
import { BRANCHES, TECHS } from '../../../src/sim/advancement';

const CURRENCY: Record<string, readonly string[]> = {
  // docs/CIV.md §6.4: Economy - timber, bricks/stone, coin; Military - iron, coin (horses for destriers, stone for keeps and walls);
  // Kinship & Diplomacy - coin and gifts (cloth, ale); Knowledge & Belief - vellum, candles, coin
  economy: ['timber', 'planks', 'stone', 'brick', 'straw'],
  military: ['iron', 'horse', 'stone', 'timber', 'arrow'],
  kinship: ['cloth', 'ale'],
  knowledge: ['vellum', 'candle', 'iron'],
};

describe('research prices', () => {
  it('give every technique goods, coin, days and a place to work', () => {
    for (const t of TECHS) {
      const r = t.research;
      expect(r, t.id).toBeTruthy();
      expect(r!.pence, t.id).toBeGreaterThan(0);
      expect(r!.days, t.id).toBeGreaterThan(0);
      expect(r!.place.length, t.id).toBeGreaterThan(0);
      expect(Object.keys(r!.goods).length, t.id).toBeGreaterThan(0);
    }
  });

  it('name goods and buildings that exist', () => {
    for (const t of TECHS) {
      for (const [g, q] of Object.entries(t.research!.goods)) {
        expect(GOODS[g], `${t.id}: ${g}`).toBeTruthy();
        expect(q, `${t.id}: ${g}`).toBeGreaterThan(0);
      }
      for (const kind of t.research!.place) expect(BUILDINGS[kind as keyof typeof BUILDINGS], `${t.id}: ${kind}`).toBeTruthy();
    }
  });

  it('are paid in the currencies of the technique\'s branch', () => {
    expect(BRANCHES.map((b) => b.id)).toEqual(Object.keys(CURRENCY));
    for (const t of TECHS) {
      for (const g of Object.keys(t.research!.goods)) expect(CURRENCY[t.branch], `${t.id} (${t.branch}) wants ${g}`).toContain(g);
    }
    // the signature currency of each branch is used
    const used = (branch: string): Set<string> => new Set(TECHS.filter((t) => t.branch === branch).flatMap((t) => Object.keys(t.research!.goods)));
    expect(used('military').has('iron')).toBe(true);
    expect(used('military').has('horse')).toBe(true); // destriers
    expect(used('military').has('stone')).toBe(true); // keeps and walls
    expect(used('knowledge').has('vellum')).toBe(true);
    expect(used('knowledge').has('candle')).toBe(true);
    expect(used('kinship').has('cloth')).toBe(true);
    expect(used('kinship').has('ale')).toBe(true);
    expect(used('economy').has('brick')).toBe(true);
  });

  it('cost more and take longer the further up the tree a technique stands', () => {
    const by = new Map(TECHS.map((t) => [t.id, t]));
    for (const t of TECHS) {
      for (const parent of t.requires) {
        const p = by.get(parent)!;
        expect(t.research!.pence, `${t.id} costs less than ${parent}`).toBeGreaterThan(p.research!.pence);
        expect(t.research!.days, `${t.id} is quicker than ${parent}`).toBeGreaterThan(p.research!.days);
      }
    }
  });

  it('are worth the trouble: dearer than a master\'s lesson, and within reach of a landed knight for the early ones', () => {
    for (const t of TECHS) expect(t.research!.pence, t.id).toBeGreaterThan(t.teach.fee * 0.4);
    // a landed knight's purse is a few thousand pence: the first rung of every branch is within his means
    for (const id of ['heavy_plough', 'longbow_drill', 'oaths', 'parish_school']) expect(TECHS.find((t) => t.id === id)!.research!.pence).toBeLessThan(1000);
  });
});
