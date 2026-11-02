// What the world shows of the objectives: the beacon on the tracked step's target (primary), small markers for
// home, work and a person or place the player asked to find, and the marks over the heads of the people who
// have something for the player. The marker list is reused between frames; positions of people are live.
import type { WorldMarker } from '../../core/view';
import type { PersonId } from '../state';
import type { Obj, ObjRec, StepRec } from './core';
import { buildingTarget, homeOf, personTarget, whereIs } from './places';
import { bagQty, requestById } from './sources';
import type { ObjectiveTarget, QuestMark } from './types';

const COLORS = { objective: 0xffd24a, home: 0x6fbf73, work: 0x6fa8dc, person: 0xe08cff, place: 0xf2f2f2 } as const;
const ID = { objective: 9001, home: 9002, work: 9003, person: 9004, place: 9005 } as const;

/** What the zone offers to mark people (both optional and guarded: absent in headless runs, `setQuestMarks` absent in older zones). */
interface MarkingZone {
  /** The quest marks over heads (docs/CIV.md §1): "!" for people who have something for the player, "?" for the person a finished task is handed to. */
  setQuestMarks?(marks: ReadonlyArray<{ person: PersonId; kind: 'quest' | 'turnin' }>): void;
  /** The old form: the people who have something for the player. */
  setQuestGivers?(ids: readonly PersonId[]): void;
  /** The person the player asked to find (journal "Find"): their nameplate carries the track mark. 0 clears. */
  setTrackedPerson?(id: PersonId): void;
}

export interface MarkerHost {
  /** The people with a mark over their head, and why (the compass, the minimap and the hover card read it). */
  marks(): readonly QuestMark[];
  /** The markers for the renderer and the UI (reused objects). */
  source(): readonly WorldMarker[];
  /** Brings positions that move (people) and the quest-giver marks up to date. Cheap; called about once a second. */
  refresh(): void;
  /** Re-reads the targets after objectives or the world changed. */
  invalidate(): void;
}

function blank(id: number, kind: WorldMarker['kind'], color: number): WorldMarker {
  return { id, kind, x: 0, z: 0, label: '', color };
}

/** The current step of the tracked objective with a target. */
export function trackedTarget(O: Obj): { target: ObjectiveTarget; objective: number } | null {
  const tr = O.save.list.find((o) => o.id === O.save.tracked && o.state === 'active');
  if (!tr) return null;
  const step = O.current(tr);
  return step?.target ? { target: step.target, objective: tr.id } : null;
}

/** Is what a hand-in step needs gathered? (A fetch request: the goods are in the pack; a message or a report: nothing more.) */
function handInReady(O: Obj, cur: StepRec): boolean {
  if (cur.m.k !== 'req') return true;
  const r = requestById(O, cur.m.id);
  if (!r || r.state !== 'accepted') return false;
  if (r.type === 'fetch') {
    const me = O.me;
    return !!me && bagQty(me.inventory, r.data.good ?? '') + 1e-9 >= (r.data.qty ?? 1);
  }
  return true;
}

/** What a request's asker wants, in a line: "Maire wants 7 bundles of firewood". */
function requestLine(O: Obj, o: ObjRec): string {
  const who = o.giver ? O.first(o.giver) : 'Someone';
  const r = o.data?.req !== undefined ? requestById(O, Number(o.data.req)) : undefined;
  if (!r || r.state === 'offered') return `${who} has something to ask of you`;
  switch (r.type) {
    case 'fetch': return `${who} wants ${O.deps.economy.describe(r.data.good ?? '', r.data.qty ?? 1)}`;
    case 'work': return `${who} wants ${r.data.count ?? 3} jobs of work done`;
    default: return o.title;
  }
}

/**
 * The marks the objectives put over people: "!" over anyone who has something for the player (the asker of a request, the person a
 * step says to speak to, the head of the household with today's chores) and "?" over the person to report to when the current step
 * is a hand-in whose needs are met (the goods of a request gathered, the message in hand). The hand-in wins when both apply.
 */
export function questMarks(O: Obj, out: QuestMark[]): QuestMark[] {
  out.length = 0;
  const me = O.playerId;
  const quest = new Map<PersonId, QuestMark>();
  const turnin = new Map<PersonId, QuestMark>();
  const put = (map: Map<PersonId, QuestMark>, person: PersonId, kind: 'quest' | 'turnin', text: string, objective: number): void => {
    if (person > 0 && person !== me && !map.has(person)) map.set(person, { person, kind, text, objective });
  };
  for (const o of O.active()) {
    const cur = O.current(o);
    if (o.source === 'request' && o.giver) put(quest, o.giver, 'quest', requestLine(O, o), o.id);
    if (cur) {
      if (cur.turnin && handInReady(O, cur)) {
        const who = cur.target?.kind === 'person' ? cur.target.id : o.giver ?? 0;
        put(turnin, who, 'turnin', cur.text, o.id);
      } else {
        if (cur.m.k === 'talk' && cur.m.who > 0) put(quest, cur.m.who, 'quest', cur.text, o.id);
        if (cur.target?.kind === 'person' && (cur.m.k === 'act' || cur.m.k === 'talk')) put(quest, cur.target.id, 'quest', cur.text, o.id);
      }
    }
    // the head of the household, while there is work of theirs to do today
    if (o.source === 'chore' && o.giver) put(quest, o.giver, 'quest', `${O.first(o.giver)} has work for you: ${o.title.charAt(0).toLowerCase()}${o.title.slice(1)}`, o.id);
  }
  for (const id of turnin.keys()) quest.delete(id);
  for (const m of [...turnin.values()].sort((x, y) => x.person - y.person)) out.push(m);
  for (const m of [...quest.values()].sort((x, y) => x.person - y.person)) out.push(m);
  return out;
}

export function installMarkers(O: Obj): MarkerHost {
  const mObj = blank(ID.objective, 'objective', COLORS.objective);
  mObj.primary = true;
  const mHome = blank(ID.home, 'home', COLORS.home);
  const mWork = blank(ID.work, 'work', COLORS.work);
  const mPerson = blank(ID.person, 'person', COLORS.person);
  const mPlace = blank(ID.place, 'place', COLORS.place);
  const out: WorldMarker[] = [];
  let homeKey = '';
  let homeAt: { x: number; z: number; label: string } | null = null;
  let workAt: { x: number; z: number; label: string } | null = null;
  let workKey = '';
  let givers = '';
  let sentTracked = 0;

  const place =(m: WorldMarker, x: number, z: number, label: string, y?: number): void => {
    m.x = x; m.z = z; m.label = label;
    if (y !== undefined) m.y = y; else delete m.y;
  };

  const resolveHome = (): void => {
    const me = O.me;
    const b = me ? homeOf(O, me) : undefined;
    const key = b ? `${b.id}:${O.state.buildingRevision}` : '';
    if (key === homeKey) return;
    homeKey = key;
    homeAt = b ? { x: buildingTarget(O, b).x, z: buildingTarget(O, b).z, label: 'Home' } : null;
  };
  const resolveWork = (): void => {
    const me = O.me;
    const emp = me ? O.deps.economy.employment(me.id) : null;
    const b = emp?.building !== undefined ? O.state.buildings.get(emp.building) : undefined;
    const key = b ? `${b.id}:${O.state.buildingRevision}` : '';
    if (key === workKey) return;
    workKey = key;
    workAt = b ? { x: buildingTarget(O, b).x, z: buildingTarget(O, b).z, label: 'Work' } : null;
  };

  const source = (): readonly WorldMarker[] => {
    out.length = 0;
    const tt = trackedTarget(O);
    if (tt) {
      const t = tt.target;
      if (t.kind === 'person') { const w = whereIs(O, t.id); place(mObj, w.x, w.z, t.label, 2.4); }
      else place(mObj, t.x, t.z, t.label);
      out.push(mObj);
    }
    resolveHome();
    if (homeAt && !(tt && Math.hypot(tt.target.x - homeAt.x, tt.target.z - homeAt.z) < 4)) { place(mHome, homeAt.x, homeAt.z, homeAt.label); out.push(mHome); }
    resolveWork();
    if (workAt && !(tt && Math.hypot(tt.target.x - workAt.x, tt.target.z - workAt.z) < 4)) { place(mWork, workAt.x, workAt.z, workAt.label); out.push(mWork); }
    const fp = O.save.foundPerson;
    if (fp) {
      const p = O.state.persons.get(fp);
      if (p && !p.death) { const w = whereIs(O, fp); place(mPerson, w.x, w.z, p.first, 2.4); out.push(mPerson); }
    }
    const fl = O.save.foundPlace;
    if (fl) { place(mPlace, fl.x, fl.z, fl.label); out.push(mPlace); }
    return out;
  };

  const list: QuestMark[] = [];
  let computed = false;
  const refresh = (): void => {
    // people the player has business with get a mark over the head
    const zone = O.deps.zone as (MarkingZone & typeof O.deps.zone) | undefined;
    questMarks(O, list);
    computed = true;
    if (zone?.setQuestMarks || zone?.setQuestGivers) {
      const key = list.map((m) => `${m.person}${m.kind === 'turnin' ? '?' : '!'}`).join(',');
      if (key !== givers) {
        givers = key;
        if (zone.setQuestMarks) zone.setQuestMarks(list.map((m) => ({ person: m.person, kind: m.kind })));
        else zone.setQuestGivers?.(list.map((m) => m.person).sort((x, y) => x - y));
      }
    }
    // the person asked for with "Find" (the zone gives them the track mark)
    if (zone?.setTrackedPerson) {
      const fp = O.save.foundPerson;
      if (fp !== sentTracked) {
        sentTracked = fp;
        zone.setTrackedPerson(fp);
      }
    }
    // a person target walks about: keep the saved copy of its position near the truth
    if (O.deps.zone) {
      const tr = O.save.list.find((o) => o.id === O.save.tracked && o.state === 'active');
      const step = tr ? O.current(tr) : undefined;
      if (step?.target?.kind === 'person') {
        const w = whereIs(O, step.target.id);
        step.target.x = Math.round(w.x * 10) / 10;
        step.target.z = Math.round(w.z * 10) / 10;
      }
    }
  };

  const marks = (): readonly QuestMark[] => {
    if (!computed) { questMarks(O, list); computed = true; }
    return list;
  };

  return { marks, source, refresh, invalidate: () => { homeKey = ''; workKey = ''; givers = ''; sentTracked = -1; computed = false; } };
}

export { personTarget };
