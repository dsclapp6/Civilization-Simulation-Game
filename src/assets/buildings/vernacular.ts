// Generic vernacular house generator: one- or two-storey rectangular buildings in the local
// culture's walls, framing and roofing, with chimneys, lean-tos, porches and yard decor.
// Used by hovels, cottages, longhouses, alehouses and most workshops.
import type { PropKind } from '../types';
import { F, Layer, MeshBuilder, posHash, shade, type V3 } from '../core/builder';
import { decorInto } from '../props/props';
import { chimney, house, pick, windowRow, type Ctx, type HouseResult, type Opening, type Rect, type Side, type StoreyOpts } from './parts';
import { buildRoof, roofLook, type RoofMat, type RoofType } from './roof';
import { COL, roofTint, type FrameKind, type WallKind } from './style';

export interface VernOpts {
  W: number; D: number;
  /** Effective architectural level 1..3 (quality of build). */
  q: number;
  storeys?: number;
  wallH?: number;
  upperH?: number;
  wall?: WallKind;
  upperWall?: WallKind;
  frame?: FrameKind;
  upperFrame?: FrameKind;
  roofMat?: RoofMat;
  roofType?: RoofType;
  pitch?: number;
  ridge?: 'plain' | 'scallop' | 'flowers' | 'auto';
  /** Front door position along the front wall (fraction -0.5..0.5 of length). */
  doorAt?: number;
  doorW?: number;
  wideDoor?: boolean;
  backDoor?: boolean;
  frontWindows?: number;
  backWindows?: number;
  gableWindows?: boolean;
  windowW?: number;
  windowH?: number;
  /** 'gable' external stack on -x, 'gable2' both ends, 'ridge' internal, 'louvre', 'hole', 'none'. */
  chimney?: 'gable' | 'gable2' | 'ridge' | 'ridge2' | 'louvre' | 'hole' | 'none';
  /** Lean-to outshot at a gable end. */
  lean?: 'px' | 'nx';
  porch?: boolean;
  jetty?: number;
  decor?: PropKind[];
  /** Extra openings (u in metres from the wall centre). */
  extra?: Opening[];
  plinthH?: number;
  /** Turn off the default culture cruck gable. */
  noCruck?: boolean;
  /** Ridge along z instead of x. */
  axisZ?: boolean;
  /** Minimum free margin in front of the front wall (m). */
  frontMargin?: number;
}

export interface VernResult extends HouseResult { rect: Rect; }

export function ovFor(mat: RoofMat): { ov: number; gov: number } {
  switch (mat) {
    case 'thatch': case 'heather': return { ov: 0.48, gov: 0.32 };
    case 'turf': return { ov: 0.4, gov: 0.35 };
    case 'tile': case 'stoneslate': return { ov: 0.36, gov: 0.22 };
    default: return { ov: 0.3, gov: 0.2 };
  }
}

export function vernacular(ctx: Ctx, o: VernOpts): VernResult {
  const { b, s, r, lod } = ctx;
  const q = Math.max(1, Math.min(3, o.q)) - 1;
  const wall = o.wall ?? s.homeWall[q];
  const frame = o.frame ?? s.homeFrame[q];
  const roofMat = o.roofMat ?? s.homeRoof[q];
  const { ov, gov } = ovFor(roofMat);
  const storeys = o.storeys ?? 1;
  const leanW = o.lean ? 1.6 : 0;
  const chimSpace = o.chimney === 'gable' || o.chimney === 'gable2' ? 0.8 : 0;
  const porchD = o.porch ? 1.1 : 0;
  const jetty = storeys > 1 ? (o.jetty ?? 0) : 0;
  const axisZ = !!o.axisZ;
  const roofType: RoofType = o.roofType ?? (storeys > 1 ? 'gable' : s.homeRoofShape);
  // Wall rectangle inset so eaves (+ bevel/bulge margin), chimneys, lean-tos, porches and yard
  // decor all stay inside the footprint.
  const endOv = (roofType === 'hip' ? ov : gov) + 0.1;
  const frontM = Math.max(ov + 0.1, o.decor && o.decor.length ? 0.66 : 0, o.frontMargin ?? 0);
  const rect: Rect = axisZ
    ? { x0: -o.W / 2 + ov + 0.1, x1: o.W / 2 - ov - 0.1, z0: -o.D / 2 + endOv + chimSpace, z1: o.D / 2 - endOv - porchD - jetty }
    : {
      x0: -o.W / 2 + endOv + (o.lean === 'nx' ? leanW : 0) + chimSpace,
      x1: o.W / 2 - endOv - (o.lean === 'px' ? leanW : 0) - (o.chimney === 'gable2' ? chimSpace : 0),
      z0: -o.D / 2 + ov + 0.1,
      z1: o.D / 2 - frontM - porchD - jetty,
    };
  const L = rect.x1 - rect.x0, Dp = rect.z1 - rect.z0;
  const wallH = o.wallH ?? (storeys > 1 ? 2.55 : 2.6);
  const upperH = o.upperH ?? 2.2;
  const plinthH = o.plinthH ?? (wall === 'planks' ? 0.45 : wall === 'stone' || wall === 'rubble' || wall === 'whitewash' ? 0.15 : 0.3);
  const doorW = o.doorW ?? (o.wideDoor ? 2.2 : 0.95);
  const doorH = o.wideDoor ? Math.min(2.6, wallH - 0.2) : Math.min(1.95, wallH - 0.25);
  const frontLen = axisZ ? Dp : L;
  const doorU = (o.doorAt ?? -0.18) * frontLen;
  const stoneish = wall === 'stone' || wall === 'rubble' || wall === 'whitewash' || wall === 'render';
  const winW = o.windowW ?? (q === 0 ? 0.6 : q === 1 ? 0.78 : 0.95);
  const winH = o.windowH ?? (q === 0 ? 0.55 : 0.75);
  const winY = Math.min(1.05, wallH - winH - 0.35);
  const frameKind: 'timber' | 'stone' = wall === 'stone' ? 'stone' : 'timber';
  const front: Side = axisZ ? 'px' : 'pz';
  const back: Side = axisZ ? 'nx' : 'nz';
  const gA: Side = axisZ ? 'pz' : 'px', gB: Side = axisZ ? 'nz' : 'nx';
  const ground: Opening[] = [];
  ground.push({ side: axisZ ? 'pz' : 'pz', u: axisZ ? 0 : doorU, w: doorW, h: doorH, y: 0, kind: o.wideDoor ? 'wide' : 'door', frame: frameKind, shape: wall === 'stone' && q >= 1 ? 'pointed' : 'flat' });
  if (o.backDoor) ground.push({ side: back, u: (axisZ ? 0.25 : -0.18) * frontLen, w: 0.9, h: Math.min(1.9, wallH - 0.25), y: 0, kind: 'door', frame: frameKind });
  ground.push(...windowRow(axisZ ? 'pz' : 'pz', axisZ ? sideLenOf(rect, 'pz') : L, o.frontWindows ?? (q === 0 ? 2 : 3), { w: winW, h: winH, y: winY, frame: frameKind, shutters: !stoneish || r() < 0.5 }, [axisZ ? 0 : doorU]));
  ground.push(...windowRow(back, axisZ ? Dp : L, o.backWindows ?? 1, { w: winW * 0.9, h: winH, y: winY, frame: frameKind, shutters: false }, o.backDoor ? [(axisZ ? 0.25 : -0.18) * frontLen] : []));
  if (o.gableWindows ?? q > 0) ground.push({ side: gA, u: 0, w: winW * 0.8, h: winH * 0.9, y: winY, kind: 'window', frame: frameKind, shutters: !stoneish });
  if (o.extra) ground.push(...o.extra);
  void front;
  const st: StoreyOpts[] = [{ h: wallH, wall, frame, openings: ground, quoins: wall === 'stone' }];
  if (storeys > 1) {
    const uw = o.upperWall ?? wall;
    const uf = o.upperFrame ?? (frame === 'box' ? 'close' : frame);
    const ups: Opening[] = [];
    ups.push(...windowRow(axisZ ? 'pz' : 'pz', axisZ ? sideLenOf(rect, 'pz') : L + 0, axisZ ? 1 : (o.frontWindows ?? 3), { w: winW, h: winH * 0.95, y: 0.75, frame: uw === 'stone' ? 'stone' : 'timber', shutters: uw !== 'stone' }));
    ups.push(...windowRow(back, axisZ ? Dp : L, 1, { w: winW * 0.85, h: winH, y: 0.75, frame: uw === 'stone' ? 'stone' : 'timber', shutters: false }));
    st.push({ h: upperH, wall: uw, frame: uf, openings: ups, jetty: jetty > 0 ? (axisZ ? { pz: jetty } : { pz: jetty }) : undefined, quoins: uw === 'stone' });
  }
  const pitch = o.pitch ?? s.pitch;
  const cruck = !o.noCruck && frame === 'cruck';
  const res = house(ctx, {
    rect,
    plinthH,
    storeys: st,
    roof: { type: roofType, pitch, mat: roofMat, ov, gov, ridge: o.ridge ?? (s.ridgeFlowers && roofMat === 'thatch' ? 'flowers' : q >= 1 && roofMat === 'thatch' ? 'scallop' : 'plain'), axis: axisZ ? 'z' : 'x' },
    cruck,
    parapet: s.crowSteps && (wall === 'stone' || wall === 'whitewash') && roofType === 'gable' && q >= 2 ? 'crow' : undefined,
    roped: s.roped && (roofMat === 'heather' || roofMat === 'thatch'),
  });
  const roof = res.roof;
  const top = res.top;
  const ridgeTop = roof.topY;

  // Chimneys / smoke outlets
  const cz = (rect.z0 + rect.z1) / 2;
  const stackCol = wall === 'whitewash' ? COL.limewash : wall === 'stone' ? s.stone : wall === 'rubble' ? COL.rubble : s.id === 'norse' ? COL.stoneGrey : s.stone;
  const gableStack = (end: 'nx' | 'px') => {
    const x = end === 'nx' ? rect.x0 - 0.36 : rect.x1 + 0.36;
    chimney(ctx, { x, z: cz + Dp * 0.06, baseY: -0.3, topY: ridgeTop + 0.4, w: 0.6, d: 0.78, baseW: 0.72, baseD: 1.45, shoulderY: res.eaveY - 0.3, color: stackCol, pots: q >= 3 ? 1 : 0 });
  };
  switch (o.chimney ?? 'none') {
    case 'gable': gableStack('nx'); break;
    case 'gable2': gableStack('nx'); gableStack('px'); break;
    case 'ridge': case 'ridge2': {
      const xs = o.chimney === 'ridge2' ? [rect.x0 + L * 0.2, rect.x1 - L * 0.2] : [rect.x0 + L * 0.3];
      for (const x of xs) chimney(ctx, { x, z: cz, baseY: res.eaveY - 0.5, topY: ridgeTop + 0.75, w: 0.65, d: 0.6, color: q >= 2 && s.id !== 'norse' ? COL.brick : stackCol, pots: q >= 2 ? 2 : 0 });
      break;
    }
    case 'louvre': {
      // Small gabled smoke louvre on the ridge.
      const x = (rect.x0 + rect.x1) / 2 + L * 0.12;
      const y = roof.topAt(x, cz) - 0.15;
      b.state({ layer: Layer.Roof, flags: F.Snow }, () => {
        b.box(x - 0.35, y, cz - 0.3, x + 0.35, y + 0.55, cz + 0.3, { side: shade(s.timber, 1.1) });
        const lk = roofLook(roofMat, roofTint(roofMat, s));
        buildRoof(b, { x0: x - 0.35, x1: x + 0.35, z0: cz - 0.3, z1: cz + 0.3, eaveY: y + 0.55, type: 'gable', axis: 'z', pitch: 45, ov: 0.12, gov: 0.1, ridge: 'none', frame: false }, { ...lk, thickness: 0.12, jitter: 0 }, 2);
      });
      ctx.out.smoke.push([x, y + 1.0, cz]);
      break;
    }
    case 'hole': {
      const x = (rect.x0 + rect.x1) / 2 + L * 0.1;
      ctx.out.smoke.push([x, roof.topAt(x, cz) + 0.2, cz]);
      break;
    }
    case 'none': break;
  }

  // Lean-to outshot
  if (o.lean) {
    const lx0 = o.lean === 'px' ? rect.x1 : rect.x0 - leanW + 0.05;
    const lx1 = o.lean === 'px' ? rect.x1 + leanW - 0.05 : rect.x0;
    const lr: Rect = { x0: lx0, x1: lx1, z0: rect.z0 + 0.3, z1: rect.z1 - 0.2 };
    const lh = Math.min(1.9, wallH - 0.3);
    house(ctx, {
      rect: lr, plinthH: Math.min(plinthH, 0.2), noFloor: true,
      storeys: [{ h: lh, wall: wall === 'daub' ? (r() < 0.5 ? 'weatherboard' : 'daub') : wall, frame: 'none', openings: [{ side: 'pz', u: 0, w: 0.8, h: Math.min(1.6, lh - 0.1), y: 0, kind: 'door', frame: 'timber' }] }],
      roof: { type: 'shed', low: o.lean, pitch: 28, mat: roofMat === 'heather' ? 'thatch' : roofMat, ov: 0.3, gov: 0.15, frame: false },
    });
  }

  // Porch
  if (o.porch) {
    const pz0 = rect.z1, pz1 = rect.z1 + porchD - 0.05;
    const pw = 1.5;
    const px = doorU;
    b.state({ layer: Layer.Wall, flags: F.Burn | F.Snow }, () => {
      for (const sx of [-1, 1]) b.box(px + sx * pw / 2 - 0.08, 0, pz1 - 0.16, px + sx * pw / 2 + 0.08, 2.1, pz1, s.timber);
      b.box(px - pw / 2 - 0.1, 2.1, pz0, px + pw / 2 + 0.1, 2.28, pz1, s.timber);
    });
    const lk = roofLook(roofMat === 'heather' ? 'thatch' : roofMat, roofTint(roofMat, s));
    buildRoof(b, { x0: px - pw / 2 - 0.1, x1: px + pw / 2 + 0.1, z0: pz0 - 0.4, z1: pz1, eaveY: 2.28, type: 'gable', axis: 'z', pitch: Math.min(55, pitch + 5), ov: 0.15, gov: 0.1, ridge: 'plain', frame: false }, { ...lk, thickness: Math.min(lk.thickness, 0.25) }, lod);
    b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
      b.flat([[px - pw / 2 - 0.1 - px, 2.28], [px + pw / 2 + 0.1 - px, 2.28], [0, 2.28 + (pw / 2 + 0.1) * Math.tan((Math.min(55, pitch + 5) * Math.PI) / 180)]].map(([u, v]) => [u + px, v] as [number, number]), 0, s.daub);
    });
  }

  // Turf tufts
  if (roofMat === 'turf' && lod === 0) turfTufts(b, top, roof, posHash(ctx.seed, 2, 3));

  // Yard decor along the walls (inside the footprint margin).
  if (o.decor && lod === 0) {
    // Against the front wall at the corners, clear of the door.
    let k = 0;
    const margin = o.D / 2 - rect.z1 - porchD;
    for (const kind of o.decor) {
      if (margin < 0.5 && kind !== 'dung_heap') continue;
      const slot = k++;
      const fx = slot % 2 === 0 ? rect.x1 - 0.85 - (slot >> 1) * 1.4 : rect.x0 + 0.85 + (slot >> 1) * 1.4;
      if (Math.abs(fx - doorU - (rect.x0 + rect.x1) / 2) < 1.2) continue;
      b.push();
      b.layer = Layer.Decor;
      b.translate(fx, 0, rect.z1 + 0.3);
      decorInto(b, kind, ctx.seed + slot);
      b.layer = Layer.Wall;
      b.pop();
    }
  }
  return { ...res, rect };
}

function sideLenOf(rc: Rect, s: Side): number { return s === 'pz' || s === 'nz' ? rc.x1 - rc.x0 : rc.z1 - rc.z0; }

function turfTufts(b: MeshBuilder, top: Rect, roof: { topAt(x: number, z: number): number }, seed: number): void {
  b.state({ layer: Layer.Roof, flags: F.Snow | F.Grass }, () => {
    const n = Math.round((top.x1 - top.x0) * (top.z1 - top.z0) * 0.5);
    for (let i = 0; i < n; i++) {
      const x = top.x0 + posHash(i, 1, seed) * (top.x1 - top.x0);
      const z = top.z0 + 0.1 + posHash(i, 2, seed) * (top.z1 - top.z0 - 0.2);
      const y = roof.topAt(x, z);
      const h = 0.18 + posHash(i, 3, seed) * 0.22;
      const c = shade(COL.turf, 0.85 + posHash(i, 4, seed) * 0.35);
      const p: V3 = [x, y + h, z];
      const a: V3 = [x - 0.12, y - 0.02, z - 0.07], bb: V3 = [x + 0.12, y - 0.02, z - 0.07], cc: V3 = [x, y - 0.02, z + 0.13];
      b.tri(a, bb, p, c);
      b.tri(bb, cc, p, shade(c, 0.9));
      b.tri(cc, a, p, shade(c, 1.08));
    }
  });
}

/** Choose a culture-appropriate decor set for a home. */
export function homeDecor(ctx: Ctx, n: number): PropKind[] {
  const opts: PropKind[] = ['woodpile', 'barrel', 'bench', 'woodpile', 'crate', 'sack_pile'];
  const out: PropKind[] = [];
  for (let i = 0; i < n; i++) out.push(pick(ctx.r, opts));
  return out;
}
