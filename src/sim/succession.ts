// Death and what follows it: closing a life, passing on the household headship, inheritance of
// titles (SPEC §15: sons by birth order, daughters as coheiresses, regency for heirs under 16),
// fostering orphans. Pure state changes + events; no timing logic.
import { BUILDINGS, type BuildingKind } from '../content/types';
import type { RankTier, Sex } from '../core/domain';
import type { Rng } from '../core/rng';
import type { SimContext } from './context';
import { familyOf } from './kin';
import { createPerson, refreshTrained } from './people';
import {
  NONE, TITLE_RANK, ageYears, fullName,
  type BuildingState, type DeathCause, type GameState, type Household, type House, type Person, type PersonId, type Title,
} from './state';

const ADULT = 16;

// ---------------------------------------------------------------------------------------------
// Rank
// ---------------------------------------------------------------------------------------------

function applyTier(p: Person, tier: RankTier): void {
  p.rankTier = tier;
  if (tier >= 5) p.estate = 'noble';
}

/** Changes a person's rank tier; spouse and children living in the household follow upwards. */
export function setRank(ctx: SimContext, p: Person, tier: RankTier): void {
  const state = ctx.state;
  const from = p.rankTier;
  if (from === tier) return;
  applyTier(p, tier);
  state.touch(p);
  ctx.events.emit('rankChanged', { person: p.id, from, to: tier });
  if (tier > from) {
    const sp = p.spouse ? state.persons.get(p.spouse) : undefined;
    if (sp && !sp.death && sp.rankTier < tier) { applyTier(sp, tier); state.touch(sp); }
    const hh = state.households.get(p.household);
    if (hh) {
      for (const id of hh.members) {
        const c = state.persons.get(id);
        if (c && !c.death && (c.father === p.id || c.mother === p.id) && c.rankTier < tier && ageYears(c, ctx.absDay) < ADULT) {
          applyTier(c, tier); state.touch(c);
        }
      }
    }
    if (p.house === state.run.houseId) ctx.score.onRankReached(tier);
  }
}

/** Moves a household head, spouse and children under 16 who share the head's old tier to a new
 *  tier (promotion or demotion of the whole family). */
export function shiftFamilyRank(ctx: SimContext, head: Person, tier: RankTier): void {
  const state = ctx.state;
  const old = head.rankTier;
  if (old === tier) return;
  const move = (p: Person | undefined): void => {
    if (!p || p.death || p.rankTier !== old) return;
    p.rankTier = tier;
    if (tier >= 5) p.estate = 'noble';
    else if (tier >= 2 && p.estate === 'unfree') p.estate = 'free';
    state.touch(p);
  };
  head.rankTier = tier;
  if (tier >= 2 && head.estate === 'unfree') head.estate = 'free';
  state.touch(head);
  ctx.events.emit('rankChanged', { person: head.id, from: old, to: tier });
  move(head.spouse ? state.persons.get(head.spouse) : undefined);
  const hh = state.households.get(head.household);
  if (hh) {
    for (const id of hh.members) {
      const c = state.persons.get(id);
      if (c && (c.father === head.id || c.mother === head.id) && ageYears(c, ctx.absDay) < ADULT) move(c);
    }
  }
  if (tier > old && head.house === state.run.houseId) ctx.score.onRankReached(tier);
}

// ---------------------------------------------------------------------------------------------
// Homes and household merging
// ---------------------------------------------------------------------------------------------

/** Picks a home building in a settlement: an empty home of a preferred kind, any empty home, else a shared one. */
export function pickHome(state: GameState, rng: Rng, settlementId: number, prefer?: readonly BuildingKind[]): BuildingState | null {
  const all = state.buildingsAt.get(settlementId);
  if (!all || all.length === 0) return null;
  const empty: BuildingState[] = [];
  let homes = 0;
  let shared: BuildingState | null = null;
  for (const b of all) {
    if (BUILDINGS[b.kind].cat !== 'home') continue;
    homes++;
    if (!b.household) {
      if (prefer && prefer.includes(b.kind)) return b;
      empty.push(b);
    } else if (!shared || rng.next() < 0.2) shared = b;
  }
  if (empty.length) return empty[Math.floor(rng.next() * empty.length)];
  if (homes) return shared;
  return all[Math.floor(rng.next() * all.length)];
}

/** Moves every member of `src` into `dst` and dissolves `src`. */
export function mergeHouseholds(state: GameState, src: Household, dst: Household): void {
  if (src.id === dst.id) return;
  for (const id of src.members.slice()) {
    const m = state.persons.get(id);
    if (m && !m.death) state.joinHousehold(m, dst);
  }
  dst.purse += src.purse;
  for (const [k, v] of Object.entries(src.stores)) dst.stores[k] = (dst.stores[k] ?? 0) + v;
  state.touchHousehold(dst);
  state.removeHousehold(src);
}

/** Removes a household nobody lives in any more. */
export function dissolveIfEmpty(state: GameState, hh: Household): boolean {
  if (hh.members.length > 0) return false;
  // monasteries, garrisons and castle staff outlive their members: recruitment refills them
  if (hh.target !== undefined) { state.setHead(hh, null); return false; }
  state.removeHousehold(hh);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Death
// ---------------------------------------------------------------------------------------------

/** Closes a life: marks the death, widows the spouse, passes household headship and titles on,
 *  fosters orphans and finally announces the death. `now` is the (boundary) time of death. */
export function killPerson(ctx: SimContext, p: Person, cause: DeathCause, now: number): void {
  const state = ctx.state;
  if (p.death) return;
  const age = ageYears(p, now);
  const hh = state.households.get(p.household);
  const wasHead = !!hh && hh.head === p.id;
  const house = state.houses.get(p.house);

  p.pregnancy = null;
  p.health.conditions.length = 0;
  state.markDead(p, now, cause);
  if (p.spouse) {
    const sp = state.persons.get(p.spouse);
    if (sp && !sp.death) state.widow(sp);
  }
  if (hh) {
    if (p.money > 0) { hh.purse += p.money; p.money = 0; state.touchHousehold(hh); }
    state.leaveHousehold(p);
    succeedHousehold(ctx, hh, p, wasHead, now);
  }
  if (house) {
    const i = house.sworn.indexOf(p.id);
    if (i >= 0) { house.sworn.splice(i, 1); state.touchHouse(house); }
  }
  inheritTitles(ctx, p, now);
  if (house) fixHouseHead(state, house, p);

  const st = state.stats.current;
  st.deaths++;
  st.ageAtDeathSum += age;
  if (age < 1) st.infantDeaths++;
  st.deathsByCause[cause] = (st.deathsByCause[cause] ?? 0) + 1;

  if (p.house === state.run.houseId || p.flags.player) {
    state.log(now, 'death', `${fullName(p)} died${age >= 1 ? ` aged ${Math.floor(age)}` : ' in infancy'} (${cause.replace('_', ' ')}).`, [p.id]);
  }
  ctx.events.emit('death', { person: p.id, cause, age, wasHead });
}

/** When the head of a household dies: the eldest adult son (or the widow if none grown), else
 *  the eldest adult; with no adults the children are fostered and the household is dissolved. */
function succeedHousehold(ctx: SimContext, hh: Household, dead: Person, wasHead: boolean, now: number): void {
  const state = ctx.state;
  if (hh.members.length === 0) { dissolveIfEmpty(state, hh); return; }
  if (!wasHead && hh.head && state.persons.get(hh.head) && !state.persons.get(hh.head)!.death) return;

  const members: Person[] = [];
  for (const id of hh.members) { const m = state.persons.get(id); if (m && !m.death) members.push(m); }
  const adults = members.filter((m) => ageYears(m, now) >= ADULT);
  if (adults.length > 0) {
    const widow = dead.spouse ? adults.find((m) => m.id === dead.spouse) : undefined;
    const kin = adults.filter((m) => m.father === dead.id || m.mother === dead.id);
    const sons = kin.filter((m) => m.sex === 'm').sort((a, b) => a.birthDay - b.birthDay);
    let next: Person | undefined;
    if (dead.sex === 'm' && sons.length && ageYears(sons[0], now) >= 18) next = sons[0];
    else if (widow) next = widow;
    else if (sons.length) next = sons[0];
    else if (kin.length) next = kin.sort((a, b) => a.birthDay - b.birthDay)[0];
    else {
      // otherwise the eldest adult who is not a servant, else the eldest adult
      const family = adults.filter((m) => m.house === dead.house && !state.houses.get(m.house)?.sworn.includes(m.id));
      next = (family.length ? family : adults).sort((a, b) => a.birthDay - b.birthDay)[0];
    }
    state.setHead(hh, next);
    return;
  }
  // no adult left: place the children with relatives or neighbours
  placeOrphans(ctx, hh, members);
}

/** Children left without an adult go to grandparents, uncles/aunts, else a suitable household nearby. */
export function placeOrphans(ctx: SimContext, hh: Household, members: Person[]): void {
  const state = ctx.state;
  const rng = ctx.rng('succession');
  for (const child of members) {
    const target = fosterHousehold(state, child, rng);
    if (target) state.joinHousehold(child, target);
  }
  const rest = hh.members.filter((id) => { const m = state.persons.get(id); return m && !m.death; });
  if (rest.length === 0) dissolveIfEmpty(state, hh);
  else {
    const oldest = rest.map((id) => state.persons.get(id) as Person).sort((a, b) => a.birthDay - b.birthDay)[0];
    state.setHead(hh, oldest);
  }
}

function livingHouseholdOf(state: GameState, id: PersonId, exclude: Household['id']): Household | null {
  if (!id) return null;
  const p = state.persons.get(id);
  if (!p || p.death) return null;
  const hh = state.households.get(p.household);
  return hh && hh.id !== exclude ? hh : null;
}

function fosterHousehold(state: GameState, child: Person, rng: Rng): Household | null {
  const self = child.household;
  // grandparents, then uncles and aunts
  const parents = [child.father, child.mother].filter(Boolean).map((id) => state.persons.get(id)).filter((p): p is Person => !!p);
  for (const parent of parents) {
    for (const gid of [parent.father, parent.mother]) {
      const h = livingHouseholdOf(state, gid, self);
      if (h) return h;
    }
  }
  for (const parent of parents) {
    for (const gid of [parent.father, parent.mother]) {
      const gp = gid ? state.persons.get(gid) : undefined;
      if (!gp) continue;
      for (const sibId of gp.children) {
        if (sibId === parent.id) continue;
        const h = livingHouseholdOf(state, sibId, self);
        if (h) return h;
      }
    }
  }
  // siblings of the child who are grown
  // a household of similar standing in the same settlement
  const here = state.householdList(child.settlement);
  let best: Household | null = null;
  let bestScore = -Infinity;
  for (const h of here) {
    if (h.id === self || h.kind === 'monastic' || h.kind === 'garrison') continue;
    const head = state.persons.get(h.head);
    if (!head || head.death) continue;
    const score = -Math.abs(head.rankTier - child.rankTier) * 3 - h.members.length * 0.3 + rng.next();
    if (score > bestScore) { bestScore = score; best = h; }
  }
  return best;
}

function fixHouseHead(state: GameState, house: House, dead: Person): void {
  if (house.head !== dead.id) return;
  let best: Person | null = null;
  {
    for (const m of state.houseMemberList(house.id)) {
      if (house.sworn.includes(m.id)) continue;
      if (!best) { best = m; continue; }
      // adults before children, men before women, then the eldest
      const mAdult = m.birthDay <= dead.death!.day - ADULT * 16 ? 0 : 1;
      const bAdult = best.birthDay <= dead.death!.day - ADULT * 16 ? 0 : 1;
      const mKey = mAdult * 4 + (m.sex === 'm' ? 0 : 2);
      const bKey = bAdult * 4 + (best.sex === 'm' ? 0 : 2);
      if (mKey < bKey || (mKey === bKey && m.birthDay < best.birthDay)) best = m;
    }
  }
  house.head = best ? best.id : NONE;
  if (!best) house.extinct = true;
  state.touchHouse(house);
}

// ---------------------------------------------------------------------------------------------
// Heirs (SPEC §15)
// ---------------------------------------------------------------------------------------------

export interface HeirResult {
  heirs: Person[];
  /** True when several daughters (or their lines) inherit jointly. */
  coheirs: boolean;
}

function livingChildrenOldestFirst(state: GameState, p: Person, sex?: Sex): Person[] {
  const out: Person[] = [];
  for (const id of p.children) {
    const c = state.persons.get(id);
    if (c && (sex === undefined || c.sex === sex)) out.push(c);
  }
  return out.sort((a, b) => a.birthDay - b.birthDay || a.id - b.id);
}

/** Eldest-son line: the eldest living son, else (right of representation) the male-line heir of the
 *  eldest dead son who left one, and so on down the brothers. */
function maleLineHeir(state: GameState, p: Person, depth = 0): Person | null {
  if (depth > 6) return null;
  for (const son of livingChildrenOldestFirst(state, p, 'm')) {
    if (!son.death) return son;
    const rep = maleLineHeir(state, son, depth + 1);
    if (rep) return rep;
  }
  return null;
}

/** Daughters (and, for dead daughters or sons without sons, their descendants) as coheiresses. */
function femaleLineHeirs(state: GameState, p: Person, depth = 0): Person[] {
  if (depth > 5) return [];
  const out: Person[] = [];
  for (const c of livingChildrenOldestFirst(state, p)) {
    if (!c.death) {
      if (c.sex === 'f') out.push(c);
    } else {
      const rep = femaleLineHeirs(state, c, depth + 1);
      const kids = livingChildrenOldestFirst(state, c).filter((k) => !k.death);
      // a dead child is represented by their living children, else deeper descendants
      if (kids.length) out.push(kids[0]);
      else if (rep.length) out.push(rep[0]);
    }
  }
  return out;
}

/** Nearest living relative of the same House (brothers before sisters, then by closeness). */
function collateralHeir(state: GameState, dead: Person): Person | null {
  const kin = familyOf(state, dead, 3);
  let best: Person | null = null;
  let bestKey = Infinity;
  for (const [id, dist] of kin) {
    if (id === dead.id) continue;
    const c = state.persons.get(id);
    if (!c || c.death || c.house !== dead.house) continue;
    const key = dist * 1000 + (c.sex === 'm' ? 0 : 500) + (c.birthDay + 100000) / 1000;
    if (key < bestKey) { bestKey = key; best = c; }
  }
  return best;
}

export function findHeirs(state: GameState, dead: Person): HeirResult {
  const son = maleLineHeir(state, dead);
  if (son) return { heirs: [son], coheirs: false };
  const co = femaleLineHeirs(state, dead);
  if (co.length === 1) return { heirs: co, coheirs: false };
  if (co.length > 1) return { heirs: co.sort((a, b) => a.birthDay - b.birthDay), coheirs: true };
  const c = collateralHeir(state, dead);
  return c ? { heirs: [c], coheirs: false } : { heirs: [], coheirs: false };
}

function titleTier(t: Title): RankTier {
  return Math.max(2, Math.min(8, TITLE_RANK[t.kind])) as RankTier;
}

// ---------------------------------------------------------------------------------------------
// Inheritance
// ---------------------------------------------------------------------------------------------

/** Passes the dead person's titles to heirs (or appoints a successor), regency included. */
export function inheritTitles(ctx: SimContext, dead: Person, now: number): void {
  const state = ctx.state;
  // coholdings of a title shared with others are simply dropped from the list
  for (const t of state.titles.values()) {
    const i = t.coholders.indexOf(dead.id);
    if (i >= 0) { t.coholders.splice(i, 1); state.touchTitle(t); }
  }
  const held = [...state.titlesHeldBy(dead.id)];
  if (held.length === 0) return;
  held.sort((a, b) => TITLE_RANK[b.kind] - TITLE_RANK[a.kind] || a.id - b.id);

  const secular = held.filter((t) => t.kind !== 'abbey' && t.kind !== 'see');
  const church = held.filter((t) => t.kind === 'abbey' || t.kind === 'see');
  for (const t of church) electReligiousHead(ctx, t, dead, now);
  if (secular.length === 0) return;

  const res = findHeirs(state, dead);
  if (res.heirs.length === 0) {
    for (const t of secular) appointHolder(ctx, t, dead, now);
    return;
  }
  const eldest = res.heirs[0];
  if (!res.coheirs) {
    for (const t of secular) grantTitle(ctx, t, eldest, dead, [], now);
  } else {
    // lands divided between the coheiresses, the principal title to the eldest
    const heirs = res.heirs;
    secular.forEach((t, i) => {
      const holder = i === 0 ? heirs[0] : heirs[i % heirs.length];
      const co = secular.length === 1 || (i === 0 && secular.length < heirs.length) ? heirs.filter((h) => h.id !== holder.id).map((h) => h.id) : [];
      grantTitle(ctx, t, holder, dead, co, now);
    });
  }
}

function grantTitle(ctx: SimContext, t: Title, heir: Person, from: Person, coholders: PersonId[], now: number): void {
  const state = ctx.state;
  state.setTitleHolder(t, heir.id);
  t.coholders = coholders;
  t.regent = NONE;
  const age = ageYears(heir, now);
  if (age < ADULT) {
    const regent = pickRegent(state, heir, now);
    if (regent) {
      t.regent = regent.id;
      regent.flags.regent = true;
      state.touch(regent);
    }
  }
  const tier = titleTier(t);
  if (tier > heir.rankTier) setRank(ctx, heir, tier);
  heir.career = heir.sex === 'm' ? (heir.rankTier >= 6 ? 'lord' : 'knight') : 'lady';
  heir.offices.push({ office: t.kind === 'manor' ? 'lord' : t.kind, place: t.place, since: Math.round(now) });
  heir.prestige += tier * 2;
  state.touch(heir);
  const house = state.houses.get(heir.house);
  if (house && house.head !== heir.id && from.house === heir.house && house.head === from.id) { house.head = heir.id; state.touchHouse(house); }
  ctx.events.emit('inheritance', { from: from.id, to: heir.id, title: t.id });
  if (from.house === state.run.houseId || heir.house === state.run.houseId) {
    state.log(now, 'inheritance', `${fullName(heir)} inherited ${t.name} from ${fullName(from)}.`, [heir.id, from.id]);
  }
}

function pickRegent(state: GameState, minor: Person, now: number): Person | null {
  const mother = minor.mother ? state.persons.get(minor.mother) : undefined;
  if (mother && !mother.death && ageYears(mother, now) >= ADULT) return mother;
  const father = minor.father ? state.persons.get(minor.father) : undefined;
  if (father) {
    for (const sibId of father.children) {
      if (sibId === minor.id) continue;
      const uncle = state.persons.get(sibId);
      if (uncle && !uncle.death && uncle.sex === 'm' && ageYears(uncle, now) >= ADULT) return uncle;
    }
    for (const gid of [father.father, father.mother]) {
      const gp = gid ? state.persons.get(gid) : undefined;
      if (gp && !gp.death) return gp;
    }
    for (const sibId of father.children) {
      if (sibId === minor.id) continue;
      const aunt = state.persons.get(sibId);
      if (aunt && !aunt.death && ageYears(aunt, now) >= ADULT) return aunt;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Fallback: no heir
// ---------------------------------------------------------------------------------------------

/** Candidate pool for an appointed holder: adult men of enough standing in the same kingdom. */
function appointHolder(ctx: SimContext, t: Title, from: Person, now: number): void {
  const state = ctx.state;
  const tier = titleTier(t);
  const world = ctx.world;
  const seatId = t.kind === 'kingdom' ? world.kingdoms.find((k) => k.id === t.place)?.capital
    : t.kind === 'county' ? world.counties.find((c) => c.id === t.place)?.seat
      : t.place;
  const seat = world.settlements.find((s) => s.id === seatId) ?? world.settlements[0];
  const kingdom = seat.kingdom;
  let best: Person | null = null;
  let bestKey = -Infinity;
  for (const s of world.settlements) {
    if (s.kingdom !== kingdom) continue;
    for (const p of state.residentList(s.id)) {
      if (p.sex !== 'm' || p.estate !== 'noble' || p.flags.player || ageYears(p, now) < 21) continue;
      if (p.rankTier + 1 < Math.min(tier, 6) || p.id === from.id) continue;
      const key = p.rankTier * 100 + p.prestige;
      if (key > bestKey) { bestKey = key; best = p; }
    }
  }
  if (!best) best = spawnNoble(ctx, seat.id, tier, now);
  grantTitle(ctx, t, best, from, [], now);
}

/** Brings a new landless knight (and family) into the kingdom — used only when a line dies out. */
export function spawnNoble(ctx: SimContext, settlementId: number, tier: RankTier, now: number): Person {
  const state = ctx.state;
  const rng = ctx.rng('succession');
  const s = ctx.world.settlements.find((x) => x.id === settlementId) ?? ctx.world.settlements[0];
  const house = state.addHouse({
    id: state.houses.alloc(), name: '', culture: s.culture, kind: 'noble', seat: s.id, founder: NONE, head: NONE, sworn: [], extinct: false,
  });
  const hh = state.addHousehold({
    id: state.households.alloc(), kind: 'family', head: NONE, members: [], home: -1, settlement: s.id, purse: 0, stores: {},
  });
  const knight = createPerson(state, rng, {
    culture: s.culture, sex: 'm', age: rng.range(24, 42), day: now, settlement: s.id, settlementName: s.name, household: hh,
    house: house.id, career: 'knight', stage: 2, tier: Math.max(5, tier - 1) as RankTier, estate: 'noble', noble: true,
  });
  house.name = knight.byname;
  house.founder = knight.id;
  house.head = knight.id;
  state.setHouse(knight, house.id);
  state.setHead(hh, knight);
  const home = pickHome(state, rng, s.id, ['manor_house', 'longhouse', 'cottage']);
  if (home) state.setHome(hh, home.id);
  hh.purse = 4000;
  state.stats.current.arrivals++;
  return knight;
}

/** Abbots, abbesses and priors are chosen by the community: the senior, ablest member. */
function electReligiousHead(ctx: SimContext, t: Title, from: Person, now: number): void {
  const state = ctx.state;
  const rng = ctx.rng('succession');
  const s = ctx.world.settlements.find((x) => x.id === t.place);
  const abbatial = !s || s.kind === 'abbey' || s.kind === 'nunnery';
  let best: Person | null = null;
  let bestKey = -Infinity;
  for (const p of state.residentList(t.place)) {
    if (p.estate !== 'clergy' || p.id === from.id || ageYears(p, now) < 24) continue;
    if (p.career !== 'monk' && p.career !== 'nun') continue;
    if (from.sex !== p.sex) continue;
    const key = p.trained.int * 2 + p.trained.cha + p.prestige + ageYears(p, now) * 0.2 + rng.next();
    if (key > bestKey) { bestKey = key; best = p; }
  }
  if (!best) {
    // the community has died out: the bishop sends someone
    const hh = state.householdList(t.place).find((h) => h.kind === 'monastic');
    best = createPerson(state, rng, {
      culture: s ? s.culture : from.culture, sex: from.sex, age: rng.range(35, 55), day: now, settlement: t.place,
      settlementName: s?.name, household: hh ?? null, house: from.house, career: 'monk', stage: 1, tier: 3, estate: 'clergy',
    });
    state.stats.current.arrivals++;
  }
  state.setTitleHolder(t, best.id);
  best.career = abbatial ? 'abbot' : 'prior';
  best.careerStage = 3;
  const office = abbatial ? (best.sex === 'f' ? 'abbess' : 'abbot') : (best.sex === 'f' ? 'prioress' : 'prior');
  best.offices.push({ office, place: t.place, since: Math.round(now) });
  applyTier(best, abbatial ? 6 : 4);
  best.estate = 'clergy';
  refreshTrained(best, ageYears(best, now));
  state.touch(best);
  const hh = state.households.get(best.household);
  if (hh && hh.kind === 'monastic') state.setHead(hh, best);
  const house = state.houses.get(best.house);
  if (house) { house.head = best.id; state.touchHouse(house); }
  ctx.events.emit('inheritance', { from: from.id, to: best.id, title: t.id });
}
