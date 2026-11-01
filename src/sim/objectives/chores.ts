// The household's chores: each dawn the head asks the player for one to three jobs, fitted to the season,
// the player's age and sex, the household plan, the state of the family's strips, the animals and the woodpile.
// A chore is a single located step; it pays a little from the household's purse and the head's good opinion,
// and a chore ignored altogether costs a little of that opinion.
import { hash01 } from '../../core/math';
import { isHolyDay } from '../calendar';
import { CAREERS } from '../careers';
import { skillLevel } from '../people';
import type { Person } from '../state';
import { workChoices, workTitle, type WorkChoice } from './choices';
import type { NewObjective, Obj } from './core';
import { T, cap, type Vars } from './data';
import {
  awayFromHome, buildingPhrase, buildingTarget, churchOf, deadwoodNear, describePerson, homeOf, personTarget, stripPhrase, stripSide,
} from './places';
import { boardFor, enabledOption, headOf, neighbourFor, priestOf } from './roles';
import { bagQty } from './sources';
import { findNear } from './places';

type Plan = 'fields' | 'garden' | 'livestock' | 'craft' | 'brew' | 'spin' | 'market' | 'wood' | 'service' | 'school' | 'play' | 'rest' | 'auto';

/** Which kinds of work each household task points at. */
const PLAN_KINDS: Record<string, readonly WorkChoice['kind'][]> = {
  fields: ['strip', 'barn'], garden: ['garden', 'stock'], livestock: ['stock', 'herd', 'strip'], craft: ['craft'], brew: ['craft'], spin: ['craft'],
  market: ['craft'], wood: [], service: ['craft'], school: [], play: [], rest: [], auto: ['strip', 'garden', 'stock'],
};

interface Pick { spec: NewObjective; order: number }

function dueOf(O: Obj): number {
  // a chore lapses at the next sunrise
  return O.sunrise(O.dayNo + 1);
}

function headVars(O: Obj, me: Person, head: Person | undefined): Vars {
  return { head: head?.first ?? 'the household', player: me.first, headDesc: head ? describePerson(O, head) : 'the household' };
}

function rewardText(O: Obj, head: Person | undefined, pence: number): string {
  const hh = head ? O.state.households.get(head.household) : undefined;
  const can = hh ? Math.min(pence, Math.floor(hh.purse * 0.5 * 100) / 100) : 0;
  const thanks = head ? `${head.first}'s thanks` : 'the household\'s thanks';
  return can >= 0.5 ? `${can < 1 ? '½d' : `${Math.round(can)}d`} and ${thanks}` : thanks;
}

function choreBase(O: Obj, me: Person, head: Person | undefined, key: string, title: string, why: string, pence: number): Omit<NewObjective, 'steps'> {
  const spec: Omit<NewObjective, 'steps'> = { source: 'chore', key, title, why, dueDay: dueOf(O), reward: rewardText(O, head, pence) };
  if (head && head.id !== me.id) { spec.giver = head.id; spec.pay = { pence, opinion: 1 }; spec.fine = 1; }
  return spec;
}

function fromWork(O: Obj, me: Person, head: Person | undefined, c: WorkChoice, day: number): NewObjective {
  const hv = headVars(O, me, head);
  if (c.kind === 'strip' && c.strip) {
    const ph = stripPhrase(O, c.strip.id);
    const st = O.state.strips.get(c.strip.id);
    const vars: Vars = { ...hv, strip: ph.phrase, side: stripSide(st?.field ?? 1) };
    return {
      ...choreBase(O, me, head, `chore:${day}:strip:${c.strip.id}`, T('chores', `strip.title.${c.strip.task}`, vars), T('chores', `strip.why.${c.strip.task}`, vars), 1),
      steps: [{
        text: T('chores', `strip.${c.strip.task}`, vars), hint: T('chores', 'strip.hint', vars), target: c.at, goal: c.bouts, progress: 0,
        m: { k: 'strip', strip: c.strip.id, task: c.strip.task, need: c.bouts },
      }],
    };
  }
  const vars: Vars = { ...hv, place: c.place, label: c.label };
  return {
    ...choreBase(O, me, head, `chore:${day}:${c.kind}:${c.at.id}`, T('chores', `work.title.${c.kind}`, vars), T('chores', `work.why.${c.kind}`, vars), 0.5),
    steps: [{
      text: `${workTitle(c)} (${c.place})`, hint: T('chores', 'work.hint', vars), target: c.at, goal: c.bouts, progress: 0,
      m: { k: 'act', ids: c.ids, at: { kind: c.target.kind, id: 'id' in c.target ? c.target.id : -1 }, need: c.bouts },
    }],
  };
}

function woodChore(O: Obj, me: Person, head: Person | undefined, day: number, low: boolean): NewObjective | null {
  const home = homeOf(O, me);
  if (!home) return null;
  const tg = deadwoodNear(O, home.x, home.z, 180);
  if (!tg) return null;
  const vars: Vars = { ...headVars(O, me, head), n: 2, kind: tg.label.toLowerCase() };
  return {
    ...choreBase(O, me, head, `chore:${day}:wood`, T('chores', 'wood.title', vars), T('chores', low ? 'wood.why' : 'wood.why.plenty', vars), 0.5),
    steps: [{ text: T('chores', 'wood.step', vars), hint: T('chores', 'wood.hint', vars), target: tg, goal: 2, progress: 0, m: { k: 'act', ids: ['wood.gather'], need: 2, re: 'deadwood' } }],
  };
}

function errandChore(O: Obj, me: Person, head: Person | undefined, day: number): NewObjective | null {
  const nb = neighbourFor(O, me);
  if (!nb) return null;
  const vars: Vars = { ...headVars(O, me, head), nb: nb.first, nbDesc: describePerson(O, nb) };
  return {
    ...choreBase(O, me, head, `chore:${day}:errand`, T('chores', 'errand.title', vars), T('chores', 'errand.why', vars), 0),
    reward: `A penny or two, and ${nb.first}'s thanks`,
    steps: [{
      text: T('chores', 'errand.step', vars), hint: T('chores', 'errand.hint', vars), target: personTarget(O, nb, describePerson(O, nb)),
      m: { k: 'act', ids: ['errand.run'], at: { kind: 'person', id: nb.id }, need: 1 },
    }],
  };
}

/** Nothing to do at home: the board where work is asked about. */
function jobsChore(O: Obj, me: Person, head: Person | undefined, day: number): NewObjective | null {
  if (O.deps.economy.employment(me.id) || O.age(me) < 12) return null;
  const board = boardFor(O, me);
  if (!board) return null;
  const vars: Vars = { ...headVars(O, me, head), place: board.phrase };
  return {
    ...choreBase(O, me, head, `chore:${day}:jobs`, T('chores', 'jobs.title', vars), T('chores', 'jobs.why', vars), 0),
    reward: 'A post to take, when you are ready',
    steps: [{
      text: T('chores', 'jobs.step', vars), hint: T('chores', 'jobs.hint', vars), target: board.at,
      m: { k: 'act', ids: ['manage.jobs'], at: { kind: board.target.kind, id: 'id' in board.target ? board.target.id : -1 }, need: 1 },
    }],
  };
}

function massChore(O: Obj, me: Person, head: Person | undefined, day: number): NewObjective | null {
  const church = churchOf(O, me);
  if (!church) return null;
  const target = { kind: 'building', id: church.id } as const;
  const mass = enabledOption(O, me, target, /^social\.mass/);
  const pray = mass ?? enabledOption(O, me, target, /^social\.pray/);
  if (!pray) return null;
  const phrase = buildingPhrase(O, church);
  const vars: Vars = { ...headVars(O, me, head), church: phrase };
  const spec: NewObjective = {
    source: 'chore', key: `chore:${day}:mass`, title: T('chores', 'mass.title', vars), why: T('chores', 'mass.why', vars), reward: 'Piety, and a good name with the parish',
    dueDay: O.dayNo + 0.62,
    steps: [{
      text: T('chores', mass ? 'mass.step' : 'mass.step.pray', vars), hint: T('chores', 'mass.hint', vars), target: buildingTarget(O, church),
      m: { k: 'act', ids: ['social.mass', 'social.pray'], at: { kind: 'building', id: church.id }, need: 1 },
    }],
  };
  if (head && head.id !== me.id) spec.giver = head.id;
  return spec;
}

function buttsChore(O: Obj, me: Person, head: Person | undefined, day: number): NewObjective | null {
  const butts = findNear(O, me, ['archery_butts'], 900);
  if (!butts) return null;
  if (!enabledOption(O, me, { kind: 'building', id: butts.id }, /^arms\.practise/)) return null;
  const vars: Vars = { ...headVars(O, me, head), place: buildingPhrase(O, butts) };
  const spec: NewObjective = {
    source: 'chore', key: `chore:${day}:butts`, title: T('chores', 'butts.title', vars), why: T('chores', 'butts.why', vars), reward: 'Archery, strength and the others\' respect',
    dueDay: O.sunrise(O.dayNo + 1),
    steps: [{
      text: T('chores', 'butts.step', vars), hint: T('chores', 'butts.hint', vars), target: buildingTarget(O, butts), goal: 3, progress: 0,
      m: { k: 'act', ids: ['arms.practise'], at: { kind: 'building', id: butts.id }, need: 3 },
    }],
  };
  if (head && head.id !== me.id) spec.giver = head.id;
  return spec;
}

function schoolChore(O: Obj, me: Person, head: Person | undefined, day: number): NewObjective | null {
  const priest = priestOf(O, me);
  if (!priest) return null;
  const vars: Vars = { ...headVars(O, me, head), priest: priest.first };
  return {
    ...choreBase(O, me, head, `chore:${day}:school`, T('chores', 'school.title', vars), T('chores', 'school.why', vars), 0),
    reward: `Letters, and ${priest.first}'s good opinion`,
    steps: [{ text: T('chores', 'school.step', vars), hint: T('chores', 'school.hint', vars), target: personTarget(O, priest, describePerson(O, priest)), m: { k: 'talk', who: priest.id } }],
  };
}

/** The player's task in the household plan. */
function planOf(O: Obj, me: Person): Plan {
  const line = O.deps.economy.householdPlan(me.household).find((l) => l.person === me.id);
  return (line?.task ?? 'auto') as Plan;
}

/** Is the woodpile low for this household and season? */
function woodLow(O: Obj, me: Person): boolean {
  const hh = O.state.households.get(me.household);
  if (!hh) return false;
  let units = 0;
  for (const id of hh.members) { const m = O.state.persons.get(id); if (m && !m.death) units += O.age(m) >= 14 ? 1 : 0.6; }
  const winter = Math.floor((O.day % 16) / 4) === 3;
  return bagQty(hh.stores, 'firewood') < units * (winter ? 6 : 3);
}

/** How many chores the player's age and the day allow. */
function capFor(O: Obj, me: Person): number {
  return O.age(me) < 14 ? 2 : 3;
}

/** Makes today's chores. Returns how many were made. */
export function makeChores(O: Obj): number {
  const me = O.me;
  if (!me || O.age(me) < 8) return 0;
  const day = O.dayNo;
  if (O.save.choresDay >= day) return 0;
  // the player must be at home (their own village or nearby), not away on the road or the map
  if (awayFromHome(O, me)) return 0;
  O.save.choresDay = day;

  const head = headOf(O, me);
  const hh = O.state.households.get(me.household);
  const isHead = !!hh && hh.head === me.id;
  const giver = isHead ? undefined : head;
  const picks: Pick[] = [];
  // someone with a post has the post's duty to do first
  const cap0 = O.active().some((o) => o.source === 'job') ? 1 : capFor(O, me);
  const add = (spec: NewObjective | null, order: number): void => { if (spec && !picks.some((p) => p.spec.key === spec.key)) picks.push({ spec, order }); };

  if (isHolyDay(O.day)) {
    add(massChore(O, me, giver, day), 0);
    if (me.sex === 'm' && O.age(me) >= 12) add(buttsChore(O, me, giver, day), 1);
  } else {
    const plan = planOf(O, me);
    const wanted = PLAN_KINDS[plan] ?? PLAN_KINDS.auto;
    const works = workChoices(O, me);
    // the plan's own kinds first, the rest in the registry's order
    const ordered = [...works.filter((w) => wanted.includes(w.kind)), ...works.filter((w) => !wanted.includes(w.kind))];
    let strips = 0;
    const kinds = new Set<string>();
    let order = 0;
    // the head's own plan for the day leads: firewood, or lessons with the priest
    if (plan === 'wood') add(woodChore(O, me, giver, day, woodLow(O, me)), order++);
    else if (plan === 'school') add(schoolChore(O, me, giver, day), order++);
    for (const w of ordered) {
      if (picks.length >= cap0) break;
      if (w.kind === 'strip') { if (strips >= 2) continue; strips++; }
      else if (kinds.has(w.kind)) continue;
      kinds.add(w.kind);
      add(fromWork(O, me, giver, w, day), order++);
    }
    // small jobs that fit any day
    const low = woodLow(O, me);
    if (picks.length < cap0 && (plan === 'wood' || low || hash01(me.id, day, 11) < 0.3)) add(woodChore(O, me, giver, day, low), order++);
    if (picks.length < cap0 && (plan === 'school' || (O.age(me) < 13 && hash01(me.id, day, 13) < 0.25))) add(schoolChore(O, me, giver, day), order++);
    if (picks.length < cap0 && picks.length < 2 && hash01(me.id, day, 17) < (O.age(me) < 16 ? 0.5 : 0.25)) add(errandChore(O, me, giver, day), order++);
    // nothing doable at home: an errand for a neighbour, or the board where work is asked about
    if (picks.length === 0) add(errandChore(O, me, giver, day), order++);
    if (picks.length === 0) add(jobsChore(O, me, giver, day), order++);
  }

  const made: NewObjective[] = picks.sort((a, b) => a.order - b.order).slice(0, cap0).map((p) => p.spec);
  let n = 0;
  const titles: string[] = [];
  for (const spec of made) {
    if (O.add(spec)) { n++; titles.push(spec.title.charAt(0).toLowerCase() + spec.title.slice(1)); }
  }
  if (n > 0) {
    const list = titles.length > 1 ? `${titles.slice(0, -1).join(', ')} and ${titles[titles.length - 1]}` : titles[0];
    const vars: Vars = { ...headVars(O, me, giver), list };
    const key = giver ? `say.set.${Math.floor(hash01(me.id, day, 5) * 3)}` : 'say.set.self';
    O.notify(T('chores', key, vars), 'quest', giver?.id);
  }
  return n;
}

/** Lapses chores that ran past their time (untouched ones cost the head's goodwill). */
export function expireOverdue(O: Obj): void {
  for (const o of O.active()) {
    if (o.dueDay === undefined || O.day < o.dueDay) continue;
    if (o.source === 'tutorial' || o.source === 'request') continue;
    O.finish(o, 'expired');
  }
}

/** The head's reaction when a chore is done: a line, a small thank-you. */
export function choreDone(O: Obj, title: string, giver: number | undefined): void {
  const me = O.me;
  if (!me || !giver || giver === me.id) return;
  const head = O.state.persons.get(giver);
  if (!head || head.death) return;
  const vars: Vars = { head: head.first, player: me.first, title };
  O.notify(T('chores', `say.done.${Math.floor(hash01(me.id, O.dayNo, giver) * 4)}`, vars), 'social', head.id);
}

export { CAREERS, cap, skillLevel };
