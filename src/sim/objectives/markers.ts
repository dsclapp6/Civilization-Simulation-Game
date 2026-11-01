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

/** Anything the zone offers to mark people (Builder 1's hook, see the README: absent in headless runs). */
interface MarkingZone {
  setQuestGivers?(ids: readonly PersonId[], tracked?: PersonId): void;
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

  const place = (m: WorldMarker, x: number, z: number, label: string, y?: number): void => {
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
    // people the player has business with get a mark over the head
    const zone = O.deps.zone as (MarkingZone & typeof O.deps.zone) | undefined;
    if (zone?.setQuestGivers) {
      const ids = new Set<PersonId>();
      for (const o of O.active()) {
        if (o.source === 'request' && o.giver) ids.add(o.giver);
        const cur = O.current(o);
        if (cur && cur.m.k === 'talk' && cur.m.who > 0) ids.add(cur.m.who);
        if (cur?.target?.kind === 'person' && (cur.m.k === 'act' || cur.m.k === 'talk')) ids.add(cur.target.id);
      }
      const list = [...ids].sort((a, b) => a - b);
      const key = `${list.join(',')}|${O.save.foundPerson}`;
      if (key !== givers) {
        givers = key;
        zone.setQuestGivers(list, O.save.foundPerson || undefined);
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

  return { source, refresh, invalidate: () => { homeKey = ''; workKey = ''; givers = ''; } };
}

export { personTarget };
