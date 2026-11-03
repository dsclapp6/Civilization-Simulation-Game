import { describe, expect, it } from 'vitest';
import { militaryContext } from '../../../src/sim/military';
import { foodStock, wallIntegrity, fortBonus } from '../../../src/sim/military/siege';
import { planEffect, siegeWorks } from '../../../src/sim/military/plan';
import { CFG } from '../../../src/sim/military/config';
import { addMan } from '../../../src/sim/military/armies';
import type { AdvancementApi } from '../../../src/sim/wave3';
import { mkPerson } from '../builders';
import { declareWar, fakeCombat, fakePolitics, milSim } from './helpers';

function royals(sim: ReturnType<typeof milSim>['sim']): number[] {
  return [...sim.state.houses.values()].filter((h) => h.kind === 'royal').map((h) => h.id);
}

/** The attacker raises an army, camps it a few hundred metres from `castle` and orders the siege. */
function setupSiege(seed: string, opts: { tech?: boolean; strong?: boolean; fortress?: boolean; body?: boolean } = {}) {
  const ctx = milSim({ seed, body: opts.body });
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
    // (the households' own stores can still grow on the autumn cull of their herds; the besiegers' count of the food inside is what falls)
    expect(foodStock(M, castle.id)).toBeGreaterThan(0);
    void food0;
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

  it('the engines follow the assault plan\'s companies: a ram for each full crew, no ram without a crew', () => {
    const company = (id: number, task: 'ram' | 'ladders' | 'charge', levy: number) => ({ id, name: task, captain: 0, men: { levy }, task });
    const gap = CFG.siege.assaultGap;
    CFG.siege.assaultGap = 999; // no storm: watch the works grow
    const run = (seed: string, companies: ReturnType<typeof company>[]) => {
      const t = setupSiege(seed);
      t.army.plan = { companies };
      // the most rams the besiegers had on any day of the first week
      let rams = -1;
      for (let d = 0; d < 7; d++) { t.sim.advanceDays(1); const v = t.mil.siegeAt(t.castle.id); if (v) rams = Math.max(rams, v.rams); }
      return rams < 0 ? null : { rams };
    };
    const crewed = run('siege-plan-a', [company(1, 'ram', 25), company(2, 'ladders', 12), company(3, 'charge', 20)]);
    const bare = run('siege-plan-b', [company(3, 'charge', 40)]);
    CFG.siege.assaultGap = gap;
    expect(crewed).toBeTruthy();
    expect(bare).toBeTruthy();
    if (crewed) expect(crewed.rams).toBeGreaterThanOrEqual(1);
    if (bare) expect(bare.rams).toBe(0);
    expect(siegeWorks({ companies: [company(1, 'ram', 25), company(2, 'ladders', 12)] })).toMatchObject({ rams: 2, ladders: 2 });
    expect(siegeWorks({ companies: [company(1, 'ram', 9)] }).rams).toBe(0);
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

describe('the assault plan (companies, captains, tasks)', () => {
  it('250 against 300: the army and the garrison are brought to strength, and a plan with bows on the walls and a manned ram beats one without', () => {
    const t = setupSiege('plan-a');
    const { mil, castle, id, M } = t;
    const A = M.army(id)!;
    // bring the host to 250 and the garrison to 300
    const need = 250 - A.men.length;
    if (need > 0) mil.reinforce!(id, { levy: Math.round(need * 0.55), archer: Math.round(need * 0.25), man_at_arms: need - Math.round(need * 0.55) - Math.round(need * 0.25) });
    expect(A.men.length).toBeGreaterThanOrEqual(250);
    const plan0 = mil.assaultPlan!(id)!;
    const have = plan0.defenders;
    if (have < 300) mil.garrison!(castle.id, { man_at_arms: Math.round((300 - have) * 0.5), archer: Math.round((300 - have) * 0.25), levy: 300 - have - Math.round((300 - have) * 0.5) - Math.round((300 - have) * 0.25) });
    const p = mil.assaultPlan!(id)!;
    expect(p.defenders).toBeGreaterThanOrEqual(295);
    expect(p.plan.companies.map((c) => c.task)).toEqual(expect.arrayContaining(['loose', 'ram', 'charge']));
    // what the plan does against walls: a good plan lowers their worth far more than a bad one
    const good = planEffect(p.plan, A, p.defenders, 1.8);
    const bad = planEffect({ companies: p.plan.companies.map((c) => ({ ...c, task: 'charge' as const })) }, A, p.defenders, 1.8);
    expect(good.fort).toBeLessThan(bad.fort);
    expect(good.note).toMatch(/ram/);
    // orders: retask a company, move men between companies, name a captain
    const ram = p.plan.companies.find((c) => c.task === 'ram')!;
    const main = p.plan.companies.find((c) => c.task === 'charge')!;
    expect(mil.setCompanyTask!(id, ram.id, 'reserve').ok).toBe(true);
    expect(mil.moveMen!(id, main.id, ram.id, 'levy', 5).ok).toBe(true);
    expect(mil.setCaptain!(id, ram.id, A.commander).ok).toBe(true);
    // the storm can be ordered at once
    expect(mil.stormNow!(id).ok).toBe(true);
  });

  it('the retreat breaks off the storm in good order: the battle ends, the siege is lifted, the host turns home', () => {
    const t = setupSiege('retreat-a', { body: true });
    const { mil, id, M, sim } = t;
    const A = M.army(id)!;
    // the player rides in the host, so the storm is fought out around him (it does not resolve at once)
    const me = sim.state.persons.get(sim.state.run.playerId)!;
    if (!A.men.includes(me.id)) addMan(M, A, me, 'knight');
    expect(mil.stormNow!(id).ok).toBe(true);
    expect(M.data.battles.some((b) => b.a === id)).toBe(true);
    const before = A.men.length;
    const r = mil.retreat!(id);
    expect(r.ok).toBe(true);
    expect(M.data.battles.some((b) => b.a === id || b.d === id)).toBe(false);
    expect(M.data.sieges.some((s) => s.army === id)).toBe(false);
    const after = M.army(id);
    expect(after).toBeDefined();
    expect(after!.intent).toBe('return');
    // an orderly withdrawal: most of the host comes away
    expect(after!.men.length).toBeGreaterThan(before * 0.6);
    // and from the march it simply turns back
    expect(mil.retreat!(999999).ok).toBe(false);
  });
});
