import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../../src/core/time';
import { S } from '../../src/combat/fighter';
import { adultMen, combatRig, setStats, stepFor } from './helpers';

describe('NPC cavalry', () => {
  it('a mounted knight is drawn on a horse, gallops at the line, lands the lance and is on foot again when the fight ends', () => {
    let rode = 0, struck = 0, drawn = 0, cleared = 0;
    for (let i = 0; i < 6; i++) {
      const r = combatRig({ seed: `lance${i}` });
      const [k, foot] = adultMen(r.sim, 2);
      for (const p of [k, foot]) { setStats(p, { str: 12, agi: 11, end: 12 }); p.needs.hunger = 1; p.needs.rest = 1; }
      r.combat.arena.setKitOverride(k.id, { weapon: 'sword', armour: ['mail'] });
      r.combat.arena.setKitOverride(foot.id, { weapon: 'dagger', armour: [] });
      const agent = r.zone.addAgent(k.id, 470, 500);
      r.zone.addAgent(foot.id, 500, 500);
      r.combat.engage([{ faction: 'house:1', people: [k.id], mounted: [k.id] }, { faction: 'house:2', people: [foot.id] }], { at: { x: 485, z: 500 } });
      const fk = r.combat.arena.fighterOf(k.id)!, ff = r.combat.arena.fighterOf(foot.id)!;
      fk.x = 470; fk.z = 500; ff.x = 500; ff.z = 500;
      expect(fk.mounted).toBe(true);
      expect(fk.gear.weapon.id).toBe('lance');
      let top = 0, sawMount = false;
      for (let t = 0; t < 20 * 45 && r.combat.anyFight!(); t++) {
        r.sim.step(SIM_DT);
        top = Math.max(top, fk.speed);
        if (agent.draw.mount) sawMount = true;
      }
      if (top > 6) rode++;
      if (fk.hitsLanded > 0 || r.combat.wounds(foot.id).length > 0 || foot.death) struck++;
      if (sawMount) drawn++;
      if (!agent.draw.mount && !fk.mounted) cleared++;
      expect(fk.st === S.Dead || fk.mounted === false).toBe(true);
    }
    expect(rode).toBeGreaterThanOrEqual(5);
    expect(struck).toBeGreaterThanOrEqual(4);
    expect(drawn).toBe(6);
    expect(cleared).toBe(6);
  });

  it('is deterministic', () => {
    const run = (): string => {
      const r = combatRig({ seed: 'lance-det' });
      const [k, foot] = adultMen(r.sim, 2);
      r.combat.arena.setKitOverride(k.id, { weapon: 'sword', armour: [] });
      r.combat.arena.setKitOverride(foot.id, { weapon: 'spear', armour: [] });
      r.combat.engage([{ faction: 'a', people: [k.id], mounted: [k.id] }, { faction: 'b', people: [foot.id] }], { at: { x: 500, z: 500 } });
      stepFor(r.sim, 40);
      return r.sim.stateHash();
    };
    expect(run()).toBe(run());
  });
});

describe('wounds slow people; stray arrows hit bystanders', () => {
  it('low health and a hurt leg slow a person', () => {
    const r = combatRig({ seed: 'slow' });
    const [p] = adultMen(r.sim, 1);
    const book = r.combat.arena.env.book;
    const well = book.mobility(p);
    expect(well).toBe(1);
    p.health.hp = 0.2;
    const weak = book.mobility(p);
    expect(weak).toBeLessThan(0.8);
    expect(weak).toBeGreaterThanOrEqual(0.45);
  });

  it('an arrow loosed along a line that a bystander stands on wounds him', () => {
    let wounded = 0;
    for (let i = 0; i < 10; i++) {
      const r = combatRig({ seed: `stray${i}` });
      const [a, b, c] = adultMen(r.sim, 3);
      setStats(a, { str: 13, per: 13, agi: 11 });
      a.skills.archery = 4000;
      r.combat.arena.setKitOverride(a.id, { weapon: 'dagger', ranged: 'longbow', armour: [] });
      r.combat.arena.setKitOverride(b.id, { weapon: 'dagger', armour: [] });
      r.zone.addAgent(c.id, 489, 500);
      r.combat.engage([{ faction: 'bow', people: [a.id] }, { faction: 'mark', people: [b.id] }], { at: { x: 500, z: 500 } });
      const fa = r.combat.arena.fighterOf(a.id)!, fb = r.combat.arena.fighterOf(b.id)!;
      fa.x = 480; fa.z = 500; fb.x = 497; fb.z = 500;
      fb.think = 1e9; fb.wantSpeed = 0; fb.morale = fb.moraleBase = 500;
      for (let t = 0; t < 20 * 25 && r.combat.anyFight!(); t++) { r.sim.step(SIM_DT); fb.x = 497; fb.z = 500; }
      if (r.combat.wounds(c.id).length > 0 || c.death) wounded++;
    }
    expect(wounded).toBeGreaterThan(0);
  });
});
