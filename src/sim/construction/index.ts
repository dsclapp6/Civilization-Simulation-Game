// Construction (civilization pass, docs/CIV.md §5): raising, upgrading, repairing and pulling down buildings.
// PLACEHOLDER — the contract's shape with nothing buildable; replaced by Builder A2.
import type { Simulation } from '../sim';
import type { Wave3Deps } from '../wave3deps';
import type { ConstructionApi } from './types';

export function installConstruction(sim: Simulation, _deps: Wave3Deps): ConstructionApi {
  const no = { ok: false, reason: 'Building is not available yet' };
  const api: ConstructionApi = {
    scope: (person) => ({ person, settlements: [], own: [], outposts: false, label: '', household: 0, house: 0 }),
    catalogue: () => [],
    check: (_p, _k, x, z, rot) => ({ ok: false, reason: no.reason, x, z, rot, settlement: -1, footprint: [] }),
    place: () => no,
    upgrade: () => no,
    repair: () => no,
    demolish: () => no,
    cancel: () => no,
    setPriority: () => no,
    sites: () => [],
    site: () => null,
    siteOf: () => null,
    outposts: () => [],
    cost: () => ({ goods: {}, labour: 0, pence: 0 }),
    suggestSpot: () => null,
    workersAt: () => [],
    version: () => 0,
  };
  sim.services.construction = api;
  return api;
}
