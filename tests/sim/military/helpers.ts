// Helpers for the military tests: a simulation with economy and military installed, plus small fakes for the
// other wave 3 modules (politics with scripted wars; combat with deterministic harm).
import { installEconomy, type EconomyRuntime } from '../../../src/sim/economy';
import { installMilitary } from '../../../src/sim/military';
import type { MilitaryRuntime } from '../../../src/sim/military/types';
import { installSocial } from '../../../src/sim/social';
import type { Simulation } from '../../../src/sim/sim';
import type { SocialApi } from '../../../src/sim/social/types';
import type { HouseId, Person } from '../../../src/sim/state';
import type { CombatApi, FightResult, HarmResult, PoliticsApi, WarView } from '../../../src/sim/wave3';
import { newSim, type TestSimOptions } from '../helpers';

export interface MilSim {
  sim: Simulation;
  eco: EconomyRuntime;
  social: SocialApi;
  mil: MilitaryRuntime;
}

export function milSim(opts: TestSimOptions = {}): MilSim {
  const sim = newSim({ preset: 'small', ...opts });
  const social = installSocial(sim);
  const eco = installEconomy(sim, { social });
  const mil = installMilitary(sim, { economy: eco, social });
  return { sim, eco, social, mil };
}

/** A scripted politics module: wars are whatever the test puts in `wars`. */
export interface FakePolitics extends PoliticsApi {
  wars_: WarView[];
  reports: Array<{ war: number; attackerWon: boolean; weight: number }>;
  liege: Map<HouseId, HouseId>;
}

export function fakePolitics(sim: Simulation): FakePolitics {
  const wars_: WarView[] = [];
  const reports: FakePolitics['reports'] = [];
  const liege = new Map<HouseId, HouseId>();
  const api: FakePolitics = {
    wars_, reports, liege,
    stance: (a, b) => (wars_.some((w) => (w.attackers.includes(a) && w.defenders.includes(b)) || (w.attackers.includes(b) && w.defenders.includes(a))) ? 'war' : 'neutral'),
    wars: () => wars_,
    warsOf: (h) => wars_.filter((w) => w.attackers.includes(h) || w.defenders.includes(h)),
    liegeOf: (h) => liege.get(h) ?? 0,
    strength: () => 1,
    reportBattle: (war, attackerWon, weight) => { reports.push({ war, attackerWon, weight }); },
  };
  sim.services.politics = api;
  return api;
}

export function declareWar(p: FakePolitics, sim: Simulation, attackers: HouseId[], defenders: HouseId[]): WarView {
  const w: WarView = { id: p.wars_.length + 1, attackers, defenders, goal: 0, since: sim.absDay, score: 0 };
  p.wars_.push(w);
  return w;
}

/** A combat stand-in: `harm` kills with probability `intensity` x `lethality`, wounds otherwise; fights end at once. */
export interface FakeCombat extends CombatApi {
  harmed: Array<{ person: number; intensity: number; cause: string }>;
  engaged: Array<{ sides: number; id: number }>;
  finish(id: number, winner: string | null): void;
  lethality: number;
}

export function fakeCombat(sim: Simulation, lethality = 0.5): FakeCombat {
  const listeners: Array<(r: FightResult) => void> = [];
  let nextId = 1;
  const c: FakeCombat = {
    harmed: [], engaged: [], lethality,
    engage: (sides) => { const id = nextId++; c.engaged.push({ sides: sides.length, id }); return id; },
    isFighting: () => false,
    harm(person, intensity, cause): HarmResult {
      c.harmed.push({ person, intensity, cause });
      const p = sim.state.persons.get(person);
      if (!p || p.death) return 'dead';
      const r = sim.rng('fake-harm').next();
      if (r < intensity * c.lethality) { p.death = { day: sim.absDay, cause: 'battle' }; sim.state.markDead(p, sim.absDay, 'battle'); return 'dead'; }
      return r < intensity ? 'wounded' : 'unhurt';
    },
    wounds: () => [],
    onFightEnded: (fn) => { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
    finish(id, winner) {
      const r: FightResult = { id, winner, dead: [], wounded: [], captured: [], fled: [] };
      for (const l of listeners) l(r);
    },
  };
  sim.services.combat = c;
  return c;
}

/** Noble houses with a seat, strongest first. */
export function houses(sim: Simulation, kind: 'royal' | 'noble' = 'noble'): HouseId[] {
  return [...sim.state.houses.values()].filter((h) => h.kind === kind && !h.extinct).map((h) => h.id);
}

export function headOf(sim: Simulation, house: HouseId): Person {
  const h = sim.state.houses.get(house)!;
  return sim.state.persons.get(h.head)!;
}

/** Runs the calendar by whole hours (macro systems only). */
export function runHours(sim: Simulation, hours: number): void {
  sim.advanceHours(hours);
}
