// Realm (civilization pass, docs/CIV.md §6, §7, §10): ruling — treasury and stores, research, recruiting, the field plan,
// works labour, trade orders, knighting, news and rivals. PLACEHOLDER — the contract's shape; replaced by Builder A3.
import type { Simulation } from '../sim';
import type { Wave3Deps } from '../wave3deps';
import type { RealmApi } from './types';

export function installRealm(sim: Simulation, _deps: Wave3Deps): RealmApi {
  const no = { ok: false, reason: 'Ruling is not available yet' };
  const api: RealmApi = {
    rulerOf: () => 0,
    canRule: () => false,
    view: () => null,
    researchOptions: () => [],
    startResearch: () => no,
    stopResearch: () => no,
    projects: () => [],
    recruitOptions: () => [],
    recruit: () => no,
    dub: () => no,
    cropPlan: () => ({ 0: 'fallow', 1: 'fallow', 2: 'fallow' }),
    setCropPlan: () => no,
    worksShare: () => 0,
    setWorksShare: () => no,
    tradeOrders: () => [],
    addTradeOrder: () => no,
    removeTradeOrder: () => no,
    news: () => [],
    rivals: () => [],
    version: () => 0,
  };
  sim.services.realm = api;
  return api;
}
