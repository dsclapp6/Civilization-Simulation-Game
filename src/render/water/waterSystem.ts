// All static water: lake surfaces, river ribbons, the far ocean plane, bridges and fords.
// (The coastal sea near the camera is built per terrain node; see terrain/nodeBuilder.ts.)
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, pointInPolygon } from '../../core/math';
import type { WorldModel } from '../../world/types';
import type { Palette } from '../../assets/types';
import type { AtmosphereState } from '../sky/atmosphere';
import { buildRiverRibbons, ribbonGeometry } from './rivers';
import { buildBridgesGeometry } from './bridges';
import { createWaterMaterial, createWaterShared, type WaterShared } from './waterMaterial';

export class WaterSystem {
  readonly root = new THREE.Group();
  readonly shared: WaterShared;
  readonly seaMaterial: THREE.ShaderMaterial;
  readonly lakeMaterial: THREE.ShaderMaterial;
  readonly riverMaterial: THREE.ShaderMaterial;
  readonly farMaterial: THREE.ShaderMaterial;
  readonly bridgeMaterial: THREE.MeshLambertMaterial;
  private readonly depthTex: THREE.DataTexture;
  private readonly geometries: THREE.BufferGeometry[] = [];
  readonly bridges: THREE.Mesh | null = null;
  /** River tiles (hidden at map altitude, where the overlay draws bold rivers instead). */
  readonly riverMeshes: THREE.Mesh[] = [];
  private readonly tmpC = new THREE.Color();

  constructor(private readonly world: WorldModel, private readonly palette: Palette, mask: THREE.Texture) {
    this.root.name = 'water';
    this.shared = createWaterShared(world.size);
    this.shared.uMask.value = mask;
    this.seaMaterial = createWaterMaterial('sea', this.shared);
    this.lakeMaterial = createWaterMaterial('lake', this.shared);
    this.riverMaterial = createWaterMaterial('river', this.shared);
    this.farMaterial = createWaterMaterial('far', this.shared);
    this.bridgeMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });

    // macro depth texture for the far ocean colour
    const m = world.macro;
    const data = new Uint8Array(m.res * m.res);
    for (let k = 0; k < data.length; k++) data[k] = clamp(Math.round((-m.height[k] / 40) * 255), 0, 255);
    this.depthTex = new THREE.DataTexture(data, m.res, m.res, THREE.RedFormat, THREE.UnsignedByteType);
    this.depthTex.magFilter = THREE.LinearFilter;
    this.depthTex.minFilter = THREE.LinearFilter;
    this.depthTex.needsUpdate = true;
    this.shared.uDepthTex.value = this.depthTex;

    // far ocean: one big plane, masked where detailed terrain nodes draw their own sea
    const farGeo = new THREE.PlaneGeometry(260000, 260000, 1, 1);
    farGeo.rotateX(-Math.PI / 2);
    farGeo.translate(world.size / 2, 0, world.size / 2);
    this.geometries.push(farGeo);
    const far = new THREE.Mesh(farGeo, this.farMaterial);
    far.name = 'ocean-far';
    far.frustumCulled = false;
    far.renderOrder = 0;
    this.root.add(far);

    for (const lake of world.lakes) {
      const g = this.buildLake(lake.outline, lake.level);
      if (!g) continue;
      const mesh = new THREE.Mesh(g, this.lakeMaterial);
      mesh.name = `lake:${lake.id}`;
      mesh.renderOrder = 2;
      this.root.add(mesh);
    }
    // river ribbons merged per 2 km tile: one draw call per tile however many streams it holds
    const RT = 2048;
    const byTile = new Map<number, THREE.BufferGeometry[]>();
    for (const river of world.rivers) {
      for (const piece of buildRiverRibbons(world, river, 160)) {
        const g = ribbonGeometry(piece);
        const c = g.boundingSphere!.center;
        const key = Math.floor(c.z / RT) * 64 + Math.floor(c.x / RT);
        let list = byTile.get(key);
        if (!list) { list = []; byTile.set(key, list); }
        list.push(g);
      }
    }
    for (const [key, list] of byTile) {
      const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (list.length > 1) for (const g of list) g.dispose();
      if (!merged) continue;
      merged.computeBoundingSphere();
      this.geometries.push(merged);
      const mesh = new THREE.Mesh(merged, this.riverMaterial);
      mesh.name = `rivers:${key % 64}:${Math.floor(key / 64)}`;
      mesh.renderOrder = 3;
      this.root.add(mesh);
      this.riverMeshes.push(mesh);
    }
    const bg = buildBridgesGeometry(world, palette);
    if (bg) {
      this.geometries.push(bg);
      const mesh = new THREE.Mesh(bg, this.bridgeMaterial);
      mesh.name = 'bridges';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.root.add(mesh);
      this.bridges = mesh;
    }
    for (const c of this.root.children) { c.updateMatrixWorld(); c.matrixAutoUpdate = false; }
  }

  private buildLake(outline: readonly { x: number; z: number }[], level: number): THREE.BufferGeometry | null {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of outline) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
    x0 -= 24; z0 -= 24; x1 += 24; z1 += 24;
    const span = Math.max(x1 - x0, z1 - z0);
    const step = clamp(span / 160, 3, 12);
    const nx = Math.ceil((x1 - x0) / step), nz = Math.ceil((z1 - z0) / step);
    const H = new Float32Array((nx + 1) * (nz + 1));
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) H[j * (nx + 1) + i] = this.world.heightAt(x0 + i * step, z0 + j * step);
    const pos: number[] = [], dep: number[] = [];
    const near = (x: number, z: number): boolean => {
      if (pointInPolygon(x, z, outline)) return true;
      for (const p of outline) if (Math.abs(p.x - x) < 24 && Math.abs(p.z - z) < 24) return true;
      return false;
    };
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const h00 = H[j * (nx + 1) + i], h10 = H[j * (nx + 1) + i + 1], h01 = H[(j + 1) * (nx + 1) + i], h11 = H[(j + 1) * (nx + 1) + i + 1];
        if (Math.min(h00, h10, h01, h11) > level + 0.3) continue;
        const cx = x0 + (i + 0.5) * step, cz = z0 + (j + 0.5) * step;
        if (!near(cx, cz)) continue;
        const ax = x0 + i * step, az = z0 + j * step;
        const quad = [ax, az, h00, ax, az + step, h01, ax + step, az + step, h11, ax, az, h00, ax + step, az + step, h11, ax + step, az, h10];
        for (let k = 0; k < 6; k++) {
          pos.push(quad[k * 3], level, quad[k * 3 + 1]);
          dep.push(level - quad[k * 3 + 2]);
        }
      }
    }
    if (!pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aDepth', new THREE.Float32BufferAttribute(dep, 1));
    g.computeBoundingSphere();
    this.geometries.push(g);
    return g;
  }

  /** Per-frame uniforms. `linearOutput` selects the colour space used for display-space colours. */
  update(atmo: AtmosphereState, time: number, rain: number, mapBlend = 0, pixelAngle = 0.0013): void {
    for (const m of this.riverMeshes) m.visible = mapBlend < 0.9;
    this.riverMaterial.uniforms.uPixelAngle.value = pixelAngle;
    const s = this.shared;
    s.uTime.value = time;
    const p = this.palette.water;
    // water tint follows the light: darker and bluer at night, warmer at dusk
    const lightLevel = clamp(atmo.day * 0.85 + 0.15, 0.12, 1) * (1 - atmo.overcast * 0.3);
    s.uShallow.value.setHex(p.shallow).multiplyScalar(lightLevel);
    s.uDeep.value.setHex(p.deep).multiplyScalar(lightLevel);
    if (atmo.overcast > 0) {
      // grey skies make water slate-coloured
      const g = (s.uShallow.value.r + s.uShallow.value.g + s.uShallow.value.b) / 3;
      s.uShallow.value.lerp(this.tmpC.setRGB(g, g, g * 1.05), atmo.overcast * 0.45);
      const gd = (s.uDeep.value.r + s.uDeep.value.g + s.uDeep.value.b) / 3;
      s.uDeep.value.lerp(this.tmpC.setRGB(gd, gd, gd * 1.1), atmo.overcast * 0.35);
    }
    s.uFoam.value.setHex(p.foam);
    s.uSunDir.value.copy(atmo.lightDir);
    s.uSunColor.value.copy(atmo.lightColor).multiplyScalar(atmo.lightIntensity / 3.0);
    s.uAmbient.value.copy(atmo.hemiSky).multiplyScalar(atmo.hemiIntensity * 0.65);
    s.uSkyTop.value.copy(atmo.skyTop).multiplyScalar(0.58);
    s.uSkyHorizon.value.copy(atmo.skyHorizon).multiplyScalar(0.62).lerp(this.tmpC.copy(atmo.sunHalo), 0.25 * atmo.dusk);
    s.uRain.value = rain;
    s.uGlint.value = atmo.lightIsMoon ? 0.3 : 1;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    this.seaMaterial.dispose();
    this.lakeMaterial.dispose();
    this.riverMaterial.dispose();
    this.farMaterial.dispose();
    this.bridgeMaterial.dispose();
    this.depthTex.dispose();
  }
}
