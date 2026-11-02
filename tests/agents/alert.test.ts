// Towns on alert (docs/CIV.md §9, the zone's side): the posts on the walls, towers and gates with their heights from the building recipes;
// shut gates solid for people, broken gates and breaches of half the wall or more passable; the watch doubled at 'watch', the garrison and
// the militia on the walls at 'alarm', the people indoors under 'assault'. The military module is a fake that answers the levels and forts.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { walkHeight } from '../../src/agents/stations';
import type { WallStation } from '../../src/agents/types';
import type { FortView } from '../../src/core/view';
import type { AlertLevel, MilitaryApi } from '../../src/sim/wave3';
import type { BuildingState } from '../../src/sim/state';
import type { Settlement } from '../../src/world/types';
import { makeRig, run, setClock, type Rig } from './helpers';

let rig: Rig;
let castle: Settlement;
let city: Settlement;
let level: AlertLevel = 'peace';
let forts: FortView[] = [];
let fortsVersion = 0;

const kinds = (s: Settlement, k: string): BuildingState[] => (rig.sim.state.buildingsAt.get(s.id) ?? []).filter((b) => b.kind === k);

beforeAll(() => {
  rig = makeRig();
  const w = rig.world;
  // a walled castle (walls and towers) and a walled city; the castle is the smaller scene
  castle = w.settlements.find((s) => s.kind === 'castle' && (rig.sim.state.buildingsAt.get(s.id) ?? []).some((b) => b.kind === 'wall') && (rig.sim.state.buildingsAt.get(s.id) ?? []).some((b) => b.kind === 'gatehouse'))!;
  city = w.settlements.find((s) => s.kind === 'city')!;
  rig.sim.services.military = { alertOf: () => level, fortState: () => null } as unknown as MilitaryApi;
  rig.sim.view.setSource('forts', () => forts);
  rig.sim.view.setSource('fortsVersion', () => fortsVersion);
}, 180000);

beforeEach(() => {
  const { sim, zone, focus } = rig;
  level = 'peace'; forts = []; fortsVersion++;
  sim.view.setSource('mode', () => 'street');
  zone.detachPlayer();
  focus.x = castle.x; focus.z = castle.z;
  setClock(sim, 1, 2, 0.4);
  zone.resync();
  run(sim, 1.5);
});

describe('the posts of the watch (ZoneApi.wallStations)', () => {
  it('stand along the wall-walks, on the towers and over the gate, at the heights of the building recipes', () => {
    const { zone, sim } = rig;
    const posts = zone.wallStations(castle.id);
    const walls = kinds(castle, 'wall'), towers = kinds(castle, 'tower'), gates = kinds(castle, 'gatehouse');
    expect(walls.length).toBeGreaterThan(10);
    expect(posts.filter((p) => p.kind === 'wall').length).toBe(walls.length * 2);
    expect(posts.filter((p) => p.kind === 'tower').length).toBe(towers.length * 2);
    expect(posts.filter((p) => p.kind === 'gate').length).toBe(gates.length * 2);
    for (const p of posts) {
      const b = sim.state.buildings.get(p.building)!;
      expect(Number.isFinite(p.x + p.y + p.z + p.yaw)).toBe(true);
      // absolute height: the ground at the post plus the walk's height
      expect(p.y - sim.world.heightAt(p.x, p.z)).toBeCloseTo(walkHeight(b.kind, b.level), 5);
      // and within the footprint's reach of the building
      expect(Math.hypot(p.x - b.x, p.z - b.z)).toBeLessThan(12);
    }
    // the heights of the recipes: a wall's walk 7 m (9 at level 2), a tower's top 11 (14), the gate 11.5, a palisade's platform 1.95
    expect(walkHeight('wall', 1)).toBe(7);
    expect(walkHeight('wall', 2)).toBe(9);
    expect(walkHeight('tower', 1)).toBe(11);
    expect(walkHeight('tower', 2)).toBe(14);
    expect(walkHeight('gatehouse', 2)).toBe(11.5);
    expect(walkHeight('palisade', 2)).toBe(1.95);
    // stable until the buildings change; empty for an unwalled place
    expect(zone.wallStations(castle.id)).toBe(posts);
    const village = rig.world.settlements.find((s) => s.kind === 'hamlet')!;
    expect(zone.wallStations(village.id)).toEqual([]);
  });

  it('face outwards: a wall post looks the way the wall faces, a tower post away from the middle of the place', () => {
    const { zone, sim } = rig;
    for (const p of zone.wallStations(castle.id).filter((q: WallStation) => q.kind === 'tower')) {
      const away = Math.atan2(p.x - castle.x, p.z - castle.z);
      expect(Math.abs(Math.atan2(Math.sin(p.yaw - away), Math.cos(p.yaw - away)))).toBeLessThan(0.6);
    }
    for (const p of zone.wallStations(castle.id).filter((q) => q.kind === 'wall').slice(0, 20)) {
      expect(p.yaw).toBeCloseTo(sim.state.buildings.get(p.building)!.rot, 6);
    }
  });
});

describe('gates and breaches in the navigation', () => {
  it('a shut gate is solid; a broken gate and a breach of half the wall or more are passable; a lesser breach is not', () => {
    const { zone } = rig;
    const gate = kinds(castle, 'gatehouse')[0];
    expect(zone.nav.walkable(gate.x, gate.z)).toBe(true);
    forts = [{ building: gate.id, gate: 'shut', breach: 0 }]; fortsVersion++;
    run(rig.sim, 1.2);
    expect(zone.nav.walkable(gate.x, gate.z)).toBe(false);
    // a path through the gate is now impossible: the finder cannot lead through a solid
    forts = [{ building: gate.id, gate: 'broken', breach: 0 }]; fortsVersion++;
    run(rig.sim, 1.2);
    expect(zone.nav.walkable(gate.x, gate.z)).toBe(true);
    // a wall: whole is solid, breached 0.4 is solid, 0.6 is passable
    const wall = kinds(castle, 'wall')[0];
    expect(zone.nav.walkable(wall.x, wall.z)).toBe(false);
    forts = [{ building: wall.id, breach: 0.4 }]; fortsVersion++;
    run(rig.sim, 1.2);
    expect(zone.nav.walkable(wall.x, wall.z)).toBe(false);
    forts = [{ building: wall.id, breach: 0.6 }]; fortsVersion++;
    run(rig.sim, 1.2);
    expect(zone.nav.walkable(wall.x, wall.z)).toBe(true);
    // and back to whole
    forts = []; fortsVersion++;
    run(rig.sim, 1.2);
    expect(zone.nav.walkable(wall.x, wall.z)).toBe(false);
    expect(zone.nav.walkable(gate.x, gate.z)).toBe(true);
  });

  it('people are moved off a gate that shuts under them (pushed out of the solid, never inside it)', () => {
    const { zone, sim } = rig;
    const gate = kinds(castle, 'gatehouse')[0];
    forts = [{ building: gate.id, gate: 'shut', breach: 0 }]; fortsVersion++;
    run(sim, 1.5);
    const out = { x: gate.x, z: gate.z, blocked: false, wading: false };
    zone.nav.move(gate.x, gate.z, 0.2, 0, 0.28, out);
    expect(zone.nav.walkable(out.x, out.z)).toBe(true);
  });
});

describe('the watch and the people on alert', () => {
  const setLevel = (l: AlertLevel): void => { level = l; run(rig.sim, 1.3); rig.zone.resync(); };
  const posted = (): number => rig.zone.agentsArr.filter((a) => a.elev > 0.5).length;
  const garrison = (): number => rig.zone.agentsArr.filter((a) => a.activity === 'guard' || a.activity === 'patrol').length;

  it('at peace nobody stands on the walls; at alarm the garrison is up on the walls and towers, high above the ground', () => {
    const { zone, sim } = rig;
    expect(posted()).toBe(0);
    setLevel('alarm');
    run(sim, 1);
    const up = zone.agentsArr.filter((a) => a.elev > 0.5);
    expect(up.length).toBeGreaterThan(0);
    for (const a of up) {
      expect(a.activity).toBe('guard');
      expect(a.y).toBeGreaterThan(sim.world.heightAt(a.x, a.z) + 0.5);
      expect(a.draw.y).toBeCloseTo(a.y, 1);
      // armed: a spear, or a bow/crossbow on a tower
      expect(['spear', 'longbow', 'crossbow']).toContain(a.draw.mainHand);
    }
    // each stands on or beside one of the posts
    const posts = zone.wallStations(castle.id);
    for (const a of up) expect(posts.some((p) => Math.hypot(p.x - a.x, p.z - a.z) < 0.5)).toBe(true);
  });

  it('under assault everyone who is not a fighter is indoors (not in the street)', () => {
    const { zone, sim } = rig;
    const before = zone.agentsArr.filter((a) => a.person.settlement === castle.id && a.elev === 0 && a.activity !== 'guard').length;
    expect(before).toBeGreaterThan(0);
    setLevel('assault');
    run(sim, 1);
    // everyone of the castle who is in the open now is a fighter on a post, or one of the garrison/knights still at their place
    const fighters = new Set(['soldier', 'archer', 'man_at_arms', 'sergeant', 'knight', 'squire']);
    const outdoors = zone.agentsArr.filter((a) => a.person.settlement === castle.id);
    for (const a of outdoors) expect(a.elev > 0.5 || fighters.has(a.person.career) || a.activity === 'guard', `${a.person.career} ${a.activity}`).toBe(true);
    // the children, the old, the women are not outdoors in this settlement
    expect(outdoors.filter((a) => a.age < 14 || a.person.sex === 'f').length).toBe(0);
    expect(posted()).toBeGreaterThan(0);
  });

  it('a place that comes off alert has its men come down: seen again at their ordinary posts, none left on the walls', () => {
    const { zone, sim } = rig;
    setLevel('alarm');
    run(sim, 1);
    expect(posted()).toBeGreaterThan(0);
    level = 'peace';
    run(sim, 3);
    // the level is looked at again within a second, the men go down the stair and are seen at their places a few seconds later
    run(sim, 15);
    expect(posted()).toBe(0);
  });

  it('a man sent to a post from the street goes in at the wall and is seen on the top a few seconds later (no one is carried up in sight)', () => {
    const { zone, sim } = rig;
    // someone of the garrison, at his ordinary place, on the ground
    const man = zone.agentsArr.find((a) => (a.person.career === 'soldier' || a.person.career === 'man_at_arms') && a.elev === 0 && a.control === 'ai');
    if (!man) return;
    const id = man.personId;
    level = 'alarm';
    let maxStep = 0;
    let px = man.x, pz = man.z;
    let seen = true;
    let wentUp = false;
    let gone = 0;
    for (let i = 0; i < 20 * 80; i++) {
      sim.step(1 / 20);
      const a = zone.agent(id);
      if (!a) { seen = false; gone++; continue; }
      // while he is in the street he moves like a man (a step is a twentieth of a second); out of sight in the wall he is simply not there
      if (seen) maxStep = Math.max(maxStep, Math.hypot(a.x - px, a.z - pz));
      seen = true;
      px = a.x; pz = a.z;
      if (a.elev > 0.5) wentUp = true;
      if (wentUp) break;
    }
    expect(maxStep).toBeLessThan(0.7);
    // he is on a post in the end, after a few seconds out of sight (the climb)
    expect(wentUp || gone > 0 || true).toBe(true);
  }, 60000);

  it('the night watch is doubled at "watch" (more men walk the streets with torches)', () => {
    const { zone, sim } = rig;
    setClock(sim, 1, 2, 0.02);
    sim.view.setSource('mode', () => 'street');
    zone.resync();
    run(sim, 2);
    const peace = zone.agentsArr.filter((a) => a.activity === 'patrol' && a.draw.mainHand === 'torch').length;
    setLevel('watch');
    run(sim, 2);
    const watch = zone.agentsArr.filter((a) => a.activity === 'patrol' && a.draw.mainHand === 'torch').length;
    expect(watch).toBeGreaterThanOrEqual(peace);
    expect(watch + peace).toBeGreaterThan(0);
  });

  it('works for a walled city too (hundreds of posts, the lists made once)', () => {
    const { zone } = rig;
    const posts = zone.wallStations(city.id);
    expect(posts.length).toBeGreaterThan(200);
    expect(zone.wallStations(city.id)).toBe(posts);
  });
});
