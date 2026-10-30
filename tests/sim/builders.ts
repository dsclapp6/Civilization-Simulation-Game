// Builders for hand-made scenarios inside a running Simulation.
import { createPerson } from '../../src/sim/people';
import type { Simulation } from '../../src/sim/sim';
import type { Household, House, Person } from '../../src/sim/state';

export interface MkPerson {
  sex?: 'm' | 'f';
  age?: number;
  tier?: Person['rankTier'];
  estate?: Person['estate'];
  career?: Person['career'];
  house?: number;
  household?: number;
  father?: Person | null;
  mother?: Person | null;
  settlement?: number;
  byname?: string;
  culture?: Person['culture'];
}

/** Creates a person in the running sim (in the run's House unless told otherwise). */
export function mkPerson(sim: Simulation, o: MkPerson = {}): Person {
  const st = sim.state;
  const hh = o.household ? st.households.get(o.household) : undefined;
  const settlement = o.settlement ?? hh?.settlement ?? sim.world.settlements.find((s) => s.kind === 'village')!.id;
  const p = createPerson(st, st.rng('test-helper'), {
    culture: o.culture ?? 'anglo', sex: o.sex ?? 'm', age: o.age ?? 30, day: sim.absDay, settlement, household: hh ?? null,
    house: o.house ?? st.run.houseId, career: o.career ?? 'farmer', stage: 1, tier: o.tier ?? 2, estate: o.estate ?? 'free',
    father: o.father ?? null, mother: o.mother ?? null, byname: o.byname ?? 'Tester',
  });
  if (o.father) st.addChild(o.father, p.id);
  if (o.mother) st.addChild(o.mother, p.id);
  return p;
}

export function mkHousehold(sim: Simulation, settlement?: number): Household {
  const st = sim.state;
  const sid = settlement ?? sim.world.settlements.find((s) => s.kind === 'village')!.id;
  return st.addHousehold({ id: st.households.alloc(), kind: 'family', head: 0, members: [], home: -1, settlement: sid, purse: 100, stores: {} });
}

export function mkHouse(sim: Simulation, name = 'Tester'): House {
  const st = sim.state;
  return st.addHouse({ id: st.houses.alloc(), name, culture: 'anglo', kind: 'peasant', seat: 0, founder: 0, head: 0, sworn: [], extinct: false });
}

/** Makes `p` the player (removing the flag from the previous one) without any other ceremony. */
export function makePlayer(sim: Simulation, p: Person): void {
  const st = sim.state;
  const old = st.persons.get(st.run.playerId);
  if (old) { delete old.flags.player; st.touch(old); }
  p.flags.player = true;
  st.run.playerId = p.id;
  st.run.houseId = p.house;
  st.run.phase = 'alive';
  st.run.pendingSuccession = null;
  st.touch(p);
}
