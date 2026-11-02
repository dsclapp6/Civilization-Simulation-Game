// Deposits in the world (docs/CIV.md §7; world.deposits): what lies in the ground shows on it. Iron as rust-stained
// outcrops on a reddened slope, stone as pale outcrops with a worked face and squared blocks, clay as ochre wet banks
// with puddles by the water, salt as a white crust of plates on the flats, silver as blue-grey veined rock, gold as a
// gravel bar on the stream bank with glints that catch the sun. Each deposit near the camera gets its own geometry
// (asset kit pieces placed on the terrain, a draped ground stain), built once and kept while it stays within range:
// full detail within NEAR m, the bigger pieces only within FAR m, nothing beyond (deposits are tens of metres across).
// Pieces keep clear of buildings (a mine or quarry raised on the deposit), roads, fields and water; a deposit is rebuilt
// when a building near it comes or goes. ≤ 3 draw calls per deposit in view, typically 0–4 deposits.
import * as THREE from 'three';
import { BUILDINGS } from '../content/types';
import type { BuildingView } from '../core/view';
import { Mat, MeshBuilder } from '../assets/core/builder';
import { DEPOSIT_STAIN, depositPieceInto, puddleInto, type DepositKindId } from '../assets/deposits';
import type { AssetLibrary } from '../assets/types';
import { Ground, type Deposit, type WorldModel } from '../world/types';

const NEAR = 280, FAR = 750, DROP = 900;

const SPARK_VERT = /* glsl */`
attribute float aPhase;
uniform float uTime;
uniform float uSun;
uniform float uScale;
varying float vI;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // a glint flashes when the sun catches the grain: short sharp peaks at random moments
  float t = fract(uTime * (0.35 + fract(aPhase * 7.13) * 0.4) + aPhase);
  vI = pow(max(0.0, 1.0 - abs(t - 0.5) * 9.0), 2.0) * uSun;
  gl_PointSize = clamp(uScale * (0.6 + vI) / max(1.0, -mv.z), 1.5, 22.0);
  gl_Position = projectionMatrix * mv;
}`;
const SPARK_FRAG = /* glsl */`
varying float vI;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  // a four-pointed star
  float star = max(0.0, 1.0 - (abs(p.x) * 9.0 + abs(p.y) * 1.4)) + max(0.0, 1.0 - (abs(p.y) * 9.0 + abs(p.x) * 1.4));
  float core = max(0.0, 1.0 - length(p) * 5.0);
  float a = clamp((star * 0.7 + core) * vI, 0.0, 1.0);
  if (a < 0.02) discard;
  gl_FragColor = vec4(vec3(1.0, 0.86, 0.45) * a * 1.6, a);
}`;

interface Built { group: THREE.Group; lod: 0 | 1; bkey: string; geos: THREE.BufferGeometry[] }

/** Deterministic hash in [0,1). */
function h01(a: number, b: number, c = 0): number {
  let x = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x9e37, 0x165667b1) ^ Math.imul((c | 0) + 7, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d);
  x = Math.imul(x ^ (x >>> 12), 0x297a2d39);
  return ((x ^ (x >>> 15)) >>> 0) / 4294967296;
}

export class DepositSystem {
  readonly root = new THREE.Group();
  private readonly list: readonly Deposit[];
  private readonly built = new Map<number, Built>();
  private readonly opaque: THREE.Material;
  private readonly water: THREE.Material;
  private readonly stainMat: THREE.MeshLambertMaterial;
  private readonly sparkMat: THREE.ShaderMaterial;
  private readonly owned: THREE.Material[] = [];
  private lastEval = new THREE.Vector3(Infinity, 0, 0);
  private frame = 0;
  private buildingsVer = -1;
  private buildings: readonly BuildingView[] = [];
  /** Deposits drawn now (stats/tests) and geometry builds so far. */
  drawn = 0;
  builds = 0;

  constructor(private readonly world: WorldModel, assets: AssetLibrary, private readonly heightAt: (x: number, z: number) => number) {
    this.root.name = 'deposits';
    this.list = world.deposits ?? [];
    const shared = assets.sharedMaterials?.();
    if (shared) { this.opaque = shared.opaque; this.water = shared.water; }
    else {
      this.opaque = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9, metalness: 0 });
      this.water = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.15, metalness: 0 });
      this.owned.push(this.opaque, this.water);
    }
    this.stainMat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 });
    this.stainMat.name = 'deposit-stain';
    this.sparkMat = new THREE.ShaderMaterial({
      vertexShader: SPARK_VERT, fragmentShader: SPARK_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uSun: { value: 1 }, uScale: { value: 420 } }, fog: false, toneMapped: false,
    });
    this.owned.push(this.stainMat, this.sparkMat);
  }

  /** Called each frame: (re)build what came into range, drop what left, animate the glints. */
  update(camera: THREE.Camera, buildings: readonly BuildingView[], buildingsVersion: number, time: number, sun: number, show: boolean): void {
    this.frame++;
    this.sparkMat.uniforms.uTime.value = time;
    this.sparkMat.uniforms.uSun.value = sun;
    this.root.visible = show;
    if (!this.list.length) return;
    const cp = camera.position;
    const bchanged = buildingsVersion !== this.buildingsVer;
    if (bchanged) { this.buildingsVer = buildingsVersion; this.buildings = buildings; }
    if (!bchanged && cp.distanceToSquared(this.lastEval) < 30 * 30 && this.frame % 30 !== 0) return;
    this.lastEval.copy(cp);
    let n = 0;
    for (const d of this.list) {
      const dist = Math.hypot(d.x - cp.x, d.z - cp.z, Math.max(0, cp.y - this.heightAt(d.x, d.z)) * 0.6);
      const b = this.built.get(d.id);
      if (dist > (b ? DROP : FAR) || !show) {
        if (b) this.drop(d.id, b);
        continue;
      }
      const lod: 0 | 1 = dist < (b?.lod === 0 ? NEAR * 1.15 : NEAR) ? 0 : 1;
      const bkey = this.nearbyBuildings(d);
      if (!b || b.lod !== lod || b.bkey !== bkey) {
        if (b) this.drop(d.id, b);
        this.build(d, lod, bkey);
      }
      n++;
    }
    this.drawn = n;
  }

  /** Ids of buildings standing on or by the deposit (a rebuild key). */
  private nearbyBuildings(d: Deposit): string {
    let key = '';
    for (const bv of this.buildings) {
      if (Math.abs(bv.x - d.x) > d.radius + 30 || Math.abs(bv.z - d.z) > d.radius + 30) continue;
      key += `${bv.id},`;
    }
    return key;
  }

  /** Is a spot fit for a piece: dry, not a road, field or yard, clear of buildings? */
  private free(x: number, z: number, r: number): boolean {
    const W = this.world.size;
    if (x < 1 || z < 1 || x > W - 1 || z > W - 1) return false;
    if (this.world.waterSurfaceAt(x, z) !== null) return false;
    const gr = this.world.groundAt(x, z);
    if (gr === Ground.Road || gr === Ground.Path || gr === Ground.Field || gr === Ground.Cobbles || gr === Ground.Yard) return false;
    for (const bv of this.buildings) {
      const def = BUILDINGS[bv.kind];
      const br = Math.max(def.w, def.d) / 2 + 1.5 + r;
      if (Math.abs(bv.x - x) < br && Math.abs(bv.z - z) < br && Math.hypot(bv.x - x, bv.z - z) < br) return false;
    }
    return true;
  }

  /** Unit direction from the deposit to the nearest water within `range`, or null. */
  private waterDir(d: Deposit, range: number): { x: number; z: number } | null {
    for (let r = 6; r <= range; r += 6) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        if (this.world.waterSurfaceAt(d.x + Math.cos(a) * r, d.z + Math.sin(a) * r) !== null) return { x: Math.cos(a), z: Math.sin(a) };
      }
    }
    return null;
  }

  private build(d: Deposit, lod: 0 | 1, bkey: string): void {
    this.builds++;
    const kind = d.kind as DepositKindId;
    const b = new MeshBuilder(d.id + 11);
    const R = d.radius;
    const sparks: number[] = [], phases: number[] = [];
    const place = (x: number, z: number, s: number, seed: number, sink: number) => {
      // sit the piece on the lowest of its footprint so it never floats on a slope
      const y = Math.min(this.heightAt(x, z), this.heightAt(x + s * 0.4, z), this.heightAt(x - s * 0.4, z), this.heightAt(x, z + s * 0.4), this.heightAt(x, z - s * 0.4)) - sink;
      b.push(); b.translate(x, y, z); b.rotY(h01(seed, 3) * Math.PI * 2);
      depositPieceInto(b, kind, s, seed, lod);
      b.pop();
    };
    if (kind === 'iron' || kind === 'stone' || kind === 'silver') {
      // outcrops in two to four clusters round the working floor at the middle
      const clusters = 3 + Math.floor(h01(d.id, 1) * 3);
      for (let c = 0; c < clusters; c++) {
        const a = h01(d.id, 10 + c) * Math.PI * 2, r = R * (0.3 + h01(d.id, 20 + c) * 0.5);
        const cx = d.x + Math.cos(a) * r, cz = d.z + Math.sin(a) * r;
        const pieces = lod === 0 ? 4 + Math.floor(h01(d.id, 30 + c) * 4) : 2;
        for (let i = 0; i < pieces; i++) {
          const s = (i === 0 ? 4.6 : 1.4 + h01(d.id, 40 + c * 8 + i) * 2.2) * (kind === 'silver' ? 0.85 : 1) * (0.8 + d.richness * 0.4);
          const aa = h01(d.id, 50 + c * 8 + i) * Math.PI * 2, rr = i === 0 ? 0 : 2.2 + h01(d.id, 60 + c * 8 + i) * 4.5;
          const x = cx + Math.cos(aa) * rr, z = cz + Math.sin(aa) * rr;
          if (!this.free(x, z, s * 0.5)) continue;
          place(x, z, s, d.id * 131 + c * 17 + i, s * 0.12);
        }
      }
    } else if (kind === 'clay') {
      // banks along the water side (or round the middle when no water is near), puddles between them
      const wd = this.waterDir(d, R * 1.2);
      const n = lod === 0 ? 7 : 3;
      for (let i = 0; i < n; i++) {
        let x: number, z: number;
        if (wd) {
          const along = (h01(d.id, 70 + i) - 0.5) * R * 1.4, toward = R * (0.15 + h01(d.id, 80 + i) * 0.45);
          x = d.x + wd.x * toward - wd.z * along; z = d.z + wd.z * toward + wd.x * along;
        } else {
          const a = h01(d.id, 70 + i) * Math.PI * 2, r = R * (0.25 + h01(d.id, 80 + i) * 0.55);
          x = d.x + Math.cos(a) * r; z = d.z + Math.sin(a) * r;
        }
        const s = 2.5 + h01(d.id, 90 + i) * 3;
        if (!this.free(x, z, s * 0.5)) continue;
        place(x, z, s, d.id * 17 + i, 0.05);
        if (lod === 0 && i % 2 === 0 && this.free(x + 2.5, z + 1.5, 1)) {
          b.push(); b.translate(x + 2.4, this.heightAt(x + 2.4, z + 1.5), z + 1.5); puddleInto(b, 0.9 + h01(d.id, 95 + i), d.id + i); b.pop();
        }
      }
    } else if (kind === 'salt') {
      const n = lod === 0 ? 90 : 30;
      for (let i = 0; i < n; i++) {
        const a = h01(d.id, 100 + i) * Math.PI * 2, r = R * 0.85 * Math.sqrt(h01(d.id, 200 + i));
        const x = d.x + Math.cos(a) * r, z = d.z + Math.sin(a) * r;
        const s = 2.2 + h01(d.id, 300 + i) * 3.2;
        if (!this.free(x, z, s * 0.4)) continue;
        place(x, z, s, d.id * 7 + i, 0);
      }
    } else if (kind === 'gold') {
      // a gravel bar along the bank: patches strung along the stream, glints among them
      const wd = this.waterDir(d, R * 1.4) ?? { x: 1, z: 0 };
      const n = lod === 0 ? 22 : 8;
      for (let i = 0; i < n; i++) {
        const along = (i / Math.max(1, n - 1) - 0.5) * R * 1.6 + (h01(d.id, 400 + i) - 0.5) * 3, toward = R * (0.3 + h01(d.id, 410 + i) * 0.45);
        const x = d.x + wd.x * toward - wd.z * along, z = d.z + wd.z * toward + wd.x * along;
        if (!this.free(x, z, 1)) continue;
        place(x, z, 3.2, d.id * 5 + i, 0.02);
        for (let k = 0; k < (lod === 0 ? 4 : 1); k++) {
          const gx = x + (h01(i, k, 1) - 0.5) * 2, gz = z + (h01(i, k, 2) - 0.5) * 2;
          sparks.push(gx, this.heightAt(gx, gz) + 0.08, gz);
          phases.push(h01(d.id, i * 7 + k, 3));
        }
      }
    }
    const group = new THREE.Group();
    group.name = `deposit:${d.id}:${kind}`;
    const geos: THREE.BufferGeometry[] = [];
    const og = b.toGeometry({ mat: Mat.Opaque, surf: true, aoHeight: 0.5, aoStrength: 0.22 });
    if (og) { const m = new THREE.Mesh(og, this.opaque); m.castShadow = true; m.receiveShadow = true; group.add(m); geos.push(og); }
    const wg = b.toGeometry({ mat: Mat.Water, surf: true });
    if (wg) { const m = new THREE.Mesh(wg, this.water); m.receiveShadow = true; group.add(m); geos.push(wg); }
    const sg = this.stain(d, kind);
    group.add(new THREE.Mesh(sg, this.stainMat));
    geos.push(sg);
    if (sparks.length) {
      const pg = new THREE.BufferGeometry();
      pg.setAttribute('position', new THREE.Float32BufferAttribute(sparks, 3));
      pg.setAttribute('aPhase', new THREE.Float32BufferAttribute(phases, 1));
      const pts = new THREE.Points(pg, this.sparkMat);
      pts.frustumCulled = false;
      pts.renderOrder = 9;
      group.add(pts);
      geos.push(pg);
    }
    this.root.add(group);
    this.built.set(d.id, { group, lod, bkey, geos });
  }

  /** A disc of the kind's colour draped on the ground, strongest in the middle, its edge broken by noise. */
  private stain(d: Deposit, kind: DepositKindId): THREE.BufferGeometry {
    const { color, alpha } = DEPOSIT_STAIN[kind];
    const c = new THREE.Color(color);
    const rings = 7, segs = 28, R = d.radius * (kind === 'salt' ? 1.0 : 0.95);
    const pos: number[] = [], col: number[] = [], idx: number[] = [];
    for (let r = 0; r <= rings; r++) {
      for (let k = 0; k < (r === 0 ? 1 : segs); k++) {
        const a = (k / segs) * Math.PI * 2;
        const wob = 1 + (h01(d.id, k, r) - 0.5) * 0.35;
        const rr = (r / rings) * R * (r === rings ? wob : 1 + (h01(d.id, k + 50, r) - 0.5) * 0.15);
        const x = d.x + Math.cos(a) * rr, z = d.z + Math.sin(a) * rr;
        const dry = this.world.waterSurfaceAt(x, z) === null;
        pos.push(x, this.heightAt(x, z) + 0.06, z);
        const t = r / rings;
        const patch = 0.55 + 0.45 * h01(d.id, k * 3, r * 5);
        const a2 = dry ? alpha * (1 - t * t) * patch : 0;
        col.push(c.r, c.g, c.b, a2);
      }
    }
    // centre fan, then quads between rings
    for (let k = 0; k < segs; k++) idx.push(0, 1 + ((k + 1) % segs), 1 + k);
    for (let r = 1; r < rings; r++) {
      const a0 = 1 + (r - 1) * segs, a1 = 1 + r * segs;
      for (let k = 0; k < segs; k++) {
        const k1 = (k + 1) % segs;
        idx.push(a0 + k, a0 + k1, a1 + k1, a0 + k, a1 + k1, a1 + k);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
    g.setIndex(idx);
    g.computeVertexNormals();
    // the normals face up whatever the winding (draped decal)
    const nrm = g.getAttribute('normal');
    for (let i = 0; i < nrm.count; i++) if (nrm.getY(i) < 0) nrm.setXYZ(i, -nrm.getX(i), -nrm.getY(i), -nrm.getZ(i));
    return g;
  }

  private drop(id: number, b: Built): void {
    this.root.remove(b.group);
    for (const g of b.geos) g.dispose();
    this.built.delete(id);
  }

  /** Deposits whose geometry is built now (tests). */
  builtIds(): number[] { return [...this.built.keys()]; }

  dispose(): void {
    for (const [id, b] of [...this.built]) this.drop(id, b);
    for (const m of this.owned) m.dispose();
    this.root.clear();
  }
}
