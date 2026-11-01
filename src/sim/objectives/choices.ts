// What work the player can really do right now, near home. The action registry is asked about the family's
// strips, the household's buildings and the common pasture, so an objective only ever points at something that
// is enabled (a strip that waits for the plough season, a bench with no materials, or a holy day offer nothing).
import type { ActionOption, TargetRef } from '../actions';
import { TASK_BOUTS } from '../economy/farm';
import type { Person } from '../state';
import { dist } from '../../core/math';
import type { Obj } from './core';
import { buildingPhrase, buildingTarget, capFirst, placeTarget, stripPhrase, stripTarget } from './places';
import { holdingOf, taskWord } from './sources';
import type { ObjectiveTarget } from './types';

export type WorkKind = 'strip' | 'garden' | 'stock' | 'barn' | 'craft' | 'dig' | 'herd';

export interface WorkChoice {
  kind: WorkKind;
  /** Where the action is listed (the registry's target). */
  target: TargetRef;
  /** The marker/beacon target. */
  at: ObjectiveTarget;
  /** The action id as listed, and the patterns that count its bouts. */
  optionId: string;
  ids: string[];
  label: string;
  /** For strips: the strip and its task. */
  strip?: { id: number; task: string };
  /** The place as a phrase ("your family's east strip", "the cowshed"). */
  place: string;
  /** Lower is better. */
  rank: number;
  /** Bouts a task of this kind takes (strips) or a sensible number to ask for. */
  bouts: number;
}

const STRIP_ORDER = ['reap', 'bind', 'carry', 'plough', 'harrow', 'sow', 'weed'];
const FARM_TASK = /^farm\.(plough|harrow|sow|weed|reap|bind|carry)/;

function firstEnabled(list: readonly ActionOption[], re: RegExp, skip?: RegExp): ActionOption | undefined {
  return list.find((o) => o.enabled && re.test(o.id) && !(skip && skip.test(o.id)));
}

/** The pasture or meadow of the player's place (for herding). */
function pastureOf(O: Obj, p: Person): { id: number; x: number; z: number } | null {
  for (const q of O.world.parcels) {
    if (q.settlement !== p.settlement || (q.use !== 'pasture' && q.use !== 'meadow') || q.poly.length === 0) continue;
    let x = 0, z = 0;
    for (const v of q.poly) { x += v.x; z += v.z; }
    return { id: q.id, x: x / q.poly.length, z: z / q.poly.length };
  }
  return null;
}

/** Every doable bit of work around the household, best first. */
export function workChoices(O: Obj, me: Person): WorkChoice[] {
  const out: WorkChoice[] = [];
  const reg = O.sim.actions;
  const holding = holdingOf(O, me);

  // the family's strips
  if (holding) {
    for (const s of holding.strips) {
      const task = taskWord(s.nextTask);
      if (!task) continue;
      const target: TargetRef = { kind: 'strip', id: s.id };
      const opt = firstEnabled(reg.list(me.id, target), FARM_TASK);
      if (!opt) continue;
      const ph = stripPhrase(O, s.id);
      out.push({
        kind: 'strip', target, at: stripTarget(O, s.id), optionId: opt.id, ids: [`farm.${task}*`], label: opt.label,
        strip: { id: s.id, task }, place: ph.phrase, rank: STRIP_ORDER.indexOf(task), bouts: TASK_BOUTS[task as keyof typeof TASK_BOUTS] ?? 3,
      });
    }
  }

  // buildings: the home, then the household's others (barn, byre, workshop …)
  const ids: number[] = [];
  const hh = O.state.households.get(me.household);
  if (hh && hh.home >= 0) ids.push(hh.home);
  if (holding) for (const b of holding.buildings) if (!ids.includes(b)) ids.push(b);
  for (const id of ids) {
    const b = O.state.buildings.get(id);
    if (!b || b.construction < 1) continue;
    const target: TargetRef = { kind: 'building', id };
    const list = reg.list(me.id, target);
    const place = buildingPhrase(O, b);
    const at = buildingTarget(O, b);
    const add = (kind: WorkKind, re: RegExp, rank: number, ids2: string[], bouts: number, skip?: RegExp): void => {
      const opt = firstEnabled(list, re, skip);
      if (opt) out.push({ kind, target, at, optionId: opt.id, ids: ids2, label: opt.label, place, rank, bouts });
    };
    // a batch at the bench uses up materials, so it is asked for once; the rest can be repeated
    add('craft', /^craft\./, 20, ['craft.*'], 1);
    add('craft', /^appr\./, 18, ['appr.*'], 2);
    add('barn', /^farm\.(thresh|winnow)/, 22, ['farm.thresh', 'farm.winnow'], 2);
    add('stock', /^stock\.milk/, 24, ['stock.milk'], 1);
    add('stock', /^stock\.shear/, 25, ['stock.shear'], 1);
    add('stock', /^stock\.feed/, 26, ['stock.feed'], 1);
    add('stock', /^stock\.muck/, 28, ['stock.muck'], 2);
    add('garden', /^garden\.(dig|sow|weed|harvest)/, 30, ['garden.*'], 2);
    add('dig', /^dig\./, 35, ['dig.*'], 2);
  }

  // the common pasture
  const pasture = pastureOf(O, me);
  if (pasture) {
    const target: TargetRef = { kind: 'parcel', id: pasture.id };
    const opt = firstEnabled(reg.list(me.id, target), /^stock\.herd/);
    if (opt) {
      out.push({
        kind: 'herd', target, at: { kind: 'parcel', id: pasture.id, x: pasture.x, z: pasture.z, label: 'Common pasture' }, optionId: opt.id, ids: ['stock.herd'],
        label: opt.label, place: 'the common pasture', rank: 40, bouts: 2,
      });
    }
  }
  return out.sort((a, b) => a.rank - b.rank || (a.at.id - b.at.id));
}

/** The best work of the given kinds: by rank, with the household's crafts last unless `craftFirst`. */
export function pickWork(O: Obj, me: Person, kinds?: readonly WorkKind[], craftFirst = false): WorkChoice | null {
  const all = workChoices(O, me).filter((c) => !kinds || kinds.includes(c.kind));
  if (craftFirst) return all.find((c) => c.kind === 'craft') ?? all[0] ?? null;
  return all.find((c) => c.kind !== 'craft') ?? all[0] ?? null;
}

/** Text helpers for a work choice. */
export function workTitle(c: WorkChoice): string {
  return capFirst(c.label.replace(/\s*\(.*\)\s*$/, ''));
}

export function distanceTo(c: WorkChoice, x: number, z: number): number {
  return dist(c.at.x, c.at.z, x, z);
}

export { placeTarget };
