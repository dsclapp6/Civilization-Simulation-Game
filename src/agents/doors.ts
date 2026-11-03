// Doors (docs/INTERIORS.md): every doorway of a plan has a leaf that is shut or open — a view of the zone, not saved. People
// open and shut them as they go in and out (a pass opens a door for a moment and it swings to behind them), a workshop's,
// an alehouse's, a barn's door stands open in working hours and a church's by day, a home's is shut. At night a home is
// locked to anyone but its household and their servants, the invited and the law; a shut-up place (a workshop, a store, a
// church, a hall) is locked too. A locked door can be forced (src/player: "Force the door"), which breaks it until the morning
// and is a crime the law hears about.
import type { BuildingKind } from '../content/types';
import type { BuildingState, GameState, Person, PersonId } from '../sim/state';
import type { Interiors, Loaded } from './nav/interiors';
import type { PDoor } from '../assets/interiors/types';

/** How far a leaf swings open (rad) and how fast (rad/s). */
export const OPEN_ANGLE = 1.45;
const SWING = 2.6;
/** A door that is passed stays open this long (s) and then swings to. */
const PASS_HOLD = 1.8;
/** A door opened by hand stays open this long before the household shuts it again (s). */
const HAND_HOLD = 40;

const HOMES = new Set<BuildingKind>(['hovel', 'cottage', 'longhouse', 'townhouse', 'manor_house']);
const WORK_OPEN = new Set<BuildingKind>([
  'smithy', 'carpenter', 'tannery', 'weaver', 'bakehouse', 'brewhouse', 'slaughterhouse', 'alehouse', 'tavern', 'watermill', 'fulling_mill',
  'barn', 'tithe_barn', 'stable', 'cowshed', 'warehouse', 'guildhall', 'market_hall', 'school', 'library', 'infirmary',
]);
const CHURCHES = new Set<BuildingKind>(['chapel', 'church', 'abbey_church', 'cathedral', 'cloister']);
/** Open day and night (a garrison's tower, an alehouse at night is still kept open until late). */
const NEVER_LOCKED = new Set<BuildingKind>(['tower', 'gatehouse', 'barracks', 'motte', 'infirmary', 'pigsty', 'henhouse', 'cowshed', 'stable', 'sheepfold']);
const LAW: ReadonlySet<string> = new Set(['bailiff', 'steward', 'sergeant', 'knight', 'man_at_arms', 'soldier', 'squire', 'lord', 'lady']);

interface DoorRec { angle: number; target: number; shutAt: number; /** Sim seconds until the household's habit takes over again. */ hand: number; /** Broken open until this absolute day. */ forced: number }

export interface DoorLock { locked: boolean; why: string }

export class DoorBook {
  private readonly recs = new Map<number, DoorRec>();
  private readonly invites = new Map<PersonId, { building: number; until: number }>();
  private t = 0;
  private dayFrac = 0.5;
  private absDay = 0;

  constructor(private readonly state: GameState, private readonly interiors: Interiors) {}

  private static key(building: number, door: number): number { return building * 256 + door; }

  /** Advances the leaves (sim seconds); `absDay` is the calendar now. */
  step(dt: number, absDay: number): void {
    this.t += dt;
    this.absDay = absDay;
    this.dayFrac = absDay - Math.floor(absDay);
    for (const [k, r] of this.recs) {
      if (r.shutAt > 0 && this.t >= r.shutAt) { r.target = 0; r.shutAt = 0; }
      if (r.hand > 0 && this.t >= r.hand) { r.hand = 0; r.target = 0; }
      const d = r.target - r.angle;
      r.angle += Math.sign(d) * Math.min(Math.abs(d), SWING * dt);
      // back to the habit of the place: forget a shut door that nobody touched
      if (r.angle <= 0 && r.target === 0 && r.shutAt === 0 && r.hand === 0 && r.forced < absDay) this.recs.delete(k);
    }
  }

  /** Does the door stand open by the habit of the place at this hour? */
  standsOpen(b: BuildingState, d: PDoor): boolean {
    if (d.open || d.kind === 'arch') return true;
    if (!d.outer) return false;
    const h = this.dayFrac * 24;
    if (CHURCHES.has(b.kind)) return h >= 6.5 && h < 19 && d.kind !== 'small';
    if (WORK_OPEN.has(b.kind)) return h >= 7 && h < 18.5 && (d.kind === 'wide' || b.kind === 'alehouse' || b.kind === 'tavern' || b.kind === 'smithy' || b.kind === 'bakehouse');
    return false;
  }

  /** How far a door's leaf stands open (rad). */
  angle(building: number, door: number): number {
    const r = this.recs.get(DoorBook.key(building, door));
    if (r) return r.angle;
    const l = this.interiors.loaded.get(building);
    const b = l?.b ?? this.state.buildings.get(building);
    const d = l?.plan.doors[door];
    return b && d && this.standsOpen(b, d) ? OPEN_ANGLE : 0;
  }

  /** Is the door shut (solid) for someone walking? */
  shut(building: number, door: number): boolean { return this.angle(building, door) < 0.95; }

  /** The renderer's question: the leaf of the door at (lx, lz) in the building's frame. */
  angleAt(building: number, lx: number, lz: number): number {
    const b = this.state.buildings.get(building);
    if (!b) return 0;
    const l = this.interiors.placed(b);
    if (!l) return 0;
    const i = doorIndexAt(l, lx, lz);
    return i < 0 ? 0 : this.angle(building, i);
  }

  private rec(building: number, door: number): DoorRec {
    const k = DoorBook.key(building, door);
    let r = this.recs.get(k);
    if (!r) { r = { angle: this.angle(building, door), target: 0, shutAt: 0, hand: 0, forced: -1 }; this.recs.set(k, r); }
    return r;
  }

  /** Someone goes through: the door opens and swings to behind them. */
  pass(building: number, door: number, hold = PASS_HOLD): void {
    if (door < 0) return;
    const r = this.rec(building, door);
    r.target = OPEN_ANGLE;
    if (r.hand === 0) r.shutAt = Math.max(r.shutAt, this.t + hold);
  }

  /** Opened or shut by hand (the player's E): it stays so a while, then the household's habit comes back. */
  set(building: number, door: number, open: boolean): void {
    const r = this.rec(building, door);
    r.target = open ? OPEN_ANGLE : 0;
    r.shutAt = 0;
    r.hand = this.t + HAND_HOLD;
  }

  /** Broken open: it will not lock again until the morning. */
  force(building: number, door: number): void {
    const r = this.rec(building, door);
    r.forced = Math.floor(this.absDay) + (this.dayFrac > 0.5 ? 1.25 : 0.25);
    r.target = OPEN_ANGLE;
    r.shutAt = 0;
    r.hand = this.t + HAND_HOLD;
  }

  isOpen(building: number, door: number): boolean { return this.angle(building, door) > 0.6; }

  /** The household let someone in: they may pass its doors until `until` (absolute day). */
  invite(person: PersonId, building: number, until: number): void { this.invites.set(person, { building, until }); }

  /** Is this door locked to this person now, and why? */
  lockFor(p: Person, b: BuildingState, door: number): DoorLock {
    const l = this.interiors.loaded.get(b.id) ?? this.interiors.placed(b);
    const d = l?.plan.doors[door];
    const open: DoorLock = { locked: false, why: '' };
    if (!d || !d.outer || d.open || d.kind === 'arch') return open;
    const r = this.recs.get(DoorBook.key(b.id, door));
    if (r && r.forced >= this.absDay) return open;
    if (NEVER_LOCKED.has(b.kind)) return open;
    const h = this.dayFrac * 24;
    const night = h < 5.5 || h >= 21;
    const shutUp = night || (!HOMES.has(b.kind) && !CHURCHES.has(b.kind) && (h < 6 || h >= 20));
    if (!shutUp) return open;
    if (this.mayPass(p, b)) return open;
    const what = HOMES.has(b.kind) ? 'The door is barred for the night.' : CHURCHES.has(b.kind) ? 'The church is locked for the night.' : 'The place is shut up for the night.';
    return { locked: true, why: what };
  }

  /** The owner, his household and their servants, the invited and the law may pass a locked door. */
  mayPass(p: Person, b: BuildingState): boolean {
    const st = this.state;
    if (b.household && p.household === b.household) return true;
    for (const hh of st.households.values()) if (hh.home === b.id && hh.members.includes(p.id)) return true;
    if (b.owner && p.house === b.owner && p.house !== 0) return true;
    const inv = this.invites.get(p.id);
    if (inv && inv.building === b.id && inv.until > this.absDay) return true;
    if (LAW.has(p.career) && p.settlement === b.settlement) return true;
    // the clergy have the keys of their church
    if (CHURCHES.has(b.kind) && (p.career === 'priest' || p.career === 'monk' || p.career === 'nun' || p.career === 'prior' || p.career === 'abbot' || p.career === 'bishop' || p.career === 'clerk')) return true;
    return false;
  }

  clear(): void { this.recs.clear(); this.invites.clear(); }
}

/** The index of the door of a plan whose threshold is at (lx, lz) (−1 none within 0.4 m). */
export function doorIndexAt(l: Loaded, lx: number, lz: number): number {
  let best = -1, bd = 0.4;
  const ds = l.plan.doors;
  for (let i = 0; i < ds.length; i++) {
    const d = Math.hypot(ds[i].x - lx, ds[i].z - lz);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}
