// Fights with intent 'subdue' (docs/CIV.md §4): a patrol taking a trespasser strikes to wound and takes the downed and the
// yielding alive; the same fight with intent 'kill' leaves dead men.
import { describe, expect, it } from 'vitest';
import type { FightResult } from '../../src/sim/wave3';
import { adultMen, combatRig, setStats, stepFor } from './helpers';

function patrol(seed: string, intent: 'kill' | 'subdue', guardsN = 3) {
  const r = combatRig({ seed });
  const men = adultMen(r.sim, guardsN + 1);
  const [poacher, ...guards] = men;
  for (const p of men) { setStats(p, { str: 12, agi: 11, end: 12 }); p.needs.hunger = 1; p.needs.rest = 1; p.rankTier = 2; p.traits = []; }
  r.combat.arena.setKitOverride(poacher.id, { weapon: 'axe', armour: [] });
  for (const g of guards) r.combat.arena.setKitOverride(g.id, { weapon: 'sword', shield: 'shield', armour: ['padded_armour'] });
  const results: FightResult[] = [];
  r.combat.onFightEnded((res) => results.push(res));
  const id = r.combat.engage(
    [{ faction: 'patrol', people: guards.map((g) => g.id) }, { faction: 'poacher', people: [poacher.id] }],
    { at: { x: 500, z: 500 }, intent, yieldAllowed: true, reason: 'patrol' },
  );
  expect(id).toBeGreaterThan(0);
  stepFor(r.sim, 90);
  return { r, poacher, guards, results };
}

describe("engage with intent 'subdue'", () => {
  it('takes the trespasser alive: nobody dies, he is flagged captive, listed in the result and bound up', () => {
    let captured = 0, dead = 0;
    const events: Array<{ captive: number; captor: number; ransom: number }> = [];
    for (let i = 0; i < 12; i++) {
      const { r, poacher, guards, results } = patrol(`sub${i}`, 'subdue');
      r.sim.events.on('captured', (e) => events.push(e));
      expect(results).toHaveLength(1);
      if (poacher.death) dead++;
      const c = results[0].captured.find((x) => x.captive === poacher.id);
      if (c) {
        captured++;
        expect(guards.map((g) => g.id)).toContain(c.captor);
        expect(poacher.flags.captive).toBe(true);
        expect(results[0].winner).toBe('patrol');
        // the patrol bound his wounds
        for (const w of r.combat.wounds(poacher.id)) expect(w.severity).toBeLessThan(1);
      }
    }
    expect(dead).toBe(0);
    expect(captured).toBeGreaterThanOrEqual(9);
  });

  it('a man who just has to be beaten is not killed in his sleep: the patrol never strikes the downed', () => {
    const { r, poacher, results } = patrol('sub-down', 'subdue', 4);
    expect(poacher.death).toBeFalsy();
    expect(results[0].dead).not.toContain(poacher.id);
    // the fight ended with him on the ground or on his knees
    const f = r.combat.arena.fighterOf(poacher.id);
    expect(!f || f.gone || f.yielded || poacher.flags.captive === true || results[0].fled.includes(poacher.id)).toBe(true);
  });

  it("the same fight with intent 'kill' leaves dead men that 'subdue' does not", () => {
    let killed = 0, subdued = 0;
    for (let i = 0; i < 12; i++) {
      if (patrol(`cmp${i}`, 'kill').poacher.death) killed++;
      if (patrol(`cmp${i}`, 'subdue').poacher.death) subdued++;
    }
    expect(subdued).toBe(0);
    expect(killed).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const one = patrol('sub-det', 'subdue');
    const two = patrol('sub-det', 'subdue');
    expect(one.r.sim.stateHash()).toBe(two.r.sim.stateHash());
    expect(JSON.stringify(one.results)).toBe(JSON.stringify(two.results));
  });

  it('when the trespasser wins the patrol takes no one (and the fight is the old kind of fight for its other side)', () => {
    const r = combatRig({ seed: 'sub-lose' });
    const men = adultMen(r.sim, 3);
    const [guard, b1, b2] = men;
    for (const p of men) { setStats(p, { str: 13, agi: 12, end: 13 }); p.needs.hunger = 1; p.traits = []; p.rankTier = 2; }
    r.combat.arena.setKitOverride(guard.id, { weapon: 'dagger', armour: [] });
    for (const b of [b1, b2]) r.combat.arena.setKitOverride(b.id, { weapon: 'sword', shield: 'shield', armour: ['mail_hauberk'] });
    const results: FightResult[] = [];
    r.combat.onFightEnded((res) => results.push(res));
    r.combat.engage([{ faction: 'patrol', people: [guard.id] }, { faction: 'band', people: [b1.id, b2.id] }], { at: { x: 500, z: 500 }, intent: 'subdue' });
    stepFor(r.sim, 90);
    expect(results).toHaveLength(1);
    expect(results[0].winner).toBe('band');
    expect(results[0].captured).toHaveLength(0);
    expect(b1.flags.captive).toBeUndefined();
    expect(b2.flags.captive).toBeUndefined();
  });
});
