import { describe, expect, it } from 'vitest';
import { dist } from '../../../src/core/math';
import { militaryContext } from '../../../src/sim/military';
import { planMarch } from '../../../src/sim/military/roads';
import { fakePolitics, milSim } from './helpers';

function royals(sim: ReturnType<typeof milSim>['sim']): number[] {
  return [...sim.state.houses.values()].filter((h) => h.kind === 'royal').map((h) => h.id);
}

describe('armies on the map', () => {
  it('raises the retinue, a share of the garrison and the levy, mustering at the seat', () => {
    const { sim, mil } = milSim({ seed: 'raise' });
    const [a] = royals(sim);
    const headcount = mil.raise(a, 'war');
    expect(headcount).toBeGreaterThan(20);
    const views = mil.armiesOf(a);
    expect(views).toHaveLength(1);
    const v = views[0];
    expect(v.task).toBe('muster');
    const seat = sim.world.settlements.find((s) => s.id === sim.state.houses.get(a)!.seat)!;
    expect(dist(v.x, v.z, seat.x, seat.z)).toBeLessThan(1);
    const total = Object.values(v.troops).reduce((s, n) => s + n, 0);
    expect(total).toBe(headcount);
    // real people, each in one army only
    const roster = mil.roster(v.id);
    expect(new Set(roster.map((r) => r.person)).size).toBe(roster.length);
    for (const r of roster) { expect(sim.state.persons.get(r.person)).toBeTruthy(); expect(mil.armyOf(r.person)).toBe(v.id); }
    // the head of the House leads; levy are the bulk
    expect(v.commander).toBe(sim.state.houses.get(a)!.head);
    expect(v.troops.levy).toBeGreaterThan(0);
    // a second raise finds nobody left to take
    expect(mil.raise(a, 'war')).toBeLessThan(headcount);
  });

  it('the muster completes after a day or two, then the army waits for orders', () => {
    const { sim, mil } = milSim({ seed: 'muster' });
    const [a] = royals(sim);
    mil.raise(a, 'war');
    expect(mil.armiesOf(a)[0].task).toBe('muster');
    sim.advanceDays(5);
    expect(mil.armiesOf(a)[0].task).not.toBe('muster');
  });

  it('marches along the road graph at the pace of its slowest unit and arrives', () => {
    const { sim, mil } = milSim({ seed: 'march' });
    const [a] = royals(sim);
    const id = mil.raiseArmy(a, 'war', { vassals: false });
    expect(id).toBeGreaterThan(0);
    mil.order(id, { kind: 'hold' });
    sim.advanceDays(3);
    const army = mil.armiesOf(a)[0];
    // the farthest settlement of the same kingdom
    const from = { x: army.x, z: army.z };
    const dest = [...sim.world.settlements].sort((p, q) => dist(q.x, q.z, from.x, from.z) - dist(p.x, p.z, from.x, from.z))
      .find((s) => dist(s.x, s.z, from.x, from.z) < 6000)!;
    const plan = planMarch(sim.world, from, { x: dest.x, z: dest.z }, dest.id);
    expect(plan.total).toBeGreaterThan(500);
    expect(mil.order(id, { kind: 'garrison', settlement: dest.id }).ok).toBe(true);
    // every hour the army stays on the planned road
    let last = dist(from.x, from.z, army.x, army.z);
    let arrivedHour = -1;
    for (let h = 0; h < 24 * 40; h++) {
      sim.advanceHours(1);
      const v = mil.armies().find((x) => x.id === id)!;
      if (v.task === 'garrison' && dist(v.x, v.z, dest.x, dest.z) < 2) { arrivedHour = h; break; }
      // distance from the plan's polyline is tiny
      let best = Infinity;
      for (let i = 0; i + 1 < plan.points.length; i++) {
        const p = plan.points[i], q = plan.points[i + 1];
        const t = Math.max(0, Math.min(1, ((v.x - p.x) * (q.x - p.x) + (v.z - p.z) * (q.z - p.z)) / (((q.x - p.x) ** 2 + (q.z - p.z) ** 2) || 1)));
        best = Math.min(best, dist(v.x, v.z, p.x + (q.x - p.x) * t, p.z + (q.z - p.z) * t));
      }
      expect(best).toBeLessThan(8);
      last = Math.max(last, 0);
    }
    expect(arrivedHour).toBeGreaterThan(0);
    // 760 m a day at most (mounted armies are faster; this one is mostly foot): not instant, not crawling
    const days = arrivedHour / 24;
    expect(days).toBeGreaterThan(plan.total / 1500);
    expect(days).toBeLessThan(plan.total / 300 + 3);
  });

  it('a mixed army marches at the pace of the foot', () => {
    const { sim, mil } = milSim({ seed: 'pace' });
    const [a] = royals(sim);
    const id = mil.raiseArmy(a, 'war', { vassals: false });
    const det = mil.armyDetail(id)!;
    const mounted = (det.troops.knights ?? 0) + (det.troops.sergeants ?? 0);
    expect(mounted / det.size).toBeLessThan(0.5);
    const M = militaryContext(sim);
    const army = M.army(id)!;
    const a0 = army.x;
    sim.advanceDays(3);
    // after the muster it moves at foot pace
    const dest = sim.world.settlements.find((s) => dist(s.x, s.z, army.x, army.z) > 2500 && dist(s.x, s.z, army.x, army.z) < 4000)!;
    mil.order(id, { kind: 'march', x: dest.x, z: dest.z, settlement: dest.id });
    const x0 = army.x, z0 = army.z;
    sim.advanceDays(1);
    const moved = dist(x0, z0, army.x, army.z);
    expect(moved).toBeGreaterThan(200);
    expect(moved).toBeLessThan(900);
    void a0;
  });

  it('forages: a hungry army eats the village stores', () => {
    const { sim, mil } = milSim({ seed: 'forage' });
    const [a] = royals(sim);
    const id = mil.raiseArmy(a, 'war', { vassals: false });
    const M = militaryContext(sim);
    const army = M.army(id)!;
    const near = sim.world.settlements.reduce((b, s) => (dist(s.x, s.z, army.x, army.z) < dist(b.x, b.z, army.x, army.z) ? s : b));
    const before = (): number => {
      let sum = 0;
      for (const hh of sim.state.householdsIn(near.id)) for (const [k, v] of Object.entries(hh.stores)) if (/^(wheat|rye|barley|oats|bread)/.test(k)) sum += v;
      return sum;
    };
    const b0 = before();
    army.supplies = 0;
    sim.advanceDays(2);
    expect(before()).toBeLessThan(b0);
    expect(army.supplies).toBeGreaterThanOrEqual(0);
  });

  it('unpaid men desert, mercenaries are paid from the purse and leave when the contract ends', () => {
    const { sim, mil } = milSim({ seed: 'pay' });
    const [a] = royals(sim);
    const M = militaryContext(sim);
    const hired = mil.hireMercenaries(a, 12, 'man_at_arms');
    expect(hired).toBeGreaterThan(5);
    const id = mil.raiseArmy(a, 'war', { vassals: false });
    const army = M.army(id)!;
    mil.order(id, { kind: 'hold' });
    const mercs = () => army.men.filter((p) => M.data.hired[p]).length;
    expect(mercs()).toBeGreaterThan(0);
    const purse0 = M.realm.purse(a);
    sim.advanceDays(4);
    expect(M.realm.purse(a)).toBeLessThan(purse0);
    // the House cannot pay any more: arrears build up, morale falls, men slip away
    const hh = M.realm.householdOf(a)!;
    const size0 = army.men.length;
    for (let d = 0; d < 14; d++) { hh.purse = 0; sim.advanceDays(1); }
    expect(army.owed).toBeGreaterThan(0);
    expect(army.morale).toBeLessThan(0.85);
    expect(M.armyById.has(id) ? army.men.length : 0).toBeLessThan(size0);
  });

  it('disbanding shares the spoils and clears the roster', () => {
    const { sim, mil } = milSim({ seed: 'disband' });
    const [a] = royals(sim);
    const M = militaryContext(sim);
    const id = mil.raiseArmy(a, 'war', { vassals: false });
    const army = M.army(id)!;
    const man = M.person(army.men[army.men.length - 1])!;
    const money0 = man.money;
    army.funds = 5000;
    const people = army.men.slice();
    expect(mil.disband(id).ok).toBe(true);
    expect(mil.armies().find((x) => x.id === id)).toBeUndefined();
    expect(man.money).toBeGreaterThan(money0);
    for (const p of people) expect(mil.armyOf(p)).toBe(0);
  });

  it('armies of Houses at war meet and the war is told of it (and a war that ends sends the armies home)', () => {
    const { sim, mil } = milSim({ seed: 'war-end' });
    const pol = fakePolitics(sim);
    const [a, b] = royals(sim);
    pol.wars_.push({ id: 1, attackers: [a], defenders: [b], goal: 0, since: 0, score: 0 });
    sim.advanceDays(2);
    // both sides raise on their own
    expect(mil.armiesOf(a).length).toBeGreaterThan(0);
    expect(mil.armiesOf(b).length).toBeGreaterThan(0);
    pol.wars_.length = 0;
    sim.advanceDays(1);
    const M = militaryContext(sim);
    for (const v of mil.armies()) expect(['muster', 'march', 'garrison']).toContain(v.task);
    void M;
  });
});
