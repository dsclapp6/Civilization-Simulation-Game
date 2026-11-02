// The saved data of the construction module (state.ext['construction']): the sites being worked, the outposts founded and the
// counters. Plain JSON, deterministic; everything else (indexes, caches, the cell grids) is rebuilt from this and the state.
import type { BuildingKind } from '../../content/types';
import type { HouseId, HouseholdId, PersonId } from '../state';
import type { SiteStatus } from './types';

export const EXT_KEY = 'construction';

export type WorkKind = 'build' | 'upgrade' | 'repair' | 'demolish';

export interface SiteRec {
  id: number;
  /** The BuildingState worked on. */
  building: number;
  kind: BuildingKind;
  work: WorkKind;
  /** Level when done (build: 1; upgrade: the next; repair and demolish: the present). */
  level: number;
  /** The building's settlement (an outpost's parent). */
  settlement: number;
  /** Outpost id (0 = none). */
  outpost: number;
  /** Who pays (household) and owns (House). */
  household: HouseholdId;
  house: HouseId;
  /** Who ordered it. */
  builder: PersonId;
  priority: number;
  placed: number;
  /** A home: who moves in when it is done. */
  occupant: 'builder' | 'vacant';
  /** Paid labourers wanted: a number or 'auto'. */
  hired: number | 'auto';
  /** Materials the job needs, those delivered into it, those ordered and on their way ([amount, day they should arrive]). */
  need: Record<string, number>;
  have: Record<string, number>;
  transit: Record<string, [number, number]>;
  /** Worker-days the job needs and has had. */
  labour: number;
  done: number;
  /** Cash fees (mason, millwright, carting) in all and paid so far. */
  pence: number;
  paid: number;
  /** Repairs: the damage when the work began. */
  damage0: number;
  /** Today's labour (set by the daily pass): worker-days for the whole working day, who is at work, and where it comes from. */
  perDay: number;
  crew: number[];
  from: [household: number, week: number, hired: number];
  /** Day number the plan above was made for. */
  planned: number;
  status: SiteStatus;
  note: string;
  /** Labour has begun / the share of progress last announced (events). */
  started: boolean;
  told: number;
  /** Whole days with nothing to do. */
  idle: number;
  /** The last quantised construction value written to the building. */
  shown: number;
  /** Day the site was finished or cancelled (0 = still open). */
  closed: number;
}

export interface OutpostRec {
  id: number;
  name: string;
  /** The settlement it belongs to for the economy. */
  settlement: number;
  x: number;
  z: number;
  /** Deposit id it lies on (−1 = none). */
  deposit: number;
  founded: number;
  house: HouseId;
  founder: PersonId;
}

export interface ConstructionSave {
  v: 1;
  nextSite: number;
  nextOutpost: number;
  sites: SiteRec[];
  outposts: OutpostRec[];
  /** Ids of the world's own buildings that were pulled down (they reappear on load; the module removes them again at install). */
  razed: number[];
  /** Totals for the debug tool. */
  stats: { placed: number; finished: number; cancelled: number; demolished: number };
}

export function newSave(): ConstructionSave {
  return { v: 1, nextSite: 1, nextOutpost: 1, sites: [], outposts: [], razed: [], stats: { placed: 0, finished: 0, cancelled: 0, demolished: 0 } };
}

/** Makes sure a loaded section has every field (older saves, hand-made states). */
export function normalise(s: Partial<ConstructionSave> | undefined): ConstructionSave {
  const out = newSave();
  if (!s || typeof s !== 'object') return out;
  if (typeof s.nextSite === 'number') out.nextSite = s.nextSite;
  if (typeof s.nextOutpost === 'number') out.nextOutpost = s.nextOutpost;
  if (Array.isArray(s.sites)) out.sites = s.sites;
  if (Array.isArray(s.outposts)) out.outposts = s.outposts;
  if (Array.isArray(s.razed)) out.razed = s.razed;
  if (s.stats) out.stats = { ...out.stats, ...s.stats };
  return out;
}
