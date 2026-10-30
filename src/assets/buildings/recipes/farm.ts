// Farm buildings: barn, tithe barn, granary, cowshed, stable, sheepfold, pigsty, henhouse, dovecote.
import type { BuildingDef } from '../../../content/types';
import { F, Layer, Mat, shade, type V3 } from '../../core/builder';
import { decorInto } from '../../props/props';
import { cupola, enterSide, fenceRun, flagPole, house, opening, staddle, strawFloor, windowRow, type Ctx, type Opening, type Rect } from '../parts';
import { buildCone, buildRoof, roofLook, type RoofMat } from '../roof';
import { COL, roofTint, wallColor, type CultureStyle, type FrameKind, type WallKind } from '../style';
import { ovFor } from '../vernacular';

export function farmWall(s: CultureStyle, q: number): { wall: WallKind; frame: FrameKind } {
  switch (s.id) {
    case 'anglo': return { wall: 'weatherboard', frame: 'none' };
    case 'franc': return { wall: q >= 2 ? 'stone' : 'render', frame: 'none' };
    case 'teuton': return { wall: 'daub', frame: 'fachwerk' };
    case 'norse': return { wall: 'planks', frame: 'none' };
    case 'gael': return { wall: 'rubble', frame: 'none' };
    case 'cymric': return { wall: q >= 2 ? 'whitewash' : 'rubble', frame: 'none' };
  }
}

export function farmRoof(s: CultureStyle, q: number): RoofMat {
  return q >= 3 ? s.richRoof : s.farmRoof;
}

/** A gabled loft door breaking the eave (stables, barns, warehouses). */
export function loftGablet(ctx: Ctx, rc: Rect, eaveY: number, x: number, w: number, h: number, mat: RoofMat, pitch: number, wall: WallKind): void {
  const { b, s, lod } = ctx;
  const z1 = rc.z1;
  const g: Rect = { x0: x - w / 2, x1: x + w / 2, z0: z1 - 1.6, z1 };
  b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
    enterSide(b, g, 'pz', eaveY - 0.05);
    b.flat([[-w / 2, 0], [w / 2, 0], [w / 2, h], [-w / 2, h]], 0, wallColor(wall, s));
    b.pop();
    b.box(g.x0, eaveY - 0.05, g.z0, g.x0 + 0.02, eaveY + h, g.z1, wallColor(wall, s), 'b');
    b.box(g.x1 - 0.02, eaveY - 0.05, g.z0, g.x1, eaveY + h, g.z1, wallColor(wall, s), 'b');
  });
  enterSide(b, g, 'pz', eaveY - 0.05);
  opening(ctx, { side: 'pz', u: 0, w: w * 0.55, h: h * 0.8, y: 0.05, kind: 'window', frame: 'timber', shutters: true, mullions: 0, lit: 0.15 });
  b.pop();
  const look = roofLook(mat, roofTint(mat, s));
  buildRoof(b, { x0: g.x0, x1: g.x1, z0: g.z0, z1: g.z1, eaveY: eaveY + h, type: 'gable', axis: 'z', pitch, ov: 0.18, gov: 0.15, ridge: 'plain', frame: false }, { ...look, thickness: Math.min(look.thickness, 0.3) }, lod);
  if (lod === 0) b.state({ layer: Layer.Detail, flags: F.Burn }, () => b.beam([x, eaveY + h + 0.2, z1 - 0.2], [x, eaveY + h + 0.2, z1 + 0.3], 0.12, 0.14, s.timber));
}

export function barn(ctx: Ctx, def: BuildingDef): void {
  const { s, level: q, b, lod } = ctx;
  const { wall, frame } = farmWall(s, q);
  const mat = farmRoof(s, q);
  const { ov, gov } = ovFor(mat);
  const porchD = q >= 2 ? 1.7 : 0;
  const leanW = q >= 3 ? 2.6 : 0;
  const endIn = (s.id === 'gael' ? ov : gov) + 0.14;
  const rect: Rect = { x0: -def.w / 2 + endIn, x1: def.w / 2 - endIn - leanW, z0: -def.d / 2 + ov + 0.14, z1: def.d / 2 - Math.max(ov + 0.14, 0.62) - porchD };
  const H = 3.5 + (q - 1) * 0.3;
  const L = rect.x1 - rect.x0;
  const cx = (rect.x0 + rect.x1) / 2;
  const ops: Opening[] = [
    { side: 'nz', u: 0, w: 2.6, h: 2.9, y: 0, kind: 'wide', frame: 'timber', open: true },
    { side: 'px', u: 0, w: 0.35, h: 0.9, y: H * 0.55, kind: 'slit', frame: 'timber', lit: 0.05 },
    { side: 'nx', u: 0, w: 0.35, h: 0.9, y: H * 0.55, kind: 'slit', frame: 'timber', lit: 0.05 },
  ];
  if (!porchD) ops.push({ side: 'pz', u: 0, w: 2.8, h: 3.0, y: 0, kind: 'wide', frame: 'timber' });
  else {
    ops.push({ side: 'pz', u: -L / 2 + 1.2, w: 0.9, h: 1.9, y: 0, kind: 'door', frame: 'timber' });
    ops.push(...windowRow('pz', L, 4, { w: 0.3, h: 0.8, y: H * 0.55, kind: 'slit', frame: 'timber', shutters: false, lit: 0.05 }, [0, -L / 2 + 1.2]));
  }
  const res = house(ctx, {
    rect, plinthH: q >= 2 ? 0.55 : 0.3, plinthColor: s.id === 'anglo' ? COL.brick : s.plinth,
    storeys: [{ h: H, wall, frame, openings: ops }],
    roof: { type: s.id === 'gael' ? 'hip' : q >= 2 && s.id === 'anglo' ? 'halfhip' : 'gable', pitch: Math.min(56, s.pitch + 3), mat, ov, gov, ridge: 'plain' },
  });
  if (porchD) {
    // Midstrey: a gabled wagon porch over the threshing-floor doors.
    const pw = 4.6;
    const pr: Rect = { x0: cx - pw / 2, x1: cx + pw / 2, z0: rect.z1 - 0.2, z1: rect.z1 + porchD };
    house(ctx, {
      rect: pr, plinthH: 0.3, plinthColor: s.plinth, noFloor: true,
      storeys: [{ h: H - 0.2, wall, frame, openings: [{ side: 'pz', u: 0, w: 2.9, h: H - 0.6, y: 0, kind: 'wide', frame: 'timber' }] }],
      roof: { type: 'gable', axis: 'z', pitch: Math.min(56, s.pitch + 3), mat, ov: 0.3, gov: 0.18, ridge: 'plain' },
    });
  }
  if (leanW) {
    // Open cart shed lean-to on the +x gable with a wagon inside.
    const lr: Rect = { x0: rect.x1, x1: rect.x1 + leanW - 0.15, z0: rect.z0 + 0.2, z1: rect.z1 + porchD * 0.4 };
    house(ctx, {
      rect: lr, plinthH: 0, noFloor: true,
      storeys: [{ h: 2.4, wall, frame: 'none', open: ['pz'], postSpacing: 2.2 }],
      roof: { type: 'shed', low: 'px', pitch: 24, mat: mat === 'heather' ? 'thatch' : mat, ov: 0.25, gov: 0.15, frame: false },
    });
    strawFloor(b, lr);
    if (lod === 0) {
      b.push(); b.layer = Layer.Decor; b.translate((lr.x0 + lr.x1) / 2, 0, (lr.z0 + lr.z1) / 2 + 0.4); b.scale(0.8, 0.8, 0.8); decorInto(b, 'cart', ctx.seed); b.layer = Layer.Wall; b.pop();
    }
  }
  void res;
}

export function titheBarn(ctx: Ctx, def: BuildingDef): void {
  const { s, b, lod } = ctx;
  const mat: RoofMat = s.id === 'norse' ? 'shingle' : s.id === 'teuton' ? 'tile' : s.id === 'franc' || s.id === 'cymric' ? 'slate' : 'stoneslate';
  const porchD = 2.1;
  const rect: Rect = { x0: -def.w / 2 + 0.45, x1: def.w / 2 - 0.45, z0: -def.d / 2 + 0.88, z1: def.d / 2 - 0.4 - porchD };
  const H = 5.6;
  const stoneW: WallKind = s.id === 'norse' ? 'planks' : s.id === 'cymric' ? 'rubble' : 'stone';
  const L = rect.x1 - rect.x0;
  const res = house(ctx, {
    rect, plinthH: 0.4,
    storeys: [{ h: H, wall: stoneW, quoins: stoneW === 'stone', openings: [
      ...windowRow('pz', L, 8, { w: 0.25, h: 1.1, y: 2.6, kind: 'slit', frame: 'stone', shutters: false, lit: 0.05 }, [-6, 6]),
      ...windowRow('nz', L, 8, { w: 0.25, h: 1.1, y: 2.6, kind: 'slit', frame: 'stone', shutters: false, lit: 0.05 }),
      { side: 'nz', u: 0, w: 3.0, h: 3.6, y: 0, kind: 'wide', frame: 'stone', shape: 'pointed', open: true },
      { side: 'px', u: 0, w: 0.5, h: 0.9, y: H + 1.5, kind: 'slit', frame: 'stone', lit: 0.05 },
      { side: 'nx', u: 0, w: 0.5, h: 0.9, y: H + 1.5, kind: 'slit', frame: 'stone', lit: 0.05 },
    ] }],
    roof: { type: 'gable', pitch: 52, mat, ov: 0.3, gov: 0.1, ridge: 'plain' },
    parapet: stoneW === 'stone' ? (s.crowSteps ? 'crow' : 'coping') : undefined,
  });
  // Buttresses along both long walls.
  b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
    const n = 6;
    for (let i = 0; i <= n; i++) {
      const x = rect.x0 + 0.4 + ((L - 0.8) * i) / n;
      if (Math.abs(x - 6) < 2.8 || Math.abs(x + 6) < 2.8) continue;
      for (const [z, dir] of [[rect.z1, 1], [rect.z0, -1]] as [number, number][]) {
        const z0 = dir > 0 ? z : z - 0.75, z1 = dir > 0 ? z + 0.75 : z;
        b.taperBox(x - 0.32, -0.3, z0, x + 0.32, H * 0.55, z1, 0.02, 0.12, s.stone);
        b.taperBox(x - 0.3, H * 0.55, dir > 0 ? z : z - 0.5, x + 0.3, H * 0.85, dir > 0 ? z + 0.5 : z, 0.03, 0.22, { side: s.stone, top: s.stoneTrim });
      }
    }
  });
  // Two porches with tall arched wagon doors.
  for (const px of [-6, 6]) {
    const pr: Rect = { x0: px - 2.6, x1: px + 2.6, z0: rect.z1 - 0.2, z1: rect.z1 + porchD };
    house(ctx, {
      rect: pr, plinthH: 0.4, noFloor: true,
      storeys: [{ h: H - 0.4, wall: stoneW, quoins: stoneW === 'stone', openings: [{ side: 'pz', u: 0, w: 3.2, h: 4.2, y: 0, kind: 'wide', frame: 'stone', shape: 'pointed', open: true }] }],
      roof: { type: 'gable', axis: 'z', pitch: 52, mat, ov: 0.25, gov: 0.1, ridge: 'plain' },
      parapet: stoneW === 'stone' ? (s.crowSteps ? 'crow' : 'coping') : undefined,
    });
  }
  // Cross finials on the main gables.
  if (lod < 2) b.state({ layer: Layer.Detail, flags: F.Snow }, () => {
    for (const x of [rect.x0 + 0.1, rect.x1 - 0.1]) {
      const y = res.roof.ridgeY + 0.6;
      b.box(x - 0.1, y, -0.1, x + 0.1, y + 1.1, 0.1, s.stoneTrim);
      b.box(x - 0.1, y + 0.6, -0.42, x + 0.1, y + 0.8, 0.42, s.stoneTrim);
    }
  });
}

export function granary(ctx: Ctx, def: BuildingDef): void {
  const { s, level: q, b, lod } = ctx;
  const mat: RoofMat = q >= 2 ? (s.id === 'norse' ? 'shingle' : s.id === 'gael' ? 'slate' : s.richRoof === 'slate' ? 'slate' : 'tile') : s.id === 'norse' ? 'shingle' : s.id === 'gael' ? 'heather' : 'thatch';
  const { ov } = ovFor(mat);
  const half = def.w / 2 - ov - 0.15;
  const rect: Rect = { x0: -half, x1: half, z0: -half, z1: half - 0.75 };
  const lift = 0.85;
  // Staddle stones and a timber floor frame.
  b.state({ layer: Layer.Ground, flags: F.Snow }, () => {
    const n = q >= 2 ? 3 : 3;
    for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) {
      staddle(b, rect.x0 + 0.35 + ((rect.x1 - rect.x0 - 0.7) * i) / (n - 1), rect.z0 + 0.35 + ((rect.z1 - rect.z0 - 0.7) * k) / (n - 1), lift - 0.12, COL.stoneGrey);
    }
  });
  b.state({ layer: Layer.Frame, flags: F.Snow | F.Burn }, () => b.box(rect.x0 - 0.05, lift - 0.14, rect.z0 - 0.05, rect.x1 + 0.05, lift + 0.02, rect.z1 + 0.05, s.timber));
  const { wall, frame } = farmWall(s, 1);
  const w2: WallKind = wall === 'stone' || wall === 'rubble' || wall === 'whitewash' ? 'weatherboard' : wall;
  b.push();
  b.translate(0, lift, 0);
  const res = house(ctx, {
    rect, plinthH: 0, noFloor: true,
    storeys: [{ h: q >= 2 ? 2.6 : 2.2, wall: w2, frame: s.id === 'teuton' ? 'fachwerk' : frame === 'fachwerk' ? 'fachwerk' : 'none', openings: [
      { side: 'pz', u: 0, w: 0.85, h: 1.6, y: 0, kind: 'door', frame: 'timber' },
      { side: 'px', u: 0, w: 0.35, h: 0.3, y: 1.5, kind: 'slit', frame: 'timber', lit: 0.05 },
    ] }],
    roof: { type: q >= 2 ? 'hip' : 'pyramid', pitch: 48, mat, ov, gov: ov, ridge: 'plain' },
  });
  b.pop();
  // Detached stone steps (keeps the rats out).
  b.state({ layer: Layer.Ground, flags: F.Snow }, () => {
    for (let i = 0; i < 3; i++) b.box(-0.45, -0.3, rect.z1 + 0.22 + i * 0.28, 0.45, lift - 0.08 - i * 0.25, rect.z1 + 0.5 + i * 0.28, { side: COL.stoneGrey, top: COL.stone });
  });
  ctx.out.doors.length = 0;
  ctx.out.doors.push({ x: 0, z: rect.z1 + 1.2 });
  if (q >= 2 && lod === 0) cupola(ctx, 0, 0, res.roof.topY - 0.2, 0.7, 0.55, mat, { open: false });
}

export function cowshed(ctx: Ctx, def: BuildingDef): void {
  const { s, level: q, b, lod } = ctx;
  const { wall, frame } = farmWall(s, q);
  const mat = farmRoof(s, q);
  const { ov, gov } = ovFor(mat);
  const endIn = (s.id === 'gael' ? ov : gov) + 0.14;
  const rect: Rect = { x0: -def.w / 2 + endIn, x1: def.w / 2 - endIn, z0: -def.d / 2 + ov + 0.14, z1: def.d / 2 - ov - 0.16 };
  const L = rect.x1 - rect.x0;
  if (q === 1) {
    // Open-fronted byre under a lean-to roof.
    house(ctx, {
      rect, plinthH: 0.15, noFloor: true,
      storeys: [{ h: 2.5, wall: wall === 'weatherboard' ? 'wattle' : wall, frame, open: ['pz'], postSpacing: 2.4, openings: [] }],
      roof: { type: 'shed', low: 'pz', pitch: 22, mat, ov, gov, ridge: 'plain' },
    });
    strawFloor(b, rect);
    // Hay rack along the back wall.
    if (lod === 0) b.state({ layer: Layer.Detail, flags: F.Burn }, () => {
      for (let i = 0; i < 14; i++) {
        const x = rect.x0 + 0.4 + ((L - 0.8) * i) / 13;
        b.beam([x, 1.0, rect.z0 + 0.15], [x, 1.9, rect.z0 + 0.65], 0.04, 0.04, COL.timberRaw);
      }
      b.box(rect.x0 + 0.3, 1.0, rect.z0 + 0.1, rect.x1 - 0.3, 1.1, rect.z0 + 0.25, s.timber);
      b.box(rect.x0 + 0.3, 1.85, rect.z0 + 0.55, rect.x1 - 0.3, 1.95, rect.z0 + 0.7, s.timber);
      b.blob((rect.x0 + rect.x1) / 2, 1.5, rect.z0 + 0.35, L * 0.35, 0.35, 0.25, COL.hay, 0.3);
    });
    return;
  }
  const res = house(ctx, {
    rect, plinthH: 0.3,
    storeys: [{ h: 2.7, wall, frame, openings: [
      { side: 'pz', u: -L / 4, w: 1.2, h: 2.0, y: 0, kind: 'door', frame: 'timber' },
      { side: 'pz', u: L / 4, w: 1.2, h: 2.0, y: 0, kind: 'door', frame: 'timber' },
      { side: 'pz', u: 0, w: 0.5, h: 0.4, y: 1.5, kind: 'slit', frame: 'timber', lit: 0.05 },
      { side: 'nz', u: 0, w: 0.6, h: 0.4, y: 1.5, kind: 'slit', frame: 'timber', lit: 0.05 },
    ] }],
    roof: { type: s.id === 'gael' ? 'hip' : 'gable', pitch: s.pitch, mat, ov, gov, ridge: 'plain' },
  });
  loftGablet(ctx, rect, res.eaveY, 0, 1.6, 1.2, mat === 'heather' ? 'thatch' : mat, s.pitch, wall);
}

export function stable(ctx: Ctx, def: BuildingDef): void {
  const { s, level: q, lod } = ctx;
  const base = farmWall(s, q);
  const wall: WallKind = q >= 3 && s.id !== 'norse' ? (s.id === 'cymric' || s.id === 'gael' ? 'whitewash' : 'stone') : base.wall;
  const frame: FrameKind = wall === 'stone' || wall === 'whitewash' ? 'none' : base.frame;
  const mat = q >= 3 ? s.richRoof : q === 2 && s.farmRoof === 'thatch' ? 'thatch' : s.farmRoof;
  const { ov, gov } = ovFor(mat);
  const endIn = (s.id === 'gael' ? ov : gov) + 0.14;
  const rect: Rect = { x0: -def.w / 2 + endIn, x1: def.w / 2 - endIn, z0: -def.d / 2 + ov + 0.14, z1: def.d / 2 - 0.7 };
  const L = rect.x1 - rect.x0;
  const stalls = q === 1 ? 3 : 4;
  const ops: Opening[] = [];
  for (let i = 0; i < stalls; i++) {
    const u = -L / 2 + (L * (i + 0.5)) / stalls;
    // Split stable door: lower leaf shut, upper half open (dark).
    ops.push({ side: 'pz', u, w: 1.05, h: 1.15, y: 0, kind: 'door', frame: 'timber' });
    ops.push({ side: 'pz', u, w: 1.05, h: 0.85, y: 1.2, kind: 'window', frame: 'timber', mullions: 0, lit: 0.12 });
  }
  ops.push({ side: 'nx', u: 0, w: 0.6, h: 0.5, y: 1.4, kind: 'window', frame: wall === 'stone' ? 'stone' : 'timber', shutters: true });
  ops.push({ side: 'px', u: 0, w: 0.9, h: 1.9, y: 0, kind: 'door', frame: wall === 'stone' ? 'stone' : 'timber' });
  const res = house(ctx, {
    rect, plinthH: 0.25,
    storeys: [{ h: 2.8, wall, frame, openings: ops, quoins: wall === 'stone' }],
    roof: { type: s.id === 'gael' ? 'hip' : 'gable', pitch: s.pitch, mat, ov, gov, ridge: 'plain' },
    parapet: wall === 'stone' && s.crowSteps ? 'crow' : undefined,
  });
  if (q >= 2) loftGablet(ctx, rect, res.eaveY, 0, 1.7, 1.3, mat === 'heather' ? 'thatch' : mat, s.pitch, wall === 'stone' ? 'stone' : wall);
  if (q >= 3 && lod < 2) cupola(ctx, rect.x1 - 2, (rect.z0 + rect.z1) / 2, res.roof.topY - 0.25, 0.9, 0.8, mat, {});
  if (lod === 0) { const b = ctx.b; b.push(); b.layer = Layer.Decor; b.translate(rect.x0 + 1.1, 0, rect.z1 + 0.36); b.scale(0.9, 0.9, 0.9); decorInto(b, 'trough', ctx.seed); b.layer = Layer.Wall; b.pop(); }
}

export function sheepfold(ctx: Ctx, def: BuildingDef): void {
  const { s, level: q, b, lod } = ctx;
  const hw = def.w / 2 - 0.45, hd = def.d / 2 - 0.45;
  const kind = q >= 2 ? 'drystone' : 'wattle';
  fenceRun(ctx, -hw, hd, hw, hd, kind, 2.4);
  fenceRun(ctx, hw, hd, hw, -hd, kind);
  fenceRun(ctx, hw, -hd, -hw, -hd, kind);
  fenceRun(ctx, -hw, -hd, -hw, hd, kind);
  if (q >= 2) fenceRun(ctx, 1.5, -hd, 1.5, 0.8, 'drystone');
  ctx.out.doors.push({ x: 0, z: hd + 0.6 });
  // Shelter in the back corner.
  const sr: Rect = { x0: -hw + 0.4, x1: -hw + 4.2, z0: -hd + 0.4, z1: -hd + 2.8 };
  const mat: RoofMat = q >= 2 ? (s.id === 'anglo' ? 'stoneslate' : s.farmRoof === 'heather' ? 'heather' : s.richRoof === 'tile' ? 'tile' : 'slate') : s.farmRoof;
  house(ctx, {
    rect: sr, plinthH: 0.1, noFloor: true,
    storeys: [{ h: 1.9, wall: q >= 2 ? 'rubble' : 'wattle', frame: 'none', open: ['pz'], postSpacing: 1.8 }],
    roof: { type: 'shed', low: 'pz', pitch: 22, mat, ov: 0.3, gov: 0.2, frame: false },
  });
  strawFloor(b, sr);
  if (lod === 0) {
    b.push(); b.layer = Layer.Decor; b.translate(2.5, 0, -1.5); decorInto(b, 'trough', ctx.seed); b.layer = Layer.Wall; b.pop();
    b.state({ layer: Layer.Decor, flags: F.Burn | F.Snow }, () => {
      // V-shaped hay rack
      for (const sd of [-1, 1]) b.beam([-1.2, 0.5, 2 + sd * 0.05], [1.2, 1.2, 2 + sd * 0.45], 0.05, 0.05, COL.timberRaw);
      b.blob(0, 1.0, 2, 1.0, 0.25, 0.3, COL.hay, 0.3);
    });
  }
}

export function pigsty(ctx: Ctx, def: BuildingDef): void {
  const { s, b, lod } = ctx;
  const wall: WallKind = s.id === 'norse' ? 'planks' : s.id === 'anglo' || s.id === 'teuton' ? 'rubble' : 'rubble';
  const mat: RoofMat = s.id === 'norse' ? 'turf' : s.id === 'gael' ? 'heather' : s.id === 'anglo' ? 'thatch' : s.richRoof === 'slate' ? 'slate' : 'tile';
  const hut: Rect = { x0: -def.w / 2 + 0.35, x1: def.w / 2 - 0.35, z0: -def.d / 2 + 0.35, z1: -def.d / 2 + 2.3 };
  house(ctx, {
    rect: hut, plinthH: 0.1,
    storeys: [{ h: 1.45, wall, frame: 'none', openings: [
      { side: 'pz', u: -1.2, w: 0.65, h: 0.95, y: 0, kind: 'door', frame: 'timber', open: true },
      { side: 'pz', u: 1.2, w: 0.65, h: 0.95, y: 0, kind: 'door', frame: 'timber', open: true },
    ] }],
    roof: { type: 'shed', low: 'pz', pitch: 24, mat, ov: 0.3, gov: 0.15, frame: false },
  });
  // Walled pen with a mud floor and a stone trough.
  const pz1 = def.d / 2 - 0.3;
  b.state({ layer: Layer.Ground, flags: F.NoAO }, () => b.box(hut.x0, -0.05, hut.z1, hut.x1, 0.03, pz1, { top: COL.mud, side: COL.mud }, 'b'));
  fenceRun(ctx, hut.x0 + 0.1, hut.z1, hut.x0 + 0.1, pz1, s.id === 'norse' ? 'wattle' : 'drystone');
  fenceRun(ctx, hut.x1 - 0.1, pz1, hut.x1 - 0.1, hut.z1, s.id === 'norse' ? 'wattle' : 'drystone');
  fenceRun(ctx, hut.x0 + 0.1, pz1, hut.x1 - 0.1, pz1, s.id === 'norse' ? 'wattle' : 'drystone', 1.1);
  if (lod === 0) b.state({ layer: Layer.Decor, flags: F.Snow }, () => {
    b.box(0.6, 0, hut.z1 + 0.6, 1.7, 0.35, hut.z1 + 1.05, { side: COL.stoneGrey, top: COL.stone });
    b.state({ mat: Mat.Water }, () => b.box(0.7, 0.2, hut.z1 + 0.68, 1.6, 0.3, hut.z1 + 0.97, COL.waterMurk, 'b'));
  });
  ctx.out.doors.push({ x: 0, z: pz1 + 0.5 });
}

export function henhouse(ctx: Ctx, def: BuildingDef): void {
  const { s, b, lod } = ctx;
  const mat: RoofMat = s.id === 'norse' ? 'turf' : s.id === 'anglo' || s.id === 'franc' ? 'thatch' : s.id === 'gael' ? 'heather' : 'plank';
  const coop: Rect = { x0: -0.95, x1: 0.95, z0: -1.25, z1: 0.05 };
  b.state({ layer: Layer.Wall, flags: F.Snow | F.Burn }, () => {
    for (const [x, z] of [[coop.x0 + 0.1, coop.z0 + 0.1], [coop.x1 - 0.1, coop.z0 + 0.1], [coop.x0 + 0.1, coop.z1 - 0.1], [coop.x1 - 0.1, coop.z1 - 0.1]] as [number, number][]) {
      b.box(x - 0.06, -0.3, z - 0.06, x + 0.06, 0.55, z + 0.06, s.timber);
    }
  });
  b.push();
  b.translate(0, 0.55, 0);
  house(ctx, {
    rect: coop, plinthH: 0, noFloor: true,
    storeys: [{ h: 1.0, wall: s.id === 'teuton' ? 'daub' : 'planks', frame: s.id === 'teuton' ? 'fachwerk' : 'none', color: s.id === 'norse' ? COL.plankTar : COL.plank, openings: [
      { side: 'pz', u: 0.45, w: 0.32, h: 0.4, y: 0.05, kind: 'door', frame: 'timber', open: true },
      { side: 'px', u: 0, w: 0.3, h: 0.25, y: 0.6, kind: 'slit', frame: 'timber', lit: 0.05 },
    ] }],
    roof: { type: 'gable', pitch: 42, mat, ov: 0.2, gov: 0.15, ridge: 'plain', frame: false },
  });
  b.pop();
  ctx.out.doors.length = 0;
  b.state({ layer: Layer.Detail, flags: F.Burn | F.Snow }, () => {
    // Ramp with cleats.
    const a: V3 = [0.45, 0.58, coop.z1 + 0.02], c: V3 = [0.45, 0.0, coop.z1 + 1.0];
    b.beam(a, c, 0.32, 0.04, COL.timberRaw);
    if (lod === 0) for (let i = 1; i < 5; i++) { const t = i / 5; b.box(0.3, a[1] + (c[1] - a[1]) * t, a[2] + (c[2] - a[2]) * t - 0.02, 0.6, a[1] + (c[1] - a[1]) * t + 0.03, a[2] + (c[2] - a[2]) * t + 0.02, COL.timber); }
  });
  // Low wattle run.
  fenceRun(ctx, -1.35, 1.3, 1.35, 1.3, 'wattle', 0.7);
  ctx.out.doors.push({ x: 0, z: 1.7 });
}

export function dovecote(ctx: Ctx, def: BuildingDef): void {
  const { s, b, lod } = ctx;
  void def;
  if (s.id === 'norse' || s.id === 'teuton') {
    // Square timber dovecote on a post frame.
    const r: Rect = { x0: -1.2, x1: 1.2, z0: -1.2, z1: 1.2 };
    b.state({ layer: Layer.Wall, flags: F.Burn | F.Snow }, () => {
      for (const [x, z] of [[-0.9, -0.9], [0.9, -0.9], [0.9, 0.9], [-0.9, 0.9]] as [number, number][]) b.box(x - 0.1, -0.3, z - 0.1, x + 0.1, 2.4, z + 0.1, s.timber);
      b.beam([-0.9, 0.4, 0.9], [0.9, 2.2, 0.9], 0.1, 0.1, s.timber);
    });
    b.push();
    b.translate(0, 2.4, 0);
    house(ctx, {
      rect: r, plinthH: 0, noFloor: true,
      storeys: [{ h: 2.2, wall: s.id === 'teuton' ? 'daub' : 'planks', frame: s.id === 'teuton' ? 'fachwerk' : 'none', openings: [
        ...[-0.6, 0, 0.6].map((u) => ({ side: 'pz' as const, u, w: 0.18, h: 0.18, y: 1.5, kind: 'slit' as const, frame: 'timber' as const, lit: 0.02 })),
        ...[-0.6, 0, 0.6].map((u) => ({ side: 'px' as const, u, w: 0.18, h: 0.18, y: 1.5, kind: 'slit' as const, frame: 'timber' as const, lit: 0.02 })),
      ] }],
      roof: { type: 'pyramid', pitch: 50, mat: s.id === 'norse' ? 'shingle' : 'tile', ov: 0.3, gov: 0.3, ridge: 'plain' },
    });
    b.pop();
    ctx.out.doors.push({ x: 0, z: 1.6 });
    return;
  }
  // Round stone dovecote with a conical roof and a glover (lantern).
  const R = 1.7, H = 4.6;
  const wallCol = s.id === 'cymric' ? COL.limewash : s.id === 'gael' ? COL.stoneGrey : s.stone;
  b.push();
  b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
    b.lathe([[R + 0.12, -0.6], [R + 0.12, 0.35], [R, 0.6], [R, 2.9], [R + 0.1, 2.95], [R + 0.1, 3.15], [R, 3.2], [R, H]], lod === 0 ? 14 : 8,
      [shade(wallCol, 0.85), shade(wallCol, 0.95), wallCol, s.stoneTrim, s.stoneTrim, shade(wallCol, 0.95), wallCol], { capTop: false });
  });
  b.pop();
  // Door and flight holes.
  b.push();
  b.translate(0, 0, R);
  b.state({ layer: Layer.Detail, flags: F.Burn | F.Snow }, () => {
    b.flat([[-0.38, 0.05], [0.38, 0.05], [0.38, 1.55], [0, 1.75], [-0.38, 1.55]], 0.03, s.stoneTrim);
    b.flat([[-0.3, 0.05], [0.3, 0.05], [0.3, 1.5], [0, 1.66], [-0.3, 1.5]], 0.045, pickDoor(s));
  });
  b.pop();
  if (lod === 0) b.state({ layer: Layer.Detail, flags: F.NoAO }, () => {
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + 0.26;
      b.push(); b.translate(Math.cos(a) * (R + 0.01), 0, Math.sin(a) * (R + 0.01)); b.rotY(Math.PI / 2 - a);
      b.quad([-0.08, 3.6, 0], [0.08, 3.6, 0], [0.08, 3.78, 0], [-0.08, 3.78, 0], 0x1d1712);
      b.pop();
    }
  });
  ctx.out.doors.push({ x: 0, z: R + 0.55 });
  const mat: RoofMat = s.id === 'franc' ? 'slate' : s.id === 'cymric' ? 'slate' : s.id === 'gael' ? 'heather' : 'tile';
  const look = roofLook(mat, roofTint(mat, s));
  const top = buildCone(b, 0, 0, H, R, 2.2, lod === 0 ? 14 : 8, look, 0.32, lod);
  // Glover: a little open lantern on the apex for the birds.
  b.state({ layer: Layer.Roof, flags: F.Snow | F.Burn }, () => {
    b.cyl(0, 0, top - 0.35, top + 0.25, 0.32, 0.32, 6, { side: s.timber, top: s.timber }, { top: false });
    b.cyl(0, 0, top + 0.25, top + 0.75, 0.45, 0.0, 6, shade(look.top[0], 0.95));
  });
  void flagPole;
}

function pickDoor(s: CultureStyle): number { return s.doors[0]; }
