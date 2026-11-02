// Realm (civilization pass, docs/CIV.md §6, §7, §10): ruling - who rules a place, the treasury and stores, research paid in each
// branch's currencies, recruiting and knighting, the field plan, labour sent to the works, the steward's trade orders, news of
// neighbours and rivals. `installRealm(sim, deps)` registers `sim.services.realm` and a few light calendar jobs (research, wages,
// trade orders, news, books - each at an hour of its own); it works headless, and finds the other modules (advancement, military,
// politics, construction, territory) lazily on `sim.services`, any of which may be absent. See docs/REALM.md.
import type { Simulation } from '../sim';
import type { Wave3Deps } from '../wave3deps';
import { closeBooks, yearOf } from './books';
import { HOURS } from './config';
import { installNews, newsDaily, newsList, newsYearly, rivalsOf } from './news';
import { cropPlan, cropPlanView, setCropPlan, setWorksShare, worksShare } from './plans';
import { discharge, dub, recruit, recruitOptions, troopsDaily, troopsOf } from './recruit';
import { projectsOf, researchDaily, researchOptions, startResearch, stopResearch } from './research';
import { canRule, rulerOf, rulesOf, scopeOf, viewOf } from './rule';
import { Rlm } from './store';
import { addTradeOrder, removeTradeOrder, tradeDaily, tradeOrders } from './trade';
import type { RealmApi } from './types';

export type * from './types';

/** The realm API plus the module's internals (tests, tools and the dev pages). */
export interface RealmRuntime extends RealmApi {
  readonly ctx: Rlm;
  /** Removes the systems and listeners this install registered. */
  dispose(): void;
}

const installed = new WeakMap<Simulation, RealmRuntime>();

/** The runtime installed in a simulation, if any. */
export function realmOf(sim: Simulation): RealmRuntime | undefined { return installed.get(sim); }

/** The module's internal context (tests and tools). */
export function realmContext(sim: Simulation): Rlm {
  const r = installed.get(sim);
  if (!r) throw new Error('installRealm has not run for this simulation');
  return r.ctx;
}

export function installRealm(sim: Simulation, deps: Wave3Deps): RealmRuntime {
  const existing = installed.get(sim);
  if (existing) return existing;
  const R = new Rlm(sim, { economy: deps.economy, social: deps.social });
  const offs: Array<() => void> = [];

  // ---- the calendar's jobs, one per hour so that no frame carries them all ----
  offs.push(sim.registerSystem({
    name: 'realm.hour', phase: 'hourly', order: 80,
    run: (_ctx, info) => {
      const h = info.hour;
      if (h >= HOURS.research.from && h < HOURS.research.from + HOURS.research.shards) researchDaily(R, h - HOURS.research.from, HOURS.research.shards);
      else if (h === HOURS.troops) troopsDaily(R);
      else if (h >= HOURS.trade.from && h < HOURS.trade.from + HOURS.trade.shards) tradeDaily(R, h - HOURS.trade.from, HOURS.trade.shards);
      else if (h === HOURS.news) newsDaily(R);
      else if (h === HOURS.books) closeBooks(R);
    },
  }));
  offs.push(sim.registerSystem({ name: 'realm.year', phase: 'yearly', order: 80, run: () => newsYearly(R) }));

  // ---- what changes who rules, and what the ruler panel shows ----
  offs.push(installNews(R));
  for (const ev of ['inheritance', 'death', 'office', 'playerSwitched', 'captured'] as const) offs.push(sim.events.on(ev, () => { R.version++; }));

  const api: RealmRuntime = {
    ctx: R,
    dispose() {
      for (const off of offs.splice(0)) off();
      if (sim.services.realm === api) delete sim.services.realm;
      installed.delete(sim);
    },

    rulerOf: (settlement) => rulerOf(R, settlement),
    canRule: (person) => canRule(R, person),
    view: (person) => viewOf(R, person),
    rules: (person) => rulesOf(R, person),

    researchOptions: (person) => researchOptions(R, person),
    startResearch: (person, tech, researcher, building, opts) => startResearch(R, person, tech, researcher, building, opts),
    stopResearch: (person, project) => stopResearch(R, person, project),
    projects: (house) => projectsOf(R, house),

    recruitOptions: (person, settlement) => recruitOptions(R, person, settlement),
    recruit: (person, settlement, kind, count) => recruit(R, person, settlement, kind, count),
    dub: (person, candidate) => dub(R, person, candidate),
    troops: (person, settlement) => troopsOf(R, person, settlement),
    discharge: (person, man) => discharge(R, person, man),

    cropPlan: (settlement) => cropPlan(R, settlement),
    setCropPlan: (person, settlement, field, crop) => setCropPlan(R, person, settlement, field, crop),
    cropPlanView: (settlement) => cropPlanView(R, settlement),
    worksShare: (settlement) => worksShare(R, settlement),
    setWorksShare: (person, settlement, share) => setWorksShare(R, person, settlement, share),

    tradeOrders: (person) => tradeOrders(R, person),
    addTradeOrder: (person, order) => addTradeOrder(R, person, order),
    removeTradeOrder: (person, id) => removeTradeOrder(R, person, id),

    news: (limit) => newsList(R, limit),
    rivals: (person) => rivalsOf(R, person),
    accounts: (person) => {
      const sc = scopeOf(R, person);
      return sc && sc.treasury ? yearOf(R, sc.treasury.id).lines : [];
    },
    version: () => R.version,
  };
  sim.services.realm = api;
  installed.set(sim, api);
  return api;
}
