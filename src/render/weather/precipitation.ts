// Rain streaks and snowflakes in a box that wraps around the camera. Fully GPU-animated: the CPU
// only updates a few uniforms per frame. One draw call each.
import * as THREE from 'three';

const RAIN_VERTEX = /* glsl */`
attribute vec4 aSeed;
attribute float aEnd;
uniform vec3 uOrigin;
uniform vec3 uOffset;
uniform vec3 uBox;
uniform vec3 uVel;
uniform float uStreak;
uniform float uCount;
varying float vAlpha;
void main() {
  vec3 p = aSeed.xyz * uBox + uOffset;
  p = mod(p, uBox) + uOrigin;
  p -= uVel * aEnd * uStreak;
  vAlpha = (1.0 - aEnd * 0.8) * step(aSeed.w, uCount);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  vAlpha *= smoothstep(0.5, 3.0, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;

const RAIN_FRAGMENT = /* glsl */`
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;
void main() {
  gl_FragColor = vec4(uColor, uOpacity * vAlpha);
  #include <colorspace_fragment>
}`;

const SNOW_VERTEX = /* glsl */`
attribute vec4 aSeed;
uniform vec3 uOrigin;
uniform vec3 uOffset;
uniform vec3 uBox;
uniform float uTime;
uniform float uCount;
uniform float uScale;
varying float vAlpha;
void main() {
  vec3 p = aSeed.xyz * uBox + uOffset;
  p.x += sin(uTime * 0.9 + aSeed.w * 40.0) * 0.6;
  p.z += cos(uTime * 0.7 + aSeed.w * 25.0) * 0.6;
  p = mod(p, uBox) + uOrigin;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  vAlpha = step(aSeed.w, uCount) * smoothstep(0.3, 2.0, -mv.z);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uScale * (0.6 + fract(aSeed.w * 97.0) * 0.8) / max(0.5, -mv.z);
}`;

const SNOW_FRAGMENT = /* glsl */`
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.15, d) * vAlpha * uOpacity;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}`;

function seeds(n: number, perItem: number): Float32Array {
  const a = new Float32Array(n * perItem * 4);
  let s = 987654321;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let i = 0; i < n; i++) {
    const x = rnd(), y = rnd(), z = rnd(), w = rnd();
    for (let k = 0; k < perItem; k++) a.set([x, y, z, w], (i * perItem + k) * 4);
  }
  return a;
}

export class Precipitation {
  readonly rain: THREE.LineSegments;
  readonly snow: THREE.Points;
  private readonly rainMat: THREE.ShaderMaterial;
  private readonly snowMat: THREE.ShaderMaterial;
  private rainT = 0;
  private snowT = 0;
  private readonly box = new THREE.Vector3(44, 26, 44);
  private readonly snowBox = new THREE.Vector3(50, 30, 50);

  constructor(rainDrops: number, snowFlakes: number) {
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(rainDrops * 2 * 3), 3));
    rg.setAttribute('aSeed', new THREE.BufferAttribute(seeds(rainDrops, 2), 4));
    const ends = new Float32Array(rainDrops * 2);
    for (let i = 0; i < rainDrops; i++) ends[i * 2 + 1] = 1;
    rg.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
    this.rainMat = new THREE.ShaderMaterial({
      vertexShader: RAIN_VERTEX, fragmentShader: RAIN_FRAGMENT, transparent: true, depthWrite: false,
      uniforms: {
        uOrigin: { value: new THREE.Vector3() }, uOffset: { value: new THREE.Vector3() }, uBox: { value: this.box },
        uVel: { value: new THREE.Vector3(0, -11, 0) }, uStreak: { value: 0.045 }, uCount: { value: 0 },
        uColor: { value: new THREE.Color(0.72, 0.76, 0.82) }, uOpacity: { value: 0.35 },
      },
    });
    this.rain = new THREE.LineSegments(rg, this.rainMat);
    this.rain.frustumCulled = false;
    this.rain.renderOrder = 10;
    this.rain.name = 'rain';

    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(snowFlakes * 3), 3));
    sg.setAttribute('aSeed', new THREE.BufferAttribute(seeds(snowFlakes, 1), 4));
    this.snowMat = new THREE.ShaderMaterial({
      vertexShader: SNOW_VERTEX, fragmentShader: SNOW_FRAGMENT, transparent: true, depthWrite: false,
      uniforms: {
        uOrigin: { value: new THREE.Vector3() }, uOffset: { value: new THREE.Vector3() }, uBox: { value: this.snowBox },
        uTime: { value: 0 }, uCount: { value: 0 }, uScale: { value: 60 },
        uColor: { value: new THREE.Color(0.95, 0.96, 1.0) }, uOpacity: { value: 0.9 },
      },
    });
    this.snow = new THREE.Points(sg, this.snowMat);
    this.snow.frustumCulled = false;
    this.snow.renderOrder = 10;
    this.snow.name = 'snow';
  }

  update(camera: THREE.Camera, dt: number, time: number, rain: number, snow: number, windX: number, windZ: number,
    light: number, pixelScale: number, aboveGround: number): void {
    const cp = camera.position;
    const show = aboveGround < 120;
    // rain
    const ru = this.rainMat.uniforms;
    const vel = ru.uVel.value as THREE.Vector3;
    vel.set(windX * 0.45, -11 - rain * 2, windZ * 0.45);
    this.rainT += dt;
    const period = 200;
    if (this.rainT > period) this.rainT -= period;
    (ru.uOffset.value as THREE.Vector3).copy(vel).multiplyScalar(this.rainT);
    (ru.uOrigin.value as THREE.Vector3).set(cp.x - this.box.x / 2, cp.y - this.box.y * 0.45, cp.z - this.box.z / 2);
    // wrap the offset so the origin shift keeps drops stable relative to the world
    const off = ru.uOffset.value as THREE.Vector3;
    off.x = ((off.x - (cp.x - this.box.x / 2)) % this.box.x + this.box.x) % this.box.x;
    off.y = ((off.y - (cp.y - this.box.y * 0.45)) % this.box.y + this.box.y) % this.box.y;
    off.z = ((off.z - (cp.z - this.box.z / 2)) % this.box.z + this.box.z) % this.box.z;
    ru.uCount.value = rain;
    ru.uOpacity.value = 0.22 + 0.25 * light;
    (ru.uColor.value as THREE.Color).setRGB(0.55 + 0.25 * light, 0.6 + 0.25 * light, 0.68 + 0.22 * light);
    this.rain.visible = show && rain > 0.01;
    // snow
    const su = this.snowMat.uniforms;
    this.snowT += dt;
    if (this.snowT > 1000) this.snowT -= 1000;
    const so = su.uOffset.value as THREE.Vector3;
    so.set(windX * 0.3 * this.snowT, -1.1 * this.snowT, windZ * 0.3 * this.snowT);
    (su.uOrigin.value as THREE.Vector3).set(cp.x - this.snowBox.x / 2, cp.y - this.snowBox.y * 0.45, cp.z - this.snowBox.z / 2);
    so.x = ((so.x - (cp.x - this.snowBox.x / 2)) % this.snowBox.x + this.snowBox.x) % this.snowBox.x;
    so.y = ((so.y - (cp.y - this.snowBox.y * 0.45)) % this.snowBox.y + this.snowBox.y) % this.snowBox.y;
    so.z = ((so.z - (cp.z - this.snowBox.z / 2)) % this.snowBox.z + this.snowBox.z) % this.snowBox.z;
    su.uTime.value = time;
    su.uCount.value = snow;
    su.uScale.value = 55 * pixelScale;
    (su.uColor.value as THREE.Color).setRGB(0.55 + 0.42 * light, 0.57 + 0.41 * light, 0.62 + 0.38 * light);
    this.snow.visible = show && snow > 0.01;
  }

  dispose(): void {
    this.rain.geometry.dispose();
    this.snow.geometry.dispose();
    this.rainMat.dispose();
    this.snowMat.dispose();
  }
}
