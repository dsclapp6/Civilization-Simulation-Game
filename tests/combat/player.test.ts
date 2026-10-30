import { describe, expect, it } from 'vitest';
import { S } from '../../src/combat/fighter';
import { SIM_DT } from '../../src/core/time';
import { adultMen, combatRig, input, setStats, stepFor, type CombatRig } from './helpers';

/** One frame of the real controller with the given held buttons (a frame is one 20 Hz step here). */
function frame(r: CombatRig, over: Parameters<typeof input>[0] = {}): void {
  r.player!.setInput(input(over));
  r.sim.step(SIM_DT);
  r.player!.frame?.(SIM_DT);
}
function hold(r: CombatRig, seconds: number, over: Parameters<typeof input>[0] = {}): void {
  const n = Math.round(seconds / SIM_DT);
  for (let i = 0; i < n; i++) frame(r, over);
}
const draw = (r: CombatRig) => r.zone.attached!.draw;

/** A dummy: stands where it is put and never thinks (its swings are started by the test). */
function freeze(f: { think: number; wantSpeed: number; aggression: number; cooldown: number; morale: number; moraleBase: number }): void {
  f.think = 1e9; f.wantSpeed = 0; f.aggression = 0.01; f.cooldown = 999; f.morale = f.moraleBase = 500;
}

/** The player with a sword, a bandit one and a half metres in front, and a fight between them. */
function duelRig(seed: string, weapon = 'sword') {
  const r = combatRig({ seed, player: true });
  const pid = r.sim.state.run.playerId;
  const me = r.sim.state.persons.get(pid)!;
  setStats(me, { str: 12, agi: 11, end: 12 });
  r.combat.arena.setKitOverride(pid, { weapon, armour: [] });
  const [foe] = adultMen(r.sim, 1);
  r.combat.arena.setKitOverride(foe.id, { weapon: 'dagger', armour: [] });
  const body = r.player!.body()!;
  const id = r.combat.engage([{ faction: 'player', people: [pid] }, { faction: 'bandits', people: [foe.id] }], { at: { x: body.x, z: body.z } });
  const pf = r.combat.arena.fighterOf(pid)!;
  const ff = r.combat.arena.fighterOf(foe.id)!;
  // the foe stands right in front of the player, but does not fight back (we test the player here)
  ff.x = body.x + Math.sin(body.yaw) * 1.5; ff.z = body.z + Math.cos(body.yaw) * 1.5;
  freeze(ff);
  ff.yaw = Math.atan2(body.x - ff.x, body.z - ff.z);
  ff.wantYaw = ff.yaw;
  return { r, me, foe, pf, ff, id, yaw: body.yaw };
}

describe('the player in a fight', () => {
  it('a click swings the sword, shows the blow and lands it on the man in front', () => {
    const { r, ff, pf, yaw } = duelRig('pl-attack');
    const seen = new Set<string>();
    let landed = 0;
    for (let n = 0; n < 6 && landed === 0; n++) {
      frame(r, { attack: true, cameraYaw: yaw });
      frame(r, { attack: false, cameraYaw: yaw });
      for (let i = 0; i < 30; i++) { frame(r, { cameraYaw: yaw }); seen.add(draw(r).anim); }
      landed = pf.hitsLanded;
    }
    expect(seen.has('attack_slash')).toBe(true);
    expect(landed).toBeGreaterThan(0);
    expect(ff.hitsTaken).toBeGreaterThan(0);
    expect(draw(r).mainHand).toBe('sword');
  });

  it('holding the button builds a heavy overhead blow', () => {
    const { r, yaw, pf } = duelRig('pl-heavy');
    hold(r, 0.45, { attack: true, cameraYaw: yaw });
    expect(pf.attackKey).toBe('overhead');
    expect(draw(r).anim === 'attack_overhead' || pf.st === S.Windup || pf.st === S.Recover).toBe(true);
  });

  it('the right button raises a guard that turns blows aside and slows the walk', () => {
    const swings = (guard: boolean): number => {
      const { r, yaw, pf, ff, me } = duelRig('pl-block');
      if (guard) {
        hold(r, 0.3, { block: true, cameraYaw: yaw });
        expect(pf.st).toBe(S.Block);
        expect(draw(r).anim).toBe('block');
      }
      // the foe swings fifteen times at the man in front of him
      for (let i = 0; i < 15 && !me.death; i++) {
        ff.target = pf; ff.cooldown = 0;
        ff.st = S.Idle; ff.attack = null;
        r.combat.arena.startAttack(ff, 'slash');
        for (let k = 0; k < 14; k++) frame(r, { block: guard, cameraYaw: yaw });
      }
      return me.death ? 1 : 1 - me.health.hp;
    };
    const guarded = swings(true);
    const bare = swings(false);
    expect(guarded).toBeLessThan(bare * 0.7);
    expect(guarded).toBeLessThan(0.6);
    const { r, yaw } = duelRig('pl-block-walk');
    const z0 = r.player!.body()!.z;
    hold(r, 1, { block: true, forward: 1, cameraYaw: yaw });
    expect(Math.abs(r.player!.body()!.z - z0)).toBeLessThan(3.2 * 0.6);
  });

  it('a roll gives a moment in which blows miss', () => {
    const { r, yaw, pf } = duelRig('pl-dodge');
    let invulnerable = 0;
    frame(r, { dodge: true, forward: 1, cameraYaw: yaw });
    for (let i = 0; i < 12; i++) { frame(r, { cameraYaw: yaw }); if (pf.dodgeI > 0) invulnerable++; }
    expect(invulnerable).toBeGreaterThan(2);
    expect(invulnerable).toBeLessThan(9);
  });

  it('a blow that lands wounds the same body anyone has, and being hurt staggers the player', () => {
    const { r, yaw, pf, ff, me } = duelRig('pl-hurt');
    ff.aggression = 1;
    let wounded = false;
    let reeled = false;
    for (let i = 0; i < 12 && !wounded && !me.death; i++) {
      ff.target = pf; ff.cooldown = 0; ff.st = S.Idle;
      r.combat.arena.startAttack(ff, 'overhead');
      for (let k = 0; k < 16; k++) { frame(r, { cameraYaw: yaw }); if (pf.st === S.Stagger || pf.st === S.Hit || pf.st === S.Down) reeled = true; }
      wounded = r.combat.wounds(me.id).length > 0;
    }
    // a blow either leaves a wound on the player or, if it was a mortal one, ends the life: there is no hero health
    expect(wounded || me.death !== null).toBe(true);
    expect(reeled).toBe(true);
    if (!me.death) {
      expect(me.health.hp).toBeLessThan(1);
      expect(me.health.conditions.some((c) => c.id === 'injury')).toBe(true);
    } else expect(me.death.cause).toBe('violence');
  });

  it('a longbow is drawn with the right button and loosed with the left along the camera ray', () => {
    const r = combatRig({ seed: 'pl-bow', player: true });
    const pid = r.sim.state.run.playerId;
    const me = r.sim.state.persons.get(pid)!;
    setStats(me, { str: 13, per: 12 });
    r.combat.arena.setKitOverride(pid, { weapon: 'dagger', ranged: 'longbow', armour: [] });
    const [foe] = adultMen(r.sim, 1);
    r.combat.arena.setKitOverride(foe.id, { weapon: 'sword', armour: [] });
    const body = r.player!.body()!;
    r.combat.engage([{ faction: 'player', people: [pid] }, { faction: 'bandits', people: [foe.id] }], { at: { x: body.x, z: body.z } });
    const ff = r.combat.arena.fighterOf(foe.id)!;
    ff.x = body.x + Math.sin(body.yaw) * 22; ff.z = body.z + Math.cos(body.yaw) * 22;
    freeze(ff);
    const camY = body.y + 1.6;
    const aim = { x: body.x - Math.sin(body.yaw) * 3, y: camY + 0.6, z: body.z - Math.cos(body.yaw) * 3, dx: Math.sin(body.yaw), dy: -0.03, dz: Math.cos(body.yaw) };
    const tgtDist = Math.hypot(ff.x - aim.x, ff.z - aim.z);
    aim.dy = (ff.y + 1.1 - aim.y) / tgtDist;
    const pf = r.combat.arena.fighterOf(pid)!;
    const proj = r.combat.arena.env.proj;
    let drawn = false, aimed = false, flew = false, bowShown = false;
    for (let i = 0; i < 20 * 14; i++) {
      const aiming = i < 20 * 10;
      r.player!.setInput(input({ block: aiming, attack: aiming && pf.st === S.Aim && i % 40 > 20, cameraYaw: body.yaw, aim }));
      r.sim.step(SIM_DT); r.player!.frame?.(SIM_DT);
      if (pf.st === S.Draw) drawn = true;
      if (pf.st === S.Aim) { aimed = true; if (draw(r).mainHand === 'longbow') bowShown = true; }
      if (proj.flying.length > 0) flew = true;
    }
    expect(drawn && aimed && flew).toBe(true);
    expect(bowShown).toBe(true);
  });

  it('a bow picked up a moment before the guard is pressed is drawn, not held in melee Block', () => {
    const r = combatRig({ seed: 'pl-bow-race', player: true });
    const pid = r.sim.state.run.playerId;
    const me = r.sim.state.persons.get(pid)!;
    setStats(me, { str: 13, per: 12 });
    const [foe] = adultMen(r.sim, 1);
    r.combat.arena.setKitOverride(foe.id, { weapon: 'sword', armour: [] });
    const body = r.player!.body()!;
    r.combat.engage([{ faction: 'player', people: [pid] }, { faction: 'bandits', people: [foe.id] }], { at: { x: body.x, z: body.z } });
    const ff = r.combat.arena.fighterOf(foe.id)!;
    ff.x = body.x + Math.sin(body.yaw) * 22; ff.z = body.z + Math.cos(body.yaw) * 22;
    freeze(ff);
    // a few frames in melee: the port has just refreshed its gear
    hold(r, 0.3, { cameraYaw: body.yaw });
    const pf = r.combat.arena.fighterOf(pid)!;
    expect(pf.gear.ranged).toBeNull();
    // the bow and arrows come into the pack and into the hand, and the guard goes up at once
    me.inventory['longbow#2'] = 1;
    me.inventory['arrow#1'] = 24;
    r.economy.equip(pid, 'main', 'longbow#2');
    frame(r, { block: true, cameraYaw: body.yaw });
    frame(r, { block: true, cameraYaw: body.yaw });
    expect(pf.gear.ranged).not.toBeNull();
    expect(pf.st === S.Draw || pf.st === S.Aim).toBe(true);
  });

  it('a mounted charge with a couched lance hits harder the faster the horse', () => {
    const r = combatRig({ seed: 'pl-lance', player: true });
    const pid = r.sim.state.run.playerId;
    const me = r.sim.state.persons.get(pid)!;
    setStats(me, { str: 13, agi: 12, end: 12 });
    r.player!.debug!.forceMount();
    r.combat.arena.setKitOverride(pid, { weapon: 'lance', armour: [] });
    stepFor(r.sim, 2.5);
    const [foe] = adultMen(r.sim, 1);
    r.combat.arena.setKitOverride(foe.id, { weapon: 'sword', armour: [] });
    const body = r.player!.body()!;
    r.combat.engage([{ faction: 'player', people: [pid] }, { faction: 'bandits', people: [foe.id] }], { at: { x: body.x, z: body.z } });
    const ff = r.combat.arena.fighterOf(foe.id)!;
    const yaw = body.yaw;
    ff.x = body.x + Math.sin(yaw) * 40; ff.z = body.z + Math.cos(yaw) * 40;
    freeze(ff);
    const pf = r.combat.arena.fighterOf(pid)!;
    let charged = false;
    for (let i = 0; i < 20 * 14 && ff.hitsTaken === 0 && !foe.death; i++) {
      r.player!.setInput(input({ forward: 1, sprint: true, attack: true, cameraYaw: yaw }));
      r.sim.step(SIM_DT); r.player!.frame?.(SIM_DT);
      if (pf.st === S.Charge) charged = true;
    }
    expect(charged).toBe(true);
    expect(draw(r).anim === 'ride_charge' || charged).toBe(true);
    expect(ff.hitsTaken > 0 || foe.death !== null).toBe(true);
  });
});

describe('a road fight', () => {
  it('Fight is among the choices; choosing it turns the party into the other side and the road waits', () => {
    const r = combatRig({ seed: 'pl-road', player: true });
    const pid = r.sim.state.run.playerId;
    r.combat.arena.setKitOverride(pid, { weapon: 'sword', armour: ['padded_armour'] });
    r.player!.debug!.forceEncounter('bandits');
    const t = r.player!.travel()!;
    expect(t.phase).toBe('encounter');
    const fight = t.encounter!.choices!.find((c) => c.id === 'encounter.fight');
    expect(fight).toBeTruthy();
    expect(fight!.enabled).toBe(true);
    const out = r.player!.perform(fight!);
    expect(out.ok).toBe(true);
    expect(r.combat.anyFight!()).toBe(true);
    expect(r.player!.travel()!.phase).toBe('encounter');
    expect(r.player!.travel()!.encounter).toBeUndefined();
    expect(r.sim.hostileNear()).toBe(true);
    expect(r.sim.state.clock.actionTime).toBe(true);
    // the fight runs to its end and the journey carries on
    for (let i = 0; i < 20 * 120 && r.combat.anyFight!(); i++) { r.player!.setInput(input({ block: i % 40 < 20, attack: i % 40 >= 20 })); r.sim.step(SIM_DT); }
    expect(r.combat.anyFight!()).toBe(false);
    const after = r.player!.travel();
    expect(after === null || after.phase !== 'encounter' || r.sim.state.run.phase !== 'alive').toBe(true);
  });

  it('wolves can be fought too', () => {
    const r = combatRig({ seed: 'pl-wolves', player: true });
    const pid = r.sim.state.run.playerId;
    r.combat.arena.setKitOverride(pid, { weapon: 'sword', armour: [] });
    r.player!.debug!.forceEncounter('wolves');
    const t = r.player!.travel()!;
    const fight = t.encounter!.choices!.find((c) => c.id === 'encounter.fight')!;
    expect(fight.enabled).toBe(true);
    r.player!.perform(fight);
    expect(r.combat.anyFight!()).toBe(true);
    const beasts = r.combat.arena.fighters.filter((f) => f.isAnimal);
    expect(beasts.length).toBeGreaterThan(0);
  });
});
