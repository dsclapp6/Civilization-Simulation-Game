// Building generation: request → recipe → construction/damage state → per-channel geometry.
import type * as THREE from 'three';
import { BUILDINGS, type BuildingDef, type BuildingKind } from '../../content/types';
import type { CultureId } from '../../core/domain';
import type { P2 } from '../../core/math';
import { F, Layer, MAT_COUNT, Mat, MeshBuilder, prng, type V3 } from '../core/builder';
import { newOut, type AnimPart, type Ctx, type EmitterSpec, type FlagSpec } from './parts';
import { applyConstruction, applyDamage } from './states';
import { STYLES } from './style';
import { RECIPES } from './recipes';

export interface NormalizedRequest {
  kind: BuildingKind;
  level: number;
  culture: CultureId;
  seedBucket: number;
  /** Quantised construction (1 = complete). */
  construction: number;
  /** Quantised damage. */
  damage: number;
  owner: number;
  lod: 0 | 1 | 2;
}

export interface BuiltAnim {
  pivot: V3;
  geo: THREE.BufferGeometry | null;
  kind: AnimPart['kind'];
  speed: number;
  mat: AnimPart['mat'];
  children: BuiltAnim[];
}

export interface BuiltBuilding {
  key: string;
  geos: (THREE.BufferGeometry | null)[];
  doubleSided: boolean;
  anims: BuiltAnim[];
  flags: FlagSpec[];
  doors: P2[];
  smoke: V3[];
  emitters: EmitterSpec[];
  fire: V3[];
  w: number;
  d: number;
  height: number;
  triangles: number;
}

export const CONSTRUCTION_STEPS = 10;
export const DAMAGE_STEPS = 4;
export const SEED_BUCKETS = 4;

export function normalizeRequest(req: { kind: BuildingKind; level: number; culture: CultureId; seed: number; construction?: number; damage?: number; ownerColor?: number; lod?: 0 | 1 | 2 }): NormalizedRequest {
  const def = BUILDINGS[req.kind];
  const level = Math.max(1, Math.min(def.maxLevel, Math.round(req.level || 1)));
  const c = req.construction ?? 1;
  const construction = c >= 1 ? 1 : Math.min(CONSTRUCTION_STEPS - 1, Math.max(0, Math.floor(c * CONSTRUCTION_STEPS))) / CONSTRUCTION_STEPS + 0.5 / CONSTRUCTION_STEPS;
  const d = req.damage ?? 0;
  const damage = Math.round(Math.max(0, Math.min(1, d)) * DAMAGE_STEPS) / DAMAGE_STEPS;
  return {
    kind: req.kind, level, culture: STYLES[req.culture] ? req.culture : 'anglo',
    seedBucket: ((req.seed | 0) % SEED_BUCKETS + SEED_BUCKETS) % SEED_BUCKETS,
    construction, damage, owner: req.ownerColor ?? 0xa8302a, lod: req.lod ?? 0,
  };
}

export function requestKey(n: NormalizedRequest): string {
  return `${n.kind}|${n.level}|${n.culture}|${n.seedBucket}|${n.construction.toFixed(2)}|${n.damage.toFixed(2)}|${n.owner.toString(16)}|${n.lod}`;
}

/** Run a recipe and produce the raw builder (before states), for tests and tools. */
export function runRecipe(n: NormalizedRequest): { b: MeshBuilder; ctx: Ctx; def: BuildingDef } {
  const def = BUILDINGS[n.kind];
  const seed = hashSeed(n.kind, n.culture, n.seedBucket);
  const b = new MeshBuilder(seed);
  const ctx: Ctx = { b, s: STYLES[n.culture], level: n.level, lod: n.lod, r: prng(seed ^ 0x5bd1e995), seed, owner: n.owner, out: newOut() };
  const recipe = RECIPES[n.kind];
  recipe(ctx, def);
  return { b, ctx, def };
}

export function generateBuilding(n: NormalizedRequest): BuiltBuilding {
  const { b, ctx, def } = runRecipe(n);
  let src = b;
  const seed = ctx.seed;
  const info = { w: def.w, d: def.d };
  // Coarser LODs drop yard clutter (LOD1+) and small details except lit window panes (LOD2).
  if (n.lod >= 1) src = src.filter((t) => src.tLayer[t] !== Layer.Decor && !(n.lod === 2 && src.tLayer[t] === Layer.Detail && src.tMat[t] !== Mat.Window));
  if (n.construction < 1) src = applyConstruction(src, n.construction, info, seed);
  if (n.damage > 0) src = applyDamage(src, n.damage, info, seed);
  else if (n.construction >= 1) src = src.filter((t) => src.tLayer[t] !== Layer.RoofFrame);
  const geos: (THREE.BufferGeometry | null)[] = [];
  let triangles = 0;
  for (let m = 0; m < MAT_COUNT; m++) {
    const g = src.toGeometry({ mat: m as 0, surf: true, sway: m === Mat.Cloth, aoHeight: 0.9, aoStrength: 0.26 });
    if (g) triangles += g.getAttribute('position').count / 3;
    geos.push(g);
  }
  const intact = n.construction >= 1 && n.damage < 0.75;
  const anims: BuiltAnim[] = [];
  if (n.construction >= 0.95) {
    const conv = (p: AnimPart): BuiltAnim => {
      let pb = p.builder;
      if (n.damage > 0) pb = applyDamage(pb, Math.min(0.5, n.damage), info, seed + 9);
      const g = pb.toGeometry({ mat: p.mat === 'cloth' ? Mat.Cloth : Mat.Opaque, surf: true, sway: p.mat === 'cloth', aoHeight: 0 });
      if (g) triangles += g.getAttribute('position').count / 3;
      return { pivot: p.pivot, geo: g, kind: intact ? p.kind : 'swing', speed: intact ? p.speed : 0, mat: p.mat, children: (p.children ?? []).map(conv) };
    };
    for (const p of ctx.out.anims) anims.push(conv(p));
  }
  let height = 0;
  for (const g of geos) if (g?.boundingBox) height = Math.max(height, g.boundingBox.max.y);
  const animTop = (a: BuiltAnim, base: number): void => {
    const r = a.geo?.boundingSphere ? a.geo.boundingSphere.radius + a.geo.boundingSphere.center.length() : 1;
    height = Math.max(height, base + r);
    for (const c of a.children) animTop(c, c.pivot[1]);
  };
  for (const a of anims) animTop(a, a.pivot[1]);
  return {
    key: requestKey(n),
    geos,
    doubleSided: n.construction < 1 || n.damage > 0,
    anims,
    flags: intact ? ctx.out.flags : [],
    doors: ctx.out.doors,
    smoke: n.construction >= 1 && n.damage < 0.5 ? ctx.out.smoke : [],
    emitters: n.construction >= 1 && n.damage < 0.5 ? ctx.out.emitters : [],
    fire: firePoints(src, def, ctx.out.fire),
    w: def.w,
    d: def.d,
    height,
    triangles,
  };
}

function firePoints(src: MeshBuilder, def: BuildingDef, extra: V3[]): V3[] {
  if (extra.length) return extra;
  const bb = src.bounds((t) => src.tLayer[t] === Layer.Roof || src.tLayer[t] === Layer.Wall);
  if (bb.isEmpty()) return [[0, 1, 0]];
  const pts: V3[] = [];
  const n = Math.max(2, Math.min(8, Math.round((def.w * def.d) / 30)));
  const r = prng(def.w * 131 + def.d);
  for (let i = 0; i < n; i++) {
    pts.push([bb.min.x + (bb.max.x - bb.min.x) * (0.15 + r() * 0.7), bb.min.y + (bb.max.y - bb.min.y) * (0.55 + r() * 0.4), bb.min.z + (bb.max.z - bb.min.z) * (0.15 + r() * 0.7)]);
  }
  return pts;
}

function hashSeed(kind: string, culture: string, bucket: number): number {
  let h = 2166136261;
  const s = `${kind}:${culture}:${bucket}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 1000003;
}

export { F };
