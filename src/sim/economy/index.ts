// Placeholder (wave 2 ECON replaces this file): an economy with no goods or markets.
import type { SocialApi } from '../social/types';
import type { Simulation } from '../sim';
import type { EconomyApi } from './types';

export interface EconomyDeps { social: SocialApi }

export function installEconomy(sim: Simulation, _deps: EconomyDeps): EconomyApi {
  const none = { ok: false, reason: 'Not available yet' };
  return {
    goods: () => [],
    good: () => undefined,
    describe: (key, qty) => (qty && qty !== 1 ? `${qty} ${key}` : key),
    inventory: (person) => {
      const p = sim.state.persons.get(person);
      return { owner: person, items: [], money: p?.money ?? 0, weight: 0, capacity: 30, equipment: {} };
    },
    stores: () => [],
    stash: () => none,
    equip: () => none,
    consume: () => none,
    give: () => none,
    market: () => null,
    price: () => 0,
    partnerStock: () => [],
    quote: () => ({ lines: [], money: 0, ok: false, reason: 'Not available yet' }),
    trade: () => none,
    jobs: () => [],
    applyForJob: () => none,
    quitJob: () => none,
    employment: () => null,
    careerPaths: () => [],
    entryTests: () => [],
    workSpot: () => null,
    holding: () => null,
    listings: () => [],
    buyOrRent: () => none,
    obligations: () => [],
    ledger: () => [],
    householdPlan: () => [],
    setTask: () => none,
    hire: () => none,
    dismiss: () => none,
    perk: () => undefined,
    perkChoices: () => [],
    choosePerk: () => none,
  };
}
