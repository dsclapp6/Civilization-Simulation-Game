import { describe, expect, it } from 'vitest';
import { PALETTE } from '../../src/assets/palette';
import { DAYS_PER_YEAR } from '../../src/core/time';
import { AppearanceCache, buildLook, mixColour } from '../../src/sim/appearance';
import { ageYears, type Person } from '../../src/sim/state';
import { newSim } from './helpers';

const sim = newSim({ seed: 'look', preset: 'large' });
const st = sim.state;
const cache = new AppearanceCache();
const all = [...st.persons.values()].filter((p) => !p.death);
const find = (f: (p: Person) => boolean): Person => {
  const p = all.find(f);
  if (!p) throw new Error('no such person in this world');
  return p;
};
const age = (p: Person): number => ageYears(p, sim.absDay);
const look = (p: Person) => cache.get(st, p, sim.absDay).look;
const dyeSet = (tier: number): number[] => PALETTE.dyes[tier];

describe('appearance', () => {
  it('is stable per person: the same object and version until something visible changes', () => {
    const p = find((x) => x.rankTier === 2 && age(x) > 25);
    const a = cache.get(st, p, sim.absDay);
    const b = cache.get(st, p, sim.absDay + 0.5);
    expect(b).toBe(a);
    expect(b.version).toBe(1);
    // a year later (a birthday), they have aged: a new look, a new version
    const c = cache.get(st, p, sim.absDay + DAYS_PER_YEAR + 1);
    expect(c.version).toBe(2);
    expect(c.look.age).toBeGreaterThan(a.look.age);
    // building it twice gives equal data
    expect(buildLook(st, p, sim.absDay)).toEqual(buildLook(st, p, sim.absDay));
    // marriage is visible (headwear), so it bumps the version
    const maiden = find((x) => x.sex === 'f' && !x.spouse && age(x) > 17 && age(x) < 30 && x.rankTier <= 2);
    const v1 = cache.get(st, maiden, sim.absDay).version;
    const husband = find((x) => x.sex === 'm' && !x.spouse && age(x) > 20 && x.rankTier <= 2);
    st.marry(husband, maiden, sim.absDay);
    expect(cache.get(st, maiden, sim.absDay).version).toBe(v1 + 1);
    expect(cache.get(st, maiden, sim.absDay).look.clothing.headwear).toMatch(/coif|veil|wimple/);
  });

  it('dresses serfs in undyed russet or rags, commoners in faded earth tones', () => {
    let rags = 0, plain = 0;
    for (const p of all.filter((x) => x.rankTier === 1 && age(x) >= 12).slice(0, 400)) {
      const c = look(p).clothing;
      if (c.tunicStyle === 'rags') { rags++; expect(c.shoes).toBe('bare'); continue; }
      plain++;
      expect(dyeSet(1)).toContain(c.tunic);
      expect(c.trim).toBeUndefined();
      expect(['short', 'long']).toContain(c.tunicStyle);
    }
    expect(plain).toBeGreaterThan(rags);
    for (const p of all.filter((x) => x.rankTier === 2 && !x.estate.startsWith('clergy') && age(x) >= 14 && x.career !== 'man_at_arms' && x.career !== 'sergeant').slice(0, 300)) {
      const c = look(p).clothing;
      expect(dyeSet(2)).toContain(c.tunic);
      expect(c.trim).toBeUndefined();
    }
  });

  it('gives gentry and nobles rich dyes, trim and cloaks; knights wear heraldic surcoats; royals crowns', () => {
    const knight = find((x) => x.sex === 'm' && x.career === 'knight' && x.rankTier === 5 && age(x) > 20 && !!st.house(x.house)?.heraldry);
    const kl = look(knight);
    expect(kl.clothing.tunicStyle).toBe('surcoat');
    expect(kl.heraldry).toEqual(st.house(knight.house)!.heraldry);
    expect(kl.clothing.tunic).toBe(kl.heraldry!.field);
    expect(kl.clothing.shoes).toBe('boots');

    const king = find((x) => st.titlesHeldBy(x.id).size > 0 && [...st.titlesHeldBy(x.id)].some((t) => t.kind === 'kingdom'));
    const kingLook = look(king);
    expect(kingLook.clothing.headwear).toBe('crown');
    expect(kingLook.clothing.tunicStyle).toBe('robe');
    expect(kingLook.clothing.trim).toBeDefined();

    const queen = find((x) => x.sex === 'f' && x.spouse !== 0 && [...st.titlesHeldBy(x.spouse)].some((t) => t.kind === 'kingdom'));
    expect(look(queen).clothing.headwear).toBe('crown');

    const gentry = find((x) => x.rankTier === 4 && x.sex === 'm' && age(x) > 25 && x.estate !== 'noble' && x.career === 'merchant');
    const gl = look(gentry).clothing;
    expect(dyeSet(4)).toContain(gl.tunic);
    expect(gl.cloak).toBeDefined();
    expect(gl.shoes).toBe('shoes');
    const earl = find((x) => x.rankTier === 7 && x.sex === 'm' && [...st.titlesHeldBy(x.id)].some((t) => t.kind === 'county'));
    expect(look(earl).clothing.headwear).toBe('circlet');
  });

  it('dresses clergy in habits and robes: monks, nuns, priests, bishops and abbots', () => {
    const monk = find((x) => x.career === 'monk' && x.sex === 'm' && age(x) > 25);
    const ml = look(monk).clothing;
    expect(ml.tunicStyle).toBe('habit');
    expect([0x2b2622, 0xe6e2d6, 0x6b4f35]).toContain(ml.tunic);
    expect(['hood', 'mitre']).toContain(ml.headwear);
    expect(look(monk).beard).toBe(0);
    const nun = find((x) => x.career === 'nun' && x.sex === 'f' && age(x) > 25);
    expect(look(nun).clothing.tunicStyle).toBe('habit');
    expect(look(nun).clothing.headwear).toMatch(/veil|wimple/);
    const priest = find((x) => x.career === 'priest' && x.sex === 'm');
    expect(look(priest).clothing.tunicStyle).toBe('robe');
    const abbot = find((x) => x.career === 'abbot' && x.sex === 'm');
    expect(look(abbot).clothing.tunicStyle).toBe('habit');
  });

  it('draws headwear by sex and marital state: hoods and straw hats for men, coifs, veils and wimples for women', () => {
    const wives = all.filter((x) => x.sex === 'f' && x.spouse && x.rankTier <= 3 && age(x) > 18 && age(x) < 50).slice(0, 200);
    for (const w of wives) expect(['coif', 'veil', 'wimple']).toContain(look(w).clothing.headwear);
    const girls = all.filter((x) => x.sex === 'f' && !x.spouse && x.children.length === 0 && age(x) < 18 && x.rankTier <= 2).slice(0, 100);
    for (const g of girls) expect(look(g).clothing.headwear).toBe('none');
    const hats = new Set(all.filter((x) => x.sex === 'm' && x.rankTier <= 2 && age(x) > 16 && x.career !== 'man_at_arms').slice(0, 400).map((x) => look(x).clothing.headwear));
    expect(hats.has('hood')).toBe(true);
    expect(hats.has('straw_hat') || hats.has('felt_hat')).toBe(true);
    const guard = find((x) => x.career === 'man_at_arms');
    expect(look(guard).armour).toMatch(/mail|padded/);
    expect(look(guard).helmet).not.toBe('none');
  });

  it('makes children small and elders grey and slightly stooped', () => {
    const child = find((x) => age(x) > 5.5 && age(x) < 6.5);
    const adultM = find((x) => x.sex === 'm' && age(x) > 25 && age(x) < 35);
    expect(look(child).height).toBeGreaterThan(0.85);
    expect(look(child).height).toBeLessThan(1.25);
    expect(look(adultM).height).toBeGreaterThan(1.55);
    expect(look(adultM).height).toBeLessThan(1.9);
    const men = all.filter((x) => x.sex === 'm' && age(x) > 22 && age(x) < 50).map((x) => look(x).height);
    const women = all.filter((x) => x.sex === 'f' && age(x) > 22 && age(x) < 50).map((x) => look(x).height);
    const mean = (a: number[]): number => a.reduce((s, v) => s + v, 0) / a.length;
    expect(mean(men)).toBeGreaterThan(mean(women) + 0.08);
    const old = all.filter((x) => age(x) > 70);
    expect(old.length).toBeGreaterThan(10);
    const greyish = old.filter((x) => { const h = look(x).hair; return h === 0x8f8f8f || h === 0xd8d8d8 || Math.abs(((h >> 16) & 255) - ((h >> 8) & 255)) < 30; });
    expect(greyish.length / old.length).toBeGreaterThan(0.8);
    const youngHair = new Set(all.filter((x) => age(x) > 14 && age(x) < 28).slice(0, 300).map((x) => look(x).hair));
    expect(youngHair.size).toBeGreaterThan(3);
    for (const p of all.slice(0, 500)) {
      const l = look(p);
      expect(l.build).toBeGreaterThanOrEqual(0);
      expect(l.build).toBeLessThanOrEqual(1);
      expect(l.hairStyle).toBeGreaterThanOrEqual(0);
      expect(l.hairStyle).toBeLessThanOrEqual(7);
      expect(l.beard).toBeGreaterThanOrEqual(0);
      expect(l.beard).toBeLessThanOrEqual(4);
      expect(l.sex).toBe(p.sex);
      expect(l.culture).toBe(p.culture);
      if (p.sex === 'f') expect(l.beard).toBe(0);
    }
  });

  it('inherits skin and hair from the parents', () => {
    const pairs = all.filter((x) => x.father && x.mother && st.persons.get(x.father) && st.persons.get(x.mother)).slice(0, 400);
    expect(pairs.length).toBeGreaterThan(100);
    let close = 0;
    for (const c of pairs) {
      const f = st.persons.get(c.father)!, m = st.persons.get(c.mother)!;
      if (Math.abs(c.genes.skin - (f.genes.skin + m.genes.skin) / 2) < 0.25) close++;
    }
    expect(close / pairs.length).toBeGreaterThan(0.9);
    expect(mixColour(0x000000, 0xffffff, 0.5)).toBe(0x808080);
  });
});
