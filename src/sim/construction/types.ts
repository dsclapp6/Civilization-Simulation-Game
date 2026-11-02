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
}

export interface OutpostView { id: number; name: string; settlement: number; x: number; z: number; deposit: number; founded: number }

export interface Result { ok: boolean; reason?: string }

export interface ConstructionApi {
  /** What this person may build where (rank, offices, own land). */
  scope(person: PersonId): BuildScope;
  /** The catalogue for this person in a settlement (or the wild when −1). */
  catalogue(person: PersonId, settlement: number): BuildOption[];
  /** Is this a valid site for that building, for this person? (cheap: the ghost calls it every frame). */
  check(person: PersonId, kind: BuildingKind, x: number, z: number, rot: number): PlacementCheck;
  /** Stakes out a site (and an outpost when it lies in the wild and `outpost` names it). */
  place(person: PersonId, kind: BuildingKind, x: number, z: number, rot: number, opts?: { outpost?: string; priority?: number }): Result & { site?: number };
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
}
