// The inside of a building, drawn from its plan (docs/INTERIORS.md): the inner faces of the walls with their thickness, the
// doorways and windows where they are outside (reveals, sills, panes that show the day), floors of earth, flags or boards, the
// joists under an upper floor, the rafters under the roof, partitions, stairs and ladders with their rails, and the furniture
// of the rooms at the scale of people. Flat-shaded vertex colours like everything else (docs/ART.md); three channels: the
// opaque body, the glow (embers, candle flames) and the window panes (the renderer colours them by the light outside).
import { BUILDINGS, type BuildingKind } from '../../content/types';
import type { CultureId } from '../../core/domain';
import { archShape, F, Layer, Mat, MeshBuilder, mixHex, shade, type V2 } from '../core/builder';
import { STYLES } from '../buildings/style';
import { COL, type CultureStyle } from '../buildings/style';
import type { InteriorPlan, PBlock, PDoor, PFurn, PStair, PWindow } from './types';

export interface InteriorModel {
  body: MeshBuilder;
  glow: MeshBuilder;
  panes: MeshBuilder;
}

type Side = 'pz' | 'nz' | 'px' | 'nx';
const SIDES: Side[] = ['pz', 'px', 'nz', 'nx'];

const STONEY = new Set(['stone', 'rubble']);
const CHURCHLY = new Set(['church', 'chapel', 'abbey_church', 'cathedral', 'cloister', 'infirmary']);
const CASTLE = new Set(['keep_stone', 'tower', 'gatehouse', 'great_hall', 'motte']);

/** The colour of a wall's inner face: limewashed plaster in a house, dressed stone in a church or castle, boards in a barn. */
function innerColor(wall: string, kind: string, s: CultureStyle): number {
  if (wall === 'planks') return shade(COL.plank, 1.08);
  if (wall === 'weatherboard') return shade(COL.weatherboardGrey, 0.95);
  if (STONEY.has(wall) && (CHURCHLY.has(kind) || CASTLE.has(kind) || kind === 'library' || kind === 'gaol')) return mixHex(s.stone, 0xd8cfba, 0.35);
  if (STONEY.has(wall) && (kind === 'barn' || kind === 'tithe_barn' || kind === 'stable' || kind === 'cowshed')) return shade(s.stone, 0.92);
  return CHURCHLY.has(kind) ? 0xe9e1cf : shade(COL.limewash, 0.94);
}

function floorKind(kind: string, level: number, y: number, base: number): 'earth' | 'flags' | 'boards' | 'straw' | 'cobbles' {
  if (level > 0 && y > base + 1.2) return 'boards';
  if (kind === 'barn' || kind === 'tithe_barn' || kind === 'granary' || kind === 'stable' || kind === 'cowshed' || kind === 'pigsty' || kind === 'henhouse') return kind === 'granary' ? 'boards' : 'straw';
  if (kind === 'hovel' || kind === 'longhouse' || kind === 'smithy' || kind === 'tannery' || kind === 'slaughterhouse' || kind === 'bloomery' || kind === 'cottage') return 'earth';
  if (CHURCHLY.has(kind) || CASTLE.has(kind) || kind === 'manor_house' || kind === 'guildhall' || kind === 'library' || kind === 'gaol' || kind === 'bakehouse' || kind === 'brewhouse') return 'flags';
  if (kind === 'watermill' || kind === 'fulling_mill' || kind === 'warehouse' || kind === 'carpenter' || kind === 'weaver') return 'boards';
  return 'earth';
}

export function buildInterior(plan: InteriorPlan): InteriorModel {
  const s = STYLES[plan.culture as CultureId] ?? STYLES.anglo;
  const body = new MeshBuilder(17);
  const glow = new MeshBuilder(18);
  const panes = new MeshBuilder(19);
  body.layer = Layer.Wall;
  body.flags = F.NoAO;
  body.jitter = 0.02;
  glow.mat = Mat.Glow;
  glow.flags = F.NoAO;
  panes.flags = F.NoAO;
  const base = plan.levels[0]?.y ?? 0;
  for (const bl of plan.blocks) drawBlock(body, panes, plan, bl, s);
  drawFloors(body, plan, s, base);
  for (const p of plan.partitions) drawPartition(body, p, s);
  for (const st of plan.stairs) if (st.kind !== 'steps') drawStair(body, st, s);
  for (const r of plan.rails) drawRail(body, r, s);
  for (const d of plan.doors) if (!d.outer) drawInnerDoorFrame(body, d, s);
  for (const f of plan.furniture) drawFurn(body, glow, f, s, plan.kind);
  for (const l of plan.lights) if (l.kind === 'candle' && !plan.furniture.some((f) => (f.kind === 'chandelier') && Math.hypot(f.x - l.x, f.z - l.z) < 0.5)) candle(body, glow, l.x, l.y - 0.2, l.z);
  return { body, glow, panes };
}

// ---------------------------------------------------------------------------------------------------------------------
// walls

/** Enter a frame on the inner face of a wall: u along it, v up from y, n (local +z) into the room. Returns the map x/z → u. */
function enterInner(b: MeshBuilder, r: { x0: number; x1: number; z0: number; z1: number }, s: Side, y: number): (x: number, z: number) => number {
  const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
  b.push();
  if (s === 'pz') { b.translate(cx, y, r.z1); b.rotY(Math.PI); return (x) => -(x - cx); }
  if (s === 'nz') { b.translate(cx, y, r.z0); return (x) => x - cx; }
  if (s === 'px') { b.translate(r.x1, y, cz); b.rotY(-Math.PI / 2); return (_x, z) => z - cz; }
  b.translate(r.x0, y, cz); b.rotY(Math.PI / 2); return (_x, z) => -(z - cz);
}

interface Hole { u: number; w: number; v0: number; v1: number; shape: 'flat' | 'round' | 'pointed' | 'tudor'; win: PWindow | null; door: PDoor | null }

/** A round block: the inner face of its wall as a ring (open at its doorways, with their passages), and the floor to the wall. */
function drawRoundBlock(b: MeshBuilder, plan: InteriorPlan, bl: PBlock, s: CultureStyle): void {
  const rd = bl.round!;
  const col = innerColor(bl.wall, plan.kind, s), reveal = shade(col, 0.8);
  const n = 18;
  const P = (a: number, r: number, y: number): [number, number, number] => [rd.cx + Math.sin(a) * r, y, rd.cz + Math.cos(a) * r];
  const doors = plan.doors.filter((d) => Math.abs(Math.hypot(d.x - rd.cx, d.z - rd.cz) - rd.r) < 0.6);
  b.state({ layer: Layer.Wall, flags: F.NoAO }, () => {
    bl.ys.forEach((y, k) => {
      const top = y + Math.min(bl.hs[k], 7.5);
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
        const am = (a0 + a1) / 2;
        let lo = y;
        for (const d of doors) {
          if (Math.abs(d.y - y) > 0.6) continue;
          const da = Math.atan2(d.x - rd.cx, d.z - rd.cz);
          const half = (d.w / 2) / rd.rin + Math.PI / n;
          if (Math.abs(Math.atan2(Math.sin(am - da), Math.cos(am - da))) < half) lo = Math.max(lo, d.y + d.h);
        }
        b.quad(P(a1, rd.rin, lo), P(a0, rd.rin, lo), P(a0, rd.rin, top), P(a1, rd.rin, top), i % 2 ? col : shade(col, 0.96));
      }
      // the floor out to the wall beyond each side of the plan's square floor
      const half = rd.rin / Math.SQRT2 + 0.12;
      if (half < rd.rin) {
        const tc = Math.atan2(Math.sqrt(rd.rin * rd.rin - half * half), half);
        for (const phi of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
          const pts: [number, number, number][] = [];
          for (let j = 0; j <= 6; j++) pts.push(P(phi - tc + (2 * tc * j) / 6, rd.rin, y - 0.01));
          b.poly(pts, k > 0 ? 0x8a6a48 : mixHex(s.stone, 0x8a847a, 0.5));
        }
      }
      // the doorways' passages through the thickness of the wall
      for (const d of doors) {
        if (Math.abs(d.y - y) > 0.6) continue;
        const da = Math.atan2(d.x - rd.cx, d.z - rd.cz);
        const ux = Math.cos(da), uz = -Math.sin(da);
        for (const sd of [-1, 1]) {
          const ox = ux * sd * d.w / 2, oz = uz * sd * d.w / 2;
          const inner: [number, number, number] = [rd.cx + Math.sin(da) * (rd.rin - 0.05) + ox, d.y, rd.cz + Math.cos(da) * (rd.rin - 0.05) + oz];
          const outer: [number, number, number] = [rd.cx + Math.sin(da) * rd.r + ox, d.y, rd.cz + Math.cos(da) * rd.r + oz];
          const q = [inner, outer, [outer[0], d.y + d.h, outer[2]], [inner[0], d.y + d.h, inner[2]]] as [number, number, number][];
          if (sd > 0) b.quad(q[0], q[1], q[2], q[3], reveal); else b.quad(q[3], q[2], q[1], q[0], reveal);
        }
      }
    });
  });
}

function drawBlock(b: MeshBuilder, panes: MeshBuilder, plan: InteriorPlan, bl: PBlock, s: CultureStyle): void {
  if (bl.round) { drawRoundBlock(b, plan, bl, s); return; }
  const col = innerColor(bl.wall, plan.kind, s);
  const reveal = shade(col, 0.82);
  const cap = shade(col, 0.7);
  bl.rects.forEach((R, k) => {
    const y = bl.ys[k];
    const h = bl.hs[k];
    if (h < 0.3) return;
    const t = bl.t;
    // the inner rect: the walls' inner faces
    const open = (bl.open[k] ?? []) as Side[];
    const IR = { x0: R.x0 + (open.includes('nx') ? 0 : t), x1: R.x1 - (open.includes('px') ? 0 : t), z0: R.z0 + (open.includes('nz') ? 0 : t), z1: R.z1 - (open.includes('pz') ? 0 : t) };
    const topH = Math.min(h, 7.5);
    for (const side of SIDES) {
      if (open.includes(side)) continue;
      const outerC = side === 'pz' ? R.z1 : side === 'nz' ? R.z0 : side === 'px' ? R.x1 : R.x0;
      const along = side === 'pz' || side === 'nz';
      const L = along ? IR.x1 - IR.x0 : IR.z1 - IR.z0;
      const holes: Hole[] = [];
      const toU = enterInner(b, IR, side, y);
      for (const d of plan.doors) {
        if (d.kind === 'small' && d.h < 0.6) continue;
        const onPlane = along ? Math.abs(d.nz) > 0.5 && Math.abs(d.z - outerC) < d.t + 0.2 : Math.abs(d.nx) > 0.5 && Math.abs(d.x - outerC) < d.t + 0.2;
        if (!onPlane || d.y < y - 0.6 || d.y > y + h - 0.5) continue;
        const u = toU(d.x, d.z);
        if (Math.abs(u) > L / 2 + 0.2) continue;
        holes.push({ u, w: d.w, v0: d.y - y, v1: d.y - y + d.h, shape: d.shape, win: null, door: d });
      }
      for (const w of plan.windows) {
        const onPlane = along ? Math.abs(w.nz) > 0.5 && Math.abs(w.z - outerC) < 0.05 : Math.abs(w.nx) > 0.5 && Math.abs(w.x - outerC) < 0.05;
        if (!onPlane || w.y < y - 0.05 || w.y > y + h) continue;
        const u = toU(w.x, w.z);
        if (Math.abs(u) > L / 2) continue;
        holes.push({ u, w: w.w, v0: w.y - y, v1: Math.min(h - 0.05, w.y - y + w.h), shape: w.shape, win: w, door: null });
      }
      holes.sort((p, q) => p.u - q.u);
      const depth = t - 0.03;
      const piece = (u0: number, u1: number, v0: number, v1: number): void => {
        if (u1 - u0 < 0.01 || v1 - v0 < 0.01) return;
        b.box(u0, v0, -depth, u1, v1, 0, { pz: col, side: reveal, top: cap, bottom: reveal }, 'nz');
      };
      let u = -L / 2;
      for (const hl of holes) {
        const a0 = Math.max(-L / 2, hl.u - hl.w / 2), a1 = Math.min(L / 2, hl.u + hl.w / 2);
        if (a0 > u) piece(u, a0, 0, topH);
        if (a1 <= u) continue;
        const from = Math.max(u, a0);
        piece(from, a1, 0, Math.max(0, hl.v0));
        piece(from, a1, hl.v1, topH);
        if (hl.shape !== 'flat') archFill(b, hl, col, reveal, depth);
        if (hl.win) {
          // the pane in the middle of the wall's thickness, a sill board under it
          const pts = archShape(hl.w, hl.v1 - hl.v0, hl.shape, 4).map(([x, v]) => [x + hl.u, v + hl.v0] as V2);
          panes.push();
          panes.applyMatrix(currentMatrix(b));
          panes.flat(pts, -depth * 0.55, 0xffffff);
          panes.pop();
          if (hl.win.kind !== 'slit' && hl.win.kind !== 'louvre' && hl.win.kind !== 'oculus') {
            b.box(hl.u - hl.w / 2 - 0.05, hl.v0 - 0.05, -depth * 0.55, hl.u + hl.w / 2 + 0.05, hl.v0, 0.06, shade(s.timber, 1.15));
            // the shutters folded back inside
            if (hl.win.kind === 'window' && hl.w < 1.4 && plan.kind !== 'church') {
              const sc = shade(s.timber, 0.95);
              b.box(hl.u - hl.w / 2 - 0.06, hl.v0, 0.0, hl.u - hl.w / 2 - 0.02, hl.v1 - 0.05, Math.min(0.5, hl.w / 2) + 0.0, sc);
              b.box(hl.u + hl.w / 2 + 0.02, hl.v0, 0.0, hl.u + hl.w / 2 + 0.06, hl.v1 - 0.05, Math.min(0.5, hl.w / 2) + 0.0, sc);
            }
          }
        }
        u = Math.max(u, a1);
      }
      if (u < L / 2) piece(u, L / 2, 0, topH);
      // a skirting of darker plaster and a timber wall plate along the top in houses
      if (!STONEY.has(bl.wall) && bl.wall !== 'planks' && bl.wall !== 'weatherboard') b.box(-L / 2, 0, 0, L / 2, 0.12, 0.012, shade(col, 0.78), 'b');
      if (k + 1 < bl.rects.length || h < 4) b.box(-L / 2, topH - 0.18, 0, L / 2, topH, 0.12, shade(s.timber, 0.95), 'b');
      b.pop();
    }
    // the roof's underside over the top storey: boards on rafters from the eaves to the ridge
    if (k === bl.rects.length - 1 && bl.ridge > bl.eave + 0.4 && y + h >= bl.eave - 0.2) roofUnder(b, IR, bl, s);
  });
}

/** The matrix of a builder's current frame (for drawing a pane in another builder at the same place). */
function currentMatrix(b: MeshBuilder): import('three').Matrix4 {
  return (b as unknown as { m: import('three').Matrix4 }).m.clone();
}

/** The wall over an arched head: the corners between the hole's rectangle and its arch, on the inner face and as a soffit. */
function archFill(b: MeshBuilder, hl: Hole, col: number, reveal: number, depth: number): void {
  const H = hl.v1 - hl.v0;
  const pts = archShape(hl.w, H, hl.shape, 6);
  // the curve from the right springer over the top to the left springer
  const curve = pts.filter((p) => p[1] > 0.01).sort((p, q) => q[0] - p[0]);
  if (curve.length < 2) return;
  const spring = Math.min(...curve.map((p) => p[1]));
  const hw = hl.w / 2;
  const right: V2[] = [[hw, spring], [hw, H], ...curve.filter((p) => p[0] >= 0).reverse().map((p) => [p[0], p[1]] as V2)].map(([x, v]) => [x + hl.u, v + hl.v0] as V2);
  const left: V2[] = [[-hw, H], [-hw, spring], ...curve.filter((p) => p[0] <= 0).sort((p, q) => q[0] - p[0]).map((p) => [p[0], p[1]] as V2)].map(([x, v]) => [x + hl.u, v + hl.v0] as V2);
  b.state({ layer: Layer.Wall, flags: F.NoAO }, () => {
    b.flat(dedupe(right), 0, col);
    b.flat(dedupe(left), 0, col);
    // the soffit of the arch: a strip of quads along the curve through the wall
    for (let i = 0; i + 1 < curve.length; i++) {
      const [x0, v0] = curve[i], [x1, v1] = curve[i + 1];
      b.quad([x1 + hl.u, v1 + hl.v0, 0], [x0 + hl.u, v0 + hl.v0, 0], [x0 + hl.u, v0 + hl.v0, -depth], [x1 + hl.u, v1 + hl.v0, -depth], reveal);
    }
  });
}

function dedupe(p: V2[]): V2[] {
  const out: V2[] = [];
  for (const q of p) if (!out.length || Math.hypot(out[out.length - 1][0] - q[0], out[out.length - 1][1] - q[1]) > 1e-4) out.push(q);
  if (out.length > 2 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 1e-4) out.pop();
  return out;
}

/** Rafters and boards under a pitched roof, from the inner faces at the eaves to the ridge. */
function roofUnder(b: MeshBuilder, r: { x0: number; x1: number; z0: number; z1: number }, bl: PBlock, s: CultureStyle): void {
  const boards = shade(s.timber, 1.25), rafter = shade(s.timber, 0.85);
  const e = bl.eave, top = bl.ridge - 0.35;
  b.state({ layer: Layer.Wall, flags: F.NoAO }, () => {
    if (bl.axis === 'x') {
      const cz = (r.z0 + r.z1) / 2;
      // two slopes facing down into the room
      b.quad([r.x0, e, r.z0], [r.x1, e, r.z0], [r.x1, top, cz], [r.x0, top, cz], boards);
      b.quad([r.x1, e, r.z1], [r.x0, e, r.z1], [r.x0, top, cz], [r.x1, top, cz], shade(boards, 0.94));
      // gable ends: the inner triangles
      b.tri([r.x0, e, r.z1], [r.x0, e, r.z0], [r.x0, top, cz], shade(boards, 0.9));
      b.tri([r.x1, e, r.z0], [r.x1, e, r.z1], [r.x1, top, cz], shade(boards, 0.9));
      const n = Math.max(2, Math.round((r.x1 - r.x0) / 0.9));
      for (let i = 1; i < n; i++) {
        const x = r.x0 + ((r.x1 - r.x0) * i) / n;
        b.beam([x, e - 0.05, r.z0 + 0.05], [x, top - 0.06, cz], 0.1, 0.12, rafter);
        b.beam([x, e - 0.05, r.z1 - 0.05], [x, top - 0.06, cz], 0.1, 0.12, rafter);
      }
      // tie beams across every few metres
      for (let x = r.x0 + 2.2; x < r.x1 - 1; x += 3.2) b.box(x - 0.11, e - 0.25, r.z0, x + 0.11, e - 0.02, r.z1, rafter);
    } else {
      const cx = (r.x0 + r.x1) / 2;
      b.quad([r.x1, e, r.z0], [r.x1, e, r.z1], [cx, top, r.z1], [cx, top, r.z0], boards);
      b.quad([r.x0, e, r.z1], [r.x0, e, r.z0], [cx, top, r.z0], [cx, top, r.z1], shade(boards, 0.94));
      b.tri([r.x0, e, r.z0], [r.x1, e, r.z0], [cx, top, r.z0], shade(boards, 0.9));
      b.tri([r.x1, e, r.z1], [r.x0, e, r.z1], [cx, top, r.z1], shade(boards, 0.9));
      const n = Math.max(2, Math.round((r.z1 - r.z0) / 0.9));
      for (let i = 1; i < n; i++) {
        const z = r.z0 + ((r.z1 - r.z0) * i) / n;
        b.beam([r.x0 + 0.05, e - 0.05, z], [cx, top - 0.06, z], 0.1, 0.12, rafter);
        b.beam([r.x1 - 0.05, e - 0.05, z], [cx, top - 0.06, z], 0.1, 0.12, rafter);
      }
      for (let z = r.z0 + 2.2; z < r.z1 - 1; z += 3.2) b.box(r.x0, e - 0.25, z - 0.11, r.x1, e - 0.02, z + 0.11, rafter);
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// floors, partitions, stairs

function drawFloors(b: MeshBuilder, plan: InteriorPlan, s: CultureStyle, base: number): void {
  for (const f of plan.floors) {
    const fk = floorKind(plan.kind, f.level, f.y, base);
    const upper = f.level > 0 && f.y > base + 1.2;
    const th = upper ? 0.2 : 0.1;
    const w = f.x1 - f.x0, d = f.z1 - f.z0;
    if (w < 0.02 || d < 0.02) continue;
    b.state({ layer: Layer.Ground, flags: F.NoAO }, () => {
      switch (fk) {
        case 'boards': {
          // boards along the long side, alternating tones
          const alongX = w >= d;
          const n = Math.max(1, Math.round((alongX ? d : w) / 0.28));
          for (let i = 0; i < n; i++) {
            const t = shade(0x8a6a48, 0.92 + ((i * 7) % 5) * 0.035);
            if (alongX) b.box(f.x0, f.y - 0.04, f.z0 + (d * i) / n, f.x1, f.y, f.z0 + (d * (i + 1)) / n, t, 'b');
            else b.box(f.x0 + (w * i) / n, f.y - 0.04, f.z0, f.x0 + (w * (i + 1)) / n, f.y, f.z1, t, 'b');
          }
          break;
        }
        case 'flags': {
          const n = Math.max(1, Math.round(w / 0.9)), m = Math.max(1, Math.round(d / 0.9));
          for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
            const t = shade(mixHex(s.stone, 0x9a948a, 0.5), 0.86 + (((i * 31 + j * 17) % 7) / 7) * 0.16);
            b.box(f.x0 + (w * i) / n + 0.01, f.y - 0.04, f.z0 + (d * j) / m + 0.01, f.x0 + (w * (i + 1)) / n - 0.01, f.y, f.z0 + (d * (j + 1)) / m - 0.01, t, 'b');
          }
          b.box(f.x0, f.y - 0.06, f.z0, f.x1, f.y - 0.035, f.z1, 0x4a4540, 'b');
          break;
        }
        case 'straw': b.box(f.x0, f.y - 0.05, f.z0, f.x1, f.y, f.z1, { top: 0xb79a5c, side: 0x8a7448 }, 'b'); break;
        default: {
          // beaten earth, strewn with rushes in patches
          b.box(f.x0, f.y - 0.05, f.z0, f.x1, f.y, f.z1, { top: 0x7e6648, side: 0x5a4834 }, 'b');
          if (w > 1.2 && d > 1.2) {
            const n = Math.min(10, Math.floor((w * d) / 2.5));
            for (let i = 0; i < n; i++) {
              const px = f.x0 + 0.3 + ((i * 0.618 + f.x0 * 0.13) % 1) * (w - 0.6), pz = f.z0 + 0.3 + ((i * 0.381 + f.z0 * 0.17) % 1) * (d - 0.6);
              const hw = 0.25 + ((i * 7) % 5) * 0.06;
              b.quad([px - hw, f.y + 0.004, pz + hw * 0.6], [px + hw, f.y + 0.004, pz + hw * 0.7], [px + hw * 0.8, f.y + 0.004, pz - hw * 0.6], [px - hw * 0.9, f.y + 0.004, pz - hw * 0.7], i % 2 ? 0xa48c58 : 0x9a8450);
            }
          }
        }
      }
      if (upper) {
        // the floor's thickness and the joists seen from below
        b.box(f.x0, f.y - th, f.z0, f.x1, f.y - 0.04, f.z1, { bottom: shade(s.timber, 1.2), side: shade(s.timber, 0.9), top: shade(s.timber, 0.9) }, '');
        const alongX = w < d;
        const n = Math.max(1, Math.floor((alongX ? w : d) / 0.6));
        for (let i = 0; i <= n; i++) {
          if (alongX) { const x = f.x0 + 0.05 + ((w - 0.1) * i) / Math.max(1, n); b.box(x - 0.07, f.y - th - 0.16, f.z0, x + 0.07, f.y - th, f.z1, shade(s.timber, 0.8), 'top'); }
          else { const z = f.z0 + 0.05 + ((d - 0.1) * i) / Math.max(1, n); b.box(f.x0, f.y - th - 0.16, z - 0.07, f.x1, f.y - th, z + 0.07, shade(s.timber, 0.8), 'top'); }
        }
      }
    });
  }
}

function drawPartition(b: MeshBuilder, p: { x0: number; x1: number; z0: number; z1: number; y0: number; y1: number }, s: CultureStyle): void {
  const plaster = shade(COL.limewash, 0.92), tim = s.timber;
  b.box(p.x0, p.y0, p.z0, p.x1, p.y1, p.z1, { side: plaster, top: tim }, 'b');
  // studs and a rail on both faces
  const alongX = p.x1 - p.x0 > p.z1 - p.z0;
  const L = alongX ? p.x1 - p.x0 : p.z1 - p.z0;
  const n = Math.max(1, Math.round(L / 0.9));
  for (let i = 0; i <= n; i++) {
    const a = (alongX ? p.x0 : p.z0) + (L * i) / n;
    if (alongX) b.box(a - 0.05, p.y0, p.z0 - 0.015, a + 0.05, p.y1, p.z1 + 0.015, tim, 'b');
    else b.box(p.x0 - 0.015, p.y0, a - 0.05, p.x1 + 0.015, p.y1, a + 0.05, tim, 'b');
  }
  if (p.y1 - p.y0 > 1.5) {
    const ym = p.y0 + Math.min(1.1, (p.y1 - p.y0) * 0.45);
    if (alongX) b.box(p.x0, ym - 0.05, p.z0 - 0.015, p.x1, ym + 0.05, p.z1 + 0.015, tim, 'b');
    else b.box(p.x0 - 0.015, ym - 0.05, p.z0, p.x1 + 0.015, ym + 0.05, p.z1, tim, 'b');
  }
}

function drawInnerDoorFrame(b: MeshBuilder, d: PDoor, s: CultureStyle): void {
  if (d.kind === 'arch' || d.t > 0.3) return;
  const tim = shade(s.timber, 0.9);
  const ax = Math.abs(d.nz) > 0.5;
  const hw = d.w / 2;
  const n0 = ax ? d.z - d.nz * (d.t + 0.02) : d.x - d.nx * (d.t + 0.02), n1 = ax ? d.z + 0.02 * d.nz : d.x + 0.02 * d.nx;
  const lo = Math.min(n0, n1), hi = Math.max(n0, n1);
  for (const sd of [-1, 1]) {
    const c = (ax ? d.x : d.z) + sd * (hw + 0.04);
    if (ax) b.box(c - 0.05, d.y, lo, c + 0.05, d.y + d.h + 0.08, hi, tim);
    else b.box(lo, d.y, c - 0.05, hi, d.y + d.h + 0.08, c + 0.05, tim);
  }
  if (ax) b.box(d.x - hw - 0.09, d.y + d.h, lo, d.x + hw + 0.09, d.y + d.h + 0.1, hi, tim);
  else b.box(lo, d.y + d.h, d.z - hw - 0.09, hi, d.y + d.h + 0.1, d.z + hw + 0.09, tim);
}

function drawStair(b: MeshBuilder, st: PStair, s: CultureStyle): void {
  const wood = shade(s.timber, 1.15), dark = shade(s.timber, 0.85);
  const rise = st.y1 - st.y0;
  const len = st.axis === 'x' ? st.x1 - st.x0 : st.z1 - st.z0;
  // in the stair's own frame: a along the run (0 at the foot), c across it
  const P = (a: number, y: number, c: number): [number, number, number] => {
    const al = st.dir > 0 ? a : len - a;
    return st.axis === 'x' ? [st.x0 + al, y, st.z0 + c] : [st.x0 + c, y, st.z0 + al];
  };
  const box = (a0: number, y0: number, c0: number, a1: number, y1: number, c1: number, col: number): void => {
    const p = P(a0, y0, c0), q = P(a1, y1, c1);
    b.box(Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.min(p[2], q[2]), Math.max(p[0], q[0]), Math.max(p[1], q[1]), Math.max(p[2], q[2]), col);
  };
  const w = st.w;
  b.state({ layer: Layer.Detail, flags: F.NoAO }, () => {
    if (st.kind === 'ladder') {
      for (const c of [0.06, w - 0.06]) b.beam(P(0, st.y0, c), P(len, st.y1 + 0.9, c), 0.07, 0.09, dark);
      const n = Math.max(3, Math.round(rise / 0.3));
      for (let i = 1; i <= n; i++) {
        const t = i / (n + 0.4);
        box(len * t - 0.03, st.y0 + rise * t - 0.03, 0.06, len * t + 0.03, st.y0 + rise * t + 0.03, w - 0.06, wood);
      }
      return;
    }
    const n = Math.max(3, Math.round(rise / 0.2));
    const tread = len / n;
    for (let i = 0; i < n; i++) {
      const y = st.y0 + (rise * (i + 1)) / n;
      // a solid flight: each step a block down to the floor, boarded on the open side
      box(tread * i, st.y0, 0.02, tread * (i + 1) + 0.02, y, w - 0.02, i % 2 ? wood : shade(wood, 0.95));
      box(tread * i - 0.02, y - 0.04, 0, tread * (i + 1) + 0.03, y + 0.02, w, shade(wood, 1.12));
    }
    // a handrail on posts along the open side
    for (const c of [w - 0.04]) {
      b.beam(P(0, st.y0 + 0.9, c), P(len, st.y1 + 0.9, c), 0.06, 0.06, dark);
      for (let a = 0; a <= len + 0.01; a += Math.max(0.6, len / 4)) box(a - 0.03, st.y0 + (rise * a) / len, c - 0.03, a + 0.03, st.y0 + (rise * a) / len + 0.9, c + 0.03, dark);
    }
  });
}

function drawRail(b: MeshBuilder, r: { x0: number; x1: number; z0: number; z1: number; y0: number; y1: number }, s: CultureStyle): void {
  const dark = shade(s.timber, 0.85);
  const alongX = r.x1 - r.x0 > r.z1 - r.z0;
  const L = alongX ? r.x1 - r.x0 : r.z1 - r.z0;
  b.state({ layer: Layer.Detail, flags: F.NoAO }, () => {
    if (alongX) b.box(r.x0, r.y0 + 0.86, r.z0 - 0.02, r.x1, r.y0 + 0.95, r.z1 + 0.02, dark);
    else b.box(r.x0 - 0.02, r.y0 + 0.86, r.z0, r.x1 + 0.02, r.y0 + 0.95, r.z1, dark);
    const n = Math.max(1, Math.round(L / 0.35));
    for (let i = 0; i <= n; i++) {
      const a = (alongX ? r.x0 : r.z0) + (L * i) / n;
      if (alongX) b.box(a - 0.025, r.y0, r.z0, a + 0.025, r.y0 + 0.86, r.z1, dark);
      else b.box(r.x0, r.y0, a - 0.025, r.x1, r.y0 + 0.86, a + 0.025, dark);
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// furniture

const LINEN = 0xe2dccb, WOOL = 0x8a3b2e, WOOL2 = 0x3e5a7a, STRAW = 0xc8ab6a, IRON = 0x34302c, CLOTH_GOLD = 0xb8902e;

function candle(b: MeshBuilder, glow: MeshBuilder, x: number, y: number, z: number): void {
  b.cyl(x, z, y - 0.18, y, 0.025, 0.025, 5, 0xeee6cc);
  glow.blob(x, y + 0.04, z, 0.02, 0.045, 0.02, 0xffb347, 0.1, 0, 1);
}

function drawFurn(b: MeshBuilder, glow: MeshBuilder, f: PFurn, s: CultureStyle, kind: string): void {
  const wood = mixHex(s.timber, 0x8a6a46, 0.45 + f.v * 0.2), dark = shade(wood, 0.78), light = shade(wood, 1.18);
  b.push();
  b.translate(f.x, f.y, f.z);
  b.rotY(f.yaw);
  const hw = f.w / 2, hd = f.d / 2, h = f.h;
  const legs = (x: number, z: number, hh: number, t = 0.06, col = dark): void => {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box(sx * x - t / 2, 0, sz * z - t / 2, sx * x + t / 2, hh, sz * z + t / 2, col, 'b');
  };
  b.state({ layer: Layer.Detail, flags: F.NoAO }, () => {
    switch (f.kind) {
      case 'bed': case 'cot': case 'bunk': {
        const frameH = f.kind === 'bunk' ? 0.35 : 0.32;
        const tiers = f.kind === 'bunk' ? [0, 1.0] : [0];
        for (const ty of tiers) {
          b.box(-hw, ty + 0.12, -hd, hw, ty + frameH, hd, wood);
          b.box(-hw + 0.06, ty + frameH, -hd + 0.06, hw - 0.06, ty + frameH + 0.14, hd - 0.06, LINEN);
          b.box(-hw + 0.04, ty + frameH + 0.1, -hd + 0.5, hw - 0.04, ty + frameH + 0.2, hd - 0.04, f.v < 0.5 ? WOOL : WOOL2);
          b.blob(0, ty + frameH + 0.2, -hd + 0.25, hw * 0.65, 0.07, 0.15, 0xf0ead8, 0.1, 0, 2);
        }
        legs(hw - 0.05, hd - 0.05, f.kind === 'bunk' ? 1.5 : 0.12, 0.08, dark);
        if (f.kind === 'bed' && f.w > 1.3) {
          // a great bed: tall posts and a tester
          for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box(sx * (hw - 0.05) - 0.05, 0, sz * (hd - 0.05) - 0.05, sx * (hw - 0.05) + 0.05, 2.1, sz * (hd - 0.05) + 0.05, dark, 'b');
          b.box(-hw, 2.0, -hd, hw, 2.12, hd, CLOTH_GOLD);
          b.box(-hw, 0.4, -hd, hw, 1.25, -hd + 0.06, dark);
        } else b.box(-hw, 0, -hd, hw, 0.75, -hd + 0.07, dark);
        break;
      }
      case 'pallet': b.box(-hw, 0, -hd, hw, 0.12, hd, STRAW); b.box(-hw + 0.05, 0.12, -hd + 0.4, hw - 0.05, 0.18, hd - 0.05, 0x7a6a50); break;
      case 'cradle': b.box(-hw, 0.1, -hd, hw, 0.42, hd, wood); b.box(-hw + 0.05, 0.42, -hd + 0.05, hw - 0.05, 0.45, hd - 0.05, LINEN); b.box(-hw, 0, -0.04, hw, 0.12, 0.04, dark); break;
      case 'table': case 'trestle': case 'high_table': case 'desk': case 'counter': case 'kneading': {
        const top = f.kind === 'kneading' ? 0.82 : f.kind === 'counter' ? 0.95 : f.kind === 'desk' ? 0.82 : 0.74;
        b.box(-hw, top - 0.06, -hd, hw, top, hd, light);
        if (f.kind === 'trestle') for (const sx of [-1, 1]) { b.box(sx * (hw - 0.3) - 0.04, 0, -hd + 0.05, sx * (hw - 0.3) + 0.04, top - 0.06, hd - 0.05, dark); }
        else if (f.kind === 'counter' || f.kind === 'kneading') b.box(-hw + 0.02, 0, -hd + 0.02, hw - 0.02, top - 0.06, hd - 0.02, wood);
        else legs(hw - 0.07, hd - 0.07, top - 0.06, 0.07);
        if (f.kind === 'high_table') { b.box(-hw, top - 0.02, -hd - 0.01, hw, top + 0.005, hd + 0.01, LINEN); b.box(-hw - 0.01, top - 0.4, hd - 0.02, hw + 0.01, top, hd + 0.01, LINEN); }
        if (f.kind === 'desk') { b.box(-hw + 0.1, top, -hd + 0.05, hw - 0.1, top + 0.12, -hd + 0.25, wood); b.box(-0.2, top, -0.1, 0.15, top + 0.04, 0.15, 0xe8dcc0); }
        if (f.kind === 'counter') for (let i = 0; i < 4; i++) b.blob(-hw + 0.3 + i * (f.w - 0.6) / 3, top + 0.08, 0, 0.12, 0.08, 0.12, [0xb8342a, 0xd9902a, 0x7a9a3a, 0xc9b27a][(i + Math.floor(f.v * 4)) % 4], 0.2, 0, i);
        if (f.kind === 'table' || f.kind === 'trestle') {
          // a jug, a bowl, a loaf
          b.cyl(-hw * 0.4, 0, top, top + 0.22, 0.07, 0.05, 6, 0x8a5a3a);
          b.cyl(hw * 0.3, 0.05, top, top + 0.06, 0.12, 0.09, 7, 0x9a7a52);
          b.blob(hw * 0.05, top + 0.05, -0.1, 0.11, 0.06, 0.07, 0xb07a3a, 0.15, 0, 3);
        }
        break;
      }
      case 'bench': b.box(-hw, h - 0.05, -hd, hw, h, hd, light); for (const sx of [-1, 1]) b.box(sx * (hw - 0.12) - 0.03, 0, -hd + 0.03, sx * (hw - 0.12) + 0.03, h - 0.05, hd - 0.03, dark, 'b'); break;
      case 'stool': b.cyl(0, 0, h - 0.05, h, hw, hw, 7, light); for (let i = 0; i < 3; i++) { const a = (i / 3) * Math.PI * 2; b.beam([Math.cos(a) * hw * 0.6, h - 0.05, Math.sin(a) * hw * 0.6], [Math.cos(a) * hw * 0.85, 0, Math.sin(a) * hw * 0.85], 0.04, 0.04, dark); } break;
      case 'chair': case 'throne': {
        const seat = f.kind === 'throne' ? 0.55 : 0.46;
        b.box(-hw, seat - 0.06, -hd, hw, seat, hd, light);
        legs(hw - 0.04, hd - 0.04, seat - 0.06, 0.06);
        b.box(-hw, seat, -hd, hw, h, -hd + 0.08, dark);
        if (f.kind === 'throne') { b.box(-hw, seat, -hd, -hw + 0.08, seat + 0.35, hd, dark); b.box(hw - 0.08, seat, -hd, hw, seat + 0.35, hd, dark); b.box(-hw + 0.08, seat, -hd + 0.08, hw - 0.08, seat + 0.03, hd - 0.05, 0x8a2a2a); b.box(-hw + 0.1, seat + 0.1, -hd + 0.081, hw - 0.1, h - 0.15, -hd + 0.09, 0x8a2a2a); }
        break;
      }
      case 'chest': b.box(-hw, 0, -hd, hw, h - 0.06, hd, wood); b.box(-hw - 0.01, h - 0.08, -hd - 0.01, hw + 0.01, h, hd + 0.01, dark); for (const sx of [-0.6, 0.6]) b.box(sx * hw - 0.03, 0, hd, sx * hw + 0.03, h, hd + 0.012, IRON); break;
      case 'dresser': case 'shelf': case 'bookcase': case 'rack': case 'weapon_rack': case 'cask_rack': {
        if (f.kind === 'cask_rack') {
          b.box(-hw, 0, -hd, hw, 0.35, hd, dark);
          for (let i = 0; i < 3; i++) b.tube([-hw + 0.3 + i * (f.w - 0.6) / 2, 0.62, -hd + 0.05], [-hw + 0.3 + i * (f.w - 0.6) / 2, 0.62, hd - 0.05], 0.27, 0.27, 8, shade(0x7a5a38, 0.9 + i * 0.05));
          break;
        }
        b.box(-hw, 0, -hd, -hw + 0.05, h, hd, dark); b.box(hw - 0.05, 0, -hd, hw, h, hd, dark); b.box(-hw, 0, -hd, hw, h, -hd + 0.03, wood);
        const shelves = f.kind === 'weapon_rack' || f.kind === 'rack' ? 2 : Math.max(2, Math.round(h / 0.42));
        for (let i = 0; i <= shelves; i++) b.box(-hw, (h * i) / shelves - 0.03, -hd, hw, (h * i) / shelves + 0.01, hd, wood);
        for (let i = 0; i < shelves; i++) {
          const y = (h * i) / shelves + 0.01;
          if (f.kind === 'bookcase') for (let k = 0; k < Math.floor(f.w / 0.07) - 1; k++) b.box(-hw + 0.06 + k * 0.07, y, -hd + 0.05, -hw + 0.12 + k * 0.07, y + 0.22 + ((k * 7) % 3) * 0.03, hd - 0.05, [0x7a2a22, 0x2a4a6a, 0x4a3a22, 0x6a5a2a, 0x3a5a3a][(k + i) % 5]);
          else if (f.kind === 'dresser' || f.kind === 'shelf') for (let k = 0; k < 3; k++) b.cyl(-hw + 0.25 + k * (f.w - 0.5) / 2, 0, y, y + 0.16, 0.08, 0.06, 6, [0x9a7a52, 0xc9b28a, 0x7a5a3a][(k + i) % 3]);
          else if (f.kind === 'weapon_rack') for (let k = 0; k < 4; k++) b.beam([-hw + 0.2 + k * (f.w - 0.4) / 3, 0.05, 0], [-hw + 0.2 + k * (f.w - 0.4) / 3, h + 0.4, 0], 0.03, 0.03, k % 2 ? 0x8a8a8a : dark);
          else for (let k = 0; k < 3; k++) b.box(-hw + 0.2 + k * (f.w - 0.4) / 2 - 0.02, y + 0.1, -0.02, -hw + 0.2 + k * (f.w - 0.4) / 2 + 0.02, y + 0.45, 0.02, IRON);
        }
        break;
      }
      case 'hearth': {
        // a ring of stones on the floor round the embers
        for (let i = 0; i < 9; i++) { const a = (i / 9) * Math.PI * 2; b.blob(Math.cos(a) * hw * 0.8, 0.08, Math.sin(a) * hd * 0.8, 0.13, 0.09, 0.11, shade(0x7a746a, 0.85 + (i % 3) * 0.08), 0.2, 0, i); }
        b.box(-hw * 0.65, 0, -hd * 0.65, hw * 0.65, 0.04, hd * 0.65, 0x2a2420);
        for (let i = 0; i < 3; i++) b.beam([-0.3 + i * 0.25, 0.08, -0.25], [-0.2 + i * 0.15, 0.12, 0.3], 0.07, 0.07, 0x3a2a1c);
        glow.blob(0, 0.1, 0, hw * 0.45, 0.08, hd * 0.45, 0xff8a2a, 0.25, 1, 7);
        glow.blob(0.05, 0.25, 0.02, 0.12, 0.2, 0.1, 0xffc85a, 0.2, 0, 8);
        // a pot on a tripod
        for (let i = 0; i < 3; i++) { const a = (i / 3) * Math.PI * 2 + 0.3; b.beam([Math.cos(a) * 0.45, 0, Math.sin(a) * 0.45], [0, 0.95, 0], 0.03, 0.03, IRON); }
        b.cyl(0, 0, 0.45, 0.7, 0.16, 0.2, 7, IRON);
        break;
      }
      case 'fireplace': case 'forge': case 'oven': case 'copper': {
        const stone = shade(s.stone, 0.9);
        if (f.kind === 'oven') {
          b.box(-hw, 0, -hd, hw, 0.7, hd, stone);
          b.blob(0, 0.7, -0.05, hw * 0.92, h - 0.6, hd * 0.9, shade(0xa07858, 0.95), 0.15, 1, 4);
          b.box(-0.25, 0.75, hd * 0.85, 0.25, 1.05, hd * 0.95, 0x1a1410);
          glow.box(-0.2, 0.76, hd * 0.84, 0.2, 0.98, hd * 0.86, 0xff9a3a);
          break;
        }
        if (f.kind === 'copper') {
          b.box(-hw, 0, -hd, hw, 0.55, hd, stone);
          b.cyl(0, 0, 0.55, 1.05, hw * 0.75, hw * 0.8, 10, 0xb06a3a);
          glow.box(-0.25, 0.12, hd - 0.02, 0.25, 0.38, hd + 0.005, 0xff8a2a);
          break;
        }
        // the hearth on its stone base, the hood above (a forge has its bellows beside: placed apart)
        b.box(-hw, 0, -hd, hw, f.kind === 'forge' ? 0.75 : 0.18, hd, stone);
        if (f.kind === 'forge') { b.box(-hw + 0.15, 0.75, -hd + 0.15, hw - 0.15, 0.8, hd - 0.15, 0x2a2420); glow.blob(0, 0.82, 0, hw * 0.5, 0.06, hd * 0.45, 0xff6a1a, 0.25, 1, 5); }
        else {
          b.box(-hw, 0.18, -hd, -hw + 0.18, 1.2, hd - 0.1, stone);
          b.box(hw - 0.18, 0.18, -hd, hw, 1.2, hd - 0.1, stone);
          b.box(-hw, 0.18, -hd, hw, 1.2, -hd + 0.12, shade(stone, 0.6));
          for (let i = 0; i < 3; i++) b.beam([-0.3 + i * 0.25, 0.22, -0.1], [-0.2 + i * 0.15, 0.26, 0.25], 0.08, 0.08, 0x3a2a1c);
          glow.blob(0, 0.24, 0.05, hw * 0.35, 0.07, hd * 0.3, 0xff8a2a, 0.25, 1, 6);
          glow.blob(0.02, 0.4, 0.05, 0.14, 0.22, 0.1, 0xffc85a, 0.2, 0, 9);
        }
        // the hood: a lintel and the flue narrowing to the wall
        b.box(-hw - 0.05, 1.2, -hd, hw + 0.05, 1.45, hd + 0.04, f.kind === 'forge' ? shade(0x8a6a50, 0.9) : shade(s.timber, 1.0));
        b.taperBox(-hw, 1.45, -hd, hw, Math.max(2.2, h + 0.6), hd, hw * 0.35, hd * 0.35, stone);
        break;
      }
      case 'anvil': b.box(-0.18, 0, -0.18, 0.18, 0.55, 0.18, 0x5a4634); b.box(-0.12, 0.55, -hd, 0.12, 0.75, hd * 0.7, IRON); b.taperBox(-0.08, 0.6, hd * 0.7, 0.08, 0.72, hd, 0.06, 0.0, IRON); break;
      case 'bellows': b.box(-hw, 0.4, -hd, hw, 0.62, hd, 0x5a3a24); b.box(-hw, 0, -0.05, hw, 0.4, 0.05, dark); b.beam([0, 0.62, hd], [0, 1.3, hd + 0.3], 0.05, 0.05, dark); break;
      case 'trough': case 'manger': case 'vat': case 'tub': case 'tun': {
        const r0 = Math.min(hw, hd);
        if (f.kind === 'vat' || f.kind === 'tun' || f.kind === 'tub') {
          b.cyl(0, 0, 0, h, r0, r0 * 0.94, 10, wood, { top: false });
          b.cyl(0, 0, h - 0.12, h - 0.04, r0 * 0.9, r0 * 0.9, 10, f.kind === 'vat' ? 0x5a4a2a : 0x6a5a3a, { bottom: false });
          for (const yy of [0.2, h - 0.25]) b.cyl(0, 0, yy, yy + 0.04, r0 + 0.01, r0 + 0.01, 10, IRON, { top: false, bottom: false });
        } else {
          b.box(-hw, 0, -hd, hw, h, hd, wood, '');
          b.box(-hw + 0.06, h - 0.1, -hd + 0.06, hw - 0.06, h - 0.02, hd - 0.06, f.kind === 'manger' ? STRAW : 0x4a5a5a);
        }
        break;
      }
      case 'barrel': case 'barrels': {
        const n = f.kind === 'barrels' ? 3 : 1;
        for (let i = 0; i < n; i++) {
          const x = n === 1 ? 0 : -hw + 0.28 + i * (f.w - 0.56) / 2, r0 = 0.25;
          b.push(); b.translate(x, 0, 0);
          b.lathe([[r0 * 0.88, 0], [r0, h * 0.5], [r0 * 0.88, h]], 9, [shade(0x7a5a38, 0.9 + i * 0.05)], { capTop: true });
          b.cyl(0, 0, h * 0.22, h * 0.27, r0 * 0.97, r0 * 0.97, 9, IRON, { top: false, bottom: false });
          b.cyl(0, 0, h * 0.73, h * 0.78, r0 * 0.97, r0 * 0.97, 9, IRON, { top: false, bottom: false });
          b.pop();
        }
        break;
      }
      case 'sacks': case 'grain_bin': case 'crates': {
        if (f.kind === 'grain_bin') { b.box(-hw, 0, -hd, hw, h, hd, wood); b.box(-hw + 0.05, h - 0.05, -hd + 0.05, hw - 0.05, h - 0.02, hd - 0.05, 0xd8b868); break; }
        if (f.kind === 'crates') { b.box(-hw, 0, -hd, 0.05, h * 0.55, hd, light); b.box(-0.05, 0, -hd + 0.05, hw, h * 0.5, hd - 0.05, wood); b.box(-hw + 0.1, h * 0.55, -hd + 0.1, 0.1, h, hd - 0.1, shade(light, 0.95)); break; }
        for (let i = 0; i < 3; i++) b.blob(-hw * 0.5 + i * hw * 0.5, 0.22 + (i === 1 ? 0.2 : 0), (i - 1) * 0.1, hw * 0.42, 0.24, hd * 0.75, shade(0xc9b285, 0.9 + i * 0.05), 0.18, 1, i);
        break;
      }
      case 'hay': case 'sheaves': {
        if (f.kind === 'sheaves') { for (let i = 0; i < 6; i++) b.cyl(-hw + 0.25 + (i % 3) * (f.w - 0.5) / 2, -hd * 0.4 + Math.floor(i / 3) * hd * 0.8, 0, h * (0.8 + (i % 2) * 0.15), 0.18, 0.24, 6, shade(0xd4b45a, 0.9 + (i % 3) * 0.05)); break; }
        b.blob(0, h * 0.45, 0, hw, h * 0.55, hd, (nx: number, ny: number) => shade(0xc8a85a, 0.85 + ny * 0.12 + nx * 0.03), 0.25, 1, 3);
        break;
      }
      case 'stall': {
        // partitions between stalls: a boarded screen each side
        for (const sx of [-1, 1]) b.box(sx * hw - 0.04, 0, -hd, sx * hw + 0.04, h, hd, wood);
        b.box(-hw, 0, -hd, hw, 0.05, hd, STRAW);
        break;
      }
      case 'millstones': {
        b.box(-hw, 0, -hd, hw, 0.7, hd, wood);
        b.cyl(0, 0, 0.7, 1.0, hw * 0.8, hw * 0.8, 14, 0xa8a49a);
        b.cyl(0, 0, 1.0, 1.25, hw * 0.78, hw * 0.78, 14, shade(0x9a968c, 0.95));
        b.box(-hw * 0.7, 1.25, -hd * 0.7, hw * 0.7, 1.3, hd * 0.7, wood);
        break;
      }
      case 'hopper': b.taperBox(-hw * 0.6, h - 0.6, -hd * 0.6, hw * 0.6, h, hd * 0.6, -0.2, -0.2, wood); for (const sx of [-1, 1]) b.box(sx * hw * 0.55 - 0.04, 1.25, -0.04, sx * hw * 0.55 + 0.04, h, 0.04, dark); break;
      case 'gearwheel': b.tube([0, h * 0.5, -hd], [0, h * 0.5, hd], h * 0.45, h * 0.45, 12, dark); b.tube([0, h * 0.5, -hd - 0.2], [0, h * 0.5, hd + 0.2], 0.12, 0.12, 8, wood); break;
      case 'stocks_fuller': b.box(-hw, 0, -hd, hw, 0.6, hd, wood); for (const sx of [-0.5, 0.5]) { b.beam([sx * hw, 0.6, hd * 0.6], [sx * hw, 1.5, -hd * 0.7], 0.25, 0.25, dark); } b.box(-hw, 1.4, -hd, hw, 1.6, -hd + 0.2, dark); break;
      case 'loom': {
        for (const sx of [-1, 1]) { b.box(sx * hw - 0.05, 0, -hd, sx * hw + 0.05, h, -hd + 0.1, dark); b.box(sx * hw - 0.05, 0, hd - 0.1, sx * hw + 0.05, 0.9, hd, dark); b.box(sx * hw - 0.05, 0.8, -hd, sx * hw + 0.05, 0.9, hd, dark); }
        b.box(-hw, h - 0.1, -hd, hw, h, -hd + 0.1, wood);
        b.box(-hw + 0.1, 0.9, -hd + 0.05, hw - 0.1, h - 0.15, -hd + 0.07, f.v < 0.5 ? 0x9a3a2a : 0x4a6a8a);
        b.box(-hw + 0.1, 0.78, -hd + 0.1, hw - 0.1, 0.82, hd - 0.2, 0xd8ccb0);
        break;
      }
      case 'spinning_wheel': b.tube([0, 0.62, -0.02], [0, 0.62, 0.02], 0.32, 0.32, 12, wood); b.box(-0.08, 0, -hd, 0.08, 0.35, hd, dark); b.box(-0.04, 0.35, -hd + 0.1, 0.04, 0.62, -hd + 0.18, dark); break;
      case 'workbench': b.box(-hw, h - 0.1, -hd, hw, h, hd, light); legs(hw - 0.1, hd - 0.1, h - 0.1, 0.1); b.box(-hw + 0.1, 0.2, -hd + 0.1, hw - 0.1, 0.26, hd - 0.1, wood); for (let i = 0; i < 3; i++) b.box(-hw + 0.3 + i * 0.5, h, -0.1, -hw + 0.4 + i * 0.5, h + 0.05, 0.25, i % 2 ? IRON : dark); break;
      case 'sawhorse': for (const sx of [-1, 1]) { b.beam([sx * hw * 0.8, 0, -hd], [sx * hw * 0.8, h, 0], 0.06, 0.06, dark); b.beam([sx * hw * 0.8, 0, hd], [sx * hw * 0.8, h, 0], 0.06, 0.06, dark); } b.box(-hw, h - 0.06, -0.05, hw, h + 0.04, 0.05, wood); b.box(-hw * 0.6, h + 0.04, -0.1, hw * 0.9, h + 0.12, 0.1, light); break;
      case 'planks': for (let i = 0; i < 5; i++) b.box(-hw + 0.02, i * (h / 5), -hd, hw - 0.02, (i + 1) * (h / 5) - 0.01, hd, shade(light, 0.9 + (i % 2) * 0.1)); break;
      case 'hides': b.box(-hw, h - 0.06, -0.03, hw, h, 0.03, dark); for (let i = 0; i < 3; i++) b.box(-hw + 0.1 + i * (f.w - 0.2) / 3, 0.5, -0.01, -hw + 0.1 + (i + 0.9) * (f.w - 0.2) / 3, h - 0.06, 0.01, shade(0x9a7a5a, 0.9 + i * 0.06)); for (const sx of [-1, 1]) b.box(sx * hw - 0.04, 0, -0.05, sx * hw + 0.04, h, 0.05, dark, 'b'); break;
      case 'altar': {
        b.box(-hw, 0, -hd, hw, h, hd, mixHex(s.stone, 0xe0d8c8, 0.4));
        b.box(-hw - 0.02, h - 0.02, -hd - 0.02, hw + 0.02, h + 0.02, hd + 0.02, LINEN);
        b.box(hw - 0.01, 0.15, -hd * 0.8, hw + 0.012, h - 0.05, hd * 0.8, kind === 'chapel' ? 0x2a5a3a : 0x8a2a2a);
        // the cross and the candlesticks
        b.box(-0.05, h, -0.03, 0.05, h + 0.6, 0.03, CLOTH_GOLD);
        b.box(-0.05, h + 0.36, -0.2, 0.05, h + 0.44, 0.2, CLOTH_GOLD);
        for (const sz of [-1, 1]) { b.cyl(0, sz * hd * 0.7, h, h + 0.3, 0.03, 0.04, 6, CLOTH_GOLD); glow.blob(0, h + 0.36, sz * hd * 0.7, 0.02, 0.045, 0.02, 0xffb347, 0.1, 0, sz + 2); }
        break;
      }
      case 'pew': b.box(-hw, 0.42, -hd, hw, 0.46, hd * 0.2, light); b.box(-hw, 0.46, -hd, hw, h, -hd + 0.05, wood); for (const sx of [-1, 1]) b.box(sx * hw - 0.04, 0, -hd, sx * hw + 0.04, h + 0.05, hd, dark, 'b'); break;
      case 'choir': b.box(-hw, 0, -hd, hw, 0.45, hd, wood); b.box(-hw, 0.45, -hd, hw, h, -hd + 0.08, dark); b.box(-hw, h - 0.06, -hd, hw, h, -hd + 0.3, dark); break;
      case 'font': b.cyl(0, 0, 0, 0.55, 0.18, 0.18, 8, s.stone); b.cyl(0, 0, 0.55, h, 0.4, 0.38, 8, mixHex(s.stone, 0xe0d8c8, 0.3)); b.cyl(0, 0, h - 0.02, h + 0.01, 0.3, 0.3, 8, 0x5a7a8a, { bottom: false }); break;
      case 'pulpit': b.cyl(0, 0, 0, 0.35, 0.12, 0.12, 6, dark); b.cyl(0, 0, 0.35, h, hw * 0.8, hw * 0.75, 8, wood); b.box(-0.2, h, -0.1, 0.2, h + 0.06, 0.15, light); break;
      case 'lectern': b.cyl(0, 0, 0, 1.0, 0.06, 0.06, 6, dark); b.beam([0, 1.0, -0.15], [0, 1.2, 0.15], 0.45, 0.05, wood); b.box(-0.18, 1.12, -0.05, 0.18, 1.16, 0.12, 0xe8dcc0); break;
      case 'tomb': b.box(-hw, 0, -hd, hw, h, hd, mixHex(s.stone, 0xe0d8c8, 0.3)); b.blob(0, h + 0.1, 0, hw * 0.7, 0.12, hd * 0.4, shade(s.stone, 1.1), 0.1, 0, 4); break;
      case 'dais': b.box(-hw, 0, -hd, hw, h, hd, { top: shade(s.timber, 1.2), side: shade(s.timber, 0.9) }, 'b'); break;
      case 'tapestry': b.box(-hw, 0.5, -hd, hw, h + 0.4, hd, f.v < 0.33 ? 0x7a2a2a : f.v < 0.66 ? 0x2a4a6a : 0x3a5a2a); b.box(-hw, h + 0.25, -hd - 0.01, hw, h + 0.32, hd + 0.01, CLOTH_GOLD); b.box(-hw * 0.4, 0.9, hd, hw * 0.4, h - 0.1, hd + 0.005, CLOTH_GOLD); break;
      case 'chandelier': {
        const y = 2.7;
        b.cyl(0, 0, y - 0.05, y + 0.05, 0.5, 0.5, 10, IRON, { top: false });
        b.beam([0, y, 0], [0, y + 2.5, 0], 0.03, 0.03, IRON);
        for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; candle(b, glow, Math.cos(a) * 0.48, y + 0.25, Math.sin(a) * 0.48); }
        break;
      }
      case 'cell_bars': for (let i = 0; i <= Math.floor(f.w / 0.15); i++) b.box(-hw + i * 0.15 - 0.015, 0, -0.015, -hw + i * 0.15 + 0.015, h, 0.015, IRON); b.box(-hw, h - 0.08, -0.04, hw, h, 0.04, IRON); b.box(-hw, 1.0, -0.03, hw, 1.06, 0.03, IRON); break;
      case 'block': b.cyl(0, 0, 0, h, hw, hw * 0.95, 9, 0x6a4a34); b.box(-0.2, h, -0.02, 0.15, h + 0.12, 0.02, IRON); break;
      case 'pillar': b.cyl(0, 0, 0, 3.5, hw, hw, 10, mixHex(s.stone, 0xd0c8b8, 0.3)); b.box(-hw - 0.05, 0, -hd - 0.05, hw + 0.05, 0.25, hd + 0.05, s.stone); break;
      case 'bell': b.box(-hw, h + 0.5, -0.06, hw, h + 0.62, 0.06, dark); b.lathe([[0.42, 0], [0.38, 0.15], [0.26, 0.55], [0.2, 0.75], [0, 0.78]], 12, [0x9a7a3a, 0xa88a42]); break;
      case 'well_head': b.cyl(0, 0, 0, h, hw, hw, 12, s.stone, { top: false }); b.cyl(0, 0, h - 0.05, h, hw * 0.75, hw * 0.75, 12, 0x1a2228, { bottom: false }); break;
      case 'pot': b.cyl(0, 0, 0, h, hw, hw * 0.8, 7, 0x6a4a3a); break;
      case 'rail': break;
      default: b.box(-hw, 0, -hd, hw, h, hd, wood);
    }
  });
  b.pop();
}

/** Kinds whose models have a plan (for galleries and tools). */
export function interiorKinds(): BuildingKind[] {
  return (Object.keys(BUILDINGS) as BuildingKind[]);
}
