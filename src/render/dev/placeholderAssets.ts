// Dev stand-in for the asset library (src/assets). Implements the AssetLibrary contract with
// simple flat-coloured low-poly shapes so the renderer can be developed against the contract.
// Only src/render/dev/assetSource.ts imports this; the integrator swaps that one line.
import * as THREE from 'three';
import { BUILDINGS, type BuildingKind } from '../../content/types';
import type { AnimalKind, CropKind, CultureId } from '../../core/domain';
import { hash01 } from '../../core/math';
import type { AnimalDrawItem, CharacterDrawItem, FxEvent, ProjectileDrawItem } from '../../core/view';
import { PALETTE } from '../../assets/palette';
import type {
  AnimalLayer, AssetEnvironment, AssetLibrary, BuildingAsset, BuildingRequest, CharacterLayer,
  FxLayer, InstancedKit, PropKind, ProjectileLayer,
} from '../../assets/types';
import type { ScatterKind } from '../../world/types';
import { MeshKit, gableGeometry, pyramidGeometry } from './meshKit';

const P = PALETTE;

function shade(hex: number, f: number): number {
  const r = Math.min(255, Math.round(((hex >> 16) & 255) * f));
  const g = Math.min(255, Math.round(((hex >> 8) & 255) * f));
  const b = Math.min(255, Math.round((hex & 255) * f));
  return (r << 16) | (g << 8) | b;
}
function mix(a: number, b: number, t: number): number {
  const r = ((a >> 16) & 255) * (1 - t) + ((b >> 16) & 255) * t;
  const g = ((a >> 8) & 255) * (1 - t) + ((b >> 8) & 255) * t;
  const bl = (a & 255) * (1 - t) + (b & 255) * t;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
}

const box = (w: number, h: number, d: number) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(0, h / 2, 0); return g; };
const cyl = (rt: number, rb: number, h: number, seg = 6) => { const g = new THREE.CylinderGeometry(rt, rb, h, seg); g.translate(0, h / 2, 0); return g; };
const cone = (r: number, h: number, seg = 6) => { const g = new THREE.ConeGeometry(r, h, seg); g.translate(0, h / 2, 0); return g; };
const ico = (r: number, detail = 0) => new THREE.IcosahedronGeometry(r, detail);

// ------------------------------------------------------------------------------------------
// Shared materials

interface VegUniforms {
  uTime: { value: number };
  uWind: { value: THREE.Vector2 };
  uTint: { value: THREE.Color };
  uSnow: { value: number };
  uBare: { value: number };
}

function createVegetationMaterial(u: VegUniforms): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aFoliage;
uniform float uTime; uniform vec2 uWind; uniform vec3 uTint; uniform float uSnow; uniform float uBare;
varying float vFoliage; varying float vUp;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vFoliage = aFoliage;
vUp = normal.y;
float swayPhase = 0.0;
#ifdef USE_INSTANCING
swayPhase = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.23;
#endif
float sway = max(position.y, 0.0) * 0.012 * (0.4 + length(uWind) * 0.25);
transformed.x += sway * (sin(uTime * 1.7 + swayPhase) + uWind.x * 0.3);
transformed.z += sway * (cos(uTime * 1.3 + swayPhase * 1.3) + uWind.y * 0.3);
transformed *= 1.0 - uBare * aFoliage * 0.35;`)
      .replace('#include <color_vertex>', `#include <color_vertex>
vColor.rgb = mix(vColor.rgb, vColor.rgb * uTint * 1.6, aFoliage);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uSnow; varying float vFoliage; varying float vUp;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.95, 0.98), uSnow * smoothstep(0.25, 0.8, vUp) * 0.85);`);
  };
  mat.customProgramCacheKey = () => 'placeholder-veg';
  return mat;
}

// ------------------------------------------------------------------------------------------
// Buildings

interface Look { wall: number; roof: number; trim: number; stone: boolean; roofPitch: number }

function cultureLook(culture: CultureId, kind: BuildingKind, seed: number): Look {
  const v = hash01(seed, 3);
  const town = kind === 'townhouse' || kind === 'guildhall' || kind === 'tavern' || kind === 'market_hall' || kind === 'warehouse';
  switch (culture) {
    case 'norse': return { wall: shade(P.timber, 1.3), roof: 0x6f7a3e, trim: P.timber, stone: false, roofPitch: 0.5 };
    case 'teuton': return { wall: P.daub, roof: town || v < 0.6 ? P.roofTile : P.thatch, trim: P.timber, stone: false, roofPitch: 0.75 };
    case 'franc': return { wall: mix(P.daub, P.stone, 0.4), roof: v < 0.5 ? P.slate : P.roofTile, trim: P.timber, stone: v < 0.3, roofPitch: 0.85 };
    case 'gael':
    case 'cymric': return { wall: P.stone, roof: v < 0.75 ? P.thatch : P.slate, trim: shade(P.timber, 0.9), stone: true, roofPitch: 0.6 };
    default: return { wall: P.daub, roof: town ? (v < 0.5 ? P.roofTile : P.slate) : P.thatch, trim: P.timber, stone: false, roofPitch: 0.62 };
  }
}

interface BuiltParts {
  body: MeshKit;
  windows: { x: number; y: number; z: number; w: number; h: number; ry: number }[];
  chimney?: THREE.Vector3;
  moving?: { geo: THREE.BufferGeometry; pos: THREE.Vector3; axis: 'x' | 'z'; speed: number };
  height: number;
}

function houseBody(k: MeshKit, w: number, d: number, wallH: number, look: Look, jetty = false): number {
  const wall = look.wall;
  k.add(box(w, 0.35, d), shade(look.stone ? P.stone : P.timber, 0.85));
  k.add(box(w - 0.1, wallH, d - 0.1), wall, { y: 0.0 });
  if (!look.stone) {
    // timber framing: corner posts and a mid rail
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.add(box(0.28, wallH, 0.28), look.trim, { x: sx * (w / 2 - 0.1), z: sz * (d / 2 - 0.1) });
    k.add(box(w + 0.02, 0.2, d + 0.02), look.trim, { y: wallH * 0.52 });
    k.add(box(w + 0.02, 0.22, d + 0.02), look.trim, { y: wallH - 0.2 });
    for (let i = 1; i < Math.floor(w / 2.2); i++) {
      const x = -w / 2 + i * (w / Math.floor(w / 2.2));
      k.add(box(0.2, wallH, d + 0.03), look.trim, { x });
    }
  }
  let top = wallH;
  if (jetty) {
    k.add(box(w + 0.6, wallH * 0.85, d + 0.8), wall, { y: wallH });
    k.add(box(w + 0.62, 0.2, d + 0.82), look.trim, { y: wallH });
    top = wallH * 1.85;
  }
  // roof with overhang, ridge along the longer axis
  const span = Math.min(w, d) + 0.9, len = Math.max(w, d) + 0.9;
  const rh = span * look.roofPitch * 0.55;
  const roof = gableGeometry(span, len, rh);
  k.add(roof, look.roof, { y: top, ry: w > d ? Math.PI / 2 : 0 });
  // door on +z
  k.add(box(1.0, 1.9, 0.12), shade(P.timber, 0.7), { z: d / 2 + 0.02 });
  return top + rh;
}

function buildParts(req: BuildingRequest): BuiltParts {
  const def = BUILDINGS[req.kind];
  const look = cultureLook(req.culture, req.kind, req.seed);
  const k = new MeshKit();
  const w = def.w, d = def.d;
  const lvl = Math.max(1, req.level);
  const windows: BuiltParts['windows'] = [];
  let chimney: THREE.Vector3 | undefined;
  let moving: BuiltParts['moving'];
  let height = 4;
  const stone = P.stone;
  const addWindows = (wallH: number, y0: number, count: number) => {
    for (let i = 0; i < count; i++) {
      const x = -w / 2 + ((i + 0.5) / count) * w;
      windows.push({ x, y: y0 + wallH * 0.45, z: d / 2 + 0.06, w: 0.6, h: 0.7, ry: 0 });
      windows.push({ x, y: y0 + wallH * 0.45, z: -d / 2 - 0.06, w: 0.6, h: 0.7, ry: 0 });
    }
  };
  switch (req.kind) {
    case 'church': case 'chapel': case 'abbey_church': case 'cathedral': {
      const big = req.kind === 'cathedral' || req.kind === 'abbey_church';
      const wallH = big ? 13 : req.kind === 'chapel' ? 5 : 6.5;
      const naveW = w * 0.72;
      k.add(box(naveW, wallH, d), stone, { x: w * 0.1 });
      k.add(gableGeometry(d + 0.6, naveW + 0.6, d * 0.55), P.slate, { x: w * 0.1, y: wallH, ry: Math.PI / 2 });
      // chancel
      k.add(box(w * 0.2, wallH * 0.8, d * 0.7), shade(stone, 0.95), { x: w * 0.5 - w * 0.06 });
      k.add(gableGeometry(d * 0.7 + 0.4, w * 0.2 + 0.4, d * 0.4), P.slate, { x: w * 0.5 - w * 0.06, y: wallH * 0.8, ry: Math.PI / 2 });
      if (req.kind !== 'chapel') {
        const tw = big ? d * 0.55 : Math.min(5.5, d * 0.65);
        const th = big ? 34 : 15 + lvl * 2;
        k.add(box(tw, th, tw), shade(stone, 0.92), { x: -w / 2 + tw / 2 });
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.add(box(0.7, 1.2, 0.7), shade(stone, 0.9), { x: -w / 2 + tw / 2 + sx * (tw / 2 - 0.35), y: th, z: sz * (tw / 2 - 0.35) });
        k.add(pyramidGeometry(tw * 0.8, tw * 0.8, big ? 14 : 7), P.slate, { x: -w / 2 + tw / 2, y: th });
        height = th + (big ? 14 : 7);
        windows.push({ x: -w / 2 + tw / 2, y: th - 3, z: tw / 2 + 0.05, w: 0.6, h: 1.4, ry: 0 });
      } else height = wallH + d * 0.55;
      for (let i = 0; i < 4; i++) {
        const x = w * 0.1 - naveW / 2 + ((i + 0.5) / 4) * naveW;
        windows.push({ x, y: wallH * 0.5, z: d / 2 + 0.06, w: 0.7, h: wallH * 0.35, ry: 0 });
        windows.push({ x, y: wallH * 0.5, z: -d / 2 - 0.06, w: 0.7, h: wallH * 0.35, ry: 0 });
      }
      break;
    }
    case 'keep_stone': case 'tower': case 'wall': case 'gatehouse': {
      const h = req.kind === 'keep_stone' ? 16 + lvl * 3 : req.kind === 'wall' ? 7 : req.kind === 'gatehouse' ? 11 : 11;
      const ww = req.kind === 'wall' ? w + 0.2 : w;
      if (req.kind === 'gatehouse') {
        k.add(box(w * 0.32, h, d), stone, { x: -w * 0.34 });
        k.add(box(w * 0.32, h, d), stone, { x: w * 0.34 });
        k.add(box(w * 0.4, h * 0.42, d * 0.9), shade(stone, 0.95), { y: h * 0.58 });
      } else {
        k.add(box(ww, h, d), stone);
      }
      const merl = Math.max(2, Math.round(ww / 1.4));
      for (let i = 0; i < merl; i++) {
        const x = -ww / 2 + (i + 0.5) * (ww / merl);
        k.add(box(0.7, 1.0, 0.6), shade(stone, 0.92), { x, y: h, z: d / 2 - 0.3 });
        k.add(box(0.7, 1.0, 0.6), shade(stone, 0.92), { x, y: h, z: -d / 2 + 0.3 });
      }
      if (req.kind === 'keep_stone') {
        for (let i = 0; i < 3; i++) windows.push({ x: -w / 4 + i * (w / 4), y: h * 0.6, z: d / 2 + 0.06, w: 0.5, h: 1.2, ry: 0 });
        if (req.ownerColor !== undefined) {
          k.add(cyl(0.06, 0.06, 5, 4), P.timber, { y: h });
          k.add(box(1.6, 1.0, 0.05), req.ownerColor, { x: 0.8, y: h + 3.8 });
        }
      }
      height = h + 1;
      break;
    }
    case 'palisade': {
      for (let i = 0; i < 8; i++) k.add(cyl(0.22, 0.25, 4 + hash01(req.seed, i) * 0.8, 5), shade(P.timber, 1.1), { x: -w / 2 + (i + 0.5) * (w / 8) });
      height = 4.8;
      break;
    }
    case 'motte': {
      k.add(cone(w * 0.5, 8, 10), 0x6d7d3e, { sy: 1 });
      k.add(box(6, 7, 6), shade(P.timber, 1.15), { y: 6.5 });
      k.add(pyramidGeometry(6.6, 6.6, 3), P.thatch, { y: 13.5 });
      height = 16.5;
      break;
    }
    case 'windmill': {
      k.add(cone(2.2, 2.4, 8), shade(stone, 0.9));
      k.add(cyl(0.3, 0.3, 4, 6), P.timber, { y: 1.5 });
      k.add(box(3.4, 4.2, 4.0), shade(P.timber, 1.25), { y: 4.6 });
      k.add(gableGeometry(3.8, 4.4, 1.6), shade(P.timber, 0.9), { y: 8.8 });
      const sails = new MeshKit();
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        sails.add(box(0.25, 6.5, 0.12), P.timber, { rz: a, x: Math.sin(-a) * 0, y: 0 });
        sails.add(box(1.4, 5.2, 0.05), P.daub, { rz: a, x: Math.cos(a) * 0.75, y: Math.sin(a) * 0.75 + 0, z: -0.08 });
      }
      moving = { geo: sails.build(), pos: new THREE.Vector3(0, 7.2, 2.15), axis: 'z', speed: 0.9 };
      height = 14;
      break;
    }
    case 'watermill': {
      height = houseBody(k, w * 0.85, d, 3.4 + lvl * 0.3, { ...look, stone: true, wall: stone });
      const wheel = new MeshKit();
      wheel.add(new THREE.CylinderGeometry(2.6, 2.6, 0.9, 12, 1, true), shade(P.timber, 1.1), { rz: Math.PI / 2 });
      for (let i = 0; i < 6; i++) wheel.add(box(0.15, 5.0, 0.8), P.timber, { rx: (i / 6) * Math.PI, y: -2.5 });
      moving = { geo: wheel.build(), pos: new THREE.Vector3(w * 0.5 + 0.3, 1.6, 0), axis: 'x', speed: -0.8 };
      chimney = new THREE.Vector3(-w * 0.3, height, 0);
      addWindows(3.4, 0, 2);
      break;
    }
    case 'well': {
      k.add(cyl(0.9, 1.0, 0.9, 8), stone);
      k.add(box(0.15, 2.2, 0.15), P.timber, { x: -0.8 });
      k.add(box(0.15, 2.2, 0.15), P.timber, { x: 0.8 });
      k.add(gableGeometry(2.2, 1.6, 0.7), P.thatch, { y: 2.1, ry: Math.PI / 2 });
      height = 2.8;
      break;
    }
    case 'market_stall': {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.add(box(0.12, 2.2, 0.12), P.timber, { x: sx * 1.3, z: sz * 0.8 });
      k.add(box(2.6, 0.8, 1.6), shade(P.timber, 1.2));
      k.add(gableGeometry(2.0, 3.0, 0.5), [0xb03a2e, 0x2e5fa8, 0xd8b04a, 0x3f8a46][Math.floor(hash01(req.seed) * 4)], { y: 2.2, ry: Math.PI / 2 });
      height = 2.7;
      break;
    }
    case 'market_cross': {
      k.add(box(3.6, 0.4, 3.6), stone); k.add(box(2.6, 0.4, 2.6), stone, { y: 0.4 });
      k.add(box(0.5, 4.2, 0.5), stone, { y: 0.8 }); k.add(box(1.6, 0.4, 0.4), stone, { y: 4.2 });
      height = 5;
      break;
    }
    case 'stocks': case 'gallows': case 'archery_butts': case 'training_yard': case 'sawpit': case 'quarry':
    case 'sheepfold': case 'dock': case 'charcoal_mound': case 'kiln': case 'mine': case 'tent': case 'henhouse':
    case 'dovecote': case 'pigsty': {
      switch (req.kind) {
        case 'archery_butts':
          for (let i = 0; i < 3; i++) { const x = -6 + i * 6; k.add(box(3, 1.6, 2.4), 0x6d7d3e, { x }); k.add(cyl(0.7, 0.7, 0.2, 10), 0xd8c48e, { x, y: 1.6, z: 0.0, rx: Math.PI / 2 }); }
          height = 2.4; break;
        case 'sheepfold': case 'training_yard':
          for (let i = 0; i < 20; i++) {
            const a = (i / 20) * Math.PI * 2;
            k.add(box(1.0 + w * 0.15, req.kind === 'sheepfold' ? 0.9 : 1.1, 0.4), req.kind === 'sheepfold' ? stone : P.timber, { x: Math.cos(a) * w * 0.45, z: Math.sin(a) * d * 0.45, ry: -a + Math.PI / 2 });
          }
          height = 1.2; break;
        case 'quarry': for (let i = 0; i < 6; i++) k.add(ico(1.5 + hash01(req.seed, i) * 2), shade(stone, 0.9), { x: (hash01(req.seed, i, 1) - 0.5) * w, z: (hash01(req.seed, i, 2) - 0.5) * d, sy: 0.6 }); height = 3; break;
        case 'dock': k.add(box(w, 0.3, d), shade(P.timber, 1.15), { y: 0.6 }); for (let i = 0; i < 6; i++) k.add(cyl(0.18, 0.18, 2.4, 5), P.timber, { x: -w / 2 + i * (w / 5), z: d / 2 - 0.3, y: -1.6 }); height = 1; break;
        case 'charcoal_mound': case 'kiln': k.add(new THREE.SphereGeometry(w * 0.45, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), req.kind === 'kiln' ? 0xa8553a : 0x3a332c); height = w * 0.45; break;
        case 'mine': k.add(box(w, 2.6, d), shade(stone, 0.8)); k.add(box(1.8, 2.0, 0.3), 0x1a1612, { z: d / 2 }); height = 2.6; break;
        case 'tent': k.add(cone(w * 0.55, 2.8, 6), 0xd8cfb4); height = 2.8; break;
        default: height = houseBody(k, w, d, req.kind === 'dovecote' ? 3.5 : 1.6, look); break;
      }
      break;
    }
    default: {
      const cat = def.cat;
      const tall = req.kind === 'townhouse' || req.kind === 'guildhall';
      const wallH = (cat === 'farm' ? 3.6 : req.kind === 'manor_house' || req.kind === 'great_hall' ? 4.6 : 2.6) + (lvl - 1) * 0.5 + (tall ? 0.6 : 0);
      height = houseBody(k, w, d, wallH, look, tall);
      if (cat === 'home' || cat === 'social' || req.kind === 'smithy' || req.kind === 'bakehouse' || req.kind === 'brewhouse' || req.kind === 'great_hall') {
        const cx = w > d ? w / 2 - 1.0 : 0, cz = w > d ? 0 : d / 2 - 1.0;
        const ch = height + 0.9;
        k.add(box(0.8, ch, 0.8), shade(stone, 0.85), { x: cx * 0.8, z: cz * 0.8 });
        chimney = new THREE.Vector3(cx * 0.8, ch + 0.2, cz * 0.8);
      }
      if (cat !== 'farm') addWindows(wallH, 0, Math.max(1, Math.round(w / 3.2)));
      if (tall) addWindows(wallH * 0.85, wallH, Math.max(1, Math.round(w / 2.6)));
      break;
    }
  }
  return { body: k, windows, chimney, moving, height };
}

const windowGeo = new THREE.BoxGeometry(1, 1, 0.08);
const darkWindow = new THREE.Color(0x231c16);
const litWindow = new THREE.Color(0xffa040);

function createBuilding(req: BuildingRequest, bodyMat: THREE.Material): BuildingAsset {
  const parts = buildParts(req);
  const def = BUILDINGS[req.kind];
  const group = new THREE.Group();
  group.name = `building:${req.kind}`;
  const construction = req.construction ?? 1;
  const damage = req.damage ?? 0;
  const geo = parts.body.build();
  if (damage > 0) {
    const c = geo.getAttribute('color') as THREE.BufferAttribute;
    for (let i = 0; i < c.count; i++) c.setXYZ(i, c.getX(i) * (1 - damage * 0.55), c.getY(i) * (1 - damage * 0.6), c.getZ(i) * (1 - damage * 0.62));
  }
  const body = new THREE.Mesh(geo, bodyMat);
  body.castShadow = true;
  body.receiveShadow = true;
  if (construction < 1) body.scale.y = Math.max(0.15, construction);
  group.add(body);
  if (construction < 1) {
    const sk = new MeshKit();
    const h = parts.height * 1.05;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) sk.add(box(0.12, h, 0.12), shade(P.timber, 1.2), { x: sx * (def.w / 2 + 0.6), z: sz * (def.d / 2 + 0.6) });
    for (let y = 1.5; y < h; y += 1.8) {
      sk.add(box(def.w + 1.4, 0.1, 0.1), shade(P.timber, 1.2), { y, z: def.d / 2 + 0.6 });
      sk.add(box(def.w + 1.4, 0.1, 0.1), shade(P.timber, 1.2), { y, z: -def.d / 2 - 0.6 });
    }
    const scaffold = new THREE.Mesh(sk.build(), bodyMat);
    scaffold.castShadow = true;
    group.add(scaffold);
  }
  let winMat: THREE.MeshLambertMaterial | null = null;
  let winMesh: THREE.InstancedMesh | null = null;
  if (parts.windows.length && construction >= 1) {
    winMat = new THREE.MeshLambertMaterial({ color: darkWindow, emissive: litWindow, emissiveIntensity: 0 });
    winMesh = new THREE.InstancedMesh(windowGeo, winMat, parts.windows.length);
    const m = new THREE.Matrix4();
    parts.windows.forEach((wd, i) => {
      m.compose(new THREE.Vector3(wd.x, wd.y, wd.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, wd.ry, 0)), new THREE.Vector3(wd.w, wd.h, 1));
      winMesh!.setMatrixAt(i, m);
    });
    winMesh.computeBoundingSphere();
    group.add(winMesh);
  }
  let mover: THREE.Mesh | null = null;
  if (parts.moving) {
    mover = new THREE.Mesh(parts.moving.geo, bodyMat);
    mover.position.copy(parts.moving.pos);
    mover.castShadow = true;
    group.add(mover);
  }
  if (parts.chimney) {
    const anchor = new THREE.Object3D();
    anchor.name = 'chimney';
    anchor.position.copy(parts.chimney);
    group.add(anchor);
  }
  const moving = parts.moving;
  return {
    object: group,
    w: def.w, d: def.d, height: parts.height,
    doors: [{ x: 0, z: def.d / 2 }],
    update: mover && moving ? (t: number) => {
      if (moving.axis === 'z') mover!.rotation.z = t * moving.speed;
      else mover!.rotation.x = t * moving.speed;
    } : undefined,
    setLit: winMat ? (amount: number) => { winMat!.emissiveIntensity = amount * 2.2; } : undefined,
    dispose() {
      geo.dispose();
      for (const ch of group.children) {
        if (ch instanceof THREE.Mesh && ch !== body && !(ch instanceof THREE.InstancedMesh)) ch.geometry.dispose();
      }
      winMesh?.dispose();
      winMat?.dispose();
    },
  };
}

// ------------------------------------------------------------------------------------------
// Vegetation

function treeKit(kind: ScatterKind, lod: 0 | 1 | 2): MeshKit {
  const k = new MeshKit();
  const trunk = P.timber;
  const leaf = 0x5f8f3a;
  const seg = lod === 0 ? 6 : lod === 1 ? 5 : 4;
  const blob = (r: number, o: { x?: number; y?: number; z?: number; sx?: number; sy?: number; sz?: number }, color: number) => {
    // distant LODs are a touch darker so far woods read as calm masses rather than glitter
    k.add(ico(r, 0), lod === 0 ? color : shade(color, lod === 1 ? 0.92 : 0.82), { ...o, foliage: 1 });
  };
  switch (kind) {
    case 'oak': case 'beech': case 'ash': case 'apple': {
      const h = kind === 'apple' ? 2.2 : kind === 'ash' ? 5 : 4.2;
      const r = kind === 'apple' ? 1.9 : kind === 'beech' ? 3.4 : 3.6;
      const col = kind === 'beech' ? 0x6a9a3e : kind === 'ash' ? 0x7aa04a : kind === 'apple' ? 0x6f9c45 : leaf;
      if (lod < 2) k.add(cyl(0.22 * r / 3, 0.38 * r / 3, h + r * 0.4, seg), trunk);
      blob(r, { y: h + r * 0.75, sy: 0.85 }, col);
      if (lod === 0) {
        blob(r * 0.7, { x: r * 0.55, y: h + r * 0.5, z: 0.3 }, shade(col, 0.92));
        blob(r * 0.65, { x: -r * 0.5, y: h + r * 0.6, z: -0.4 }, shade(col, 1.06));
        if (kind === 'apple') for (let i = 0; i < 5; i++) k.add(ico(0.16, 0), 0xc23a2a, { x: Math.cos(i * 1.3) * r * 0.9, y: h + 0.6 + (i % 3) * 0.5, z: Math.sin(i * 1.3) * r * 0.9 });
      }
      break;
    }
    case 'birch': {
      if (lod < 2) k.add(cyl(0.12, 0.18, 7.5, seg), 0xe8e4da);
      blob(1.7, { y: 7.2, sy: 1.5 }, 0x86ad4c);
      if (lod === 0) blob(1.2, { x: 0.6, y: 5.6, sy: 1.3 }, 0x7ea446);
      break;
    }
    case 'willow': {
      if (lod < 2) k.add(cyl(0.35, 0.55, 3.2, seg), shade(trunk, 1.1));
      blob(3.2, { y: 4.2, sy: 0.75 }, 0x86a84e);
      if (lod === 0) for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; k.add(cone(0.9, 3.0, 5), 0x7c9c48, { x: Math.cos(a) * 2.6, y: 0.9, z: Math.sin(a) * 2.6, rx: Math.PI, foliage: 1 }); }
      break;
    }
    case 'pine': case 'spruce': {
      const col = kind === 'pine' ? 0x3f6b3a : 0x2f5a36;
      const h = kind === 'pine' ? 11 : 10;
      if (lod < 2) k.add(cyl(0.18, 0.32, kind === 'pine' ? h * 0.75 : h * 0.4, seg), trunk);
      const tiers = lod === 0 ? 3 : lod === 1 ? 2 : 1;
      for (let i = 0; i < tiers; i++) {
        const t = i / Math.max(1, tiers);
        const r = (kind === 'pine' ? 2.2 : 2.8) * (1 - t * 0.55);
        const base = kind === 'pine' ? h * 0.45 + t * h * 0.38 : h * 0.15 + t * h * 0.5;
        k.add(cone(r, (kind === 'pine' ? 4.2 : 6) * (1 - t * 0.3), seg + 1), shade(col, 1 + i * 0.05), { y: base, foliage: 1 });
      }
      break;
    }
    case 'deadtree': {
      k.add(cyl(0.15, 0.35, 6, seg), 0x6b5a48);
      if (lod < 2) for (let i = 0; i < 3; i++) k.add(cyl(0.05, 0.12, 2.4, 4), 0x6b5a48, { y: 3 + i, rz: (i % 2 ? 1 : -1) * 0.8, ry: i * 2 });
      break;
    }
    case 'bush': blob(1.0, { y: 0.6, sy: 0.7 }, 0x557f36); if (lod === 0) blob(0.7, { x: 0.6, y: 0.45, sy: 0.7 }, 0x5f8a3c); break;
    case 'bramble': blob(0.8, { y: 0.4, sy: 0.6 }, 0x4a6a32); if (lod === 0) for (let i = 0; i < 4; i++) k.add(ico(0.07, 0), 0x3a1f3a, { x: Math.cos(i * 1.7) * 0.7, y: 0.6, z: Math.sin(i * 1.7) * 0.7 }); break;
    case 'reeds': for (let i = 0; i < (lod === 0 ? 7 : 3); i++) k.add(cone(0.06, 1.6 + hash01(i, 4) * 0.8, 3), 0xa59a5a, { x: Math.cos(i * 2.4) * 0.4, z: Math.sin(i * 2.4) * 0.4, foliage: 0.6 }); break;
    case 'fern': for (let i = 0; i < 5; i++) k.add(cone(0.18, 1.0, 3), 0x4f7f34, { rz: 0.9, ry: (i / 5) * Math.PI * 2, y: 0.1, foliage: 1 }); break;
    case 'grass_tuft': for (let i = 0; i < (lod === 0 ? 6 : 3); i++) k.add(cone(0.05, 0.5 + hash01(i, 9) * 0.3, 3), 0x7aa24a, { x: Math.cos(i * 2.1) * 0.15, z: Math.sin(i * 2.1) * 0.15, rz: Math.cos(i * 1.7) * 0.25, foliage: 1 }); break;
    case 'flowers': {
      for (let i = 0; i < 4; i++) k.add(cone(0.04, 0.45, 3), 0x6f9a42, { x: Math.cos(i * 1.6) * 0.15, z: Math.sin(i * 1.6) * 0.15, foliage: 1 });
      const fc = [0xf2e35a, 0xe8e8f0, 0xc45ab0, 0xd84a3a][i4(kind)];
      for (let i = 0; i < 4; i++) k.add(new THREE.OctahedronGeometry(0.07), fc, { x: Math.cos(i * 1.6) * 0.15, y: 0.47, z: Math.sin(i * 1.6) * 0.15 });
      break;
    }
    case 'rock_small': k.add(new THREE.DodecahedronGeometry(0.45, 0), 0x8d8a83, { y: 0.15, sy: 0.6 }); break;
    case 'rock_large': k.add(new THREE.DodecahedronGeometry(1.2, 0), 0x86837c, { y: 0.4, sy: 0.65, rx: 0.3 }); break;
    case 'boulder': k.add(new THREE.DodecahedronGeometry(2.2, 0), 0x7f7c75, { y: 0.8, sy: 0.7, ry: 0.5 }); break;
    case 'stump': k.add(cyl(0.38, 0.45, 0.6, 7), shade(trunk, 1.1)); break;
    case 'log': k.add(cyl(0.3, 0.3, 4, 6), shade(trunk, 1.1), { rz: Math.PI / 2, y: 0.3 }); break;
  }
  return k;
}
function i4(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h) % 4; }

const CROP_COLORS: Record<CropKind, [number, number]> = {
  wheat: [0x7fa24a, 0xd9b45a], rye: [0x7a9c4c, 0xc9a25a], barley: [0x86a854, 0xe0c070], oats: [0x8aa858, 0xd8c47c],
  peas: [0x4f8a3a, 0x7c8a3e], beans: [0x4a7f36, 0x6f6a38], flax: [0x6f9a5a, 0x7f8fb0], cabbage: [0x6f9f6a, 0x7fae74],
  onions: [0x6f9a6a, 0x8aa070], leeks: [0x5f8f5a, 0x6f9f68], turnips: [0x5f8f42, 0x6f9a48], fallow: [0x7a9a4a, 0x8a9a52],
};

function cropKit(kind: CropKind, stage: 0 | 1 | 2 | 3): MeshKit {
  const k = new MeshKit();
  const [green, ripe] = CROP_COLORS[kind];
  const col = mix(green, ripe, stage / 3);
  const h = [0.15, 0.4, 0.75, 1.0][stage] * (kind === 'rye' ? 1.4 : kind === 'flax' ? 0.9 : 1.0);
  if (kind === 'cabbage' || kind === 'turnips') {
    k.add(ico(0.12 + stage * 0.07, 0), col, { y: 0.06 + stage * 0.04, sy: 0.75 });
  } else if (kind === 'peas' || kind === 'beans') {
    k.add(ico(0.1 + stage * 0.08, 0), col, { y: 0.08 + stage * 0.08, sy: 1.2 });
  } else {
    const blades = stage === 0 ? 3 : 5;
    for (let i = 0; i < blades; i++) {
      k.add(cone(0.035, h, 3), col, { x: Math.cos(i * 2.3) * 0.1, z: Math.sin(i * 2.3) * 0.1, rz: Math.cos(i * 1.9) * 0.15 });
      if (stage === 3) k.add(cone(0.05, 0.16, 3), shade(ripe, 1.08), { x: Math.cos(i * 2.3) * 0.1 + Math.cos(i * 1.9) * -0.02, y: h - 0.02, z: Math.sin(i * 2.3) * 0.1 });
    }
  }
  return k;
}

// ------------------------------------------------------------------------------------------
// Dynamic layers

class PlaceholderCharacters implements CharacterLayer {
  readonly object = new THREE.Group();
  private body: THREE.InstancedMesh;
  private head: THREE.InstancedMesh;
  private horse: THREE.InstancedMesh;
  private cap = 0;
  private ids: number[] = [];
  private pos: THREE.Vector3[] = [];
  private readonly mat = new THREE.MeshLambertMaterial({ flatShading: true });
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly c = new THREE.Color();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly bodyGeo: THREE.BufferGeometry;
  private readonly headGeo: THREE.BufferGeometry;
  private readonly horseGeo: THREE.BufferGeometry;

  constructor() {
    const b = new MeshKit();
    b.add(cyl(0.17, 0.24, 0.95, 7), 0xffffff, { y: 0.5 });
    b.add(cyl(0.11, 0.1, 0.5, 5), 0x5a4a3a, { y: 0.0 });
    b.add(cyl(0.21, 0.18, 0.12, 7), 0x4a3a2a, { y: 0.95 });
    this.bodyGeo = b.build();
    this.headGeo = new THREE.IcosahedronGeometry(0.13, 1).translate(0, 1.6, 0);
    const h = new MeshKit();
    h.add(box(0.5, 0.7, 1.7), 0xffffff, { y: 0.8 });
    h.add(box(0.3, 0.5, 0.6), 0xffffff, { y: 1.35, z: 0.95, rx: -0.5 });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) h.add(box(0.14, 0.85, 0.14), 0xffffff, { x: sx * 0.17, z: sz * 0.65 });
    this.horseGeo = h.build();
    this.body = this.horse = this.head = null as unknown as THREE.InstancedMesh;
    this.grow(64);
  }

  private grow(n: number): void {
    for (const im of [this.body, this.head, this.horse]) if (im) { this.object.remove(im); im.dispose(); }
    this.cap = n;
    this.body = new THREE.InstancedMesh(this.bodyGeo, this.mat, n);
    this.head = new THREE.InstancedMesh(this.headGeo, this.mat, n);
    this.horse = new THREE.InstancedMesh(this.horseGeo, this.mat, n);
    for (const im of [this.body, this.head, this.horse]) {
      im.castShadow = true;
      im.frustumCulled = false;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.setColorAt(0, this.c.set(0xffffff));
      im.count = 0;
      this.object.add(im);
    }
  }

  update(items: readonly CharacterDrawItem[], _dt: number): void {
    if (items.length > this.cap) this.grow(Math.ceil(items.length * 1.5));
    let nh = 0;
    this.ids.length = items.length;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      this.ids[i] = it.id;
      const scale = it.look.height / 1.75;
      const moving = it.anim === 'walk' || it.anim === 'run' || it.anim === 'sprint' || it.anim === 'carry_walk';
      const bob = moving ? Math.abs(Math.sin(it.animTime * (it.moveSpeed * 2.2 + 3))) * 0.05 : Math.sin(it.animTime * 1.5) * 0.008;
      const ride = it.mount ? 1.15 : 0;
      this.q.setFromAxisAngle(this.v.set(0, 1, 0), it.yaw);
      if (!this.pos[i]) this.pos[i] = new THREE.Vector3();
      this.pos[i].set(it.x, it.y + ride, it.z);
      this.m.compose(this.v.set(it.x, it.y + bob + ride, it.z), this.q, this.s.set(scale * (0.9 + it.look.build * 0.25), scale, scale));
      this.body.setMatrixAt(i, this.m);
      this.head.setMatrixAt(i, this.m);
      this.body.setColorAt(i, this.c.setHex(it.look.clothing.tunic));
      this.head.setColorAt(i, this.c.setHex(it.look.skin));
      if (it.mount) {
        this.m.compose(this.v.set(it.x, it.y, it.z), this.q, this.s.set(1, 1, 1));
        this.horse.setMatrixAt(nh, this.m);
        this.horse.setColorAt(nh, this.c.setHex(it.mount.coat));
        nh++;
      }
    }
    this.body.count = this.head.count = items.length;
    this.horse.count = nh;
    for (const im of [this.body, this.head, this.horse]) {
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
  }

  pick(raycaster: THREE.Raycaster): number {
    let best = -1, bd = Infinity;
    for (let i = 0; i < this.body.count; i++) {
      const p = this.pos[i];
      this.v.set(p.x, p.y + 0.9, p.z);
      const d = raycaster.ray.distanceSqToPoint(this.v);
      if (d < 0.45 * 0.45) {
        const t = raycaster.ray.origin.distanceTo(this.v);
        if (t < bd) { bd = t; best = this.ids[i]; }
      }
    }
    return best;
  }

  dispose(): void {
    for (const im of [this.body, this.head, this.horse]) im.dispose();
    this.bodyGeo.dispose(); this.headGeo.dispose(); this.horseGeo.dispose(); this.mat.dispose();
  }
}

const ANIMAL_SIZE: Record<AnimalKind, [number, number, number]> = {
  horse: [0.5, 0.7, 1.7], ox: [0.8, 0.9, 2.0], cow: [0.7, 0.8, 1.8], sheep: [0.45, 0.45, 0.8], pig: [0.45, 0.4, 0.9],
  goat: [0.35, 0.45, 0.8], chicken: [0.15, 0.18, 0.25], goose: [0.18, 0.22, 0.35], dog: [0.22, 0.3, 0.7], cat: [0.12, 0.15, 0.4],
  deer: [0.35, 0.6, 1.2], boar: [0.45, 0.5, 1.1], wolf: [0.28, 0.4, 1.0], fox: [0.18, 0.25, 0.65], hare: [0.12, 0.15, 0.35],
};

class PlaceholderAnimals implements AnimalLayer {
  readonly object = new THREE.Group();
  private mesh: THREE.InstancedMesh;
  private cap = 0;
  private ids: number[] = [];
  private pos: THREE.Vector3[] = [];
  private readonly mat = new THREE.MeshLambertMaterial({ flatShading: true });
  private readonly geo: THREE.BufferGeometry;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly c = new THREE.Color();
  constructor() {
    const k = new MeshKit();
    k.add(box(1, 1, 1), 0xffffff, { y: 0.9 });
    k.add(box(0.55, 0.55, 0.45), 0xffffff, { y: 1.45, z: 0.6 });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.add(box(0.18, 0.9, 0.18), 0xdddddd, { x: sx * 0.3, z: sz * 0.35 });
    this.geo = k.build();
    this.mesh = null as unknown as THREE.InstancedMesh;
    this.grow(64);
  }
  private grow(n: number): void {
    if (this.mesh) { this.object.remove(this.mesh); this.mesh.dispose(); }
    this.cap = n;
    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, n);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.setColorAt(0, this.c.set(0xffffff));
    this.mesh.count = 0;
    this.object.add(this.mesh);
  }
  update(items: readonly AnimalDrawItem[]): void {
    if (items.length > this.cap) this.grow(Math.ceil(items.length * 1.5));
    this.ids.length = items.length;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      this.ids[i] = it.id;
      const [w, h, l] = ANIMAL_SIZE[it.kind];
      const sc = it.scale * (it.young ? 0.6 : 1);
      const bob = it.anim === 'walk' || it.anim === 'run' || it.anim === 'trot' ? Math.abs(Math.sin(it.animTime * 6)) * 0.04 : 0;
      const lying = it.anim === 'lie' || it.anim === 'sleep' || it.anim === 'dead';
      this.q.setFromAxisAngle(this.v.set(0, 1, 0), it.yaw);
      this.m.compose(this.v.set(it.x, it.y + bob - (lying ? h * 0.45 * sc : 0), it.z), this.q, this.s.set(w * sc, h * 0.75 * sc, l * sc));
      this.mesh.setMatrixAt(i, this.m);
      this.mesh.setColorAt(i, this.c.setHex(it.coat));
      if (!this.pos[i]) this.pos[i] = new THREE.Vector3();
      this.pos[i].set(it.x, it.y + h * 0.6 * sc, it.z);
    }
    this.mesh.count = items.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
  pick(raycaster: THREE.Raycaster): number {
    let best = -1, bd = Infinity;
    for (let i = 0; i < this.mesh.count; i++) {
      const d = raycaster.ray.distanceSqToPoint(this.pos[i]);
      if (d < 0.6 * 0.6) {
        const t = raycaster.ray.origin.distanceTo(this.pos[i]);
        if (t < bd) { bd = t; best = this.ids[i]; }
      }
    }
    return best;
  }
  dispose(): void { this.mesh.dispose(); this.geo.dispose(); this.mat.dispose(); }
}

class PlaceholderProjectiles implements ProjectileLayer {
  readonly object: THREE.InstancedMesh;
  private readonly geo = new THREE.BoxGeometry(0.03, 0.03, 0.8);
  private readonly mat = new THREE.MeshLambertMaterial({ color: 0x6b5030 });
  private readonly m = new THREE.Matrix4();
  private readonly look = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly o = new THREE.Object3D();
  constructor() {
    this.object = new THREE.InstancedMesh(this.geo, this.mat, 256);
    this.object.count = 0;
    this.object.frustumCulled = false;
  }
  update(items: readonly ProjectileDrawItem[]): void {
    const n = Math.min(items.length, 256);
    for (let i = 0; i < n; i++) {
      const it = items[i];
      this.o.position.set(it.x, it.y, it.z);
      this.look.set(it.x + it.vx, it.y + it.vy, it.z + it.vz);
      if (it.vx * it.vx + it.vy * it.vy + it.vz * it.vz > 1e-6) this.o.lookAt(this.look);
      this.o.updateMatrix();
      this.m.copy(this.o.matrix);
      this.object.setMatrixAt(i, this.m);
    }
    void this.up;
    this.object.count = n;
    this.object.instanceMatrix.needsUpdate = true;
  }
  dispose(): void { this.object.dispose(); this.geo.dispose(); this.mat.dispose(); }
}

class PlaceholderFx implements FxLayer {
  readonly object: THREE.Points;
  private readonly max = 3000;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly size: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly baseCol: Float32Array;
  private head = 0;
  private readonly geo = new THREE.BufferGeometry();
  private readonly mat: THREE.ShaderMaterial;
  constructor() {
    this.pos = new Float32Array(this.max * 3);
    this.col = new Float32Array(this.max * 4);
    this.baseCol = new Float32Array(this.max * 3);
    this.size = new Float32Array(this.max);
    this.vel = new Float32Array(this.max * 3);
    this.life = new Float32Array(this.max);
    this.maxLife = new Float32Array(this.max);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uScale: { value: 600 } },
      vertexShader: `attribute vec4 aColor; attribute float aSize; uniform float uScale; varying vec4 vColor;
        void main() { vColor = aColor; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize * uScale / max(0.1, -mv.z); }`,
      fragmentShader: `varying vec4 vColor; void main() { vec2 d = gl_PointCoord - 0.5; float a = smoothstep(0.5, 0.2, length(d));
        gl_FragColor = vec4(vColor.rgb, vColor.a * a); if (gl_FragColor.a < 0.01) discard;
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        }`,
    });
    this.object = new THREE.Points(this.geo, this.mat);
    this.object.frustumCulled = false;
  }
  emit(events: readonly FxEvent[]): void {
    for (const e of events) {
      const n = e.kind === 'hearth_smoke' || e.kind === 'smoke' ? 1 : Math.ceil(4 * e.intensity) + 2;
      for (let k = 0; k < n; k++) {
        const i = this.head;
        this.head = (this.head + 1) % this.max;
        const r = Math.random;
        this.pos[i * 3] = e.x + (r() - 0.5) * 0.3; this.pos[i * 3 + 1] = e.y; this.pos[i * 3 + 2] = e.z + (r() - 0.5) * 0.3;
        let col = 0x8a8a8a, life = 1, vy = 0.5, spread = 0.5, size = 0.4;
        switch (e.kind) {
          case 'hearth_smoke': case 'smoke': col = 0xb4b0aa; life = 7; vy = 0.9; spread = 0.25; size = 1.2; break;
          case 'fire': col = 0xffa030; life = 0.8; vy = 1.5; size = 0.6; break;
          case 'sparks': col = 0xffc060; life = 0.6; vy = 2; spread = 2; size = 0.1; break;
          case 'blood': col = 0x8a1010; life = 0.7; vy = 0.8; spread = 1; size = 0.12; break;
          case 'splash': col = 0xe8f4f4; life = 0.8; vy = 2; spread = 1.2; size = 0.2; break;
          case 'dust': case 'chaff': case 'chips': case 'impact': col = 0xb8a580; life = 1.2; vy = 0.4; spread = 0.8; size = 0.5; break;
        }
        this.vel[i * 3] = (r() - 0.5) * spread; this.vel[i * 3 + 1] = vy * (0.7 + r() * 0.6); this.vel[i * 3 + 2] = (r() - 0.5) * spread;
        this.life[i] = life; this.maxLife[i] = life; this.size[i] = size;
        const c = new THREE.Color(col);
        this.baseCol[i * 3] = c.r; this.baseCol[i * 3 + 1] = c.g; this.baseCol[i * 3 + 2] = c.b;
      }
    }
  }
  update(dt: number, camera: THREE.Camera): void {
    void camera;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) { this.col[i * 4 + 3] = 0; continue; }
      this.life[i] -= dt;
      const t = 1 - this.life[i] / this.maxLife[i];
      this.pos[i * 3] += this.vel[i * 3] * dt + windX * 0.15 * dt * t;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt + windZ * 0.15 * dt * t;
      this.col[i * 4] = this.baseCol[i * 3]; this.col[i * 4 + 1] = this.baseCol[i * 3 + 1]; this.col[i * 4 + 2] = this.baseCol[i * 3 + 2];
      this.col[i * 4 + 3] = Math.max(0, Math.sin(t * Math.PI)) * 0.55;
      this.size[i] = Math.max(this.size[i], 0.1) + dt * 0.25;
    }
    (this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aColor') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;
  }
  dispose(): void { this.geo.dispose(); this.mat.dispose(); }
}
let windX = 0, windZ = 0;

// ------------------------------------------------------------------------------------------

export function createPlaceholderAssets(): AssetLibrary {
  const bodyMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const vegU: VegUniforms = {
    uTime: { value: 0 }, uWind: { value: new THREE.Vector2() }, uTint: { value: new THREE.Color(1, 1, 1) },
    uSnow: { value: 0 }, uBare: { value: 0 },
  };
  const vegMat = createVegetationMaterial(vegU);
  const cropMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const kits = new Map<string, InstancedKit>();
  const summer = new THREE.Color(P.foliage.summer);
  const tintFrom = new THREE.Color(), tintTo = new THREE.Color();
  const seasonColors = [P.foliage.spring, P.foliage.summer, P.foliage.autumn, P.foliage.winter];

  return {
    palette: PALETTE,
    setEnvironment(env: AssetEnvironment): void {
      vegU.uTime.value = env.time;
      vegU.uWind.value.set(env.windX, env.windZ);
      windX = env.windX; windZ = env.windZ;
      tintFrom.setHex(seasonColors[env.season]);
      tintTo.setHex(seasonColors[(env.season + 1) % 4]);
      const t = Math.max(0, (env.seasonProgress - 0.6) / 0.4);
      tintFrom.lerp(tintTo, t * t);
      vegU.uTint.value.setRGB(tintFrom.r / summer.r, tintFrom.g / summer.g, tintFrom.b / summer.b).multiplyScalar(0.62);
      vegU.uSnow.value = env.snowCover;
      vegU.uBare.value = env.season === 3 ? 0.6 : env.season === 2 ? env.seasonProgress * 0.3 : 0;
    },
    building(req: BuildingRequest): BuildingAsset { return createBuilding(req, bodyMat); },
    vegetation(kind: ScatterKind, lod: 0 | 1 | 2): InstancedKit {
      const key = `v:${kind}:${lod}`;
      let kit = kits.get(key);
      if (!kit) {
        const geo = treeKit(kind, lod).build(true);
        kit = { geometry: geo, material: vegMat, radius: geo.boundingSphere ? geo.boundingSphere.radius + geo.boundingSphere.center.length() : 5 };
        kits.set(key, kit);
      }
      return kit;
    },
    crop(kind: CropKind, stage: 0 | 1 | 2 | 3): InstancedKit {
      const key = `c:${kind}:${stage}`;
      let kit = kits.get(key);
      if (!kit) {
        const geo = cropKit(kind, stage).build();
        kit = { geometry: geo, material: cropMat, radius: 0.6 };
        kits.set(key, kit);
      }
      return kit;
    },
    prop(kind: PropKind, seed = 0): THREE.Object3D {
      const k = new MeshKit();
      k.add(box(1, 1, 1), [P.timber, P.thatch, P.stone][Math.floor(hash01(seed, kind.length) * 3)]);
      const m = new THREE.Mesh(k.build(), bodyMat);
      m.name = `prop:${kind}`;
      return m;
    },
    createCharacterLayer: () => new PlaceholderCharacters(),
    createAnimalLayer: () => new PlaceholderAnimals(),
    createProjectileLayer: () => new PlaceholderProjectiles(),
    createFxLayer: () => new PlaceholderFx(),
  };
}
