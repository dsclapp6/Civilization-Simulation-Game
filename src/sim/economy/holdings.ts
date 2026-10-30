// Land, housing and the household's own management (SPEC §7, §9): what a household holds, the
// property on the market and how to rent or buy it, the household plan, hired helpers, the ledger.
import { BUILDINGS, type BuildingKind } from '../../content/types';
import type { AnimalKind } from '../../core/domain';
import { hash01 } from '../../core/math';
import { isHolyDay } from '../calendar';
import { shiftFamilyRank } from '../succession';
import { ageYears, type BuildingState, type Household, type Person, type PersonId } from '../state';
import type { Econ } from './core';
import { CAREER_ECON, careerEcon, goodOf } from './data';
import { nextTask, taskLabel } from './farm';
import { aiTask, landLadder } from './jobs';
import { bagEntries } from './items';
import { rentOf, weekWorkDays } from './obligations';
import { peekExtra } from '../farming';
import { stackValue } from './market';
import type {
  HoldingView, HouseholdPlanLine, HouseholdTask, ItemStack, LedgerLine, PropertyListing, Requirement, Result, StripHolding, Tenure,
} from './types';
import { parseItemKey } from './types';
import { skillLevel } from '../people';

const req = (label: string, met: boolean): Requirement => ({ label, met });

const ANIMALS: Record<string, AnimalKind> = { ox: 'ox', cow: 'cow', sheep: 'sheep', pig: 'pig', goat: 'goat', chicken: 'chicken', horse: 'horse' };

export function stackList(E: Econ, bag: Record<string, number>, settlement: number): ItemStack[] {
  const out: ItemStack[] = [];
  for (const [key, qty] of bagEntries(bag)) {
    const g = goodOf(key);
    if (!g) continue;
    const { quality } = parseItemKey(key);
    const st: ItemStack = { key, good: g, qty, value: stackValue(E, settlement, key, qty) };
    if (quality !== undefined) st.quality = quality;
    out.push(st);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// What a household holds
// ---------------------------------------------------------------------------------------------

export function tenureOf(E: Econ, hh: Household): Tenure {
  const head = E.person(hh.head);
  const explicit = E.save.tenure[String(hh.id)];
  if (explicit) return explicit;
  if (!head) return 'none';
  const s = E.settlementById.get(hh.settlement);
  let strips = 0;
  if (s) for (const id of s.strips) if (E.state.strips.get(id)?.holder === hh.id) strips++;
  if (head.estate === 'unfree') return 'serf';
  if (strips > 0) return 'free';
  return hh.home >= 0 ? 'lodger' : 'none';
}

export function holding(E: Econ, householdId: number): HoldingView | null {
  const hh = E.household(householdId);
  if (!hh) return null;
  const head = E.person(hh.head);
  const s = E.settlementById.get(hh.settlement);
  const strips: StripHolding[] = [];
  if (s) {
    for (const id of s.strips) {
      const st = E.state.strips.get(id);
      if (!st || st.holder !== hh.id) continue;
      const t = nextTask(E, st);
      strips.push({
        id, field: st.field, crop: st.crop, state: st.state, growth: st.growth, work: peekExtra(E.farm, id)?.p ?? 0,
        nextTask: t ? taskLabel(t, st) : st.state === 'sown' || st.state === 'growing' ? 'Growing' : st.state === 'ripe' ? 'Reap' : 'Wait',
      });
    }
  }
  const livestock: Partial<Record<AnimalKind, number>> = {};
  for (const [k, v] of Object.entries(hh.stores)) {
    const a = ANIMALS[parseItemKey(k).good];
    if (a && v > 0) livestock[a] = (livestock[a] ?? 0) + v;
  }
  const buildings: number[] = [];
  for (const b of E.state.buildingsAt.get(hh.settlement) ?? []) if (b.household === hh.id) buildings.push(b.id);
  const garden = E.world.parcels.find((q) => q.settlement === hh.settlement && q.use === 'garden');
  return {
    household: hh.id, home: hh.home, tenure: tenureOf(E, hh), rent: Math.round(rentOf(E, hh).annual * 100) / 100,
    weekWork: head ? weekWorkDays(E, head) : 0, strips, gardenParcel: garden ? garden.id : -1, livestock, buildings,
    stores: stackList(E, hh.stores, hh.settlement),
  };
}

// ---------------------------------------------------------------------------------------------
// Property on the market
// ---------------------------------------------------------------------------------------------

/** [purchase price, rent per year] by building kind. */
const PRICES: Partial<Record<BuildingKind, readonly [number, number]>> = {
  hovel: [18, 1.5], cottage: [40, 3], longhouse: [80, 6], townhouse: [160, 12], manor_house: [800, 36],
  smithy: [90, 8], carpenter: [80, 7], bakehouse: [70, 6], brewhouse: [60, 5], weaver: [70, 6], tannery: [100, 9],
  windmill: [300, 24], watermill: [500, 36], kiln: [40, 4], sawpit: [30, 3], market_stall: [20, 2], alehouse: [120, 10],
  tavern: [300, 24], warehouse: [200, 16], cowshed: [30, 2.5], stable: [60, 5], barn: [50, 4],
};

export const STRIP_RENT = 3;
export const STRIP_PRICE = 60;

const ids = { house: 0, strip: 1_000_000, work: 2_000_000, manor: 3_000_000, land: 4_000_000 };

function worth(E: Econ, p: Person): number { const hh = E.hhOf(p); return p.money + (hh && hh.head === p.id ? hh.purse : 0); }

export function listingsAt(E: Econ, sid: number, forPerson: PersonId): PropertyListing[] {
  const s = E.settlementById.get(sid);
  const p = E.person(forPerson);
  if (!s || !p) return [];
  const out: PropertyListing[] = [];
  const lord = E.lordOf(sid);
  const seller = lord?.person.id ?? 0;
  const free = p.estate !== 'unfree';
  const adult = ageYears(p, E.day) >= 14;
  const head = E.hhOf(p)?.head === p.id;
  const cash = worth(E, p);

  // houses and workshops
  for (const b of E.state.buildingsAt.get(sid) ?? []) {
    if (b.household !== 0 || b.construction < 1) continue;
    const price = PRICES[b.kind];
    if (!price) continue;
    const cat = BUILDINGS[b.kind].cat;
    const [buy, rent] = price;
    const lvl = 1 + 0.35 * (b.level - 1);
    if (cat === 'home' && b.kind !== 'manor_house') {
      out.push({
        id: ids.house + b.id, kind: 'house', building: b.id, settlement: sid, label: `${BUILDINGS[b.kind].name}${b.level > 1 ? ' (improved)' : ''}`,
        price: free ? Math.round(buy * lvl) : null, rent: Math.round(rent * lvl * 100) / 100, seller,
        requirements: [req('Aged 14 or more', adult), req(free ? 'Free to hold property' : 'Serfs rent only', true), req(`${Math.round(rent * lvl / 2 * 100) / 100}d for the first term`, cash >= rent * lvl / 2)],
      });
    } else if (cat === 'work' || cat === 'trade' || cat === 'social') {
      const craft = careerEcon(p.career).workplace.includes(b.kind);
      out.push({
        id: ids.work + b.id, kind: cat === 'work' ? 'workshop' : 'shop', building: b.id, settlement: sid,
        label: `${BUILDINGS[b.kind].name}${b.level > 1 ? ' (improved)' : ''}`,
        price: free ? Math.round(buy * lvl) : null, rent: Math.round(rent * lvl * 100) / 100, seller,
        requirements: [
          req('A free craftsman or trader', free && adult),
          req(`Trained in the trade (a master, or skill ${cat === 'work' ? 5 : 3})`, craft || (p.careerStage >= 2 && CAREER_ECON[p.career].workplace.includes(b.kind)) || skillLevel(p.skills[CAREER_ECON[p.career].skill]) >= 5),
          req(`${Math.round(rent * lvl / 2 * 100) / 100}d for the first term`, cash >= rent * lvl / 2),
        ],
      });
    }
  }
  // strips the lord will let out (a share of the demesne)
  const open: number[] = [];
  for (const id of s.strips) {
    const st = E.state.strips.get(id);
    if (st && st.holder === 0 && hash01(id, 3, 5) < 0.55) open.push(id);
  }
  for (const id of open.slice(0, 8)) {
    out.push({
      id: ids.strip + id, kind: 'strip', strips: [id], settlement: sid, label: `A strip of the ${['east', 'middle', 'west'][E.state.strips.get(id)?.field ?? 0]} field`,
      price: free ? STRIP_PRICE : null, rent: STRIP_RENT, seller,
      requirements: [
        req('Aged 14 or more', adult), req('Head of a household', head),
        req(`${STRIP_RENT / 2}d for the first term`, cash >= STRIP_RENT / 2),
      ],
    });
  }
  // meadow, orchard and woodlot in private hands
  for (const q of E.world.parcels) {
    if (q.settlement !== sid || (q.use !== 'meadow' && q.use !== 'orchard' && q.use !== 'woodlot')) continue;
    if (E.save.parcels[String(q.id)]) continue;
    const rent = q.use === 'meadow' ? 4 : q.use === 'orchard' ? 3 : 2;
    out.push({
      id: ids.land + q.id, kind: 'land', settlement: sid, label: `A ${q.use}`, price: free ? rent * 18 : null, rent, seller,
      requirements: [req('Head of a household', head), req('Aged 14 or more', adult), req(`${rent / 2}d for the first term`, cash >= rent / 2)],
    });
  }
  // a manor house, for the gentry
  const manorHouse = (E.state.buildingsAt.get(sid) ?? []).find((b) => b.kind === 'manor_house' && b.household === 0 && b.owner === 0);
  if (manorHouse) {
    const [buy] = PRICES.manor_house as readonly [number, number];
    out.push({
      id: ids.manor + manorHouse.id, kind: 'manor', building: manorHouse.id, settlement: sid, label: 'A small manor house', price: buy, rent: null, seller,
      requirements: [req('Gentry or better (rank 4)', p.rankTier >= 4), req(`${buy}d`, cash >= buy)],
    });
  }
  return out;
}

export function buyOrRent(E: Econ, personId: PersonId, listingId: number, mode: 'buy' | 'rent'): Result {
  const p = E.person(personId);
  if (!p || p.death) return { ok: false, reason: 'Nobody to sign' };
  const hh = E.hhOf(p);
  if (!hh) return { ok: false, reason: 'You have no household' };
  const sid = p.settlement;
  const listing = listingsAt(E, sid, personId).find((l) => l.id === listingId);
  if (!listing) return { ok: false, reason: 'That is no longer for sale or rent' };
  const bad = listing.requirements.find((r) => !r.met);
  if (bad) return { ok: false, reason: `Needs: ${bad.label}` };
  if (mode === 'buy' && listing.price === null) return { ok: false, reason: 'Only for rent' };
  if (mode === 'rent' && listing.rent === null) return { ok: false, reason: 'Only for sale' };
  const cost = mode === 'buy' ? (listing.price as number) : (listing.rent as number) / 2;
  const seller = listing.seller ? E.person(listing.seller) : undefined;
  if (!E.spend(p, cost, `${mode === 'buy' ? 'Bought' : 'Rented'}: ${listing.label}`, true)) return { ok: false, reason: `You need ${Math.round(cost * 100) / 100}d` };
  if (seller) E.credit(E.hhOf(seller), cost);
  const key = String(hh.id);
  const player = E.isPlayer(personId);

  switch (listing.kind) {
    case 'house': case 'workshop': case 'shop': case 'manor': {
      const b = E.state.buildings.get(listing.building as number) as BuildingState;
      if (listing.kind === 'house' || listing.kind === 'manor') {
        E.state.setHome(hh, b.id);
        if (hh.settlement !== b.settlement) E.state.relocateHousehold(hh, b.settlement, b.id);
      } else {
        b.household = hh.id;
        b.occupied = true;
        E.state.touchBuilding(b);
      }
      if (mode === 'buy') { b.owner = p.house; E.state.touchBuilding(b); delete E.save.lease[`b${b.id}`]; E.save.tenure[key] = 'owned'; }
      else { E.save.lease[`b${b.id}`] = listing.rent as number; E.save.tenure[key] = E.save.tenure[key] ?? 'lease'; }
      if (listing.kind === 'manor') E.deed('manor', 150, 'Bought a manor house');
      break;
    }
    case 'strip': {
      const id = (listing.strips as number[])[0];
      const st = E.state.strips.get(id);
      if (!st || st.holder !== 0) return { ok: false, reason: 'Someone else took it' };
      const hadLand = (E.settlementById.get(sid)?.strips ?? []).some((x) => E.state.strips.get(x)?.holder === hh.id);
      st.holder = hh.id;
      E.state.touchStrip(st);
      E.save.lease[String(id)] = mode === 'buy' ? 0 : (listing.rent as number);
      E.save.tenure[key] = mode === 'buy' ? 'owned' : E.save.tenure[key] ?? 'lease';
      if (!hadLand && mode === 'buy') E.deed('first_land', 25, 'Bought land for the first time');
      else if (!hadLand) E.deed('first_tenancy', 10, 'Took a tenancy');
      break;
    }
    case 'land': {
      const pid = listingId - ids.land;
      E.save.parcels[String(pid)] = { hh: hh.id, rent: mode === 'buy' ? 0 : (listing.rent as number) };
      if (mode === 'buy' && !E.save.deeds.includes('first_land')) E.deed('first_land', 25, 'Bought land for the first time');
      break;
    }
  }
  E.touchSave();
  if (player) {
    E.notify(`${mode === 'buy' ? 'Bought' : 'Rented'}: ${listing.label} (${Math.round(cost * 100) / 100}d).`, 'gain', personId);
    landLadder(E, p);
    if (mode === 'buy' && p.rankTier < 3 && hh.head === p.id && listing.kind === 'workshop' && p.careerStage >= 2) shiftFamilyRank(E.sim, p, 3);
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// The household plan and helpers
// ---------------------------------------------------------------------------------------------

export function householdPlan(E: Econ, householdId: number): HouseholdPlanLine[] {
  const hh = E.household(householdId);
  if (!hh) return [];
  const out: HouseholdPlanLine[] = [];
  const sea = Math.floor(E.dayOfYear / 4);
  for (const id of hh.members) {
    const m = E.person(id);
    if (!m || m.death) continue;
    const set = E.save.plan[String(id)];
    const age = ageYears(m, E.day);
    out.push({ person: id, task: (set && set !== 'auto' ? set : aiTask(E, m, hh, age, sea)) as HouseholdTask, set: !!set && set !== 'auto' });
  }
  return out;
}

export function setTask(E: Econ, headId: PersonId, memberId: PersonId, task: HouseholdTask): Result {
  const head = E.person(headId);
  const member = E.person(memberId);
  if (!head || !member) return { ok: false, reason: 'No such person' };
  const hh = E.hhOf(head);
  if (!hh || hh.head !== headId) return { ok: false, reason: 'Only the head of the household sets its work' };
  if (member.household !== hh.id) return { ok: false, reason: 'They are not of your household' };
  if (task === 'auto') delete E.save.plan[String(memberId)];
  else E.save.plan[String(memberId)] = task;
  E.touchSave();
  return { ok: true };
}

export function standardWage(E: Econ, w: Person): number {
  const age = ageYears(w, E.day);
  const ce = careerEcon(w.career);
  const base = ce.wage[Math.min(3, w.careerStage)] || 0;
  if (age < 14) return 1;
  return Math.max(2, base);
}

export function hire(E: Econ, employerId: PersonId, workerId: PersonId, wage: number, task: HouseholdTask): Result {
  const emp = E.person(employerId);
  const w = E.person(workerId);
  if (!emp || !w || w.death) return { ok: false, reason: 'No such person' };
  const hh = E.hhOf(emp);
  if (!hh || hh.head !== employerId) return { ok: false, reason: 'Only a household head hires help' };
  if (w.household === hh.id) return { ok: false, reason: 'They already work for your household' };
  if (E.isHired(workerId)) return { ok: false, reason: 'They are already hired' };
  if (ageYears(w, E.day) < 12) return { ok: false, reason: 'Too young to hire' };
  const min = Math.round(standardWage(E, w) * 0.8 * 100) / 100;
  if (wage < min) return { ok: false, reason: `They want at least ${min}d a day` };
  if (wage > 20) return { ok: false, reason: 'That is more than a master earns' };
  if (hh.purse + emp.money < wage * 4) return { ok: false, reason: `You need ${Math.ceil(wage * 4)}d to keep a hand for a week` };
  E.save.helpers.push({ w: workerId, e: employerId, hh: hh.id, wage, task, since: Math.floor(E.day) });
  E.touchSave();
  if (E.isPlayer(employerId)) E.notify(`${w.first} works for you at ${wage}d a day.`, 'gain', employerId);
  E.social.adjustOpinion(workerId, employerId, 3, 'hired');
  return { ok: true };
}

export function dismiss(E: Econ, employerId: PersonId, workerId: PersonId): Result {
  const i = E.save.helpers.findIndex((h) => h.w === workerId && h.e === employerId);
  if (i < 0) return { ok: false, reason: 'They do not work for you' };
  E.save.helpers.splice(i, 1);
  E.touchSave();
  const w = E.person(workerId);
  if (w && E.isPlayer(employerId)) E.notify(`${w.first} is let go.`, 'info', employerId);
  return { ok: true };
}

/** Daily: helpers are paid (a helper whose master cannot pay walks away); the player's land ladder is checked. */
export function holdingsDaily(E: Econ): void {
  if (!isHolyDay(E.day)) {
    for (let i = E.save.helpers.length - 1; i >= 0; i--) {
      const h = E.save.helpers[i];
      const w = E.person(h.w);
      const emp = E.person(h.e);
      if (!w || w.death || !emp || emp.death) { E.save.helpers.splice(i, 1); E.touchSave(); continue; }
      const hh = E.household(h.hh);
      const wage = h.wage;
      let paid = false;
      if (emp && E.isPlayer(emp.id)) paid = E.spend(emp, wage, `Wages: ${w.first}`, true);
      else if (hh && hh.purse >= wage) { E.debit(hh, wage); paid = true; }
      if (paid) E.credit(E.hhOf(w), wage);
      else {
        E.save.helpers.splice(i, 1);
        E.touchSave();
        if (E.isPlayer(h.e)) E.notify(`${w.first} leaves your service: no wages.`, 'warn', h.e);
      }
    }
  }
  const p = E.person(E.playerId);
  if (p && !p.death) landLadder(E, p);
}

export function ledger(E: Econ, householdId: number): LedgerLine[] {
  return (E.save.ledger[String(householdId)] ?? []).slice().reverse();
}
