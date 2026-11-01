// v1 finishing pass: resumable system shards, the advancement keys that now bite, conquered seats, captives,
// battles saved mid-fight.
import { describe, expect, it } from 'vitest';
import { installCombat } from '../../src/combat';
import { installEconomy } from '../../src/sim/economy';
import { installMilitary, militaryContext } from '../../src/sim/military';
import { installSocial } from '../../src/sim/social';
import { MemorySaveStore } from '../../src/sim/save-memory';
import { Simulation } from '../../src/sim/sim';
import { unitKindOf } from '../../src/sim/military/forces';
import { takeCaptive } from '../../src/sim/military/harm';
import { transferTitle } from '../../src/sim/politics/titles';
import type { AdvancementApi } from '../../src/sim/wave3';
import { mkHousehold, mkPerson } from './builders';
import { mockGenerator, newSim, settle } from './helpers';
import { milSim } from './military/helpers';
import { holderOf, rig, titlesOfKind } from './politics/helpers';

describe('system shards', () => {
  it('a sharded system runs its shards in order, and a frame may stop between two of them', () => {
    const sim = newSim();
    let fakeNow = 0;
    sim.scheduler.clock = () => fakeNow;
    sim.hookBudgetMs = 4;
    const calls: string[] = [];
    sim.registerSystem({
      name: 'heavy', phase: 'hourly', order: 900, shards: 4,
      run: (_c, info, shard = 0) => { calls.push(`${info.hourIndex}:${shard}`); fakeNow += 3; },
    });
    const hours: number[] = [];
    sim.events.on('hourStarted', (h) => hours.push(h.hourIndex));
    let maxPerFrame = 0;
    for (let f = 0; f < 400; f++) {
      const before = calls.length;
      sim.step(0.05);
      maxPerFrame = Math.max(maxPerFrame, calls.length - before);
    }
    expect(maxPerFrame).toBeLessThanOrEqual(2);
    const expected = hours.flatMap((h) => [0, 1, 2, 3].map((k) => `${h}:${k}`));
    expect(calls.slice(0, expected.length)).toEqual(expected);
  });
});

describe('advancement keys', () => {
  it('truces and alliances are likelier for Houses that command the techniques', () => {
    const r = rig({ preset: 'small' });
    const [a, b] = r.pol.actors();
    const base = r.x.diplo.acceptChance(a, b, 'truce');
    const stub = { bonus: (_h: number, key: string) => (key === 'diplomacy.truce' ? 1 : 0), knows: () => false, houseHas: () => false } as AdvancementApi;
    r.sim.services.advancement = stub;
    const better = r.x.diplo.acceptChance(a, b, 'truce');
    expect(better).toBeGreaterThan(base);
  });

  it('a council of the realm calms a vassal (fewer rebellions): the key is read', () => {
    const r = rig({ preset: 'small' });
    const [a] = r.pol.actors();
    expect(r.x.core.techBonus(a, 'realm.council')).toBe(0);
    r.sim.services.advancement = { bonus: (_h: number, key: string) => (key === 'realm.council' ? 1 : 0), knows: () => false, houseHas: () => false } as AdvancementApi;
    expect(r.x.core.techBonus(a, 'realm.council')).toBe(1);
  });

  it('levy archers turn a share of the levy into bowmen', () => {
    const { sim } = milSim({ seed: 'levy-archers' });
    const M = militaryContext(sim);
    const hh = mkHousehold(sim);
    const men = Array.from({ length: 40 }, () => { const p = mkPerson(sim, { age: 25, career: 'farmer', tier: 1, household: hh.id }); p.skills.archery = 300; return p; });
    const count = (): number => men.filter((p) => unitKindOf(M, p, { levy: true, house: p.house }) === 'archer').length;
    const none = count();
    sim.services.advancement = { bonus: (_h: number, key: string) => (key === 'levy.archers' ? 0.5 : 0), knows: () => false, houseHas: () => false } as AdvancementApi;
    expect(count()).toBeGreaterThan(none);
  });
});

describe('conquered seats and captives', () => {
  it('a conquered manor gets a castellan of the winning House living at the seat', () => {
    const r = rig({ preset: 'small' });
    const manors = titlesOfKind(r.sim, 'manor');
    const t = manors[0];
    const seat = t.place;
    const old = holderOf(r.sim, t);
    // a winner from another House who lives elsewhere
    const other = r.pol.actors().find((h) => h !== old.house && r.x.core.headOf(h)!.settlement !== seat)!;
    const winner = r.x.core.headOf(other)!;
    const before = r.sim.state.residentList(seat).filter((p) => p.house === other).length;
    transferTitle(r.x.core, t, winner, 'test conquest', { rehome: true });
    const castellans = r.sim.state.residentList(seat).filter((p) => p.house === other && p.offices.some((o) => o.office === 'castellan'));
    expect(castellans.length).toBe(1);
    expect(castellans[0].sex).toBe('m');
    expect(r.sim.state.residentList(seat).filter((p) => p.house === other).length).toBeGreaterThan(before);
    expect(r.sim.state.households.get(castellans[0].household)?.settlement).toBe(seat);
    // a second change of hands to the same House does not pile up castellans
    transferTitle(r.x.core, t, old, 'back', { rehome: true });
    transferTitle(r.x.core, t, winner, 'again', { rehome: true });
    expect(r.sim.state.residentList(seat).filter((p) => p.house === other && p.offices.some((o) => o.office === 'castellan')).length).toBe(1);
  });

  it('a prisoner neither works nor travels, and is free again when the ransom is paid', () => {
    const { sim, eco } = milSim({ seed: 'captive-work' });
    const M = militaryContext(sim);
    const captor = mkPerson(sim, { age: 30, career: 'man_at_arms', tier: 2 });
    // a working morning of some ordinary day, and somebody who has work to go to then
    const mornings = Array.from({ length: 12 }, (_, i) => Math.floor(sim.absDay) + i + 0.35);
    const man = [...sim.state.persons.values()].find((p) => !p.death && p.sex === 'm' && p.rankTier <= 2 && mornings.some((d) => eco.workSpot(p.id, d) !== null) && p.id !== sim.state.run.playerId)!;
    expect(man).toBeTruthy();
    takeCaptive(M, man, captor.id, 'battle', man.settlement, 80);
    expect(man.flags.captive).toBe(true);
    for (const d of mornings) expect(eco.workSpot(man.id, d)).toBeNull();
    const opts = sim.actions.list(man.id, { kind: 'self' });
    expect(opts.filter((o) => (o.category === 'work' || o.category === 'trade' || o.category === 'travel') && o.enabled)).toHaveLength(0);
    sim.advanceDays(4);
    expect(man.flags.captive).toBeUndefined();
  });
});

describe('a battle saved in the middle of its detail fight', () => {
  it('is settled by the macro model after the load, and action time does not stay on', async () => {
    const store = new MemorySaveStore();
    const sim = newSim({ seed: 'load-battle', preset: 'small', store, autosave: { intervalMs: 0 } });
    const social0 = installSocial(sim);
    const eco0 = installEconomy(sim, { social: social0 });
    installMilitary(sim, { economy: eco0, social: social0 });
    const M = militaryContext(sim);
    M.data.battles.push({
      id: 99, a: 0, d: 0, war: 0, x: 0, z: 0, settlement: -1, siege: -1, fort: 0, fight: 7, detailA: [], detailD: [], clock: 100, result: '', playerArmy: 0,
    } as never);
    M.touch();
    sim.state.clock.actionTime = true;
    sim.state.dirty.meta = true;
    await settle();
    sim.requestSave('test');
    await sim.flush();

    const loaded = (await Simulation.load(store, mockGenerator('small')))!;
    const social = installSocial(loaded);
    const economy = installEconomy(loaded, { social });
    installMilitary(loaded, { economy, social });
    installCombat(loaded, { economy, social });
    const rec = militaryContext(loaded).data.battles.find((b) => b.id === 99)!;
    expect(rec).toBeTruthy();
    expect(rec.fight).toBe(0);
    expect(rec.clock).toBe(0);
    expect(loaded.state.clock.actionTime).toBe(false);
  });
});
