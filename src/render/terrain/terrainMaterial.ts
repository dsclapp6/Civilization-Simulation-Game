// Terrain material: Lambert (lights, shadows, fog, cloud shadows come from three + the atmosphere
// patch) with per-triangle sRGB colours and shader-side seasonal grass tint, patchy snow cover,
// rain wetness and the strategic-map overlay. The far variant discards fragments covered by
// detailed quadtree nodes (coverage mask).
import * as THREE from 'three';

export interface TerrainUniforms {
  uGrassTint: { value: THREE.Color };
  uGrassTintStrength: { value: number };
  uSnowCover: { value: number };
  uWetness: { value: number };
  uOverlay: { value: THREE.Texture | null };
  /** Smooth map colours (rgb) and woodland density (a), see map/mapOverlay.buildMapBase. */
  uMapBase: { value: THREE.Texture | null };
  uOverlayStrength: { value: number };
  uWorldSize: { value: number };
  uMask: { value: THREE.Texture | null };
  uSnowLine: { value: number };
  /** Canopy albedo for distant woodland, and the distance over which it takes over. */
  uCanopy: { value: THREE.Color };
  uCanopyDist: { value: number };
}

export function createTerrainUniforms(worldSize: number): TerrainUniforms {
  return {
    uGrassTint: { value: new THREE.Color(1, 1, 1) },
    uGrassTintStrength: { value: 0 },
    uSnowCover: { value: 0 },
    uWetness: { value: 0 },
    uOverlay: { value: null },
    uMapBase: { value: null },
    uOverlayStrength: { value: 0 },
    uWorldSize: { value: worldSize },
    uMask: { value: null },
    uSnowLine: { value: 900 },
    uCanopy: { value: new THREE.Color(0.06, 0.12, 0.03) },
    uCanopyDist: { value: 1500 },
  };
}

export function createTerrainMaterial(u: TerrainUniforms, far: boolean): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  mat.name = far ? 'terrain-far' : 'terrain';
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aMat;
varying vec4 vTMat;
varying vec3 vTWorld;
varying float vTUp;`)
      .replace('#include <color_vertex>', `#include <color_vertex>
// colours are stored as sRGB bytes; decode to linear
vColor.rgb = vColor.rgb * (vColor.rgb * (vColor.rgb * 0.305306011 + 0.682171111) + 0.012522878);`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
vTMat = aMat;
vTWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
vTUp = normalize(mat3(modelMatrix) * objectNormal).y;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec3 uGrassTint;
uniform float uGrassTintStrength;
uniform float uSnowCover;
uniform float uWetness;
uniform sampler2D uOverlay;
uniform sampler2D uMapBase;
uniform float uOverlayStrength;
uniform float uWorldSize;
uniform float uSnowLine;
uniform vec3 uCanopy;
uniform float uCanopyDist;
${far ? 'uniform sampler2D uMask;' : ''}
varying vec4 vTMat;
varying vec3 vTWorld;
varying float vTUp;
float tHash(vec2 p) { p = fract(p * vec2(233.34, 851.73)); p += dot(p, p + 23.45); return fract(p.x * p.y); }
float tNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 w = f * f * (3.0 - 2.0 * f);
  return mix(mix(tHash(i), tHash(i + vec2(1.0, 0.0)), w.x), mix(tHash(i + vec2(0.0, 1.0)), tHash(i + vec2(1.0, 1.0)), w.x), w.y);
}`)
      .replace('void main() {', `void main() {
${far ? `if (texture2D(uMask, vTWorld.xz / uWorldSize).r > 0.5) discard;` : ''}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  vec3 base = diffuseColor.rgb;
  float grassW = vTMat.x;
  float forestW = vTMat.w;
  if (uOverlayStrength > 0.001) {
    // rising towards the map: smooth per-cell colours replace the per-triangle mosaic
    vec4 mb = texture2D(uMapBase, vTWorld.xz / uWorldSize);
    base = mix(base, mb.rgb, uOverlayStrength);
    grassW = mix(grassW, 0.8, uOverlayStrength);
    forestW = mix(forestW, smoothstep(0.15, 0.75, mb.a), uOverlayStrength);
  }
  float lum = dot(base, vec3(0.2126, 0.7152, 0.0722));
  base = mix(base, lum * uGrassTint, grassW * uGrassTintStrength);
  // distant woods read as canopy, not as dark floor between sparse far-LOD trees
  float camD = distance(vTWorld, cameraPosition);
  float canopy = forestW * smoothstep(uCanopyDist * 0.3, uCanopyDist * 0.95, camD);
  base = mix(base, uCanopy * (0.9 + 0.2 * tNoise(vTWorld.xz * 0.02)), canopy * 0.7);
  // close to the camera: soft mottling (tufts, trodden patches) so the smooth near ground is not plastic
  float nearG = 1.0 - smoothstep(25.0, 90.0, camD);
  if (nearG > 0.0) {
    float mott = (tNoise(vTWorld.xz * 1.15) - 0.5) * 0.12 + (tNoise(vTWorld.xz * 0.27 + 7.3) - 0.5) * 0.14;
    base *= 1.0 + mott * nearG * (0.45 + 0.55 * grassW);
  }
  // snow: settles on flat, exposed ground first; patchy while thin; always on high peaks
  float flatness = smoothstep(0.55, 0.88, vTUp);
  float n = tNoise(vTWorld.xz * 0.045) * 0.55 + tNoise(vTWorld.xz * 0.19) * 0.3 + tNoise(vTWorld.xz * 0.9) * 0.15;
  float seasonal = smoothstep(1.0 - uSnowCover, 1.0 - uSnowCover + 0.2, n * 0.6 + flatness * 0.4) * flatness * vTMat.y;
  // permanent snow above the snow line clings to everything but sheer faces
  float alt = smoothstep(uSnowLine - 160.0, uSnowLine + 120.0, vTWorld.y + (n - 0.5) * 160.0);
  float snow = max(seasonal, alt * smoothstep(0.3, 0.62, vTUp));
  snow *= smoothstep(-0.3, 0.4, vTWorld.y);
  base = mix(base, vec3(0.86, 0.9, 0.95) + n * 0.06, clamp(snow, 0.0, 1.0));
  // rain: darker, slightly more saturated ground
  float wet = uWetness * vTMat.z * (1.0 - snow);
  base = mix(base, base * base * 1.6, wet * 0.35);
  base *= 1.0 - wet * 0.22;
  if (uOverlayStrength > 0.001) {
    vec4 ov = texture2D(uOverlay, vTWorld.xz / uWorldSize);
    base = mix(base, ov.rgb, ov.a * uOverlayStrength);
  }
  diffuseColor.rgb = base;
}`);
  };
  mat.customProgramCacheKey = () => (far ? 'millennia-terrain-far' : 'millennia-terrain');
  return mat;
}
