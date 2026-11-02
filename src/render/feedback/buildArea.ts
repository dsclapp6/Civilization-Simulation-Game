// Builder mode's land tint (GameRenderer.setBuildArea, docs/CIV.md §5): the land the builder may build on is lit with a
// soft warm tint and outlined by a thin glowing line; all other land is shaded a touch darker. The polygons (their
// union) are rasterised once into a small coverage mask over their bounds (rebuilt only when the area changes) and the
// ground's own shaders — terrain, field strips, roads — read it, so the tint lies exactly on the ground at any distance
// and costs no extra draw call. The line is drawn where the (softened) mask crosses one half, a constant ~2 px wide.
import * as THREE from 'three';

export type AreaPolys = ReadonlyArray<ReadonlyArray<{ x: number; z: number }>>;

export interface BuildAreaUniforms {
  uBuildMask: { value: THREE.Texture | null };
  /** x0, z0, 1/width, 1/depth of the mask in world metres. */
  uBuildRect: { value: THREE.Vector4 };
  /** 0 off … 1 on (eased in and out). */
  uBuildOn: { value: number };
}

export function createBuildAreaUniforms(): BuildAreaUniforms {
  return { uBuildMask: { value: null }, uBuildRect: { value: new THREE.Vector4(0, 0, 1, 1) }, uBuildOn: { value: 0 } };
}

/** Declarations and helpers for a ground fragment shader (needs a world position). */
export const BUILD_TINT_PARS = /* glsl */`
uniform sampler2D uBuildMask;
uniform vec4 uBuildRect;
uniform float uBuildOn;
float mlBuildIn(vec2 xz) {
  vec2 uv = (xz - uBuildRect.xy) * uBuildRect.zw;
  float inRect = step(0.0, uv.x) * step(0.0, uv.y) * step(uv.x, 1.0) * step(uv.y, 1.0);
  return texture2D(uBuildMask, clamp(uv, vec2(0.001), vec2(0.999))).r * inRect;
}
// albedo: the builder's land a little warmer and lighter, the rest darker and greyer
vec3 mlBuildTint(vec3 col, float m) {
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  vec3 outside = mix(col, vec3(lum), 0.3) * 0.64;
  vec3 inside = col * vec3(1.07, 1.05, 0.93) + vec3(0.012, 0.01, 0.0);
  return mix(col, mix(outside, inside, smoothstep(0.25, 0.75, m)), uBuildOn);
}
// emissive: the edge line (constant pixel width) and a soft glow just inside it
vec3 mlBuildGlow(float m) {
  float w = max(fwidth(m), 1e-4);
  float line = 1.0 - smoothstep(0.6, 1.6, abs(m - 0.5) / w);
  float band = smoothstep(0.45, 0.6, m) * (1.0 - smoothstep(0.6, 0.98, m));
  return (vec3(1.0, 0.8, 0.38) * line * 0.9 + vec3(0.5, 0.36, 0.12) * band * 0.25) * uBuildOn;
}
`;

/** Grid size of the mask by the area's extent (m). */
function maskSize(extent: number): number {
  return extent > 6000 ? 1024 : extent > 1500 ? 512 : 256;
}

/**
 * Rasterises the union of polygons into an N×N coverage grid over `rect` (even-odd per polygon, OR between them),
 * then softens it (3×3 box, twice) so the half-coverage line runs smoothly between cells. Pure (tests).
 */
export function rasterizeArea(polys: AreaPolys, rect: { x0: number; z0: number; w: number; d: number }, n: number): Uint8Array {
  const hard = new Uint8Array(n * n);
  const xs: number[] = [];
  for (const poly of polys) {
    if (!poly || poly.length < 3) continue;
    for (let j = 0; j < n; j++) {
      const z = rect.z0 + ((j + 0.5) / n) * rect.d;
      xs.length = 0;
      for (let i = 0, k = poly.length - 1; i < poly.length; k = i++) {
        const a = poly[i], b = poly[k];
        if ((a.z > z) !== (b.z > z)) xs.push(a.x + ((z - a.z) / (b.z - a.z)) * (b.x - a.x));
      }
      if (xs.length < 2) continue;
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil(((xs[k] - rect.x0) / rect.w) * n - 0.5));
        const c1 = Math.min(n - 1, Math.floor(((xs[k + 1] - rect.x0) / rect.w) * n - 0.5));
        for (let i = c0; i <= c1; i++) hard[j * n + i] = 255;
      }
    }
  }
  // soften: two passes of a 3×3 box
  let src = hard, dst = new Uint8Array(n * n);
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        let sum = 0, cnt = 0;
        for (let dj = -1; dj <= 1; dj++) {
          const jj = j + dj;
          if (jj < 0 || jj >= n) continue;
          for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            if (ii < 0 || ii >= n) continue;
            sum += src[jj * n + ii]; cnt++;
          }
        }
        dst[j * n + i] = Math.round(sum / cnt);
      }
    }
    const t = src === hard ? new Uint8Array(n * n) : src;
    src = dst; dst = t;
  }
  return src;
}

/** Cheap identity of an area (reference, then counts and a coordinate sum). */
function areaKey(area: AreaPolys | null): string {
  if (!area || !area.length) return '';
  let h = 0, n = 0;
  for (const p of area) {
    if (!p) continue;
    n += p.length;
    for (let i = 0; i < p.length; i += Math.max(1, Math.floor(p.length / 16))) h = (h * 31 + Math.round(p[i].x * 10) * 7 + Math.round(p[i].z * 10)) | 0;
  }
  return `${area.length}:${n}:${h}`;
}

export class BuildAreaOverlay {
  readonly uniforms: BuildAreaUniforms;
  private key = '';
  private target = 0;
  private tex: THREE.DataTexture | null = null;
  /** Rebuilds of the mask so far (tests: only when the area changes). */
  rebuilds = 0;

  constructor(uniforms?: BuildAreaUniforms) {
    this.uniforms = uniforms ?? createBuildAreaUniforms();
  }

  get active(): boolean { return this.target > 0 || this.uniforms.uBuildOn.value > 0.001; }

  set(area: AreaPolys | null): void {
    const key = areaKey(area);
    if (key === this.key) return;
    this.key = key;
    if (!key || !area) { this.target = 0; return; }
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const p of area) for (const q of p ?? []) {
      if (!Number.isFinite(q.x) || !Number.isFinite(q.z)) continue;
      x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); z0 = Math.min(z0, q.z); z1 = Math.max(z1, q.z);
    }
    if (!(x1 > x0 && z1 > z0)) { this.target = 0; return; }
    const ext = Math.max(x1 - x0, z1 - z0);
    const n = maskSize(ext);
    // square cells, a margin of a few cells round the outline so the line never touches the mask's border
    const size = ext * (1 + 8 / n) + 4;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const rect = { x0: cx - size / 2, z0: cz - size / 2, w: size, d: size };
    const data = rasterizeArea(area, rect, n);
    this.tex?.dispose();
    const tex = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.UnsignedByteType);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.tex = tex;
    this.uniforms.uBuildMask.value = tex;
    this.uniforms.uBuildRect.value.set(rect.x0, rect.z0, 1 / rect.w, 1 / rect.d);
    this.target = 1;
    this.rebuilds++;
  }

  /** Ease the tint in and out (~0.35 s). */
  update(dt: number): void {
    const u = this.uniforms.uBuildOn;
    const k = 1 - Math.exp(-Math.max(0, dt) * 9);
    u.value += (this.target - u.value) * (dt > 0 ? k : 1);
    if (Math.abs(u.value - this.target) < 0.002) u.value = this.target;
  }

  dispose(): void {
    this.tex?.dispose();
    this.tex = null;
    this.uniforms.uBuildMask.value = null;
  }
}
