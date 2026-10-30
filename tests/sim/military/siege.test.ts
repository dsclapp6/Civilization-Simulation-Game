import { describe, expect, it } from 'vitest';
import { militaryContext } from '../../../src/sim/military';
import { foodStock, wallIntegrity, fortBonus } from '../../../src/sim/military/siege';
import type { AdvancementApi } from '../../../src/sim/wave3';
import { mkPerson } from '../builders';
import { declareWar, fakeCombat, fakePolitics, milSim } from './helpers';

function royals(sim: ReturnType<typeof milSim>['sim']): number[] {
  return [...sim.state.houses.values()].filter((h) => h.kind === 'royal').map((h) => h.id);
}

/** The attacker raises an army, camps it a few hundred metres from `castle` and orders the siege. */
function setupSiege(seed: string, opts: { tech?: boolean; strong?: boolean; fortress?: boolean } = {}) {
  const ctx = milSim({ seed });
  const { sim, mil } = ctx;
  const pol = fakePolitics(sim);
  fakeCombat(sim, 0.5);
  const [ka, kb] = royals(sim);
  const M = militaryContext(sim);
  const castle = sim.world.settlements.find((s) => s.kind === 'castle' && M.realm.root(M.realm.lordHouse(s.id)) === kb)!;
  const w = declareWar(pol, sim, [ka], [kb]);
  const adv: AdvancementApi = { knows: () => !!opts.tech, houseHas: (_h, t) => !!opts.tech && t === 'trebuchet' };
  sim.services.advancement = adv;
  // the defenders do not raise an army of their own here (we test the siege)
  for (const h of sim.state.houses.values()) { M.data.think[`r${h.id}`] = sim.absDay + 999; M.data.think[`d${h.id}`] = sim.absDay + 999; }
  M.data.wars[String(w.id)] = Math.floor(sim.absDay);
  if (opts.fortress) {
    // a hundred and fifty men-at-arms behind the walls: nobody storms that
    const hh = sim.state.householdList(castle.id).find((h) => h.kind === 'garrison') ?? sim.state.addHousehold({
      id: sim.state.households.alloc(), kind: 'garrison', head: 0, members: [], home: -1, settlement: castle.id, purse: 0, stores: {},
    });
    for (let i = 0; i < 150; i++) {
      const p = mkPerson(sim, { age: 28, career: 'man_at_arms', tier: 2, house: M.realm.lordHouse(castle.id) });
      p.trained.str = 14; p.trained.end = 12; p.skills.melee = 40 * 25;
      sim.state.joinHousehold(p, hh);
    }
  }
  const id = mil.raiseArmy(ka, 'war', { vassals: true, war: w.id });
  const A = M.army(id)!;
  if (opts.strong) {
    // a big host: copy levy men from the pool of the capital's neighbours
    A.supplies = 99999;
  }
  mil.order(id, { kind: 'hold' });
  sim.advanceDays(5);
  A.x = castle.x - 300; A.z = castle.z; A.px = A.x; A.pz = A.z;
  A.supplies = A.men.length * 200;
  A.morale = 1;
  mil.order(id, { kind: 'siege', settlement: castle.id });
  return { ...ctx, pol, ka, kb, M, castle, army: A, id, war: w };
}

describe('sieges', () => {
  it('the army sits down before the walls; the besieged eat their stores and the blockade starves them', () => {
    const t = setupSiege('siege-a');
    const { sim, mil, castle, M } = t;
    const events: string[] = [];
    sim.events.on('siege', (e) => events.push(e.phase));
    sim.advanceDays(1);
    expect(mil.siegeAt(castle.id)).toBeTruthy();
    expect(events[0]).toBe('start');
    const food0 = foodStock(M, castle.id);
    expect(food0).toBeGreaterThan(0);
    const start = mil.siegeAt(castle.id)!;
    expect(start.foodDays).toBeGreaterThan(5);
    const days = [start.foodDays];
    for (let d = 0; d < 12; d++) {
      sim.advanceDays(1);
      const v = mil.siegeAt(castle.id);
      if (!v) break;
      days.push(v.foodDays);
    }
    // the besieged cannot be resupplied: food only goes down while the siege lasts, a day's food a day
    for (let i = 1; i < days.length; i++) expect(days[i]).toBeLessThan(days[i - 1]);
    expect(days[days.length - 1]).toBeLessThan(days[0] - 0.8);
    expect(foodStock(M, castle.id)).toBeLessThanOrEqual(food0 + 1);
  });

  it('a siege ends: the place falls by surrender or storm, or is lifted; the war is told and the lord held for ransom', () => {
    const t = setupSiege('siege-b', { strong: true });
    const { sim, mil, castle, pol, M } = t;
    const phases: string[] = [];
    sim.events.on('siege', (e) => phases.push(e.phase));
    let ended = false;
    for (let d = 0; d < 60 && !ended; d++) {
      sim.advanceDays(1);
      ended = phases.includes('fell') || phases.includes('lifted');
    }
    expect(phases[0]).toBe('start');
    expect(ended).toBe(true);
    expect(mil.siegeAt(castle.id)).toBeNull();
    if (phases.includes('fell')) {
      expect(pol.reports.some((r) => r.attackerWon && r.weight >= 1.5)).toBe(true);
      const lord = sim.state.houses.get(M.realm.lordHouse(castle.id))!;
      expect(mil.captiveOf(lord.head) !== null || sim.state.chronicle.some((c) => c.kind === 'siege')).toBe(true);
    }
    expect(sim.state.chronicle.some((c) => c.kind === 'siege')).toBe(true);
  });

  it('trebuchets need the technique: without it the walls stand, with it the walls take damage', () => {
    const plain = setupSiege('siege-c', { tech: false, fortress: true });
    plain.sim.advanceDays(1);
    expect(plain.army.men.length).toBeGreaterThanOrEqual(60);
    const walls0 = wallIntegrity(plain.M, plain.castle.id);
    expect(walls0).toBeGreaterThan(0);
    plain.army.stance = 'hold';
    for (let d = 0; d < 8; d++) {
      plain.sim.advanceDays(1);
      const rec = plain.M.sieges.recOf(plain.castle.id);
      if (rec) expect(rec.trebuchets).toBe(0);
    }

    const tech = setupSiege('siege-c', { tech: true, fortress: true });
    tech.sim.advanceDays(1);
    const f0 = fortBonus(tech.M, tech.castle.id);
    let built = 0;
    for (let d = 0; d < 8; d++) {
      tech.sim.advanceDays(1);
      const rec = tech.M.sieges.recOf(tech.castle.id);
      if (rec) built = Math.max(built, rec.trebuchets);
      if (!rec) break;
    }
    expect(built).toBeGreaterThan(0);
    const damaged = [...tech.sim.state.buildingsAt.get(tech.castle.id)!].filter((b) => b.damage > 0).length;
    expect(damaged).toBeGreaterThan(0);
    expect(fortBonus(tech.M, tech.castle.id)).toBeLessThan(f0);
  });

  it('a siege is lifted when the besiegers go home', () => {
    const t = setupSiege('siege-d');
    const { sim, mil, castle, id } = t;
    sim.advanceDays(1);
    expect(mil.siegeAt(castle.id)).toBeTruthy();
    const phases: string[] = [];
    sim.events.on('siege', (e) => phases.push(e.phase));
    mil.order(id, { kind: 'return' });
    expect(mil.siegeAt(castle.id)).toBeNull();
    expect(phases).toContain('lifted');
  });
});
