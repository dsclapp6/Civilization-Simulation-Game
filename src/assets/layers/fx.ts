// FX layer: GPU-simulated billboard particles in two draw calls (alpha-blended + additive).
// Each FxEvent writes a burst of particles into a ring buffer of instance attributes; motion
// (drag, gravity/buoyancy, wind) is evaluated in the vertex shader from spawn data, so the CPU
// only touches the slots it writes.
import * as THREE from 'three';
import type { FxEvent } from '../../core/view';
import type { AssetEnvironment, FxLayer } from '../types';
import type { SharedUniforms } from '../core/materials';

const SHAPE = { soft: 0, drop: 1, chip: 2, streak: 3, flame: 4 } as const;

interface Pool {
  mesh: THREE.Mesh;
  geo: THREE.InstancedBufferGeometry;
  attrs: Record<'iPos' | 'iVel' | 'iTime' | 'iSize' | 'iColor' | 'iPhys', THREE.InstancedBufferAttribute>;
  n: number;
  head: number;
  dirtyFrom: number;
  dirtyCount: number;
}

const VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindAmp;
attribute vec3 iPos;
attribute vec3 iVel;
attribute vec2 iTime;
attribute vec2 iSize;
attribute vec4 iColor;
attribute vec4 iPhys;
varying vec2 vUv;
varying vec4 vCol;
varying float vShape;
varying float vT;
void main() {
  float age = uTime - iTime.x;
  float life = iTime.y;
  if (age < 0.0 || age > life || life <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float t = age / life;
  float k = max(iPhys.y, 0.001);
  float f = (1.0 - exp(-k * age)) / k;
  vec3 p = iPos + iVel * f;
  p.y -= 0.5 * iPhys.x * age * age;
  p.xz += uWindDir * (0.6 + uWindAmp * 2.2) * iPhys.z * age;
  float size = mix(iSize.x, iSize.y, t);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  vec2 corner = position.xy;
  float shape = floor(iPhys.w + 0.5);
  if (shape == 3.0) {
    // Spark streak aligned with the projected velocity.
    vec3 v = iVel * exp(-k * age) - vec3(0.0, iPhys.x * age, 0.0);
    vec3 vv = (viewMatrix * vec4(v, 0.0)).xyz;
    vec2 d = length(vv.xy) > 1e-4 ? normalize(vv.xy) : vec2(0.0, 1.0);
    vec2 n = vec2(-d.y, d.x);
    float len = size * (2.5 + min(6.0, length(v)));
    mv.xy += d * corner.y * len + n * corner.x * size * 0.6;
  } else if (shape == 2.0) {
    // Tumbling chip.
    float a = age * (6.0 + fract(iPos.x * 13.1) * 8.0) + iPos.z * 7.0;
    mat2 r = mat2(cos(a), -sin(a), sin(a), cos(a));
    mv.xy += r * corner * size * vec2(1.0, 0.55 + 0.45 * cos(a * 0.7));
  } else if (shape == 4.0) {
    mv.xy += corner * size * vec2(0.7, 1.35);
  } else {
    float a = iPos.x * 3.7 + iPos.z * 1.3 + age * 0.3;
    mat2 r = mat2(cos(a), -sin(a), sin(a), cos(a));
    mv.xy += r * corner * size;
  }
  vUv = corner + 0.5;
  float fadeIn = smoothstep(0.0, 0.08, t);
  float fadeOut = 1.0 - smoothstep(0.55, 1.0, t);
  vCol = vec4(iColor.rgb, iColor.a * fadeIn * fadeOut);
  vShape = shape;
  vT = t;
  gl_Position = projectionMatrix * mv;
  vec4 mvPosition = mv;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform float uLight;
uniform float uAdditive;
varying vec2 vUv;
varying vec4 vCol;
varying float vShape;
varying float vT;
void main() {
  vec2 c = vUv - 0.5;
  float r = length(c) * 2.0;
  float a;
  if (vShape < 0.5) {
    // Soft puff with a lumpy edge.
    float lump = 0.12 * sin(atan(c.y, c.x) * 5.0 + vT * 3.0);
    a = 1.0 - smoothstep(0.35 + lump, 1.0 + lump, r);
  } else if (vShape < 1.5) {
    a = 1.0 - smoothstep(0.7, 1.0, r);
  } else if (vShape < 2.5) {
    a = step(max(abs(c.x), abs(c.y)), 0.42);
  } else if (vShape < 3.5) {
    a = (1.0 - smoothstep(0.1, 0.5, abs(c.x))) * (1.0 - smoothstep(0.25, 0.5, abs(c.y)));
  } else {
    // Flame: teardrop, hotter core.
    float w = mix(0.5, 0.05, clamp(vUv.y, 0.0, 1.0));
    a = (1.0 - smoothstep(w * 0.4, w, abs(c.x))) * (1.0 - smoothstep(0.3, 0.5, abs(c.y)));
  }
  a *= vCol.a;
  if (a < 0.003) discard;
  vec3 col = vCol.rgb;
  if (uAdditive < 0.5) col *= uLight;
  else if (vShape > 3.5) col = mix(col, vec3(1.0, 0.92, 0.6), (1.0 - smoothstep(0.0, 0.6, r)) * 0.6);
  gl_FragColor = vec4(col * (uAdditive > 0.5 ? a : 1.0), uAdditive > 0.5 ? 1.0 : a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

function makePool(n: number, additive: boolean, u: SharedUniforms, light: { value: number }): Pool {
  const geo = new THREE.InstancedBufferGeometry();
  const quad = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
  geo.setAttribute('position', new THREE.BufferAttribute(quad, 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const mk = (size: number) => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(n * size), size);
    a.setUsage(THREE.DynamicDrawUsage);
    return a;
  };
  const attrs = { iPos: mk(3), iVel: mk(3), iTime: mk(2), iSize: mk(2), iColor: mk(4), iPhys: mk(4) };
  for (const [k, a] of Object.entries(attrs)) geo.setAttribute(k, a);
  // Mark all particles dead.
  for (let i = 0; i < n; i++) attrs.iTime.setXY(i, -1e6, 0);
  geo.instanceCount = n;
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uAdditive: { value: additive ? 1 : 0 } }]),
    transparent: true,
    depthWrite: false,
    fog: true,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  mat.uniforms.uTime = u.uTime;
  mat.uniforms.uWindDir = u.uWindDir;
  mat.uniforms.uWindAmp = u.uWindAmp;
  mat.uniforms.uLight = light;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = additive ? 11 : 10;
  mesh.name = additive ? 'fx-additive' : 'fx-alpha';
  return { mesh, geo, attrs, n, head: 0, dirtyFrom: -1, dirtyCount: 0 };
}

interface Spawn {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number; s0: number; s1: number;
  r: number; g: number; b: number; a: number;
  grav: number; drag: number; wind: number; shape: number;
  delay?: number;
}

export function createFxLayer(u: SharedUniforms, envRef: () => AssetEnvironment): FxLayer {
  const light = { value: 1 };
  const alpha = makePool(4096, false, u, light);
  const add = makePool(2048, true, u, light);
  const group = new THREE.Group();
  group.name = 'fx';
  group.add(alpha.mesh, add.mesh);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const sp: Spawn = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, s0: 1, s1: 1, r: 1, g: 1, b: 1, a: 1, grav: 0, drag: 0, wind: 0, shape: 0 };

  function write(pool: Pool, s: Spawn): void {
    const i = pool.head;
    pool.head = (pool.head + 1) % pool.n;
    const t = u.uTime.value + (s.delay ?? 0);
    pool.attrs.iPos.setXYZ(i, s.x, s.y, s.z);
    pool.attrs.iVel.setXYZ(i, s.vx, s.vy, s.vz);
    pool.attrs.iTime.setXY(i, t, s.life);
    pool.attrs.iSize.setXY(i, s.s0, s.s1);
    pool.attrs.iColor.setXYZW(i, s.r, s.g, s.b, s.a);
    pool.attrs.iPhys.setXYZW(i, s.grav, s.drag, s.wind, s.shape);
    if (pool.dirtyFrom < 0) { pool.dirtyFrom = i; pool.dirtyCount = 1; }
    else pool.dirtyCount = Math.min(pool.n, pool.dirtyCount + 1);
  }

  function flush(pool: Pool): void {
    if (pool.dirtyFrom < 0) return;
    const from = pool.dirtyFrom, count = pool.dirtyCount;
    for (const a of Object.values(pool.attrs)) {
      a.clearUpdateRanges();
      const sz = a.itemSize;
      if (from + count <= pool.n) a.addUpdateRange(from * sz, count * sz);
      else { a.addUpdateRange(from * sz, (pool.n - from) * sz); a.addUpdateRange(0, (from + count - pool.n) * sz); }
      a.needsUpdate = true;
    }
    pool.dirtyFrom = -1;
    pool.dirtyCount = 0;
  }

  const col = (hex: number, k = 1) => {
    const c = new THREE.Color(hex);
    sp.r = c.r * k; sp.g = c.g * k; sp.b = c.b * k;
  };
  const at = (e: FxEvent, j = 0) => { sp.x = e.x + (rnd() - 0.5) * j; sp.y = e.y + (rnd() - 0.5) * j * 0.5; sp.z = e.z + (rnd() - 0.5) * j; };
  const burst = (speed: number, up: number) => {
    const a = rnd() * Math.PI * 2, s = speed * (0.4 + rnd() * 0.6);
    sp.vx = Math.cos(a) * s; sp.vz = Math.sin(a) * s; sp.vy = up * (0.5 + rnd() * 0.7);
  };
  sp.delay = 0;

  function emitOne(e: FxEvent): void {
    const k = Math.max(0.2, Math.min(3, e.intensity || 1));
    const N = (base: number) => Math.max(1, Math.round(base * k));
    sp.delay = 0;
    switch (e.kind) {
      case 'dust':
        for (let i = 0; i < N(8); i++) {
          at(e, 0.6); burst(0.9, 0.5); col(0xb5a585); sp.a = 0.45;
          sp.life = 1.2 + rnd() * 1.0; sp.s0 = 0.35 * Math.sqrt(k); sp.s1 = 1.4 * Math.sqrt(k);
          sp.grav = -0.08; sp.drag = 1.6; sp.wind = 0.35; sp.shape = SHAPE.soft;
          write(alpha, sp);
        }
        break;
      case 'blood':
        for (let i = 0; i < N(12); i++) {
          at(e, 0.15); burst(2.2, 2.4); col(0x7a0c0c); sp.a = 0.95;
          sp.life = 0.5 + rnd() * 0.4; sp.s0 = 0.07; sp.s1 = 0.05; sp.grav = 9.8; sp.drag = 0.6; sp.wind = 0; sp.shape = SHAPE.drop;
          write(alpha, sp);
        }
        for (let i = 0; i < N(2); i++) {
          at(e, 0.1); burst(0.4, 0.3); col(0x8a1414); sp.a = 0.35;
          sp.life = 0.6; sp.s0 = 0.15; sp.s1 = 0.5; sp.grav = 0.5; sp.drag = 2; sp.wind = 0.1; sp.shape = SHAPE.soft;
          write(alpha, sp);
        }
        break;
      case 'sparks':
        for (let i = 0; i < N(18); i++) {
          at(e, 0.1); burst(3.2, 3.5); col(0xffb040, 2.2); sp.a = 1;
          sp.life = 0.35 + rnd() * 0.55; sp.s0 = 0.035; sp.s1 = 0.02; sp.grav = 7; sp.drag = 1.2; sp.wind = 0.05; sp.shape = SHAPE.streak;
          write(add, sp);
        }
        break;
      case 'smoke':
        for (let i = 0; i < N(5); i++) {
          at(e, 0.8); burst(0.3, 1.2); col(0x5f5f5f); sp.a = 0.55;
          sp.life = 4 + rnd() * 3; sp.s0 = 1.0 * Math.sqrt(k); sp.s1 = 4.0 * Math.sqrt(k);
          sp.grav = -0.12; sp.drag = 0.7; sp.wind = 1; sp.shape = SHAPE.soft; sp.delay = i * 0.12;
          write(alpha, sp);
        }
        break;
      case 'fire':
        for (let i = 0; i < N(8); i++) {
          at(e, 0.7); burst(0.35, 1.6); col(rnd() < 0.5 ? 0xff7a1a : 0xffa030, 2.0); sp.a = 0.9;
          sp.life = 0.45 + rnd() * 0.45; sp.s0 = 0.55 * Math.sqrt(k); sp.s1 = 0.12; sp.grav = -2.5; sp.drag = 1.2; sp.wind = 0.4; sp.shape = SHAPE.flame;
          write(add, sp);
        }
        for (let i = 0; i < N(2); i++) {
          at(e, 0.5); burst(0.2, 1.4); col(0x55504c); sp.a = 0.32;
          sp.life = 3 + rnd() * 2; sp.s0 = 0.7; sp.s1 = 3.0; sp.grav = -0.2; sp.drag = 0.6; sp.wind = 1; sp.shape = SHAPE.soft; sp.delay = 0.3;
          write(alpha, sp);
        }
        if (rnd() < 0.5) {
          at(e, 0.4); burst(1.5, 3.0); col(0xffa040, 2.0); sp.a = 1; sp.life = 0.9; sp.s0 = 0.03; sp.s1 = 0.02; sp.grav = 1.5; sp.drag = 0.8; sp.wind = 0.6; sp.shape = SHAPE.streak;
          write(add, sp);
        }
        break;
      case 'splash':
        for (let i = 0; i < N(14); i++) {
          at(e, 0.2); burst(1.6, 3.4); col(0xd4e6ec); sp.a = 0.85;
          sp.life = 0.6 + rnd() * 0.4; sp.s0 = 0.09; sp.s1 = 0.06; sp.grav = 9.8; sp.drag = 0.4; sp.wind = 0; sp.shape = SHAPE.drop;
          write(alpha, sp);
        }
        for (let i = 0; i < N(3); i++) {
          at(e, 0.3); burst(0.5, 0.4); col(0xeaf4f6); sp.a = 0.35;
          sp.life = 0.9; sp.s0 = 0.3; sp.s1 = 1.1; sp.grav = 0.3; sp.drag = 2; sp.wind = 0.2; sp.shape = SHAPE.soft;
          write(alpha, sp);
        }
        break;
      case 'chips':
        for (let i = 0; i < N(10); i++) {
          at(e, 0.15); burst(1.8, 2.6); col(rnd() < 0.7 ? 0xa88458 : 0xc8a878); sp.a = 1;
          sp.life = 0.8 + rnd() * 0.5; sp.s0 = 0.08; sp.s1 = 0.07; sp.grav = 9.8; sp.drag = 0.5; sp.wind = 0; sp.shape = SHAPE.chip;
          write(alpha, sp);
        }
        break;
      case 'chaff':
        for (let i = 0; i < N(14); i++) {
          at(e, 0.4); burst(0.8, 1.2); col(rnd() < 0.5 ? 0xd8bf6e : 0xc8a858); sp.a = 0.95;
          sp.life = 2 + rnd() * 1.5; sp.s0 = 0.06; sp.s1 = 0.05; sp.grav = 0.7; sp.drag = 2.2; sp.wind = 1.4; sp.shape = SHAPE.chip;
          write(alpha, sp);
        }
        break;
      case 'impact':
        for (let i = 0; i < N(5); i++) {
          at(e, 0.2); burst(1.0, 0.5); col(0xa89a80); sp.a = 0.5;
          sp.life = 0.9 + rnd() * 0.5; sp.s0 = 0.2; sp.s1 = 0.8; sp.grav = -0.05; sp.drag = 2.5; sp.wind = 0.2; sp.shape = SHAPE.soft;
          write(alpha, sp);
        }
        for (let i = 0; i < N(5); i++) {
          at(e, 0.1); burst(1.6, 2.2); col(0x8a7a62); sp.a = 1;
          sp.life = 0.6 + rnd() * 0.3; sp.s0 = 0.05; sp.s1 = 0.05; sp.grav = 9.8; sp.drag = 0.4; sp.wind = 0; sp.shape = SHAPE.chip;
          write(alpha, sp);
        }
        break;
      case 'hearth_smoke':
        for (let i = 0; i < N(1); i++) {
          at(e, 0.15); sp.vx = (rnd() - 0.5) * 0.1; sp.vy = 0.55 + rnd() * 0.25; sp.vz = (rnd() - 0.5) * 0.1;
          col(rnd() < 0.5 ? 0xa4a8ae : 0x8f949a); sp.a = 0.32;
          sp.life = 6 + rnd() * 3; sp.s0 = 0.35; sp.s1 = 2.4; sp.grav = -0.04; sp.drag = 0.25; sp.wind = 0.9; sp.shape = SHAPE.soft;
          write(alpha, sp);
        }
        break;
    }
  }

  return {
    object: group,
    emit(events: readonly FxEvent[]): void {
      for (const e of events) emitOne(e);
    },
    update(dt: number, camera: THREE.Camera): void {
      void dt; void camera;
      const night = envRef().nightLight;
      light.value = 1 - night * 0.72;
      flush(alpha);
      flush(add);
    },
    dispose(): void {
      group.removeFromParent();
      alpha.geo.dispose(); (alpha.mesh.material as THREE.Material).dispose();
      add.geo.dispose(); (add.mesh.material as THREE.Material).dispose();
    },
  };
}
