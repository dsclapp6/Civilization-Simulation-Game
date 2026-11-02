// Save -> load -> continue gives the same state hash with the AI rulers at work: what a ruler must remember (what failed and until
// when, what he has told the neighbours, when he last did a thing, the works he started, the research he began) lives in
// `state.ext['realm.ai']`, and everything else he decides from the world.
import { describe, expect, it } from 'vitest';
import { MemorySaveStore } from '../../../src/sim/save-memory';
import { Simulation } from '../../../src/sim/sim';
import { mockGenerator, newSim, noPlayer, settle } from '../helpers';
import { aiWorld, equipAi } from './aiworld';

const gen = mockGenerator('small');

describe('the AI rulers\' section', () => {
  it('round-trips: same hash after a load, same future for weeks, same table', async () => {
    const store = new MemorySaveStore();
    const sim = newSim({ seed: 'ai-save', preset: 'small', store, autosave: { intervalMs: 0 } });
    noPlayer(sim);
    const w = equipAi(sim);
    sim.advanceDays(22);
    expect(sim.state.ext['realm.ai']).toBeTruthy();
    expect(w.ai.table().reduce((n, y) => n + y.placed, 0)).toBeGreaterThan(3);
    expect(w.ai.data.s.length).toBeGreaterThan(0);
    await settle();
    sim.requestSave('test');
    await sim.flush();

    const loaded = (await Simulation.load(store, gen))!;
    expect(loaded).not.toBeNull();
    const w2 = equipAi(loaded);
    expect(loaded.stateHash()).toBe(sim.stateHash());
    expect(JSON.stringify(w2.ai.data)).toBe(JSON.stringify(w.ai.data));
    expect(JSON.stringify(w2.ai.table())).toBe(JSON.stringify(w.ai.table()));
    // the two go on together over weeks of rounds (works, research, arms, orders, outposts)
    for (let d = 0; d < 28; d++) {
      sim.advanceDays(1);
      loaded.advanceDays(1);
      expect(loaded.stateHash(), `day ${d}`).toBe(sim.stateHash());
    }
    expect(JSON.stringify(w2.ai.data)).toBe(JSON.stringify(w.ai.data));
    expect(JSON.stringify(w2.ai.table())).toBe(JSON.stringify(w.ai.table()));
  });

  it('is deterministic: the same seed twice gives the same hash and the same table', () => {
    const run = (): { hash: string; table: string } => {
      const w = aiWorld({ seed: 'ai-det' });
      w.sim.advanceDays(30);
      return { hash: w.sim.stateHash(), table: JSON.stringify(w.ai.table()) };
    };
    const a = run(), b = run();
    expect(a.hash).toBe(b.hash);
    expect(a.table).toBe(b.table);
  });

  it('starts empty on a save made before the rulers existed, and on a section it does not know', () => {
    const sim = newSim({ seed: 'ai-old', preset: 'small' });
    noPlayer(sim);
    expect(sim.state.ext['realm.ai']).toBeUndefined();
    const w = equipAi(sim);
    expect(w.ai.data).toMatchObject({ v: 1, h: {}, y: {}, s: [], r: [] });

    const odd = newSim({ seed: 'ai-odd', preset: 'small' });
    noPlayer(odd);
    odd.state.ext['realm.ai'] = { v: 7, whatever: true };
    const o = equipAi(odd);
    expect(o.ai.data).toMatchObject({ v: 1, h: {}, y: {}, s: [], r: [] });
    odd.advanceDays(6);
    expect(odd.state.ext['realm.ai']).toBe(o.ai.data);
  });

  it('keeps a small section: the books of the rulers do not grow without bound', () => {
    const w = aiWorld({ seed: 'ai-small' });
    w.sim.advanceDays(16 * 6);
    const json = JSON.stringify(w.sim.state.ext['realm.ai']);
    expect(json.length).toBeLessThan(60_000);
    expect(w.ai.data.s.length).toBeLessThanOrEqual(400);
    expect(w.ai.table().length).toBeLessThanOrEqual(40);
    for (const rec of Object.values(w.ai.data.h)) {
      expect(Object.keys(rec.no).length).toBeLessThanOrEqual(80);
      expect(Object.keys(rec.said).length).toBeLessThanOrEqual(60);
    }
  });

  it('leaves the world alone when switched off: nothing is staked out, ordered or recruited', () => {
    const off = aiWorld({ seed: 'ai-off' });
    off.ai.enabled = false;
    off.sim.advanceDays(10);
    const left = aiWorld({ seed: 'ai-off', noAi: true });
    left.sim.advanceDays(10);
    expect(off.cons.sites().length).toBe(0);
    expect(left.cons.sites().length).toBe(0);
    for (const u of off.ai.units()) {
      expect(off.realm.tradeOrders(u.ruler)).toEqual(left.realm.tradeOrders(u.ruler));
      expect(off.realm.troops!(u.ruler)).toEqual(left.realm.troops!(u.ruler));
    }
    expect(off.realm.projects().length).toBe(0);
  });
});
