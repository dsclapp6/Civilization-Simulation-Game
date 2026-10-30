// Civic: well, stocks, gallows, school.
import type { BuildingDef } from '../../../content/types';
import { F, Layer, Mat, shade } from '../../core/builder';
import { cupola, type Ctx } from '../parts';
import { buildRoof, roofLook, type RoofMat } from '../roof';
import { COL, roofTint } from '../style';
import { vernacular } from '../vernacular';

export function well(ctx: Ctx, def: BuildingDef): void {
  const { s, b, lod } = ctx;
  void def;
  const stone = s.id === 'cymric' || s.id === 'gael' ? COL.stoneGrey : s.stone;
  const n = lod === 0 ? 10 : 7;
  b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
    b.lathe([[0.82, -0.4], [0.82, 0.78], [0.62, 0.8], [0.62, 0.3]], n, [stone, shade(stone, 1.08), shade(stone, 0.6)], {});
    b.cyl(0, 0, 0.82, 0.86, 0.86, 0.86, n, { side: shade(stone, 1.05), top: shade(stone, 1.1) }, { bottom: false });
  });
  b.state({ layer: Layer.Detail, mat: Mat.Water, flags: F.NoAO }, () => b.cyl(0, 0, 0.25, 0.3, 0.62, 0.62, n, COL.waterDeep, { bottom: false }));
  // Posts, windlass with crank, bucket and a small roof.
  b.state({ layer: Layer.Wall, flags: F.Snow | F.Burn }, () => {
    for (const x of [-0.75, 0.75]) b.box(x - 0.07, 0, -0.07, x + 0.07, 2.0, 0.07, s.timber);
    b.tube([-0.82, 1.25, 0], [0.82, 1.25, 0], 0.11, 0.11, 6, COL.timberRaw);
    b.beam([0.85, 1.25, 0], [0.85, 1.0, 0.25], 0.04, 0.04, COL.iron);
    b.beam([0.85, 1.0, 0.25], [1.05, 1.0, 0.25], 0.04, 0.04, COL.iron);
    b.beam([0, 1.18, 0], [0, 0.75, 0], 0.02, 0.02, COL.rope);
    b.lathe([[0.13, 0.42], [0.16, 0.7]], 6, 0x8a6440, { capTop: false });
  });
  const mat: RoofMat = s.id === 'norse' ? 'turf' : s.id === 'gael' ? 'heather' : s.id === 'anglo' ? 'thatch' : s.richRoof === 'slate' ? 'slate' : 'tile';
  const lk = roofLook(mat, roofTint(mat, s));
  buildRoof(b, { x0: -0.82, x1: 0.82, z0: -0.5, z1: 0.5, eaveY: 2.0, type: 'gable', pitch: 45, ov: 0.25, gov: 0.12, ridge: 'plain', frame: false }, { ...lk, thickness: Math.min(0.22, lk.thickness) }, lod);
  ctx.out.doors.push({ x: 0, z: 1.3 });
}

export function stocks(ctx: Ctx, def: BuildingDef): void {
  const { s, b } = ctx;
  void def;
  b.state({ layer: Layer.Wall, flags: F.Snow | F.Burn }, () => {
    for (const x of [-0.8, 0.8]) b.box(x - 0.08, -0.3, -0.08, x + 0.08, 0.95, 0.08, s.timber);
    b.box(-0.88, 0.3, -0.07, 0.88, 0.5, 0.07, COL.timberRaw);
    b.box(-0.88, 0.5, -0.07, 0.88, 0.68, 0.07, shade(COL.timberRaw, 0.92));
    for (const x of [-0.3, 0.3]) b.box(x - 0.07, 0.46, 0.071, x + 0.07, 0.54, 0.075, 0x1a1511);
    b.box(-0.88, 0.95, -0.09, 0.88, 1.03, 0.09, s.timber);
    // Seat plank behind.
    b.box(-0.7, 0.32, -0.42, 0.7, 0.38, -0.22, COL.timberRaw);
    for (const x of [-0.6, 0.6]) b.box(x - 0.04, -0.2, -0.36, x + 0.04, 0.32, -0.28, s.timber);
  });
  ctx.out.doors.push({ x: 0, z: 0.8 });
}

export function gallows(ctx: Ctx, def: BuildingDef): void {
  const { s, b } = ctx;
  void def;
  b.state({ layer: Layer.Ground, flags: F.Snow | F.Grass }, () => b.lathe([[1.45, -0.3], [1.45, 0.05], [1.2, 0.35], [0, 0.4]], 9, [0x6f8a3c, 0x6a8540, 0x74883e], {}));
  b.state({ layer: Layer.Wall, flags: F.Snow | F.Burn }, () => {
    for (const x of [-1.0, 1.0]) b.box(x - 0.12, 0, -0.12, x + 0.12, 3.6, 0.12, s.timber);
    b.box(-1.25, 3.45, -0.13, 1.25, 3.7, 0.13, s.timber);
    for (const sx of [-1, 1]) b.beam([sx * 1.0, 2.7, 0], [sx * 0.55, 3.45, 0], 0.1, 0.1, s.timber);
    b.beam([0.2, 3.45, 0], [0.2, 2.5, 0], 0.025, 0.025, COL.rope);
    b.cyl(0.2, 0, 2.3, 2.55, 0.11, 0.11, 6, COL.rope, { top: false, bottom: false });
    // Ladder leaning on the beam.
    b.beam([-0.55, 0.3, 0.9], [-0.55, 3.4, 0.15], 0.06, 0.06, COL.timberRaw);
    b.beam([-0.15, 0.3, 0.9], [-0.15, 3.4, 0.15], 0.06, 0.06, COL.timberRaw);
    for (let i = 1; i < 8; i++) { const t = i / 8; b.box(-0.55, 0.3 + 3.1 * t - 0.03, 0.9 - 0.75 * t - 0.03, -0.15, 0.3 + 3.1 * t + 0.03, 0.9 - 0.75 * t + 0.03, COL.timberRaw); }
  });
  ctx.out.doors.push({ x: 0, z: 1.6 });
}

export function school(ctx: Ctx, def: BuildingDef): void {
  const { level: q, s } = ctx;
  const stone = s.id !== 'norse';
  const res = vernacular(ctx, {
    W: def.w, D: def.d, q: q + 1,
    storeys: q >= 2 ? 2 : 1, jetty: q >= 2 && s.homeFrame[2] !== 'none' ? 0.3 : 0,
    wall: stone ? (s.id === 'cymric' ? 'whitewash' : s.id === 'gael' ? 'rubble' : 'stone') : 'planks',
    upperWall: stone && q >= 2 ? (s.id === 'anglo' || s.id === 'teuton' ? 'daub' : undefined) : undefined,
    frame: 'none', upperFrame: s.id === 'teuton' ? 'fachwerk' : s.id === 'anglo' ? 'close' : 'none',
    roofMat: s.richRoof, roofType: 'gable',
    frontWindows: 3, backWindows: 2, chimney: 'gable', doorAt: -0.05,
    decor: ['bench'],
  });
  cupola(ctx, (res.rect.x0 + res.rect.x1) / 2 + 1.4, (res.rect.z0 + res.rect.z1) / 2, res.roof.topY - 0.3, 0.8, 0.8, s.id === 'norse' ? 'shingle' : 'lead', { open: true, bell: true });
}
