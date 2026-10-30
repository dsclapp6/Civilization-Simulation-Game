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

export interface StateInfo { w: number; d: number; }

/**
 * Construction state (c < 1). Returns a new builder with clipped layers plus scaffolding
 * and a materials pile.
 */
export function applyConstruction(src: MeshBuilder, c: number, info: StateInfo, seed: number): MeshBuilder {
  const lb = layerBounds(src);
  const dst = new MeshBuilder(seed + 3);
  const groundOn = c >= 0.03;
  const lerp = (l: number, a: number, b: number) => {
    const L = lb[l];
    if (L.min === Infinity) return -Infinity;
    const lo = Math.max(L.min, 0);
    return lo + (L.max - lo) * ss(a, b, c);
  };
  const hFrame = lerp(Layer.Frame, 0.06, 0.4);
  const hWall = lerp(Layer.Wall, 0.14, 0.64);
  const hRF = c > 0.5 ? lerp(Layer.RoofFrame, 0.5, 0.7) : -Infinity;
  const hRoof = c > 0.66 ? lerp(Layer.Roof, 0.66, 0.97) : -Infinity;
  const showDetail = c >= 0.84;
  const ragged = (base: number) => (x: number, z: number) => base + (posHash(Math.floor(x), 0, Math.floor(z), seed) - 0.5) * 0.45;
  for (let t = 0; t < src.triCount; t++) {
    const layer = src.tLayer[t];
    const mat = src.tMat[t];
    if (mat !== Mat.Opaque && c < 0.95) {
      if (mat === Mat.Window && showDetail) clipFlat(dst, src, t, hWall);
      continue;
    }
    switch (layer) {
      case Layer.Ground: if (groundOn) dst.copyTri(src, t); break;
      case Layer.Frame: clipFlat(dst, src, t, hFrame); break;
      case Layer.Wall: if (hWall > -Infinity) raggedClip(dst, src, t, ragged(hWall), 1.1, hWall - 0.3, hWall + 0.3); break;
      case Layer.RoofFrame: if (hRF > -Infinity) clipFlat(dst, src, t, hRF); break;
      case Layer.Roof:
        if (hRoof > -Infinity && !(src.tFlags[t] & F.Under && c < 0.9)) clipFlat(dst, src, t, hRoof);
        break;
      case Layer.Detail: if (showDetail) clipFlat(dst, src, t, Math.max(hWall, lb[Layer.Wall].max)); break;
      case Layer.Decor: break;
    }
  }
  // Scaffolding around the wall footprint while walls and roof go up.
  if (c > 0.04 && c < 0.97) {
    const wallTop = Math.max(lb[Layer.Wall].max, 0);
    const curH = Math.min(wallTop, Math.max(hWall, hFrame, 0.5) + 1.2);
    scaffolding(dst, src, info, curH, seed);
  }
  if (c < 0.9) materialsPile(dst, info, seed, c);
  if (c < 0.06) markingOut(dst, info);
  return dst;
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
    // Working platform at the highest level.
    const ly = Math.floor(top / levelH) * levelH;
    if (ly >= levelH) {
      const nx = -(bz - az) / len, nz = (bx - ax) / len;
      const w = 0.45;
      dst.push();
      dst.beam([ax - nx * w, ly + 0.06, az - nz * w], [bx - nx * w, ly + 0.06, bz - nz * w], 0.5, 0.05, 0xa88b62);
      dst.pop();
    }
  }
  // Ladder at the front.
  const lx = x0 + 0.7, lz = z1 + 0.05;
  const lt = Math.min(top + 1, maxH);
  dst.beam([lx - 0.22, 0, lz + 0.35], [lx - 0.22, lt, lz], 0.06, 0.06, pole);
  dst.beam([lx + 0.22, 0, lz + 0.35], [lx + 0.22, lt, lz], 0.06, 0.06, pole);
  for (let y = 0.35; y < lt; y += 0.35) {
    const zz = lz + 0.35 * (1 - y / lt);
    dst.beam([lx - 0.22, y, zz], [lx + 0.22, y, zz], 0.04, 0.04, pole);
  }
  void seed;
}

function materialsPile(dst: MeshBuilder, info: StateInfo, seed: number, c: number): void {
  if (info.w * info.d < 6) return;
  dst.layer = Layer.Detail;
  dst.flags = F.Snow | F.Burn;
  const x = -info.w / 2 + 0.6, z = info.d / 2 - 0.45;
  // Timber stack
  const n = c < 0.5 ? 4 : 2;
  for (let i = 0; i < n; i++) {
    const y = 0.11 + Math.floor(i / 2) * 0.2;
    const zz = z - (i % 2) * 0.24;
    dst.beam([x - 0.3, y, zz], [x + Math.min(2.4, info.w * 0.35), y, zz], 0.2, 0.2, i % 2 ? 0x9a7a52 : 0x8a6a46);
  }
  // Stone / daub heap
  dst.blob(info.w / 2 - 0.8, 0.12, info.d / 2 - 0.55, 0.5, 0.3, 0.4, COL.stoneGrey, 0.25, 0, seed);
  dst.box(info.w / 2 - 1.5, 0, info.d / 2 - 0.7, info.w / 2 - 1.05, 0.3, info.d / 2 - 0.3, COL.stoneTrim);
}

function markingOut(dst: MeshBuilder, info: StateInfo): void {
  dst.layer = Layer.Ground;
  dst.flags = F.Snow;
  const hw = info.w / 2 - 0.3, hd = info.d / 2 - 0.3;
  for (const [x, z] of [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]] as [number, number][]) {
    dst.cyl(x, z, 0, 0.6, 0.04, 0.02, 4, 0x9a7a52);
  }
  dst.beam([-hw, 0.45, hd], [hw, 0.45, hd], 0.015, 0.015, COL.rope);
  dst.beam([hw, 0.45, hd], [hw, 0.45, -hd], 0.015, 0.015, COL.rope);
  dst.beam([hw, 0.45, -hd], [-hw, 0.45, -hd], 0.015, 0.015, COL.rope);
  dst.beam([-hw, 0.45, -hd], [-hw, 0.45, hd], 0.015, 0.015, COL.rope);
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
