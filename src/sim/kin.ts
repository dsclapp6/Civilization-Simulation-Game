// Kinship queries over the person graph. Pruned (forgotten) dead people simply end a branch.
import { NONE, type GameState, type Person, type PersonId } from './state';

export function parentsOf(state: GameState, p: Person): Person[] {
  const out: Person[] = [];
  const f = p.father ? state.persons.get(p.father) : undefined;
  const m = p.mother ? state.persons.get(p.mother) : undefined;
  if (f) out.push(f);
  if (m) out.push(m);
  return out;
}

export function childrenOf(state: GameState, p: Person): Person[] {
  const out: Person[] = [];
  for (const id of p.children) {
    const c = state.persons.get(id);
    if (c) out.push(c);
  }
  return out;
}

/** Full and half siblings known to the registry. */
export function siblingsOf(state: GameState, p: Person): Person[] {
  const seen = new Set<PersonId>();
  const out: Person[] = [];
  for (const parentId of [p.father, p.mother]) {
    if (!parentId) continue;
    const parent = state.persons.get(parentId);
    if (!parent) continue;
    for (const id of parent.children) {
      if (id === p.id || seen.has(id)) continue;
      seen.add(id);
      const s = state.persons.get(id);
      if (s) out.push(s);
    }
  }
  return out;
}

/** Ancestor ids up to `generations` back (parents = 1). Ids of pruned people are included when
 *  they are still referenced by a surviving child, which is enough to detect shared ancestry. */
export function ancestorIds(state: GameState, p: Person, generations: number): Set<PersonId> {
  const out = new Set<PersonId>();
  let layer: Person[] = [p];
  for (let g = 0; g < generations; g++) {
    const next: Person[] = [];
    for (const q of layer) {
      for (const id of [q.father, q.mother]) {
        if (!id || out.has(id)) continue;
        out.add(id);
        const parent = state.persons.get(id);
        if (parent) next.push(parent);
      }
    }
    layer = next;
  }
  return out;
}

/** Too closely related to marry: parent/child, siblings, grandparent, aunt/uncle, first cousins. */
export function isCloseKin(state: GameState, a: Person, b: Person): boolean {
  if (a.id === b.id) return true;
  const aa = ancestorIds(state, a, 2);
  if (aa.has(b.id)) return true;
  const bb = ancestorIds(state, b, 2);
  if (bb.has(a.id)) return true;
  for (const id of aa) if (bb.has(id)) return true;
  return false;
}

/** People within `maxDepth` parent/child/spouse links of `start` (blood and marriage).
 *  The map value is the link distance. */
export function familyOf(state: GameState, start: Person, maxDepth = 4): Map<PersonId, number> {
  const seen = new Map<PersonId, number>([[start.id, 0]]);
  let frontier: Person[] = [start];
  for (let d = 1; d <= maxDepth && frontier.length; d++) {
    const next: Person[] = [];
    for (const p of frontier) {
      const edges = [p.father, p.mother, p.spouse, ...p.children];
      for (const id of edges) {
        if (id === NONE || seen.has(id)) continue;
        const q = state.persons.get(id);
        if (!q) continue;
        seen.set(id, d);
        next.push(q);
      }
    }
    frontier = next;
  }
  return seen;
}

/** Number of surviving (living) children. */
export function livingChildren(state: GameState, p: Person): number {
  let n = 0;
  for (const id of p.children) {
    const c = state.persons.get(id);
    if (c && !c.death) n++;
  }
  return n;
}
