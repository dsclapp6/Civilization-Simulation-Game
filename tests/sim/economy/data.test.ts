// The content tables: goods, recipes, crops, careers, perks (src/content/*.json) are consistent with each other.
import { describe, expect, it } from 'vitest';
import { SKILLS } from '../../../src/core/domain';
import { CAREERS } from '../../../src/sim/careers';
import {
  CAREER_ECON, CROPS, ENTRY_TESTS, GOODS, GOOD_LIST, MACRO_GOODS, PERKS, RECIPE_LIST, basePriceOf, describeItem, keyOf, pd, perksAt, validateData,
} from '../../../src/sim/economy/data';

describe('economy content', () => {
  it('has no dangling references', () => {
    expect(validateData()).toEqual([]);
  });

  it('every career of the sim has an economy row, with a wage ladder and a skill', () => {
    for (const id of Object.keys(CAREERS)) {
      const c = CAREER_ECON[id as keyof typeof CAREER_ECON];
      expect(c, `career ${id}`).toBeTruthy();
      expect(SKILLS).toContain(c.skill);
      expect(c.wage.length).toBeGreaterThan(0);
      for (const w of c.wage) expect(w).toBeGreaterThanOrEqual(0);
    }
  });

  it('has 160 perks: two choices at each of the four levels of every skill', () => {
    expect(PERKS.length).toBe(160);
    const ids = new Set<string>();
    for (const p of PERKS) {
      expect(ids.has(p.id), `duplicate ${p.id}`).toBe(false);
      ids.add(p.id);
      expect(p.id.startsWith(`${p.skill}.`)).toBe(true);
      expect([5, 10, 15, 20]).toContain(p.level);
      expect(p.name.length).toBeGreaterThan(2);
      expect(p.description.length).toBeGreaterThan(10);
      expect(p.effects && Object.keys(p.effects).length, p.id).toBeGreaterThan(0);
    }
    for (const skill of SKILLS) for (const level of [5, 10, 15, 20]) expect(perksAt(skill, level).length, `${skill} ${level}`).toBe(2);
  });

  it('goods: positive prices, the macro goods exist, qualities scale upwards, names read well', () => {
    expect(GOOD_LIST.length).toBeGreaterThanOrEqual(90);
    for (const g of GOOD_LIST) {
      expect(g.basePrice, g.id).toBeGreaterThan(0);
      expect(g.weight, g.id).toBeGreaterThanOrEqual(0);
      expect((g.unitOne ?? '').length, g.id).toBeGreaterThan(1);
      if (g.qualityPrice && g.category !== 'grain') {
        for (let i = 1; i < g.qualityPrice.length; i++) expect(g.qualityPrice[i], g.id).toBeGreaterThan(g.qualityPrice[i - 1]);
      }
    }
    // fourteen foods and fuels, and (civilization pass) twelve building materials and raw goods with a supply model
    expect(MACRO_GOODS.filter((g) => !GOODS[g].supply).length).toBe(14);
    expect(MACRO_GOODS.filter((g) => GOODS[g].supply).length).toBe(12);
    for (const g of MACRO_GOODS) if (GOODS[g].supply) {
      const s = GOODS[g].supply!;
      expect(s.use, g).toBeGreaterThan(0);
      expect(s.cover, g).toBeGreaterThan(1);
      expect(s.relax, g).toBeGreaterThan(0);
      expect(s.relax, g).toBeLessThan(0.5);
    }
    expect(basePriceOf('wheat')).toBe(1);
    expect(basePriceOf('sickle#3')).toBeGreaterThan(basePriceOf('sickle#1') * 3);
    expect(describeItem('eggs', 3)).toBe('3 dozen eggs');
    expect(describeItem('sickle#2', 1)).toBe('1 good sickle');
    expect(describeItem(keyOf('wheat', 1), 2)).toContain('wheat');
  });

  it('recipes make money for a skilled hand: the output is worth more than the inputs, tools exist', () => {
    expect(RECIPE_LIST.length).toBeGreaterThan(45);
    let thin = 0;
    for (const r of RECIPE_LIST) {
      let inV = 0, outV = 0;
      for (const [g, q] of Object.entries(r.inputs)) inV += GOODS[g].basePrice * q;
      for (const [g, q] of Object.entries(r.outputs)) outV += (GOODS[g].quality ? basePriceOf(keyOf(g, 2)) : GOODS[g].basePrice) * q; // a competent hand makes good work
      expect(r.work, r.id).toBeGreaterThan(0);
      expect(r.level, r.id).toBeGreaterThanOrEqual(0);
      if (outV < inV * 1.02) thin++;
    }
    // a few steps (milling, threshing) are services rather than profits, but the bulk of recipes pay
    expect(thin, 'recipes that lose money at base prices').toBeLessThan(RECIPE_LIST.length * 0.1);
  });

  it('crops have grow times and ratios that make sense; the recruiter tests include the archers', () => {
    for (const [id, c] of Object.entries(CROPS)) {
      expect(c.ratio, id).toBeGreaterThan(0);
      expect(c.seed, id).toBeGreaterThan(0);
      expect(c.seed, id).toBeLessThan(0.8);
    }
    const archer = ENTRY_TESTS.find((t) => t.career === 'archer');
    expect(archer?.stats.str).toBe(10);
    expect(archer?.skills.archery).toBe(3);
  });

  it('money texts', () => {
    expect(pd(0.45)).toBe('0.45d');
    expect(pd(4.5)).toBe('4½d');
    expect(pd(16)).toBe('1s 4d');
    expect(pd(748)).toBe('£3 2s 4d');
  });
});
