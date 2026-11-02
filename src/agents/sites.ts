// Construction sites as the schedule sees them (docs/CIV.md §5): who is at work on which site today, and the spot and the work they have
// there — digging the footings, sawing and framing, dressing and laying stone, hauling timber and thatch from the pile, roofing, pulling
// down. The construction module (`sim.services.construction`) says who works where (`workersAt`); members of a household whose task is
// 'build' go to that household's site as well. Looked at lazily and guarded: without the module, or with no sites, nothing changes.
import { BUILDINGS, type BuildingKind } from '../content/types';
import { hash01 } from '../core/math';
import type { AnimState, CarryLook, HeldItem } from '../core/view';
import type { ConstructionApi, SiteView } from '../sim/construction/types';
import type { EconomyApi } from '../sim/economy/types';
import type { Person, PersonId } from '../sim/state';
import { frontPoint, type DoorPoint } from './geometry';

/** Where a worker stands and what they do (written into the schedule's intent). */
export interface SiteSpot {
  x: number; z: number; yaw: number;
  anim: AnimState; main: HeldItem; off: HeldItem; carry: CarryLook;
  label: string;
  /** Carries `carry` between the pile (bx, bz) and the work (x, z). */
  haul: boolean;
  bx: number; bz: number;
}

/** Buildings raised in stone (dressed and laid) rather than in timber (sawn, framed and thatched). */
const STONE: ReadonlySet<BuildingKind> = new Set<BuildingKind>([
  'chapel', 'church', 'abbey_church', 'cathedral', 'cloister', 'infirmary', 'keep_stone', 'tower', 'wall', 'gatehouse', 'guildhall',
  'warehouse', 'gaol', 'well', 'kiln', 'bloomery', 'watermill', 'manor_house', 'market_cross',
]);
/** Works dug out of the ground rather than built up. */
const EARTH: ReadonlySet<BuildingKind> = new Set<BuildingKind>(['motte', 'quarry', 'clay_pit', 'salt_pan', 'mine', 'charcoal_mound', 'sheepfold']);

const DONE: ReadonlySet<string> = new Set(['done', 'cancelled']);

export class SiteWork {
  private readonly byPerson = new Map<PersonId, SiteView>();
  private version = -1;
  private hour = -1;
  private api: ConstructionApi | undefined;

  constructor(
    private readonly lookup: () => ConstructionApi | undefined,
    private readonly economy: EconomyApi,
    /** The sim's present absolute day: who works where is only known for today. */
    private readonly now: () => number,
  ) {}

  /** The site this person works at today (and is asked about `absDay` of today), or null. */
  siteOf(p: Person, absDay: number): SiteView | null {
    const c = this.lookup();
    if (!c) return null;
    const now = this.now();
    if (Math.floor(absDay) !== Math.floor(now)) return null;
    let version = 0;
    try { version = c.version(); } catch { return null; }
    const hour = Math.floor(now * 24);
    if (c !== this.api || version !== this.version || hour !== this.hour) { this.api = c; this.version = version; this.hour = hour; this.rebuild(c); }
    return this.byPerson.size === 0 ? null : this.byPerson.get(p.id) ?? null;
  }

  private rebuild(c: ConstructionApi): void {
    const map = this.byPerson;
    map.clear();
    try {
      const sites = c.sites().filter((s) => !DONE.has(s.status));
      if (sites.length === 0) return;
      for (const s of sites) for (const w of c.workersAt(s.id)) if (!map.has(w)) map.set(w, s);
      // the members of a household on the 'build' task go to the household's first site
      const first = new Map<number, SiteView>();
      for (const s of sites) {
        const cur = first.get(s.household);
        if (!cur || s.priority < cur.priority || (s.priority === cur.priority && s.id < cur.id)) first.set(s.household, s);
      }
      for (const [household, s] of first) {
        for (const line of this.economy.householdPlan(household)) if (line.task === 'build' && !map.has(line.person)) map.set(line.person, s);
      }
    } catch {
      map.clear();
    }
  }
}

const tmp: DoorPoint = { x: 0, z: 0, yaw: 0 };

/**
 * The spot and work of a person on a site today. Deterministic from the person, the site and the day: where they stand around the
 * building (outside its footprint when it is solid), whether they saw, hammer, dress or lay stone, or haul material from the pile.
 */
export function siteSpot(p: Person, s: SiteView, day: number, out: SiteSpot): SiteSpot {
  const def = BUILDINGS[s.kind];
  const h = (k: number): number => hash01(p.id, s.id * 13 + k, day % 5);
  const stone = STONE.has(s.kind);
  const earth = EARTH.has(s.kind);
  const name = def.name.toLowerCase();
  // where: a place on the ring round the footprint, or inside it for open works
  const hw = def.w / 2, hd = def.d / 2;
  const rot = s.rot;
  const placed = { kind: s.kind, x: s.x, z: s.z, rot };
  if (def.blocks && !earth) {
    const per = 2 * (def.w + def.d);
    let u = h(1) * per;
    const gap = 1.7 + 1.0 * h(2);
    let lx: number, lz: number;
    if (u < def.w) { lx = -hw + u; lz = hd + gap; }
    else if ((u -= def.w) < def.d) { lx = hw + gap; lz = hd - u; }
    else if ((u -= def.d) < def.w) { lx = hw - u; lz = -hd - gap; }
    else { u -= def.w; lx = -hw - gap; lz = -hd + u; }
    frontPoint(placed, lx, lz, tmp, 0);
    out.x = tmp.x; out.z = tmp.z;
    out.yaw = Math.atan2(s.x - out.x, s.z - out.z);
  } else {
    frontPoint(placed, (h(1) - 0.5) * Math.max(1, def.w - 3), (h(2) - 0.5) * Math.max(1, def.d - 3), tmp, 0);
    out.x = tmp.x; out.z = tmp.z;
    out.yaw = rot + (h(3) - 0.5) * 3;
  }
  // the pile of material: out on the front side, at a distance that depends on the site
  frontPoint(placed, (hash01(s.id, 5) - 0.5) * def.w, hd + 7 + 7 * hash01(s.id, 6), tmp, 0);
  out.bx = tmp.x; out.bz = tmp.z;
  out.haul = false;
  out.main = 'none'; out.off = 'none'; out.carry = 'none';

  const r = h(4);
  if (s.work === 'demolish') {
    out.anim = r < 0.5 ? 'work_pick' : 'work_hammer'; out.main = r < 0.5 ? 'pick' : 'hammer'; out.label = `Pulling down the ${name}`;
    if (r > 0.8) { out.anim = 'work_lift'; out.carry = stone ? 'stone' : 'bundle_wood'; out.haul = true; out.label = 'Carrying off the rubble'; }
    return out;
  }
  if (s.work === 'repair') {
    out.anim = r < 0.65 ? 'work_hammer' : 'work_saw'; out.main = r < 0.65 ? 'hammer' : 'saw'; out.label = `Mending the ${name}`;
    return out;
  }
  const prog = s.progress;
  const verb = s.work === 'upgrade' ? 'Improving' : 'Raising';
  if (prog < 0.2 || earth) {
    // pegs and footings: digging, and carrying the first stone or timber
    if (r < 0.62 || earth && r < 0.85) { out.anim = earth && stone ? 'work_pick' : 'work_dig'; out.main = earth && stone ? 'pick' : 'spade'; out.label = earth ? `Digging at the ${name}` : `Digging the footings of the ${name}`; }
    else { out.anim = 'work_lift'; out.carry = stone ? 'stone' : 'bundle_wood'; out.haul = true; out.label = `Fetching for the ${name}`; }
    return out;
  }
  if (prog < 0.65) {
    if (stone) {
      if (r < 0.34) { out.anim = 'work_pick'; out.main = 'chisel'; out.label = `Dressing stone for the ${name}`; }
      else if (r < 0.62) { out.anim = 'work_hammer'; out.main = 'hammer'; out.label = `Laying the walls of the ${name}`; }
      else { out.anim = 'work_hammer'; out.main = 'hammer'; out.carry = 'stone'; out.haul = true; out.label = `Carrying stone to the ${name}`; }
    } else if (r < 0.3) { out.anim = 'work_saw'; out.main = 'saw'; out.label = `Sawing timber for the ${name}`; }
    else if (r < 0.7) { out.anim = 'work_hammer'; out.main = 'hammer'; out.label = `${verb} the frame of the ${name}`; }
    else { out.anim = 'work_hammer'; out.main = 'hammer'; out.carry = 'bundle_wood'; out.haul = true; out.label = `Hauling timber to the ${name}`; }
    return out;
  }
  // the roof, the doors and the finishing
  if (r < 0.5) { out.anim = 'work_hammer'; out.main = 'hammer'; out.label = `Roofing the ${name}`; }
  else if (r < 0.8) { out.anim = 'work_hammer'; out.main = 'hammer'; out.carry = stone ? 'bundle_wood' : 'sheaf'; out.haul = true; out.label = stone ? `Carrying timber to the ${name}` : `Carrying thatch to the ${name}`; }
  else { out.anim = 'work_saw'; out.main = 'saw'; out.label = `Fitting out the ${name}`; }
  return out;
}
