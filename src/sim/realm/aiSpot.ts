// Where an AI ruler puts a building: the same `check` the player's ghost asks, a bounded number of times (so the longest call of a
// round stays a few milliseconds whatever the crowd), with the layout a lord would choose: houses among the houses, workshops at the
// edge, mines and quarries on their deposits, a lumber camp in the wood, palisades and walls in runs on the side the danger comes from.
import { BUILDINGS, type BuildingKind } from '../../content/types';
import { hash01, yawTo, type P2 } from '../../core/math';
import type { Deposit, ResourceKind } from '../../world/types';
import type { ConstructionInstall } from '../construction';
import { rulesOf } from '../construction/data';
import type { PlacementCheck } from '../construction/types';
import type { PoliticsRuntime } from '../politics/types';
import type { BuildingState } from '../state';
import { AI } from './aiConfig';
import type { Place, Sense } from './aiSense';
import type { Rlm } from './store';

const GOLDEN = 2.399963229728653;

interface Cand { x: number; z: number; rot: number }

/** The way a door should face at a point: toward the nearest street if the module can say, else toward the middle of the place. */
function facing(R: Rlm, x: number, z: number, cx: number, cz: number): number {
  const core = (R.construction as ConstructionInstall | undefined)?.core;
  const road = core?.spatial?.nearestRoadPoint?.(x, z, 40);
  return road ? yawTo(x, z, road.x, road.z) : yawTo(x, z, cx, cz);
}

/** A building of the place to start the search from: a house for houses, so a new one stands among them. */
function anchorOf(R: Rlm, place: Place, kind: BuildingKind, salt: number): P2 {
  const list = R.state.buildingsAt.get(place.id) ?? [];
  const homes = BUILDINGS[kind].cat === 'home';
  const pool: BuildingState[] = [];
  for (const b of list) if (b.construction >= 1 && (!homes || BUILDINGS[b.kind].cat === 'home')) pool.push(b);
  if (pool.length === 0) return { x: place.s.x, z: place.s.z };
  pool.sort((a, b) => a.id - b.id);
  const b = pool[Math.floor(hash01(place.id, salt, kind.length) * pool.length) % pool.length];
  return { x: b.x, z: b.z };
}

/** Spiral of spots round an origin, the doors turned toward the street. */
function spiral(R: Rlm, place: Place, kind: BuildingKind, origin: P2, n: number, radius: number, salt: number): Cand[] {
  const def = BUILDINGS[kind];
  const step = Math.max(5, Math.min(def.w, def.d) * 0.9);
  const out: Cand[] = [];
  const turn = hash01(place.id, salt, 17) * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const r = step * Math.sqrt(i + 0.5) * 0.95;
    if (r > radius) break;
    const a = turn + i * GOLDEN;
    const x = origin.x + Math.cos(a) * r, z = origin.z + Math.sin(a) * r;
    out.push({ x, z, rot: facing(R, x, z, place.s.x, place.s.z) });
  }
  return out;
}

/** Spots on and about the deposits of the kinds, nearest to the origin first (the same layout as the module's own). */
function depositSpots(R: Rlm, kinds: readonly ResourceKind[], origin: P2, home: P2 | undefined, reach: number, max: number): Cand[] {
  const t = R.territory;
  const found: Deposit[] = [];
  if (t) for (const k of kinds) found.push(...t.depositsNear(origin.x, origin.z, reach, k));
  found.sort((a, b) => (a.x - origin.x) ** 2 + (a.z - origin.z) ** 2 - ((b.x - origin.x) ** 2 + (b.z - origin.z) ** 2) || a.id - b.id);
  const out: Cand[] = [];
  for (const d of found.slice(0, 6)) {
    for (let i = 0; i < 10 && out.length < max; i++) {
      const r = i === 0 ? 0 : Math.sqrt(i / 10) * d.radius * 0.8;
      const a = i * GOLDEN;
      const x = d.x + Math.cos(a) * r, z = d.z + Math.sin(a) * r;
      out.push({ x, z, rot: home ? yawTo(x, z, home.x, home.z) : 0 });
    }
  }
  return out;
}

/** Spots in the place's woods, nearest first: rings round the village, kept where the woodland map and the land both say forest. */
function woodSpots(R: Rlm, place: Place, max: number): Cand[] {
  const T = R.territory;
  const out: Array<Cand & { d: number }> = [];
  const salt = hash01(place.id, 5, 9) * Math.PI * 2;
  for (let ring = 0; ring < 9; ring++) {
    const r = 110 + ring * 120;
    const steps = 14 + ring * 2;
    for (let i = 0; i < steps; i++) {
      const a = salt + (i / steps) * Math.PI * 2 + ring * 0.37;
      const x = place.s.x + Math.cos(a) * r, z = place.s.z + Math.sin(a) * r;
      if (R.world.forestAt(x, z) < 0.5) continue;
      if (T) {
        const land = T.landAt(x, z);
        if (land.kind !== 'forest' || (land.settlement !== place.id && land.settlement !== place.s.parent)) continue;
      }
      out.push({ x, z, rot: yawTo(x, z, place.s.x, place.s.z), d: r });
    }
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}

/** The side of a place the danger comes from: the bearing to the seat of the nearest hostile or strong neighbour. */
export function threatBearing(R: Rlm, S: Sense, place: Place): number {
  const pol = R.politics as unknown as PoliticsRuntime | undefined;
  let bw = -Infinity, bx = 0, bz = 0, found = false;
  if (pol) {
    for (const o of pol.neighbours(S.house).slice(0, 8)) {
      const st = pol.stance(o, S.house);
      const w = st === 'war' ? 3 : st === 'hostile' ? 2 : st === 'neutral' ? 1 : 0;
      if (w === 0) continue;
      const s = R.settlementById.get(R.state.houses.get(o)?.seat ?? -1);
      if (!s) continue;
      const key = w * 10000 - Math.hypot(s.x - place.s.x, s.z - place.s.z);
      if (key > bw) { bw = key; bx = s.x; bz = s.z; found = true; }
    }
  }
  if (!found) return hash01(place.id, 3, 5) * Math.PI * 2;
  return Math.atan2(bz - place.s.z, bx - place.s.x);
}

/** The newest run of palisade or wall the place has, as the two spots at its ends, to carry on from. */
function runEnds(R: Rlm, place: Place): Cand[] {
  const list = R.state.buildingsAt.get(place.id) ?? [];
  let last: BuildingState | null = null;
  for (const b of list) {
    if (b.plot >= 0 || (b.kind !== 'palisade' && b.kind !== 'wall')) continue;
    if (!last || b.id > last.id) last = b;
  }
  if (!last) return [];
  const w = BUILDINGS[last.kind].w;
  const dx = Math.cos(last.rot) * w, dz = -Math.sin(last.rot) * w;
  return [
    { x: last.x + dx, z: last.z + dz, rot: last.rot },
    { x: last.x - dx, z: last.z - dz, rot: last.rot },
  ];
}

/** Spots for a run of walling: carry on from the newest run, else along a ring on the side the danger comes from. */
function wallSpots(R: Rlm, S: Sense, place: Place, kind: BuildingKind): Cand[] {
  const def = BUILDINGS[kind];
  const out: Cand[] = [];
  for (const e of runEnds(R, place)) {
    out.push(e);
    // the run may bend a little as it goes round
    for (const turn of [0.18, -0.18]) out.push({ x: e.x, z: e.z, rot: e.rot + turn });
  }
  const base = place.s.radius + 6;
  const a0 = threatBearing(R, S, place);
  for (const dr of [0, 8, -8, 16, -16, 26]) {
    const r = Math.max(20, base + dr);
    const step = def.w / r;
    for (let i = 0; i < 8; i++) {
      const a = a0 + (i % 2 === 0 ? 1 : -1) * Math.ceil(i / 2) * step;
      const x = place.s.x + Math.cos(a) * r, z = place.s.z + Math.sin(a) * r;
      out.push({ x, z, rot: yawTo(x, z, place.s.x, place.s.z) });
    }
  }
  return out;
}

export interface SpotHint {
  /** Look near this point instead of the place's own middle (outposts at a deposit). */
  near?: P2;
  /** The place the building must belong to (−1: a new outpost). */
  settlement?: number;
}

/**
 * A valid spot for the building, found with at most `AI.searchChecks` looks: houses among the houses, farm and works at the edge,
 * mines and quarries on their deposits, a lumber camp in the wood, palisades and walls in runs. Null when nothing fits in that many
 * looks (the ruler tries another day). Spots on a field, a road or water are passed over without a look.
 */
export function findSpot(R: Rlm, S: Sense, place: Place, kind: BuildingKind, hint: SpotHint = {}): PlacementCheck | null {
  const C = R.construction;
  if (!C) return null;
  const rules = rulesOf(kind);
  const def = BUILDINGS[kind];
  const wantSettlement = hint.settlement ?? place.id;
  const salt = Math.floor(R.day / 4);
  let cands: Cand[];
  if (rules.terrain === 'deposit') {
    const origin = hint.near ?? { x: place.s.x, z: place.s.z };
    cands = depositSpots(R, rules.deposits ?? [], origin, hint.near ? undefined : { x: place.s.x, z: place.s.z }, hint.near ? 900 : 3500, AI.searchChecks);
  } else if (rules.terrain === 'forest') {
    cands = woodSpots(R, place, AI.searchChecks);
  } else if (def.segment) {
    cands = wallSpots(R, S, place, kind);
  } else {
    const radius = Math.max(40, place.s.radius * 1.3);
    let origin: P2;
    if (hint.near) origin = hint.near;
    else if (rules.cat === 'farm' || rules.cat === 'resource') origin = { x: place.s.x + Math.cos(kind.length + salt) * place.s.radius * 0.7, z: place.s.z + Math.sin(kind.length + salt) * place.s.radius * 0.7 };
    else origin = anchorOf(R, place, kind, salt);
    cands = spiral(R, place, kind, origin, AI.searchChecks * 2, radius, salt);
  }
  const T = R.territory;
  let looked = 0;
  for (const c of cands) {
    if (looked >= AI.searchChecks) break;
    if (T) {
      // a field, a road or the water is no place for a building: no need to ask the builder
      const k = T.landAt(c.x, c.z).kind;
      if (k === 'field' || k === 'road' || k === 'water') continue;
    }
    for (const turn of [0, Math.PI / 2]) {
      looked++;
      const e = C.check(S.ruler, kind, c.x, c.z, c.rot + turn);
      const here = wantSettlement < 0 ? e.settlement < 0 || e.outpost !== undefined : e.settlement === wantSettlement;
      if (e.ok && here) return e;
      // a slot that is tight may fit turned a quarter; any other refusal is not worth turning for
      if (!/Overlaps|On the road|On a strip/.test(e.reason ?? '')) break;
    }
  }
  return null;
}
