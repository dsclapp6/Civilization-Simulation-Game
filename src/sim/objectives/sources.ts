// Reads from the other modules, each guarded: the objectives work with whatever is installed (a headless
// run has no zone or player; a test may have no happenings or military).
import type { HoldingView, StripHolding } from '../economy/types';
import type { HappeningsRuntime, RequestView } from '../happenings/types';
import type { MilitaryRuntime } from '../military/types';
import type { Person } from '../state';
import type { Obj } from './core';

export function happeningsOf(O: Obj): HappeningsRuntime | undefined {
  const h = O.sim.services.happenings as Partial<HappeningsRuntime> | undefined;
  return h && typeof h.requests === 'function' ? (h as HappeningsRuntime) : undefined;
}

export function militaryOf(O: Obj): MilitaryRuntime | undefined {
  const m = O.sim.services.military as Partial<MilitaryRuntime> | undefined;
  return m && typeof m.service === 'function' ? (m as MilitaryRuntime) : undefined;
}

/** All requests the happenings module knows (open ones first). */
export function requestsOf(O: Obj): RequestView[] {
  return happeningsOf(O)?.requests() ?? [];
}

export function requestById(O: Obj, id: number): RequestView | undefined {
  return requestsOf(O).find((r) => r.id === id);
}

export function holdingOf(O: Obj, p: Person): HoldingView | null {
  return p.household ? O.deps.economy.holding(p.household) : null;
}

/** What a strip waits for, as one word ('' when it waits for nothing the player can do now). */
export function taskWord(label: string): string {
  const w = /^(Plough|Harrow|Sow|Weed|Reap|Bind|Carry)/.exec(label);
  return w ? w[1].toLowerCase() : '';
}

export interface StripNow { task: string; work: number; crop: string; state: string; label: string }

/** The state of one of the household's strips. */
export function stripNow(O: Obj, p: Person, id: number): StripNow | null {
  const h = holdingOf(O, p);
  const s: StripHolding | undefined = h?.strips.find((x) => x.id === id);
  return s ? { task: taskWord(s.nextTask), work: s.work, crop: s.crop, state: s.state, label: s.nextTask } : null;
}

/** Quantity of a good in a bag (item keys carry a quality suffix: `sickle#2`; keys starting with `~` are bookkeeping). */
export function bagQty(bag: Readonly<Record<string, number>>, good: string): number {
  let n = 0;
  for (const k of Object.keys(bag)) {
    if (k.charCodeAt(0) === 126) continue;
    if (k === good || (k.length > good.length && k.startsWith(good) && k.charCodeAt(good.length) === 35)) n += bag[k];
  }
  return n;
}

export const round1 = (v: number): number => Math.round(v * 10) / 10;
export const round2 = (v: number): number => Math.round(v * 100) / 100;
