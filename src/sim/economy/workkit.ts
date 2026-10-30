// Shared parts of every work action: how fast a person works, which tool they hold, what a bout
// earns (wages, week-work credit, experience, strength) and what it costs (tool wear, strength,
// hunger). Actions themselves live in work-farm.ts, work-craft.ts and work-misc.ts.
import type { SkillId, StatId } from '../../core/domain';
import type { ActionOption } from '../actions';
import { isHolyDay } from '../calendar';
import { skillLevel } from '../people';
import { gainSkill, trainStat } from '../skills';
import type { Household, Person } from '../state';
import type { Econ } from './core';
import { TOOL_SPEED } from './data';
import { bagEntries, bestOf, wearTool, type Bag } from './items';
import { drainWork, needsFactor } from './needs';
import { creditWeekWork } from './obligations';
import { perkSum, perkTotal } from './perks';
import { parseItemKey, type ItemKey, type Quality } from './types';

/** Seconds a bout takes at speed 1. */
export const BOUT = 12;
/** Fraction of a working day one bout stands for (a day's work is a little over three bouts). */
export const BOUT_DAYS = 0.3;

export interface ToolRef { key: ItemKey; quality: Quality; bag: Bag; shared: boolean }

/** The best tool of a class the person carries or the household keeps. */
export function toolFor(E: Econ, p: Person, good: string): ToolRef | null {
  const inv = bestOf(p.inventory, good);
  if (inv) return { key: inv.key, quality: inv.quality, bag: p.inventory, shared: false };
  const hh = E.hhOf(p);
  if (hh) {
    const b = bestOf(hh.stores, good);
    if (b) return { key: b.key, quality: b.quality, bag: hh.stores, shared: true };
  }
  return null;
}

/** Cheap check used by list(): does the person hold at least `n` of a good, carried or in the household's stores? */
export function haveOf(E: Econ, p: Person, good: string): number {
  let n = 0;
  for (const [k, v] of bagEntries(p.inventory)) if (parseItemKey(k).good === good) n += v;
  const hh = E.hhOf(p);
  if (hh) for (const [k, v] of bagEntries(hh.stores)) if (parseItemKey(k).good === good) n += v;
  return n;
}

export function weatherSlow(E: Econ): number {
  const w = E.sim.view.weather();
  return (1 - 0.12 * Math.min(1, w.rain)) * (1 - 0.18 * Math.min(1, w.snow));
}

/** Work speed (1 = an average hand with a common tool in fair weather). */
export function speedOf(E: Econ, p: Person, skill: SkillId, stat: StatId, toolQ: number | null, extra = 0): number {
  const lvl = skillLevel(p.skills[skill]);
  const s = (0.62 + 0.035 * lvl) * (0.78 + 0.043 * p.trained[stat]) * (toolQ === null ? 1 : TOOL_SPEED[toolQ])
    * needsFactor(p) * (1 + perkSum(p, skill, 'speed') + extra) * weatherSlow(E);
  return Math.max(0.3, Math.min(3.2, s));
}

export function secondsFor(bouts: number, speed: number, min = 5, max = 90): number {
  return Math.max(min, Math.min(max, Math.round(((BOUT * bouts) / speed) * 10) / 10));
}

/** Experience for `bouts` bouts of work (perks and quick learners are applied by gainSkill). */
export function giveXp(E: Econ, p: Person, skill: SkillId, base: number, bouts: number): void {
  const mult = 1 + perkSum(p, skill, 'xp') + perkTotal(p, 'xpAll');
  gainSkill(E.sim, p, skill, base * bouts * mult);
}

/** Heavy labour builds strength and endurance (0.012 / 0.010 a bout at full effort: STR 10 by 14 for a boy of 12 with potential 11+). */
export function trainBout(E: Econ, p: Person, strWeight: number, endWeight: number, bouts: number): void {
  if (strWeight > 0) trainStat(E.sim, p, 'str', 0.012 * strWeight * bouts);
  if (endWeight > 0) trainStat(E.sim, p, 'end', 0.01 * endWeight * bouts);
}

export function wearOut(E: Econ, p: Person, tool: ToolRef | null, amount: number, skill: SkillId): void {
  if (!tool) return;
  const a = amount * (1 - Math.min(0.8, perkSum(p, skill, 'wear')));
  const res = wearTool(tool.bag, tool.key, a);
  if (tool.shared) { const hh = E.hhOf(p); if (hh) E.state.touchHousehold(hh); } else E.state.touch(p);
  if (res !== 'ok' && E.isPlayer(p.id)) {
    const name = parseItemKey(tool.key).good;
    E.notify(res === 'broke' ? `Your ${name} breaks.` : `Your ${name} is worn: it has lost its edge.`, 'warn', p.id);
  }
}

/** The cost of a bout in strength and food, then the experience and training it earned. */
export function boutDone(E: Econ, p: Person, o: { skill: SkillId; xp: number; heavy: number; str?: number; end?: number; bouts: number }): void {
  drainWork(E, p, o.heavy * o.bouts);
  giveXp(E, p, o.skill, o.xp, o.bouts);
  trainBout(E, p, (o.str ?? o.heavy) * o.heavy, (o.end ?? o.heavy) * o.heavy, o.bouts);
}

export type AccessMode = 'own' | 'week' | 'hired' | 'free';

/** Pays for a bout of work done for someone else: wages from the employer, or credit towards week-work. */
export function payBout(E: Econ, p: Person, mode: AccessMode, wage: number, bouts: number, employer: Household | undefined): number {
  if (mode === 'week') { creditWeekWork(E, p, BOUT_DAYS * bouts); return 0; }
  if (mode !== 'hired' || wage <= 0) return 0;
  const pay = Math.round(wage * BOUT_DAYS * bouts * 100) / 100;
  if (employer) {
    const got = E.debit(employer, pay);
    E.earn(p, got, 'Wages');
    return got;
  }
  E.earn(p, pay, 'Wages');
  return pay;
}

export function holyDayBlock(E: Econ): string | null {
  return isHolyDay(E.day) ? 'It is the holy day: rest, go to church, or practise at the butts' : null;
}

/** The universal check: a person who cannot stand does not work. */
export function incapable(p: Person): string | null {
  if (p.needs.hunger <= 0.03) return 'You are too weak from hunger';
  if (p.health.hp < 0.12) return 'You are too hurt to work';
  return null;
}

let optionCounter = 0;

export function option(o: Partial<ActionOption> & Pick<ActionOption, 'id' | 'label' | 'target' | 'seconds'>): ActionOption {
  optionCounter++;
  return { provider: '', category: 'work', enabled: true, range: 8, priority: 20, repeat: true, ...o };
}

export function disabled(o: Partial<ActionOption> & Pick<ActionOption, 'id' | 'label' | 'target'>, reason: string): ActionOption {
  return { provider: '', category: 'work', seconds: 0, range: 8, priority: 1, ...o, enabled: false, reason };
}

export const round1 = (v: number): number => Math.round(v * 10) / 10;
export const round2 = (v: number): number => Math.round(v * 100) / 100;

/** Stochastic rounding with the economy's own deterministic stream. */
export function stoch(E: Econ, x: number): number {
  const f = Math.floor(x);
  return f + (E.rng('roll').next() < x - f ? 1 : 0);
}

/** Care a piece of work puts into a crop or product: skill, tool and how rested the worker is (0.4..1). */
export function careOf(p: Person, skill: SkillId, toolQ: number | null): number {
  return Math.max(0.4, Math.min(1, 0.52 + 0.025 * skillLevel(p.skills[skill]) + 0.08 * ((toolQ ?? 1) - 1) + 0.12 * needsFactor(p) - 0.1));
}
