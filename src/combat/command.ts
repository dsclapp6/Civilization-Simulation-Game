// Troops you direct (civilization pass, wave B; docs/CIV.md §9, docs/WAR.md). In a battle the fighters of a side are sorted into
// three groups by kind — foot, archers, horse — and each group has an order: follow me, hold here, advance to a point, charge,
// loose at will (or at a named enemy), retreat, move to a point; and a formation: loose, line, shield wall, wedge. A group keeps
// an *anchor* (the place and facing of its formation); every man has a slot in the formation round the anchor and walks to it,
// fighting what comes within his engage radius and coming back to the slot afterwards. The anchor moves towards the order's
// point no faster than the group holds together, so a line advances as a line.
//
// The player's orders go to his commanded layer (the men nearest him in the roster, as many as his rank commands); every other
// man — the rest of his side, and the whole of the enemy's — takes the orders of his side's AI commander (commander.ts), which
// gives exactly the same orders. A fight without a command layer (a brawl, wolves, a patrol) has none of this: every man is
// his own master, as before.
//
// This file is the state and the geometry; what a man does with his slot is in ai.ts (`obey`).
import { clamp, hash3, yawTo, type P2 } from '../core/math';
import type { PersonId } from '../sim/state';
import type { BattleGroupView, Formation, GroupKey, GroupOrder, GroupOrderKind } from '../sim/wave3';
import type { Arena, Fight } from './arena';
import { D, S, type Fighter } from './fighter';

export const GROUP_NAMES = ['Foot', 'Archers', 'Horse'] as const;
export const GROUP_KEYS: readonly GroupKey[] = ['foot', 'archers', 'horse'];
const KEY_OF: readonly GroupKey[] = GROUP_KEYS;

/** Pace of the formation anchor, by kind (m/s): a line advances at a walk, horse at a walk-trot. */
const ANCHOR_SPEED = [1.85, 1.85, 2.7] as const;
/** Walking pace of a man closing up on his slot (m/s) and the pace of one who has fallen far behind. */
const FOLLOW_SPEED = [1.9, 1.9, 3.4] as const;
const CATCH_UP = 3.7;
const REBUILD_EVERY = 0.5;

export interface Group {
  side: number;
  layer: 0 | 1;
  gk: 0 | 1 | 2;
  order: GroupOrderKind;
  formation: Formation;
  /** Where the order points (advance, move, hold at, retreat to), or null. */
  at: P2 | null;
  /** The enemy an order names (person id), 0 = none. */
  target: PersonId;
  /** The formation anchor and the way it faces. */
  ax: number; az: number; yaw: number;
  /** The men in the group, the best-armed first (they take the front). */
  members: Fighter[];
  cx: number; cz: number;
  count: number;
  engaged: boolean;
  /** Share of the men within reach of their slots. */
  cohesion: number;
  /** Average morale 0..1. */
  morale: number;
  /** Seconds since the order was given. */
  orderT: number;
  byPlayer: boolean;
  /** The anchor has been set to where the men stand (first order, or after a charge broke the ranks). */
  formed: boolean;
}

export interface CommandResult { ok: boolean; reason?: string }

/** Local slot (lx right of the anchor, lz ahead of it; behind is negative) of man `i` of `n` in a formation. */
export function slotOffset(formation: Formation, i: number, n: number, mounted: boolean, out: { lx: number; lz: number }): void {
  const wide = mounted ? 1.75 : 1;
  switch (formation) {
    case 'line': {
      const per = clamp(Math.ceil(n / 2), 4, 14);
      const r = Math.floor(i / per), k = i % per;
      const inRank = Math.min(per, n - r * per);
      out.lx = (k - (inRank - 1) / 2) * 1.35 * wide;
      out.lz = -r * 1.5 * wide;
      return;
    }
    case 'shield_wall': {
      const per = clamp(Math.ceil(n / 2), 5, 16);
      const r = Math.floor(i / per), k = i % per;
      const inRank = Math.min(per, n - r * per);
      out.lx = (k - (inRank - 1) / 2) * 0.86 * wide;
      out.lz = -r * 1.0 * wide;
      return;
    }
    case 'wedge': {
      // row r holds 2r+1 men; the tip is man 0
      let r = 0, first = 0;
      while (first + 2 * r + 1 <= i) { first += 2 * r + 1; r++; }
      const inRow = Math.min(2 * r + 1, n - first);
      out.lx = (i - first - (inRow - 1) / 2) * 1.25 * wide;
      out.lz = -r * 1.15 * wide;
      return;
    }
    default: {
      // loose: an open order on a grid, jittered a little so it does not look drilled
      const per = Math.max(3, Math.ceil(Math.sqrt(n * 1.6)));
      const r = Math.floor(i / per), k = i % per;
      const inRank = Math.min(per, n - r * per);
      const jx = ((hash3(i, 11) % 100) / 100 - 0.5) * 0.9, jz = ((hash3(i, 13) % 100) / 100 - 0.5) * 0.9;
      out.lx = (k - (inRank - 1) / 2) * 2.5 * wide + jx;
      out.lz = -r * 2.6 * wide + jz;
    }
  }
}

/** The kind of fighting man for the groups: horse, archers or foot. */
export function kindOf(f: Fighter): 0 | 1 | 2 {
  if (f.mounted) return 2;
  if (f.gear.ranged !== null && f.preferRanged) return 1;
  return 0;
}

const SLOT = { lx: 0, lz: 0 };

export class FightCommand {
  readonly groups: Group[] = [];
  /** The side the player commands (−1 = nobody), and how many men are in his commanded layer. */
  playerSide = -1;
  span = 0;
  private rebuildT = 0;
  private clock = 0;

  constructor(readonly fight: Fight, private readonly arena: Arena) {}

  /** Makes the empty groups: three kinds for each side, and a second layer on the side the player commands. */
  setup(playerSide: number, span: number): void {
    this.playerSide = playerSide;
    this.span = span;
    const mk = (side: number, layer: 0 | 1, gk: 0 | 1 | 2): Group => ({
      side, layer, gk, order: 'hold', formation: gk === 1 ? 'loose' : 'line', at: null, target: 0, ax: 0, az: 0, yaw: 0, members: [],
      cx: 0, cz: 0, count: 0, engaged: false, cohesion: 1, morale: 1, orderT: 0, byPlayer: false, formed: false,
    });
    for (let s = 0; s < this.fight.sides.length; s++) {
      for (const gk of [0, 1, 2] as const) {
        this.groups.push(mk(s, 0, gk));
        if (s === playerSide) this.groups.push(mk(s, 1, gk));
      }
    }
  }

  find(side: number, layer: 0 | 1, gk: 0 | 1 | 2): Group | undefined {
    for (const g of this.groups) if (g.side === side && g.layer === layer && g.gk === gk) return g;
    return undefined;
  }

  /** Puts the first `span` fighters (not the player) of the commanded side into the player's layer. */
  assignLayers(people: readonly PersonId[]): void {
    if (this.playerSide < 0) return;
    const side = this.fight.sides[this.playerSide];
    let n = 0;
    for (const pid of people) {
      if (n >= this.span) break;
      const f = side.members.find((m) => m.personId === pid);
      if (!f || f.isPlayer) continue;
      f.layer = 1;
      n++;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Membership
  // ---------------------------------------------------------------------------------------------

  /** Sorts the standing men into their groups (a man who dismounts or loses his bow changes group). */
  rebuild(): void {
    for (const g of this.groups) g.members.length = 0;
    const fight = this.fight;
    for (let s = 0; s < fight.sides.length; s++) {
      for (const f of fight.sides[s].members) {
        if (f.isPlayer || f.isAnimal || f.gone || !f.active) { f.dMode = D.Free; continue; }
        f.gk = kindOf(f);
        const g = this.find(s, f.layer, f.gk) ?? this.find(s, 0, f.gk);
        if (g) g.members.push(f);
      }
    }
    for (const g of this.groups) {
      const m = g.members;
      m.sort((a, b) => weight(b) - weight(a) || a.key - b.key);
      let sx = 0, sz = 0, mor = 0, eng = false;
      for (let i = 0; i < m.length; i++) {
        const f = m[i];
        f.sIdx = i;
        sx += f.x; sz += f.z; mor += f.morale;
        if (f.st === S.Windup || f.st === S.Recover || f.st === S.Block) eng = true;
      }
      g.count = m.length;
      if (m.length > 0) { g.cx = sx / m.length; g.cz = sz / m.length; g.morale = clamp(mor / m.length / 100, 0, 1); }
      g.engaged = eng;
      if (m.length > 0 && !g.formed) { g.ax = g.cx; g.az = g.cz; g.formed = true; if (g.yaw === 0) g.yaw = this.facingFor(g); }
    }
  }

  /** The way a group faces while no order turns it: towards the nearest enemy group's centre, else the way it already faces. */
  private facingFor(g: Group): number {
    let best = Infinity, bx = 0, bz = 0;
    for (const o of this.groups) {
      if (o.side === g.side || o.count === 0) continue;
      const d = (o.cx - g.cx) ** 2 + (o.cz - g.cz) ** 2;
      if (d < best) { best = d; bx = o.cx; bz = o.cz; }
    }
    return best < Infinity ? yawTo(g.cx, g.cz, bx, bz) : g.yaw;
  }

  /** Are there archers on the other side with arrows to loose (a shield wall keeps its shields up)? */
  shotAt(side: number): boolean {
    for (const g of this.groups) if (g.side !== side && g.gk === 1 && g.count > 0) return true;
    return false;
  }

  /** Centre of all the standing men of the other sides. */
  enemyCentre(side: number, out: P2): boolean {
    let sx = 0, sz = 0, n = 0;
    for (const g of this.groups) {
      if (g.side === side) continue;
      sx += g.cx * g.count; sz += g.cz * g.count; n += g.count;
    }
    if (n === 0) return false;
    out.x = sx / n; out.z = sz / n;
    return true;
  }

  // ---------------------------------------------------------------------------------------------
  // The step
  // ---------------------------------------------------------------------------------------------

  update(dt: number): void {
    this.clock += dt;
    this.rebuildT -= dt;
    if (this.rebuildT <= 0) { this.rebuildT = REBUILD_EVERY; this.rebuild(); }
    for (const g of this.groups) {
      if (g.count === 0) continue;
      g.orderT += dt;
      this.moveAnchor(g, dt);
      this.directMembers(g);
    }
  }

  private leaderOf(g: Group): { x: number; z: number; yaw: number } | null {
    const pf = this.arena.player;
    if (pf && pf.fight === this.fight.id && pf.side === g.side && pf.active) return pf;
    // the AI's "follow me" follows the best man of the side
    let best: Fighter | null = null;
    for (const o of this.groups) {
      if (o.side !== g.side) continue;
      for (const f of o.members) if (!best || (f.person?.rankTier ?? 0) > (best.person?.rankTier ?? 0)) best = f;
    }
    return best;
  }

  private moveAnchor(g: Group, dt: number): void {
    const speed = ANCHOR_SPEED[g.gk] * clamp(0.5 + g.cohesion, 0.45, 1);
    switch (g.order) {
      case 'follow': {
        const L = this.leaderOf(g);
        if (!L) break;
        const bx = L.x - Math.sin(L.yaw) * 4.5, bz = L.z - Math.cos(L.yaw) * 4.5;
        const dx = bx - g.ax, dz = bz - g.az, d = Math.hypot(dx, dz);
        const step = Math.min(d, (d > 12 ? 4 : speed * 1.4) * dt);
        if (d > 0.05) { g.ax += (dx / d) * step; g.az += (dz / d) * step; }
        g.yaw = turn(g.yaw, L.yaw, 2.2 * dt);
        break;
      }
      case 'hold': case 'advance': case 'move': {
        const at = g.at;
        if (at) {
          const dx = at.x - g.ax, dz = at.z - g.az, d = Math.hypot(dx, dz);
          if (d > 0.4) {
            const step = Math.min(d, speed * dt);
            g.ax += (dx / d) * step; g.az += (dz / d) * step;
            if (d > 2) g.yaw = turn(g.yaw, Math.atan2(dx, dz), 2.0 * dt);
            else if (g.order !== 'move') g.yaw = turn(g.yaw, this.facingFor(g), 1.2 * dt);
          } else g.yaw = turn(g.yaw, this.facingFor(g), 1.2 * dt);
        } else g.yaw = turn(g.yaw, this.facingFor(g), 1.2 * dt);
        break;
      }
      default:
        // charge, loose, retreat: no formation to hold; the anchor shadows the men so the next order starts from where they are
        g.ax = g.cx; g.az = g.cz;
        g.formed = false;
    }
  }

  /** Fills each man's directive from the group's order and his place in the file. */
  private directMembers(g: Group): void {
    const m = g.members;
    const n = m.length;
    const sin = Math.sin(g.yaw), cos = Math.cos(g.yaw);
    const slotMode = g.order === 'hold' || g.order === 'advance' || g.order === 'move' || g.order === 'follow';
    const mounted = g.gk === 2;
    const speed = FOLLOW_SPEED[g.gk];
    const target = g.target ? this.arena.byKey.get(g.target) ?? null : null;
    const live = target && target.active ? target : null;
    let near = 0;
    for (let i = 0; i < n; i++) {
      const f = m[i];
      if (slotMode) {
        slotOffset(g.formation, i, n, mounted, SLOT);
        f.dMode = D.Slot;
        f.dx = g.ax + SLOT.lx * cos + SLOT.lz * sin;
        f.dz = g.az - SLOT.lx * sin + SLOT.lz * cos;
        f.dYaw = g.yaw;
        const wall = g.formation === 'shield_wall';
        f.dEngage = g.order === 'move' ? 1.6 : g.order === 'hold' ? (wall ? 3.0 : 4.2) : g.order === 'follow' ? 5.5 : (wall ? 3.5 : 7);
        if (g.gk === 1) f.dEngage = 14;
        f.dLeash = g.order === 'move' ? 2.5 : g.order === 'hold' ? (wall ? 4 : 7) : g.order === 'follow' ? 9 : (wall ? 5 : 10);
        f.dSpeed = wall ? speed * 0.85 : speed;
        f.dGuard = wall && g.order !== 'move';
        const sd = Math.hypot(f.dx - f.x, f.dz - f.z);
        f.dHurry = sd > 6;
        if (sd < 4.5) near++;
        f.dTarget = null;
      } else if (g.order === 'charge') {
        f.dMode = D.Charge; f.dTarget = live; f.dGuard = false; f.dHurry = false;
      } else if (g.order === 'retreat') {
        f.dMode = D.Retreat;
        f.dx = g.at ? g.at.x : g.cx; f.dz = g.at ? g.at.z : g.cz;
        f.dTarget = null; f.dGuard = false; f.dHurry = false;
      } else {
        // loose: at will, but at the named enemy if there is one
        f.dMode = D.Free; f.dTarget = live; f.dGuard = false; f.dHurry = false;
      }
    }
    g.cohesion = n > 0 ? (slotMode ? near / n : 1) : 1;
  }

  // ---------------------------------------------------------------------------------------------
  // Orders
  // ---------------------------------------------------------------------------------------------

  /** Applies an order to a group. `byPlayer` marks the player's own (the AI commander leaves such a group alone for a while). */
  give(g: Group, o: GroupOrder, byPlayer: boolean): CommandResult {
    if (g.count === 0) return { ok: false, reason: 'No one is left in that group' };
    const enemy = { x: 0, z: 0 };
    const haveEnemy = this.enemyCentre(g.side, enemy);
    const was = g.order;
    switch (o.kind) {
      case 'formation': {
        if (!o.formation) return { ok: false, reason: 'Which formation?' };
        g.formation = o.formation;
        g.byPlayer = byPlayer || g.byPlayer;
        return { ok: true };
      }
      case 'hold': {
        g.order = 'hold';
        g.at = o.at ? { x: o.at.x, z: o.at.z } : { x: g.cx, z: g.cz };
        break;
      }
      case 'advance': {
        let at = o.at ?? null;
        if (!at) {
          if (!haveEnemy) return { ok: false, reason: 'Advance where?' };
          const d = Math.hypot(enemy.x - g.cx, enemy.z - g.cz);
          const k = d > 30 ? Math.max(8, d * 0.6) / d : 1;
          at = { x: g.cx + (enemy.x - g.cx) * k, z: g.cz + (enemy.z - g.cz) * k };
        }
        g.order = 'advance';
        g.at = { x: at.x, z: at.z };
        break;
      }
      case 'move': {
        if (!o.at) return { ok: false, reason: 'Move where?' };
        g.order = 'move';
        g.at = { x: o.at.x, z: o.at.z };
        break;
      }
      case 'follow': {
        if (!this.leaderOf(g)) return { ok: false, reason: 'There is nobody to follow' };
        g.order = 'follow';
        g.at = null;
        break;
      }
      case 'charge': case 'loose': {
        g.order = o.kind;
        g.at = o.at ? { x: o.at.x, z: o.at.z } : null;
        g.target = this.enemyTarget(g, o.target);
        break;
      }
      case 'retreat': {
        g.order = 'retreat';
        if (o.at) g.at = { x: o.at.x, z: o.at.z };
        else if (haveEnemy) {
          const dx = g.cx - enemy.x, dz = g.cz - enemy.z, d = Math.hypot(dx, dz) || 1;
          g.at = { x: g.cx + (dx / d) * 55, z: g.cz + (dz / d) * 55 };
        } else g.at = { x: g.cx, z: g.cz };
        break;
      }
      default:
        return { ok: false, reason: 'No such order' };
    }
    if (o.kind !== 'charge' && o.kind !== 'loose') g.target = 0;
    if (!g.formed || !(was === 'hold' || was === 'advance' || was === 'move' || was === 'follow')) {
      // re-form where the men stand
      g.ax = g.cx; g.az = g.cz; g.formed = true;
      if (o.kind === 'advance' || o.kind === 'move') g.yaw = Math.atan2((g.at?.x ?? g.cx) - g.cx, (g.at?.z ?? g.cz) - g.cz);
      else g.yaw = this.facingFor(g);
    }
    g.orderT = 0;
    g.byPlayer = byPlayer;
    return { ok: true };
  }

  /** The enemy fighter an order names, as a person id (0 = the nearest, chosen by each man); anything else is ignored. */
  private enemyTarget(g: Group, who: PersonId | undefined): PersonId {
    if (!who) return 0;
    const f = this.arena.byKey.get(who);
    if (!f || !f.person || f.side === g.side || f.fight !== this.fight.id || !f.active) return 0;
    return who;
  }

  // ---------------------------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------------------------

  viewOf(g: Group): BattleGroupView {
    return {
      key: KEY_OF[g.gk], label: GROUP_NAMES[g.gk], count: g.count, x: g.cx, z: g.cz, yaw: g.yaw, order: g.order, formation: g.formation,
      at: g.at ? { x: g.at.x, z: g.at.z } : null, target: g.target, engaged: g.engaged, morale: g.morale,
    };
  }

  /** The player's commanded groups (plus an 'all' row when there are several), or the enemy's groups within `within` m of (px, pz). */
  views(side: 'own' | 'enemy', px: number, pz: number, within = 160): BattleGroupView[] {
    const out: BattleGroupView[] = [];
    if (side === 'own') {
      if (this.playerSide < 0) return out;
      const mine = this.groups.filter((g) => g.side === this.playerSide && g.layer === 1 && g.count > 0);
      if (mine.length === 0) return out;
      out.push(this.allRow(mine));
      for (const g of mine) out.push(this.viewOf(g));
      return out;
    }
    const sides = new Set<number>();
    for (let s = 0; s < this.fight.sides.length; s++) if (s !== this.playerSide) sides.add(s);
    for (const g of this.groups) {
      if (!sides.has(g.side) || g.count === 0) continue;
      if (Math.hypot(g.cx - px, g.cz - pz) > within) continue;
      out.push(this.viewOf(g));
    }
    return out;
  }

  private allRow(groups: readonly Group[]): BattleGroupView {
    let n = 0, sx = 0, sz = 0, mor = 0, eng = false;
    let lead = groups[0];
    for (const g of groups) {
      n += g.count; sx += g.cx * g.count; sz += g.cz * g.count; mor += g.morale * g.count; eng = eng || g.engaged;
      if (g.count > lead.count) lead = g;
    }
    return {
      key: 'all', label: 'All', count: n, x: sx / n, z: sz / n, yaw: lead.yaw, order: lead.order, formation: lead.formation,
      at: lead.at ? { x: lead.at.x, z: lead.at.z } : null, target: lead.target, engaged: eng, morale: mor / n,
    };
  }

  /** Groups an order to `key` reaches in the player's layer. */
  commanded(key: GroupKey): Group[] {
    if (this.playerSide < 0) return [];
    return this.groups.filter((g) => g.side === this.playerSide && g.layer === 1 && g.count > 0 && (key === 'all' || KEY_OF[g.gk] === key));
  }

  /** The group a man belongs to (null for the player, beasts and the fallen). */
  groupOf(f: Fighter): Group | null {
    if (f.isPlayer || f.isAnimal) return null;
    return this.find(f.side, f.layer, f.gk) ?? this.find(f.side, 0, f.gk) ?? null;
  }
}

function weight(f: Fighter): number {
  return (f.gear.shield ? 100 : 0) + f.gear.worn * 2 + f.melee + (f.person?.rankTier ?? 0) * 3;
}

function turn(cur: number, target: number, step: number): number {
  let d = target - cur;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  if (Math.abs(d) <= step) return target;
  return cur + (d > 0 ? step : -step);
}
