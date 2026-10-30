// Churches: chapel, parish church, abbey church, cloister, cathedral, infirmary.
// Orientation: the altar (east end) is local +x, the west front / tower is local -x and the
// main (south) door is on local +z, matching the contract's door side.
import type { BuildingDef } from '../../../content/types';
import { F, Layer, shade, type V3 } from '../../core/builder';
import { chimney, crenelLine, enterSide, flagPole, house, opening, roundTower, windowRow, type Ctx, type Opening, type Rect, type Side } from '../parts';
import { buildCone, buildRoof, roofLook, type RoofMat } from '../roof';
import { COL, roofTint, type CultureStyle, type WallKind } from '../style';

function churchWall(s: CultureStyle): WallKind {
  return s.id === 'norse' ? 'planks' : s.id === 'cymric' ? 'rubble' : s.id === 'gael' ? 'rubble' : 'stone';
}

function churchRoof(s: CultureStyle, q: number): RoofMat {
  if (s.id === 'anglo' && q === 1) return 'thatch';
  if (s.id === 'gael' && q === 1) return 'heather';
  return s.churchRoof;
}

function lancets(side: Side, L: number, n: number, y: number, h: number, w: number, avoid: number[] = []): Opening[] {
  return windowRow(side, L, n, { w, h, y, kind: 'lancet', frame: 'stone', shape: 'pointed', shutters: false, mullions: w > 0.9 ? 1 : 0 }, avoid);
}

/** Buttresses along a wall line (x0..x1 at z, projecting towards dir). */
function buttresses(ctx: Ctx, x0: number, x1: number, z: number, dir: 1 | -1, n: number, H: number, col: number, skip: (x: number) => boolean = () => false, depth = 0.7): void {
  const { b } = ctx;
  b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
    for (let i = 0; i <= n; i++) {
      const x = x0 + ((x1 - x0) * i) / n;
      if (skip(x)) continue;
      const za = dir > 0 ? z : z - depth, zb = dir > 0 ? z + depth : z;
      b.taperBox(x - 0.3, -0.3, za, x + 0.3, H * 0.5, zb, 0.02, 0.1, col);
      const za2 = dir > 0 ? z : z - depth * 0.65, zb2 = dir > 0 ? z + depth * 0.65 : z;
      b.taperBox(x - 0.26, H * 0.5, za2, x + 0.26, H * 0.82, zb2, 0.02, depth * 0.3, { side: col, top: shade(col, 1.08) }, 'b');
    }
  });
}

/** Corner buttresses on a rectangle. */
function cornerButtresses(ctx: Ctx, rc: Rect, H: number, col: number): void {
  const { b } = ctx;
  b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
    for (const [x, z, sx, sz] of [[rc.x0, rc.z0, -1, -1], [rc.x1, rc.z0, 1, -1], [rc.x1, rc.z1, 1, 1], [rc.x0, rc.z1, -1, 1]] as [number, number, number, number][]) {
      b.taperBox(Math.min(x, x + sx * 0.6), -0.3, z - 0.28, Math.max(x, x + sx * 0.6), H * 0.7, z + 0.28, 0.12, 0.02, col);
      b.taperBox(x - 0.28, -0.3, Math.min(z, z + sz * 0.6), x + 0.28, H * 0.7, Math.max(z, z + sz * 0.6), 0.02, 0.12, col);
    }
  });
}

function pinnacle(ctx: Ctx, x: number, z: number, y: number, h: number, w: number, col: number): void {
  const { b } = ctx;
  b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
    b.box(x - w / 2, y, z - w / 2, x + w / 2, y + h * 0.4, z + w / 2, col);
    b.cyl(x, z, y + h * 0.4, y + h, w * 0.72, 0, 4, shade(col, 1.04), { rot: Math.PI / 4 });
  });
}

export interface TowerOpts {
  crenel?: boolean;
  pinnacles?: boolean;
  spire?: 'none' | 'stone' | 'helm' | 'timber' | 'pyramid';
  wall?: WallKind;
  belfry?: boolean;
  door?: boolean;
  flag?: boolean;
}

/** Square church/castle tower centred at (x, z). Returns the top Y (parapet or spire). */
export function squareTower(ctx: Ctx, x: number, z: number, size: number, H: number, o: TowerOpts = {}): number {
  const { b, s, lod } = ctx;
  const wall = o.wall ?? churchWall(s);
  const col = wall === 'planks' ? COL.plankTar : wall === 'rubble' ? (s.id === 'gael' ? COL.stoneGrey : COL.rubble) : s.stone;
  const hs = size / 2;
  const rc: Rect = { x0: x - hs, x1: x + hs, z0: z - hs, z1: z + hs };
  const fk = wall === 'planks' ? 'timber' : 'stone';
  const belfry: Opening[] = [];
  if (o.belfry ?? true) for (const side of ['pz', 'nz', 'px', 'nx'] as Side[]) belfry.push({ side, u: 0, w: Math.min(1.2, size * 0.28), h: 1.8, y: H - 3.4, kind: 'louvre', frame: fk, shape: wall === 'planks' ? 'flat' : 'pointed' });
  const lower: Opening[] = [
    { side: 'nx', u: 0, w: 0.8, h: 2.2, y: H * 0.3, kind: 'lancet', frame: fk, shape: 'pointed' },
    { side: 'pz', u: 0, w: 0.3, h: 0.9, y: H * 0.55, kind: 'slit', frame: fk },
  ];
  if (o.door) lower.push({ side: 'nx', u: 0, w: 1.2, h: 2.4, y: 0, kind: 'door', frame: fk, shape: 'pointed' });
  house(ctx, {
    rect: rc, plinthH: 0.5,
    storeys: [{ h: H - 0.5, wall, frame: 'none', quoins: wall === 'stone' && H < 12, openings: [...lower, ...belfry] }],
    roof: null,
  });
  if (lod < 2 && wall !== 'planks') {
    b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
      // Angle buttresses stepping in.
      for (const [cx, cz, sx, sz] of [[rc.x0, rc.z0, -1, -1], [rc.x1, rc.z0, 1, -1], [rc.x1, rc.z1, 1, 1], [rc.x0, rc.z1, -1, 1]] as [number, number, number, number][]) {
        b.taperBox(Math.min(cx, cx + sx * 0.55), -0.3, cz - 0.25, Math.max(cx, cx + sx * 0.55), H * 0.62, cz + 0.25, 0.1, 0.02, col);
        b.taperBox(cx - 0.25, -0.3, Math.min(cz, cz + sz * 0.55), cx + 0.25, H * 0.62, Math.max(cz, cz + sz * 0.55), 0.02, 0.1, col);
      }
      // String course under the belfry.
      b.box(rc.x0 - 0.08, H - 4.0, rc.z0 - 0.08, rc.x1 + 0.08, H - 3.8, rc.z1 + 0.08, shade(col, 1.08), 'b');
    });
  }
  let top = H;
  const spire = o.spire ?? 'none';
  if (o.crenel ?? spire === 'none') {
    b.state({ layer: Layer.Wall, flags: F.Snow }, () => b.box(rc.x0, H - 0.4, rc.z0, rc.x1, H - 0.05, rc.z1, shade(col, 0.7), 'b'));
    crenelLine(ctx, rc.x0 - 0.1, rc.x1 + 0.1, rc.z1 + 0.1, H, col, { thick: 0.4, period: size / Math.max(2, Math.round(size / 1.3)), merlon: 0.6, phase: 0.1 });
    crenelLine(ctx, rc.x0 - 0.1, rc.x1 + 0.1, rc.z0 + 0.3, H, col, { thick: 0.4, period: size / Math.max(2, Math.round(size / 1.3)), merlon: 0.6, phase: 0.1 });
    b.push(); b.translate(x, 0, z); b.rotY(Math.PI / 2); b.translate(-x, 0, -z);
    crenelLine(ctx, x - hs + 0.3, x + hs - 0.3, z + hs + 0.1, H, col, { thick: 0.4, period: size / Math.max(2, Math.round(size / 1.3)), merlon: 0.6, phase: 0.4 });
    crenelLine(ctx, x - hs + 0.3, x + hs - 0.3, z - hs + 0.3, H, col, { thick: 0.4, period: size / Math.max(2, Math.round(size / 1.3)), merlon: 0.6, phase: 0.4 });
    b.pop();
    top = H + 1.4;
    if (o.pinnacles && lod < 2) for (const [px, pz] of [[rc.x0, rc.z0], [rc.x1, rc.z0], [rc.x1, rc.z1], [rc.x0, rc.z1]] as [number, number][]) pinnacle(ctx, px, pz, H, 2.4, 0.5, col);
  }
  const roofMat: RoofMat = s.id === 'norse' ? 'shingle' : s.id === 'teuton' ? 'slate' : spire === 'stone' ? 'slate' : s.churchRoof;
  if (spire === 'stone') {
    // Octagonal broach spire.
    b.state({ layer: Layer.Roof, flags: F.Snow }, () => {
      const sh = size * 2.6;
      b.cyl(x, z, H - 0.2, H + sh, hs * 0.95, 0.05, 8, { side: shade(col, 1.02) }, { rot: Math.PI / 8, top: false, bottom: false });
      for (const [px, pz] of [[rc.x0, rc.z0], [rc.x1, rc.z0], [rc.x1, rc.z1], [rc.x0, rc.z1]] as [number, number][]) {
        b.tri([px, H - 0.2, pz], [x + (px - x) * 0.35, H - 0.2 + size * 0.7, z + (pz - z) * 0.35], [x + (px - x) * 0.7, H - 0.2, z], shade(col, 0.95));
        b.tri([px, H - 0.2, pz], [x, H - 0.2, z + (pz - z) * 0.7], [x + (px - x) * 0.35, H - 0.2 + size * 0.7, z + (pz - z) * 0.35], shade(col, 0.95));
      }
      top = H + sh;
    });
  } else if (spire === 'helm') {
    // Rhenish helm: gables on each face, rhombic roof planes rising to a point.
    const g = size * 0.75, sh = size * 2.2;
    const lk = roofLook('slate', roofTint('slate', s));
    b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
      for (const side of ['pz', 'nz', 'px', 'nx'] as Side[]) {
        enterSide(b, rc, side, H);
        b.flat([[-hs, 0], [hs, 0], [0, g]], 0, col);
        b.pop();
      }
    });
    b.state({ layer: Layer.Roof, flags: F.Snow }, () => {
      const A: V3 = [x, H + sh, z];
      const C: V3[] = [[rc.x1, H, rc.z1], [rc.x1, H, rc.z0], [rc.x0, H, rc.z0], [rc.x0, H, rc.z1]];
      const G: V3[] = [[x + hs, H + g, z], [x, H + g, rc.z0], [x - hs, H + g, z], [x, H + g, rc.z1]];
      for (let i = 0; i < 4; i++) {
        const c = C[i], gA = G[i], gB = G[(i + 3) % 4];
        b.tri(c, A, gB, lk.top[i % 3]);
        b.tri(c, gA, A, shade(lk.top[0], 0.93));
      }
    });
    top = H + sh;
  } else if (spire === 'timber' || spire === 'pyramid') {
    const lk = roofLook(roofMat, roofTint(roofMat, s));
    const r = buildRoof(b, { x0: rc.x0, x1: rc.x1, z0: rc.z0, z1: rc.z1, eaveY: H, type: 'pyramid', pitch: spire === 'timber' ? 76 : 58, ov: 0.35, gov: 0.35, ridge: 'none', frame: false }, lk, lod);
    top = r.topY;
  }
  if (spire !== 'none' && lod < 2) b.state({ layer: Layer.Detail, flags: F.Snow }, () => {
    b.box(x - 0.05, top - 0.1, z - 0.05, x + 0.05, top + 1.2, z + 0.05, COL.iron);
    b.box(x - 0.3, top + 0.75, z - 0.04, x + 0.3, top + 0.83, z + 0.04, COL.iron);
    b.blob(x, top + 1.25, z, 0.1, 0.1, 0.1, COL.gold, 0.1);
  });
  if (o.flag) flagPole(ctx, x, top - 0.6, z, 3.4, ctx.owner);
  return top;
}

function bellcote(ctx: Ctx, x: number, z: number, y: number, double: boolean, col: number, mat: RoofMat): void {
  const { b, lod } = ctx;
  const w = double ? 1.7 : 1.1;
  b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
    b.box(x - 0.3, y - 0.6, z - w / 2, x + 0.3, y + 1.6, z + w / 2, { side: col, top: shade(col, 1.06) });
    b.cyl(x, z, y + 1.55, y + 2.4, w * 0.55, 0, 4, shade(col, 1.04), { rot: Math.PI / 4, sz: 0.5 / (w * 0.55) * 0.55 + 0.55 });
  });
  b.state({ layer: Layer.Detail, flags: F.NoAO }, () => {
    const n = double ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const zc = z + (n === 1 ? 0 : (i - 0.5) * 0.75);
      for (const sx of [-1, 1]) b.quad(sx > 0 ? [x + 0.31, y + 0.25, zc - 0.25] : [x - 0.31, y + 0.25, zc + 0.25], sx > 0 ? [x + 0.31, y + 0.25, zc + 0.25] : [x - 0.31, y + 0.25, zc - 0.25], sx > 0 ? [x + 0.31, y + 1.2, zc + 0.25] : [x - 0.31, y + 1.2, zc - 0.25], sx > 0 ? [x + 0.31, y + 1.2, zc - 0.25] : [x - 0.31, y + 1.2, zc + 0.25], 0x1a1612);
      if (lod === 0) b.lathe([[0.03, y + 1.15], [0.12, y + 1.05], [0.17, y + 0.75], [0.21, y + 0.6]], 6, COL.gold, {});
    }
  });
  void mat;
}

/** Big traceried window on a gable (east/west windows, transept ends). */
function bigWindow(side: Side, u: number, y: number, w: number, h: number): Opening {
  return { side, u, w, h, y, kind: 'big', frame: 'stone', shape: 'pointed', mullions: w > 2.5 ? 3 : 2, lit: 1 };
}

export function chapel(ctx: Ctx, def: BuildingDef): void {
  const { s, b, lod } = ctx;
  const wall = churchWall(s);
  const mat = churchRoof(s, 1);
  const rect: Rect = { x0: -def.w / 2 + 0.75, x1: def.w / 2 - 0.65, z0: -def.d / 2 + 0.7, z1: def.d / 2 - 0.75 };
  const L = rect.x1 - rect.x0;
  const H = s.id === 'norse' ? 3.6 : 4.0;
  const fk = wall === 'planks' ? 'timber' : 'stone';
  house(ctx, {
    rect, plinthH: 0.3,
    storeys: [{ h: H, wall, frame: 'none', quoins: wall === 'stone', openings: [
      { side: 'pz', u: -L / 2 + 1.4, w: 1.0, h: 2.2, y: 0, kind: 'door', frame: fk, shape: s.id === 'norse' ? 'round' : 'pointed' },
      ...lancets('pz', L, 3, 1.4, 1.6, 0.45, [-L / 2 + 1.4]),
      ...lancets('nz', L, 3, 1.4, 1.6, 0.45),
      { side: 'px', u: 0, w: 1.0, h: 2.0, y: 1.3, kind: 'lancet', frame: fk, shape: 'pointed', mullions: 1, lit: 1 },
    ] }],
    roof: { type: 'gable', pitch: Math.max(52, s.churchPitch), mat, ov: 0.3, gov: 0.15, ridge: 'plain' },
    parapet: wall !== 'planks' ? (s.crowSteps ? 'crow' : 'coping') : undefined,
  });
  if (wall !== 'planks') cornerButtresses(ctx, rect, H, s.stone);
  const roofY = 0.3 + H + ((rect.z1 - rect.z0) / 2) * Math.tan((Math.max(52, s.churchPitch) * Math.PI) / 180);
  bellcote(ctx, rect.x0 + 0.1, 0, roofY - 0.2, s.bellcote === 'double', wall === 'planks' ? COL.plankTar : s.stone, mat);
  if (lod < 2) b.state({ layer: Layer.Detail, flags: F.Snow }, () => {
    const x = rect.x1 - 0.1, y = roofY + 0.4;
    b.box(x - 0.08, y, -0.08, x + 0.08, y + 1.0, 0.08, s.stoneTrim);
    b.box(x - 0.08, y + 0.55, -0.35, x + 0.08, y + 0.72, 0.35, s.stoneTrim);
  });
}

export function church(ctx: Ctx, def: BuildingDef): void {
  const { s, level: q, b, lod } = ctx;
  const wall = churchWall(s);
  const mat = churchRoof(s, q);
  const col = wall === 'planks' ? COL.plankTar : wall === 'rubble' ? COL.rubble : s.stone;
  const fk = wall === 'planks' ? 'timber' : 'stone';
  const W = def.w, D = def.d;
  const pitch = Math.max(50, s.churchPitch);
  const towerS = 4.6;
  const hasTower = q >= 2;
  const aisles = q >= 3 && s.id !== 'norse' && s.id !== 'gael';
  const nx0 = -W / 2 + (hasTower ? towerS + 0.75 : 0.8), nx1 = W / 2 - 5.6;
  const nhw = aisles ? 2.5 : hasTower ? 3.0 : 3.2;
  const nave: Rect = { x0: nx0, x1: nx1, z0: -nhw, z1: nhw };
  const NH = aisles ? 7.6 : 5.4;
  const doorU = -(nx1 - nx0) / 2 + 1.6;
  const L = nx1 - nx0;
  const naveOps: Opening[] = aisles
    ? [...lancets('pz', L, 4, NH - 2.0, 1.3, 0.55), ...lancets('nz', L, 4, NH - 2.0, 1.3, 0.55)]
    : [
      { side: 'pz', u: doorU, w: 1.1, h: 2.4, y: 0, kind: 'door', frame: fk, shape: s.id === 'norse' ? 'round' : 'pointed' },
      ...lancets('pz', L, 3, 1.6, 2.2, 0.6, [doorU]),
      ...lancets('nz', L, 3, 1.6, 2.2, 0.6),
    ];
  if (!hasTower) naveOps.push({ side: 'nx', u: 0, w: 1.0, h: 2.2, y: 1.8, kind: 'lancet', frame: fk, shape: 'pointed', mullions: 1 });
  const naveRes = house(ctx, {
    rect: nave, plinthH: 0.35,
    storeys: [{ h: NH, wall, frame: 'none', quoins: wall === 'stone', openings: naveOps }],
    roof: { type: 'gable', pitch, mat, ov: 0.3, gov: 0.12, ridge: 'plain' },
    parapet: wall !== 'planks' ? (s.crowSteps ? 'crow' : 'coping') : undefined,
  });
  // Chancel: narrower and lower, with the east window.
  const ch: Rect = { x0: nx1, x1: W / 2 - 0.7, z0: -nhw + 0.5, z1: nhw - 0.5 };
  const CH = NH - (aisles ? 2.2 : 0.9);
  house(ctx, {
    rect: ch, plinthH: 0.35,
    storeys: [{ h: CH, wall, frame: 'none', quoins: wall === 'stone', openings: [
      ...lancets('pz', ch.x1 - ch.x0, 2, 1.6, 2.0, 0.55),
      ...lancets('nz', ch.x1 - ch.x0, 2, 1.6, 2.0, 0.55),
      bigWindow('px', 0, 1.4, Math.min(2.2, (ch.z1 - ch.z0) * 0.5), Math.min(3.6, CH + 0.8)),
    ] }],
    roof: { type: 'gable', pitch, mat, ov: 0.3, gov: 0.12, ridge: 'plain' },
    parapet: wall !== 'planks' ? (s.crowSteps ? 'crow' : 'coping') : undefined,
  });
  if (wall !== 'planks') {
    cornerButtresses(ctx, ch, CH, col);
    if (!aisles) {
      buttresses(ctx, nx0 + 0.3, nx1 - 0.3, nave.z1, 1, 3, NH, col, (x) => Math.abs(x - (nx0 + L / 2 + doorU)) < 1.2);
      buttresses(ctx, nx0 + 0.3, nx1 - 0.3, nave.z0, -1, 3, NH, col);
    }
  }
  // Aisles with lean-to roofs (level 3).
  if (aisles) {
    for (const sd of [1, -1]) {
      const ar: Rect = sd > 0 ? { x0: nx0 + 0.3, x1: nx1 - 0.3, z0: nhw, z1: D / 2 - 0.55 } : { x0: nx0 + 0.3, x1: nx1 - 0.3, z0: -D / 2 + 0.55, z1: -nhw };
      const al = ar.x1 - ar.x0;
      house(ctx, {
        rect: ar, plinthH: 0.35, noFloor: true,
        storeys: [{ h: 3.6, wall, frame: 'none', openings: sd > 0
          ? [{ side: 'pz', u: -al / 2 + 1.4, w: 1.1, h: 2.4, y: 0, kind: 'door', frame: fk, shape: 'pointed' }, ...lancets('pz', al, 3, 1.2, 1.9, 0.6, [-al / 2 + 1.4])]
          : lancets('nz', al, 3, 1.2, 1.9, 0.6) }],
        roof: { type: 'shed', low: sd > 0 ? 'pz' : 'nz', pitch: 24, mat: mat === 'thatch' ? 'lead' : mat, ov: 0.2, gov: 0.1, frame: false },
      });
      buttresses(ctx, ar.x0 + 0.2, ar.x1 - 0.2, sd > 0 ? ar.z1 : ar.z0, sd as 1 | -1, 3, 3.6, col, (x) => sd > 0 && Math.abs(x - (ar.x0 + 1.4)) < 1.0, 0.45);
    }
  }
  // South porch (level 2).
  if (q === 2 || (q >= 3 && !aisles)) {
    const px = nx0 + L / 2 + doorU;
    const pr: Rect = { x0: px - 1.25, x1: px + 1.25, z0: nave.z1, z1: D / 2 - 0.35 };
    house(ctx, {
      rect: pr, plinthH: 0.35, noFloor: true,
      storeys: [{ h: 2.9, wall, frame: 'none', quoins: wall === 'stone', openings: [{ side: 'pz', u: 0, w: 1.3, h: 2.3, y: 0, kind: 'door', frame: fk, shape: 'pointed', open: true }] }],
      roof: { type: 'gable', axis: 'z', pitch, mat: mat === 'thatch' ? 'stoneslate' : mat, ov: 0.15, gov: 0.1, ridge: 'plain' },
      parapet: wall !== 'planks' ? 'coping' : undefined,
    });
  }
  // West tower or bellcote.
  if (hasTower) {
    const tx = -W / 2 + towerS / 2 + 0.85;
    const H = q >= 3 ? 17.5 : 13.5;
    const spire = s.spire === 'roundtower' ? 'none' : q >= 3 || (q === 2 && (s.id === 'franc' || s.id === 'norse')) ? (s.spire === 'none' ? 'none' : s.spire) : 'none';
    squareTower(ctx, tx, 0, towerS, H, {
      spire: spire as 'none', crenel: spire === 'none', pinnacles: q >= 3 && spire === 'none',
      wall, door: true,
    });
    if (s.spire === 'roundtower' && q >= 3) {
      // Irish round tower standing by the chancel.
      const top = roundTower(ctx, W / 2 - 1.3, D / 2 - 1.4, 1.1, 16, COL.stoneGrey, { batter: 0.15, roof: 'none' });
      b.state({ layer: Layer.Roof, flags: F.Snow }, () => b.cyl(W / 2 - 1.3, D / 2 - 1.4, top, top + 2.4, 1.18, 0, lod === 0 ? 12 : 8, COL.stoneGrey));
    }
  } else {
    bellcote(ctx, nx0 + 0.1, 0, naveRes.roof.ridgeY - 0.3, s.bellcote === 'double', col, mat);
  }
  if (lod < 2) b.state({ layer: Layer.Detail, flags: F.Snow }, () => {
    const x = ch.x1 - 0.12, y = 0.35 + CH + ((ch.z1 - ch.z0) / 2) * Math.tan((pitch * Math.PI) / 180) + 0.4;
    b.box(x - 0.09, y, -0.09, x + 0.09, y + 1.1, 0.09, s.stoneTrim);
    b.box(x - 0.09, y + 0.6, -0.38, x + 0.09, y + 0.78, 0.38, s.stoneTrim);
  });
  void opening;
}

/** Cruciform great church: nave + aisles, transepts, crossing tower, presbytery, optional west towers. */
function greatChurch(ctx: Ctx, def: BuildingDef, o: { naveH: number; aisleH: number; naveHW: number; aisleW: number; transX: [number, number]; presbyX: number; towerH: number; westTowers: number; spire: boolean; flyers: boolean; apse: boolean; rose: boolean }): void {
  const { s, b, lod } = ctx;
  const wall = churchWall(s) === 'planks' ? 'stone' : churchWall(s);
  const col = wall === 'rubble' ? COL.stoneGrey : s.stone;
  const mat: RoofMat = s.id === 'norse' ? 'shingle' : s.churchRoof === 'stoneslate' ? 'slate' : s.churchRoof;
  const W = def.w, D = def.d;
  const pitch = Math.max(52, s.churchPitch);
  const westX = -W / 2 + 0.6;
  const wtS = o.westTowers > 0 ? o.aisleW + 1.4 : 0;
  const nave: Rect = { x0: westX + (o.westTowers > 0 ? 0 : 0.3), x1: o.transX[0], z0: -o.naveHW, z1: o.naveHW };
  const NL = nave.x1 - nave.x0;
  const bays = Math.max(4, Math.round(NL / 4.2));
  const clere = lancets('pz', NL, bays, o.naveH - o.aisleH * 0.15 - 3.0 + 0.6, 2.2, 0.9).concat(lancets('nz', NL, bays, o.naveH - o.aisleH * 0.15 - 3.0 + 0.6, 2.2, 0.9));
  const westOps: Opening[] = [
    { side: 'nx', u: 0, w: 2.4, h: 4.2, y: 0, kind: 'door', frame: 'stone', shape: 'pointed' },
    o.rose ? { side: 'nx', u: 0, w: 3.6, h: 3.6, y: o.naveH - 5.2, kind: 'big', frame: 'stone', shape: 'round', mullions: 3, lit: 1 } : bigWindow('nx', 0, 6.0, 3.4, Math.min(8, o.naveH - 7)),
  ];
  house(ctx, {
    rect: nave, plinthH: 0.5,
    storeys: [{ h: o.naveH, wall, frame: 'none', openings: [...clere, ...westOps] }],
    roof: { type: 'gable', pitch, mat, ov: 0.35, gov: 0.15, ridge: 'plain' },
    parapet: 'coping',
  });
  // Aisles
  for (const sd of [1, -1]) {
    const ar: Rect = sd > 0 ? { x0: nave.x0 + wtS, x1: nave.x1, z0: o.naveHW, z1: o.naveHW + o.aisleW } : { x0: nave.x0 + wtS, x1: nave.x1, z0: -o.naveHW - o.aisleW, z1: -o.naveHW };
    const al = ar.x1 - ar.x0;
    const ops: Opening[] = lancets(sd > 0 ? 'pz' : 'nz', al, bays - (wtS ? 1 : 0), 1.8, Math.min(3.6, o.aisleH - 3), 1.0);
    if (sd > 0) ops.splice(1, 1, { side: 'pz', u: -al / 2 + al / (bays - (wtS ? 1 : 0)) * 1.5, w: 1.8, h: 3.4, y: 0, kind: 'door', frame: 'stone', shape: 'pointed' });
    house(ctx, {
      rect: ar, plinthH: 0.5, noFloor: true,
      storeys: [{ h: o.aisleH, wall, frame: 'none', openings: ops }],
      roof: { type: 'shed', low: sd > 0 ? 'pz' : 'nz', pitch: 22, mat, ov: 0.25, gov: 0.1, frame: false },
    });
    const zOut = sd > 0 ? ar.z1 : ar.z0;
    buttresses(ctx, ar.x0 + 0.4, ar.x1 - 0.4, zOut, sd as 1 | -1, bays - (wtS ? 1 : 0), o.aisleH, col, () => false, 0.9);
    if (o.flyers && lod < 2) {
      // Flying buttresses from the aisle piers to the clerestory, with pinnacles.
      const n = bays - (wtS ? 1 : 0);
      b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
        for (let i = 0; i <= n; i++) {
          const x = ar.x0 + 0.4 + ((ar.x1 - ar.x0 - 0.8) * i) / n;
          const zo = zOut + sd * 0.45;
          b.box(x - 0.32, o.aisleH * 0.82, Math.min(zo - sd * 0.45, zo + sd * 0.45), x + 0.32, o.aisleH + 3.2, Math.max(zo - sd * 0.45, zo + sd * 0.45), col, 'b');
          b.beam([x, o.aisleH + 2.6, zo], [x, o.naveH - 2.2, sd * o.naveHW], 0.42, 0.55, col);
          b.beam([x, o.aisleH + 1.4, zo], [x, o.naveH - 3.6, sd * o.naveHW], 0.3, 0.3, shade(col, 0.95));
          if (lod === 0) b.cyl(x, zo, o.aisleH + 3.2, o.aisleH + 5.2, 0.36, 0, 4, shade(col, 1.04), { rot: Math.PI / 4 });
        }
      });
    }
  }
  // Transepts (full depth) with big end windows.
  const tr: Rect = { x0: o.transX[0], x1: o.transX[1], z0: -D / 2 + 0.6, z1: D / 2 - 0.6 };
  house(ctx, {
    rect: tr, plinthH: 0.5,
    storeys: [{ h: o.naveH, wall, frame: 'none', openings: [
      o.rose ? { side: 'pz', u: 0, w: 3.2, h: 3.2, y: o.naveH - 5, kind: 'big', frame: 'stone', shape: 'round', mullions: 3, lit: 1 } : bigWindow('pz', 0, 5.0, 2.8, Math.min(7.5, o.naveH - 6)),
      o.rose ? { side: 'nz', u: 0, w: 3.2, h: 3.2, y: o.naveH - 5, kind: 'big', frame: 'stone', shape: 'round', mullions: 3 } : bigWindow('nz', 0, 5.0, 2.8, Math.min(7.5, o.naveH - 6)),
      { side: 'pz', u: 0, w: 1.8, h: 3.4, y: 0, kind: 'door', frame: 'stone', shape: 'pointed' },
      ...lancets('px', tr.z1 - tr.z0, 4, 3.0, 3.2, 0.9, [0]),
    ] }],
    roof: { type: 'gable', axis: 'z', pitch, mat, ov: 0.35, gov: 0.15, ridge: 'plain' },
    parapet: 'coping',
  });
  cornerButtresses(ctx, tr, o.naveH, col);
  // Presbytery / choir with an apse or a square east end.
  const pr: Rect = { x0: o.transX[1], x1: o.presbyX, z0: -o.naveHW, z1: o.naveHW };
  const PH = o.naveH - 1;
  house(ctx, {
    rect: pr, plinthH: 0.5,
    storeys: [{ h: PH, wall, frame: 'none', openings: [
      ...lancets('pz', pr.x1 - pr.x0, 3, 4.0, 4.0, 1.0), ...lancets('nz', pr.x1 - pr.x0, 3, 4.0, 4.0, 1.0),
      ...(o.apse ? [] : [bigWindow('px', 0, 3.6, Math.min(4.2, o.naveHW * 1.2), Math.min(PH - 2, 10))]),
    ] }],
    roof: { type: 'gable', pitch, mat, ov: 0.35, gov: 0.15, ridge: 'plain' },
    parapet: o.apse ? undefined : 'coping',
  });
  buttresses(ctx, pr.x0 + 0.5, pr.x1 - 0.2, pr.z1, 1, 3, PH, col, () => false, 0.9);
  buttresses(ctx, pr.x0 + 0.5, pr.x1 - 0.2, pr.z0, -1, 3, PH, col, () => false, 0.9);
  if (o.apse) {
    // Semicircular apse with radiating buttresses and a conical roof.
    const R = o.naveHW - 0.05;
    const ax = pr.x1;
    b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
      const n = lod === 0 ? 7 : 4;
      for (let i = 0; i < n; i++) {
        const a0 = -Math.PI / 2 + (i / n) * Math.PI, a1 = -Math.PI / 2 + ((i + 1) / n) * Math.PI;
        const p0: V3 = [ax + Math.cos(a0) * R, 0, Math.sin(a0) * R], p1: V3 = [ax + Math.cos(a1) * R, 0, Math.sin(a1) * R];
        b.quad([p0[0], -0.3, p0[2]], [p1[0], -0.3, p1[2]], [p1[0], PH + 0.5, p1[2]], [p0[0], PH + 0.5, p0[2]], i % 2 ? col : shade(col, 0.97));
        const am = (a0 + a1) / 2;
        b.push(); b.translate(ax + Math.cos(am) * (R + 0.01), 0, Math.sin(am) * (R + 0.01)); b.rotY(Math.PI / 2 - am);
        b.state({ layer: Layer.Detail, flags: F.NoAO }, () => b.flat([[-0.45, 4.2], [0.45, 4.2], [0.45, 8.2], [0, 9.0], [-0.45, 8.2]], 0.02, 0x2a2420));
        b.pop();
        const ab = a1;
        if (i < n - 1) b.push(), b.translate(ax + Math.cos(ab) * R, 0, Math.sin(ab) * R), b.rotY(Math.PI / 2 - ab), b.taperBox(-0.3, -0.3, 0, 0.3, PH * 0.75, 1.0, 0.02, 0.35, col), b.pop();
      }
    });
    const lk = roofLook(mat, roofTint(mat, s));
    b.state({ layer: Layer.Roof, flags: F.Snow }, () => {
      const n = lod === 0 ? 7 : 4;
      const top: V3 = [ax, PH + 0.5 + R * Math.tan((pitch * Math.PI) / 180), 0];
      for (let i = 0; i < n; i++) {
        const a0 = -Math.PI / 2 + (i / n) * Math.PI, a1 = -Math.PI / 2 + ((i + 1) / n) * Math.PI;
        b.tri([ax + Math.cos(a0) * (R + 0.35), PH + 0.3, Math.sin(a0) * (R + 0.35)], top, [ax + Math.cos(a1) * (R + 0.35), PH + 0.3, Math.sin(a1) * (R + 0.35)], lk.top[i % lk.top.length]);
      }
    });
  }
  // Crossing tower.
  const cx = (o.transX[0] + o.transX[1]) / 2;
  const tS = Math.min(o.transX[1] - o.transX[0], o.naveHW * 2) + 0.2;
  squareTower(ctx, cx, 0, tS, o.towerH, { spire: o.spire ? (s.spire === 'helm' ? 'helm' : s.id === 'norse' ? 'timber' : 'stone') : 'none', crenel: !o.spire, pinnacles: true, belfry: true, flag: !o.spire });
  // West towers.
  if (o.westTowers > 0) {
    for (const sd of [1, -1]) {
      const tz = sd * (o.naveHW + o.aisleW / 2 + 0.1);
      squareTower(ctx, westX + wtS / 2, tz, wtS, o.westTowers, { spire: o.spire && s.id !== 'anglo' ? (s.spire === 'helm' ? 'helm' : 'stone') : 'none', crenel: !(o.spire && s.id !== 'anglo'), pinnacles: true, belfry: true });
    }
  }
}

export function abbeyChurch(ctx: Ctx, def: BuildingDef): void {
  const q = ctx.level;
  greatChurch(ctx, def, {
    naveH: q >= 2 ? 13 : 11.5, aisleH: 6.2, naveHW: 4.3, aisleW: 3.4,
    transX: [4.5, 13], presbyX: def.w / 2 - (ctx.s.id === 'franc' ? 5.7 : 0.8),
    towerH: q >= 2 ? 30 : 21, westTowers: q >= 2 ? 21 : 0, spire: false, flyers: false, apse: ctx.s.id === 'franc', rose: false,
  });
}

export function cathedral(ctx: Ctx, def: BuildingDef): void {
  const q = ctx.level;
  const s = ctx.s;
  greatChurch(ctx, def, {
    naveH: 22, aisleH: 10.5, naveHW: 5.8, aisleW: 4.8,
    transX: [7, 17], presbyX: def.w / 2 - (s.id === 'franc' || s.id === 'teuton' ? 7.4 : 1.0),
    towerH: q >= 2 ? 44 : 36, westTowers: q >= 2 ? 36 : 30, spire: q >= 2, flyers: true, apse: s.id === 'franc' || s.id === 'teuton', rose: s.id !== 'anglo',
  });
}

export function cloister(ctx: Ctx, def: BuildingDef): void {
  const { s, level: q, b, lod } = ctx;
  const W = def.w, D = def.d;
  const wall: WallKind = churchWall(s) === 'planks' ? 'planks' : churchWall(s);
  const col = wall === 'planks' ? COL.plankTar : wall === 'rubble' ? COL.rubble : s.stone;
  const mat: RoofMat = s.id === 'norse' ? 'shingle' : s.churchRoof === 'lead' ? 'stoneslate' : s.churchRoof;
  const R = 6.0;
  const pitch = Math.max(48, s.churchPitch);
  const fk = wall === 'planks' ? 'timber' : 'stone';
  const storeys = q >= 2 ? 2 : 1;
  const rangeH = 3.6;
  const mk = (rc: Rect, ax: 'x' | 'z', outer: Side, inner: Side, door: boolean) => {
    const len = ax === 'x' ? rc.x1 - rc.x0 : rc.z1 - rc.z0;
    const st = [{ h: rangeH, wall, frame: 'none' as const, quoins: wall === 'stone', openings: [
      ...lancets(outer, len, 4, 1.3, 1.6, 0.55, door ? [0] : []),
      ...(door ? [{ side: outer, u: 0, w: 2.2, h: 2.9, y: 0, kind: 'door' as const, frame: fk as 'stone', shape: 'pointed' as const, open: true }] : []),
    ] }];
    if (storeys > 1 || ax === 'z') st.push({ h: 2.8, wall, frame: 'none' as const, quoins: false, openings: [...windowRow(outer, len, 4, { w: 0.6, h: 0.8, y: 0.9, frame: fk, shutters: false }), ...windowRow(inner, len, 3, { w: 0.6, h: 0.8, y: 0.9, frame: fk, shutters: false })] } as never);
    return house(ctx, { rect: rc, plinthH: 0.35, storeys: st, roof: { type: 'gable', axis: ax, pitch, mat, ov: 0.3, gov: 0.12, ridge: 'plain' }, parapet: wall !== 'planks' ? (s.crowSteps ? 'crow' : 'coping') : undefined });
  };
  // Ranges: north (-z) dormitory over chapter house, east (+x), west (-x), and the gate range (+z).
  const north = mk({ x0: -W / 2 + 0.6, x1: W / 2 - 0.6, z0: -D / 2 + 0.6, z1: -D / 2 + R }, 'x', 'nz', 'pz', false);
  mk({ x0: W / 2 - R, x1: W / 2 - 0.6, z0: -D / 2 + R, z1: D / 2 - R }, 'z', 'px', 'nx', false);
  mk({ x0: -W / 2 + 0.6, x1: -W / 2 + R, z0: -D / 2 + R, z1: D / 2 - R }, 'z', 'nx', 'px', false);
  const south: Rect = { x0: -W / 2 + 0.6, x1: W / 2 - 0.6, z0: D / 2 - R + 1.6, z1: D / 2 - 0.6 };
  house(ctx, {
    rect: south, plinthH: 0.35,
    storeys: [{ h: rangeH, wall, frame: 'none', quoins: wall === 'stone', openings: [
      { side: 'pz', u: 0, w: 2.4, h: 3.0, y: 0, kind: 'door', frame: fk, shape: 'pointed', open: true },
      ...lancets('pz', south.x1 - south.x0, 6, 1.3, 1.5, 0.5, [0]),
    ] }],
    roof: { type: 'gable', pitch, mat, ov: 0.3, gov: 0.12, ridge: 'plain' },
  });
  // Cloister walks: arcades facing the garth with lean-to roofs.
  const g: Rect = { x0: -W / 2 + R + 2.4, x1: W / 2 - R - 2.4, z0: -D / 2 + R + 2.4, z1: D / 2 - R + 1.6 - 2.4 };
  const walk = (x0: number, z0: number, x1: number, z1: number, low: Side) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const a = Math.atan2(-(z1 - z0), x1 - x0);
    b.push(); b.translate(x0, 0, z0); b.rotY(a);
    b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
      const nb = Math.max(3, Math.round(len / 1.8));
      for (let i = 0; i <= nb; i++) b.box((len * i) / nb - 0.2, -0.3, -0.2, (len * i) / nb + 0.2, 2.3, 0.2, { side: col, top: col });
      b.box(-0.2, 0, -0.25, len + 0.2, 0.6, 0.25, { side: col, top: shade(col, 1.06) });
      for (let i = 0; i < nb; i++) {
        const u0 = (len * i) / nb + 0.2, u1 = (len * (i + 1)) / nb - 0.2, um = (u0 + u1) / 2;
        b.flat([[u0, 1.9], [um, 2.3], [u1, 1.9], [u1, 2.55], [u0, 2.55]], 0.2, col);
        b.flat([[u1, 1.9], [um, 2.3], [u0, 1.9], [u0, 2.55], [u1, 2.55]].map(([u, v]) => [u, v] as [number, number]).reverse(), -0.2, col);
      }
      b.box(-0.2, 2.55, -0.22, len + 0.2, 2.75, 0.22, shade(col, 1.04));
    });
    b.pop();
    void low;
  };
  walk(g.x0, g.z1, g.x1, g.z1, 'pz');
  walk(g.x1, g.z0, g.x0, g.z0, 'nz');
  walk(g.x1, g.z1, g.x1, g.z0, 'px');
  walk(g.x0, g.z0, g.x0, g.z1, 'nx');
  const lk = roofLook(mat, roofTint(mat, s));
  for (const [rc, low] of [
    [{ x0: g.x0 - 0.3, x1: g.x1 + 0.3, z0: g.z1, z1: south.z0 }, 'nz'],
    [{ x0: g.x0 - 0.3, x1: g.x1 + 0.3, z0: north.top.z1, z1: g.z0 }, 'pz'],
    [{ x0: g.x1, x1: W / 2 - R, z0: g.z0, z1: g.z1 }, 'nx'],
    [{ x0: -W / 2 + R, x1: g.x0, z0: g.z0, z1: g.z1 }, 'px'],
  ] as [Rect, Side][]) {
    buildRoof(b, { ...rc, eaveY: 2.75, type: 'shed', low, pitch: 20, ov: 0.25, gov: 0.0, frame: false }, { ...lk, thickness: 0.14 }, lod);
  }
  // The garth: grass with a central well / yew.
  b.state({ layer: Layer.Ground, flags: F.Snow | F.Grass }, () => b.box(g.x0 + 0.3, -0.05, g.z0 + 0.3, g.x1 - 0.3, 0.05, g.z1 - 0.3, { top: COL.grass, side: COL.grassDark }, 'b'));
  b.state({ layer: Layer.Decor, flags: F.Snow }, () => {
    b.cyl(0, (g.z0 + g.z1) / 2, -0.2, 0.75, 0.75, 0.75, 8, { side: col, top: shade(col, 1.06) });
    b.cyl(0, (g.z0 + g.z1) / 2, 0.6, 0.72, 0.55, 0.55, 8, COL.waterDeep, { bottom: false });
  });
  if (lod < 2) b.state({ layer: Layer.Decor, flags: F.Snow }, () => {
    b.cyl(g.x1 - 2, g.z0 + 2, -0.2, 1.5, 0.25, 0.2, 5, COL.bark);
    b.blob(g.x1 - 2, g.z0 + 2 + 0, 3.2, 1.7, 2.4, 1.7, 0x2f4a32, 0.25, 0, 5);
  });
  if (q >= 2) {
    // Bell turret on the north range and a lavatorium chimney.
    squareTower(ctx, W / 2 - 3.2, -D / 2 + 3.2, 2.6, 11.5, { spire: 'pyramid', crenel: false, belfry: true, wall });
  }
  chimney(ctx, { x: -W / 2 + 3.0, z: -D / 2 + 1.8, baseY: 5, topY: north.roof.topY + 0.6, w: 0.9, d: 0.9, color: col, pots: 1 });
  ctx.out.doors.length = 0;
  ctx.out.doors.push({ x: 0, z: D / 2 + 0.0 });
}

export function infirmary(ctx: Ctx, def: BuildingDef): void {
  const { s, level: q, b, lod } = ctx;
  const wall = churchWall(s);
  const col = wall === 'planks' ? COL.plankTar : wall === 'rubble' ? COL.rubble : s.stone;
  const mat: RoofMat = s.id === 'norse' ? 'shingle' : s.churchRoof === 'lead' ? 'tile' : s.churchRoof;
  const fk = wall === 'planks' ? 'timber' : 'stone';
  const W = def.w, D = def.d;
  const pitch = Math.max(50, s.churchPitch);
  const hall: Rect = { x0: -W / 2 + 0.6, x1: W / 2 - 4.6, z0: -D / 2 + 0.82, z1: D / 2 - (q >= 2 ? 1.9 : 0.82) };
  const L = hall.x1 - hall.x0;
  const H = q >= 2 ? 5.2 : 4.4;
  const res = house(ctx, {
    rect: hall, plinthH: 0.35,
    storeys: [{ h: H, wall, frame: 'none', quoins: wall === 'stone', openings: [
      { side: 'pz', u: -L / 2 + 1.4, w: 1.2, h: 2.4, y: 0, kind: 'door', frame: fk, shape: 'pointed' },
      ...windowRow('pz', L, 4, { w: 1.0, h: 2.0, y: 1.5, kind: 'lancet', frame: fk, shape: 'pointed', shutters: false, mullions: 1, lit: 0.9 }, [-L / 2 + 1.4]),
      ...windowRow('nz', L, 4, { w: 1.0, h: 2.0, y: 1.5, kind: 'lancet', frame: fk, shape: 'pointed', shutters: false, mullions: 1 }),
      { side: 'nx', u: 0, w: 1.6, h: 2.6, y: 1.4, kind: 'big', frame: fk, shape: 'pointed', mullions: 2 },
    ] }],
    roof: { type: 'gable', pitch, mat, ov: 0.3, gov: 0.12, ridge: 'plain' },
    parapet: wall !== 'planks' ? (s.crowSteps ? 'crow' : 'coping') : undefined,
  });
  buttresses(ctx, hall.x0 + 0.4, hall.x1 - 0.4, hall.z1, 1, 4, H, col, (x) => Math.abs(x - (hall.x0 + 1.4)) < 1.0);
  buttresses(ctx, hall.x0 + 0.4, hall.x1 - 0.4, hall.z0, -1, 4, H, col);
  // Infirmary chapel at the east end.
  const ch: Rect = { x0: hall.x1, x1: W / 2 - 0.6, z0: hall.z0 + 0.6, z1: hall.z1 - 0.6 };
  house(ctx, {
    rect: ch, plinthH: 0.35,
    storeys: [{ h: H - 0.6, wall, frame: 'none', quoins: wall === 'stone', openings: [bigWindow('px', 0, 1.3, 1.4, 2.6), ...lancets('pz', ch.x1 - ch.x0, 1, 1.4, 1.8, 0.5)] }],
    roof: { type: 'gable', pitch, mat, ov: 0.3, gov: 0.12, ridge: 'plain' },
    parapet: wall !== 'planks' ? 'coping' : undefined,
  });
  chimney(ctx, { x: hall.x0 + L * 0.55, z: hall.z0 + 0.1, baseY: -0.3, topY: res.roof.topY + 0.7, w: 1.0, d: 0.6, baseW: 1.3, baseD: 0.7, shoulderY: H - 0.2, color: col, pots: 1 });
  bellcote(ctx, hall.x0 + 0.1, 0, res.roof.ridgeY - 0.3, false, col, mat);
  if (q >= 2 && lod < 2) {
    // Herb garden: raised beds with green plants and a low wattle edge in front.
    b.state({ layer: Layer.Decor, flags: F.Snow }, () => {
      for (let i = 0; i < 4; i++) {
        const x = hall.x0 + 1.8 + i * 2.6;
        if (Math.abs(x - (hall.x0 + 1.4)) < 1.2) continue;
        const z0 = hall.z1 + 0.3, z1 = D / 2 - 0.3;
        b.box(x - 1.0, 0, z0, x + 1.0, 0.25, z1, { side: 0x6a5032, top: 0x5a4632 });
        for (let k = 0; k < 4; k++) b.blob(x - 0.7 + k * 0.46, 0.38, (z0 + z1) / 2, 0.22, 0.18, 0.25, k % 2 ? 0x5f8a3a : 0x7a9a4a, 0.3, 0, i * 4 + k);
      }
    });
  }
  void enterSide;
}
