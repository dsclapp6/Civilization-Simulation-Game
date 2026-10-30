// SkinnedCrowd: every actor (person, horse, animal) of a layer lives in ONE indexed
// BufferGeometry drawn with ONE draw call (+1 per shadow map). Each actor owns a
// "slot" = one row of a float texture holding up to MAX_BONES 3x4 skinning matrices
// plus a parameter texel. Vertices carry (slot, boneA, boneB, weight, material flag)
// and are skinned in the vertex shader (patched MeshStandardMaterial + depth materials).
// Geometry chunks are sub-allocated from the shared buffers (first-fit free lists).
import * as THREE from 'three';
import type { GeometryData } from './builder';

export const MAX_BONES = 32;
/** Texels per slot row: 3 per bone + 1 params texel (highlight, tint, spare). */
export const SLOT_TEXELS = MAX_BONES * 3 + 1;
const PARAM_TEXEL = MAX_BONES * 3;

export interface Chunk {
  vStart: number;
  vCount: number;
  iStart: number;
  iCount: number;
  slot: number;
}

interface Span { start: number; count: number; }

/** First-fit allocator over a linear range with coalescing frees. */
class RangeAllocator {
  free: Span[] = [];
  constructor(public capacity: number) { this.free.push({ start: 0, count: capacity }); }
  alloc(n: number): number {
    for (let i = 0; i < this.free.length; i++) {
      const f = this.free[i];
      if (f.count >= n) {
        const s = f.start;
        f.start += n; f.count -= n;
        if (f.count === 0) this.free.splice(i, 1);
        return s;
      }
    }
    return -1;
  }
  release(start: number, n: number): void {
    // insert sorted, merge neighbours
    let i = 0;
    while (i < this.free.length && this.free[i].start < start) i++;
    this.free.splice(i, 0, { start, count: n });
    if (i + 1 < this.free.length && start + n === this.free[i + 1].start) {
      this.free[i].count += this.free[i + 1].count;
      this.free.splice(i + 1, 1);
    }
    if (i > 0 && this.free[i - 1].start + this.free[i - 1].count === start) {
      this.free[i - 1].count += this.free[i].count;
      this.free.splice(i, 1);
    }
  }
  grow(newCap: number): void {
    const extra = newCap - this.capacity;
    if (extra <= 0) return;
    this.release(this.capacity, extra);
    this.capacity = newCap;
  }
  /** One past the highest allocated element. */
  highWater(): number {
    const last = this.free[this.free.length - 1];
    if (last && last.start + last.count === this.capacity) return last.start;
    return this.capacity;
  }
}

const VERT_PARS = /* glsl */`
uniform highp sampler2D crowdBones;
attribute vec4 skin;
attribute float slot;
varying float vCrowdFlag;
varying vec4 vCrowdParams;
mat4 crowdBone( const in int s, const in int b ) {
  int x = b * 3;
  vec4 r0 = texelFetch( crowdBones, ivec2( x, s ), 0 );
  vec4 r1 = texelFetch( crowdBones, ivec2( x + 1, s ), 0 );
  vec4 r2 = texelFetch( crowdBones, ivec2( x + 2, s ), 0 );
  return mat4( r0.x, r1.x, r2.x, 0.0, r0.y, r1.y, r2.y, 0.0, r0.z, r1.z, r2.z, 0.0, r0.w, r1.w, r2.w, 1.0 );
}
`;

const VERT_SKIN = /* glsl */`
  int crowdSlot = int( slot + 0.5 );
  mat4 crowdM = crowdBone( crowdSlot, int( skin.x + 0.5 ) );
  if ( skin.z > 0.5 ) {
    mat4 crowdB = crowdBone( crowdSlot, int( skin.y + 0.5 ) );
    crowdM += ( crowdB - crowdM ) * ( skin.z / 255.0 );
  }
  vCrowdFlag = skin.w;
  vCrowdParams = texelFetch( crowdBones, ivec2( ${PARAM_TEXEL}, crowdSlot ), 0 );
`;

const FRAG_PARS = /* glsl */`
varying float vCrowdFlag;
varying vec4 vCrowdParams;
`;

// Material flags (see builder MAT): 0 cloth 1 leather 2 steel 3 gold 4 glow 5 glossy 6 hair 7 ring 8 wood
const FRAG_ROUGH = /* glsl */`
  float roughnessFactor = roughness;
  float crowdMetal = 0.0;
  int crowdFlagI = int( vCrowdFlag + 0.5 );
  if ( crowdFlagI == 1 ) { roughnessFactor = 0.62; }
  else if ( crowdFlagI == 2 ) { roughnessFactor = 0.34; crowdMetal = 0.45; }
  else if ( crowdFlagI == 3 ) { roughnessFactor = 0.3; crowdMetal = 0.7; }
  else if ( crowdFlagI == 5 ) { roughnessFactor = 0.22; }
  else if ( crowdFlagI == 6 ) { roughnessFactor = 0.7; }
  else if ( crowdFlagI == 8 ) { roughnessFactor = 0.78; }
`;

const FRAG_METAL = /* glsl */`
  float metalnessFactor = crowdMetal;
`;

const FRAG_EMISSIVE = /* glsl */`
  if ( crowdFlagI == 4 ) { totalEmissiveRadiance += diffuseColor.rgb * 2.2; }
  if ( crowdFlagI == 7 ) { totalEmissiveRadiance += diffuseColor.rgb * 1.6; diffuseColor.rgb *= 0.2; }
  float crowdHl = vCrowdParams.x;
  if ( crowdHl > 0.5 ) {
    float crowdRim = 1.0 - saturate( dot( normal, normalize( vViewPosition ) ) );
    crowdRim = crowdRim * crowdRim * ( 3.0 - 2.0 * crowdRim );
    vec3 crowdHc = crowdHl < 1.5 ? vec3( 1.0, 0.92, 0.75 ) : ( crowdHl < 2.5 ? vec3( 1.0, 0.72, 0.22 ) : vec3( 0.85, 0.8, 0.55 ) );
    float crowdK = crowdHl < 1.5 ? 0.55 : ( crowdHl < 2.5 ? 0.9 : 0.35 );
    totalEmissiveRadiance += crowdHc * ( crowdRim * crowdK + 0.04 * crowdK );
  }
  // per-actor tint/flash (params.y: hit flash, params.z: darken for dead/night ghosts)
  totalEmissiveRadiance += vec3( 0.6, 0.12, 0.08 ) * vCrowdParams.y;
`;

const SRGB_DECODE = /* glsl */`
#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
  vColor.rgb = mix( vColor.rgb / 12.92, pow( ( vColor.rgb + 0.055 ) / 1.055, vec3( 2.4 ) ), step( 0.04045, vColor.rgb ) );
#endif
`;

function patchVertex(src: string, withNormal: boolean): string {
  let s = src.replace('#include <common>', `#include <common>\n${VERT_PARS}`);
  // Skin before anything consumes position/normal.
  if (withNormal) {
    s = s.replace('#include <beginnormal_vertex>', `${VERT_SKIN}\n  vec3 objectNormal = mat3( crowdM ) * vec3( normal );\n#ifdef USE_TANGENT\n  vec3 objectTangent = vec3( tangent.xyz );\n#endif`);
    s = s.replace('#include <begin_vertex>', 'vec3 transformed = ( crowdM * vec4( position, 1.0 ) ).xyz;');
  } else {
    s = s.replace('#include <begin_vertex>', `${VERT_SKIN}\n  vec3 transformed = ( crowdM * vec4( position, 1.0 ) ).xyz;`);
  }
  s = s.replace('#include <color_vertex>', `#include <color_vertex>\n${SRGB_DECODE}`);
  return s;
}

export interface CrowdOptions {
  name: string;
  initialVertices?: number;
  initialIndices?: number;
  initialSlots?: number;
}

export class SkinnedCrowd {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshStandardMaterial;
  private depthMat: THREE.MeshDepthMaterial;
  private distMat: THREE.MeshDistanceMaterial;
  private geometry: THREE.BufferGeometry;
  private vAlloc: RangeAllocator;
  private iAlloc: RangeAllocator;
  private position!: THREE.BufferAttribute;
  private normal!: THREE.BufferAttribute;
  private color!: THREE.BufferAttribute;
  private skin!: THREE.BufferAttribute;
  private slotAttr!: THREE.BufferAttribute;
  private index!: THREE.BufferAttribute;
  private boneUniform: { value: THREE.DataTexture };
  /** Raw bone texture data: slotCapacity rows × SLOT_TEXELS texels × 4 floats. */
  bones: Float32Array;
  private boneTex: THREE.DataTexture;
  private slotCap: number;
  private freeSlots: number[] = [];
  private nextSlot = 0;
  private usedSlots = 0;
  private dirtyGeo = false;
  private vDirty: [number, number] = [Infinity, -Infinity];
  private iDirty: [number, number] = [Infinity, -Infinity];

  constructor(opts: CrowdOptions) {
    const vCap = opts.initialVertices ?? 65536;
    const iCap = opts.initialIndices ?? 196608;
    this.slotCap = opts.initialSlots ?? 128;
    this.vAlloc = new RangeAllocator(vCap);
    this.iAlloc = new RangeAllocator(iCap);
    this.geometry = this.makeGeometry(vCap, iCap, null);
    this.bones = new Float32Array(this.slotCap * SLOT_TEXELS * 4);
    this.boneTex = this.makeBoneTexture();
    this.boneUniform = { value: this.boneTex };

    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true, flatShading: true, roughness: 0.86, metalness: 0, side: THREE.DoubleSide,
    });
    this.material.name = `${opts.name}-crowd`;
    const uniform = this.boneUniform;
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.crowdBones = uniform;
      shader.vertexShader = patchVertex(shader.vertexShader, true);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
        .replace('#include <roughnessmap_fragment>', FRAG_ROUGH)
        .replace('#include <metalnessmap_fragment>', FRAG_METAL)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${FRAG_EMISSIVE}`);
    };
    this.material.customProgramCacheKey = () => 'millennia-crowd-std-v1';

    this.depthMat = new THREE.MeshDepthMaterial();
    this.depthMat.onBeforeCompile = (shader) => {
      shader.uniforms.crowdBones = uniform;
      shader.vertexShader = patchVertex(shader.vertexShader, false);
    };
    this.depthMat.customProgramCacheKey = () => 'millennia-crowd-depth-v1';
    this.distMat = new THREE.MeshDistanceMaterial();
    this.distMat.onBeforeCompile = (shader) => {
      shader.uniforms.crowdBones = uniform;
      shader.vertexShader = patchVertex(shader.vertexShader, false);
    };
    this.distMat.customProgramCacheKey = () => 'millennia-crowd-dist-v1';

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = opts.name;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.customDepthMaterial = this.depthMat;
    this.mesh.customDistanceMaterial = this.distMat;
    this.mesh.matrixAutoUpdate = false;
    // Tells other passes (override materials, outlines) that vertices are skinned on the GPU.
    this.mesh.userData.millenniaSkinnedCrowd = true;
    this.geometry.setDrawRange(0, 0);
  }

  private makeGeometry(vCap: number, iCap: number, old: THREE.BufferGeometry | null): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(vCap * 3);
    const nrm = new Int8Array(vCap * 3);
    const col = new Uint8Array(vCap * 3);
    const skn = new Uint8Array(vCap * 4);
    const slt = new Uint16Array(vCap);
    const idx = new Uint32Array(iCap);
    if (old) {
      pos.set(this.position.array as Float32Array);
      nrm.set(this.normal.array as Int8Array);
      col.set(this.color.array as Uint8Array);
      skn.set(this.skin.array as Uint8Array);
      slt.set(this.slotAttr.array as Uint16Array);
      idx.set(this.index.array as Uint32Array);
    }
    this.position = new THREE.BufferAttribute(pos, 3);
    this.normal = new THREE.BufferAttribute(nrm, 3, true);
    this.color = new THREE.BufferAttribute(col, 3, true);
    this.skin = new THREE.BufferAttribute(skn, 4, false);
    this.slotAttr = new THREE.BufferAttribute(slt, 1, false);
    this.index = new THREE.BufferAttribute(idx, 1);
    for (const a of [this.position, this.normal, this.color, this.skin, this.slotAttr, this.index]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.position);
    g.setAttribute('normal', this.normal);
    g.setAttribute('color', this.color);
    g.setAttribute('skin', this.skin);
    g.setAttribute('slot', this.slotAttr);
    g.setIndex(this.index);
    // Far-away bounds: frustum culling is done per actor on the CPU.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    g.boundingBox = new THREE.Box3(new THREE.Vector3(-1e7, -1e7, -1e7), new THREE.Vector3(1e7, 1e7, 1e7));
    return g;
  }

  private makeBoneTexture(): THREE.DataTexture {
    const t = new THREE.DataTexture(this.bones, SLOT_TEXELS, this.slotCap, THREE.RGBAFormat, THREE.FloatType);
    t.minFilter = THREE.NearestFilter;
    t.magFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  }

  // ----- slots -----
  allocSlot(): number {
    let s: number;
    if (this.freeSlots.length) {
      // lowest free slot keeps the used rows compact
      let best = 0;
      for (let i = 1; i < this.freeSlots.length; i++) if (this.freeSlots[i] < this.freeSlots[best]) best = i;
      s = this.freeSlots[best];
      this.freeSlots.splice(best, 1);
    } else {
      s = this.nextSlot++;
      if (s >= this.slotCap) this.growSlots(Math.max(this.slotCap * 2, s + 1));
    }
    this.usedSlots++;
    this.hideSlot(s);
    return s;
  }
  releaseSlot(s: number): void {
    this.hideSlot(s);
    this.freeSlots.push(s);
    this.usedSlots--;
  }
  get slotCount(): number { return this.usedSlots; }

  private growSlots(cap: number): void {
    const old = this.bones;
    this.slotCap = cap;
    this.bones = new Float32Array(cap * SLOT_TEXELS * 4);
    this.bones.set(old);
    const oldTex = this.boneTex;
    this.boneTex = this.makeBoneTexture();
    this.boneUniform.value = this.boneTex;
    oldTex.dispose();
  }

  /** Offset (in floats) of bone b of slot s inside `bones`. */
  boneOffset(s: number, b: number): number { return (s * SLOT_TEXELS + b * 3) * 4; }

  /** Collapse every bone of a slot (actor invisible). */
  hideSlot(s: number): void {
    const o = s * SLOT_TEXELS * 4;
    this.bones.fill(0, o, o + SLOT_TEXELS * 4);
  }

  setParams(s: number, highlight: number, flash: number, extra = 0): void {
    const o = (s * SLOT_TEXELS + PARAM_TEXEL) * 4;
    this.bones[o] = highlight; this.bones[o + 1] = flash; this.bones[o + 2] = extra;
  }

  // ----- geometry chunks -----
  /** Copy geometry into the shared buffers for a slot. boneMap remaps local bone ids. */
  addChunk(g: GeometryData, slot: number, boneMap?: ArrayLike<number>): Chunk | null {
    if (g.vertexCount === 0 || g.indexCount === 0) return null;
    let vs = this.vAlloc.alloc(g.vertexCount);
    let is = this.iAlloc.alloc(g.indexCount);
    if (vs < 0 || is < 0) {
      if (vs >= 0) this.vAlloc.release(vs, g.vertexCount);
      if (is >= 0) this.iAlloc.release(is, g.indexCount);
      this.growGeometry(g.vertexCount, g.indexCount);
      vs = this.vAlloc.alloc(g.vertexCount);
      is = this.iAlloc.alloc(g.indexCount);
      if (vs < 0 || is < 0) return null;
    }
    const pos = this.position.array as Float32Array;
    const nrm = this.normal.array as Int8Array;
    const col = this.color.array as Uint8Array;
    const skn = this.skin.array as Uint8Array;
    const slt = this.slotAttr.array as Uint16Array;
    const idx = this.index.array as Uint32Array;
    pos.set(g.position, vs * 3);
    nrm.set(g.normal, vs * 3);
    col.set(g.color, vs * 3);
    if (boneMap) {
      for (let i = 0; i < g.vertexCount; i++) {
        const o = (vs + i) * 4, si = i * 4;
        skn[o] = boneMap[g.skin[si]]; skn[o + 1] = boneMap[g.skin[si + 1]];
        skn[o + 2] = g.skin[si + 2]; skn[o + 3] = g.skin[si + 3];
      }
    } else {
      skn.set(g.skin, vs * 4);
    }
    slt.fill(slot, vs, vs + g.vertexCount);
    for (let i = 0; i < g.indexCount; i++) idx[is + i] = g.index[i] + vs;
    this.markV(vs, g.vertexCount);
    this.markI(is, g.indexCount);
    return { vStart: vs, vCount: g.vertexCount, iStart: is, iCount: g.indexCount, slot };
  }

  removeChunk(c: Chunk | null): void {
    if (!c) return;
    const idx = this.index.array as Uint32Array;
    idx.fill(0, c.iStart, c.iStart + c.iCount); // degenerate triangles
    this.markI(c.iStart, c.iCount);
    this.vAlloc.release(c.vStart, c.vCount);
    this.iAlloc.release(c.iStart, c.iCount);
  }

  private markV(s: number, n: number): void {
    this.vDirty[0] = Math.min(this.vDirty[0], s); this.vDirty[1] = Math.max(this.vDirty[1], s + n);
    this.dirtyGeo = true;
  }
  private markI(s: number, n: number): void {
    this.iDirty[0] = Math.min(this.iDirty[0], s); this.iDirty[1] = Math.max(this.iDirty[1], s + n);
    this.dirtyGeo = true;
  }

  private growGeometry(vNeed: number, iNeed: number): void {
    let vCap = this.vAlloc.capacity, iCap = this.iAlloc.capacity;
    while (vCap < this.vAlloc.highWater() + vNeed + 1) vCap *= 2;
    while (iCap < this.iAlloc.highWater() + iNeed + 1) iCap *= 2;
    if (vCap === this.vAlloc.capacity && iCap === this.iAlloc.capacity) { vCap *= 2; iCap *= 2; }
    const old = this.geometry;
    this.geometry = this.makeGeometry(vCap, iCap, old);
    this.vAlloc.grow(vCap);
    this.iAlloc.grow(iCap);
    this.mesh.geometry = this.geometry;
    old.dispose();
    this.vDirty = [Infinity, -Infinity];
    this.iDirty = [Infinity, -Infinity];
    this.dirtyGeo = false;
  }

  /** Call once per frame after writing bones/chunks. */
  commit(): void {
    if (this.dirtyGeo) {
      if (this.vDirty[1] > this.vDirty[0]) {
        const s = this.vDirty[0], n = this.vDirty[1] - this.vDirty[0];
        this.position.addUpdateRange(s * 3, n * 3); this.position.needsUpdate = true;
        this.normal.addUpdateRange(s * 3, n * 3); this.normal.needsUpdate = true;
        this.color.addUpdateRange(s * 3, n * 3); this.color.needsUpdate = true;
        this.skin.addUpdateRange(s * 4, n * 4); this.skin.needsUpdate = true;
        this.slotAttr.addUpdateRange(s, n); this.slotAttr.needsUpdate = true;
      }
      if (this.iDirty[1] > this.iDirty[0]) {
        this.index.addUpdateRange(this.iDirty[0], this.iDirty[1] - this.iDirty[0]);
        this.index.needsUpdate = true;
      }
      this.vDirty = [Infinity, -Infinity];
      this.iDirty = [Infinity, -Infinity];
      this.dirtyGeo = false;
    }
    this.geometry.setDrawRange(0, this.iAlloc.highWater());
    this.boneTex.needsUpdate = true;
  }

  /** Vertices / indices currently allocated (for stats). */
  stats(): { vertices: number; triangles: number; slots: number } {
    let vFree = 0, iFree = 0;
    for (const f of this.vAlloc.free) vFree += f.count;
    for (const f of this.iAlloc.free) iFree += f.count;
    return { vertices: this.vAlloc.capacity - vFree, triangles: (this.iAlloc.capacity - iFree) / 3, slots: this.usedSlots };
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.depthMat.dispose();
    this.distMat.dispose();
    this.boneTex.dispose();
  }
}
