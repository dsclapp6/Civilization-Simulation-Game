// Helpers for the territory tests: simulations on stand-in worlds (quick, and a world we can reshape before the module reads it)
// and on the real generated continent, with the other modules' answers (wars, feuds, outposts) scripted.
import type { Difficulty } from '../../../src/core/domain';
import { newProfile } from '../../../src/sim/legacy';
import { Simulation } from '../../../src/sim/sim';
import { installSocial } from '../../../src/sim/social';
import type { SocialApi } from '../../../src/sim/social/types';
import type { HouseId, Person } from '../../../src/sim/state';
import { installTerritory } from '../../../src/sim/territory';
import type { TerritoryRuntime } from '../../../src/sim/territory/types';
import { createMockWorld, type MockWorldOptions } from '../../../src/sim/testing/mockWorld';
import type { ArmyView, MilitaryApi, PoliticsApi, Stance, WarView } from '../../../src/sim/wave3';
import type { ConstructionApi, OutpostView } from '../../../src/sim/construction/types';
import { generateWorld } from '../../../src/world/generate';
import type { WorldModel } from '../../../src/world/types';
import { noPlayer } from '../helpers';

export interface Rig { sim: Simulation; terr: TerritoryRuntime; social: SocialApi; world: WorldModel }

function boot(sim: Simulation, keepPlayer: boolean): Rig {
  if (!keepPlayer) noPlayer(sim);
  const social = installSocial(sim);
  const terr = installTerritory(sim, { social, economy: undefined as never });
  return { sim, terr, social, world: sim.world };
}

/** A simulation on a stand-in world; `mutate` may reshape the world (add parcels, plots …) before the territory module reads it. */
export function mockRig(opts: MockWorldOptions & { difficulty?: Difficulty; mutate?: (w: WorldModel) => void; keepPlayer?: boolean } = {}): Rig {
  const sim = Simulation.newGame({
    seed: opts.seed ?? 'terr', difficulty: opts.difficulty ?? 'knight', profile: newProfile(),
    generateWorld: (seed) => {
      const w = createMockWorld({ seed, preset: opts.preset ?? 'small', kingdoms: opts.kingdoms });
      opts.mutate?.(w);
      return w;
    },
  });
  return boot(sim, opts.keepPlayer ?? false);
}

const real = new Map<string, Rig>();
/** The real generated continent (a few seconds to make, so one per test file and kind). Do not mutate the world or the state. */
export function realRig(sparse = true, seed = 'abc'): Rig {
  const key = `${seed}:${sparse}`;
  let r = real.get(key);
  if (!r) {
    const sim = Simulation.newGame({ seed, difficulty: 'knight', profile: newProfile(), generateWorld: (s) => generateWorld(s, { sparse }) });
    r = boot(sim, false);
    real.set(key, r);
  }
  return r;
}

// ---------------------------------------------------------------------------------------------
// The other modules' answers, scripted
// ---------------------------------------------------------------------------------------------

export interface ScriptedPolitics extends PoliticsApi {
  wars_: WarView[];
  stances: Map<string, Stance>;
  lieges: Map<HouseId, HouseId>;
  /** Sets how `a` stands towards `b` (both ways). */
  setStance(a: HouseId, b: HouseId, s: Stance): void;
  war(attackers: HouseId[], defenders: HouseId[]): WarView;
  endWar(id: number): void;
}

export function scriptedPolitics(sim: Simulation): ScriptedPolitics {
  const wars_: WarView[] = [];
  const stances = new Map<string, Stance>();
  const lieges = new Map<HouseId, HouseId>();
  const key = (a: HouseId, b: HouseId): string => `${a}>${b}`;
  const api: ScriptedPolitics = {
    wars_, stances, lieges,
    setStance: (a, b, s) => { stances.set(key(a, b), s); stances.set(key(b, a), s); },
    war: (attackers, defenders) => {
      const w: WarView = { id: wars_.length + 1, attackers, defenders, goal: 0, since: sim.absDay, score: 0 };
      wars_.push(w);
      for (const a of attackers) for (const d of defenders) { stances.set(key(a, d), 'war'); stances.set(key(d, a), 'war'); }
      return w;
    },
    endWar: (id) => {
      const i = wars_.findIndex((w) => w.id === id);
      if (i < 0) return;
      const [w] = wars_.splice(i, 1);
      for (const a of w.attackers) for (const d of w.defenders) { stances.delete(key(a, d)); stances.delete(key(d, a)); }
    },
    stance: (a, b) => stances.get(key(a, b)) ?? 'neutral',
    wars: () => wars_,
    warsOf: (h) => wars_.filter((w) => w.attackers.includes(h) || w.defenders.includes(h)),
    liegeOf: (h) => lieges.get(h) ?? 0,
    strength: () => 1,
    reportBattle: () => undefined,
  };
  sim.services.politics = api;
  return api;
}

export interface ScriptedMilitary extends MilitaryApi {
  feuds: Set<string>;
  sieges: Set<number>;
  armyList: ArmyView[];
  feud(a: HouseId, b: HouseId): void;
  endFeud(a: HouseId, b: HouseId): void;
}

export function scriptedMilitary(sim: Simulation): ScriptedMilitary {
  const feuds = new Set<string>();
  const sieges = new Set<number>();
  const armyList: ArmyView[] = [];
  const key = (a: HouseId, b: HouseId): string => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const api: ScriptedMilitary = {
    feuds, sieges, armyList,
    feud: (a, b) => { feuds.add(key(a, b)); },
    endFeud: (a, b) => { feuds.delete(key(a, b)); },
    armies: () => armyList,
    raise: () => 0,
    armyOf: () => 0,
    hostile: (a, b) => feuds.has(key(a, b)) || !!(sim.services.politics?.stance(a, b) === 'war'),
    siegeAt: (s) => (sieges.has(s) ? { besieger: 1 } : undefined),
  };
  sim.services.military = api;
  return api;
}

/** A construction module that only knows its outposts. */
export function scriptedConstruction(sim: Simulation, outposts: OutpostView[]): { outposts: OutpostView[]; found(o: OutpostView): void } {
  const list = outposts;
  let version = 1;
  const no = { ok: false, reason: 'scripted' };
  const api: ConstructionApi = {
    scope: (person) => ({ person, settlements: [], own: [], outposts: false, label: '', household: 0, house: 0 }),
    catalogue: () => [],
    check: (_p, _k, x, z, rot) => ({ ok: false, x, z, rot, settlement: -1, footprint: [] }),
    place: () => no, upgrade: () => no, repair: () => no, demolish: () => no, cancel: () => no, setPriority: () => no,
    sites: () => [], site: () => null, siteOf: () => null,
    outposts: () => list,
    cost: () => ({ goods: {}, labour: 0, pence: 0 }),
    suggestSpot: () => null, workersAt: () => [],
    version: () => version,
  };
  sim.services.construction = api;
  return { outposts: list, found(o) { list.push(o); version++; sim.events.emit('construction', { phase: 'done', site: 0, building: 0, settlement: o.settlement, kind: 'tent', work: 'build', house: 0 }); } };
}

// ---------------------------------------------------------------------------------------------
// People and times
// ---------------------------------------------------------------------------------------------

/** Midnight of the current day plus a fraction (0 = midnight, 0.5 = noon): sets the clock without running the calendar. */
export function setTimeOfDay(rig: Rig, fraction: number): void {
  rig.sim.state.clock.absDay = Math.floor(rig.sim.state.clock.absDay) + fraction;
  rig.terr.refresh();
}

/** The living resident of a settlement matching a test, nearest to the front of the id order. */
export function residentOf(rig: Rig, settlement: number, test: (p: Person) => boolean): Person {
  const p = rig.sim.state.residentList(settlement).find(test);
  if (!p) throw new Error(`no matching resident in settlement ${settlement}`);
  return p;
}
