// What the player can interact with near a point: people, animals, building doors, strips and
// parcels, trees and rocks. Each candidate is scored by distance and by how much it is in front of
// the player (so the thing you are looking at wins), and carries a short label for the prompt.
import { BUILDINGS } from '../content/types';
import { angleDiff, pointInPolygon } from '../core/math';
import { roleLabel } from '../sim/careers';
import { fullName, type BuildingState } from '../sim/state';
import type { LandParcel, Strip } from '../world/types';
import { doorStand } from './geometry';
import { scatterKindOf } from './nav/obstacles';
import type { InteractCandidate } from './types';
import type { Zone } from './zone';

const SCATTER_NAMES: Record<string, string> = {
  oak: 'Oak', beech: 'Beech', birch: 'Birch', ash: 'Ash', willow: 'Willow', pine: 'Pine', spruce: 'Spruce', apple: 'Apple tree',
  deadtree: 'Dead tree', rock_large: 'Rock', boulder: 'Boulder',
};
const PARCEL_NAMES: Record<LandParcel['use'], string> = {
  pasture: 'Pasture', meadow: 'Meadow', garden: 'Garden', orchard: 'Orchard', woodlot: 'Woodlot', demesne: "The lord's close",
};
const CROP_NAMES: Record<string, string> = {
  wheat: 'wheat', rye: 'rye', barley: 'barley', oats: 'oats', peas: 'peas', beans: 'beans', flax: 'flax', cabbage: 'cabbages',
  onions: 'onions', leeks: 'leeks', turnips: 'turnips', fallow: 'fallow',
};

/** A coarse cell index over rectangles, built once. */
class CellIndex {
  private readonly cells = new Map<number, number[]>();
  constructor(private readonly cell: number, count: number, bounds: (i: number, out: number[]) => void) {
    const b = [0, 0, 0, 0];
    for (let i = 0; i < count; i++) {
      bounds(i, b);
      for (let cz = Math.floor(b[1] / cell); cz <= Math.floor(b[3] / cell); cz++) {
        for (let cx = Math.floor(b[0] / cell); cx <= Math.floor(b[2] / cell); cx++) {
          const key = cz * 4096 + cx;
          const arr = this.cells.get(key);
          if (arr) arr.push(i); else this.cells.set(key, [i]);
        }
      }
    }
  }
  at(x: number, z: number): readonly number[] | undefined { return this.cells.get(Math.floor(z / this.cell) * 4096 + Math.floor(x / this.cell)); }
  around(x: number, z: number, r: number, fn: (i: number) => void): void {
    const seen = new Set<number>();
    for (let cz = Math.floor((z - r) / this.cell); cz <= Math.floor((z + r) / this.cell); cz++) {
      for (let cx = Math.floor((x - r) / this.cell); cx <= Math.floor((x + r) / this.cell); cx++) {
        const arr = this.cells.get(cz * 4096 + cx);
        if (!arr) continue;
        for (const i of arr) if (!seen.has(i)) { seen.add(i); fn(i); }
      }
    }
  }
}

interface Index {
  strips: CellIndex;
  parcels: CellIndex;
  buildings: CellIndex | null;
  buildingList: BuildingState[];
  buildingRev: number;
}
const indexes = new WeakMap<object, Index>();

function indexFor(z: Zone): Index {
  let ix = indexes.get(z);
  const world = z.world;
  if (!ix) {
    ix = {
      strips: new CellIndex(64, world.strips.length, (i, b) => { const p = world.strips[i].poly; b[0] = Math.min(p[0].x, p[1].x, p[2].x, p[3].x); b[1] = Math.min(p[0].z, p[1].z, p[2].z, p[3].z); b[2] = Math.max(p[0].x, p[1].x, p[2].x, p[3].x); b[3] = Math.max(p[0].z, p[1].z, p[2].z, p[3].z); }),
      parcels: new CellIndex(64, world.parcels.length, (i, b) => {
        let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
        for (const q of world.parcels[i].poly) { if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.z < z0) z0 = q.z; if (q.z > z1) z1 = q.z; }
        b[0] = x0; b[1] = z0; b[2] = x1; b[3] = z1;
      }),
      buildings: null, buildingList: [], buildingRev: -1,
    };
    indexes.set(z, ix);
  }
  const st = z.state;
  if (ix.buildingRev !== st.buildingRevision) {
    ix.buildingRev = st.buildingRevision;
    ix.buildingList = [...st.buildings.values()];
    const list = ix.buildingList;
    ix.buildings = new CellIndex(32, list.length, (i, b) => {
      const o = list[i];
      const def = BUILDINGS[o.kind];
      const r = Math.hypot(def.w, def.d) / 2 + 3;
      b[0] = o.x - r; b[1] = o.z - r; b[2] = o.x + r; b[3] = o.z + r;
    });
  }
  return ix;
}

const pool: InteractCandidate[] = [];
const scores: number[] = [];
let used = 0;

function take(): InteractCandidate {
  let c = pool[used];
  if (!c) { c = { target: { kind: 'self' }, x: 0, z: 0, distance: 0, label: '' }; pool[used] = c; }
  used++;
  return c;
}

export function findInteractables(zone: Zone, x: number, z: number, yaw: number, range: number, out: InteractCandidate[]): InteractCandidate[] {
  used = 0;
  scores.length = 0;
  const sinY = Math.sin(yaw), cosY = Math.cos(yaw);
  const fx = x + sinY * 1.1, fz = z + cosY * 1.1;
  const r2 = range * range;
  const push = (target: InteractCandidate['target'], tx: number, tz: number, dist: number, label: string, bias: number, facingOK = true): void => {
    let pen = 0;
    if (facingOK && dist > 0.4) {
      const ang = Math.abs(angleDiff(yaw, Math.atan2(tx - x, tz - z)));
      pen = (ang / Math.PI) * 2.4;
    }
    const c = take();
    c.target = target; c.x = tx; c.z = tz; c.distance = dist; c.label = label;
    scores.push(dist + pen + bias);
  };

  // people
  const st = zone.state;
  for (const a of zone.agentsArr) {
    if (a.dead || !a.visible) continue;
    const dx = a.x - x, dz = a.z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 > r2) continue;
    const p = a.person;
    const role = roleLabel(p.career, p.careerStage, p.sex).toLowerCase();
    push({ kind: 'person', id: a.personId }, a.x, a.z, Math.sqrt(d2), role ? `${fullName(p)}, ${role}` : fullName(p), -0.4);
  }
  // animals
  for (const an of zone.fauna.list()) {
    const dx = an.x - x, dz = an.z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 > r2) continue;
    push({ kind: 'animal', id: an.id }, an.x, an.z, Math.sqrt(d2), zone.fauna.labelOf(an), -0.2);
  }
  // building doors
  const ix = indexFor(zone);
  const door = zone.door;
  ix.buildings?.around(x, z, range + 8, (i) => {
    const b = ix.buildingList[i];
    const def = BUILDINGS[b.kind];
    if (def.segment) return;
    doorStand(b, door);
    // distance to the door or to the footprint, whichever is nearer
    const dd = Math.hypot(door.x - x, door.z - z);
    const c = Math.cos(b.rot), s = Math.sin(b.rot);
    const lx = (x - b.x) * c - (z - b.z) * s, lz = (x - b.x) * s + (z - b.z) * c;
    const ex = Math.max(0, Math.abs(lx) - def.w / 2), ez = Math.max(0, Math.abs(lz) - def.d / 2);
    const dFoot = Math.hypot(ex, ez);
    // the point is always the door, so a caller checking its action range against (x, z) agrees with `distance`
    void dFoot;
    if (dd > range) return;
    push({ kind: 'building', id: b.id }, door.x, door.z, dd, def.name, 0.5);
  });
  // trees and rocks
  zone.nav.obstacles.forSolids(x - range, z - range, x + range, z + range, (ch, i) => {
    const dx = ch.x[i] - x, dz = ch.z[i] - z;
    const d = Math.max(0, Math.sqrt(dx * dx + dz * dz) - ch.r[i]);
    if (d > range) return;
    const name = SCATTER_NAMES[scatterKindOf(ch.kind[i])] ?? 'Tree';
    push({ kind: 'scatter', id: ch.id[i] }, ch.x[i], ch.z[i], d, name, 0.35);
  });
  // strips and parcels under or just ahead of the player
  const strips = ix.strips.at(fx, fz);
  const stripsHere = ix.strips.at(x, z);
  const seenStrip = new Set<number>();
  for (const list of [stripsHere, strips]) {
    if (!list) continue;
    for (const id of list) {
      if (seenStrip.has(id)) continue;
      seenStrip.add(id);
      const s: Strip = zone.world.strips[id];
      if (!pointInPolygon(x, z, s.poly) && !pointInPolygon(fx, fz, s.poly)) continue;
      const ss = st.strips.get(id);
      const crop = ss ? CROP_NAMES[ss.crop] ?? ss.crop : 'fallow';
      const inHere = pointInPolygon(x, z, s.poly);
      push({ kind: 'strip', id }, inHere ? x : fx, inHere ? z : fz, inHere ? 0 : 1.1, ss && ss.crop === 'fallow' ? 'Fallow strip' : `Strip of ${crop}`, 3.4, false);
    }
  }
  const seenParcel = new Set<number>();
  for (const list of [ix.parcels.at(x, z), ix.parcels.at(fx, fz)]) {
    if (!list) continue;
    for (const id of list) {
      if (seenParcel.has(id)) continue;
      seenParcel.add(id);
      const p = zone.world.parcels[id];
      if (!pointInPolygon(x, z, p.poly) && !pointInPolygon(fx, fz, p.poly)) continue;
      const inHere = pointInPolygon(x, z, p.poly);
      push({ kind: 'parcel', id }, inHere ? x : fx, inHere ? z : fz, inHere ? 0 : 1.1, PARCEL_NAMES[p.use], 3.8, false);
    }
  }
  // best first
  const n = used;
  const order: number[] = [];
  for (let i = 0; i < n; i++) order.push(i);
  order.sort((a, b) => scores[a] - scores[b]);
  out.length = 0;
  for (const i of order) out.push(pool[i]);
  return out;
}
