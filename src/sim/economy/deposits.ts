// What the ground under a works holds (civilization pass, docs/CIV.md §7). The territory module (sim.services.territory,
// found lazily: any module may be missing in a test) knows the deposits of the world; the economy asks it which one a mine,
// quarry, clay pit or salt pan stands on, how rich it is, and what lies in reach of a market town. Without the module a
// works is taken to stand on a middling deposit of the kind it is meant for, so the old world plays as it did.
import type { Deposit, ResourceKind } from '../../world/types';
import type { Econ } from './core';

/** Richness of a works that stands on no known deposit (the world before deposits: an ordinary seam). */
export const DEFAULT_RICHNESS = 0.7;

/** The deposit a point lies on, trying the kinds in order (the richest metal first); null if the territory module knows none. */
export function depositUnder(E: Econ, x: number, z: number, kinds: readonly ResourceKind[]): Deposit | null {
  const terr = E.sim.services.territory;
  if (!terr) return null;
  for (const k of kinds) {
    let d: Deposit | null = null;
    try { d = terr.depositAt(x, z, k); } catch { d = null; }
    if (d) return d;
  }
  return null;
}

/** What a mine yields, by the deposit under it: gold and silver where the territory says so, else iron. */
export function mineKind(E: Econ, x: number, z: number): { kind: ResourceKind; richness: number; known: boolean } {
  const d = depositUnder(E, x, z, ['gold', 'silver', 'iron']);
  return d ? { kind: d.kind, richness: d.richness, known: true } : { kind: 'iron', richness: DEFAULT_RICHNESS, known: false };
}

/** Yield multiplier of a deposit's richness (0..1): a thin bank gives about half of a rich seam. */
export function richnessFactor(richness: number): number { return 0.35 + 0.8 * Math.max(0, Math.min(1, richness)); }

/** Is there a deposit of this kind within `radius` of a point (false without the territory module)? */
export function depositNear(E: Econ, x: number, z: number, radius: number, kind: ResourceKind): boolean {
  const terr = E.sim.services.territory;
  if (!terr) return false;
  try { return terr.depositsNear(x, z, radius, kind).length > 0; } catch { return false; }
}
