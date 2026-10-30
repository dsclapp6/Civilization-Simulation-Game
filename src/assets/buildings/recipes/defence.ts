// Defence: palisade, curtain wall, wall tower, gatehouse, motte and keep, stone keep, great hall,
// barracks, archery butts, training yard, tent. Wall segments (palisade, wall) run along local x
// and tile seamlessly end to end; their local +z face is the outside (field side).
import type { BuildingDef } from '../../../content/types';
import { F, Layer, Mat, MeshBuilder, shade, type V2, type V3 } from '../../core/builder';
import { decorInto } from '../../props/props';
import { crenelLine, crenelRing, cupola, enterSide, fenceRun, flagPole, house, opening, roundTower, windowRow, chimney, type Ctx, type Opening, type Rect, type Side } from '../parts';
import { buildCone, buildRoof, roofLook, type RoofMat } from '../roof';
import { COL, roofTint, type WallKind } from '../style';
import { squareTower } from './church';
import { ovFor, vernacular } from '../vernacular';

function castleStone(ctx: Ctx): number {
  const s = ctx.s;
  return s.id === 'gael' || s.id === 'cymric' ? COL.stoneGrey : s.id === 'norse' ? 0x8b8a85 : s.stone;
}

function castleWall(ctx: Ctx): WallKind {
  return ctx.s.id === 'norse' ? 'rubble' : ctx.s.id === 'gael' || ctx.s.id === 'cymric' ? 'rubble' : 'stone';
}

function decor(ctx: Ctx, kind: Parameters<typeof decorInto>[1], x: number, z: number, rot = 0, s = 1): void {
  if (ctx.lod !== 0) return;
  const b = ctx.b;
  b.push(); b.layer = Layer.Decor; b.translate(x, 0, z); b.rotY(rot); if (s !== 1) b.scale(s, s, s);
  decorInto(b, kind, ctx.seed + Math.round(x * 7 + z * 13));
  b.layer = Layer.Wall; b.pop();
}

/** Arrow slit decal (cross loop) on the current side frame. */
function loop(b: MeshBuilder, u: number, v: number, h = 1.2): void {
  b.quad([u - 0.06, v, 0.02], [u + 0.06, v, 0.02], [u + 0.06, v + h, 0.02], [u - 0.06, v + h, 0.02], 0x1a1612);
  b.quad([u - 0.25, v + h * 0.55, 0.021], [u + 0.25, v + h * 0.55, 0.021], [u + 0.25, v + h * 0.62, 0.021], [u - 0.25, v + h * 0.62, 0.021], 0x1a1612);
}

export function palisade(ctx: Ctx, def: BuildingDef): void {
  const { s, level: q, b, lod } = ctx;
  const L = def.w;
  const n = 13;
  const H = q >= 2 ? 3.6 : 2.7;
  const zf = q >= 2 ? 0.28 : 0.0;
  const sides = lod === 0 ? 6 : 4;
  b.state({ layer: Layer.Wall, flags: F.Snow | F.Burn }, () => {
    for (let i = 0; i < n; i++) {
      const x = -L / 2 + (L * (i + 0.5)) / n;
      const h = H + ((i * 37 + 11) % 7) * 0.06;
      const r = 0.15;
      b.cyl(x, zf, -0.5, h, r, r * 0.95, sides, { side: shade(COL.bark, 0.95 + ((i * 13) % 5) * 0.03) }, { top: false, bottom: false, rot: i });
      b.cyl(x, zf, h, h + 0.42, r * 0.95, 0, sides, 0xa8875e, { top: false, bottom: false, rot: i });
    }
    // Horizontal wale on the inside, tying the stakes.
    b.box(-L / 2, 1.0, zf - 0.28, L / 2, 1.2, zf - 0.12, s.timber);
    if (q >= 2) {
      // Fighting platform behind the stakes.
      b.box(-L / 2, 1.85, -0.5, L / 2, 1.95, zf - 0.13, { top: 0x9a7a52, side: 0x7a5a3a });
      for (const x of [-L / 2 + 0.5, L / 2 - 0.5]) b.box(x - 0.08, -0.3, -0.45, x + 0.08, 1.85, -0.3, s.timber);
      b.box(-L / 2, 2.6, zf - 0.28, L / 2, 2.72, zf - 0.14, s.timber);
    }
  });
}

export function curtainWall(ctx: Ctx, def: BuildingDef): void {
  const { level: q, b, lod } = ctx;
  const L = def.w, D = def.d;
  const H = q >= 2 ? 9.0 : 7.0;
  const col = castleStone(ctx);
  const wall = castleWall(ctx);
  const rc: Rect = { x0: -L / 2, x1: L / 2, z0: -D / 2, z1: D / 2 - 0.22 - (q >= 2 ? 0.42 : 0) };
  // Battered plinth, then the wall body (outer face +z, inner face -z).
  b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
    b.taperBox(rc.x0, -0.8, rc.z0 - 0.0, rc.x1, 1.4, rc.z1 + 0.2, 0, 0.18, { side: shade(col, 0.93), top: col }, 'px nx');
  });
  b.push();
  b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
    for (const side of ['pz', 'nz'] as Side[]) {
      enterSide(b, rc, side, 1.2);
      import_wall(b, L, H - 1.2, wall, col, lod);
      if (lod === 0 && side === 'pz') { loop(b, -1.5, 2.6); loop(b, 1.5, 2.6); if (q >= 2) { loop(b, 0, 5.0); } }
      b.pop();
    }
    // End caps (hidden where segments abut).
    b.quad([rc.x1, 1.2, rc.z1], [rc.x1, 1.2, rc.z0], [rc.x1, H, rc.z0], [rc.x1, H, rc.z1], shade(col, 0.9));
    b.quad([rc.x0, 1.2, rc.z0], [rc.x0, 1.2, rc.z1], [rc.x0, H, rc.z1], [rc.x0, H, rc.z0], shade(col, 0.9));
    // Wall-walk.
    b.box(rc.x0, H - 0.15, rc.z0, rc.x1, H, rc.z1, { top: 0x9a948a, side: col }, 'px nx b');
  });
  b.pop();
  const out = q >= 2 ? 0.42 : 0;
  if (q >= 2) {
    // Machicolations: the parapet steps out on corbels.
    b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
      b.box(rc.x0, H - 0.3, rc.z1 - 0.1, rc.x1, H + 0.05, rc.z1 + out, { side: col, top: col, bottom: shade(col, 0.6) }, 'px nx');
      if (lod === 0) for (let i = 0; i < 8; i++) {
        const x = rc.x0 + 0.375 + i * 0.75;
        b.taperBox(x - 0.17, H - 1.1, rc.z1, x + 0.17, H - 0.3, rc.z1 + out, 0, 0, shade(col, 0.95), 'nz');
      }
    });
  }
  // Crenellated parapet on the outside, low parapet on the inside; tiles every 1.5 m.
  crenelLine(ctx, rc.x0, rc.x1, rc.z1 + out, H, col, { thick: 0.5, period: 1.5, merlon: 0.9, h: 0.95, phase: 0.3 });
  b.state({ layer: Layer.Wall, flags: F.Snow }, () => b.box(rc.x0, H, rc.z0, rc.x1, H + 0.65, rc.z0 + 0.35, { side: col, top: shade(col, 1.06) }, 'px nx'));
  ctx.out.doors.length = 0;
}

function import_wall(b: MeshBuilder, L: number, H: number, wall: WallKind, col: number, lod: 0 | 1 | 2): void {
  // Coursed masonry identical on every segment so runs tile seamlessly.
  const rows = Math.max(2, Math.round(H / 0.75));
  const rh = H / rows;
  const tones = [col, shade(col, 0.95), shade(col, 1.04), shade(col, 0.98)];
  for (let r = 0; r < rows; r++) {
    const va = r * rh, vb = va + rh;
    if (lod > 0 || wall === 'planks') { b.quad([-L / 2, va, 0], [L / 2, va, 0], [L / 2, vb, 0], [-L / 2, vb, 0], tones[r % tones.length]); continue; }
    const off = r % 2 ? 0.75 : 0;
    const joints = [-L / 2, -L / 2 + 1.5 + off, -L / 2 + 3.0 + off, -L / 2 + 4.5 + off, L / 2].filter((u, i, a) => u <= L / 2 && (i === 0 || u > a[i - 1] + 0.1));
    for (let k = 0; k < joints.length - 1; k++) {
      b.quad([joints[k], va, 0], [joints[k + 1], va, 0], [joints[k + 1], vb, 0], [joints[k], vb, 0], tones[(r * 3 + k) % tones.length]);
    }
  }
}

export function wallTower(ctx: Ctx, def: BuildingDef): void {
  const { s, level: q, b, lod } = ctx;
  const col = castleStone(ctx);
  const H = q >= 2 ? 14 : 11;
  const round = s.towerShape === 'round';
  if (s.id === 'norse' && q === 1) {
    // Timber tower with a shingled hood.
    squareTower(ctx, 0, 0, def.w - 1.2, 9.5, { wall: 'planks', crenel: false, spire: 'pyramid', belfry: true });
    ctx.out.doors.push({ x: 0, z: def.d / 2 + 0.2 });
    return;
  }
  let top: number;
  if (round) {
    const R = def.w / 2 - 0.55;
    top = roundTower(ctx, 0, 0, R, H, col, { batter: 0.4, crenel: q < 2 || s.towerRoof === 'none', roof: q >= 2 && s.towerRoof === 'cone' ? s.churchRoof === 'stoneslate' ? 'slate' : s.churchRoof === 'lead' ? 'slate' : s.churchRoof : 'none', roofH: R * 2.6 });
    // Door and loops.
    b.push(); b.translate(0, 0, R + 0.01);
    b.state({ layer: Layer.Detail, flags: F.Snow }, () => { b.flat([[-0.5, 0.0], [0.5, 0.0], [0.5, 1.8], [0, 2.4], [-0.5, 1.8]], 0.03, s.stoneTrim); b.flat([[-0.4, 0.0], [0.4, 0.0], [0.4, 1.75], [0, 2.25], [-0.4, 1.75]], 0.045, s.doors[0]); });
    if (lod === 0) { loop(b, 0, 4.2); loop(b, 0, 7.4); }
    b.pop();
    if (lod === 0) for (const a of [Math.PI / 2 + 0.9, Math.PI / 2 - 0.9]) { b.push(); b.translate(Math.cos(a) * (R + 0.01), 0, Math.sin(a) * (R + 0.01)); b.rotY(Math.PI / 2 - a); loop(b, 0, 5.5); b.pop(); }
    ctx.out.doors.push({ x: 0, z: R + 0.6 });
  } else {
    const S = def.w - 1.5;
    top = squareTower(ctx, 0, 0, S, H, { wall: castleWall(ctx), crenel: q < 2 || s.towerRoof === 'none', spire: q >= 2 && s.towerRoof === 'pyramid' ? 'pyramid' : 'none', belfry: false, pinnacles: false });
    b.push(); b.translate(0, 0, S / 2);
    b.state({ layer: Layer.Detail, flags: F.Snow }, () => { b.flat([[-0.55, 0], [0.55, 0], [0.55, 1.9], [0, 2.5], [-0.55, 1.9]], 0.03, s.stoneTrim); b.flat([[-0.45, 0], [0.45, 0], [0.45, 1.85], [0, 2.35], [-0.45, 1.85]], 0.045, s.doors[0]); });
    if (lod === 0) { loop(b, -1.2, 4.0); loop(b, 1.2, 6.8); }
    b.pop();
    ctx.out.doors.push({ x: 0, z: S / 2 + 0.6 });
  }
  if (q >= 2) flagPole(ctx, 0, top - 0.3, 0, 3.0, ctx.owner);
}

export function gatehouse(ctx: Ctx, def: BuildingDef): void {
  const { s, level: q, b, lod } = ctx;
  const W = def.w, D = def.d;
  const pw = 3.2;
  if (q === 1) {
    // Timber gate tower over a palisade gate.
    const tw = 2.6;
    for (const sd of [-1, 1]) {
      const rc: Rect = { x0: sd < 0 ? -W / 2 + 0.6 : pw / 2, x1: sd < 0 ? -pw / 2 : W / 2 - 0.6, z0: -D / 2 + 1.2, z1: D / 2 - 1.2 };
      house(ctx, { rect: rc, plinthH: 0.2, storeys: [{ h: 6.4, wall: 'planks', frame: 'none', openings: [{ side: 'pz', u: 0, w: 0.4, h: 0.5, y: 4.4, kind: 'slit', frame: 'timber' }] }], roof: null });
      void tw;
    }
    // Bridge room above the passage, jettied hoarding all round, and a shingled/thatched roof.
    const br: Rect = { x0: -W / 2 + 0.6, x1: W / 2 - 0.6, z0: -D / 2 + 1.3, z1: D / 2 - 1.3 };
    b.push(); b.translate(0, 4.4, 0);
    const mat: RoofMat = s.id === 'norse' ? 'shingle' : s.id === 'anglo' ? 'thatch' : s.id === 'gael' ? 'heather' : 'shingle';
    const res = house(ctx, {
      rect: br, plinthH: 0, noFloor: true,
      storeys: [{ h: 2.6, wall: 'planks', frame: 'none', openings: [
        { side: 'pz', u: 0, w: 1.4, h: 0.7, y: 1.0, kind: 'window', frame: 'timber', shutters: true },
        { side: 'nz', u: 0, w: 1.0, h: 0.6, y: 1.0, kind: 'window', frame: 'timber', shutters: false },
      ] }],
      roof: { type: 'hip', pitch: 46, mat, ov: 0.4, gov: 0.4, ridge: 'plain' },
    });
    b.pop();
    void res;
    // Gate leaves standing open inwards.
    b.state({ layer: Layer.Detail, flags: F.Burn | F.Snow }, () => {
      for (const sd of [-1, 1]) {
        b.push(); b.translate(sd * pw / 2, 0, -D / 2 + 1.5); b.rotY(sd * -1.0);
        b.box(sd < 0 ? 0 : -pw / 2, 0, -0.06, sd < 0 ? pw / 2 : 0, 3.6, 0.06, { side: COL.timberRaw, pz: shade(COL.timberRaw, 1.05) });
        b.pop();
      }
    });
    ctx.out.doors.push({ x: 0, z: D / 2 + 0.3 }, { x: 0, z: -D / 2 - 0.3 });
    return;
  }
  // Stone twin-towered gatehouse: two blocks flanking a vaulted passage, D-shaped towers in front.
  const col = castleStone(ctx);
  const wall = castleWall(ctx);
  const H = 11.5;
  const zf = 1.6;
  for (const sd of [-1, 1]) {
    const rc: Rect = { x0: sd < 0 ? -W / 2 + 0.5 : pw / 2, x1: sd < 0 ? -pw / 2 : W / 2 - 0.5, z0: -D / 2 + 0.5, z1: zf };
    house(ctx, { rect: rc, plinthH: 0.6, storeys: [{ h: H - 0.6, wall, frame: 'none', openings: [{ side: 'nz', u: 0, w: 0.6, h: 1.0, y: 5.5, kind: 'window', frame: 'stone', shape: 'pointed' }] }], roof: null });
    const R = 1.85;
    const tx = sd * (W / 2 - 0.5 - R), tz = zf;
    roundTower(ctx, tx, tz, R, H + 1.2, col, { batter: 0.35, crenel: true, roof: s.towerRoof === 'cone' ? 'slate' : 'none', roofH: R * 2.5 });
    if (lod === 0) for (const a of [Math.PI / 2, Math.PI / 2 + sd * 0.8]) { b.push(); b.translate(tx + Math.cos(a) * (R + 0.01), 0, tz + Math.sin(a) * (R + 0.01)); b.rotY(Math.PI / 2 - a); loop(b, 0, 3.0); loop(b, 0, 6.6); b.pop(); }
  }
  // Upper block bridging the passage.
  const ub: Rect = { x0: -pw / 2 - 0.05, x1: pw / 2 + 0.05, z0: -D / 2 + 0.5, z1: zf };
  b.push(); b.translate(0, 4.4, 0);
  house(ctx, { rect: ub, plinthH: 0, noFloor: true, storeys: [{ h: H - 4.4, wall, frame: 'none', openings: [{ side: 'pz', u: 0, w: 0.9, h: 1.5, y: 2.3, kind: 'window', frame: 'stone', shape: 'pointed', mullions: 1, lit: 0.9 }] }], roof: null });
  b.pop();
  // Arch spandrels front and back, and the half-raised portcullis.
  b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
    for (const [z, dir] of [[zf, 1], [-D / 2 + 0.5, -1]] as [number, number][]) {
      const pts: V2[] = [[-pw / 2, 4.45], [-pw / 2, 2.7], [-pw * 0.38, 3.5], [-pw * 0.18, 4.0], [0, 4.2], [pw * 0.18, 4.0], [pw * 0.38, 3.5], [pw / 2, 2.7], [pw / 2, 4.45]];
      b.push(); b.translate(0, 0, z + dir * 0.01); if (dir < 0) b.rotY(Math.PI);
      b.flat(pts, 0, col);
      b.flat([...pts].reverse().map(([u, v]) => [u, v] as V2), -0.02, shade(col, 0.6));
      b.pop();
    }
  });
  if (lod < 2) b.state({ layer: Layer.Detail, flags: F.Snow }, () => {
    const z = zf - 0.35;
    for (let i = 0; i <= 6; i++) { const x = -pw / 2 + 0.2 + ((pw - 0.4) * i) / 6; b.box(x - 0.05, 2.5, z - 0.05, x + 0.05, 4.3, z + 0.05, 0x3a3430); b.cyl(x, z, 2.25, 2.5, 0, 0.05, 4, 0x3a3430, { top: false }); }
    for (let k = 0; k < 4; k++) b.box(-pw / 2 + 0.1, 2.7 + k * 0.45, z - 0.06, pw / 2 - 0.1, 2.78 + k * 0.45, z + 0.06, 0x3a3430);
  });
  // Passage floor (cobbles) and crenellations.
  b.state({ layer: Layer.Ground, flags: F.NoAO }, () => b.box(-pw / 2, -0.05, -D / 2 + 0.4, pw / 2, 0.06, zf + 0.1, { top: 0x8e8a80, side: 0x7a766e }, 'b'));
  crenelLine(ctx, -W / 2 + 0.5, W / 2 - 0.5, zf, H, col, { thick: 0.45, period: 1.5, merlon: 0.9, phase: 0.3 });
  crenelLine(ctx, -W / 2 + 0.5, W / 2 - 0.5, -D / 2 + 0.95, H, col, { thick: 0.45, period: 1.5, merlon: 0.9, phase: 0.3 });
  b.state({ layer: Layer.Wall, flags: F.Snow }, () => b.box(-W / 2 + 0.5, H - 0.25, -D / 2 + 0.5, W / 2 - 0.5, H - 0.05, zf, { top: 0x9a948a, side: col }, 'b'));
  flagPole(ctx, 0, H, (zf - D / 2 + 0.5) / 2, 3.2, ctx.owner);
  ctx.out.doors.length = 0;
  ctx.out.doors.push({ x: 0, z: D / 2 + 0.3 }, { x: 0, z: -D / 2 - 0.3 });
  void opening;
}

export function motte(ctx: Ctx, def: BuildingDef): void {
  const { s, b, lod } = ctx;
  const R = def.w / 2 - 0.4;
  const top = 7.6, rt = 5.2;
  // Earthen mound (grass), with a worn path.
  b.state({ layer: Layer.Ground, flags: F.Snow | F.Grass }, () => {
    const prof: V2[] = [[R, -0.6], [R - 0.2, 0.4], [R - 1.8, 2.4], [R - 3.6, 4.6], [rt + 0.6, 6.9], [rt, top], [rt - 0.1, top + 0.05], [0, top + 0.08]];
    b.lathe(prof, lod === 0 ? 20 : 12, [0x6a8a3a, 0x6f8f3c, 0x748f40, 0x6a8a3a, 0x7a8a46, 0x8a7a50, 0x8a7a50], {});
  });
  // Palisade ring on top with a gate gap facing +z.
  const n = lod === 0 ? 40 : 18;
  b.state({ layer: Layer.Wall, flags: F.Snow | F.Burn }, () => {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      if (Math.abs(Math.atan2(Math.sin(a - Math.PI / 2), Math.cos(a - Math.PI / 2))) < 0.18) continue;
      const x = Math.cos(a) * (rt - 0.25), z = Math.sin(a) * (rt - 0.25);
      const h = 2.3 + (i % 3) * 0.12;
      b.cyl(x, z, top - 0.4, top + h, 0.17, 0.16, lod === 0 ? 5 : 4, COL.bark, { top: false, bottom: false });
      b.cyl(x, z, top + h, top + h + 0.4, 0.16, 0, lod === 0 ? 5 : 4, 0xa8875e, { top: false, bottom: false });
    }
  });
  // Timber keep with an overhanging fighting gallery and a hipped roof.
  b.push(); b.translate(0, top, -0.6);
  const kr: Rect = { x0: -2.2, x1: 2.2, z0: -2.2, z1: 2.2 };
  const mat: RoofMat = s.id === 'norse' ? 'shingle' : s.id === 'anglo' || s.id === 'franc' ? 'shingle' : s.id === 'gael' ? 'heather' : 'shingle';
  const res = house(ctx, {
    rect: kr, plinthH: 0.3, noFloor: true,
    storeys: [
      { h: 4.2, wall: 'planks', frame: 'none', openings: [{ side: 'pz', u: 0, w: 1.0, h: 1.9, y: 0, kind: 'door', frame: 'timber' }, { side: 'px', u: 0, w: 0.3, h: 0.6, y: 2.4, kind: 'slit', frame: 'timber' }] },
      { h: 2.3, wall: 'planks', frame: 'none', jetty: { pz: 0.6, nz: 0.6, px: 0.6, nx: 0.6 }, openings: [
        { side: 'pz', u: 0, w: 0.8, h: 0.6, y: 0.9, kind: 'window', frame: 'timber', shutters: true },
        { side: 'nx', u: 0, w: 0.3, h: 0.6, y: 0.8, kind: 'slit', frame: 'timber' }, { side: 'px', u: 0, w: 0.3, h: 0.6, y: 0.8, kind: 'slit', frame: 'timber' },
      ] },
    ],
    roof: { type: 'pyramid', pitch: 50, mat, ov: 0.45, gov: 0.45, ridge: 'plain' },
  });
  b.pop();
  flagPole(ctx, 0, top + res.roof.topY - 0.4, -0.6, 2.8, ctx.owner);
  ctx.out.smoke.push([1.2, top + res.roof.topY - 1.2, -0.6]);
  // Flying bridge / stair from the foot of the mound to the gate.
  b.state({ layer: Layer.Wall, flags: F.Snow | F.Burn }, () => {
    const z0 = R + 0.2, z1 = rt - 0.2;
    const pts: V3[] = [[0, 0.25, z0 - 0.6], [0, top + 0.1, z1]];
    b.beam(pts[0], pts[1], 1.4, 0.12, { top: 0x9a7a52, side: 0x7a5a3a });
    const steps = lod === 0 ? 14 : 6;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const y = 0.25 + (top - 0.15) * t, z = z0 - 0.6 + (z1 - z0 + 0.6) * t;
      if (lod === 0) b.box(-0.7, y, z - 0.05, 0.7, y + 0.06, z + 0.12, 0x8a6a46);
      if (i % 3 === 0) for (const x of [-0.75, 0.75]) b.box(x - 0.07, y - 0.4 - y * 0.0, z - 0.07, x + 0.07, y + 1.0, z + 0.07, s.timber);
      if (i % 4 === 0) b.box(-0.08, -0.3, z - 0.08, 0.08, y, z + 0.08, s.timber);
    }
    for (const x of [-0.75, 0.75]) b.beam([x, 1.25, z0 - 0.6], [x, top + 1.0, z1], 0.06, 0.06, s.timber);
  });
  ctx.out.doors.push({ x: 0, z: R + 0.1 });
}

export function keepStone(ctx: Ctx, def: BuildingDef): void {
  const { s, level: q, b, lod } = ctx;
  const col = castleStone(ctx);
  const wall = castleWall(ctx);
  const S = 12.4;
  const H = q === 1 ? 17 : q === 2 ? 20 : 23;
  const rc: Rect = { x0: -S / 2, x1: S / 2, z0: -def.d / 2 + 1.0, z1: -def.d / 2 + 1.0 + S };
  const cz = (rc.z0 + rc.z1) / 2;
  // Battered base.
  b.state({ layer: Layer.Ground, flags: F.Snow }, () => b.taperBox(rc.x0 - 0.7, -0.8, rc.z0 - 0.7, rc.x1 + 0.7, 1.8, rc.z1 + 0.7, 0.62, 0.62, { side: shade(col, 0.92), top: col }));
  const ops: Opening[] = [];
  for (const side of ['pz', 'nz', 'px', 'nx'] as Side[]) {
    ops.push(...windowRow(side, S, 2, { w: 0.5, h: 1.1, y: 4.5, kind: 'slit', frame: 'stone', shape: 'round', shutters: false, lit: 0.4 }));
    ops.push(...windowRow(side, S, 3, { w: 0.9, h: 1.6, y: H * 0.55, frame: 'stone', shape: 'round', shutters: false, mullions: 1, lit: 0.8 }));
    if (q >= 2) ops.push(...windowRow(side, S, 2, { w: 1.0, h: 1.7, y: H * 0.78, frame: 'stone', shape: 'round', shutters: false, mullions: 1, lit: 0.9 }));
  }
  house(ctx, { rect: rc, plinthH: 1.6, storeys: [{ h: H - 1.6, wall, frame: 'none', quoins: false, openings: ops }], roof: null });
  // Pilaster buttresses at corners and mid-faces.
  b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
    for (const side of ['pz', 'nz', 'px', 'nx'] as Side[]) {
      enterSide(b, rc, side, 0);
      for (const u of [-S / 2 + 0.6, 0, S / 2 - 0.6]) b.box(u - 0.6, 1.7, 0, u + 0.6, H - 0.1, 0.32, { side: shade(col, 1.02), top: shade(col, 1.08) }, 'nz');
      b.pop();
    }
  });
  // Parapet and corner turrets.
  b.state({ layer: Layer.Wall, flags: F.Snow }, () => b.box(rc.x0, H - 0.3, rc.z0, rc.x1, H, rc.z1, { top: 0x7a746c, side: col }, 'b'));
  const per = 1.55;
  crenelLine(ctx, rc.x0 - 0.1, rc.x1 + 0.1, rc.z1 + 0.15, H, col, { thick: 0.5, period: per, merlon: 0.95, phase: 0.3 });
  crenelLine(ctx, rc.x0 - 0.1, rc.x1 + 0.1, rc.z0 + 0.35, H, col, { thick: 0.5, period: per, merlon: 0.95, phase: 0.3 });
  b.push(); b.translate(0, 0, cz); b.rotY(Math.PI / 2); b.translate(0, 0, -cz);
  crenelLine(ctx, -S / 2 + 0.4, S / 2 - 0.4, cz + S / 2 + 0.15, H, col, { thick: 0.5, period: per, merlon: 0.95, phase: 0.3 });
  crenelLine(ctx, -S / 2 + 0.4, S / 2 - 0.4, cz - S / 2 + 0.35, H, col, { thick: 0.5, period: per, merlon: 0.95, phase: 0.3 });
  b.pop();
  const turretRoof: RoofMat | 'none' = q >= 3 && s.towerRoof === 'cone' ? 'slate' : 'none';
  for (const [x, z] of [[rc.x0 + 1.1, rc.z0 + 1.1], [rc.x1 - 1.1, rc.z0 + 1.1], [rc.x1 - 1.1, rc.z1 - 1.1], [rc.x0 + 1.1, rc.z1 - 1.1]] as [number, number][]) {
    const th = H + (q >= 2 ? 3.6 : 2.4);
    if (s.towerShape === 'round' || q >= 3) {
      const top = roundTower(ctx, x, z, 1.25, th, col, { batter: 0, crenel: turretRoof === 'none', roof: turretRoof, roofH: 3.2, sides: lod === 0 ? 10 : 6 });
      if (q >= 2 && lod < 2 && (x > 0) === (z > cz)) flagPole(ctx, x, top - 0.2, z, 2.6, ctx.owner, 'pennant');
    } else {
      // Square corner turret: plain shaft rising above the parapet with its own merlons.
      b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
        b.box(x - 1.25, H - 2.0, z - 1.25, x + 1.25, th, z + 1.25, { side: shade(col, 1.02), top: 0x7a746c }, 'b');
        b.box(x - 1.32, th - 0.25, z - 1.32, x + 1.32, th - 0.05, z + 1.32, shade(col, 1.08), 'b');
      });
      crenelLine(ctx, x - 1.32, x + 1.32, z + 1.32, th, col, { thick: 0.3, period: 0.88, merlon: 0.5, phase: 0.05, h: 0.7 });
      crenelLine(ctx, x - 1.32, x + 1.32, z - 1.02, th, col, { thick: 0.3, period: 0.88, merlon: 0.5, phase: 0.05, h: 0.7 });
      void squareTower;
    }
  }
  if (q >= 2) flagPole(ctx, 0, H, cz, 4.2, ctx.owner);
  // Forebuilding with an external stair to the first-floor entrance on +z.
  const fb: Rect = { x0: -3.4, x1: 1.6, z0: rc.z1, z1: def.d / 2 - 0.4 };
  house(ctx, { rect: fb, plinthH: 0.6, storeys: [{ h: 7.4, wall, frame: 'none', openings: [{ side: 'pz', u: 0.6, w: 1.3, h: 2.4, y: 4.4, kind: 'door', frame: 'stone', shape: 'round' }, { side: 'pz', u: -1.4, w: 0.4, h: 1.0, y: 2.0, kind: 'slit', frame: 'stone' }] }], roof: null });
  crenelLine(ctx, fb.x0, fb.x1, fb.z1, 7.9, col, { thick: 0.45, period: 1.2, merlon: 0.7, phase: 0.25 });
  b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
    b.box(fb.x0, 7.75, fb.z0, fb.x1, 8.0, fb.z1, { top: 0x7a746c, side: col }, 'b');
    // Stair along the forebuilding face.
    const steps = lod === 0 ? 12 : 5;
    for (let i = 0; i < steps; i++) {
      const t = (i + 1) / steps;
      b.box(fb.x1 + 0.1 + (1 - t) * 2.6, -0.3, fb.z1 - 1.5, fb.x1 + 0.1 + (1 - t) * 2.6 + 2.6 / steps + 0.05, 0.6 + t * 4.4, fb.z1 - 0.1, { side: shade(col, 0.95), top: col });
    }
  });
  ctx.out.doors.length = 0;
  ctx.out.doors.push({ x: fb.x1 + 2.8, z: fb.z1 - 0.8 });
  ctx.out.smoke.push([rc.x0 + 3, H + 0.6, cz]);
  void chimney; void buildCone; void roofLook; void roofTint;
}

export function greatHall(ctx: Ctx, def: BuildingDef): void {
  const { s, level: q, b, lod } = ctx;
  const col = castleStone(ctx);
  const wall: WallKind = s.id === 'norse' ? 'planks' : castleWall(ctx);
  const mat: RoofMat = s.id === 'norse' ? 'shingle' : s.richRoof;
  const { ov } = ovFor(mat);
  const W = def.w, D = def.d;
  const rect: Rect = { x0: -W / 2 + 0.7, x1: W / 2 - (q >= 2 ? 2.2 : 0.7), z0: -D / 2 + 0.85, z1: D / 2 - 1.9 };
  const L = rect.x1 - rect.x0;
  const H = q >= 2 ? 7.4 : 6.6;
  const fk = wall === 'planks' ? 'timber' : 'stone';
  const res = house(ctx, {
    rect, plinthH: 0.4,
    storeys: [{ h: H, wall, frame: 'none', quoins: wall === 'stone', openings: [
      { side: 'pz', u: -L / 2 + 1.6, w: 1.4, h: 2.6, y: 0, kind: 'door', frame: fk, shape: 'pointed' },
      ...windowRow('pz', L, 4, { w: 1.2, h: 3.0, y: 2.6, kind: 'big', frame: fk, shape: 'pointed', mullions: 1, shutters: false, lit: 1 }, [-L / 2 + 1.6]),
      ...windowRow('nz', L, 4, { w: 1.2, h: 3.0, y: 2.6, kind: 'big', frame: fk, shape: 'pointed', mullions: 1, shutters: false, lit: 0.9 }),
      { side: 'px', u: 0, w: 2.0, h: 3.4, y: 2.2, kind: 'big', frame: fk, shape: 'pointed', mullions: 2, lit: 1 },
    ] }],
    roof: { type: 'gable', pitch: Math.max(52, s.pitch), mat, ov, gov: 0.12, ridge: 'plain' },
    parapet: wall !== 'planks' ? (s.crowSteps ? 'crow' : q >= 2 ? 'crow' : 'coping') : undefined,
  });
  if (wall !== 'planks') {
    const bt = (x: number) => Math.abs(x - (rect.x0 + 1.6)) < 1.3;
    for (const [z, d] of [[rect.z1, 1], [rect.z0, -1]] as [number, 1 | -1][]) {
      b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
        for (let i = 0; i <= 5; i++) {
          const x = rect.x0 + 0.3 + ((L - 0.6) * i) / 5;
          if (d > 0 && bt(x)) continue;
          b.taperBox(x - 0.3, -0.3, d > 0 ? z : z - 0.6, x + 0.3, H * 0.8, d > 0 ? z + 0.6 : z, 0.02, 0.2, col);
        }
      });
    }
  }
  // Porch over the screens-passage door.
  const pr: Rect = { x0: rect.x0 + 0.4, x1: rect.x0 + 2.8, z0: rect.z1, z1: D / 2 - 0.35 };
  house(ctx, { rect: pr, plinthH: 0.4, noFloor: true, storeys: [{ h: 3.2, wall, frame: 'none', openings: [{ side: 'pz', u: 0, w: 1.4, h: 2.5, y: 0, kind: 'door', frame: fk, shape: 'pointed', open: true }] }], roof: { type: 'gable', axis: 'z', pitch: 52, mat, ov: 0.15, gov: 0.1, ridge: 'plain' }, parapet: wall !== 'planks' ? 'coping' : undefined });
  // Louvre over the central hearth, lateral chimney at level 2, oriel at the dais end.
  cupola(ctx, rect.x0 + L * 0.45, (rect.z0 + rect.z1) / 2, res.roof.topY - 0.4, 1.3, 1.1, mat === 'thatch' ? 'thatch' : s.id === 'norse' ? 'shingle' : 'lead', { open: false });
  ctx.out.smoke.push([rect.x0 + L * 0.45, res.roof.topY + 1.6, (rect.z0 + rect.z1) / 2]);
  if (q >= 2) {
    chimney(ctx, { x: rect.x0 + L * 0.7, z: rect.z0 - 0.3, baseY: -0.3, topY: res.roof.topY + 0.8, w: 1.2, d: 0.7, color: col, pots: 2, shoulderY: H });
    // Oriel bay on the dais (east) end.
    const oy = 2.2;
    b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
      b.taperBox(rect.x1, oy - 1.2, -1.4, rect.x1 + 1.3, oy, 1.4, 0.0, 0.0, col);
      b.box(rect.x1, oy, -1.4, rect.x1 + 1.3, oy + 3.6, 1.4, { side: col, top: shade(col, 1.06) });
    });
    enterSide(b, { x0: rect.x1, x1: rect.x1 + 1.3, z0: -1.4, z1: 1.4 }, 'px', oy);
    opening(ctx, { side: 'px', u: 0, w: 1.8, h: 2.6, y: 0.5, kind: 'big', frame: 'stone', shape: 'pointed', mullions: 2, lit: 1 });
    b.pop();
    crenelLine(ctx, rect.x1 + 0.0, rect.x1 + 1.3, 1.45, oy + 3.6, col, { thick: 0.35, period: 0.65, merlon: 0.4 });
  }
  flagPole(ctx, rect.x1 - 0.3, res.roof.ridgeY + 0.5, (rect.z0 + rect.z1) / 2, 3.0, ctx.owner);
}

export function barracks(ctx: Ctx, def: BuildingDef): void {
  const { s, level: q, b } = ctx;
  if (q === 1) {
    const res = vernacular(ctx, { W: def.w, D: def.d, q: 1, frontWindows: 3, backWindows: 2, chimney: 'ridge', doorAt: -0.3, extra: [], decor: ['woodpile', 'barrel'] });
    weaponRack(ctx, res.rect.x1 - 1.2, res.rect.z1 + 0.35);
    return;
  }
  const col = castleStone(ctx);
  const wall = castleWall(ctx);
  const mat: RoofMat = s.id === 'norse' ? 'shingle' : s.richRoof;
  const { ov, gov } = ovFor(mat);
  const rect: Rect = { x0: -def.w / 2 + gov + 0.2, x1: def.w / 2 - gov - 0.2, z0: -def.d / 2 + ov + 0.2, z1: def.d / 2 - 0.75 };
  const L = rect.x1 - rect.x0;
  const upperWall: WallKind = q >= 3 ? wall : s.id === 'norse' ? 'planks' : s.id === 'teuton' ? 'daub' : 'weatherboard';
  const res = house(ctx, {
    rect, plinthH: 0.35,
    storeys: [
      { h: 3.0, wall, frame: 'none', quoins: wall === 'stone', openings: [
        { side: 'pz', u: -L / 4, w: 1.1, h: 2.2, y: 0, kind: 'door', frame: 'stone', shape: 'round' },
        { side: 'pz', u: L / 4, w: 1.1, h: 2.2, y: 0, kind: 'door', frame: 'stone', shape: 'round' },
        ...windowRow('pz', L, 6, { w: 0.4, h: 1.0, y: 1.2, kind: 'slit', frame: 'stone', shutters: false, lit: 0.6 }, [-L / 4, L / 4]),
        ...windowRow('nz', L, 5, { w: 0.4, h: 1.0, y: 1.2, kind: 'slit', frame: 'stone', shutters: false }),
      ] },
      { h: 2.6, wall: upperWall, frame: upperWall === 'daub' ? 'fachwerk' : 'none', openings: [
        ...windowRow('pz', L, 5, { w: 0.7, h: 0.8, y: 0.8, frame: upperWall === 'stone' ? 'stone' : 'timber', shutters: upperWall !== 'stone', lit: 0.8 }),
        ...windowRow('nz', L, 4, { w: 0.6, h: 0.7, y: 0.8, frame: upperWall === 'stone' ? 'stone' : 'timber', shutters: false }),
      ] },
    ],
    roof: q >= 3 ? { type: 'hip', pitch: 30, mat, ov: 0.05, gov: 0.05, ridge: 'plain' } : { type: 'gable', pitch: s.pitch, mat, ov, gov, ridge: 'plain' },
  });
  if (q >= 3) {
    const y = res.eaveY;
    crenelLine(ctx, rect.x0 - 0.1, rect.x1 + 0.1, rect.z1 + 0.1, y, col, { thick: 0.4, period: 1.4, merlon: 0.8 });
    crenelLine(ctx, rect.x0 - 0.1, rect.x1 + 0.1, rect.z0 + 0.3, y, col, { thick: 0.4, period: 1.4, merlon: 0.8 });
    flagPole(ctx, rect.x1 - 0.6, y + 0.5, (rect.z0 + rect.z1) / 2, 3.0, ctx.owner);
  }
  chimney(ctx, { x: rect.x0 + 1.2, z: (rect.z0 + rect.z1) / 2, baseY: res.eaveY - 1, topY: res.roof.topY + 0.8, w: 0.8, d: 0.8, color: col, pots: 1 });
  weaponRack(ctx, rect.x1 - 1.4, rect.z1 + 0.35);
  void b;
}

function weaponRack(ctx: Ctx, x: number, z: number): void {
  const { b, lod } = ctx;
  if (lod > 0) return;
  b.state({ layer: Layer.Decor, flags: F.Snow | F.Burn }, () => {
    for (const dx of [-0.6, 0.6]) b.box(x + dx - 0.05, 0, z - 0.05, x + dx + 0.05, 1.5, z + 0.05, COL.timber);
    b.box(x - 0.7, 1.35, z - 0.06, x + 0.7, 1.45, z + 0.06, COL.timber);
    b.box(x - 0.7, 0.25, z - 0.12, x + 0.7, 0.32, z + 0.12, COL.timber);
    for (let i = 0; i < 5; i++) {
      const px = x - 0.5 + i * 0.25;
      b.beam([px, 0.3, z], [px + 0.05, 2.3, z - 0.1], 0.03, 0.03, COL.timberRaw);
      b.cyl(px + 0.05, z - 0.1, 2.3, 2.55, 0.05, 0, 4, 0x8a8a90, { top: false, bottom: false });
    }
  });
}

export function archeryButts(ctx: Ctx, def: BuildingDef): void {
  const { b, lod } = ctx;
  const hw = def.w / 2 - 0.4, hd = def.d / 2 - 0.4;
  for (const x of [-hw / 2, hw / 2]) {
    b.state({ layer: Layer.Wall, flags: F.Snow | F.Grass }, () => b.taperBox(x - 1.9, -0.4, -hd, x + 1.9, 1.9, -hd + 2.2, 0.45, 0.65, { side: 0x6a8a3a, top: 0x7a9a46, pz: 0x7a6a48 }));
    decor(ctx, 'archery_target', x, -hd + 2.6);
  }
  // Shooting line: pegs and a bench; a few spent arrows in the turf.
  b.state({ layer: Layer.Decor, flags: F.Snow }, () => {
    for (let i = 0; i < 6; i++) b.box(-hw + 1 + i * ((2 * hw - 2) / 5) - 0.04, -0.2, hd - 1.2, -hw + 1 + i * ((2 * hw - 2) / 5) + 0.04, 0.45, hd - 1.12, COL.timberRaw);
    if (lod === 0) for (let i = 0; i < 6; i++) b.beam([-hw / 2 + (i - 3) * 0.3, 0, -hd + 2.0 - (i % 2) * 0.3], [-hw / 2 + (i - 3) * 0.3 + 0.1, 0.55, -hd + 2.4 - (i % 2) * 0.3], 0.02, 0.02, 0x9a7a52);
  });
  decor(ctx, 'bench', 0, hd - 0.45);
  ctx.out.doors.push({ x: 0, z: hd + 0.5 });
}

export function trainingYard(ctx: Ctx, def: BuildingDef): void {
  const { s, level: q, b, lod } = ctx;
  const hw = def.w / 2 - 0.35, hd = def.d / 2 - 0.35;
  b.state({ layer: Layer.Ground, flags: F.NoAO }, () => b.box(-hw + 0.2, -0.05, -hd + 0.2, hw - 0.2, 0.03, hd - 0.2, { top: 0xb8a272, side: 0xa89262 }, 'b'));
  fenceRun(ctx, -hw, hd, hw, hd, 'rail', 3.0);
  fenceRun(ctx, hw, hd, hw, -hd, 'rail');
  fenceRun(ctx, hw, -hd, -hw, -hd, 'rail');
  fenceRun(ctx, -hw, -hd, -hw, hd, 'rail');
  decor(ctx, 'pell', -hw + 1.6, -hd + 1.8);
  decor(ctx, 'pell', -hw + 3.4, -hd + 1.8);
  decor(ctx, 'pell', -hw + 5.2, -hd + 1.8);
  decor(ctx, 'archery_target', hw - 2.0, -hd + 1.6);
  decor(ctx, 'scarecrow', hw - 4.0, 1.0);
  weaponRack(ctx, -hw + 1.5, hd - 1.0);
  // Quintain: a post with a pivoting arm carrying a shield and a sandbag.
  const qx = 1.0, qz = -0.5;
  b.state({ layer: Layer.Wall, flags: F.Snow | F.Burn }, () => b.box(qx - 0.1, -0.3, qz - 0.1, qx + 0.1, 2.0, qz + 0.1, s.timber));
  const arm = new MeshBuilder(17);
  arm.layer = Layer.Detail; arm.flags = F.Burn;
  arm.box(-1.4, -0.06, -0.06, 1.4, 0.06, 0.06, COL.timberRaw);
  arm.box(-1.4, -0.75, -0.05, -1.0, 0.0, 0.05, { side: ctx.owner, px: ctx.owner, nx: ctx.owner });
  arm.beam([1.3, 0, 0], [1.3, -0.6, 0], 0.02, 0.02, COL.rope);
  arm.blob(1.3, -0.75, 0, 0.18, 0.22, 0.18, 0xc2a676, 0.15);
  ctx.out.anims.push({ pivot: [qx, 2.05, qz], builder: arm, kind: 'swing', speed: 0.06, mat: 'opaque' });
  if (q >= 2) {
    // Covered viewing stand at the back.
    const st: Rect = { x0: 1.5, x1: hw - 0.6, z0: -hd + 0.4, z1: -hd + 2.6 };
    b.state({ layer: Layer.Wall, flags: F.Snow | F.Burn }, () => {
      b.box(st.x0, -0.3, st.z0, st.x1, 0.9, st.z1, { top: 0x9a7a52, side: 0x7a5a3a });
      for (const [x, z] of [[st.x0 + 0.1, st.z0 + 0.1], [st.x1 - 0.1, st.z0 + 0.1], [st.x0 + 0.1, st.z1 - 0.1], [st.x1 - 0.1, st.z1 - 0.1]] as [number, number][]) b.box(x - 0.08, 0.9, z - 0.08, x + 0.08, 3.0, z + 0.08, s.timber);
      b.box(st.x0, 1.6, st.z0 + 0.6, st.x1, 1.7, st.z0 + 1.1, 0x8a6a46);
    });
    const mat: RoofMat = s.id === 'norse' ? 'turf' : 'shingle';
    buildRoof(b, { x0: st.x0, x1: st.x1, z0: st.z0, z1: st.z1, eaveY: 3.0, type: 'shed', low: 'pz', pitch: 18, ov: 0.2, gov: 0.15, frame: false }, { ...roofLook(mat, roofTint(mat, s)), thickness: 0.14 }, lod);
    b.state({ layer: Layer.Detail, mat: Mat.Cloth, flags: F.NoAO }, () => {
      const old = b.swayFn; b.swayFn = (_x, y) => Math.max(0, 3.0 - y) * 0.4;
      for (let i = 0; i < 6; i++) { const x0 = st.x0 + 0.1 + i * ((st.x1 - st.x0 - 0.2) / 6), x1 = x0 + (st.x1 - st.x0 - 0.2) / 6; b.quad([x0, 2.4, st.z1 + 0.02], [x1, 2.4, st.z1 + 0.02], [x1, 2.98, st.z1 + 0.02], [x0, 2.98, st.z1 + 0.02], i % 2 ? ctx.owner : COL.gold); }
      b.swayFn = old;
    });
  }
  ctx.out.doors.push({ x: 0, z: hd + 0.5 });
}

export function tent(ctx: Ctx, def: BuildingDef): void {
  const { b, lod, owner } = ctx;
  void def;
  const R = 1.35, wallH = 1.5, coneH = 1.65;
  const n = lod === 0 ? 12 : 8;
  const white = 0xeee6d2;
  b.state({ layer: Layer.Wall, mat: Mat.Cloth, flags: F.Snow }, () => {
    const old = b.swayFn;
    b.swayFn = (_x, y) => Math.min(1, Math.max(0, (wallH - y) / wallH)) * 0.25;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      const p0: V3 = [Math.cos(a0) * R, 0, Math.sin(a0) * R], p1: V3 = [Math.cos(a1) * R, 0, Math.sin(a1) * R];
      const c = i % 2 ? owner : white;
      const am = (a0 + a1) / 2;
      if (Math.abs(Math.atan2(Math.sin(am - Math.PI / 2), Math.cos(am - Math.PI / 2))) < 0.3) {
        // Door flap tied back: dark opening.
        b.state({ mat: Mat.Opaque, flags: F.NoAO }, () => b.quad([p1[0] * 0.98, 0.0, p1[2] * 0.98], [p0[0] * 0.98, 0.0, p0[2] * 0.98], [p0[0] * 0.98, wallH, p0[2] * 0.98], [p1[0] * 0.98, wallH, p1[2] * 0.98], 0x2a2420));
        continue;
      }
      b.quad([p1[0], -0.05, p1[2]], [p0[0], -0.05, p0[2]], [p0[0], wallH, p0[2]], [p1[0], wallH, p1[2]], c);
    }
    b.swayFn = (_x, y) => Math.max(0, (wallH + coneH - y) / coneH) * 0.15;
    const apex: V3 = [0, wallH + coneH, 0];
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      const Ro = R + 0.18;
      b.tri([Math.cos(a1) * Ro, wallH - 0.05, Math.sin(a1) * Ro], [Math.cos(a0) * Ro, wallH - 0.05, Math.sin(a0) * Ro], apex, i % 2 ? white : owner);
      // Scalloped valance.
      const am = (a0 + a1) / 2;
      b.tri([Math.cos(a1) * Ro, wallH - 0.05, Math.sin(a1) * Ro], [Math.cos(am) * Ro, wallH - 0.38, Math.sin(am) * Ro], [Math.cos(a0) * Ro, wallH - 0.05, Math.sin(a0) * Ro], i % 2 ? owner : white);
    }
    b.swayFn = old;
  });
  b.state({ layer: Layer.Wall, flags: F.Burn }, () => {
    b.cyl(0, 0, 0, wallH + coneH + 0.9, 0.05, 0.04, 4, COL.timberDark);
    b.blob(0, wallH + coneH + 0.92, 0, 0.08, 0.08, 0.08, COL.gold, 0.1);
  });
  ctx.out.flags.push({ pos: [0, wallH + coneH + 0.8, 0], w: 1.3, h: 0.4, color: owner, kind: 'pennant' });
  ctx.out.doors.push({ x: 0, z: R + 0.4 });
}
