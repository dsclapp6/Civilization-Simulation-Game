// Helpers for the construction tests: a mock continent with shaped terrain (a river, a hill, water, deposits), a fake territory
// service, a stub of the economy's household trade, and builders for lords, stewards and peasants with known rank and land.
import goodsJson from '../../../src/content/goods.json';
import type { BuildingKind } from '../../../src/content/types';
import { dist2, pointInPolygon } from '../../../src/core/math';
import { installConstruction, type ConstructionInstall } from '../../../src/sim/construction';
import type { EconomyApi } from '../../../src/sim/economy/types';
import { newProfile } from '../../../src/sim/legacy';
import { Simulation } from '../../../src/sim/sim';
import type { SocialApi } from '../../../src/sim/social/types';
import type { Household, Person, Title } from '../../../src/sim/state';
import { createMockWorld } from '../../../src/sim/testing/mockWorld';
import type { LandInfo, TerritoryApi } from '../../../src/sim/territory/types';
import type { Wave3Deps } from '../../../src/sim/wave3deps';
import type { Deposit, River, WorldModel } from '../../../src/world/types';
import { mkHousehold, mkHouse, mkPerson } from '../builders';

export interface Shape {
  height?: (x: number, z: number) => number;
  water?: (x: number, z: number) => number | null;
  forest?: (x: number, z: number) => number;
  walk?: (x: number, z: number) => number;
  rivers?: River[];
  deposits?: Deposit[];
}

/** The tiny mock continent with some of its terrain replaced. */
export function shapedWorld(seed: string, shape: Shape = {}): WorldModel {
  const w = createMockWorld({ seed, preset: 'tiny' });
  return {
    ...w,
    heightAt: shape.height ?? w.heightAt,
    waterSurfaceAt: shape.water ?? w.waterSurfaceAt,
    forestAt: shape.forest ?? w.forestAt,
    walkCostAt: shape.walk ?? w.walkCostAt,
    rivers: shape.rivers ?? w.rivers,
    deposits: shape.deposits ?? w.deposits,
  };
}

export function buildSim(seed = 'cons', shape: Shape = {}): Simulation {
  return Simulation.newGame({ seed, difficulty: 'knight', generateWorld: (s) => shapedWorld(s, shape), profile: newProfile() });
}

// ---------------------------------------------------------------------------------------------
// A territory service
// ---------------------------------------------------------------------------------------------

const RADIUS: Record<string, number> = { hamlet: 1200, village: 2000, town: 2500, city: 3000, castle: 2000, abbey: 1500, priory: 1200, nunnery: 1200 };

export interface FakeTerritory extends TerritoryApi {
  /** Hand-placed ground: tried first. */
  patches: Array<{ test: (x: number, z: number) => boolean; land: Partial<LandInfo> }>;
  bump(): void;
}

export function fakeTerritory(sim: Simulation): FakeTerritory {
  let ver = 0;
  const patches: FakeTerritory['patches'] = [];
  const settlements = sim.world.settlements;
  const titleAt = (sid: number): Title | undefined => {
    for (const k of ['manor', 'town', 'abbey', 'barony'] as const) { const t = sim.state.titleFor(k, sid); if (t) return t; }
    for (const co of sim.world.counties) if (co.seat === sid) return sim.state.titleFor('county', co.id);
    return undefined;
  };
  const api: FakeTerritory = {
    patches,
    bump: () => { ver++; },
    landAt(x, z): LandInfo {
      for (const p of patches) if (p.test(x, z)) return { kind: 'garden', settlement: -1, house: 0, title: 0, household: 0, strip: -1, parcel: -1, building: -1, ...p.land };
      let best: (typeof settlements)[number] | undefined, bd = Infinity;
      for (const s of settlements) {
        const d = dist2(x, z, s.x, s.z);
        const r = RADIUS[s.kind] ?? 1500;
        if (d <= r * r && d < bd) { bd = d; best = s; }
      }
      if (!best) return { kind: 'wild', settlement: -1, house: 0, title: 0, household: 0, strip: -1, parcel: -1, building: -1 };
      const t = titleAt(best.id);
      const holder = t ? sim.state.persons.get(t.holder) : undefined;
      let kind: LandInfo['kind'] = Math.sqrt(bd) <= best.radius ? 'town' : 'demesne';
      let strip = -1;
      for (const sid of best.strips) {
        const s = sim.world.strips[sid];
        if (s && pointInPolygon(x, z, s.poly)) { kind = 'field'; strip = s.id; break; }
      }
      return { kind, settlement: best.id, house: holder?.house ?? 0, title: t?.id ?? 0, household: 0, strip, parcel: -1, building: -1 };
    },
    trespass: () => ({ level: 'none', land: api.landAt(0, 0), reason: '' }),
    settlementOf: (x, z) => api.landAt(x, z).settlement,
    landsRadius: (sid) => RADIUS[settlements.find((s) => s.id === sid)?.kind ?? 'village'] ?? 1500,
    resources: (settlement) => ({ settlement, deposits: [], forest: 0, fertility: 0, coast: false, river: false, yields: [] }),
    deposits: () => sim.world.deposits ?? [],
    depositsNear: (x, z, radius, kind) => (sim.world.deposits ?? []).filter((d) => (!kind || d.kind === kind) && dist2(x, z, d.x, d.z) <= radius * radius),
    depositAt: (x, z, kind) => (sim.world.deposits ?? []).find((d) => (!kind || d.kind === kind) && dist2(x, z, d.x, d.z) <= d.radius * d.radius) ?? null,
    version: () => ver,
  };
  sim.services.territory = api;
  return api;
}

// ---------------------------------------------------------------------------------------------
// A stub of the economy's household trade and plan
// ---------------------------------------------------------------------------------------------

export interface FakeEconomy {
  api: EconomyApi;
  /** Stock the stub's market holds (good → amount). */
  market: Record<string, number>;
  /** Unit prices charged (default: the reference price). */
  price: Record<string, number>;
  calls: Array<{ household: number; good: string; qty: number; got: number }>;
  /** Household tasks the stub reports (person → task). */
  tasks: Map<number, string>;
  /** Days goods take to arrive. */
  days: number;
  /** Turn off `procure` to test its absence. */
  disableProcure(): void;
}

const GOODS = goodsJson as unknown as Record<string, { name: string; unit: string; basePrice: number }>;

export function fakeEconomy(sim: Simulation): FakeEconomy {
  const market: Record<string, number> = {};
  const price: Record<string, number> = {};
  const pending: Array<{ hh: number; good: string; qty: number; day: number }> = [];
  const calls: FakeEconomy['calls'] = [];
  const tasks = new Map<number, string>();
  const fe: FakeEconomy = {
    api: undefined as unknown as EconomyApi, market, price, calls, tasks, days: 1,
    disableProcure() { delete (fe.api as { procure?: unknown }).procure; },
  };
  sim.events.on('hourStarted', () => {
    for (let i = pending.length - 1; i >= 0; i--) {
      const d = pending[i];
      if (d.day > sim.absDay + 1e-9) continue;
      const hh = sim.state.households.get(d.hh);
      if (hh) { hh.stores[d.good] = (hh.stores[d.good] ?? 0) + d.qty; sim.state.touchHousehold(hh); }
      pending.splice(i, 1);
    }
  });
  const api = {
    good: (id: string) => (GOODS[id] ? { id, name: GOODS[id].name, unit: GOODS[id].unit, basePrice: GOODS[id].basePrice } : undefined),
    householdPlan: (household: number) => {
      const hh = sim.state.households.get(household);
      return (hh?.members ?? []).map((person) => ({ person, task: tasks.get(person) ?? 'auto', set: tasks.has(person) }));
    },
    procure: (household: number, good: string, qty: number, opts?: { settlement?: number; maxPrice?: number }) => {
      const hh = sim.state.households.get(household);
      const unit = price[good] ?? GOODS[good]?.basePrice ?? 1;
      const settlement = opts?.settlement ?? hh?.settlement ?? 0;
      if (!hh || (opts?.maxPrice !== undefined && unit > opts.maxPrice)) { calls.push({ household, good, qty, got: 0 }); return { got: 0, cost: 0, settlement, days: 0 }; }
      const n = Math.max(0, Math.min(qty, market[good] ?? 0, Math.floor(hh.purse / unit + 1e-9)));
      if (n > 0) {
        hh.purse = Math.round((hh.purse - n * unit) * 100) / 100;
        market[good] = (market[good] ?? 0) - n;
        pending.push({ hh: household, good, qty: n, day: sim.absDay + fe.days });
        sim.state.touchHousehold(hh);
      }
      calls.push({ household, good, qty, got: n });
      return { got: n, cost: n * unit, settlement, days: fe.days };
    },
  };
  fe.api = api as unknown as EconomyApi;
  return fe;
}

// ---------------------------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------------------------

export interface Rig {
  sim: Simulation;
  eco: FakeEconomy;
  terr: FakeTerritory;
  cons: ConstructionInstall;
}

/** A tiny world with the fake territory, the economy stub and construction installed; the clock at 8 in the morning. */
export function rig(seed = 'cons', shape: Shape = {}): Rig {
  const sim = buildSim(seed, shape);
  const terr = fakeTerritory(sim);
  const eco = fakeEconomy(sim);
  const deps: Wave3Deps = { economy: eco.api, social: {} as SocialApi };
  const cons = installConstruction(sim, deps);
  setTime(sim, 8 / 24);
  return { sim, eco, terr, cons };
}

/** Sets the time of day on the current day without firing hooks. */
export function setTime(sim: Simulation, fraction: number, day = Math.floor(sim.absDay)): void {
  sim.state.clock.absDay = day + fraction;
  sim.state.clock.firedHour = Math.floor((day + fraction) * 24);
}

/** Moves to 05:00 of a later day (the hour before the day's plan) without firing hooks. */
export function toDawn(sim: Simulation, days = 1): void {
  setTime(sim, 5 / 24, Math.floor(sim.absDay) + days);
}

export function village(sim: Simulation): { id: number; x: number; z: number; radius: number } {
  const s = sim.world.settlements.find((x) => x.kind === 'village' && sim.state.titleFor('manor', x.id))!;
  return { id: s.id, x: s.x, z: s.z, radius: s.radius };
}

export function manorLord(sim: Simulation, settlement: number): Person {
  const t = sim.state.titleFor('manor', settlement)!;
  return sim.state.persons.get(t.holder)!;
}

export function houseOf(sim: Simulation, p: Person): Household {
  return sim.state.households.get(p.household)!;
}

/** Fills a household's stores and purse so a job is never short. */
export function enrich(hh: Household, goods: Record<string, number> = {}, purse = 100000): void {
  hh.purse = purse;
  for (const [g, q] of Object.entries(goods)) hh.stores[g] = (hh.stores[g] ?? 0) + q;
}

/** Everything a new building of this kind costs in materials. */
export function allMaterials(kind: BuildingKind, cons: ConstructionInstall, mult = 1): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [g, q] of Object.entries(cons.cost(kind, 1).goods)) out[g] = Math.ceil(q * mult);
  return out;
}

/** A free peasant who heads a household with a croft: the fake territory calls 18 m round a point behind the home his garden. */
export function peasantWithGarden(r: Rig, tier: 1 | 2 | 3 = 2): { p: Person; hh: Household; x: number; z: number } {
  const sim = r.sim;
  const v = village(sim);
  const hh = mkHousehold(sim, v.id);
  const p = mkPerson(sim, { age: 32, tier, estate: tier === 1 ? 'unfree' : 'free', household: hh.id, settlement: v.id, house: mkHouse(sim, 'Croft').id });
  sim.state.setHead(hh, p);
  const home = sim.state.buildingsAt.get(v.id)!.find((b) => b.kind === 'cottage' && b.household === 0 && b.construction >= 1)
    ?? sim.state.buildingsAt.get(v.id)!.find((b) => b.kind === 'hovel' && b.household === 0)!;
  sim.state.setHome(hh, home.id);
  hh.purse = 400;
  const gx = home.x + Math.sin(home.rot + Math.PI) * 20, gz = home.z + Math.cos(home.rot + Math.PI) * 20;
  r.terr.patches.push({ test: (x, z) => dist2(x, z, gx, gz) < 18 * 18, land: { kind: 'garden', settlement: v.id, household: hh.id, house: 0 } });
  r.terr.bump();
  return { p, hh, x: gx, z: gz };
}

/** A clear patch of a settlement's ground for this builder (the module's own suggestion). */
export function clearSpot(r: Rig, settlement: number, kind: BuildingKind, who: Person): { x: number; z: number; rot: number } {
  const spot = r.cons.suggestSpot(who.id, kind, settlement);
  if (!spot) throw new Error(`no spot for ${kind} at ${settlement}`);
  return { x: spot.x, z: spot.z, rot: spot.rot };
}
