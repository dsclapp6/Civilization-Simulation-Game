// Where a building's model stands (pure; docs/INTERIORS.md): the renderer sets the model here and the navigation puts its inside
// at the same place, so a floor one walks on is the floor one sees. Water buildings (mills, the tannery, the dock) are turned to
// put their race or quay over the water; a model sits on the lower corners of its footprint, a little sunk (the plinth reaches
// 0.8 m down).
import { BUILDINGS, type BuildingKind } from '../../content/types';

export interface PlacementWorld {
  size: number;
  heightAt(x: number, z: number): number;
  waterSurfaceAt(x: number, z: number): number | null;
  settlements?: ReadonlyArray<{ id: number; x: number; z: number }>;
}

/** A piece of fortification a tower may stand against (a length of wall or palisade, a gatehouse). */
export interface WallPiece { kind: BuildingKind; x: number; z: number; rot: number }
export const WALL_PIECES: ReadonlySet<BuildingKind> = new Set<BuildingKind>(['wall', 'palisade', 'gatehouse']);

/** Does a piece of wall end against the face of a tower that looks along (fx, fz)? Its door there would open into masonry. */
function faceBlocked(tx: number, tz: number, fx: number, fz: number, pieces: Iterable<WallPiece>): boolean {
  const th = BUILDINGS.tower.w / 2;
  for (const p of pieces) {
    if (!WALL_PIECES.has(p.kind)) continue;
    const vx = p.x - tx, vz = p.z - tz;
    const along = vx * fx + vz * fz;
    if (along <= 0 || along > th + 14) continue;
    const perp = Math.abs(vx * -fz + vz * fx);
    if (perp > th + 0.5) continue;
    // the piece's half extent along the face: the wall's x axis in the world is (cos, −sin), its z axis (sin, cos)
    const def = BUILDINGS[p.kind];
    const c = Math.cos(p.rot), s = Math.sin(p.rot);
    const half = Math.abs(fx * c - fz * s) * def.w / 2 + Math.abs(fx * s + fz * c) * def.d / 2;
    if (along - half < th + 1.2) return true;
  }
  return false;
}

/**
 * A wall tower is turned by quarter turns so its door (the recipe's, on local +z) faces the middle of its place, inside the walls
 * (agents/nav/walls.ts turns its stairs the same way: `towerFacing`). A face that a length of wall ends against is no door's place
 * (a corner tower has two of them): the nearest free turn is taken — for a corner tower, the door on the outer side.
 */
export function towerTurn(rot: number, x: number, z: number, cx: number, cz: number, pieces?: Iterable<WallPiece>): number {
  const want = Math.atan2(cx - x, cz - z);
  const cands: Array<{ r: number; d: number }> = [];
  for (let k = 0; k < 4; k++) {
    const r = rot + (k * Math.PI) / 2;
    cands.push({ r, d: Math.abs(Math.atan2(Math.sin(want - r), Math.cos(want - r))) });
  }
  cands.sort((a, b) => a.d - b.d || a.r - b.r);
  if (pieces) {
    const list = [...pieces];
    for (const c of cands) if (!faceBlocked(x, z, Math.sin(c.r), Math.cos(c.r), list)) return c.r;
  }
  return cands[0].r;
}

/** Kinds whose model carries its mill race / quay on local −z (docs/ART.md section 8). */
export const WATER_KINDS: ReadonlySet<BuildingKind> = new Set<BuildingKind>(['watermill', 'fulling_mill', 'tannery', 'dock']);

function waterAt(w: PlacementWorld, x: number, z: number): boolean {
  return w.waterSurfaceAt(Math.min(w.size, Math.max(0, x)), Math.min(w.size, Math.max(0, z))) !== null;
}

/** The yaw the model is drawn at: a water building faces its door away from the water. */
export function placedRot(w: PlacementWorld, b: { kind: BuildingKind; x: number; z: number; rot: number; settlement?: number }, pieces?: Iterable<WallPiece>): number {
  if (b.kind === 'tower' && w.settlements && b.settlement !== undefined) {
    const s = w.settlements.find((q) => q.id === b.settlement);
    if (s) return towerTurn(b.rot, b.x, b.z, s.x, s.z, pieces);
  }
  if (!WATER_KINDS.has(b.kind)) return b.rot;
  const def = BUILDINGS[b.kind];
  const fx = Math.sin(b.rot), fz = Math.cos(b.rot);
  let front = 0, back = 0;
  for (const r of [def.d / 2 + 1.5, def.d / 2 + 4]) {
    if (waterAt(w, b.x + fx * r, b.z + fz * r)) front++;
    if (waterAt(w, b.x - fx * r, b.z - fz * r)) back++;
  }
  return front > back ? b.rot + Math.PI : b.rot;
}

/** The height the model's origin is set at. */
export function placedY(w: PlacementWorld, b: { kind: BuildingKind; x: number; z: number }, rot: number): number {
  const def = BUILDINGS[b.kind];
  const c = Math.cos(rot), s = Math.sin(rot);
  const at = (lx: number, lz: number): number => w.heightAt(b.x + lx * c + lz * s, b.z - lx * s + lz * c);
  if (WATER_KINDS.has(b.kind)) {
    const hs = [at(0, 0), at(-def.w * 0.35, def.d * 0.3), at(def.w * 0.35, def.d * 0.3), at(0, def.d * 0.45)];
    return Math.max(hs[0], (hs[1] + hs[2] + hs[3]) / 3) - 0.1;
  }
  let mn = at(0, 0), sum = mn;
  for (const [lx, lz] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) {
    const h = at(lx * def.w, lz * def.d);
    mn = Math.min(mn, h);
    sum += h;
  }
  return Math.min(mn + 0.15, sum / 5) - 0.05;
}
