import { describe, expect, it } from 'vitest';
import { DAYS_PER_YEAR } from '../../src/core/time';
import {
  BASE_Q, CONCEPTION_PER_DAY, SURVIVAL, dailyHazard, lifeExpectancyAtBirth, sampleStationaryAge, survivalTo,
} from '../../src/sim/demography';
import { Rng } from '../../src/core/rng';
import { autoSuccessor, newSim } from './helpers';
import { ageYears, type Person } from '../../src/sim/state';
import type { Simulation } from '../../src/sim/sim';

describe('demographic schedules', () => {
  it('has medieval mortality: notable child mortality, life expectancy in the early thirties', () => {
    expect(lifeExpectancyAtBirth()).toBeGreaterThan(28);
    expect(lifeExpectancyAtBirth()).toBeLessThan(37);
    expect(1 - SURVIVAL[1]).toBeGreaterThan(0.12); // infant mortality
    expect(1 - SURVIVAL[1]).toBeLessThan(0.3);
    expect(1 - SURVIVAL[10]).toBeGreaterThan(0.3); // dead before ten
    expect(1 - SURVIVAL[10]).toBeLessThan(0.45);
    expect(BASE_Q[0]).toBeGreaterThan(BASE_Q[10] * 10);
    expect(BASE_Q[75]).toBeGreaterThan(BASE_Q[40] * 3);
    expect(survivalTo(0)).toBe(1);
    expect(survivalTo(50)).toBeGreaterThan(survivalTo(60));
  });

  it('daily hazard follows age, class and sex', () => {
    expect(dailyHazard(2, 'm', 0)).toBeGreaterThan(dailyHazard(2, 'm', 20) * 5);
    expect(dailyHazard(1, 'm', 30)).toBeGreaterThan(dailyHazard(6, 'm', 30));
    expect(dailyHazard(2, 'm', 1)).toBeGreaterThan(dailyHazard(2, 'f', 1));
    const yearly = 1 - Math.pow(1 - dailyHazard(2, 'f', 30), DAYS_PER_YEAR);
    expect(yearly).toBeCloseTo(BASE_Q[30], 4);
  });

  it('is fertile only between about 15 and 45', () => {
    expect(CONCEPTION_PER_DAY[10]).toBe(0);
    expect(CONCEPTION_PER_DAY[25]).toBeGreaterThan(CONCEPTION_PER_DAY[38]);
    expect(CONCEPTION_PER_DAY[38]).toBeGreaterThan(CONCEPTION_PER_DAY[44]);
    expect(CONCEPTION_PER_DAY[46]).toBe(0);
  });

  it('samples ages from the stationary distribution', () => {
    const rng = new Rng('ages');
    let kids = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) if (sampleStationaryAge(rng, 0, 100) < 15) kids++;
    expect(kids / n).toBeGreaterThan(0.27);
    expect(kids / n).toBeLessThan(0.36);
  });
});

interface Census { pop: number; peasants: number; kids: number; old: number }

function census(sim: Simulation): Census {
  let pop = 0, peasants = 0, kids = 0, old = 0;
  for (const p of sim.state.persons.values()) {
    if (p.death) continue;
    pop++;
    if (p.rankTier <= 2) peasants++;
    const a = ageYears(p, sim.absDay);
    if (a < 15) kids++;
    if (a >= 60) old++;
  }
  return { pop, peasants: peasants / pop, kids: kids / pop, old: old / pop };
}

describe('100 years of macro life', () => {
  for (const seed of ['alpha', 'beta']) {
    it(`keeps the population stable within +-0.5%/yr and the society intact (seed ${seed})`, () => {
      const sim = newSim({ seed, preset: 'small' });
      // the player may die in a century; take over the first relative so the run goes on
      autoSuccessor(sim);
      const start = census(sim);
      const startPop = sim.state.living;
      const decades: number[] = [startPop];
      let last = startPop;
      for (let y = 1; y <= 100; y++) {
        sim.advanceDays(DAYS_PER_YEAR);
        expect(sim.state.run.phase).not.toBe('over');
        if (y % 10 === 0) { decades.push(sim.state.living); last = sim.state.living; }
      }
      const growth = Math.pow(last / startPop, 1 / 100) - 1;
      expect(Math.abs(growth)).toBeLessThanOrEqual(0.005);
      for (let i = 1; i < decades.length; i++) {
        const g = Math.pow(decades[i] / decades[i - 1], 1 / 10) - 1;
        expect(Math.abs(g), `decade ${i}`).toBeLessThan(0.015);
      }
      const end = census(sim);
      expect(Math.abs(end.peasants - start.peasants)).toBeLessThan(0.1);
      expect(end.kids).toBeGreaterThan(0.24);
      expect(end.kids).toBeLessThan(0.42);
      expect(end.old).toBeGreaterThan(0.03);
      expect(end.old).toBeLessThan(0.16);

      // vital statistics of the last 50 years
      const hist = sim.state.stats.history.slice(-50);
      let births = 0, deaths = 0, infant = 0, marriages = 0, ageSum = 0, pops = 0;
      for (const y of hist) { births += y.births; deaths += y.deaths; infant += y.infantDeaths; marriages += y.marriages; ageSum += y.ageAtDeathSum; pops += y.population; }
      const meanPop = pops / hist.length;
      expect(births / hist.length / meanPop).toBeGreaterThan(0.025);
      expect(births / hist.length / meanPop).toBeLessThan(0.045);
      expect(deaths / hist.length / meanPop).toBeGreaterThan(0.025);
      expect(deaths / hist.length / meanPop).toBeLessThan(0.045);
      expect(ageSum / deaths).toBeGreaterThan(24);
      expect(ageSum / deaths).toBeLessThan(38);
      expect(infant / births).toBeGreaterThan(0.06);
      expect(infant / births).toBeLessThan(0.3);
      expect(marriages / hist.length / meanPop).toBeGreaterThan(0.006);
      expect(marriages / hist.length / meanPop).toBeLessThan(0.025);

      // accounting: everyone alive is accounted for by births, deaths and arrivals
      let b = 0, d = 0, a = 0;
      for (const y of sim.state.stats.history) { b += y.births; d += y.deaths; a += y.arrivals; }
      const cur = sim.state.stats.current;
      b += cur.births; d += cur.deaths; a += cur.arrivals;
      expect(startPop + b - d + a).toBe(sim.state.living);
    }, 120_000);
  }

  it('leaves a consistent world after a century: titles held by the living, no empty households, rank order', () => {
    const sim = newSim({ seed: 'gamma', preset: 'small' });
    autoSuccessor(sim);
    sim.advanceDays(DAYS_PER_YEAR * 100);
    const st = sim.state;
    for (const t of st.titles.values()) {
      const h = st.persons.get(t.holder);
      expect(h && !h.death, `${t.name} holder`).toBeTruthy();
      const min = { kingdom: 8, county: 7, barony: 6, manor: 5, town: 4, abbey: 4, see: 6 }[t.kind];
      expect((h as Person).rankTier, t.name).toBeGreaterThanOrEqual(min);
    }
    for (const hh of st.households.values()) {
      expect(hh.members.length).toBeGreaterThan(0);
      const head = st.persons.get(hh.head);
      expect(head && !head.death && head.household === hh.id).toBeTruthy();
      for (const id of hh.members) expect(st.persons.get(id)?.household).toBe(hh.id);
    }
    for (const p of st.persons.values()) {
      if (p.death) continue;
      expect(st.households.has(p.household)).toBe(true);
      expect(st.houses.has(p.house)).toBe(true);
      expect(st.settlements.has(p.settlement)).toBe(true);
      if (p.spouse) expect(st.persons.get(p.spouse)?.spouse).toBe(p.id);
      for (const s of ['str', 'end', 'agi', 'int', 'per', 'cha'] as const) expect(p.potential[s]).toBeLessThanOrEqual(18);
    }
    // the kingdoms still have kings
    for (const k of sim.world.kingdoms) expect(st.persons.get(st.titleFor('kingdom', k.id)!.holder)?.death).toBeNull();
    // dead people are forgotten, so the registry stays bounded
    expect(st.persons.size).toBeLessThan(st.living * 1.5);
  }, 120_000);
});
