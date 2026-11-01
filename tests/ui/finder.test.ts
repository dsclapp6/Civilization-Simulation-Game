// "Find" and "Show me": with the objectives module's own markers when it has them, with a pin of the UI's when not,
// and the clearing of either on arrival. Pure logic over a small fake of the services.
import { describe, expect, it } from 'vitest';
import type { ObjectiveTarget, ObjectivesApi } from '../../src/sim/objectives/types';
import { PinStore } from '../../src/ui/core/pins';
import { arrivedAt, findState, isFound, showPerson, showPlace, stopFinding, targetOf } from '../../src/ui/core/finder';
import type { GameServices } from '../../src/ui/types';

/** The members every objectives module has. */
function bare(): ObjectivesApi {
  return { list: () => [], tracked: () => null, track: () => {}, suggestions: () => [], daySummary: () => null, trackPerson: () => {} };
}

/** A module with the additive members, remembering what it was asked. */
function full(): ObjectivesApi & { log: string[]; place: ObjectiveTarget | null; person: number } {
  const m = {
    ...bare(),
    log: [] as string[],
    place: null as ObjectiveTarget | null,
    person: 0,
    trackPerson(id: number) { m.person = id; m.log.push(`person ${id}`); },
    trackPlace(t: ObjectiveTarget | null) { m.place = t ? { ...t } : null; m.log.push(`place ${t ? t.label : 'none'}`); },
    found: () => ({ person: m.person, place: m.place }),
  };
  return m;
}

function services(objectives: ObjectivesApi | undefined, agents: Record<number, { x: number; z: number }> = {}): GameServices {
  return {
    objectives,
    zone: { agent: (id: number) => agents[id] ?? null },
    sim: { state: { persons: new Map([[7, { first: 'Wat' }]]) } },
  } as unknown as GameServices;
}

describe('Show me on a place', () => {
  it('hands a place to the module when it can mark one, and leaves the pin alone', () => {
    const api = full();
    const pins = new PinStore();
    pins.set({ x: 1, z: 1, label: 'old' });
    expect(showPlace(services(api), pins, { x: 10, z: 20, label: 'The well', kind: 'building', id: 33 })).toBe(true);
    expect(api.place).toEqual({ kind: 'building', id: 33, x: 10, z: 20, label: 'The well' });
    expect(pins.get()).toBeNull();
  });

  it('pins it on the compass itself when the module has no such member', () => {
    const pins = new PinStore();
    expect(showPlace(services(bare()), pins, { x: 10, z: 20, label: 'The well' })).toBe(false);
    expect(pins.get()).toMatchObject({ x: 10, z: 20, label: 'The well' });
    expect(showPlace(null, pins, { x: 3, z: 4, label: 'Here' })).toBe(false);
    expect(pins.get()?.label).toBe('Here');
  });

  it('calls a bare spot a place with no id', () => {
    expect(targetOf({ x: 1, z: 2, label: 'There' })).toEqual({ kind: 'place', id: -1, x: 1, z: 2, label: 'There' });
  });
});

describe('Find on a person', () => {
  it('asks the module to follow them, and drops any pin', () => {
    const api = full();
    const pins = new PinStore();
    pins.set({ x: 1, z: 1, label: 'old' });
    showPerson(services(api), pins, 7);
    expect(api.person).toBe(7);
    expect(pins.get()).toBeNull();
  });
});

describe('What is being found', () => {
  it('reads the module when it knows, else the pin', () => {
    const api = full();
    const pins = new PinStore();
    expect(findState(services(api), pins)).toEqual({ person: 0, place: null });
    api.trackPlace!({ kind: 'strip', id: 5, x: 40, z: 50, label: 'Your family’s strip 1' });
    api.trackPerson(7);
    expect(findState(services(api), pins)).toEqual({ person: 7, place: { x: 40, z: 50, label: 'Your family’s strip 1', kind: 'strip', id: 5 } });
    pins.set({ x: 9, z: 9, label: 'Pinned' });
    expect(findState(services(bare()), pins)).toEqual({ person: 0, place: { x: 9, z: 9, label: 'Pinned' } });
  });

  it('knows a row is the one being found by what it is, or by where it is', () => {
    const state = { person: 0, place: { x: 40, z: 50, label: 'x', kind: 'building' as const, id: 5 } };
    expect(isFound(state, { x: 0, z: 0, kind: 'building', id: 5 })).toBe(true);
    expect(isFound(state, { x: 40, z: 50, kind: 'building', id: 6 })).toBe(false);
    expect(isFound(state, { x: 41, z: 51 })).toBe(true);
    expect(isFound(state, { x: 90, z: 51 })).toBe(false);
    expect(isFound({ person: 0, place: null }, { x: 0, z: 0 })).toBe(false);
  });

  it('stops finding: the module is told only what there is to clear', () => {
    const api = full();
    const pins = new PinStore();
    pins.set({ x: 1, z: 1, label: 'old' });
    stopFinding(services(api), pins);
    expect(api.log).toEqual(['place none']);
    expect(pins.get()).toBeNull();
    api.trackPerson(7);
    api.log.length = 0;
    stopFinding(services(api), pins);
    expect(api.log).toEqual(['place none', 'person 0']);
    expect(api.person).toBe(0);
  });
});

describe('Arriving', () => {
  it('clears a found place when the body gets near it, and says so once', () => {
    const api = full();
    const pins = new PinStore();
    const g = services(api);
    api.trackPlace!({ kind: 'building', id: 1, x: 100, z: 100, label: 'The well' });
    expect(arrivedAt(g, pins, 60, 100)).toBeNull();
    expect(api.place).not.toBeNull();
    expect(arrivedAt(g, pins, 95, 100)).toBe('You have arrived.');
    expect(api.place).toBeNull();
    expect(arrivedAt(g, pins, 95, 100)).toBeNull();
  });

  it('clears a found person when you walk up to them', () => {
    const api = full();
    const pins = new PinStore();
    const g = services(api, { 7: { x: 200, z: 200 } });
    api.trackPerson(7);
    expect(arrivedAt(g, pins, 100, 100)).toBeNull();
    expect(arrivedAt(g, pins, 197, 200)).toBe('You have found Wat.');
    expect(api.person).toBe(0);
  });

  it('clears the UI’s own pin as before', () => {
    const pins = new PinStore();
    pins.set({ x: 10, z: 10, label: 'Pinned' });
    const g = services(bare());
    expect(arrivedAt(g, pins, 80, 10)).toBeNull();
    expect(arrivedAt(g, pins, 12, 10)).toBe('You have arrived.');
    expect(pins.get()).toBeNull();
  });
});
