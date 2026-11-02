// What the rival AI reckons besides the head-count of a House (SPEC §16: "they weigh the new strength"): the quality its techniques and
// arms add to its men, the walls and keeps a siege of its lands would meet, and how thin its standing force is beside its people.
// The AI rulers (src/sim/realm/ai*.ts) raise walls, research and take men on with the player's own calls; these are the readings by
// which the war decisions of `ai.ts` take those deeds into account. All are pure functions of the state, cheap and cached by the
// caller for the hour.
import type { BuildingKind } from '../../content/types';
import type { BuildingState } from '../state';

/** The fortification weights and ceiling of the macro siege (src/sim/military/siege.ts DEFENCE_WEIGHT, fortBonus): what a siege counts. */
export const FORT_WEIGHT: Readonly<Partial<Record<BuildingKind, number>>> = { palisade: 0.45, wall: 0.9, tower: 0.25, gatehouse: 0.3, motte: 0.8, keep_stone: 1.1 };
export const FORT_MAX = 3.2;

/** The multiplier the macro siege gives a place whose buildings are these (1 = no walls at all, up to 3.2), and how many pieces count. */
export function fortFactor(buildings: readonly BuildingState[]): { fort: number; pieces: number } {
  let bonus = 0, pieces = 0;
  for (const b of buildings) {
    const w = FORT_WEIGHT[b.kind];
    if (w === undefined || b.construction < 1) continue;
    pieces++;
    const lv = b.kind === 'wall' || b.kind === 'palisade' ? Math.min(1.4, 0.6 + b.level * 0.35) : 1 + (b.level - 1) * 0.15;
    bonus += w * lv * (1 - Math.min(1, b.damage));
  }
  const fort = Math.min(FORT_MAX, 1 + Math.min(2.2, (bonus / 3.2) * 2.2 + (bonus > 0 ? 0.25 : 0)));
  return { fort, pieces };
}

/** How much a technique adds to the weight of a House's men: the bow, plate, the destrier, the crossbow, paid retinues and archers (at most +35 %). */
export function mightOf(bonus: (key: string) => number): number {
  const m = 0.06 * bonus('arms.longbow') + 0.05 * bonus('armour.plates') + 0.04 * bonus('armour.plate') + 0.04 * bonus('arms.destrier')
    + 0.04 * bonus('arms.crossbow') + 0.25 * bonus('levy.retinue') + 0.3 * bonus('levy.archers');
  return 1 + Math.min(0.35, m);
}

/** How much the keep, the walls and the concentric plan make the same stones count for (the military module's own sum). */
export function masonryOf(bonus: (key: string) => number): number {
  return 1 + 0.1 * bonus('defence.keep') + 0.14 * bonus('defence.walls') + 0.18 * bonus('defence.concentric');
}

/** What the besiegers' engines add against walls (a trebuchet, a bombard). */
export function siegecraftOf(bonus: (key: string) => number): number {
  return 1 + 0.05 * bonus('siege.trebuchet') + 0.08 * bonus('siege.bombard');
}
