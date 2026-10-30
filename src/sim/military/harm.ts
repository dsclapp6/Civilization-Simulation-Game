// Casualties and prisoners. Harm lands on real people through `combat.harm` (the wound model of the combat
// module); without it a small stand-in rolls the same kinds of result so headless runs and tests still
// have deaths, wounds and captures. Prisoners carry a ransom of about a year of their estate's income
// (SPEC §13); the captor holds the right.
import { DAYS_PER_YEAR } from '../../core/time';
import { killPerson } from '../succession';
import { adjustOpinion, NONE, type HouseId, type Person, type PersonId } from '../state';
import type { HarmResult } from '../wave3';
import { TITLE_INCOME, CFG } from './config';
import { armsQuality } from './forces';
import type { Mil } from './store';
import type { CaptiveRec, CaptiveView, Result } from './types';

const TIER_INCOME = [0, 6, 30, 140, 520, 2600, 13000, 65000, 320000];

// ---------------------------------------------------------------------------------------------
// Harm
// ---------------------------------------------------------------------------------------------

/** Rolls a wound on a real person: 0..1 intensity of what struck him. */
export function harm(M: Mil, p: Person, intensity: number, cause: string): HarmResult {
  if (p.death) return 'dead';
  const combat = M.combat;
  if (combat) {
    const r = combat.harm(p.id, intensity, cause);
    if (r === 'dead') M.data.stats.dead++;
    return r;
  }
  const rng = M.rng('military.harm');
  const armour = Math.max(0, Math.min(1, (armsQuality(M, p) - 0.5) / 1.0));
  const lethal = Math.max(0, intensity) * (0.5 - 0.28 * armour) * (1.15 - 0.03 * p.trained.end);
  const r = rng.next();
  if (r < lethal * 0.5) {
    killPerson(M.sim, p, 'battle', M.day);
    M.data.stats.dead++;
    return 'dead';
  }
  if (r < lethal * 0.5 + intensity * 0.6) {
    const days = 3 + Math.floor(rng.next() * 10);
    const grave = rng.chance(0.12 + 0.12 * intensity);
    p.health.conditions.push({ id: 'injury', since: M.day, until: M.day + days, severity: grave ? 0.5 : 0.9, fatal: grave });
    p.health.hp = Math.max(0.12, Math.round((p.health.hp - 0.2 - 0.4 * intensity) * 100) / 100);
    M.state.touch(p);
    return 'wounded';
  }
  return 'unhurt';
}

// ---------------------------------------------------------------------------------------------
// Ransom
// ---------------------------------------------------------------------------------------------

/** A year of the captive's estate income (SPEC §13, §4), at least a few shillings. */
export function ransomValue(M: Mil, p: Person): number {
  let income = TIER_INCOME[p.rankTier] ?? 6;
  let titled = 0;
  for (const t of M.state.titlesHeldBy(p.id)) titled += TITLE_INCOME[t.kind] ?? 0;
  if (titled > 0) income = Math.max(income, titled);
  // a year of the estate's income; the pence figures are per game year already (16 days)
  const v = Math.max(CFG.ransomMin, Math.round(income / 10) * 10);
  return v;
}

function holderOf(M: Mil, captor: PersonId): HouseId {
  const c = M.state.persons.get(captor);
  return c ? c.house : NONE;
}

/** Takes a prisoner: flag, record, event, chronicle. Returns null when he cannot be taken. */
export function takeCaptive(M: Mil, captive: Person, captor: PersonId, cause: string, place: number, ransom?: number): CaptiveRec | null {
  if (captive.death || captive.flags.captive) return null;
  const id = captive.id;
  if (M.data.captives.some((c) => c.person === id)) return null;
  const value = ransom && ransom > 0 ? ransom : ransomValue(M, captive);
  const rec: CaptiveRec = { person: id, captor, holder: holderOf(M, captor), ransom: value, since: M.day, place, cause };
  captive.flags.captive = true;
  M.state.touch(captive);
  if (captive.rankTier >= 4 && place >= 0) M.state.setSettlement(captive, place);
  M.data.captives.push(rec);
  M.data.stats.ransoms++;
  M.touch();
  M.sim.events.emit('captured', { captive: id, captor, ransom: value });
  if (captive.rankTier >= 4 || captive.id === M.playerId || captive.house === M.state.run.houseId) {
    M.log('captured', `${M.name(id)} was taken prisoner by ${captor ? M.name(captor) : 'the enemy'}; ransom ${value}d.`, [id, captor].filter(Boolean));
  }
  if (id === M.playerId) {
    M.notify(`You have been taken prisoner. Your ransom is set at ${value} pence.`, 'danger', id);
  } else if (captive.house === M.state.run.houseId) {
    M.notify(`${M.name(id)} of your House is a prisoner. Ransom: ${value} pence.`, 'warn', id);
  }
  return rec;
}

/** Registers a capture made elsewhere (the combat module's yielded nobles) so it can be ransomed. */
export function adoptCaptive(M: Mil, captive: PersonId, captor: PersonId, ransom: number): void {
  const p = M.alive(captive);
  if (!p || M.data.captives.some((c) => c.person === captive)) return;
  const c = M.state.persons.get(captor);
  const place = c ? c.settlement : p.settlement;
  const value = ransom > 0 ? ransom : ransomValue(M, p);
  const rec: CaptiveRec = { person: captive, captor, holder: holderOf(M, captor), ransom: value, since: M.day, place, cause: 'fight' };
  p.flags.captive = true;
  M.state.touch(p);
  M.data.captives.push(rec);
  M.touch();
}

export function captiveView(M: Mil, rec: CaptiveRec): CaptiveView {
  return { person: rec.person, name: M.name(rec.person), captor: rec.captor, holder: rec.holder, ransom: rec.ransom, since: rec.since, place: rec.place };
}

function release(M: Mil, rec: CaptiveRec, why: 'paid' | 'let go' | 'dead'): void {
  const i = M.data.captives.indexOf(rec);
  if (i >= 0) M.data.captives.splice(i, 1);
  const p = M.person(rec.person);
  M.touch();
  if (!p || p.death) return;
  delete p.flags.captive;
  const hh = M.state.households.get(p.household);
  if (hh && p.settlement !== hh.settlement) M.state.setSettlement(p, hh.settlement);
  M.state.touch(p);
  if (why === 'let go') {
    adjustOpinion(p, rec.captor, -6);
    M.state.touch(p);
  }
  if (p.id === M.playerId) M.notify(why === 'paid' ? 'Your ransom is paid. You are free to go.' : 'Your captors let you go.', 'gain', p.id);
  else if (p.house === M.state.run.houseId) M.notify(`${M.name(p.id)} is free again.`, 'gain', p.id);
}

/** What the captive's people can raise: his purse, the household's, and half the head of House's. */
function resources(M: Mil, p: Person): number {
  let total = p.money;
  const hh = M.state.households.get(p.household);
  if (hh) total += hh.purse;
  const house = M.state.houses.get(p.house);
  const head = house ? M.state.persons.get(house.head) : undefined;
  const hhh = head && head.id !== p.id ? M.state.households.get(head.household) : undefined;
  if (hhh && hhh !== hh) total += hhh.purse * 0.5 + (head?.money ?? 0) * 0.5;
  return total;
}

function drain(M: Mil, p: Person, amount: number, payer?: Person): number {
  let left = amount;
  const take = (get: () => number, set: (v: number) => void): void => {
    const x = Math.min(left, get());
    if (x <= 0) return;
    set(Math.round((get() - x) * 100) / 100);
    left -= x;
  };
  if (payer) { take(() => payer.money, (v) => { payer.money = v; M.state.touch(payer); }); }
  take(() => p.money, (v) => { p.money = v; M.state.touch(p); });
  const hh = M.state.households.get(p.household);
  if (hh) take(() => hh.purse, (v) => { hh.purse = v; M.state.touchHousehold(hh); });
  const house = M.state.houses.get(p.house);
  const head = house ? M.state.persons.get(house.head) : undefined;
  const hhh = head ? M.state.households.get(head.household) : undefined;
  if (hhh && hhh !== hh) take(() => hhh.purse, (v) => { hhh.purse = v; M.state.touchHousehold(hhh); });
  return amount - left;
}

/** The ransom is paid: the captor takes his share (70%), his lord the rest; the army shares what it is owed. */
export function payRansom(M: Mil, personId: PersonId, payerId?: PersonId): Result {
  const rec = M.data.captives.find((c) => c.person === personId);
  if (!rec) return { ok: false, reason: 'Nobody holds that prisoner' };
  const p = M.person(personId);
  if (!p || p.death) { release(M, rec, 'dead'); return { ok: false, reason: 'The prisoner is dead' }; }
  const payer = payerId ? M.alive(payerId) : undefined;
  const have = resources(M, p) + (payer ? payer.money : 0);
  if (have + 1e-6 < rec.ransom) return { ok: false, reason: `The ransom is ${rec.ransom} pence; only ${Math.floor(have)} can be raised` };
  const paid = drain(M, p, rec.ransom, payer);
  const captor = M.person(rec.captor);
  const share = Math.round(paid * 0.7 * 100) / 100;
  if (captor && !captor.death) {
    captor.money = Math.round((captor.money + share) * 100) / 100;
    M.state.touch(captor);
    M.data.stats.ransomPaid += share;
    if (captor.id === M.playerId) {
      M.data.player.earned += share;
      M.notify(`Ransom paid for ${M.name(personId)}: ${share} pence is yours by right of capture.`, 'gain', captor.id);
    }
    const army = M.armyOfPerson.get(captor.id);
    const a = army ? M.army(army) : undefined;
    if (a) a.funds += paid - share;
    else M.realm.credit(rec.holder, paid - share);
  } else {
    M.realm.credit(rec.holder, paid);
  }
  release(M, rec, 'paid');
  return { ok: true };
}

/** Daily: families pay what they can; the hopeless and the humble are let go. */
export function tickCaptives(M: Mil): void {
  const list = M.data.captives.slice();
  const now = M.day;
  for (const rec of list) {
    const p = M.person(rec.person);
    if (!p || p.death) { release(M, rec, 'dead'); continue; }
    const held = now - rec.since;
    const have = resources(M, p);
    const mine = p.id === M.playerId || M.state.houses.get(p.house)?.head === M.playerId;
    // NPC families negotiate for a couple of days, then pay if they can; the player decides for his own
    if (!mine && held >= 2 && have >= rec.ransom) { payRansom(M, rec.person); continue; }
    // common prisoners are worth little: let go; hopeless ransoms are written off after a long wait
    if ((p.rankTier <= 2 && held >= DAYS_PER_YEAR * 0.5) || held >= CFG.ransomPatience) release(M, rec, 'let go');
  }
}

export function captiveOf(M: Mil, person: PersonId): CaptiveRec | undefined {
  return M.data.captives.find((c) => c.person === person);
}
