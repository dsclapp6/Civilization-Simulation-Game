// Streaming quadtree terrain: selects nodes around the camera, generates missing ones within a
// per-frame time budget (resumable jobs), caches them (LRU), and maintains a coverage mask so
// the macro far-terrain fills everything not covered by detailed nodes.
import * as THREE from 'three';
import { Simplex2 } from '../../core/noise';
import { Rng } from '../../core/rng';
import type { WorldModel } from '../../world/types';
import type { Palette } from '../../assets/types';
import { makeGroundStyle, type GroundStyle } from './groundStyle';
import { TerrainNodeJob } from './nodeBuilder';
import { HeightPyramid, QuadtreeSelector, keyI, keyJ, keyLevel, type QuadBoundsSource } from './quadtree';
import { createTerrainMaterial, createTerrainUniforms, type TerrainUniforms } from './terrainMaterial';
import { buildFarTerrainGeometry } from './farTerrain';

const NODE_RES = 32;
const MASK_RES = 256;

interface TerrainNode {
  key: number;
  level: number;
  x0: number;
  z0: number;
  size: number;
  group: THREE.Group;
  terrain: THREE.Mesh;
  water: THREE.Mesh | null;
  minY: number;
  maxY: number;
  lastUsed: number;
  visible: boolean;
}

export interface TerrainSettings {
  maxLevel: number;
  splitFactor: number;
  drawDistance: number;
  cacheNodes: number;
}

export class TerrainSystem implements QuadBoundsSource {
  readonly root = new THREE.Group();
  readonly uniforms: TerrainUniforms;
  readonly material: THREE.MeshLambertMaterial;
  readonly farMaterial: THREE.MeshLambertMaterial;
  readonly far: THREE.Mesh;
  readonly mask: THREE.DataTexture;
  private readonly maskData: Uint8Array;
  private readonly nodes = new Map<number, TerrainNode>();
  private readonly selector: QuadtreeSelector;
  private readonly pyramid: HeightPyramid;
  private readonly style: GroundStyle;
  private readonly noise: Simplex2;
  private job: { key: number; job: TerrainNodeJob } | null = null;
  private frame = 0;
  private renderSig = -1;
  private readonly box = new THREE.Box3();
  private readonly v1 = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();
  private readonly pb = { min: 0, max: 0 };
  private buildCount = 0;
  private buildTotal = 0;
  private buildMax = 0;
  drawn = 0;

  constructor(private readonly world: WorldModel, palette: Palette, public seaMaterial: THREE.Material, private settings: TerrainSettings) {
    this.root.name = 'terrain';
    this.style = makeGroundStyle(palette);
    this.noise = new Simplex2(new Rng(`terrain-colour:${world.seed}`));
    this.uniforms = createTerrainUniforms(world.size);
    this.maskData = new Uint8Array(MASK_RES * MASK_RES);
    this.mask = new THREE.DataTexture(this.maskData, MASK_RES, MASK_RES, THREE.RedFormat, THREE.UnsignedByteType);
    this.mask.magFilter = THREE.NearestFilter;
    this.mask.minFilter = THREE.NearestFilter;
    this.mask.generateMipmaps = false;
    this.mask.needsUpdate = true;
    this.uniforms.uMask.value = this.mask;
    this.material = createTerrainMaterial(this.uniforms, false);
    this.farMaterial = createTerrainMaterial(this.uniforms, true);
    this.selector = new QuadtreeSelector(world.size);
    this.pyramid = new HeightPyramid(world.macro.height, world.macro.res, world.size);
    const farGeo = buildFarTerrainGeometry(world, this.style, this.noise);
    this.far = new THREE.Mesh(farGeo, this.farMaterial);
    this.far.name = 'terrain-far';
    this.far.receiveShadow = true;
    this.far.frustumCulled = false;
    this.far.matrixAutoUpdate = false;
    this.root.add(this.far);
  }

  configure(settings: TerrainSettings): void {
    this.settings = settings;
  }

  // ---- QuadBoundsSource ----
  bounds(key: number, _level: number, x0: number, z0: number, size: number, out: { min: number; max: number }): void {
    const n = this.nodes.get(key);
    if (n) { out.min = n.minY; out.max = n.maxY; return; }
    this.pyramid.bounds(x0, z0, size, out);
  }
  isReady(key: number): boolean { return this.nodes.has(key); }

  /**
   * Select, show/hide and stream nodes. Returns ms spent generating.
   * @param budgetMs time allowed for generation this frame
   */
  update(camera: THREE.PerspectiveCamera, frustum: THREE.Frustum, budgetMs: number): number {
    this.frame++;
    const s = this.settings;
    const cp = camera.position;
    this.selector.select({
      camX: cp.x, camY: cp.y, camZ: cp.z,
      splitFactor: s.splitFactor, drawDistance: s.drawDistance, maxLevel: s.maxLevel,
    }, this);

    // visibility
    let sig = 0;
    for (const n of this.nodes.values()) n.visible = false;
    const render = this.selector.render;
    for (let k = 0; k < render.length; k++) {
      const n = this.nodes.get(render[k]);
      if (!n) continue;
      n.visible = true;
      n.lastUsed = this.frame;
      sig = (sig * 31 + (render[k] % 1000003)) % 2147483647;
    }
    let drawn = 0;
    for (const n of this.nodes.values()) {
      n.group.visible = n.visible;
      if (n.visible) drawn++;
    }
    this.drawn = drawn;
    sig = (sig + render.length * 7919) % 2147483647;
    if (sig !== this.renderSig) {
      this.renderSig = sig;
      this.rebuildMask();
    }

    // generation within budget
    const t0 = performance.now();
    const deadline = t0 + budgetMs;
    let guard = 0;
    while (performance.now() < deadline && guard++ < 64) {
      if (!this.job) {
        const key = this.pickNext(frustum);
        if (key < 0) break;
        const level = keyLevel(key), i = keyI(key), j = keyJ(key);
        const size = this.world.size / (1 << level);
        this.job = {
          key,
          job: new TerrainNodeJob({
            world: this.world, style: this.style, noise: this.noise,
            x0: i * size, z0: j * size, size, res: NODE_RES, seed: key % 1000003,
          }),
        };
      }
      if (this.job.job.step(deadline)) {
        this.finishJob();
      }
    }
    this.evict();
    return performance.now() - t0;
  }

  /** Generate everything currently wanted (loading screens / screenshots). */
  settle(camera: THREE.PerspectiveCamera, frustum: THREE.Frustum, maxMs: number): void {
    const t0 = performance.now();
    for (let it = 0; it < 64; it++) {
      this.update(camera, frustum, 200);
      if (this.selector.wanted.length === 0 && !this.job) break;
      if (performance.now() - t0 > maxMs) break;
    }
    this.update(camera, frustum, 0);
  }

  get pending(): number { return this.selector.wanted.length + (this.job ? 1 : 0); }
  get cached(): number { return this.nodes.size; }
  get avgBuildMs(): number { return this.buildCount ? this.buildTotal / this.buildCount : 0; }
  get maxBuildMs(): number { return this.buildMax; }

  private pickNext(frustum: THREE.Frustum): number {
    const wanted = this.selector.wanted, dist = this.selector.wantedDist;
    let best = -1, bestP = Infinity;
    for (let k = 0; k < wanted.length; k++) {
      const key = wanted[k];
      if (this.nodes.has(key)) continue;
      const level = keyLevel(key), size = this.world.size / (1 << level);
      const x0 = keyI(key) * size, z0 = keyJ(key) * size;
      this.pyramid.bounds(x0, z0, size, this.pb);
      this.box.set(this.v1.set(x0, this.pb.min, z0), this.v2.set(x0 + size, this.pb.max, z0 + size));
      const inView = frustum.intersectsBox(this.box);
      // prefer visible nodes and coarse fallbacks (they cover more ground per build)
      const p = (dist[k] + 20) * (inView ? 1 : 4) * (1 + level * 0.04);
      if (p < bestP) { bestP = p; best = key; }
    }
    return best;
  }

  private finishJob(): void {
    if (!this.job) return;
    const { key, job } = this.job;
    this.job = null;
    const data = job.result();
    const level = keyLevel(key), size = this.world.size / (1 << level);
    const x0 = keyI(key) * size, z0 = keyJ(key) * size;
    this.buildCount++;
    this.buildTotal += job.elapsed;
    this.buildMax = Math.max(this.buildMax, job.elapsed);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(data.position, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(data.normal, 3, true));
    geo.setAttribute('color', new THREE.BufferAttribute(data.color, 3, true));
    geo.setAttribute('aMat', new THREE.BufferAttribute(data.mat, 4, true));
    geo.setDrawRange(0, data.vertexCount);
    const cy = (data.minY + data.maxY) / 2, hy = (data.maxY - data.minY) / 2 + 5;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(size / 2, cy, size / 2), Math.sqrt(size * size * 0.5 + hy * hy));
    geo.boundingBox = new THREE.Box3(new THREE.Vector3(0, data.minY - 5, 0), new THREE.Vector3(size, data.maxY + 5, size));
    const terrain = new THREE.Mesh(geo, this.material);
    // terrain only receives: hill shadows would be cut off at the shadow-map range, and Lambert
    // N·L already darkens slopes facing away from the sun
    terrain.castShadow = false;
    terrain.receiveShadow = true;
    terrain.matrixAutoUpdate = false;
    terrain.name = `terrain:${level}:${keyI(key)}:${keyJ(key)}`;
    const group = new THREE.Group();
    group.position.set(x0, 0, z0);
    group.add(terrain);
    let water: THREE.Mesh | null = null;
    if (data.waterPosition && data.waterDepth) {
      const wg = new THREE.BufferGeometry();
      wg.setAttribute('position', new THREE.BufferAttribute(data.waterPosition, 3));
      wg.setAttribute('aDepth', new THREE.BufferAttribute(data.waterDepth, 1));
      wg.boundingSphere = new THREE.Sphere(new THREE.Vector3(size / 2, 0, size / 2), size * 0.75);
      water = new THREE.Mesh(wg, this.seaMaterial);
      water.matrixAutoUpdate = false;
      water.renderOrder = 1;
      water.name = 'sea';
      group.add(water);
    }
    group.updateMatrixWorld(true);
    group.matrixAutoUpdate = false;
    group.visible = false;
    this.root.add(group);
    this.nodes.set(key, {
      key, level, x0, z0, size, group, terrain, water,
      minY: data.minY, maxY: data.maxY + 0.5, lastUsed: this.frame, visible: false,
    });
  }

  private evict(): void {
    const max = this.settings.cacheNodes;
    if (this.nodes.size <= max) return;
    const cands: TerrainNode[] = [];
    for (const n of this.nodes.values()) if (!n.visible) cands.push(n);
    cands.sort((a, b) => a.lastUsed - b.lastUsed);
    const remove = Math.min(cands.length, this.nodes.size - max);
    for (let k = 0; k < remove; k++) this.disposeNode(cands[k]);
  }

  private disposeNode(n: TerrainNode): void {
    this.root.remove(n.group);
    n.terrain.geometry.dispose();
    n.water?.geometry.dispose();
    this.nodes.delete(n.key);
  }

  private rebuildMask(): void {
    const m = this.maskData;
    m.fill(0);
    for (const key of this.selector.render) {
      const n = this.nodes.get(key);
      if (!n) continue;
      const k = MASK_RES >> n.level;
      if (k <= 0) continue;
      const i0 = keyI(key) * k, j0 = keyJ(key) * k;
      for (let j = j0; j < j0 + k; j++) m.fill(255, j * MASK_RES + i0, j * MASK_RES + i0 + k);
    }
    this.mask.needsUpdate = true;
  }

  /** Height of the drawn terrain surface is world.heightAt; exposed for symmetry. */
  heightAt(x: number, z: number): number {
    return this.world.heightAt(Math.min(Math.max(x, 0), this.world.size), Math.min(Math.max(z, 0), this.world.size));
  }

  dispose(): void {
    for (const n of [...this.nodes.values()]) this.disposeNode(n);
    this.far.geometry.dispose();
    this.material.dispose();
    this.farMaterial.dispose();
    this.mask.dispose();
  }
}
