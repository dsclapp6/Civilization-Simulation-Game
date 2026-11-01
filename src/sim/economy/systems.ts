// Scheduler systems of the economy: when each part runs. Settlements tick one per hour slot, like
// life.ts (offset by half a day so the two never land on the same frame); the player's own needs and
// payments tick every hour; bookkeeping runs once a day, a season and a year.
import type { DayInfo, HourInfo, SeasonInfo, YearInfo } from '../clock';
import type { SimContext } from '../context';
import type { Scheduler } from '../scheduler';
import type { Econ } from './core';
import { adoptPlaceholderPhases } from '../farming';
import { initFarm, yearlyFarm } from './farm';
import { giveKit, initHouseholds, partsOf, settlementDay, yearlyProsperity } from './macro';
import { marketFlowsDay } from './market';

/** Hour of the day at which a settlement's economic day is run. */
export const slotOf = (settlementId: number): number => (settlementId + 12) % 24;

export type Hook<T> = (E: Econ, info: T) => void;

export interface SystemHooks {
  hourly: Array<Hook<HourInfo>>;
  daily: Array<Hook<DayInfo>>;
  seasonal: Array<Hook<SeasonInfo>>;
  yearly: Array<Hook<YearInfo>>;
}

const ECON_SHARDS = 12;

export function registerSystems(E: Econ, sched: Scheduler, hooks: SystemHooks): () => void {
  const offs: Array<() => void> = [];
  offs.push(sched.register({
    name: 'econ.settlements', phase: 'hourly', order: 40, shards: ECON_SHARDS,
    run: (_ctx: SimContext, info: HourInfo, shard = 0) => {
      // a big settlement's day runs in slices over consecutive hours (slice k at slot + k), and the hour's settlements
      // in shards, so no frame carries more than a few of them
      for (const s of E.world.settlements) {
        if (s.id % ECON_SHARDS !== shard) continue;
        const parts = partsOf(s);
        const k = (info.hour - slotOf(s.id) + 24) % 24;
        if (k < parts) settlementDay(E, s, k, parts);
      }
    },
  }));
  offs.push(sched.register({
    name: 'econ.hourly', phase: 'hourly', order: 45,
    run: (_ctx: SimContext, info: HourInfo) => { for (const h of hooks.hourly) h(E, info); },
  }));
  offs.push(sched.register({
    name: 'econ.daily', phase: 'daily', order: 35,
    run: (_ctx: SimContext, info: DayInfo) => { marketFlowsDay(E); for (const h of hooks.daily) h(E, info); },
  }));
  offs.push(sched.register({
    name: 'econ.seasonal', phase: 'seasonal', order: 35,
    run: (_ctx: SimContext, info: SeasonInfo) => { for (const h of hooks.seasonal) h(E, info); },
  }));
  offs.push(sched.register({
    name: 'econ.yearly', phase: 'yearly', order: 20,
    run: (_ctx: SimContext, info: YearInfo) => {
      yearlyProsperity(E);
      yearlyFarm(E, info.year);
      for (const h of hooks.yearly) h(E, info);
    },
  }));
  return () => { for (const o of offs) o(); };
}

/** One-time set-up of a fresh run (a loaded run already has all of this in its saved state). */
export function initFresh(E: Econ): void {
  adoptPlaceholderPhases(E.state, E.day);
  initFarm(E);
  initHouseholds(E);
  const player = E.person(E.playerId);
  if (player) giveKit(E, player);
  E.save.init = 1;
  E.touchSave();
  E.touchMarkets();
  E.touchFarm();
  for (const s of E.state.strips.values()) E.state.touchStrip(s);
}
