// Construction (civilization pass, docs/CIV.md §5): raising, upgrading, repairing and pulling down buildings, for the player and the
// AI alike. `installConstruction(sim, deps)` registers `sim.services.construction` (the `ConstructionApi` of types.ts), the hourly
// system that plans each morning and puts in each working hour, and the action provider for the player's own hands on a site.
// Costs and rules are content (src/content/construction.json); the saved data is in state.ext['construction']. Everything works
// headless; the territory, economy (`procure`), realm and advancement services are looked up lazily and may be missing.
import { BUILDINGS, type BuildingKind } from '../../content/types';
import type { P2 } from '../../core/math';
import type { Simulation } from '../sim';
import type { PersonId } from '../state';
import type { Wave3Deps } from '../wave3deps';
import { evaluate, suggest } from './check';
import { catalogue } from './catalogue';
import { constructionProvider } from './actions';
import { Construction } from './core';
import { levelCost } from './data';
import { PLAN_SHARDS, hourly, planNow } from './progress';
import { noScopeReason, scopeInfo } from './scope';
import {
  applyRazed, canManageSite, cancelSite, demolishSite, repairSite, setHired, setPriority, placeSite, upgradeSite, viewOf,
} from './sites';
import type {
  BuildScope, ConstructionApi, OutpostView, PlacementCheck, SiteView,
} from './types';

export type { ConstructionApi } from './types';
export { Construction } from './core';

export interface ConstructionInstall extends ConstructionApi {
  /** The module's runtime (tests, tools, the debug page). */
  readonly core: Construction;
}

const installed = new WeakMap<Simulation, ConstructionInstall>();

export function installConstruction(sim: Simulation, deps: Wave3Deps): ConstructionInstall {
  const existing = installed.get(sim);
  if (existing) return existing;
  const C = new Construction(sim, deps);
  // buildings the world's own plots made but an earlier session had pulled down
  applyRazed(C);
  C.planNow = (rec) => planNow(C, rec);

  const offs: Array<() => void> = [];
  offs.push(sim.registerSystem({ name: 'construction.hourly', phase: 'hourly', order: 70, shards: PLAN_SHARDS, run: (_ctx, info, shard = 0) => hourly(C, info, shard) }));
  offs.push(sim.actions.register(constructionProvider(C)));

  let memoKey = '';
  let memo: PlacementCheck | null = null;
  let sitesKey = '';
  let sitesMemo: SiteView[] = [];

  const open = (settlement?: number): SiteView[] => {
    const key = `${C.version}|${Math.floor(sim.absDay * 24)}|${C.playerSite()}`;
    if (key !== sitesKey) {
      sitesKey = key;
      sitesMemo = C.openSites().sort((a, b) => a.priority - b.priority || a.id - b.id).map((r) => viewOf(C, r));
    }
    return settlement === undefined ? sitesMemo : sitesMemo.filter((s) => s.settlement === settlement);
  };

  const api: ConstructionInstall = {
    core: C,

    scope(person: PersonId): BuildScope {
      const si = scopeInfo(C, person);
      const p = C.person(person);
      if (!si) {
        return { person, settlements: [], own: [], outposts: false, label: noScopeReason(C, person), household: p?.household ?? 0, house: p?.house ?? 0, rank: p?.rankTier, role: 'none', agentFor: [] };
      }
      const own: number[] = [];
      if (si.own) {
        if (si.own.home >= 0) own.push(si.own.home);
        for (const b of C.state.buildingsAt.get(si.own.settlement) ?? []) if (b.household === si.own.id && !own.includes(b.id)) own.push(b.id);
      }
      const settlements = [...si.auth.keys()].sort((a, b) => a - b);
      const agentFor = [...si.auth.values()].filter((a) => a.kind !== 'lord').map((a) => a.settlement).sort((a, b) => a - b);
      const payer = si.payer ?? si.own;
      return {
        person, settlements, own: own.sort((a, b) => a - b), outposts: si.outposts, label: si.label, household: payer?.id ?? 0,
        house: si.house, rank: si.rank, role: si.role, agentFor,
      };
    },

    catalogue: (person, settlement) => catalogue(C, person, settlement),

    check(person, kind, x, z, rot): PlacementCheck {
      const key = `${person}|${kind}|${x}|${z}|${rot}|${C.version}|${sim.state.buildingRevision}|${sim.services.territory?.version() ?? 0}|${Math.floor(sim.absDay)}`;
      if (key === memoKey && memo) return memo;
      const out = evaluate(C, person, kind, x, z, rot).check;
      memoKey = key;
      memo = out;
      return out;
    },

    place: (person, kind, x, z, rot, opts) => { memoKey = ''; return placeSite(C, person, kind, x, z, rot, opts); },
    upgrade: (person, building) => upgradeSite(C, person, building),
    repair: (person, building) => repairSite(C, person, building),
    demolish: (person, building) => demolishSite(C, person, building),
    cancel: (person, site) => { memoKey = ''; return cancelSite(C, person, site); },
    setPriority: (person, site, priority) => setPriority(C, person, site, priority),

    sites: (settlement) => open(settlement),
    site(id: number): SiteView | null {
      const rec = C.sitesById.get(id);
      return rec ? viewOf(C, rec) : null;
    },
    siteOf(building: number): SiteView | null {
      const rec = C.openByBuilding.get(building);
      return rec ? viewOf(C, rec) : null;
    },

    outposts(): readonly OutpostView[] {
      return C.save.outposts.map((o) => ({ id: o.id, name: o.name, settlement: o.settlement, x: o.x, z: o.z, deposit: o.deposit, founded: o.founded, house: o.house }));
    },

    cost: (kind: BuildingKind, level = 1) => levelCost(kind, level),

    suggestSpot: (person: PersonId, kind: BuildingKind, settlement: number, near?: P2) => suggest(C, person, kind, settlement, near),

    workersAt(site: number): readonly PersonId[] {
      const rec = C.sitesById.get(site);
      if (!rec || rec.closed !== 0) return [];
      const out = rec.crew.filter((id) => !!C.living(id));
      const player = C.state.run.playerId;
      if (player && C.playerSite() === site && !out.includes(player)) out.push(player);
      return out;
    },

    version: () => C.version,

    onSite(person: PersonId): number {
      if (C.playerSite() && person === C.state.run.playerId) return C.playerSite();
      return C.crewOf.get(person) ?? 0;
    },
    setHired: (person, site, hired) => setHired(C, person, site, hired),
    canManage: (person, site) => { const rec = C.sitesById.get(site); return !!rec && canManageSite(C, person, rec); },
  };

  sim.services.construction = api;
  installed.set(sim, api);
  void offs;
  void BUILDINGS;
  return api;
}

/** The runtime installed in a simulation (tests, tools). */
export function constructionOf(sim: Simulation): ConstructionInstall | undefined { return installed.get(sim); }
