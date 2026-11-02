// The command HUD's logic without a screen (civilization pass, wave B; docs/WAR.md): which key selects which group, what the order
// wheel offers, what a click on the field means, what the ground marks and the banners say, where the tactical camera looks. The
// DOM parts (src/ui/hud/battle.ts, src/ui/panels/battle.ts) are thin over this, and this is what the tests cover.
import { KEYMAP } from '../../player/types';
import type { PersonId } from '../state';
import type { BattleGroupView, Formation, GroupKey, GroupOrder, GroupOrderKind } from '../wave3';

export interface P2 { x: number; z: number }

/** The mark the renderer draws on the ground (render/types.ts `OrderMark`, by shape: the UI passes these on as they are). */
export interface OrderMarkShape {
  id: number;
  kind: 'move' | 'attack' | 'hold' | 'retreat';
  from: P2;
  to: P2;
  tone: 'own' | 'selected' | 'enemy';
}

// ---------------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------------

/** Keys 4–7 select all / foot / archers / horse. */
export const SELECT_KEYS: Readonly<Record<string, GroupKey>> = {
  [KEYMAP.battle.all]: 'all', [KEYMAP.battle.foot]: 'foot', [KEYMAP.battle.archers]: 'archers', [KEYMAP.battle.horse]: 'horse',
};
export const KEY_OF_GROUP: Readonly<Record<GroupKey, string>> = {
  all: KEYMAP.battle.all, foot: KEYMAP.battle.foot, archers: KEYMAP.battle.archers, horse: KEYMAP.battle.horse,
};
/** The digit shown on a group's button ("4"). */
export function keycapOf(key: GroupKey): string { return KEY_OF_GROUP[key].replace('Digit', ''); }
/** Opens the order wheel. */
export const WHEEL_KEY = 'Digit8';

/**
 * Pressing a group's key selects it; pressing the selected one again lets go (nothing selected: orders go to everyone). A group
 * that has no men cannot be selected.
 */
export function selectionAfter(current: GroupKey | null, pressed: GroupKey, groups: readonly BattleGroupView[]): GroupKey | null {
  const g = groups.find((x) => x.key === pressed);
  if (!g || g.count === 0) return current;
  return current === pressed ? null : pressed;
}

// ---------------------------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------------------------

export interface OrderContext {
  /** The point the player is looking at on the ground (or ahead of him), if known. */
  ahead: P2 | null;
  /** The enemy under the sight (person id), 0 = none. */
  target: PersonId;
}

export interface OrderChoice {
  /** The digit that gives it while the wheel is open (1–9). */
  n: number;
  id: string;
  label: string;
  hint: string;
  icon: 'flag' | 'shield' | 'swords' | 'archery' | 'horse' | 'crown' | 'users' | 'boot' | 'helm';
  order(c: OrderContext): GroupOrder;
}

/** The order wheel: follow me, hold here, advance, charge, loose, retreat, then the three formations. */
export const ORDER_CHOICES: readonly OrderChoice[] = [
  { n: 1, id: 'follow', label: 'Follow me', hint: 'Keep close behind you', icon: 'flag', order: () => ({ kind: 'follow' }) },
  { n: 2, id: 'hold', label: 'Hold here', hint: 'Stand and fight where they are', icon: 'shield', order: () => ({ kind: 'hold' }) },
  { n: 3, id: 'advance', label: 'Advance', hint: 'March in order to where you look', icon: 'users', order: (c) => (c.ahead ? { kind: 'advance', at: { ...c.ahead } } : { kind: 'advance' }) },
  { n: 4, id: 'charge', label: 'Charge', hint: 'All out at the enemy (or the man you look at)', icon: 'swords', order: (c) => (c.target ? { kind: 'charge', target: c.target } : { kind: 'charge' }) },
  { n: 5, id: 'loose', label: 'Loose', hint: 'Shoot at will (or at the man you look at)', icon: 'archery', order: (c) => (c.target ? { kind: 'loose', target: c.target } : { kind: 'loose' }) },
  { n: 6, id: 'retreat', label: 'Fall back', hint: 'Withdraw out of the fight', icon: 'boot', order: () => ({ kind: 'retreat' }) },
  { n: 7, id: 'line', label: 'Line', hint: 'Form a line two ranks deep', icon: 'users', order: () => ({ kind: 'formation', formation: 'line' }) },
  { n: 8, id: 'shield_wall', label: 'Shield wall', hint: 'Close up, shields raised', icon: 'shield', order: () => ({ kind: 'formation', formation: 'shield_wall' }) },
  { n: 9, id: 'wedge', label: 'Wedge', hint: 'A wedge to break a line', icon: 'helm', order: () => ({ kind: 'formation', formation: 'wedge' }) },
];

export function orderByDigit(n: number): OrderChoice | undefined { return ORDER_CHOICES.find((o) => o.n === n); }

const ORDER_WORDS: Record<GroupOrderKind, string> = {
  follow: 'following you', hold: 'holding', advance: 'advancing', charge: 'charging', loose: 'loosing', retreat: 'falling back', move: 'moving', formation: 'forming up',
};
export function orderWord(kind: GroupOrderKind): string { return ORDER_WORDS[kind] ?? kind; }

const FORMATION_WORDS: Record<Formation, string> = { loose: 'open order', line: 'line', shield_wall: 'shield wall', wedge: 'wedge' };
export function formationWord(f: Formation): string { return FORMATION_WORDS[f] ?? f; }

/** "Foot · 12 · holding · shield wall" */
export function groupLine(g: BattleGroupView): string {
  return `${g.label} · ${g.count} · ${orderWord(g.order)}${g.formation !== 'line' && g.order !== 'charge' && g.order !== 'retreat' ? ` · ${formationWord(g.formation)}` : ''}`;
}

/** Colour family for a group's morale 0..1. */
export function moraleTone(m: number): 'green' | 'gold' | 'vermilion' { return m > 0.6 ? 'green' : m > 0.35 ? 'gold' : 'vermilion'; }

/**
 * What a click in the tactical view orders. A click on an enemy sends the group at him (charge; archers loose); a click on the
 * ground marches the group there in order (alt: just moves, without engaging on the way). Nothing under the cursor, no order.
 */
export function clickOrder(group: GroupKey, ground: P2 | null, enemy: PersonId, alt = false): GroupOrder | null {
  if (enemy) return { kind: group === 'archers' ? 'loose' : 'charge', target: enemy };
  if (!ground) return null;
  return { kind: alt ? 'move' : 'advance', at: { x: ground.x, z: ground.z } };
}

/** What dragging a group's banner to a point orders: a move there in order. */
export function dragOrder(ground: P2): GroupOrder { return { kind: 'move', at: { x: ground.x, z: ground.z } }; }

// ---------------------------------------------------------------------------------------------
// The field seen from above
// ---------------------------------------------------------------------------------------------

/** The overhead camera's circle: round both armies, with room to move. Null when there is nothing to look at. */
export function overviewFor(own: readonly BattleGroupView[], enemy: readonly BattleGroupView[], fallback: P2 | null): { x: number; z: number; radius: number; distance: number } | null {
  const pts: Array<{ x: number; z: number; w: number }> = [];
  for (const g of own) if (g.key !== 'all' && g.count > 0) pts.push({ x: g.x, z: g.z, w: g.count });
  for (const g of enemy) if (g.count > 0) pts.push({ x: g.x, z: g.z, w: g.count });
  if (pts.length === 0) return fallback ? { x: fallback.x, z: fallback.z, radius: 120, distance: 90 } : null;
  let sx = 0, sz = 0, sw = 0;
  for (const p of pts) { sx += p.x * p.w; sz += p.z * p.w; sw += p.w; }
  const x = sx / sw, z = sz / sw;
  let far = 0;
  for (const p of pts) far = Math.max(far, Math.hypot(p.x - x, p.z - z));
  const radius = Math.max(110, Math.min(380, far + 70));
  return { x, z, radius, distance: Math.max(70, Math.min(240, radius * 0.95)) };
}

/** The marks on the ground for the groups' orders: gold arrows for the player's, the selected one bright, the enemy's red. */
export function orderMarks(own: readonly BattleGroupView[], enemy: readonly BattleGroupView[], selected: GroupKey | null, enemyAt?: (id: PersonId) => P2 | null): OrderMarkShape[] {
  const out: OrderMarkShape[] = [];
  const from = (g: BattleGroupView): P2 => ({ x: g.x, z: g.z });
  own.forEach((g, i) => {
    if (g.key === 'all' || g.count === 0) return;
    const tone: OrderMarkShape['tone'] = selected === g.key || selected === 'all' ? 'selected' : 'own';
    const id = 1000 + i;
    switch (g.order) {
      case 'advance': case 'move':
        if (g.at) out.push({ id, kind: 'move', from: from(g), to: { ...g.at }, tone });
        break;
      case 'hold':
        out.push({ id, kind: 'hold', from: from(g), to: g.at ? { ...g.at } : from(g), tone });
        break;
      case 'charge': case 'loose': {
        const t = g.target && enemyAt ? enemyAt(g.target) : null;
        if (t) out.push({ id, kind: 'attack', from: from(g), to: t, tone });
        else if (g.at) out.push({ id, kind: 'attack', from: from(g), to: { ...g.at }, tone });
        break;
      }
      case 'retreat':
        out.push({ id, kind: 'retreat', from: from(g), to: g.at ? { ...g.at } : from(g), tone });
        break;
      default: break;
    }
  });
  enemy.forEach((g, i) => {
    if (g.count === 0) return;
    const id = 2000 + i;
    if ((g.order === 'advance' || g.order === 'move') && g.at) out.push({ id, kind: 'move', from: from(g), to: { ...g.at }, tone: 'enemy' });
    else if (g.order === 'hold') out.push({ id, kind: 'hold', from: from(g), to: g.at ? { ...g.at } : from(g), tone: 'enemy' });
    else if (g.order === 'charge') out.push({ id, kind: 'attack', from: from(g), to: { x: g.x + Math.sin(g.yaw) * 14, z: g.z + Math.cos(g.yaw) * 14 }, tone: 'enemy' });
    else if (g.order === 'retreat') out.push({ id, kind: 'retreat', from: from(g), to: g.at ? { ...g.at } : from(g), tone: 'enemy' });
  });
  return out;
}

/** A cheap fingerprint of what the group views say, so the DOM is rebuilt only when something showing has changed. */
export function groupsSignature(own: readonly BattleGroupView[], enemy: readonly BattleGroupView[]): string {
  let s = '';
  for (const g of own) s += `${g.key}:${g.count}:${g.order}:${g.formation}:${Math.round(g.morale * 10)}:${g.engaged ? 1 : 0}:${g.target};`;
  s += '|';
  for (const g of enemy) s += `${g.key}:${g.count}:${g.order};`;
  return s;
}
