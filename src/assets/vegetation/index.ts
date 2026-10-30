// Instancing kits for vegetation: one geometry + one material per kind/LOD, sharing a
// per-kind FoliageUniforms block that setEnvironment updates from the phenology tables.
import * as THREE from 'three';
import type { AssetEnvironment, InstancedKit } from '../types';
import type { ScatterKind } from '../../world/types';
import { MeshBuilder } from '../core/builder';
import { createFoliageUniforms, createVegetationDepthMaterial, createVegetationMaterial, type FoliageUniforms, type SharedUniforms } from '../core/materials';
import { applyPhenology } from './phenology';
import { PLANTS } from './plants';

/** InstancedKit plus the matching shadow depth material (additive to the contract). */
export interface VegetationKit extends InstancedKit {
  /** Assign to InstancedMesh.customDepthMaterial so shadows follow sway and leaf fall. */
  depthMaterial: THREE.Material;
  /** Triangle count of the geometry. */
  triangles: number;
  /** Approximate height at scale 1. */
  height: number;
}

export interface VegetationKits {
  get(kind: ScatterKind, lod: 0 | 1 | 2): VegetationKit;
  update(env: AssetEnvironment): void;
  dispose(): void;
}

export function buildPlantGeometry(kind: ScatterKind, lod: 0 | 1 | 2): THREE.BufferGeometry {
  const b = new MeshBuilder(kind.length * 31 + lod);
  b.jitter = 0.05;
  b.flags = 1;
  PLANTS[kind].build(b, lod);
  const g = b.toGeometry({ leaf: true, sway: true })!;
  if (PLANTS[kind].soft) bendNormalsUp(g, 0.3);
  return g;
}

/** Replace face normals with mostly-up normals (thin plants lit like the ground beneath them). */
export function bendNormalsUp(g: THREE.BufferGeometry, keep: number): void {
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < n.count; i++) {
    let x = n.getX(i), y = n.getY(i), z = n.getZ(i);
    if (y < 0) { x = -x; y = -y; z = -z; }
    x *= keep; y = y * keep + 1; z *= keep;
    const l = Math.hypot(x, y, z) || 1;
    n.setXYZ(i, x / l, y / l, z / l);
  }
  n.needsUpdate = true;
}

export function createVegetationKits(u: SharedUniforms): VegetationKits {
  const foliage = new Map<ScatterKind, FoliageUniforms>();
  const kits = new Map<string, VegetationKit>();
  const mats = new Map<ScatterKind, { m: THREE.Material; d: THREE.Material }>();
  let last: AssetEnvironment | null = null;

  const fol = (kind: ScatterKind): FoliageUniforms => {
    let f = foliage.get(kind);
    if (!f) {
      f = createFoliageUniforms();
      foliage.set(kind, f);
      if (last) applyPhenology(PLANTS[kind].phen, last.season, last.seasonProgress, f);
    }
    return f;
  };
  const matsFor = (kind: ScatterKind) => {
    let m = mats.get(kind);
    if (!m) {
      const f = fol(kind);
      const ds = PLANTS[kind].doubleSided;
      m = { m: createVegetationMaterial(u, f, ds, !!PLANTS[kind].soft), d: createVegetationDepthMaterial(u, f, ds) };
      m.m.name = `veg:${kind}`;
      mats.set(kind, m);
    }
    return m;
  };

  return {
    get(kind, lod) {
      const key = `${kind}|${lod}`;
      let k = kits.get(key);
      if (!k) {
        const geometry = buildPlantGeometry(kind, lod);
        const { m, d } = matsFor(kind);
        const bb = geometry.boundingBox!;
        k = {
          geometry, material: m, depthMaterial: d,
          radius: geometry.boundingSphere!.radius + geometry.boundingSphere!.center.length(),
          triangles: geometry.getAttribute('position').count / 3,
          height: bb.max.y,
        };
        kits.set(key, k);
      }
      return k;
    },
    update(env) {
      last = env;
      for (const [kind, f] of foliage) applyPhenology(PLANTS[kind].phen, env.season, env.seasonProgress, f);
    },
    dispose() {
      for (const k of kits.values()) k.geometry.dispose();
      for (const m of mats.values()) { m.m.dispose(); m.d.dispose(); }
      kits.clear();
      mats.clear();
    },
  };
}
