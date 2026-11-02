// Mounted fighting (docs/WAR.md): sword cuts from the saddle, the couched spear and lance, the braced spear, horses wounded by
// arrows and blows, rearing, falling, riders thrown.
import { describe, expect, it } from 'vitest';
import { S } from '../../src/combat/fighter';
import { COUCH_MIN_SPEED, couchable, couchWeight, WEAPONS } from '../../src/combat/weapons';
import { SIM_DT } from '../../src/core/time';
import { adultMen, combatRig, setStats, stepFor } from './helpers';

function frozen(f: { think: number; wantSpeed: number; aggression: number; cooldown: number; morale: number; moraleBase: number }): void {
  f.think = 1e9; f.wantSpeed = 0; f.aggression = 0.01; f.cooldown = 999; f.morale = f.moraleBase = 900;
}

describe('what can be couched', () => {
  it('a lance and a spear are couched, a sword is not; a spear carries less weight than a lance; a trot is too slow', () => {
    expect(couchable(WEAPONS.lance)).toBe(true);
    expect(couchable(WEAPONS.spear)).toBe(true);
    expect(couchable(WEAPONS.sword)).toBe(false);
    expect(couchWeight(WEAPONS.spear)).toBeLessThan(couchWeight(WEAPONS.lance));
    // the new gaits: walk 1.7, trot 3.5, canter 6, gallop 10: a canter is enough to couch, a trot is not
    expect(COUCH_MIN_SPEED).toBeGreaterThan(3.5);
    expect(COUCH_MIN_SPEED).toBeLessThanOrEqual(6);
  });
});

describe('the sword from the saddle', () => {
  function cut(mounted: boolean, gapM: number): number {
    let hits = 0;
    for (let i = 0; i < 10; i++) {
      const r = combatRig({ seed: `saddle${i}` });
      const [a, b] = adultMen(r.sim, 2);
      for (const p of [a, b]) { setStats(p, { str: 12, agi: 11, end: 12 }); p.needs.hunger = 1; p.traits = []; }
      r.combat.arena.setKitOverride(a.id, { weapon: 'sword', armour: [] });
      r.combat.arena.setKitOverride(b.id, { weapon: 'dagger', armour: [] });
      r.combat.engage([{ faction: 'a', people: [a.id], mounted: mounted ? [a.id] : [] }, { faction: 'b', people: [b.id] }], { at: { x: 500, z: 500 } });
      const fa = r.combat.arena.fighterOf(a.id)!, fb = r.combat.arena.fighterOf(b.id)!;
      if (mounted) { fa.gear.weapon = WEAPONS.sword; fa.sidearm = WEAPONS.sword; }
      frozen(fb);
      fa.think = 1e9;
      fa.x = 500; fa.z = 500; fb.x = 500; fb.z = 500 + gapM + fa.radius + fb.radius; fa.yaw = 0; fb.yaw = Math.PI;
      fa.target = fb;
      fa.stamina = 100;
      r.combat.arena.startAttack(fa, 'slash');
      stepFor(r.sim, 1.2);
      if (fb.hitsTaken > 0) hits++;
    }
    return hits;
  }
  it('reaches a little further than the same cut on foot', () => {
    // a gap that a man on foot just misses and a rider just reaches (sword reach 1.05 + 0.2; rider +0.45)
    expect(cut(true, 1.9)).toBeGreaterThanOrEqual(6);
    expect(cut(false, 1.9)).toBe(0);
  });
});

describe('the couched spear', () => {
  it('a rider with a spear keeps it for the charge, gallops at the line and wounds the man he rides down', () => {
    let rode = 0, struck = 0;
    for (let i = 0; i < 8; i++) {
      const r = combatRig({ seed: `couch-spear${i}` });
      const [k, foot] = adultMen(r.sim, 2);
      for (const p of [k, foot]) { setStats(p, { str: 12, agi: 11, end: 12 }); p.needs.hunger = 1; p.needs.rest = 1; p.traits = []; }
      r.combat.arena.setKitOverride(k.id, { weapon: 'spear', armour: ['mail_hauberk'] });
      r.combat.arena.setKitOverride(foot.id, { weapon: 'dagger', armour: [] });
      r.zone.addAgent(k.id, 470, 500);
      r.zone.addAgent(foot.id, 500, 500);
      r.combat.engage([{ faction: 'a', people: [k.id], mounted: [k.id] }, { faction: 'b', people: [foot.id] }], { at: { x: 485, z: 500 } });
      const fk = r.combat.arena.fighterOf(k.id)!, ff = r.combat.arena.fighterOf(foot.id)!;
      expect(fk.gear.weapon.id).toBe('spear');
      expect(fk.sidearm?.id).toBe('sword');
      fk.x = 470; fk.z = 500; ff.x = 500; ff.z = 500;
      let top = 0;
      for (let t = 0; t < 20 * 40 && r.combat.anyFight!(); t++) { r.sim.step(SIM_DT); top = Math.max(top, fk.speed); }
      if (top >= COUCH_MIN_SPEED) rode++;
      if (fk.hitsLanded > 0 || ff.hitsTaken > 0) struck++;
    }
    expect(rode).toBeGreaterThanOrEqual(7);
    expect(struck).toBeGreaterThanOrEqual(5);
  });
});

describe('horses', () => {
  function riderRig(seed: string, foeKit: { weapon: string; ranged?: string; armour?: string[] }, atFoe: [number, number] = [520, 500]) {
    const r = combatRig({ seed });
    const [k, foe] = adultMen(r.sim, 2);
    for (const p of [k, foe]) { setStats(p, { str: 13, agi: 11, end: 12, per: 13 }); p.needs.hunger = 1; p.needs.rest = 1; p.traits = []; }
    r.combat.arena.setKitOverride(k.id, { weapon: 'sword', armour: ['mail_hauberk'] });
    r.combat.arena.setKitOverride(foe.id, { ...foeKit, armour: foeKit.armour ?? [] });
    const agent = r.zone.addAgent(k.id, 500, 500);
    r.zone.addAgent(foe.id, atFoe[0], atFoe[1]);
    r.combat.engage([{ faction: 'knights', people: [k.id], mounted: [k.id] }, { faction: 'foes', people: [foe.id] }], { at: { x: 505, z: 500 } });
    const fk = r.combat.arena.fighterOf(k.id)!, ff = r.combat.arena.fighterOf(foe.id)!;
    fk.x = 500; fk.z = 500; ff.x = atFoe[0]; ff.z = atFoe[1];
    frozen(fk);
    fk.wantSpeed = 0;
    return { r, k, foe, fk, ff, agent };
  }

  it('an arrow that strikes below the saddle hits the horse; enough of them bring it down and throw the rider, who is hurt', () => {
    let horseHit = 0, thrown = 0, corpses = 0;
    for (let i = 0; i < 6; i++) {
      const { r, fk, ff, k } = riderRig(`harrow${i}`, { weapon: 'dagger', ranged: 'longbow' });
      ff.think = 1e9; ff.morale = ff.moraleBase = 900;
      let arrows = 0;
      // the archer shoots the rider again and again at twenty metres, aiming low
      for (let t = 0; t < 20 * 50 && fk.mounted; t++) {
        if (ff.st === S.Idle && ff.cooldown <= 0 && arrows < 40) {
          ff.shotsLeft = 30; ff.stamina = 100; ff.target = fk; ff.aimSet = true;
          ff.aimDx = -1; ff.aimDz = 0; ff.aimDy = -0.02; ff.pitch = -0.02;
          // the shot leaves the string at the rider's low line
          ff.y = fk.y - 0.6;
          ff.set(S.Shoot, 'shoot_bow', 0.8); ff.impacted = false; arrows++; ff.cooldown = 0.5;
        }
        r.sim.step(SIM_DT);
      }
      if (fk.mountHp < 110) horseHit++;
      if (!fk.mounted && fk.unhorse) {
        thrown++;
        if (r.combat.arena.beastCorpses.some((c) => c.draw.kind === 'horse' && c.draw.anim === 'dead')) { corpses++; expect(k.health.hp).toBeLessThan(1); }
      }
    }
    expect(horseHit).toBeGreaterThanOrEqual(4);
    expect(thrown).toBeGreaterThanOrEqual(1);
    expect(corpses).toBeGreaterThanOrEqual(1);
  });

  it('a horse struck by a blow rears (drawn rearing) and its rider is shaken; killed, it falls and the rider is thrown', () => {
    const { r, fk, agent, k } = riderRig('hrear', { weapon: 'dagger' });
    for (let i = 0; i < 4; i++) r.sim.step(SIM_DT);
    expect(agent.draw.mount?.anim).not.toBe('rear');
    r.combat.arena.horseStruck(fk, 30, 520, 500);
    r.sim.step(SIM_DT);
    expect(fk.rearT).toBeGreaterThan(0);
    expect(agent.draw.mount?.anim).toBe('rear');
    expect(fk.mounted).toBe(true);
    // killed under him
    r.combat.arena.horseStruck(fk, 200, 520, 500);
    expect(fk.mounted).toBe(false);
    expect(fk.unhorse).toBe(true);
    expect(fk.st === S.Down || k.health.hp < 1).toBe(true);
    expect(agent.draw.mount).toBeUndefined();
    const corpse = r.combat.arena.beastCorpses.find((c) => c.draw.kind === 'horse');
    expect(corpse?.draw.anim).toBe('dead');
    // and the corpse reaches the view
    expect(r.sim.view.animals().some((a) => a.kind === 'horse' && a.anim === 'dead')).toBe(true);
  });

  it('a wounded horse is slower', () => {
    const { r, fk } = riderRig('hslow', { weapon: 'dagger' });
    const well = r.combat.arena.mobility(fk);
    fk.mountHp = 20;
    expect(r.combat.arena.mobility(fk)).toBeLessThan(well * 0.8);
  });

  it('a spearman standing his ground breaks a charge now and then: the point takes the horse', () => {
    let broken = 0, plain = 0;
    for (let i = 0; i < 14; i++) {
      for (const kit of ['spear', 'dagger'] as const) {
        const r = combatRig({ seed: `brace${i}` });
        const [k, foe] = adultMen(r.sim, 2);
        for (const p of [k, foe]) { setStats(p, { str: 12, agi: 11, end: 12 }); p.needs.hunger = 1; p.needs.rest = 1; p.traits = []; }
        r.combat.arena.setKitOverride(k.id, { weapon: 'sword', armour: ['mail_hauberk'] });
        r.combat.arena.setKitOverride(foe.id, { weapon: kit, armour: [] });
        r.zone.addAgent(k.id, 470, 500);
        r.zone.addAgent(foe.id, 500, 500);
        r.combat.engage([{ faction: 'knights', people: [k.id], mounted: [k.id] }, { faction: 'foes', people: [foe.id] }], { at: { x: 485, z: 500 } });
        const fk = r.combat.arena.fighterOf(k.id)!, ff = r.combat.arena.fighterOf(foe.id)!;
        fk.x = 470; fk.z = 500; ff.x = 500; ff.z = 500;
        ff.think = 1e9; ff.morale = ff.moraleBase = 900; ff.yaw = -Math.PI / 2; ff.wantSpeed = 0; ff.cooldown = 999;
        ff.melee = 8;
        let struck = 0;
        const arena = r.combat.arena;
        const orig = arena.horseStruck.bind(arena);
        arena.horseStruck = (rider, dmg, fx, fz) => { struck++; orig(rider, dmg, fx, fz); };
        for (let t = 0; t < 20 * 12 && r.combat.anyFight!(); t++) r.sim.step(SIM_DT);
        if (struck > 0) { if (kit === 'spear') broken++; else plain++; }
      }
    }
    expect(broken).toBeGreaterThanOrEqual(2);
    expect(plain).toBe(0);
  });
});
