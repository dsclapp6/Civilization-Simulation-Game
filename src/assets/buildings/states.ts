// Construction and damage states, derived generically from the layer tags of any model.
// Construction reveals layers bottom-up in order (ground → frame → walls → rafters → roof →
// details) with scaffolding; damage adds soot/char, roof holes, ragged wall collapse and rubble.
import { F, Layer, Mat, MeshBuilder, lin, posHash, type V3 } from '../core/builder';
import { COL } from './style';

/** Smoothstep. */
function ss(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function valueNoise2(x: number, z: number, salt: number): number {
  const xi = Math.floor(x), zi = Math.floor(z);
  const fx = x - xi, fz = z - zi;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const h = (a: number, c: number) => posHash(a, 0, c, salt);
  const a = h(xi, zi), b = h(xi + 1, zi), c = h(xi, zi + 1), d = h(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

interface LayerBounds { min: number; max: number; }

function layerBounds(src: MeshBuilder): LayerBounds[] {
  const out: LayerBounds[] = [];
  for (let l = 0; l <= 6; l++) out.push({ min: Infinity, max: -Infinity });
  for (let t = 0; t < src.triCount; t++) {
    const lb = out[src.tLayer[t]];
    for (let v = 0; v < 3; v++) {
      const y = src.pos[t * 9 + v * 3 + 1];
      if (y < lb.min) lb.min = y;
      if (y > lb.max) lb.max = y;
    }
  }
  return out;
}

type Vert = { p: [number, number, number]; c: [number, number, number]; s: number; };

function triVerts(src: MeshBuilder, t: number): Vert[] {
  const out: Vert[] = [];
  for (let v = 0; v < 3; v++) {
    const o = t * 9 + v * 3;
    out.push({ p: [src.pos[o], src.pos[o + 1], src.pos[o + 2]], c: [src.col[o], src.col[o + 1], src.col[o + 2]], s: src.sway[t * 3 + v] });
  }
  return out;
}

function lerpV(a: Vert, b: Vert, t: number): Vert {
  return {
    p: [a.p[0] + (b.p[0] - a.p[0]) * t, a.p[1] + (b.p[1] - a.p[1]) * t, a.p[2] + (b.p[2] - a.p[2]) * t],
    c: [a.c[0] + (b.c[0] - a.c[0]) * t, a.c[1] + (b.c[1] - a.c[1]) * t, a.c[2] + (b.c[2] - a.c[2]) * t],
    s: a.s + (b.s - a.s) * t,
  };
}

/** Clip polygon keeping f(p) <= 0 where f is linear along the polygon edges. */
function clipBy(poly: Vert[], f: (p: [number, number, number]) => number): Vert[] {
  const out: Vert[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const fa = f(a.p), fb = f(b.p);
    if (fa <= 1e-7) out.push(a);
    if ((fa <= 1e-7) !== (fb <= 1e-7)) out.push(lerpV(a, b, fa / (fa - fb)));
  }
  return out;
}

function emitPoly(dst: MeshBuilder, poly: Vert[], src: MeshBuilder, t: number, override?: { color?: [number, number, number]; mat?: number; layer?: number; flags?: number }): void {
  if (poly.length < 3) return;
  const leaf = src.leaf[t * 3];
  const o = t * 9;
  const ctr = [src.ctr[o], src.ctr[o + 1], src.ctr[o + 2]];
  for (let i = 1; i < poly.length - 1; i++) {
    const a = poly[0], b = poly[i], c = poly[i + 1];
    const p = [...a.p, ...b.p, ...c.p];
    const col = override?.color ? [...override.color, ...override.color, ...override.color] : [...a.c, ...b.c, ...c.c];
    dst.rawTri(p, col, [a.s, b.s, c.s], leaf, ctr, override?.layer ?? src.tLayer[t], override?.mat ?? src.tMat[t], override?.flags ?? src.tFlags[t]);
  }
}

/** Clip a triangle against a per-cell ragged height field (grid g on x/z). */
function raggedClip(dst: MeshBuilder, src: MeshBuilder, t: number, height: (x: number, z: number) => number, g: number, hMin: number, hMax: number): void {
  const vs = triVerts(src, t);
  let ymin = Infinity, ymax = -Infinity, xmin = Infinity, xmax = -Infinity, zmin = Infinity, zmax = -Infinity;
  for (const v of vs) {
    ymin = Math.min(ymin, v.p[1]); ymax = Math.max(ymax, v.p[1]);
    xmin = Math.min(xmin, v.p[0]); xmax = Math.max(xmax, v.p[0]);
    zmin = Math.min(zmin, v.p[2]); zmax = Math.max(zmax, v.p[2]);
  }
  if (ymax <= hMin) { dst.copyTri(src, t); return; }
  if (ymin >= hMax) return;
  // Split into grid cells, then clip each piece at its cell height.
  const kx0 = Math.floor(xmin / g), kx1 = Math.floor(xmax / g), kz0 = Math.floor(zmin / g), kz1 = Math.floor(zmax / g);
  for (let kx = kx0; kx <= kx1; kx++) {
    let px = clipBy(vs, (p) => kx * g - p[0]);
    px = clipBy(px, (p) => p[0] - (kx + 1) * g);
    if (px.length < 3) continue;
    for (let kz = kz0; kz <= kz1; kz++) {
      let pz = clipBy(px, (p) => kz * g - p[2]);
      pz = clipBy(pz, (p) => p[2] - (kz + 1) * g);
      if (pz.length < 3) continue;
      const h = height((kx + 0.5) * g, (kz + 0.5) * g);
      const py = clipBy(pz, (p) => p[1] - h);
      emitPoly(dst, py, src, t);
    }
  }
}

function clipFlat(dst: MeshBuilder, src: MeshBuilder, t: number, h: number): void {
  const vs = triVerts(src, t);
  let ymin = Infinity, ymax = -Infinity;
  for (const v of vs) { ymin = Math.min(ymin, v.p[1]); ymax = Math.max(ymax, v.p[1]); }
  if (ymax <= h + 1e-6) { dst.copyTri(src, t); return; }
  if (ymin >= h) return;
  emitPoly(dst, clipBy(vs, (p) => p[1] - h), src, t);
}

/** A triangle heaped up to a fraction k of its height: earth and plinths rise whole, never cut open at the top. */
function squashY(dst: MeshBuilder, src: MeshBuilder, t: number, k: number): void {
  dst.copyTri(src, t);
  const o = dst.pos.length - 9;
  for (let i = 0; i < 3; i++) {
    if (dst.pos[o + i * 3 + 1] > 0) dst.pos[o + i * 3 + 1] *= k;
    if (dst.ctr[o + i * 3 + 1] > 0) dst.ctr[o + i * 3 + 1] *= k;
  }
}

export interface StateInfo {
  w: number;
  d: number;
  /** Dug or heaped rather than built up (a quarry face, a clay pit, a mine, a charcoal mound, a motte, salt pans):
   *  no scaffold round it while it is made. */
  earthwork?: boolean;
}

/**
 * Construction progress bins. Each cached construction model stands for one bin (drawn at its middle); the breaks
 * follow the sim's stages (construction/sites.ts `stageOf`: pegs < 0.08 ≤ footings < 0.3 ≤ frame < 0.75 ≤ roof < 1)
 * so what is drawn always matches the stage the site card names.
 */
export const CONSTRUCTION_BREAKS: readonly number[] = [0, 0.04, 0.08, 0.14, 0.2, 0.3, 0.4, 0.5, 0.62, 0.75, 0.84, 0.92];

/** Bin of a construction value (0 … BREAKS.length - 1; BREAKS.length = complete). */
export function constructionStep(c: number): number {
  if (!(c < 1)) return CONSTRUCTION_BREAKS.length;
  let i = 0;
  while (i + 1 < CONSTRUCTION_BREAKS.length && c >= CONSTRUCTION_BREAKS[i + 1]) i++;
  return i;
}

/** The construction value a bin is drawn at (its middle; 1 = complete). */
export function constructionOfStep(step: number): number {
  const n = CONSTRUCTION_BREAKS.length;
  if (step >= n) return 1;
  const a = CONSTRUCTION_BREAKS[Math.max(0, step)], b = step + 1 < n ? CONSTRUCTION_BREAKS[step + 1] : 1;
  return (a + b) / 2;
}

/** Wall tops at least this high get a full scaffold (masonry, towers, tall houses); lower ones a ladder and trestles. */
const SCAFFOLD_H = 4.2;

/**
 * Construction state (c < 1), read from the model's layers: the site is staked out with pegs, lines and lime marks
 * (pegs), the trenches are dug and the footings rise (footings), the frame rises ahead of the walls, the walls with a
 * ragged course top, the rafters go up (frame), the roof is laid from the eaves up and the doors and windows go in
 * (roof). Scaffolding stands round tall walls while they rise; low ones get a ladder and trestles. The materials on
 * the site are world props (the sim's site view), not part of the model.
 */
export function applyConstruction(src: MeshBuilder, c: number, info: StateInfo, seed: number): MeshBuilder {
  const lb = layerBounds(src);
  const dst = new MeshBuilder(seed + 3);
  /** Height to which a layer shows: nothing before `a`, its whole height by `b`. */
  const reveal = (l: number, a: number, b: number, from?: number): number => {
    const L = lb[l];
    if (L.min === Infinity || c < a) return -Infinity;
    const lo = from ?? Math.max(L.min, 0);
    return lo + (L.max + 0.01 - lo) * ss(a, b, c);
  };
  const G = lb[Layer.Ground];
  // the ground works (plinths, platforms, a motte's mound) are heaped up whole: squashed, not cut, so no hollow shows
  const kGround = G.min === Infinity || c < 0.08 ? -1 : Math.max(0.04, ss(0.08, 0.2, c));
  const hFrame = reveal(Layer.Frame, 0.17, 0.5);
  const hWall = reveal(Layer.Wall, 0.2, 0.7);
  const hRF = reveal(Layer.RoofFrame, 0.5, 0.72, lb[Layer.RoofFrame].min);
  const hRoof = reveal(Layer.Roof, 0.72, 0.97, lb[Layer.Roof].min);
  const showDetail = c >= 0.86;
  const ragged = (base: number) => (x: number, z: number) => base + (posHash(Math.floor(x), 0, Math.floor(z), seed) - 0.5) * 0.45;
  for (let t = 0; t < src.triCount; t++) {
    const layer = src.tLayer[t];
    const mat = src.tMat[t];
    if (mat !== Mat.Opaque && c < 0.95) {
      if (mat === Mat.Window && showDetail) clipFlat(dst, src, t, hWall);
      continue;
    }
    switch (layer) {
      case Layer.Ground: if (kGround > 0) squashY(dst, src, t, kGround); break;
      case Layer.Frame: if (hFrame > -Infinity) clipFlat(dst, src, t, hFrame); break;
      case Layer.Wall: if (hWall > -Infinity) raggedClip(dst, src, t, ragged(hWall), 1.1, hWall - 0.3, hWall + 0.3); break;
      case Layer.RoofFrame: if (hRF > -Infinity) clipFlat(dst, src, t, hRF); break;
      case Layer.Roof:
        if (hRoof > -Infinity && !(src.tFlags[t] & F.Under && c < 0.9)) clipFlat(dst, src, t, hRoof);
        break;
      case Layer.Detail: if (showDetail) clipFlat(dst, src, t, Math.max(hWall, lb[Layer.Wall].max)); break;
      case Layer.Decor: break;
    }
  }
  const outline = siteOutline(src, info);
  siteGround(dst, info, c);
  // (a well or the stocks get their four pegs and no more)
  const small = info.w * info.d < 6;
  if (c < 0.14) markingOut(dst, outline, small ? 1 : c);
  if (c >= 0.04 && c < 0.2 && !small) trenches(dst, outline, c, seed);
  const wb = src.bounds((t) => src.tLayer[t] === Layer.Wall && src.tMat[t] === Mat.Opaque);
  const wallTop = wb.isEmpty() ? 0 : wb.max.y;
  // how tall the walls stand: up to the eaves where there is a roof (gables and chimneys rise above them)
  const eaves = lb[Layer.Roof].min === Infinity ? wallTop : Math.min(wallTop, Math.max(0, lb[Layer.Roof].min));
  // (a church's porch roof is low but its tower is not: anything with walls 10 m up is scaffolded too)
  const tall = eaves >= SCAFFOLD_H || wallTop >= 10;
  const rising = Math.max(hWall, hFrame);
  if (c >= 0.2 && c < 0.92 && rising > 1.2 && !info.earthwork) {
    if (tall) scaffolding(dst, src, info, Math.min(wallTop, rising + 1.2), seed);
    else lightScaffold(dst, outline, Math.min(eaves, rising), c, seed);
  }
  if (c >= 0.14 && c < 0.92) siteTools(dst, outline, info, tall, seed);
  return dst;
}

interface Outline { x0: number; x1: number; z0: number; z1: number }

/** The rectangle the walls stand on (base of the wall layer), else the footprint less a margin. */
function siteOutline(src: MeshBuilder, info: StateInfo): Outline {
  const low = (t: number) => Math.min(src.pos[t * 9 + 1], src.pos[t * 9 + 4], src.pos[t * 9 + 7]) < 1.2;
  const wb = src.bounds((t) => src.tLayer[t] === Layer.Wall && src.tMat[t] === Mat.Opaque && low(t));
  const hw = info.w / 2 - 0.3, hd = info.d / 2 - 0.3;
  if (wb.isEmpty()) return { x0: -hw, x1: hw, z0: -hd, z1: hd };
  return { x0: Math.max(-hw, wb.min.x), x1: Math.min(hw, wb.max.x), z0: Math.max(-hd, wb.min.z), z1: Math.min(hd, wb.max.z) };
}

/** The cleared, trodden ground of the site (a levelled platform: its sides show on a slope). */
function siteGround(dst: MeshBuilder, info: StateInfo, c: number): void {
  if (info.w * info.d < 4) return;
  dst.layer = Layer.Ground;
  dst.flags = F.Snow | F.NoAO;
  const hw = info.w / 2 - 0.08, hd = info.d / 2 - 0.08;
  const top = c < 0.08 ? 0x7d6646 : 0x6f5a3e;
  dst.box(-hw, -0.5, -hd, hw, 0.025, hd, { top, side: COL.earth }, 'b');
}

/** Pegs at the corners and along the sides, string lines between them, lime marks on the ground. */
function markingOut(dst: MeshBuilder, o: Outline, c: number): void {
  dst.layer = Layer.Ground;
  dst.flags = F.Snow;
  const corners: [number, number][] = [[o.x0, o.z0], [o.x1, o.z0], [o.x1, o.z1], [o.x0, o.z1]];
  const peg = (x: number, z: number, h: number) => dst.cyl(x, z, -0.2, h, 0.035, 0.022, 4, 0xa7865a, { rot: 0.4 });
  const mx = (o.x0 + o.x1) / 2, mz = (o.z0 + o.z1) / 2;
  for (let i = 0; i < 4; i++) {
    const [ax, az] = corners[i], [bx, bz] = corners[(i + 1) % 4];
    const L = Math.hypot(bx - ax, bz - az);
    // corner profile: a pair of pegs set out beyond the corner
    const ox = Math.sign(ax - mx) * 0.5, oz = Math.sign(az - mz) * 0.5;
    peg(ax + ox, az, 0.62);
    if (c >= 1) continue;
    peg(ax, az + oz, 0.62);
    const n = Math.max(1, Math.round(L / 3));
    for (let k = 1; k < n; k++) peg(ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n, 0.42);
    if (c < 0.08) {
      // the string at knee height and the lime line under it
      dst.beam([ax, 0.36, az], [bx, 0.36, bz], 0.016, 0.016, COL.rope);
      dst.state({ flags: F.NoAO }, () => dst.beam([ax, 0.035, az], [bx, 0.035, bz], 0.12, 0.02, COL.lime));
    }
  }
}

/** Foundation trenches dug along the wall lines, with the spoil thrown up beside them. */
function trenches(dst: MeshBuilder, o: Outline, c: number, seed: number): void {
  dst.layer = Layer.Ground;
  dst.flags = F.Snow | F.NoAO;
  const w = 0.55;
  const k = ss(0.04, 0.1, c);
  const sides: [number, number, number, number, number, number][] = [
    [o.x0 - w / 2, o.z1 - w / 2, o.x1 + w / 2, o.z1 + w / 2, 0, 1], [o.x0 - w / 2, o.z0 - w / 2, o.x1 + w / 2, o.z0 + w / 2, 0, -1],
    [o.x0 - w / 2, o.z0 + w / 2, o.x0 + w / 2, o.z1 - w / 2, -1, 0], [o.x1 - w / 2, o.z0 + w / 2, o.x1 + w / 2, o.z1 - w / 2, 1, 0],
  ];
  sides.forEach(([x0, z0, x1, z1, nx, nz], i) => {
    // dug (dark) along the part of the line the diggers have reached
    const xe = nz !== 0 ? x0 + (x1 - x0) * k : x1, ze = nx !== 0 ? z0 + (z1 - z0) * k : z1;
    if (Math.abs(xe - x0) < 0.05 || Math.abs(ze - z0) < 0.05) return;
    dst.box(x0, 0.0, z0, xe, 0.04, ze, { top: 0x3f3122, side: 0x4a3a28 }, 'b');
    // spoil ridge just outside
    const sx = nx * (w * 0.5 + 0.3), sz = nz * (w * 0.5 + 0.3);
    const cx = (x0 + xe) / 2 + sx, cz = (z0 + ze) / 2 + sz;
    const lx = nz !== 0 ? Math.abs(xe - x0) / 2 : 0.3, lz = nx !== 0 ? Math.abs(ze - z0) / 2 : 0.3;
    dst.blob(cx, 0.0, cz, Math.max(0.3, lx), 0.2, Math.max(0.3, lz), COL.earth, 0.22, 0, seed + i);
  });
}

/** Low walls: a ladder against the front and a pair of trestles with a plank (cottages, sheds, low workshops). */
function lightScaffold(dst: MeshBuilder, o: Outline, h: number, c: number, seed: number): void {
  dst.layer = Layer.Detail;
  dst.flags = F.Burn | F.Snow;
  const pole = 0x8f7350;
  const lx = o.x0 + (o.x1 - o.x0) * 0.72, lz = o.z1 + 0.08;
  const lt = Math.max(1.6, h + 0.6);
  for (const dx of [-0.22, 0.22]) dst.beam([lx + dx, 0, lz + 0.55], [lx + dx, lt, lz + 0.02], 0.055, 0.055, pole);
  for (let y = 0.32; y < lt - 0.1; y += 0.32) {
    const zz = lz + 0.55 * (1 - y / lt) + 0.02;
    dst.beam([lx - 0.22, y, zz], [lx + 0.22, y, zz], 0.035, 0.035, pole);
  }
  if (c < 0.62) {
    // trestles and a plank along the back, where the daubers or masons work from
    const tz = o.z0 - 0.75, x0 = o.x0 + 0.6, x1 = Math.min(o.x1 - 0.6, x0 + 3.2);
    const th = Math.min(1.25, Math.max(0.8, h * 0.5));
    for (const x of [x0, x1]) {
      dst.beam([x - 0.25, 0, tz], [x, th, tz], 0.05, 0.05, pole);
      dst.beam([x + 0.25, 0, tz], [x, th, tz], 0.05, 0.05, pole);
    }
    dst.beam([x0 - 0.2, th + 0.03, tz], [x1 + 0.2, th + 0.03, tz], 0.32, 0.05, 0xa88b62);
  }
  void seed;
}

/** Working gear on the site: a mortar box and a hod (masonry) or a sawhorse with a beam and offcuts (timber). */
function siteTools(dst: MeshBuilder, o: Outline, info: StateInfo, masonry: boolean, seed: number): void {
  if (info.w * info.d < 8) return;
  dst.layer = Layer.Detail;
  dst.flags = F.Snow | F.Burn;
  const x = Math.max(-info.w / 2 + 0.6, o.x0 - 0.2) + 0.4, z = Math.min(info.d / 2 - 0.5, o.z1 + 0.9);
  if (masonry) {
    dst.box(x - 0.45, 0.02, z - 0.3, x + 0.45, 0.24, z + 0.3, { side: COL.timberRaw, top: 0xd8d2c2 });
    dst.beam([x + 0.7, 0.02, z], [x + 0.95, 1.05, z - 0.1], 0.05, 0.05, COL.timberRaw);
    dst.box(x + 0.82, 0.85, z - 0.22, x + 1.08, 1.05, z + 0.0, 0x9a7a52);
  } else {
    const p = 0x8a6a46;
    for (const dx of [-0.45, 0.45]) {
      dst.beam([x + dx, 0, z - 0.25], [x + dx, 0.7, z], 0.05, 0.05, p);
      dst.beam([x + dx, 0, z + 0.25], [x + dx, 0.7, z], 0.05, 0.05, p);
    }
    dst.beam([x - 1.0, 0.78, z], [x + 1.1, 0.78, z + 0.02], 0.18, 0.16, 0xa8875e);
    for (let i = 0; i < 6; i++) {
      const a = posHash(i, 3, seed) * Math.PI;
      const cx = x + (posHash(i, 1, seed) - 0.5) * 2.0, cz = z + 0.4 + (posHash(i, 2, seed) - 0.5) * 0.6;
      dst.beam([cx, 0.03, cz], [cx + Math.cos(a) * 0.12, 0.03, cz + Math.sin(a) * 0.12], 0.05, 0.015, 0xd8c08a);
    }
  }
}

function scaffolding(dst: MeshBuilder, src: MeshBuilder, info: StateInfo, h: number, seed: number): void {
  const wb = src.bounds((t) => src.tLayer[t] === Layer.Wall && src.tMat[t] === Mat.Opaque);
  if (wb.isEmpty()) return;
  const maxH = wb.max.y;
  if (maxH < 2.2 || info.w * info.d < 8) return;
  const off = 0.55;
  const x0 = Math.max(-info.w / 2 + 0.05, wb.min.x - off), x1 = Math.min(info.w / 2 - 0.05, wb.max.x + off);
  const z0 = Math.max(-info.d / 2 + 0.05, wb.min.z - off), z1 = Math.min(info.d / 2 - 0.05, wb.max.z + off);
  const per = 2 * ((x1 - x0) + (z1 - z0));
  const spacing = Math.max(2.4, per / 36);
  const levelH = Math.max(1.9, maxH / 7);
  const top = Math.min(h, maxH + 0.8);
  const pole = 0x8f7350;
  dst.layer = Layer.Detail;
  dst.flags = F.Burn | F.Snow;
  const sides: [number, number, number, number][] = [[x0, z1, x1, z1], [x1, z1, x1, z0], [x1, z0, x0, z0], [x0, z0, x0, z1]];
  for (const [ax, az, bx, bz] of sides) {
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.round(len / spacing));
    for (let i = 0; i < n; i++) {
      const f = i / n;
      const x = ax + (bx - ax) * f, z = az + (bz - az) * f;
      dst.cyl(x, z, -0.3, top + 0.9, 0.06, 0.05, 4, pole, { top: false, bottom: false, rot: Math.PI / 4 });
    }
    for (let y = levelH; y <= top + 0.01; y += levelH) {
      dst.beam([ax, y, az], [bx, y, bz], 0.07, 0.07, pole);
    }
    // working platform at the highest level
    const ly = Math.floor(top / levelH) * levelH;
    if (ly >= levelH) {
      const nx = -(bz - az) / len, nz = (bx - ax) / len;
      const w = 0.45;
      dst.beam([ax - nx * w, ly + 0.06, az - nz * w], [bx - nx * w, ly + 0.06, bz - nz * w], 0.5, 0.05, 0xa88b62);
    }
    // a diagonal brace on the long faces
    if (len > 6 && top > levelH * 1.5) {
      const f = Math.min(1, (levelH * 1.6) / len);
      dst.beam([ax, 0.1, az], [ax + (bx - ax) * f, Math.min(top, levelH * 2), az + (bz - az) * f], 0.05, 0.05, pole);
    }
  }
  // ladder at the front
  const lx = x0 + 0.7, lz = z1 + 0.05;
  const lt = Math.min(top + 1, maxH);
  dst.beam([lx - 0.22, 0, lz + 0.35], [lx - 0.22, lt, lz], 0.06, 0.06, pole);
  dst.beam([lx + 0.22, 0, lz + 0.35], [lx + 0.22, lt, lz], 0.06, 0.06, pole);
  for (let y = 0.35; y < lt; y += 0.35) {
    const zz = lz + 0.35 * (1 - y / lt);
    dst.beam([lx - 0.22, y, zz], [lx + 0.22, y, zz], 0.04, 0.04, pole);
  }
  // a hoist pole with a rope and a block of stone on its way up
  if (top > 5) {
    const hx = x1 - 0.4, hz = z1 - 0.2, hy = top + 1.6;
    dst.beam([hx, -0.3, hz], [hx, hy, hz], 0.09, 0.09, pole);
    dst.beam([hx, hy - 0.1, hz], [hx, hy - 0.1, hz + 1.1], 0.07, 0.07, pole);
    dst.beam([hx, hy - 0.15, hz + 1.05], [hx, top * 0.55, hz + 1.05], 0.02, 0.02, COL.rope);
    dst.box(hx - 0.25, top * 0.55 - 0.35, hz + 0.85, hx + 0.25, top * 0.55, hz + 1.25, { side: COL.stoneGrey, top: COL.stoneTrim });
  }
  void seed;
}

/** Damage state (d > 0): soot and char, roof holes, ragged collapse, rubble. */
export function applyDamage(src: MeshBuilder, d: number, info: StateInfo, seed: number): MeshBuilder {
  const lb = layerBounds(src);
  const dst = new MeshBuilder(seed + 5);
  const wallTop = Math.max(lb[Layer.Wall].max, 0.5);
  const H = Math.max(wallTop, lb[Layer.Roof].max, 1);
  const collapse = ss(0.4, 1.0, d);
  const wallH = (x: number, z: number) => {
    const n = valueNoise2(x / 3.2, z / 3.2, seed) * 0.7 + posHash(Math.floor(x / 1.1), 0, Math.floor(z / 1.1), seed + 1) * 0.3;
    const drop = collapse * (0.35 + 0.6 * n);
    return wallTop * (1 - Math.min(0.85, drop)) + 0.3;
  };
  const holeT = d >= 0.95 ? 2 : d * 0.78;
  const soot = lin(COL.soot), char = lin(COL.char);
  const scorch = (x: number, y: number, z: number) => {
    const n = valueNoise2(x / 1.7 + 3.1, z / 1.7 - y / 2.3, seed + 7);
    return ss(0, 0.35, n * 0.75 + (y / H) * 0.45 - (1 - d) * 0.95);
  };
  const dark: [number, number, number] = [0.012, 0.01, 0.009];
  for (let t = 0; t < src.triCount; t++) {
    const layer = src.tLayer[t];
    const mat = src.tMat[t];
    const fl = src.tFlags[t];
    const o = t * 9;
    const cx = (src.pos[o] + src.pos[o + 3] + src.pos[o + 6]) / 3;
    const cy = (src.pos[o + 1] + src.pos[o + 4] + src.pos[o + 7]) / 3;
    const cz = (src.pos[o + 2] + src.pos[o + 5] + src.pos[o + 8]) / 3;
    const hsh = posHash(Math.round(cx * 3), Math.round(cy * 3), Math.round(cz * 3), seed);
    if (mat === Mat.Window) {
      // Smashed / dark windows.
      if (cy < wallH(cx, cz)) emitPoly(dst, triVerts(src, t), src, t, { color: dark, mat: Mat.Opaque, flags: F.NoAO });
      continue;
    }
    if (mat === Mat.Glow) {
      if (d < 0.5) dst.copyTri(src, t);
      else emitPoly(dst, triVerts(src, t), src, t, { color: char, mat: Mat.Opaque });
      continue;
    }
    if (mat === Mat.Cloth) {
      if (hsh > d * 0.9) dst.copyTri(src, t);
      continue;
    }
    if (layer === Layer.Decor) { if (hsh > d * 1.6) dst.copyTri(src, t); continue; }
    if (layer === Layer.Roof) {
      if (fl & F.Under) continue;
      const n = valueNoise2(cx / 1.6, cz / 1.6, seed + 3) * 0.75 + hsh * 0.25;
      if (!(fl & F.NoHole) && n < holeT) continue;
    }
    if (layer === Layer.RoofFrame) {
      if (d < 0.2) continue;
      if (d >= 0.95 && hsh < 0.55) continue;
    }
    if (layer === Layer.Detail && d >= 0.5 && (fl & F.Burn) && hsh < d * 0.8) continue;
    // Recolour (soot / char), then clip walls when collapsing.
    const before = dst.triCount;
    if ((layer === Layer.Wall || layer === Layer.Frame || layer === Layer.Detail) && collapse > 0.01) {
      raggedClip(dst, src, t, wallH, 1.1, wallTop * 0.12, wallTop + 0.31);
    } else if (layer === Layer.RoofFrame && collapse > 0.01) {
      clipFlat(dst, src, t, wallTop + (H - wallTop) * (1 - collapse * 0.7));
    } else {
      dst.copyTri(src, t);
    }
    for (let k = before; k < dst.triCount; k++) {
      for (let v = 0; v < 3; v++) {
        const p = k * 9 + v * 3;
        const m = scorch(dst.pos[p], dst.pos[p + 1], dst.pos[p + 2]);
        const burn = (fl & F.Burn) || layer === Layer.RoofFrame ? 1 : 0.7;
        const target = burn === 1 ? char : soot;
        const a = m * burn;
        dst.col[p] += (target[0] - dst.col[p]) * a;
        dst.col[p + 1] += (target[1] - dst.col[p + 1]) * a;
        dst.col[p + 2] += (target[2] - dst.col[p + 2]) * a;
      }
      if (layer === Layer.RoofFrame) {
        for (let i = 0; i < 9; i += 3) {
          dst.col[k * 9 + i] = dst.col[k * 9 + i] * 0.4 + char[0] * 0.6;
          dst.col[k * 9 + i + 1] = dst.col[k * 9 + i + 1] * 0.4 + char[1] * 0.6;
          dst.col[k * 9 + i + 2] = dst.col[k * 9 + i + 2] * 0.4 + char[2] * 0.6;
        }
      }
    }
  }
  if (d >= 0.45) rubble(dst, src, info, d, seed);
  return dst;
}

function rubble(dst: MeshBuilder, src: MeshBuilder, info: StateInfo, d: number, seed: number): void {
  const wb = src.bounds((t) => src.tLayer[t] === Layer.Wall);
  if (wb.isEmpty()) return;
  // Sample the dominant wall colour.
  let r = 0, g = 0, bl = 0, n = 0;
  for (let t = 0; t < src.triCount && n < 400; t += 3) {
    if (src.tLayer[t] !== Layer.Wall) continue;
    r += src.col[t * 9]; g += src.col[t * 9 + 1]; bl += src.col[t * 9 + 2]; n++;
  }
  const toHex = (x: number) => Math.round(Math.pow(Math.min(1, x / Math.max(1, n)), 1 / 2.2) * 255);
  const wallHex = n ? (toHex(r) << 16) | (toHex(g) << 8) | toHex(bl) : COL.stoneGrey;
  dst.layer = Layer.Ground;
  dst.flags = F.Snow;
  const rnd = (k: number) => posHash(k, 1, 2, seed);
  const count = Math.round((6 + (info.w + info.d) * 0.9) * (d - 0.3));
  const hw = info.w / 2 - 0.3, hd = info.d / 2 - 0.3;
  for (let i = 0; i < count; i++) {
    const side = Math.floor(rnd(i * 5) * 4);
    const f = rnd(i * 5 + 1) * 2 - 1;
    let x = 0, z = 0;
    const ex = Math.min(hw, wb.max.x + 0.3), ez = Math.min(hd, wb.max.z + 0.3);
    if (side === 0) { x = f * ex; z = ez * (0.7 + rnd(i * 5 + 2) * 0.3); }
    else if (side === 1) { x = f * ex; z = -ez * (0.7 + rnd(i * 5 + 2) * 0.3); }
    else if (side === 2) { z = f * ez; x = ex * (0.7 + rnd(i * 5 + 2) * 0.3); }
    else { z = f * ez; x = -ex * (0.7 + rnd(i * 5 + 2) * 0.3); }
    const s = 0.25 + rnd(i * 5 + 3) * 0.45;
    const colr = rnd(i * 5 + 4) < 0.3 ? COL.char : wallHex;
    dst.blob(x, s * 0.25, z, s, s * 0.6, s * 0.8, colr, 0.3, 0, seed + i);
  }
  // A few fallen charred beams.
  const beams = Math.round(2 + d * 4);
  for (let i = 0; i < beams; i++) {
    const x = (rnd(i * 7 + 50) - 0.5) * info.w * 0.7, z = (rnd(i * 7 + 51) - 0.5) * info.d * 0.7;
    const a = rnd(i * 7 + 52) * Math.PI;
    const L = 1.5 + rnd(i * 7 + 53) * 2;
    const p0: V3 = [x - Math.cos(a) * L / 2, 0.12, z - Math.sin(a) * L / 2];
    const p1: V3 = [x + Math.cos(a) * L / 2, 0.12 + rnd(i * 7 + 54) * 0.8, z + Math.sin(a) * L / 2];
    dst.flags = F.Snow | F.Burn;
    dst.beam(p0, p1, 0.2, 0.2, COL.char);
  }
}

/**
 * A breach in a wall or palisade segment (FortView.breach; the segment runs along local x). Below one half the top is
 * battered (merlons knocked off, a ragged crest); from one half a gap opens in the middle — the masonry broken down in a
 * jagged V to a passable heap of rubble spilling out on both sides (stakes snapped off to stubs and lying about, for a
 * palisade) — wider as the breach grows, the full width at 1.
 */
export function applyBreach(src: MeshBuilder, breach: number, palisade: boolean, info: StateInfo, seed: number): MeshBuilder {
  const lb = layerBounds(src);
  const top = Math.max(lb[Layer.Wall].max, 1);
  const dst = new MeshBuilder(seed + 9);
  const gap = breach >= 0.5;
  const half = gap ? (info.w / 2) * Math.min(1.05, 0.32 + 1.3 * (breach - 0.5)) : 0;
  const xc = gap && breach < 1 ? (posHash(seed, 1, 2) - 0.5) * (info.w / 2 - half) : 0;
  const low = palisade ? 0.35 : 0.55;
  const height = (x: number, z: number): number => {
    const n = posHash(Math.floor(x / 0.7), 0, Math.floor(z / 0.7), seed);
    if (!gap) return top - 0.55 - n * 0.8;
    const d = Math.abs(x - xc) - half;
    if (d < 0) return low + n * (palisade ? 0.3 : 0.7);
    const ramp = palisade ? 0.6 : 2.2;
    return d < ramp ? low + (top - low) * (d / ramp) + (n - 0.5) * 0.8 : Infinity;
  };
  for (let t = 0; t < src.triCount; t++) {
    const layer = src.tLayer[t];
    if (layer === Layer.Wall || layer === Layer.Detail || layer === Layer.Frame) raggedClip(dst, src, t, height, 0.7, low, top + 2);
    else if (layer === Layer.Decor) { if (!gap) dst.copyTri(src, t); }
    else dst.copyTri(src, t);
  }
  // rubble (or snapped stakes) in and around the gap, spilling to both faces
  let r = 0, g = 0, bl = 0, n = 0;
  for (let t = 0; t < src.triCount && n < 300; t += 2) {
    if (src.tLayer[t] !== Layer.Wall) continue;
    r += src.col[t * 9]; g += src.col[t * 9 + 1]; bl += src.col[t * 9 + 2]; n++;
  }
  const toHex = (x: number) => Math.round(Math.pow(Math.min(1, x / Math.max(1, n)), 1 / 2.2) * 255);
  const wallHex = n ? (toHex(r) << 16) | (toHex(g) << 8) | toHex(bl) : COL.stoneGrey;
  dst.layer = Layer.Ground;
  dst.flags = F.Snow;
  const rnd = (k: number) => posHash(k, 3, 5, seed);
  const span = gap ? half + 0.8 : info.w / 2;
  const count = Math.round((palisade ? 6 : 10) + (gap ? breach * (palisade ? 10 : 26) : 4));
  for (let i = 0; i < count; i++) {
    const x = xc + (rnd(i * 4) * 2 - 1) * span;
    const side = rnd(i * 4 + 1) < 0.5 ? -1 : 1;
    const z = side * (info.d / 2) * (0.2 + rnd(i * 4 + 2) * (gap ? 1.4 : 0.7));
    if (palisade) {
      // a snapped stake lying on the ground, its pale broken end showing
      const a = rnd(i * 4 + 3) * Math.PI;
      const L = 1.2 + rnd(i * 4 + 3) * 1.4;
      dst.flags = F.Snow | F.Burn;
      dst.beam([x - Math.cos(a) * L / 2, 0.15, z - Math.sin(a) * L / 2], [x + Math.cos(a) * L / 2, 0.12, z + Math.sin(a) * L / 2], 0.26, 0.26, i % 3 ? COL.bark : 0x9a7a52);
      continue;
    }
    const s = 0.35 + rnd(i * 4 + 3) * 0.55;
    const inGap = Math.abs(x - xc) < half;
    // a heap across the gap (higher in the middle of the wall's thickness), loose blocks further out
    const y = inGap ? Math.max(0, 0.5 - Math.abs(z) / Math.max(1, info.d) * 0.6) : 0;
    dst.blob(x, y + s * 0.2, z, s * 1.2, s * 0.65, s, i % 5 === 0 ? COL.stoneDark : wallHex, 0.3, 0, seed + i);
  }
  if (gap && !palisade) {
    // the rubble ramp itself: a long low mound through the gap, out on both faces
    dst.blob(xc, 0.05, 0, half * 0.95, 0.85, info.d * 0.95, wallHex, 0.22, 1, seed + 77);
  }
  return dst;
}
