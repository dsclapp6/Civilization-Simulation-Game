// Deposits in the world (docs/CIV.md §7): the pieces the renderer scatters over a deposit's extent, each written at
// the builder's current transform (origin on the ground). Iron: rust-stained outcrops; stone: pale outcrops with a
// worked face and squared blocks; clay: ochre wet banks; salt: white crust plates; silver: blue-grey rock with pale
// veins; gold: stream gravel (the glints are the renderer's sparkles). Plus the colour of each kind's ground stain.
import { F, Layer, Mat, MeshBuilder, posHash, shade, type V3 } from './core/builder';

export type DepositKindId = 'iron' | 'stone' | 'clay' | 'salt' | 'silver' | 'gold';

/** Ground stain under a deposit (sRGB) and its strength at the centre. */
export const DEPOSIT_STAIN: Record<DepositKindId, { color: number; alpha: number }> = {
  iron: { color: 0x94482a, alpha: 0.78 },
  stone: { color: 0xc9bfa6, alpha: 0.7 },
  clay: { color: 0xb07a40, alpha: 0.82 },
  salt: { color: 0xeeeae0, alpha: 0.92 },
  silver: { color: 0x7a8292, alpha: 0.6 },
  gold: { color: 0xa39478, alpha: 0.72 },
};

const RUST = [0x9c4e2c, 0xb0603a, 0x8a452a, 0xa86a40];
const IRON_ROCK = [0x6f655a, 0x7a6f62, 0x655c53];
const LIME = [0xc9c0aa, 0xbdb39c, 0xd2c9b3];
const LIME_CUT = 0xe2dac6;
const SILVER_ROCK = [0x6c7380, 0x77808e, 0x646a76];
const VEIN = [0xcfd8e4, 0xe6ecf2];
const CLAY = [0xb7834c, 0xc08c52, 0xa87644];
const CLAY_WET = 0x7e5c3e;
const SALT = [0xf0ece2, 0xe8e3d6, 0xf6f3ea];
const PEBBLES = [0x8a7f70, 0x9c8f7c, 0x6f675c, 0xa89a84, 0x7c7468];

/** One outcrop (iron, stone, silver) of size `s` (≈ metres across), or one bank / plate / gravel patch. */
export function depositPieceInto(b: MeshBuilder, kind: DepositKindId, s: number, seed: number, lod: 0 | 1): void {
  const h = (k: number) => posHash(seed, k, 3, 17);
  b.state({ layer: Layer.Wall, mat: Mat.Opaque, flags: F.Snow, jitter: 0.05 }, () => {
    switch (kind) {
      case 'iron': {
        const rx = s * (0.5 + h(1) * 0.3), ry = s * (0.32 + h(2) * 0.3), rz = s * (0.45 + h(3) * 0.3);
        b.blob(0, ry * 0.35, 0, rx, ry, rz, (nx, ny, nz) => {
          const k = posHash(Math.round(nx * 5), Math.round(ny * 5), Math.round(nz * 5), seed);
          if (ny > 0.62) return k < 0.5 ? 0x6f7048 : IRON_ROCK[0];
          return k < 0.45 ? RUST[Math.floor(k * 9) % RUST.length] : IRON_ROCK[Math.floor(k * 7) % IRON_ROCK.length];
        }, 0.3, lod === 0 && s > 1.2 ? 1 : 0, seed);
        if (lod === 0) for (let i = 0; i < 3; i++) {
          const a = h(10 + i) * Math.PI * 2, r = rx * (1.05 + h(20 + i) * 0.5);
          b.blob(Math.cos(a) * r, 0.04, Math.sin(a) * r, s * 0.12, s * 0.07, s * 0.1, RUST[i % RUST.length], 0.3, 0, seed + i);
        }
        return;
      }
      case 'silver': {
        const rx = s * (0.5 + h(1) * 0.25), ry = s * (0.4 + h(2) * 0.3), rz = s * (0.45 + h(3) * 0.25);
        const tilt = h(4) * 3;
        b.blob(0, ry * 0.4, 0, rx, ry, rz, (nx, ny, nz) => {
          // pale veins: bands across the rock
          const band = Math.abs(Math.sin((nx * 2.3 + ny * 3.1 + nz * 1.7 + tilt) * 2.4));
          if (band < 0.2) return VEIN[band < 0.1 ? 1 : 0];
          return SILVER_ROCK[Math.floor(posHash(Math.round(nx * 4), Math.round(ny * 4), Math.round(nz * 4), seed) * 3) % 3];
        }, 0.26, lod === 0 && s > 1 ? 1 : 0, seed);
        return;
      }
      case 'stone': {
        // a weathered pale outcrop with a cut face: the natural rock, then a squared step cut into it
        const rx = s * (0.55 + h(1) * 0.25), ry = s * (0.35 + h(2) * 0.25), rz = s * (0.5 + h(3) * 0.25);
        b.blob(0, ry * 0.3, 0, rx, ry, rz, (nx, ny) => (ny > 0.7 ? 0x8a9a5a : LIME[Math.floor(posHash(nx * 9, ny * 9, 0, seed) * 3) % 3]), 0.24, lod === 0 && s > 1.2 ? 1 : 0, seed);
        const cw = rx * 0.9, cd = rz * 0.55;
        b.push(); b.rotY(h(5) * Math.PI * 2);
        b.box(-cw / 2, -0.3, rz * 0.15, cw / 2, ry * 0.95, rz * 0.15 + cd, { side: shade(LIME_CUT, 0.94), pz: LIME_CUT, top: shade(LIME_CUT, 1.03) });
        if (lod === 0) {
          // a couple of squared blocks lying in front of the face
          for (let i = 0; i < 2; i++) {
            const bx = (h(30 + i) - 0.5) * cw, bz = rz * 0.2 + cd + 0.5 + h(32 + i) * 0.6;
            b.push(); b.translate(bx, 0, bz); b.rotY(h(34 + i) * 0.8);
            b.box(-0.35, 0, -0.25, 0.35, 0.45, 0.25, { side: shade(LIME_CUT, 0.92), top: LIME_CUT });
            b.pop();
          }
        }
        b.pop();
        return;
      }
      case 'clay': {
        // a low ochre bank, darker where it is wet, its face cut back
        const rx = s * (0.6 + h(1) * 0.3), rz = s * (0.35 + h(3) * 0.2), ry = s * 0.18;
        b.blob(0, 0, 0, rx, ry, rz, (_nx, ny, nz) => (ny < 0.15 ? CLAY_WET : nz > 0.4 ? shade(CLAY[0], 1.06) : CLAY[Math.floor(posHash(_nx * 7, ny * 7, nz, seed) * 3) % 3]), 0.2, 0, seed);
        return;
      }
      case 'salt': {
        // a flat crust plate: an irregular polygon a few cm proud of the ground
        const n = 6;
        const pts: V3[] = [];
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + h(i) * 0.4;
          const r = s * (0.38 + h(i + 10) * 0.18);
          pts.push([Math.cos(a) * r, 0.035, Math.sin(a) * r]);
        }
        const col = SALT[Math.floor(h(20) * 3) % 3];
        b.poly([...pts].reverse(), col);
        for (let i = 0; i < n; i++) {
          const a = pts[i], c = pts[(i + 1) % n];
          b.quad([a[0], -0.02, a[2]], [c[0], -0.02, c[2]], c, a, shade(col, 0.86));
        }
        return;
      }
      case 'gold': {
        // a patch of stream gravel: pebbles of the bed's colours
        const n = lod === 0 ? 12 : 5;
        for (let i = 0; i < n; i++) {
          const a = h(i) * Math.PI * 2, r = s * 0.5 * Math.sqrt(h(i + 40));
          const ps = 0.1 + h(i + 80) * 0.16;
          b.blob(Math.cos(a) * r, ps * 0.2, Math.sin(a) * r, ps, ps * 0.55, ps * 0.8, PEBBLES[i % PEBBLES.length], 0.25, 0, seed + i);
        }
        return;
      }
    }
  });
}

/** Wet puddles (water channel) for clay banks: a flat irregular pool of radius ~r. */
export function puddleInto(b: MeshBuilder, r: number, seed: number): void {
  b.state({ layer: Layer.Detail, mat: Mat.Water, flags: F.NoAO }, () => {
    const n = 7;
    const pts: V3[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const k = r * (0.75 + posHash(seed, i, 5) * 0.4);
      pts.push([Math.cos(a) * k, 0.03, Math.sin(a) * k * 0.7]);
    }
    b.poly([...pts].reverse(), 0x6f7468);
  });
}
