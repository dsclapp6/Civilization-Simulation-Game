// CONTRACT (civilization pass, docs/CIV.md §4, §7) — who owns the land, who may be where, and what the land holds.
// Implemented by src/sim/territory/** (`installTerritory`). Pure functions of the world and the sim state (land kinds
// from strips, parcels, plots and the world's maps; owners from titles); cheap enough to ask per frame for the player and
// a few times a second for patrols. Registered as `sim.services.territory`.
// Builder A1 added, additively: `TrespassCheck.cause` and `.lord`, `TrespassCause`, `LandOwner`, the optional `TerritoryApi.ownerOf`,
// `grantLeave`, `leaveUntil`, `exitFrom`, and `TerritoryRuntime` (what `installTerritory` returns).
import type { P2 } from '../../core/math';
import type { Deposit, ResourceKind } from '../../world/types';
import type { HouseId, HouseholdId, PersonId, TitleId } from '../state';

export type LandKind =
  | 'field'      // an open-field strip
  | 'pasture'    // common pasture
  | 'meadow'     // common meadow (hay)
  | 'garden'     // a croft garden or yard of a household
  | 'demesne'    // the lord's own land and closes
  | 'forest'     // woodland of the manor (the lord's game; firewood by custom)
  | 'park'       // an enclosed deer park
  | 'town'       // streets and open ground inside a settlement
  | 'castle'     // castle grounds, baileys, inside the walls of a castle
  | 'road'
  | 'water'
  | 'wild';      // beyond any settlement's lands (nominally the crown's)

export interface LandInfo {
  kind: LandKind;
  /** Settlement whose lands these are (-1 = wild). */
  settlement: number;
  /** House holding the land (the manor/town title holder's House); 0 = none (wild, common without a lord). */
  house: HouseId;
  /** The title the land is held under (0 = none). */
  title: TitleId;
  /** Household that holds or works it (a strip's or garden's household), 0 = none. */
  household: HouseholdId;
  /** Entity ids when the point is on one (-1 = none). */
  strip: number;
  parcel: number;
  building: number;
}

/** none: may be here; private: a lord's land the person has no business on; hostile: land of an enemy. */
export type TrespassLevel = 'none' | 'private' | 'hostile';

/** Additive: why a person is trespassing (machine-readable; `reason` says it in words). */
export type TrespassCause =
  | 'war'      // the land's House is at war with the person's House (or their lord's)
  | 'feud'     // ... in a feud with it
  | 'hostile'  // ... on hostile terms with it (politics stance)
  | 'outlaw'   // the person is an outlaw
  | 'enemy'    // the lord of the land counts the person his enemy
  | 'demesne'  // the lord's closes and manor court
  | 'park'     // an enclosed deer park
  | 'castle';  // castle grounds at night or on alert

export interface TrespassCheck {
  level: TrespassLevel;
  land: LandInfo;
  /** Plain words for the UI and the patrol's speech: "the lord's deer park", "lands of House Avenel, at war with yours". */
  reason: string;
  /** Additive: the cause when `level` is not 'none'. */
  cause?: TrespassCause;
  /** Additive: the person who holds the land and sends the patrol (his regent while he is a child or a captive); 0 = nobody. */
  lord?: PersonId;
}

/** Additive: who holds the lands of a settlement now. */
export interface LandOwner {
  /** House of the title's holder (0 = nobody holds it). */
  house: HouseId;
  /** The title the lands are held under (0 = none). */
  title: TitleId;
  /** The person who holds the title (0 = none). */
  holder: PersonId;
  /** The person who acts for it: the holder, or his regent while he is a child or a captive. */
  lord: PersonId;
}

/** What a settlement's lands hold and can make (docs/CIV.md §7). */
export interface ResourceProfile {
  settlement: number;
  /** Deposits inside its lands. */
  deposits: readonly Deposit[];
  /** 0..1 woodland share of its lands (timber, firewood, charcoal). */
  forest: number;
  /** 0..1 mean fertility of its fields. */
  fertility: number;
  coast: boolean;
  river: boolean;
  /** Good ids its lands can yield with the right buildings ("iron_ore", "clay", "timber", "salt", "fish", "wool", "grain"…). */
  yields: readonly string[];
}

export interface TerritoryApi {
  /** What land this is and whose. */
  landAt(x: number, z: number): LandInfo;
  /** May this person be here? (their House's wars and feuds, their offices and household, the land kind). */
  trespass(person: PersonId, x: number, z: number): TrespassCheck;
  /** The settlement whose lands contain the point (-1 = wild). */
  settlementOf(x: number, z: number): number;
  /** Radius (m) of a settlement's lands (its Voronoi cell is also clipped to it). */
  landsRadius(settlement: number): number;
  resources(settlement: number): ResourceProfile;
  deposits(): readonly Deposit[];
  depositsNear(x: number, z: number, radius: number, kind?: ResourceKind): Deposit[];
  /** The deposit a point lies on (within its radius), or null. */
  depositAt(x: number, z: number, kind?: ResourceKind): Deposit | null;
  /** Bumps when ownership changes (titles change hands, wars start or end, outposts are founded). */
  version(): number;

  // ---- additive (territory module); optional so other modules' fakes need not implement them ----
  /** Who holds the lands of a settlement now (the manor/town/barony/abbey title's holder; a vacant title is kept by its liege). */
  ownerOf?(settlement: number): LandOwner;
  /**
   * The lord's leave for a person to be on his private land (a pass, a fine paid, business accepted by a patrol): until
   * `days` game days from now. While it lasts `trespass` does not call the person a trespasser there (never on hostile land).
   */
  grantLeave?(person: PersonId, settlement: number, days: number): void;
  /** Absolute day the person's leave on that settlement's land ends (0 = none). */
  leaveUntil?(person: PersonId, settlement: number): number;
  /** The nearest point (within ~1.5 km) where this person is no longer a trespasser, for a patrol's escort to the edge; null if none. */
  exitFrom?(person: PersonId, x: number, z: number): P2 | null;
}

/** What `installTerritory` returns: the API plus what tests and tools need. */
export interface TerritoryRuntime extends TerritoryApi {
  /** Re-reads titles, wars and outposts at once (the module does it once a game hour and on the events that move them). */
  refresh(): void;
  /** Removes the listeners the module installed (tests, tools). */
  dispose(): void;
}
