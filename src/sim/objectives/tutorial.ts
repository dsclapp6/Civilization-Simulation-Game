// The first-day tutorial: a short chain of objectives fitted to the birth (farm child, craftsman's child,
// merchant's child, a page of a gentry or knightly house, a baron's heir). Each stage is made when the one
// before it is done, from what is really at hand (the family's strips, the workshop, a neighbour, a shop), so
// every step is located and the registry has agreed it can be done. A stage that cannot be made is skipped.
import { dayPart } from '../calendar';
import { CAREERS } from '../careers';
import { formatMoney } from '../money';
import type { BirthClass, Person } from '../state';
import { fullName } from '../state';
import type { SkillId } from '../../core/domain';
import { pickWork, type WorkChoice, workTitle } from './choices';
import type { NewObjective, Obj, Reward } from './core';
import { CHAINS, T, cap, type Vars } from './data';
import {
  buildingPhrase, buildingTarget, churchOf, describePerson, doorXZ, personTarget, placeTarget, stripCentre, stripPhrase, stripTarget,
} from './places';
import { boardFor, enabledOption, headOf, meetPerson, neighbourFor, peerFor, priestOf, stewardOf, traderFor } from './roles';
import type { ObjectiveTarget } from './types';

const CHAIN_OF: Record<BirthClass, string> = {
  serf: 'farm', free: 'farm', craftsman: 'craft', merchant: 'merchant', gentry: 'noble', knightly: 'noble', baronial: 'baron',
};

interface Ctx {
  O: Obj;
  me: Person;
  cls: string;
  head: Person | undefined;
  vars: Vars;
  idx: number;
}

type Step = NewObjective['steps'][number];
type Built = NewObjective | null | 'wait';

function baseVars(O: Obj, me: Person, head: Person | undefined): Vars {
  const village = O.settlementById.get(me.settlement)?.name ?? 'the village';
  const v: Vars = { village, home: 'your home', place: village, player: me.first };
  if (head) {
    v.head = head.first;
    v.headFull = fullName(head);
    v.headDesc = describePerson(O, head);
    const rel = O.deps.social.relationLabel(me.id, head.id);
    v.headRel = rel.startsWith('your ') ? rel : `your ${rel}`;
  } else {
    v.head = 'the household head'; v.headFull = v.head; v.headDesc = v.head; v.headRel = 'your head of household';
  }
  return v;
}

/** "2d from Wat, and " or "": only what the household can really pay is promised. */
function payPhrase(O: Obj, head: Person | undefined, pence: number): { pay: Reward; text: string } {
  const hh = head ? O.state.households.get(head.household) : undefined;
  const can = hh ? Math.min(pence, Math.floor(hh.purse * 0.5 * 100) / 100) : 0;
  return { pay: { pence }, text: can >= 0.5 ? `${formatMoney(can)} from ${head?.first ?? 'the household'}, and ` : '' };
}

function make(c: Ctx, id: string, steps: Step[], extra: { title?: string; why?: string; reward?: string; pay?: Reward; vars?: Vars } = {}): NewObjective {
  const vars = { ...c.vars, ...(extra.vars ?? {}) };
  const spec: NewObjective = {
    source: 'tutorial', key: `tut:${id}`, title: extra.title ?? T('tutorial', `${id}.title`, vars, c.cls), why: extra.why ?? T('tutorial', `${id}.why`, vars, c.cls),
    steps, tut: c.idx,
  };
  if (c.head) spec.giver = c.head.id;
  const reward = extra.reward ?? T('tutorial', `${id}.reward`, vars, c.cls);
  if (reward) spec.reward = reward;
  if (extra.pay) spec.pay = extra.pay;
  return spec;
}

const reachAt = (text: string, hint: string, at: ObjectiveTarget, r: number): Step => ({ text, hint, target: at, m: { k: 'reach', x: at.x, z: at.z, r } });

// ---------------------------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------------------------

function stageMeet(c: Ctx): Built {
  const { O, me } = c;
  const who = meetPerson(O, me, c.head);
  if (!who) return null;
  const vars: Vars = { ...c.vars, meet: who.first, meetDesc: describePerson(O, who) };
  const spec = make(c, 'meet', [{
    text: T('tutorial', 'meet.talk.text', vars, c.cls), hint: T('tutorial', 'meet.talk.hint', vars, c.cls),
    target: personTarget(O, who, describePerson(O, who)), m: { k: 'talk', who: who.id },
  }], { pay: { opinion: 2 }, vars });
  spec.giver = who.id;
  return spec;
}

/** Which skill a bit of work trains (for the stage's small reward). */
function skillOfWork(c: WorkChoice, me: Person): SkillId {
  switch (c.kind) {
    case 'strip': case 'garden': case 'barn': return 'farming';
    case 'stock': case 'herd': return 'husbandry';
    case 'dig': return 'mining';
    case 'craft': return CAREERS[me.career]?.skills[0] ?? 'carpentry';
  }
}

function stageWork(c: Ctx): Built {
  const { O, me } = c;
  // household crafts (brewing, baking) are the first thing to learn only in a craftsman's house
  const work = pickWork(O, me, undefined, c.cls === 'craft');
  if (!work) return stageJobs(c);
  const vars: Vars = { ...c.vars, place: work.place, label: work.label };
  const steps: Step[] = [];
  if (work.kind === 'strip' && work.strip) {
    const ph = stripPhrase(O, work.strip.id);
    vars.strip = ph.phrase;
    vars.place = ph.phrase;
    const centre = stripCentre(O, work.strip.id);
    steps.push({
      text: T('tutorial', 'work.go.text', vars, c.cls), hint: T('tutorial', 'work.go.hint.strip', vars, c.cls), target: stripTarget(O, work.strip.id),
      m: { k: 'reach', x: centre.x, z: centre.z, r: 4, strip: work.strip.id },
    });
    steps.push({
      text: T('chores', `strip.${work.strip.task}`, vars), hint: T('tutorial', 'work.do.hint.strip', vars, c.cls), target: work.at, goal: work.bouts, progress: 0,
      m: { k: 'strip', strip: work.strip.id, task: work.strip.task, need: work.bouts },
    });
  } else {
    steps.push(reachAt(T('tutorial', 'work.go.text', vars, c.cls), T('tutorial', 'work.go.hint', vars, c.cls), work.at, 6));
    steps.push({
      text: `${workTitle(work)} (${work.place})`, hint: T('tutorial', 'work.do.hint', vars, c.cls), target: work.at, goal: work.bouts, progress: 0,
      m: { k: 'act', ids: work.ids, at: { kind: work.target.kind, id: 'id' in work.target ? work.target.id : -1 }, need: work.bouts },
    });
  }
  const p = payPhrase(O, c.head, 2);
  vars.pay = p.text;
  const skill = skillOfWork(work, me);
  const titleKey = `work.title.${work.kind}`;
  const whyKey = work.kind === 'strip' ? 'work.why.strip' : `work.why.${work.kind}`;
  return make(c, 'work', steps, {
    title: T('tutorial', titleKey, vars, c.cls), why: T('tutorial', whyKey, vars, c.cls), reward: T('tutorial', 'work.reward', vars, c.cls),
    pay: { ...p.pay, opinion: 2, skill, xp: 10 }, vars,
  });
}

/** When there is no work at home to do: find the board where work is asked about. */
function stageJobs(c: Ctx): Built {
  const { O, me } = c;
  const board = boardFor(O, me);
  if (!board) return null;
  const vars: Vars = { ...c.vars, place: board.phrase };
  return make(c, 'jobs', [
    reachAt(T('tutorial', 'jobs.go.text', vars, c.cls), T('tutorial', 'jobs.go.hint', vars, c.cls), board.at, 6),
    {
      text: T('tutorial', 'jobs.ask.text', vars, c.cls), hint: T('tutorial', 'jobs.ask.hint', vars, c.cls), target: board.at,
      m: { k: 'act', ids: ['manage.jobs'], at: { kind: board.target.kind, id: 'id' in board.target ? board.target.id : -1 }, need: 1 },
    },
  ], { vars });
}

function stageErrand(c: Ctx): Built {
  const { O, me } = c;
  const nb = neighbourFor(O, me);
  if (!nb) return null;
  const vars: Vars = { ...c.vars, nb: nb.first, nbDesc: describePerson(O, nb) };
  return make(c, 'errand', [{
    text: T('tutorial', 'errand.do.text', vars, c.cls), hint: T('tutorial', 'errand.do.hint', vars, c.cls), target: personTarget(O, nb, describePerson(O, nb)),
    m: { k: 'act', ids: ['errand.run'], at: { kind: 'person', id: nb.id }, need: 1 },
  }], { vars, pay: { opinion: 1 } });
}

function stageTrade(c: Ctx): Built {
  const { O, me } = c;
  const t = traderFor(O, me);
  if (!t) return null;
  const vars: Vars = { ...c.vars, shop: t.keeper ? t.keeper.first : t.phrase, shopDesc: t.phrase, keeper: t.keeper?.first ?? 'the trader' };
  const at = t.at;
  return make(c, 'trade', [
    reachAt(T('tutorial', 'trade.go.text', vars, c.cls), T('tutorial', 'trade.go.hint', vars, c.cls), at, t.kind === 'person' ? 4 : 7),
    { text: T('tutorial', 'trade.do.text', vars, c.cls), hint: T('tutorial', 'trade.do.hint', vars, c.cls), target: at, m: { k: 'trade', dir: 'any', need: 1 } },
  ], {
    vars, title: T('tutorial', c.cls === 'merchant' ? 'trade.title.merchant' : 'trade.title', vars, c.cls), pay: { skill: 'trade', xp: 8 },
  });
}

function stageChapel(c: Ctx): Built {
  const { O, me } = c;
  const church = churchOf(O, me);
  if (!church) return null;
  const target = { kind: 'building', id: church.id } as const;
  const mass = enabledOption(O, me, target, /^social\.mass/);
  const pray = mass ?? enabledOption(O, me, target, /^social\.pray/);
  if (!pray) return null;
  const phrase = buildingPhrase(O, church);
  const vars: Vars = { ...c.vars, church: phrase, place: phrase };
  const at = buildingTarget(O, church);
  const doKey = mass ? 'chapel.mass' : 'chapel.pray';
  return make(c, 'chapel', [
    reachAt(T('tutorial', 'chapel.go.text', vars, c.cls), T('tutorial', 'chapel.go.hint', vars, c.cls), at, 9),
    { text: T('tutorial', `${doKey}.text`, vars, c.cls), hint: T('tutorial', `${doKey}.hint`, vars, c.cls), target: at, m: { k: 'act', ids: ['social.mass', 'social.pray'], at: { kind: 'building', id: church.id }, need: 1 } },
  ], { vars, pay: { opinion: 1 } });
}

function stageLessons(c: Ctx): Built {
  const { O, me } = c;
  const priest = priestOf(O, me);
  if (!priest) return null;
  const vars: Vars = { ...c.vars, priest: priest.first, priestDesc: describePerson(O, priest) };
  return make(c, 'lessons', [{
    text: T('tutorial', 'lessons.talk.text', vars, c.cls), hint: T('tutorial', 'lessons.talk.hint', vars, c.cls), target: personTarget(O, priest, describePerson(O, priest)),
    m: { k: 'talk', who: priest.id },
  }], { vars, pay: { opinion: 2, skill: 'letters', xp: 8 } });
}

function stagePractice(c: Ctx): Built {
  const { O, me } = c;
  const peer = peerFor(O, me);
  if (!peer) return null;
  const vars: Vars = { ...c.vars, peer: peer.first, peerDesc: describePerson(O, peer) };
  return make(c, 'practice', [{
    text: T('tutorial', 'practice.do.text', vars, c.cls), hint: T('tutorial', 'practice.do.hint', vars, c.cls), target: personTarget(O, peer, describePerson(O, peer)),
    m: { k: 'act', ids: ['social.wrestle'], at: { kind: 'person', id: peer.id }, need: 1 },
  }], { vars, pay: { skill: 'melee', xp: 8 } });
}

function stageSteward(c: Ctx): Built {
  const { O, me } = c;
  const st = stewardOf(O, me);
  if (!st) return null;
  const vars: Vars = { ...c.vars, steward: st.first, stewardDesc: describePerson(O, st) };
  return make(c, 'steward', [{
    text: T('tutorial', 'steward.talk.text', vars, c.cls), hint: T('tutorial', 'steward.talk.hint', vars, c.cls), target: personTarget(O, st, describePerson(O, st)),
    m: { k: 'talk', who: st.id },
  }], { vars, pay: { opinion: 2, skill: 'stewardship', xp: 8 } });
}

function stageFolk(c: Ctx): Built {
  const { O, me } = c;
  const hh = O.state.households.get(me.household);
  const not = [me.id, ...(hh?.members ?? [])];
  return make(c, 'folk', [{
    text: T('tutorial', 'folk.talk.text', c.vars, c.cls), hint: T('tutorial', 'folk.talk.hint', c.vars, c.cls), goal: 2, progress: 0,
    m: { k: 'talkAny', need: 2, not, seen: [] },
  }], { pay: { skill: 'persuasion', xp: 6 } });
}

function stageNight(c: Ctx): Built {
  const { O, me } = c;
  const part = dayPart(O.day);
  // the evening stage waits for the evening (or a tired body)
  if (part !== 'evening' && part !== 'dusk' && part !== 'night' && me.needs.rest > 0.3) return 'wait';
  const home = O.state.households.get(me.household)?.home;
  const b = home !== undefined ? O.state.buildings.get(home) : undefined;
  const steps: Step[] = [];
  if (b) {
    const d = doorXZ(O, b);
    const at = buildingTarget(O, b, 'your home');
    steps.push(reachAt(T('tutorial', 'night.home.text', c.vars, c.cls), T('tutorial', 'night.home.hint', c.vars, c.cls), { ...at, x: d.x, z: d.z }, 12));
  }
  steps.push({
    text: T('tutorial', 'night.sleep.text', c.vars, c.cls), hint: T('tutorial', 'night.sleep.hint', c.vars, c.cls),
    ...(b ? { target: buildingTarget(O, b, 'your home') } : { target: placeTarget('Your bed', 0, 0) }), m: { k: 'sleep' },
  });
  return make(c, 'night', steps, { pay: { opinion: 1 } });
}

const STAGES: Record<string, (c: Ctx) => Built> = {
  meet: stageMeet, work: stageWork, errand: stageErrand, trade: stageTrade, chapel: stageChapel, lessons: stageLessons, practice: stagePractice,
  steward: stageSteward, folk: stageFolk, night: stageNight,
};

// ---------------------------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------------------------

export function chainOf(O: Obj): string {
  return CHAIN_OF[O.state.run.birthClass] ?? 'farm';
}

/** Begins the tutorial of a fresh run. */
export function startTutorial(O: Obj): void {
  const t = O.save.tut;
  t.cls = chainOf(O);
  t.stage = 0;
  t.done = false;
  t.since = O.dayNo;
  advanceTutorial(O);
}

/** Makes the next stage that can be made, if no tutorial objective is live. Call again when one finishes, and hourly. */
export function advanceTutorial(O: Obj): void {
  const t = O.save.tut;
  const me = O.me;
  if (t.done || !me) return;
  // the lessons last three days, then it is the household's chores and the player's own goals
  if (O.dayNo - t.since > 3) {
    t.done = true;
    for (const o of O.active()) if (o.source === 'tutorial') O.finish(o, 'expired');
    O.touch();
    return;
  }
  const live = O.save.list.find((o) => o.source === 'tutorial' && o.state === 'active');
  if (live) {
    // a stage nobody could get to (the neighbour keeps walking off, the shop is shut) does not hold the others up
    if (O.day - live.born > 1.5 && !live.steps.some((s) => s.done || (s.progress ?? 0) > 0)) O.finish(live, 'expired');
    return;
  }
  const chain = CHAINS[t.cls] ?? CHAINS.farm;
  while (t.stage < chain.length) {
    const id = chain[t.stage];
    const build = STAGES[id];
    const ctx: Ctx = { O, me, cls: t.cls, head: headOf(O, me), vars: {}, idx: t.stage };
    ctx.vars = baseVars(O, me, ctx.head);
    const spec = build ? build(ctx) : null;
    if (spec === 'wait') return;
    t.stage++;
    if (spec) {
      O.add(spec);
      O.touch();
      return;
    }
  }
  t.done = true;
  O.touch();
}

/** Capitalised stage title for tests and tools. */
export const stageTitle = (id: string, cls: string): string => cap(T('tutorial', `${id}.title`, {}, cls));
