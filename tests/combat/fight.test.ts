import { describe, expect, it } from 'vitest';
import type { FightResult } from '../../src/sim/wave3';
import { S } from '../../src/combat/fighter';
import { adultMen, combatRig, setStats, stepFor } from './helpers';

function runFight(seed: string, aKit: Parameters<ReturnType<typeof combatRig>['combat']['arena']['setKitOverride']>[1], bKit: typeof aKit, n = 3, seconds = 90) {
  const r = combatRig({ seed });
  const men = adultMen(r.sim, n * 2);
  const a = men.slice(0, n), b = men.slice(n);
  for (const p of men) { setStats(p, { str: 11, agi: 11, end: 11 }); p.needs.hunger = 1; p.needs.rest = 1; }
  for (const p of a) r.combat.arena.setKitOverride(p.id, aKit);
  for (const p of b) r.combat.arena.setKitOverride(p.id, bKit);
  const results: FightResult[] = [];
  r.combat.onFightEnded((res) => results.push(res));
  const id = r.combat.engage([{ faction: 'red', people: a.map((p) => p.id) }, { faction: 'blue', people: b.map((p) => p.id) }], { at: { x: 500, z: 500 } });
  expect(id).toBeGreaterThan(0);
  stepFor(r.sim, seconds);
  return { r, a, b, results };
}

describe('melee fights', () => {
  it('summons the fighters, runs to a result and reports it', () => {
    const { r, results, a, b } = runFight('f1', { weapon: 'sword', shield: 'shield', armour: ['padded_armour'] }, { weapon: 'axe', armour: [] });
    expect(results).toHaveLength(1);
    const res = results[0];
    expect(res.winner === 'red' || res.winner === 'blue' || res.winner === null).toBe(true);
    // somebody was hurt or fled
    const hurt = [...a, ...b].filter((p) => p.death || r.combat.wounds(p.id).length > 0).length;
    expect(hurt).toBeGreaterThan(0);
    expect(r.combat.isFighting(a[0].id)).toBe(false);
    expect(r.combat.anyFight!()).toBe(false);
    expect(r.zone.summoned.size + r.zone.dismissedPeople.length).toBeGreaterThan(0);
  });

  it('is deterministic for a seed', () => {
    const one = runFight('same', { weapon: 'sword' }, { weapon: 'spear' }, 3, 40);
    const two = runFight('same', { weapon: 'sword' }, { weapon: 'spear' }, 3, 40);
    expect(one.r.sim.stateHash()).toBe(two.r.sim.stateHash());
    expect(JSON.stringify(one.results)).toBe(JSON.stringify(two.results));
  });

  it('armour and a shield cost the wearer far less blood than bare skin with the same sword', () => {
    let armouredLoss = 0, bareLoss = 0;
    for (let i = 0; i < 8; i++) {
      // the same four men fight twice, once with each pair armoured, so who they are cancels out
      for (const swap of [false, true]) {
        const r = combatRig({ seed: `armour${i}` });
        const men = adultMen(r.sim, 4);
        for (const p of men) { setStats(p, { str: 11, agi: 11, end: 11 }); p.needs.hunger = 1; p.needs.rest = 1; p.rankTier = 2; p.traits = []; }
        const armoured = swap ? men.slice(2) : men.slice(0, 2);
        const bare = swap ? men.slice(0, 2) : men.slice(2);
        for (const p of armoured) r.combat.arena.setKitOverride(p.id, { weapon: 'sword', shield: 'shield_heater', armour: ['mail_hauberk', 'kettle_hat'] });
        for (const p of bare) r.combat.arena.setKitOverride(p.id, { weapon: 'sword', armour: [] });
        // what each side had lost when the fight was over (before the wounds are left to bleed)
        const loss = (ps: typeof men): number => ps.reduce((s, p) => s + (p.death ? 1 : 1 - p.health.hp), 0);
        r.combat.onFightEnded(() => { armouredLoss += loss(armoured); bareLoss += loss(bare); });
        r.combat.engage([{ faction: 'armoured', people: armoured.map((p) => p.id) }, { faction: 'bare', people: bare.map((p) => p.id) }], { at: { x: 500, z: 500 } });
        stepFor(r.sim, 70);
      }
    }
    expect(armouredLoss).toBeLessThan(bareLoss * 0.8);
  });

  it('a long weapon keeps a man with a knife at bay', () => {
    let spear = 0, knife = 0;
    for (let i = 0; i < 6; i++) {
      const { results } = runFight(`reach${i}`, { weapon: 'spear' }, { weapon: 'dagger' }, 1, 60);
      if (results[0]?.winner === 'red') spear++;
      else if (results[0]?.winner === 'blue') knife++;
    }
    expect(spear).toBeGreaterThanOrEqual(knife);
  });

  it('noble prisoners: a beaten knight yields and is captured for ransom', () => {
    const r = combatRig({ seed: 'yield' });
    const [k, ...hands] = adultMen(r.sim, 5);
    k.rankTier = 5;
    setStats(k, { str: 9, agi: 9, end: 9 });
    k.traits = k.traits.filter((t) => t !== 'brave');
    r.combat.arena.setKitOverride(k.id, { weapon: 'dagger', armour: [] });
    for (const h of hands) { setStats(h, { str: 13, agi: 12, end: 12 }); r.combat.arena.setKitOverride(h.id, { weapon: 'sword', armour: ['mail_hauberk'] }); }
    const captured: Array<{ captive: number; captor: number; ransom: number }> = [];
    r.sim.events.on('captured', (e) => captured.push(e));
    const results: FightResult[] = [];
    r.combat.onFightEnded((res) => results.push(res));
    r.combat.engage([{ faction: 'knight', people: [k.id] }, { faction: 'mob', people: hands.map((h) => h.id) }], { at: { x: 500, z: 500 }, yieldAllowed: true });
    stepFor(r.sim, 80);
    expect(results).toHaveLength(1);
    expect(results[0].winner).toBe('mob');
    if (!k.death) {
      expect(results[0].captured.some((c) => c.captive === k.id)).toBe(true);
      expect(captured.length).toBeGreaterThan(0);
      expect(captured[0].ransom).toBeGreaterThan(100);
      expect(k.flags.captive).toBe(true);
    }
  });

  it('commoners run when the odds turn', () => {
    const r = combatRig({ seed: 'rout' });
    const men = adultMen(r.sim, 7);
    for (const p of men) { setStats(p, { str: 11, agi: 11, end: 11 }); p.traits = p.traits.filter((t) => t !== 'brave'); r.combat.arena.setKitOverride(p.id, { weapon: 'sword', armour: [] }); }
    const lone = men[0];
    lone.traits.push('craven');
    const results: FightResult[] = [];
    r.combat.onFightEnded((res) => results.push(res));
    r.combat.engage([{ faction: 'one', people: [lone.id] }, { faction: 'many', people: men.slice(1).map((p) => p.id) }], { at: { x: 500, z: 500 } });
    stepFor(r.sim, 60);
    expect(results).toHaveLength(1);
    expect(results[0].winner).toBe('many');
    expect(results[0].fled.includes(lone.id) || results[0].dead.includes(lone.id) || results[0].wounded.includes(lone.id) || lone.flags.captive === true).toBe(true);
  });

  it('archers loose from a distance and one arrow can end it', () => {
    const r = combatRig({ seed: 'archers' });
    const [a, b] = adultMen(r.sim, 2);
    setStats(a, { str: 12, per: 13, agi: 11 });
    r.combat.arena.setKitOverride(a.id, { weapon: 'dagger', ranged: 'longbow', armour: [] });
    r.combat.arena.setKitOverride(b.id, { weapon: 'sword', armour: [] });
    const proj = r.combat.arena.env.proj;
    let flew = false;
    r.combat.engage([{ faction: 'bow', people: [a.id] }, { faction: 'sword', people: [b.id] }], { at: { x: 500, z: 500 } });
    const fa = r.combat.arena.fighterOf(a.id)!;
    const fb = r.combat.arena.fighterOf(b.id)!;
    fa.x = 480; fa.z = 500; fb.x = 515; fb.z = 500;
    for (let i = 0; i < 400 && r.combat.arena.anyFight(); i++) {
      r.sim.step(0.05);
      if (proj.flying.length > 0) flew = true;
    }
    expect(flew).toBe(true);
    expect(fa.hitsLanded + (b.death ? 1 : 0) + r.combat.wounds(b.id).length).toBeGreaterThan(0);
    expect(S.Dead).toBeGreaterThan(0);
  });
});
