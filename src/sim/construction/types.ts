// CONTRACT (civilization pass, docs/CIV.md §5) — raising, upgrading, repairing and pulling down buildings, for the player
// and the AI alike. Implemented by src/sim/construction/** (`installConstruction`), registered as
// `sim.services.construction`. A building raised in play is an ordinary `BuildingState` (plot −1) whose `construction`
// grows 0→1 while its site gets materials and labour; the renderer already draws the stages (`BuildingView.construction`).
// Costs and rules are content (`src/content/construction.json`). Saved in state.ext['construction'], deterministic.
import type { BuildingKind } from '../../content/types';
import type { P2 } from '../../core/math';
import type { ResourceKind } from '../../world/types';
import type { HouseId, HouseholdId, PersonId } from '../state';

export interface BuildCost {
  /** Materials by good id (timber, planks, stone, brick, iron, nails, straw…). */
  goods: Readonly<Record<string, number>>;
  /** Labour in worker-days of an able adult. */
  labour: number;
  /** Money paid out besides labour you supply yourself (a mason's fee, carting), pence. */
  pence: number;
}

export type BuildCategory = 'home' | 'farm' | 'craft' | 'food' | 'religion' | 'civic' | 'defence' | 'resource' | 'military';

export interface BuildRequirement {
  /** A technique the builder's House must command (advancement id). */
  tech?: string;
  /** Terrain the site needs. */
  terrain?: 'river' | 'rise' | 'coast' | 'deposit' | 'forest';
  /** For terrain 'deposit': which. */
  deposit?: ResourceKind;
  /** Least rank tier of the builder (SPEC §4 tiers) unless they build on their own household's land. */
  rank?: number;
  /** Additive: for terrain 'deposit', every deposit kind that will do (a mine takes iron, silver or gold); `deposit` is the first. */
  deposits?: ResourceKind[];
  /** Additive: most of this building the settlement may hold (absent = no limit). */
  max?: number;
}

/** One entry of the builder's catalogue, as it stands for this person here. */
export interface BuildOption {
  kind: BuildingKind;
  name: string;
  category: BuildCategory;
  level: number;
  cost: BuildCost;
  requires: BuildRequirement;
  /** One line of what it does ("Grinds grain for the village; the lord takes a toll"). */
  does: string;
  /** May this person build it here at all (rank, tech, the count allowed)? */
  ok: boolean;
  reason?: string;
}

/** Where a builder may build, and in whose name. */
export interface BuildScope {
  person: PersonId;
  /** Settlements (and their lands) where the person may build anything their rank allows. */
  settlements: readonly number[];
  /** Plots/buildings of their own household (a peasant's croft, a master's workshop). */
  own: readonly number[];
  /** May found outposts in the wild (baron and up). */
  outposts: boolean;
  /** Plain words: "your croft", "the manor of Dromore", "the barony of Avenel". */
  label: string;
  /** Who pays and owns: the builder's household or their House's ruling household. */
  household: HouseholdId;
  house: HouseId;
  /** Additive: the builder's rank tier. */
  rank?: number;
  /** Additive: how the person builds ('head' = for their own household on its land, 'lord' = a title over land, 'steward' = an office on a lord's orders, 'baron' = a baron or greater, 'none'). */
  role?: 'none' | 'head' | 'steward' | 'lord' | 'baron';
  /** Additive: settlements where the person only builds for the lord (offices); their money is the lord's household's. */
  agentFor?: readonly number[];
}

/** Additive: the options of `place`. */
export interface PlaceOptions {
  /** Names the outpost founded when a spot in the wild is built on (a default name is made when absent). */
  outpost?: string;
  priority?: number;
  /** A home: who moves in when it is finished — the builder's household ('builder', the default for a household head building on their own land) or nobody ('vacant': it is let). */
  occupant?: 'builder' | 'vacant';
  /** Paid labourers to hire for the site (a number, or 'auto' for as many as the job and the purse allow). */
  hired?: number | 'auto';
}

export interface PlacementCheck {
  ok: boolean;
  /** "Too steep", "Overlaps the smithy", "Not your land", "Needs a river bank", "On the road". */
  reason?: string;
  x: number;
  z: number;
  rot: number;
  /** Settlement the building would belong to (-1 = a new outpost in the wild). */
  settlement: number;
  /** Footprint corners (world m) for the ghost. */
  footprint: P2[];
  /** Additive: a spot in the wild or in an outpost's land: `id` 0 founds a new outpost (named `name`, a suggestion), else the outpost it joins. */
  outpost?: { id: number; parent: number; name: string };
  /** Additive: the building would be a new building or the next level of this one. */
  cost?: BuildCost;
}

export type SiteStatus = 'waiting' | 'working' | 'stalled' | 'done' | 'cancelled';

export interface SiteView {
  id: number;
  /** The BuildingState being raised (construction < 1 until done); for an upgrade, the building upgraded. */
  building: number;
  kind: BuildingKind;
  /** 'build' | 'upgrade' | 'repair' | 'demolish'. */
  work: 'build' | 'upgrade' | 'repair' | 'demolish';
  settlement: number;
  x: number;
  z: number;
  rot: number;
  household: HouseholdId;
  house: HouseId;
  /** 0..1 */
  progress: number;
  /** Materials still to come (good → amount). */
  missing: Readonly<Record<string, number>>;
  /** Labour still to put in (worker-days). */
  labourLeft: number;
  /** People working there today. */
  workers: number;
  status: SiteStatus;
  /** Why it waits ("Waiting for 12 planks — carted from Dromore market, 1 day"). */
  note?: string;
  /** Absolute day it should be done at the present pace (Infinity = stalled). */
  eta: number;
  /** Name of the outpost it belongs to, if any. */
  outpost?: string;
  /** Order in the builder's queue (lower first). */
  priority: number;
  /** Additive: the level the building will have when done. */
  level?: number;
  /** Additive: who ordered it. */
  builder?: PersonId;
  /** Additive: pegs and lines → footings → frame/walls → roof → done (CIV §5). */
  stage?: 'pegs' | 'footings' | 'frame' | 'roof' | 'done';
  /** Additive: paid labourers at work today. */
  hired?: number;
  /** Additive: the whole job's cost. */
  cost?: BuildCost;
  /** Additive: 0..1 share of the materials that have come in. */
  materials?: number;
}

export interface OutpostView {
  id: number; name: string; settlement: number; x: number; z: number; deposit: number; founded: number;
  /** Additive: the House that holds it. */
  house?: HouseId;
}

export interface Result { ok: boolean; reason?: string }

export interface ConstructionApi {
  /** What this person may build where (rank, offices, own land). */
  scope(person: PersonId): BuildScope;
  /** The catalogue for this person in a settlement (or the wild when −1). */
  catalogue(person: PersonId, settlement: number): BuildOption[];
  /** Is this a valid site for that building, for this person? (cheap: the ghost calls it every frame). */
  check(person: PersonId, kind: BuildingKind, x: number, z: number, rot: number): PlacementCheck;
  /** Stakes out a site (and an outpost when it lies in the wild and `outpost` names it). */
  place(person: PersonId, kind: BuildingKind, x: number, z: number, rot: number, opts?: PlaceOptions): Result & { site?: number };
  upgrade(person: PersonId, building: number): Result & { site?: number };
  repair(person: PersonId, building: number): Result & { site?: number };
  demolish(person: PersonId, building: number): Result & { site?: number };
  cancel(person: PersonId, site: number): Result;
  setPriority(person: PersonId, site: number, priority: number): Result;
  sites(settlement?: number): readonly SiteView[];
  site(id: number): SiteView | null;
  siteOf(building: number): SiteView | null;
  outposts(): readonly OutpostView[];
  /** Cost of a building of a kind and level (content), for UIs and AI planners. */
  cost(kind: BuildingKind, level?: number): BuildCost;
  /** A valid spot for this building in a settlement (near a point if given), for AI planners and the UI's "place for me". */
  suggestSpot(person: PersonId, kind: BuildingKind, settlement: number, near?: P2): PlacementCheck | null;
  /** People working at a site today (the zone draws them there working; src/agents). */
  workersAt(site: number): readonly PersonId[];
  /** Bumps on any change of sites or outposts (cheap UI refresh). */
  version(): number;

  // ---- additive (construction module); optional so other modules' fakes need not implement them ----
  /** The site this person works at today (hired, on the household's 'build' task, on week-work or at a bout), or 0. */
  onSite?(person: PersonId): number;
  /** Sets how many paid labourers work the site (a number, or 'auto'). The person must be allowed to manage it. */
  setHired?(person: PersonId, site: number, hired: number | 'auto'): Result;
  /** May this person cancel, reprioritise or hire for the site? */
  canManage?(person: PersonId, site: number): boolean;
  /** What improving, mending or pulling down a building would cost (and whether this person may order it), without ordering it. */
  quote?(person: PersonId, work: 'upgrade' | 'repair' | 'demolish', building: number): Result & { cost?: BuildCost; level?: number };
  /**
   * Where this person may build, as polygons (world m) for builder mode's tint (`GameRenderer.setBuildArea`): the lands of every
   * settlement in `scope(person).settlements` (the territory service's `landsPolygon(settlement)` when it has one, else a circle of
   * its `landsRadius`), the land round the outposts they hold, and — for a household head with no say over the place — the
   * household's own plots. Cached: the same array comes back until the territory, the sites, the day or their holdings change.
   */
  buildArea?(person: PersonId): ReadonlyArray<readonly P2[]>;
}
