// Which tree or rock is under the mouse: the renderer's `pick` knows characters, animals, buildings and the
// ground but not the vegetation, so the pointer asks the world's scatter directly. Each tree is a trunk (a
// vertical cylinder) under a crown (a sphere), generously sized so the foliage is as easy to point at as the bark.
import { CHUNKS_PER_SIDE, CHUNK_SIZE, type ScatterKind, type WorldModel } from '../world/types';
import type { PickRay } from './types';

interface Shape {
  /** Trunk radius (m) at scale 1. */
  trunk: number;
  /** Crown centre height above the ground and its radius. */
  crownY: number;
  crown: number;
  /** Rocks have no trunk: only the sphere. */
  rock?: boolean;
}

const SHAPES: Partial<Record<ScatterKind, Shape>> = {
  oak: { trunk: 0.55, crownY: 9.0, crown: 4.2 },
  beech: { trunk: 0.45, crownY: 10.6, crown: 3.9 },
  birch: { trunk: 0.28, crownY: 8.0, crown: 2.2 },
  ash: { trunk: 0.45, crownY: 10.4, crown: 3.4 },
  willow: { trunk: 0.6, crownY: 4.8, crown: 2.7 },
  pine: { trunk: 0.4, crownY: 11.0, crown: 2.8 },
  spruce: { trunk: 0.38, crownY: 8.5, crown: 2.8 },
  apple: { trunk: 0.32, crownY: 3.4, crown: 2.3 },
  deadtree: { trunk: 0.32, crownY: 5.0, crown: 1.5 },
  rock_large: { trunk: 0, crownY: 0.6, crown: 1.3, rock: true },
  boulder: { trunk: 0, crownY: 1.0, crown: 2.0, rock: true },
};

export interface ScatterHit {
  id: number;
  kind: ScatterKind;
  x: number;
  z: number;
  /** Distance along the ray (m). */
  t: number;
}

/** Nearest intersection of a ray with a sphere, or null. */
function raySphere(r: PickRay, cx: number, cy: number, cz: number, rad: number): number | null {
  const ox = r.x - cx, oy = r.y - cy, oz = r.z - cz;
  const b = ox * r.dx + oy * r.dy + oz * r.dz;
  const c = ox * ox + oy * oy + oz * oz - rad * rad;
  const disc = b * b - c;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  const t0 = -b - s;
  if (t0 >= 0) return t0;
  const t1 = -b + s;
  return t1 >= 0 ? t1 : null;
}

/** Nearest intersection with a vertical cylinder of radius `rad` between heights y0 and y1, or null. */
function rayCylinder(r: PickRay, cx: number, cz: number, rad: number, y0: number, y1: number): number | null {
  const ox = r.x - cx, oz = r.z - cz;
  const a = r.dx * r.dx + r.dz * r.dz;
  if (a < 1e-9) return null; // looking straight up or down
  const b = ox * r.dx + oz * r.dz;
  const c = ox * ox + oz * oz - rad * rad;
  const disc = b * b - a * c;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  for (const t of [(-b - s) / a, (-b + s) / a]) {
    if (t < 0) continue;
    const y = r.y + r.dy * t;
    if (y >= y0 && y <= y1) return t;
  }
  return null;
}

/**
 * The nearest tree or rock the ray meets within `maxT` metres, or null. `felled` ids are skipped. Chunks come from
 * `world.scatterInChunk` (cached by the world; the renderer and the zone have already asked for the ones nearby).
 */
export function pickScatter(
  world: Pick<WorldModel, 'scatterInChunk' | 'heightAt'>, felled: ReadonlySet<number>, ray: PickRay, maxT: number,
): ScatterHit | null {
  const t = Math.max(1, Math.min(maxT, 90));
  const ex = ray.x + ray.dx * t, ez = ray.z + ray.dz * t;
  const pad = 6;
  const x0 = Math.min(ray.x, ex) - pad, x1 = Math.max(ray.x, ex) + pad;
  const z0 = Math.min(ray.z, ez) - pad, z1 = Math.max(ray.z, ez) + pad;
  const cx0 = Math.max(0, Math.floor(x0 / CHUNK_SIZE)), cx1 = Math.min(CHUNKS_PER_SIDE - 1, Math.floor(x1 / CHUNK_SIZE));
  const cz0 = Math.max(0, Math.floor(z0 / CHUNK_SIZE)), cz1 = Math.min(CHUNKS_PER_SIDE - 1, Math.floor(z1 / CHUNK_SIZE));
  let best: ScatterHit | null = null;
  for (let cz = cz0; cz <= cz1; cz++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      for (const it of world.scatterInChunk(cx, cz)) {
        const shape = SHAPES[it.kind];
        if (!shape || felled.has(it.id)) continue;
        const reach = (shape.crown + 0.8) * it.scale;
        // quick reject: the ray's horizontal line must pass within reach of the trunk
        const px = it.x - ray.x, pz = it.z - ray.z;
        const h = Math.hypot(ray.dx, ray.dz);
        if (h > 1e-6) {
          const along = (px * ray.dx + pz * ray.dz) / h;
          if (along < -reach || along > t * h + reach) continue;
          const off = Math.abs(px * ray.dz - pz * ray.dx) / h;
          if (off > reach) continue;
        } else if (Math.hypot(px, pz) > reach) continue;
        const gy = world.heightAt(it.x, it.z);
        const s = it.scale;
        let hit = raySphere(ray, it.x, gy + shape.crownY * s, it.z, (shape.crown + 0.3) * s);
        if (!shape.rock) {
          const tr = rayCylinder(ray, it.x, it.z, Math.max(shape.trunk * s, 0.3) * 1.5, gy, gy + shape.crownY * s);
          if (tr !== null && (hit === null || tr < hit)) hit = tr;
        }
        if (hit === null || hit > t) continue;
        if (!best || hit < best.t) best = { id: it.id, kind: it.kind, x: it.x, z: it.z, t: hit };
      }
    }
  }
  return best;
}

/** Plain names for the things `pickScatter` finds (the zone's own labels are preferred when it has them). */
export const SCATTER_NAME: Partial<Record<ScatterKind, string>> = {
  oak: 'Oak', beech: 'Beech', birch: 'Birch', ash: 'Ash', willow: 'Willow', pine: 'Pine', spruce: 'Spruce', apple: 'Apple tree',
  deadtree: 'Dead tree', rock_large: 'Rock', boulder: 'Boulder',
};
