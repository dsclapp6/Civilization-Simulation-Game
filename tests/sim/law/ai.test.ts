// The AI's trespassers (docs/CIV.md §4): the lord's watch takes poachers, outlaws and enemy scouts off-screen, once a day, and holds them
// the same way as the player — in the gaol or the lock-up, with fines, sentences and families that pay. Cheap, capped, deterministic.
import { describe, expect, it } from 'vitest';
import { LAW } from '../../../src/sim/law/config';
import { mkHouse, mkPerson } from '../builders';
import { lawContext, lawRig } from './helpers';

describe('the AI\'s poachers, bandits and scouts', () => {
  it('poachers are caught by the watch of a place with game, a few a day at most, and are held in its gaol', () => {
    const r = lawRig({ gaol: true, forest: true });
    r.rig(0.01);
    const held = (): number => r.law.prisoners().length;
    expect(held()).toBe(0);
    let before = 0;
    for (let d = 0; d < 6; d++) {
      r.sim.advanceDays(1);
      expect(held() - before).toBeLessThanOrEqual(2);
      before = held();
    }
    const list = r.law.prisoners();
    expect(list.length).toBeGreaterThan(0);
    for (const c of list) {
      const p = r.sim.state.persons.get(c.person)!;
      expect(p.flags.captive).toBe(true);
      expect(c.person).not.toBe(r.stranger.id);
      expect(['poaching', 'crime', 'war']).toContain(c.kind);
      expect(c.since).toBeLessThanOrEqual(r.sim.absDay);
      // held in a building of a lord: the gaol of the village, or the lock-up of the place
      expect(c.text).toMatch(/Held in|Held prisoner/);
    }
    // each is reachable through the API as the card reads it
    const first = list[0];
    expect(r.law.captivity(first.person)?.text).toBe(first.text);
    expect(r.law.prisoners(first.settlement).some((c) => c.person === first.person)).toBe(true);
  });

  it('the cases are capped (never more than the module holds) and the prisoners get out: fines paid, sentences served, patience out', () => {
    const r = lawRig({ gaol: true, forest: true });
    r.rig(0.01);
    const L = lawContext(r.sim).law;
    let top = 0;
    for (let d = 0; d < 80; d++) {
      r.sim.advanceDays(1);
      top = Math.max(top, L.store.data.captives.length);
      expect(L.store.data.captives.length).toBeLessThanOrEqual(LAW.maxHeld);
    }
    expect(L.store.data.stats.taken).toBeGreaterThan(3);
    expect(L.store.data.stats.released).toBeGreaterThan(2);
    // nobody is left flagged captive without a record, and nobody with a record is free
    for (const p of r.sim.state.persons.values()) {
      if (p.death) continue;
      const rec = L.store.captiveOf(p.id);
      if (rec) expect(p.flags.captive).toBe(true);
      else expect(p.flags.captive).toBeFalsy();
    }
    expect(top).toBeGreaterThan(0);
  }, 60000);

  it('an outlaw on the lord\'s roads is taken by the watch (and hanged only under the rules of the hangman)', () => {
    const r = lawRig({ gaol: true });
    r.rig(0.01);
    const L = lawContext(r.sim).law;
    const outlaw = mkPerson(r.sim, { settlement: r.village.id, house: mkHouse(r.sim, 'Outlaws').id, tier: 1, estate: 'unfree', career: 'labourer' });
    outlaw.flags.outlaw = true;
    r.sim.state.touch(outlaw);
    let rec = L.store.captiveOf(outlaw.id);
    for (let d = 0; d < 40 && !rec; d++) {
      r.sim.advanceDays(1);
      rec = L.store.captiveOf(outlaw.id);
    }
    expect(rec).toBeDefined();
    expect(rec!.kind).toBe('crime');
    expect(rec!.settlement).toBe(r.village.id);
    expect(rec!.cause).toMatch(/robbery/);
    expect(outlaw.flags.captive).toBe(true);
    // a man who killed the lord's man may be warned of the rope; one who robbed on the roads is not
    expect(rec!.danger).toBe(rec!.bloodshed && r.lord.rep.cruelty >= LAW.cruelLord);
  });

  it('an enemy scout on hostile lands is taken, at war only, and held for ransom', () => {
    const r = lawRig({ gaol: true });
    r.rig(0.01);
    const L = lawContext(r.sim).law;
    const enemy = mkHouse(r.sim, 'Enemy');
    const knight = mkPerson(r.sim, { settlement: r.village.id, house: enemy.id, tier: 4, estate: 'noble', career: 'knight', age: 30, sex: 'm' });
    // at peace nobody is taken for scouting
    r.sim.advanceDays(30);
    expect(L.store.captiveOf(knight.id)).toBeUndefined();
    r.pol.war([r.lordHouse], [enemy.id]);
    let rec = L.store.captiveOf(knight.id);
    for (let d = 0; d < 60 && !rec; d++) {
      r.sim.advanceDays(1);
      rec = L.store.captiveOf(knight.id);
    }
    expect(rec).toBeDefined();
    expect(rec!.kind).toBe('war');
    expect(rec!.ransom).toBeGreaterThan(0);
    expect(r.law.captivity(knight.id)?.war).toBe(true);
    expect(r.law.captivity(knight.id)?.ransom).toBeGreaterThan(0);
  }, 60000);

  it('does nothing without a lord on the land (no territory module: no cases) and costs a few lookups a day', () => {
    const r = lawRig({ gaol: true });
    r.rig(0.01);
    const L = lawContext(r.sim).law;
    delete r.sim.services.territory;
    r.sim.advanceDays(10);
    expect(L.store.data.captives.length).toBe(0);
  });

  it('is deterministic: the same seed makes the same prisoners in the same order', () => {
    const run = (): string => {
      const r = lawRig({ gaol: true, forest: true, seed: 'law-det' });
      r.sim.advanceDays(40);
      const L = lawContext(r.sim).law;
      return JSON.stringify(L.store.data) + r.sim.stateHash();
    };
    const a = run();
    expect(a).toBe(run());
    expect(a.length).toBeGreaterThan(100);
  }, 120000);
});
