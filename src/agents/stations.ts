// Where the watch stands on a settlement's fortifications (docs/CIV.md §9): along the wall-walks of the curtain walls, behind the stakes
// of palisades, on the towers and over the gate. `ZoneApi.wallStations(settlement)` is built here from the finished fortification
// buildings; the heights are those of the building recipes (src/assets/buildings/recipes/defence.ts), as the door offsets of
// geometry.ts are — a stone wall's walk is at 7 m (9 m at level 2), a tower's top at 11 (14), the gatehouse's at 11.5, a palisade's fighting
// platform at 1.95 m (level 2; a level 1 palisade has none: the men stand behind the stakes on the ground).
import { BUILDINGS } from '../content/types';
import type { BuildingKind } from '../content/types';
import type { BuildingState, GameState } from '../sim/state';
import type { WorldModel } from '../world/types';
import { toWorld } from './geometry';
import type { WallStation } from './types';

/** Kinds of fortification buildings that carry stations. */
export const FORT_KINDS: ReadonlySet<BuildingKind> = new Set<BuildingKind>(['wall', 'palisade', 'tower', 'gatehouse']);

/** Height (m above the ground at the building) of the walk a defender stands on. */
export function walkHeight(kind: BuildingKind, level: number): number {
  switch (kind) {
    case 'wall': return level >= 2 ? 9.0 : 7.0;
    case 'tower': return level >= 2 ? 14 : 11;
    case 'gatehouse': return level >= 2 ? 11.5 : 6.6;
    case 'palisade': return level >= 2 ? 1.95 : 0;
    default: return 0;
  }
}

/** A ladder is only set against a station whose floor is raised at least this far above the ground: a level 1 palisade has stakes and no walk. */
export const LADDER_MIN_RISE = 1.5;

const tmp = { x: 0, z: 0 };

/** The stations of one building (0 to 2 of them). */
export function stationsOf(b: BuildingState, world: WorldModel, centre: { x: number; z: number } | null, out: WallStation[]): void {
  const def = BUILDINGS[b.kind];
  const base = walkHeight(b.kind, b.level);
  const put = (lx: number, lz: number, kind: WallStation['kind'], yaw: number): void => {
    toWorld(b, lx, lz, tmp);
    out.push({ building: b.id, kind, x: tmp.x, y: world.heightAt(tmp.x, tmp.z) + base, z: tmp.z, yaw });
  };
  switch (b.kind) {
    case 'wall':
      // along the wall-walk (the outer parapet is on the local +z side, which faces the field)
      put(-def.w / 4, 0.2, 'wall', b.rot);
      put(def.w / 4, 0.2, 'wall', b.rot);
      break;
    case 'palisade':
      // behind the stakes (the fighting platform is on the inner, local -z, side)
      put(-def.w / 4, b.level >= 2 ? -0.35 : -0.9, 'palisade', b.rot);
      put(def.w / 4, b.level >= 2 ? -0.35 : -0.9, 'palisade', b.rot);
      break;
    case 'tower': {
      // two places at the rim of the top, facing away from the middle of the settlement
      const yaw = centre ? Math.atan2(b.x - centre.x, b.z - centre.z) : b.rot;
      const s = Math.sin(yaw), c = Math.cos(yaw);
      for (const side of [-1, 1]) {
        out.push({
          building: b.id, kind: 'tower', x: b.x + s * 1.5 + c * side * 1.0, y: world.heightAt(b.x, b.z) + base, z: b.z + c * 1.5 - s * side * 1.0, yaw,
        });
      }
      break;
    }
    case 'gatehouse':
      // over each flanking block, looking out of the gate (its door faces local +z)
      put(-def.w / 2 + 2.2, 1.0, 'gate', b.rot);
      put(def.w / 2 - 2.2, 1.0, 'gate', b.rot);
      break;
    default: break;
  }
}

/** The stations of a settlement's fortifications, finished and standing ones only. Empty for an unwalled place. */
export function buildStations(state: GameState, world: WorldModel, settlement: number): WallStation[] {
  const out: WallStation[] = [];
  const s = world.settlements.find((q) => q.id === settlement);
  const centre = s ? { x: s.x, z: s.z } : null;
  for (const b of state.buildingsAt.get(settlement) ?? []) {
    if (!FORT_KINDS.has(b.kind) || b.construction < 1 || b.damage >= 0.9) continue;
    stationsOf(b, world, centre, out);
  }
  return out;
}
