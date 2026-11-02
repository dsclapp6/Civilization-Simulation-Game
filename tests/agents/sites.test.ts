// Buildings raised in play (docs/CIV.md §5): the people who work on a construction site go there in work hours and work; the zone's
// navigation, doors and places follow buildings that are put up, finished and pulled down. The construction module is faked here.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { doorStand } from '../../src/agents/geometry';
import { newIntent } from '../../src/agents/schedule';
import { siteSpot, type SiteSpot } from '../../src/agents/sites';
import { BUILDINGS, type BuildingKind } from '../../src/content/types';
import type { AnimState } from '../../src/core/view';
import type { ConstructionApi, SiteView } from '../../src/sim/construction/types';
import { ageYears, type BuildingState, type Person } from '../../src/sim/state';
import type { Settlement } from '../../src/world/types';
import { makeRig, run, setClock, village, type Rig } from './helpers';

let rig: Rig;
let vil: Settlement;
let workers: Person[];
let site: SiteView;
let version = 1;
let crew: number[] = [];
let sites: SiteView[] = [];

const WORK_CLIPS = new Set<AnimState>(['work_hammer', 'work_saw', 'work_pick', 'work_dig', 'work_lift', 'work_axe']);

function fakeConstruction(): ConstructionApi {
  const no = { ok: false, reason: 'fake' };
  return {
    scope: (person) => ({ person, settlements: [], own: [], outposts: false, label: '', household: 0, house: 0 }),
    catalogue: () => [], check: (_p, _k, x, z, rot) => ({ ok: false, x, z, rot, settlement: -1, footprint: [] }),
    place: () => no, upgrade: () => no, repair: () => no, demolish: () => no, cancel: () => no, setPriority: () => no,
    sites: () => sites, site: (id) => sites.find((s) => s.id === id) ?? null, siteOf: () => null, outposts: () => [],
    cost: () => ({ goods: {}, labour: 0, pence: 0 }), suggestSpot: () => null,
    workersAt: (id) => (id === site.id ? crew : []), version: () => version,
  };
}

function makeSite(kind: BuildingKind, x: number, z: number, over: Partial<SiteView> = {}): SiteView {
  return {
    id: 7001, building: -1, kind, work: 'build', settlement: vil.id, x, z, rot: 0.4, household: 0, house: 0, progress: 0.4, missing: {}, labourLeft: 20,
    workers: 0, status: 'working', eta: 100, priority: 0, ...over,
  };
}

beforeAll(() => {
  rig = makeRig();
  vil = village(rig.world, rig.zone);
  const adults = [...rig.sim.state.residentsOf(vil.id)].filter((p) => !p.death && ageYears(p, rig.sim.absDay) >= 18 && ageYears(p, rig.sim.absDay) < 50 && p.estate !== 'clergy' && p.career !== 'child');
  workers = adults.slice(0, 8);
  const sp = rig.zone.places.of(vil.id)!;
  site = makeSite('cottage', sp.green.x + 22, sp.green.z + 14);
  sites = [site];
  crew = workers.map((p) => p.id);
  rig.sim.services.construction = fakeConstruction();
}, 180000);

afterAll(() => { delete rig.sim.services.construction; });

describe('workers at a site', () => {
  it('go to the site in work hours and work there: hammer, saw, carry — and the others do not', () => {
    const { zone, sim } = rig;
    const I = newIntent();
    setClock(sim, 1, 2, 0);
    const day = sim.absDay;
    const anims = new Set<AnimState>();
    let atSite = 0;
    for (const p of workers) {
      zone.sched.intent(p, day + 0.4, I);
      expect(I.activity).toBe('work');
      expect(I.indoors).toBe(false);
      expect(WORK_CLIPS.has(I.anim)).toBe(true);
      anims.add(I.anim);
      // outside the footprint of a building that is solid, within a few metres of it
      const d = Math.hypot(I.x - site.x, I.z - site.z);
      if (d > 3 && d < 14) atSite++;
      expect(I.label).toMatch(/cottage/i);
    }
    expect(atSite).toBe(workers.length);
    expect(anims.size).toBeGreaterThan(1);
    // someone not on the crew keeps to their own day
    const other = [...sim.state.residentsOf(vil.id)].find((p) => !crew.includes(p.id) && p.career === 'smith' && ageYears(p, day) >= 18);
    if (other) {
      zone.sched.intent(other, day + 0.4, I);
      expect(Math.hypot(I.x - site.x, I.z - site.z)).toBeGreaterThan(20);
    }
  });

  it('stay at home on the holy day, in the evening and at night, and shelter from heavy rain', () => {
    const { zone, sim } = rig;
    const I = newIntent();
    const near = (p: Person): boolean => { zone.sched.intent(p, sim.absDay + 0.4, I); return Math.hypot(I.x - site.x, I.z - site.z) < 14 && I.activity === 'work'; };
    setClock(sim, 1, 4, 0); // the holy day
    expect(workers.filter((p) => near(p)).length).toBe(0);
    setClock(sim, 1, 2, 0);
    zone.sched.intent(workers[0], sim.absDay + 0.97, I);
    expect(I.indoors).toBe(true);
    zone.sched.forceWeather({ rain: 0.95, snow: 0, temperature: 8 });
    zone.sched.intent(workers[0], sim.absDay + 0.4, I);
    expect(I.label).toMatch(/weather/i);
    zone.sched.forceWeather({ rain: 0, snow: 0, temperature: 14 });
  });

  it('are on the site where the household plan says "build", even when the construction module lists nobody', () => {
    const { zone, sim } = rig;
    const I = newIntent();
    const before = crew;
    crew = [];
    version++;
    const member = workers[0];
    const hh = member.household;
    sites = [{ ...site, household: hh }];
    const eco = zone.economy as unknown as { householdPlan: (h: number) => Array<{ person: number; task: string; set: boolean }> };
    const real = eco.householdPlan;
    eco.householdPlan = (h) => (h === hh ? [{ person: member.id, task: 'build', set: true }] : real.call(zone.economy, h));
    setClock(sim, 1, 2, 0);
    zone.sched.intent(member, sim.absDay + 0.4, I);
    expect(I.activity).toBe('work');
    expect(Math.hypot(I.x - site.x, I.z - site.z)).toBeLessThan(14);
    eco.householdPlan = real;
    crew = before; sites = [site]; version++;
  });

  it('are drawn there working: the zone puts them around the site with hammers, saws and loads', () => {
    const { zone, sim, focus } = rig;
    zone.detachPlayer();
    sim.view.setSource('mode', () => 'street');
    focus.x = site.x; focus.z = site.z;
    setClock(sim, 1, 2, 0.43);
    version++;
    zone.resync();
    run(sim, 40);
    const around = zone.agentsArr.filter((a) => crew.includes(a.personId) && Math.hypot(a.x - site.x, a.z - site.z) < 16);
    expect(around.length).toBeGreaterThanOrEqual(Math.ceil(workers.length * 0.6));
    const working = around.filter((a) => WORK_CLIPS.has(a.draw.anim) || a.draw.carry !== 'none');
    expect(working.length).toBeGreaterThan(0);
    // the tools in their hands
    expect(around.some((a) => a.draw.mainHand === 'hammer' || a.draw.mainHand === 'saw' || a.draw.mainHand === 'chisel')).toBe(true);
  }, 60000);

  it('is quiet without the construction module, or when it fails', () => {
    const { zone, sim } = rig;
    const I = newIntent();
    setClock(sim, 1, 2, 0);
    const keep = sim.services.construction;
    delete sim.services.construction;
    version++;
    zone.sched.intent(workers[0], sim.absDay + 0.4, I);
    expect(I.label).not.toMatch(/cottage/i);
    sim.services.construction = { ...fakeConstruction(), sites: () => { throw new Error('boom'); } };
    expect(() => zone.sched.intent(workers[1], sim.absDay + 0.41, I)).not.toThrow();
    sim.services.construction = keep;
  });
});

describe('the work at a site', () => {
  const spot: SiteSpot = { x: 0, z: 0, yaw: 0, anim: 'idle', main: 'none', off: 'none', carry: 'none', label: '', haul: false, bx: 0, bz: 0 };
  const mk = (kind: BuildingKind, progress: number, work: SiteView['work'] = 'build'): SiteView => makeSite(kind, 5000, 5000, { kind, progress, work });

  it('follows the stage and the material: digging footings, sawing the frame of a timber house, dressing and carrying stone for a church', () => {
    const seen = (kind: BuildingKind, progress: number, work: SiteView['work'] = 'build'): Set<string> => {
      const out = new Set<string>();
      for (let i = 1; i <= 40; i++) {
        const p = rig.sim.state.persons.get(workers[i % workers.length].id)!;
        const s = siteSpot({ ...p, id: p.id * 7 + i } as Person, mk(kind, progress, work), 3, spot);
        out.add(spot.anim + (spot.haul ? '+haul' : ''));
        expect(Number.isFinite(spot.x + spot.z + spot.bx + spot.bz)).toBe(true);
        void s;
      }
      return out;
    };
    expect([...seen('cottage', 0.05)].some((a) => a.startsWith('work_dig'))).toBe(true);
    expect(seen('cottage', 0.4).has('work_saw')).toBe(true);
    expect(seen('church', 0.4).has('work_pick')).toBe(true);
    expect([...seen('church', 0.4)].some((a) => a.endsWith('+haul'))).toBe(true);
    expect(seen('cottage', 0.8).has('work_hammer')).toBe(true);
    expect([...seen('barn', 0.5, 'demolish')].some((a) => a === 'work_pick' || a === 'work_hammer')).toBe(true);
    expect([...seen('watermill', 0.5, 'repair')].length).toBeGreaterThan(0);
  });

  it('stands outside a solid footprint and inside an open one', () => {
    for (const kind of ['cottage', 'church', 'smithy', 'barn'] as BuildingKind[]) {
      const def = BUILDINGS[kind];
      for (let i = 0; i < 30; i++) {
        siteSpot({ id: 100 + i } as Person, mk(kind, 0.4), 2, spot);
        // in the building's own frame
        const s = mk(kind, 0.4);
        const dx = spot.x - s.x, dz = spot.z - s.z;
        const c = Math.cos(s.rot), sn = Math.sin(s.rot);
        const lx = dx * c - dz * sn, lz = dx * sn + dz * c;
        const out = Math.abs(lx) > def.w / 2 + 1.2 || Math.abs(lz) > def.d / 2 + 1.2;
        expect(out, `${kind} worker ${i} at ${lx.toFixed(1)}, ${lz.toFixed(1)}`).toBe(true);
      }
    }
    for (const kind of ['quarry', 'clay_pit'] as BuildingKind[]) {
      const def = BUILDINGS[kind];
      for (let i = 0; i < 20; i++) {
        siteSpot({ id: 300 + i } as Person, mk(kind, 0.4), 2, spot);
        expect(Math.hypot(spot.x - 5000, spot.z - 5000)).toBeLessThan(Math.hypot(def.w, def.d) / 2);
      }
    }
  });
});

describe('buildings raised in play are used by the zone', () => {
  const stand = (b: BuildingState): { x: number; z: number } => { const o = { x: 0, z: 0, yaw: 0 }; doorStand(b, o, 0); return o; };

  it('are solid for walkers once put up (even a site), and not any more once pulled down', () => {
    const { zone, sim, focus } = rig;
    zone.detachPlayer();
    sim.view.setSource('mode', () => 'street');
    const sp = zone.places.of(vil.id)!;
    focus.x = sp.green.x; focus.z = sp.green.z;
    setClock(sim, 1, 2, 0.3);
    zone.resync();
    // a free spot near the green
    let at: { x: number; z: number } | null = null;
    for (let r = 14; r < 60 && !at; r += 4) for (let a = 0; a < 12 && !at; a++) {
      const x = sp.green.x + Math.cos(a) * r, z = sp.green.z + Math.sin(a) * r;
      if (zone.nav.walkable(x, z) && zone.nav.walkable(x + 5, z) && zone.nav.walkable(x - 5, z) && zone.nav.walkable(x, z + 5) && zone.nav.walkable(x, z - 5)) at = { x, z };
    }
    expect(at).not.toBeNull();
    expect(zone.nav.walkable(at!.x, at!.z)).toBe(true);
    const id = 9_000_001;
    const b: BuildingState = {
      id, plot: -1, kind: 'barn', level: 1, settlement: vil.id, construction: 0.2, damage: 0, onFire: false, owner: 0, household: 0, occupied: false,
      x: at!.x, z: at!.z, rot: 0, culture: 0 as never, seed: 5,
    };
    sim.state.buildings.set(id, b);
    sim.state.buildingsAt.get(vil.id)!.push(b);
    // (no revision bump: the zone follows the number of buildings too)
    run(sim, 3);
    expect(zone.nav.walkable(at!.x, at!.z)).toBe(false);
    expect(zone.nav.finder.lineClear(at!.x - 7, at!.z, at!.x + 7, at!.z)).toBe(false);
    // a site is not a place of daily life yet
    expect(zone.places.of(vil.id)!.first('barn')?.id).not.toBe(id);
    // finished, it is
    b.construction = 1; sim.state.touchBuilding(b);
    run(sim, 1);
    expect(zone.places.of(vil.id)!.all(['barn']).some((x) => x.id === id)).toBe(true);
    // its door is where the model has it, and the player can find it
    const door = stand(b);
    const out: import('../../src/agents/types').InteractCandidate[] = [];
    zone.interactables(door.x, door.z, 0, 4, out);
    expect(out.some((c) => c.target.kind === 'building' && c.target.id === id)).toBe(true);
    // pulled down
    sim.state.buildings.delete(id);
    sim.state.buildingsAt.set(vil.id, sim.state.buildingsAt.get(vil.id)!.filter((x) => x.id !== id));
    run(sim, 3);
    expect(zone.nav.walkable(at!.x, at!.z)).toBe(true);
    expect(zone.nav.finder.lineClear(at!.x - 7, at!.z, at!.x + 7, at!.z)).toBe(true);
  }, 60000);

  it('label a building still going up, and know the doors of the new kinds', () => {
    const { zone, sim } = rig;
    const sp = zone.places.of(vil.id)!;
    const kinds: BuildingKind[] = ['slaughterhouse', 'clay_pit', 'salt_pan', 'lumber_camp', 'gaol'];
    for (const kind of kinds) {
      const b: BuildingState = {
        id: 9_100_000 + kinds.indexOf(kind), plot: -1, kind, level: 1, settlement: vil.id, construction: 0.5, damage: 0, onFire: false, owner: 0, household: 0,
        occupied: false, x: sp.green.x + 40, z: sp.green.z + 40, rot: 1, culture: 0 as never, seed: 1,
      };
      const d = zone.nav.doorOf(b.id);
      expect(d).toBeNull(); // not in the state yet
      sim.state.buildings.set(b.id, b);
      const door = zone.nav.doorOf(b.id)!;
      expect(Number.isFinite(door.x + door.z + door.yaw)).toBe(true);
      // outside the footprint, on the front side
      const dx = door.x - b.x, dz = door.z - b.z;
      const c = Math.cos(b.rot), sn = Math.sin(b.rot);
      expect(dx * sn + dz * c).toBeGreaterThan(BUILDINGS[kind].d / 2);
      sim.state.buildings.delete(b.id);
    }
  });
});
