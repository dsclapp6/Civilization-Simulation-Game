// Road ribbons: smooth, draped strips along world.roads near the camera with soft verges and
// faint wheel ruts, replacing the stair-stepped road colouring of fine terrain tiles (those tiles
// leave roads out; coarse distant tiles still paint them). Built per 512 m tile, time-sliced and
// cached; cut where a road crosses a bridge (the bridge deck carries it).
import * as THREE from 'three';
import { clamp, hash01 } from '../core/math';
import { Ground, type Road, type WorldModel } from '../world/types';
import type { Palette } from '../assets/types';

const TILE = 512;
/** Ribbons fade out over this camera-distance band (fine terrain tiles below ~2.5 m cover it). */
export const ROAD_FADE_START = 160;
export const ROAD_FADE_END = 230;
const FADE_START = ROAD_FADE_START;
const FADE_END = ROAD_FADE_END;
const STEP = 2.2;
const VERGE = 0.32;

interface Tile { key: number; mesh: THREE.Mesh | null; cx: number; cz: number; lastUsed: number }

export class RoadSystem {
  readonly root = new THREE.Group();
  private readonly material: THREE.MeshLambertMaterial;
  private readonly tiles = new Map<number, Tile>();
  /** road segment ids per tile: road index * 65536 + segment index */
  private readonly buckets = new Map<number, number[]>();
  private readonly queue: number[] = [];
  private frame = 0;
  private readonly roadColor: THREE.Color;
  private readonly pathColor: THREE.Color;
  private readonly cutCentres: { roadId: number; x: number; z: number; r: number }[];
  radius: number;

  /** Optional shared weather uniforms (terrain's), so roads take snow and rain like the ground. */
  weather: { uSnowCover: { value: number }; uWetness: { value: number } } = { uSnowCover: { value: 0 }, uWetness: { value: 0 } };

  constructor(private readonly world: WorldModel, palette: Palette, radius: number) {
    this.radius = radius;
    this.root.name = 'roads';
    this.roadColor = new THREE.Color(palette.ground[Ground.Road]).multiplyScalar(0.86);
    this.pathColor = new THREE.Color(palette.ground[Ground.Path]).multiplyScalar(0.86);
    this.cutCentres = world.bridges.map((b) => ({ roadId: b.roadId, x: b.x, z: b.z, r: b.length / 2 + 0.6 }));
    this.material = new THREE.MeshLambertMaterial({
      vertexColors: true, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -8,
    });
    this.material.name = 'roads';
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.weather);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 aRoad;\nvarying vec3 vRoad;\nvarying float vRoadFade;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRoad = aRoad;')
        // ribbons only where terrain tiles are fine enough to match their draping; beyond, the
        // terrain paints the road itself (render/terrain/nodeBuilder.ts)
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
vRoadFade = 1.0 - smoothstep(${FADE_START.toFixed(1)}, ${FADE_END.toFixed(1)}, distance((modelMatrix * vec4(transformed, 1.0)).xyz, cameraPosition));`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uSnowCover;\nuniform float uWetness;\nvarying vec3 vRoad;\nvarying float vRoadFade;')
        .replace('#include <color_fragment>', `#include <color_fragment>
{
  // vRoad.x: -1..1 across the carriageway, y: metres along, z: rut strength
  float a = abs(vRoad.x);
  float rut = smoothstep(0.13, 0.0, abs(a - 0.42)) * vRoad.z;
  float aa = clamp(1.0 - fwidth(vRoad.x) * 6.0, 0.0, 1.0);
  diffuseColor.rgb *= 1.0 - rut * 0.22 * aa;
  // trodden snow: whiter towards the verges, wheel ruts stay muddy
  float snowy = smoothstep(0.05, 0.6, uSnowCover) * (0.55 + 0.35 * smoothstep(0.2, 0.9, a)) * (1.0 - rut * 0.6);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.78, 0.8, 0.84), snowy);
  diffuseColor.rgb *= 1.0 - uWetness * 0.28 * (1.0 - snowy);
  diffuseColor.a *= vRoadFade;
}`);
    };
    this.material.customProgramCacheKey = () => 'millennia-roads';
    const roads = world.roads;
    for (let r = 0; r < roads.length; r++) {
      const pts = roads[r].points;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const pad = roads[r].width;
        for (let tz = Math.floor((Math.min(a.z, b.z) - pad) / TILE); tz <= Math.floor((Math.max(a.z, b.z) + pad) / TILE); tz++) {
          for (let tx = Math.floor((Math.min(a.x, b.x) - pad) / TILE); tx <= Math.floor((Math.max(a.x, b.x) + pad) / TILE); tx++) {
            const key = tz * 64 + tx;
            let list = this.buckets.get(key);
            if (!list) { list = []; this.buckets.set(key, list); }
            list.push(r * 65536 + i);
          }
        }
      }
    }
  }

  private cut(road: Road, x: number, z: number): boolean {
    for (const c of this.cutCentres) {
      if (c.roadId === road.id && Math.abs(c.x - x) < c.r && Math.abs(c.z - z) < c.r && Math.hypot(c.x - x, c.z - z) < c.r) return true;
    }
    return false;
  }

  private buildTile(key: number): THREE.Mesh | null {
    const segs = this.buckets.get(key);
    if (!segs) return null;
    const tx = key % 64, tz = Math.floor(key / 64);
    const x0 = tx * TILE, z0 = tz * TILE;
    const pos: number[] = [], col: number[] = [], road: number[] = [], idx: number[] = [];
    const c = new THREE.Color();
    // group consecutive segments of the same road so ribbons join smoothly
    const byRoad = new Map<number, number[]>();
    for (const s of segs) {
      const r = Math.floor(s / 65536);
      let l = byRoad.get(r);
      if (!l) { l = []; byRoad.set(r, l); }
      l.push(s % 65536);
    }
    for (const [ri, list] of byRoad) {
      const rd = this.world.roads[ri];
      if (rd.width < 1.2) continue;
      list.sort((a, b) => a - b);
      const hw = rd.width / 2;
      const base = rd.kind === 'path' || rd.kind === 'track' ? this.pathColor : this.roadColor;
      const ruts = rd.kind === 'path' ? 0.4 : rd.kind === 'track' ? 1 : 0.6;
      // runs of consecutive segments
      let run: number[] = [];
      const flush = () => {
        if (!run.length) return;
        const pts = rd.points;
        // sample the run with Catmull-Rom so curves are smooth at every LOD
        const samples: { x: number; z: number }[] = [];
        for (const si of run) {
          const p0 = pts[Math.max(0, si - 1)], p1 = pts[si], p2 = pts[si + 1], p3 = pts[Math.min(pts.length - 1, si + 2)];
          const len = Math.hypot(p2.x - p1.x, p2.z - p1.z);
          const n = Math.max(1, Math.ceil(len / STEP));
          for (let k = 0; k < n; k++) {
            const t = k / n, t2 = t * t, t3 = t2 * t;
            const cr = (a: number, b: number, cc: number, d: number) => 0.5 * (2 * b + (-a + cc) * t + (2 * a - 5 * b + 4 * cc - d) * t2 + (-a + 3 * b - 3 * cc + d) * t3);
            samples.push({ x: cr(p0.x, p1.x, p2.x, p3.x), z: cr(p0.z, p1.z, p2.z, p3.z) });
          }
        }
        const last = pts[run[run.length - 1] + 1];
        samples.push({ x: last.x, z: last.z });
        let along = 0;
        let prevKept = false;
        for (let k = 0; k < samples.length; k++) {
          const p = samples[k];
          const inside = p.x >= x0 - 4 && p.x <= x0 + TILE + 4 && p.z >= z0 - 4 && p.z <= z0 + TILE + 4;
          const keep = inside && !this.cut(rd, p.x, p.z);
          if (k > 0) along += Math.hypot(p.x - samples[k - 1].x, p.z - samples[k - 1].z);
          if (!keep) { prevKept = false; continue; }
          const a = samples[Math.max(0, k - 1)], b = samples[Math.min(samples.length - 1, k + 1)];
          let tdx = b.x - a.x, tdz = b.z - a.z;
          const tl = Math.hypot(tdx, tdz) || 1;
          tdx /= tl; tdz /= tl;
          const nx = -tdz, nz = tdx;
          const shade = 0.94 + hash01(Math.floor(p.x), Math.floor(p.z)) * 0.1;
          c.copy(base).multiplyScalar(shade);
          const v0 = pos.length / 3;
          // across: outer verge, edge, centre, edge, outer verge
          for (const u of [-1 - VERGE / hw, -1, 0, 1, 1 + VERGE / hw]) {
            const off = u * hw;
            const x = p.x + nx * off, z = p.z + nz * off;
            const y = this.world.heightAt(clamp(x, 0, this.world.size), clamp(z, 0, this.world.size)) + 0.05;
            pos.push(x, y, z);
            // soft verge: the outer vertices are transparent, so the edge fades into the grass
            col.push(c.r, c.g, c.b, Math.abs(u) > 1.001 ? 0 : 1);
            road.push(u, along, ruts);
          }
          if (prevKept) {
            for (let q = 0; q < 4; q++) {
              const a0 = v0 - 5 + q, a1 = a0 + 1, b0 = v0 + q, b1 = b0 + 1;
              idx.push(a0, b0, a1, a1, b0, b1);
            }
          }
          prevKept = true;
        }
      };
      for (const si of list) {
        if (run.length && si !== run[run.length - 1] + 1) { flush(); run = []; }
        run.push(si);
      }
      flush();
    }
    if (!idx.length) return null;
    // faces must point up
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
    g.setAttribute('aRoad', new THREE.Float32BufferAttribute(road, 3));
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], cc = idx[t + 2];
      const ux = pos[b * 3] - pos[a * 3], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
      const vx = pos[cc * 3] - pos[a * 3], vz = pos[cc * 3 + 2] - pos[a * 3 + 2];
      if (uz * vx - ux * vz < 0) { idx[t + 1] = cc; idx[t + 2] = b; }
    }
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, this.material);
    mesh.name = `roads:${tx}:${tz}`;
    mesh.receiveShadow = true;
    mesh.renderOrder = -1;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  update(camera: THREE.Camera, budgetMs: number): number {
    const t0 = performance.now();
    this.frame++;
    const cp = camera.position;
    const R = this.radius;
    const above = cp.y - Math.max(0, this.world.heightAt(clamp(cp.x, 0, this.world.size), clamp(cp.z, 0, this.world.size)));
    const want: { key: number; d: number }[] = [];
    if (above < R) {
      for (let tz = Math.floor((cp.z - R) / TILE); tz <= Math.floor((cp.z + R) / TILE); tz++) {
        for (let tx = Math.floor((cp.x - R) / TILE); tx <= Math.floor((cp.x + R) / TILE); tx++) {
          if (tx < 0 || tz < 0 || tx >= 64 || tz >= 64) continue;
          const dx = Math.max(tx * TILE - cp.x, 0, cp.x - (tx + 1) * TILE);
          const dz = Math.max(tz * TILE - cp.z, 0, cp.z - (tz + 1) * TILE);
          const d = Math.hypot(dx, dz);
          if (d > R) continue;
          const key = tz * 64 + tx;
          if (!this.buckets.has(key)) continue;
          want.push({ key, d });
        }
      }
    }
    const wanted = new Set(want.map((w) => w.key));
    for (const t of this.tiles.values()) {
      const vis = wanted.has(t.key);
      if (t.mesh) t.mesh.visible = vis;
      if (vis) t.lastUsed = this.frame;
    }
    want.sort((a, b) => a.d - b.d);
    for (const w of want) {
      if (this.tiles.has(w.key)) continue;
      if (performance.now() - t0 > budgetMs) break;
      const mesh = this.buildTile(w.key);
      if (mesh) { mesh.updateMatrixWorld(); this.root.add(mesh); }
      this.tiles.set(w.key, { key: w.key, mesh, cx: (w.key % 64 + 0.5) * TILE, cz: (Math.floor(w.key / 64) + 0.5) * TILE, lastUsed: this.frame });
    }
    // forget tiles long out of range
    if (this.tiles.size > 64) {
      for (const t of [...this.tiles.values()].sort((a, b) => a.lastUsed - b.lastUsed).slice(0, this.tiles.size - 48)) {
        if (t.lastUsed === this.frame) continue;
        if (t.mesh) { this.root.remove(t.mesh); t.mesh.geometry.dispose(); }
        this.tiles.delete(t.key);
      }
    }
    return performance.now() - t0;
  }

  get pending(): number {
    return this.queue.length;
  }

  dispose(): void {
    for (const t of this.tiles.values()) t.mesh?.geometry.dispose();
    this.tiles.clear();
    this.material.dispose();
    this.root.clear();
  }
}
