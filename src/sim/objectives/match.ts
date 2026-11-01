// Deciding when a step is done. Event-based kinds count what the player does (an action completes, a
// conversation begins, a trade is struck, sleep begins); state-based kinds look at the world (where the player
// stands, what they carry, a skill level, a request's state). Only the current step of each live objective is
// ever looked at, so a round is a handful of cheap checks.
import type { TargetRef } from '../actions';
import { dist } from '../../core/math';
import { skillLevel } from '../people';
import type { Person, PersonId } from '../state';
import type { Match, Obj, ObjRec, StepRec } from './core';
import { deadwoodNear, homeOf, onStrip, playerXZ } from './places';
import { bagQty, requestById, round1 } from './sources';

/** What just happened (null = a periodic look at the state). */
export type Ev =
  | { t: 'action'; id: string; target: TargetRef; ok: boolean }
  | { t: 'talk'; who: PersonId }
  | { t: 'trade'; buy: boolean; item: string }
  | { t: 'sleep' }
  | { t: 'career'; to: string }
  | { t: 'flag'; name: string }
  /** A periodic look; the heavier checks (strips, requests, courtships) wait for a slow one. */
  | { t: 'poll'; slow: boolean };

/** Does an action id match one of the patterns (exact, or a prefix ending in `*`)? */
export function idMatches(id: string, patterns: readonly string[]): boolean {
  for (const p of patterns) {
    if (p === id) return true;
    if (p.endsWith('*') && id.startsWith(p.slice(0, -1))) return true;
  }
  return false;
}

function setProgress(step: StepRec, value: number, goal?: number): void {
  if (goal !== undefined) step.goal = goal;
  step.progress = value;
}

/** Looks at one step; returns true when its text, progress or state changed. */
export function evalStep(O: Obj, o: ObjRec, step: StepRec, ev: Ev | null): boolean {
  const m: Match = step.m;
  const me = O.me;
  if (!me) return false;
  const before = step.progress;
  const wasDone = step.done;
  const fast = ev?.t === 'poll' && !ev.slow;
  const count = (need: number): void => {
    step.progress = (step.progress ?? 0) + 1;
    if (need > 1) step.goal = need;
    if (step.progress >= need) { step.done = true; step.progress = need > 1 ? need : step.progress; }
  };
  switch (m.k) {
    case 'talk':
      if (ev?.t === 'talk' && (m.who === 0 || ev.who === m.who)) step.done = true;
      break;
    case 'talkAny':
      if (ev?.t === 'talk' && !m.not.includes(ev.who) && !m.seen.includes(ev.who)) {
        m.seen.push(ev.who);
        setProgress(step, m.seen.length, m.need);
        if (m.seen.length >= m.need) step.done = true;
      }
      break;
    case 'act':
      if (ev?.t === 'action' && ev.ok && idMatches(ev.id, m.ids) && (!m.at || (ev.target.kind === m.at.kind && (m.at.id < 0 || ('id' in ev.target && ev.target.id === m.at.id))))) count(m.need);
      break;
    case 'strip':
      if (!fast) checkStrip(O, me, step, m);
      break;
    case 'reach': {
      const pos = playerXZ(O);
      const inWindow = (m.from === undefined || O.day >= m.from) && (m.to === undefined || O.day <= m.to);
      if (pos && inWindow && (m.strip !== undefined ? onStrip(O, m.strip, pos.x, pos.z, m.r) : dist(pos.x, pos.z, m.x, m.z) <= m.r)) step.done = true;
      break;
    }
    case 'trade':
      if (ev?.t === 'trade' && (m.dir === 'any' || (m.dir === 'buy') === ev.buy) && (!m.item || ev.item.startsWith(m.item))) count(m.need);
      break;
    case 'have': {
      const goods = m.good.split('|');
      const stores = m.hh ? O.state.households.get(me.household)?.stores ?? {} : {};
      let n = 0;
      for (const g of goods) n += bagQty(me.inventory, g) + (m.hh ? bagQty(stores, g) : 0);
      const shown = Math.min(Math.floor(n * 10) / 10, m.qty);
      setProgress(step, shown, m.qty);
      if (n + 1e-9 >= m.qty) step.done = true;
      break;
    }
    case 'sleep':
      if (ev?.t === 'sleep') step.done = true;
      break;
    case 'skill': {
      const lvl = skillLevel(me.skills[m.skill]);
      setProgress(step, Math.min(lvl, m.level), m.level);
      if (lvl >= m.level) step.done = true;
      break;
    }
    case 'stat': {
      const v = me.trained[m.stat];
      setProgress(step, Math.min(round1(v), m.value), m.value);
      if (v + 1e-9 >= m.value) step.done = true;
      break;
    }
    case 'money': {
      const hh = O.state.households.get(me.household);
      const have = me.money + (hh && hh.head === me.id ? hh.purse : 0);
      setProgress(step, Math.min(Math.floor(have), m.pence), m.pence);
      if (have + 1e-9 >= m.pence) step.done = true;
      break;
    }
    case 'career': {
      if (ev?.t === 'career' && (m.to === undefined || m.to === ev.to)) step.done = true;
      else if (m.post && O.deps.economy.employment(me.id)) step.done = true;
      break;
    }
    case 'req': {
      if (fast) break;
      const r = requestById(O, m.id);
      if (r && (m.at === 'accepted' ? r.state !== 'offered' && r.state !== 'declined' && r.state !== 'expired' : r.state === 'done')) step.done = true;
      break;
    }
    case 'reqwork': {
      if (fast) break;
      const r = requestById(O, m.id);
      const goal = m.field === 'watched' ? (r?.data.hours ?? 5) : (r?.data.count ?? 3);
      const v = r ? Number(r.data[m.field] ?? 0) : 0;
      setProgress(step, Math.min(v, goal), goal);
      if (r && (r.state === 'done' || v >= goal)) step.done = true;
      break;
    }
    case 'wait':
      if (O.day >= m.until) step.done = true;
      break;
    case 'age': {
      const a = O.age(me);
      setProgress(step, Math.min(round1(a), m.years), m.years);
      if (a >= m.years) step.done = true;
      break;
    }
    case 'court': {
      if (fast) break;
      const c = O.deps.social.courtship(me.id, m.with);
      const v = c ? Math.round(c.progress * 100) / 100 : 0;
      setProgress(step, Math.min(v, m.progress), m.progress);
      if (v + 1e-9 >= m.progress) step.done = true;
      break;
    }
    case 'flag':
      if (ev?.t === 'flag' && ev.name === m.name) step.done = true;
      break;
  }
  void o;
  return step.done !== wasDone || step.progress !== before;
}

/** A strip's task is done when the strip waits for something else (or nothing); until then its progress is the share of the task done. */
function checkStrip(O: Obj, me: Person, step: StepRec, m: Extract<Match, { k: 'strip' }>): void {
  const hh = O.deps.economy.holding(me.household);
  const s = hh?.strips.find((x) => x.id === m.strip);
  if (!s) return;
  const word = /^(Plough|Harrow|Sow|Weed|Reap|Bind|Carry)/.exec(s.nextTask)?.[1].toLowerCase() ?? '';
  if (word !== m.task) {
    step.done = true;
    setProgress(step, m.need, m.need);
    return;
  }
  setProgress(step, Math.min(m.need - 1, Math.floor(s.work * m.need + 1e-6)), m.need);
}

/** A gathering step points at the nearest dead wood still standing, which changes as loads are taken. */
function retarget(O: Obj, o: ObjRec): void {
  const cur = O.current(o);
  if (!cur || cur.m.k !== 'act' || cur.m.re !== 'deadwood') return;
  const me = O.me;
  if (!me) return;
  const pos = playerXZ(O) ?? homeOf(O, me);
  if (!pos) return;
  const t = deadwoodNear(O, pos.x, pos.z, 200);
  if (t) cur.target = t;
}

/**
 * Looks at the current step of every live objective; steps that complete let the next one be looked at in the
 * same round (a step already satisfied by the state is skipped at once). Finished objectives are closed.
 */
export function round(O: Obj, ev: Ev | null): void {
  let any = false;
  for (const o of O.save.list.slice()) {
    if (o.state !== 'active') continue;
    let moved = false;
    let seen = ev;
    // a strip task the household has already finished ends the walk to the strip as well
    if (!(ev?.t === 'poll' && !ev.slow)) {
      const at = o.steps.findIndex((s) => s.m.k === 'strip' && !s.done);
      if (at > 0 && o.steps.slice(0, at).some((s) => !s.done) && evalStep(O, o, o.steps[at], null) && o.steps[at].done) {
        for (let i = 0; i < at; i++) o.steps[i].done = true;
        moved = true;
      }
    }
    for (let guard = 0; guard < 16; guard++) {
      const cur = O.current(o);
      if (!cur) break;
      const changed = evalStep(O, o, cur, seen);
      seen = null;
      if (changed) moved = true;
      if (!cur.done) break;
    }
    if (!moved) continue;
    any = true;
    retarget(O, o);
    if (!O.current(o)) O.finish(o, 'done');
    else O.progressed(o);
  }
  if (any) O.changed();
}
