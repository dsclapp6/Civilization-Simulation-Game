// Work objectives: the day's duty of someone who holds a post (an apprentice at the bench, a farmhand, a
// shepherd, an archer) and the week-work a serf owes his lord. Pay comes from the economy bout by bout; the
// objective only says where to be and what to do, and counts the bouts.
import { dist } from '../../core/math';
import { isHolyDay } from '../calendar';
import { BOUT_DAYS } from '../economy/workkit';
import type { Employment } from '../economy/types';
import type { Person } from '../state';
import type { NewObjective, Obj } from './core';
import { T, type Vars } from './data';
import {
  awayFromHome, buildingPhrase, buildingTarget, describePerson, findNear, homeOf, personTarget, stripCentre, stripPhrase, stripTarget,
} from './places';
import { enabledOption } from './roles';

type Step = NewObjective['steps'][number];

const dueNext = (O: Obj): number => O.sunrise(O.dayNo + 1);

function reachStep(text: string, hint: string, at: Step['target'] & object, r: number): Step {
  return { text, hint, target: at, m: { k: 'reach', x: at.x, z: at.z, r } };
}

/** A strip of the lord's demesne the player may work today, nearest to home first. */
function demesneStrip(O: Obj, me: Person): number | null {
  const s = O.settlementById.get(me.settlement);
  if (!s) return null;
  const home = homeOf(O, me);
  const hx = home?.x ?? s.x, hz = home?.z ?? s.z;
  const cand = s.strips.filter((id) => O.state.strips.get(id)?.holder === 0)
    .sort((a, b) => dist(hx, hz, stripCentre(O, a).x, stripCentre(O, a).z) - dist(hx, hz, stripCentre(O, b).x, stripCentre(O, b).z) || a - b);
  for (const id of cand) {
    if (enabledOption(O, me, { kind: 'strip', id }, /^farm\.(plough|harrow|sow|weed|reap|bind|carry)/)) return id;
  }
  return null;
}

function workplace(O: Obj, emp: Employment, me: Person): ReturnType<typeof findNear> {
  if (emp.building !== undefined) return O.state.buildings.get(emp.building);
  const employer = O.state.persons.get(emp.employer);
  const hh = employer ? O.state.households.get(employer.household) : undefined;
  return hh ? O.state.buildings.get(hh.home) : homeOf(O, me);
}

/** Today's duty of the player's post, or null when the post has nothing the player can do today. */
function dutyFor(O: Obj, me: Person, emp: Employment): NewObjective | null {
  const employer = emp.employer ? O.state.persons.get(emp.employer) : undefined;
  const eName = employer ? employer.first : 'the lord\'s reeve';
  const base: Omit<NewObjective, 'steps' | 'title'> = {
    source: 'job', key: `job:${O.dayNo}`, why: '', dueDay: dueNext(O), reward: employer ? `Your wage, and ${employer.first}'s good opinion` : 'Your wage',
    pay: { opinion: 1 },
  };
  if (employer) { base.giver = employer.id; base.fine = 1; base.offer = true; }
  const vars: Vars = { employer: eName, title: emp.title.toLowerCase(), place: '' };
  const why = (): string => T('chores', 'job.why', vars);

  // a craftsman's bench
  if (emp.terms === 'apprenticeship' || emp.career === 'smith' || emp.career === 'carpenter' || emp.career === 'mason' || emp.career === 'weaver' || emp.career === 'baker' || emp.career === 'tailor') {
    const b = workplace(O, emp, me);
    if (b && enabledOption(O, me, { kind: 'building', id: b.id }, /^(appr|craft)\./)) {
      const phrase = buildingPhrase(O, b);
      vars.place = phrase;
      const at = buildingTarget(O, b);
      return {
        ...base, title: T('chores', 'job.title.craft', vars), why: why(),
        steps: [
          reachStep(T('chores', 'job.go.text', vars), T('chores', 'job.go.hint', vars), at, 6),
          { text: T('chores', 'job.do.text', vars), hint: T('chores', 'job.do.hint', vars), target: at, goal: 4, progress: 0, m: { k: 'act', ids: ['appr.*', 'craft.*'], at: { kind: 'building', id: b.id }, need: 4 } },
        ],
      };
    }
  }
  // day labour on the lord's land
  if (emp.career === 'labourer') {
    const id = demesneStrip(O, me);
    if (id !== null) {
      const ph = stripPhrase(O, id);
      vars.place = ph.phrase;
      const centre = stripCentre(O, id);
      return {
        ...base, title: T('chores', 'job.title.land', vars), why: why(),
        steps: [
          { text: T('chores', 'job.go.text', vars), hint: T('chores', 'job.go.hint', vars), target: stripTarget(O, id), m: { k: 'reach', x: centre.x, z: centre.z, r: 4, strip: id } },
          { text: T('chores', 'job.do.text', vars), hint: T('chores', 'strip.hint', vars), target: stripTarget(O, id), goal: 4, progress: 0, m: { k: 'act', ids: ['farm.*'], at: { kind: 'strip', id }, need: 4 } },
        ],
      };
    }
  }
  // the common flock
  if (emp.career === 'shepherd') {
    const pasture = O.world.parcels.find((q) => q.settlement === me.settlement && (q.use === 'pasture' || q.use === 'meadow') && q.poly.length > 0);
    if (pasture && enabledOption(O, me, { kind: 'parcel', id: pasture.id }, /^stock\.herd/)) {
      let x = 0, z = 0;
      for (const v of pasture.poly) { x += v.x; z += v.z; }
      x /= pasture.poly.length; z /= pasture.poly.length;
      const at = { kind: 'parcel' as const, id: pasture.id, x, z, label: 'Common pasture' };
      return {
        ...base, title: T('chores', 'job.title.herd', vars), why: why(),
        steps: [
          reachStep(T('chores', 'job.go.text', { ...vars, place: 'the common pasture' }), T('chores', 'job.go.hint', vars), at, 14),
          { text: T('chores', 'job.do.text', { ...vars, place: 'the common pasture' }), hint: T('chores', 'job.do.hint', vars), target: at, goal: 2, progress: 0, m: { k: 'act', ids: ['stock.herd'], at: { kind: 'parcel', id: pasture.id }, need: 2 } },
        ],
      };
    }
  }
  // soldiers drill at the butts
  if (emp.career === 'archer' || emp.career === 'man_at_arms' || emp.career === 'sergeant' || emp.career === 'soldier') {
    const butts = findNear(O, me, ['archery_butts', 'training_yard'], 1500);
    if (butts && enabledOption(O, me, { kind: 'building', id: butts.id }, /^arms\.practise/)) {
      vars.place = buildingPhrase(O, butts);
      const at = buildingTarget(O, butts);
      return {
        ...base, title: T('chores', 'job.title.arms', vars), why: why(),
        steps: [
          reachStep(T('chores', 'job.go.text', vars), T('chores', 'job.go.hint', vars), at, 12),
          { text: T('chores', 'job.do.text', vars), hint: T('chores', 'job.do.hint', vars), target: at, goal: 3, progress: 0, m: { k: 'act', ids: ['arms.practise'], at: { kind: 'building', id: butts.id }, need: 3 } },
        ],
      };
    }
  }
  // anything else: be seen by the master
  if (employer) {
    return {
      ...base, title: T('chores', 'job.title.report', vars), why: why(),
      steps: [{ text: T('chores', 'job.report.text', vars), hint: T('chores', 'job.report.hint', vars), target: personTarget(O, employer, describePerson(O, employer)), m: { k: 'talk', who: employer.id } }],
    };
  }
  return null;
}

/** Today's duty for someone who holds a post, and the week-work of an unfree adult. */
export function makeJobs(O: Obj): number {
  const me = O.me;
  if (!me || isHolyDay(O.day) || awayFromHome(O, me)) return 0;
  O.save.jobsDay = O.dayNo;
  let n = 0;
  const emp = O.deps.economy.employment(me.id);
  if (emp) {
    const duty = dutyFor(O, me, emp);
    if (duty && O.add(duty)) n++;
  }
  n += makeWeekWork(O, me);
  return n;
}

/** The lord's week-work, while some of it is still owed this week. */
function makeWeekWork(O: Obj, me: Person): number {
  if (me.estate !== 'unfree' || O.age(me) < 14) return 0;
  const ob = O.deps.economy.obligations(me.id).find((x) => x.kind === 'week_work');
  if (!ob || ob.amount <= 0.05) return 0;
  const id = demesneStrip(O, me);
  if (id === null) return 0;
  const need = Math.max(2, Math.min(8, Math.ceil(ob.amount / BOUT_DAYS)));
  const days = ob.amount >= 1.5 ? `${Math.round(ob.amount)} days` : ob.amount > 0.9 ? 'a day' : 'a part of a day';
  const ph = stripPhrase(O, id);
  const vars: Vars = { days, label: ph.phrase };
  const centre = stripCentre(O, id);
  const lord = ob.to ? O.state.persons.get(ob.to) : undefined;
  const spec: NewObjective = {
    source: 'job', key: `week:${Math.floor(O.dayNo / 4)}`, title: T('chores', 'week.title', vars), why: T('chores', 'week.why', vars),
    reward: 'The week\'s dues paid, and no fine', dueDay: ob.due,
    steps: [
      { text: T('chores', 'job.go.text', { place: ph.phrase }), hint: T('chores', 'job.go.hint', {}), target: stripTarget(O, id), m: { k: 'reach', x: centre.x, z: centre.z, r: 4, strip: id } },
      { text: T('chores', 'week.step', vars), hint: T('chores', 'week.hint', vars), target: stripTarget(O, id), goal: need, progress: 0, m: { k: 'act', ids: ['farm.*'], at: { kind: 'strip', id }, need } },
    ],
  };
  if (lord) spec.giver = lord.id;
  return O.add(spec) ? 1 : 0;
}
