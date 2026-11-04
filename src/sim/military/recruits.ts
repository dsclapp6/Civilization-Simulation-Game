// Fresh fighting men made for a House: drilled soldiers in a new garrison household of the place, with careers and arms
// skills fitting their kind (the scenario's hosts and garrisons, raiders' hired swords).
import { createPerson } from '../people';
import { NONE, type HouseId, type Person } from '../state';
import type { Mil } from './store';
import type { UnitKind } from './types';

export function freshMen(M: Mil, house: HouseId, sid: number, counts: Partial<Record<UnitKind, number>>): Array<{ person: Person; kind: UnitKind }> {
  const st = M.state;
  const s = M.settlementById.get(sid);
  const h = st.houses.get(house);
  if (!s || !h) return [];
  const rng = M.sim.rng('military.muster');
  const hh = st.addHousehold({ id: st.households.alloc(), kind: 'garrison', head: NONE, members: [], home: -1, settlement: sid, purse: 0, stores: {} });
  const CAREER: Record<UnitKind, Person['career']> = {
    levy: 'soldier', archer: 'archer', crossbow: 'crossbowman', man_at_arms: 'man_at_arms', sergeant: 'sergeant', knight: 'knight', mercenary: 'man_at_arms',
  };
  const out: Array<{ person: Person; kind: UnitKind }> = [];
  for (const [kind, n] of Object.entries(counts) as Array<[UnitKind, number]>) {
    for (let i = 0; i < (n ?? 0); i++) {
      const tier = kind === 'knight' ? 5 : kind === 'sergeant' ? 3 : 2;
      const p = createPerson(st, rng, {
        culture: s.culture, sex: 'm', age: 19 + rng.range(0, 18), day: M.day, settlement: sid, settlementName: s.name, household: hh,
        house, career: CAREER[kind], stage: kind === 'knight' ? 2 : 1, tier: tier as Person['rankTier'], estate: kind === 'knight' ? 'noble' : 'free', money: 4,
      });
      // drilled men: arms skills fitting their kind
      p.skills.melee = Math.max(p.skills.melee, kind === 'levy' ? 600 : kind === 'archer' || kind === 'crossbow' ? 900 : 2200);
      if (kind === 'archer' || kind === 'crossbow') p.skills.archery = Math.max(p.skills.archery, 2600);
      if (kind === 'knight' || kind === 'sergeant') p.skills.riding = Math.max(p.skills.riding, 2000);
      if (!hh.head) st.setHead(hh, p);
      out.push({ person: p, kind });
    }
  }
  return out;
}
