// Animal layer: all livestock and wildlife skinned on the GPU from one shared buffer
// (1 draw call per pass). Quadrupeds share one parametric rig; poultry have their own.
import * as THREE from 'three';
import type { AnimalLayer, Palette } from '../types';
import type { AnimalAnim, AnimalDrawItem } from '../../core/view';
import { hash3 } from '../../core/math';
import { copy12, mulEulerT, scaleRot, setZero } from '../characters/engine/affine';
import type { GeometryData } from '../characters/engine/builder';
import { type Chunk, SkinnedCrowd } from '../characters/engine/crowd';
import { rayCapsule } from '../characters/layer';
import { BB, B_BONES, type BirdDims, birdDims, birdEvaluate, birdFK, type BirdState, buildBird, createBirdState } from './birds';
import { isBird, quadSpec, type QuadKind } from './kinds';
import { buildQuadruped, Q_BONES, QB, quadDims, type QuadDims } from './quadruped';
import { createQuadState, quadEvaluate, quadFK, type QuadAnim, type QuadState } from './quadAnim';

interface AnimalState {
  id: number;
  seed: number;
  slot: number;
  chunk: Chunk | null;
  key: string;
  bird: boolean;
  qd: QuadDims | null;
  bd: BirdDims | null;
  qs: QuadState | null;
  bs: BirdState | null;
  seen: number;
  hidden: boolean;
  lastFull: number;
  lastX: number; lastY: number; lastZ: number;
  px: number; py: number; pz: number; yaw: number; len: number; height: number;
}

const _place = new Float32Array(12);
const IDENT = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
const _frustum = new THREE.Frustum();
const _proj = new THREE.Matrix4();
const _sphere = new THREE.Sphere();
const _v = new THREE.Vector3();

function toQuadAnim(a: AnimalAnim): QuadAnim { return a; }

function writeBones(bind: Float32Array, W: Float32Array, n: number, bones: Float32Array, base: number): void {
  for (let b = 0; b < n; b++) {
    const o = b * 12, t = base + b * 12;
    const bx = bind[b * 3], by = bind[b * 3 + 1], bz = bind[b * 3 + 2];
    bones[t] = W[o]; bones[t + 1] = W[o + 1]; bones[t + 2] = W[o + 2];
    bones[t + 3] = W[o + 3] - (W[o] * bx + W[o + 1] * by + W[o + 2] * bz);
    bones[t + 4] = W[o + 4]; bones[t + 5] = W[o + 5]; bones[t + 6] = W[o + 6];
    bones[t + 7] = W[o + 7] - (W[o + 4] * bx + W[o + 5] * by + W[o + 6] * bz);
    bones[t + 8] = W[o + 8]; bones[t + 9] = W[o + 9]; bones[t + 10] = W[o + 10];
    bones[t + 11] = W[o + 11] - (W[o + 8] * bx + W[o + 9] * by + W[o + 10] * bz);
  }
}

export function createAnimalLayer(palette: Palette): AnimalLayer {
  void palette;
  const crowd = new SkinnedCrowd({ name: 'animals', initialVertices: 1 << 18, initialIndices: 1 << 19, initialSlots: 192 });
  const object = new THREE.Group();
  object.name = 'animal-layer';
  object.add(crowd.mesh);
  const states = new Map<number, AnimalState>();
  const cache = new Map<string, GeometryData>();
  let frame = 0, time = 0;
  let originX = NaN, originZ = NaN;
  let forceFull = false;
  const stats = { updateMs: 0, animated: 0, culled: 0, built: 0 };
  const options = { buildBudgetMs: 3, animLod: true };

  function maleOf(item: AnimalDrawItem, seed: number): boolean {
    return item.male ?? (seed % 2 === 0);
  }

  function keyOf(item: AnimalDrawItem, seed: number): string {
    return `${item.kind}:${item.coat}:${item.young ? 1 : 0}:${maleOf(item, seed) ? 1 : 0}:${Math.round(item.scale * 20)}`;
  }

  function build(st: AnimalState, item: AnimalDrawItem): void {
    const key = keyOf(item, st.seed);
    const male = maleOf(item, st.seed);
    if (st.slot < 0) st.slot = crowd.allocSlot();
    crowd.removeChunk(st.chunk);
    st.bird = isBird(item.kind);
    if (st.bird) {
      st.bd = birdDims(item.kind === 'goose', item.scale || 1, !!item.young, item.coat, male);
      st.qd = null;
      st.bs = st.bs ?? createBirdState(st.seed);
      st.qs = null;
    } else {
      st.qd = quadDims(quadSpec(item.kind as QuadKind, item.coat), item.scale || 1, !!item.young, item.coat, male);
      st.bd = null;
      st.qs = st.qs ?? createQuadState(st.seed);
      st.bs = null;
    }
    let g = cache.get(key);
    if (!g) {
      g = st.bird ? buildBird(st.bd!, !!item.young) : buildQuadruped(st.qd!);
      if (cache.size > 300) cache.clear();
      cache.set(key, g);
    }
    st.chunk = crowd.addChunk(g, st.slot);
    st.key = key;
    st.len = st.bird ? st.bd!.len : st.qd!.len;
    st.height = st.bird ? st.bd!.bodyY + st.bd!.neckLen : st.qd!.withers;
  }

  function animate(st: AnimalState, item: AnimalDrawItem, dt: number): void {
    mulEulerT(_place, 0, IDENT, 0, 0, item.yaw, 0, item.x - originX, item.y, item.z - originZ);
    if (st.bird) {
      const bs = st.bs!, bd = st.bd!;
      birdEvaluate(bs, bd, item.anim, item.moveSpeed, dt);
      birdFK(bs, bd, _place);
      const W = bs.world;
      if (item.highlight >= 2) { copy12(W, BB.ring * 12, _place, 0); W[BB.ring * 12 + 7] += 0.02; scaleRot(W, BB.ring * 12, Math.max(0.25, bd.len * 1.1)); }
      else setZero(W, BB.ring * 12);
      writeBones(bd.bind, W, B_BONES, crowd.bones, crowd.boneOffset(st.slot, 0));
    } else {
      const qs = st.qs!, qd = st.qd!;
      quadEvaluate(qs, qd, toQuadAnim(item.anim), item.animTime, item.moveSpeed, dt);
      quadFK(qs, qd, _place, dt);
      const W = qs.world;
      setZero(W, QB.reins * 12); setZero(W, QB.stirL * 12); setZero(W, QB.stirR * 12); setZero(W, QB.cloth * 12);
      if (item.highlight >= 2) { copy12(W, QB.ring * 12, _place, 0); W[QB.ring * 12 + 7] += 0.02; scaleRot(W, QB.ring * 12, Math.max(0.3, qd.len * 0.75)); }
      else setZero(W, QB.ring * 12);
      writeBones(qd.bind, W, Q_BONES, crowd.bones, crowd.boneOffset(st.slot, 0));
    }
    crowd.setParams(st.slot, item.highlight, item.anim === 'hit' ? Math.max(0, 1 - item.animTime * 4) : 0);
    st.px = item.x; st.py = item.y; st.pz = item.z; st.yaw = item.yaw;
    st.lastX = item.x; st.lastY = item.y; st.lastZ = item.z;
    st.lastFull = frame;
  }

  function translateOnly(st: AnimalState, item: AnimalDrawItem): void {
    const dx = item.x - st.lastX, dy = item.y - st.lastY, dz = item.z - st.lastZ;
    if (dx === 0 && dy === 0 && dz === 0) return;
    const o = crowd.boneOffset(st.slot, 0), bones = crowd.bones;
    const n = st.bird ? B_BONES : Q_BONES;
    for (let b = 0; b < n; b++) {
      const t = o + b * 12;
      if (bones[t] === 0 && bones[t + 5] === 0 && bones[t + 10] === 0) continue;
      bones[t + 3] += dx; bones[t + 7] += dy; bones[t + 11] += dz;
    }
    st.lastX = item.x; st.lastY = item.y; st.lastZ = item.z;
    st.px = item.x; st.py = item.y; st.pz = item.z;
  }

  function update(items: readonly AnimalDrawItem[], dt: number, camera: THREE.Camera): void {
    const t0 = performance.now();
    frame++;
    const step = Math.min(0.1, Math.max(0, dt));
    time += step;
    camera.getWorldPosition(_v);
    if (Number.isNaN(originX) || Math.abs(_v.x - originX) > 400 || Math.abs(_v.z - originZ) > 400) {
      originX = Math.round(_v.x / 64) * 64; originZ = Math.round(_v.z / 64) * 64;
      crowd.mesh.position.set(originX, 0, originZ);
      crowd.mesh.updateMatrix();
      crowd.mesh.updateMatrixWorld(true);
      forceFull = true;
    }
    camera.updateMatrixWorld();
    _proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_proj);
    let animated = 0, culled = 0, built = 0;
    for (const item of items) {
      let st = states.get(item.id);
      if (!st) {
        st = {
          id: item.id, seed: hash3(item.id, 104729) & 0x7fffffff, slot: -1, chunk: null, key: '', bird: false,
          qd: null, bd: null, qs: null, bs: null, seen: frame, hidden: true, lastFull: -999,
          lastX: 0, lastY: 0, lastZ: 0, px: 0, py: 0, pz: 0, yaw: 0, len: 1, height: 1,
        };
        states.set(item.id, st);
      }
      st.seen = frame;
      const key = keyOf(item, st.seed);
      if (key !== st.key) {
        if (built > 0 && performance.now() - t0 > options.buildBudgetMs && st.chunk) { /* keep old look this frame */ }
        else { build(st, item); built++; }
      }
      _sphere.center.set(item.x, item.y + st.height * 0.5, item.z);
      _sphere.radius = Math.max(0.5, st.len) + 0.6 + 3; // + shadow margin
      if (!_frustum.intersectsSphere(_sphere)) {
        if (!st.hidden) { crowd.hideSlot(st.slot); st.hidden = true; }
        culled++;
        st.px = item.x; st.py = item.y; st.pz = item.z;
        continue;
      }
      const dx = item.x - _v.x, dz = item.z - _v.z;
      const d2 = dx * dx + dz * dz;
      const interval = !options.animLod ? 1 : d2 < 40 * 40 ? 1 : d2 < 90 * 90 ? 2 : 4;
      if (st.hidden || forceFull || interval === 1 || (frame + (st.seed & 3)) % interval === 0 || item.highlight > 0) {
        const adt = st.hidden ? step : Math.min(0.25, step * Math.max(1, frame - st.lastFull));
        animate(st, item, st.lastFull < 0 ? step : adt);
        st.hidden = false;
        animated++;
      } else translateOnly(st, item);
    }
    forceFull = false;
    for (const [id, st] of states) {
      if (st.seen !== frame) {
        crowd.removeChunk(st.chunk);
        if (st.slot >= 0) crowd.releaseSlot(st.slot);
        states.delete(id);
      }
    }
    crowd.commit();
    stats.updateMs = performance.now() - t0;
    stats.animated = animated; stats.culled = culled; stats.built = built;
  }

  const _ro = new THREE.Vector3(), _rd = new THREE.Vector3();
  function pick(raycaster: THREE.Raycaster): number {
    _ro.copy(raycaster.ray.origin); _rd.copy(raycaster.ray.direction);
    let best = -1, bestT = Infinity;
    for (const st of states.values()) {
      if (st.hidden) continue;
      const fx = Math.sin(st.yaw), fz = Math.cos(st.yaw);
      const r = Math.max(0.12, st.height * 0.32);
      const y = st.py + st.height * 0.62;
      const half = Math.max(0.05, st.len * 0.5);
      const t = rayCapsule(_ro, _rd, st.px - fx * half, y, st.pz - fz * half, st.px + fx * half, y, st.pz + fz * half, r);
      if (t < bestT) { bestT = t; best = st.id; }
    }
    return best;
  }

  function dispose(): void { crowd.dispose(); states.clear(); cache.clear(); }
  void time;
  const layer: AnimalLayer & { stats: typeof stats; crowd: SkinnedCrowd; options: typeof options } = { object, update, pick, dispose, stats, crowd, options };
  return layer;
}
