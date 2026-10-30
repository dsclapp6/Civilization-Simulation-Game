// Titles changing hands outside inheritance (conquest, peace terms, grants, revocation) and the
// claims that justify wars (SPEC §15: claims by blood or marriage, computed from kinship to the
// holders of titles).
import type { RankTier } from '../../core/domain';
import { ancestorIds, familyOf } from '../kin';
import { continentPct } from '../score';
import { setRank } from '../succession';
import { ageYears, fullName, TITLE_RANK, type HouseId, type Person, type PersonId, type Title, type TitleId } from '../state';
import type { PoliticsCore } from './core';
import type { Claim } from './types';

/** The office name written in `Person.offices` for holding a title. */
export function officeFor(t: Title): string {
  switch (t.kind) {
    case 'manor': case 'town': return 'lord';
    case 'barony': return 'baron';
    case 'county': return 'earl';
    case 'kingdom': return 'king';
    case 'abbey': return 'abbot';
    default: return 'bishop';
  }
}

function tierOf(t: Title): RankTier {
  return Math.max(2, Math.min(8, TITLE_RANK[t.kind])) as RankTier;
}

/** Recomputes the continent share at once (the yearly hook would otherwise leave it stale for a year). */
export function refreshScore(core: PoliticsCore): void {
  core.state.score.continentPct = continentPct(core.state, core.world);
  core.state.dirty.meta = true;
}

function dropOffice(core: PoliticsCore, p: Person, office: string, place: number): void {
  const i = p.offices.findIndex((o) => o.office === office && o.place === place);
  if (i < 0) return;
  p.offices.splice(i, 1);
  core.state.touch(p);
  core.sim.events.emit('office', { person: p.id, office, place, gained: false });
}

/** Moves a title to `to`: the holder's offices, the new holder's rank and the lieges stay consistent. */
export function transferTitle(core: PoliticsCore, t: Title, to: Person, why: string, opts: { rehome?: boolean } = {}): void {
  const state = core.state;
  const old = t.holder ? state.persons.get(t.holder) : undefined;
  if (old && old.id === to.id) return;
  const office = officeFor(t);
  state.setTitleHolder(t, to.id);
  t.coholders = [];
  t.regent = 0;
  if (old) {
    dropOffice(core, old, office, t.place);
    // a deposed House keeps its claim for a time (the root of "avenge")
    if (old.house && old.house !== to.house) core.save.deposed[String(t.id)] = [old.house, Math.floor(core.day) + 5 * 16];
    delete core.save.oaths[String(t.id)];
  }
  if (opts.rehome) rehome(core, t, to);
  const tier = tierOf(t);
  if (tier > to.rankTier) setRank(core.sim, to, tier);
  if (to.sex === 'm' && to.career !== 'lord' && to.career !== 'knight') to.career = tier >= 6 ? 'lord' : 'knight';
  else if (to.sex === 'f') to.career = 'lady';
  if (!to.offices.some((o) => o.office === office && o.place === t.place)) {
    to.offices.push({ office, place: t.place, since: Math.round(core.day) });
  }
  to.prestige += tier * 2;
  state.touch(to);
  core.save.stats.titlesMoved++;
  core.touch();
  core.invalidate();
  core.sim.events.emit('office', { person: to.id, office, place: t.place, gained: true });
  const mine = (old && old.house === state.run.houseId) || to.house === state.run.houseId;
  const text = `${t.name} passed from ${old ? fullName(old) : 'no one'} to ${fullName(to)} (${why}).`;
  if (mine || tier >= 6) core.log('title', text, old ? [to.id, old.id] : [to.id]);
  refreshScore(core);
  core.sim.requestSave('title moved');
}

/** A conquered title is held from the conqueror's own higher title (or from no one), not from the old liege. */
function rehome(core: PoliticsCore, t: Title, to: Person): void {
  const state = core.state;
  let best: Title | undefined;
  for (const x of state.titlesHeldBy(to.id)) {
    if (x.id === t.id || x.kind === 'abbey' || x.kind === 'see') continue;
    if (TITLE_RANK[x.kind] <= TITLE_RANK[t.kind]) continue;
    if (!best || TITLE_RANK[x.kind] < TITLE_RANK[best.kind] || (TITLE_RANK[x.kind] === TITLE_RANK[best.kind] && x.id < best.id)) best = x;
  }
  // the title's old liege is kept only if it already belongs to the conqueror's own realm
  const old = t.liege ? state.titles.get(t.liege) : undefined;
  const oldHolder = old && old.holder ? state.persons.get(old.holder) : undefined;
  if (oldHolder && oldHolder.house === to.house) return;
  const next = best ? best.id : 0;
  if (t.liege !== next) { t.liege = next; state.touchTitle(t); }
}

// ---------------------------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------------------------

/** Who outside the holder's House can press a claim on the title, strongest first. */
export function claimsOnTitle(core: PoliticsCore, t: Title): Claim[] {
  const state = core.state;
  const holder = t.holder ? state.persons.get(t.holder) : undefined;
  if (!holder || holder.death) return [];
  const out = new Map<HouseId, Claim>();
  const put = (c: Claim): void => {
    const cur = out.get(c.house);
    if (!cur || c.strength > cur.strength || (c.strength === cur.strength && c.person < cur.person)) out.set(c.house, c);
  };

  const kin = familyOf(state, holder, 3);
  const holderParents = [holder.father, holder.mother].filter((x) => x > 0);
  const ids = [...kin.keys()].sort((a, b) => a - b);
  const blood = new Map<PersonId, 1 | 2 | 3>();
  for (const id of ids) {
    const c = state.persons.get(id);
    if (!c || c.death || id === holder.id || c.estate === 'clergy') continue;
    if (c.house === holder.house || !c.house) continue;
    const anc = ancestorIds(state, c, 3);
    let s = 0;
    if (c.father === holder.id || c.mother === holder.id) s = 3;
    else if (anc.has(holder.id)) s = ancestorDepth(state, c, holder.id) === 2 ? 2 : 1;
    else if (holderParents.some((p) => c.father === p || c.mother === p)) s = 2; // a brother or sister of the holder
    else if (holderParents.some((p) => anc.has(p))) s = 1; // a nephew or niece
    if (s > 0) {
      blood.set(c.id, s as 1 | 2 | 3);
      put({ title: t.id, person: c.id, house: c.house, kind: 'blood', strength: s as 1 | 2 | 3 });
    }
  }
  // by marriage: the spouse of the holder (and of a claimant) stands behind the claim
  if (holder.spouse) {
    const sp = state.persons.get(holder.spouse);
    if (sp && !sp.death && sp.house !== holder.house && sp.estate !== 'clergy') {
      put({ title: t.id, person: sp.id, house: sp.house, kind: 'marriage', strength: holder.sex === 'f' ? 2 : 1 });
    }
  }
  for (const [pid, s] of [...blood.entries()].sort((a, b) => a[0] - b[0])) {
    if (s < 2) continue;
    const c = state.persons.get(pid);
    const sp = c && c.spouse ? state.persons.get(c.spouse) : undefined;
    if (sp && !sp.death && sp.house !== holder.house && sp.estate !== 'clergy') put({ title: t.id, person: sp.id, house: sp.house, kind: 'marriage', strength: 1 });
  }
  // a House that lost the title keeps its grievance and its claim for a few years
  const dep = core.save.deposed[String(t.id)];
  if (dep && dep[1] > core.day && dep[0] !== holder.house) {
    const house = state.houses.get(dep[0]);
    const head = house ? core.living(house.head) : undefined;
    if (head) put({ title: t.id, person: head.id, house: dep[0], kind: 'deposed', strength: 3 });
  }
  return [...out.values()].sort((a, b) => b.strength - a.strength || a.house - b.house);
}

function ancestorDepth(state: PoliticsCore['state'], c: Person, target: PersonId): number {
  let layer: Person[] = [c];
  for (let d = 1; d <= 3; d++) {
    const next: Person[] = [];
    for (const p of layer) {
      for (const id of [p.father, p.mother]) {
        if (id === target) return d;
        const q = id ? state.persons.get(id) : undefined;
        if (q) next.push(q);
      }
    }
    layer = next;
  }
  return 9;
}

/** Claims held by a House on the titles of other Houses (living holders only), strongest first. */
export function claimsOfHouse(core: PoliticsCore, house: HouseId): Claim[] {
  const out: Claim[] = [];
  for (const h of core.actors()) {
    if (h === house) continue;
    for (const t of core.titlesOfHouse(h)) {
      if (t.kind === 'abbey' || t.kind === 'see') continue;
      for (const c of claimsOnTitle(core, t)) if (c.house === house) out.push(c);
    }
  }
  return out.sort((a, b) => b.strength - a.strength || a.title - b.title);
}

export function claimOn(core: PoliticsCore, house: HouseId, title: TitleId): Claim | undefined {
  const t = core.state.titles.get(title);
  if (!t) return undefined;
  return claimsOnTitle(core, t).find((c) => c.house === house);
}

/** Best adult heir-apparent of a House to receive a conquered title: unlanded sons first, the head last. */
export function recipientFor(core: PoliticsCore, house: HouseId, t: Title, claimant: PersonId): Person | undefined {
  const state = core.state;
  const c = claimant ? core.living(claimant) : undefined;
  if (c && c.house === house && core.age(c) >= 16) return c;
  const head = core.headOf(house);
  const tier = tierOf(t);
  let best: Person | undefined;
  let bestKey = -Infinity;
  for (const m of state.houseMemberList(house)) {
    if (m.death || m.sex !== 'm' || m.estate === 'clergy' || m.flags.captive) continue;
    if (state.houses.get(house)?.sworn.includes(m.id)) continue;
    const age = ageYears(m, core.day);
    if (age < 18) continue;
    const held = state.titlesHeldBy(m.id).size;
    const key = (head && m.id === head.id ? 0 : 40) - held * 25 + Math.min(age, 45) * 0.5 + (m.rankTier >= tier - 2 ? 15 : 0) - m.id * 1e-6;
    if (key > bestKey) { bestKey = key; best = m; }
  }
  return best ?? head;
}
