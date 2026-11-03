// Where a building's model stands (pure; docs/INTERIORS.md): the renderer sets the model here and the navigation puts its inside
// at the same place, so a floor one walks on is the floor one sees. Water buildings (mills, the tannery, the dock) are turned to
// put their race or quay over the water; a model sits on the lower corners of its footprint, a little sunk (the plinth reaches
// 0.8 m down).
import { BUILDINGS, type BuildingKind } from '../../content/types';

export interface PlacementWorld {
  size: number;
  heightAt(x: number, z: number): number;
  waterSurfaceAt(x: number, z: number): number | null;
}

/** Kinds whose model carries its mill race / quay on local −z (docs/ART.md section 8). */
export const WATER_KINDS: ReadonlySet<BuildingKind> = new Set<BuildingKind>(['watermill', 'fulling_mill', 'tannery', 'dock']);

function waterAt(w: PlacementWorld, x: number, z: number): boolean {
  return w.waterSurfaceAt(Math.min(w.size, Math.max(0, x)), Math.min(w.size, Math.max(0, z))) !== null;
}

/** The yaw the model is drawn at: a water building faces its door away from the water. */
export function placedRot(w: PlacementWorld, b: { kind: BuildingKind; x: number; z: number; rot: number }): number {
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
