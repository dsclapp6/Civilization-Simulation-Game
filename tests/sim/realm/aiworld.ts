// A simulation with everything the AI rulers work with installed - social, economy, politics, military, advancement, the territory,
// construction and the realm with its rulers - on a mock continent, for the AI tests (ai*.test.ts). The player is removed by default
// so that no House is the player's and a long run cannot end in game over.
import { installAdvancement } from '../../../src/sim/advancement';
import { installConstruction, type ConstructionInstall } from '../../../src/sim/construction';
import { installEconomy, type EconomyRuntime } from '../../../src/sim/economy';
import { installMilitary } from '../../../src/sim/military';
import { installPolitics, politicsInternals, type PoliticsInternals, type PoliticsRuntime } from '../../../src/sim/politics';
import { installRealm, type RealmRuntime } from '../../../src/sim/realm';
import type { Ai } from '../../../src/sim/realm/ai';
import type { Rlm } from '../../../src/sim/realm/store';
import type { Simulation } from '../../../src/sim/sim';
import { installSocial } from '../../../src/sim/social';
import { installTerritory } from '../../../src/sim/territory';
import type { Person } from '../../../src/sim/state';
import { LandsIndex } from '../../../src/world/lands';
import { WORLD_SIZE, type Deposit, type ResourceKind } from '../../../src/world/types';
import { newSim, noPlayer, type TestSimOptions } from '../helpers';

export interface AiWorld {
  sim: Simulation;
  economy: EconomyRuntime;
  pol: PoliticsRuntime;
  x: PoliticsInternals;
  cons: ConstructionInstall;
  realm: RealmRuntime;
  R: Rlm;
  ai: Ai;
}

export interface AiWorldOptions extends TestSimOptions {
  /** Keep the player (default: removed). */
  keepPlayer?: boolean;
  /** Leave the AI out (a control run). */
  noAi?: boolean;
  /** Called on the new simulation before the modules are installed (to shape the world: wild deposits, and the like). */
  prepare?: (sim: Simulation) => void;
}

export function aiWorld(opts: AiWorldOptions = {}): AiWorld {
  const sim = newSim({ preset: 'small', ...opts });
  if (!opts.keepPlayer) noPlayer(sim);
  opts.prepare?.(sim);
  return equipAi(sim, opts);
}

/** Installs the modules on a simulation (a new one, or one just loaded from a save) in the order the game does. */
export function equipAi(sim: Simulation, opts: AiWorldOptions = {}): AiWorld {
  const social = installSocial(sim);
  const economy = installEconomy(sim, { social });
  const deps = { economy, social };
  const pol = installPolitics(sim, deps);
  installMilitary(sim, deps);
  installAdvancement(sim, deps);
  installTerritory(sim, deps);
  const cons = installConstruction(sim, deps);
  const realm = installRealm(sim, deps, { ai: opts.noAi !== true });
  return { sim, economy, pol, x: politicsInternals(sim) as PoliticsInternals, cons, realm, R: realm.ctx, ai: realm.ai as Ai };
}

/** The first ruler of a class in the unit order, with his sense. */
export function aRuler(w: AiWorld, cls: 'manor' | 'county' | 'kingdom' | 'barony' | 'abbey', nth = 0): { id: number; person: Person; house: number } {
  const found: number[] = [];
  for (const u of w.ai.units()) {
    const S = w.ai.sense(u.ruler);
    if (S && S.class === cls) found.push(u.ruler);
  }
  const id = found[nth];
  if (id === undefined) throw new Error(`no ${cls} ruler`);
  const person = w.sim.state.persons.get(id) as Person;
  return { id, person, house: person.house };
}

/** Gives a household goods (and thereby the ruler the means to build or research). */
export function stockUpHousehold(sim: Simulation, householdId: number, goods: Record<string, number>): void {
  const hh = sim.state.households.get(householdId);
  if (!hh) return;
  for (const [k, v] of Object.entries(goods)) hh.stores[k] = Math.round(((hh.stores[k] ?? 0) + v) * 100) / 100;
  sim.state.touchHousehold(hh);
}

/**
 * A point in the wild (nobody's lands), on dry ground, between 2.4 and 5.5 km from a settlement - the `skip`-th found, looking round
 * the compass and then outwards (null when there is none). For the `prepare` hook: a world's wild deposits are fixed when the
 * territory is installed.
 */
export function wildPointNear(sim: Simulation, settlement: number, skip = 0): { x: number; z: number } | null {
  const s = sim.world.settlements.find((x) => x.id === settlement);
  if (!s) return null;
  const lands = new LandsIndex(sim.world.settlements);
  let seen = 0;
  for (let r = 2400; r <= 5500; r += 250) {
    for (let k = 0; k < 36; k++) {
      const a = (k / 36) * Math.PI * 2;
      const x = s.x + Math.cos(a) * r, z = s.z + Math.sin(a) * r;
      if (x < 300 || z < 300 || x > WORLD_SIZE - 300 || z > WORLD_SIZE - 300) continue;
      if (sim.world.waterSurfaceAt(x, z) !== null) continue;
      if (lands.lookup(x, z) !== -1 || lands.nearBuiltUp(x, z, 600)) continue;
      if (seen++ >= skip) return { x, z };
    }
  }
  return null;
}

/** Adds wild deposits to a simulation's world (before the territory is installed). */
export function addDeposits(sim: Simulation, list: Array<{ kind: ResourceKind; x: number; z: number; richness?: number }>): void {
  const world = sim.world as unknown as { deposits?: Deposit[] };
  const all = (world.deposits ?? []).slice();
  let id = all.reduce((m, d) => Math.max(m, d.id + 1), 0);
  for (const d of list) all.push({ id: id++, kind: d.kind, x: d.x, z: d.z, radius: 60, richness: d.richness ?? 0.8, settlement: -1 });
  world.deposits = all;
}
