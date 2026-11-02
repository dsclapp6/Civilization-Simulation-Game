// War in the zone (civilization pass, wave B; docs/WAR.md): what the military module and the combat module say to each
// other beyond the cross-module contract in sim/wave3.ts. Additive and optional: a combat module without these members (a
// test's fake) simply never gets a detail storm or troop orders, and the military falls back to the macro model.
import type { PersonId } from '../state';
import type { BattleGroupView, CombatApi, FightSide, FightIntent, GroupKey, GroupOrder } from '../wave3';

/** A storm of a walled place, as the military module hands it to the arena (the macro siege's numbers become real things). */
export interface SiegeSetup {
  /** The settlement whose walls are stormed. */
  settlement: number;
  /** Index (into the sides given to `engage`) of the side that storms, and of the side that holds the walls. */
  attackers: number;
  defenders: number;
  /** Rams the besiegers built (0..3): each is pushed to the gate by a crew and batters it. */
  rams: number;
  /** Scaling ladders ready (0 = none): carried to the wall by the foot soldiers. */
  ladders: number;
  /** Throwing engines (trebuchets, mangonels) the besiegers have: they break the walls from afar while the storm lasts. */
  engines: number;
  /** The walls were undermined: a stretch of wall has already come down. */
  mined?: boolean;
}

/** `engage`'s options as the war code uses them (the contract's, plus the storm and the command). */
export interface WarEngageOpts {
  at?: { x: number; z: number };
  yieldAllowed?: boolean;
  reason?: string;
  intent?: FightIntent;
  /** Which side strikes to wound and takes the downed alive when `intent` is 'subdue' (default: the side without the player, else side 0). */
  subdueSide?: number;
  /** A storm: ram, ladders, engines, the defenders on the wall stations (docs/WAR.md). */
  siege?: SiegeSetup;
  /** The player commands men of one side: the first `span` fighters of that side's list (the men nearest him in the roster) take his
   *  orders; the rest follow their side's commander. Absent = the player commands nobody (he follows orders). */
  command?: { side: number; span: number };
}

/** The gate and the works of the storm in progress, for the HUD. */
export interface SiegeStatus {
  settlement: number;
  /** Gate: 'shut' (barred), 'open' (let in), 'broken' (battered in). 0..1 integrity of the gate leaves. */
  gate: 'shut' | 'open' | 'broken' | 'none';
  gateIntegrity: number;
  rams: number;
  ladders: number;
  /** Attackers on the wall-walk now. */
  onWalls: number;
  /** Wall segments or palisades fallen far enough to climb through. */
  breaches: number;
  /** Defenders manning stations (archers and others on the wall tops). */
  stationed: number;
  engines: number;
}

/** What the combat module offers the war code (the module returns this from `installCombat`; `sim.services.combat` is it). */
export interface WarCombatApi extends CombatApi {
  engage(sides: FightSide[], opts?: WarEngageOpts): number;
  /** Troop groups of the fight the player is in: his own commanded men, or the enemy's within sight. */
  groups(side: 'own' | 'enemy'): readonly BattleGroupView[];
  /** An order to the player's commanded men of a group (no level check: the military module does that). */
  orderGroup(group: GroupKey, order: GroupOrder): { ok: boolean; reason?: string };
  /** The storm in progress near the player, or null. */
  siegeStatus(): SiegeStatus | null;
  /** The fight a person is in and his side's index (the war code needs it to put the command in the right place). */
  sideOf(person: PersonId): number;
}

/** True when the object is a combat module that does groups (a fake may not). */
export function isWarCombat(c: unknown): c is WarCombatApi {
  const x = c as Partial<WarCombatApi> | undefined;
  return !!x && typeof x.groups === 'function' && typeof x.orderGroup === 'function';
}
