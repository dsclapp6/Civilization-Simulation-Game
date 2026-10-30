// Directional sun/moon light with a shadow camera fitted to the near view frustum, plus the
// hemisphere light. One directional light is reused for sun and moon so shaders never recompile.
import * as THREE from 'three';
import type { AtmosphereState } from './atmosphere';

const ORIGIN = new THREE.Vector3();

export class Lighting {
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  /** Shadowless sky fill opposite the sun (never casts: costs one light term per fragment). */
  readonly fill: THREE.DirectionalLight;
  private readonly lightView = new THREE.Matrix4();
  private readonly lightViewInv = new THREE.Matrix4();
  private readonly centre = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private mapSize = 2048;

  constructor(scene: THREE.Scene) {
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.name = 'sun';
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.sun.shadow.radius = 2.5;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.hemi = new THREE.HemisphereLight(0xbfd9ef, 0x6b5a3a, 0.9);
    this.hemi.name = 'hemisphere';
    this.fill = new THREE.DirectionalLight(0xc9dcf0, 0);
    this.fill.name = 'sky-fill';
    this.fill.castShadow = false;
    scene.add(this.sun, this.sun.target, this.hemi, this.fill, this.fill.target);
  }

  configure(shadows: boolean, mapSize: number, radius: number): void {
    this.sun.shadow.radius = radius;
    if (mapSize !== this.mapSize) {
      this.mapSize = mapSize;
      this.sun.shadow.mapSize.set(mapSize, mapSize);
      if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    }
    // Presets without shadows drop the shadow-casting light entirely (one recompile on switch);
    // a shadow-casting light must have a rendered map or lit materials sample a null depth texture.
    this.sun.castShadow = shadows;
  }

  /** @param shadowsActive false for views where shadows are invisible anyway (map altitude) */
  update(atmo: AtmosphereState, shadowsActive: boolean): void {
    this.sun.color.copy(atmo.lightColor);
    this.sun.intensity = atmo.lightIntensity;
    this.hemi.color.copy(atmo.hemiSky);
    this.hemi.groundColor.copy(atmo.hemiGround);
    this.hemi.intensity = atmo.hemiIntensity;
    this.fill.color.copy(atmo.fillColor);
    this.fill.intensity = atmo.fillIntensity;
    // directional lights shine from position towards target: keep the pair at the origin offset
    this.fill.position.copy(atmo.fillDir);
    this.fill.target.position.set(0, 0, 0);
    this.fill.updateMatrixWorld();
    this.fill.target.updateMatrixWorld();
    if (!this.sun.castShadow) return;
    this.sun.shadow.intensity = shadowsActive ? atmo.shadowStrength : 0;
    // keep the map alive: always render it at least once, then only while shadows matter
    this.sun.shadow.autoUpdate = !this.sun.shadow.map || (shadowsActive && atmo.lightIntensity > 0.01);
  }

  /**
   * Fit the orthographic shadow camera to the bounding sphere of the camera frustum slice
   * [near, maxDist], snapped to shadow-map texels so shadows do not shimmer when moving.
   */
  fitShadow(camera: THREE.PerspectiveCamera, lightDir: THREE.Vector3, maxDist: number, casterReach = 350): void {
    const n = camera.near, f = Math.max(n + 1, maxDist);
    const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const tanX = tanY * camera.aspect;
    const k2 = tanX * tanX + tanY * tanY;
    let zc = 0.5 * (f + n) * (1 + k2);
    let r: number;
    if (zc >= f) { zc = f; r = f * Math.sqrt(k2); } else r = Math.sqrt((f - zc) * (f - zc) + f * f * k2);
    r = Math.ceil(r * 1.04);
    camera.getWorldDirection(this.fwd);
    this.centre.copy(camera.position).addScaledVector(this.fwd, zc);

    // light-space basis, identical to the one DirectionalLightShadow builds for its camera
    this.lightView.lookAt(ORIGIN, this.tmp.copy(lightDir).negate(), this.up);
    this.lightViewInv.copy(this.lightView).invert();
    // snap the centre to texel increments in light space
    const texel = (2 * r) / this.mapSize;
    const lc = this.tmp.copy(this.centre).applyMatrix4(this.lightViewInv);
    lc.x = Math.round(lc.x / texel) * texel;
    lc.y = Math.round(lc.y / texel) * texel;
    lc.applyMatrix4(this.lightView);
    this.centre.copy(lc);

    const sh = this.sun.shadow.camera;
    sh.left = -r; sh.right = r; sh.top = r; sh.bottom = -r;
    sh.near = 1;
    sh.far = 2 * r + casterReach;
    sh.updateProjectionMatrix();
    this.sun.position.copy(this.centre).addScaledVector(lightDir, r + casterReach);
    this.sun.target.position.copy(this.centre);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
    this.sun.shadow.normalBias = Math.max(0.02, texel * 0.9);
  }

  dispose(): void {
    this.sun.shadow.map?.dispose();
    this.sun.dispose();
    this.hemi.dispose();
    this.fill.dispose();
  }
}
