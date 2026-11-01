// What the world shows of the objectives: the beacon on the tracked step's target, home and work, a person or
// place to find, and the marks over the heads of the people who have something for the player.
import { describe, expect, it } from 'vitest';
import { fakeZone, objSim, playObjectives, playerOf, recOf, tracked } from './helpers';

function markers(o: ReturnType<typeof objSim>) {
  return o.sim.view.worldMarkers?.() ?? [];
}

describe('world markers', () => {
  it('the tracked step is the primary marker, home a secondary one', () => {
    const z = fakeZone();
    const o = objSim({ seed: 's1', zone: z.zone });
    z.agents.set(tracked(o)!.steps[0].target!.id, { x: 5000, z: 5000 }); // the head is out and about
    const ms = markers(o);
    const primary = ms.filter((m) => m.primary);
    expect(primary).toHaveLength(1);
    expect(primary[0].kind).toBe('objective');
    const step = tracked(o)!.steps.find((s) => !s.done)!;
    expect(primary[0].label).toBe(step.target!.label);
    expect(ms.find((m) => m.kind === 'home')).toBeTruthy();
    // ids are stable and distinct
    expect(new Set(ms.map((m) => m.id)).size).toBe(ms.length);
    // the same array is handed out each time: nothing is allocated per frame
    expect(markers(o)).toBe(ms);
  });

  it('follow the player through the tutorial: the beacon moves to each new target', () => {
    const o = objSim({ seed: 's1' });
    const seen: Array<[number, number]> = [];
    for (let i = 0; i < 3; i++) {
      const m = markers(o).find((x) => x.primary);
      expect(m, `stage ${i}`).toBeTruthy();
      seen.push([Math.round(m!.x), Math.round(m!.z)]);
      playObjectives(o, ['tutorial'], 1);
    }
    expect(new Set(seen.map((s) => s.join(','))).size).toBeGreaterThan(1);
  });

  it('a person target is followed live through the zone', () => {
    const z = fakeZone();
    const o = objSim({ seed: 's1', zone: z.zone });
    const step = tracked(o)!.steps.find((s) => !s.done)!;
    const head = step.target!.id;
    z.agents.set(head, { x: 100, z: 200 });
    let m = markers(o).find((x) => x.primary)!;
    expect([m.x, m.z]).toEqual([100, 200]);
    expect(m.y).toBeGreaterThan(1.5); // over the head
    z.agents.set(head, { x: 130, z: 210 });
    m = markers(o).find((x) => x.primary)!;
    expect([m.x, m.z]).toEqual([130, 210]);
    // out of the zone: where the schedule puts them
    z.agents.delete(head);
    m = markers(o).find((x) => x.primary)!;
    expect([m.x, m.z]).toEqual([123, 456]);
  });

  it('"Find" puts a marker on a person (live) or a place, and clears again', () => {
    const z = fakeZone();
    const o = objSim({ seed: 's1', zone: z.zone });
    const me = playerOf(o.sim);
    const friend = o.sim.state.residentsOf(me.settlement).find((p) => p.id !== me.id && !p.death)!;
    z.agents.set(friend.id, { x: 11, z: 22 });
    o.obj.trackPerson(friend.id);
    expect(o.obj.found?.().person).toBe(friend.id);
    let m = markers(o).find((x) => x.kind === 'person')!;
    expect([m.x, m.z, m.label]).toEqual([11, 22, friend.first]);
    z.agents.set(friend.id, { x: 15, z: 25 });
    m = markers(o).find((x) => x.kind === 'person')!;
    expect([m.x, m.z]).toEqual([15, 25]);
    o.obj.trackPerson(0);
    expect(markers(o).find((x) => x.kind === 'person')).toBeUndefined();

    const places = o.obj.places!();
    expect(places.length).toBeGreaterThan(2);
    expect(places[0].label).toBe('Your home');
    o.obj.trackPlace!(places[1]);
    const pm = markers(o).find((x) => x.kind === 'place')!;
    expect([pm.x, pm.z, pm.label]).toEqual([places[1].x, places[1].z, places[1].label]);
    o.obj.trackPlace!(null);
    expect(markers(o).find((x) => x.kind === 'place')).toBeUndefined();
  });

  it('does not repeat home when the tracked target is the home door', () => {
    const o = objSim({ seed: 's1' });
    playObjectives(o, ['tutorial'], 4); // up to the evening stage
    o.sim.state.clock.absDay = Math.floor(o.sim.absDay) + 0.83;
    o.sim.advanceHours(1);
    const night = tracked(o)!;
    expect(night.title).toBe('Home before dark');
    const ms = markers(o);
    expect(ms.filter((m) => m.kind === 'home')).toHaveLength(0);
    expect(ms.find((m) => m.primary)!.label).toBe('Your home');
  });
});

describe('quest givers', () => {
  it('are told to the zone: whoever the current step needs, and whoever asks something of the player', () => {
    const z = fakeZone();
    const o = objSim({ seed: 's1', zone: z.zone });
    const head = tracked(o)!.steps[0].target!.id;
    const last = z.givers[z.givers.length - 1];
    expect(last, 'the zone was told at the start').toBeTruthy();
    expect(last.ids).toContain(head);
    // a request makes its asker one
    const from = o.adv.happenings.requests().length === 0 ? o.adv.happenings.offerRequest('fetch') : 0;
    expect(from).toBeGreaterThan(0);
    const req = o.adv.happenings.requests()[0];
    o.obj.poll(true);
    const now = z.givers[z.givers.length - 1];
    expect(now.ids).toContain(req.from);
    // the zone is told again only when the set changes
    const calls = z.givers.length;
    o.obj.poll(true);
    o.obj.poll(true);
    expect(z.givers.length).toBe(calls);
    void recOf;
  });

  it('"Find" is passed to the zone as the tracked person, once per change, and cleared with 0', () => {
    const z = fakeZone();
    const o = objSim({ seed: 's1', zone: z.zone });
    const me = playerOf(o.sim);
    const friend = o.sim.state.residentsOf(me.settlement).find((p) => p.id !== me.id && !p.death)!;
    o.obj.trackPerson(friend.id);
    expect(z.tracked[z.tracked.length - 1]).toBe(friend.id);
    const n = z.tracked.length;
    o.obj.poll(true);
    o.obj.poll(true);
    expect(z.tracked.length).toBe(n);
    o.obj.trackPerson(0);
    expect(z.tracked[z.tracked.length - 1]).toBe(0);
  });

  it('are quietly skipped when the zone has no such hooks', () => {
    const z = fakeZone();
    delete (z.zone as unknown as { setQuestGivers?: unknown }).setQuestGivers;
    delete (z.zone as unknown as { setTrackedPerson?: unknown }).setTrackedPerson;
    const o = objSim({ seed: 's1', zone: z.zone });
    expect(() => { o.obj.poll(true); o.obj.trackPerson(1); playObjectives(o, ['tutorial'], 2); }).not.toThrow();
  });
});
