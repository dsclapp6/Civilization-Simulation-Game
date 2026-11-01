// The day's log and its summary: what the player did (work by bout and by finished task), what they earned
// and spent, the goods they made, the skill and stat gains, the objectives they finished, the state of the
// household and what tomorrow holds. The log is kept as the day goes; closing it (the player lies down to
// sleep, or midnight passes) builds the summary and announces `dayEnd`.
import { SKILLS, STATS } from '../../core/domain';
import { SEASON_NAMES, toDate } from '../../core/time';
import { isHolyDay, isMarketDay } from '../calendar';
import { GRAIN_PER_UNIT_DAY, STAPLE_GRAINS } from '../economy/diet';
import { formatMoney } from '../money';
import { skillLevel } from '../people';
import type { ActionEvent } from '../actions';
import type { Person } from '../state';
import { newLog, type DayLog, type Obj, type WorkTally } from './core';
import { T, cap, hasText, type Vars } from './data';
import { buildingPhrase, marketTownOf, stripPhrase } from './places';
import { bagQty, happeningsOf, round1 } from './sources';
import type { DaySummary } from './types';

const NOT_GOODS = new Set<string>([...SKILLS, ...STATS, 'money', 'days', 'rank']);
const KEEP_SUMMARIES = 8;

// ---------------------------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------------------------

/** Starts a fresh log for `day`, taking the snapshots the summary compares against. */
export function startLog(O: Obj, day = O.dayNo): void {
  const log = newLog(day);
  const me = O.me;
  if (me) {
    log.money0 = me.money;
    for (const s of SKILLS) if (me.skills[s] > 0) log.skills0[s] = Math.round(me.skills[s] * 100) / 100;
    for (const s of STATS) log.stats0[s] = Math.round(me.trained[s] * 100) / 100;
  }
  O.save.log = log;
  O.touch();
}

function verbOf(id: string, part: boolean): string {
  const bits = id.split('.');
  const tries = [id, `${bits[0]}.${bits[1] ?? ''}`, bits[0]];
  for (const t of tries) {
    if (part && hasText('text', `verb.${t}.part`)) return T('text', `verb.${t}.part`);
    if (hasText('text', `verb.${t}`)) return T('text', `verb.${t}`);
  }
  return T('text', 'verb.default');
}

function targetPhrase(O: Obj, kind: string, id: number): string {
  switch (kind) {
    case 'strip': return stripPhrase(O, id).phrase;
    case 'building': { const b = O.state.buildings.get(id); return b ? buildingPhrase(O, b) : 'the village'; }
    case 'person': return O.first(id);
    case 'parcel': return 'the common pasture';
    case 'scatter': return 'the wood';
    default: return 'the village';
  }
}

/** Actions that are one kind of work for the summary: `farm.sow.barley` is `farm.sow`, every recipe is `craft`. */
function workClass(id: string): string {
  if (id.startsWith('farm.')) return id.split('.').slice(0, 2).join('.');
  if (id.startsWith('craft.')) return 'craft';
  if (id.startsWith('garden.')) return 'garden';
  if (id.startsWith('appr.')) return 'appr';
  if (id.startsWith('stock.slaughter')) return 'stock.slaughter';
  return id;
}

/** Notes a finished action of the player's. */
export function logAction(O: Obj, e: Extract<ActionEvent, { type: 'completed' }>): void {
  if (!e.outcome.ok) return;
  const log = O.save.log;
  const o = e.option;
  const t = o.target;
  const tid = 'id' in t ? t.id : -1;
  const partial = /:\s*\d+%\.?$/.test(e.outcome.message ?? '') && o.id.startsWith('farm.');
  // the same kind of work at the same place is one line; a task finished is counted apart from its bouts
  const kind = workClass(o.id);
  const key = `${kind}|${t.kind}:${tid}`;
  let w: WorkTally | undefined = log.work[key];
  if (!w) {
    if (Object.keys(log.work).length >= 24) return;
    w = { verb: kind, at: targetPhrase(O, t.kind, tid), n: 0, fin: 0 };
    log.work[key] = w;
  }
  w.n++;
  if (!partial && o.id.startsWith('farm.') && tid >= 0 && t.kind === 'strip') w.fin++;
  for (const g of e.outcome.gains ?? []) {
    if (!g.amount || g.amount <= 0) continue;
    if (g.ref === 'money') log.inc += g.amount;
    else if (!g.ref || !NOT_GOODS.has(g.ref)) log.goods[g.label] = Math.round(((log.goods[g.label] ?? 0) + g.amount) * 100) / 100;
  }
  O.touch();
}

/** Notes a trade line the player took part in. */
export function logTrade(O: Obj, buyer: number, seller: number, pence: number): void {
  const log = O.save.log;
  if (buyer === O.playerId) log.out += pence;
  else if (seller === O.playerId) log.inc += pence;
  log.trades++;
}

export function logTalk(O: Obj): void { O.save.log.talks++; }

// ---------------------------------------------------------------------------------------------
// The summary
// ---------------------------------------------------------------------------------------------

function workLines(log: DayLog): string[] {
  const rows = Object.values(log.work).sort((a, b) => b.n - a.n);
  const lines: string[] = [];
  for (const w of rows.slice(0, 7)) {
    const finished = w.fin > 0;
    const verb = verbOf(w.verb, !finished && w.verb.startsWith('farm.'));
    const bouts = w.n === 1 ? T('text', 'bouts.one', { n: 1 }) : T('text', 'bouts.many', { n: w.n });
    lines.push(finished ? `${verb} ${w.at}` : `${verb} ${w.at} (${bouts})`);
  }
  return lines;
}

function householdLines(O: Obj, me: Person): string[] {
  const out: string[] = [];
  const hh = O.state.households.get(me.household);
  if (me.needs.hunger < 0.3) out.push(T('text', 'sum.household.hungry'));
  if (hh) {
    let units = 0;
    for (const id of hh.members) { const m = O.state.persons.get(id); if (m && !m.death) units += O.age(m) >= 14 ? 1 : O.age(m) >= 8 ? 0.7 : 0.4; }
    let grain = 0;
    for (const g of STAPLE_GRAINS) grain += bagQty(hh.stores, g);
    grain += bagQty(hh.stores, 'flour') / 6.5 + bagQty(hh.stores, 'bread') / 8;
    const days = units > 0 ? Math.floor(grain / (units * GRAIN_PER_UNIT_DAY)) : 99;
    if (days < 1) out.push(T('text', 'sum.household.grain.none'));
    else if (days < 5) out.push(T('text', 'sum.household.grain.low', { days }));
    else if (days < 40) out.push(T('text', 'sum.household.grain', { days }));
    const winter = Math.floor((O.day % 16) / 4) === 3;
    if (bagQty(hh.stores, 'firewood') < units * (winter ? 4 : 2)) out.push(T('text', 'sum.household.wood'));
    for (const id of hh.members) {
      const m = O.state.persons.get(id);
      if (m && !m.death && m.health.conditions.some((c) => c.fatal)) out.push(T('text', 'sum.household.ill', { name: m.first }));
    }
    // debts and dues that are near
    const now = O.day;
    let shown = 0;
    for (const ob of O.deps.economy.obligations(me.id)) {
      if (shown >= 2) break;
      if (ob.kind === 'heriot' || ob.kind === 'merchet' || ob.kind === 'tithe' || ob.kind === 'wage') continue;
      if (ob.unit === 'days' && ob.amount <= 0.05) continue;
      if (ob.overdue) { out.push(T('text', 'sum.household.overdue', { what: ob.label })); shown++; }
      else if (ob.due >= 0 && ob.due - now <= 2) {
        const d = Math.max(0, Math.ceil(ob.due - now));
        out.push(T('text', 'sum.household.due', { what: ob.label, when: d <= 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days` }));
        shown++;
      }
    }
  }
  if (out.length === 0) out.push(T('text', 'sum.household.fed'));
  return out;
}

function tomorrowLines(O: Obj, me: Person): string[] {
  const out: string[] = [];
  const tomorrow = O.dayNo + 1;
  if (isHolyDay(tomorrow)) out.push(T('text', 'sum.tomorrow.holy'));
  const town = marketTownOf(O, me.settlement);
  if (town && isMarketDay(tomorrow, town.id)) out.push(T('text', 'sum.tomorrow.market', { town: town.name }));
  const today = toDate(O.dayNo), next = toDate(tomorrow);
  if (next.season !== today.season) out.push(T('text', 'sum.tomorrow.season', { season: SEASON_NAMES[next.season] }));
  for (const o of O.active().slice(0, 12)) {
    if (o.source === 'request') {
      out.push(T('text', 'sum.tomorrow.request', { from: o.giver ? O.first(o.giver) : 'Someone', title: o.title.charAt(0).toLowerCase() + o.title.slice(1) }));
    } else if (o.source !== 'chore' && o.source !== 'tutorial' && o.dueDay !== undefined && o.dueDay - O.day <= 2) {
      out.push(T('text', 'sum.tomorrow.open', { title: o.title.charAt(0).toLowerCase() + o.title.slice(1) }));
    }
    if (out.length >= 5) break;
  }
  const open = O.active().filter((o) => o.source === 'chore');
  if (open.length > 0) out.push(T('text', 'sum.tomorrow.open', { title: open[0].title.charAt(0).toLowerCase() + open[0].title.slice(1) }));
  out.push(T('text', 'sum.tomorrow.chores'));
  return out.slice(0, 6);
}

/** Builds the summary of the log's day from the log and the player's state now. */
export function buildSummary(O: Obj): DaySummary | null {
  const me = O.me;
  const log = O.save.log;
  if (!me) return null;
  // money: the events seen, the rest reconciled against the purse
  const net = Math.round((me.money - log.money0) * 100) / 100;
  const seen = log.inc - log.out;
  const resid = net - seen;
  let earned = log.inc, spent = log.out;
  if (resid > 0.005) earned += resid; else if (resid < -0.005) spent += -resid;
  const skills: DaySummary['skills'] = [];
  for (const s of SKILLS) {
    const was = log.skills0[s] ?? 0;
    const gain = me.skills[s] - was;
    if (gain < 0.5) continue;
    const entry: DaySummary['skills'][number] = { skill: s, xp: Math.round(gain) };
    const lvl = skillLevel(me.skills[s]);
    if (lvl > skillLevel(was)) entry.level = lvl;
    skills.push(entry);
  }
  skills.sort((a, b) => b.xp - a.xp);
  const stats: DaySummary['stats'] = [];
  for (const s of STATS) {
    const from = log.stats0[s] ?? me.trained[s];
    if (Math.abs(me.trained[s] - from) >= 0.05) stats.push({ stat: s, from: round1(from), to: round1(me.trained[s]) });
  }
  const goods = Object.entries(log.goods).map(([label, amount]) => ({ label, amount: Math.round(amount * 10) / 10 })).sort((a, b) => b.amount - a.amount).slice(0, 6);
  return {
    day: log.day, work: workLines(log), earned: Math.round(earned * 100) / 100, spent: Math.round(spent * 100) / 100, goods, skills, stats,
    objectivesDone: log.done.slice(0, 8), household: householdLines(O, me), tomorrow: tomorrowLines(O, me),
  };
}

/** Is there anything worth a card? */
function worthShowing(s: DaySummary, log: DayLog): boolean {
  return s.work.length > 0 || s.earned > 0 || s.spent > 0 || s.skills.length > 0 || s.objectivesDone.length > 0 || log.trades > 0 || log.talks > 2;
}

/**
 * Closes the log: stores the summary and announces `dayEnd` when the day held something worth showing.
 * `rollover` starts the next day's log at once (midnight); going to sleep keeps counting until midnight.
 */
export function closeDay(O: Obj, rollover: boolean): void {
  const s = O.save;
  const log = s.log;
  if (s.closed < log.day) {
    const sum = buildSummary(O);
    if (sum && worthShowing(sum, log)) {
      const i = s.sums.findIndex((x) => x.day === sum.day);
      if (i >= 0) s.sums[i] = sum; else s.sums.push(sum);
      if (s.sums.length > KEEP_SUMMARIES) s.sums.splice(0, s.sums.length - KEEP_SUMMARIES);
      s.closed = log.day;
      O.touch();
      O.sim.events.emit('dayEnd', { day: log.day });
    } else {
      s.closed = log.day;
    }
  }
  if (rollover) startLog(O, O.dayNo);
}

export function summaryOf(O: Obj, day?: number): DaySummary | null {
  const sums = O.save.sums;
  if (sums.length === 0) return null;
  if (day === undefined) return sums[sums.length - 1];
  return sums.find((x) => x.day === day) ?? null;
}

export { cap, formatMoney, happeningsOf };
export type { Vars };
