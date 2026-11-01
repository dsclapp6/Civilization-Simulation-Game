// The places worth knowing, for the journal's Places page ("Find" puts a marker on one): home, the family's
// strips, the church, the market, the smithy, the alehouse, the mill, the butts, the well and the workplace.
import type { BuildingKind } from '../../content/types';
import { dist } from '../../core/math';
import type { Person } from '../state';
import type { Obj } from './core';
import {
  buildingTarget, buildingsOfKind, churchOf, homeOf, marketPlaceIn, marketTownOf, nearestOf, settlementTarget, stripTarget, playerXZ,
} from './places';
import { holdingOf } from './sources';
import type { ObjectiveTarget } from './types';

const KNOWN: ReadonlyArray<{ label: string; kinds: readonly BuildingKind[] }> = [
  { label: 'smithy', kinds: ['smithy'] },
  { label: 'alehouse', kinds: ['alehouse', 'tavern'] },
  { label: 'mill', kinds: ['watermill', 'windmill'] },
  { label: 'archery butts', kinds: ['archery_butts'] },
  { label: 'well', kinds: ['well'] },
  { label: 'bakehouse', kinds: ['bakehouse'] },
  { label: 'carpenter', kinds: ['carpenter'] },
  { label: 'manor house', kinds: ['manor_house', 'great_hall', 'keep_stone'] },
];

/** Notable places around the player, nearest first (home always leads). */
export function notablePlaces(O: Obj, me: Person): ObjectiveTarget[] {
  const out: ObjectiveTarget[] = [];
  const home = homeOf(O, me);
  if (home) out.push(buildingTarget(O, home, 'Your home'));
  const holding = holdingOf(O, me);
  if (holding) for (const s of holding.strips.slice(0, 6)) out.push(stripTarget(O, s.id));
  const church = churchOf(O, me);
  if (church) out.push(buildingTarget(O, church));
  const town = marketTownOf(O, me.settlement);
  if (town) {
    const hall = marketPlaceIn(O, town);
    out.push(hall ? buildingTarget(O, hall) : settlementTarget(O, town));
  }
  const emp = O.deps.economy.employment(me.id);
  const work = emp?.building !== undefined ? O.state.buildings.get(emp.building) : undefined;
  if (work) out.push(buildingTarget(O, work, `${buildingTarget(O, work).label} (your work)`));
  const hx = home?.x ?? 0, hz = home?.z ?? 0;
  const seen = new Set(out.map((t) => `${t.kind}:${t.id}`));
  for (const k of KNOWN) {
    const b = nearestOf(buildingsOfKind(O, me.settlement, k.kinds), hx, hz);
    if (b && !seen.has(`building:${b.id}`)) { out.push(buildingTarget(O, b)); seen.add(`building:${b.id}`); }
  }
  const pos = playerXZ(O);
  const first = out.shift();
  if (pos) out.sort((a, b) => dist(pos.x, pos.z, a.x, a.z) - dist(pos.x, pos.z, b.x, b.z));
  return first ? [first, ...out] : out;
}
