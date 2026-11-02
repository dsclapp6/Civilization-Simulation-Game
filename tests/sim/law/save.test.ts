// Save → load → continue gives the same state hash (the prisoners, the wanted list and the warnings live in `state.ext['law']`); a
// game saved while a patrol is out is loaded with the case open and the watch finds the trespasser again; a game saved while the
// player is a prisoner is loaded with him in the cell, bound.
import { describe, expect, it } from 'vitest';
import { MemorySaveStore } from '../../../src/sim/save-memory';
import { settle } from '../helpers';
import { lawContext, lawRig, reloadLawRig, type LawRig } from './helpers';

async function save(r: LawRig): Promise<void> {
  await settle();
  r.sim.requestSave('test');
  await r.sim.flush();
}

describe('law save and load', () => {
  it('round-trips with prisoners (the player one of them), a wanted list and a warning: same hash, same future', async () => {
    const store = new MemorySaveStore();
    const o = { gaol: true, forest: true, seed: 'law-save' };
    const a = lawRig({ ...o, store });
    a.sim.advanceDays(30);
    const La = lawContext(a.sim).law;
    expect(La.store.data.stats.taken).toBeGreaterThan(0);
    // the player is taken in the lord's closes
    const captor = a.lord.id;
    expect(a.law.seize(a.stranger.id, captor, 'trespass', a.village.id, 'trespass in the lord\'s closes')).toBe(true);
    La.store.makeWanted(a.stranger.id, a.village.id, a.sim.absDay + 8);
    La.store.noteOffence(a.stranger.id, a.village.id, a.sim.absDay);
    a.sim.advanceDays(2);
    const mine = a.law.captivity(a.stranger.id);
    expect(mine).not.toBeNull();
    expect(a.player.bound?.kind).toBe('held');
    await save(a);

    const b = await reloadLawRig(store, o);
    expect(b.sim.stateHash()).toBe(a.sim.stateHash());
    const Lb = lawContext(b.sim).law;
    expect(JSON.stringify(Lb.store.data)).toBe(JSON.stringify(La.store.data));
    // the player is in the cell, bound, with the same card
    expect(b.law.captivity(b.stranger.id)?.text).toBe(a.law.captivity(a.stranger.id)?.text);
    expect(b.player.bound?.kind).toBe('held');
    expect(b.law.wanted?.(b.stranger.id).length).toBe(1);
    // and the two runs stay together, whatever the days bring (sentences, fines, the family, new cases)
    for (let d = 0; d < 25; d++) {
      a.sim.advanceDays(1);
      b.sim.advanceDays(1);
      expect(b.sim.stateHash(), `day ${d}`).toBe(a.sim.stateHash());
    }
    expect(JSON.stringify(Lb.store.data)).toBe(JSON.stringify(La.store.data));
  }, 120000);

  it('a prisoner who was being led when the game was saved is in the cell when it is loaded (the walk is not saved)', async () => {
    const store = new MemorySaveStore();
    const a = lawRig({ gaol: true, store, seed: 'law-led' });
    const La = lawContext(a.sim).law;
    a.law.report(a.stranger.id, a.court.x, a.court.z);
    // the player yields: bound and led behind the leader
    const p = a.law.patrolFor(a.stranger.id)!;
    for (const id of [p.leader, ...p.men]) {
      const g = a.zone.agent(id) ?? a.zone.addAgent(id, a.court.x + 2, a.court.z);
      g.x = a.court.x + 2; g.z = a.court.z + 1;
    }
    a.run(0.3);
    expect(a.law.answerPatrol(a.stranger.id, 'yield').ok).toBe(true);
    a.run(0.2);
    const led = La.store.captiveOf(a.stranger.id)!;
    expect(led.led).toBe(true);
    expect(a.player.bound?.kind).toBe('led');
    await save(a);

    const b = await reloadLawRig(store, { gaol: true });
    const rec = lawContext(b.sim).law.store.captiveOf(b.stranger.id)!;
    expect(rec.led).toBe(false);
    expect(rec.building).toBeGreaterThanOrEqual(0);
    expect(b.player.bound?.kind).toBe('held');
    expect(b.law.captivity(b.stranger.id)?.led).toBeFalsy();
    expect(b.law.patrolFor(b.stranger.id)).toBeNull();
  }, 60000);

  it('a game saved while a patrol is out is loaded with the player free to act: the patrol is not saved, the watch finds him again', async () => {
    const store = new MemorySaveStore();
    const a = lawRig({ store, seed: 'law-patrol' });
    expect(a.law.report(a.stranger.id, a.court.x, a.court.z)).toBe(true);
    expect(a.law.patrolFor(a.stranger.id)).not.toBeNull();
    await save(a);

    const b = await reloadLawRig(store, {});
    expect(b.law.patrolFor(b.stranger.id)).toBeNull();
    expect(b.player.bound).toBeNull();
    // he still stands on the lord's land; when someone of the village sees him, the patrol is sent again
    b.sim.state.clock.absDay = Math.floor(b.sim.state.clock.absDay) + 1.5;
    b.sim.state.clock.firedHour = Math.floor(b.sim.state.clock.absDay * 24);
    const villager = b.sim.state.residentList(b.village.id).find((p) => p.sex === 'm' && !p.death && b.law.captivity(p.id) === null && b.sim.absDay - p.birthDay > 16 * 20)!;
    b.zone.addAgent(villager.id, b.court.x + 25, b.court.z);
    b.rig(0.5);
    b.run(30);
    expect(b.law.patrolFor(b.stranger.id)).not.toBeNull();
  }, 60000);

  it('is deterministic: two runs of the same seed with a player held and AI cases give the same hash', () => {
    const run = (): string => {
      const r = lawRig({ gaol: true, forest: true, seed: 'law-det2' });
      r.law.seize(r.stranger.id, r.lord.id, 'poaching', r.village.id, "poaching the lord's deer");
      r.sim.advanceDays(30);
      return r.sim.stateHash();
    };
    expect(run()).toBe(run());
  }, 120000);
});
