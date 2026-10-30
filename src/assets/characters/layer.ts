// Character layer: every visible person (and their horse) is skinned on the GPU from one
// shared buffer → 1 draw call per pass. See engine/crowd.ts for the GPU side and
// human/animator.ts for the animation pipeline.
//
// Optional extras read from draw items (additive, all optional):
//   (item as {seatHeight?: number}).seatHeight — 'sit' on a seat of that height (m) instead of the ground.
import * as THREE from 'three';
import type { CharacterLayer, Palette } from '../types';
import type { CharacterDrawItem, CharacterLook } from '../../core/view';
import { hash3 } from '../../core/math';
import { copy12, mulEulerT, setZero } from './engine/affine';
import { type GeometryData, MAT, MeshBuilder } from './engine/builder';
import { type Chunk, SkinnedCrowd } from './engine/crowd';
import { type AnimContext, createAnimState, evaluatePose, type HumanAnimState, poseToBones } from './human/animator';
import { buildHumanBody } from './human/body';
import { arrowGeometry, backGeometry, carryGeometry, cupGeometry, IB, isBow, itemGeometry, ITEMS, propGeometry } from './human/items';
import { HB, HUMAN_BONES, humanDims } from './human/skeleton';
import { buildChildCarry } from './human/child';
import { type QuadDims, QB, Q_BONES, buildQuadruped, quadDims } from '../animals/quadruped';
import { createQuadState, quadEvaluate, quadFK, type QuadAnim, type QuadState } from '../animals/quadAnim';
import { quadSpec } from '../animals/kinds';

interface HorseRig {
  slot: number;
  chunk: Chunk | null;
  key: string;
  dims: QuadDims;
  st: QuadState;
}

interface CharState {
  id: number;
  seed: number;
  slot: number;
  lookVersion: number;
  lookRef: CharacterLook | null;
  body: Chunk | null;
  main: Chunk | null; mainKey: string;
  off: Chunk | null; offKey: string;
  back: Chunk | null; backKey: string;
  carry: Chunk | null; carryKey: string;
  /** Body detail level currently in the buffer. */
  lod: 0 | 1;
  /** Last equipment seen (change detection). */
  eqMain: string; eqOff: string; eqBack: string; eqCarry: string; eqLook: number; eqMount: number;
  anim: HumanAnimState | null;
  horse: HorseRig | null;
  seen: number;
  ready: boolean;
  hidden: boolean;
  lastFull: number;
  lastX: number; lastY: number; lastZ: number;
  // picking
  px: number; py: number; pz: number; top: number; mounted: boolean; yaw: number; radius: number;
}

const _place = new Float32Array(12);
const _saddle = new Float32Array(12);
const _stand = new Float32Array(12);
const _frustum = new THREE.Frustum();
const _projScreen = new THREE.Matrix4();
const _sphere = new THREE.Sphere();
const _v = new THREE.Vector3();
const HUMAN_TEX_BONES = HUMAN_BONES;
/** Far-LOD switch distances (m): out beyond LOD_OUT, back in under LOD_IN. */
const LOD_OUT = 32, LOD_IN = 27;
const GEO_CACHE_MAX = 900;

/** Appearance of the body chunk (everything that only changes with the look). */
function buildBodyChunk(look: CharacterLook, lod: 0 | 1): GeometryData {
  const d = humanDims(look);
  const body = buildHumanBody(look, d, lod);
  const b = new MeshBuilder();
  b.append(body);
  // highlight ring (unit radius, scaled at runtime)
  b.bind(HB.ring).color(0xffd36a).flag(MAT.ring);
  b.loft([{ y: 0, rx: 0.9, rz: 0.9 }, { y: 0.004, rx: 1.0, rz: 1.0 }], { seg: 24 });
  // implicit eat/drink props
  b.append(propGeometry(), PROP_MAP);
  b.append(cupGeometry(), PROP2_MAP);
  return b.finish();
}
const PROP_MAP = remap(HB.prop);
const PROP2_MAP = remap(HB.prop2);
function remap(item: number, str = HB.string, flag = HB.flag, arrow = HB.arrow): Uint8Array {
  const m = new Uint8Array(4);
  m[IB.item] = item; m[IB.string] = str; m[IB.flag] = flag; m[IB.arrow] = arrow;
  return m;
}
const MAP_R = remap(HB.itemR);
const MAP_L = remap(HB.itemL);
const MAP_BACK = remap(HB.back);
const MAP_CARRY = remap(HB.carry);
const MAP_ARROW = remap(HB.arrow);

function horseKey(item: CharacterDrawItem): string {
  const m = item.mount!;
  const h = item.look.heraldry;
  const war = item.look.armour !== 'none' || item.mainHand === 'lance';
  return `${m.coat}:${m.barding ?? -1}:${h ? `${h.charge}:${h.pattern}` : ''}:${war ? 1 : 0}`;
}

function horseAnim(a: CharacterDrawItem): QuadAnim {
  switch (a.mount!.anim) {
    case 'walk': return 'walk';
    case 'trot': return 'trot';
    case 'gallop': return 'run';
    case 'rear': return 'rear';
    case 'fall': return 'fall';
    case 'dead': return 'dead';
    case 'graze': return 'graze';
    default: return 'idle';
  }
}

export function createCharacterLayer(palette: Palette): CharacterLayer {
  void palette;
  const crowd = new SkinnedCrowd({ name: 'characters', initialVertices: 1 << 19, initialIndices: 1 << 20, initialSlots: 384 });
  const object = new THREE.Group();
  object.name = 'character-layer';
  object.add(crowd.mesh);
  const states = new Map<number, CharState>();
  const pending: CharState[] = [];
  const geoCache = new Map<string, GeometryData>();
  const horseCache = new Map<string, GeometryData>();
  let frame = 0;
  let time = 0;
  let originX = NaN, originZ = NaN;
  let forceFull = false;
  /** Last update stats (ms, counts) for profiling. */
  const stats = { updateMs: 0, animated: 0, culled: 0, built: 0, pending: 0 };
  /** Tunables (not part of the CharacterLayer contract): time budget for building new appearances per frame. */
  const options = { buildBudgetMs: 4, lodBudgetMs: 1, lod: true, animLod: true };

  /** LRU cache of built appearances (≈25–50 KB each); keeps both LODs of everyone nearby. */
  function cacheGet(key: string, make: () => GeometryData): GeometryData {
    let g = geoCache.get(key);
    if (g) {
      geoCache.delete(key); // refresh recency
      geoCache.set(key, g);
      return g;
    }
    g = make();
    geoCache.set(key, g);
    while (geoCache.size > GEO_CACHE_MAX) {
      const oldest = geoCache.keys().next().value as string;
      geoCache.delete(oldest);
    }
    return g;
  }

  function release(st: CharState): void {
    crowd.removeChunk(st.body); crowd.removeChunk(st.main); crowd.removeChunk(st.off);
    crowd.removeChunk(st.back); crowd.removeChunk(st.carry);
    st.body = st.main = st.off = st.back = st.carry = null;
    if (st.slot >= 0) crowd.releaseSlot(st.slot);
    st.slot = -1;
    if (st.horse) {
      crowd.removeChunk(st.horse.chunk);
      crowd.releaseSlot(st.horse.slot);
      st.horse = null;
    }
  }

  function buildBody(st: CharState, item: CharacterDrawItem, lod: 0 | 1): void {
    const look = item.look;
    const g = cacheGet(`b:${item.id}:${item.lookVersion}:${lod}`, () => buildBodyChunk(look, lod));
    st.lod = lod;
    if (st.slot < 0) st.slot = crowd.allocSlot();
    crowd.removeChunk(st.body);
    st.body = crowd.addChunk(g, st.slot);
    const dims = humanDims(look);
    if (!st.anim) st.anim = createAnimState(st.seed, dims);
    else st.anim.dims = dims;
    st.lookVersion = item.lookVersion;
    st.lookRef = look;
    st.mainKey = st.offKey = st.backKey = st.carryKey = '#';
    st.eqLook = -1;
    st.ready = true;
  }

  function syncEquipment(st: CharState, item: CharacterDrawItem): void {
    // cheap change detection first (no per-frame string building)
    const m = item.mount;
    if (st.eqMain === item.mainHand && st.eqOff === item.offHand && st.eqBack === item.back && st.eqCarry === item.carry
      && st.eqLook === item.lookVersion && st.eqMount === (m ? m.coat * 4096 + (m.barding ?? -1) : -2)) return;
    st.eqMain = item.mainHand; st.eqOff = item.offHand; st.eqBack = item.back; st.eqCarry = item.carry;
    st.eqLook = item.lookVersion; st.eqMount = m ? m.coat * 4096 + (m.barding ?? -1) : -2;
    const h = item.look.heraldry;
    const hk = h ? `${h.field}:${h.charge}:${h.pattern}` : '';
    const mk = `${item.mainHand}:${hk}`;
    if (mk !== st.mainKey) {
      crowd.removeChunk(st.main); st.main = null;
      if (item.mainHand !== 'none') {
        const def = ITEMS[item.mainHand];
        const g = itemGeometry(item.mainHand, item.look);
        const map = def.hand === 'R' ? MAP_R : MAP_L;
        if (isBow(item.mainHand)) {
          const b = new MeshBuilder();
          b.append(g, map);
          b.append(arrowGeometry(), MAP_ARROW);
          st.main = crowd.addChunk(b.finish(), st.slot);
        } else st.main = crowd.addChunk(g, st.slot, map);
      }
      st.mainKey = mk;
    }
    const ok = `${item.offHand}:${hk}`;
    if (ok !== st.offKey) {
      crowd.removeChunk(st.off); st.off = null;
      const mainLeft = item.mainHand !== 'none' && ITEMS[item.mainHand].hand !== 'R';
      if (item.offHand !== 'none' && !mainLeft) st.off = crowd.addChunk(itemGeometry(item.offHand, item.look), st.slot, MAP_L);
      st.offKey = ok;
    }
    const bk = `${item.back}:${hk}`;
    if (bk !== st.backKey) {
      crowd.removeChunk(st.back); st.back = null;
      if (item.back !== 'none') {
        const back = item.back;
        st.back = crowd.addChunk(cacheGet(`back:${bk}`, () => backGeometry(back, item.look)), st.slot, MAP_BACK);
      }
      st.backKey = bk;
    }
    const ck = item.carry;
    if (ck !== st.carryKey) {
      crowd.removeChunk(st.carry); st.carry = null;
      if (item.carry !== 'none') {
        const c = item.carry;
        const g = c === 'child' ? cacheGet(`child:${st.seed % 6}`, () => buildChildCarry(st.seed)) : cacheGet(`carry:${c}`, () => carryGeometry(c));
        st.carry = crowd.addChunk(g, st.slot, MAP_CARRY);
      }
      st.carryKey = ck;
    }
    // horse
    if (item.mount) {
      const key = horseKey(item);
      if (!st.horse || st.horse.key !== key) {
        if (st.horse) { crowd.removeChunk(st.horse.chunk); }
        const m = item.mount;
        const spec = quadSpec('horse', m.coat);
        const war = item.look.armour !== 'none' || item.mainHand === 'lance';
        const dims = quadDims(spec, war ? 1.05 : 1.0, false, m.coat, true);
        const g = (() => {
          let hg = horseCache.get(key);
          if (!hg) {
            hg = buildQuadruped(dims, {
              saddle: true, bridle: true, war,
              barding: m.barding, bardingCharge: item.look.heraldry?.charge, bardingPattern: item.look.heraldry?.pattern,
            });
            if (horseCache.size > 100) horseCache.clear();
            horseCache.set(key, hg);
          }
          return hg;
        })();
        const slot = st.horse ? st.horse.slot : crowd.allocSlot();
        st.horse = { slot, chunk: crowd.addChunk(g, slot), key, dims, st: st.horse?.st ?? createQuadState(st.seed) };
      }
    } else if (st.horse) {
      crowd.removeChunk(st.horse.chunk);
      crowd.releaseSlot(st.horse.slot);
      st.horse = null;
    }
  }

  function newState(item: CharacterDrawItem): CharState {
    return {
      id: item.id, seed: hash3(item.id, 7919) & 0x7fffffff, slot: -1, lookVersion: -1, lookRef: null,
      body: null, main: null, mainKey: '#', off: null, offKey: '#', back: null, backKey: '#', carry: null, carryKey: '#',
      lod: 0, eqMain: '', eqOff: '', eqBack: '', eqCarry: '', eqLook: -1, eqMount: -3, anim: null, horse: null, seen: frame, ready: false, hidden: true, lastFull: -999,
      lastX: 0, lastY: 0, lastZ: 0, px: 0, py: 0, pz: 0, top: 1.7, mounted: false, yaw: 0, radius: 0.3,
    };
  }

  const ctx: AnimContext = { place: _place, saddle: null, stand: null, horsePhase: 0, horseBob: 0, dt: 0, time: 0 };

  function animateOne(st: CharState, item: CharacterDrawItem, dt: number): void {
    const a = st.anim!;
    const lx = item.x - originX, lz = item.z - originZ;
    // placement: yaw + position
    mulEulerT(_place, 0, IDENT, 0, 0, item.yaw, 0, lx, item.y, lz);
    ctx.dt = dt; ctx.time = time;
    ctx.saddle = null; ctx.stand = null;
    const horse = st.horse;
    if (horse && item.mount) {
      const hs = horse.st;
      const hanim = horseAnim(item);
      quadEvaluate(hs, horse.dims, hanim, item.mount.animTime, item.moveSpeed, dt);
      quadFK(hs, horse.dims, _place, dt);
      // saddle frame: on the horse body, at the rider's hip-joint height above the seat
      const hd = horse.dims;
      const seatY = hd.s.barrelH * hd.scale * 0.52 + 0.09;
      const riderHip = 0.06 * a.dims.H;
      const riderLeg = 0;
      mulEulerT(_saddle, 0, hs.world, QB.body * 12, -hs.pitch * 0.45, 0, -hs.pose[2] * 0.4, 0, seatY + riderHip + riderLeg, hd.len * 0.06);
      // stand point beside the horse (left side), at hip height
      mulEulerT(_stand, 0, _place, 0, 0, 0, 0, hd.s.barrelW * hd.scale * 0.5 + 0.32, a.dims.hipY, hd.len * 0.05);
      ctx.saddle = _saddle;
      ctx.stand = _stand;
    }
    evaluatePose(a, item, ctx);
    poseToBones(a, item, ctx, crowd.bones, crowd.boneOffset(st.slot, 0));
    crowd.setParams(st.slot, item.highlight, a.flash);
    if (horse) {
      // reins to the rider's hands, stirrups to the feet
      const W = a.world;
      const HW = horse.st.world;
      copy12(HW, QB.reins * 12, HW, QB.body * 12);
      HW[QB.reins * 12 + 3] = (W[HB.handL * 12 + 3] + W[HB.handR * 12 + 3]) / 2;
      HW[QB.reins * 12 + 7] = (W[HB.handL * 12 + 7] + W[HB.handR * 12 + 7]) / 2 - 0.05;
      HW[QB.reins * 12 + 11] = (W[HB.handL * 12 + 11] + W[HB.handR * 12 + 11]) / 2;
      const seat = Math.max(0, Math.min(1, a.pose[POSE_SEAT]));
      if (seat > 0.6) {
        copy12(HW, QB.stirL * 12, HW, QB.body * 12);
        copy12(HW, QB.stirR * 12, HW, QB.body * 12);
        for (const [sb, fb] of [[QB.stirL, HB.ftL], [QB.stirR, HB.ftR]] as const) {
          HW[sb * 12 + 3] = W[fb * 12 + 3] + W[fb * 12 + 2] * 0.03;
          HW[sb * 12 + 7] = W[fb * 12 + 7] - 0.045;
          HW[sb * 12 + 11] = W[fb * 12 + 11] + W[fb * 12 + 10] * 0.03;
        }
      } else {
        // hanging free under the saddle flaps
        const hd = horse.dims;
        const sy = hd.s.barrelH * hd.scale * 0.52;
        mulEulerT(HW, QB.stirL * 12, HW, QB.body * 12, 0, 0, 0, hd.s.barrelW * hd.scale * 0.55, sy - 0.62, hd.len * 0.12);
        mulEulerT(HW, QB.stirR * 12, HW, QB.body * 12, 0, 0, 0, -hd.s.barrelW * hd.scale * 0.55, sy - 0.62, hd.len * 0.12);
      }
      if (item.highlight >= 2) { copy12(HW, QB.ring * 12, _place, 0); HW[QB.ring * 12 + 7] += 0.03; for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) HW[QB.ring * 12 + i] *= 1.3; }
      else setZero(HW, QB.ring * 12);
      setZero(HW, QB.cloth * 12);
      writeQuadBones(horse.dims, HW, crowd.bones, crowd.boneOffset(horse.slot, 0));
      crowd.setParams(horse.slot, item.highlight, 0);
    }
    // picking info
    st.px = item.x; st.py = item.y; st.pz = item.z; st.yaw = item.yaw;
    st.top = Math.max(0.5, a.top + (horse ? 0 : 0));
    st.mounted = !!horse;
    st.radius = 0.2 * a.dims.H;
    st.lastX = item.x; st.lastY = item.y; st.lastZ = item.z;
    st.lastFull = frame;
  }

  /** Slide an LOD-skipped character's bones by its movement since the last full update. */
  function translateOnly(st: CharState, item: CharacterDrawItem): void {
    const dx = item.x - st.lastX, dy = item.y - st.lastY, dz = item.z - st.lastZ;
    if (dx === 0 && dy === 0 && dz === 0) return;
    const bones = crowd.bones;
    const shift = (slot: number, n: number): void => {
      const o = crowd.boneOffset(slot, 0);
      for (let b = 0; b < n; b++) {
        const t = o + b * 12;
        if (bones[t] === 0 && bones[t + 5] === 0 && bones[t + 10] === 0) continue; // hidden bone
        bones[t + 3] += dx; bones[t + 7] += dy; bones[t + 11] += dz;
      }
    };
    shift(st.slot, HUMAN_TEX_BONES);
    if (st.horse) shift(st.horse.slot, Q_BONES);
    st.lastX = item.x; st.lastY = item.y; st.lastZ = item.z;
    st.px = item.x; st.py = item.y; st.pz = item.z;
  }

  function update(items: readonly CharacterDrawItem[], dt: number, camera: THREE.Camera): void {
    const t0 = performance.now();
    frame++;
    const step = Math.min(0.1, Math.max(0, dt));
    time += step;
    // layer origin near the camera keeps float32 skinning precise across a 16 km world
    camera.getWorldPosition(_v);
    if (Number.isNaN(originX) || Math.abs(_v.x - originX) > 400 || Math.abs(_v.z - originZ) > 400) {
      originX = Math.round(_v.x / 64) * 64; originZ = Math.round(_v.z / 64) * 64;
      crowd.mesh.position.set(originX, 0, originZ);
      crowd.mesh.updateMatrix();
      crowd.mesh.updateMatrixWorld(true);
      forceFull = true;
    }
    camera.updateMatrixWorld();
    _projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projScreen);
    let animated = 0, culled = 0, built = 0;
    const buildBudget = options.buildBudgetMs; // ms per frame for new appearances
    for (const item of items) {
      let st = states.get(item.id);
      if (!st) { st = newState(item); states.set(item.id, st); }
      st.seen = frame;
      // level of detail by distance, with hysteresis
      const ddx = item.x - _v.x, ddz = item.z - _v.z;
      const camDist2 = ddx * ddx + ddz * ddz;
      const far = options.lod ? (st.lod === 1 ? camDist2 > LOD_IN * LOD_IN : camDist2 > LOD_OUT * LOD_OUT) : false;
      const wantLod: 0 | 1 = far && item.highlight === 0 ? 1 : 0;
      if (!st.ready || st.lookVersion !== item.lookVersion) {
        if (built === 0 || performance.now() - t0 < buildBudget) {
          buildBody(st, item, wantLod);
          built++;
        } else if (!st.ready) continue;
      } else if (wantLod !== st.lod && performance.now() - t0 < Math.min(buildBudget, options.lodBudgetMs)) {
        // optional work: swap detail level only while the frame is cheap
        buildBody(st, item, wantLod);
        built++;
      }
      syncEquipment(st, item);
      // culling
      _sphere.center.set(item.x, item.y + (item.mount ? 1.4 : 0.9), item.z);
      _sphere.radius = item.mount ? 2.6 : 1.6;
      const visible = _frustum.intersectsSphere(_sphere);
      if (!visible) {
        if (!st.hidden) {
          crowd.hideSlot(st.slot);
          if (st.horse) crowd.hideSlot(st.horse.slot);
          st.hidden = true;
        }
        culled++;
        // keep picking info roughly current
        st.px = item.x; st.py = item.y; st.pz = item.z;
        continue;
      }
      const dx = item.x - _v.x, dz = item.z - _v.z;
      const dist2 = dx * dx + dz * dz;
      const interval = !options.animLod ? 1 : dist2 < 45 * 45 ? 1 : dist2 < 100 * 100 ? 2 : 4;
      const due = st.hidden || forceFull || interval === 1 || (frame + (st.seed & 3)) % interval === 0 || item.highlight > 0;
      if (due) {
        const adt = st.hidden ? step : Math.min(0.25, step * Math.max(1, frame - st.lastFull));
        animateOne(st, item, st.lastFull < 0 ? step : adt);
        st.hidden = false;
        animated++;
      } else {
        translateOnly(st, item);
      }
    }
    forceFull = false;
    // drop characters that left
    for (const [id, st] of states) {
      if (st.seen !== frame) { release(st); states.delete(id); }
    }
    crowd.commit();
    stats.updateMs = performance.now() - t0;
    stats.animated = animated; stats.culled = culled; stats.built = built; stats.pending = pending.length;
  }

  // ---------------------------------------------------------------- picking
  const _ro = new THREE.Vector3(), _rd = new THREE.Vector3();
  function pick(raycaster: THREE.Raycaster): number {
    _ro.copy(raycaster.ray.origin); _rd.copy(raycaster.ray.direction);
    let best = -1, bestT = Infinity;
    for (const st of states.values()) {
      if (st.hidden || !st.ready) continue;
      // person capsule
      const r = st.mounted ? 0.32 : Math.max(0.22, st.radius);
      const y0 = st.py + (st.mounted ? 1.0 : r * 0.8), y1 = st.py + st.top;
      let t = rayCapsule(_ro, _rd, st.px, y0, st.pz, st.px, Math.max(y0, y1 - r * 0.5), st.pz, r);
      if (st.mounted) {
        // horse body capsule along the facing
        const fx = Math.sin(st.yaw), fz = Math.cos(st.yaw);
        const th = rayCapsule(_ro, _rd, st.px - fx * 0.8, st.py + 1.1, st.pz - fz * 0.8, st.px + fx * 1.0, st.py + 1.3, st.pz + fz * 1.0, 0.45);
        if (th < t) t = th;
      }
      if (t < bestT) { bestT = t; best = st.id; }
    }
    return best;
  }

  function dispose(): void {
    crowd.dispose();
    states.clear();
    geoCache.clear();
    horseCache.clear();
  }

  const layer: CharacterLayer & { stats: typeof stats; crowd: SkinnedCrowd; options: typeof options } = { object, update, pick, dispose, stats, crowd, options };
  return layer;
}

const IDENT = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
import { CH } from './human/pose';
const POSE_SEAT = CH.seat;

/** Skinning matrices for a quadruped (S = W × T(-bind)). */
export function writeQuadBones(q: QuadDims, W: Float32Array, bones: Float32Array, base: number): void {
  for (let b = 0; b < Q_BONES; b++) {
    const o = b * 12, t = base + b * 12;
    const bx = q.bind[b * 3], by = q.bind[b * 3 + 1], bz = q.bind[b * 3 + 2];
    bones[t] = W[o]; bones[t + 1] = W[o + 1]; bones[t + 2] = W[o + 2];
    bones[t + 3] = W[o + 3] - (W[o] * bx + W[o + 1] * by + W[o + 2] * bz);
    bones[t + 4] = W[o + 4]; bones[t + 5] = W[o + 5]; bones[t + 6] = W[o + 6];
    bones[t + 7] = W[o + 7] - (W[o + 4] * bx + W[o + 5] * by + W[o + 6] * bz);
    bones[t + 8] = W[o + 8]; bones[t + 9] = W[o + 9]; bones[t + 10] = W[o + 10];
    bones[t + 11] = W[o + 11] - (W[o + 8] * bx + W[o + 9] * by + W[o + 10] * bz);
  }
}

/** Ray vs capsule (segment a→b, radius r). Returns the ray distance or Infinity. */
export function rayCapsule(ro: THREE.Vector3, rd: THREE.Vector3, ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number): number {
  // closest approach between the ray and the segment, then a sphere test there
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const wx = ro.x - ax, wy = ro.y - ay, wz = ro.z - az;
  const a = rd.x * rd.x + rd.y * rd.y + rd.z * rd.z;
  const b = rd.x * ux + rd.y * uy + rd.z * uz;
  const c = ux * ux + uy * uy + uz * uz;
  const d = rd.x * wx + rd.y * wy + rd.z * wz;
  const e = ux * wx + uy * wy + uz * wz;
  const den = a * c - b * b;
  let s = den > 1e-9 ? (b * e - c * d) / den : 0;
  let t = c > 1e-9 ? (a * e - b * d) / den : 0;
  if (den <= 1e-9) t = 0;
  t = Math.max(0, Math.min(1, t));
  // recompute s for the clamped t
  s = Math.max(0, (rd.x * (ax + ux * t - ro.x) + rd.y * (ay + uy * t - ro.y) + rd.z * (az + uz * t - ro.z)) / a);
  const px = ro.x + rd.x * s - (ax + ux * t), py = ro.y + rd.y * s - (ay + uy * t), pz = ro.z + rd.z * s - (az + uz * t);
  const dist2 = px * px + py * py + pz * pz;
  if (dist2 > r * r) return Infinity;
  // back off to the entry point of the sphere at the closest approach
  return Math.max(0, s - Math.sqrt(Math.max(0, r * r - dist2)));
}
