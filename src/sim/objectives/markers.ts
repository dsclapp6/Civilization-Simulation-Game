// What the world shows of the objectives: the beacon on the tracked step's target (primary), small markers for
// home, work and a person or place the player asked to find, and the marks over the heads of the people who
// have something for the player. The marker list is reused between frames; positions of people are live.
import type { WorldMarker } from '../../core/view';
import type { PersonId } from '../state';
import type { Obj } from './core';
import { buildingTarget, homeOf, personTarget, whereIs } from './places';
import type { ObjectiveTarget } from './types';

const COLORS = { objective: 0xffd24a, home: 0x6fbf73, work: 0x6fa8dc, person: 0xe08cff, place: 0xf2f2f2 } as const;
const ID = { objective: 9001, home: 9002, work: 9003, person: 9004, place: 9005 } as const;

/** What the zone offers to mark people (Builder 1's hooks, see the README: both absent in headless runs). */
interface MarkingZone {
  /** The people who have something for the player: their nameplate carries the quest mark. */
  setQuestGivers?(ids: readonly PersonId[]): void;
  /** Both kinds of mark: 'quest' ("!": has a task to give the player) and 'turnin' (wings: a task can be finished
   *  with them). Preferred over setQuestGivers when the zone has it. */
  setQuestMarks?(marks: ReadonlyArray<{ person: PersonId; kind: 'quest' | 'turnin' }>): void;
  /** The person the player asked to find (journal "Find"): their nameplate carries the track mark. 0 clears. */
  setTrackedPerson?(id: PersonId): void;
}

export interface MarkerHost {
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

/** Who carries a mark, and which: 'quest' ("!") for people with a task to give, 'turnin' (wings) for people a task
 *  is finished with. Sorted by person; "!" wins when someone is both. */
export function questMarks(O: Obj): Array<{ person: PersonId; kind: 'quest' | 'turnin' }> {
  const kinds = new Map<PersonId, 'quest' | 'turnin'>();
  const put = (id: PersonId, kind: 'quest' | 'turnin'): void => {
    if (id <= 0 || id === O.playerId) return;
    if (kinds.get(id) !== 'quest') kinds.set(id, kind);
  };
  for (const o of O.offered()) if (o.giver) put(o.giver, 'quest');
  for (const o of O.active()) {
    const cur = O.current(o);
    if (!cur) continue;
    // a request taken up but not yet heard out: the asker still has the task to give
    if (cur.m.k === 'req' && cur.m.at === 'accepted' && o.giver) { put(o.giver, 'quest'); continue; }
    if (cur.m.k === 'talk' && cur.m.who > 0) put(cur.m.who, 'turnin');
    else if (cur.target?.kind === 'person' && (cur.m.k === 'act' || cur.m.k === 'talk' || cur.m.k === 'req')) put(cur.target.id, 'turnin');
  }
  return [...kinds.entries()].sort((a, b) => a[0] - b[0]).map(([person, kind]) => ({ person, kind }));
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

  const refresh = (): void => {
    // people the player has business with get a mark over the head: "!" for whoever has a task to give (an offer
    // waiting, or a request still to be heard), wings for whoever a task can be finished with (talked to, handed to)
    const zone = O.deps.zone as (MarkingZone & typeof O.deps.zone) | undefined;
    if (zone?.setQuestMarks || zone?.setQuestGivers) {
      const marks = questMarks(O);
      const key = marks.map((m) => `${m.person}:${m.kind}`).join(',');
      if (key !== givers) {
        givers = key;
        if (zone.setQuestMarks) zone.setQuestMarks(marks);
        else zone.setQuestGivers!(marks.map((m) => m.person));
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

  return { source, refresh, invalidate: () => { homeKey = ''; workKey = ''; givers = ''; sentTracked = -1; } };
}

export { personTarget };
