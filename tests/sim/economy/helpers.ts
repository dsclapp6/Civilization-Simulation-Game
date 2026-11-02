// Helpers for the economy tests: a simulation with the economy installed, a player who heads a
// farm household, and a driver that runs player actions to completion.
import { ageYears, type BuildingState, type Household, type Person } from '../../../src/sim/state';
import type { BuildingKind } from '../../../src/content/types';
import type { ConstructionApi, SiteView } from '../../../src/sim/construction/types';
import type { RealmApi } from '../../../src/sim/realm/types';
import type { TerritoryApi } from '../../../src/sim/territory/types';
import type { Deposit, ResourceKind } from '../../../src/world/types';
import type { ActionOption, TargetRef } from '../../../src/sim/actions';
import { installEconomy, type EconomyRuntime } from '../../../src/sim/economy';
import { refreshTrained } from '../../../src/sim/people';
import { pickHome } from '../../../src/sim/succession';
import { fieldRole } from '../../../src/sim/farming';
import { stockHousehold } from '../../../src/sim/economy/macro';
import type { Simulation } from '../../../src/sim/sim';
import { installSocial } from '../../../src/sim/social';
import type { SocialApi, SocialHooks, TopicProvider } from '../../../src/sim/social/types';
import type { JobOffer } from '../../../src/sim/economy/types';
import { newSim, type TestSimOptions } from '../helpers';

export interface EconSim { sim: Simulation; eco: EconomyRuntime; social: SocialApi; topics: TopicProvider[]; hooks: SocialHooks }

/** A fake social system that records the topics the economy registers and knows no opinions. */
export function fakeSocial(sim: Simulation): { social: SocialApi; topics: TopicProvider[]; hooks: SocialHooks } {
  const base = installSocial(sim);
  const topics: TopicProvider[] = [];
  const opinions = new Map<string, number>();
  const hooks: SocialHooks = {};
  const social: SocialApi = {
    ...base,
    registerTopic: (t) => { topics.push(t); return () => { const i = topics.indexOf(t); if (i >= 0) topics.splice(i, 1); }; },
    setHooks: (h) => { Object.assign(hooks, h); base.setHooks?.(h); },
    opinion: (of, about) => opinions.get(`${of}:${about}`) ?? 0,
    adjustOpinion: (of, about, delta) => { const k = `${of}:${about}`; opinions.set(k, (opinions.get(k) ?? 0) + delta); },
  };
  return { social, topics, hooks };
}

const runtimes = new WeakMap<Simulation, EconomyRuntime>();

export function econSim(opts: TestSimOptions = {}): EconSim {
  const sim = newSim({ preset: 'tiny', ...opts });
  const { social, topics, hooks } = fakeSocial(sim);
  const eco = installEconomy(sim, { social });
  runtimes.set(sim, eco);
  return { sim, eco, social, topics, hooks };
}

/** The economy installed into a simulation by `econSim` (or registered with `adopt`). */
export function ecoOf(sim: Simulation): EconomyRuntime {
  const eco = runtimes.get(sim);
  if (!eco) throw new Error('no economy installed in this simulation');
  return eco;
}

export function adopt(sim: Simulation, eco: EconomyRuntime): void { runtimes.set(sim, eco); }

export function playerOf(sim: Simulation): Person {
  return sim.state.persons.get(sim.state.run.playerId) as Person;
}

/** Makes the player a household head of the given age holding `strips` strips of the village's three fields. */
export function makeFarmer(sim: Simulation, opts: { age?: number; strips?: number; role?: 0 | 1 | 2; strength?: number; stock?: boolean } = {}): { player: Person; hh: Household; strips: number[] } {
  const st = sim.state;
  const player = playerOf(sim);
  const hh = st.households.get(player.household) as Household;
  let village = sim.world.settlements.find((s) => s.id === player.settlement) ?? sim.world.settlements[0];
  if (village.strips.length === 0) {
    // born in a town or a castle: the family farms in the biggest village instead
    village = sim.world.settlements.filter((s) => s.strips.length > 0).sort((a, b) => b.strips.length - a.strips.length)[0];
    const home = pickHome(st, sim.rng('test-home'), village.id, ['cottage', 'longhouse']);
    st.relocateHousehold(hh, village.id, home ? home.id : -1);
  }
  const age = opts.age ?? 14;
  player.birthDay = Math.round(sim.absDay - age * 16);
  refreshTrained(player, ageYears(player, sim.absDay));
  player.career = 'farmer';
  player.careerStage = 0;
  if (hh.head !== player.id) st.setHead(hh, player);
  // the player's family holds only what the test gives them
  for (const id of village.strips) {
    const s = st.strips.get(id);
    if (s && s.holder === hh.id) { s.holder = 0; st.touchStrip(s); }
  }
  const mine: number[] = [];
  const wanted = (id: number): boolean => {
    const s = st.strips.get(id);
    return !!s && (opts.role === undefined || fieldRole(s.field, Math.floor(sim.absDay / 16)) === opts.role);
  };
  // free strips first; if the village has none of the wanted kind the test takes them from their tenants
  for (const pass of [0, 1]) {
    for (const id of village.strips) {
      if (mine.length >= (opts.strips ?? 3)) break;
      const s = st.strips.get(id);
      if (!s || s.holder === hh.id || !wanted(id)) continue;
      if (pass === 0 && s.holder !== 0) continue;
      s.holder = hh.id; st.touchStrip(s); mine.push(id);
    }
  }
  if (opts.strength !== undefined) { player.potential.str = opts.strength; refreshTrained(player, ageYears(player, sim.absDay)); }
  // a farm household has food for the days to the harvest, firewood, animals and seed corn for its strips
  const eco = runtimes.get(sim);
  if (eco && opts.stock !== false) {
    for (const k of Object.keys(hh.stores)) delete hh.stores[k];
    stockHousehold(eco.econ, hh, true);
  }
  return { player, hh, strips: mine };
}

/** Starts an option and steps the simulation until the action (and its repeats, if `repeats` > 0) finish. */
export function perform(sim: Simulation, option: ActionOption, repeats = 0): { ok: boolean; message?: string } {
  const actor = sim.state.run.playerId;
  let done = 0;
  let last: { ok: boolean; message?: string } = { ok: true };
  // listen before starting: an instant action completes inside start()
  const off = sim.actions.onEvent((e) => { if (e.type === 'completed') { done++; last = e.outcome; } });
  const first = sim.actions.start(actor, option);
  if (!first.ok) { off(); return first; }
  let guard = 0;
  const target = repeats + 1;
  // a bout is at most ~60 seconds of simulated time; 20 steps a second
  while (sim.actions.active(actor) && done < target && guard++ < 60 * 20 * 3) sim.step(1 / 20);
  if (done >= target) sim.actions.cancel(actor);
  off();
  return last;
}

export function optionsFor(sim: Simulation, target: TargetRef): ActionOption[] {
  return sim.actions.list(sim.state.run.playerId, target);
}

export function find(options: ActionOption[], id: string): ActionOption | undefined {
  return options.find((o) => o.id === id);
}

/** Runs the same option again and again while it stays enabled; returns how many bouts ran. */
export function grind(sim: Simulation, target: TargetRef, id: string, max = 60): number {
  let n = 0;
  for (; n < max; n++) {
    const o = find(optionsFor(sim, target), id);
    if (!o || !o.enabled) break;
    const r = perform(sim, o);
    if (!r.ok) break;
  }
  return n;
}

// ---------------------------------------------------------------------------------------------
// A scripted worker: takes the first enabled option it likes, eats and sleeps as a sensible person would
// ---------------------------------------------------------------------------------------------

export interface WorkSpec {
  /** The player's home (the family table for meals). */
  home: TargetRef;
  /** Places to look for work, in order of preference. */
  targets: TargetRef[];
  /** Option ids worth doing. */
  accept: RegExp;
  /** Option ids never to start. */
  reject?: RegExp;
  /** Game days to work (the run also ends when `until` returns true). */
  days: number;
  until?: () => boolean;
  /** Counts of completed actions by id, and a short log. */
  counts?: Record<string, number>;
  log?: string[];
  /** Hours to let pass when there is nothing to do (default 6). */
  idleHours?: number;
}

/** Runs the scripted worker; returns the game days used. */
export function runWork(sim: Simulation, spec: WorkSpec): number {
  const player = playerOf(sim);
  const start = sim.absDay;
  const counts = spec.counts ?? {};
  const note = (o: ActionOption, msg?: string): void => {
    counts[o.id] = (counts[o.id] ?? 0) + 1;
    if (spec.log && spec.log.length < 500) spec.log.push(`${(sim.absDay - start).toFixed(1)} ${o.id}${msg ? `: ${msg}` : ''}`);
  };
  for (let iter = 0; iter < 6000 && sim.absDay - start < spec.days; iter++) {
    if (spec.until?.()) break;
    if (sim.state.run.phase !== 'alive') break;
    if (player.needs.hunger < 0.45) {
      const eat = find(optionsFor(sim, spec.home), 'eat.home');
      if (eat?.enabled) perform(sim, eat);
    }
    if (player.needs.rest < 0.2) {
      sim.dispatch({ type: 'sleep' });
      let g = 0;
      while (sim.clock.skip && g++ < 2000) sim.step(0.25);
    }
    let acted = false;
    for (const t of spec.targets) {
      const o = optionsFor(sim, t).find((x) => x.enabled && spec.accept.test(x.id) && !(spec.reject && spec.reject.test(x.id)));
      if (!o) continue;
      const r = perform(sim, o);
      if (r.ok) { note(o, r.message); acted = true; break; }
    }
    if (!acted) sim.advanceHours(spec.idleHours ?? 6);
  }
  return sim.absDay - start;
}

/**
 * Makes the player a free-born boy of `age` living where a master takes apprentices with the given title
 * ("Apprentice smith"), with money in the family purse for the premium. Returns the post and its workshop.
 */
export function makeApprentice(sim: Simulation, opts: { age?: number; title?: string; purse?: number } = {}): { player: Person; hh: Household; job: JobOffer; shop: number; settlement: number } {
  const st = sim.state;
  const eco = ecoOf(sim);
  const player = playerOf(sim);
  const hh = st.households.get(player.household) as Household;
  const title = opts.title ?? 'Apprentice smith';
  player.sex = 'm';
  player.estate = 'free';
  player.birthDay = Math.round(sim.absDay - (opts.age ?? 12) * 16);
  refreshTrained(player, ageYears(player, sim.absDay));
  player.career = 'child';
  player.careerStage = 0;
  hh.purse = opts.purse ?? 600;
  let found: JobOffer | undefined;
  // the player's own settlement first, then the others
  const order = [...sim.world.settlements].sort((a, b) => (a.id === player.settlement ? -1 : 0) - (b.id === player.settlement ? -1 : 0) || a.id - b.id);
  for (const s of order) {
    found = eco.jobs(s.id, player.id).find((j) => j.title === title && j.building !== undefined);
    if (found) break;
  }
  if (!found) throw new Error(`nobody in the test world takes an "${title}"`);
  if (hh.settlement !== found.settlement) {
    const home = pickHome(st, sim.rng('test-home'), found.settlement, ['cottage', 'longhouse', 'townhouse']);
    st.relocateHousehold(hh, found.settlement, home ? home.id : -1);
  }
  st.touch(player);
  st.touchHousehold(hh);
  return { player, hh, job: found, shop: found.building as number, settlement: found.settlement };
}

// ---------------------------------------------------------------------------------------------
// A scripted player: works the household's strips, eats and sleeps as a sensible person would
// ---------------------------------------------------------------------------------------------

export interface FarmBot {
  sim: Simulation;
  strips: number[];
  home: TargetRef;
  mill: TargetRef | null;
  /** How many times each action id ran to completion. */
  counts: Record<string, number>;
  log: string[];
  bouts: number;
}

export function farmBot(sim: Simulation, strips: number[], hh: Household): FarmBot {
  const player = playerOf(sim);
  const village = sim.world.settlements.find((s) => s.id === player.settlement);
  const mill = village ? sim.state.buildingsAt.get(village.id)?.find((b) => b.kind === 'watermill' || b.kind === 'windmill') : undefined;
  return { sim, strips, home: { kind: 'building', id: hh.home }, mill: mill ? { kind: 'building', id: mill.id } : null, counts: {}, log: [], bouts: 0 };
}

export interface BotOptions {
  /** Mill the household's grain at the mill (default false: keep it as grain). */
  mill?: boolean;
  /** Stop the run as soon as this returns true. */
  until?: () => boolean;
  /** Ids the bot must not start. */
  skip?: RegExp;
}

/** Runs the scripted player for `days` of game time (or until `opts.until`). Returns the game days actually used. */
export function runBot(bot: FarmBot, days: number, opts: BotOptions = {}): number {
  const { sim } = bot;
  const player = playerOf(sim);
  const start = sim.absDay;
  const note = (id: string, msg?: string): void => {
    bot.counts[id] = (bot.counts[id] ?? 0) + 1;
    bot.bouts++;
    if (bot.log.length < 400) bot.log.push(`${(sim.absDay - start).toFixed(1)} ${id}${msg ? `: ${msg}` : ''}`);
  };
  const start1 = (o: ActionOption | undefined): boolean => {
    if (!o || !o.enabled || (opts.skip && opts.skip.test(o.id))) return false;
    const r = perform(sim, o);
    if (r.ok) note(o.id, r.message);
    return r.ok;
  };
  for (let iter = 0; iter < 4000 && sim.absDay - start < days; iter++) {
    if (opts.until?.()) break;
    if (sim.state.run.phase !== 'alive') break;
    if (player.needs.hunger < 0.45) start1(find(optionsFor(sim, bot.home), 'eat.home'));
    if (player.needs.rest < 0.2) {
      sim.dispatch({ type: 'sleep' });
      let g = 0;
      while (sim.clock.skip && g++ < 2000) sim.step(0.25);
    }
    let acted = false;
    for (const id of bot.strips) {
      const o = optionsFor(sim, { kind: 'strip', id }).find((x) => x.enabled && x.id !== 'farm.wait' && x.id !== 'farm.manure' && x.id !== 'farm.hire_on');
      if (o && start1(o)) { acted = true; break; }
    }
    if (!acted) {
      const barn = optionsFor(sim, bot.home).filter((o) => /^farm\.(unload|thresh|winnow)/.test(o.id) && o.enabled).sort((a, b) => b.priority - a.priority)[0];
      if (barn && start1(barn)) acted = true;
    }
    if (!acted && opts.mill && bot.mill) {
      if (start1(find(optionsFor(sim, bot.mill), 'farm.mill'))) acted = true;
    }
    if (!acted) sim.advanceHours(6);
  }
  return sim.absDay - start;
}

// ---------------------------------------------------------------------------------------------
// Civilization pass: buildings raised in play, fake neighbours (territory, construction, realm)
// ---------------------------------------------------------------------------------------------

/** Raises a finished (or part-built) building the way the construction module does: a real BuildingState, plot -1. */
export function raise(sim: Simulation, kind: BuildingKind, o: { settlement?: number; household?: number; construction?: number; level?: number; at?: { x: number; z: number } } = {}): BuildingState {
  const st = sim.state;
  const sid = o.settlement ?? playerOf(sim).settlement;
  const s = sim.world.settlements.find((x) => x.id === sid) ?? sim.world.settlements[0];
  const n = st.nextBuildingId++;
  const b: BuildingState = {
    id: n, plot: -1, kind, level: o.level ?? 1, settlement: s.id, construction: o.construction ?? 1, damage: 0, onFire: false, owner: 0,
    household: o.household ?? 0, occupied: false, x: o.at?.x ?? s.x + 30 + (n % 7) * 3, z: o.at?.z ?? s.z + 30 + (n % 5) * 3, rot: 0, culture: 'anglo', seed: n,
  };
  st.buildings.set(b.id, b);
  let list = st.buildingsAt.get(s.id);
  if (!list) { list = []; st.buildingsAt.set(s.id, list); }
  list.push(b);
  st.touchBuilding(b);
  return b;
}

/** A territory service that knows the deposits it is given (the rest of its contract is the placeholder's). */
export function fakeTerritory(sim: Simulation, deposits: Array<Omit<Deposit, 'id' | 'settlement'> & { settlement?: number }>): TerritoryApi {
  const all: Deposit[] = deposits.map((d, id) => ({ settlement: -1, ...d, id }));
  const near = (x: number, z: number, r: number, kind?: ResourceKind): Deposit[] => all.filter((d) => (!kind || d.kind === kind) && Math.hypot(d.x - x, d.z - z) <= r + d.radius);
  const api: TerritoryApi = {
    landAt: () => ({ kind: 'wild', settlement: -1, house: 0, title: 0, household: 0, strip: -1, parcel: -1, building: -1 }),
    trespass: () => ({ level: 'none', land: api.landAt(0, 0), reason: '' }),
    settlementOf: (x, z) => sim.world.settlementAt(x, z)?.id ?? -1,
    landsRadius: () => 2500,
    resources: (settlement) => ({ settlement, deposits: all, forest: 0, fertility: 0, coast: false, river: false, yields: [] }),
    deposits: () => all,
    depositsNear: near,
    depositAt: (x, z, kind) => near(x, z, 0, kind)[0] ?? null,
    version: () => all.length,
  };
  sim.services.territory = api;
  return api;
}

/** A construction service with the sites it is given. */
export function fakeConstruction(sim: Simulation, sites: SiteView[]): ConstructionApi {
  const api = {
    sites: (settlement?: number) => sites.filter((s) => settlement === undefined || s.settlement === settlement),
    site: (id: number) => sites.find((s) => s.id === id) ?? null,
    siteOf: (b: number) => sites.find((s) => s.building === b) ?? null,
    workersAt: () => [],
    outposts: () => [],
    version: () => sites.length,
  } as unknown as ConstructionApi;
  sim.services.construction = api;
  return api;
}

/** A realm service that answers the crop plan (and nothing else of value). */
export function fakeRealm(sim: Simulation, plan: Record<number, Record<0 | 1 | 2, string>>): RealmApi {
  const api = { cropPlan: (settlement: number) => plan[settlement] ?? { 0: 'fallow', 1: 'fallow', 2: 'fallow' }, worksShare: () => 0, version: () => 0 } as unknown as RealmApi;
  sim.services.realm = api;
  return api;
}

/** Gives the player a household with the animals given, in the village where the family farms. */
export function stockPlayer(sim: Simulation, animals: Record<string, number>, o: { age?: number; strength?: number } = {}): { player: Person; hh: Household } {
  const { player, hh } = makeFarmer(sim, { age: o.age ?? 20, strips: 1, strength: o.strength ?? 12 });
  for (const [k, v] of Object.entries(animals)) hh.stores[k] = v;
  sim.state.touchHousehold(hh);
  return { player, hh };
}
