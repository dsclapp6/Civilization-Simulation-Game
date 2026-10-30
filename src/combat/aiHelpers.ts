// Small estimates the fighters' AI makes about each other.
import type { Fighter } from './fighter';

/** How much cutting armour the opponent seems to wear on the body (hit points soaked). */
export function absorbRate(t: Fighter): number {
  let a = 0;
  for (const p of t.gear.armour) if ((p.def.cover.torso ?? 0) > 0) a += p.def.absorb.cut * (p.def.cover.torso ?? 0);
  return a;
}
