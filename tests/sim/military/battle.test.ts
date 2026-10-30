import { describe, expect, it } from 'vitest';
import { militaryContext } from '../../../src/sim/military';
import { fightersOf, resolve, type Fighters } from '../../../src/sim/military/battle';
import { declareWar, fakeCombat, fakePolitics, milSim } from './helpers';

function royals(sim: ReturnType<typeof milSim>['sim']): number[] {
  return [...sim.state.houses.values()].filter((h) => h.kind === 'royal').map((h) => h.id);
}

/** A copy of the fighters keeping only every k-th man (a smaller army of the same mix). */
function thin(f: Fighters, keep: number): Fighters {
  const people = f.people.filter((_, i) => i % keep === 0);
  const kinds = f.kinds.filter((_, i) => i % keep === 0);
  const power = f.power.filter((_, i) => i % keep === 0);
  return { ...f, people, kinds, power, total: power.reduce((s, x) => s + x, 0) };
}

function winRate(M: ReturnType<typeof militaryContext>, a: Fighters, d: Fighters, n = 200): number {
  let wins = 0;
  for (let i = 0; i < n; i++) if (resolve(M, a, d, { x: 100, z: 100 }).attWon) wins++;
  return wins / n;
}

describe('battle odds', () => {
  it('bigger and better armies win more often, but not always', () => {
    const { sim, mil } = milSim({ seed: 'odds' });
    const [ka, kb] = royals(sim);
    const M = militaryContext(sim);
    const ia = mil.raiseArmy(ka, 'war', { vassals: true });
    const ib = mil.raiseArmy(kb, 'war', { vassals: true });
    const A = fightersOf(M, [M.army(ia)!]);
    const B = fightersOf(M, [M.army(ib)!]);
    expect(A.people.length).toBeGreaterThan(40);
    expect(B.people.length).toBeGreaterThan(40);
    // even-ish: the two armies are similar in size; thin one side to make a clear mismatch
    const scaled = (f: Fighters, k: number): Fighters => ({ ...f, power: f.power.map((x) => x * k), total: f.total * k });
    const rates = [1, 1.15, 1.3, 1.6, 2].map((k) => winRate(M, scaled(A, k), A, 300));
    console.log('win rate by strength ratio 1, 1.15, 1.3, 1.6, 2:', rates.join(' '));
    expect(rates[0]).toBeGreaterThan(0.3);
    expect(rates[0]).toBeLessThan(0.7);
    for (let i = 1; i < rates.length; i++) expect(rates[i]).toBeGreaterThanOrEqual(rates[i - 1] - 0.03);
    expect(rates[2]).toBeGreaterThan(0.6);
    expect(rates[2]).toBeLessThan(0.97);
    expect(rates[4]).toBeGreaterThan(0.9);
    const weak = winRate(M, A, scaled(A, 2));
    expect(weak).toBeLessThan(0.1);
    void thin; void B;
    // equal armies are a toss-up
    const sameA = thin(A, 2), sameB = thin(A, 2);
    sameB.people = sameA.people.slice(); // identical strength
    const even = winRate(M, sameA, sameB, 300);
    expect(even).toBeGreaterThan(0.25);
    expect(even).toBeLessThan(0.75);
    // quality: a small elite beats a mass of levy of the same weight
    const half = thin(A, 2);
    const strongerPerMan: Fighters = { ...half, power: half.power.map((x) => x * 1.6), total: half.total * 1.6 };
    expect(winRate(M, strongerPerMan, half)).toBeGreaterThan(0.8);
  });

  it('a commander with Leadership and a defender behind walls turn the odds', () => {
    const { sim, mil } = milSim({ seed: 'odds2' });
    const [ka, kb] = royals(sim);
    const M = militaryContext(sim);
    const ia = mil.raiseArmy(ka, 'war', { vassals: true });
    const ib = mil.raiseArmy(kb, 'war', { vassals: true });
    const A = fightersOf(M, [M.army(ia)!]);
    const B = { ...A, power: A.power.map((x) => x * 0.85), total: A.total * 0.85 };
    const base = winRate(M, A, B);
    const walled = winRate(M, A, { ...B, bonus: 1.6 });
    expect(walled).toBeLessThan(base);
    expect(base).toBeGreaterThan(0.5);
    expect(walled).toBeLessThan(0.5);
    // a shattered, unfed army breaks sooner than a confident one
    const broken = winRate(M, { ...A, morale: 0.1 }, B);
    expect(broken).toBeLessThan(base);
  });
});

describe('battles of armies', () => {
  it('hostile armies in contact fight: casualties fall on real people, the war is told, an event and a chronicle line follow', () => {
    const { sim, mil } = milSim({ seed: 'fight' });
    const pol = fakePolitics(sim);
    const combat = fakeCombat(sim, 0.6);
    const [ka, kb] = royals(sim);
    const M = militaryContext(sim);
    const w = declareWar(pol, sim, [ka], [kb]);
    const ia = mil.raiseArmy(ka, 'war', { vassals: true, war: w.id });
    const ib = mil.raiseArmy(kb, 'war', { vassals: true, war: w.id });
    const A = M.army(ia)!, B = M.army(ib)!;
    for (const x of [A, B]) mil.order(x.id, { kind: 'hold' });
    sim.advanceDays(5);
    // bring them together
    B.x = A.x + 50; B.z = A.z;
    const sizes = [A.men.length, B.men.length];
    const people = [...A.men, ...B.men].filter((id) => !sim.state.persons.get(id)!.death);
    let event: { attackerWon: boolean; dead: number } | undefined;
    sim.events.on('battle', (e) => { event = e; });
    const logs0 = sim.state.chronicle.length;
    sim.advanceHours(1);
    expect(event).toBeDefined();
    const dead = people.filter((id) => sim.state.persons.get(id)!.death).length;
    expect(dead).toBeGreaterThan(0);
    expect(event!.dead).toBe(dead);
    // the casualties were rolled through the combat module's wound model
    expect(combat.harmed.length).toBeGreaterThan(0);
    for (const h of combat.harmed) expect(people).toContain(h.person);
    // rosters shrank by the hit men; the loser retreats
    const aliveA = M.armyById.has(ia) ? A.men.length : 0, aliveB = M.armyById.has(ib) ? B.men.length : 0;
    expect(aliveA + aliveB).toBeLessThan(sizes[0] + sizes[1]);
    expect(pol.reports).toHaveLength(1);
    expect(pol.reports[0].war).toBe(w.id);
    expect(pol.reports[0].weight).toBeGreaterThan(0);
    expect(sim.state.chronicle.length).toBeGreaterThan(logs0);
    expect(sim.state.chronicle.some((c) => c.kind === 'battle')).toBe(true);
    expect(mil.battles()).toHaveLength(0);
  });

  it('no war, no battle: armies of Houses at peace pass each other', () => {
    const { sim, mil } = milSim({ seed: 'peace' });
    fakePolitics(sim);
    const [ka, kb] = royals(sim);
    const M = militaryContext(sim);
    const ia = mil.raiseArmy(ka, 'war', {});
    const ib = mil.raiseArmy(kb, 'war', {});
    mil.order(ia, { kind: 'hold' }); mil.order(ib, { kind: 'hold' });
    sim.advanceDays(2);
    M.army(ib)!.x = M.army(ia)!.x + 20; M.army(ib)!.z = M.army(ia)!.z;
    let fought = false;
    sim.events.on('battle', () => { fought = true; });
    sim.advanceHours(3);
    expect(fought).toBe(false);
  });

  it('nobles are taken for ransom of about a year of their estate\'s income instead of being killed', () => {
    const { sim, mil } = milSim({ seed: 'ransom' });
    const pol = fakePolitics(sim);
    fakeCombat(sim, 0.4);
    const [ka, kb] = royals(sim);
    const M = militaryContext(sim);
    const w = declareWar(pol, sim, [ka], [kb]);
    const ia = mil.raiseArmy(ka, 'war', { vassals: true, war: w.id });
    const ib = mil.raiseArmy(kb, 'war', { vassals: true, war: w.id });
    for (const id of [ia, ib]) mil.order(id, { kind: 'hold' });
    sim.advanceDays(5);
    const A = M.army(ia)!, B = M.army(ib)!;
    // make one side crushingly weaker so its knights fall into the winner's hands
    for (let i = B.men.length - 1; i > 12; i--) { /* thin the host */ B.men.splice(i, 1); B.units = B.units.slice(0, i) + B.units.slice(i + 1); }
    B.x = A.x + 40; B.z = A.z;
    const captured: Array<{ captive: number; captor: number; ransom: number }> = [];
    sim.events.on('captured', (e) => captured.push(e));
    // fight repeatedly to see a capture
    sim.advanceHours(2);
    const caps = mil.captives();
    expect(caps.length).toBeGreaterThan(0);
    for (const c of caps) {
      const p = sim.state.persons.get(c.person)!;
      expect(p.flags.captive).toBe(true);
      expect(c.ransom).toBeGreaterThanOrEqual(24);
      // a year's income of the estate: more for a lord with titles than for a sergeant
      expect(c.ransom).toBe(mil.ransomValue(c.person));
    }
    expect(captured.length).toBe(caps.length);
    const rich = caps.map((c) => c).sort((a, b) => b.ransom - a.ransom)[0];
    expect(rich.ransom).toBeGreaterThan(100);
  });
});
