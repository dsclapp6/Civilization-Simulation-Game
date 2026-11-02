// Prisoners taken outside a battle (a patrol, the watch): `takeCaptive` / `release` of the military contract.
import { describe, expect, it } from 'vitest';
import { mkPerson } from '../builders';
import { fakeCombat, milSim } from './helpers';

describe('takeCaptive and release', () => {
  it('holds a trespasser for ransom with the captor\'s House, tells the world, and refuses a second capture', () => {
    const { sim, mil } = milSim({ seed: 'cap-a' });
    const knight = mkPerson(sim, { age: 30, career: 'knight', tier: 5, estate: 'noble' });
    const poacher = mkPerson(sim, { age: 24, career: 'labourer', tier: 1, house: 0 });
    const events: Array<{ captive: number; captor: number; ransom: number }> = [];
    sim.events.on('captured', (e) => events.push(e));
    const r = mil.takeCaptive!(poacher.id, knight.id, { settlement: knight.settlement, reason: 'poaching' });
    expect(r.ok).toBe(true);
    expect(poacher.flags.captive).toBe(true);
    const view = mil.captiveOf(poacher.id)!;
    expect(view.captor).toBe(knight.id);
    expect(view.holder).toBe(knight.house);
    expect(view.ransom).toBeGreaterThanOrEqual(24);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ captive: poacher.id, captor: knight.id });
    // already held
    const again = mil.takeCaptive!(poacher.id, knight.id);
    expect(again.ok).toBe(false);
    expect(again.reason).toMatch(/already a prisoner/);
    expect(mil.captives()).toHaveLength(1);
  });

  it('refuses the dead, and a dead captor; the lord of the place holds a prisoner taken in no one\'s name', () => {
    const { sim, mil } = milSim({ seed: 'cap-b' });
    const dead = mkPerson(sim, { age: 30 });
    sim.state.markDead(dead, sim.absDay, 'violence');
    expect(mil.takeCaptive!(dead.id, 0).ok).toBe(false);
    const a = mkPerson(sim, { age: 30 });
    const b = mkPerson(sim, { age: 30, career: 'sergeant' });
    sim.state.markDead(b, sim.absDay, 'violence');
    expect(mil.takeCaptive!(a.id, b.id).ok).toBe(false);
    expect(a.flags.captive).toBeUndefined();
    // no captor: the lord of the settlement holds him
    const castle = sim.world.settlements.find((s) => s.kind === 'castle')!;
    const lord = mil.lordHouse(castle.id);
    const r = mil.takeCaptive!(a.id, 0, { settlement: castle.id, reason: 'trespass' });
    expect(r.ok).toBe(true);
    expect(mil.captiveOf(a.id)!.holder).toBe(lord);
    expect(mil.captiveOf(a.id)!.place).toBe(castle.id);
  });

  it('release frees him in every way a captive can go free, and costs nothing when he was never held', () => {
    const { sim, mil } = milSim({ seed: 'cap-c' });
    const captor = mkPerson(sim, { age: 35, career: 'sergeant', tier: 3 });
    for (const why of ['escaped', 'pardoned', 'served', 'ransomed'] as const) {
      const p = mkPerson(sim, { age: 26, career: 'labourer', tier: 1 });
      expect(mil.takeCaptive!(p.id, captor.id).ok).toBe(true);
      expect(p.flags.captive).toBe(true);
      mil.release!(p.id, why);
      expect(p.flags.captive).toBeUndefined();
      expect(mil.captiveOf(p.id)).toBeNull();
    }
    expect(mil.captives()).toHaveLength(0);
    // someone flagged by another module and not in the book is unflagged
    const q = mkPerson(sim, { age: 26 });
    q.flags.captive = true;
    mil.release!(q.id, 'pardoned');
    expect(q.flags.captive).toBeUndefined();
    // and a free man is left alone
    const free = mkPerson(sim, { age: 26 });
    expect(() => mil.release!(free.id, 'escaped')).not.toThrow();
  });

  it('a prisoner taken in a fight is bound up by his captors (the combat module tends him)', () => {
    const { sim, mil } = milSim({ seed: 'cap-d' });
    const combat = fakeCombat(sim);
    const tended: Array<[number, number]> = [];
    combat.tend = (healer, patient) => { tended.push([healer, patient]); return { ok: true, message: '' }; };
    const captor = mkPerson(sim, { age: 35, career: 'sergeant', tier: 3 });
    const p = mkPerson(sim, { age: 26 });
    expect(mil.takeCaptive!(p.id, captor.id).ok).toBe(true);
    expect(tended).toEqual([[captor.id, p.id]]);
  });

  it('the old ransom flow still works for people taken this way: paying frees them', () => {
    const { sim, mil } = milSim({ seed: 'cap-e' });
    const captor = mkPerson(sim, { age: 35, career: 'sergeant', tier: 3 });
    const p = mkPerson(sim, { age: 26, tier: 2 });
    p.money = 5000;
    expect(mil.takeCaptive!(p.id, captor.id).ok).toBe(true);
    const r = mil.payRansom(p.id);
    expect(r.ok).toBe(true);
    expect(p.flags.captive).toBeUndefined();
    expect(mil.captiveOf(p.id)).toBeNull();
  });
});
