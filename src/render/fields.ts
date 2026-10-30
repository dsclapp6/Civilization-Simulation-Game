// Open-field strips from view.strips(): draped surface meshes per 1 km tile (built lazily near the
// camera: a terrain-hugging grid within FINE_DIST, a few long quads further out) coloured by
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
/** Crops nearer than this to the camera cast shadows. */
const CROP_SHADOW_DIST = 30;
/** Tiles closer than this use the fine, terrain-hugging strip grid. */
const FINE_DIST = 600;

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
  cx: number;
  cz: number;
  radius: number;
  state: StripState;
  crop: CropKind;
  growth: number;
}

interface Tile {
  key: number;
  strips: StripGeom[];
  mesh: THREE.Mesh | null;
  geo: THREE.BufferGeometry | null;
  lod: -1 | 0 | 1;
  cx: number;
  cz: number;
}

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
  private readonly cropShadowMeshes = new Map<string, THREE.InstancedMesh>();
  private readonly kits = new Map<string, InstancedKit>();
  private cropJob: { order: StripGeom[]; idx: number; cx: number; cz: number; buf: Map<string, number[]>; total: number } | null = null;
  private lastCropPos = new THREE.Vector2(Infinity, Infinity);
  private lastList: readonly StripView[] = [];
  private pendingTiles = 0;
  private readonly tmpC = new THREE.Color();
  private readonly tmpC2 = new THREE.Color();
  private readonly fieldColor: THREE.Color;
  private readonly grassColor: THREE.Color;
  private cropsDirty = true;
  cropInstances = 0;

  constructor(private readonly world: WorldModel, private readonly assets: AssetLibrary, terrainU: TerrainUniforms, private settings: FieldSettings) {
    this.root.name = 'fields';
    this.fieldColor = new THREE.Color(assets.palette.ground[Ground.Field]);
    this.grassColor = new THREE.Color(assets.palette.ground[Ground.Grass]);
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

  /** Strip frames and states only; tile geometry is built lazily near the camera. */
  private buildIndex(list: readonly StripView[]): void {
    for (const t of this.tiles.values()) this.dropTile(t);
    this.tiles.clear();
    this.strips.clear();
    for (const sv of list) {
      if (sv.poly.length < 4) continue;
      const p = sv.poly.slice(0, 4).map((q) => new THREE.Vector2(q.x, q.z));
      const e0 = p[1].distanceTo(p[0]), e1 = p[3].distanceTo(p[0]);
      const longIsV = e1 >= e0;
      const width = longIsV ? e0 : e1, length = longIsV ? e1 : e0;
      const cx = (p[0].x + p[1].x + p[2].x + p[3].x) / 4, cz = (p[0].y + p[1].y + p[2].y + p[3].y) / 4;
      const g: StripGeom = {
        id: sv.id, tile: this.tileKey(cx, cz), start: 0, count: 0, p, longIsV, width, length,
        cx, cz, radius: Math.hypot(width, length) / 2, state: sv.state, crop: sv.crop, growth: sv.growth,
      };
      this.strips.set(sv.id, g);
      let t = this.tiles.get(g.tile);
      if (!t) {
        t = { key: g.tile, strips: [], mesh: null, geo: null, lod: -1, cx: (g.tile % 64 + 0.5) * TILE, cz: (Math.floor(g.tile / 64) + 0.5) * TILE };
        this.tiles.set(g.tile, t);
      }
      t.strips.push(g);
    }
  }

  private dropTile(t: Tile): void {
    if (t.mesh) { this.root.remove(t.mesh); t.geo!.dispose(); }
    t.mesh = null;
    t.geo = null;
    t.lod = -1;
  }

  /** Bilinear point inside a strip: u across (0..1), w along (0..1). */
  private stripPoint(g: StripGeom, u: number, w: number, out: THREE.Vector2): THREE.Vector2 {
    const a = g.p[0], b = g.longIsV ? g.p[1] : g.p[3], c = g.p[2], d = g.longIsV ? g.p[3] : g.p[1];
    return out.set(
      (a.x * (1 - u) + b.x * u) * (1 - w) + (d.x * (1 - u) + c.x * u) * w,
      (a.y * (1 - u) + b.y * u) * (1 - w) + (d.y * (1 - u) + c.y * u) * w,
    );
  }

  /**
   * Indexed draped grid per strip. LOD 0 (near) follows the terrain closely (2 x 2.5 m cells) so
   * fine terrain facets cannot poke through; LOD 1 (far) is a few long quads lifted a little more.
   */
  private buildTile(t: Tile, lod: 0 | 1): void {
    let verts = 0, tris = 0;
    const dims = t.strips.map((g) => {
      const nu = lod === 0 ? Math.max(2, Math.round(g.width / 2)) : 1;
      const nv = lod === 0 ? Math.max(2, Math.round(g.length / 2.5)) : Math.max(1, Math.round(g.length / 25));
      verts += (nu + 1) * (nv + 1);
      tris += nu * nv * 2;
      return { nu, nv };
    });
    const pos = new Float32Array(verts * 3), col = new Float32Array(verts * 3), fld = new Float32Array(verts * 4);
    const index = new Uint32Array(tris * 3);
    const q = new THREE.Vector2();
    const lift = lod === 0 ? 0.1 : 0.35;
    let v = 0, ii = 0;
    t.strips.forEach((g, si) => {
      const { nu, nv } = dims[si];
      g.start = v;
      for (let j = 0; j <= nv; j++) {
        for (let i = 0; i <= nu; i++) {
          this.stripPoint(g, i / nu, j / nv, q);
          pos[v * 3] = q.x; pos[v * 3 + 1] = this.world.heightAt(q.x, q.y) + lift; pos[v * 3 + 2] = q.y;
          fld[v * 4] = (i / nu) * g.width;
          fld[v * 4 + 1] = (j / nv) * g.length;
          v++;
        }
      }
      g.count = v - g.start;
      for (let j = 0; j < nv; j++) {
        for (let i = 0; i < nu; i++) {
          const a = g.start + j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
          index[ii++] = a; index[ii++] = c; index[ii++] = b;
          index[ii++] = b; index[ii++] = c; index[ii++] = d;
        }
      }
    });
    // make every face point up (strip corners may wind either way)
    for (let k = 0; k < index.length; k += 3) {
      const a = index[k], b = index[k + 1], c = index[k + 2];
      const ux = pos[b * 3] - pos[a * 3], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
      const vx = pos[c * 3] - pos[a * 3], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
      if (uz * vx - ux * vz < 0) { index[k + 1] = c; index[k + 2] = b; }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aField', new THREE.BufferAttribute(fld, 4));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    if (t.mesh) { this.root.remove(t.mesh); t.geo!.dispose(); }
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.receiveShadow = true;
    mesh.name = `strips:${t.key}:${lod}`;
    mesh.matrixAutoUpdate = false;
    this.root.add(mesh);
    t.mesh = mesh;
    t.geo = geo;
    t.lod = lod;
    this.colorTile(t);
  }

  private stripLook(g: StripGeom, c: THREE.Color): { furrow: number; rows: number } {
    const field = this.fieldColor, grass = this.grassColor;
    let furrow = 0.15, rows = 0;
    const vary = 0.94 + hash01(g.id, 3) * 0.12;
    switch (g.state) {
      case 'bare': c.copy(field).multiplyScalar(1.05); furrow = 0.1; break;
      case 'ploughed': c.copy(field).multiplyScalar(0.78); furrow = 0.85; break;
      case 'sown': c.copy(field).multiplyScalar(0.84).lerp(this.tmpC.setHex(CROP_GREEN[g.crop]), 0.12); furrow = 0.7; break;
      case 'growing': {
        const t = clamp(g.growth, 0, 1);
        c.copy(field).multiplyScalar(0.85).lerp(lerpHex(CROP_GREEN[g.crop], CROP_RIPE[g.crop], Math.max(0, t - 0.6) * 1.6, this.tmpC), 0.3 + t * 0.65);
        furrow = 0.5 * (1 - t); rows = 0.6 * t + 0.2;
        break;
      }
      case 'ripe': c.setHex(CROP_RIPE[g.crop]); rows = 0.5; furrow = 0; break;
      case 'harvested': c.setHex(0xc8b07a); furrow = 0.25; rows = 0.4; break;
      case 'stubble': c.setHex(0xb59f6c); furrow = 0.2; rows = 0.5; break;
      case 'fallow': c.copy(grass).lerp(field, 0.35).multiplyScalar(0.95); furrow = 0.05; break;
    }
    c.multiplyScalar(vary);
    return { furrow, rows };
  }

  private colorTile(t: Tile): void {
    if (!t.geo) return;
    const col = t.geo.getAttribute('color') as THREE.BufferAttribute;
    const fld = t.geo.getAttribute('aField') as THREE.BufferAttribute;
    const c = this.tmpC2;
    for (const g of t.strips) {
      const { furrow, rows } = this.stripLook(g, c);
      for (let v = g.start; v < g.start + g.count; v++) {
        col.setXYZ(v, c.r, c.g, c.b);
        fld.setZ(v, furrow);
        fld.setW(v, rows);
      }
    }
    col.needsUpdate = true;
    fld.needsUpdate = true;
  }

  private recolor(list: readonly StripView[]): void {
    const dirty = new Set<Tile>();
    for (const sv of list) {
      const g = this.strips.get(sv.id);
      if (!g) continue;
      if (g.state === sv.state && g.crop === sv.crop && Math.abs(g.growth - sv.growth) < 1e-3) continue;
      g.state = sv.state; g.crop = sv.crop; g.growth = sv.growth;
      const t = this.tiles.get(g.tile);
      if (t) dirty.add(t);
    }
    for (const t of dirty) this.colorTile(t);
  }

  update(list: readonly StripView[], version: number, camera: THREE.Camera, budgetMs: number): number {
    const t0 = performance.now();
    this.lastList = list;
    if (version !== this.version) {
      const sameSet = list.length === this.strips.size && list.every((s) => this.strips.has(s.id));
      if (!sameSet) this.buildIndex(list);
      this.recolor(list);
      this.version = version;
      this.cropsDirty = true;
    }
    const cp = camera.position;
    // tiles: fine near, coarse further out, none beyond the strip distance; nearest built first
    const todo: { t: Tile; lod: 0 | 1; d: number }[] = [];
    for (const t of this.tiles.values()) {
      const d = Math.max(0, Math.hypot(t.cx - cp.x, t.cz - cp.z) - TILE * 0.71);
      const far = d > this.settings.stripDistance || cp.y > this.settings.stripDistance;
      if (far) {
        if (t.mesh) { t.mesh.visible = false; if (d > this.settings.stripDistance * 1.4) this.dropTile(t); }
        continue;
      }
      const want: 0 | 1 = d < FINE_DIST ? 0 : t.lod === 0 && d < FINE_DIST * 1.25 ? 0 : 1;
      if (t.mesh) t.mesh.visible = true;
      if (t.lod !== want) todo.push({ t, lod: want, d });
    }
    todo.sort((a, b) => a.d - b.d);
    for (let k = 0; k < todo.length; k++) {
      if (k > 0 && performance.now() - t0 > budgetMs) break;
      this.buildTile(todo[k].t, todo[k].lod);
    }
    this.pendingTiles = Math.max(0, todo.length - 1);
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
    for (let i = 0; i < 200 && (this.cropJob || this.pendingTiles > 0); i++) {
      this.update(this.lastList, this.version, camera, 1000);
      if (this.cropJob) this.stepCrops(performance.now() + 50);
    }
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
          const y = this.world.heightAt(x, z) + 0.02;
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
    for (const [key, mesh] of this.cropMeshes) if (!job.buf.has(key)) mesh.count = 0;
    for (const [key, mesh] of this.cropShadowMeshes) if (!job.buf.has(key)) mesh.count = 0;
    // keep within the triangle budget: instances were gathered nearest strip first, so trimming
    // each list's tail drops the farthest plants
    let tris = 0;
    for (const [key, arr] of job.buf) {
      const g = this.kit(key).geometry;
      tris += (arr.length / 5) * ((g.index ? g.index.count : g.getAttribute('position').count) / 3);
    }
    const keep = tris > this.settings.cropTris ? this.settings.cropTris / tris : 1;
    const mk = (key: string, n: number, shadow: boolean): THREE.InstancedMesh => {
      const pool = shadow ? this.cropShadowMeshes : this.cropMeshes;
      let mesh = pool.get(key);
      if (!mesh || mesh.instanceMatrix.count < n) {
        if (mesh) { this.root.remove(mesh); mesh.dispose(); }
        const kit = this.kit(key);
        mesh = new THREE.InstancedMesh(kit.geometry, kit.material, Math.ceil(n * 1.3) + 32);
        mesh.frustumCulled = false;
        mesh.receiveShadow = true;
        // only crops close to the camera cast shadows (they follow the sway via the kit's depth material)
        mesh.castShadow = shadow;
        if (shadow && kit.depthMaterial) mesh.customDepthMaterial = kit.depthMaterial;
        mesh.name = `crop:${key}${shadow ? ':near' : ''}`;
        pool.set(key, mesh);
        this.root.add(mesh);
      }
      return mesh;
    };
    const near2 = CROP_SHADOW_DIST * CROP_SHADOW_DIST;
    for (const [key, arr] of job.buf) {
      const n = Math.floor((arr.length / 5) * keep);
      const tall = Number(key.split(':')[1]) >= 2;
      let nNear = 0;
      if (tall) for (let i = 0; i < n; i++) if ((arr[i * 5] - job.cx) ** 2 + (arr[i * 5 + 2] - job.cz) ** 2 < near2) nNear++;
      const far = mk(key, Math.max(1, n - nNear), false);
      const nearMesh = tall ? mk(key, Math.max(1, nNear), true) : null;
      let iFar = 0, iNear = 0;
      for (let i = 0; i < n; i++) {
        q.setFromAxisAngle(y, arr[i * 5 + 3]);
        const sc = arr[i * 5 + 4];
        m.compose(p.set(arr[i * 5], arr[i * 5 + 1], arr[i * 5 + 2]), q, s.set(sc, sc, sc));
        const isNear = tall && (arr[i * 5] - job.cx) ** 2 + (arr[i * 5 + 2] - job.cz) ** 2 < near2;
        if (isNear) nearMesh!.setMatrixAt(iNear++, m);
        else far.setMatrixAt(iFar++, m);
      }
      far.count = iFar;
      far.instanceMatrix.needsUpdate = true;
      if (nearMesh) { nearMesh.count = iNear; nearMesh.instanceMatrix.needsUpdate = true; }
      else { const sm = this.cropShadowMeshes.get(key); if (sm) sm.count = 0; }
      total += n;
    }
    this.cropInstances = total;
  }

  dispose(): void {
    for (const t of this.tiles.values()) t.geo?.dispose();
    for (const m of this.cropMeshes.values()) m.dispose();
    for (const m of this.cropShadowMeshes.values()) m.dispose();
    this.material.dispose();
    this.root.clear();
  }
}
