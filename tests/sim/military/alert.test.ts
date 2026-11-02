// Alert levels, gates and breaches (docs/WAR.md): derived from armies, sieges, wars and the damage buildings carry.
import { describe, expect, it } from 'vitest';
import type { BuildingKind } from '../../../src/content/types';
import { militaryContext } from '../../../src/sim/military';
import { breachOf, gateOf } from '../../../src/sim/military/alert';
import type { Simulation } from '../../../src/sim/sim';
import type { BuildingState } from '../../../src/sim/state';
import { declareWar, fakePolitics, milSim } from './helpers';

function royals(sim: Simulation): number[] {
  return [...sim.state.houses.values()].filter((h) => h.kind === 'royal').map((h) => h.id);
}

/** Puts a finished fortification into a settlement. */
let nextId = 800000;
export function addFort(sim: Simulation, sid: number, kind: BuildingKind, x: number, z: number, rot = 0, over: Partial<BuildingState> = {}): BuildingState {
  const st = sim.state;
  const b: BuildingState = {
    id: nextId++, plot: -1, kind, level: 1, settlement: sid, construction: 1, damage: 0, onFire: false, owner: 0, household: 0,
    occupied: false, x, z, rot, culture: 'anglo', seed: 1, ...over,
  };
  st.buildings.set(b.id, b);
  let list = st.buildingsAt.get(sid);
  if (!list) { list = []; st.buildingsAt.set(sid, list); }
  list.push(b);
  st.touchBuilding(b);
  return b;
}

function setDayFraction(sim: Simulation, frac: number): void {
  sim.state.clock.absDay = Math.floor(sim.state.clock.absDay) + frac;
}

function castleOf(sim: Simulation, kingdomHouse: number) {
  const M = militaryContext(sim);
  return sim.world.settlements.find((s) => s.kind === 'castle' && M.realm.root(M.realm.lordHouse(s.id)) === kingdomHouse)!;
}

describe('breaches and gates (pure)', () => {
  it('a wall breaches from 0.3 damage and can be climbed through from 0.5', () => {
    expect(breachOf(0)).toBe(0);
    expect(breachOf(0.3)).toBe(0);
    expect(breachOf(0.5)).toBe(0.5);
    expect(breachOf(0.7)).toBe(1);
    expect(breachOf(1)).toBe(1);
  });
  it('gates: open in peace, shut at night under watch, shut from alarm, broken from 0.6 damage', () => {
    expect(gateOf(0, 'peace', true)).toBe('open');
    expect(gateOf(0, 'watch', false)).toBe('open');
    expect(gateOf(0, 'watch', true)).toBe('shut');
    expect(gateOf(0, 'alarm', false)).toBe('shut');
    expect(gateOf(0, 'assault', false)).toBe('shut');
    expect(gateOf(0.59, 'peace', false)).toBe('open');
    expect(gateOf(0.6, 'peace', false)).toBe('broken');
    expect(gateOf(0.9, 'alarm', true)).toBe('broken');
  });
});

describe('alertOf', () => {
  it('is peace in a quiet land and watch when the lord\'s House is at war', () => {
    const { sim, mil } = milSim({ seed: 'alert-a' });
    const pol = fakePolitics(sim);
    const [ka, kb] = royals(sim);
    const castle = castleOf(sim, kb);
    expect(mil.alertOf(castle.id)).toBe('peace');
    declareWar(pol, sim, [ka], [kb]);
    militaryContext(sim).realm.invalidateEnmity();
    expect(mil.alertOf(castle.id)).toBe('watch');
    // a place of the other realm is on watch too; a neutral land is not
    const other = sim.world.settlements.find((s) => militaryContext(sim).realm.root(militaryContext(sim).realm.lordHouse(s.id)) !== ka && militaryContext(sim).realm.root(militaryContext(sim).realm.lordHouse(s.id)) !== kb);
    if (other) expect(mil.alertOf(other.id)).toBe('peace');
  });

  it('a hostile army within 6 km puts a place on watch and within 2 km on alarm; a friendly one changes nothing', () => {
    const { sim, mil } = milSim({ seed: 'alert-b' });
    const pol = fakePolitics(sim);
    const [ka, kb] = royals(sim);
    const M = militaryContext(sim);
    const castle = castleOf(sim, kb);
    const w = declareWar(pol, sim, [ka], [kb]);
    M.realm.invalidateEnmity();
    for (const h of sim.state.houses.values()) { M.data.think[`r${h.id}`] = sim.absDay + 999; M.data.think[`d${h.id}`] = sim.absDay + 999; }
    const id = mil.raiseArmy(ka, 'war', { vassals: false, war: w.id });
    mil.order(id, { kind: 'hold' });
    sim.advanceDays(6);
    const A = M.army(id)!;
    A.x = castle.x + 4500; A.z = castle.z;
    M.touch();
    expect(mil.alertOf(castle.id)).toBe('watch');
    A.x = castle.x + 1500; M.touch();
    expect(mil.alertOf(castle.id)).toBe('alarm');
    A.x = castle.x + 7500; M.touch();
    // out of the 6 km ring but still at war: still on watch
    expect(mil.alertOf(castle.id)).toBe('watch');
    // an army of the lord's own House frightens no one
    const own = mil.raiseArmy(kb, 'war', { vassals: false });
    if (own) { const O = M.army(own)!; O.x = castle.x + 300; O.z = castle.z; M.touch(); mil.order(own, { kind: 'hold' }); }
    expect(['watch', 'peace']).toContain(mil.alertOf(castle.id));
  });

  it('a siege camp is alarm and a storm is assault', () => {
    const { sim, mil } = milSim({ seed: 'alert-c' });
    const pol = fakePolitics(sim);
    const [ka, kb] = royals(sim);
    const M = militaryContext(sim);
    const castle = castleOf(sim, kb);
    const w = declareWar(pol, sim, [ka], [kb]);
    M.realm.invalidateEnmity();
    for (const h of sim.state.houses.values()) { M.data.think[`r${h.id}`] = sim.absDay + 999; M.data.think[`d${h.id}`] = sim.absDay + 999; }
    M.data.wars[String(w.id)] = Math.floor(sim.absDay);
    const id = mil.raiseArmy(ka, 'war', { vassals: false, war: w.id });
    mil.order(id, { kind: 'hold' });
    sim.advanceDays(6);
    const A = M.army(id)!;
    A.x = castle.x - 300; A.z = castle.z; A.px = A.x; A.pz = A.z; A.supplies = A.men.length * 200; A.morale = 1;
    mil.order(id, { kind: 'siege', settlement: castle.id });
    sim.advanceDays(1);
    expect(mil.siegeAt(castle.id)).toBeTruthy();
    expect(['alarm', 'assault']).toContain(mil.alertOf(castle.id));
    // a storm is going on at the walls
    M.data.battles.push({
      id: 99, x: castle.x, z: castle.z, a: id, d: 0, settlement: castle.id, war: w.id, startedDay: sim.absDay, fight: 0,
      detailA: [], detailD: [], playerArmy: 0, clock: 100, result: '', fort: 1, siege: castle.id,
    });
    M.touch();
    expect(mil.alertOf(castle.id)).toBe('assault');
    M.data.battles.pop();
    M.touch();
    expect(mil.alertOf(castle.id)).not.toBe('assault');
  });

  it('answers the same until something changes, and again after a touch (the cache is only a cache)', () => {
    const { sim, mil } = milSim({ seed: 'alert-d' });
    const M = militaryContext(sim);
    const s = sim.world.settlements[0];
    const first = mil.alertOf(s.id);
    for (let i = 0; i < 50; i++) expect(mil.alertOf(s.id)).toBe(first);
    M.touch();
    expect(mil.alertOf(s.id)).toBe(first);
  });
});

describe('fortState and the forts view', () => {
  function stage(seed: string) {
    const ctx = milSim({ seed });
    const pol = fakePolitics(ctx.sim);
    const [ka, kb] = royals(ctx.sim);
    const M = militaryContext(ctx.sim);
    const castle = castleOf(ctx.sim, kb);
    const gate = addFort(ctx.sim, castle.id, 'gatehouse', castle.x, castle.z + 30);
    const wall = addFort(ctx.sim, castle.id, 'wall', castle.x + 12, castle.z + 30);
    const pal = addFort(ctx.sim, castle.id, 'palisade', castle.x + 20, castle.z + 30);
    const tower = addFort(ctx.sim, castle.id, 'tower', castle.x + 30, castle.z + 30);
    return { ...ctx, pol, ka, kb, M, castle, gate, wall, pal, tower };
  }

  it('in peace everything is open and whole: nothing is listed', () => {
    const t = stage('fort-a');
    setDayFraction(t.sim, 0.5);
    expect(t.mil.fortState(t.gate.id)).toBeNull();
    expect(t.mil.fortState(t.wall.id)).toBeNull();
    expect(t.sim.view.forts!().filter((f) => [t.gate.id, t.wall.id, t.pal.id, t.tower.id].includes(f.building))).toHaveLength(0);
  });

  it('under watch the gate is shut at night only; from alarm always; a battered gate is broken whatever the alert', () => {
    const t = stage('fort-b');
    declareWar(t.pol, t.sim, [t.ka], [t.kb]);
    t.M.realm.invalidateEnmity();
    for (const h of t.sim.state.houses.values()) { t.M.data.think[`r${h.id}`] = t.sim.absDay + 999; t.M.data.think[`d${h.id}`] = t.sim.absDay + 999; }
    setDayFraction(t.sim, 0.5);
    expect(t.mil.alertOf(t.castle.id)).toBe('watch');
    expect(t.mil.fortState(t.gate.id)).toBeNull();
    setDayFraction(t.sim, 0.02);
    expect(t.mil.fortState(t.gate.id)).toEqual({ building: t.gate.id, gate: 'shut', breach: 0 });
    // an army at the gates: shut by day too
    setDayFraction(t.sim, 0.5);
    const id = t.mil.raiseArmy(t.ka, 'war', { vassals: false });
    t.mil.order(id, { kind: 'hold' });
    t.sim.advanceDays(6);
    const A = t.M.army(id)!;
    A.x = t.castle.x + 1000; A.z = t.castle.z; t.M.touch();
    setDayFraction(t.sim, 0.5);
    expect(t.mil.alertOf(t.castle.id)).toBe('alarm');
    expect(t.mil.fortState(t.gate.id)?.gate).toBe('shut');
    t.gate.damage = 0.65; t.sim.state.touchBuilding(t.gate);
    expect(t.mil.fortState(t.gate.id)?.gate).toBe('broken');
  });

  it('walls and palisades show a breach from their damage; towers and unfinished works show none', () => {
    const t = stage('fort-c');
    t.wall.damage = 0.5; t.sim.state.touchBuilding(t.wall);
    t.pal.damage = 0.9; t.sim.state.touchBuilding(t.pal);
    t.tower.damage = 0.9; t.sim.state.touchBuilding(t.tower);
    expect(t.mil.fortState(t.wall.id)).toEqual({ building: t.wall.id, breach: 0.5 });
    expect(t.mil.fortState(t.pal.id)?.breach).toBe(1);
    expect(t.mil.fortState(t.tower.id)).toBeNull();
    const raw = addFort(t.sim, t.castle.id, 'wall', t.castle.x + 40, t.castle.z + 30, 0, { damage: 0.9, construction: 0.5 });
    expect(t.mil.fortState(raw.id)).toBeNull();
    const listed = t.sim.view.forts!().map((f) => f.building);
    expect(listed).toContain(t.wall.id);
    expect(listed).toContain(t.pal.id);
    expect(listed).not.toContain(raw.id);
  });

  it('the version moves only when the list changes', () => {
    const t = stage('fort-d');
    setDayFraction(t.sim, 0.5);
    const v0 = t.sim.view.fortsVersion!();
    expect(t.sim.view.fortsVersion!()).toBe(v0);
    t.sim.state.touchBuilding(t.tower); // a touch that changes nothing on the list
    expect(t.sim.view.fortsVersion!()).toBe(v0);
    t.wall.damage = 0.6; t.sim.state.touchBuilding(t.wall);
    const v1 = t.sim.view.fortsVersion!();
    expect(v1).toBeGreaterThan(v0);
    expect(t.sim.view.fortsVersion!()).toBe(v1);
  });
});
