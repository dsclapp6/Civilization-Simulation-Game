// Research (docs/CIV.md §6.4): a ruler commissions a technique by naming a person who could work it out and a fitting place,
// and paying its price in its branch's currencies (src/content/techs.json `research`). The work runs daily by the researcher's
// skill and the place; done, the researcher knows it (techniques live in people, SPEC §17) and so does the ruler, so the House
// commands it. The same calls serve the player's ruler panel and the AI's rulers.
import { CAREERS } from '../careers';
import type { Adv } from '../advancement/core';
import type { TechDef } from '../advancement/types';
import { formatMoney } from '../money';
import { ageYears, type Household, type HouseId, type Person, type PersonId } from '../state';
import { bagAdd, round2 } from './bags';
import { bookIn, bookOut } from './books';
import { RESEARCH } from './config';
import { addNews } from './news';
import { Pool, realmHouseholds } from './pool';
import { mayCommand, poolOf, scopeOf, titleAtSettlement, type RealmScope } from './rule';
import type { ProjectRec, Rlm } from './store';
import type { ResearchOption, ResearchProject, Result } from './types';

const fail = (reason: string): Result => ({ ok: false, reason });
const names = (ids: readonly string[], R: Rlm): string => ids.map((i) => R.tech?.tech(i)?.name ?? i).join(' and ');

/** "smithy, sawpit or carpenter" for the first few kinds of building a work is done in. */
function placeWords(kinds: readonly string[]): string {
  const k = kinds.slice(0, 3).map((x) => x.replace(/_/g, ' '));
  return k.length <= 1 ? (k[0] ?? 'workshop') : `${k.slice(0, -1).join(', ')} or ${k[k.length - 1]}`;
}

// ---------------------------------------------------------------------------------------------
// Who can do the work, and where
// ---------------------------------------------------------------------------------------------

/** Does the person meet the technique's own qualifications (skill, rank, craft stage), the building and market aside? */
function meets(A: Adv, p: Person, def: TechDef): boolean {
  const l = def.learn;
  if (l.skill && A.skillOf(p, l.skill) < (l.minSkill ?? 0)) return false;
  if (l.minTier !== undefined && p.rankTier < l.minTier) return false;
  if (l.minStage !== undefined && p.careerStage < l.minStage) return false;
  return true;
}

/** 1 for a researcher of the technique's own trade, a slower pace for clerks, clergy and masters, 0 for nobody. */
export function paceOf(R: Rlm, A: Adv, p: Person, def: TechDef, cands?: readonly TechDef[]): number {
  if (p.death || p.flags.captive || p.flags.outlaw || p.flags.exile) return 0;
  if (ageYears(p, R.day) < 14) return 0;
  if ((cands ?? A.candidates(p)).includes(def) && meets(A, p, def)) return 1;
  if (RESEARCH.scholars.includes(p.career) && A.skillOf(p, 'letters') >= 3) return RESEARCH.slowPace;
  if (CAREERS[p.career]?.field === 'craft' && p.careerStage >= 2) return RESEARCH.slowPace;
  return 0;
}

/** Progress per day of a researcher at a place. */
export function rateOf(R: Rlm, A: Adv, p: Person, def: TechDef, building: { level: number; settlement: number }, pace = paceOf(R, A, p, def)): number {
  const days = def.research?.days ?? 30;
  const skill = A.skillOf(p, def.learn.skill ?? 'letters');
  const f = (0.55 + 0.07 * skill) * (0.7 + 0.03 * p.trained.int) * (1 + 0.1 * (building.level - 1)) * (p.settlement === building.settlement ? 1 : 0.7);
  return Math.max(0.01, Math.min(2.5, pace * f)) / days;
}

/** Buildings of the realm (complete, standing) of the kinds the technique is worked on, best first. */
export function placesFor(R: Rlm, def: TechDef, settlements: readonly number[]): number[] {
  const kinds = def.research?.place;
  if (!kinds) return [];
  const found: Array<{ id: number; level: number }> = [];
  for (const sid of settlements) {
    for (const b of R.state.buildingsAt.get(sid) ?? []) {
      if (b.construction >= 1 && b.damage < 0.9 && kinds.includes(b.kind)) found.push({ id: b.id, level: b.level });
    }
  }
  found.sort((a, b) => b.level - a.level || a.id - b.id);
  return found.slice(0, 12).map((f) => f.id);
}

interface Candidate { p: Person; pace: number; skill: number }

/** People of the realm who could do the work, qualified ones first (best skill, then wits), then the slower ones. */
function researchersFor(R: Rlm, A: Adv, def: TechDef, people: readonly Person[], candsOf: Map<number, readonly TechDef[]>, busy: ReadonlySet<PersonId>): { fit: Candidate[]; slow: Candidate[] } {
  const fit: Candidate[] = [], slow: Candidate[] = [];
  const skill = def.learn.skill ?? 'letters';
  for (const p of people) {
    if (busy.has(p.id)) continue;
    const pace = paceOf(R, A, p, def, candsOf.get(p.id));
    if (pace <= 0) continue;
    (pace >= 1 ? fit : slow).push({ p, pace, skill: A.skillOf(p, skill) });
  }
  const order = (a: Candidate, b: Candidate): number => b.skill - a.skill || b.p.trained.int - a.p.trained.int || a.p.id - b.p.id;
  fit.sort(order); slow.sort(order);
  return { fit: fit.slice(0, 10), slow: slow.slice(0, 6) };
}

/** Everyone grown who lives in the realm's own settlements. */
function realmPeople(R: Rlm, sc: RealmScope): Person[] {
  const out: Person[] = [];
  for (const sid of sc.direct) {
    for (const p of R.state.residentsOf(sid)) {
      if (out.length >= 4000) return out;
      if (!p.death && ageYears(p, R.day) >= 14) out.push(p);
    }
  }
  return out;
}

function busyResearchers(R: Rlm): Set<PersonId> {
  const busy = new Set<PersonId>();
  for (const pr of R.data.projects) if (pr.state === 'active' || pr.state === 'stalled') busy.add(pr.researcher);
  return busy;
}

// ---------------------------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------------------------

/** Goods the pool lacks for a price (good → amount short). */
function shortOf(pool: Pool, goods: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const g of Object.keys(goods).sort()) {
    const have = pool.count(g);
    if (have + 0.004 < goods[g]) out[g] = round2(goods[g] - have);
  }
  return out;
}

/** What buying the goods now would cost at a market (pence), with the merchant's profit. */
function buyPrice(R: Rlm, settlement: number, short: Readonly<Record<string, number>>): number {
  let sum = 0;
  for (const g of Object.keys(short)) {
    const quote = R.economy.price(settlement, `${g}`, 'buy');
    const unit = quote > 0 ? quote : R.economy.good(g)?.basePrice ?? 1;
    sum += unit * short[g];
  }
  return round2(sum * RESEARCH.buyPremium);
}

function describeShort(R: Rlm, pool: Pool, goods: Readonly<Record<string, number>>, short: Readonly<Record<string, number>>): string {
  const parts = Object.keys(short).map((g) => `${Math.ceil(goods[g])} ${R.economy.good(g)?.name.toLowerCase() ?? g} (you have ${Math.floor(pool.count(g))})`);
  return `Needs ${parts.join(', ')}`;
}

// ---------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------

export function researchOptions(R: Rlm, personId: PersonId): ResearchOption[] {
  const rt = R.tech;
  const sc = scopeOf(R, personId);
  if (!rt || !sc) return [];
  const A = rt.adv;
  const allowed = mayCommand(R, personId, 'realm') !== null && sc.role !== 'reeve';
  const people = realmPeople(R, sc);
  const candsOf = new Map<number, readonly TechDef[]>();
  for (const p of people) candsOf.set(p.id, A.candidates(p));
  const busy = busyResearchers(R);
  const pool = poolOf(R, sc);
  const purse = sc.treasury?.purse ?? 0;
  const running = R.data.projects.filter((pr) => pr.house === sc.house && (pr.state === 'active' || pr.state === 'stalled'));
  const out: ResearchOption[] = [];
  for (const def of rt.techs()) {
    if (!def.research) continue;
    if (A.houseHas(sc.house, def.id)) continue;
    if (def.requires.some((r) => !A.houseHas(sc.house, r))) continue;
    const res = def.research;
    const { fit, slow } = researchersFor(R, A, def, people, candsOf, busy);
    const places = placesFor(R, def, sc.direct);
    const short = shortOf(pool, res.goods);
    const hasShort = Object.keys(short).length > 0;
    const settlement = places.length ? R.state.buildings.get(places[0])?.settlement ?? sc.direct[0] : sc.direct[0];
    const buyCost = hasShort && settlement !== undefined ? buyPrice(R, settlement, short) : 0;
    let reason: string | undefined;
    let buyable = false;
    if (!allowed) reason = 'Only the lord, or his steward when he cannot act, commissions research';
    else if (def.year !== undefined && R.sim.absDay / 16 < def.year) reason = `Nobody can work this out before year ${def.year}`;
    else if (running.some((pr) => pr.tech === def.id)) reason = 'Already under way';
    else if (running.length >= RESEARCH.maxProjects) reason = `Your scholars are busy with ${running.length} works already`;
    else if (fit.length + slow.length === 0) reason = 'Nobody in your lands could work it out';
    else if (places.length === 0) reason = `You have no ${placeWords(def.research.place)} to work in`;
    else if (purse + 1e-9 < res.pence) reason = `Needs ${formatMoney(res.pence)}; the treasury holds ${formatMoney(purse)}`;
    else if (hasShort) { reason = describeShort(R, pool, res.goods, short); buyable = !!R.economy.procure && purse + 1e-9 >= res.pence + buyCost; }
    let days: number | undefined;
    const best = fit[0] ?? slow[0];
    const bplace = places.length ? R.state.buildings.get(places[0]) : undefined;
    if (best && bplace) days = Math.ceil(1 / rateOf(R, A, best.p, def, bplace, best.pace));
    const o: ResearchOption = {
      tech: def.id, name: def.name, branch: def.branch,
      cost: { goods: { ...res.goods }, pence: res.pence, days: res.days },
      researchers: [...fit, ...slow].map((c) => c.p.id), places,
      ok: reason === undefined,
    };
    if (reason) o.reason = reason;
    if (slow.length) o.slow = slow.map((c) => c.p.id);
    if (hasShort) { o.short = short; o.buyCost = buyCost; o.buyable = buyable; }
    if (days !== undefined) o.days = days;
    out.push(o);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Start, stop, view
// ---------------------------------------------------------------------------------------------

export function startResearch(R: Rlm, personId: PersonId, tech: string, researcherId: PersonId, buildingId: number, opts?: { buy?: boolean }): Result & { project?: number } {
  const rt = R.tech;
  if (!rt) return fail('There is no learning in this land');
  const A = rt.adv;
  const def = rt.tech(tech);
  if (!def || !def.research) return fail('Nobody knows how to set about that');
  const sc = scopeOf(R, personId);
  if (!sc || sc.role === 'reeve') return fail('You rule nothing that could do such work');
  if (!mayCommand(R, personId, 'realm')) return fail('Only the lord, or his steward when he cannot act, commissions research');
  const treasury = sc.treasury;
  if (!treasury) return fail('There is no treasury to pay from');
  const res = def.research;
  if (A.houseHas(sc.house, def.id)) return fail('Your House already commands it');
  const missing = def.requires.filter((r) => !A.houseHas(sc.house, r));
  if (missing.length) return fail(`First needs ${names(missing, R)}`);
  if (def.year !== undefined && R.sim.absDay / 16 < def.year) return fail(`Nobody can work this out before year ${def.year}`);
  const running = R.data.projects.filter((pr) => pr.house === sc.house && (pr.state === 'active' || pr.state === 'stalled'));
  if (running.some((pr) => pr.tech === def.id)) return fail('Already under way');
  if (running.length >= RESEARCH.maxProjects) return fail(`Your scholars are busy with ${running.length} works already`);

  // the place
  const places = placesFor(R, def, sc.direct);
  let building = buildingId >= 0 ? R.state.buildings.get(buildingId) : undefined;
  if (buildingId >= 0) {
    if (!building || building.construction < 1 || building.damage >= 0.9) return fail('That building cannot be worked in');
    if (!places.includes(building.id)) return fail(`That is no place for it: it is worked in a ${placeWords(res.place)}`);
  } else {
    building = places.length ? R.state.buildings.get(places[0]) : undefined;
    if (!building) return fail(`You have no ${placeWords(res.place)} to work in`);
  }

  // the researcher
  const people = realmPeople(R, sc);
  const candsOf = new Map<number, readonly TechDef[]>();
  const busy = busyResearchers(R);
  let researcher: Person | undefined;
  let pace = 0;
  if (researcherId > 0) {
    researcher = R.person(researcherId);
    if (!researcher || researcher.death) return fail('Nobody there');
    if (busy.has(researcher.id)) return fail(`${researcher.first} is at another work already`);
    if (!people.some((p) => p.id === researcher?.id)) return fail(`${researcher.first} does not live in your lands`);
    pace = paceOf(R, A, researcher, def);
    if (pace <= 0) return fail(`${researcher.first} could not work that out: it wants a ${def.learn.skill ?? 'learned'} hand`);
  } else {
    for (const p of people) candsOf.set(p.id, A.candidates(p));
    const { fit, slow } = researchersFor(R, A, def, people, candsOf, busy);
    const best = fit[0] ?? slow[0];
    if (!best) return fail('Nobody in your lands could work it out');
    researcher = best.p; pace = best.pace;
  }

  // the price: coin first, then the goods from the stores, or bought
  const pool = poolOf(R, sc);
  if (treasury.purse + 1e-9 < res.pence) return fail(`Needs ${formatMoney(res.pence)}; the treasury holds ${formatMoney(treasury.purse)}`);
  const short = shortOf(pool, res.goods);
  const lacking = Object.keys(short).length > 0;
  const wantsBuy = opts?.buy === true;
  if (lacking && !wantsBuy) return fail(describeShort(R, pool, res.goods, short));
  if (lacking && !R.economy.procure) return fail(`${describeShort(R, pool, res.goods, short)}, and there is no merchant to buy it from`);

  // the goods that must be bought: the price of the work and of the goods are both to be found in the treasury, and the market must have some
  const carts: Array<[number, string, number]> = [];
  let waitDays = 0;
  if (lacking) {
    const quote = buyPrice(R, building.settlement, short);
    if (treasury.purse + 1e-9 < res.pence + quote) return fail(`Needs ${formatMoney(res.pence)} and about ${formatMoney(quote)} for the goods; the treasury holds ${formatMoney(treasury.purse)}`);
    let any = false;
    for (const g of Object.keys(short).sort()) {
      const order = orderGoods(R, treasury, g, short[g], building.settlement);
      if (order && order.got > 0) { any = true; carts.push([R.day + order.days, g, order.got]); waitDays = Math.max(waitDays, order.days); }
    }
    if (!any) return fail(`The market has none of the ${Object.keys(short).sort().map((g) => R.economy.good(g)?.name.toLowerCase() ?? g).join(', ')} to sell`);
  }

  // pay: the coin, and the goods the stores hold
  if (treasury.purse + 1e-9 < res.pence) return fail(`Needs ${formatMoney(res.pence)}; the treasury holds ${formatMoney(treasury.purse)} after buying the goods`);
  treasury.purse = round2(treasury.purse - res.pence);
  R.state.touchHousehold(treasury);
  bookOut(R, treasury.id, res.pence, 'Research');
  for (const g of Object.keys(res.goods).sort()) {
    const have = Math.min(pool.count(g), res.goods[g]);
    if (have > 0) pool.take(g, have);
  }
  const rec: ProjectRec = {
    id: R.data.seq.project++, tech: def.id, house: sc.house, household: treasury.id, ruler: personId,
    researcher: researcher.id, building: building.id, settlement: building.settlement,
    progress: 0, rate: 0, pace, state: 'active', note: '', started: Math.floor(R.day), ended: -1,
    pence: res.pence, goods: { ...res.goods }, needs: {}, cart: carts, due: 0, buy: wantsBuy, still: -1, chk: Math.floor(R.day),
  };
  if (lacking) {
    // the work begins when the carts have come
    for (const g of Object.keys(short).sort()) rec.needs[g] = short[g];
    rec.due = Math.floor(R.day) + Math.max(RESEARCH.reorderDays, Math.ceil(waitDays));
    rec.state = 'stalled';
    rec.still = Math.floor(R.day);
    rec.note = waitingNote(R, rec);
  }
  R.data.projects.push(rec);
  R.touch();
  R.sim.events.emit('research', { phase: 'started', project: rec.id, tech: def.id, house: rec.house, researcher: rec.researcher });
  if (R.isPlayersHouse(rec.house)) R.notify(`${R.name(rec.researcher)} sets about ${def.name.toLowerCase()} at ${R.placeName(rec.settlement)}.`, 'info');
  addNews(R, { kind: 'research', house: rec.house, settlement: rec.settlement, text: `${R.houseName(rec.house)} has set ${R.name(rec.researcher)} to work out ${def.name.toLowerCase()}`, weight: 0.3, tech: def.id });
  return { ok: true, project: rec.id };
}

/** Orders goods at the market of a settlement for a household; the answer says how much came, what it cost and how long the carting takes. */
function orderGoods(R: Rlm, hh: Household, good: string, qty: number, settlement: number): { got: number; days: number } | null {
  const procure = R.economy.procure;
  if (!procure) return null;
  const before = hh.purse;
  const r = procure.call(R.economy, hh.id, good, Math.ceil(qty), { settlement });
  const paid = round2(before - hh.purse);
  if (paid > 0) bookOut(R, hh.id, paid, 'Goods bought');
  return { got: r.got, days: r.days };
}

/** What the project waits for: the goods still to come, and which are already on the road. */
function waitingNote(R: Rlm, rec: ProjectRec): string {
  const parts = Object.keys(rec.needs).sort().map((g) => {
    const road = rec.cart.reduce((s, c) => s + (c[1] === g ? c[2] : 0), 0);
    const name = R.economy.good(g)?.name.toLowerCase() ?? g;
    return road > 0.004 ? `${Math.ceil(rec.needs[g])} ${name} (${Math.ceil(Math.min(road, rec.needs[g]))} on the road)` : `${Math.ceil(rec.needs[g])} ${name}`;
  });
  return parts.length ? `Waiting for ${parts.join(', ')}` : '';
}

export function stopResearch(R: Rlm, personId: PersonId, projectId: number): Result {
  const rec = R.data.projects.find((p) => p.id === projectId);
  if (!rec || (rec.state !== 'active' && rec.state !== 'stalled')) return fail('That work is over');
  const sc = scopeOf(R, personId);
  if (!sc || sc.house !== rec.house || !mayCommand(R, personId, 'realm')) return fail('It is not your work to stop');
  abandon(R, rec, 'stopped by order');
  return { ok: true };
}

/** Gives a project up; part of what it cost goes back to the treasury. */
function abandon(R: Rlm, rec: ProjectRec, why: string): void {
  const hh = R.state.households.get(rec.household);
  const back = RESEARCH.refund * (1 - rec.progress);
  if (hh && back > 0) {
    const pence = round2(rec.pence * back);
    hh.purse = round2(hh.purse + pence);
    bookIn(R, hh.id, pence, 'Research refunded');
    for (const g of Object.keys(rec.goods).sort()) {
      // only goods that were really taken (not the part still on order) come back
      const taken = Math.max(0, rec.goods[g] - (rec.needs[g] ?? 0));
      const q = Math.floor(taken * back);
      if (q > 0) bagAdd(hh.stores, R.economy.good(g)?.quality ? `${g}#1` : g, q);
    }
    R.state.touchHousehold(hh);
  }
  rec.state = 'abandoned';
  rec.ended = Math.floor(R.day);
  rec.note = why;
  rec.needs = {};
  prune(R);
  R.touch();
  const def = R.tech?.tech(rec.tech);
  R.sim.events.emit('research', { phase: 'abandoned', project: rec.id, tech: rec.tech, house: rec.house, researcher: rec.researcher });
  if (R.isPlayersHouse(rec.house)) R.notify(`The work on ${def?.name.toLowerCase() ?? rec.tech} is given up (${why}).`, 'warn');
}

function prune(R: Rlm): void {
  const done = R.data.projects.filter((p) => p.state === 'done' || p.state === 'abandoned');
  if (done.length <= 16) return;
  const drop = new Set(done.slice(0, done.length - 16).map((p) => p.id));
  R.data.projects = R.data.projects.filter((p) => !drop.has(p.id));
}

export function projectView(R: Rlm, rec: ProjectRec): ResearchProject {
  const def = R.tech?.tech(rec.tech);
  const active = rec.state === 'active' && rec.rate > 0;
  const v: ResearchProject = {
    id: rec.id, tech: rec.tech, name: def?.name ?? rec.tech, house: rec.house, researcher: rec.researcher, building: rec.building,
    progress: rec.progress,
    eta: rec.state === 'done' ? rec.ended : active ? R.day + (1 - rec.progress) / rec.rate : Infinity,
    state: rec.state, started: rec.started, rate: rec.rate, settlement: rec.settlement, paid: rec.pence,
  };
  if (rec.note) v.note = rec.note;
  if (Object.keys(rec.needs).length) v.needs = { ...rec.needs };
  return v;
}

export function projectsOf(R: Rlm, house?: HouseId): ResearchProject[] {
  const out: ResearchProject[] = [];
  for (const rec of R.data.projects) if (house === undefined || rec.house === house) out.push(projectView(R, rec));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Daily work
// ---------------------------------------------------------------------------------------------

/** The best other person to take over a work whose researcher is gone. */
function replacement(R: Rlm, A: Adv, rec: ProjectRec, def: TechDef): Person | undefined {
  const treasury = R.state.households.get(rec.household);
  const settlements = treasury ? [treasury.settlement, rec.settlement] : [rec.settlement];
  const busy = busyResearchers(R);
  const people: Person[] = [];
  for (const sid of new Set(settlements)) for (const p of R.state.residentsOf(sid)) if (!p.death && ageYears(p, R.day) >= 14) people.push(p);
  const candsOf = new Map<number, readonly TechDef[]>();
  const { fit, slow } = researchersFor(R, A, def, people, candsOf, busy);
  return (fit[0] ?? slow[0])?.p;
}

/** Once a day: goods come in, the work moves on, finished works are handed over, stalled ones given up. */
export function researchDaily(R: Rlm, shard = 0, shards = 1): void {
  const rt = R.tech;
  if (!rt || R.data.projects.length === 0) return;
  const A = rt.adv;
  const today = Math.floor(R.day);
  let changed = false;
  for (const rec of R.data.projects.slice()) {
    if (rec.state !== 'active' && rec.state !== 'stalled') continue;
    if (rec.id % shards !== shard) continue;
    const def = rt.tech(rec.tech);
    const building = R.state.buildings.get(rec.building);
    const treasury = R.state.households.get(rec.household);
    if (!def || !def.research) { abandon(R, rec, 'the technique is unknown'); changed = true; continue; }
    const wasStalled = rec.state === 'stalled';
    let why = '';
    let researcher = R.person(rec.researcher);
    // every day: is the place standing, the treasury there, the researcher alive and free? Every eight days (and whenever the
    // work stands still) the fuller check: is the place still the House's, is the man still fit to do it
    const free = !!researcher && !researcher.death && !researcher.flags.captive && !researcher.flags.outlaw && !researcher.flags.exile;
    if (!building || building.construction < 1 || building.damage >= 0.9) why = 'The place is ruined';
    else if (!treasury) why = 'The treasury is gone';
    if (!why && (wasStalled || !free || today - rec.chk >= 8)) {
      rec.chk = today;
      const lord = titleAtSettlement(R, rec.settlement);
      const holderHouse = lord ? R.person(lord.holder)?.house ?? 0 : 0;
      if (holderHouse !== rec.house) why = 'The place is lost to the House';
      else if (!researcher || paceOf(R, A, researcher, def) <= 0) {
        const next = replacement(R, A, rec, def);
        if (next) {
          const old = R.name(rec.researcher);
          rec.researcher = next.id; rec.pace = paceOf(R, A, next, def); researcher = next; changed = true;
          if (R.isPlayersHouse(rec.house)) R.notify(`${R.name(next.id)} takes over the work on ${def.name.toLowerCase()} from ${old}.`, 'info');
        } else why = 'No one is left to do the work';
      }
    }

    // goods that were ordered come in, or are ordered again
    if (!why && treasury && Object.keys(rec.needs).length > 0) {
      rec.cart = rec.cart.filter((c) => c[0] > R.day);
      const pool = new Pool(R.state, realmHouseholds(R, rec.house, treasury, [rec.settlement, treasury.settlement]));
      for (const g of Object.keys(rec.needs).sort()) {
        const took = pool.take(g, rec.needs[g]).reduce((s, [, q]) => s + q, 0);
        if (took > 0) { rec.needs[g] = round2(rec.needs[g] - took); changed = true; }
        if (rec.needs[g] <= 0.004) delete rec.needs[g];
      }
      if (Object.keys(rec.needs).length > 0) {
        if (rec.buy && today >= rec.due && R.economy.procure) {
          // order what is not already on the road
          let days = 0;
          for (const g of Object.keys(rec.needs).sort()) {
            const road = rec.cart.reduce((s, c) => s + (c[1] === g ? c[2] : 0), 0);
            const want = rec.needs[g] - road;
            if (want < 0.5) continue;
            const o = orderGoods(R, treasury, g, want, rec.settlement);
            if (o && o.got > 0) { rec.cart.push([R.day + o.days, g, o.got]); days = Math.max(days, o.days); }
          }
          rec.due = today + Math.max(Math.ceil(days), RESEARCH.reorderDays);
          changed = true;
        }
        why = waitingNote(R, rec);
      }
    }

    if (why) {
      rec.state = 'stalled'; rec.note = why; rec.rate = 0;
      if (rec.still < 0) rec.still = today;
      if (!wasStalled) {
        R.sim.events.emit('research', { phase: 'stalled', project: rec.id, tech: rec.tech, house: rec.house, researcher: rec.researcher });
        if (R.isPlayersHouse(rec.house)) R.notify(`The work on ${def.name.toLowerCase()} stands still: ${why.toLowerCase()}.`, 'warn');
      }
      changed = true;
      if (today - rec.still >= RESEARCH.stallDays) abandon(R, rec, 'it stood still too long');
      continue;
    }

    // work
    if (rec.state !== 'active') { rec.state = 'active'; rec.note = ''; rec.still = -1; changed = true; }
    const r = rateOf(R, A, researcher as Person, def, building as { level: number; settlement: number }, rec.pace);
    rec.rate = Math.round(r * 10000) / 10000;
    rec.progress = Math.min(1, Math.round((rec.progress + r) * 10000) / 10000);
    changed = true;
    if (rec.progress >= 1) finish(R, A, rec, def, researcher as Person);
  }
  if (changed) R.touch();
}

/** The work is done: the researcher and the ruler know the technique, and the House commands it. */
function finish(R: Rlm, A: Adv, rec: ProjectRec, def: TechDef, researcher: Person): void {
  rec.state = 'done';
  rec.ended = Math.floor(R.day);
  rec.rate = 0;
  rec.note = '';
  // the ruler first (his House commands what he knows), then the man who worked it out
  const ruler = R.alive(rec.ruler);
  const holder = R.alive(R.state.households.get(rec.household)?.head ?? 0);
  for (const who of [ruler, holder]) if (who && who.id !== researcher.id && ageYears(who, R.day) >= 12) A.grant(who, def.id, 'research');
  A.grant(researcher, def.id, 'research');
  prune(R);
  R.touch();
  R.sim.events.emit('research', { phase: 'done', project: rec.id, tech: rec.tech, house: rec.house, researcher: rec.researcher });
  R.log('research', `${R.name(researcher.id)} worked out ${def.name.toLowerCase()} for ${R.houseName(rec.house)}.`, [researcher.id]);
  if (R.isPlayersHouse(rec.house)) R.notify(`${R.name(researcher.id)} has worked out ${def.name.toLowerCase()}: your House commands it now.`, 'gain');
  addNews(R, { kind: 'research', house: rec.house, settlement: rec.settlement, text: `${R.houseName(rec.house)}'s ${R.name(researcher.id)} has mastered ${def.name.toLowerCase()}`, weight: techWeight(def), tech: def.id });
}

/** How much a technique matters to a neighbour's safety (0..1): arms and fortification most, the arts least. */
export function techWeight(def: TechDef): number {
  const fx = def.effects;
  if (def.branch === 'military') return fx['defence.keep'] || fx['defence.walls'] || fx['defence.concentric'] || fx['siege.trebuchet'] || fx['siege.bombard'] ? 0.85 : 0.65;
  if (def.branch === 'kinship') return fx['diplomacy.alliance'] || fx['realm.council'] ? 0.4 : 0.2;
  return def.points >= 35 ? 0.3 : 0.15;
}
