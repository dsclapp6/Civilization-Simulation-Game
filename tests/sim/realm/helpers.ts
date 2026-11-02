// A simulation with the modules the realm works with installed: social, economy (with a stand-in market for `procure`/`sell`,
// which another builder implements), politics, military, advancement and the realm itself.
import type { BuildingKind } from '../../../src/content/types';
import { installAdvancement, type AdvancementInstall } from '../../../src/sim/advancement';
import { installEconomy, type EconomyRuntime } from '../../../src/sim/economy';
import type { EconomyApi } from '../../../src/sim/economy/types';
import { installMilitary } from '../../../src/sim/military';
import type { MilitaryRuntime } from '../../../src/sim/military/types';
import { installPolitics, type PoliticsRuntime } from '../../../src/sim/politics';
import { installRealm, type RealmRuntime } from '../../../src/sim/realm';
import type { Rlm } from '../../../src/sim/realm/store';
import type { Simulation } from '../../../src/sim/sim';
import { installSocial } from '../../../src/sim/social';
import type { SocialApi } from '../../../src/sim/social/types';
import { createPerson } from '../../../src/sim/people';
import type { BuildingState, Household, Person, Title } from '../../../src/sim/state';
import { newSim, noPlayer, type TestSimOptions } from '../helpers';

/** A market that sells what it is told to and buys everything: `procure` and `sell` as the economy will give them. */
export interface MarketStub {
  /** Stock per settlement and good; a good without an entry is unlimited unless `strict`. */
  stock: Record<number, Record<string, number>>;
  strict: boolean;
  /** Days goods take to arrive. */
  days: number;
  calls: Array<{ fn: 'procure' | 'sell'; household: number; good: string; qty: number; got: number; money: number }>;
  pending: Array<{ day: number; household: number; good: string; qty: number }>;
}

export interface RealmSim {
  sim: Simulation;
  social: SocialApi;
  economy: EconomyRuntime;
  /** What the realm was given as the economy: the runtime with the stand-in market's `procure` and `sell` (absent with `market: false`). */
  deps: { economy: EconomyApi; social: SocialApi };
  adv: AdvancementInstall;
  pol?: PoliticsRuntime;
  mil?: MilitaryRuntime;
  realm: RealmRuntime;
  R: Rlm;
  market: MarketStub;
}

export interface RealmSimOptions extends TestSimOptions {
  politics?: boolean;
  military?: boolean;
  /** Give the realm a `procure`/`sell`: the stand-in market (true, default), none (false), or the economy's own ('real'). */
  market?: boolean | 'real';
  /** Keep the player (default: removed, so a long run cannot end in game over). */
  keepPlayer?: boolean;
  noon?: boolean;
}

export function realmSim(opts: RealmSimOptions = {}): RealmSim {
  const sim = newSim({ preset: 'small', ...opts });
  if (!opts.keepPlayer) noPlayer(sim);
  return bootRealm(sim, opts);
}

/** Installs the modules on a simulation (a fresh one, or one just loaded from a save) in the order the game does. */
export function bootRealm(sim: Simulation, opts: RealmSimOptions = {}): RealmSim {
  const social = installSocial(sim);
  const economy = installEconomy(sim, { social });
  const deps0 = { economy, social };
  const pol = opts.politics ? installPolitics(sim, deps0) : undefined;
  const mil = opts.military ? installMilitary(sim, deps0) : undefined;
  const adv = installAdvancement(sim, deps0);
  const market: MarketStub = { stock: {}, strict: false, days: 1, calls: [], pending: [] };
  // `market: false` is a realm with no merchant to deal with: the real economy without its household trade (`procure`/`sell`)
  const eco: EconomyApi = opts.market === 'real' ? economy
    : opts.market === false ? { ...economy, procure: undefined, sell: undefined } : stubEconomy(sim, economy, market);
  const deps = { economy: eco, social };
  const realm = installRealm(sim, deps);
  if (opts.market !== false && opts.market !== 'real') {
    sim.registerSystem({
      name: 'stub.deliver', phase: 'hourly', order: 5,
      run: () => {
        for (const p of market.pending.slice()) {
          if (p.day > sim.absDay) continue;
          market.pending.splice(market.pending.indexOf(p), 1);
          const hh = sim.state.households.get(p.household);
          if (hh) { hh.stores[p.good] = Math.round(((hh.stores[p.good] ?? 0) + p.qty) * 100) / 100; sim.state.touchHousehold(hh); }
        }
      },
    });
  }
  return { sim, social, economy, deps, adv, pol: pol as PoliticsRuntime | undefined, mil: mil as MilitaryRuntime | undefined, realm, R: realm.ctx, market };
}

function stubEconomy(sim: Simulation, economy: EconomyRuntime, m: MarketStub): EconomyApi {
  const price = (settlement: number, good: string, side: 'buy' | 'sell'): number => economy.price(settlement, good, side);
  return {
    ...economy,
    procure(household, good, qty, opts) {
      const hh = sim.state.households.get(household);
      if (!hh) return { got: 0, cost: 0, settlement: -1, days: 0 };
      const settlement = opts?.settlement ?? hh.settlement;
      const stock = m.stock[settlement] ?? (m.stock[settlement] = {});
      const have = stock[good] ?? (m.strict ? 0 : 1e9);
      const unit = price(settlement, good, 'buy');
      if (opts?.maxPrice && unit > opts.maxPrice) return { got: 0, cost: 0, settlement, days: 0 };
      let got = Math.min(qty, have);
      if (unit > 0) got = Math.min(got, Math.floor(hh.purse / unit));
      if (got <= 0) return { got: 0, cost: 0, settlement, days: 0 };
      const cost = Math.round(got * unit * 100) / 100;
      hh.purse = Math.round((hh.purse - cost) * 100) / 100;
      if (stock[good] !== undefined) stock[good] -= got;
      sim.state.touchHousehold(hh);
      if (m.days > 0) m.pending.push({ day: sim.absDay + m.days, household, good, qty: got });
      else { hh.stores[good] = Math.round(((hh.stores[good] ?? 0) + got) * 100) / 100; }
      m.calls.push({ fn: 'procure', household, good, qty, got, money: cost });
      return { got, cost, settlement, days: m.days };
    },
    sell(household, good, qty, opts) {
      const hh = sim.state.households.get(household);
      if (!hh) return { sold: 0, income: 0, settlement: -1 };
      const settlement = opts?.settlement ?? hh.settlement;
      const unit = price(settlement, good, 'sell');
      if (opts?.minPrice && unit < opts.minPrice) return { sold: 0, income: 0, settlement };
      const have = hh.stores[good] ?? 0;
      const sold = Math.min(qty, have);
      if (sold <= 0) return { sold: 0, income: 0, settlement };
      const income = Math.round(sold * unit * 100) / 100;
      hh.stores[good] = Math.round((have - sold) * 100) / 100;
      if (hh.stores[good] <= 0.004) delete hh.stores[good];
      hh.purse = Math.round((hh.purse + income) * 100) / 100;
      sim.state.touchHousehold(hh);
      m.calls.push({ fn: 'sell', household, good, qty, got: sold, money: income });
      return { sold, income, settlement };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Finding people and places
// ---------------------------------------------------------------------------------------------

export function titlesOfKind(sim: Simulation, kind: Title['kind']): Title[] {
  return [...sim.state.titles.values()].filter((t) => t.kind === kind).sort((a, b) => a.id - b.id);
}

export function holderOf(sim: Simulation, t: Title): Person {
  return sim.state.persons.get(t.holder) as Person;
}

export function householdOf(sim: Simulation, p: Person): Household {
  return sim.state.households.get(p.household) as Household;
}

/** The first manor lord of the world (a landed knight with a household), his title and his village. */
export function aManor(sim: Simulation): { title: Title; lord: Person; hh: Household; settlement: number } {
  const title = titlesOfKind(sim, 'manor')[0];
  const lord = holderOf(sim, title);
  return { title, lord, hh: householdOf(sim, lord), settlement: title.place };
}

/** Makes a grown man in a settlement (in a household of its own, not the head's). */
export function aMan(sim: Simulation, settlement: number, opts: { age?: number; str?: number; end?: number; career?: Person['career']; household?: Household } = {}): Person {
  const st = sim.state;
  const hh = opts.household ?? st.addHousehold({ id: st.households.alloc(), kind: 'family', head: 0, members: [], home: -1, settlement, purse: 50, stores: {} });
  const p = createPerson(st, st.rng('test-man'), {
    culture: 'anglo', sex: 'm', age: opts.age ?? 22, day: sim.absDay, settlement, household: hh, house: 0, career: opts.career ?? 'labourer', stage: 0, tier: 2, estate: 'free',
  });
  st.joinHousehold(p, hh);
  if (!hh.head) st.setHead(hh, p);
  p.trained.str = opts.str ?? 13; p.trained.end = opts.end ?? 12; p.trained.agi = 11; p.trained.per = 10;
  p.health.hp = 1;
  st.touch(p);
  return p;
}

/** Fills a settlement with `n` strong young men who live in households as brothers (so they may be recruited without breaking a household up). */
export function youths(sim: Simulation, settlement: number, n: number): Person[] {
  const out: Person[] = [];
  const st = sim.state;
  const hh = st.addHousehold({ id: st.households.alloc(), kind: 'family', head: 0, members: [], home: -1, settlement, purse: 50, stores: {} });
  const head = aMan(sim, settlement, { age: 50, household: hh });
  void head;
  for (let i = 0; i < n; i++) out.push(aMan(sim, settlement, { age: 18 + (i % 8), str: 12 + (i % 4), end: 11 + (i % 3), household: hh }));
  return out;
}

/** Adds goods to a household's stores. */
export function stock(sim: Simulation, hh: Household, goods: Record<string, number>): void {
  for (const [k, v] of Object.entries(goods)) hh.stores[k] = Math.round(((hh.stores[k] ?? 0) + v) * 100) / 100;
  sim.state.touchHousehold(hh);
}

/** Puts the clock at an hour of the day. */
export function runToHour(sim: Simulation, hour: number): void {
  const frac = ((sim.absDay % 1) + 1) % 1;
  let hours = hour - Math.floor(frac * 24 + 1e-6);
  if (hours <= 0) hours += 24;
  sim.advanceHours(hours);
}

/** Sets the calendar to an absolute day (and the hours as fired, so that nothing catches up). */
export function setDay(sim: Simulation, absDay: number): void {
  sim.state.clock.absDay = absDay;
  sim.state.clock.firedHour = Math.floor(absDay * 24 + 1e-6);
}

/** Raises a finished building of a kind in a settlement (a smithy, a school, a barracks…), as a hand-made scenario needs it. */
export function addBuilding(sim: Simulation, settlement: number, kind: BuildingKind, level = 1): BuildingState {
  const st = sim.state;
  const s = sim.world.settlements.find((x) => x.id === settlement) as { x: number; z: number; culture: BuildingState['culture'] };
  const b: BuildingState = {
    id: st.nextBuildingId++, plot: -1, kind, level, settlement, construction: 1, damage: 0, onFire: false, owner: 0, household: 0,
    occupied: false, x: s.x, z: s.z, rot: 0, culture: s.culture, seed: 1,
  };
  st.buildings.set(b.id, b);
  const list = st.buildingsAt.get(settlement) ?? [];
  list.push(b);
  st.buildingsAt.set(settlement, list);
  st.touchBuilding(b);
  return b;
}

/** Takes a technique away from everyone (so the House lacks it). */
export function forget(r: Pick<RealmSim, 'adv'>, tech: string): void {
  for (const id of r.adv.holders(tech).slice()) r.adv.adv.removeHolder(id, tech);
  delete r.adv.adv.save.rec[tech];
  delete r.adv.adv.save.lost[tech];
}
