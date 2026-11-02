// Captivity (docs/CIV.md §4): bound and led to the gaol, held there, and the four ways out — wait for the ransom (the family pays if
// it can and cares), pay your own, serve a sentence on the lord's works, or try to get away at night (caught is worse). The
// player and the AI share it; the AI's cases are made and settled off-screen (ai.ts). Prisoners of war are the military module's
// to ransom: this keeps where they are held and what the card offers.
import { isNight } from '../../core/time';
import { formatMoney } from '../money';
import { skillOf } from '../skills';
import { adjustOpinion, hasFlag, type HouseId, type Person, type PersonId } from '../state';
import { killPerson } from '../succession';
import { LAW } from './config';
import type { Law } from './context';
import type { CaptiveRec } from './store';
import type { CaptivityKind, CaptivityView, LawChoice, Result } from './types';

const KIND_TEXT: Record<CaptivityKind, string> = {
  trespass: 'trespass', poaching: 'poaching', war: 'taken in arms', crime: 'crimes against the lord\'s peace',
};

/** Pence a day of labour is worth to the lord's works and a family's means. */
function pence(n: number): number { return Math.round(n * 100) / 100; }

// ---------------------------------------------------------------------------------------------
// The records
// ---------------------------------------------------------------------------------------------

/** "Held in the gaol of Dromore for poaching the lord's deer." */
export function textOf(L: Law, rec: CaptiveRec): string {
  const what = rec.cause || KIND_TEXT[rec.kind];
  if (rec.led) return `Bound and led to ${placeOf(L, rec)} for ${what}.`;
  if (rec.kind === 'war') return `Held prisoner in ${placeOf(L, rec)}${rec.cause ? `: ${rec.cause}` : ''}.`;
  return `Held in ${placeOf(L, rec)} for ${what}.`;
}

/** "the gaol of Dromore" / "the stocks at Cyney": where the prisoner is (or is being taken). */
export function placeOf(L: Law, rec: CaptiveRec): string {
  const b = rec.building >= 0 ? L.state.buildings.get(rec.building) : undefined;
  if (b) {
    for (const [kind, prefix] of [['gaol', 'the gaol of'], ['keep_stone', 'the keep of'], ['motte', 'the keep of'], ['manor_house', "the manor's lock-up at"], ['great_hall', 'the guardroom at'], ['barracks', 'the guardroom at'], ['gatehouse', 'the gatehouse cell at'], ['tower', 'the tower cell at']] as const) {
      if (b.kind === kind) return `${prefix} ${L.placeName(rec.settlement)}`;
    }
  }
  const l = L.holdingPlace(rec.settlement, rec.house);
  return l.text;
}

/** What is asked for his freedom: a prisoner of war's ransom (the military module's figure when it keeps him), else the lord's fine. */
function owedOf(L: Law, rec: CaptiveRec): number {
  if (rec.kind !== 'war') return rec.fine;
  const m = rec.military ? L.military?.captiveOf?.(rec.person) : null;
  return m && m.ransom > 0 ? m.ransom : rec.ransom;
}

export function viewOf(L: Law, rec: CaptiveRec): CaptivityView {
  const war = rec.kind === 'war';
  return {
    person: rec.person, kind: rec.kind, captor: rec.captor, house: rec.house, settlement: rec.settlement, building: rec.led ? -1 : rec.building,
    since: rec.since, ransom: war ? owedOf(L, rec) : 0, fine: war ? 0 : rec.fine, sentenceDays: rec.sentence, text: textOf(L, rec), danger: rec.danger,
    serving: rec.serving, led: rec.led, place: placeOf(L, rec), escapes: rec.escapes, war,
  };
}

/** The ransom the military module keeps for this person (a prisoner of war), as a record of our own for the card. */
export function warView(L: Law, person: PersonId): CaptivityView | null {
  const c = L.military?.captiveOf?.(person);
  if (!c) return null;
  const p = L.person(person);
  if (!p) return null;
  const place = c.place >= 0 ? c.place : p.settlement;
  const lock = L.holdingPlace(place, c.holder);
  return {
    person, kind: 'war', captor: c.captor, house: c.holder, settlement: lock.settlement, building: lock.building?.id ?? -1, since: c.since,
    ransom: c.ransom, fine: 0, sentenceDays: 0, text: `Held prisoner in ${lock.text}.`, danger: false, place: lock.text, war: true,
  };
}

// ---------------------------------------------------------------------------------------------
// Taking a prisoner
// ---------------------------------------------------------------------------------------------

function between(L: Law, [lo, hi]: readonly [number, number]): number {
  if (hi <= lo) return lo;
  return lo + Math.floor(L.rng().next() * (hi - lo + 1));
}

/** What a House gets for the prisoner: scaled by rank (the great pay more) and by the lord's temper. */
function fineFor(L: Law, p: Person, kind: CaptivityKind, lord: Person | undefined): number {
  const [lo, hi] = LAW.fine[kind];
  if (hi <= 0) return 0;
  const base = lo + L.rng().next() * (hi - lo);
  const rank = 1 + 0.35 * Math.max(0, p.rankTier - 2);
  const temper = lord ? 1 + Math.max(-0.3, Math.min(0.5, lord.rep.cruelty / 200)) : 1;
  return pence(Math.max(2, Math.round(base * rank * temper)));
}

/** A prisoner of war's price when the military module is not asked: a year of the estate's income by rank. */
function ransomFor(L: Law, p: Person): number {
  const m = L.military?.ransomValue?.(p.id);
  if (m && m > 0) return m;
  return [0, 6, 30, 140, 520, 2600, 13000, 65000, 320000][p.rankTier] ?? 30;
}

function atWarWith(L: Law, a: HouseId, b: HouseId): boolean {
  if (!a || !b || a === b) return false;
  if (L.politics?.stance(a, b) === 'war') return true;
  return !!L.military?.hostile?.(a, b);
}

/** Might this lord hang this man? Enemy soldiers (and nobles) who shed the lord's men's blood, at war, under a cruel lord. */
export function mayHang(L: Law, p: Person, rec: CaptiveRec): boolean {
  if (!rec.bloodshed || rec.kind === 'trespass' || rec.kind === 'poaching') return false;
  const lord = L.alive(L.lordOf(rec.settlement)) ?? L.alive(rec.captor);
  if (!lord || lord.rep.cruelty < LAW.cruelLord) return false;
  const soldier = L.armed(p) || p.rankTier >= 4;
  if (!soldier) return false;
  // at war with the holding House, or an outlaw (a bandit who killed the lord's men)
  return rec.kind === 'crime' || atWarWith(L, p.house, rec.house) || hasFlag(p, 'outlaw');
}

/**
 * Takes the person prisoner: the record, the flag, the warning if the lord may hang him, the military module told (it keeps the
 * ransom right), the player bound. Returns null when he cannot be taken (dead, already held).
 */
export function seizePerson(
  L: Law, p: Person, captor: PersonId, kind: CaptivityKind, settlement: number, cause: string,
  opts: { led?: boolean; bloodshed?: boolean; level?: 'private' | 'hostile'; ransom?: number } = {},
): CaptiveRec | null {
  if (p.death || L.store.captiveOf(p.id)) return null;
  const owner = L.territory?.ownerOf?.(settlement);
  const house: HouseId = owner?.house || L.person(captor)?.house || 0;
  const lord = L.alive(owner?.lord ?? 0);
  const place = L.holdingPlace(settlement, house);
  const war = kind === 'war';
  const rec: CaptiveRec = {
    person: p.id, kind, captor, house, settlement: place.settlement, building: opts.led ? -1 : (place.building?.id ?? -1), since: L.day,
    ransom: war ? (opts.ransom && opts.ransom > 0 ? opts.ransom : ransomFor(L, p)) : 0,
    fine: war ? 0 : fineFor(L, p, kind, lord), sentence: between(L, LAW.sentence[kind]),
    serving: false, danger: false, dangerSince: -1, cause, led: !!opts.led, bloodshed: !!opts.bloodshed, escapes: 0, military: false,
  };
  if (mayHang(L, p, rec)) { rec.danger = true; rec.dangerSince = L.day; }
  L.store.data.captives.push(rec);
  L.store.data.stats.taken++;
  L.store.touch();
  p.flags.captive = true;
  L.state.touch(p);
  // the military module keeps the ransom right (B4); until it does, the law keeps the flag and the price itself
  if (L.military?.takeCaptive) {
    const r = L.military.takeCaptive(p.id, captor, { settlement: place.settlement, reason: cause });
    // only a prisoner the module reports back is its to release (the law frees the others itself)
    if (r.ok && L.military.captiveOf?.(p.id)) rec.military = true;
  }
  L.sim.events.emit('trespass', { phase: 'captured', person: p.id, house, settlement, level: opts.level ?? (war ? 'hostile' : 'private') });
  if (p.id === L.playerId) {
    L.notify('danger', rec.led ? `You are taken prisoner and bound: ${cause}.` : `You are taken prisoner: ${cause}.`);
    if (rec.danger) L.notify('danger', `${L.titled(lord?.id ?? captor)} is a cruel man and your hands are red with his men's blood: he may hang you.`);
    L.sim.requestSave('taken prisoner');
  } else if (p.house === L.state.run.houseId) {
    L.notify('warn', `${L.name(p.id)} of your House is a prisoner in ${place.text}.`, L.playerId);
  }
  L.log('captured', `${L.name(p.id)} was taken for ${cause} and held in ${place.text}.`, [p.id, captor].filter(Boolean));
  return rec;
}

/** A prisoner of war taken by the military module (a battle, a raid) that the law keeps an eye on: the player's case, so the card and the gaol apply. */
export function adoptWar(L: Law, captive: PersonId, captor: PersonId, ransom: number): CaptiveRec | null {
  const p = L.alive(captive);
  if (!p || L.store.captiveOf(captive)) return null;
  const c = L.person(captor);
  const settlement = L.military?.captiveOf?.(captive)?.place ?? c?.settlement ?? p.settlement;
  const house = c?.house ?? 0;
  const place = L.holdingPlace(settlement >= 0 ? settlement : p.settlement, house);
  const rec: CaptiveRec = {
    person: captive, kind: 'war', captor, house, settlement: place.settlement, building: place.building?.id ?? -1, since: L.day,
    ransom: ransom > 0 ? ransom : ransomFor(L, p), fine: 0, sentence: 0, serving: false, danger: false, dangerSince: -1,
    cause: 'taken in arms', led: false, bloodshed: false, escapes: 0, military: true,
  };
  L.store.data.captives.push(rec);
  L.store.touch();
  return rec;
}

// ---------------------------------------------------------------------------------------------
// The player's body
// ---------------------------------------------------------------------------------------------

/** Binds (or frees) the player's body to match the record: led behind the captor, or held at the door of the lock-up. */
export function restrainPlayer(L: Law, rec: CaptiveRec | null): void {
  const pl = L.player;
  if (!pl?.restrain) return;
  if (!rec || rec.person !== L.playerId) return;
  const text = textOf(L, rec);
  if (rec.led) { pl.restrain({ kind: 'led', by: rec.captor, reason: text }); return; }
  const spot = rec.building >= 0 ? L.doorOf(rec.building) : null;
  const s = L.world.settlements.find((x) => x.id === rec.settlement);
  const x = spot ? spot.x : (s?.x ?? 0) + 5, z = spot ? spot.z : (s?.z ?? 0) + 5;
  pl.restrain({ kind: 'held', x, z, building: rec.building, reason: text });
  if (spot) pl.placeAt?.(x, z, spot.yaw + Math.PI);
}

/** The cell door's standing place, for the player's body after the walk. */
export function deliver(L: Law, rec: CaptiveRec): void {
  if (!rec.led) return;
  const place = L.holdingPlace(rec.settlement, rec.house);
  rec.led = false;
  rec.settlement = place.settlement;
  rec.building = place.building?.id ?? -1;
  L.store.touch();
  if (rec.person === L.playerId) {
    restrainPlayer(L, rec);
    L.notify('warn', `You are put in ${placeOf(L, rec)}.`);
    L.sim.events.emit('ui', { panel: 'ext', name: 'law', data: { mode: 'captive' } });
  }
}

// ---------------------------------------------------------------------------------------------
// Letting go
// ---------------------------------------------------------------------------------------------

export type ReleaseWhy = 'paid' | 'served' | 'pardoned' | 'escaped' | 'ransomed' | 'let go' | 'dead';

const MILITARY_WHY: Record<ReleaseWhy, 'escaped' | 'pardoned' | 'served' | 'ransomed'> = {
  paid: 'ransomed', ransomed: 'ransomed', served: 'served', pardoned: 'pardoned', 'let go': 'pardoned', escaped: 'escaped', dead: 'pardoned',
};

export function releasePerson(L: Law, rec: CaptiveRec, why: ReleaseWhy): void {
  L.store.remove(rec);
  L.store.data.stats.released++;
  L.store.touch();
  const p = L.person(rec.person);
  if (!p) return;
  if (!p.death) {
    // the military module may still keep this prisoner: it frees him by its own rules; otherwise the flag is ours to clear
    const mil = L.military;
    if (mil?.captiveOf?.(p.id) && mil.release) mil.release(p.id, MILITARY_WHY[why]);
    else {
      delete p.flags.captive;
      const hh = L.state.households.get(p.household);
      if (hh && why !== 'escaped' && p.settlement !== hh.settlement && p.id !== L.playerId) L.state.setSettlement(p, hh.settlement);
      L.state.touch(p);
    }
    if (why === 'escaped') L.store.makeWanted(p.id, rec.settlement, L.day + LAW.wantedDays);
    else if (why === 'let go') {
      const captor = L.person(rec.captor);
      if (captor) adjustOpinion(p, captor.id, -4);
    }
  }
  L.sim.events.emit('trespass', {
    phase: why === 'escaped' ? 'escaped' : 'released', person: rec.person, house: rec.house, settlement: rec.settlement,
    level: rec.kind === 'war' ? 'hostile' : 'private',
  });
  if (rec.person === L.playerId) {
    L.player?.restrain?.(null);
    const msg = why === 'paid' ? 'The fine is paid. The door is opened and you are free to go.'
      : why === 'ransomed' ? 'Your ransom is paid. You are free to go.'
        : why === 'served' ? 'Your sentence is served. You are turned out of the gaol.'
          : why === 'escaped' ? 'You are away! Keep clear of the lord\'s men: you will be taken at sight.'
            : why === 'dead' ? '' : 'The lord lets you go.';
    if (msg) L.notify(why === 'escaped' ? 'warn' : 'gain', msg);
    L.sim.requestSave('released');
  } else if (p.house === L.state.run.houseId && why !== 'dead') {
    L.notify('gain', `${L.name(p.id)} is free again.`, L.playerId);
  }
}

// ---------------------------------------------------------------------------------------------
// The choices
// ---------------------------------------------------------------------------------------------

/** What the captive and his people can raise: his purse and household's (the family adds the head of House's, half). */
function ownMeans(L: Law, p: Person): number {
  let t = p.money;
  const hh = L.state.households.get(p.household);
  if (hh) t += hh.purse;
  return t;
}

function familyMeans(L: Law, p: Person): number {
  let t = ownMeans(L, p);
  const house = L.state.houses.get(p.house);
  const head = house ? L.person(house.head) : undefined;
  if (head && head.id !== p.id) {
    const hh = L.state.households.get(head.household);
    if (hh && hh.id !== p.household) t += hh.purse * 0.5 + head.money * 0.5;
  }
  return t;
}


function drain(L: Law, p: Person, amount: number, family: boolean): number {
  let left = amount;
  const take = (get: () => number, set: (v: number) => void): void => {
    const x = Math.min(left, get());
    if (x <= 0) return;
    set(pence(get() - x));
    left -= x;
  };
  take(() => p.money, (v) => { p.money = v; L.state.touch(p); });
  const hh = L.state.households.get(p.household);
  if (hh) take(() => hh.purse, (v) => { hh.purse = v; L.state.touchHousehold(hh); });
  if (family) {
    const house = L.state.houses.get(p.house);
    const head = house ? L.person(house.head) : undefined;
    const hhh = head ? L.state.households.get(head.household) : undefined;
    if (hhh && hhh !== hh) take(() => hhh.purse, (v) => { hhh.purse = v; L.state.touchHousehold(hhh); });
  }
  return amount - left;
}

function creditHouse(L: Law, house: HouseId, amount: number): void {
  if (amount <= 0) return;
  const h = L.state.houses.get(house);
  const head = h ? L.person(h.head) : undefined;
  const hh = head ? L.state.households.get(head.household) : undefined;
  if (!hh) return;
  hh.purse = pence(hh.purse + amount);
  L.state.touchHousehold(hh);
}

/** The prisoner (or his family) pays what is asked: a fine to the lord's House, a ransom through the military module when it keeps it. */
export function payFor(L: Law, rec: CaptiveRec, family: boolean): Result {
  const p = L.alive(rec.person);
  if (!p) return { ok: false, reason: 'No one to free' };
  const owed = owedOf(L, rec);
  if (owed <= 0) {
    releasePerson(L, rec, 'pardoned');
    return { ok: true, message: 'Nothing is asked: you are let go.' };
  }
  const have = family ? familyMeans(L, p) : ownMeans(L, p);
  if (have + 1e-6 < owed) return { ok: false, reason: `${formatMoney(owed)} is asked; only ${formatMoney(Math.floor(have))} can be raised${family ? '' : ' by you and your household'}.` };
  const warRec = rec.kind === 'war';
  if (warRec && L.military?.captiveOf?.(p.id)) {
    const r = L.military.payRansom?.(p.id);
    if (r && !r.ok) return { ok: false, reason: r.reason ?? 'The ransom is refused.' };
    // the military module released him; ours is a copy
    L.store.remove(rec);
    L.store.touch();
    if (p.id === L.playerId) L.player?.restrain?.(null);
    L.sim.events.emit('trespass', { phase: 'released', person: p.id, house: rec.house, settlement: rec.settlement, level: 'hostile' });
    if (p.id === L.playerId) L.notify('gain', 'Your ransom is paid. You are free to go.');
    return { ok: true, message: 'The ransom is paid.' };
  }
  const paid = drain(L, p, owed, family);
  creditHouse(L, rec.house, paid);
  L.store.data.stats.finesPaid++;
  releasePerson(L, rec, warRec ? 'ransomed' : 'paid');
  return { ok: true, message: warRec ? 'The ransom is paid.' : `You pay ${formatMoney(owed)} and are freed.` };
}

/** Serving a sentence: labour on the lord's works for the days the lord sets; freed when they are out. */
function serve(L: Law, rec: CaptiveRec): Result {
  if (rec.kind === 'war') return { ok: false, reason: 'A prisoner of war is held for ransom, not sentenced' };
  if (rec.serving) return { ok: false, reason: 'You are serving your sentence already' };
  if (rec.sentence <= 0) rec.sentence = 1;
  rec.serving = true;
  L.store.touch();
  return { ok: true, message: `You are put to labour on the lord's works for ${rec.sentence} ${rec.sentence === 1 ? 'day' : 'days'}. Wait out the days (Z).` };
}

/** Night, an unwatched door, a loose bar: Agility and Strength against the watch; caught is worse. */
export function escapeChance(L: Law, p: Person, rec: CaptiveRec): number {
  const watch = L.state.residentList(rec.settlement).filter((q) => L.armed(q) && L.age(q) >= 17).length;
  const guard = Math.min(0.28, watch * 0.015 + (rec.building < 0 ? 0 : 0.04));
  const c = 0.34 + 0.022 * (p.trained.agi - 10) + 0.014 * (p.trained.str - 10) + 0.018 * skillOf(p, 'stealth') - guard - 0.07 * rec.escapes;
  return Math.max(0.07, Math.min(0.82, c));
}

function attemptEscape(L: Law, rec: CaptiveRec): Result {
  const p = L.alive(rec.person);
  if (!p) return { ok: false, reason: 'No one to free' };
  if (rec.led) return { ok: false, reason: 'You are bound and watched; wait for the door' };
  if (!isNight(L.day)) return { ok: false, reason: 'Only at night, when the watch is thin' };
  const chance = escapeChance(L, p, rec);
  if (L.rng().next() < chance) {
    releasePerson(L, rec, 'escaped');
    return { ok: true, message: 'You slip the bar and go over the wall in the dark.' };
  }
  // caught: worse
  rec.escapes++;
  rec.sentence += LAW.escapePenaltyDays;
  rec.fine = pence(rec.fine * 1.5 + 4);
  rec.serving = false;
  const lord = L.alive(L.lordOf(rec.settlement)) ?? L.alive(rec.captor);
  if (lord) adjustOpinion(lord, p.id, -8);
  L.combat?.harm(p.id, 0.28, 'beaten by the watch');
  if (rec.kind !== 'trespass' && rec.kind !== 'poaching' && rec.escapes >= 2 && !rec.danger && mayHang(L, p, { ...rec, bloodshed: true })) {
    rec.danger = true; rec.dangerSince = L.day;
  }
  L.store.touch();
  return { ok: false, reason: `Caught in the yard and beaten for it: ${LAW.escapePenaltyDays} more days of sentence and a heavier fine.`, message: 'Caught.' };
}

function viewFor(L: Law, person: PersonId): { rec: CaptiveRec | null; war: CaptivityView | null } {
  const rec = L.store.captiveOf(person) ?? null;
  return { rec, war: rec ? null : warView(L, person) };
}

export function captivityChoices(L: Law, person: PersonId): LawChoice[] {
  const p = L.alive(person);
  if (!p) return [];
  const { rec, war } = viewFor(L, person);
  if (!rec && !war) return [];
  const out: LawChoice[] = [];
  if (!rec && war) {
    // a prisoner of war the law keeps no record of (an AI man, a case before the module adopted it): wait or pay
    const have = ownMeans(L, p);
    out.push({ id: 'wait', label: 'Wait for ransom', detail: `${formatMoney(war.ransom)} is asked; your House or family may pay`, ok: true });
    out.push({ id: 'pay', label: 'Pay your own ransom', detail: `${formatMoney(war.ransom)} — you and your household have ${formatMoney(Math.floor(have))}`, ok: have + 1e-6 >= war.ransom, reason: have + 1e-6 >= war.ransom ? undefined : 'You cannot raise it' });
    return out;
  }
  const r = rec as CaptiveRec;
  const owed = owedOf(L, r);
  const warRec = r.kind === 'war';
  const family = familyMeans(L, p);
  out.push({
    id: 'wait', label: warRec ? 'Wait for ransom' : 'Wait for your family',
    detail: owed > 0 ? `${formatMoney(owed)} is asked${family >= owed ? '; your people could pay it' : '; your people cannot raise it yet'}` : 'Nothing is asked',
    ok: !r.led, reason: r.led ? 'You are being led away' : undefined,
  });
  const have = ownMeans(L, p);
  out.push({
    id: 'pay', label: warRec ? 'Pay your own ransom' : 'Pay the fine',
    detail: owed > 0 ? `${formatMoney(owed)} — you and your household have ${formatMoney(Math.floor(have))}` : undefined,
    ok: !r.led && owed > 0 && have + 1e-6 >= owed,
    reason: r.led ? 'You are being led away' : owed <= 0 ? 'Nothing is asked' : have + 1e-6 >= owed ? undefined : 'You cannot raise it',
  });
  out.push({
    id: 'serve', label: 'Serve a sentence', detail: warRec ? undefined : `${Math.max(1, r.sentence)} ${r.sentence === 1 ? 'day' : 'days'} of labour on the lord's works`,
    ok: !r.led && !warRec && !r.serving, reason: warRec ? 'A prisoner of war is held for ransom' : r.serving ? 'You are serving it now' : r.led ? 'You are being led away' : undefined,
  });
  const night = isNight(L.day);
  out.push({
    id: 'escape', label: 'Try to escape tonight', detail: `About ${Math.round(escapeChance(L, p, r) * 100)}% — Agility and Strength against the watch; caught is worse`,
    ok: !r.led && night, reason: r.led ? 'You are bound and watched' : night ? undefined : 'Only at night, when the watch is thin',
  });
  return out;
}

export function chooseInCaptivity(L: Law, person: PersonId, choice: string): Result {
  const p = L.alive(person);
  if (!p) return { ok: false, reason: 'No one to free' };
  const { rec, war } = viewFor(L, person);
  if (!rec && !war) return { ok: false, reason: 'Not held' };
  const opt = captivityChoices(L, person).find((c) => c.id === choice);
  if (!opt) return { ok: false, reason: 'That is not offered' };
  if (!opt.ok) return { ok: false, reason: opt.reason ?? 'Not now' };
  if (!rec) {
    // a prisoner of war the law holds no record of
    if (choice === 'pay') {
      const r = L.military?.payRansom?.(person);
      return r?.ok ? { ok: true, message: 'The ransom is paid.' } : { ok: false, reason: r?.reason ?? 'The ransom is refused' };
    }
    return { ok: true, message: 'You wait for word from home.' };
  }
  switch (choice) {
    case 'wait': return { ok: true, message: rec.kind === 'war' ? 'You wait in the dark for your ransom.' : 'You wait for word from your family.' };
    case 'pay': return payFor(L, rec, false);
    case 'serve': return serve(L, rec);
    case 'escape': return attemptEscape(L, rec);
    default: return { ok: false, reason: 'That is not offered' };
  }
}

// ---------------------------------------------------------------------------------------------
// Days in the gaol
// ---------------------------------------------------------------------------------------------

/** A man hanged: the lord's justice. */
function hang(L: Law, rec: CaptiveRec): void {
  const p = L.alive(rec.person);
  L.store.remove(rec);
  L.store.data.stats.hanged++;
  L.store.touch();
  if (!p) return;
  const isPlayer = p.id === L.playerId;
  L.log('execution', `${L.name(p.id)} was hanged at ${L.placeName(rec.settlement)} by order of ${L.titled(L.lordOf(rec.settlement) || rec.captor)}.`, [p.id, rec.captor]);
  if (isPlayer) L.notify('danger', 'At dawn they bring you out. The lord has given his judgement.');
  killPerson(L.sim, p, 'execution', L.day);
}

/** Once a day: the warned may be hanged, sentences run out, families pay what they can, the lord loses patience. */
export function dailyCaptives(L: Law): void {
  const list = L.store.data.captives.slice();
  for (const rec of list) {
    const p = L.person(rec.person);
    if (!p || p.death) { L.store.remove(rec); L.store.touch(); continue; }
    if (rec.led) continue;
    const held = Math.floor(L.day) - Math.floor(rec.since);
    // the lord's justice, after the warning
    // (a night must pass after the warning: the days are counted by the calendar)
    if (rec.danger && rec.dangerSince >= 0 && Math.floor(L.day) - Math.floor(rec.dangerSince) >= LAW.hangAfterDays && L.rng().next() < LAW.hangChance) { hang(L, rec); continue; }
    const warRec = rec.kind === 'war';
    // the military module let him go by its own rules (the family paid the ransom, its patience ran out): so does the law
    if (rec.military && !L.military?.captiveOf?.(p.id)) { releasePerson(L, rec, 'ransomed'); continue; }
    // serving: a day's labour for the lord's works
    if (rec.serving && !warRec) {
      rec.sentence -= 1;
      const lord = L.lordOf(rec.settlement);
      const lp = L.person(lord);
      const hh = lp ? L.state.households.get(lp.household) : undefined;
      if (hh) { hh.purse = pence(hh.purse + LAW.labourDayValue); L.state.touchHousehold(hh); }
      if (rec.sentence <= 0) { releasePerson(L, rec, 'served'); continue; }
      L.store.touch();
      continue;
    }
    const owed = owedOf(L, rec);
    // the family pays what is asked when it can and cares (the player decides for himself)
    const mine = p.id === L.playerId || L.state.houses.get(p.house)?.head === L.playerId;
    if (!mine && held >= LAW.payAfterDays && owed > 0 && familyMeans(L, p) >= owed && cares(L, p)) { payFor(L, rec, true); continue; }
    if (warRec) {
      // a prisoner of war the military module no longer keeps is let go after a long wait; the military's own patience covers the rest
      if (!L.military?.captiveOf?.(p.id) && held >= 30) releasePerson(L, rec, 'let go');
      continue;
    }
    // the lord loses patience: a sentence is set (the player may still pay)
    if (!rec.serving && held >= LAW.patienceDays) {
      rec.serving = true;
      if (rec.sentence <= 0) rec.sentence = 1;
      L.store.touch();
      if (p.id === L.playerId) L.notify('warn', `The lord's patience is out: you are put to labour for ${rec.sentence} ${rec.sentence === 1 ? 'day' : 'days'}.`);
    }
  }
  if (L.store.expireWanted(L.day)) L.store.touch();
}

/** Does someone of the prisoner's own household or family care enough to pay? */
function cares(L: Law, p: Person): boolean {
  const hh = L.state.households.get(p.household);
  if (!hh) return false;
  for (const id of hh.members) {
    if (id === p.id) continue;
    const m = L.alive(id);
    if (!m) continue;
    if (m.spouse === p.id || p.children.includes(m.id) || m.id === p.father || m.id === p.mother || (m.opinions[p.id] ?? 0) >= 15) return true;
  }
  const head = L.alive(L.state.houses.get(p.house)?.head ?? 0);
  return !!head && head.id !== p.id && (head.opinions[p.id] ?? 0) >= 0 && p.rankTier >= 4;
}
