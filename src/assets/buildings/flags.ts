// Flag / banner cloth geometry: hangs from the pivot (pole top) along +x and waves in the
// cloth shader (aSway grows towards the free edge). The pivot is yawed downwind at runtime.
import type * as THREE from 'three';
import { F, Layer, Mat, MeshBuilder, shade } from '../core/builder';
import { COL } from './style';

export function buildFlagGeometry(w: number, h: number, color: number, color2: number | undefined, kind: string): THREE.BufferGeometry {
  const b = new MeshBuilder(7);
  b.layer = Layer.Detail;
  b.mat = Mat.Cloth;
  b.flags = F.NoAO;
  b.jitter = 0.02;
  const nx = 6, ny = 3;
  const x0 = 0.06;
  b.swayFn = (x) => Math.min(1, Math.max(0, (x - x0) / w)) * 1.25;
  const c2 = color2 ?? COL.gold;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const xa = x0 + (w * i) / nx, xb = x0 + (w * (i + 1)) / nx;
      let ya = -h + (h * j) / ny, yb = -h + (h * (j + 1)) / ny;
      if (kind === 'pennant') {
        // Tapering triangle: shrink towards the tip.
        const ta = 1 - i / nx, tb = 1 - (i + 1) / nx;
        const ca = -h / 2, hb = h / 2;
        const yaA = ca + (ya + h / 2) * ta, ybA = ca + (yb + h / 2) * ta;
        const yaB = ca + (ya + h / 2) * tb, ybB = ca + (yb + h / 2) * tb;
        void hb;
        const col = j === 1 ? c2 : color;
        b.quad([xa, yaA, 0], [xb, yaB, 0], [xb, ybB, 0], [xa, ybA, 0], col);
        continue;
      }
      if (kind === 'standard' && i === nx - 1 && j === 1) {
        // Swallow-tail notch.
        b.tri([xa, ya, 0], [xb, ya - 0.05, 0], [xa + (xb - xa) * 0.3, (ya + yb) / 2, 0], color);
        b.tri([xa + (xb - xa) * 0.3, (ya + yb) / 2, 0], [xb, yb + 0.05, 0], [xa, yb, 0], color);
        continue;
      }
      // Field with a central pale (vertical stripe) of the second tincture.
      const pale = i === 2 || i === 3;
      const col = pale && kind !== 'standard' ? c2 : color;
      void ya; void yb;
      ya = -h + (h * j) / ny; yb = -h + (h * (j + 1)) / ny;
      b.quad([xa, ya, 0], [xb, ya, 0], [xb, yb, 0], [xa, yb, 0], col);
    }
  }
  // Hem at the hoist.
  b.quad([0.02, -h, 0], [x0, -h, 0], [x0, 0, 0], [0.02, 0, 0], shade(color, 0.7));
  b.swayFn = null;
  return b.toGeometry({ mat: Mat.Cloth, surf: true, sway: true })!;
}
