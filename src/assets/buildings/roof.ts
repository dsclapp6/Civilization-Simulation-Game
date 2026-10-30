// Roofs: every pitched roof is a set of planar convex slopes (gable, hip, half-hip, lean-to,
// pyramid). Each slope is a closed slab (top + soffit + free edges) so it casts proper shadows;
// the top is split into courses (tiles/slates/shingles get a stepped lip per course, thatch and
// turf get soft organic jitter). Rafters and battens go on the RoofFrame layer, which only shows
// during construction and through damage holes.
import { F, Layer, Mat, MeshBuilder, posHash, shade, type V3 } from '../core/builder';
import { COL } from './style';

export type RoofMat = 'thatch' | 'tile' | 'slate' | 'stoneslate' | 'shingle' | 'turf' | 'lead' | 'plank' | 'heather';
export type RoofType = 'gable' | 'hip' | 'halfhip' | 'shed' | 'pyramid';
export type RidgeStyle = 'auto' | 'plain' | 'scallop' | 'flowers' | 'none';
export type Side = 'pz' | 'nz' | 'px' | 'nx';

export interface RoofLook {
  top: number[];
  under: number;
  edge: number;
  thickness: number;
  rowH: number;
  cellW: number;
  lip: number;
  jitter: number;
  grass: boolean;
  /** Bottom courses darker (weathering), top lighter. */
  weather: number;
}

export function roofLook(mat: RoofMat, tint?: number): RoofLook {
  switch (mat) {
    case 'thatch': {
      const t = tint ?? COL.thatch;
      return { top: [t, shade(t, 0.97), shade(t, 1.02), shade(t, 0.985)], under: shade(t, 0.62), edge: shade(t, 0.8), thickness: 0.42, rowH: 0.8, cellW: 1.7, lip: 0, jitter: 0.035, grass: false, weather: 0.14 };
    }
    case 'heather': {
      const t = tint ?? COL.heather;
      return { top: [t, shade(t, 0.96), shade(t, 1.03)], under: shade(t, 0.6), edge: shade(t, 0.78), thickness: 0.45, rowH: 0.8, cellW: 1.7, lip: 0, jitter: 0.04, grass: false, weather: 0.12 };
    }
    case 'tile': {
      const t = tint ?? COL.tile;
      return { top: [t, shade(t, 0.9), shade(t, 1.07), shade(t, 0.96), COL.tileBrown], under: COL.timber, edge: shade(t, 0.8), thickness: 0.17, rowH: 0.5, cellW: 3.2, lip: 0.055, jitter: 0, grass: false, weather: 0.06 };
    }
    case 'slate': {
      const t = tint ?? COL.slate;
      return { top: [t, shade(t, 0.93), shade(t, 1.06), shade(t, 0.98)], under: COL.timber, edge: shade(t, 0.82), thickness: 0.13, rowH: 0.46, cellW: 3.2, lip: 0.04, jitter: 0, grass: false, weather: 0.04 };
    }
    case 'stoneslate': {
      const t = tint ?? COL.stoneSlate;
      return { top: [t, shade(t, 0.92), shade(t, 1.06), shade(t, 0.97)], under: COL.timber, edge: shade(t, 0.82), thickness: 0.2, rowH: 0.58, cellW: 3.0, lip: 0.065, jitter: 0, grass: false, weather: 0.1 };
    }
    case 'shingle': {
      const t = tint ?? COL.shingle;
      return { top: [t, shade(t, 0.92), shade(t, 1.07), shade(t, 0.97)], under: COL.timberDark, edge: shade(t, 0.78), thickness: 0.14, rowH: 0.42, cellW: 2.6, lip: 0.045, jitter: 0, grass: false, weather: 0.08 };
    }
    case 'turf': {
      const t = tint ?? COL.turf;
      return { top: [t, shade(t, 0.92), shade(t, 1.07), shade(t, 0.97)], under: COL.timberDark, edge: COL.soil, thickness: 0.45, rowH: 1.0, cellW: 2.0, lip: 0, jitter: 0.06, grass: true, weather: 0.05 };
    }
    case 'lead': {
      const t = tint ?? COL.lead;
      return { top: [t, shade(t, 0.95), shade(t, 1.04)], under: COL.timber, edge: shade(t, 0.85), thickness: 0.12, rowH: 30, cellW: 0.75, lip: 0, jitter: 0, grass: false, weather: 0 };
    }
    case 'plank': {
      const t = tint ?? COL.plank;
      return { top: [t, shade(t, 0.9), shade(t, 1.08)], under: shade(t, 0.7), edge: shade(t, 0.8), thickness: 0.1, rowH: 30, cellW: 0.32, lip: 0, jitter: 0, grass: false, weather: 0 };
    }
  }
}

type EdgeKind = 'eave' | 'verge' | 'hip' | 'ridge' | 'top';

interface Slope {
  pts: V3[];
  edges: EdgeKind[];
  /** Unit vector along the eave. */
  along: V3;
}

export interface RoofSpec {
  /** Wall-plate rectangle (outer wall faces of the storey the roof sits on). */
  x0: number; x1: number; z0: number; z1: number;
  eaveY: number;
  type: RoofType;
  /** Ridge direction (default: the longer side). */
  axis?: 'x' | 'z';
  /** Pitch in degrees. */
  pitch: number;
  /** Eave overhang (m). */
  ov?: number;
  /** Gable/verge overhang (m). */
  gov?: number;
  /** Half-hip: fraction of the rise that is gable (0.55 typical). */
  gableFrac?: number;
  /** Lean-to: the low side. */
  low?: Side;
  ridge?: RidgeStyle;
  /** Emit rafters on the RoofFrame layer. */
  frame?: boolean;
  /** Override the default ridge-cap colour. */
  ridgeColor?: number;
  /** Ridge sag in metres (default: thatch 0.12, hard roofs 0.05). */
  sag?: number;
}

export interface RoofResult {
  ridgeY: number;
  /** Top of the covering at the ridge. */
  topY: number;
  eaveY: number;
  axis: 'x' | 'z';
  /** Underside height of the roof above a world point (for gable walls and chimneys). */
  underAt(x: number, z: number): number;
  /** Roof top surface height above a world point (approx). */
  topAt(x: number, z: number): number;
  /** Gable-wall outlines (world space polygons on the end-wall planes) for gable / half-hip roofs. */
  gables: { side: Side; pts: V3[] }[];
}

const DEG = Math.PI / 180;

/**
 * Build a roof into `b`. `lod` 0 = full courses, 1 = coarse, 2 = one quad per slope.
 */
export function buildRoof(b: MeshBuilder, spec: RoofSpec, look: RoofLook, lod: 0 | 1 | 2): RoofResult {
  const wx = spec.x1 - spec.x0, wz = spec.z1 - spec.z0;
  const axis = spec.axis ?? (wx >= wz ? 'x' : 'z');
  // Work in a local frame where the ridge runs along +x.
  let lx0: number, lx1: number, lz0: number, lz1: number;
  const toWorld = (p: V3): V3 => (axis === 'x' ? p : [-p[2], p[1], p[0]]);
  const toLocalXZ = (x: number, z: number): [number, number] => (axis === 'x' ? [x, z] : [z, -x]);
  if (axis === 'x') { lx0 = spec.x0; lx1 = spec.x1; lz0 = spec.z0; lz1 = spec.z1; }
  else { lx0 = spec.z0; lx1 = spec.z1; lz0 = -spec.x1; lz1 = -spec.x0; }
  const sideToLocal = (s: Side): Side => {
    if (axis === 'x') return s;
    // world px (+x) → local -z ; world nx → local +z ; world pz (+z) → local +x ; world nz → local -x
    return s === 'px' ? 'nz' : s === 'nx' ? 'pz' : s === 'pz' ? 'px' : 'nx';
  };
  const localToSide = (s: Side): Side => {
    if (axis === 'x') return s;
    return s === 'nz' ? 'px' : s === 'pz' ? 'nx' : s === 'px' ? 'pz' : 'nz';
  };

  const tp = Math.tan(spec.pitch * DEG);
  const ov = spec.ov ?? 0.4, gov = spec.gov ?? 0.3;
  const eY = spec.eaveY;
  const zc = (lz0 + lz1) / 2;
  const half = (lz1 - lz0) / 2;
  const rise = half * tp;
  const yr = eY + rise;
  const ye = eY - ov * tp;
  const slopes: Slope[] = [];
  const gables: { side: Side; pts: V3[] }[] = [];
  const type = spec.type;

  if (type === 'gable') {
    const xa = lx0 - gov, xb = lx1 + gov;
    slopes.push({ pts: [[xa, ye, lz1 + ov], [xb, ye, lz1 + ov], [xb, yr, zc], [xa, yr, zc]], edges: ['eave', 'verge', 'ridge', 'verge'], along: [1, 0, 0] });
    slopes.push({ pts: [[xb, ye, lz0 - ov], [xa, ye, lz0 - ov], [xa, yr, zc], [xb, yr, zc]], edges: ['eave', 'verge', 'ridge', 'verge'], along: [-1, 0, 0] });
    gables.push({ side: 'nx', pts: [[lx0, eY, lz0], [lx0, eY, lz1], [lx0, yr, zc]] });
    gables.push({ side: 'px', pts: [[lx1, eY, lz1], [lx1, eY, lz0], [lx1, yr, zc]] });
  } else if (type === 'hip' || type === 'pyramid') {
    const run = half + ov;
    let rx0 = lx0 - ov + run, rx1 = lx1 + ov - run;
    if (type === 'pyramid' || rx1 < rx0) { const m = (lx0 + lx1) / 2; rx0 = m; rx1 = m; }
    const ytop = type === 'pyramid' ? ye + Math.max(run, (lx1 - lx0) / 2 + ov) * tp : yr;
    const e0 = lx0 - ov, e1 = lx1 + ov, f0 = lz0 - ov, f1 = lz1 + ov;
    if (rx1 - rx0 > 1e-4) {
      slopes.push({ pts: [[e0, ye, f1], [e1, ye, f1], [rx1, ytop, zc], [rx0, ytop, zc]], edges: ['eave', 'hip', 'ridge', 'hip'], along: [1, 0, 0] });
      slopes.push({ pts: [[e1, ye, f0], [e0, ye, f0], [rx0, ytop, zc], [rx1, ytop, zc]], edges: ['eave', 'hip', 'ridge', 'hip'], along: [-1, 0, 0] });
    } else {
      slopes.push({ pts: [[e0, ye, f1], [e1, ye, f1], [rx0, ytop, zc]], edges: ['eave', 'hip', 'hip'], along: [1, 0, 0] });
      slopes.push({ pts: [[e1, ye, f0], [e0, ye, f0], [rx0, ytop, zc]], edges: ['eave', 'hip', 'hip'], along: [-1, 0, 0] });
    }
    slopes.push({ pts: [[e1, ye, f1], [e1, ye, f0], [rx1, ytop, zc]], edges: ['eave', 'hip', 'hip'], along: [0, 0, -1] });
    slopes.push({ pts: [[e0, ye, f0], [e0, ye, f1], [rx0, ytop, zc]], edges: ['eave', 'hip', 'hip'], along: [0, 0, 1] });
  } else if (type === 'halfhip') {
    const gf = spec.gableFrac ?? 0.55;
    const xa = lx0 - gov, xb = lx1 + gov;
    const yh = eY + rise * gf;
    const zf = zc + (yr - yh) / tp, zb = zc - (yr - yh) / tp;
    const run = (yr - yh) / tp;
    const rx0 = xa + run, rx1 = xb - run;
    slopes.push({ pts: [[xa, ye, lz1 + ov], [xb, ye, lz1 + ov], [xb, yh, zf], [rx1, yr, zc], [rx0, yr, zc], [xa, yh, zf]], edges: ['eave', 'verge', 'hip', 'ridge', 'hip', 'verge'], along: [1, 0, 0] });
    slopes.push({ pts: [[xb, ye, lz0 - ov], [xa, ye, lz0 - ov], [xa, yh, zb], [rx0, yr, zc], [rx1, yr, zc], [xb, yh, zb]], edges: ['eave', 'verge', 'hip', 'ridge', 'hip', 'verge'], along: [-1, 0, 0] });
    slopes.push({ pts: [[xb, yh, zf], [xb, yh, zb], [rx1, yr, zc]], edges: ['eave', 'hip', 'hip'], along: [0, 0, -1] });
    slopes.push({ pts: [[xa, yh, zb], [xa, yh, zf], [rx0, yr, zc]], edges: ['eave', 'hip', 'hip'], along: [0, 0, 1] });
    const yw = yh + gov * tp * 0.9;
    const zwf = zc + (yr - yw) / tp, zwb = zc - (yr - yw) / tp;
    gables.push({ side: 'nx', pts: [[lx0, eY, lz0], [lx0, eY, lz1], [lx0, yw, zwf], [lx0, yw, zwb]] });
    gables.push({ side: 'px', pts: [[lx1, eY, lz1], [lx1, eY, lz0], [lx1, yw, zwb], [lx1, yw, zwf]] });
  } else if (type === 'shed') {
    // Lean-to: rises from the low side towards the opposite wall.
    const low = sideToLocal(spec.low ?? 'pz');
    const lowDepth = low === 'pz' || low === 'nz' ? lz1 - lz0 : lx1 - lx0;
    const riseS = lowDepth * tp;
    const yt = eY + riseS;
    if (low === 'pz') {
      slopes.push({ pts: [[lx0 - gov, ye, lz1 + ov], [lx1 + gov, ye, lz1 + ov], [lx1 + gov, yt, lz0], [lx0 - gov, yt, lz0]], edges: ['eave', 'verge', 'top', 'verge'], along: [1, 0, 0] });
      gables.push({ side: 'nx', pts: [[lx0, eY, lz0], [lx0, eY, lz1], [lx0, yt, lz0]] });
      gables.push({ side: 'px', pts: [[lx1, eY, lz1], [lx1, eY, lz0], [lx1, yt, lz0]] });
    } else if (low === 'nz') {
      slopes.push({ pts: [[lx1 + gov, ye, lz0 - ov], [lx0 - gov, ye, lz0 - ov], [lx0 - gov, yt, lz1], [lx1 + gov, yt, lz1]], edges: ['eave', 'verge', 'top', 'verge'], along: [-1, 0, 0] });
      gables.push({ side: 'nx', pts: [[lx0, eY, lz0], [lx0, eY, lz1], [lx0, yt, lz1]] });
      gables.push({ side: 'px', pts: [[lx1, eY, lz1], [lx1, eY, lz0], [lx1, yt, lz1]] });
    } else if (low === 'px') {
      slopes.push({ pts: [[lx1 + ov, ye, lz1 + gov], [lx1 + ov, ye, lz0 - gov], [lx0, yt, lz0 - gov], [lx0, yt, lz1 + gov]], edges: ['eave', 'verge', 'top', 'verge'], along: [0, 0, -1] });
      gables.push({ side: 'pz', pts: [[lx0, eY, lz1], [lx1, eY, lz1], [lx0, yt, lz1]] });
      gables.push({ side: 'nz', pts: [[lx1, eY, lz0], [lx0, eY, lz0], [lx0, yt, lz0]] });
    } else {
      slopes.push({ pts: [[lx0 - ov, ye, lz0 - gov], [lx0 - ov, ye, lz1 + gov], [lx1, yt, lz1 + gov], [lx1, yt, lz0 - gov]], edges: ['eave', 'verge', 'top', 'verge'], along: [0, 0, 1] });
      gables.push({ side: 'pz', pts: [[lx0, eY, lz1], [lx1, eY, lz1], [lx1, yt, lz1]] });
      gables.push({ side: 'nz', pts: [[lx1, eY, lz0], [lx0, eY, lz0], [lx1, yt, lz0]] });
    }
  }

  const tv = look.thickness / Math.cos(spec.pitch * DEG);
  const rowH = lod === 0 ? look.rowH : lod === 1 ? Math.max(look.rowH * 2.5, 1.2) : 100;
  const cellW = lod === 0 ? look.cellW : lod === 1 ? Math.max(look.cellW * 2.5, 2.5) : 100;
  const lip = lod === 0 ? look.lip : 0;
  const jit = lod === 2 ? 0 : look.jitter;
  const baseFlags = F.Snow | (look.grass ? F.Grass : 0);
  const soft = look.jitter > 0;
  // Organic deformation: soft roofs bulge (puffy thatch/turf) and old ridges sag a little.
  const span = Math.max(1, (lx1 - lx0) / 2 + gov);
  const xcR = (lx0 + lx1) / 2;
  const bulge = lod === 2 ? 0 : soft ? Math.min(0.22, 0.05 + half * 0.045) : 0;
  const sag = lod === 2 ? 0 : (spec.sag ?? (soft ? 0.12 : 0.05)) * Math.min(1, span / 4);

  b.push();
  if (axis === 'z') b.rotY(-Math.PI / 2);

  let maxY = -Infinity;
  for (const s of slopes) for (const p of s.pts) maxY = Math.max(maxY, p[1]);
  const minY = ye;

  const deform = (p: V3): number => {
    const t = maxY > minY ? Math.min(1, Math.max(0, (p[1] - minY) / (maxY - minY))) : 0;
    let d = bulge * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.08)), 0.75);
    const u = (p[0] - xcR) / span;
    d -= sag * Math.max(0, 1 - u * u) * t;
    if (jit > 0) d += (posHash(Math.round(p[0] * 20) / 20, Math.round(p[1] * 20) / 20, Math.round(p[2] * 20) / 20, 3) - 0.5) * 2 * jit;
    return d;
  };
  for (const s of slopes) {
    emitSlope(b, s, look, { tv, rowH, cellW, lip, flags: baseFlags, minY, maxY, deform, soft });
  }

  // Ridge cap and roof frame.
  const ridgeStyle = spec.ridge ?? 'auto';
  if (lod < 2 && type !== 'shed') emitRidge(b, spec, look, slopes, tv, ridgeStyle, lod, deform);
  if ((spec.frame ?? true) && lod === 0) emitFrame(b, slopes, eY, spec.pitch);

  b.pop();

  const topY = maxY + tv;
  const underLocal = (lx: number, lz: number): number => {
    let best = -Infinity;
    for (const s of slopes) {
      const y = planeYAt(s, lx, lz);
      if (y !== null && insideXZ(s, lx, lz)) best = Math.max(best, y);
    }
    if (best === -Infinity) {
      // Outside every slope footprint: use the nearest plane estimate.
      for (const s of slopes) { const y = planeYAt(s, lx, lz); if (y !== null) best = Math.max(best, Math.min(y, maxY)); }
    }
    return best;
  };
  return {
    ridgeY: maxY,
    topY,
    eaveY: eY,
    axis,
    underAt: (x, z) => { const [a, c] = toLocalXZ(x, z); return underLocal(a, c); },
    topAt: (x, z) => { const [a, c] = toLocalXZ(x, z); return underLocal(a, c) + tv; },
    gables: gables.map((g) => ({ side: localToSide(g.side), pts: g.pts.map(toWorld) })),
  };
}

function planeYAt(s: Slope, x: number, z: number): number | null {
  const [a, b, c] = s.pts;
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  if (Math.abs(ny) < 1e-6) return null;
  return a[1] - (nx * (x - a[0]) + nz * (z - a[2])) / ny;
}

function insideXZ(s: Slope, x: number, z: number): boolean {
  const n = s.pts.length;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const a = s.pts[i], b = s.pts[(i + 1) % n];
    const cr = (b[0] - a[0]) * (z - a[2]) - (b[2] - a[2]) * (x - a[0]);
    if (Math.abs(cr) < 1e-9) continue;
    const sg = cr > 0 ? 1 : -1;
    if (sign === 0) sign = sg;
    else if (sg !== sign) return false;
  }
  return true;
}

// Sutherland–Hodgman clip of a convex polygon against a half-space dot(p, n) >= d.
function clipPoly(pts: V3[], n: V3, d: number): V3[] {
  const out: V3[] = [];
  const m = pts.length;
  for (let i = 0; i < m; i++) {
    const a = pts[i], b = pts[(i + 1) % m];
    const da = a[0] * n[0] + a[1] * n[1] + a[2] * n[2] - d;
    const db = b[0] * n[0] + b[1] * n[1] + b[2] * n[2] - d;
    if (da >= -1e-9) out.push(a);
    if ((da >= -1e-9) !== (db >= -1e-9)) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  return out;
}

interface SlopeParams {
  tv: number; rowH: number; cellW: number; lip: number; flags: number; minY: number; maxY: number;
  /** Vertical offset of the top surface at a point (bulge, sag, organic jitter). */
  deform(p: V3): number;
  soft: boolean;
}

function onSegment(p: V3, a: V3, b: V3): boolean {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const l2 = abx * abx + aby * aby + abz * abz;
  if (l2 < 1e-10) return false;
  const t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / l2;
  if (t < -1e-4 || t > 1 + 1e-4) return false;
  const dx = a[0] + abx * t - p[0], dy = a[1] + aby * t - p[1], dz = a[2] + abz * t - p[2];
  return dx * dx + dy * dy + dz * dz < 1e-8;
}

function emitSlope(b: MeshBuilder, s: Slope, look: RoofLook, P: SlopeParams): void {
  const pts = s.pts;
  let y0 = Infinity, y1 = -Infinity;
  for (const p of pts) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  const a = pts[0], bb = pts[1], c = pts[2];
  const ux = bb[0] - a[0], uy = bb[1] - a[1], uz = bb[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
  const sinP = Math.sqrt(Math.max(1e-6, 1 - ny * ny));
  const slopeLen = (y1 - y0) / Math.max(0.1, sinP);
  const rowH = P.lip > 0 ? P.rowH * Math.max(1, Math.sqrt(slopeLen / 3.5)) : P.rowH;
  const rowDY = Math.max(0.05, rowH * sinP);
  // Rows are horizontal bands measured on the whole roof so hips/ridges line up between slopes.
  const rows = Math.min(P.soft ? 12 : 8, Math.max(1, Math.round((y1 - y0) / rowDY)));
  const dy = (y1 - y0) / rows;
  const al = s.along;
  let dmin = Infinity, dmax = -Infinity;
  for (const p of pts) { const d = p[0] * al[0] + p[2] * al[2]; dmin = Math.min(dmin, d); dmax = Math.max(dmax, d); }
  const cw = Math.max(P.cellW, (dmax - dmin) / (P.soft ? 12 : 4));
  const cells: number[] = [dmin];
  const startK = Math.ceil(dmin / cw + 1e-6), endK = Math.floor(dmax / cw - 1e-6);
  for (let k = startK; k <= endK; k++) cells.push(k * cw);
  cells.push(dmax);
  const tv = P.tv;
  const top = (p: V3): V3 => [p[0], p[1] + tv + P.deform(p), p[2]];
  const free: { a: V3; b: V3; kind: EdgeKind }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const k = s.edges[i];
    if (k === 'eave' || k === 'verge' || k === 'top') free.push({ a: pts[i], b: pts[(i + 1) % pts.length], kind: k });
  }
  const edgeFlags = F.NoAO | F.Snow | (look.grass ? F.Grass : 0);

  for (let r = 0; r < rows; r++) {
    const ya = y0 + r * dy, yb = ya + dy;
    let band = clipPoly(pts, [0, 1, 0], ya);
    band = clipPoly(band, [0, -1, 0], -yb);
    if (band.length < 3) continue;
    const tRow = rows > 1 ? r / (rows - 1) : 0.5;
    const rowShade = 1 - look.weather * (1 - tRow);
    for (let ci = 0; ci < cells.length - 1; ci++) {
      let cell = clipPoly(band, [al[0], 0, al[2]], cells[ci]);
      cell = clipPoly(cell, [-al[0], 0, -al[2]], -cells[ci + 1]);
      if (cell.length < 3) continue;
      const colIdx = Math.floor(posHash(cells[ci], ya, al[0] + al[2] * 3, 11) * look.top.length);
      const color = shade(look.top[colIdx], rowShade);
      const isBottom = (p: V3) => Math.abs(p[1] - ya) < 1e-6;
      const lifted = cell.map((p) => {
        const q = top(p);
        if (P.lip > 0 && isBottom(p)) q[1] += P.lip;
        return q;
      });
      b.state({ layer: Layer.Roof, flags: P.flags }, () => b.poly(lifted, color));
      const m = cell.length;
      for (let i = 0; i < m; i++) {
        const p0 = cell[i], p1 = cell[(i + 1) % m];
        const t0 = lifted[i], t1 = lifted[(i + 1) % m];
        // Course lip (hard roofs): the raised lower edge of this course.
        if (P.lip > 0 && r > 0 && isBottom(p0) && isBottom(p1)) {
          const l0 = top(p0), l1 = top(p1);
          b.state({ layer: Layer.Roof, flags: P.flags }, () => b.quad(l0, l1, t1, t0, shade(color, 0.62)));
        }
        // Free edge strip (eave / verge / lean-to top) for this cell edge.
        const fe = free.find((f) => onSegment(p0, f.a, f.b) && onSegment(p1, f.a, f.b));
        if (!fe) continue;
        b.state({ layer: Layer.Roof, flags: edgeFlags }, () => {
          if (fe.kind === 'eave' && P.soft) {
            // Rounded thatch/turf eave: bevel out-and-down, darker underneath.
            const mid0: V3 = [p0[0] + nx * 0.06, p0[1] + tv * 0.5 + P.deform(p0) * 0.5, p0[2] + nz * 0.06];
            const mid1: V3 = [p1[0] + nx * 0.06, p1[1] + tv * 0.5 + P.deform(p1) * 0.5, p1[2] + nz * 0.06];
            b.quad(mid0, mid1, t1, t0, shade(color, 0.86));
            b.quad(p0, p1, mid1, mid0, shade(look.edge, 0.78));
          } else {
            b.quad(p0, p1, t1, t0, look.edge);
          }
        });
      }
    }
  }
  // Soffit (underside).
  b.state({ layer: Layer.Roof, flags: F.Under | F.NoAO }, () => b.poly([...pts].reverse(), look.under));
}

function emitRidge(b: MeshBuilder, spec: RoofSpec, look: RoofLook, slopes: Slope[], tv: number, style: RidgeStyle, lod: number, deform: (p: V3) => number): void {
  const segs: [V3, V3][] = [];
  const hips: [V3, V3][] = [];
  for (const s of slopes) {
    const m = s.pts.length;
    for (let i = 0; i < m; i++) {
      const p0 = s.pts[i], p1 = s.pts[(i + 1) % m];
      if (s.edges[i] === 'ridge') segs.push([p0, p1]);
      if (s.edges[i] === 'hip') hips.push([p0, p1]);
    }
  }
  const T = Math.tan(spec.pitch * DEG);
  const isThatch = look.jitter > 0 && !look.grass;
  const ridgeCol = spec.ridgeColor ?? (isThatch ? shade(look.top[0], 0.84) : shade(look.edge, 0.92));
  const seen = new Set<string>();
  b.state({ layer: Layer.Roof, flags: F.Snow }, () => {
    for (const [p0, p1] of segs) {
      const key = [Math.min(p0[0], p1[0]).toFixed(2), Math.max(p0[0], p1[0]).toFixed(2), p0[1].toFixed(2)].join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      if (style === 'none' || look.grass) continue;
      const xa = Math.min(p0[0], p1[0]) - 0.05, xb = Math.max(p0[0], p1[0]) + 0.05;
      const yBase = p0[1];
      const z = p0[2];
      const st = style === 'auto' ? 'plain' : style;
      const w = isThatch ? 0.48 : 0.24;
      const h = isThatch ? 0.12 : 0.1;
      const topCol = isThatch && st === 'flowers' ? COL.ridgeGreen : ridgeCol;
      const nSeg = Math.max(1, Math.round((xb - xa) / (lod === 0 ? 1.2 : 3)));
      const ridgeY = (x: number) => yBase + tv + deform([x, yBase, z]);
      const sec = (x: number) => {
        const y = ridgeY(x);
        const ys = y - w * T;
        const ye = ys + (isThatch ? 0.11 : 0.035);
        return { A: [x, ye, z + w] as V3, C: [x, y + h, z] as V3, E: [x, ye, z - w] as V3, ys };
      };
      let prev = sec(xa);
      b.tri(prev.E, prev.A, prev.C, shade(topCol, 0.88));
      for (let i = 1; i <= nSeg; i++) {
        const x = xa + ((xb - xa) * i) / nSeg;
        const cur = sec(x);
        b.quad(prev.A, cur.A, cur.C, prev.C, topCol);
        b.quad(cur.E, prev.E, prev.C, cur.C, topCol);
        if (isThatch) {
          b.quad([prev.A[0], prev.ys - 0.03, z + w], [cur.A[0], cur.ys - 0.03, z + w], cur.A, prev.A, shade(topCol, 0.78));
          b.quad([cur.E[0], cur.ys - 0.03, z - w], [prev.E[0], prev.ys - 0.03, z - w], prev.E, cur.E, shade(topCol, 0.78));
        }
        prev = cur;
      }
      b.tri(prev.A, prev.E, prev.C, shade(topCol, 0.88));
      if (isThatch && st === 'scallop' && lod === 0) {
        // Block-cut ridge: pointed scallops laid over the thatch below the cap.
        const n = Math.max(3, Math.round((xb - xa) / 0.7));
        const reach = 0.38;
        for (const sd of [1, -1]) {
          for (let i = 0; i < n; i++) {
            const xA = xa + ((xb - xa) * i) / n, xB = xa + ((xb - xa) * (i + 1)) / n, xm = (xA + xB) / 2;
            const sa = sec(xA), sb = sec(xB);
            const a0: V3 = sd > 0 ? sa.A : sa.E, c0: V3 = sd > 0 ? sb.A : sb.E;
            const tip: V3 = [xm, ridgeY(xm) - (w + reach) * T + 0.04, z + sd * (w + reach)];
            if (sd > 0) b.tri(a0, tip, c0, shade(ridgeCol, 1.06));
            else b.tri(c0, tip, a0, shade(ridgeCol, 1.06));
          }
        }
      }
      if (isThatch && st === 'flowers' && lod === 0) {
        const n = Math.max(3, Math.round((xb - xa) / 0.55));
        for (let i = 0; i < n; i++) {
          const xm = xa + ((xb - xa) * (i + 0.5)) / n;
          b.blob(xm, ridgeY(xm) + h + 0.04, z + (i % 2 ? 0.12 : -0.12), 0.13, 0.11, 0.13, i % 3 ? COL.iris : COL.ridgeGreen, 0.25, 0, i);
        }
      }
    }
    if (!isThatch && !look.grass && lod === 0) {
      const hs = new Set<string>();
      for (const [p0, p1] of hips) {
        const lo = p0[1] < p1[1] ? p0 : p1, hi = p0[1] < p1[1] ? p1 : p0;
        const key = `${lo[0].toFixed(2)},${lo[2].toFixed(2)}`;
        if (hs.has(key)) continue;
        hs.add(key);
        b.beam([lo[0], lo[1] + tv + 0.03, lo[2]], [hi[0], hi[1] + tv + 0.03, hi[2]], 0.2, 0.1, ridgeCol);
      }
    }
  });
}

function emitFrame(b: MeshBuilder, slopes: Slope[], eaveY: number, pitchDeg: number): void {
  b.state({ layer: Layer.RoofFrame, flags: F.Burn | F.NoAO, mat: Mat.Opaque }, () => {
    for (const s of slopes) {
      const al = s.along;
      const pts = s.pts;
      let dmin = Infinity, dmax = -Infinity;
      for (const p of pts) { const d = p[0] * al[0] + p[2] * al[2]; dmin = Math.min(dmin, d); dmax = Math.max(dmax, d); }
      const n = Math.max(2, Math.round((dmax - dmin) / 0.75));
      for (let i = 0; i <= n; i++) {
        const d = dmin + 0.12 + ((dmax - dmin - 0.24) * i) / n;
        let seg = clipPoly(pts, [al[0], 0, al[2]], d - 0.001);
        seg = clipPoly(seg, [-al[0], 0, -al[2]], -(d + 0.001));
        if (seg.length < 2) continue;
        let lo: V3 = seg[0], hi: V3 = seg[0];
        for (const p of seg) { if (p[1] < lo[1]) lo = p; if (p[1] > hi[1]) hi = p; }
        if (hi[1] - lo[1] < 0.3) continue;
        b.beam([lo[0], lo[1] - 0.09, lo[2]], [hi[0], hi[1] - 0.09, hi[2]], 0.11, 0.14, COL.timberRaw);
      }
      // Battens across the rafters.
      let y0 = Infinity, y1 = -Infinity;
      for (const p of pts) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
      const rows = Math.max(1, Math.floor((y1 - Math.max(y0, eaveY)) / 0.9));
      for (let r = 1; r <= rows; r++) {
        const y = Math.max(y0, eaveY) + ((y1 - Math.max(y0, eaveY)) * r) / (rows + 1);
        let line = clipPoly(pts, [0, 1, 0], y - 0.001);
        line = clipPoly(line, [0, -1, 0], -(y + 0.001));
        if (line.length < 2) continue;
        let a: V3 = line[0], c: V3 = line[0];
        for (const p of line) {
          const dp = p[0] * al[0] + p[2] * al[2];
          if (dp < a[0] * al[0] + a[2] * al[2]) a = p;
          if (dp > c[0] * al[0] + c[2] * al[2]) c = p;
        }
        b.beam([a[0], y + 0.02, a[2]], [c[0], y + 0.02, c[2]], 0.06, 0.05, COL.timberRaw);
      }
    }
    void pitchDeg;
  });
}

/** Conical roof (towers, dovecotes, round huts): closed cone slab with eave edge. */
export function buildCone(b: MeshBuilder, cx: number, cz: number, y: number, r: number, h: number, sides: number, look: RoofLook, ov = 0.3, lod: 0 | 1 | 2 = 0): number {
  const R = r + ov;
  const t = look.thickness;
  const rows = lod === 0 ? Math.max(2, Math.round(h / Math.max(0.6, look.rowH * 1.5))) : 1;
  const ye = y - ov * (h / r);
  b.push();
  b.translate(cx, 0, cz);
  b.state({ layer: Layer.Roof, flags: F.Snow | (look.grass ? F.Grass : 0) }, () => {
    const prof: [number, number][] = [];
    for (let i = 0; i <= rows; i++) {
      const f = i / rows;
      prof.push([R * (1 - f), ye + t + (y + h - ye) * f]);
    }
    const cols = prof.map((_, i) => shade(look.top[i % look.top.length], 1 - look.weather * (1 - i / rows)));
    b.lathe(prof, sides, cols);
  });
  b.state({ layer: Layer.Roof, flags: F.Under | F.NoAO }, () => {
    b.lathe([[0, y + h - 0.01], [R, ye]], sides, look.under);
  });
  b.state({ layer: Layer.Roof, flags: F.NoAO }, () => {
    b.lathe([[R, ye], [R, ye + t]], sides, look.edge);
  });
  b.pop();
  return y + h + t;
}
