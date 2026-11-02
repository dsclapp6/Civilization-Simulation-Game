// Troops you direct (civilization pass, wave B; docs/CIV.md §9, docs/WAR.md): the military module's side of orders in a detail
// battle. The combat module keeps the groups (foot, archers, horse) and carries the orders out; this is where the player's rank
// decides how many men take them, and where the old six battle orders (keys 1–6 of the command panel) become group orders.
import type { BattleGroupView, GroupKey, GroupOrder, GroupOrderKind } from '../wave3';
import { isWarCombat } from './war';
import type { Mil } from './store';
import type { BattleOrder, CommandLevel, Result } from './types';

/** How many men a rank commands in the line (SPEC §7): yourself → a squad → a company → the army (of those in the detail fight). */
export function commandSpan(level: CommandLevel): number {
  return level === 'squad' ? 8 : level === 'company' ? 30 : level === 'army' ? 60 : 0;
}

const NO_GROUPS: readonly BattleGroupView[] = [];

/** The troop groups of the fight the player is in: his own commanded men (by rank) or the enemy's as far as they are in sight. */
export function battleGroupsOf(M: Mil, side: 'own' | 'enemy' = 'own'): readonly BattleGroupView[] {
  const c = M.combat;
  if (!isWarCombat(c)) return NO_GROUPS;
  if (side === 'own' && M.career.commandLevel() === 'self') return NO_GROUPS;
  return c.groups(side);
}

/** An order to a group of the player's commanded men. A man who only follows orders gives none. */
export function orderGroupOf(M: Mil, group: GroupKey, order: GroupOrder): Result {
  const c = M.combat;
  if (!isWarCombat(c)) return { ok: false, reason: 'There is no battle to command' };
  const level = M.career.commandLevel();
  if (level === 'self') return { ok: false, reason: 'You follow orders; only a sergeant or above commands men' };
  const r = c.orderGroup(group, order);
  if (r.ok) M.touch();
  return r;
}

/** The six battle orders of the macro model as orders to every commanded group at once. */
export function groupOrderOf(order: BattleOrder): GroupOrder {
  const kind: GroupOrderKind = order === 'hold' ? 'hold' : order === 'advance' ? 'advance' : order === 'charge' ? 'charge'
    : order === 'loose' ? 'loose' : order === 'retreat' ? 'retreat' : 'follow';
  return { kind };
}

/** Gives a battle order to all the player's commanded groups; false when there is no detail fight with groups to give it to. */
export function orderAll(M: Mil, order: BattleOrder): boolean {
  const c = M.combat;
  if (!isWarCombat(c) || c.groups('own').length === 0) return false;
  return c.orderGroup('all', groupOrderOf(order)).ok;
}
