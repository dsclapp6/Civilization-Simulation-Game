// Stage 6: settlement layouts (plots, streets, parcels) for every settlement.
import { CELL, N } from '../grid';
import { lap, lapReset, type GenState } from '../state';
import { TerrainModel } from '../terrainmodel';
import { LayoutCtx } from './common';
import { generateFields } from '../fields';
import { findCrossings } from '../roads';
import { repairLayout } from '../validate';
import { layoutAbbey, layoutCastle } from './castle';
import { layoutTown } from './town';
import { layoutHamlet, layoutVillage } from './village';

export interface LayoutResult { ctx: LayoutCtx; tm: TerrainModel; }

export function generateLayouts(s: GenState, tm: TerrainModel): LayoutResult {
  lapReset();
  const ctx = new LayoutCtx(s, tm, s.rng.fork('layout'));
  const order = s.settlements.map((st) => st.id);
  const rank = (k: string): number => ({ city: 0, castle: 1, town: 2, abbey: 3, priory: 3, nunnery: 3, village: 4, hamlet: 5 } as Record<string, number>)[k] ?? 6;
  order.sort((a, b) => rank(s.settlements[a].kind) - rank(s.settlements[b].kind) || a - b);
  for (const id of order) {
    const st = s.settlements[id];
    const t0 = performance.now();
    switch (st.kind) {
      case 'village': layoutVillage(ctx, id); break;
      case 'hamlet': layoutHamlet(ctx, id); break;
      case 'town': layoutTown(ctx, id, false); break;
      case 'city': layoutTown(ctx, id, true); break;
      case 'castle': layoutCastle(ctx, id); break;
      case 'abbey': case 'priory': case 'nunnery': layoutAbbey(ctx, id); break;
      default: break;
    }
    s.timings[`l.${st.kind}`] = (s.timings[`l.${st.kind}`] ?? 0) + (performance.now() - t0);
  }
  lap(s, 'l.layouts');
  generateFields(ctx);
  // castle and abbey approaches were re-routed: crossings (bridges, fords) are recomputed on the final roads
  findCrossings(s);
  tm.refreshDepth();
  const rep = repairLayout(s, tm, ctx);
  ctx.diag.repairedPlots = rep.plotsRemoved;
  ctx.diag.repairedStrips = rep.stripsRemoved;
  // castles and abbeys may have been shifted from their original site: the macro kingdom/county cells at each
  // settlement must agree with the settlement itself (a one-cell patch at a border at most)
  for (const st of s.settlements) {
    const k = Math.min(N - 1, Math.max(0, Math.floor(st.z / CELL))) * N + Math.min(N - 1, Math.max(0, Math.floor(st.x / CELL)));
    s.kingdomGrid[k] = st.kingdom + 1;
    s.countyGrid[k] = st.county + 1;
  }
  lap(s, 'l.repair');
  return { ctx, tm };
}
