import { beforeAll, describe, expect, it } from 'vitest';
import { STAT_CAP, STATS } from '../../src/core/domain';
import { generatePopulation } from '../../src/sim/population';
import { hashState } from '../../src/sim/serialize';
import { GameState, ageYears, type Person } from '../../src/sim/state';
import { createMockWorld } from '../../src/sim/testing/mockWorld';
import type { WorldModel } from '../../src/world/types';

let world: WorldModel;
let state: GameState;
let genMs = 0;
const living = (): Person[] => [...state.persons.values()].filter((p) => !p.death);

beforeAll(() => {
  world = createMockWorld({ seed: 'pop', preset: 'large' });
  state = GameState.fromWorld(world, 'pop', 'knight');
  const t0 = performance.now();
  generatePopulation(state, world);
  genMs = performance.now() - t0;
});

describe('initial population (large mock world, ~12k people)', () => {
  it('generates 10-15k people in under 1.5 s', () => {
    expect(genMs).toBeLessThan(1500);
    expect(state.living).toBeGreaterThanOrEqual(10_000);
    expect(state.living).toBeLessThanOrEqual(15_000);
    const target = world.settlements.reduce((a, s) => a + s.population, 0);
    expect(state.living / target).toBeGreaterThan(0.92);
    expect(state.living / target).toBeLessThan(1.12);
  });

  it('follows the social composition of SPEC §4: peasants about 80-90%', () => {
    const n = state.living;
    const tier = new Array(9).fill(0);
    for (const p of living()) tier[p.rankTier]++;
    const peasants = (tier[1] + tier[2]) / n;
    expect(peasants).toBeGreaterThanOrEqual(0.8);
    expect(peasants).toBeLessThanOrEqual(0.92);
    expect(tier[1] / n).toBeGreaterThan(0.25); // many unfree
    expect(tier[3] / n).toBeGreaterThan(0.05);
    expect(tier[3] / n).toBeLessThan(0.2);
    const nobility = (tier[4] + tier[5] + tier[6] + tier[7] + tier[8]) / n;
    expect(nobility).toBeGreaterThan(0.015);
    expect(nobility).toBeLessThan(0.08);
    for (let t = 1; t <= 8; t++) expect(tier[t]).toBeGreaterThan(0);
  });

  it('has a king in every kingdom capital with a royal family, earls per county, barons at castles', () => {
    for (const k of world.kingdoms) {
      const t = state.titleFor('kingdom', k.id)!;
      expect(t).toBeDefined();
      const king = state.persons.get(t.holder)!;
      expect(king.sex).toBe('m');
      expect(king.rankTier).toBe(8);
      expect(king.settlement).toBe(k.capital);
      const royals = living().filter((p) => p.rankTier === 8 && p.settlement === k.capital);
      expect(royals.length).toBeGreaterThanOrEqual(3);
      for (const cid of k.counties) {
        const c = state.titleFor('county', cid)!;
        const holder = state.persons.get(c.holder)!;
        expect(holder.rankTier).toBeGreaterThanOrEqual(7);
        expect(state.title(c.liege)?.kind).toBe('kingdom');
      }
    }
    for (const s of world.settlements.filter((x) => x.kind === 'castle')) {
      const isSeat = world.counties.some((c) => c.seat === s.id);
      if (isSeat) continue;
      const b = state.titleFor('barony', s.id)!;
      expect(b).toBeDefined();
      expect(state.persons.get(b.holder)!.rankTier).toBe(6);
      expect(state.title(b.liege)?.kind).toBe('county');
    }
  });

  it('gives every village and hamlet a knight as manor lord; one knight may hold several', () => {
    const holders = new Map<number, number>();
    for (const s of world.settlements.filter((x) => x.kind === 'village' || x.kind === 'hamlet')) {
      const t = state.titleFor('manor', s.id)!;
      expect(t, s.name).toBeDefined();
      const lord = state.persons.get(t.holder)!;
      expect(lord.sex).toBe('m');
      expect(lord.rankTier).toBe(5);
      expect(lord.estate).toBe('noble');
      expect(lord.career).toBe('knight');
      holders.set(lord.id, (holders.get(lord.id) ?? 0) + 1);
      expect(['barony', 'county']).toContain(state.title(t.liege)?.kind);
    }
    expect(Math.max(...holders.values())).toBeGreaterThanOrEqual(2);
    expect(Math.max(...holders.values())).toBeLessThanOrEqual(3);
  });

  it('populates villages with priest, reeve, miller, smith and alewife where the buildings exist', () => {
    let villages = 0;
    for (const s of world.settlements.filter((x) => x.kind === 'village')) {
      villages++;
      const kinds = new Set(s.plots.map((id) => state.buildings.get(id)!.kind));
      const res = state.residentList(s.id);
      if (kinds.has('church')) expect(res.some((p) => p.career === 'priest' && p.estate === 'clergy'), `${s.name} priest`).toBe(true);
      expect(res.some((p) => p.offices.some((o) => o.office === 'reeve')), `${s.name} reeve`).toBe(true);
      if (kinds.has('watermill') || kinds.has('windmill')) expect(res.some((p) => p.career === 'miller' && p.careerStage >= 2)).toBe(true);
      if (kinds.has('smithy')) expect(res.some((p) => p.career === 'smith' && p.careerStage >= 2)).toBe(true);
      if (kinds.has('alehouse')) expect(res.some((p) => p.career === 'alewife')).toBe(true);
      const peasants = res.filter((p) => p.rankTier <= 2).length;
      expect(peasants / res.length).toBeGreaterThan(0.6);
    }
    expect(villages).toBeGreaterThan(50);
  });

  it('populates towns with masters, journeymen, apprentices, merchants, labourers and servants', () => {
    for (const s of world.settlements.filter((x) => x.kind === 'town' || x.kind === 'city')) {
      const res = state.residentList(s.id);
      const has = (f: (p: Person) => boolean): boolean => res.some(f);
      expect(has((p) => p.careerStage === 2 && p.rankTier === 3 && ['smith', 'carpenter', 'mason', 'baker', 'weaver', 'tanner', 'tailor', 'miller', 'butcher', 'cooper', 'cobbler', 'potter', 'fuller', 'chandler', 'wheelwright', 'saddler'].includes(p.career)), `${s.name} masters`).toBe(true);
      expect(has((p) => p.careerStage === 1 && p.rankTier === 2 && p.sex === 'm' && p.career !== 'servant' && p.career !== 'merchant'), `${s.name} journeymen`).toBe(true);
      expect(has((p) => p.careerStage === 0 && p.rankTier === 2 && p.career !== 'labourer' && p.career !== 'farmer' && p.career !== 'child' && p.career !== 'none' && p.career !== 'weaver' && p.career !== 'alewife' && p.career !== 'cook' && p.career !== 'shopkeeper'), `${s.name} apprentices`).toBe(true);
      expect(has((p) => p.career === 'merchant'), `${s.name} merchants`).toBe(true);
      expect(has((p) => p.career === 'labourer'), `${s.name} labourers`).toBe(true);
      expect(has((p) => p.career === 'servant' && p.rankTier === 1), `${s.name} servants`).toBe(true);
      expect(has((p) => p.offices.some((o) => o.office === 'mayor' || o.office === 'alderman'))).toBe(true);
    }
  });

  it('populates castles with the lord, knights, men-at-arms and servants; abbeys with an abbot or abbess', () => {
    for (const s of world.settlements.filter((x) => x.kind === 'castle')) {
      const res = state.residentList(s.id);
      expect(res.some((p) => p.rankTier >= 6), `${s.name} lord`).toBe(true);
      expect(res.some((p) => p.career === 'knight'), `${s.name} knights`).toBe(true);
      expect(res.some((p) => p.career === 'man_at_arms'), `${s.name} men-at-arms`).toBe(true);
      expect(res.some((p) => p.career === 'servant' || p.career === 'cook'), `${s.name} servants`).toBe(true);
    }
    for (const s of world.settlements.filter((x) => x.kind === 'abbey' || x.kind === 'priory' || x.kind === 'nunnery')) {
      const res = state.residentList(s.id);
      const head = res.find((p) => p.offices.some((o) => ['abbot', 'abbess', 'prior', 'prioress'].includes(o.office)));
      expect(head, s.name).toBeDefined();
      if (s.kind === 'nunnery') {
        expect(head!.sex).toBe('f');
        expect(res.filter((p) => p.career === 'nun').length).toBeGreaterThan(5);
      } else {
        expect(head!.sex).toBe('m');
        expect(res.filter((p) => p.career === 'monk').length).toBeGreaterThan(5);
      }
      expect(res.every((p) => p.estate === 'clergy' || p.rankTier === 1 || p.career === 'cook' || p.career === 'servant' || p.career === 'labourer' || p.career === 'smith' || p.career === 'cottar' || p.career === 'child' || p.career === 'none')).toBe(true);
    }
  });

  it('rolls stats around mean 10 / s.d. 2.5 with every potential within 3..18', () => {
    const adults = living().filter((p) => ageYears(p, 0) >= 16);
    for (const s of STATS) {
      const vals = adults.map((p) => p.potential[s]);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
      expect(Math.abs(mean - 10), s).toBeLessThan(0.45);
      expect(sd, s).toBeGreaterThan(1.9);
      expect(sd, s).toBeLessThan(2.9);
      expect(Math.max(...vals)).toBeLessThanOrEqual(STAT_CAP);
      expect(Math.min(...vals)).toBeGreaterThanOrEqual(3);
    }
    for (const p of living()) for (const s of STATS) expect(p.trained[s]).toBeLessThanOrEqual(p.potential[s] + 1e-9);
  });

  it('inherits stats from parents (family resemblance) and keeps the child below the parents ages', () => {
    const pairs: Array<[number, number]> = [];
    for (const p of living()) {
      const f = p.father ? state.persons.get(p.father) : undefined;
      const m = p.mother ? state.persons.get(p.mother) : undefined;
      if (f && m && ageYears(p, 0) >= 5) pairs.push([(f.potential.int + m.potential.int) / 2, p.potential.int]);
      for (const par of [f, m]) if (par) expect(par.birthDay).toBeLessThan(p.birthDay - 14 * 16);
    }
    expect(pairs.length).toBeGreaterThan(500);
    const mx = pairs.reduce((a, b) => a + b[0], 0) / pairs.length, my = pairs.reduce((a, b) => a + b[1], 0) / pairs.length;
    let sxy = 0, sxx = 0, syy = 0;
    for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
    expect(sxy / Math.sqrt(sxx * syy)).toBeGreaterThan(0.35);
  });

  it('has a plausible age and sex structure', () => {
    const n = state.living;
    let kids = 0, males = 0, old = 0;
    for (const p of living()) {
      const a = ageYears(p, 0);
      if (a < 15) kids++;
      if (a >= 60) old++;
      if (p.sex === 'm') males++;
      expect(a).toBeLessThan(100);
    }
    expect(kids / n).toBeGreaterThan(0.25);
    expect(kids / n).toBeLessThan(0.4);
    expect(old / n).toBeGreaterThan(0.03);
    expect(old / n).toBeLessThan(0.12);
    expect(males / n).toBeGreaterThan(0.48);
    expect(males / n).toBeLessThan(0.56);
  });

  it('is internally consistent: households, houses, marriages, parents, homes', () => {
    const hhs = [...state.households.values()];
    expect(hhs.length).toBeGreaterThan(2000);
    let size = 0;
    for (const hh of hhs) {
      expect(hh.members.length, `household ${hh.id}`).toBeGreaterThan(0);
      expect(hh.members).toContain(hh.head);
      size += hh.members.length;
      for (const id of hh.members) {
        const m = state.persons.get(id)!;
        expect(m.household).toBe(hh.id);
        expect(m.settlement).toBe(hh.settlement);
        expect(m.death).toBeNull();
      }
      if (hh.home >= 0) {
        const b = state.buildings.get(hh.home)!;
        expect(b).toBeDefined();
        expect(b.settlement).toBe(hh.settlement);
        expect(b.occupied).toBe(true);
      }
      expect(hh.members.length).toBeLessThan(60);
    }
    expect(size / hhs.length).toBeGreaterThan(3.2);
    expect(size / hhs.length).toBeLessThan(6.5);
    for (const p of living()) {
      expect(state.households.has(p.household)).toBe(true);
      expect(state.houses.has(p.house), `house of ${p.first} ${p.byname}`).toBe(true);
      if (p.spouse) {
        const sp = state.persons.get(p.spouse)!;
        expect(sp.spouse).toBe(p.id);
        expect(sp.sex).not.toBe(p.sex);
      }
      for (const cid of p.children) {
        const c = state.persons.get(cid)!;
        expect(p.sex === 'm' ? c.father : c.mother).toBe(p.id);
      }
    }
  });

  it('hands out open-field strips to farming households and starts with the three-field rotation', () => {
    const states = new Set<string>();
    let held = 0, total = 0;
    for (const st of state.strips.values()) {
      total++;
      states.add(st.state);
      if (st.holder) { held++; expect(state.households.has(st.holder)).toBe(true); }
    }
    expect(total).toBe(world.strips.length);
    expect(held / total).toBeGreaterThan(0.7);
    expect(states.has('fallow') || states.has('sown')).toBe(true);
  });

  it('is deterministic for a seed', () => {
    const w2 = createMockWorld({ seed: 'pop-det', preset: 'small' });
    const a = GameState.fromWorld(w2, 'det', 'knight'); generatePopulation(a, w2);
    const b = GameState.fromWorld(w2, 'det', 'knight'); generatePopulation(b, w2);
    expect(hashState(a)).toBe(hashState(b));
    const c = GameState.fromWorld(w2, 'other', 'knight'); generatePopulation(c, w2);
    expect(hashState(c)).not.toBe(hashState(a));
  });
});
