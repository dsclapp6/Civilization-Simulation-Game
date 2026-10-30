// Homes: hovel, cottage, longhouse, townhouse, manor house.
import type { BuildingDef } from '../../../content/types';
import { F, Layer, shade } from '../../core/builder';
import { chimney, flagPole, house, opening, enterSide, pick, windowRow, type Ctx, type Opening, type Rect, type StoreyOpts } from '../parts';
import { buildRoof, roofLook } from '../roof';
import { COL, roofTint, wallColor, type FrameKind, type WallKind } from '../style';
import { homeDecor, vernacular } from '../vernacular';

export function hovel(ctx: Ctx, def: BuildingDef): void {
  const { s } = ctx;
  const wall: WallKind = s.id === 'norse' ? 'planks' : s.id === 'gael' ? 'rubble' : s.id === 'cymric' ? 'rubble' : 'daub';
  vernacular(ctx, {
    W: def.w, D: def.d, q: 1,
    wallH: s.id === 'gael' ? 1.45 : 1.6,
    wall,
    frame: wall === 'daub' ? (s.id === 'teuton' ? 'fachwerk' : s.id === 'franc' ? 'none' : 'cruck') : 'none',
    roofMat: s.id === 'norse' ? 'turf' : s.id === 'gael' ? 'heather' : 'thatch',
    roofType: s.id === 'norse' ? 'gable' : 'hip',
    pitch: s.id === 'norse' ? 38 : 52,
    frontWindows: 1, backWindows: 0, gableWindows: false,
    windowW: 0.5, windowH: 0.45, doorAt: -0.12,
    chimney: 'hole', ridge: 'plain',
    decor: ctx.lod === 0 ? [pick(ctx.r, ['woodpile', 'barrel', 'sack_pile'] as const)] : [],
  });
}

export function cottage(ctx: Ctx, def: BuildingDef): void {
  const { s, level } = ctx;
  const q = level;
  const chim = s.id === 'norse' ? (q >= 3 ? 'ridge' : 'hole')
    : s.id === 'gael' ? (q === 1 ? 'hole' : 'gable2')
      : s.id === 'cymric' ? (q === 3 ? 'gable2' : 'gable')
        : s.id === 'teuton' ? (q === 1 ? 'louvre' : 'ridge')
          : q === 1 ? 'louvre' : q === 2 ? 'gable' : 'ridge2';
  vernacular(ctx, {
    W: def.w, D: def.d, q,
    storeys: q >= 3 ? 2 : 1,
    wallH: s.id === 'gael' && q < 3 ? 1.9 : q >= 3 ? 2.55 : 2.6,
    jetty: q >= 3 && (s.id === 'anglo' || s.id === 'teuton' || s.id === 'franc') ? 0.38 : 0,
    chimney: chim,
    lean: q === 2 && (s.id === 'anglo' || s.id === 'teuton' || s.id === 'franc') ? 'px' : undefined,
    porch: q >= 3 && s.id !== 'gael',
    frontWindows: q === 1 ? 2 : 3,
    backWindows: 1,
    doorAt: q >= 3 ? -0.05 : -0.2,
    roofType: q >= 3 ? 'gable' : undefined,
    decor: homeDecor(ctx, q),
  });
}

export function longhouse(ctx: Ctx, def: BuildingDef): void {
  const { s, level, lod, b } = ctx;
  const q = level;
  // House end at -x (hearth, windows), byre end at +x (wide door, muck).
  const W = def.w, D = def.d;
  const wideDoor: Opening = { side: 'pz', u: 3.4, w: 1.7, h: 2.0, y: 0, kind: 'wide', frame: 'timber', open: false };
  const res = vernacular(ctx, {
    W, D, q,
    storeys: 1,
    wallH: s.id === 'gael' ? 1.9 : 2.3,
    roofType: s.id === 'norse' ? 'gable' : s.id === 'gael' ? 'hip' : q >= 2 ? 'halfhip' : 'hip',
    pitch: s.id === 'norse' ? 36 : s.pitch,
    doorAt: -0.02,
    backDoor: true,
    frontWindows: 2, backWindows: 1,
    chimney: q === 1 ? 'hole' : s.id === 'norse' ? 'hole' : 'ridge',
    extra: [wideDoor],
    porch: q >= 3 && s.id !== 'gael' && s.id !== 'norse',
    decor: ['dung_heap'],
  });
  // Byre partition screen and cattle slit windows on the byre end.
  const rc = res.rect;
  enterSide(b, rc, 'px', 0.3);
  opening(ctx, { side: 'px', u: 0, w: 0.25, h: 0.6, y: 1.1, kind: 'slit', frame: 'timber', lit: 0.1 });
  b.pop();
  if (q >= 2 && lod === 0) {
    // Second hearth smoke and a little outshot store at the house end.
    ctx.out.smoke.push([rc.x0 + (rc.x1 - rc.x0) * 0.2, res.roof.topY + 0.2, (rc.z0 + rc.z1) / 2]);
  }
  void s;
}

export function townhouse(ctx: Ctx, def: BuildingDef): void {
  const { b, s, level, lod, r } = ctx;
  const q = level;
  // Narrow plot, gable end to the street (+z). Jettied upper storeys.
  const W = def.w, D = def.d;
  const gov = 0.25, ov = 0.18;
  const nUp = q === 1 ? 1 : 2;
  const jet = s.id === 'norse' ? 0 : 0.42;
  const rect: Rect = { x0: -W / 2 + ov + 0.05, x1: W / 2 - ov - 0.05, z0: -D / 2 + gov + 0.14, z1: D / 2 - gov - 0.14 - Math.max(jet * nUp, 0.6) };
  const timberTown = s.id !== 'gael' && s.id !== 'cymric';
  const groundWall: WallKind = timberTown ? (s.id === 'norse' ? 'planks' : q >= 3 && s.id === 'franc' ? 'stone' : 'daub') : 'stone';
  const upWall: WallKind = s.id === 'norse' ? 'planks' : s.id === 'cymric' ? 'whitewash' : s.id === 'gael' ? 'whitewash' : 'daub';
  const fr: FrameKind = s.id === 'teuton' ? 'fachwerk' : s.id === 'norse' || !timberTown ? 'none' : q >= 2 ? 'close' : 'box';
  const L = rect.x1 - rect.x0;
  const ground: Opening[] = [
    { side: 'pz', u: -L / 2 + 0.85, w: 0.95, h: 2.0, y: 0, kind: 'door', frame: groundWall === 'stone' ? 'stone' : 'timber', shape: groundWall === 'stone' ? 'pointed' : 'flat' },
    { side: 'pz', u: 0.75, w: 2.2, h: 1.15, y: 0.85, kind: 'shop', frame: 'timber', shutters: false, mullions: 0 },
    ...windowRow('px', rect.z1 - rect.z0, 2, { w: 0.6, h: 0.6, y: 1.2, frame: 'timber', shutters: false }),
    { side: 'nz', u: 0.5, w: 0.9, h: 1.9, y: 0, kind: 'door', frame: 'timber' },
  ];
  const storeys: StoreyOpts[] = [{ h: 2.75, wall: groundWall, frame: groundWall === 'stone' ? 'none' : fr, openings: ground, quoins: groundWall === 'stone' }];
  for (let i = 0; i < nUp; i++) {
    const ups: Opening[] = [
      ...windowRow('pz', L + jet * (i + 1) * 0, i === 0 && q >= 3 ? 1 : 2, { w: i === 0 && q >= 3 ? 1.9 : 0.85, h: 0.8, y: 0.7, frame: 'timber', shutters: s.id !== 'norse' && r() < 0.6 }),
      ...windowRow('px', rect.z1 - rect.z0, 2, { w: 0.6, h: 0.65, y: 0.8, frame: 'timber', shutters: false }),
      ...windowRow('nz', L, 1, { w: 0.7, h: 0.7, y: 0.8, frame: 'timber', shutters: false }),
    ];
    storeys.push({ h: i === 0 ? 2.45 : 2.25, wall: upWall, frame: fr === 'box' ? 'close' : fr, openings: ups, jetty: jet ? { pz: jet } : undefined });
  }
  const roofMat = s.id === 'norse' ? 'shingle' : s.id === 'franc' ? 'slate' : s.id === 'anglo' && q === 1 ? 'thatch' : s.richRoof;
  const res = house(ctx, {
    rect, plinthH: 0.25, storeys,
    roof: { type: 'gable', axis: 'z', pitch: Math.max(s.pitch, 52), mat: roofMat, ov, gov, ridge: 'plain' },
    parapet: s.crowSteps ? 'crow' : undefined,
  });
  // Shop counter (lower shutter dropped as a board) and an upper shutter propped as an awning.
  enterSide(b, rect, 'pz', 0.25);
  b.state({ layer: Layer.Detail, flags: F.Burn | F.Snow }, () => {
    b.box(-0.35, 0.78, 0, 1.85, 0.86, 0.55, shade(s.timber, 1.25));
    b.box(-0.35, 0.3, 0.42, -0.27, 0.78, 0.5, s.timber);
    b.box(1.77, 0.3, 0.42, 1.85, 0.78, 0.5, s.timber);
    b.push();
    b.translate(0.75, 2.02, 0.02);
    b.rotX(-1.05);
    b.box(-1.15, 0, 0, 1.15, 0.85, 0.05, shade(pick(r, s.shutters), 1.0));
    b.pop();
    if (lod === 0) {
      const goods = [0xb8342a, 0xd9902a, 0x7a9a3a, 0xc9b27a];
      for (let i = 0; i < 4; i++) b.blob(-0.1 + i * 0.5, 0.95, 0.28, 0.16, 0.1, 0.14, goods[(i + ctx.seed) % 4], 0.2, 0, i);
    }
  });
  b.pop();
  // Side chimney stack on the party wall.
  const stackX = rect.x0 + 0.38;
  chimney(ctx, { x: stackX, z: -D / 2 + gov + 2.2, baseY: res.eaveY - 1, topY: res.roof.underAt(stackX, -D / 2 + gov + 2.2) + 1.2, w: 0.7, d: 0.8, color: s.id === 'norse' ? COL.stoneGrey : COL.brick, pots: q >= 2 ? 2 : 1 });
  if (q >= 3 && lod === 0) {
    // Oriel window bay on the first floor.
    const y0 = res.bases[1] + 0.45;
    const zf = res.rects[1].z1;
    b.state({ layer: Layer.Wall, flags: F.Snow | F.Burn }, () => {
      b.taperBox(-0.9, y0 - 0.35, zf, 0.9, y0, zf + 0.45, 0.35, 0.3, { side: s.timber });
      b.box(-0.9, y0, zf, 0.9, y0 + 1.25, zf + 0.45, { side: wallColor(upWall, s), top: s.timber });
      b.box(-0.95, y0 + 1.25, zf - 0.02, 0.95, y0 + 1.38, zf + 0.5, s.timber);
    });
    enterSide(b, { x0: -0.9, x1: 0.9, z0: zf, z1: zf + 0.45 }, 'pz', y0);
    opening(ctx, { side: 'pz', u: 0, w: 1.5, h: 0.95, y: 0.15, kind: 'window', frame: 'timber', mullions: 3, lit: 0.9 });
    b.pop();
    const look = roofLook(roofMat, roofTint(roofMat, s));
    void look;
  }
}

export function manorHouse(ctx: Ctx, def: BuildingDef): void {
  const { b, s, level, lod } = ctx;
  const W = def.w, D = def.d;
  const q = level;
  const timber = s.timber;
  const richRoof = s.id === 'anglo' && q === 1 ? 'thatch' : s.richRoof;
  if (q === 1 && (s.id === 'anglo' || s.id === 'teuton' || s.id === 'franc')) {
    // Wealden hall house: open hall between two jettied end bays under one hipped roof.
    const ov = 0.42;
    const z0 = -D / 2 + ov + 0.2, zf = D / 2 - ov - 0.6;
    const jet = 0.5;
    const bay = 4.6;
    const x0 = -W / 2 + ov + 0.3, x1 = W / 2 - ov - 0.3;
    const fr: FrameKind = s.id === 'teuton' ? 'fachwerk' : 'close';
    const g1 = 2.6, g2 = 2.5;
    for (const side of [-1, 1] as const) {
      const bx0 = side < 0 ? x0 : x1 - bay, bx1 = side < 0 ? x0 + bay : x1;
      house(ctx, {
        rect: { x0: bx0, x1: bx1, z0, z1: zf - jet }, plinthH: 0.3, noFloor: false,
        storeys: [
          { h: g1, wall: 'daub', frame: fr, openings: [{ side: 'pz', u: 0, w: 1.1, h: 0.75, y: 1.1, kind: 'window', frame: 'timber', shutters: true }, { side: side < 0 ? 'nx' : 'px', u: 0.4, w: 0.8, h: 0.7, y: 1.1, kind: 'window', frame: 'timber', shutters: true }] },
          { h: g2, wall: 'daub', frame: fr, jetty: { pz: jet }, openings: [{ side: 'pz', u: 0, w: 1.6, h: 0.85, y: 0.8, kind: 'window', frame: 'timber', mullions: 3 }, { side: side < 0 ? 'nx' : 'px', u: 0, w: 0.9, h: 0.75, y: 0.8, kind: 'window', frame: 'timber' }] },
        ],
        roof: null,
      });
    }
    // Hall, recessed under the flying wall plate.
    const hx0 = x0 + bay, hx1 = x1 - bay;
    house(ctx, {
      rect: { x0: hx0, x1: hx1, z0, z1: zf - jet }, plinthH: 0.3,
      storeys: [{ h: g1 + g2, wall: 'daub', frame: fr, openings: [
        { side: 'pz', u: -(hx1 - hx0) / 2 + 1.0, w: 1.1, h: 2.1, y: 0, kind: 'door', frame: 'timber', shape: 'tudor' },
        { side: 'pz', u: 0.9, w: 1.7, h: 2.6, y: 1.4, kind: 'window', frame: 'timber', mullions: 3, lit: 1 },
        { side: 'nz', u: 0, w: 1.4, h: 2.0, y: 1.6, kind: 'window', frame: 'timber', mullions: 2 },
      ] }],
      roof: null,
    });
    // Single hipped roof over everything at the jettied line.
    const eaveY = 0.3 + g1 + g2;
    const look = roofLook(richRoof, roofTint(richRoof, s));
    const roof = buildRoof(b, { x0, x1, z0, z1: zf, eaveY, type: 'hip', pitch: s.pitch + 2, ov, gov: ov, ridge: 'plain' }, look, lod);
    // Flying wall plate braces in front of the hall.
    b.state({ layer: Layer.Frame, flags: F.Burn | F.Snow }, () => {
      b.box(hx0, eaveY - 0.22, zf - 0.12, hx1, eaveY, zf, timber);
      for (const x of [hx0 + 0.15, hx1 - 0.15]) b.beam([x, eaveY - 1.3, zf - jet + 0.04], [x, eaveY - 0.2, zf - 0.08], 0.16, 0.14, timber, [1, 0, 0]);
    });
    chimney(ctx, { x: hx0 + 2.4, z: z0 + 1.0, baseY: eaveY - 1, topY: roof.topY + 0.6, w: 0.9, d: 0.8, color: COL.brick, pots: 2 });
    ctx.out.smoke.push([(hx0 + hx1) / 2, roof.topY + 0.1, (z0 + zf) / 2]);
    decorYard(ctx, W, D, ['woodpile', 'barrel']);
    return;
  }
  // H-plan manor: hall range with two gabled cross-wings projecting to the front.
  const stone = q >= 3 || s.id === 'gael' || s.id === 'cymric' || (q === 2 && s.id === 'franc');
  const wall: WallKind = stone ? (s.id === 'cymric' || s.id === 'gael' ? 'whitewash' : 'stone') : s.id === 'norse' ? 'planks' : 'daub';
  const fr: FrameKind = stone ? 'none' : s.id === 'teuton' ? (q >= 2 ? 'square' : 'fachwerk') : s.id === 'norse' ? 'none' : q >= 3 ? 'close' : 'square';
  const wingW = 4.2;
  const hallZ0 = -D / 2 + 0.6, hallZ1 = D / 2 - 2.8;
  const wingZ0 = -D / 2 + 0.62, wingZ1 = D / 2 - 0.5;
  const hx0 = -W / 2 + 0.3 + wingW, hx1 = W / 2 - 0.3 - wingW;
  const fk = stone ? 'stone' : 'timber';
  const shape = stone ? 'pointed' : 'flat';
  // Hall range
  const hall = house(ctx, {
    rect: { x0: hx0 - 0.3, x1: hx1 + 0.3, z0: hallZ0, z1: hallZ1 }, plinthH: 0.35,
    storeys: [{ h: 5.2, wall, frame: fr, quoins: false, openings: [
      { side: 'pz', u: -2.6, w: 1.2, h: 2.2, y: 0, kind: 'door', frame: fk, shape: stone ? 'pointed' : 'tudor' },
      { side: 'pz', u: 0.4, w: 1.4, h: 2.6, y: 1.6, kind: 'window', frame: fk, shape, mullions: 2, lit: 1 },
      { side: 'pz', u: 2.7, w: 1.4, h: 2.6, y: 1.6, kind: 'window', frame: fk, shape, mullions: 2, lit: 1 },
      { side: 'nz', u: 0.5, w: 1.3, h: 2.4, y: 1.7, kind: 'window', frame: fk, shape, mullions: 2 },
    ] }],
    roof: { type: 'gable', pitch: s.pitch, mat: richRoof, ov: 0.3, gov: 0.1, ridge: 'plain', axis: 'x' },
    parapet: stone ? (s.crowSteps ? 'crow' : undefined) : undefined,
  });
  // Cross wings (gables to the front)
  const wingRoof = richRoof;
  const wings: Rect[] = [
    { x0: -W / 2 + 0.3, x1: hx0, z0: wingZ0, z1: wingZ1 },
    { x0: hx1, x1: W / 2 - 0.3, z0: wingZ0, z1: wingZ1 },
  ];
  wings.forEach((wr, i) => {
    const ww = wr.x1 - wr.x0;
    const upper: StoreyOpts = { h: 2.6, wall: stone ? wall : wall, frame: fr === 'none' ? 'none' : fr, jetty: stone ? undefined : { pz: 0.35 },
      openings: [
        { side: 'pz', u: 0, w: 1.5, h: 1.0, y: 0.7, kind: 'window', frame: fk, mullions: 3, shape: stone ? 'flat' : 'flat' },
        { side: i === 0 ? 'nx' : 'px', u: 0.4, w: 0.9, h: 0.9, y: 0.8, kind: 'window', frame: fk },
      ] };
    const r2 = { ...wr, z1: wr.z1 - (stone ? 0 : 0.35) };
    house(ctx, {
      rect: r2, plinthH: 0.35,
      storeys: [
        { h: 2.8, wall, frame: fr, quoins: wall === 'stone', openings: [
          { side: 'pz', u: 0, w: 1.3, h: 1.0, y: 1.0, kind: 'window', frame: fk, mullions: 2, shutters: !stone },
          { side: i === 0 ? 'nx' : 'px', u: 0, w: 0.9, h: 0.9, y: 1.1, kind: 'window', frame: fk, shutters: !stone },
          { side: i === 0 ? 'px' : 'nx', u: (r2.z1 - r2.z0) / 2 - 0.9, w: 0.9, h: 2.0, y: 0, kind: 'door', frame: fk },
        ] },
        upper,
      ],
      roof: { type: 'gable', pitch: s.pitch + 2, mat: wingRoof, ov: 0.25, gov: 0.25, ridge: 'plain', axis: 'z' },
      parapet: stone ? (s.crowSteps ? 'crow' : 'coping') : undefined,
    });
    // Wing chimney on the outer wall
    const cx = i === 0 ? wr.x0 + 0.45 : wr.x1 - 0.45;
    chimney(ctx, { x: cx, z: (wr.z0 + wr.z1) / 2 - 1.2, baseY: 3.0, topY: 8.4 + (q - 2) * 0.4, w: 0.8, d: 1.0, color: stone ? s.stone : COL.brick, pots: 2 });
    void ww;
  });
  // Lateral hall chimney stack on the back wall.
  chimney(ctx, { x: 0.8, z: hallZ0 - 0.15, baseY: -0.3, topY: hall.roof.topY + 0.8, w: 1.1, d: 0.6, baseW: 1.4, baseD: 0.62, color: stone ? s.stone : COL.brick, pots: 2, shoulderY: 4.6 });
  // Porch / porch tower
  if (q >= 3) {
    const pr: Rect = { x0: -3.6, x1: -1.6, z0: hallZ1, z1: hallZ1 + 2.2 };
    const tw: WallKind = wall;
    house(ctx, {
      rect: pr, plinthH: 0.35,
      storeys: [
        { h: 3.0, wall: tw, frame: 'none', quoins: tw === 'stone', openings: [{ side: 'pz', u: 0, w: 1.1, h: 2.3, y: 0, kind: 'door', frame: 'stone', shape: 'pointed', open: true }] },
        { h: 2.8, wall: tw, frame: 'none', openings: [{ side: 'pz', u: 0, w: 0.8, h: 1.1, y: 0.8, kind: 'window', frame: 'stone', shape: 'pointed' }] },
        { h: 2.4, wall: tw, frame: 'none', openings: [] },
      ],
      roof: { type: 'pyramid', pitch: 8, mat: 'lead', ov: 0.05, gov: 0.05, ridge: 'none' },
    });
    const ty = 0.35 + 3 + 2.8 + 2.4;
    for (const [z, x0, x1] of [[pr.z1 + 0.02, pr.x0 - 0.1, pr.x1 + 0.1], [pr.z0 + 0.42, pr.x0 - 0.1, pr.x1 + 0.1]] as [number, number, number][]) {
      ctxCrenel(ctx, x0, x1, z, ty, s.stone);
    }
    flagPole(ctx, (pr.x0 + pr.x1) / 2, ty + 0.6, (pr.z0 + pr.z1) / 2, 3.2, ctx.owner);
  } else {
    // Timber gabled porch
    const pr: Rect = { x0: -3.4, x1: -1.8, z0: hallZ1, z1: hallZ1 + 1.6 };
    house(ctx, {
      rect: pr, plinthH: 0.3,
      storeys: [{ h: 2.5, wall: wall === 'stone' ? 'stone' : wall, frame: fr, openings: [{ side: 'pz', u: 0, w: 1.0, h: 2.1, y: 0, kind: 'door', frame: fk, open: true, shape: stone ? 'pointed' : 'flat' }] }],
      roof: { type: 'gable', axis: 'z', pitch: s.pitch + 3, mat: richRoof, ov: 0.2, gov: 0.15, ridge: 'plain' },
    });
  }
  decorYard(ctx, W, D, q >= 2 ? ['barrel', 'bench'] : ['woodpile']);
  void lod; void timber;
}

function ctxCrenel(ctx: Ctx, x0: number, x1: number, z: number, y: number, col: number): void {
  const { b, lod } = ctx;
  b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
    b.box(x0, y - 0.1, z - 0.4, x1, y + 0.4, z, { side: col, top: shade(col, 1.06) });
    if (lod < 2) for (let x = x0 + 0.15; x < x1 - 0.3; x += 0.9) b.box(x, y + 0.4, z - 0.4, x + 0.5, y + 1.0, z, { side: col, top: shade(col, 1.06) });
  });
}

export function decorYard(ctx: Ctx, W: number, D: number, kinds: import('../../types').PropKind[]): void {
  void W; void D; void kinds; void ctx;
}
