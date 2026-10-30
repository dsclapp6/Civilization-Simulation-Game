// Stage 7: open fields (furlongs of strips in three fields), common pasture, meadow, woodlots; woodland clearing.
import { BUILDINGS } from '../content/types';
import type { P2 } from '../core/math';
import { smoothstep as _smoothstep } from '../core/noise';
import { Biome as _Biome, type Strip } from './types';
import * as G from './grid';
import { bilerp as _bilerp } from './grid';
import { ccwFromAbove, localToWorld, polyArea } from './geom';
import { LayoutCtx, TAG } from './layout/common';
import { lap, lapReset } from './state';

const { CELL, N, NN } = G;
const smoothstep = _smoothstep, Biome = _Biome, bilerp = _bilerp;
export const TAG_STRIP = 5;

interface Farm { id: number; x: number; z: number; R: number; maxStrips: number; blockN: [number, number]; }

export function generateFields(ctx: LayoutCtx): void {
  lapReset();
  const s = ctx.s, tm = ctx.tm;
  const rng = ctx.rng.fork('fields');
  // ---- who farms what ----
  const farms: Farm[] = [];
  for (const st of s.settlements) {
    const site = s.sites[st.id];
    switch (st.kind) {
      case 'village': farms.push({ id: st.id, x: st.x, z: st.z, R: 380 + 2.4 * site.population, maxStrips: 330, blockN: [9, 22] }); break;
      case 'hamlet': farms.push({ id: st.id, x: st.x, z: st.z, R: 250, maxStrips: 70, blockN: [6, 12] }); break;
      case 'town': farms.push({ id: st.id, x: st.x, z: st.z, R: 380, maxStrips: 170, blockN: [8, 18] }); break;
      case 'city': farms.push({ id: st.id, x: st.x, z: st.z, R: 460, maxStrips: 200, blockN: [8, 18] }); break;
      case 'abbey': farms.push({ id: st.id, x: st.x, z: st.z, R: 540, maxStrips: 240, blockN: [8, 20] }); break;
      case 'priory': case 'nunnery': farms.push({ id: st.id, x: st.x, z: st.z, R: 420, maxStrips: 150, blockN: [8, 16] }); break;
      default: break;
    }
  }
  // ownership raster (macro cells): nearest farm by distance / R
  const owner = new Int16Array(NN).fill(-1);
  const best = new Float32Array(NN).fill(1.0001);
  farms.forEach((f, fi) => {
    const i0 = Math.max(0, Math.floor((f.x - f.R) / CELL)), i1 = Math.min(N - 1, Math.floor((f.x + f.R) / CELL));
    const j0 = Math.max(0, Math.floor((f.z - f.R) / CELL)), j1 = Math.min(N - 1, Math.floor((f.z + f.R) / CELL));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const d = Math.hypot((i + 0.5) * CELL - f.x, (j + 0.5) * CELL - f.z) / f.R;
      const k = j * N + i;
      if (d < best[k]) { best[k] = d; owner[k] = fi; }
    }
  });
  const ownerAt = (x: number, z: number): number => owner[Math.min(N - 1, Math.max(0, Math.floor(z / CELL))) * N + Math.min(N - 1, Math.max(0, Math.floor(x / CELL)))];
  const { fertility, forest, biome, slope, coastDist, waterDist, water } = s;
  const suit = (x: number, z: number): number => {
    const k = Math.min(N - 1, Math.max(0, Math.floor(z / CELL))) * N + Math.min(N - 1, Math.max(0, Math.floor(x / CELL)));
    if (water[k] !== 0 || coastDist[k] < 50) return 0;
    const b = biome[k];
    if (b === Biome.Marsh || b === Biome.Moor || b === Biome.Mountain || b === Biome.Snow || b === Biome.Beach || b === Biome.Upland) return 0;
    if (bilerp(waterDist, x, z) < 46) return 0;
    const sl = bilerp(slope, x, z);
    if (sl > 0.085) return 0;
    const f = bilerp(forest, x, z) / 255;
    if (f > 0.55) return 0;
    const fe = bilerp(fertility, x, z) / 255;
    if (fe < 0.2) return 0;
    return fe * (1 - f) * (1 - sl * 6);
  };

  let totalStrips = 0;
  farms.forEach((farm, fi) => {
    const st = s.settlements[farm.id];
    const fr = rng.fork('farm' + farm.id);
    const blocks: { cx: number; cz: number; ang: number; strips: number[] }[] = [];
    const placedStrips: Strip[] = [];
    const r0 = Math.max(st.radius, 40) + 26;
    const ring = (r: number, off: number): { x: number; z: number }[] => {
      const out: { x: number; z: number }[] = [];
      const n = Math.max(6, Math.round((Math.PI * 2 * r) / 120));
      for (let a = 0; a < n; a++) {
        const ang = off + (a / n) * Math.PI * 2;
        out.push({ x: farm.x + Math.cos(ang) * (r + fr.range(-26, 26)), z: farm.z + Math.sin(ang) * (r + fr.range(-26, 26)) });
      }
      return out;
    };
    const phase = fr.range(0, Math.PI * 2);
    for (let r = r0 + 40, ringIdx = 0; r < farm.R && placedStrips.length < farm.maxStrips; r += 95, ringIdx++) {
      const cands = ring(r, phase + ringIdx * 0.37);
      for (const c of cands) {
        if (placedStrips.length >= farm.maxStrips) break;
        if (ownerAt(c.x, c.z) !== fi) continue;
        if (Math.hypot(c.x - farm.x, c.z - farm.z) > farm.R) continue;
        if (suit(c.x, c.z) <= 0.05) continue;
        if (ctx.occ.covers(c.x, c.z, 4, (1 << TAG.plot) | (1 << TAG.parcel) | (1 << TAG_STRIP) | (1 << TAG.blocker))) continue;
        // furlong orientation: along the contour on slopes, otherwise coherent random
        const hx = tm.macroHeight(c.x + 25, c.z) - tm.macroHeight(c.x - 25, c.z);
        const hz = tm.macroHeight(c.x, c.z + 25) - tm.macroHeight(c.x, c.z - 25);
        const g = Math.hypot(hx, hz) / 50;
        let ang: number;
        if (g > 0.03) ang = Math.atan2(-hx, hz) + (fr.chance(0.5) ? 0 : Math.PI); // contour direction in x/z
        else ang = Math.floor(fr.next() * 4) * (Math.PI / 4) + fr.range(-0.12, 0.12) + (hash(c.x, c.z) < 0.5 ? 0 : Math.PI / 2);
        // snap to neighbours' orientation sometimes to form larger coherent furlongs
        const near = blocks.length ? blocks.reduce((b, q) => (Math.hypot(q.cx - c.x, q.cz - c.z) < Math.hypot(b.cx - c.x, b.cz - c.z) ? q : b)) : null;
        if (near && Math.hypot(near.cx - c.x, near.cz - c.z) < 220 && fr.chance(0.6)) ang = near.ang + (fr.chance(0.25) ? Math.PI / 2 : 0);
        const L = fr.range(68, 128), sw = fr.range(8.4, 11.6);
        const nMax = fr.int(farm.blockN[0], farm.blockN[1]);
        const dirx = Math.sin(ang), dirz = Math.cos(ang); // strip long axis (local +z of the strip)
        const perpx = Math.cos(ang), perpz = -Math.sin(ang); // across strips (local +x)
        const made: P2[][] = [];
        let kMin = 0, kMax = 0;
        let fails = 0;
        for (let q = 0; q < nMax * 2 && made.length < nMax && fails < 3; q++) {
          // alternate sides: 0, +1, -1, +2, -2, ...
          const k = q === 0 ? 0 : q % 2 === 1 ? (q + 1) / 2 : -q / 2;
          const sx = c.x + perpx * k * sw, sz = c.z + perpz * k * sw;
          const poly = validateStrip(ctx, fi, sx, sz, ang, sw, L, suit, ownerAt);
          if (poly) { made.push(poly); fails = 0; if (k < kMin) kMin = k; if (k > kMax) kMax = k; } else fails++;
        }
        if (made.length < 5) continue;
        const ids: number[] = [];
        for (const poly of made) {
          const id = ctx.s.strips.length;
          const strip: Strip = { id, settlement: farm.id, field: 0, poly, area: polyArea(poly) };
          ctx.s.strips.push(strip);
          st.strips.push(id);
          ctx.occ.add(poly, TAG_STRIP, id);
          ids.push(id);
          placedStrips.push(strip);
        }
        blocks.push({ cx: c.x, cz: c.z, ang, strips: ids });
        // hedgerow around the furlong
        {
          const f = { x: c.x + perpx * ((kMin + kMax) / 2) * sw, z: c.z + perpz * ((kMin + kMax) / 2) * sw, rot: ang };
          const ww = (kMax - kMin + 1) * sw;
          const q = rectPoly(f, ww + 2, L + 2);
          for (let e = 0; e < 4; e++) { const a = q[e], b = q[(e + 1) % 4]; ctx.s.hedges.push(a.x, a.z, b.x, b.z); }
        }
        void dirx; void dirz;
      }
    }
    // three fields: contiguous angular sectors with balanced strip counts (per furlong, or per strip for tiny holdings)
    if (placedStrips.length) {
      type Item = { a: number; n: number; apply: (f: 0 | 1 | 2) => void };
      const items: Item[] = blocks.length >= 6
        ? blocks.map((b) => ({ a: Math.atan2(b.cz - farm.z, b.cx - farm.x), n: b.strips.length, apply: (f) => { for (const sid of b.strips) s.strips[sid].field = f; } }))
        : placedStrips.map((t) => {
          const mx = (t.poly[0].x + t.poly[2].x) / 2, mz = (t.poly[0].z + t.poly[2].z) / 2;
          return { a: Math.atan2(mz - farm.z, mx - farm.x), n: 1, apply: (f: 0 | 1 | 2) => { t.field = f; } };
        });
      items.sort((p, q) => p.a - q.a);
      let gapAt = 0, gap = -1;
      for (let i = 0; i < items.length; i++) {
        const nxt = items[(i + 1) % items.length].a + (i + 1 === items.length ? Math.PI * 2 : 0);
        if (nxt - items[i].a > gap) { gap = nxt - items[i].a; gapAt = (i + 1) % items.length; }
      }
      const ordered = items.slice(gapAt).concat(items.slice(0, gapAt));
      const total = ordered.reduce((a, b) => a + b.n, 0);
      let acc = 0;
      for (const it of ordered) {
        it.apply(Math.min(2, Math.floor(((acc + it.n / 2) / total) * 3)) as 0 | 1 | 2);
        acc += it.n;
      }
    }
    totalStrips += placedStrips.length;
    // common pasture, meadow and woodlots
    commonLands(ctx, farm, fi, owner, ownerAt, fr);
    void st;
  });
  lap(s, 'f.strips');
  clearWoodland(s, farms, owner);
  lap(s, 'f.clear');
  void totalStrips;
}

function hash(x: number, z: number): number {
  let h = Math.imul(Math.floor(x / 90) | 0, 0x9e3779b1) ^ Math.imul(Math.floor(z / 90) | 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

function validateStrip(
  ctx: LayoutCtx, fi: number, cx: number, cz: number, ang: number, sw: number, L: number,
  suit: (x: number, z: number) => number, ownerAt: (x: number, z: number) => number,
): P2[] | null {
  const frame = { x: cx, z: cz, rot: ang };
  const tmp: P2 = { x: 0, z: 0 };
  const hw = sw / 2, hl = L / 2;
  const corners: P2[] = [];
  for (const [lx, lz] of [[-hw, -hl], [-hw, hl], [hw, hl], [hw, -hl]]) { localToWorld(frame, lx, lz, tmp); corners.push({ x: tmp.x, z: tmp.z }); }
  for (const [lx, lz] of [[0, 0], [0, -hl], [0, hl], [-hw, -hl], [hw, hl]]) {
    localToWorld(frame, lx, lz, tmp);
    if (tmp.x < 80 || tmp.z < 80 || tmp.x > 15920 || tmp.z > 15920) return null;
    if (ownerAt(tmp.x, tmp.z) !== fi) return null;
    if (suit(tmp.x, tmp.z) <= 0.04) return null;
  }
  if (ctx.occ.overlaps(corners, 0.8)) return null;
  if (ctx.roadIdx.hitsPoly(corners, 2.2)) return null;
  localToWorld(frame, 0, -hl, tmp); const h0 = ctx.tm.macroHeight(tmp.x, tmp.z);
  localToWorld(frame, 0, hl, tmp); const h1 = ctx.tm.macroHeight(tmp.x, tmp.z);
  if (Math.abs(h1 - h0) > L * 0.09) return null;
  return ccwFromAbove(corners);
}

function commonLands(
  ctx: LayoutCtx, farm: Farm, fi: number, owner: Int16Array, ownerAt: (x: number, z: number) => number, fr: ReturnType<LayoutCtx['rng']['fork']>,
): void {
  const s = ctx.s, tm = ctx.tm;
  const st = s.settlements[farm.id];
  const kind = st.kind;
  // ---- common pasture: rectangles hugging the settlement edge ----
  const wantPasture = kind === 'village' || kind === 'hamlet' ? 2 : 1;
  let made = 0;
  const startAngle = fr.range(0, Math.PI * 2);
  for (let attempt = 0; attempt < 22 && made < wantPasture; attempt++) {
    const ang = startAngle + attempt * 2.399;
    const rr = Math.max(st.radius, 40) + fr.range(28, 150);
    const cx = farm.x + Math.cos(ang) * rr, cz = farm.z + Math.sin(ang) * rr;
    if (ownerAt(cx, cz) !== fi) continue;
    const w = fr.range(80, 150), d = fr.range(55, 100);
    const rot = ang + Math.PI / 2 + fr.range(-0.3, 0.3);
    const frame = { x: cx, z: cz, rot };
    const q = rectPoly(frame, w, d);
    if (!ctx.parcelFits(q, 1.2, 8)) continue;
    if (tm.coarseSlope(cx, cz) > 0.14) continue;
    ctx.addParcel(farm.id, 'pasture', q);
    made++;
  }
  // ---- meadow: ribbons along the river ----
  let meadows = 0;
  const rs = tm;
  for (let i = 0; i + 4 < rs.rsX0.length && meadows < 3; i += 3) {
    const ax = rs.rsX0[i], az = rs.rsZ0[i];
    if (Math.abs(ax - farm.x) > farm.R || Math.abs(az - farm.z) > farm.R) continue;
    if (Math.hypot(ax - farm.x, az - farm.z) > farm.R * 0.95) continue;
    const w = rs.rsW0[i];
    if (w < 2.2) continue;
    if (!fr.chance(0.35)) continue;
    // four consecutive points of the same river
    if (rs.rsRiver[i] !== rs.rsRiver[i + 3]) continue;
    const pts: P2[] = [];
    for (let k = 0; k <= 3; k++) pts.push({ x: rs.rsX0[i + k], z: rs.rsZ0[i + k] });
    const side = fr.chance(0.5) ? 1 : -1;
    const inner: P2[] = [], outer: P2[] = [];
    for (let k = 0; k <= 3; k++) {
      const a = pts[Math.max(0, k - 1)], b = pts[Math.min(3, k + 1)];
      let tx = b.x - a.x, tz = b.z - a.z;
      const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
      const hw = rs.rsW0[i + k] / 2;
      inner.push({ x: pts[k].x - tz * side * (hw + 7), z: pts[k].z + tx * side * (hw + 7) });
      outer.push({ x: pts[k].x - tz * side * (hw + 7 + fr.range(30, 50)), z: pts[k].z + tx * side * (hw + 7 + fr.range(30, 50)) });
    }
    const poly = [...inner, ...outer.reverse()];
    if (!convexish(poly)) continue;
    if (!ctx.parcelFits(poly, 0.8, 3)) continue;
    ctx.addParcel(farm.id, 'meadow', poly);
    meadows++;
  }
  // ---- woodlot at the far edge where trees stand ----
  if (kind === 'village' || kind === 'abbey' || kind === 'town') {
    for (let attempt = 0; attempt < 30; attempt++) {
      const ang = fr.range(0, Math.PI * 2);
      const rr = farm.R * fr.range(0.6, 0.92);
      const cx = farm.x + Math.cos(ang) * rr, cz = farm.z + Math.sin(ang) * rr;
      if (ownerAt(cx, cz) !== fi) continue;
      if (bilerp(s.forest, cx, cz) < 110) continue;
      const q = rectPoly({ x: cx, z: cz, rot: ang }, fr.range(60, 110), fr.range(50, 90));
      if (!ctx.parcelFits(q, 1, 6)) continue;
      ctx.addParcel(farm.id, 'woodlot', q);
      break;
    }
  }
  void owner;
}

function rectPoly(f: { x: number; z: number; rot: number }, w: number, d: number): P2[] {
  const t: P2 = { x: 0, z: 0 };
  return [[-w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2], [w / 2, -d / 2]].map(([lx, lz]) => { localToWorld(f, lx, lz, t); return { x: t.x, z: t.z }; });
}

/** Ribbon polygons must be simple and roughly convex for the overlap tests. */
function convexish(poly: P2[]): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], c = poly[(i + 2) % poly.length];
    const cr = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
    if (Math.abs(cr) < 1e-6) continue;
    const sg = cr > 0 ? 1 : -1;
    if (sign === 0) sign = sg; else if (sg !== sign) return false;
  }
  return true;
}

/** Woodland is cleared around farmed land: strips, parcels and the area near each farm. */
function clearWoodland(s: LayoutCtx['s'], farms: Farm[], owner: Int16Array): void {
  const { forest, biome, land } = s;
  const clearing = new Float32Array(NN);
  farms.forEach((f, fi) => {
    // the edge of the clearing is lobed, not a circle: assarts followed the soil, streams and the lord's licence
    const p1 = fi * 2.399 + 0.7, p2 = fi * 1.618 + 2.1, p3 = fi * 0.931 + 4.2;
    const reach = f.R * 1.5;
    const i0 = Math.max(0, Math.floor((f.x - reach) / CELL)), i1 = Math.min(N - 1, Math.floor((f.x + reach) / CELL));
    const j0 = Math.max(0, Math.floor((f.z - reach) / CELL)), j1 = Math.min(N - 1, Math.floor((f.z + reach) / CELL));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const dx = (i + 0.5) * CELL - f.x, dz = (j + 0.5) * CELL - f.z;
      const a = Math.atan2(dz, dx);
      const lobe = 1 + 0.22 * Math.sin(3 * a + p1) + 0.15 * Math.sin(5 * a + p2) + 0.09 * Math.sin(9 * a + p3);
      const d = Math.hypot(dx, dz) / (f.R * lobe);
      const c = 1 - smoothstep(0.5, 0.95, d);
      const k = j * N + i;
      if (c > clearing[k]) clearing[k] = c;
    }
  });
  for (let k = 0; k < NN; k++) {
    if (!land[k] || clearing[k] <= 0) continue;
    forest[k] = Math.round(forest[k] * (1 - 0.9 * clearing[k]));
    if (forest[k] < 100 && (biome[k] === Biome.Broadleaf || biome[k] === Biome.Pine)) biome[k] = Biome.Meadow;
  }
  void owner;
  void BUILDINGS;
}
