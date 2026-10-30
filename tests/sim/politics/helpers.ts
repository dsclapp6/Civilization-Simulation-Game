// Helpers for the politics tests: a simulation with social, economy and politics installed, and builders
// for Houses, titles and marriages with known kinship.
import { createPerson } from '../../../src/sim/people';
import { installEconomy } from '../../../src/sim/economy';
import { installPolitics, politicsInternals, type PoliticsInternals, type PoliticsRuntime } from '../../../src/sim/politics';
import type { Simulation } from '../../../src/sim/sim';
import { installSocial, socialInternals } from '../../../src/sim/social';
import type { SocialCore } from '../../../src/sim/social/core';
import type { SocialApi } from '../../../src/sim/social/types';
import { NONE, type HouseId, type Person, type Title } from '../../../src/sim/state';
import { newSim, noPlayer, type TestSimOptions } from '../helpers';

export interface Rig {
  sim: Simulation;
  pol: PoliticsRuntime;
  x: PoliticsInternals;
  social: SocialApi;
  core: SocialCore;
}

export function rig(opts: TestSimOptions & { keepPlayer?: boolean } = {}): Rig {
  const sim = newSim({ preset: 'tiny', ...opts });
  if (!opts.keepPlayer) noPlayer(sim);
  const social = installSocial(sim);
  const economy = installEconomy(sim, { social });
  const pol = installPolitics(sim, { social, economy });
  const x = politicsInternals(sim) as PoliticsInternals;
  return { sim, pol, x, social, core: socialInternals(sim) as SocialCore };
}

export type Ctx = Pick<Rig, 'sim' | 'x'>;

/** Houses holding a title of the given kind, in title-id order. */
export function housesHolding(sim: Simulation, kind: Title['kind']): HouseId[] {
  const out: HouseId[] = [];
  for (const t of sim.state.titles.values()) {
    if (t.kind !== kind) continue;
    const p = sim.state.persons.get(t.holder);
    if (p && !out.includes(p.house)) out.push(p.house);
  }
  return out;
}

export function titlesOfKind(sim: Simulation, kind: Title['kind']): Title[] {
  return [...sim.state.titles.values()].filter((t) => t.kind === kind).sort((a, b) => a.id - b.id);
}

export function holderOf(sim: Simulation, t: Title): Person {
  return sim.state.persons.get(t.holder) as Person;
}

/** Moves the demesnes of House `b` next to those of House `a` (so they count as neighbours). */
export function bringNear(r: Ctx, a: HouseId, b: HouseId): void {
  const pa = r.x.core.demesnes(a)[0], pb = r.x.core.demesnes(b)[0];
  const sa = r.sim.world.settlements.find((s) => s.id === pa);
  const sb = r.sim.world.settlements.find((s) => s.id === pb);
  if (!sa || !sb) throw new Error('no demesne');
  (sb as { x: number }).x = sa.x + 900;
  (sb as { z: number }).z = sa.z + 300;
  r.x.core.invalidate();
}

/** A grown noble of a House, married or not, in the household of its head. */
export function noble(r: Ctx, house: HouseId, sex: 'm' | 'f', age: number, opts: { father?: Person; mother?: Person; tier?: Person['rankTier']; traits?: Person['traits'] } = {}): Person {
  const st = r.sim.state;
  const h = st.houses.get(house)!;
  const head = st.persons.get(h.head)!;
  const hh = st.households.get(head.household)!;
  const p = createPerson(st, st.rng('test-noble'), {
    culture: head.culture, sex, age, day: r.sim.absDay, settlement: hh.settlement, household: hh, house, career: sex === 'm' ? 'knight' : 'lady',
    stage: 2, tier: opts.tier ?? 5, estate: 'noble', father: opts.father ?? null, mother: opts.mother ?? null, byname: h.name, noble: true,
    traits: opts.traits ?? [],
  });
  st.joinHousehold(p, hh);
  if (opts.father) st.addChild(opts.father, p.id);
  if (opts.mother) st.addChild(opts.mother, p.id);
  return p;
}

/** Marries two people through the social system (houses, households and events as in play). */
export function wed(r: Rig, a: Person, b: Person): void {
  const res = r.core.courtship.wed(a, b);
  if (!res.ok) throw new Error(`wedding failed: ${res.reason}`);
}

/** Sets a head's traits (and so the House's temperament) for a scenario. */
export function setTraits(r: Ctx, house: HouseId, traits: Person['traits']): Person {
  const head = r.x.core.headOf(house) as Person;
  head.traits = [...traits];
  head.rep = { honour: 0, generosity: 0, piety: 0, cruelty: 0, valour: 0 };
  r.sim.state.touch(head);
  r.x.core.invalidate();
  return head;
}

export function ageHead(r: Ctx, house: HouseId, years: number): Person {
  const head = r.x.core.headOf(house) as Person;
  head.birthDay = r.sim.absDay - years * 16;
  r.sim.state.touch(head);
  return head;
}

export { NONE };
