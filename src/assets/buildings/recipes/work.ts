// Workplaces: mills, smithy, carpenter, sawpit, tannery, weaver, fulling mill, bakehouse,
// brewhouse, kiln, charcoal mound, bloomery, quarry, mine, dock.
import type { BuildingDef } from '../../../content/types';
import { F, Layer, Mat, MeshBuilder, shade, type V3 } from '../../core/builder';
import { clothQuad, decorInto } from '../../props/props';
import { chimney, cupola, enterSide, fenceRun, house, opening, planks, strawFloor, windowRow, type Ctx, type Opening, type Rect } from '../parts';
import { buildCone, buildRoof, roofLook, type RoofMat } from '../roof';
import { COL, roofTint, type FrameKind, type WallKind } from '../style';
import { ovFor, vernacular } from '../vernacular';
import { farmWall } from './farm';

function decor(ctx: Ctx, kind: Parameters<typeof decorInto>[1], x: number, z: number, rot = 0, s = 1): void {
  if (ctx.lod !== 0) return;
  const b = ctx.b;
  b.push(); b.layer = Layer.Decor; b.translate(x, 0, z); b.rotY(rot); if (s !== 1) b.scale(s, s, s);
  decorInto(b, kind, ctx.seed + Math.round(x * 7 + z * 13));
  b.layer = Layer.Wall; b.pop();
}

function workWall(ctx: Ctx): { wall: WallKind; frame: FrameKind; mat: RoofMat } {
  const { s, level: q } = ctx;
  return { wall: s.homeWall[Math.min(2, q - 1)], frame: s.homeFrame[Math.min(2, q - 1)] === 'cruck' ? 'box' : s.homeFrame[Math.min(2, q - 1)], mat: s.homeRoof[Math.min(2, q - 1)] };
}

// ---------------------------------------------------------------------------
// Water wheel (separate animated part)

function waterWheel(r: number, width: number, overshot: boolean, lod: 0 | 1 | 2): MeshBuilder {
  const b = new MeshBuilder(77);
  b.layer = Layer.Detail;
  b.flags = F.Burn;
  const n = lod === 0 ? 12 : 8;
  const wood = 0x6e5236, woodD = 0x4e3a26;
  const hw = width / 2;
  // Two rims as rings of short beams, paddles/buckets between them, spokes and an axle.
  for (const z of [-hw, hw]) {
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      b.beam([Math.cos(a0) * r, Math.sin(a0) * r, z], [Math.cos(a1) * r, Math.sin(a1) * r, z], 0.12, 0.22, wood, [0, 0, 1], 'pz nz');
    }
    for (let i = 0; i < (lod === 0 ? 6 : 4); i++) {
      const a = (i / (lod === 0 ? 6 : 4)) * Math.PI * 2 + 0.2;
      b.beam([0, 0, z], [Math.cos(a) * r, Math.sin(a) * r, z], 0.1, 0.1, woodD, [0, 0, 1], 'pz nz');
    }
  }
  for (let i = 0; i < n; i++) {
    const a = ((i + 0.5) / n) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    b.push();
    b.translate(c * (r - 0.18), s * (r - 0.18), 0);
    b.rotZ(a + (overshot ? 0.5 : 0));
    b.box(-0.22, -0.035, -hw + 0.06, 0.22, 0.035, hw - 0.06, wood);
    b.pop();
  }
  b.tube([0, 0, -hw - 0.4], [0, 0, hw + 1.6], 0.16, 0.16, 6, woodD);
  return b;
}

function millRace(ctx: Ctx, x0: number, x1: number, zc: number, w: number): void {
  const { b } = ctx;
  // A raised stone channel along x behind the mill, with water running through it.
  b.state({ layer: Layer.Ground, flags: F.Snow }, () => {
    for (const sd of [-1, 1]) b.box(x0, -0.4, zc + sd * (w / 2) - 0.2, x1, 0.55, zc + sd * (w / 2) + 0.2, { side: COL.stoneGrey, top: COL.stone });
    b.box(x0, -0.4, zc - w / 2, x1, 0.05, zc + w / 2, COL.stoneDark, 't');
  });
  b.state({ layer: Layer.Detail, mat: Mat.Water, flags: F.NoAO }, () => b.box(x0, 0.0, zc - w / 2, x1, 0.38, zc + w / 2, { top: COL.water, side: COL.waterDeep }, 'b'));
}

export function watermill(ctx: Ctx, def: BuildingDef, fulling = false): void {
  const { s, level: q, b, lod } = ctx;
  const W = def.w, D = def.d;
  const stone = q >= 2 || s.id === 'gael' || s.id === 'cymric';
  const wall: WallKind = q >= 3 ? 'stone' : stone ? (s.id === 'cymric' ? 'whitewash' : 'rubble') : s.homeWall[0] === 'planks' ? 'planks' : 'daub';
  const upper: WallKind = s.id === 'norse' ? 'planks' : q >= 3 ? 'stone' : s.id === 'teuton' ? 'daub' : 'weatherboard';
  const mat: RoofMat = q >= 3 ? s.richRoof : q === 2 ? (s.homeRoof[1] === 'heather' ? 'thatch' : s.homeRoof[1]) : s.homeRoof[0] === 'heather' ? 'thatch' : s.homeRoof[0];
  const { ov, gov } = ovFor(mat);
  const raceZ = -D / 2 + 0.95;
  const endIn = (s.id === 'gael' ? ov : gov) + 0.15;
  const rect: Rect = { x0: -W / 2 + endIn, x1: W / 2 - endIn, z0: raceZ + 1.15, z1: D / 2 - ov - 0.15 - (q >= 3 ? 0.75 : 0) };
  const L = rect.x1 - rect.x0;
  const storeys = q >= 3 ? 2 : 1;
  const ops: Opening[] = [
    { side: 'pz', u: -L / 2 + 1.3, w: 1.1, h: 2.0, y: 0, kind: 'door', frame: wall === 'stone' ? 'stone' : 'timber' },
    ...windowRow('pz', L, 3, { w: 0.7, h: 0.7, y: 1.2, frame: wall === 'stone' ? 'stone' : 'timber', shutters: wall !== 'stone' }, [-L / 2 + 1.3]),
    { side: 'nx', u: 0, w: 0.7, h: 0.6, y: 1.3, kind: 'window', frame: 'timber', shutters: true },
  ];
  const st: { h: number; wall: WallKind; frame: FrameKind; openings: Opening[]; quoins: boolean }[] = [{ h: 3.0, wall, frame: (wall === 'daub' ? (s.id === 'teuton' ? 'fachwerk' : 'box') : 'none') as FrameKind, openings: ops, quoins: wall === 'stone' }];
  if (storeys > 1 || q === 2) st.push({ h: q === 2 ? 2.0 : 2.6, wall: upper, frame: (upper === 'daub' ? 'fachwerk' : 'none') as FrameKind, openings: windowRow('pz', L, 2, { w: 0.7, h: 0.65, y: 0.7, frame: upper === 'stone' ? 'stone' : 'timber', shutters: upper !== 'stone' }), quoins: upper === 'stone' });
  const res = house(ctx, { rect, plinthH: 0.35, storeys: st, roof: { type: s.id === 'gael' ? 'hip' : 'gable', pitch: s.pitch, mat, ov, gov, ridge: 'plain' }, parapet: wall === 'stone' && s.crowSteps ? 'crow' : undefined });
  // Mill race behind, wheel on the back wall.
  millRace(ctx, -W / 2 + 0.1, W / 2 - 0.1, raceZ, 1.3);
  const overshot = q >= 2;
  const R = overshot ? 2.2 + (q - 2) * 0.35 : 1.85;
  const wx = rect.x0 + L * 0.62;
  const wy = overshot ? R + 0.35 : R + 0.05;
  ctx.out.anims.push({ pivot: [wx, wy, raceZ], builder: waterWheel(R, 0.9, overshot, lod), kind: 'spinZ', speed: overshot ? -0.6 : 0.8, mat: 'opaque' });
  ctx.out.emitters.push({ kind: 'splash', pos: [wx + (overshot ? R * 0.4 : -R * 0.3), 0.45, raceZ], rate: 2.5 });
  if (overshot) {
    // Timber launder on trestles feeding the top of the wheel, with a falling sheet of water.
    const ly = wy + R + 0.35;
    b.state({ layer: Layer.Wall, flags: F.Burn | F.Snow }, () => {
      b.box(-W / 2 + 0.1, ly - 0.15, raceZ - 0.35, wx - 0.25, ly + 0.3, raceZ + 0.35, { side: COL.timberRaw, top: shade(COL.timberRaw, 0.8) });
      for (const x of [-W / 2 + 0.5, (-W / 2 + wx) / 2]) for (const sd of [-1, 1]) b.box(x - 0.08, -0.3, raceZ + sd * 0.3 - 0.08, x + 0.08, ly - 0.15, raceZ + sd * 0.3 + 0.08, s.timber);
    });
    b.state({ layer: Layer.Detail, mat: Mat.Water, flags: F.NoAO }, () => {
      b.box(-W / 2 + 0.15, ly + 0.1, raceZ - 0.27, wx - 0.3, ly + 0.25, raceZ + 0.27, { top: COL.water, side: COL.waterDeep }, 'b');
      b.quad([wx - 0.3, ly + 0.15, raceZ - 0.25], [wx - 0.3, ly + 0.15, raceZ + 0.25], [wx + 0.25, wy + R * 0.6, raceZ + 0.25], [wx + 0.25, wy + R * 0.6, raceZ - 0.25], 0xa8d0d8);
    });
  }
  // Sack hoist lucam on big mills.
  if (q >= 3 && lod < 2) {
    const ly = res.eaveY - 0.3;
    b.state({ layer: Layer.Wall, flags: F.Snow | F.Burn }, () => {
      b.box(rect.x1 - 2.2, ly - 1.6, rect.z1, rect.x1 - 0.8, ly + 0.4, rect.z1 + 0.6, { side: COL.weatherboardGrey, top: s.timber });
    });
    const lk = roofLook(mat, roofTint(mat, s));
    buildRoof(b, { x0: rect.x1 - 2.2, x1: rect.x1 - 0.8, z0: rect.z1 - 0.6, z1: rect.z1 + 0.6, eaveY: ly + 0.4, type: 'gable', axis: 'z', pitch: s.pitch, ov: 0.12, gov: 0.1, ridge: 'plain', frame: false }, { ...lk, thickness: 0.12 }, 2);
  }
  chimney(ctx, { x: rect.x0 + 0.6, z: (rect.z0 + rect.z1) / 2, baseY: res.eaveY - 0.6, topY: res.roof.topY + 0.5, w: 0.6, d: 0.6, color: stone ? s.stone : COL.brick });
  if (fulling) {
    // Tenter frame with stretched cloth along the front.
    const tz = D / 2 - 0.25;
    b.state({ layer: Layer.Decor, flags: F.Burn | F.Snow }, () => {
      for (let i = 0; i <= 4; i++) b.box(-W / 2 + 0.4 + i * 2.2 - 0.05, -0.3, tz - 0.05, -W / 2 + 0.4 + i * 2.2 + 0.05, 1.5, tz + 0.05, s.timber);
      b.box(-W / 2 + 0.35, 1.45, tz - 0.05, W / 2 - 0.35, 1.55, tz + 0.05, s.timber);
      b.box(-W / 2 + 0.35, 0.35, tz - 0.05, W / 2 - 0.35, 0.45, tz + 0.05, s.timber);
    });
    b.state({ layer: Layer.Decor, mat: Mat.Cloth, flags: F.NoAO }, () => clothQuad(b, -W / 2 + 0.45, 0.45, W / 2 - 0.45, 1.45, tz + 0.06, [0xa8302a, 0x3e5a8a, 0xd8cfb5, 0x5a7a3a][ctx.seed % 4], 6, 2, 'none'));
  }
}

export function fullingMill(ctx: Ctx, def: BuildingDef): void { watermill(ctx, def, true); }

// ---------------------------------------------------------------------------
// Post windmill

function windmillSails(R: number, lod: 0 | 1 | 2, sailCol: number): MeshBuilder {
  const b = new MeshBuilder(91);
  b.layer = Layer.Detail;
  b.flags = F.Burn;
  const wood = 0x8a6a46, woodL = 0xa8875e;
  b.cyl(0, 0, -0.35, 0.35, 0.32, 0.32, 8, { side: 0x4e3a26, top: 0x5a432d, bottom: 0x5a432d });
  for (let k = 0; k < 4; k++) {
    b.push();
    b.rotZ((k / 4) * Math.PI * 2 + Math.PI / 4);
    // Whip (stock) and the lattice sail frame on its trailing side.
    b.box(-0.09, 0.2, 0.08, 0.09, R, 0.24, wood);
    const x0 = 0.1, x1 = 1.45, y0 = R * 0.24, y1 = R * 0.98;
    b.box(x1 - 0.06, y0, 0.12, x1, y1, 0.2, woodL, 'b');
    const bars = lod === 0 ? 9 : 4;
    for (let i = 0; i <= bars; i++) {
      const y = y0 + ((y1 - y0) * i) / bars;
      b.box(x0, y - 0.03, 0.13, x1, y + 0.03, 0.19, woodL, 'b');
    }
    // Canvas spread on the frame (visible from both sides as two faces).
    b.quad([x0, y0, 0.15], [x1, y0, 0.15], [x1, y1, 0.15], [x0, y1, 0.15], sailCol);
    b.quad([x1, y0, 0.15], [x0, y0, 0.15], [x0, y1, 0.15], [x1, y1, 0.15], shade(sailCol, 0.92));
    b.pop();
  }
  return b;
}

export function windmill(ctx: Ctx, def: BuildingDef): void {
  const { s, level: q, b, lod } = ctx;
  void def;
  const postTop = q >= 2 ? 3.6 : 3.2;
  // Trestle: piers, crosstrees, quarterbars and the main post (static).
  b.state({ layer: Layer.Wall, flags: F.Snow | F.Burn }, () => {
    for (const [x, z] of [[-2.3, 0], [2.3, 0], [0, -2.3], [0, 2.3]] as [number, number][]) b.box(x - 0.35, -0.3, z - 0.35, x + 0.35, 0.55, z + 0.35, { side: COL.brick, top: shade(COL.brick, 1.1) });
    b.box(-2.5, 0.55, -0.16, 2.5, 0.85, 0.16, s.timber);
    b.box(-0.16, 0.55, -2.5, 0.16, 0.85, 2.5, s.timber);
    for (const [x, z] of [[-2.2, 0], [2.2, 0], [0, -2.2], [0, 2.2]] as [number, number][]) b.beam([x, 0.8, z], [x * 0.12, postTop - 0.9, z * 0.12], 0.17, 0.17, s.timber);
    b.box(-0.27, 0.55, -0.27, 0.27, postTop + 0.2, 0.27, s.timber);
  });
  if (q >= 2) {
    // Roundhouse enclosing the trestle.
    const R = 2.55;
    b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
      b.push();
      const col = s.id === 'norse' ? COL.plankTar : s.id === 'cymric' ? COL.limewash : COL.rubble;
      b.lathe([[R + 0.1, -0.4], [R + 0.1, 0.3], [R, 0.4], [R, 2.4]], lod === 0 ? 14 : 8, [shade(col, 0.85), col, col], {});
      b.pop();
    });
    b.push(); b.translate(0, 0, R); opening(ctx, { side: 'pz', u: 0, w: 0.9, h: 1.85, y: 0, kind: 'door', frame: 'timber' }); b.pop();
    const lk = roofLook(s.id === 'norse' ? 'turf' : 'thatch', s.thatch);
    buildCone(b, 0, 0, 2.4, R, 1.1, lod === 0 ? 14 : 8, lk, 0.3, lod);
  } else {
    ctx.out.doors.push({ x: 0, z: 2.9 });
  }
  // The buck: weatherboarded body on the post, turns to face the wind; sails spin on its front.
  const buck = new MeshBuilder(55);
  buck.layer = Layer.Wall;
  buck.flags = F.Snow | F.Burn;
  const bw = q >= 2 ? 3.2 : 2.8, bd = q >= 2 ? 3.4 : 3.0, bh = q >= 2 ? 5.0 : 4.4;
  const white = s.id === 'anglo' || s.id === 'franc' || s.id === 'teuton';
  const boardCol = s.id === 'norse' ? COL.plankTar : white ? 0xe9e4d6 : COL.weatherboardGrey;
  const sub: Ctx = { ...ctx, b: buck, out: { doors: [], smoke: [], anims: [], flags: [], emitters: [], fire: [] } };
  const brect: Rect = { x0: -bw / 2, x1: bw / 2, z0: -bd / 2, z1: bd / 2 };
  house(sub, {
    rect: brect, plinthH: 0, noFloor: true,
    storeys: [{ h: bh, wall: 'weatherboard', color: boardCol, frame: 'none', openings: [
      { side: 'nz', u: 0, w: 0.8, h: 1.7, y: 0.1, kind: 'door', frame: 'timber' },
      { side: 'px', u: 0, w: 0.4, h: 0.4, y: 2.6, kind: 'window', frame: 'timber', mullions: 0 },
      { side: 'nx', u: 0, w: 0.4, h: 0.4, y: 2.6, kind: 'window', frame: 'timber', mullions: 0 },
    ] }],
    roof: { type: 'gable', axis: 'z', pitch: 34, mat: q >= 2 && s.id !== 'norse' ? 'lead' : 'plank', tint: q >= 2 ? COL.lead : 0x8a7a66, ov: 0.15, gov: 0.25, ridge: 'plain', frame: false },
  });
  // Ladder and tail pole at the back.
  buck.state({ layer: Layer.Detail, flags: F.Burn | F.Snow }, () => {
    buck.beam([-0.4, 0.05, -bd / 2], [-0.4, -postTop + 0.1, -bd / 2 - 1.15], 0.07, 0.1, s.timber);
    buck.beam([0.4, 0.05, -bd / 2], [0.4, -postTop + 0.1, -bd / 2 - 1.15], 0.07, 0.1, s.timber);
    for (let i = 1; i < 9; i++) { const t = i / 9; buck.box(-0.4, -postTop * t + 0.05, -bd / 2 - 1.15 * t - 0.05, 0.4, -postTop * t + 0.1, -bd / 2 - 1.15 * t + 0.05, s.timber); }
    buck.beam([0, 0.6, -bd / 2], [0, -postTop + 0.6, -bd / 2 - 1.25], 0.14, 0.14, s.timber);
    // Windshaft nose.
    buck.tube([0, bh * 0.72, bd / 2 - 0.2], [0, bh * 0.72 + 0.12, bd / 2 + 0.5], 0.17, 0.15, 6, 0x4e3a26);
  });
  const R = q >= 2 ? 7.0 : 6.2;
  const sailCol = s.id === 'norse' ? 0xd8cfb8 : 0xeee6d2;
  const sails: import('../parts').AnimPart = { pivot: [0, postTop + bh * 0.72 + 0.12, bd / 2 + 0.55], builder: windmillSails(R, lod, sailCol), kind: 'spinZ', speed: 0.9, mat: 'opaque' };
  ctx.out.anims.push({ pivot: [0, postTop, 0], builder: buck, kind: 'yawToWind', speed: 0.2, mat: 'opaque', children: [sails] });
}

// ---------------------------------------------------------------------------
// Smithy

export function smithy(ctx: Ctx, def: BuildingDef): void {
  const { s, level: q, b, lod } = ctx;
  const ww = workWall(ctx);
  const mat: RoofMat = q >= 3 ? s.richRoof : ww.mat === 'heather' ? 'thatch' : ww.mat;
  const { ov, gov } = ovFor(mat);
  const endIn = (s.id === 'gael' ? ov : gov) + 0.15;
  const rect: Rect = { x0: -def.w / 2 + endIn, x1: def.w / 2 - endIn, z0: -def.d / 2 + ov + 0.15, z1: def.d / 2 - 0.7 };
  const L = rect.x1 - rect.x0;
  const wall: WallKind = q >= 2 ? (s.id === 'norse' ? 'planks' : s.id === 'cymric' ? 'whitewash' : 'rubble') : ww.wall === 'daub' ? 'daub' : ww.wall;
  const open = q === 1;
  const res = house(ctx, {
    rect, plinthH: 0.2,
    storeys: [{ h: 2.8, wall, frame: open && wall === 'daub' ? (ww.frame === 'close' ? 'box' : ww.frame) : 'none', open: open ? ['pz'] : undefined, postSpacing: 2.4, openings: open ? [] : [
      { side: 'pz', u: -0.6, w: 2.2, h: 2.2, y: 0, kind: 'wide', frame: 'timber', open: true },
      { side: 'pz', u: L / 2 - 0.9, w: 0.8, h: 0.7, y: 1.1, kind: 'window', frame: 'timber', lit: 1 },
      { side: 'px', u: 0, w: 0.8, h: 0.7, y: 1.1, kind: 'window', frame: 'timber', lit: 1 },
    ] }],
    roof: { type: s.id === 'gael' ? 'hip' : 'gable', pitch: s.pitch, mat, ov, gov, ridge: 'plain' },
  });
  if (open) strawFloor(b, rect, 0.05);
  // Forge hearth with glowing coals, hood and chimney.
  const fx = rect.x0 + 1.0, fz = rect.z0 + 0.9;
  b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
    b.box(fx - 0.75, 0, fz - 0.6, fx + 0.75, 0.85, fz + 0.6, { side: COL.stoneGrey, top: COL.stoneDark });
    b.taperBox(fx - 0.8, 1.7, fz - 0.65, fx + 0.8, 2.5, fz + 0.65, 0.35, 0.3, COL.stoneGrey);
  });
  b.state({ layer: Layer.Detail, mat: Mat.Glow, flags: F.NoAO }, () => {
    b.blob(fx, 0.88, fz + 0.05, 0.45, 0.07, 0.4, COL.ember, 0.3);
    b.blob(fx, 0.92, fz + 0.05, 0.25, 0.06, 0.22, COL.fire, 0.3, 0, 2);
  });
  chimney(ctx, { x: fx, z: fz, baseY: 2.5, topY: res.roof.topY + 0.8, w: 0.75, d: 0.75, color: COL.stoneGrey });
  ctx.out.emitters.push({ kind: 'sparks', pos: [fx, 1.0, fz + 0.1], rate: 0.6 });
  // Bellows, anvil, quench tub.
  if (lod < 2) b.state({ layer: Layer.Detail, flags: F.Burn | F.Snow }, () => {
    b.push(); b.translate(fx + 1.0, 0.6, fz - 0.2);
    b.extrude([[-0.5, 0], [0.45, 0.12], [0.45, 0.3], [-0.5, 0.18]], -0.25, 0.25, 0x5a3e2a, 0x4a3222);
    b.pop();
    b.box(fx + 1.4, 0, fz - 0.3, fx + 1.5, 0.6, fz - 0.1, s.timber);
  });
  const ax = rect.x0 + L * 0.55, az = rect.z0 + (rect.z1 - rect.z0) * 0.55;
  decor(ctx, 'anvil', ax, az, 0.4);
  ctx.out.emitters.push({ kind: 'sparks', pos: [ax, 0.9, az], rate: 1.2 });
  decor(ctx, 'barrel', ax + 1.1, az + 0.2);
  if (q >= 2) decor(ctx, 'woodpile', rect.x1 - 0.9, rect.z1 + 0.32);
  if (q >= 3) {
    decor(ctx, 'grindstone', rect.x0 + 2.4, rect.z1 + 0.35);
    hangingSign(ctx, rect.x1 - 0.3, res.eaveY - 0.7, rect.z1, 'horseshoe');
  }
}

/** Projecting bracket with a swinging sign board (animated). */
export function hangingSign(ctx: Ctx, x: number, y: number, z: number, motif: 'horseshoe' | 'tankard' | 'bush' | 'boot' | 'key'): void {
  const { b, s } = ctx;
  b.state({ layer: Layer.Detail, flags: F.Burn | F.Snow }, () => {
    b.box(x - 0.06, y - 0.06, z, x + 0.06, y + 0.06, z + 0.62, COL.iron);
    b.beam([x, y - 0.5, z + 0.02], [x, y, z + 0.45], 0.04, 0.04, COL.iron);
  });
  const sign = new MeshBuilder(13);
  sign.layer = Layer.Detail;
  sign.flags = F.Burn;
  sign.box(-0.04, -0.75, -0.24, 0.04, -0.1, 0.24, { side: s.timber, px: 0xd8c79a, nx: 0xd8c79a });
  const col = motif === 'horseshoe' ? COL.iron : motif === 'tankard' ? 0x8a6a3a : motif === 'bush' ? COL.green : motif === 'key' ? COL.gold : 0x5a3a2a;
  for (const sd of [1, -1]) {
    sign.push(); sign.translate(sd * 0.045, -0.48, 0); sign.rotY(sd * Math.PI / 2);
    if (motif === 'horseshoe') {
      for (let i = 0; i < 7; i++) { const a0 = Math.PI * (0.1 + (i / 7) * 1.8) - Math.PI / 2, a1 = Math.PI * (0.1 + ((i + 1) / 7) * 1.8) - Math.PI / 2; sign.quad([Math.cos(a0) * 0.18, Math.sin(a0) * 0.18, 0], [Math.cos(a1) * 0.18, Math.sin(a1) * 0.18, 0], [Math.cos(a1) * 0.26, Math.sin(a1) * 0.26, 0], [Math.cos(a0) * 0.26, Math.sin(a0) * 0.26, 0], col); }
    } else {
      sign.quad([-0.15, -0.2, 0], [0.15, -0.2, 0], [0.15, 0.2, 0], [-0.15, 0.2, 0], col);
    }
    sign.pop();
  }
  ctx.out.anims.push({ pivot: [x, y, z + 0.4], builder: sign, kind: 'swing', speed: 0.12, mat: 'opaque' });
  void s;
}

// ---------------------------------------------------------------------------

export function carpenter(ctx: Ctx, def: BuildingDef): void {
  const { b, level: q, lod } = ctx;
  const res = vernacular(ctx, {
    W: def.w, D: def.d, q,
    storeys: q >= 2 ? 2 : 1, jetty: q >= 3 ? 0.35 : 0,
    wideDoor: true, doorAt: 0.12, doorW: 2.0,
    frontWindows: 1, backWindows: 1, chimney: q >= 2 ? 'ridge' : 'none',
    frontMargin: 0.68,
  });
  const rc = res.rect;
  // Workbench, sawhorse with a log and planks in the front margin / under the eaves.
  if (lod === 0) b.state({ layer: Layer.Decor, flags: F.Burn | F.Snow }, () => {
    const z = rc.z1 + 0.28;
    b.box(rc.x0 + 0.3, 0.8, z - 0.2, rc.x0 + 1.9, 0.88, z + 0.2, 0xa8875e);
    for (const x of [rc.x0 + 0.4, rc.x0 + 1.8]) b.box(x - 0.05, 0, z - 0.16, x + 0.05, 0.8, z + 0.16, COL.timber);
    b.blob(rc.x0 + 1.0, 0.9, z, 0.18, 0.04, 0.12, 0xd8c08a, 0.4);
  });
  decor(ctx, 'plank_pile' as never, rc.x1 - 1.5, rc.z1 + 0.35, 0, 0.5);
  void q;
}

export function sawpit(ctx: Ctx, def: BuildingDef): void {
  const { s, b, lod } = ctx;
  const hw = def.w / 2 - 0.3, hd = def.d / 2 - 0.3;
  // The pit: dark timber-lined hole with a log across it on trestles.
  b.state({ layer: Layer.Ground, flags: F.NoAO }, () => {
    b.box(-2.4, -0.02, -0.55, 2.4, 0.02, 0.55, 0x1f1812, 'b');
    for (const z of [-0.6, 0.6]) b.box(-2.5, -0.05, z - 0.08, 2.5, 0.12, z + 0.08, s.timber);
    for (const x of [-2.5, 2.5]) b.box(x - 0.08, -0.05, -0.6, x + 0.08, 0.12, 0.6, s.timber);
    b.box(-3.6, -0.02, -1.4, -2.6, 0.03, 1.2, { top: 0xd2b480, side: 0xd2b480 }, 'b');
  });
  b.state({ layer: Layer.Wall, flags: F.Burn | F.Snow }, () => {
    for (const x of [-1.6, 1.6]) b.box(x - 0.1, 0.12, -0.75, x + 0.1, 0.4, 0.75, s.timber);
    b.tube([-3.0, 0.62, 0], [3.0, 0.6, 0.05], 0.24, 0.22, 7, { side: COL.bark, top: 0xc9a77a, bottom: 0xc9a77a });
    b.box(0.3, 0.2, -0.02, 0.36, 1.8, 0.02, COL.iron);
    // Pent-roof shelter on posts.
    for (const [x, z] of [[-hw + 0.2, -hd + 0.2], [hw - 0.2, -hd + 0.2], [-hw + 0.2, hd - 0.3], [hw - 0.2, hd - 0.3]] as [number, number][]) b.box(x - 0.09, -0.3, z - 0.09, x + 0.09, z < 0 ? 2.8 : 2.3, z + 0.09, s.timber);
  });
  const mat: RoofMat = s.id === 'norse' ? 'turf' : s.id === 'gael' ? 'heather' : s.id === 'anglo' || s.id === 'franc' ? 'thatch' : 'tile';
  const lk = roofLook(mat, roofTint(mat, s));
  buildRoof(b, { x0: -hw + 0.1, x1: hw - 0.1, z0: -hd + 0.1, z1: hd - 0.3, eaveY: 2.3, type: 'shed', low: 'pz', pitch: 14, mat: mat, ov: 0.2, gov: 0.15, frame: false } as never, { ...lk, thickness: Math.min(0.3, lk.thickness) }, lod);
  decor(ctx, 'plank_pile' as never, 2.6, 1.3, 0, 0.5);
  ctx.out.doors.push({ x: 0, z: hd + 0.5 });
}

export function tannery(ctx: Ctx, def: BuildingDef): void {
  const { s, level: q, b, lod } = ctx;
  const W = def.w, D = def.d;
  const ww = workWall(ctx);
  const mat: RoofMat = ww.mat === 'heather' ? 'thatch' : ww.mat;
  const { ov, gov } = ovFor(mat);
  const rect: Rect = { x0: -W / 2 + ov + 0.15, x1: -W / 2 + (q >= 2 ? 6.0 : 4.8), z0: -D / 2 + gov + 0.15, z1: D / 2 - gov - 0.2 };
  const res = house(ctx, {
    rect, plinthH: 0.25,
    storeys: [
      { h: 2.6, wall: ww.wall, frame: ww.frame, openings: [{ side: 'px', u: 0.6, w: 1.0, h: 2.0, y: 0, kind: 'door', frame: 'timber' }, { side: 'pz', u: 0, w: 0.7, h: 0.6, y: 1.2, kind: 'window', frame: 'timber', shutters: true }] },
      ...(q >= 2 ? [{ h: 1.8, wall: 'weatherboard' as WallKind, frame: 'none' as FrameKind, openings: [{ side: 'pz' as const, u: 0, w: 2.6, h: 1.2, y: 0.3, kind: 'louvre' as const, frame: 'timber' as const }, { side: 'px' as const, u: 0, w: 2.0, h: 1.2, y: 0.3, kind: 'louvre' as const, frame: 'timber' as const }] }] : []),
    ],
    roof: { type: 'gable', axis: 'z', pitch: s.pitch, mat, ov, gov, ridge: 'plain' },
  });
  void res;
  // Yard of tanning pits and hide racks, entered from the front.
  const x0 = rect.x1 + 0.4;
  ctx.out.doors.push({ x: (rect.x1 + W / 2) / 2, z: D / 2 + 0.4 });
  b.state({ layer: Layer.Ground, flags: F.Snow }, () => {
    for (let i = 0; i < (q >= 2 ? 6 : 4); i++) {
      const vx = x0 + 0.6 + (i % 2) * 1.5, vz = -D / 2 + 0.9 + Math.floor(i / 2) * 1.45;
      b.box(vx - 0.62, -0.2, vz - 0.55, vx + 0.62, 0.42, vz + 0.55, { side: COL.timber, top: shade(COL.timber, 1.1) });
      b.state({ mat: Mat.Water, flags: F.NoAO }, () => b.box(vx - 0.52, 0.2, vz - 0.45, vx + 0.52, 0.36, vz + 0.45, i % 3 === 2 ? 0x6a5a3a : COL.waterMurk, 'b'));
    }
  });
  if (lod < 2) b.state({ layer: Layer.Decor, flags: F.Burn | F.Snow }, () => {
    const rx = W / 2 - 0.6;
    for (const z of [-D / 2 + 0.6, D / 2 - 0.6]) b.box(rx - 0.06, -0.3, z - 0.06, rx + 0.06, 2.0, z + 0.06, s.timber);
    b.box(rx - 0.05, 1.9, -D / 2 + 0.6, rx + 0.05, 2.0, D / 2 - 0.6, s.timber);
    for (let i = 0; i < 3; i++) {
      const z = -D / 2 + 1.3 + i * 1.5;
      b.quad([rx + 0.02, 0.6, z - 0.55], [rx + 0.02, 0.6, z + 0.55], [rx + 0.02, 1.9, z + 0.6], [rx + 0.02, 1.9, z - 0.6], i === 1 ? 0x8a6040 : COL.hide);
      b.quad([rx - 0.02, 0.6, z + 0.55], [rx - 0.02, 0.6, z - 0.55], [rx - 0.02, 1.9, z - 0.6], [rx - 0.02, 1.9, z + 0.6], shade(COL.hide, 0.85));
    }
  });
}

export function weaver(ctx: Ctx, def: BuildingDef): void {
  const { b, level: q, lod } = ctx;
  const res = vernacular(ctx, {
    W: def.w, D: def.d, q,
    storeys: q >= 2 ? 2 : 1, jetty: q >= 3 ? 0.35 : 0,
    frontWindows: 0, backWindows: 1, doorAt: -0.32, chimney: q >= 2 ? 'gable' : 'louvre',
    extra: [{ side: 'pz', u: 1.0, w: 2.6, h: 0.8, y: 1.0, kind: 'window', frame: 'timber', mullions: 4, shutters: true }],
    decor: ['bench'],
  });
  // A bolt of cloth hung out on a pole by the door as the trade sign.
  const rc = res.rect;
  const L = rc.x1 - rc.x0;
  const px = (rc.x0 + rc.x1) / 2 - 0.32 * L - 0.95;
  b.state({ layer: Layer.Detail, flags: F.Burn }, () => b.box(px - 0.04, 2.0, rc.z1, px + 0.04, 2.08, rc.z1 + 0.5, ctx.s.timber));
  if (lod < 2) b.state({ layer: Layer.Detail, mat: Mat.Cloth, flags: F.NoAO }, () => {
    b.push(); b.translate(px, 0, rc.z1 + 0.42); b.rotY(Math.PI / 2);
    clothQuad(b, -0.2, 1.1, 0.2, 2.02, 0, [0xa8302a, 0x2f4f8a, 0x3f6a3a, 0xc9a23a][ctx.seed % 4], 2, 3, 'top');
    b.pop();
  });
  void q;
}

export function bakehouse(ctx: Ctx, def: BuildingDef): void {
  const { s, level: q, b, lod } = ctx;
  const wall: WallKind = s.id === 'norse' ? 'planks' : s.id === 'cymric' ? 'whitewash' : q >= 2 || s.id === 'gael' ? 'rubble' : s.homeWall[0];
  const mat: RoofMat = q >= 2 ? s.richRoof : s.homeRoof[0] === 'heather' ? 'thatch' : s.homeRoof[0];
  const { ov, gov } = ovFor(mat);
  const rect: Rect = { x0: -def.w / 2 + gov + 0.15, x1: def.w / 2 - gov - 0.15, z0: -def.d / 2 + 1.45, z1: def.d / 2 - 0.68 };
  const L = rect.x1 - rect.x0;
  const res = house(ctx, {
    rect, plinthH: 0.2,
    storeys: [{ h: 2.6, wall, frame: wall === 'daub' ? (s.id === 'teuton' ? 'fachwerk' : 'box') : 'none', openings: [
      { side: 'pz', u: -L / 2 + 0.9, w: 0.95, h: 1.95, y: 0, kind: 'door', frame: 'timber' },
      { side: 'pz', u: 0.8, w: q >= 2 ? 1.8 : 0.8, h: 0.8, y: 1.0, kind: 'window', frame: 'timber', shutters: true, lit: 1 },
    ] }],
    roof: { type: 'gable', pitch: s.pitch, mat, ov, gov, ridge: 'plain' },
  });
  // Domed bread oven bulging from the back wall.
  b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
    b.push(); b.translate(0.4, 0, rect.z0);
    b.lathe([[1.15, -0.3], [1.15, 0.5], [1.05, 1.0], [0.8, 1.45], [0.4, 1.75], [0.0, 1.85]], lod === 0 ? 10 : 6, [COL.stoneGrey, shade(COL.stoneGrey, 1.05), 0xb8a890, 0xb8a890, 0xb0a088], { sz: 1.0 });
    b.pop();
  });
  chimney(ctx, { x: 0.4, z: rect.z0 + 0.25, baseY: res.eaveY - 1.0, topY: res.roof.topY + 0.6, w: 0.7, d: 0.7, color: q >= 2 ? COL.brick : COL.stoneGrey, pots: q >= 2 ? 1 : 0 });
  // Loaves on a board by the window and faggots of brushwood.
  if (lod === 0) b.state({ layer: Layer.Decor, flags: F.Snow }, () => {
    const z = rect.z1 + 0.32;
    b.box(0.0, 0.8, z - 0.22, 1.6, 0.86, z + 0.22, 0xa8875e);
    for (let i = 0; i < 5; i++) b.blob(0.15 + i * 0.32, 0.92, z + (i % 2) * 0.08 - 0.04, 0.13, 0.07, 0.1, 0xb07a3a, 0.2, 0, i);
    for (const x of [0.1, 1.5]) b.box(x - 0.04, 0, z - 0.18, x + 0.04, 0.8, z + 0.18, COL.timber);
  });
  decor(ctx, 'woodpile', rect.x1 - 0.9, rect.z1 + 0.3, 0, 0.9);
  ctx.out.smoke.push([0.4, 2.1, rect.z0 - 0.4]);
}

export function brewhouse(ctx: Ctx, def: BuildingDef): void {
  const { s, level: q, b, lod } = ctx;
  const W = def.w;
  const kilnR = q >= 2 ? 1.5 : 0;
  const shift = kilnR ? -1.6 : 0;
  b.push();
  b.translate(shift, 0, 0);
  const res = vernacular(ctx, {
    W: W - (kilnR ? 3.2 : 0), D: def.d, q, chimney: 'ridge', frontWindows: 2, doorAt: 0.25,
    decor: ['barrel', 'barrel'],
  });
  // Louvred vent on the ridge for the steam.
  const rc = res.rect;
  cupola(ctx, (rc.x0 + rc.x1) / 2 - 0.8, (rc.z0 + rc.z1) / 2, res.roof.topY - 0.3, 1.0, 0.7, s.homeRoof[0] === 'heather' ? 'thatch' : s.homeRoof[Math.min(2, q - 1)], { open: false });
  aleStake(ctx, rc.x0 + 0.6, res.eaveY - 0.4, rc.z1);
  b.pop();
  if (kilnR) {
    // Malting kiln: round tower with a conical roof and a white cowl.
    const kx = W / 2 - kilnR - 0.25;
    const H = 4.6;
    b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
      b.push(); b.translate(kx, 0, 0);
      b.lathe([[kilnR + 0.08, -0.4], [kilnR + 0.08, 0.3], [kilnR, 0.4], [kilnR, H]], lod === 0 ? 12 : 8, [COL.brick, COL.brick, shade(COL.brick, 1.05)], {});
      b.pop();
    });
    const lk = roofLook('tile', roofTint('tile', s));
    const top = buildCone(b, kx, 0, H, kilnR, 2.6, lod === 0 ? 12 : 8, lk, 0.2, lod);
    b.state({ layer: Layer.Roof, flags: F.Snow }, () => {
      b.cyl(kx, 0, top - 0.3, top + 0.35, 0.42, 0.42, 6, { side: COL.white, top: COL.white }, { top: false });
      b.box(kx - 0.45, top + 0.2, -0.45, kx + 0.45, top + 0.75, 0.05, { side: COL.white, top: COL.white });
      b.box(kx + 0.05, top + 0.35, 0.05, kx + 0.12, top + 0.42, 0.85, COL.timber);
    });
    ctx.out.smoke.push([kx, top + 0.8, 0.3]);
  }
}

/** Ale-stake: a pole projecting from the wall with a bush hung on the end (sign of fresh ale). */
export function aleStake(ctx: Ctx, x: number, y: number, z: number): void {
  const { b } = ctx;
  b.state({ layer: Layer.Detail, flags: F.Burn | F.Snow }, () => {
    b.beam([x, y, z], [x, y + 0.2, z + 0.4], 0.07, 0.07, COL.timber);
    b.beam([x, y + 0.2, z + 0.4], [x, y - 0.05, z + 0.4], 0.02, 0.02, COL.rope);
  });
  b.state({ layer: Layer.Detail, flags: F.Snow }, () => b.blob(x, y - 0.22, z + 0.4, 0.24, 0.24, 0.18, 0x4f7a32, 0.3));
}

export function kiln(ctx: Ctx, def: BuildingDef): void {
  const { b, lod } = ctx;
  void def;
  const col = 0xa88e74;
  b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
    b.lathe([[1.55, -0.4], [1.55, 0.6], [1.4, 1.3], [1.05, 1.9], [0.55, 2.3], [0.32, 2.4], [0.32, 2.6]], lod === 0 ? 12 : 7, [shade(col, 0.85), col, shade(col, 1.05), col, shade(col, 0.9), 0x5a4a3c], {});
  });
  // Stoking arch, glowing.
  b.push(); b.translate(0, 0, 1.5);
  b.state({ layer: Layer.Detail, flags: F.Snow }, () => b.flat([[-0.5, 0], [0.5, 0], [0.5, 0.5], [0, 0.78], [-0.5, 0.5]], 0.06, COL.stoneDark));
  b.state({ layer: Layer.Detail, mat: Mat.Glow, flags: F.NoAO }, () => b.flat([[-0.36, 0.02], [0.36, 0.02], [0.36, 0.42], [0, 0.62], [-0.36, 0.42]], 0.09, COL.ember));
  b.pop();
  ctx.out.smoke.push([0, 2.8, 0]);
  ctx.out.doors.push({ x: 0, z: 1.9 });
  decor(ctx, 'woodpile', -1.0, 1.65, 0.6, 0.7);
  if (lod === 0) b.state({ layer: Layer.Decor, flags: F.Snow }, () => {
    for (let i = 0; i < 4; i++) {
      b.push(); b.translate(1.25 + (i % 2) * 0.35, (i > 1 ? 0.42 : 0), 1.3 + (i % 2) * 0.1);
      b.lathe([[0.1, 0], [0.18, 0.15], [0.15, 0.32], [0.1, 0.4], [0.12, 0.42]], 6, i % 2 ? 0xb8683e : 0xa8583a, { capTop: true });
      b.pop();
    }
  });
}

export function charcoalMound(ctx: Ctx, def: BuildingDef): void {
  const { b, lod } = ctx;
  void def;
  b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
    b.lathe([[2.1, -0.3], [2.05, 0.3], [1.75, 0.95], [1.2, 1.45], [0.5, 1.75], [0.0, 1.8]], lod === 0 ? 12 : 7, [0x3a3026, 0x463a2c, 0x3f3428, 0x4a3e2e, 0x2e2722], {});
  });
  for (let i = 0; i < 4; i++) {
    const a = i * 1.6 + 0.4, r = i === 0 ? 0.2 : 1.35, y = i === 0 ? 1.8 : 1.15;
    const p: V3 = [Math.cos(a) * r, y, Math.sin(a) * r];
    if (lod < 2) b.state({ layer: Layer.Detail, mat: Mat.Glow, flags: F.NoAO }, () => b.blob(p[0], p[1], p[2], 0.12, 0.05, 0.12, COL.ember, 0.2, 0, i));
    ctx.out.smoke.push(p);
  }
  // Billets stacked around, a ladder and a rake.
  if (lod === 0) b.state({ layer: Layer.Decor, flags: F.Burn | F.Snow }, () => {
    for (let i = 0; i < 6; i++) b.tube([-2.3 + i * 0.12, 0.12, 1.9 - i * 0.05], [-1.1 + i * 0.12, 0.12 + (i % 2) * 0.05, 2.2 - i * 0.05], 0.09, 0.09, 5, COL.bark, { caps: false });
    b.beam([1.6, 0, 1.2], [0.9, 1.6, 0.7], 0.05, 0.05, COL.timber);
    b.beam([1.85, 0, 1.0], [1.15, 1.6, 0.5], 0.05, 0.05, COL.timber);
  });
  ctx.out.doors.push({ x: 0, z: 2.4 });
}

export function bloomery(ctx: Ctx, def: BuildingDef): void {
  const { s, level: q, b, lod } = ctx;
  const hw = def.w / 2 - 0.25, hd = def.d / 2 - 0.25;
  const furnaces = q >= 2 ? [-1.0, 1.0] : [0];
  for (const fx of furnaces) {
    b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
      b.push(); b.translate(fx, 0, -0.4);
      b.lathe([[0.75, -0.3], [0.72, 0.35], [0.55, 1.2], [0.4, 2.0], [0.3, 2.1]], lod === 0 ? 9 : 6, [0x9a6a4a, 0xa8785a, 0x9a6a4a, 0x7a5a42], {});
      b.pop();
    });
    b.state({ layer: Layer.Detail, mat: Mat.Glow, flags: F.NoAO }, () => {
      b.push(); b.translate(fx, 0, 0.32);
      b.flat([[-0.18, 0.15], [0.18, 0.15], [0.18, 0.45], [0, 0.55], [-0.18, 0.45]], 0.02, COL.fire);
      b.pop();
      b.blob(fx, 2.1, -0.4, 0.2, 0.05, 0.2, COL.ember, 0.2);
    });
    ctx.out.smoke.push([fx, 2.3, -0.4]);
    ctx.out.emitters.push({ kind: 'sparks', pos: [fx, 0.45, 0.4], rate: 0.5 });
    // Bellows.
    if (lod < 2) b.state({ layer: Layer.Detail, flags: F.Burn | F.Snow }, () => {
      b.push(); b.translate(fx + 0.85, 0.5, -0.4); b.rotY(Math.PI / 2);
      b.extrude([[-0.45, 0], [0.4, 0.1], [0.4, 0.26], [-0.45, 0.16]], -0.22, 0.22, 0x5a3e2a, 0x4a3222);
      b.pop();
    });
  }
  // Shelter: pent roof on posts, stone back wall at level 2.
  b.state({ layer: Layer.Wall, flags: F.Burn | F.Snow }, () => {
    for (const [x, z] of [[-hw + 0.15, -hd + 0.15], [hw - 0.15, -hd + 0.15], [-hw + 0.15, hd - 0.4], [hw - 0.15, hd - 0.4]] as [number, number][]) b.box(x - 0.09, -0.3, z - 0.09, x + 0.09, z < 0 ? 3.2 : 2.7, z + 0.09, s.timber);
    if (q >= 2) b.box(-hw, -0.3, -hd, hw, 2.4, -hd + 0.45, { side: COL.rubble, top: COL.stoneGrey });
  });
  const mat: RoofMat = s.id === 'norse' ? 'turf' : 'shingle';
  const lk = roofLook(mat, roofTint(mat, s));
  buildRoof(b, { x0: -hw, x1: hw, z0: -hd, z1: hd - 0.4, eaveY: 2.7, type: 'shed', low: 'pz', pitch: 12, mat, ov: 0.2, gov: 0.15, frame: false } as never, { ...lk, thickness: 0.14 }, lod);
  // Ore (red), charcoal (black) and slag heaps.
  if (lod < 2) b.state({ layer: Layer.Decor, flags: F.Snow }, () => {
    b.blob(-hw + 0.7, 0.05, hd - 0.4, 0.75, 0.42, 0.55, COL.ore, 0.3, 0, 1);
    b.blob(hw - 0.7, 0.05, hd - 0.4, 0.75, 0.38, 0.55, COL.coal, 0.3, 0, 2);
    b.blob(0, 0.0, hd - 0.2, 0.5, 0.25, 0.35, 0x3a3a40, 0.35, 0, 3);
  });
  ctx.out.doors.push({ x: 0, z: hd + 0.4 });
}

export function quarry(ctx: Ctx, def: BuildingDef): void {
  const { s, level: q, b, lod } = ctx;
  const hw = def.w / 2 - 0.3, hd = def.d / 2 - 0.3;
  const rock = s.id === 'franc' ? 0xd8cfba : s.id === 'teuton' ? 0xb48270 : s.id === 'anglo' ? 0xcbb894 : 0x9a968c;
  // Stepped rock face rising at the back: terraces of cut stone with rough tops.
  b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
    // Natural hillside of weathered rock with grassy crown...
    for (let i = 0; i < (lod === 0 ? 7 : 4); i++) {
      const x = -hw + 2.0 + (i * (2 * hw - 4.0)) / (lod === 0 ? 6 : 3);
      b.blob(x, 1.8, -hd + 1.75, 1.75, 3.6, 1.45, (_x, ny) => (ny > 0.5 ? 0x6f8a3c : shade(rock, 0.78 + (i % 3) * 0.06)), 0.18, 0, i * 3);
    }
    // ...cut back into two benches of fresh, pale stone faces.
    for (let i = 0; i < 2; i++) {
      const y = 1.5 + i * 1.6, z1 = -hd + 3.9 - i * 1.3, inset = 1.4 + i * 1.6;
      b.box(-hw + inset, -0.4, -hd + 0.6, hw - inset, y, z1, { side: shade(rock, 1.02), pz: shade(rock, 1.12), top: shade(rock, 0.92) });
    }
  });
  // Cut blocks and rubble on the floor.
  b.state({ layer: Layer.Decor, flags: F.Snow }, () => {
    for (let i = 0; i < (lod === 0 ? 9 : 4); i++) {
      const x = -hw + 1.2 + ((i * 3.7) % (hw * 2 - 2)), z = 0.5 + ((i * 2.3) % 5);
      b.push(); b.translate(x, 0, z); b.rotY(i * 0.7);
      b.box(-0.45, 0, -0.3, 0.45, 0.55, 0.3, { side: rock, top: shade(rock, 1.08) });
      if (i % 3 === 0) b.box(-0.4, 0.55, -0.25, 0.35, 1.0, 0.25, { side: shade(rock, 0.96), top: shade(rock, 1.08) });
      b.pop();
    }
  });
  if (q >= 2) {
    // Treadwheel crane: a great wheel driving a jib.
    const cx = hw - 3.2, cz = 1.0;
    const wheel = new MeshBuilder(5);
    wheel.layer = Layer.Detail; wheel.flags = F.Burn;
    const R = 1.7;
    for (const z of [-0.5, 0.5]) for (let i = 0; i < 12; i++) {
      const a0 = (i / 12) * Math.PI * 2, a1 = ((i + 1) / 12) * Math.PI * 2;
      wheel.beam([Math.cos(a0) * R, Math.sin(a0) * R, z], [Math.cos(a1) * R, Math.sin(a1) * R, z], 0.1, 0.12, COL.timberRaw, [0, 0, 1], 'pz nz');
      if (i % 2 === 0) wheel.beam([0, 0, z], [Math.cos(a0) * R, Math.sin(a0) * R, z], 0.08, 0.08, COL.timberRaw, [0, 0, 1], 'pz nz');
    }
    for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; wheel.box(Math.cos(a) * R - 0.05, Math.sin(a) * R - 0.05, -0.5, Math.cos(a) * R + 0.05, Math.sin(a) * R + 0.05, 0.5, COL.timber); }
    ctx.out.anims.push({ pivot: [cx, R + 0.3, cz], builder: wheel, kind: 'spinZ', speed: 0.15, mat: 'opaque' });
    b.state({ layer: Layer.Wall, flags: F.Burn | F.Snow }, () => {
      for (const z of [cz - 0.7, cz + 0.7]) { b.beam([cx - 1.2, -0.3, z], [cx, R + 0.4, z], 0.14, 0.14, s.timber); b.beam([cx + 1.2, -0.3, z], [cx, R + 0.4, z], 0.14, 0.14, s.timber); }
      b.beam([cx, R + 0.3, cz], [cx - 0.5, 6.0, cz], 0.2, 0.2, s.timber);
      b.beam([cx - 0.5, 6.0, cz], [cx - 3.5, 7.0, cz], 0.16, 0.16, s.timber);
      b.beam([cx - 3.5, 7.0, cz], [cx - 3.5, 3.4, cz], 0.03, 0.03, COL.rope);
      b.box(cx - 3.85, 2.9, cz - 0.3, cx - 3.15, 3.4, cz + 0.3, { side: rock, top: shade(rock, 1.08) });
    });
  } else {
    // Shear-legs hoist.
    b.state({ layer: Layer.Wall, flags: F.Burn | F.Snow }, () => {
      b.beam([2.5, -0.3, 2.0], [3.6, 5.2, 0.8], 0.13, 0.13, s.timber);
      b.beam([4.7, -0.3, 2.0], [3.6, 5.2, 0.8], 0.13, 0.13, s.timber);
      b.beam([3.6, 5.2, 0.8], [3.6, 1.6, 0.8], 0.03, 0.03, COL.rope);
      b.box(3.25, 1.1, 0.5, 3.95, 1.6, 1.1, { side: rock, top: shade(rock, 1.08) });
    });
  }
  ctx.out.doors.push({ x: 0, z: hd + 0.4 });
}

export function mine(ctx: Ctx, def: BuildingDef): void {
  const { s, level: q, b, lod } = ctx;
  const hw = def.w / 2 - 0.2, hd = def.d / 2 - 0.2;
  // Hillock with a timbered adit portal facing +z.
  b.state({ layer: Layer.Wall, flags: F.Snow | F.Grass }, () => {
    b.push(); b.translate(0, 0, -0.9); b.scale(1, 1, 0.68);
    b.lathe([[hw - 0.15, -0.4], [hw - 0.25, 0.6], [hw * 0.75, 1.8], [hw * 0.45, 2.7], [0.2, 3.0]], lod === 0 ? 12 : 7, [0x6a7a40, 0x6f8a3c, 0x6a8040, 0x74883e], {});
    b.pop();
  });
  b.state({ layer: Layer.Wall, flags: F.Burn | F.Snow }, () => {
    b.box(-1.1, -0.3, 0.4, 1.1, 0.0, 1.6, { side: COL.stoneGrey, top: COL.earth });
    for (const x of [-0.85, 0.85]) b.box(x - 0.13, -0.3, 1.2, x + 0.13, 2.2, 1.45, s.timber);
    b.box(-1.15, 2.2, 1.15, 1.15, 2.5, 1.5, s.timber);
  });
  b.state({ layer: Layer.Detail, flags: F.NoAO }, () => b.quad([-0.72, 0, 1.22], [0.72, 0, 1.22], [0.72, 2.2, 1.22], [-0.72, 2.2, 1.22], 0x120e0b));
  // Rails, a tub and the spoil heap.
  b.state({ layer: Layer.Ground, flags: F.Snow }, () => {
    for (const x of [-0.35, 0.35]) b.box(x - 0.04, 0, 1.3, x + 0.04, 0.08, hd, COL.iron);
    for (let i = 0; i < 4; i++) b.box(-0.55, 0, 1.6 + i * 0.4, 0.55, 0.04, 1.75 + i * 0.4, COL.timber);
  });
  if (lod < 2) b.state({ layer: Layer.Decor, flags: F.Snow }, () => {
    b.box(-0.4, 0.15, hd - 0.9, 0.4, 0.75, hd - 0.2, { side: COL.timberRaw, top: COL.ore });
    b.blob(hw - 0.85, 0.0, hd - 0.9, 0.6, 0.55, 0.6, 0x7a7670, 0.25);
  });
  if (q >= 2) {
    // Shaft head with a roofed windlass.
    const wx = -hw + 1.3, wz = hd - 1.3;
    b.state({ layer: Layer.Wall, flags: F.Burn | F.Snow }, () => {
      b.box(wx - 0.8, 0, wz - 0.8, wx + 0.8, 0.4, wz + 0.8, { side: COL.stoneGrey, top: 0x120e0b });
      for (const x of [wx - 0.75, wx + 0.75]) b.box(x - 0.08, 0, wz - 0.08, x + 0.08, 2.0, wz + 0.08, s.timber);
      b.tube([wx - 0.85, 1.2, wz], [wx + 0.85, 1.2, wz], 0.12, 0.12, 6, COL.timberRaw);
      b.beam([wx + 0.85, 1.2, wz], [wx + 1.15, 0.9, wz], 0.05, 0.05, COL.iron);
      b.beam([wx, 1.1, wz], [wx, 0.2, wz], 0.02, 0.02, COL.rope);
    });
    const lk = roofLook(s.id === 'norse' ? 'turf' : 'shingle', COL.shingle);
    buildRoof(b, { x0: wx - 0.9, x1: wx + 0.9, z0: wz - 0.7, z1: wz + 0.7, eaveY: 2.0, type: 'gable', pitch: 40, mat: 'shingle', ov: 0.15, gov: 0.15, frame: false } as never, { ...lk, thickness: 0.1, jitter: 0 }, Math.max(1, lod) as 1);
  }
  ctx.out.doors.push({ x: 0, z: hd + 0.3 });
}

export function dock(ctx: Ctx, def: BuildingDef): void {
  const { s, level: q, b, lod } = ctx;
  const hw = def.w / 2 - 0.05, hd = def.d / 2 - 0.05;
  const deckY = 0.55;
  b.state({ layer: Layer.Ground, flags: F.Snow | F.Burn }, () => {
    // Planked deck on piles; the river side is local -z.
    const n = lod === 0 ? 16 : 4;
    for (let i = 0; i < n; i++) {
      const x0 = -hw + ((2 * hw) * i) / n, x1 = -hw + ((2 * hw) * (i + 1)) / n - 0.02;
      b.box(x0, deckY - 0.12, -hd + 1.6, x1, deckY, hd, { top: shade(0x9a7a52, i % 2 ? 0.92 : 1.04), side: 0x6a5236 });
    }
    for (let i = 0; i <= 4; i++) for (const z of [-hd + 1.8, 0.6, hd - 0.3]) {
      const x = -hw + 0.2 + ((2 * hw - 0.4) * i) / 4;
      b.cyl(x, z, -2.6, deckY + (z < -hd + 0.5 ? 0.45 : -0.1), 0.15, 0.15, 6, COL.bark, { top: true, bottom: false });
    }
  });
  if (lod < 2) b.state({ layer: Layer.Detail, flags: F.Snow }, () => {
    for (const x of [-hw + 1.0, hw - 1.0]) b.cyl(x, -hd + 1.85, deckY, deckY + 0.5, 0.13, 0.15, 6, COL.timberDark);
  });
  decor(ctx, 'barrel', -2.5, 1.2);
  decor(ctx, 'crate', 2.2, 1.4);
  decor(ctx, 'sack_pile', -0.2, 1.5);
  if (lod === 0) {
    b.push(); b.translate(0, deckY, 0); b.pop();
  }
  if (q >= 2) {
    // A timber crane on the quay.
    const cx = hw - 1.0, cz = -hd + 2.4;
    b.state({ layer: Layer.Wall, flags: F.Burn | F.Snow }, () => {
      b.box(cx - 0.18, deckY, cz - 0.18, cx + 0.18, deckY + 4.8, cz + 0.18, s.timber);
      b.beam([cx, deckY + 4.6, cz], [cx - 3.4, deckY + 5.3, cz - 1.0], 0.16, 0.16, s.timber);
      b.beam([cx, deckY + 2.8, cz], [cx - 2.2, deckY + 5.0, cz - 0.65], 0.12, 0.12, s.timber);
      b.beam([cx - 3.4, deckY + 5.3, cz - 1.0], [cx - 3.4, deckY + 2.0, cz - 1.0], 0.025, 0.025, COL.rope);
      b.box(cx - 3.7, deckY + 1.4, cz - 1.3, cx - 3.1, deckY + 2.0, cz - 0.7, { side: COL.timberRaw, top: shade(COL.timberRaw, 1.1) });
    });
  }
  // A small boat moored alongside on the river side.
  if (lod < 2) {
    b.push(); b.layer = Layer.Decor; b.translate(-1.2, -0.3, -hd + 0.75); b.rotY(Math.PI / 2); b.scale(0.7, 0.7, 0.7);
    decorInto(b, 'boat', ctx.seed);
    b.layer = Layer.Wall; b.pop();
  }
  ctx.out.doors.push({ x: 0, z: hd + 0.4 });
  void fenceRun; void opening; void enterSide; void planks;
}
