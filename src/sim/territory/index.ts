// Territory (civilization pass, docs/CIV.md §4, §7): who owns the land, who may be where, what the land holds.
// PLACEHOLDER — the contract's shape with "everything is wild, nothing is forbidden"; replaced by Builder A1.
import type { Simulation } from '../sim';
import type { Wave3Deps } from '../wave3deps';
import type { LandInfo, ResourceProfile, TerritoryApi } from './types';

export function installTerritory(sim: Simulation, _deps: Wave3Deps): TerritoryApi {
  const wild = (): LandInfo => ({ kind: 'wild', settlement: -1, house: 0, title: 0, household: 0, strip: -1, parcel: -1, building: -1 });
  const api: TerritoryApi = {
    landAt: () => wild(),
    trespass: () => ({ level: 'none', land: wild(), reason: '' }),
    settlementOf: (x, z) => sim.world.settlementAt(x, z)?.id ?? -1,
    landsRadius: () => 2500,
    resources: (settlement): ResourceProfile => ({ settlement, deposits: [], forest: 0, fertility: 0, coast: false, river: false, yields: [] }),
    deposits: () => sim.world.deposits ?? [],
    depositsNear: () => [],
    depositAt: () => null,
    version: () => 0,
  };
  sim.services.territory = api;
  return api;
}
