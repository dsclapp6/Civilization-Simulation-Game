// The assault plan: before and during a storm the commander splits the army into companies, each under its own
// captain (a knight or sergeant of the army), and gives each a task — the archers loose at the wall-walk, a crew works
// the ram against the gate, others carry ladders to the walls, the main body waits to charge through the breach, a
// reserve stands back. The plan shapes the battle model of the storm:
//   archers on the walls  → keep the defenders' heads down (their walls count for less);
//   the ram at the gate    → a well-manned ram breaks it (the walls count for much less, the charge goes in);
//   ladders                → more of the army comes to grips at once, at a heavy price;
//   charge                 → strong through a broken gate, costly against a whole one;
//   reserve                → fewer in the first press, but steadier (they do not break as soon).
// The AI's armies storm with a plan made the same way (`defaultPlan`).
import { kindAt } from './armies';
import type { Mil } from './store';
import type { Army, UnitKind } from './types';
import type { Fighters } from './battle';
import type { PersonId } from '../state';

export type CompanyTask = 'loose' | 'ram' | 'ladders' | 'charge' | 'reserve';
export const COMPANY_TASKS: readonly CompanyTask[] = ['loose', 'ram', 'ladders', 'charge', 'reserve'];

export interface Company {
  id: number;
  name: string;
  /** Its captain (0 = the army's commander leads it himself). */
  captain: PersonId;
  /** Men in it by kind (counts; the roster is the army's). */
  men: Partial<Record<UnitKind, number>>;
  task: CompanyTask;
}

export interface AssaultPlan { companies: Company[] }

export interface PlanEffect {
  /** Multiplies the defenders' fortification bonus. */
  fort: number;
  /** Multiplies the attackers' power. */
  att: number;
  /** Added to the attackers' morale (steadiness). */
  morale: number;
  /** One line for the player: what the plan does. */
  note: string;
}

const count = (c: Company): number => Object.values(c.men).reduce((s, n) => s + (n ?? 0), 0);

export function armyCounts(a: Army): Record<UnitKind, number> {
  const out = { levy: 0, archer: 0, crossbow: 0, man_at_arms: 0, sergeant: 0, knight: 0, mercenary: 0 } as Record<UnitKind, number>;
  for (let i = 0; i < a.units.length; i++) out[kindAt(a, i)]++;
  return out;
}

/** A sensible plan from what the army is made of: archers to the walls, a ram crew, ladders, the main body, a reserve. */
export function defaultPlan(M: Mil, a: Army): AssaultPlan {
  const c = armyCounts(a);
  const captains = a.men.map((id, i) => ({ id, k: kindAt(a, i) })).filter((x) => x.k === 'knight' || x.k === 'sergeant').map((x) => x.id);
  let next = 0;
  const cap = (): PersonId => captains[next++] ?? 0;
  const take = (k: UnitKind, n: number): number => { const t = Math.min(c[k], Math.max(0, Math.round(n))); c[k] -= t; return t; };
  const total = Object.values(c).reduce((s, n) => s + n, 0);
  const ram = { man_at_arms: take('man_at_arms', Math.min(20, total * 0.08)), levy: 0, mercenary: take('mercenary', 6) };
  ram.levy = take('levy', Math.max(0, 24 - ram.man_at_arms - ram.mercenary));
  const ladders = { levy: take('levy', total * 0.18), man_at_arms: take('man_at_arms', c.man_at_arms * 0.3) };
  const reserve = { levy: take('levy', total * 0.1), sergeant: take('sergeant', c.sergeant * 0.3) };
  const companies: Company[] = [
    { id: 1, name: 'The archers', captain: cap(), men: { archer: take('archer', c.archer), crossbow: take('crossbow', c.crossbow) }, task: 'loose' },
    { id: 2, name: 'The ram', captain: cap(), men: ram, task: 'ram' },
    { id: 3, name: 'The ladders', captain: cap(), men: ladders, task: 'ladders' },
    { id: 4, name: 'The main body', captain: a.commander, men: { ...c }, task: 'charge' },
    { id: 5, name: 'The reserve', captain: cap(), men: reserve, task: 'reserve' },
  ];
  void M;
  return { companies: companies.filter((x) => count(x) > 0 || x.id === 4) };
}

/** What a plan does to a storm of this army against a place whose walls count `fort` times (1 = open ground). */
export function planEffect(plan: AssaultPlan, a: Army, defenders: number, fort: number): PlanEffect {
  const total = Math.max(1, a.men.length);
  let looseShots = 0, ramMen = 0, ramHeavy = 0, ladder = 0, charge = 0, reserve = 0;
  for (const c of plan.companies) {
    const n = count(c);
    switch (c.task) {
      case 'loose': looseShots += (c.men.archer ?? 0) + (c.men.crossbow ?? 0) * 1.2 + (n - (c.men.archer ?? 0) - (c.men.crossbow ?? 0)) * 0.1; break;
      case 'ram': ramMen += n; ramHeavy += (c.men.man_at_arms ?? 0) + (c.men.mercenary ?? 0) + (c.men.sergeant ?? 0); break;
      case 'ladders': ladder += n; break;
      case 'charge': charge += n; break;
      case 'reserve': reserve += n; break;
    }
  }
  const walled = fort > 1.05;
  // archers on the walls keep the defenders' heads down: about one bow to two men on the walls does it
  const suppress = walled ? Math.min(1, looseShots / Math.max(10, defenders * 0.5)) : 0;
  // the ram: twenty or more men, the heavier the better, break the gate
  const breach = walled ? Math.min(1, (ramMen / 24) * (0.6 + 0.4 * Math.min(1, ramHeavy / Math.max(1, ramMen)))) : 1;
  const fortMul = walled ? Math.max(0.35, 1 - 0.22 * suppress - 0.38 * breach - 0.1 * Math.min(1, ladder / Math.max(20, defenders * 0.3))) : 1;
  const engaged = (charge * (0.55 + 0.55 * breach) + ladder * 1.05 + ramMen * 0.5 + looseShots * 0.4 + reserve * 0.35) / total;
  const att = Math.max(0.5, Math.min(1.25, engaged));
  const morale = Math.min(0.2, (reserve / total) * 0.8);
  const bits: string[] = [];
  if (walled) {
    bits.push(suppress > 0.7 ? 'the walls are swept by your bows' : suppress > 0.3 ? 'your bows trouble the wall-walk' : 'the defenders shoot freely from the walls');
    bits.push(breach > 0.8 ? 'the ram should break the gate' : breach > 0.3 ? 'the ram is short of hands' : 'no ram at the gate: the charge meets a closed gate');
  }
  if (reserve / total > 0.05) bits.push('a reserve stands ready');
  return { fort: fortMul, att, morale, note: bits.join('; ') };
}

/** Applies the plan of the attacking army to the two sides of a storm (before the battle model runs). */
export function applyPlan(plan: AssaultPlan | undefined, a: Army, fa: Fighters, fd: Fighters): void {
  if (!plan || fd.bonus <= 1.0001) return;
  const e = planEffect(plan, a, fd.people.length, fd.bonus);
  fd.bonus = Math.max(1, fd.bonus * e.fort);
  fa.total *= e.att;
  fa.morale = Math.min(1, fa.morale + e.morale);
}

/**
 * Which company, and so which task, each man of the army belongs to. The plan holds counts by kind, not names: the men of a
 * kind are dealt out in the army's roll to the companies in order, and any left over (the plan is older than the casualties)
 * fall to the main body. Derived, so nothing is saved and a loaded game answers the same.
 */
export function assignCompanies(a: Army, plan: AssaultPlan): Map<PersonId, { company: number; task: CompanyTask }> {
  const out = new Map<PersonId, { company: number; task: CompanyTask }>();
  const main = plan.companies.find((c) => c.task === 'charge') ?? plan.companies[plan.companies.length - 1];
  const byKind = new Map<UnitKind, PersonId[]>();
  for (let i = 0; i < a.men.length; i++) {
    const k = kindAt(a, i);
    (byKind.get(k) ?? byKind.set(k, []).get(k)!).push(a.men[i]);
  }
  for (const [kind, ids] of byKind) {
    let at = 0;
    for (const c of plan.companies) {
      const n = Math.max(0, Math.min(c.men[kind] ?? 0, ids.length - at));
      for (let j = 0; j < n; j++) out.set(ids[at + j], { company: c.id, task: c.task });
      at += n;
    }
    if (main) for (; at < ids.length; at++) out.set(ids[at], { company: main.id, task: main.task });
  }
  return out;
}

/** Numeric codes of the tasks the storm scene keeps on a fighter (`Fighter.task`; 0 = none). */
export const TASK_CODE: Record<CompanyTask, number> = { loose: 1, ram: 2, ladders: 3, charge: 4, reserve: 5 };
