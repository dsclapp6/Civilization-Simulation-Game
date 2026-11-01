// Shared materials and the shader patches that make them react to the environment
// (snow, seasonal grass tint, wind, night glow). One instance of each material is shared
// by every asset; per-frame state lives in SharedUniforms, pushed by AssetLibrary.setEnvironment.
import * as THREE from 'three';

export interface SharedUniforms {
  uTime: { value: number };
  /** Normalised world wind direction (x, z). */
  uWindDir: { value: THREE.Vector2 };
  /** Wind strength factor (≈0.15 calm … 1.5 gale). */
  uWindAmp: { value: number };
  uSnow: { value: number };
  uNight: { value: number };
  /** Multiplier applied to turf/grass-flagged faces (seasonal). */
  uGrassTint: { value: THREE.Color };
  uSnowColor: { value: THREE.Color };
}

export function createSharedUniforms(): SharedUniforms {
  return {
    uTime: { value: 0 },
    uWindDir: { value: new THREE.Vector2(1, 0) },
    uWindAmp: { value: 0.3 },
    uSnow: { value: 0 },
    uNight: { value: 0 },
    uGrassTint: { value: new THREE.Color(1, 1, 1) },
    uSnowColor: { value: new THREE.Color(0xe6ebf2) },
  };
}

const GLSL_NOISE = /* glsl */ `
float mlHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float mlNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mlHash(i), mlHash(i + vec2(1.0, 0.0)), u.x), mix(mlHash(i + vec2(0.0, 1.0)), mlHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

/** Snow mask from fragment normal (view space) and world position; returns 0..1. */
const GLSL_SNOW = /* glsl */ `
float mlSnowMask(vec3 nView, vec3 wpos, float snow, float hold) {
  if (snow <= 0.001) return 0.0;
  vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  float upness = dot(nView, upV);
  float n = mlNoise(wpos.xz * 0.55) * 0.65 + mlNoise(wpos.xz * 2.3 + 7.0) * 0.35;
  float cover = smoothstep(n - 0.18, n + 0.18, snow * 1.2 - 0.1);
  return hold * smoothstep(0.2, 0.62, upness) * cover;
}
`;

/**
 * LOD cross-fade of building meshes (x = progress 0..1, y = 0 off, 1 incoming, 2 outgoing). One
 * shared value: the renderer sets it per draw (Mesh.onBeforeRender) and clears it afterwards.
 */
export const BUILDING_FADE = { value: new THREE.Vector2(0, 0) };

function patchBuildingShader(shader: THREE.WebGLProgramParametersWithUniforms, u: SharedUniforms): void {
  shader.uniforms.uSnow = u.uSnow;
  shader.uniforms.uBFade = BUILDING_FADE;
  shader.uniforms.uGrassTint = u.uGrassTint;
  shader.uniforms.uSnowColor = u.uSnowColor;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
attribute vec2 aSurf;
varying vec2 vSurf;
varying vec3 vWPos;`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>
vSurf = aSurf;
{
  vec4 mlW = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
  mlW = instanceMatrix * mlW;
  #endif
  vWPos = (modelMatrix * mlW).xyz;
}`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
uniform float uSnow;
uniform vec3 uGrassTint;
uniform vec3 uSnowColor;
uniform vec2 uBFade;
varying vec2 vSurf;
varying vec3 vWPos;
${GLSL_NOISE}
${GLSL_SNOW}`)
    .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
if (uBFade.y > 0.5) {
  // screen-door LOD cross-fade: the incoming model takes the pattern cells below the progress,
  // the outgoing one keeps the rest, so the pair always covers the building exactly once
  vec2 bfc = mod(floor(gl_FragCoord.xy), 4.0);
  float bth = mod(bfc.x * 4.0 + bfc.y * 7.0, 16.0) / 16.0 + 1.0 / 32.0;
  if (uBFade.y < 1.5 ? bth > uBFade.x : bth <= uBFade.x) discard;
}`)
    .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
diffuseColor.rgb *= mix(vec3(1.0), uGrassTint, vSurf.y);
diffuseColor.rgb = mix(diffuseColor.rgb, uSnowColor, mlSnowMask(normal, vWPos, uSnow, vSurf.x));`);
}

/** Opaque vertex-coloured, flat-shaded surface for buildings and props. */
export function createOpaqueMaterial(u: SharedUniforms, doubleSided: boolean): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.9,
    metalness: 0,
    side: doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  });
  m.name = doubleSided ? 'ml-opaque-ds' : 'ml-opaque';
  m.onBeforeCompile = (s) => patchBuildingShader(s, u);
  m.customProgramCacheKey = () => 'ml-building';
  return m;
}

/** Window panes: dark by day; emissive glow (vertex colour × level × night) at night. */
export function createWindowMaterial(u: SharedUniforms, glow: { value: number }): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: 0x1d1814,
    vertexColors: true,
    flatShading: true,
    roughness: 0.5,
    metalness: 0,
  });
  m.name = 'ml-window';
  m.onBeforeCompile = (s) => {
    s.uniforms.uGlow = glow;
    s.uniforms.uSnow = u.uSnow;
    s.uniforms.uBFade = BUILDING_FADE;
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uGlow;
uniform vec2 uBFade;`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
if (uBFade.y > 0.5) {
  // screen-door LOD cross-fade: the incoming model takes the pattern cells below the progress,
  // the outgoing one keeps the rest, so the pair always covers the building exactly once
  vec2 bfc = mod(floor(gl_FragCoord.xy), 4.0);
  float bth = mod(bfc.x * 4.0 + bfc.y * 7.0, 16.0) / 16.0 + 1.0 / 32.0;
  if (uBFade.y < 1.5 ? bth > uBFade.x : bth <= uBFade.x) discard;
}`)
      .replace('#include <color_fragment>', '')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += vColor.rgb * uGlow;`);
  };
  m.customProgramCacheKey = () => 'ml-window';
  return m;
}

/** Fire/forge glow: unlit vertex colour with flicker, brighter than 1 so bloom can catch it. */
export function createGlowMaterial(u: SharedUniforms): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ vertexColors: true });
  m.name = 'ml-glow';
  m.onBeforeCompile = (s) => {
    s.uniforms.uTime = u.uTime;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>
varying vec3 vGPos;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  vec4 mlW = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
  mlW = instanceMatrix * mlW;
  #endif
  vGPos = (modelMatrix * mlW).xyz;
}`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uTime;
varying vec3 vGPos;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  float ph = dot(vGPos, vec3(1.7, 2.3, 1.3));
  float fl = 0.78 + 0.14 * sin(uTime * 9.0 + ph) + 0.08 * sin(uTime * 23.0 + ph * 3.1);
  diffuseColor.rgb *= fl * 1.9;
}`);
  };
  m.customProgramCacheKey = () => 'ml-glow';
  return m;
}

const GLSL_CLOTH_VERTEX = /* glsl */ `
{
  vec4 mlO = vec4(0.0, 0.0, 0.0, 1.0);
  #ifdef USE_INSTANCING
  mlO = instanceMatrix * mlO;
  #endif
  vec3 wO = (modelMatrix * mlO).xyz;
  float ph = dot(wO.xz, vec2(0.31, 0.23));
  float a = aSway * (0.35 + uWindAmp * 0.65);
  float k = transformed.x * 2.2 + transformed.y * 0.7;
  transformed.z += sin(uTime * 5.5 - k + ph) * 0.09 * a + sin(uTime * 9.1 - k * 1.9 + ph) * 0.035 * a;
  transformed.y += sin(uTime * 4.3 - k + ph) * 0.03 * a;
}
`;

/** Flags, banners, awnings, tents, sails: double-sided cloth with a travelling wave (aSway = free-edge weight). */
export function createClothMaterial(u: SharedUniforms): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.95,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  m.name = 'ml-cloth';
  m.onBeforeCompile = (s) => {
    patchBuildingShader(s, u);
    s.uniforms.uTime = u.uTime;
    s.uniforms.uWindAmp = u.uWindAmp;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>
uniform float uTime;
uniform float uWindAmp;
attribute float aSway;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
${GLSL_CLOTH_VERTEX}`);
  };
  m.customProgramCacheKey = () => 'ml-cloth';
  return m;
}

/** Depth material matching the cloth wave so flags cast moving shadows. */
export function createClothDepthMaterial(u: SharedUniforms): THREE.MeshDepthMaterial {
  const m = new THREE.MeshDepthMaterial({ side: THREE.DoubleSide });
  m.onBeforeCompile = (s) => {
    s.uniforms.uTime = u.uTime;
    s.uniforms.uWindAmp = u.uWindAmp;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>
uniform float uTime;
uniform float uWindAmp;
attribute float aSway;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
${GLSL_CLOTH_VERTEX}`);
  };
  m.customProgramCacheKey = () => 'ml-cloth-depth';
  return m;
}

/** Small water surfaces inside models (mill races, wells, vats): glossy with a slow shimmer. */
export function createWaterMaterial(u: SharedUniforms): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.12, metalness: 0.0, flatShading: false });
  m.name = 'ml-water';
  m.onBeforeCompile = (s) => {
    s.uniforms.uTime = u.uTime;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>
varying vec3 vWWater;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vWWater = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uTime;
varying vec3 vWWater;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  float r = sin(vWWater.x * 3.1 + uTime * 1.7) * sin(vWWater.z * 2.7 - uTime * 1.3);
  diffuseColor.rgb *= 0.92 + 0.12 * r;
}`);
  };
  m.customProgramCacheKey = () => 'ml-water';
  return m;
}

// ---------------------------------------------------------------------------
// Vegetation

/** Per-kind seasonal state (CPU-side phenology output). */
export interface FoliageState {
  tintA: THREE.Color;
  tintB: THREE.Color;
  leafiness: number;
  blossom: number;
  blossomColor: THREE.Color;
  fruit: number;
  fruitColor: THREE.Color;
  /** How much snow foliage holds (conifers high). */
  snowHold: number;
}

export interface FoliageUniforms {
  uTintA: { value: THREE.Color };
  uTintB: { value: THREE.Color };
  uLeafiness: { value: number };
  uBlossom: { value: number };
  uBlossomColor: { value: THREE.Color };
  uFruit: { value: number };
  uFruitColor: { value: THREE.Color };
  uSnowHold: { value: number };
}

export function createFoliageUniforms(): FoliageUniforms {
  return {
    uTintA: { value: new THREE.Color(0x6f9e3a) },
    uTintB: { value: new THREE.Color(0x6f9e3a) },
    uLeafiness: { value: 1 },
    uBlossom: { value: 0 },
    uBlossomColor: { value: new THREE.Color(0xf6e8ee) },
    uFruit: { value: 0 },
    uFruitColor: { value: new THREE.Color(0xb3261e) },
    uSnowHold: { value: 0.6 },
  };
}

const GLSL_VEG_VERTEX_PARS = /* glsl */ `
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindAmp;
uniform float uLeafiness;
uniform float uBlossom;
attribute float aSway;
attribute float aLeaf;
attribute vec3 aCenter;
varying float vLeaf;
varying float vInst;
varying vec3 vWPos;
varying float vLodDist;
`;

const GLSL_VEG_VERTEX = /* glsl */ `
{
  vec3 instO = vec3(0.0);
  mat3 instR = mat3(1.0);
  #ifdef USE_INSTANCING
  instO = instanceMatrix[3].xyz;
  instR = mat3(instanceMatrix);
  #endif
  vec3 wO = (modelMatrix * vec4(instO, 1.0)).xyz;
  vInst = fract(sin(dot(wO.xz, vec2(12.9898, 78.233))) * 43758.5453);
  vLodDist = distance(wO.xz, cameraPosition.xz);
  vLeaf = aLeaf;
  if (aLeaf >= 2.0) {
    // Petals (wildflowers): open with the blossom season.
    float pr = fract(aLeaf * 1.618 + vInst * 0.37);
    float keep = smoothstep(pr * 0.7, pr * 0.7 + 0.3, uBlossom);
    transformed = aCenter + (transformed - aCenter) * keep;
  } else if (aLeaf >= 0.0) {
    // Leaf fall / bud burst: faces shrink into their clump centre, highest aLeaf first.
    float lr = fract(aLeaf * 1.618 + vInst * 0.37);
    // Surviving faces also shrink as the canopy thins, so winter leaves read as small tufts.
    float keep = smoothstep(lr * 0.8, lr * 0.8 + 0.2, uLeafiness) * (0.3 + 0.7 * smoothstep(0.12, 0.65, uLeafiness));
    transformed = aCenter + (transformed - aCenter) * keep;
  }
  float ph = uTime * (1.15 + vInst * 0.5) + dot(wO.xz, vec2(0.21, 0.17));
  float gust = 0.7 + 0.3 * sin(uTime * 0.41 + wO.x * 0.017 + wO.z * 0.013);
  float sw = aSway * uWindAmp * gust;
  vec3 wd = transpose(instR) * vec3(uWindDir.x, 0.0, uWindDir.y);
  float wl = length(wd);
  wd = wl > 1e-5 ? wd / wl : vec3(0.0);
  vec3 wp = vec3(-wd.z, 0.0, wd.x);
  transformed += wd * sw * (0.55 + 0.45 * sin(ph)) + wp * sw * 0.22 * sin(ph * 1.63 + 1.3);
  if (aLeaf >= 0.0) transformed.y += sin(ph * 3.3 + aLeaf * 40.0) * 0.025 * sw;
  vec4 mlW = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
  mlW = instanceMatrix * mlW;
  #endif
  vWPos = (modelMatrix * mlW).xyz;
}
`;

function bindVegUniforms(s: THREE.WebGLProgramParametersWithUniforms, u: SharedUniforms, f: FoliageUniforms): void {
  s.uniforms.uTime = u.uTime;
  s.uniforms.uNight = u.uNight;
  s.uniforms.uWindDir = u.uWindDir;
  s.uniforms.uWindAmp = u.uWindAmp;
  s.uniforms.uSnow = u.uSnow;
  s.uniforms.uSnowColor = u.uSnowColor;
  s.uniforms.uLeafiness = f.uLeafiness;
  s.uniforms.uTintA = f.uTintA;
  s.uniforms.uTintB = f.uTintB;
  s.uniforms.uBlossom = f.uBlossom;
  s.uniforms.uBlossomColor = f.uBlossomColor;
  s.uniforms.uFruit = f.uFruit;
  s.uniforms.uFruitColor = f.uFruitColor;
  s.uniforms.uSnowHold = f.uSnowHold;
}

/**
 * Vegetation material: Lambert, flat-shaded, vertex colours, wind sway, seasonal tint,
 * leaf fall, blossom, fruit and snow. Faces with aLeaf ≥ 0 are foliage: their vertex colour
 * is a shade multiplier on the seasonal tint; other faces (bark, rock) keep their colour.
 */
export function createVegetationMaterial(u: SharedUniforms, f: FoliageUniforms, doubleSided = false, soft = false): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: !soft, side: doubleSided ? THREE.DoubleSide : THREE.FrontSide });
  m.name = soft ? 'ml-vegetation-soft' : 'ml-vegetation';
  // Distance cross-fade window (x..y fades in, z..w fades out, metres from the camera, per
  // instance) for LOD bands: the renderer sets it per draw (onBeforeRender) and resets it after.
  const lodFade = { value: new THREE.Vector4(...LOD_FADE_NONE) };
  m.userData.lodFade = lodFade;
  m.onBeforeCompile = (s) => {
    bindVegUniforms(s, u, f);
    s.uniforms.uLodFade = lodFade;
    if (soft) {
      // Thin plants keep their up-bent normals on both sides so they light like the ground.
      s.fragmentShader = s.fragmentShader.replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''));
      // ...but their pale blades caught the moon and sky fill and glowed over the dark ground at
      // night: dim them with the night level
      s.fragmentShader = s.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ndiffuseColor.rgb *= 1.0 - uNight * 0.45;');
    }
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>
${GLSL_VEG_VERTEX_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
${GLSL_VEG_VERTEX}`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uSnow;
uniform vec3 uSnowColor;
uniform vec3 uTintA;
uniform vec3 uTintB;
uniform float uBlossom;
uniform vec3 uBlossomColor;
uniform float uFruit;
uniform vec3 uFruitColor;
uniform float uSnowHold;
varying float vLeaf;
varying float vInst;
varying vec3 vWPos;
uniform vec4 uLodFade;
uniform float uNight;
varying float vLodDist;
${GLSL_NOISE}
${GLSL_SNOW}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
{
  // dithered LOD cross-fade: a 4x4 ordered pattern; the fading-out band keeps the cells below
  // its weight and the fading-in band the complementary cells, so a tree is never see-through
  float lfIn = smoothstep(uLodFade.x, uLodFade.y, vLodDist);
  float lfOut = 1.0 - smoothstep(uLodFade.z, uLodFade.w, vLodDist);
  if (lfIn * lfOut < 0.999) {
    vec2 fc = mod(floor(gl_FragCoord.xy), 4.0);
    float bayer = mod(fc.x * 4.0 + fc.y * 7.0, 16.0) / 16.0 + 1.0 / 32.0;
    if (bayer >= lfOut || bayer < 1.0 - lfIn) discard;
  }
}`)
      .replace('#include <color_fragment>', `
{
  vec3 base = vColor.rgb;
  float iv = 0.9 + 0.2 * fract(vInst * 7.77);
  if (vLeaf >= 2.0) {
    // Wildflower petals: poppy, cornflower, ox-eye daisy, buttercup, campion by instance.
    float k = fract(vInst * 3.31 + floor(vLeaf * 3.0) * 0.37);
    vec3 pc = k < 0.22 ? vec3(0.78, 0.06, 0.04) : k < 0.42 ? vec3(0.16, 0.26, 0.85) : k < 0.66 ? vec3(0.92, 0.9, 0.84) : k < 0.86 ? vec3(0.95, 0.72, 0.05) : vec3(0.75, 0.22, 0.45);
    // flowers lose their colour in the dark instead of glowing in the grass
    diffuseColor.rgb *= mix(pc * base, vec3(dot(pc * base, vec3(0.3, 0.55, 0.15))), uNight * 0.7) * (1.0 - uNight * 0.45);
  } else if (vLeaf >= 0.0) {
    vec3 tint = mix(uTintA, uTintB, smoothstep(0.15, 0.85, vInst));
    vec3 c = tint * base * iv;
    float rb = fract(vLeaf * 7.31 + vInst * 3.7);
    c = mix(c, uBlossomColor * (0.85 + 0.3 * base.g), step(rb, uBlossom));
    float rf = fract(vLeaf * 13.7 + vInst * 1.9);
    c = mix(c, uFruitColor * (0.8 + 0.3 * base.g), step(rf, uFruit));
    diffuseColor.rgb *= c;
  } else {
    diffuseColor.rgb *= base * (0.94 + 0.12 * fract(vInst * 5.3));
  }
}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
diffuseColor.rgb = mix(diffuseColor.rgb, uSnowColor, mlSnowMask(normal, vWPos, uSnow, vLeaf >= 0.0 ? uSnowHold : 0.85));`);
  };
  m.customProgramCacheKey = () => (soft ? 'ml-vegetation-soft' : 'ml-vegetation');
  return m;
}

/** uLodFade value meaning "always drawn". */
export const LOD_FADE_NONE: [number, number, number, number] = [-2, -1, 1e9, 2e9];

/** Depth material for vegetation shadows that follows sway and leaf fall. */
export function createVegetationDepthMaterial(u: SharedUniforms, f: FoliageUniforms, doubleSided = false): THREE.MeshDepthMaterial {
  const m = new THREE.MeshDepthMaterial({ side: doubleSided ? THREE.DoubleSide : THREE.FrontSide });
  m.onBeforeCompile = (s) => {
    bindVegUniforms(s, u, f);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>
${GLSL_VEG_VERTEX_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
${GLSL_VEG_VERTEX}`);
  };
  m.customProgramCacheKey = () => 'ml-vegetation-depth';
  return m;
}
