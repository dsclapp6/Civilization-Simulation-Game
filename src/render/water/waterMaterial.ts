// Stylised water: faceted low-poly waves (vertex sines + derivative normals), depth tint from
// per-vertex water depth, fresnel sky reflection, sun/moon glint, shoreline foam bands and river
// flow streaks. Fog comes from the patched three.js fog chunks so water sits in the same haze.
import * as THREE from 'three';
import { atmoUniforms } from '../sky/atmospherePatch';

export type WaterKind = 'sea' | 'lake' | 'river' | 'far';

export interface WaterShared {
  uTime: { value: number };
  uShallow: { value: THREE.Color };
  uDeep: { value: THREE.Color };
  uFoam: { value: THREE.Color };
  uSunDir: { value: THREE.Vector3 };
  uSunColor: { value: THREE.Color };
  uAmbient: { value: THREE.Color };
  uSkyTop: { value: THREE.Color };
  uSkyHorizon: { value: THREE.Color };
  uRain: { value: number };
  uWorldSize: { value: number };
  uMask: { value: THREE.Texture | null };
  uDepthTex: { value: THREE.Texture | null };
}

export function createWaterShared(worldSize: number): WaterShared {
  return {
    uTime: { value: 0 },
    uShallow: { value: new THREE.Color() },
    uDeep: { value: new THREE.Color() },
    uFoam: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color() },
    uAmbient: { value: new THREE.Color() },
    uSkyTop: { value: new THREE.Color() },
    uSkyHorizon: { value: new THREE.Color() },
    uRain: { value: 0 },
    uWorldSize: { value: worldSize },
    uMask: { value: null },
    uDepthTex: { value: null },
  };
}

const VERTEX = /* glsl */`
attribute float aDepth;
attribute vec2 aFlow;
attribute float aSpeed;
uniform float uTime;
uniform float uWaveAmp;
uniform float uWorldSize;
uniform sampler2D uDepthTex;
varying vec3 vWorld;
varying float vDepth;
varying vec2 vFlow;
varying float vSpeed;
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
#ifdef FAR_WATER
  float d = 40.0;
#else
  float d = aDepth;
#endif
  float distFade = 1.0 - smoothstep(120.0, 700.0, distance(wp.xyz, cameraPosition));
  float amp = uWaveAmp * smoothstep(0.0, 2.0, d) * distFade;
  float w = sin(wp.x * 0.13 + uTime * 1.15) * 0.5
          + sin(wp.z * 0.097 - uTime * 0.93 + wp.x * 0.031) * 0.35
          + sin((wp.x - wp.z) * 0.27 + uTime * 1.9) * 0.15;
  wp.y += w * amp;
  vWorld = wp.xyz;
  vDepth = d;
#ifdef RIVER
  vFlow = aFlow;
  vSpeed = aSpeed;
#else
  vFlow = vec2(0.0);
  vSpeed = 0.0;
#endif
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}`;

const FRAGMENT = /* glsl */`
uniform float uTime;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uFoam;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform float uRain;
uniform float uFoamScale;
uniform float uWorldSize;
uniform sampler2D uMask;
uniform sampler2D uDepthTex;
varying vec3 vWorld;
varying float vDepth;
varying vec2 vFlow;
varying float vSpeed;
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
float wHash(vec2 p) { p = fract(p * vec2(443.897, 441.423)); p += dot(p, p + 19.19); return fract(p.x * p.y); }
float wNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(wHash(i), wHash(i + vec2(1.0, 0.0)), u.x), mix(wHash(i + vec2(0.0, 1.0)), wHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
void main() {
  #include <logdepthbuf_fragment>
#ifdef FAR_WATER
  vec2 wuv = vWorld.xz / uWorldSize;
  if (wuv.x > 0.0 && wuv.y > 0.0 && wuv.x < 1.0 && wuv.y < 1.0 && texture2D(uMask, wuv).r > 0.5) discard;
  float depth = texture2D(uDepthTex, clamp(wuv, 0.0, 1.0)).r * 40.0;
  vec3 n = vec3(0.0, 1.0, 0.0);
#else
  float depth = max(vDepth, 0.0);
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  if (n.y < 0.0) n = -n;
#endif
  float camDist = distance(cameraPosition, vWorld);
  // fine ripples (rain makes them busier), faded out before they alias into sparkle
  float near = 1.0 - smoothstep(25.0, 220.0, camDist);
  vec2 rp = vWorld.xz * (0.35 + uRain * 0.6) + vec2(uTime * 0.21, -uTime * 0.17);
  vec2 rg = vec2(wNoise(rp) - wNoise(rp + vec2(0.37, 0.0)), wNoise(rp) - wNoise(rp + vec2(0.0, 0.37)));
  n = normalize(n + vec3(rg.x, 0.0, rg.y) * (0.3 + uRain * 0.8) * near);
  // broad swells keep distant water from looking like a mirror
  vec2 bp = vWorld.xz / 160.0 + vec2(uTime * 0.01, uTime * 0.008);
  vec2 bg = vec2(wNoise(bp) - wNoise(bp + vec2(0.5, 0.0)), wNoise(bp) - wNoise(bp + vec2(0.0, 0.5)));
  n = normalize(n + vec3(bg.x, 0.0, bg.y) * 0.18);
  vec3 V = normalize(cameraPosition - vWorld);
  float deepT = 1.0 - exp(-depth / 3.2);
  vec3 body = mix(uShallow, uDeep, deepT);
  float ndl = max(dot(n, uSunDir), 0.0);
  vec3 col = body * (uAmbient * 0.75 + uSunColor * (0.25 + ndl * 0.35));
  vec3 R = reflect(-V, n);
  vec3 sky = mix(uSkyHorizon, uSkyTop, pow(clamp(R.y, 0.0, 1.0), 0.35));
  float fres = 0.03 + 0.97 * pow(1.0 - clamp(dot(n, V), 0.0, 1.0), 5.0);
  col = mix(col, sky, clamp(fres, 0.0, 1.0) * 0.62);
  vec3 H = normalize(uSunDir + V);
  float spec = pow(max(dot(n, H), 0.0), 220.0) * (0.4 + 0.6 * near);
  col += uSunColor * spec * 2.6;
  float foam = 0.0;
#ifndef FAR_WATER
  // shoreline foam: bands that roll towards the shore and break into noisy edges
  float fn = wNoise(vWorld.xz * 0.45 + uTime * 0.15) * 0.6 + wNoise(vWorld.xz * 1.7 - uTime * 0.2) * 0.4;
  float shore = 1.0 - smoothstep(0.0, 0.75 * uFoamScale, depth + fn * 0.2);
  // thin bands rolling in towards the beach, breaking up with noise
  float bands = sin(depth * 9.0 / uFoamScale - uTime * 1.8 + fn * 4.0);
  foam = shore * smoothstep(0.55, 0.95, bands * 0.5 + 0.5) * smoothstep(0.25, 0.6, fn + shore * 0.3) * 0.9;
  foam = max(foam, smoothstep(0.18, 0.0, depth + (fn - 0.5) * 0.12) * 0.85);
#endif
#ifdef RIVER
  // flowing streaks along the current and foam at the banks
  vec2 fp = vec2(vFlow.y * 6.0, vFlow.x * 0.35 - uTime * vSpeed * 0.9);
  float streak = wNoise(fp) * 0.6 + wNoise(fp * vec2(2.0, 3.1) + 7.0) * 0.4;
  col += uFoam * smoothstep(0.62, 0.9, streak) * 0.12 * (uAmbient + uSunColor * 0.5);
  float bank = smoothstep(0.38, 0.5, abs(vFlow.y - 0.5));
  foam = max(foam, bank * smoothstep(0.35, 0.8, streak) * 0.6);
#endif
  col = mix(col, uFoam * (uAmbient * 0.85 + uSunColor * (0.2 + ndl * 0.5)), clamp(foam, 0.0, 1.0));
  float alpha = mix(0.5, 0.93, smoothstep(0.0, 2.5, depth));
  alpha = mix(alpha, 1.0, smoothstep(4.0, 9.0, depth));
#ifdef FAR_WATER
  alpha = 1.0;
#endif
  alpha = max(alpha, foam);
  alpha = mix(alpha, 1.0, clamp(fres * 0.5, 0.0, 0.5));
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

export function createWaterMaterial(kind: WaterKind, shared: WaterShared): THREE.ShaderMaterial {
  const defines: Record<string, string> = {};
  if (kind === 'river') defines.RIVER = '';
  if (kind === 'far') defines.FAR_WATER = '';
  const mat = new THREE.ShaderMaterial({
    name: `water-${kind}`,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    defines,
    transparent: true,
    depthWrite: true,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uWaveAmp: { value: kind === 'sea' ? 0.22 : kind === 'lake' ? 0.07 : kind === 'river' ? 0.04 : 0 },
      uFoamScale: { value: kind === 'sea' ? 1 : kind === 'lake' ? 0.6 : 0.5 },
    }]),
  });
  Object.assign(mat.uniforms, shared, atmoUniforms);
  return mat;
}
