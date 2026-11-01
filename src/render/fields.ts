// Open-field strips from view.strips(): draped surface meshes per 1 km tile (built lazily near the
// camera: a terrain-hugging grid within FINE_DIST, a few long quads further out) coloured by
// StripState with procedural furrows/crop rows, and crop instances (assets.crop) in rows inside
// strips near the camera, rebuilt time-sliced as the camera moves.
//
// Work in progress (StripView.task + work, docs/CLARITY.md §4) is drawn on the strip itself: the part
// from the strip's first short edge (the one through poly[0]) up to `work × length` along the strip
// takes the look of the task's result (dark ploughed furrows, fine harrowed tilth, sown drills, swathes of
// cut corn, mown windrows, clean stubble), with a fresh working front at the boundary. The boundary glides
// to each new value (no jumps between bouts) and standing crops are cut down behind it. Per-strip changes
// rewrite only that strip's vertices (partial uploads), so a busy harvest costs next to nothing.
import * as THREE from 'three';
import type { CropKind } from '../core/domain';
import { clamp, hash01 } from '../core/math';
import type { StripState, StripTask, StripView } from '../core/view';
import type { AssetLibrary, InstancedKit } from '../assets/types';
import type { WorldModel } from '../world/types';
import { Ground } from '../world/types';
import type { TerrainUniforms } from './terrain/terrainMaterial';

const TILE = 1024;
/** Crops nearer than this to the camera cast shadows. */
const CROP_SHADOW_DIST = 30;
/** Tiles closer than this use the fine, terrain-hugging strip grid. */
const FINE_DIST = 600;
/** Seconds the worked boundary takes to glide to a new value. */
const WORK_GLIDE_S = 1.4;
/** Floats per gathered crop instance: x, y, z, rot, scale, strip id, metres along the strip. */
const CI = 7;

/** Task codes in the aWork attribute (0 = no task under way). */
export const TASK_CODE: Record<StripTask, number> = { plough: 1, harrow: 2, sow: 3, weed: 4, reap: 5, mow: 6, bind: 7, carry: 8, glean: 9 };
/** Surface patterns (aWork.w): 0 plain, 1 swathes of cut corn, 2 mown windrows, 3 weedy, 4 fine tilth. */
const PAT_SWATHES = 1, PAT_WEEDY = 3, PAT_TILTH = 4;
/** Tasks that cut standing plants down behind the boundary. */
const CUTTING = new Set<StripTask>(['reap', 'mow']);

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
  /** Per-strip colour variation (0.94..1.06). */
  vary: number;
  /** Task under way (null = none) and its target progress 0..1. */
  task: StripTask | null;
  work: number;
  /** Progress currently drawn (glides towards `work`), the glide start and its phase 0..1. */
  shown: number;
  from: number;
  glide: number;
  /** Harrowing finished on this ploughed strip (the sim does not show it; kept until the state changes). */
  harrowed: boolean;
  /** Crop instances of this strip that can be cut (ripe or being reaped/mown), in the current crop meshes. */
  cut: CutInstance[] | null;
  /** Metres along up to which `cut` is hidden. */
  cutAt: number;
}

interface CutInstance { mesh: THREE.InstancedMesh; index: number; along: number; m: Float32Array; hidden: boolean }

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
/** Result looks shared by the CPU (strip states) and the shader (tasks' done side) so a finished task never jumps. */
const HARVESTED = 0xbea468, STUBBLE = 0xb2985f, SWATH = 0xd9b35a, SOWN_TINT = 0x6f9a3e, MOWN = 0xa6b866, WINDROW = 0xc8bf72;
const PLOUGHED_K = 0.78, HARROWED_K = 0.88, SOWN_K = 0.95;

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

const FIELD_GLSL = /* glsl */`
uniform float uSnowCover;
uniform float uWetness;
uniform vec3 uFieldCol;
uniform vec3 uSownCol;
uniform vec3 uHarvCol;
uniform vec3 uStubCol;
uniform vec3 uSwathCol;
uniform vec3 uMownCol;
uniform vec3 uRowCol;
varying vec4 vField;
varying vec4 vWork;
varying vec3 vFWorld;
float fHash(vec2 p) { p = fract(p * vec2(233.34, 851.73)); p += dot(p, p + 23.45); return fract(p.x * p.y); }
float fNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 w = f * f * (3.0 - 2.0 * f);
  return mix(mix(fHash(i), fHash(i + vec2(1.0, 0.0)), w.x), mix(fHash(i + vec2(0.0, 1.0)), fHash(i + vec2(1.0, 1.0)), w.x), w.y);
}
// the look a task leaves behind (must match FieldSystem.stripLook for the resulting state)
void doneLook(float task, float vary, inout vec3 col, inout float fur, inout float rows, inout float pat) {
  if (task < 0.5) return;
  if (task < 1.5) { col = uFieldCol * ${PLOUGHED_K.toFixed(2)} * vary; fur = 0.85; rows = 0.0; pat = 0.0; }
  else if (task < 2.5) { col = uFieldCol * ${HARROWED_K.toFixed(2)} * vary; fur = 0.3; rows = 0.0; pat = ${PAT_TILTH}.0; }
  else if (task < 3.5) { col = uSownCol * vary; fur = 0.22; rows = 0.85; pat = 0.0; }
  else if (task < 4.5) { pat = 0.0; }
  else if (task < 5.5) { col = uHarvCol * vary; fur = 0.25; rows = 0.4; pat = ${PAT_SWATHES}.0; }
  else if (task < 6.5) { col = uMownCol * vary; fur = 0.05; rows = 0.0; pat = 2.0; }
  else if (task < 7.5) { col = uStubCol * vary; fur = 0.2; rows = 0.5; pat = 0.0; }
}
vec3 fieldLook(vec3 col, float fur, float rows, float pat, float aa) {
  float furrow = sin(vField.x * 6.2831853 / 0.9);
  col *= 1.0 - fur * 0.32 * (0.5 + 0.5 * furrow) * aa;
  float rowsP = smoothstep(0.2, 0.9, sin(vField.x * 6.2831853 / 0.75) * 0.5 + 0.5);
  col *= 1.0 + rows * (rowsP - 0.5) * 0.25 * aa;
  if (pat > 0.5) {
    vec2 q = vFWorld.xz;
    if (pat < 1.5) {
      // swathes of cut corn lying in rows behind the reapers
      float s = sin(vField.x * 6.2831853 / 1.6 + fNoise(q * 0.5) * 2.0);
      float sw = smoothstep(0.25, 0.85, s) * (0.6 + 0.4 * fNoise(q * 2.3));
      col = mix(col, uSwathCol, sw * 0.8);
    } else if (pat < 2.5) {
      // mown grass with the hay raked into windrows
      float s = sin(vField.x * 6.2831853 / 3.2 + fNoise(q * 0.4) * 1.5);
      col = mix(col, uRowCol, smoothstep(0.55, 0.95, s) * 0.85);
    } else if (pat < 3.5) {
      // weeds coming up between the rows: thistle, charlock and the odd poppy
      float n = fNoise(q * 2.7), n2 = fNoise(q * 6.1 + 3.7);
      float fleck = smoothstep(0.7, 0.8, n) * smoothstep(0.35, 0.5, n2);
      col = mix(col, n2 > 0.82 ? vec3(0.55, 0.06, 0.04) : n2 > 0.66 ? vec3(0.62, 0.55, 0.08) : vec3(0.14, 0.3, 0.06), fleck * 0.85 * aa);
    } else {
      // harrowed: an even, fine crumb
      col *= 0.94 + 0.12 * fNoise(q * 7.0);
    }
  }
  return col;
}
`;

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
  /** Strips whose drawn work is gliding towards a new value. */
  private readonly gliding = new Set<StripGeom>();
  private readonly zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
  private readonly tmpM = new THREE.Matrix4();
  /** Crop meshes whose whole instance buffer waits for upload (cleared when drawn). */
  private readonly fullPending = new Set<THREE.InstancedMesh>();
  cropInstances = 0;
  /** Strips with a task under way (for stats/tests). */
  workingStrips = 0;

  constructor(private readonly world: WorldModel, private readonly assets: AssetLibrary, terrainU: TerrainUniforms, private settings: FieldSettings) {
    this.root.name = 'fields';
    this.fieldColor = new THREE.Color(assets.palette.ground[Ground.Field]);
    this.grassColor = new THREE.Color(assets.palette.ground[Ground.Grass]);
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 });
    this.material.name = 'strips';
    const sownCol = this.fieldColor.clone().multiplyScalar(SOWN_K).lerp(new THREE.Color(SOWN_TINT), 0.1);
    const uniforms = {
      uFieldCol: { value: this.fieldColor.clone() },
      uSownCol: { value: sownCol },
      uHarvCol: { value: new THREE.Color(HARVESTED) },
      uStubCol: { value: new THREE.Color(STUBBLE) },
      uSwathCol: { value: new THREE.Color(SWATH) },
      uMownCol: { value: new THREE.Color(MOWN) },
      uRowCol: { value: new THREE.Color(WINDROW) },
    };
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, { uSnowCover: terrainU.uSnowCover, uWetness: terrainU.uWetness }, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
attribute vec4 aField;
attribute vec4 aWork;
varying vec4 vField;
varying vec4 vWork;
varying vec3 vFWorld;`)
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
vField = aField;
vWork = aWork;
vFWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
${FIELD_GLSL}`)
        .replace('#include <color_fragment>', `#include <color_fragment>
float mlFur = 0.0;
float mlAA = 0.0;
{
  // furrows run along the strip (across coordinate in metres = vField.x); work runs along it (vField.y)
  float fw = fwidth(vField.x * 1.111);
  float aa = clamp(1.0 - fw * 1.5, 0.0, 1.0);
  mlAA = aa;
  vec3 dCol = diffuseColor.rgb;
  float dFur = vField.z, dRows = vField.w, dPat = vWork.w;
  doneLook(vWork.y, vWork.z, dCol, dFur, dRows, dPat);
  float bw = fwidth(vField.y) * 0.75 + 0.03;
  float done = vWork.y > 0.5 ? 1.0 - smoothstep(vWork.x - bw, vWork.x + bw, vField.y) : 0.0;
  vec3 col = mix(fieldLook(diffuseColor.rgb, vField.z, vField.w, vWork.w, aa), fieldLook(dCol, dFur, dRows, dPat, aa), done);
  mlFur = mix(vField.z, dFur, done);
  if (vWork.y > 0.5 && vWork.y < 7.5 && vWork.x > 0.02) {
    // the working front: freshly turned or cut ground just behind the boundary
    float d = vWork.x - vField.y;
    float front = smoothstep(-0.05, 0.12, d) * (1.0 - smoothstep(0.25, 1.1, d));
    col *= 1.0 - 0.22 * front;
  }
  float n = fNoise(vFWorld.xz * 0.35) * 0.6 + fNoise(vFWorld.xz * 1.3) * 0.4;
  col *= 0.93 + n * 0.14;
  float furrow = sin(vField.x * 6.2831853 / 0.9);
  float snow = smoothstep(1.0 - uSnowCover, 1.0 - uSnowCover + 0.25, n * 0.5 + 0.5 - furrow * 0.12);
  col = mix(col, vec3(0.86, 0.9, 0.95), clamp(snow * smoothstep(0.0, 0.2, uSnowCover), 0.0, 1.0));
  col *= 1.0 - uWetness * 0.25 * (1.0 - snow);
  diffuseColor.rgb = col;
}`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  // furrow ridges catch the light: bump the normal across the strip (surface gradient from screen derivatives)
  float k = 6.2831853 / 0.9;
  float dh = mlFur * 0.05 * mlAA * k * cos(vField.x * k);
  vec2 dHdxy = vec2(dh * dFdx(vField.x), dh * dFdy(vField.x));
  vec3 sx = dFdx(-vViewPosition), sy = dFdy(-vViewPosition);
  vec3 r1 = cross(sy, normal), r2 = cross(normal, sx);
  float det = dot(sx, r1);
  vec3 grad = sign(det) * (dHdxy.x * r1 + dHdxy.y * r2);
  normal = normalize(abs(det) * normal - grad);
}`);
    };
    this.material.customProgramCacheKey = () => 'millennia-strips-2';
  }

  configure(s: FieldSettings): void { this.settings = s; this.cropsDirty = true; }

  private tileKey(x: number, z: number): number { return Math.floor(z / TILE) * 64 + Math.floor(x / TILE); }

  /** Strip frames and states only; tile geometry is built lazily near the camera. */
  private buildIndex(list: readonly StripView[]): void {
    for (const t of this.tiles.values()) this.dropTile(t);
    this.tiles.clear();
    this.strips.clear();
    this.gliding.clear();
    for (const sv of list) {
      if (sv.poly.length < 4) continue;
      const p = sv.poly.slice(0, 4).map((q) => new THREE.Vector2(q.x, q.z));
      const e0 = p[1].distanceTo(p[0]), e1 = p[3].distanceTo(p[0]);
      const longIsV = e1 >= e0;
      const width = longIsV ? e0 : e1, length = longIsV ? e1 : e0;
      const cx = (p[0].x + p[1].x + p[2].x + p[3].x) / 4, cz = (p[0].y + p[1].y + p[2].y + p[3].y) / 4;
      const work = sv.task ? clamp(sv.work ?? 0, 0, 1) : 0;
      const g: StripGeom = {
        id: sv.id, tile: this.tileKey(cx, cz), start: 0, count: 0, p, longIsV, width, length,
        cx, cz, radius: Math.hypot(width, length) / 2, state: sv.state, crop: sv.crop, growth: sv.growth,
        vary: 0.94 + hash01(sv.id, 3) * 0.12, task: sv.task ?? null, work, shown: work, from: work, glide: 1,
        harrowed: false, cut: null, cutAt: 0,
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
    const pos = new Float32Array(verts * 3), col = new Float32Array(verts * 3), fld = new Float32Array(verts * 4), wrk = new Float32Array(verts * 4);
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
    geo.setAttribute('aWork', new THREE.BufferAttribute(wrk, 4));
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

  /** The strip's own look (before any task under way): colour, furrow and row strength, surface pattern. */
  private stripLook(g: StripGeom, c: THREE.Color): { furrow: number; rows: number; pattern: number } {
    const field = this.fieldColor, grass = this.grassColor;
    let furrow = 0.15, rows = 0, pattern = 0;
    switch (g.state) {
      case 'bare': c.copy(field).multiplyScalar(1.05); furrow = 0.1; break;
      case 'ploughed':
        if (g.harrowed) { c.copy(field).multiplyScalar(HARROWED_K); furrow = 0.3; pattern = PAT_TILTH; }
        else { c.copy(field).multiplyScalar(PLOUGHED_K); furrow = 0.85; }
        break;
      case 'sown': c.copy(field).multiplyScalar(SOWN_K).lerp(this.tmpC.setHex(SOWN_TINT), 0.1); furrow = 0.22; rows = 0.85; break;
      case 'growing': {
        const t = clamp(g.growth, 0, 1);
        c.copy(field).multiplyScalar(0.85).lerp(lerpHex(CROP_GREEN[g.crop], CROP_RIPE[g.crop], Math.max(0, t - 0.6) * 1.6, this.tmpC), 0.3 + t * 0.65);
        furrow = 0.5 * (1 - t); rows = 0.6 * t + 0.2;
        if (g.task === 'weed') pattern = PAT_WEEDY;
        break;
      }
      case 'ripe': c.setHex(CROP_RIPE[g.crop]); rows = 0.5; furrow = 0; break;
      case 'harvested': c.setHex(HARVESTED); furrow = 0.25; rows = 0.4; pattern = PAT_SWATHES; break;
      case 'stubble': c.setHex(STUBBLE); furrow = 0.2; rows = 0.5; break;
      case 'fallow': c.copy(grass).lerp(field, 0.35).multiplyScalar(0.95); furrow = 0.05; break;
    }
    c.multiplyScalar(g.vary);
    return { furrow, rows, pattern };
  }

  /** Write one strip's look and work into its vertex range (and flag the range for upload). */
  private writeStrip(t: Tile, g: StripGeom, upload: boolean): void {
    const geo = t.geo;
    if (!geo) return;
    const col = geo.getAttribute('color') as THREE.BufferAttribute;
    const fld = geo.getAttribute('aField') as THREE.BufferAttribute;
    const wrk = geo.getAttribute('aWork') as THREE.BufferAttribute;
    const c = this.tmpC2;
    const { furrow, rows, pattern } = this.stripLook(g, c);
    const code = g.task ? TASK_CODE[g.task] : 0;
    const boundary = g.task ? g.shown * g.length : 0;
    const ca = col.array as Float32Array, fa = fld.array as Float32Array, wa = wrk.array as Float32Array;
    for (let v = g.start; v < g.start + g.count; v++) {
      ca[v * 3] = c.r; ca[v * 3 + 1] = c.g; ca[v * 3 + 2] = c.b;
      fa[v * 4 + 2] = furrow; fa[v * 4 + 3] = rows;
      wa[v * 4] = boundary; wa[v * 4 + 1] = code; wa[v * 4 + 2] = g.vary; wa[v * 4 + 3] = pattern;
    }
    if (upload) {
      col.addUpdateRange(g.start * 3, g.count * 3);
      fld.addUpdateRange(g.start * 4, g.count * 4);
      wrk.addUpdateRange(g.start * 4, g.count * 4);
    }
    col.needsUpdate = true;
    fld.needsUpdate = true;
    wrk.needsUpdate = true;
  }

  /** Only the drawn work boundary of one strip (gliding). */
  private writeBoundary(g: StripGeom): void {
    const t = this.tiles.get(g.tile);
    const geo = t?.geo;
    if (!geo) return;
    const wrk = geo.getAttribute('aWork') as THREE.BufferAttribute;
    const wa = wrk.array as Float32Array;
    const boundary = g.task ? g.shown * g.length : 0;
    for (let v = g.start; v < g.start + g.count; v++) wa[v * 4] = boundary;
    wrk.addUpdateRange(g.start * 4, g.count * 4);
    wrk.needsUpdate = true;
  }

  private colorTile(t: Tile): void {
    if (!t.geo) return;
    for (const g of t.strips) this.writeStrip(t, g, false);
  }

  /** Compare the view with what is drawn; restyle changed strips, start glides, flag crop rebuilds. */
  private recolor(list: readonly StripView[]): void {
    let working = 0;
    for (const sv of list) {
      const g = this.strips.get(sv.id);
      if (!g) continue;
      const task = sv.task ?? null;
      const work = task ? clamp(sv.work ?? 0, 0, 1) : 0;
      if (task) working++;
      const stateChanged = g.state !== sv.state || g.crop !== sv.crop || Math.abs(g.growth - sv.growth) >= 1e-3;
      const taskChanged = g.task !== task;
      if (!stateChanged && !taskChanged && Math.abs(g.work - work) < 1e-4) continue;
      const stageBefore = this.cropKey(g);
      if (stateChanged && g.state !== sv.state) g.harrowed = false;
      // a finished harrowing leaves the strip 'ploughed' in the sim: keep its fine tilth on screen
      if (taskChanged && g.task === 'harrow' && g.work > 0.95 && sv.state === 'ploughed') g.harrowed = true;
      g.state = sv.state; g.crop = sv.crop; g.growth = sv.growth;
      if (taskChanged) {
        g.task = task;
        g.work = work;
        // a new task starts from the strip's first edge and glides to its first bout's progress
        g.shown = 0;
        g.from = 0;
        g.glide = task && work > 0 ? 0 : 1;
        if (g.glide < 1) this.gliding.add(g); else this.gliding.delete(g);
        // reaping or mowing needs the strip's plants registered for cutting; a cleared task leaves the rebuild to restore them
        if ((task && CUTTING.has(task) && !g.cut) || (!task && g.cut)) this.cropsDirty = true;
      } else if (Math.abs(g.work - work) >= 1e-4) {
        g.from = g.shown;
        g.work = work;
        g.glide = 0;
        this.gliding.add(g);
      }
      if (stateChanged && stageBefore !== this.cropKey(g)) this.cropsDirty = true;
      const t = this.tiles.get(g.tile);
      if (t?.geo) this.writeStrip(t, g, true);
    }
    this.workingStrips = working;
  }

  /** Which crop instances a strip shows ('' = none). */
  private cropKey(g: StripGeom): string {
    if (g.state !== 'sown' && g.state !== 'growing' && g.state !== 'ripe') return '';
    return `${g.crop}:${this.stage(g)}`;
  }

  /** Advance gliding work boundaries (eased) and cut plants behind them. */
  private stepGlides(dt: number): void {
    if (!this.gliding.size) return;
    for (const g of [...this.gliding]) {
      g.glide = Math.min(1, g.glide + dt / WORK_GLIDE_S);
      const e = 1 - Math.pow(1 - g.glide, 3);
      g.shown = g.from + (g.work - g.from) * e;
      this.writeBoundary(g);
      if (g.cut) this.applyCut(g);
      if (g.glide >= 1) this.gliding.delete(g);
    }
  }

  /** Hide (or restore) a strip's cuttable plants behind the drawn boundary. */
  private applyCut(g: StripGeom): void {
    if (!g.cut) return;
    const at = g.task && CUTTING.has(g.task) ? g.shown * g.length : 0;
    if (Math.abs(at - g.cutAt) < 1e-3) return;
    g.cutAt = at;
    const touched = new Map<THREE.InstancedMesh, [number, number]>();
    for (const ci of g.cut) {
      const hide = ci.along < at;
      if (hide === ci.hidden) continue;
      ci.hidden = hide;
      if (hide) ci.mesh.setMatrixAt(ci.index, this.zeroMatrix);
      else ci.mesh.setMatrixAt(ci.index, this.tmpM.fromArray(ci.m));
      const r = touched.get(ci.mesh);
      if (r) { r[0] = Math.min(r[0], ci.index); r[1] = Math.max(r[1], ci.index); } else touched.set(ci.mesh, [ci.index, ci.index]);
    }
    for (const [mesh, [a, b]] of touched) {
      // a whole-buffer upload still pending (new instances not yet drawn) must not shrink to a range
      if (!this.fullPending.has(mesh)) mesh.instanceMatrix.addUpdateRange(a * 16, (b - a + 1) * 16);
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  update(list: readonly StripView[], version: number, camera: THREE.Camera, budgetMs: number, dt = 0): number {
    const t0 = performance.now();
    this.lastList = list;
    if (version !== this.version) {
      const sameSet = list.length === this.strips.size && list.every((s) => this.strips.has(s.id));
      if (!sameSet) { this.buildIndex(list); this.cropsDirty = true; }
      this.recolor(list);
      this.version = version;
    }
    this.stepGlides(dt);
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
    for (let i = 0; i < 200 && (this.cropJob || this.pendingTiles > 0 || this.gliding.size > 0); i++) {
      this.update(this.lastList, this.version, camera, 1000, WORK_GLIDE_S);
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
      // plants already cut by a task under way are not gathered at all
      const cutAt = g.task && CUTTING.has(g.task) ? g.shown * g.length : -1;
      for (let r = 0; r < rowsN; r++) {
        const u = (r + 0.5) / rowsN;
        for (let k = 0; k < plantsN; k++) {
          if (job.total >= max) break;
          const w = (k + 0.5) / plantsN;
          if (w * g.length < cutAt) continue;
          const h = hash01(g.id * 7919 + r, k);
          const x = (a.x * (1 - u) + b.x * u) * (1 - w) + (d.x * (1 - u) + c.x * u) * w + (h - 0.5) * 0.18;
          const z = (a.y * (1 - u) + b.y * u) * (1 - w) + (d.y * (1 - u) + c.y * u) * w + (hash01(h * 1e6, 2) - 0.5) * 0.18;
          const dist = Math.hypot(x - job.cx, z - job.cz);
          if (dist > R) continue;
          // thin out with distance
          if (dist > R * 0.45 && h > 1.25 - dist / R) continue;
          const y = this.world.heightAt(x, z) + 0.02;
          arr.push(x, y, z, h * 6.283, 0.85 + hash01(h * 1e6, 3) * 0.3, g.id, w * g.length);
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
    // strips whose plants can be cut (ripe, or a reap/mow under way) keep a list of their instances
    for (const g of this.strips.values()) { g.cut = null; g.cutAt = 0; }
    const cutLists = new Map<number, CutInstance[]>();
    for (const g of job.order) if (g.state === 'ripe' || (g.task && CUTTING.has(g.task))) cutLists.set(g.id, []);
    // keep within the triangle budget: instances were gathered nearest strip first, so trimming
    // each list's tail drops the farthest plants
    let tris = 0;
    for (const [key, arr] of job.buf) {
      const g = this.kit(key).geometry;
      tris += (arr.length / CI) * ((g.index ? g.index.count : g.getAttribute('position').count) / 3);
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
        mesh.onBeforeRender = () => { this.fullPending.delete(mesh!); };
        pool.set(key, mesh);
        this.root.add(mesh);
      }
      return mesh;
    };
    // where each cuttable strip's boundary is now (the gather may have run over several frames)
    const cutAt = new Map<number, number>();
    for (const id of cutLists.keys()) {
      const g = this.strips.get(id)!;
      cutAt.set(id, g.task && CUTTING.has(g.task) ? g.shown * g.length : 0);
    }
    const near2 = CROP_SHADOW_DIST * CROP_SHADOW_DIST;
    for (const [key, arr] of job.buf) {
      const n = Math.floor((arr.length / CI) * keep);
      const tall = Number(key.split(':')[1]) >= 2;
      let nNear = 0;
      if (tall) for (let i = 0; i < n; i++) if ((arr[i * CI] - job.cx) ** 2 + (arr[i * CI + 2] - job.cz) ** 2 < near2) nNear++;
      const far = mk(key, Math.max(1, n - nNear), false);
      const nearMesh = tall ? mk(key, Math.max(1, nNear), true) : null;
      let iFar = 0, iNear = 0;
      for (let i = 0; i < n; i++) {
        const o = i * CI;
        q.setFromAxisAngle(y, arr[o + 3]);
        const sc = arr[o + 4];
        m.compose(p.set(arr[o], arr[o + 1], arr[o + 2]), q, s.set(sc, sc, sc));
        const isNear = tall && (arr[o] - job.cx) ** 2 + (arr[o + 2] - job.cz) ** 2 < near2;
        const mesh = isNear ? nearMesh! : far;
        const index = isNear ? iNear++ : iFar++;
        const list = cutLists.get(arr[o + 5]);
        const hidden = !!list && arr[o + 6] < (cutAt.get(arr[o + 5]) ?? 0);
        mesh.setMatrixAt(index, hidden ? this.zeroMatrix : m);
        if (list) list.push({ mesh, index, along: arr[o + 6], m: new Float32Array(m.elements), hidden });
      }
      far.count = iFar;
      far.instanceMatrix.clearUpdateRanges();
      far.instanceMatrix.needsUpdate = true;
      this.fullPending.add(far);
      if (nearMesh) {
        nearMesh.count = iNear;
        nearMesh.instanceMatrix.clearUpdateRanges();
        nearMesh.instanceMatrix.needsUpdate = true;
        this.fullPending.add(nearMesh);
      } else { const sm = this.cropShadowMeshes.get(key); if (sm) sm.count = 0; }
      total += n;
    }
    for (const [id, list] of cutLists) {
      const g = this.strips.get(id);
      if (!g || !list.length) continue;
      g.cut = list;
      g.cutAt = cutAt.get(id) ?? 0;
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
