// Story objectives: the big moments of a life that call for something of the player. A parent, a spouse or a
// child gravely ill; the wedding feast the day after the wedding; a newborn in the household; the lord's call
// to arms. They are made from events and a look at the state each hour, and they end by themselves.
import { dist } from '../../core/math';
import type { Person } from '../state';
import type { NewObjective, Obj } from './core';
import { T, type Vars } from './data';
import { buildingPhrase, buildingTarget, churchOf, describePerson, personTarget, settlementTarget, homeOf } from './places';
import { enabledOption } from './roles';
import { militaryOf } from './sources';

/** Gravely ill: a fatal sickness that has taken hold (the body has lost a quarter of its strength). */
const sick = (p: Person): boolean => p.health.conditions.some((c) => c.fatal) && p.health.hp < 0.75;

/** Kin the player would sit with: spouse, parents, children, and the head of the household. */
function dearOnes(O: Obj, me: Person): Person[] {
  const ids = new Set<number>([me.spouse, me.father, me.mother, ...me.children]);
  const hh = O.state.households.get(me.household);
  if (hh) ids.add(hh.head);
  const out: Person[] = [];
  for (const id of ids) {
    if (!id || id === me.id) continue;
    const p = O.state.persons.get(id);
    if (p && !p.death) out.push(p);
  }
  return out.sort((a, b) => a.id - b.id);
}

/** Hourly: new troubles, and the end of old ones. */
export function storyHourly(O: Obj): void {
  const me = O.me;
  if (!me) return;
  const day = O.dayNo;

  // someone dear gravely ill
  for (const p of dearOnes(O, me)) {
    if (!sick(p)) continue;
    const key = `story:ill:${p.id}`;
    if (O.byKey(key) || (O.save.seen[key] !== undefined && day - O.save.seen[key] < 6)) continue;
    if (p.settlement !== me.settlement && O.age(p) >= 14 && p.household !== me.household) continue;
    const vars: Vars = { name: p.first };
    const church = churchOf(O, me);
    // a baby cannot be talked to: it is seen at home
    const home = homeOf(O, me);
    const door = home ? buildingTarget(O, home, 'Your home') : undefined;
    const steps: NewObjective['steps'] = O.age(p) < 3 && door
      ? [{ text: T('text', 'story.ill.visit', vars), hint: T('text', 'story.ill.visit.hint', vars), target: door, m: { k: 'reach', x: door.x, z: door.z, r: 12 } }]
      : [{ text: T('text', 'story.ill.visit', vars), hint: T('text', 'story.ill.visit.hint', vars), target: personTarget(O, p, describePerson(O, p)), m: { k: 'talk', who: p.id } }];
    if (church && enabledOption(O, me, { kind: 'building', id: church.id }, /^social\.(pray|mass)/)) {
      steps.push({
        text: T('text', 'story.ill.pray', { ...vars, church: buildingPhrase(O, church) }), hint: T('text', 'story.ill.pray.hint'), target: buildingTarget(O, church),
        m: { k: 'act', ids: ['social.pray', 'social.mass'], at: { kind: 'building', id: church.id }, need: 1 },
      });
    }
    O.add({ source: 'story', key, title: T('text', 'story.ill.title', vars), why: T('text', 'story.ill.why', vars), giver: p.id, reward: T('text', 'story.ill.reward'), steps, data: { who: p.id } });
    O.save.seen[key] = day;
  }
  // ...and those who recovered, or died
  for (const o of O.active()) {
    if (o.source !== 'story' || !o.key.startsWith('story:ill:')) continue;
    const p = O.state.persons.get(Number(o.data?.who));
    if (!p || p.death) O.finish(o, 'expired');
    else if (!sick(p)) O.finish(o, 'done');
  }

  // the lord's call to arms
  const mil = militaryOf(O);
  const call = mil?.service().call ?? null;
  const live = O.byKey('story:levy');
  if (call && call.self && !live && O.save.seen['story:levy'] !== call.day) {
    const lordHouse = O.state.houses.get(call.house);
    const lord = lordHouse ? O.state.persons.get(lordHouse.head) : undefined;
    const seat = O.settlementById.get(call.muster);
    const vars: Vars = { lord: lord ? lord.first : 'The lord', place: seat?.name ?? 'the muster' };
    const steps: NewObjective['steps'] = [
      { text: T('text', 'story.levy.decide'), hint: T('text', 'story.levy.decide.hint'), m: { k: 'flag', name: 'levy-answered' } },
    ];
    if (seat) steps.push({ text: T('text', 'story.levy.report', vars), hint: T('text', 'story.levy.report.hint'), target: settlementTarget(O, seat), m: { k: 'reach', x: seat.x, z: seat.z, r: Math.max(80, seat.radius) } });
    const spec: NewObjective = { source: 'story', key: 'story:levy', title: T('text', 'story.levy.title'), why: T('text', 'story.levy.why', vars), reward: T('text', 'story.levy.reward'), dueDay: call.due, steps };
    if (lord) spec.giver = lord.id;
    O.add(spec);
    O.save.seen['story:levy'] = call.day;
  } else if (live && !call) {
    // answered: joined (carry on to the muster) or refused (the lord remembers)
    const joined = (mil?.armyOf(me.id) ?? 0) > 0;
    if (joined) {
      const cur = O.current(live);
      if (cur && cur.m.k === 'flag') { cur.done = true; O.progressed(live); }
    } else {
      O.finish(live, 'expired');
    }
  }
}

/** The wedding feast: the day after, at ten, at the church. */
export function storyMarried(O: Obj, spouse: number): void {
  const me = O.me;
  if (!me) return;
  const church = churchOf(O, me);
  if (!church) return;
  const at = O.dayNo + 1 + 10 / 24;
  const vars: Vars = { name: O.first(spouse), church: buildingPhrase(O, church) };
  const t = buildingTarget(O, church);
  O.add({
    source: 'story', key: `story:wedding:${spouse}`, title: T('text', 'story.wedding.title'), why: T('text', 'story.wedding.why', vars), giver: spouse,
    reward: T('text', 'story.wedding.reward'), dueDay: at + 0.4,
    steps: [{ text: T('text', 'story.wedding.step', vars), hint: T('text', 'story.wedding.hint'), target: t, m: { k: 'reach', x: t.x, z: t.z, r: 28, from: at - 0.05, to: at + 0.4 } }],
  });
}

/** A newborn in the household. */
export function storyBorn(O: Obj, child: number, mother: number, father: number): void {
  const me = O.me;
  if (!me) return;
  const kin = new Set<number>([me.id, ...(O.state.households.get(me.household)?.members ?? [])]);
  if (!kin.has(mother) && !kin.has(father)) return;
  const c = O.state.persons.get(child);
  if (!c || c.death) return;
  const vars: Vars = { name: c.first };
  const home = homeOf(O, me);
  if (!home) return;
  const door = buildingTarget(O, home, 'Your home');
  const homeStep: NewObjective['steps'] = [{ text: T('text', 'story.child.step', vars), hint: T('text', 'story.child.hint', vars), target: door, m: { k: 'reach', x: door.x, z: door.z, r: 12 } }];
  O.add({
    source: 'story', key: `story:born:${child}`, title: T('text', 'story.child.title'), why: T('text', 'story.child.why', vars), reward: 'A blessing on the House',
    dueDay: O.dayNo + 3,
    steps: homeStep,
  });
}

export { dist, homeOf };
