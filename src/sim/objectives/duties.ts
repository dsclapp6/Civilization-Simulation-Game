// Duties of one's place (in place of quests): someone with no master to set their day still has the work of their
// station. A knight rides the bounds, trains the men at the yard and sees to his arms at the forge; a soldier stands
// his watch at the gate; a priest keeps the church and visits the sick; a healer goes to whoever is ailing; a master
// craftsman works at his own bench. One duty a working day, drawn from the station's round (as the people of the
// world do theirs: agents/schedule.ts ROTA). A lord has no duties: he manages (the realm's matters, not tasks).
import { hash01 } from '../../core/math';
import { isHolyDay } from '../calendar';
import type { BuildingKind } from '../../content/types';
import type { Person } from '../state';
import type { NewObjective, Obj } from './core';
import { awayFromHome, buildingPhrase, buildingTarget, findNear, homeOf, personTarget, adultsNear } from './places';
import type { ObjectiveTarget } from './types';
import { enabledOption } from './roles';

type Step = NewObjective['steps'][number];

const ARMS = new Set(['knight', 'squire', 'man_at_arms', 'soldier', 'sergeant', 'archer']);
const CRAFT: Partial<Record<string, readonly BuildingKind[]>> = {
  smith: ['smithy'], carpenter: ['carpenter', 'sawpit'], weaver: ['weaver'], baker: ['bakehouse'], tanner: ['tannery'],
  alewife: ['brewhouse', 'alehouse'], miller: ['watermill', 'windmill'], cooper: ['carpenter'], wheelwright: ['carpenter'],
};

/** The ruler's orders of a kind now in force for the player ('plan': fields named and the works share set; 'command': research,
 *  standing trade orders and men raised). A step is done when the count rises above what it was when the stage was made. */
export function realmCount(O: Obj, what: 'plan' | 'command'): number {
  const R = O.sim.services.realm;
  const me = O.me;
  if (!R || !me) return 0;
  const v = R.view(me.id);
  if (!v) return 0;
  if (what === 'plan') {
    let n = 0;
    for (const sid of v.settlements) {
      if (R.worksShare(sid) > 0) n++;
      const plan = R.cropPlan(sid);
      for (const f of [0, 1, 2] as const) if (plan[f] !== 'fallow') n++;
    }
    return n;
  }
  const busy = R.projects(v.house).filter((p) => p.state !== 'abandoned').length;
  return busy + R.tradeOrders(me.id).length + (R.troops?.(me.id).length ?? 0);
}

/** A lord, regent, steward or reeve: someone who manages rather than takes tasks. */
export function managesRealm(O: Obj, me: Person): boolean {
  return O.state.titlesHeldBy(me.id).size > 0;
}

const reach = (text: string, hint: string, at: ObjectiveTarget, r: number): Step => ({ text, hint, target: at, m: { k: 'reach', x: at.x, z: at.z, r } });
const place = (x: number, z: number, label: string): ObjectiveTarget => ({ kind: 'place', id: -1, x, z, label });

/** Today's duty of the player's station (null when it has none today, or someone else sets the day). */
export function roleDuty(O: Obj, me: Person, round = 0): NewObjective | null {
  if (managesRealm(O, me) || isHolyDay(O.day) || awayFromHome(O, me) || O.age(me) < 14) return null;
  const s = O.settlementById.get(me.settlement);
  if (!s) return null;
  const c = me.career;
  const roll = hash01(me.id, O.dayNo * 7 + 41 + round * 13);
  const base = { source: 'job' as const, key: `duty:${O.dayNo}:${round}`, why: '', dueDay: O.sunrise(O.dayNo + 1), reward: 'Your standing, and the skill of your station' };
  const seat = findNear(O, me, ['keep_stone', 'great_hall', 'manor_house'], 2500);

  if (ARMS.has(c)) {
    // the yard drills the arm-at-hand: a knight trains the men at the pell (sword and spear), never at the butts; an archer shoots
    // at the butts; the rest take the pell, or the butts where there is no yard (J3: docs/WORK.md)
    const pellYard = findNear(O, me, ['training_yard'], 1500);
    const buttsYard = findNear(O, me, ['archery_butts'], 1500);
    const useButts = c === 'archer' ? !!buttsYard : !pellYard && !!buttsYard && c !== 'knight' && c !== 'squire';
    const yard = useButts ? buttsYard : pellYard;
    const smithy = findNear(O, me, ['smithy'], 1500);
    // the round: the yard, the bounds, the forge (a knight), the gate (the men)
    const pick = roll < 0.4 && yard ? 'yard' : roll < 0.75 ? 'bounds' : c === 'knight' || c === 'squire' ? (smithy ? 'forge' : 'bounds') : 'gate';
    if (pick === 'yard' && yard && enabledOption(O, me, { kind: 'building', id: yard.id }, useButts ? /^arms\.practise/ : /^pell/)) {
      const at = buildingTarget(O, yard);
      const ph = buildingPhrase(O, yard);
      return {
        ...base, title: c === 'knight' ? 'Your duty: train the men at the yard' : 'Your duty: drill at the yard', why: 'Men who drill stand in the line; men who do not, run.',
        steps: [
          reach(`Go to ${ph}`, 'Walk there (or click it)', at, 12),
          useButts
            ? { text: 'Practise at the butts', hint: 'Press E there and play the bout (J)', target: at, goal: 3, progress: 0, m: { k: 'act', ids: ['arms.practise'], at: { kind: 'building', id: yard.id }, need: 3 } }
            : { text: c === 'knight' ? 'Set the example: drill with sword and spear at the pell' : 'Drill at the pell', hint: 'Press E at the yard and choose "Drill at the pell"', target: at, goal: 3, progress: 0, m: { k: 'act', ids: ['pell', 'pell.keep'], at: { kind: 'building', id: yard.id }, need: 3 } },
        ],
      };
    }
    if (pick === 'forge' && smithy) {
      const at = buildingTarget(O, smithy);
      return {
        ...base, title: 'Your duty: see to your arms at the forge', why: 'A notched blade and a burst rivet are a dead man\'s kit.',
        steps: [reach(`Take your harness to ${buildingPhrase(O, smithy)}`, 'Walk there (or click it); the smith will see to it with you', at, 6)],
      };
    }
    if (pick === 'gate') {
      const gate = findNear(O, me, ['gatehouse'], 1500) ?? seat;
      if (gate) {
        const at = buildingTarget(O, gate);
        return { ...base, title: 'Your duty: stand the watch', why: 'Raiders come when the gate is idle.', steps: [reach(`Stand the watch at ${buildingPhrase(O, gate)}`, 'Walk there and keep watch a while', at, 8)] };
      }
    }
    // ride the bounds: three marks about the place
    const r = Math.max(60, s.radius * 0.9);
    const a0 = hash01(me.id, O.dayNo + 9 + round * 5) * Math.PI * 2;
    const marks = [0, 1, 2].map((i) => {
      const a = a0 + (i * Math.PI * 2) / 3;
      return place(s.x + Math.cos(a) * r, s.z + Math.sin(a) * r, `the bounds of ${s.name}`);
    });
    return {
      ...base, title: 'Your duty: ride the bounds', why: 'The lord\'s peace is kept by being seen; raiders look for an unwatched road.',
      steps: marks.map((m, i) => reach(`Ride the bounds: the ${['first', 'second', 'third'][i]} mark`, 'Follow the marker round the edge of the place (F mounts a horse)', m, 14)),
    };
  }

  if (c === 'priest' || c === 'monk' || c === 'nun') {
    const church = findNear(O, me, ['church', 'chapel', 'abbey_church', 'cathedral'], 1500);
    const sick = adultsNear(O, me.settlement, s.x, s.z, 0, 40, new Set([me.id])).find((p) => p.health.conditions.length > 0);
    if (sick && roll < 0.5) {
      return { ...base, title: `Your duty: visit ${sick.first} in sickness`, why: 'The sick are the priest\'s flock as much as the hale.', steps: [{ text: `Visit ${sick.first} and pray with them`, hint: 'Find them and speak with them', target: personTarget(O, sick), m: { k: 'talk', who: sick.id } }] };
    }
    if (church) return { ...base, title: 'Your duty: keep the church', why: 'The hours are said whether the village comes or not.', steps: [reach(`Say the office at ${buildingPhrase(O, church)}`, 'Walk there', buildingTarget(O, church), 6)] };
    return null;
  }

  if (c === 'healer' || c === 'midwife') {
    const sick = adultsNear(O, me.settlement, s.x, s.z, 0, 60, new Set([me.id])).find((p) => p.health.conditions.length > 0);
    if (sick) return { ...base, title: `Your duty: tend ${sick.first}`, why: 'Someone is ailing, and you have the herbs.', steps: [{ text: `Go to ${sick.first} and see to them`, hint: 'Find them and speak with them; bind a wound with the steady hand (hold J)', target: personTarget(O, sick), m: { k: 'talk', who: sick.id } }] };
    const home = homeOf(O, me);
    if (home) return { ...base, title: 'Your duty: prepare remedies', why: 'The next fever will not wait for the herbs to be gathered.', steps: [reach('Prepare remedies at home', 'Walk home', buildingTarget(O, home), 5)] };
    return null;
  }

  const kinds = CRAFT[c];
  if (kinds) {
    const b = findNear(O, me, kinds, 1200);
    if (b && enabledOption(O, me, { kind: 'building', id: b.id }, /^(craft|appr)\./)) {
      const at = buildingTarget(O, b);
      return {
        ...base, title: `Your duty: work at ${buildingPhrase(O, b)}`, why: 'Orders wait, and a master is judged by his work.',
        steps: [
          reach(`Go to ${buildingPhrase(O, b)}`, 'Walk there (or click it)', at, 6),
          { text: 'Work a few bouts', hint: 'Press E there and play the bout (J on the gold)', target: at, goal: 3, progress: 0, m: { k: 'act', ids: ['craft.*', 'appr.*'], at: { kind: 'building', id: b.id }, need: 3 } },
        ],
      };
    }
  }
  return null;
}

/**
 * A later round of duty through the day (a thirty-minute day is long and a duty is a few minutes' work): when the morning's is done,
 * nothing of the job or tutorial kind is open and no master sets the day, the station asks again. Never on the holy day.
 */
export function moreDuty(O: Obj, round: number): number {
  const me = O.me;
  if (!me || round < 1 || O.save.jobsDay !== O.dayNo || O.deps.economy.employment(me.id)) return 0;
  if (O.active().some((o) => o.source === 'job' || o.source === 'tutorial')) return 0;
  const d = roleDuty(O, me, round);
  return d && O.add(d) ? 1 : 0;
}
