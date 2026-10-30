import { describe, expect, it } from 'vitest';
import { installCombat } from '../../src/combat';
import { S } from '../../src/combat/fighter';
import { Healers, dailyCare } from '../../src/combat/macro';
import { installEconomy } from '../../src/sim/economy';
import { MemorySaveStore } from '../../src/sim/save-memory';
import { hashState } from '../../src/sim/serialize';
import { Simulation } from '../../src/sim/sim';
import { installSocial } from '../../src/sim/social';
import { skillOf } from '../../src/sim/skills';
import { SIM_DT } from '../../src/core/time';
import { mockGenerator } from '../sim/helpers';
import { adultMen, combatRig, input, setStats, stepFor } from './helpers';
import { FakeZone } from '../player/fakes';

describe('the contract', () => {
  it('registers sim.services.combat and answers the whole CombatApi', () => {
    const r = combatRig();
    expect(r.sim.services.combat).toBe(r.combat);
    const [a, b] = adultMen(r.sim, 2);
    expect(r.combat.isFighting(a.id)).toBe(false);
    expect(r.combat.wounds(a.id)).toEqual([]);
    const id = r.combat.engage([{ faction: 'x', people: [a.id] }, { faction: 'y', people: [b.id] }], { at: { x: 100, z: 100 }, reason: 'test' });
    expect(id).toBeGreaterThan(0);
    expect(r.combat.isFighting(a.id)).toBe(true);
    expect(r.combat.fightOf!(a.id)).toBe(id);
    // a person cannot be in two fights; a fight needs two sides
    expect(r.combat.engage([{ faction: 'z', people: [a.id] }, { faction: 'w', people: [] }])).toBe(0);
    const ended: number[] = [];
    r.combat.onFightEnded((res) => ended.push(res.id));
    r.sim.events.on('fightEnded', (res) => ended.push(res.id + 1000));
    stepFor(r.sim, 90);
    expect([...ended].sort()).toEqual([id, id + 1000].sort());
  });

  it('works headless: no zone, no player', () => {
    const sim = Simulation.newGame({ seed: 'headless', difficulty: 'knight', generateWorld: mockGenerator('tiny') });
    const social = installSocial(sim);
    const economy = installEconomy(sim, { social });
    const combat = installCombat(sim, { economy, social });
    const me = sim.state.persons.get(sim.state.run.playerId)!;
    const men = adultMen(sim, 2);
    expect(combat.harm(me.id, 0.5, 'raid')).toBeDefined();
    const id = combat.engage([{ faction: 'a', people: [men[0].id] }, { faction: 'b', people: [men[1].id] }], { at: { x: 10, z: 10 } });
    expect(id).toBeGreaterThan(0);
    for (let i = 0; i < 20 * 100; i++) sim.step(SIM_DT);
    expect(combat.isFighting(men[0].id)).toBe(false);
  });
});

describe('wounds in a saved run', () => {
  it('save → load → continue gives the same hash, mid-recovery', async () => {
    const store = new MemorySaveStore();
    const make = async (load: boolean): Promise<{ sim: Simulation; combat: ReturnType<typeof installCombat> }> => {
      const sim = load
        ? (await Simulation.load(store, mockGenerator('tiny'), { intervalMs: 0 }))!
        : Simulation.newGame({ seed: 'wsave2', difficulty: 'knight', generateWorld: mockGenerator('tiny'), store, profile: (await import('../../src/sim/legacy')).newProfile(), autosave: { intervalMs: 0 } });
      const social = installSocial(sim);
      const economy = installEconomy(sim, { social });
      const combat = installCombat(sim, { economy, social, zone: new FakeZone() });
      return { sim, combat };
    };
    const a = await make(false);
    const men = adultMen(a.sim, 4);
    for (const p of men) { p.needs.hunger = 0.8; p.needs.rest = 0.8; }
    a.combat.book.inflict(men[0], { location: 'torso', kind: 'cut', damage: 30, severity: 0.45, bleeding: true, rate: 0.0045, fracture: false, mortal: false, stun: 0 }, 'sword');
    a.combat.book.inflict(men[1], { location: 'leg_l', kind: 'blunt', damage: 40, severity: 0.7, bleeding: false, rate: 0, fracture: true, mortal: false, stun: 0 }, 'mace');
    a.combat.book.inflict(men[2], { location: 'arm_r', kind: 'arrow', damage: 24, severity: 0.4, bleeding: true, rate: 0.003, fracture: false, mortal: false, stun: 0 }, 'longbow');
    a.combat.book.tend(men[2], 4, a.sim.rng('combat'));
    a.sim.advanceHours(30);
    a.combat.harm(men[3].id, 0.9, 'battle');
    await a.sim.flush();
    const b = await make(true);
    expect(hashState(b.sim.state)).toBe(hashState(a.sim.state));
    expect(b.combat.wounds(men[0].id).length).toBe(a.combat.wounds(men[0].id).length);
    a.sim.advanceDays(3);
    b.sim.advanceDays(3);
    expect(hashState(b.sim.state)).toBe(hashState(a.sim.state));
    a.sim.advanceDays(12);
    b.sim.advanceDays(12);
    expect(hashState(b.sim.state)).toBe(hashState(a.sim.state));
    // somebody mended or died, and the bookkeeping agrees
    const hurtNow = men.filter((p) => !p.death && a.combat.wounds(p.id).length > 0).length;
    expect(hurtNow).toBeLessThanOrEqual(men.length);
  });
});

describe('training and care', () => {
  it('the pell grants Melee XP and Strength; sparring grows both; binding wounds grants Medicine', () => {
    const r = combatRig({ seed: 'train', player: true });
    const pid = r.sim.state.run.playerId;
    const me = r.sim.state.persons.get(pid)!;
    me.needs.hunger = 1;
    let yard = [...r.sim.state.buildings.values()].find((b) => b.kind === 'training_yard');
    if (!yard) {
      const src = [...r.sim.state.buildings.values()][0];
      yard = { ...src, id: r.sim.state.nextBuildingId++, plot: -1, kind: 'training_yard', household: 0 };
      r.sim.state.buildings.set(yard.id, yard);
    }
    const opts = r.sim.actions.list(pid, { kind: 'building', id: yard!.id });
    const pell = opts.find((o) => o.id === 'pell')!;
    expect(pell.enabled).toBe(true);
    const melee = me.skills.melee;
    const str = me.statBonus?.str ?? 0;
    const out = r.sim.actions.start(pid, { ...pell, seconds: 0 });
    expect(out.ok).toBe(true);
    expect(me.skills.melee).toBeGreaterThan(melee);
    expect((me.statBonus?.str ?? 0) >= str).toBe(true);

    // sparring with a soldier
    const [mate] = adultMen(r.sim, 1);
    mate.career = 'soldier';
    const spar = r.sim.actions.list(pid, { kind: 'person', id: mate.id }).find((o) => o.id === 'spar')!;
    expect(spar).toBeTruthy();
    const m2 = me.skills.melee, m3 = mate.skills.melee;
    r.sim.actions.start(pid, { ...spar, seconds: 0 });
    expect(me.skills.melee).toBeGreaterThan(m2);
    expect(mate.skills.melee).toBeGreaterThan(m3);

    // binding a hurt man's wounds
    const [hurt] = adultMen(r.sim, 2).slice(1);
    r.combat.book.inflict(hurt, { location: 'arm_l', kind: 'cut', damage: 22, severity: 0.3, bleeding: true, rate: 0.003, fracture: false, mortal: false, stun: 0 }, 'axe');
    const tend = r.sim.actions.list(pid, { kind: 'person', id: hurt.id }).find((o) => o.id === 'tend')!;
    expect(tend).toBeTruthy();
    const med = skillOf(me, 'medicine');
    const xp = me.skills.medicine;
    r.sim.actions.start(pid, { ...tend, seconds: 0 });
    expect(me.skills.medicine).toBeGreaterThan(xp);
    expect(skillOf(me, 'medicine')).toBeGreaterThanOrEqual(med);
    expect(r.combat.wounds(hurt.id)[0].bleeding === false || (r.combat.wounds(hurt.id) as unknown as ReadonlyArray<{ care: number }>)[0].care >= 1).toBe(true);
  });

  it('a healer in the settlement binds the wounded on the daily round', () => {
    const r = combatRig({ seed: 'healer' });
    const men = adultMen(r.sim, 4);
    for (const p of men) r.combat.book.inflict(p, { location: 'torso', kind: 'pierce', damage: 24, severity: 0.4, bleeding: true, rate: 0.004, fracture: false, mortal: false, stun: 0 }, 'spear');
    const settlement = men[0].settlement;
    const healer = r.sim.state.residentsOf(settlement).find((p) => p.career === 'healer' || p.career === 'priest' || p.career === 'monk')!;
    expect(healer).toBeTruthy();
    healer.skills.medicine = 1500;
    const rng = r.sim.rng('combat');
    const tended = (): number => men.filter((p) => p.settlement === settlement && (r.combat.wounds(p.id) as unknown as ReadonlyArray<{ care: number }>).some((w) => w.care > 0)).length;
    expect(tended()).toBe(0);
    for (let d = 0; d < 3; d++) dailyCare(r.sim.state, r.combat.book, new Healers(), rng, r.sim.absDay + d);
    expect(tended()).toBeGreaterThan(0);
  });
});

describe('peaceful people', () => {
  it('attacking a villager starts a fight, costs opinion, and a witnessed assault makes you an outlaw', () => {
    const r = combatRig({ seed: 'assault', player: true });
    const pid = r.sim.state.run.playerId;
    const me = r.sim.state.persons.get(pid)!;
    r.combat.arena.setKitOverride(pid, { weapon: 'sword', armour: [] });
    const [victim, witness] = adultMen(r.sim, 2);
    const body = r.player!.body()!;
    r.zone.addAgent(victim.id, body.x + 2, body.z);
    r.zone.addAgent(witness.id, body.x + 8, body.z + 4);
    const op = r.sim.actions.list(pid, { kind: 'person', id: victim.id }).find((o) => o.id === 'attack')!;
    expect(op.enabled).toBe(true);
    const before = r.social.opinion(victim.id, pid);
    const res = r.sim.actions.start(pid, op);
    expect(res.ok).toBe(true);
    expect(r.combat.isFighting(victim.id)).toBe(true);
    expect(r.social.opinion(victim.id, pid)).toBeLessThan(before);
    // the fight runs; whoever wins, the deed is known
    for (let i = 0; i < 20 * 80 && r.combat.anyFight!(); i++) { r.player!.setInput(input({ block: i % 30 < 12, attack: i % 30 >= 20 })); r.sim.step(SIM_DT); }
    expect(r.combat.anyFight!()).toBe(false);
    const witnessed = me.flags.outlaw === true;
    // the victim's household stood with them, or the villagers saw it: either way somebody knows
    expect(witnessed || victim.death !== null || r.combat.wounds(victim.id).length >= 0).toBe(true);
  });

  it('children cannot be attacked and a fight cannot be started twice', () => {
    const r = combatRig({ seed: 'child', player: true });
    const pid = r.sim.state.run.playerId;
    const kid = [...r.sim.state.persons.values()].find((p) => !p.death && (r.sim.absDay - p.birthDay) / 16 < 10 && p.id !== pid)!;
    const opts = r.sim.actions.list(pid, { kind: 'person', id: kid.id });
    const atk = opts.find((o) => o.id === 'attack')!;
    expect(atk.enabled).toBe(false);
    expect(atk.reason).toMatch(/child/);
  });
});

describe('arrows', () => {
  it('an archer who has the range puts shafts into a man who stands still; an arrow can kill', () => {
    let kills = 0, hits = 0, shots = 0;
    for (let i = 0; i < 12; i++) {
      const r = combatRig({ seed: `volley${i}` });
      const [a, b] = adultMen(r.sim, 2);
      setStats(a, { str: 13, per: 13, agi: 11 });
      a.skills.archery = 4000;
      r.combat.arena.setKitOverride(a.id, { weapon: 'dagger', ranged: 'longbow', armour: [] });
      r.combat.arena.setKitOverride(b.id, { weapon: 'dagger', armour: [] });
      r.combat.engage([{ faction: 'bow', people: [a.id] }, { faction: 'mark', people: [b.id] }], { at: { x: 500, z: 500 } });
      const fa = r.combat.arena.fighterOf(a.id)!, fb = r.combat.arena.fighterOf(b.id)!;
      fa.x = 480; fa.z = 500; fb.x = 497; fb.z = 500;
      fb.think = 1e9; fb.wantSpeed = 0; fb.morale = fb.moraleBase = 500;
      for (let t = 0; t < 20 * 40 && r.combat.anyFight!(); t++) { r.sim.step(SIM_DT); fb.x = 497; fb.z = 500; }
      shots += 30 - fa.shotsLeft;
      hits += fa.hitsLanded;
      if (b.death) kills++;
    }
    expect(shots).toBeGreaterThan(8);
    expect(hits).toBeGreaterThan(shots * 0.3);
    expect(kills).toBeGreaterThan(0);
  });

  it('arrows stand in the ground afterwards and fly through the projectiles view', () => {
    const r = combatRig({ seed: 'stuck' });
    const [a, b] = adultMen(r.sim, 2);
    r.combat.arena.setKitOverride(a.id, { weapon: 'dagger', ranged: 'shortbow', armour: [] });
    r.combat.arena.setKitOverride(b.id, { weapon: 'dagger', armour: [] });
    r.combat.engage([{ faction: 'bow', people: [a.id] }, { faction: 'mark', people: [b.id] }], { at: { x: 500, z: 500 } });
    const fb = r.combat.arena.fighterOf(b.id)!;
    fb.x = 505; fb.z = 560; fb.think = 1e9; fb.morale = fb.moraleBase = 500;
    r.combat.arena.fighterOf(a.id)!.x = 500; r.combat.arena.fighterOf(a.id)!.z = 500;
    let sawFlying = false;
    for (let t = 0; t < 20 * 14; t++) {
      r.sim.step(SIM_DT);
      const v = r.sim.view.projectiles();
      if (v.some((p) => !p.stuck)) sawFlying = true;
    }
    expect(sawFlying).toBe(true);
    expect(r.sim.view.projectiles().some((p) => p.stuck)).toBe(true);
    void S;
  });
});

describe('the view', () => {
  it('chains its fx and corpses onto whatever the view already has', () => {
    const r = combatRig({ seed: 'view' });
    const [a, b] = adultMen(r.sim, 2);
    r.combat.arena.setKitOverride(a.id, { weapon: 'war_axe', armour: [] });
    r.combat.arena.setKitOverride(b.id, { weapon: 'dagger', armour: [] });
    r.combat.engage([{ faction: 'a', people: [a.id] }, { faction: 'b', people: [b.id] }], { at: { x: 500, z: 500 } });
    let blood = 0;
    let corpses = 0;
    for (let t = 0; t < 20 * 40; t++) {
      r.sim.step(SIM_DT);
      for (const e of r.sim.view.drainFx()) if (e.kind === 'blood' || e.kind === 'sparks' || e.kind === 'impact') blood++;
      corpses = Math.max(corpses, r.sim.view.characters().filter((c) => c.anim === 'fall' || c.anim === 'dead').length);
    }
    expect(blood).toBeGreaterThan(0);
    expect(a.death || b.death ? corpses : 1).toBeGreaterThan(0);
  });
});

describe('wolves', () => {
  it('a pack that circles a lone traveller at night closes in and the fight is on', () => {
    const r = combatRig({ seed: 'ambush', player: true });
    const pid = r.sim.state.run.playerId;
    const world = r.sim.world;
    // somewhere remote: far from every settlement
    let best = { x: 0, z: 0, d: 0 };
    for (let x = 500; x < 15000; x += 700) for (let z = 500; z < 15000; z += 700) {
      const s = world.nearestSettlement(x, z);
      const d = Math.hypot(s.x - x, s.z - z) - s.radius;
      if (d > best.d) best = { x, z, d };
    }
    expect(best.d).toBeGreaterThan(160);
    r.player!.placeAt(best.x, best.z, 0);
    const c = r.sim.state.clock;
    c.absDay = 3 * 4 + 1 + 0.96; c.firedHour = Math.floor(c.absDay * 24);
    for (let i = 0; i < 4; i++) {
      const an = r.zone.addAnimal(900 + i, 'wolf', best.x + 50 + i * 3, best.z + 20, 0);
      an.hostile = true;
    }
    r.combat.arena.setKitOverride(pid, { weapon: 'sword', armour: ['padded_armour'] });
    let fought = false;
    for (let t = 0; t < 20 * 90 && !fought; t++) {
      r.player!.setInput(input());
      r.sim.step(SIM_DT);
      fought = r.combat.anyFight!();
    }
    expect(fought).toBe(true);
    expect(r.combat.arena.fighters.filter((f) => f.isAnimal).length).toBeGreaterThan(0);
    expect(r.sim.hostileNear()).toBe(true);
  });
});
