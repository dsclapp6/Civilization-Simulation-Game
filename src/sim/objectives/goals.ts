// Goals: the long things worth working for. Each is made when the player is eligible and has not had it before:
// choosing a path at fourteen, the archers' test, an apprenticeship, a better tool, a sweetheart. Their steps
// are state-based (a stat, a skill, a purse, a courtship), so progress is simply what the player has become.
import { dist } from '../../core/math';
import type { CropKind } from '../../core/domain';
import { CAREERS } from '../careers';
import { CAREER_ECON, TOOL_SPEED } from '../economy/data';
import { formatMoney } from '../money';
import type { Person } from '../state';
import type { NewObjective, Obj } from './core';
import { STAT_TITLE } from './core';
import { T, type Vars } from './data';
import { buildingPhrase, buildingTarget, buildingsOfKind, describePerson, findNear, homeOf, nearbySettlements, nearestOf, personTarget, placeTarget } from './places';
import { bagQty } from './sources';

type Step = NewObjective['steps'][number];

/** Goals not to be made again for this long after one ends (days); permanent when missing. */
const COOLDOWN: Record<string, number> = { 'goal:court': 12, 'goal:tool': 16 };
const MAX_GOALS = 3;

function allowed(O: Obj, key: string): boolean {
  const seen = O.save.seen[key];
  if (seen === undefined) return true;
  const cd = COOLDOWN[key];
  return cd !== undefined && O.dayNo - seen >= cd;
}

// ---------------------------------------------------------------------------------------------
// The generators
// ---------------------------------------------------------------------------------------------

function pathGoal(O: Obj, me: Person): NewObjective | null {
  if (O.age(me) < 12 || O.deps.economy.employment(me.id)) return null;
  const age = O.age(me);
  const steps: Step[] = [];
  if (age < 14) {
    const years = Math.max(0.1, 14 - age);
    const left = years >= 1.5 ? `${Math.round(years)} years` : years > 0.9 ? 'a year' : 'a few months';
    steps.push({ text: T('goals', 'path.wait', { years: left }), hint: T('goals', 'path.wait.hint'), m: { k: 'age', years: 14 }, goal: 14, progress: Math.floor(age * 10) / 10 });
  }
  steps.push({ text: T('goals', 'path.think'), hint: T('goals', 'path.think.hint'), m: { k: 'act', ids: ['manage.career'], at: { kind: 'self', id: -1 }, need: 1 } });
  return { source: 'goal', key: 'goal:path', title: T('goals', 'path.title'), why: T('goals', 'path.why'), reward: T('goals', 'path.reward'), steps };
}

/** The settlement and the captain who takes archers on, nearest to the player's home. */
function recruiterNear(O: Obj, me: Person): { person: Person; sid: number } | null {
  const home = homeOf(O, me);
  const hx = home?.x ?? 0, hz = home?.z ?? 0;
  const list = O.world.settlements.filter((s) => s.kind === 'castle' || s.kind === 'town' || s.kind === 'city' || s.kind === 'abbey').sort((a, b) => dist(hx, hz, a.x, a.z) - dist(hx, hz, b.x, b.z) || a.id - b.id);
  for (const s of list.slice(0, 4)) {
    if (dist(hx, hz, s.x, s.z) > 9000) break;
    const job = O.deps.economy.jobs(s.id, me.id).find((j) => /^archer/i.test(j.title));
    const person = job ? O.state.persons.get(job.employer) : undefined;
    if (person && !person.death) return { person, sid: s.id };
  }
  return null;
}

function archerGoal(O: Obj, me: Person): NewObjective | null {
  const age = O.age(me);
  if (me.sex !== 'm' || age < 12 || age > 35 || CAREERS[me.career].field === 'arms' || O.deps.economy.employment(me.id)) return null;
  const test = O.deps.economy.entryTests().find((t) => t.career === 'archer');
  if (!test) return null;
  const recruiter = recruiterNear(O, me);
  if (!recruiter) return null;
  const butts = findNear(O, me, ['archery_butts'], 1500);
  const steps: Step[] = [];
  for (const [stat, value] of Object.entries(test.stats)) {
    steps.push({ text: T('goals', 'archer.stat', { stat: STAT_TITLE[stat as keyof typeof STAT_TITLE], value: value as number }), hint: T('goals', 'archer.stat.hint'), m: { k: 'stat', stat: stat as 'str', value: value as number }, goal: value as number, progress: 0 });
  }
  for (const [skill, value] of Object.entries(test.skills)) {
    const st: Step = { text: T('goals', 'archer.skill', { skill: `${skill.charAt(0).toUpperCase()}${skill.slice(1)}`, value: value as number }), hint: T('goals', 'archer.skill.hint'), m: { k: 'skill', skill: skill as 'archery', level: value as number }, goal: value as number, progress: 0 };
    if (butts) st.target = buildingTarget(O, butts);
    steps.push(st);
  }
  if (test.kit.includes('bow')) {
    const carp = nearestOf(buildingsOfKind(O, me.settlement, ['carpenter']), homeOf(O, me)?.x ?? 0, homeOf(O, me)?.z ?? 0);
    const st: Step = { text: T('goals', 'archer.kit'), hint: T('goals', 'archer.kit.hint'), m: { k: 'have', good: 'shortbow|longbow', qty: 1 } };
    if (carp) st.target = buildingTarget(O, carp);
    steps.push(st);
  }
  const rec = recruiter.person;
  steps.push({
    text: T('goals', 'archer.oath', { recruiter: describePerson(O, rec) }), hint: T('goals', 'archer.oath.hint'), target: personTarget(O, rec, describePerson(O, rec)),
    m: { k: 'career', to: 'archer' },
  });
  return { source: 'goal', key: 'goal:archer', title: T('goals', 'archer.title'), why: T('goals', 'archer.why'), reward: T('goals', 'archer.reward'), steps };
}

function apprenticeGoal(O: Obj, me: Person): NewObjective | null {
  const age = O.age(me);
  if (age < 13 || age > 18 || O.deps.economy.employment(me.id)) return null;
  const jobs = O.deps.economy.jobs(me.settlement, me.id).filter((j) => j.terms === 'apprenticeship' && j.employer > 0);
  if (jobs.length === 0) return null;
  // the best offer: every requirement but the premium met, the cheapest first
  const rest = (j: (typeof jobs)[number]): number => j.requirements.filter((r) => !r.met && !/premium|leave|pay nothing/i.test(r.label)).length;
  const pick = jobs.slice().sort((a, b) => rest(a) - rest(b) || (a.premium ?? 0) - (b.premium ?? 0) || a.id - b.id)[0];
  if (rest(pick) > 0) return null;
  const master = O.state.persons.get(pick.employer);
  if (!master || master.death) return null;
  const trade = pick.title.replace(/^Apprentice\s+/i, '').toLowerCase();
  const vars: Vars = { master: describePerson(O, master), trade: `${pick.title.toLowerCase()}`, price: formatMoney(pick.premium ?? 0) };
  const steps: Step[] = [];
  if ((pick.premium ?? 0) > 0) steps.push({ text: T('goals', 'apprentice.save', vars), hint: T('goals', 'apprentice.save.hint'), m: { k: 'money', pence: pick.premium ?? 0, family: true }, goal: pick.premium ?? 0, progress: 0 });
  steps.push({ text: T('goals', 'apprentice.talk', vars), hint: T('goals', 'apprentice.talk.hint'), target: personTarget(O, master, describePerson(O, master)), m: { k: 'talk', who: master.id } });
  steps.push({ text: T('goals', 'apprentice.sign', vars), hint: T('goals', 'apprentice.sign.hint'), m: { k: 'career', post: true } });
  void trade;
  return { source: 'goal', key: 'goal:apprentice', title: T('goals', 'apprentice.title', vars), why: T('goals', 'apprentice.why', vars), reward: T('goals', 'apprentice.reward'), steps };
}

/** The tool a career wears out first, and the good it is. */
function mainTool(me: Person): string | null {
  const field = CAREERS[me.career].field;
  if (field === 'land') return 'sickle';
  if (field === 'craft') {
    switch (CAREER_ECON[me.career]?.skill) {
      case 'smithing': return 'hammer';
      case 'carpentry': return 'saw';
      case 'masonry': return 'chisel';
      case 'tailoring': return 'needle';
      default: return null;
    }
  }
  return null;
}

function bestQuality(me: Person, hhStores: Record<string, number>, good: string): number {
  let best = -1;
  for (const bag of [me.inventory, hhStores]) {
    for (const k of Object.keys(bag)) {
      if (bag[k] <= 0 || k.charCodeAt(0) === 126) continue;
      if (k === good) best = Math.max(best, 1);
      else if (k.startsWith(`${good}#`)) best = Math.max(best, Number(k.slice(good.length + 1)) || 0);
    }
  }
  return best;
}

function toolGoal(O: Obj, me: Person): NewObjective | null {
  if (O.age(me) < 12) return null;
  const good = mainTool(me);
  if (!good) return null;
  const hh = O.state.households.get(me.household);
  const q = bestQuality(me, hh?.stores ?? {}, good);
  if (q < 0 || q >= 2) return null;
  const eco = O.deps.economy;
  const key = `${good}#2`;
  const g = eco.good(good);
  if (!g) return null;
  const market = nearbySettlements(O, me.settlement, 3).find((s) => s.market);
  const price = Math.ceil(eco.price((market ?? O.settlementById.get(me.settlement))!.id, key, 'buy'));
  if (!(price > 0)) return null;
  const faster = Math.round((TOOL_SPEED[2] / TOOL_SPEED[Math.max(0, q)] - 1) * 100);
  const tool = `a good ${g.unitOne ?? good}`;
  const shop = nearestOf(buildingsOfKind(O, me.settlement, ['smithy']), homeOf(O, me)?.x ?? 0, homeOf(O, me)?.z ?? 0)
    ?? (market ? nearestOf(buildingsOfKind(O, market.id, ['market_hall', 'market_stall', 'market_cross', 'smithy']), market.x, market.z) : undefined);
  const vars: Vars = { tool, Tool: `${tool.charAt(0).toUpperCase()}${tool.slice(1)}`, price: formatMoney(price), pct: `${faster}%`, shop: shop ? buildingPhrase(O, shop) : 'the smithy or the market' };
  const buy: Step = { text: T('goals', 'tool.buy', vars), hint: T('goals', 'tool.buy.hint'), m: { k: 'trade', dir: 'buy', need: 1, item: key } };
  if (shop) buy.target = buildingTarget(O, shop);
  return {
    source: 'goal', key: 'goal:tool', title: T('goals', 'tool.title', vars), why: T('goals', 'tool.why', vars), reward: T('goals', 'tool.reward', vars),
    steps: [{ text: T('goals', 'tool.save', vars), hint: T('goals', 'tool.save.hint'), m: { k: 'money', pence: price }, goal: price, progress: 0 }, buy],
  };
}

function courtGoal(O: Obj, me: Person): NewObjective | null {
  if (O.age(me) < 16 || me.spouse) return null;
  const cands = O.deps.social.matchCandidates(me.id, 3);
  const pick = cands.map((id) => O.state.persons.get(id)).find((p): p is Person => !!p && !p.death);
  if (!pick) return null;
  const vars: Vars = { name: describePerson(O, pick) };
  const short: Vars = { name: pick.first };
  return {
    source: 'goal', key: 'goal:court', title: T('goals', 'court.title'), why: T('goals', 'court.why'), reward: T('goals', 'court.reward'),
    steps: [
      { text: T('goals', 'court.talk', vars), hint: T('goals', 'court.talk.hint', short), target: personTarget(O, pick, describePerson(O, pick)), m: { k: 'talk', who: pick.id } },
      { text: T('goals', 'court.progress', short), hint: T('goals', 'court.progress.hint'), target: personTarget(O, pick, describePerson(O, pick)), m: { k: 'court', with: pick.id, progress: 0.5 }, goal: 0.5, progress: 0 },
      { text: T('goals', 'court.marry', short), hint: T('goals', 'court.marry.hint'), target: personTarget(O, pick, describePerson(O, pick)), m: { k: 'flag', name: 'married' } },
    ],
  };
}

const GENERATORS: Array<{ key: string; make: (O: Obj, me: Person) => NewObjective | null }> = [
  { key: 'goal:path', make: pathGoal },
  { key: 'goal:archer', make: archerGoal },
  { key: 'goal:apprentice', make: apprenticeGoal },
  { key: 'goal:tool', make: toolGoal },
  { key: 'goal:court', make: courtGoal },
];

/** Makes the goals the player is eligible for, up to a few at a time. */
export function refreshGoals(O: Obj): number {
  const me = O.me;
  if (!me) return 0;
  O.save.goalsDay = O.dayNo;
  let live = O.active().filter((o) => o.source === 'goal').length;
  let n = 0;
  for (const g of GENERATORS) {
    if (live >= MAX_GOALS) break;
    if (O.byKey(g.key) || !allowed(O, g.key)) continue;
    const spec = g.make(O, me);
    if (spec && O.add(spec)) { live++; n++; }
  }
  return n;
}

/** Goals that no longer make sense lapse quietly (a recruit past the age, a trade already taken). */
export function retireGoals(O: Obj): void {
  const me = O.me;
  if (!me) return;
  for (const o of O.active()) {
    if (o.source !== 'goal') continue;
    const age = O.age(me);
    if (o.key === 'goal:court' && me.spouse) O.finish(o, 'done');
    else if (o.key === 'goal:archer' && (age > 35 || CAREERS[me.career].field === 'arms')) O.finish(o, CAREERS[me.career].field === 'arms' ? 'done' : 'expired');
    else if (o.key === 'goal:apprentice' && (age > 18 || O.deps.economy.employment(me.id)?.terms === 'apprenticeship')) O.finish(o, O.deps.economy.employment(me.id) ? 'done' : 'expired');
    else if (o.key === 'goal:tool') {
      const g = mainTool(me);
      if (!g || bestQuality(me, O.state.households.get(me.household)?.stores ?? {}, g) >= 2) O.finish(o, 'done');
    }
  }
}

export { bagQty, placeTarget };
export type { CropKind };
