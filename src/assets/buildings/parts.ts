// Architectural parts shared by all building recipes: wall surfaces, timber framing,
// openings (doors, windows, lancets), chimneys, plinths and the generic "house" kit.
import type { P2 } from '../../core/math';
import { archShape, F, Layer, Mat, MeshBuilder, mixHex, shade, type V2, type V3 } from '../core/builder';
import { buildCone, buildRoof, roofLook, type RoofMat, type RoofResult, type RoofSpec, type Side } from './roof';
import { COL, roofTint, wallColor, type CultureStyle, type FrameKind, type WallKind } from './style';

export type { Side } from './roof';

export interface Rect { x0: number; x1: number; z0: number; z1: number; }

export interface AnimPart {
  /** Pivot position in building space. */
  pivot: V3;
  builder: MeshBuilder;
  kind: 'spinZ' | 'spinX' | 'swing' | 'flag' | 'yawToWind';
  /** rad/s at nominal wind (spin) or swing amplitude (rad). */
  speed: number;
  mat: 'opaque' | 'cloth';
  /** Nested parts that move with this one (e.g. windmill sails on the turning buck). */
  children?: AnimPart[];
}

export interface FlagSpec { pos: V3; w: number; h: number; color: number; color2?: number; kind: 'banner' | 'pennant' | 'standard'; }
export interface EmitterSpec { kind: 'sparks' | 'smoke' | 'splash' | 'fire' | 'hearth_smoke' | 'dust'; pos: V3; rate: number; }

export interface RecipeOut {
  doors: P2[];
  smoke: V3[];
  anims: AnimPart[];
  flags: FlagSpec[];
  emitters: EmitterSpec[];
  /** Points where fire FX should spawn when the building burns. */
  fire: V3[];
}

export interface Ctx {
  b: MeshBuilder;
  s: CultureStyle;
  level: number;
  lod: 0 | 1 | 2;
  r: () => number;
  seed: number;
  owner: number;
  out: RecipeOut;
}

export function newOut(): RecipeOut {
  return { doors: [], smoke: [], anims: [], flags: [], emitters: [], fire: [] };
}

export function pick<T>(r: () => number, arr: readonly T[]): T { return arr[Math.floor(r() * arr.length) % arr.length]; }

export function sideLen(rc: Rect, s: Side): number { return s === 'pz' || s === 'nz' ? rc.x1 - rc.x0 : rc.z1 - rc.z0; }

/** Enter the local frame of a wall face: u along the wall (left→right seen from outside), v up, n outward. */
export function enterSide(b: MeshBuilder, rc: Rect, s: Side, y0: number): void {
  const cx = (rc.x0 + rc.x1) / 2, cz = (rc.z0 + rc.z1) / 2;
  b.push();
  if (s === 'pz') b.translate(cx, y0, rc.z1);
  else if (s === 'nz') { b.translate(cx, y0, rc.z0); b.rotY(Math.PI); }
  else if (s === 'px') { b.translate(rc.x1, y0, cz); b.rotY(Math.PI / 2); }
  else { b.translate(rc.x0, y0, cz); b.rotY(-Math.PI / 2); }
}

export const SIDES: Side[] = ['pz', 'px', 'nz', 'nx'];

// ---------------------------------------------------------------------------
// Wall surfaces (in a side frame; u ∈ [-L/2, L/2], v ∈ [v0, v1], plane n = 0)

export interface SurfaceOpts { kind: WallKind; color: number; lod: 0 | 1 | 2; seed?: number; }

/** Fill a rectangle or polygon outline of a wall face with the wall material. */
export function wallSurface(b: MeshBuilder, L: number, v0: number, v1: number, o: SurfaceOpts, poly?: V2[]): void {
  const c = o.color;
  if (poly) {
    // Gables and odd shapes: plain fill (coursing approximated by colour bands).
    b.flat(poly, 0, c);
    return;
  }
  const u0 = -L / 2, u1 = L / 2;
  const H = v1 - v0;
  if (o.lod >= 1 || H <= 0.01) {
    b.quadGrad([u0, v0, 0], [u1, v0, 0], [u1, v1, 0], [u0, v1, 0], shade(c, 0.93), shade(c, 0.93), c, c);
    return;
  }
  switch (o.kind) {
    case 'stone': case 'rubble': {
      // Coursed stone as tonal bands with a few joints: reads as masonry at any distance.
      const ch = o.kind === 'stone' ? 0.72 : 0.62;
      const rows = Math.min(9, Math.max(1, Math.round(H / ch)));
      const rh = H / rows;
      const tones = o.kind === 'stone'
        ? [c, shade(c, 0.95), shade(c, 1.04), shade(c, 0.98), mixHex(c, 0xb8ad94, 0.25)]
        : [c, shade(c, 0.9), shade(c, 1.07), mixHex(c, 0x8a7a62, 0.3), shade(c, 0.97), mixHex(c, 0x9aa098, 0.25)];
      const seed = Math.round(L * 13 + H * 7);
      for (let r = 0; r < rows; r++) {
        const va = v0 + r * rh, vb = va + rh;
        const joints = Math.min(3, 1 + Math.floor(L / 4));
        let u = u0;
        for (let k = 0; k < joints; k++) {
          const ue = k === joints - 1 ? u1 : u + (L / joints) * (0.6 + hashN(seed + r * 7 + k, 5) * 0.8);
          const e = Math.min(u1, ue);
          b.quad([u, va, 0], [e, va, 0], [e, vb, 0], [u, vb, 0], tones[Math.floor(hashN(seed + r * 17 + k, 9) * tones.length)]);
          u = e;
          if (u >= u1 - 1e-4) break;
        }
      }
      return;
    }
    case 'weatherboard': case 'planks': {
      if (o.kind === 'planks') {
        // Vertical boards with alternating tone (stave / plank walls).
        const bw = L > 8 ? 0.8 : 0.45;
        const n = Math.max(1, Math.round(L / bw));
        const w = L / n;
        for (let i = 0; i < n; i++) {
          const ua = u0 + i * w, ub = ua + w;
          const t = shade(c, i % 2 ? 0.92 : 1.04 + (hashN(i, 2) - 0.5) * 0.08);
          b.quadGrad([ua, v0, 0], [ub, v0, 0], [ub, v1, 0], [ua, v1, 0], shade(t, 0.9), shade(t, 0.9), t, t);
        }
        return;
      }
      const bh = 0.3;
      const n = Math.max(1, Math.round(H / bh));
      const h = H / n;
      const lip = 0.035;
      for (let i = 0; i < n; i++) {
        const va = v0 + i * h, vb = va + h;
        const t = shade(c, 1 + (hashN(i, 4) - 0.5) * 0.1);
        b.quad([u0, va, lip], [u1, va, lip], [u1, vb, 0], [u0, vb, 0], t);
        b.quad([u0, va, 0], [u1, va, 0], [u1, va, lip], [u0, va, lip], shade(t, 0.55));
      }
      return;
    }
    case 'wattle': {
      const bh = 0.22;
      const n = Math.max(1, Math.round(H / bh));
      const h = H / n;
      for (let i = 0; i < n; i++) {
        const va = v0 + i * h, vb = va + h;
        b.quad([u0, va, 0], [u1, va, 0], [u1, vb, 0], [u0, vb, 0], shade(c, i % 2 ? 0.88 : 1.06));
      }
      return;
    }
    default: {
      // Daub / render / whitewash: two bands with a soft gradient (dirtier low down).
      const vm = v0 + H * 0.35;
      b.quadGrad([u0, v0, 0], [u1, v0, 0], [u1, vm, 0], [u0, vm, 0], shade(c, 0.9), shade(c, 0.9), shade(c, 0.98), shade(c, 0.98));
      b.quadGrad([u0, vm, 0], [u1, vm, 0], [u1, v1, 0], [u0, v1, 0], shade(c, 0.98), shade(c, 0.98), c, c);
    }
  }
}

function hashN(a: number, b: number): number {
  let h = Math.imul(a + 0x9e37, 0x27d4eb2d) ^ Math.imul(b + 17, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------
// Openings

export type OpeningKind = 'door' | 'window' | 'wide' | 'slit' | 'shop' | 'loft' | 'lancet' | 'big' | 'louvre' | 'oculus';
export interface Opening {
  side: Side;
  /** Centre along the wall, from the wall centre (u). */
  u: number;
  w: number;
  h: number;
  /** Sill / threshold height above the storey base. */
  y: number;
  kind: OpeningKind;
  shape?: 'flat' | 'round' | 'pointed' | 'tudor';
  frame?: 'timber' | 'stone';
  shutters?: boolean;
  /** Door left open (dark interior visible). */
  open?: boolean;
  /** Glow multiplier for lit windows (default random 0.55..1). */
  lit?: number;
  /** Mullion count override. */
  mullions?: number;
  color?: number;
}

const DARK = 0x1a1511;

/** Flush decal quad in a side frame at depth d (2 triangles). */
export function dq(b: MeshBuilder, u0: number, v0: number, u1: number, v1: number, d: number, col: number): void {
  b.quad([u0, v0, d], [u1, v0, d], [u1, v1, d], [u0, v1, d], col);
}

/** Flush diagonal strip from (ua, va) to (ub, vb), width w, at depth d (2 triangles). */
export function dstrip(b: MeshBuilder, ua: number, va: number, ub: number, vb: number, w: number, d: number, col: number): void {
  const du = ub - ua, dv = vb - va;
  const L = Math.hypot(du, dv) || 1;
  const pu = (-dv / L) * (w / 2), pv = (du / L) * (w / 2);
  const A: V3 = [ua - pu, va - pv, d], B: V3 = [ub - pu, vb - pv, d], C: V3 = [ub + pu, vb + pv, d], D: V3 = [ua + pu, va + pv, d];
  // Keep CCW as seen from +n.
  const cross = (B[0] - A[0]) * (D[1] - A[1]) - (B[1] - A[1]) * (D[0] - A[0]);
  if (cross >= 0) b.quad(A, B, C, D, col); else b.quad(A, D, C, B, col);
}

/** Emit an opening in the current side frame (plane n = 0). */
export function opening(ctx: Ctx, o: Opening): void {
  const { b, s, lod, r } = ctx;
  const hw = o.w / 2;
  const u = o.u;
  const isDoor = o.kind === 'door' || o.kind === 'wide';
  const stoneFrame = o.frame === 'stone';
  const shape = o.shape ?? 'flat';
  const trim = stoneFrame ? s.stoneTrim : s.timber;
  const segs = lod === 0 && o.w > 1.3 ? 4 : 2;
  const outline = (o.kind === 'big' && shape === 'round' && Math.abs(o.w - o.h) < 0.01 ? circleShape(o.w / 2, lod === 0 ? 12 : 8, o.h / 2) : archShape(o.w, o.h, shape, segs)).map(([x, y]) => [x + u, y + o.y] as V2);
  const domestic = o.kind === 'window' || o.kind === 'shop';

  b.state({ layer: Layer.Detail, flags: F.Snow | F.Burn }, () => {
    if (stoneFrame) {
      const grow = 0.15;
      const sur = (o.kind === 'big' && shape === 'round' && Math.abs(o.w - o.h) < 0.01 ? circleShape(o.w / 2 + grow, lod === 0 ? 12 : 8, o.h / 2) : archShape(o.w + grow * 2, o.h + grow, shape, segs)).map(([x, y]) => [x + u, y + o.y - (isDoor ? 0 : grow * 0.6)] as V2);
      b.flat(sur, 0.012, trim);
      if (!isDoor && domestic && lod === 0) b.box(u - hw - 0.12, o.y - 0.14, 0, u + hw + 0.12, o.y - 0.03, 0.1, shade(trim, 0.95), 'nz');
    } else if (lod < 2) {
      const t = 0.09, d = 0.05;
      dq(b, u - hw - t, o.y - (isDoor ? 0 : t), u - hw, o.y + o.h, d, trim);
      dq(b, u + hw, o.y - (isDoor ? 0 : t), u + hw + t, o.y + o.h, d, trim);
      dq(b, u - hw - t * 1.6, o.y + o.h, u + hw + t * 1.6, o.y + o.h + t * 1.3, d + 0.006, trim);
      if (!isDoor) b.box(u - hw - t, o.y - t * 1.1, 0, u + hw + t, o.y, 0.1, shade(trim, 1.1), 'nz');
    }
  });

  if (isDoor) {
    const leafCol = o.color ?? pick(r, s.doors);
    if (o.open || o.kind === 'wide') {
      b.state({ layer: Layer.Detail, flags: F.NoAO }, () => b.flat(outline, 0.02, DARK));
      if (o.kind === 'wide' && lod === 0 && !o.open) {
        // A half-open leaf swung outwards.
        b.state({ layer: Layer.Detail, flags: F.Burn | F.Snow }, () => {
          b.push();
          b.translate(u + hw, o.y, 0.03);
          b.rotY(-0.5);
          b.box(0, 0, -0.03, Math.min(o.w * 0.5, 0.85), o.h * 0.92, 0.03, { side: shade(leafCol, 0.9), pz: leafCol, nz: shade(leafCol, 0.85) });
          b.pop();
        });
      }
    } else {
      b.state({ layer: Layer.Detail, flags: F.Burn | F.Snow }, () => {
        if (shape === 'flat') planks(b, u - hw, u + hw, o.y, o.y + o.h, 0.03, leafCol, lod);
        else {
          b.flat(outline, 0.03, leafCol);
          if (lod === 0) for (let i = 1; i < 4; i++) {
            const x = u - hw + (o.w * i) / 4;
            dq(b, x - 0.012, o.y, x + 0.012, o.y + o.h * 0.72, 0.036, shade(leafCol, 0.72));
          }
        }
        if (lod === 0) {
          for (const hy of [0.25, 0.75]) dq(b, u - hw + 0.04, o.y + o.h * hy - 0.03, u + hw * 0.55, o.y + o.h * hy + 0.03, 0.04, COL.iron);
          dq(b, u + hw * 0.62, o.y + o.h * 0.47, u + hw * 0.76, o.y + o.h * 0.53, 0.045, COL.iron);
        }
      });
    }
    b.state({ layer: Layer.Ground, flags: F.Snow }, () => {
      if (o.y < 0.05) b.box(u - hw - 0.12, -0.3, 0, u + hw + 0.12, 0.08, 0.32, stoneFrame ? shade(s.stone, 0.95) : COL.stoneGrey, 'nz');
      else if (o.y > 0.2 && o.y < 1.3) {
        const n = Math.max(1, Math.round(o.y / 0.22));
        for (let i = 0; i < n; i++) {
          const top = o.y - (o.y * i) / n;
          b.box(u - hw - 0.1, -0.3, 0, u + hw + 0.1, top, 0.3 + i * 0.3, COL.stoneGrey, 'nz');
        }
      }
    });
    const pt = b.xf([u, 0, 0.55]);
    ctx.out.doors.push({ x: pt[0], z: pt[2] });
    return;
  }

  // Windows and the like: emissive pane, then mullions and shutters.
  const lit = o.lit ?? (r() < 0.22 ? 0.18 : 0.55 + r() * 0.45);
  b.state({ layer: Layer.Detail, mat: Mat.Window, flags: F.NoAO }, () => paneFlat(b, outline, 0.02, lit));
  if (lod === 0 && o.kind !== 'slit' && o.kind !== 'oculus') {
    b.state({ layer: Layer.Detail, flags: F.Burn | F.Snow }, () => {
      const nm = o.mullions ?? (o.kind === 'louvre' ? Math.max(2, Math.round(o.h / 0.2)) : o.w > 1.3 ? 3 : o.w > 0.55 ? (stoneFrame ? 1 : 2) : 0);
      const mc = stoneFrame ? trim : shade(s.timber, 1.1);
      if (o.kind === 'louvre') {
        for (let i = 0; i < nm; i++) {
          const y = o.y + ((i + 0.5) * o.h) / nm;
          dq(b, u - hw, y - 0.045, u + hw, y + 0.045, 0.04, shade(trim, 1.05));
        }
      } else {
        const topY = shape === 'flat' ? o.y + o.h : o.y + o.h - o.w * 0.45;
        for (let i = 1; i <= nm; i++) {
          const x = u - hw + (o.w * i) / (nm + 1);
          dq(b, x - 0.035, o.y, x + 0.035, topY, 0.035, mc);
        }
        if (stoneFrame && o.h > 1.6 && o.w > 0.7) dq(b, u - hw, o.y + o.h * 0.55 - 0.035, u + hw, o.y + o.h * 0.55 + 0.035, 0.03, trim);
      }
      if (o.shutters && !stoneFrame) {
        const sc = pick(r, s.shutters);
        const sw = Math.min(hw, 0.45);
        planks(b, u - hw - 0.1 - sw, u - hw - 0.1, o.y, o.y + o.h, 0.025, sc, 1);
        if (r() < 0.6) planks(b, u + hw + 0.1, u + hw + 0.1 + sw, o.y, o.y + o.h, 0.025, sc, 1);
      }
    });
  }
}

/** Circle (rose window / oculus) outline centred at (0, cy). */
function circleShape(r: number, n: number, cy: number): V2[] {
  const out: V2[] = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2 - Math.PI / 2; out.push([Math.cos(a) * r, cy + Math.sin(a) * r]); }
  return out;
}

function paneFlat(b: MeshBuilder, outline: V2[], z: number, lit: number): void {
  const g = COL.glowWindow;
  const gr = ((g >> 16) & 255) / 255, gg = ((g >> 8) & 255) / 255, gb = (g & 255) / 255;
  // Vertex colour carries the glow tint × per-window intensity (used as emissive only).
  const cc = [gr * gr * lit, gg * gg * lit, gb * gb * lit];
  let area = 0;
  for (let i = 0; i < outline.length; i++) { const a = outline[i], c = outline[(i + 1) % outline.length]; area += a[0] * c[1] - c[0] * a[1]; }
  const pts = area < 0 ? [...outline].reverse() : outline;
  for (let i = 1; i < pts.length - 1; i++) {
    b.triCols([pts[0][0], pts[0][1], z], [pts[i][0], pts[i][1], z], [pts[i + 1][0], pts[i + 1][1], z], cc, cc, cc);
  }
}

/** Plank leaf (door / shutter): flush boards with alternating tone, at depth d. */
export function planks(b: MeshBuilder, u0: number, u1: number, v0: number, v1: number, d: number, color: number, lod: number): void {
  const n = lod === 0 ? Math.max(2, Math.round((u1 - u0) / 0.24)) : 1;
  const w = (u1 - u0) / n;
  for (let i = 0; i < n; i++) {
    const a = u0 + i * w, c = a + w;
    dq(b, a, v0, c, v1, d + (i % 2) * 0.004, shade(color, i % 2 ? 0.9 : 1.04));
  }
}

// ---------------------------------------------------------------------------
// Timber framing (flush decals just proud of the wall surface)

export interface FrameOpts {
  kind: FrameKind;
  color: number;
  /** Openings on this face (u, y relative to the storey base). */
  openings: Opening[];
  lod: 0 | 1 | 2;
  /** Draw the sole plate (bottom storey) / girding beam. */
  sole?: boolean;
  /** Corner posts present. */
  corners?: boolean;
}

const DP = 0.04, DR = 0.034, DB = 0.028, DPL = 0.046;

export function frameFace(b: MeshBuilder, L: number, H: number, o: FrameOpts): void {
  if (o.kind === 'none' || o.lod >= 2) return;
  const c = o.color;
  const pw = 0.2;
  const u0 = -L / 2, u1 = L / 2;
  b.state({ layer: Layer.Frame, flags: F.Burn | F.Snow }, () => {
    const soleH = 0.16, plateH = 0.18;
    if (o.sole ?? true) {
      const doors = o.openings.filter((p) => (p.kind === 'door' || p.kind === 'wide') && p.y < 0.1);
      let a = u0;
      for (const dd of [...doors].sort((p, q) => p.u - q.u)) {
        const e = dd.u - dd.w / 2 - 0.09;
        if (e > a + 0.05) dq(b, a, 0, e, soleH, DPL, c);
        a = dd.u + dd.w / 2 + 0.09;
      }
      if (u1 > a + 0.05) dq(b, a, 0, u1, soleH, DPL, c);
    }
    dq(b, u0, H - plateH, u1, H, DPL, c);
    if (o.lod >= 1 && o.kind !== 'close') {
      if (o.corners ?? true) { dq(b, u0, soleH, u0 + pw, H - plateH, DP, c); dq(b, u1 - pw, soleH, u1, H - plateH, DP, c); }
      return;
    }
    const spacing = o.kind === 'close' ? 0.55 : o.kind === 'square' ? 1.25 : o.kind === 'fachwerk' ? 1.15 : 1.7;
    const sw = o.kind === 'close' ? 0.15 : pw;
    const blocked = (uu: number, v0: number, v1: number) => o.openings.some((p) => uu > p.u - p.w / 2 - 0.12 && uu < p.u + p.w / 2 + 0.12 && v1 > p.y - 0.12 && v0 < p.y + p.h + 0.12);
    const posts: number[] = [];
    if (o.corners ?? true) posts.push(u0 + pw / 2, u1 - pw / 2);
    for (const p of o.openings) posts.push(p.u - p.w / 2 - 0.1 - sw / 2, p.u + p.w / 2 + 0.1 + sw / 2);
    const n = Math.max(1, Math.round(L / spacing));
    for (let i = 1; i < n; i++) posts.push(u0 + (L * i) / n);
    posts.sort((a, z) => a - z);
    const merged: number[] = [];
    for (const p of posts) {
      if (p < u0 + pw * 0.4 || p > u1 - pw * 0.4) continue;
      if (merged.length && p - merged[merged.length - 1] < (o.kind === 'close' ? 0.32 : 0.45)) continue;
      merged.push(p);
    }
    const vA = soleH, vB = H - plateH;
    const rails: number[] = o.kind === 'square' ? [H / 3, (2 * H) / 3] : o.kind === 'fachwerk' ? [Math.min(0.95, H * 0.36), H * 0.72] : o.kind === 'close' ? [H * 0.48] : [H * 0.5];
    for (const p of merged) {
      let segs: [number, number][] = [[vA, vB]];
      for (const op of o.openings) {
        if (p > op.u - op.w / 2 - 0.05 && p < op.u + op.w / 2 + 0.05) {
          const out: [number, number][] = [];
          for (const [a, z] of segs) {
            if (op.y + op.h < a || op.y > z) { out.push([a, z]); continue; }
            if (op.y - 0.1 > a) out.push([a, op.y - 0.1]);
            if (op.y + op.h + 0.12 < z) out.push([op.y + op.h + 0.12, z]);
          }
          segs = out;
        }
      }
      for (const [a, z] of segs) if (z - a > 0.1) dq(b, p - sw / 2, a, p + sw / 2, z, DP, c);
    }
    const all = [u0, ...merged, u1];
    for (const rv of rails) {
      // One continuous rail behind the posts, broken only where an opening crosses it.
      const cuts = o.openings.filter((p) => rv + 0.07 > p.y - 0.12 && rv - 0.07 < p.y + p.h + 0.12).map((p) => [p.u - p.w / 2 - 0.1 - sw, p.u + p.w / 2 + 0.1 + sw] as [number, number]).sort((x, y) => x[0] - y[0]);
      let a = u0 + pw * 0.5;
      for (const [c0, c1] of cuts) {
        if (c0 - a > 0.08) dq(b, a, rv - 0.07, c0, rv + 0.07, DR, c);
        a = Math.max(a, c1);
      }
      if (u1 - pw * 0.5 - a > 0.08) dq(b, a, rv - 0.07, u1 - pw * 0.5, rv + 0.07, DR, c);
    }
    if (o.kind === 'box' || o.kind === 'cruck' || o.kind === 'square') {
      const panels: [number, number][] = [];
      if (merged.length >= 2) { panels.push([merged[0], merged[1]]); panels.push([merged[merged.length - 1], merged[merged.length - 2]]); }
      for (const [pa, pb] of panels) {
        if (blocked((pa + pb) / 2, vA, vB)) continue;
        const dir = Math.sign(pb - pa);
        const ua = pa + dir * sw * 0.5, ub = pb - dir * sw * 0.5;
        if (Math.abs(ub - ua) > 0.4) dstrip(b, ua, rails[0] - 0.05, ub, vB - 0.02, 0.13, DB, c);
      }
    }
    if (o.kind === 'fachwerk') {
      for (let i = 0; i < all.length - 1; i++) {
        const a = all[i] + (i === 0 ? pw : sw / 2), z = all[i + 1] - (i + 1 === all.length - 1 ? pw : sw / 2);
        if (z - a < 0.45) continue;
        const mid = (a + z) / 2;
        const r0 = rails[0];
        if (!blocked(mid, vA, r0)) {
          dstrip(b, a, vA + 0.02, z, r0 - 0.07, 0.11, DB, c);
          dstrip(b, z, vA + 0.02, a, r0 - 0.07, 0.11, DB - 0.004, c);
        }
        if ((i === 0 || i === all.length - 2) && !blocked(mid, r0, vB)) {
          const outer = i === 0 ? a : z, inner = i === 0 ? z : a;
          dstrip(b, outer, r0 + 0.07, inner, vB - 0.02, 0.12, DB, c);
          dstrip(b, outer, vB - 0.02, inner, (r0 + vB) / 2, 0.11, DB - 0.004, c);
        }
      }
    }
  });
}

/** Gable-end framing above the tie beam: cruck blades, king post, Fachwerk or close studs. */
export function frameGable(b: MeshBuilder, L: number, H: number, apex: number, kind: FrameKind, color: number, lod: number, fromGround = false): void {
  if (kind === 'none' || lod >= 2) return;
  const c = color;
  const hw = L / 2;
  b.state({ layer: Layer.Frame, flags: F.Burn | F.Snow }, () => {
    const rise = apex - H;
    if (kind === 'cruck') {
      // Two curved blades from the ground to the apex, with a collar.
      const base = fromGround ? 0.05 : H;
      for (const sd of [-1, 1]) {
        const pts: V2[] = [
          [sd * (hw - 0.16), base],
          [sd * (hw - 0.22), base + (H - base) * 0.6 + rise * 0.05],
          [sd * (hw * 0.62), H + rise * 0.42],
          [sd * 0.1, apex - 0.16],
        ];
        for (let i = 0; i < pts.length - 1; i++) dstrip(b, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], 0.24, DP + 0.004, c);
      }
      dq(b, -hw * 0.5, H + rise * 0.5 - 0.08, hw * 0.5, H + rise * 0.5 + 0.08, DR, c);
      return;
    }
    if (kind === 'fachwerk') {
      dq(b, -0.09, H, 0.09, apex - 0.2, DP, c);
      const ym = H + rise * 0.5, xm = hw * 0.5;
      dq(b, -xm, ym - 0.07, xm, ym + 0.07, DR, c);
      if (lod === 0) {
        dstrip(b, -hw * 0.82, H + 0.05, -0.09, ym - 0.07, 0.11, DB, c);
        dstrip(b, hw * 0.82, H + 0.05, 0.09, ym - 0.07, 0.11, DB, c);
        dstrip(b, -xm * 0.8, ym + 0.07, -0.09, apex - 0.4, 0.1, DB, c);
        dstrip(b, xm * 0.8, ym + 0.07, 0.09, apex - 0.4, 0.1, DB, c);
      }
      return;
    }
    if (kind === 'close') {
      const n = Math.max(2, Math.round(L / 0.55));
      for (let i = 1; i < n; i++) {
        const u = -hw + (L * i) / n;
        const top = apex - (Math.abs(u) / hw) * rise - 0.12;
        if (top - H > 0.25) dq(b, u - 0.075, H, u + 0.075, top, DP, c);
      }
      return;
    }
    dq(b, -0.1, H, 0.1, apex - 0.15, DP, c);
    if (lod === 0) {
      dstrip(b, -0.1, H + 0.12, -hw * 0.5, H + rise * 0.5 - 0.05, 0.13, DB, c);
      dstrip(b, 0.1, H + 0.12, hw * 0.5, H + rise * 0.5 - 0.05, 0.13, DB, c);
    }
  });
}

// ---------------------------------------------------------------------------
// Chimneys, plinths, misc

export interface ChimneyOpts {
  x: number; z: number;
  baseY: number; topY: number;
  w?: number; d?: number;
  color?: number;
  pots?: number;
  /** External gable stack: wide base that steps in at `shoulderY`. */
  shoulderY?: number;
  /** Which way the external base projects (outwards). */
  out?: Side;
  /** Breast (base) size below the shoulder; defaults derive from w/d. */
  baseW?: number;
  baseD?: number;
}

export function chimney(ctx: Ctx, o: ChimneyOpts): void {
  const { b, lod } = ctx;
  const w = o.w ?? 0.75, d = o.d ?? 0.65;
  const col = o.color ?? ctx.s.stone;
  b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
    if (o.shoulderY !== undefined) {
      const bw = o.baseW ?? w * 1.25, bd = o.baseD ?? d * 1.6;
      let cx = o.x, cz = o.z;
      const sh = o.shoulderY;
      b.box(cx - bw / 2, o.baseY, cz - bd / 2, cx + bw / 2, sh, cz + bd / 2, col);
      b.taperBox(cx - bw / 2, sh, cz - bd / 2, cx + bw / 2, sh + 0.5, cz + bd / 2, (bw - w) / 2, (bd - d) / 2, { side: shade(col, 0.97), top: shade(col, 1.05) });
      b.box(cx - w / 2, sh + 0.5, cz - d / 2, cx + w / 2, o.topY, cz + d / 2, col, 'b');
      void cx; void cz;
    } else {
      b.box(o.x - w / 2, o.baseY, o.z - d / 2, o.x + w / 2, o.topY, o.z + d / 2, col, 'b');
    }
    if (lod < 2) b.box(o.x - w / 2 - 0.07, o.topY - 0.22, o.z - d / 2 - 0.07, o.x + w / 2 + 0.07, o.topY - 0.06, o.z + d / 2 + 0.07, shade(col, 0.88));
    const pots = lod === 0 ? (o.pots ?? 0) : 0;
    for (let i = 0; i < pots; i++) {
      const px = o.x + (pots === 1 ? 0 : (i / (pots - 1) - 0.5) * (w * 0.5));
      b.cyl(px, o.z, o.topY, o.topY + 0.38, 0.12, 0.1, 6, { side: COL.brick, top: DARK });
    }
    if (lod === 0) b.box(o.x - w / 2 + 0.1, o.topY - 0.02, o.z - d / 2 + 0.1, o.x + w / 2 - 0.1, o.topY + 0.01, o.z + d / 2 - 0.1, DARK);
  });
  ctx.out.smoke.push([o.x, o.topY + (o.pots ? 0.45 : 0.15), o.z]);
}

/** Stone plinth / sill wall under a building, sunk into the ground to hide terrain mismatch. */
export function plinth(b: MeshBuilder, rc: Rect, h: number, color: number, out = 0.06): void {
  b.state({ layer: Layer.Ground, flags: F.Snow }, () => {
    b.box(rc.x0 - out, -0.8, rc.z0 - out, rc.x1 + out, h, rc.z1 + out, { side: color, top: shade(color, 1.05) });
  });
}

/** Earthen floor inside (visible while building / in ruins). */
export function floor(b: MeshBuilder, rc: Rect, y: number, color = COL.yard): void {
  b.state({ layer: Layer.Ground, flags: F.NoAO }, () => b.box(rc.x0 + 0.05, y - 0.05, rc.z0 + 0.05, rc.x1 - 0.05, y, rc.z1 - 0.05, color, 'b'));
}

// ---------------------------------------------------------------------------
// The house kit

export interface StoreyOpts {
  h: number;
  wall: WallKind;
  frame?: FrameKind;
  color?: number;
  jetty?: Partial<Record<Side, number>>;
  openings?: Opening[];
  quoins?: boolean;
  /** Open sides (no wall; posts carry the plate) — interior faces are added. */
  open?: Side[];
  /** Post spacing on open sides (m). */
  postSpacing?: number;
}

export interface HouseOpts {
  rect: Rect;
  plinthH?: number;
  plinthColor?: number;
  storeys: StoreyOpts[];
  /** null = walls only (the caller roofs a composite building itself). */
  roof: (Omit<RoofSpec, 'x0' | 'x1' | 'z0' | 'z1' | 'eaveY'> & { mat: RoofMat; tint?: number }) | null;
  gableFrame?: FrameKind;
  /** Gable wall treatment above the top storey. */
  gableWall?: WallKind;
  /** Stone gable parapets: plain coping or crow-steps. */
  parapet?: 'coping' | 'crow';
  /** Cruck blades from the ground on the gables. */
  cruck?: boolean;
  /** Skip the floor slab. */
  noFloor?: boolean;
  /** Gael roped thatch. */
  roped?: boolean;
}

export interface HouseResult {
  roof: RoofResult;
  top: Rect;
  eaveY: number;
  rects: Rect[];
  bases: number[];
}

function expand(rc: Rect, j?: Partial<Record<Side, number>>): Rect {
  if (!j) return { ...rc };
  return { x0: rc.x0 - (j.nx ?? 0), x1: rc.x1 + (j.px ?? 0), z0: rc.z0 - (j.nz ?? 0), z1: rc.z1 + (j.pz ?? 0) };
}

export function house(ctx: Ctx, o: HouseOpts): HouseResult {
  const { b, s, lod } = ctx;
  const ph = o.plinthH ?? 0.3;
  if (ph > 0) plinth(b, o.rect, ph, o.plinthColor ?? s.plinth);
  if (!o.noFloor) floor(b, o.rect, Math.max(0.05, ph));
  let rc = { ...o.rect };
  let y = ph;
  const rects: Rect[] = [];
  const bases: number[] = [];
  o.storeys.forEach((st, si) => {
    if (si > 0) rc = expand(rc, st.jetty);
    rects.push({ ...rc });
    bases.push(y);
    const col = st.color ?? wallColor(st.wall, s);
    const frame = st.frame ?? 'none';
    const openSides = st.open ?? [];
    for (const side of SIDES) {
      const L = sideLen(rc, side);
      enterSide(b, rc, side, y);
      if (openSides.includes(side)) {
        if (si === 0) { const dp = b.xf([0, 0, 0.5]); ctx.out.doors.push({ x: dp[0], z: dp[2] }); }
        // Open front: posts and a wall plate instead of a wall.
        b.state({ layer: Layer.Wall, flags: F.Snow | F.Burn }, () => {
          const n = Math.max(1, Math.round(L / (st.postSpacing ?? 2.6)));
          for (let i = 0; i <= n; i++) {
            const u = -L / 2 + 0.12 + ((L - 0.24) * i) / n;
            b.box(u - 0.11, 0, -0.24, u + 0.11, st.h, -0.02, { side: s.timber, top: s.timber });
          }
          b.box(-L / 2, st.h - 0.24, -0.26, L / 2, st.h, 0.0, s.timber);
        });
        b.pop();
        continue;
      }
      b.state({ layer: Layer.Wall, flags: F.Snow }, () => wallSurface(b, L, 0, st.h, { kind: st.wall, color: col, lod }));
      if (openSides.length) {
        // Inner face of this wall, seen through the open side (darker: interior shade).
        b.state({ layer: Layer.Wall, flags: F.NoAO }, () => {
          b.quad([L / 2 - 0.05, 0, -0.06], [-L / 2 + 0.05, 0, -0.06], [-L / 2 + 0.05, st.h, -0.06], [L / 2 - 0.05, st.h, -0.06], shade(col, 0.55));
        });
      }
      const ops = (st.openings ?? []).filter((p) => p.side === side);
      frameFace(b, L, st.h, { kind: frame, color: s.timber, openings: ops, lod, sole: si === 0 || (st.jetty?.[side] ?? 0) > 0 || true });
      if (st.quoins && lod === 0) quoins(b, L, st.h, shade(col, 1.08));
      for (const p of ops) opening(ctx, p);
      b.pop();
    }
    // Jetty soffit, bressumer and joist ends.
    if (si > 0 && st.jetty) {
      const prev = rects[si - 1];
      b.state({ layer: Layer.Wall, flags: F.NoAO | F.Burn }, () => {
        b.quad([rc.x0, y, rc.z0], [rc.x1, y, rc.z0], [rc.x1, y, rc.z1], [rc.x0, y, rc.z1], shade(s.timber, 0.8));
      });
      for (const side of SIDES) {
        const j = st.jetty[side] ?? 0;
        if (j <= 0) continue;
        const L = sideLen(rc, side);
        enterSide(b, rc, side, y);
        b.state({ layer: Layer.Frame, flags: F.Burn | F.Snow }, () => {
          b.box(-L / 2, -0.06, 0, L / 2, 0.2, 0.09, s.timber);
          if (lod === 0) {
            const n = Math.max(2, Math.round(L / 0.5));
            for (let i = 0; i <= n; i++) {
              const u = -L / 2 + 0.15 + ((L - 0.3) * i) / n;
              b.box(u - 0.07, -0.22, -j - 0.02, u + 0.07, -0.06, 0.04, shade(s.timber, 0.9));
            }
          }
        });
        b.pop();
      }
      void prev;
    }
    y += st.h;
  });
  const top = rc;
  const eaveY = y;
  const r = o.roof;
  if (!r) {
    const flat: RoofResult = { ridgeY: eaveY, topY: eaveY, eaveY, axis: 'x', underAt: () => eaveY, topAt: () => eaveY, gables: [] };
    return { roof: flat, top, eaveY, rects, bases };
  }
  const look = roofLook(r.mat, r.tint ?? roofTint(r.mat, s));
  const roof = buildRoof(b, { ...r, x0: top.x0, x1: top.x1, z0: top.z0, z1: top.z1, eaveY }, look, lod);
  const topSt = o.storeys[o.storeys.length - 1];
  const gw = o.gableWall ?? topSt.wall;
  const gcol = gw === topSt.wall ? (topSt.color ?? wallColor(topSt.wall, s)) : wallColor(gw, s);
  for (const g of roof.gables) {
    const L = sideLen(top, g.side);
    enterSide(b, top, g.side, 0);
    // Gable outline in side-frame coordinates (u, v): map world points.
    const poly: V2[] = g.pts.map((p) => toSideUV(top, g.side, p));
    b.state({ layer: Layer.Wall, flags: F.Snow }, () => wallSurface(b, L, 0, 0, { kind: gw, color: gcol, lod }, poly));
    const apex = Math.max(...poly.map((p) => p[1]));
    if (o.parapet && lod < 2) parapetGable(b, poly, o.parapet, shade(gcol, 0.97), ctx.s.stoneTrim);
    else if (topSt.frame && topSt.frame !== 'none') {
      const fk = o.gableFrame ?? (o.cruck ? 'cruck' : topSt.frame);
      frameGable(b, L, eaveY, apex, fk, s.timber, lod, o.cruck);
    } else if (gw === 'weatherboard') {
      // boards already
    }
    const apexU = poly.reduce((m, p) => (p[1] > m[1] ? p : m), poly[0])[0];
    if (s.crossedGables && lod < 2 && !o.parapet && Math.abs(apexU) < 0.3) crossedBoards(b, poly, s.timber);
    b.pop();
  }
  if ((o.roped ?? false) && lod === 0) ropedThatch(ctx, top, roof);
  return { roof, top, eaveY, rects, bases };
}

/** Map a world point on a wall plane to side-frame (u, v). */
export function toSideUV(rc: Rect, side: Side, p: V3): V2 {
  const cx = (rc.x0 + rc.x1) / 2, cz = (rc.z0 + rc.z1) / 2;
  if (side === 'pz') return [p[0] - cx, p[1]];
  if (side === 'nz') return [cx - p[0], p[1]];
  if (side === 'px') return [cz - p[2], p[1]];
  return [p[2] - cz, p[1]];
}

function quoins(b: MeshBuilder, L: number, H: number, col: number): void {
  b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
    const n = Math.min(10, Math.max(1, Math.floor(H / 0.62)));
    for (let i = 0; i < n; i++) {
      const v = i * (H / n);
      const long = i % 2 === 0;
      const w = long ? 0.55 : 0.32;
      dq(b, -L / 2, v + 0.02, -L / 2 + w, v + H / n - 0.02, 0.025, col);
      dq(b, L / 2 - w, v + 0.02, L / 2, v + H / n - 0.02, 0.025, col);
    }
  });
}

function parapetGable(b: MeshBuilder, poly: V2[], kind: 'coping' | 'crow', col: number, trim: number): void {
  // Raise the gable edges above the roof with a coping (or crow-steps).
  let apexI = 0;
  for (let i = 0; i < poly.length; i++) if (poly[i][1] > poly[apexI][1]) apexI = i;
  const apex = poly[apexI];
  let left = poly[0], right = poly[0];
  for (const p of poly) { if (p[0] < left[0]) left = p; if (p[0] > right[0]) right = p; }
  const eave = Math.max(left[1], right[1]);
  const lh = 0.55, t = 0.36;
  b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
    if (kind === 'crow') {
      const steps = Math.max(3, Math.round((apex[1] - eave) / 0.6));
      for (const sd of [-1, 1]) {
        const ex = sd < 0 ? left[0] : right[0];
        for (let i = 0; i < steps; i++) {
          const f0 = i / steps, f1 = (i + 1) / steps;
          const u0 = ex + (apex[0] - ex) * f0, u1 = ex + (apex[0] - ex) * f1;
          const v = eave + (apex[1] - eave) * f1;
          const ua = Math.min(u0, u1), ub = Math.max(u0, u1);
          b.box(ua, eave - 0.2, -t, ub, v + 0.25, 0.02, { side: col, top: trim });
        }
      }
      b.box(apex[0] - 0.3, apex[1], -t, apex[0] + 0.3, apex[1] + 0.55, 0.02, { side: col, top: trim });
    } else {
      for (const sd of [-1, 1]) {
        const e = sd < 0 ? left : right;
        b.beam([e[0] - sd * 0.05, e[1] + lh * 0.5, -t / 2 + 0.01], [apex[0], apex[1] + lh * 0.5, -t / 2 + 0.01], lh, t + 0.02, { side: col, top: trim }, [0, 0, 1]);
      }
      b.box(apex[0] - 0.18, apex[1] + 0.2, -t * 0.8, apex[0] + 0.18, apex[1] + 0.95, 0.02, trim);
    }
  });
}

function crossedBoards(b: MeshBuilder, poly: V2[], col: number): void {
  let apexI = 0;
  for (let i = 0; i < poly.length; i++) if (poly[i][1] > poly[apexI][1]) apexI = i;
  const apex = poly[apexI];
  let left = poly[0], right = poly[0];
  for (const p of poly) { if (p[0] < left[0]) left = p; if (p[0] > right[0]) right = p; }
  b.state({ layer: Layer.Detail, flags: F.Burn | F.Snow }, () => {
    for (const e of [left, right]) {
      const dx = apex[0] - e[0], dy = apex[1] - e[1];
      const len = Math.hypot(dx, dy);
      const ext = 0.9 / len;
      b.beam([e[0] - dx * 0.05, e[1] - dy * 0.05 + 0.2, 0.12], [apex[0] + dx * ext, apex[1] + dy * ext + 0.2, 0.12], 0.26, 0.07, col, [0, 0, 1]);
    }
  });
}

function ropedThatch(ctx: Ctx, top: Rect, roof: RoofResult): void {
  const { b } = ctx;
  const along = roof.axis;
  b.state({ layer: Layer.Roof, flags: F.Snow }, () => {
    const L = along === 'x' ? top.x1 - top.x0 : top.z1 - top.z0;
    const D = along === 'x' ? top.z1 - top.z0 : top.x1 - top.x0;
    const n = Math.max(3, Math.round((L * 0.7) / 1.0));
    for (let i = 0; i < n; i++) {
      const t = -L * 0.35 + (L * 0.7 * i) / Math.max(1, n - 1);
      for (const sd of [1, -1]) {
        const pts: V3[] = [];
        for (let k = 0; k <= 2; k++) {
          const q = (sd * (D / 2 + 0.38) * k) / 2;
          const x = along === 'x' ? (top.x0 + top.x1) / 2 + t : (top.x0 + top.x1) / 2 + q;
          const z = along === 'x' ? (top.z0 + top.z1) / 2 + q : (top.z0 + top.z1) / 2 + t;
          pts.push([x, roof.topAt(x, z) + 0.05, z]);
        }
        for (let k = 0; k < 2; k++) b.beam(pts[k], pts[k + 1], 0.05, 0.04, COL.rope, [0, 1, 0], 'pz nz');
        const e = pts[2];
        // Hanging stone weight (octahedron).
        const sx = e[0], sy = e[1] - 0.42, sz = e[2];
        const r = 0.15;
        const A: V3 = [sx + r, sy, sz], B2: V3 = [sx - r, sy, sz], C: V3 = [sx, sy + r * 1.1, sz], Dd: V3 = [sx, sy - r, sz], E: V3 = [sx, sy, sz + r], G: V3 = [sx, sy, sz - r];
        const sc = i % 2 ? COL.stoneGrey : COL.stoneDark;
        b.tri(A, C, E, sc); b.tri(E, C, B2, sc); b.tri(B2, C, G, sc); b.tri(G, C, A, sc);
        b.tri(E, Dd, A, sc); b.tri(B2, Dd, E, sc); b.tri(G, Dd, B2, sc); b.tri(A, Dd, G, sc);
        b.beam([e[0], e[1], e[2]], [sx, sy + 0.1, sz], 0.03, 0.03, COL.rope, [0, 1, 0], 'pz nz');
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers for recipes

/** Evenly spaced windows on a side, skipping a door slot. */
export function windowRow(side: Side, L: number, count: number, o: Partial<Opening> & { w: number; h: number; y: number }, avoid: number[] = []): Opening[] {
  const out: Opening[] = [];
  if (count <= 0) return out;
  const slots: number[] = [];
  for (let i = 0; i < count; i++) slots.push(-L / 2 + (L * (i + 0.5)) / count);
  for (const u of slots) {
    if (avoid.some((a) => Math.abs(a - u) < o.w / 2 + 0.75)) continue;
    out.push({ side, u, kind: 'window', shutters: true, ...o } as Opening);
  }
  return out;
}

/** A flag on a pole at a position (pole is emitted into the body, cloth becomes an animated part). */
export function flagPole(ctx: Ctx, x: number, y: number, z: number, h: number, color: number, kind: FlagSpec['kind'] = 'banner', color2?: number): void {
  const { b } = ctx;
  b.state({ layer: Layer.Detail, flags: F.Snow }, () => {
    b.cyl(x, z, y, y + h, 0.06, 0.045, 5, COL.timberDark);
    b.blob(x, y + h + 0.06, z, 0.09, 0.09, 0.09, COL.gold, 0.1);
  });
  ctx.out.flags.push({ pos: [x, y + h - 0.08, z], w: kind === 'pennant' ? 2.2 : 1.5, h: kind === 'pennant' ? 0.6 : 1.0, color, color2, kind });
}

/** Round tower body (lathe) with optional conical roof. Returns the top Y. */
export function roundTower(ctx: Ctx, cx: number, cz: number, r: number, h: number, col: number, opts: { batter?: number; roof?: RoofMat | 'none'; roofH?: number; crenel?: boolean; sides?: number } = {}): number {
  const { b, lod } = ctx;
  const sides = opts.sides ?? (lod === 0 ? 12 : 8);
  const bat = opts.batter ?? 0.25;
  b.push();
  b.translate(cx, 0, cz);
  b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
    const rows = lod === 0 ? Math.min(4, Math.max(2, Math.round(h / 3))) : 1;
    const prof: V2[] = [[r + bat, -0.8], [r + bat, 0.2], [r, 1.2]];
    for (let i = 1; i <= rows; i++) prof.push([r, 1.2 + ((h - 1.2) * i) / rows]);
    const cols = prof.map((_, i) => shade(col, i % 2 ? 0.97 : 1.02));
    b.lathe(prof, sides, cols, { capTop: !opts.crenel });
  });
  b.pop();
  let top = h;
  if (opts.crenel) top = crenelRing(ctx, cx, cz, r + 0.05, h, col);
  if (opts.roof && opts.roof !== 'none') {
    const look = roofLook(opts.roof, roofTint(opts.roof, ctx.s));
    top = buildCone(b, cx, cz, h, r + (opts.crenel ? 0.1 : 0), opts.roofH ?? r * 2.2, sides, look, 0.25, lod);
  }
  return top;
}

/** Ring of merlons on a round tower top. */
export function crenelRing(ctx: Ctx, cx: number, cz: number, r: number, y: number, col: number): number {
  const { b, lod } = ctx;
  const n = lod === 0 ? Math.max(6, Math.round((r * Math.PI * 2) / 1.4)) : 6;
  const segs = lod === 0 ? Math.max(12, n * 2) : 8;
  b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
    b.push();
    b.translate(cx, 0, cz);
    b.lathe([[r - 0.06, y - 0.35], [r + 0.2, y - 0.35], [r + 0.2, y + 0.25], [r - 0.25, y + 0.25], [r - 0.25, y + 0.05]], segs,
      [shade(col, 0.8), shade(col, 0.97), shade(col, 1.05), shade(col, 0.75), shade(col, 0.7)], { capTop: true });
    b.pop();
    if (lod < 2) {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        b.push();
        b.translate(cx + Math.cos(a) * r, y + 0.25, cz + Math.sin(a) * r);
        b.rotY(Math.PI / 2 - a);
        b.box(-0.24, 0, -0.25, 0.24, 0.75, 0.2, { side: col, top: shade(col, 1.06) });
        b.pop();
      }
    }
  });
  return y + 1.0;
}

/** Straight crenellated parapet along the local x axis from u0..u1 at height y (front at +z = z1). */
export function crenelLine(ctx: Ctx, x0: number, x1: number, z: number, y: number, col: number, opts: { thick?: number; period?: number; merlon?: number; h?: number; phase?: number } = {}): void {
  const { b, lod } = ctx;
  const t = opts.thick ?? 0.45;
  const per = opts.period ?? 1.5;
  const mw = opts.merlon ?? 0.9;
  const h = opts.h ?? 0.85;
  b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
    b.box(x0, y - 0.05, z - t, x1, y + 0.55, z, { side: col, top: shade(col, 1.05) });
    if (lod >= 2) return;
    const phase = opts.phase ?? (per - mw) / 2;
    for (let u = x0 + phase; u < x1 - 1e-3; u += per) {
      const a = Math.max(x0, u), c = Math.min(x1, u + mw);
      if (c - a < 0.1) continue;
      b.box(a, y + 0.55, z - t, c, y + 0.55 + h, z, { side: shade(col, 1.0), top: shade(col, 1.06) }, 'b');
    }
  });
}

// ---------------------------------------------------------------------------
// Small structures shared by recipes

/** Mushroom-shaped staddle stone (granaries). */
export function staddle(b: MeshBuilder, x: number, z: number, h: number, col: number): void {
  b.cyl(x, z, -0.2, h - 0.12, 0.17, 0.11, 6, col, { top: false });
  b.cyl(x, z, h - 0.12, h, 0.3, 0.27, 7, { side: shade(col, 0.95), top: shade(col, 1.06), bottom: shade(col, 0.7) }, { bottom: true });
}

export type FenceKind = 'wattle' | 'rail' | 'drystone' | 'palisade' | 'hurdle';

/** A straight run of fence/wall from (x0,z0) to (x1,z1), optionally leaving a gap (gate) in the middle. */
export function fenceRun(ctx: Ctx, x0: number, z0: number, x1: number, z1: number, kind: FenceKind, gate = 0): void {
  const { b, lod } = ctx;
  const L = Math.hypot(x1 - x0, z1 - z0);
  if (L < 0.05) return;
  const a = Math.atan2(-(z1 - z0), x1 - x0);
  b.push();
  b.translate(x0, 0, z0);
  b.rotY(a);
  const segs: [number, number][] = gate > 0 ? [[0, (L - gate) / 2], [(L + gate) / 2, L]] : [[0, L]];
  b.state({ layer: Layer.Wall, flags: F.Snow | (kind === 'drystone' ? 0 : F.Burn) }, () => {
    for (const [u0, u1] of segs) {
      const len = u1 - u0;
      if (len < 0.05) continue;
      if (kind === 'drystone') {
        const h = 1.05;
        b.taperBox(u0, -0.3, -0.32, u1, h, 0.32, 0, 0.1, { side: COL.stoneGrey, top: COL.stone });
        if (lod === 0) {
          const n = Math.max(1, Math.round(len / 0.8));
          for (let i = 0; i < n; i++) {
            const uu = u0 + (len * (i + 0.5)) / n;
            b.box(uu - 0.36, h, -0.17, uu + 0.36, h + 0.16 + ((i * 7) % 3) * 0.03, 0.17, { side: COL.stoneDark, top: COL.stoneGrey }, 'px nx');
          }
        }
      } else if (kind === 'rail') {
        const n = Math.max(1, Math.round(len / 2.6));
        for (let i = 0; i <= n; i++) b.box(u0 + (len * i) / n - 0.06, -0.3, -0.06, u0 + (len * i) / n + 0.06, 1.2, 0.06, { side: 0x5a412b, top: 0x7a5a3a });
        for (const y of [0.45, 0.95]) b.box(u0, y - 0.05, 0.06, u1, y + 0.05, 0.13, 0x9a7a52, 'b');
      } else if (kind === 'palisade') {
        const n = Math.max(1, Math.round(len / 0.32));
        for (let i = 0; i < n; i++) {
          const uu = u0 + (len * (i + 0.5)) / n;
          const h = 2.4 + ((i * 37) % 7) * 0.05;
          b.cyl(uu, 0, -0.3, h, 0.15, 0.15, 5, COL.bark, { top: false, bottom: false });
          b.cyl(uu, 0, h, h + 0.35, 0.15, 0, 5, 0x9a7a52, { top: false, bottom: false });
        }
      } else {
        // Wattle hurdles: posts and woven bands.
        const n = Math.max(1, Math.round(len / 1.6));
        for (let i = 0; i <= n; i++) b.box(u0 + (len * i) / n - 0.045, -0.3, -0.045, u0 + (len * i) / n + 0.045, 1.08, 0.045, 0x5a412b, 't');
        const bands = lod === 0 ? 4 : 2;
        for (let k = 0; k < bands; k++) {
          const y = 0.15 + (k * 0.85) / Math.max(1, bands - 1);
          b.box(u0, y - 0.09, -0.03, u1, y + 0.09, 0.03, shade(0x8a6e48, k % 2 ? 0.86 : 1.05));
        }
      }
    }
  });
  b.pop();
}

/** Louvred lantern / cupola on a ridge (smoke vents, bell turrets). Returns its top Y. */
export function cupola(ctx: Ctx, x: number, z: number, y: number, size: number, h: number, mat: RoofMat, opts: { open?: boolean; bell?: boolean; axis?: 'x' | 'z' } = {}): number {
  const { b, lod, s } = ctx;
  const hw = size / 2;
  b.state({ layer: Layer.Roof, flags: F.Snow | F.Burn }, () => {
    b.box(x - hw, y - 0.6, z - hw, x + hw, y + 0.15, z + hw, s.timber);
    for (const [px, pz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as [number, number][]) {
      const cx = x + px * (hw - 0.07), cz = z + pz * (hw - 0.07);
      b.box(cx - 0.06, y + 0.15, cz - 0.06, cx + 0.06, y + 0.15 + h, cz + 0.06, s.timber);
    }
    if (!opts.open) {
      for (const sd of SIDES) {
        enterSide(b, { x0: x - hw + 0.04, x1: x + hw - 0.04, z0: z - hw + 0.04, z1: z + hw - 0.04 }, sd, y + 0.15);
        const n = lod === 0 ? 4 : 1;
        for (let i = 0; i < n; i++) dq(b, -hw + 0.1, (h * (i + 0.2)) / n, hw - 0.1, (h * (i + 0.8)) / n, 0.0, shade(s.timber, 1.15));
        b.state({ mat: Mat.Opaque }, () => dq(b, -hw + 0.08, 0.02, hw - 0.08, h - 0.02, -0.02, 0x1d1712));
        b.pop();
      }
    } else {
      b.state({ flags: F.NoAO }, () => b.box(x - hw + 0.1, y + 0.15, z - hw + 0.1, x + hw - 0.1, y + 0.2, z + hw - 0.1, 0x1d1712));
    }
    if (opts.bell) {
      b.lathe([[0.02, y + h - 0.05], [0.16, y + h - 0.12], [0.22, y + h - 0.45], [0.27, y + h - 0.6]], 7, COL.gold, { capTop: false });
    }
  });
  const look = roofLook(mat, roofTint(mat, s));
  const r = buildRoof(b, { x0: x - hw, x1: x + hw, z0: z - hw, z1: z + hw, eaveY: y + 0.15 + h, type: 'pyramid', pitch: 55, ov: 0.18, gov: 0.18, ridge: 'none', frame: false }, { ...look, thickness: Math.min(0.12, look.thickness), jitter: 0 }, 2);
  if (lod < 2) b.state({ layer: Layer.Detail, flags: F.Snow }, () => {
    b.cyl(x, z, r.topY - 0.05, r.topY + 0.55, 0.025, 0.02, 4, COL.iron);
    b.box(x - 0.25, r.topY + 0.38, z - 0.01, x + 0.25, r.topY + 0.43, z + 0.01, COL.iron);
  });
  return r.topY + 0.55;
}

/** Interior floor of hay/straw and a dark back for open sheds. */
export function strawFloor(b: MeshBuilder, rc: Rect, y = 0.06): void {
  b.state({ layer: Layer.Ground, flags: F.NoAO }, () => b.box(rc.x0 + 0.1, y - 0.04, rc.z0 + 0.1, rc.x1 - 0.1, y, rc.z1 - 0.1, { top: 0xb89a5a, side: 0x8a7040 }, 'b'));
}
