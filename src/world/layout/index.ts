// Stage 6: settlement layouts (plots, streets, parcels) for every settlement.
import { lap, lapReset, type GenState } from '../state';
import { TerrainModel } from '../terrainmodel';
import { LayoutCtx } from './common';
import { generateFields } from '../fields';
import { findCrossings } from '../roads';
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
    switch (st.kind) {
      case 'village': layoutVillage(ctx, id); break;
      case 'hamlet': layoutHamlet(ctx, id); break;
      case 'town': layoutTown(ctx, id, false); break;
      case 'city': layoutTown(ctx, id, true); break;
      case 'castle': layoutCastle(ctx, id); break;
      case 'abbey': case 'priory': case 'nunnery': layoutAbbey(ctx, id); break;
      default: break;
    }
  }
  lap(s, 'l.layouts');
  generateFields(ctx);
  // castle and abbey approaches were re-routed: crossings (bridges, fords) are recomputed on the final roads
  findCrossings(s);
  tm.refreshDepth();
  return { ctx, tm };
}
