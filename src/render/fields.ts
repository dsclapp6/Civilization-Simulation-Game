// Open-field strips from view.strips(): draped surface meshes (per 1 km tile) coloured by
// StripState with procedural furrows/crop rows, and crop instances (assets.crop) in rows inside
// strips near the camera, rebuilt time-sliced as the camera moves.
import * as THREE from 'three';
import type { CropKind } from '../core/domain';
import { clamp, hash01 } from '../core/math';
import type { StripState, StripView } from '../core/view';
import type { AssetLibrary, InstancedKit } from '../assets/types';
import type { WorldModel } from '../world/types';
import { Ground } from '../world/types';
import type { TerrainUniforms } from './terrain/terrainMaterial';

const TILE = 1024;

interface StripGeom {
  id: number;
  tile: number;
  start: number;
  count: number;
  /** corners and frame */
  p: THREE.Vector2[];
  /** long axis is p0→p3 (true) or p0→p1 */
  longIsV: boolean;
  width: number;
  length: number;
  nu: number;
  nv: number;
  heights: Float32Array;
  cx: number;
  cz: number;
  radius: number;
  state: StripState;
  crop: CropKind;
  growth: number;
}

interface Tile { key: number; mesh: THREE.Mesh; geo: THREE.BufferGeometry; cx: number; cz: number }

const CROP_GREEN: Record<CropKind, number> = {
  wheat: 0x6f9a3e, rye: 0x6a9440, barley: 0x7aa448, oats: 0x7ea64e, peas: 0x4f8a3a, beans: 0x4a7f36, flax: 0x5f9a5a,
  cabbage: 0x6a9f66, onions: 0x6a9a62, leeks: 0x5a8f56, turnips: 0x5f8f42, fallow: 0x7a9a4a,
};
const CROP_RIPE: Record<CropKind, number> = {
  wheat: 0xd6ad52, rye: 0xc4a25e, barley: 0xdcbf6c, oats: 0xd2c27a, peas: 0x8a8a44, beans: 0x6f6a3a, flax: 0x8a96b8,
  cabbage: 0x7aae74, onions: 0x93a46e, leeks: 0x6f9f68, turnips: 0x6f9a48, fallow: 0x8a9a52,
};

function lerpHex(a: number, b: number, t: number, out: THREE.Color): THREE.Color {
  const ca = new THREE.Color(a), cb = new THREE.Color(b);
  return out.copy(ca).lerp(cb, t);
}

export interface FieldSettings {
  stripDistance: number;
  cropRadius: number;
  cropMax: number;
  /** Triangle cap for all crop instances. */
  cropTris: number;
}

export class FieldSystem {
  readonly root = new THREE.Group();
  private readonly material: THREE.MeshLambertMaterial;
  private readonly tiles = new Map<number, Tile>();
  private readonly strips = new Map<number, StripGeom>();
  private version = -1;
  private readonly cropMeshes = new Map<string, THREE.InstancedMesh>();
  private readonly kits = new Map<string, InstancedKit>();
  private cropJob: { order: StripGeom[]; idx: number; cx: number; cz: number; buf: Map<string, number[]>; total: number } | null = null;
  private lastCropPos = new THREE.Vector2(Infinity, Infinity);
  private cropsDirty = true;
  cropInstances = 0;

  constructor(private readonly world: WorldModel, private readonly assets: AssetLibrary, terrainU: TerrainUniforms, private settings: FieldSettings) {
    this.root.name = 'fields';
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 });
    this.material.name = 'strips';
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, { uSnowCover: terrainU.uSnowCover, uWetness: terrainU.uWetness });
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
attribute vec4 aField;
varying vec4 vField;
varying vec3 vFWorld;`)
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
vField = aField;
vFWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
uniform float uSnowCover;
uniform float uWetness;
varying vec4 vField;
varying vec3 vFWorld;
float fHash(vec2 p) { p = fract(p * vec2(233.34, 851.73)); p += dot(p, p + 23.45); return fract(p.x * p.y); }
float fNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 w = f * f * (3.0 - 2.0 * f);
  return mix(mix(fHash(i), fHash(i + vec2(1.0, 0.0)), w.x), mix(fHash(i + vec2(0.0, 1.0)), fHash(i + vec2(1.0, 1.0)), w.x), w.y);
}`)
        .replace('#include <color_fragment>', `#include <color_fragment>
{
  // furrows run along the strip (across coordinate in metres = vField.x)
  float furrow = sin(vField.x * 6.2831853 / 0.9);
  float fw = fwidth(vField.x * 1.111);
  float aa = clamp(1.0 - fw * 1.5, 0.0, 1.0);
  diffuseColor.rgb *= 1.0 - vField.z * 0.32 * (0.5 + 0.5 * furrow) * aa;
  float rows = smoothstep(0.2, 0.9, sin(vField.x * 6.2831853 / 0.75) * 0.5 + 0.5);
  diffuseColor.rgb *= 1.0 + vField.w * (rows - 0.5) * 0.25 * aa;
  float n = fNoise(vFWorld.xz * 0.35) * 0.6 + fNoise(vFWorld.xz * 1.3) * 0.4;
  diffuseColor.rgb *= 0.93 + n * 0.14;
  float snow = smoothstep(1.0 - uSnowCover, 1.0 - uSnowCover + 0.25, n * 0.5 + 0.5 - furrow * 0.12);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.9, 0.95), clamp(snow * smoothstep(0.0, 0.2, uSnowCover), 0.0, 1.0));
  diffuseColor.rgb *= 1.0 - uWetness * 0.25 * (1.0 - snow);
}`);
    };
    this.material.customProgramCacheKey = () => 'millennia-strips';
  }

  configure(s: FieldSettings): void { this.settings = s; this.cropsDirty = true; }

  private tileKey(x: number, z: number): number { return Math.floor(z / TILE) * 64 + Math.floor(x / TILE); }

  private buildGeometry(list: readonly StripView[]): void {
    for (const t of this.tiles.values()) { this.root.remove(t.mesh); t.geo.dispose(); }
    this.tiles.clear();
    this.strips.clear();
    const byTile = new Map<number, StripGeom[]>();
    for (const sv of list) {
      if (sv.poly.length < 4) continue;
      const p = sv.poly.slice(0, 4).map((q) => new THREE.Vector2(q.x, q.z));
      const e0 = p[1].distanceTo(p[0]), e1 = p[3].distanceTo(p[0]);
      const longIsV = e1 >= e0;
      const width = longIsV ? e0 : e1, length = longIsV ? e1 : e0;
      const cx = (p[0].x + p[1].x + p[2].x + p[3].x) / 4, cz = (p[0].y + p[1].y + p[2].y + p[3].y) / 4;
      const nu = Math.max(1, Math.round((longIsV ? e0 : e1) / 3.5)), nv = Math.max(1, Math.round((longIsV ? e1 : e0) / 5));
      const g: StripGeom = {
        id: sv.id, tile: this.tileKey(cx, cz), start: 0, count: 0, p, longIsV, width, length, nu, nv,
        heights: new Float32Array((nu + 1) * (nv + 1)), cx, cz, radius: Math.hypot(width, length) / 2,
        state: sv.state, crop: sv.crop, growth: sv.growth,
      };
      this.strips.set(sv.id, g);
      let arr = byTile.get(g.tile);
      if (!arr) { arr = []; byTile.set(g.tile, arr); }
      arr.push(g);
    }
    for (const [key, arr] of byTile) {
      let verts = 0;
      for (const g of arr) verts += g.nu * g.nv * 6;
      const pos = new Float32Array(verts * 3), nor = new Float32Array(verts * 3), col = new Float32Array(verts * 3), fld = new Float32Array(verts * 4);
      let v = 0;
      for (const g of arr) {
        g.start = v;
        const P = (u: number, w: number, out: THREE.Vector2) => {
          // bilinear over the quad; u across (p0→p1 or p0→p3), w along
          const a = g.p[0], b = g.longIsV ? g.p[1] : g.p[3], c = g.p[2], d = g.longIsV ? g.p[3] : g.p[1];
          out.set(
            (a.x * (1 - u) + b.x * u) * (1 - w) + (d.x * (1 - u) + c.x * u) * w,
            (a.y * (1 - u) + b.y * u) * (1 - w) + (d.y * (1 - u) + c.y * u) * w,
          );
          return out;
        };
        const q = new THREE.Vector2();
        for (let j = 0; j <= g.nv; j++) {
          for (let i = 0; i <= g.nu; i++) {
            P(i / g.nu, j / g.nv, q);
            g.heights[j * (g.nu + 1) + i] = this.world.heightAt(q.x, q.y) + 0.07;
          }
        }
        for (let j = 0; j < g.nv; j++) {
          for (let i = 0; i < g.nu; i++) {
            for (let t = 0; t < 2; t++) {
              const ids = t === 0 ? [[i, j], [i, j + 1], [i + 1, j + 1]] : [[i, j], [i + 1, j + 1], [i + 1, j]];
              const pts = ids.map(([a, b]) => {
                P(a / g.nu, b / g.nv, q);
                return new THREE.Vector3(q.x, g.heights[b * (g.nu + 1) + a], q.y);
              });
              const nrm = new THREE.Vector3().subVectors(pts[1], pts[0]).cross(new THREE.Vector3().subVectors(pts[2], pts[0])).normalize();
              if (nrm.y < 0) {
                nrm.negate();
                [pts[1], pts[2]] = [pts[2], pts[1]];
                [ids[1], ids[2]] = [ids[2], ids[1]];
              }
              for (let k = 0; k < 3; k++) {
                const [a, b] = ids[k];
                pos[v * 3] = pts[k].x; pos[v * 3 + 1] = pts[k].y; pos[v * 3 + 2] = pts[k].z;
                nor[v * 3] = nrm.x; nor[v * 3 + 1] = nrm.y; nor[v * 3 + 2] = nrm.z;
                // across metres from the strip edge (furrows) and along metres
                fld[v * 4] = (a / g.nu) * g.width;
                fld[v * 4 + 1] = (b / g.nv) * g.length;
                v++;
              }
            }
          }
        }
        g.count = v - g.start;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.setAttribute('aField', new THREE.BufferAttribute(fld, 4));
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.receiveShadow = true;
      mesh.name = `strips:${key}`;
      mesh.matrixAutoUpdate = false;
      this.root.add(mesh);
      const tx = (key % 64 + 0.5) * TILE, tz = (Math.floor(key / 64) + 0.5) * TILE;
      this.tiles.set(key, { key, mesh, geo, cx: tx, cz: tz });
    }
  }

  private recolor(list: readonly StripView[]): void {
    const c = new THREE.Color();
    const field = new THREE.Color(this.assets.palette.ground[Ground.Field]);
    const grass = new THREE.Color(this.assets.palette.ground[Ground.Grass]);
    for (const sv of list) {
      const g = this.strips.get(sv.id);
      if (!g) continue;
      g.state = sv.state; g.crop = sv.crop; g.growth = sv.growth;
      const tile = this.tiles.get(g.tile);
      if (!tile) continue;
      let furrow = 0.15, rows = 0;
      const vary = 0.94 + hash01(sv.id, 3) * 0.12;
      switch (sv.state) {
        case 'bare': c.copy(field).multiplyScalar(1.05); furrow = 0.1; break;
        case 'ploughed': c.copy(field).multiplyScalar(0.78); furrow = 0.85; break;
        case 'sown': c.copy(field).multiplyScalar(0.84).lerp(new THREE.Color(CROP_GREEN[sv.crop]), 0.12); furrow = 0.7; break;
        case 'growing': {
          const t = clamp(sv.growth, 0, 1);
          c.copy(field).multiplyScalar(0.85).lerp(lerpHex(CROP_GREEN[sv.crop], CROP_RIPE[sv.crop], Math.max(0, t - 0.6) * 1.6, new THREE.Color()), 0.3 + t * 0.65);
          furrow = 0.5 * (1 - t); rows = 0.6 * t + 0.2;
          break;
        }
        case 'ripe': c.setHex(CROP_RIPE[sv.crop]); rows = 0.5; furrow = 0; break;
        case 'harvested': c.setHex(0xc8b07a); furrow = 0.25; rows = 0.4; break;
        case 'stubble': c.setHex(0xb59f6c); furrow = 0.2; rows = 0.5; break;
        case 'fallow': c.copy(grass).lerp(field, 0.35).multiplyScalar(0.95); furrow = 0.05; break;
      }
      c.multiplyScalar(vary);
      const col = tile.geo.getAttribute('color') as THREE.BufferAttribute;
      const fld = tile.geo.getAttribute('aField') as THREE.BufferAttribute;
      for (let v = g.start; v < g.start + g.count; v++) {
        col.setXYZ(v, c.r, c.g, c.b);
        fld.setZ(v, furrow);
        fld.setW(v, rows);
      }
      col.needsUpdate = true;
      fld.needsUpdate = true;
    }
  }

  update(list: readonly StripView[], version: number, camera: THREE.Camera, budgetMs: number): number {
    const t0 = performance.now();
    if (version !== this.version) {
      const sameSet = list.length === this.strips.size && list.every((s) => this.strips.has(s.id));
      if (!sameSet) this.buildGeometry(list);
      this.recolor(list);
      this.version = version;
      this.cropsDirty = true;
    }
    const cp = camera.position;
    for (const t of this.tiles.values()) {
      t.mesh.visible = Math.hypot(t.cx - cp.x, t.cz - cp.z) - TILE * 0.71 < this.settings.stripDistance && cp.y < this.settings.stripDistance;
    }
    // crops
    if (Math.hypot(this.lastCropPos.x - cp.x, this.lastCropPos.y - cp.z) > 10 || this.cropsDirty) {
      if (!this.cropJob) {
        this.cropsDirty = false;
        this.lastCropPos.set(cp.x, cp.z);
        const R = this.settings.cropRadius;
        const order = [...this.strips.values()]
          .filter((g) => (g.state === 'sown' || g.state === 'growing' || g.state === 'ripe') && Math.hypot(g.cx - cp.x, g.cz - cp.z) - g.radius < R && cp.y - this.world.heightAt(cp.x, cp.z) < R)
          .sort((a, b) => Math.hypot(a.cx - cp.x, a.cz - cp.z) - Math.hypot(b.cx - cp.x, b.cz - cp.z));
        this.cropJob = { order, idx: 0, cx: cp.x, cz: cp.z, buf: new Map(), total: 0 };
      }
    }
    if (this.cropJob) this.stepCrops(t0 + budgetMs);
    return performance.now() - t0;
  }

  settle(camera: THREE.Camera): void {
    for (let i = 0; i < 200 && this.cropJob; i++) this.stepCrops(performance.now() + 50);
    void camera;
  }

  private stage(g: StripGeom): 0 | 1 | 2 | 3 {
    if (g.state === 'ripe') return 3;
    if (g.state === 'sown') return 0;
    return g.growth < 0.3 ? 0 : g.growth < 0.6 ? 1 : 2;
  }

  private stepCrops(deadline: number): void {
    const job = this.cropJob!;
    const R = this.settings.cropRadius, max = this.settings.cropMax;
    while (job.idx < job.order.length && performance.now() < deadline) {
      const g = job.order[job.idx++];
      const stage = this.stage(g);
      const key = `${g.crop}:${stage}`;
      let arr = job.buf.get(key);
      if (!arr) { arr = []; job.buf.set(key, arr); }
      const rowSp = g.crop === 'cabbage' || g.crop === 'turnips' ? 0.9 : 0.7;
      const plantSp = g.crop === 'cabbage' || g.crop === 'turnips' ? 0.8 : 0.55;
      const rowsN = Math.max(1, Math.floor(g.width / rowSp));
      const plantsN = Math.max(1, Math.floor(g.length / plantSp));
      const a = g.p[0], b = g.longIsV ? g.p[1] : g.p[3], c = g.p[2], d = g.longIsV ? g.p[3] : g.p[1];
      for (let r = 0; r < rowsN; r++) {
        const u = (r + 0.5) / rowsN;
        for (let k = 0; k < plantsN; k++) {
          if (job.total >= max) break;
          const w = (k + 0.5) / plantsN;
          const h = hash01(g.id * 7919 + r, k);
          const x = (a.x * (1 - u) + b.x * u) * (1 - w) + (d.x * (1 - u) + c.x * u) * w + (h - 0.5) * 0.18;
          const z = (a.y * (1 - u) + b.y * u) * (1 - w) + (d.y * (1 - u) + c.y * u) * w + (hash01(h * 1e6, 2) - 0.5) * 0.18;
          const dist = Math.hypot(x - job.cx, z - job.cz);
          if (dist > R) continue;
          // thin out with distance
          if (dist > R * 0.45 && h > 1.25 - dist / R) continue;
          const gi = Math.min(g.nu - 1, Math.floor(u * g.nu)), gj = Math.min(g.nv - 1, Math.floor(w * g.nv));
          const fu = u * g.nu - gi, fw = w * g.nv - gj, W1 = g.nu + 1;
          const y = (g.heights[gj * W1 + gi] * (1 - fu) + g.heights[gj * W1 + gi + 1] * fu) * (1 - fw)
            + (g.heights[(gj + 1) * W1 + gi] * (1 - fu) + g.heights[(gj + 1) * W1 + gi + 1] * fu) * fw - 0.07;
          arr.push(x, y, z, h * 6.283, 0.85 + hash01(h * 1e6, 3) * 0.3);
          job.total++;
        }
      }
    }
    if (job.idx >= job.order.length || job.total >= max) this.commitCrops();
  }

  private kit(key: string): InstancedKit {
    let k = this.kits.get(key);
    if (!k) {
      const [crop, stage] = key.split(':');
      k = this.assets.crop(crop as CropKind, Number(stage) as 0 | 1 | 2 | 3);
      this.kits.set(key, k);
    }
    return k;
  }

  private commitCrops(): void {
    const job = this.cropJob!;
    this.cropJob = null;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), y = new THREE.Vector3(0, 1, 0);
    let total = 0;
    for (const [key, mesh] of this.cropMeshes) {
      if (!job.buf.has(key)) mesh.count = 0;
    }
    // keep within the triangle budget: instances were gathered nearest strip first, so trimming
    // each list's tail drops the farthest plants
    let tris = 0;
    for (const [key, arr] of job.buf) {
      const g = this.kit(key).geometry;
      tris += (arr.length / 5) * ((g.index ? g.index.count : g.getAttribute('position').count) / 3);
    }
    const keep = tris > this.settings.cropTris ? this.settings.cropTris / tris : 1;
    for (const [key, arr] of job.buf) {
      const n = Math.floor((arr.length / 5) * keep);
      let mesh = this.cropMeshes.get(key);
      if (!mesh || (mesh.instanceMatrix.count < n)) {
        if (mesh) { this.root.remove(mesh); mesh.dispose(); }
        const kit = this.kit(key);
        mesh = new THREE.InstancedMesh(kit.geometry, kit.material, Math.ceil(n * 1.3) + 32);
        mesh.frustumCulled = false;
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        mesh.name = `crop:${key}`;
        this.cropMeshes.set(key, mesh);
        this.root.add(mesh);
      }
      for (let i = 0; i < n; i++) {
        q.setFromAxisAngle(y, arr[i * 5 + 3]);
        const sc = arr[i * 5 + 4];
        m.compose(p.set(arr[i * 5], arr[i * 5 + 1], arr[i * 5 + 2]), q, s.set(sc, sc, sc));
        mesh.setMatrixAt(i, m);
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      total += n;
    }
    this.cropInstances = total;
  }

  dispose(): void {
    for (const t of this.tiles.values()) t.geo.dispose();
    for (const m of this.cropMeshes.values()) m.dispose();
    this.material.dispose();
    this.root.clear();
  }
}
