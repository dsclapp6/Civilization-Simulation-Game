// Obligations (SPEC §4, §9): what the player's household owes the lord and the church, and how a serf
// gets free. Week-work on the demesne, boon-work at harvest, rent, the tithe (taken in kind when the
// crop is bound), merchet on a serf daughter's marriage, heriot at a tenant's death, fines, and
// freedom by purchase or by a year and a day in a chartered town.
import { DAYS_PER_YEAR } from '../../core/time';
import { dayOfWeek } from '../calendar';
import { CAREERS } from '../careers';
import { shiftFamilyRank } from '../succession';
import type { Household, Person, PersonId } from '../state';
import type { Econ, FineSave } from './core';
import { basePriceOf } from './data';
import { RENT_PER_STRIP } from './macro';
import { bagAdd, bagGet } from './items';
import type { Obligation, ObligationKind, Result } from './types';

export const MANUMISSION_PRICE = 120;
/** Days of week-work a serf owes in the weeks of a season (out of the three working days of a four-day week). */
export function weekWorkDays(E: Econ, p: Person): number {
  if (p.estate !== 'unfree' || E.age(p) < 14) return 0;
  const sea = Math.floor(E.dayOfYear / 4);
  return sea === 1 || sea === 2 ? 2 : 1;
}

export function merchetFee(E: Econ, father: Person): number {
  return father.rankTier <= 1 ? 36 : 60;
}

/** The week index a day belongs to (a week is one four-day season). */
const weekOf = (day: number): number => Math.floor(day / 4);

/** Credits a day of demesne work (or part of one) towards the week's dues. Returns the days done so far this week. */
export function creditWeekWork(E: Econ, p: Person, days: number): number {
  const k = String(p.id);
  const wk = weekOf(E.day);
  const cur = E.save.ww[k];
  const done = (cur && cur[0] === wk ? cur[1] : 0) + days;
  E.save.ww[k] = [wk, Math.round(done * 100) / 100];
  E.touchSave();
  return done;
}

export function weekWorkDone(E: Econ, p: Person): number {
  const cur = E.save.ww[String(p.id)];
  return cur && cur[0] === weekOf(E.day) ? cur[1] : 0;
}

// ---------------------------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------------------------

export function obligationsOf(E: Econ, personId: PersonId): Obligation[] {
  const p = E.person(personId);
  if (!p) return [];
  const out: Obligation[] = [];
  const hh = E.hhOf(p);
  const lord = E.lordOf(p.settlement);
  const lordId = lord?.person.id ?? 0;
  const day = E.day;
  const yearStart = Math.floor(day / DAYS_PER_YEAR) * DAYS_PER_YEAR;
  const push = (kind: ObligationKind, label: string, amount: number, unit: Obligation['unit'], due: number, to: PersonId, overdue = false): void => {
    out.push({ kind, label, amount: Math.round(amount * 100) / 100, unit, due, to, overdue });
  };

  // week-work and boon-work (unfree adults)
  const ww = weekWorkDays(E, p);
  if (ww > 0) {
    const left = Math.max(0, ww - weekWorkDone(E, p));
    const dueDay = (weekOf(day) + 1) * 4 - 1; // the holy day closes the week
    push('week_work', `Work the lord's land: ${ww} day${ww > 1 ? 's' : ''} this week`, left, 'days', dueDay, lordId);
    const sea = Math.floor(E.dayOfYear / 4);
    if (sea === 1 || sea === 2) push('boon_work', 'Boon-work at harvest: one extra day', 1, 'days', yearStart + 11, lordId);
  }

  // rent
  if (hh) {
    const { annual, next } = rentOf(E, hh);
    if (annual > 0) {
      const lastPaid = E.save.paid[String(hh.id)] ?? -1;
      const term = Math.floor(day / 8);
      push('rent', `Rent: ${Math.round(annual * 100) / 100}d a year, half at each term`, annual / 2, 'pence', next, lordId, lastPaid < term - 1);
    }
    // tithe: a tenth of what the strips will give
    const exp = expectedHarvest(E, hh);
    if (exp > 0) push('tithe', 'Tithe: every tenth sheaf to the parish church', Math.round(exp * 0.1 * 10) / 10, 'goods', yearStart + 6, 0);
    // heriot and merchet as warnings
    const best = bestBeast(hh);
    if (best && (p.estate === 'unfree' || E.save.tenure[String(hh.id)] === 'lease') && hh.head === p.id) {
      push('heriot', `Heriot: your best beast (${best.key.split('#')[0]}) goes to the lord when you die`, best.value, 'pence', -1, lordId);
    }
    if (p.sex === 'f' && p.estate === 'unfree' && !p.spouse && E.age(p) >= 15) {
      push('merchet', 'Merchet: a fee to the lord when you marry', merchetFee(E, p), 'pence', -1, lordId);
    }
    // wages owed to helpers
    let wages = 0;
    for (const h of E.save.helpers) if (h.hh === hh.id) wages += h.wage;
    if (wages > 0) push('wage', 'Wages of your hired helpers (daily)', wages, 'pence', Math.floor(day) + 1, 0);
  }
  if (p.estate === 'unfree' || p.estate === 'free') push('mill_fee', "The lord's mill takes one grain in sixteen as multure", 6.25, 'goods', -1, lordId);
  if (p.estate === 'unfree') push('toll', 'A serf who sells off the manor pays the lord a fine', 3, 'pence', -1, lordId);

  for (const f of E.save.fines[String(personId)] ?? []) {
    push('fine', f.reason, f.amount, 'pence', f.due, f.to, f.due < day);
  }
  return out;
}

function bestBeast(hh: Household): { key: string; value: number } | null {
  let best: { key: string; value: number } | null = null;
  for (const k of Object.keys(hh.stores)) {
    const good = k.split('#')[0];
    if (!['ox', 'horse', 'cow', 'pig', 'sheep', 'goat'].includes(good)) continue;
    if (hh.stores[k] <= 0) continue;
    const v = basePriceOf(k);
    if (!best || v > best.value) best = { key: k, value: v };
  }
  return best;
}

function expectedHarvest(E: Econ, hh: Household): number {
  let n = 0;
  const s = E.settlementById.get(hh.settlement);
  if (!s) return 0;
  for (const id of s.strips) {
    const st = E.state.strips.get(id);
    if (st && st.holder === hh.id && (st.state === 'sown' || st.state === 'growing' || st.state === 'ripe')) n++;
  }
  return n * 20;
}

/** Annual money rent of a household (leased strips and a rented house), and the next term day. */
export function rentOf(E: Econ, hh: Household): { annual: number; next: number } {
  let annual = 0;
  const s = E.settlementById.get(hh.settlement);
  if (s) {
    for (const id of s.strips) {
      const st = E.state.strips.get(id);
      if (st && st.holder === hh.id) annual += E.save.lease[String(id)] ?? 0;
    }
  }
  if (hh.home >= 0) annual += E.save.lease[`b${hh.home}`] ?? 0;
  const day = E.day;
  const next = (Math.floor(day / 8) + 1) * 8;
  return { annual, next };
}

// ---------------------------------------------------------------------------------------------
// Fines
// ---------------------------------------------------------------------------------------------

export function addFine(E: Econ, p: Person, amount: number, reason: string, to: PersonId): void {
  const key = String(p.id);
  const list = E.save.fines[key] ?? (E.save.fines[key] = []);
  const f: FineSave = { amount: Math.round(amount * 100) / 100, reason, day: Math.floor(E.day), due: Math.floor(E.day) + 4, to };
  list.push(f);
  E.touchSave();
  if (E.isPlayer(p.id)) E.notify(`Fined ${f.amount}d: ${reason}. It falls due in four days.`, 'warn', p.id);
  const lord = to ? E.person(to) : undefined;
  if (lord) E.social.adjustOpinion(lord.id, p.id, -2, reason);
}

export function payFine(E: Econ, p: Person, index = 0): Result {
  const key = String(p.id);
  const list = E.save.fines[key];
  const f = list?.[index];
  if (!list || !f) return { ok: false, reason: 'You owe no fine' };
  if (!E.spend(p, f.amount, `Fine: ${f.reason}`, true)) return { ok: false, reason: `You need ${f.amount}d` };
  const lord = f.to ? E.person(f.to) : undefined;
  if (lord) E.credit(E.hhOf(lord), f.amount);
  list.splice(index, 1);
  if (list.length === 0) delete E.save.fines[key];
  E.touchSave();
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Daily bookkeeping for the player's household
// ---------------------------------------------------------------------------------------------

/** Called once a day: rent terms, week-work at the end of a week, unpaid fines, runaways, helpers' wages. */
export function obligationsDaily(E: Econ): void {
  const p = E.person(E.playerId);
  if (!p || p.death || E.state.run.phase !== 'alive') return;
  const day = E.day;
  const dayNo = Math.floor(day);
  const wk = weekOf(day);
  const hh = E.hhOf(p);
  const lord = E.lordOf(p.settlement);

  // the new week begins: judge the last one
  if (E.save.last.week !== wk) {
    const prev = E.save.last.week;
    E.save.last.week = wk;
    if (prev >= 0) judgeWeek(E, p, prev, lord?.person);
    E.touchSave();
  }
  // a reminder on the mornings the reeve expects you
  const ww = weekWorkDays(E, p);
  if (ww > 0 && dayOfWeek(day) <= 3) {
    const left = ww - weekWorkDone(E, p);
    if (left > 0.05) {
      E.notify(`The reeve expects you to work the lord's land (${Math.ceil(left)} day${left > 1 ? 's' : ''} still owed this week).`, 'quest', p.id, 'week_work');
    }
  }

  // rent on the first day of spring and of autumn
  if (hh && hh.head === p.id) {
    const term = Math.floor(day / 8);
    const { annual } = rentOf(E, hh);
    const last = E.save.paid[String(hh.id)] ?? -1;
    if (annual > 0 && last < term && E.dayOfYear % 8 < 1) {
      const due = annual / 2;
      if (E.spend(p, due, 'Rent', true)) {
        E.credit(lord?.household, due);
        E.save.paid[String(hh.id)] = term;
        E.touchSave();
        E.notify(`You pay ${Math.round(due * 100) / 100}d rent.`, 'info', p.id);
      } else if (last < term - 1) {
        // two terms behind: the lord takes the land back
        evictLand(E, hh, p);
        E.save.paid[String(hh.id)] = term;
      } else {
        E.notify(`You cannot pay the ${Math.round(due * 100) / 100}d rent that is due. The bailiff will call again.`, 'warn', p.id);
      }
    }
  }
  // fines come due
  const fines = E.save.fines[String(p.id)];
  if (fines) {
    for (let i = fines.length - 1; i >= 0; i--) {
      const f = fines[i];
      if (f.due <= dayNo) {
        if (payFine(E, p, i).ok) E.notify(`You pay the ${f.amount}d fine.`, 'loss', p.id);
        else { f.amount = Math.round(f.amount * 1.1 * 100) / 100; f.due = dayNo + 4; E.touchSave(); E.notify(`The ${f.reason.toLowerCase()} fine grows to ${f.amount}d.`, 'warn', p.id); }
      }
    }
  }
  // runaways
  const fug = E.save.fug[String(p.id)];
  if (fug) {
    const town = E.settlementById.get(fug.town);
    if (!town || p.settlement !== fug.town) { delete E.save.fug[String(p.id)]; E.touchSave(); }
    else if (day - fug.since >= DAYS_PER_YEAR + 1) {
      delete E.save.fug[String(p.id)];
      freeHousehold(E, p, 'Stadtluft macht frei: a year and a day in the town, unclaimed. You are free.');
    } else if (dayNo % 4 === 0 && E.rng('claim').chance(0.07)) {
      claimFugitive(E, p, fug.from);
    }
  }
}

function judgeWeek(E: Econ, p: Person, week: number, lord: Person | undefined): void {
  if (p.estate !== 'unfree' || E.age(p) < 14) return;
  const cur = E.save.ww[String(p.id)];
  const done = cur && cur[0] === week ? cur[1] : 0;
  const midday = week * 4 + 2;
  const sea = Math.floor((((midday % DAYS_PER_YEAR) + DAYS_PER_YEAR) % DAYS_PER_YEAR) / 4);
  const owed = sea === 1 || sea === 2 ? 2 : 1;
  const short = owed - done;
  if (short > 0.34) {
    const fine = Math.round(short * 3 * 100) / 100;
    addFine(E, p, fine, `Week-work not done (${Math.round(short * 10) / 10} day${short > 1.05 ? 's' : ''} short)`, lord?.id ?? 0);
  } else if (done >= owed + 0.9 && lord) {
    E.social.adjustOpinion(lord.id, p.id, 2, 'worked the lord\'s land');
  }
  delete E.save.ww[String(p.id)];
  E.touchSave();
}

function evictLand(E: Econ, hh: Household, p: Person): void {
  const s = E.settlementById.get(hh.settlement);
  let n = 0;
  if (s) {
    for (const id of s.strips) {
      const st = E.state.strips.get(id);
      if (st && st.holder === hh.id && (E.save.lease[String(id)] ?? 0) > 0) {
        st.holder = 0;
        E.state.touchStrip(st);
        delete E.save.lease[String(id)];
        n++;
      }
    }
  }
  E.touchSave();
  if (n > 0) E.notify(`Two terms unpaid: the bailiff takes back ${n} leased strip${n > 1 ? 's' : ''}.`, 'danger', p.id);
}

// ---------------------------------------------------------------------------------------------
// Freedom
// ---------------------------------------------------------------------------------------------

export function manumissionPrice(E: Econ, p: Person): number {
  return Math.round(MANUMISSION_PRICE * (1 + 0.15 * Math.min(4, (p.rankTier >= 2 ? 1 : 0) + (E.hhOf(p)?.members.length ?? 1) / 8)));
}

function freeHousehold(E: Econ, head: Person, message: string): void {
  const hh = E.hhOf(head);
  const members = hh ? hh.members.map((id) => E.person(id)).filter((m): m is Person => !!m && !m.death) : [head];
  for (const m of members) {
    if (m.estate === 'unfree') { m.estate = 'free'; E.state.touch(m); }
  }
  if (head.rankTier < 2) shiftFamilyRank(E.sim, head, 2);
  for (const m of members) if (m.rankTier < 2 && m.id !== head.id && (m.spouse === head.id || m.father === head.id || m.mother === head.id)) { m.rankTier = 2; E.state.touch(m); }
  E.deed('freedom', 80, 'Won freedom from serfdom');
  E.notify(message, 'gain', head.id);
  E.state.log(E.day, 'freedom', `${head.first} ${head.byname} is a free man.`.replace('man', head.sex === 'f' ? 'woman' : 'man'), [head.id]);
}

export function buyFreedom(E: Econ, p: Person): Result {
  if (p.estate !== 'unfree') return { ok: false, reason: 'You are already free' };
  const hh = E.hhOf(p);
  if (!hh || hh.head !== p.id) return { ok: false, reason: 'Only the head of the household can buy its freedom' };
  const price = manumissionPrice(E, p);
  const lord = E.lordOf(p.settlement);
  if (!E.spend(p, price, 'Manumission', true)) return { ok: false, reason: `Freedom costs ${price}d` };
  if (lord?.household) E.credit(lord.household, price);
  if (lord) E.social.adjustOpinion(lord.person.id, p.id, 3, 'bought freedom');
  freeHousehold(E, p, `You buy your freedom for ${price}d. The lord's seal makes you and yours free.`);
  return { ok: true };
}

/** Leaves the manor for a chartered town; a year and a day there unclaimed makes you free. */
export function fleeToTown(E: Econ, p: Person, town: number): Result {
  if (p.estate !== 'unfree') return { ok: false, reason: 'You are not bound to a lord' };
  const s = E.settlementById.get(town);
  if (!s || (s.kind !== 'town' && s.kind !== 'city')) return { ok: false, reason: 'Only a chartered town shelters a runaway' };
  if (s.id === p.settlement) return { ok: false, reason: 'That is where your lord lives' };
  if (E.save.fug[String(p.id)]) return { ok: false, reason: 'You are already hiding in a town' };
  const from = p.settlement;
  const old = E.hhOf(p);
  E.state.leaveHousehold(p);
  if (old && old.members.length > 0) E.state.setHead(old, old.members.map((id) => E.person(id)).filter((m): m is Person => !!m && !m.death).sort((a, b) => a.birthDay - b.birthDay)[0] ?? null);
  const lodging = E.state.addHousehold({ id: E.state.households.alloc(), kind: 'family', head: 0, members: [], home: -1, settlement: s.id, purse: 0, stores: {} });
  E.state.joinHousehold(p, lodging);
  E.state.setHead(lodging, p);
  const home = (E.state.buildingsAt.get(s.id) ?? []).find((b) => (b.kind === 'hovel' || b.kind === 'cottage') && !b.household);
  if (home) E.state.setHome(lodging, home.id);
  E.save.fug[String(p.id)] = { since: Math.floor(E.day), town: s.id, from };
  E.touchSave();
  E.state.touch(p);
  const lord = E.lordOf(from);
  if (lord) E.social.adjustOpinion(lord.person.id, p.id, -25, 'ran away');
  E.notify(`You slip away to ${s.name}. If you live there a year and a day unclaimed, you will be free.`, 'quest', p.id);
  return { ok: true };
}

function claimFugitive(E: Econ, p: Person, from: number): void {
  const lord = E.lordOf(from);
  const fine = 60;
  delete E.save.fug[String(p.id)];
  E.touchSave();
  E.notify('The lord\'s reeve finds you and claims you back to the manor. You are fined for running away.', 'danger', p.id);
  const home = E.state.householdList(from)[0];
  if (home) {
    E.state.leaveHousehold(p);
    E.state.joinHousehold(p, home);
  }
  addFine(E, p, fine, 'Running from the manor', lord?.person.id ?? 0);
}

// ---------------------------------------------------------------------------------------------
// Events: merchet and heriot
// ---------------------------------------------------------------------------------------------

export function attachObligationEvents(E: Econ): () => void {
  const offMarriage = E.sim.events.on('marriage', (e) => {
    const a = E.person(e.a), b = E.person(e.b);
    if (!a || !b) return;
    const bride = a.sex === 'f' ? a : b;
    const father = bride.father ? E.person(bride.father) : undefined;
    if (!father || father.estate !== 'unfree') return;
    const fee = merchetFee(E, father);
    const lord = E.lordOf(father.settlement);
    const payerHH = E.hhOf(father) ?? E.hhOf(bride);
    if (!payerHH) return;
    const involvesPlayer = E.isPlayer(father.id) || E.isPlayer(bride.id) || payerHH.members.some((id) => E.isPlayer(id));
    const taken = involvesPlayer && E.isPlayer(payerHH.head) ? (E.spend(E.person(payerHH.head) as Person, fee, 'Merchet', true) ? fee : 0) : E.debit(payerHH, fee);
    if (taken > 0 && lord?.household) E.credit(lord.household, taken);
    if (involvesPlayer) E.notify(`Merchet: ${Math.round(taken)}d paid to the lord for the marriage of a serf's daughter.`, 'loss');
  });
  const offDeath = E.sim.events.on('death', (e) => {
    if (!e.wasHead) return;
    const dead = E.person(e.person);
    if (!dead || dead.estate === 'noble' || dead.estate === 'clergy' || dead.rankTier > 3) return;
    // the household that carries on is the spouse's or the eldest living child's
    const heir = dead.spouse ? E.person(dead.spouse) : undefined;
    const kids = dead.children.map((id) => E.person(id)).filter((c): c is Person => !!c && !c.death && c.household !== 0);
    const target = heir && !heir.death && heir.household ? E.household(heir.household) : kids[0] ? E.household(kids[0].household) : undefined;
    if (!target) return;
    const tenant = dead.estate === 'unfree' || E.save.tenure[String(target.id)] === 'lease';
    if (!tenant) return;
    const best = bestBeast(target);
    if (!best) return;
    bagAdd(target.stores, best.key, -1);
    if (bagGet(target.stores, best.key) <= 0) delete target.stores[best.key];
    E.state.touchHousehold(target);
    const lord = E.lordOf(dead.settlement);
    if (lord?.household) { bagAdd(lord.household.stores, best.key, 1); E.state.touchHousehold(lord.household); }
    if (target.members.some((id) => E.isPlayer(id)) || E.isPlayer(dead.id)) {
      E.notify(`Heriot: the lord's reeve takes your best beast (${best.key.split('#')[0]}).`, 'loss');
    }
  });
  return () => { offMarriage(); offDeath(); };
}

export { RENT_PER_STRIP, CAREERS };
