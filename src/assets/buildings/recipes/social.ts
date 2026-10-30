// Social and trade: alehouse, tavern, market stall, market cross, market hall, guildhall, warehouse.
import type { BuildingDef } from '../../../content/types';
import { F, Layer, Mat, shade, type V2 } from '../../core/builder';
import { clothQuad, decorInto } from '../../props/props';
import { chimney, cupola, enterSide, flagPole, house, opening, pick, windowRow, type Ctx, type Opening, type Rect } from '../parts';
import { buildRoof, roofLook, type RoofMat } from '../roof';
import { COL, roofTint, type FrameKind, type WallKind } from '../style';
import { ovFor, vernacular } from '../vernacular';
import { aleStake, hangingSign } from './work';
import { loftGablet } from './farm';

function decor(ctx: Ctx, kind: Parameters<typeof decorInto>[1], x: number, z: number, rot = 0, s = 1): void {
  if (ctx.lod !== 0) return;
  const b = ctx.b;
  b.push(); b.layer = Layer.Decor; b.translate(x, 0, z); b.rotY(rot); if (s !== 1) b.scale(s, s, s);
  decorInto(b, kind, ctx.seed + Math.round(x * 7 + z * 13));
  b.layer = Layer.Wall; b.pop();
}

/** Town timber/stone pick for a culture at a quality. */
function townWalls(ctx: Ctx, q: number): { ground: WallKind; upper: WallKind; frame: FrameKind; mat: RoofMat } {
  const { s } = ctx;
  const stoneTown = s.id === 'gael' || s.id === 'cymric';
  const ground: WallKind = stoneTown ? (s.id === 'cymric' ? 'whitewash' : 'rubble') : s.id === 'norse' ? 'planks' : q >= 3 && s.id === 'franc' ? 'stone' : 'daub';
  const upper: WallKind = s.id === 'norse' ? 'planks' : stoneTown ? 'whitewash' : 'daub';
  const frame: FrameKind = s.id === 'teuton' ? 'fachwerk' : s.id === 'norse' || stoneTown ? 'none' : q >= 2 ? 'close' : 'box';
  const mat: RoofMat = q >= 2 ? s.richRoof : s.homeRoof[0] === 'heather' ? 'thatch' : s.homeRoof[0];
  return { ground, upper, frame, mat };
}

export function alehouse(ctx: Ctx, def: BuildingDef): void {
  const { level: q } = ctx;
  const res = vernacular(ctx, {
    W: def.w, D: def.d, q: q + 0, storeys: q >= 2 ? 2 : 1, jetty: q >= 2 ? 0.35 : 0,
    chimney: 'gable', frontWindows: 2, doorAt: 0.05,
    decor: ['bench', 'barrel'],
  });
  aleStake(ctx, res.rect.x1 - 0.8, res.bases[0] + 2.35, res.rect.z1);
}

export function tavern(ctx: Ctx, def: BuildingDef): void {
  const { s, level: q, b, lod } = ctx;
  const tw = townWalls(ctx, q);
  const mat = tw.mat;
  const { ov, gov } = ovFor(mat);
  const W = def.w, D = def.d;
  const wing = q >= 2 ? 4.2 : 0;
  const rect: Rect = { x0: -W / 2 + gov + 0.15, x1: W / 2 - gov - 0.15 - wing, z0: -D / 2 + ov + 0.15, z1: D / 2 - 1.15 - (q >= 2 ? 0.45 : 0) };
  const L = rect.x1 - rect.x0;
  const doorU = -0.6;
  const fk = tw.ground === 'stone' ? 'stone' : 'timber';
  const storeys = [
    { h: 2.8, wall: tw.ground, frame: tw.frame, quoins: tw.ground === 'stone', openings: [
      { side: 'pz' as const, u: doorU, w: 1.15, h: 2.1, y: 0, kind: 'door' as const, frame: fk as 'stone' | 'timber', shape: (tw.ground === 'stone' ? 'pointed' : 'tudor') as 'pointed' | 'tudor' },
      ...windowRow('pz', L, 4, { w: 1.1, h: 0.85, y: 1.0, frame: fk as 'timber', shutters: fk === 'timber', mullions: 2, lit: 1 }, [doorU]),
      ...windowRow('nz', L, 2, { w: 0.9, h: 0.75, y: 1.1, frame: fk as 'timber', shutters: false }),
      { side: 'nx' as const, u: 0, w: 0.9, h: 0.75, y: 1.1, kind: 'window' as const, frame: fk as 'timber', shutters: true },
    ] },
    { h: 2.5, wall: tw.upper, frame: tw.frame === 'box' ? 'close' as FrameKind : tw.frame, jetty: s.id === 'norse' ? undefined : { pz: 0.42 }, openings: [
      ...windowRow('pz', L, 4, { w: 1.0, h: 0.8, y: 0.75, frame: 'timber', shutters: s.id !== 'norse', mullions: 2, lit: 0.9 }),
      ...windowRow('nz', L, 1, { w: 0.8, h: 0.7, y: 0.8, frame: 'timber', shutters: false }),
    ] },
  ];
  if (q >= 3) storeys.push({ h: 2.3, wall: tw.upper, frame: storeys[1].frame === 'close' ? 'square' : storeys[1].frame, jetty: s.id === 'norse' ? undefined : { pz: 0.4 }, openings: windowRow('pz', L, 3, { w: 0.9, h: 0.75, y: 0.7, frame: 'timber', shutters: false, mullions: 2, lit: 0.8 }) } as never);
  const res = house(ctx, { rect, plinthH: 0.3, storeys, roof: { type: 'gable', pitch: Math.max(48, s.pitch), mat, ov, gov, ridge: q >= 2 && mat === 'thatch' ? 'scallop' : 'plain' }, parapet: s.crowSteps && tw.ground !== 'daub' ? 'crow' : undefined });
  chimney(ctx, { x: rect.x0 + L * 0.22, z: (rect.z0 + rect.z1) / 2 - 0.4, baseY: res.eaveY - 1, topY: res.roof.topY + 0.8, w: 0.8, d: 0.8, color: COL.brick, pots: q >= 2 ? 2 : 0 });
  chimney(ctx, { x: rect.x1 - L * 0.2, z: (rect.z0 + rect.z1) / 2 - 0.4, baseY: res.eaveY - 1, topY: res.roof.topY + 0.8, w: 0.8, d: 0.8, color: COL.brick, pots: q >= 2 ? 2 : 0 });
  if (q >= 2) loftGablet(ctx, res.rects[res.rects.length - 1], res.eaveY, 0.8, 2.2, 1.6, mat === 'heather' ? 'thatch' : mat, Math.max(48, s.pitch), tw.upper);
  // Side wing: stable / brewhouse range with a cart arch.
  if (wing) {
    const wr: Rect = { x0: rect.x1, x1: W / 2 - 0.3, z0: rect.z0 + 0.5, z1: rect.z1 - 0.2 };
    const wmat: RoofMat = mat;
    house(ctx, {
      rect: wr, plinthH: 0.25,
      storeys: [{ h: 3.2, wall: tw.ground === 'stone' ? 'stone' : s.id === 'norse' ? 'planks' : 'weatherboard', frame: 'none', openings: [
        { side: 'pz', u: 0, w: 2.4, h: 2.7, y: 0, kind: 'wide', frame: 'timber', open: true },
        { side: 'px', u: 0, w: 0.7, h: 0.6, y: 1.6, kind: 'window', frame: 'timber', shutters: true },
      ] }],
      roof: { type: 'gable', axis: 'z', pitch: Math.max(48, s.pitch), mat: wmat, ov: 0.3, gov: 0.25, ridge: 'plain' },
    });
  }
  // Hanging sign, ale-stake, benches and barrels.
  hangingSign(ctx, rect.x0 + 0.4, res.bases[1] - 0.1, rect.z1, 'tankard');
  aleStake(ctx, rect.x1 - 0.6, res.bases[1] + 0.3, res.rects[1].z1);
  decor(ctx, 'bench', rect.x0 + 2.1, rect.z1 + 0.35);
  decor(ctx, 'barrel', rect.x1 - 1.4, rect.z1 + 0.35);
  decor(ctx, 'barrel', rect.x1 - 2.0, rect.z1 + 0.32);
  void b; void lod;
}

export function marketStall(ctx: Ctx, def: BuildingDef): void {
  const { s, b, lod, r } = ctx;
  const hw = def.w / 2 - 0.1, hd = def.d / 2 - 0.1;
  const stripes = pick(r, [[0xb8342a, 0xeee6d2], [0x2f4f8a, 0xe8d8a0], [0x3f6a3a, 0xeee6d2], [0xc9a23a, 0x7a2a1a]]);
  b.state({ layer: Layer.Wall, flags: F.Burn | F.Snow }, () => {
    for (const [x, z, h] of [[-hw + 0.06, -hd + 0.06, 2.45], [hw - 0.06, -hd + 0.06, 2.45], [-hw + 0.06, hd - 0.06, 2.1], [hw - 0.06, hd - 0.06, 2.1]] as [number, number, number][]) b.box(x - 0.05, -0.3, z - 0.05, x + 0.05, h, z + 0.05, s.timber);
    // Counter on trestles and a back shelf.
    b.box(-hw + 0.1, 0.82, -0.2, hw - 0.1, 0.9, hd - 0.1, { side: 0x8a6a46, top: 0xa8875e });
    b.box(-hw + 0.15, 0, hd - 0.25, hw - 0.15, 0.82, hd - 0.18, 0x7a5a3a);
    b.box(-hw + 0.1, 1.25, -hd + 0.1, hw - 0.1, 1.3, -hd + 0.45, 0xa8875e);
  });
  // Striped awning sloping to the front (cloth, waves gently).
  b.state({ layer: Layer.Detail, mat: Mat.Cloth, flags: F.Snow }, () => {
    const n = lod === 0 ? 6 : 2;
    const old = b.swayFn;
    b.swayFn = (_x, _y, z) => Math.max(0, (z + hd) / (2 * hd)) * 0.5;
    for (let i = 0; i < n; i++) {
      const x0 = -hw - 0.1 + ((2 * hw + 0.2) * i) / n, x1 = -hw - 0.1 + ((2 * hw + 0.2) * (i + 1)) / n;
      b.quad([x0, 2.45, -hd - 0.05], [x1, 2.45, -hd - 0.05], [x1, 2.08, hd + 0.05], [x0, 2.08, hd + 0.05], stripes[i % 2]);
    }
    // Scalloped valance along the front.
    for (let i = 0; i < n * 2; i++) {
      const x0 = -hw - 0.1 + ((2 * hw + 0.2) * i) / (n * 2), x1 = -hw - 0.1 + ((2 * hw + 0.2) * (i + 1)) / (n * 2);
      b.tri([x0, 2.08, hd + 0.05], [x1, 2.08, hd + 0.05], [(x0 + x1) / 2, 1.85, hd + 0.06], stripes[(i >> 1) % 2]);
    }
    b.swayFn = old;
  });
  // Goods.
  if (lod < 2) {
    b.push(); b.layer = Layer.Decor; b.translate(0, 0.9, 0.35); b.scale(0.8, 0.8, 0.6);
    decorInto(b, 'market_goods', ctx.seed);
    b.layer = Layer.Wall; b.pop();
  }
  ctx.out.doors.push({ x: 0, z: hd + 0.5 });
}

export function marketCross(ctx: Ctx, def: BuildingDef): void {
  const { s, b, lod } = ctx;
  void def;
  const stone = s.id === 'cymric' || s.id === 'gael' ? COL.stoneGrey : s.stone;
  const n = lod === 0 ? 8 : 6;
  b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
    // Stepped octagonal base.
    for (let i = 0; i < 3; i++) b.cyl(0, 0, i === 0 ? -0.4 : i * 0.32, (i + 1) * 0.32, 1.95 - i * 0.48, 1.95 - i * 0.48, n, { side: shade(stone, 0.92 + i * 0.04), top: shade(stone, 1.06) }, { rot: Math.PI / 8 });
    b.cyl(0, 0, 0.96, 1.5, 0.55, 0.5, n, { side: stone, top: shade(stone, 1.05) }, { rot: Math.PI / 8 });
    b.cyl(0, 0, 1.5, 5.4, 0.22, 0.16, n, stone, { rot: Math.PI / 8 });
  });
  b.state({ layer: Layer.Detail, flags: F.Snow }, () => {
    if (s.id === 'gael' || s.id === 'cymric') {
      // Ringed (Celtic) cross head.
      b.box(-0.12, 5.3, -0.1, 0.12, 6.6, 0.1, stone);
      b.box(-0.6, 5.8, -0.1, 0.6, 6.05, 0.1, stone);
      const ring = 10;
      for (let i = 0; i < ring; i++) {
        const a0 = (i / ring) * Math.PI * 2, a1 = ((i + 1) / ring) * Math.PI * 2;
        b.beam([Math.cos(a0) * 0.38, 5.93 + Math.sin(a0) * 0.38, 0], [Math.cos(a1) * 0.38, 5.93 + Math.sin(a1) * 0.38, 0], 0.16, 0.08, stone, [0, 0, 1], 'pz nz');
      }
    } else if (s.id === 'norse') {
      // Carved runestone-like slab with a little cross.
      b.box(-0.35, 4.0, -0.12, 0.35, 5.6, 0.12, shade(stone, 0.95));
      b.box(-0.08, 5.6, -0.06, 0.08, 6.2, 0.06, stone);
      b.box(-0.25, 5.9, -0.06, 0.25, 6.0, 0.06, stone);
    } else {
      // Lantern head with a small cross on top.
      b.box(-0.32, 5.3, -0.32, 0.32, 5.4, 0.32, shade(stone, 1.05));
      b.box(-0.26, 5.4, -0.26, 0.26, 6.0, 0.26, { side: shade(stone, 0.95), top: stone });
      b.cyl(0, 0, 6.0, 6.5, 0.32, 0.0, 4, stone, { rot: Math.PI / 4 });
      b.box(-0.05, 6.45, -0.05, 0.05, 6.95, 0.05, COL.iron);
      b.box(-0.17, 6.72, -0.04, 0.17, 6.8, 0.04, COL.iron);
    }
  });
  ctx.out.doors.push({ x: 0, z: 2.0 });
}

export function marketHall(ctx: Ctx, def: BuildingDef): void {
  const { s, level: q, b, lod } = ctx;
  const tw = townWalls(ctx, 2);
  const mat = q >= 2 ? s.richRoof : tw.mat;
  const { ov, gov } = ovFor(mat);
  const W = def.w, D = def.d;
  const rect: Rect = { x0: -W / 2 + ov + 0.6, x1: W / 2 - ov - 0.6, z0: -D / 2 + ov + 0.6, z1: D / 2 - ov - 0.6 };
  const L = rect.x1 - rect.x0, Dp = rect.z1 - rect.z0;
  const H0 = 2.9;
  void gov;
  // Open ground floor: stone arcade (L2) or timber posts (L1).
  if (q >= 2) {
    b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
      for (const side of ['pz', 'nz', 'px', 'nx'] as const) {
        const len = side === 'pz' || side === 'nz' ? L : Dp;
        enterSide(b, rect, side, 0);
        const bays = Math.max(2, Math.round(len / 2.6));
        const pts: V2[] = [];
        // Arcade wall outline with pointed arches cut out, built as piers + spandrels.
        for (let i = 0; i <= bays; i++) {
          const u = -len / 2 + (len * i) / bays;
          b.box(u - 0.28, -0.3, -0.5, u + 0.28, H0, 0.0, { side: s.stone, top: s.stone });
        }
        for (let i = 0; i < bays; i++) {
          const u0 = -len / 2 + (len * i) / bays + 0.28, u1 = -len / 2 + (len * (i + 1)) / bays - 0.28;
          const um = (u0 + u1) / 2;
          b.flat([[u0, H0 - 0.9], [um, H0 - 0.15], [u1, H0 - 0.9], [u1, H0], [u0, H0]], 0, s.stone);
        }
        void pts;
        b.pop();
      }
    });
  } else {
    b.state({ layer: Layer.Wall, flags: F.Snow | F.Burn }, () => {
      const nx = 5, nz = 3;
      for (let i = 0; i <= nx; i++) for (let k = 0; k <= nz; k++) {
        if (i !== 0 && i !== nx && k !== 0 && k !== nz) continue;
        const x = rect.x0 + 0.15 + ((L - 0.3) * i) / nx, z = rect.z0 + 0.15 + ((Dp - 0.3) * k) / nz;
        b.box(x - 0.15, -0.3, z - 0.15, x + 0.15, H0, z + 0.15, s.timber);
        b.box(x - 0.25, -0.3, z - 0.25, x + 0.25, 0.25, z + 0.25, COL.stoneGrey);
      }
      b.box(rect.x0, H0 - 0.25, rect.z0, rect.x1, H0, rect.z1, s.timber, 'b');
    });
  }
  b.state({ layer: Layer.Ground, flags: F.Snow }, () => b.box(rect.x0 - 0.3, -0.3, rect.z0 - 0.3, rect.x1 + 0.3, 0.15, rect.z1 + 0.3, { side: COL.stoneGrey, top: 0x9a948a }));
  // Jettied upper hall.
  b.push();
  b.translate(0, H0, 0);
  const up: Rect = { x0: rect.x0 - 0.4, x1: rect.x1 + 0.4, z0: rect.z0 - 0.4, z1: rect.z1 + 0.4 };
  const res = house(ctx, {
    rect: up, plinthH: 0, noFloor: true,
    storeys: [{ h: 2.8, wall: tw.upper, frame: tw.frame === 'box' ? 'close' : tw.frame, openings: [
      ...windowRow('pz', up.x1 - up.x0, 4, { w: 1.1, h: 1.0, y: 0.8, frame: 'timber', shutters: false, mullions: 3, lit: 0.9 }),
      ...windowRow('nz', up.x1 - up.x0, 3, { w: 1.0, h: 0.9, y: 0.8, frame: 'timber', shutters: false, mullions: 2 }),
      { side: 'px', u: 0, w: 1.1, h: 0.9, y: 0.8, kind: 'window', frame: 'timber', mullions: 2 },
      { side: 'nx', u: 0, w: 1.1, h: 0.9, y: 0.8, kind: 'window', frame: 'timber', mullions: 2 },
    ] }],
    roof: { type: s.id === 'gael' ? 'hip' : 'hip', pitch: s.pitch, mat, ov, gov: ov, ridge: 'plain' },
  });
  b.pop();
  // Soffit under the jetty.
  b.state({ layer: Layer.Wall, flags: F.NoAO | F.Burn }, () => b.quad([up.x0, H0, up.z0], [up.x1, H0, up.z0], [up.x1, H0, up.z1], [up.x0, H0, up.z1], shade(s.timber, 0.85)));
  cupola(ctx, 0, (up.z0 + up.z1) / 2, res.roof.topY + H0 - 0.35, 1.0, 1.0, mat, { open: true, bell: true });
  // Stalls of goods under the arcade.
  if (lod === 0) for (const x of [-2.5, 1.5]) {
    b.push(); b.layer = Layer.Decor; b.translate(x, 0, 0.3); decorInto(b, 'market_goods', ctx.seed + x); b.layer = Layer.Wall; b.pop();
  }
  ctx.out.doors.push({ x: 0, z: rect.z1 + 0.6 }, { x: 0, z: rect.z0 - 0.6 });
}

export function guildhall(ctx: Ctx, def: BuildingDef): void {
  const { s, level: q, b, lod } = ctx;
  const tw = townWalls(ctx, 3);
  const mat = s.richRoof;
  const { ov, gov } = ovFor(mat);
  const W = def.w, D = def.d;
  const rect: Rect = { x0: -W / 2 + gov + 0.2, x1: W / 2 - gov - 0.2, z0: -D / 2 + ov + 0.55, z1: D / 2 - ov - 1.2 };
  const L = rect.x1 - rect.x0;
  const groundWall: WallKind = q >= 2 || tw.ground === 'rubble' ? (s.id === 'cymric' ? 'whitewash' : 'stone') : tw.ground;
  const fk = groundWall === 'stone' ? 'stone' : 'timber';
  const res = house(ctx, {
    rect, plinthH: 0.4,
    storeys: [
      { h: 3.0, wall: groundWall, frame: groundWall === 'daub' ? tw.frame : 'none', quoins: groundWall === 'stone', openings: [
        { side: 'pz', u: 0, w: 1.6, h: 2.5, y: 0, kind: 'door', frame: fk, shape: fk === 'stone' ? 'pointed' : 'tudor' },
        ...windowRow('pz', L, 5, { w: 1.0, h: 1.0, y: 1.1, frame: fk, shutters: false, mullions: 2, shape: fk === 'stone' ? 'pointed' : 'flat', lit: 0.9 }, [0]),
        ...windowRow('nz', L, 3, { w: 0.9, h: 0.9, y: 1.2, frame: fk, shutters: false }),
      ] },
      { h: 3.4, wall: tw.upper, frame: tw.frame === 'none' ? 'none' : 'close', jetty: s.id === 'norse' ? undefined : { pz: 0.5, nz: 0.3 }, openings: [
        ...windowRow('pz', L, 5, { w: 1.4, h: 1.5, y: 0.9, frame: 'timber', shutters: false, mullions: 3, lit: 1 }),
        ...windowRow('nz', L, 3, { w: 1.2, h: 1.3, y: 1.0, frame: 'timber', shutters: false, mullions: 2 }),
        { side: 'px', u: 0, w: 1.4, h: 1.4, y: 1.0, kind: 'window', frame: 'timber', mullions: 3 },
        { side: 'nx', u: 0, w: 1.4, h: 1.4, y: 1.0, kind: 'window', frame: 'timber', mullions: 3 },
      ] },
    ],
    roof: { type: 'gable', pitch: Math.max(50, s.pitch), mat, ov, gov, ridge: 'plain' },
    parapet: s.crowSteps ? 'crow' : undefined,
  });
  // Two gabled cross-dormers on the street front.
  for (const x of [-L * 0.25, L * 0.25]) loftGablet(ctx, res.rects[1], res.eaveY, x, 2.6, 1.8, mat, Math.max(50, s.pitch), tw.upper);
  // Porch on the door and a bell/clock turret.
  const pr: Rect = { x0: -1.4, x1: 1.4, z0: rect.z1, z1: rect.z1 + 1.05 };
  b.state({ layer: Layer.Wall, flags: F.Burn | F.Snow }, () => {
    for (const x of [pr.x0 + 0.12, pr.x1 - 0.12]) b.box(x - 0.12, 0.4, pr.z1 - 0.25, x + 0.12, 2.9, pr.z1 - 0.01, groundWall === 'stone' ? s.stone : s.timber);
  });
  const lk = roofLook(mat, roofTint(mat, s));
  buildRoof(b, { x0: pr.x0, x1: pr.x1, z0: pr.z0 - 0.3, z1: pr.z1, eaveY: 2.9, type: 'gable', axis: 'z', pitch: 50, ov: 0.12, gov: 0.1, ridge: 'plain', frame: false }, { ...lk, thickness: 0.14 }, lod);
  if (q >= 2) {
    const top = cupola(ctx, 0, (rect.z0 + rect.z1) / 2, res.roof.topY - 0.3, 1.4, 1.5, s.id === 'norse' ? 'shingle' : 'lead', { open: true, bell: true });
    flagPole(ctx, 0, top - 0.2, (rect.z0 + rect.z1) / 2, 2.0, ctx.owner, 'pennant');
  }
  chimney(ctx, { x: rect.x1 - 1.2, z: rect.z0 + 0.6, baseY: res.eaveY - 1, topY: res.roof.topY + 0.6, w: 0.9, d: 0.8, color: COL.brick, pots: 2 });
  ctx.out.doors.length = 0;
  ctx.out.doors.push({ x: 0, z: pr.z1 + 0.5 });
}

export function warehouse(ctx: Ctx, def: BuildingDef): void {
  const { s, level: q, b, lod } = ctx;
  const stone = q >= 2;
  const wall: WallKind = stone ? (s.id === 'cymric' ? 'whitewash' : s.id === 'norse' ? 'planks' : 'stone') : s.id === 'norse' ? 'planks' : s.id === 'teuton' ? 'daub' : 'weatherboard';
  const mat: RoofMat = stone ? s.richRoof : s.id === 'norse' ? 'shingle' : s.id === 'anglo' ? 'tile' : s.richRoof;
  const { ov, gov } = ovFor(mat);
  const W = def.w, D = def.d;
  const rect: Rect = { x0: -W / 2 + gov + 0.15, x1: W / 2 - gov - 0.15, z0: -D / 2 + ov + 0.15, z1: D / 2 - ov - 0.5 };
  const L = rect.x1 - rect.x0;
  const fk = wall === 'stone' ? 'stone' : 'timber';
  const loading: Opening[] = [];
  const st = [] as { h: number; wall: WallKind; frame: FrameKind; openings: Opening[]; quoins?: boolean }[];
  for (let i = 0; i < 3; i++) {
    loading.length = 0;
    const ops: Opening[] = [
      { side: 'pz', u: 0, w: i === 0 ? 2.4 : 1.4, h: i === 0 ? 2.5 : 1.7, y: i === 0 ? 0 : 0.35, kind: i === 0 ? 'wide' : 'window', frame: fk, mullions: 0, lit: 0.1 },
      ...windowRow('pz', L, 4, { w: 0.5, h: 0.6, y: 1.2, kind: 'slit', frame: fk, shutters: false, lit: 0.05 }, [0]),
      ...windowRow('nz', L, 3, { w: 0.5, h: 0.6, y: 1.2, kind: 'slit', frame: fk, shutters: false, lit: 0.05 }),
    ];
    st.push({ h: i === 0 ? 3.0 : 2.6, wall, frame: wall === 'daub' ? 'fachwerk' : 'none', openings: ops, quoins: wall === 'stone' && i === 0 });
  }
  const res = house(ctx, { rect, plinthH: 0.35, storeys: st, roof: { type: 'gable', pitch: Math.max(48, s.pitch), mat, ov, gov, ridge: 'plain' }, parapet: wall === 'stone' && s.crowSteps ? 'crow' : undefined });
  // Hoist gablet with a projecting beam and rope above the loading doors.
  loftGablet(ctx, rect, res.eaveY, 0, 2.0, 1.6, mat, Math.max(48, s.pitch), wall);
  b.state({ layer: Layer.Detail, flags: F.Burn }, () => {
    b.beam([0, res.eaveY + 1.0, rect.z1 + 0.5], [0, 1.2, rect.z1 + 0.5], 0.025, 0.025, COL.rope);
    b.box(-0.2, 1.0, rect.z1 + 0.3, 0.2, 1.3, rect.z1 + 0.7, { side: 0xc2a676, top: 0xb39466 });
  });
  decor(ctx, 'crate', rect.x1 - 1.6, rect.z1 + 0.4);
  decor(ctx, 'sack_pile', rect.x0 + 1.6, rect.z1 + 0.35);
  decor(ctx, 'barrel', rect.x0 + 3.0, rect.z1 + 0.32);
  void lod; void opening; void clothQuad;
}
