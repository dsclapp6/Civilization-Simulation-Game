// The objectives are saved with the run (state.ext['objectives']) and are deterministic: a saved and loaded game
// carries on exactly as the game that never stopped, and the same play gives the same state twice.
import { describe, expect, it } from 'vitest';
import { MemorySaveStore } from '../../../src/sim/save-memory';
import { hashState } from '../../../src/sim/serialize';
import { Simulation } from '../../../src/sim/sim';
import { mockGenerator } from '../helpers';
import { active, install, objSim, playObjectives, playerOf, runTo, wrapSim, type ObjSim } from './helpers';

const gen = mockGenerator('tiny');

/** The tutorial, a night, a morning's chores half done: a state with something in every part of the section. */
function livedIn(o: ObjSim): void {
  playObjectives(o, ['tutorial']);
  runTo(o, Math.floor(o.sim.absDay) + (o.sim.absDay % 1 > 0.2 ? 1 : 0), 6);
  const chores = active(o, 'chore');
  if (chores.length > 0) {
    // one chore begun, one left
    const rec = o.obj.obj.byId(chores[0].id)!;
    rec.steps[0].progress = Math.max(1, rec.steps[0].progress ?? 0);
  }
  o.adv.happenings.offerRequest('fetch');
  o.obj.poll(true);
}

function digest(o: ObjSim): unknown {
  return o.obj.list().map((x) => ({
    id: x.id, source: x.source, title: x.title, state: x.state, tracked: x.tracked, why: x.why, reward: x.reward, dueDay: x.dueDay,
    steps: x.steps.map((s) => [s.text, s.done, s.progress, s.goal, s.target?.label]),
  }));
}

describe('saving and loading', () => {
  it('installing the module adds only its own section', () => {
    const plain = objSim({ seed: 'obj-clean', install: false });
    const before = plain.sim.stateHash();
    expect(plain.sim.state.ext['objectives']).toBeUndefined();
    install(plain);
    expect(plain.sim.state.ext['objectives']).toBeDefined();
    expect(plain.sim.stateHash()).not.toBe(before);
    // and the section is small
    expect(JSON.stringify(plain.sim.state.ext['objectives']).length).toBeLessThan(12000);
  });

  it('round-trips: save → load → continue gives the same state as never saving', async () => {
    const store = new MemorySaveStore();
    const a = objSim({ seed: 'obj-rt', store, autosave: { intervalMs: 0 } });
    livedIn(a);
    const section = JSON.stringify(a.sim.state.ext['objectives']);
    expect(section.length).toBeGreaterThan(500);
    expect(section.length).toBeLessThan(20000);
    a.sim.state.markAllDirty();
    await a.sim.flush();

    const loaded = (await Simulation.load(store, gen))!;
    const b = wrapSim(loaded);
    expect(JSON.stringify(loaded.state.ext['objectives'])).toBe(section);
    expect(hashState(loaded.state)).toBe(hashState(a.sim.state));
    // what the HUD and the journal read is the same
    expect(digest(b)).toEqual(digest(a));
    expect(b.obj.tracked()?.id).toBe(a.obj.tracked()?.id);
    expect(b.obj.daySummary()).toEqual(a.obj.daySummary());
    expect(b.obj.suggestions(6)).toEqual(a.obj.suggestions(6));
    expect(b.sim.view.worldMarkers?.().map((m) => [m.kind, m.x, m.z, m.label])).toEqual(a.sim.view.worldMarkers?.().map((m) => [m.kind, m.x, m.z, m.label]));

    // carry on identically: the chores are done, days pass, new chores come, a night's sleep ends a day
    for (const x of [a, b]) {
      x.at.x = a.at.x; x.at.z = a.at.z;
      const p = playObjectives(x, ['chore']);
      expect(p.stuck, p.trace.join('\n')).toBeNull();
      runTo(x, Math.floor(x.sim.absDay) + 3, 6);
    }
    expect(hashState(b.sim.state)).toBe(hashState(a.sim.state));
    expect(digest(b)).toEqual(digest(a));
    expect(b.obj.daySummary()).toEqual(a.obj.daySummary());
  });

  it('is deterministic: the same play gives the same state, objectives included', () => {
    const run = (): { hash: string; titles: unknown } => {
      const o = objSim({ seed: 'obj-det' });
      playObjectives(o, ['tutorial']);
      runTo(o, Math.floor(o.sim.absDay) + 2, 6);
      playObjectives(o, ['chore']);
      runTo(o, Math.floor(o.sim.absDay) + 2, 6);
      return { hash: o.sim.stateHash(), titles: digest(o) };
    };
    const x = run();
    const y = run();
    expect(y.hash).toBe(x.hash);
    expect(y.titles).toEqual(x.titles);
  });

  it('a character switch starts afresh: no tutorial, new goals, the old chores gone', () => {
    const o = objSim({ seed: 's1' });
    playObjectives(o, ['tutorial']);
    runTo(o, 2, 6);
    expect(active(o, 'chore').length).toBeGreaterThan(0);
    const me = playerOf(o.sim);
    const hh = o.sim.state.households.get(me.household)!;
    const sibling = hh.members.map((id) => o.sim.state.persons.get(id)!).find((p) => p.id !== me.id && !p.death && o.sim.eligibleSwitchTargets().includes(p.id));
    if (!sibling) return; // no one to take over in this household
    const done: string[] = [];
    o.sim.events.on('objective', (e) => done.push(e.phase));
    expect(o.sim.switchTo(sibling.id)).toBe(true);
    expect(o.obj.obj.save.person).toBe(sibling.id);
    expect(active(o, 'tutorial')).toHaveLength(0);
    expect(o.obj.obj.save.tut.done).toBe(true);
    // the summaries of the earlier life stay, the objectives are the new character's
    expect(o.obj.daySummary()).toBeTruthy();
    expect(o.obj.list().every((x) => x.state !== 'active' || x.source !== 'chore' || x.id > 0)).toBe(true);
  });
});
