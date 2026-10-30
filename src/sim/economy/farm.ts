// The living open fields (SPEC §10) as the economy runs them. Every strip follows the cycle
//   fallow/stubble → ploughed → (harrowed) → sown → growing → ripe → harvested (cut) → stubble (bound)
// and is advanced either by people — the player's own work bouts, see work.ts — or, on the day it is due,
// by the household that holds it (or the lord's demesne labour): the macro farm, below. A household is
// never left waiting for the player: if its members have the labour, the work is done a little later than
// a diligent player would do it, and a little less well.
//
// Yields are calibrated so that a normal year feeds the continent: the gross yield of a cropped strip is
// the settlement's share of the national need (see yieldBase), scaled by crop, soil, weather, the harvest
// of the kingdom, care and timeliness.
import { hash01 } from '../../core/math';
import { sampleWeather } from '../weather';
import type { CropKind } from '../../core/domain';
import type { Settlement } from '../../world/types';
import {
  CALENDAR, CROPS, SPRING_CROP_LIST, WINTER_CROPS, dropExtra, extraOf, fieldRole, growStrip, peekExtra, roleOn,
  type StripExtra,
} from '../farming';
import type { Household, Person, StripState } from '../state';
import type { Econ } from './core';
import { GRAIN_PER_UNIT_DAY } from './diet';
import { bagAdd, bagGet } from './items';
import { GOODS } from './data';
import { addStock, marketBuy, postedPrice } from './market';

export const TITHE = 0.1;
/** Work units (bouts at speed 1) each strip task takes for a player; see work.ts. */
export const TASK_BOUTS = { plough: 4, harrow: 2, sow: 2, weed: 3, reap: 4, bind: 3, carry: 2, thresh: 3, winnow: 2 } as const;
export type StripTask = 'plough' | 'harrow' | 'sow' | 'weed' | 'reap' | 'bind' | 'carry';

// ---------------------------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------------------------

let globalCache: WeakMap<Econ, { yg: number; meanFert: number }> | null = null;

function calib(E: Econ): { yg: number; meanFert: number } {
  globalCache ??= new WeakMap();
  const hit = globalCache.get(E);
  if (hit) return hit;
  let need = 0, cropped = 0, fertSum = 0, n = 0;
  const m = E.world.macro;
  for (const s of E.world.settlements) {
    const ss = E.state.settlements.get(s.id);
    need += (ss ? ss.target : s.population) * GRAIN_PER_UNIT_DAY * 16;
    if (s.strips.length > 0) {
      cropped += (s.strips.length * 2) / 3;
      fertSum += soilOf(E, s, m); n++;
    }
  }
  // gross yield of a cropped strip at ratio 1: needs 12% over the need, after the tithe and the seed
  // (household farming gets care 0.7, weeding done, a little lag: about 0.93 of the potential)
  const yg = cropped > 0 ? (need * 1.08) / (cropped * 0.66 * 0.93) : 20;
  const r = { yg, meanFert: n > 0 ? fertSum / n : 0.6 };
  globalCache.set(E, r);
  return r;
}

function soilOf(E: Econ, s: Settlement, m = E.world.macro): number {
  const cx = Math.max(0, Math.min(m.res - 1, Math.floor(s.x / m.cell)));
  const cz = Math.max(0, Math.min(m.res - 1, Math.floor(s.z / m.cell)));
  return Math.max(0.2, m.fertility[cz * m.res + cx] / 255);
}

/** Gross gallons a cropped strip of this settlement yields in an average year for a crop with ratio 1. */
export function yieldBase(E: Econ, sid: number): number {
  const s = E.settlementById.get(sid);
  if (!s) return 20;
  const c = calib(E);
  return c.yg * (soilOf(E, s) / c.meanFert) * (1 + 0.16 * (hash01(sid, 5, 9) - 0.5)) * (E.farm.scale?.[sid] ?? 1);
}

export function fieldFert(E: Econ, sid: number, field: number): number {
  return E.farm.fert[`${sid}:${field}`] ?? 1;
}

export function addFieldFert(E: Econ, sid: number, field: number, delta: number): void {
  const k = `${sid}:${field}`;
  const v = Math.max(0.55, Math.min(1.4, (E.farm.fert[k] ?? 1) + delta));
  E.farm.fert[k] = Math.round(v * 1000) / 1000;
}

const stripNoise = (id: number): number => 0.92 + 0.16 * hash01(id, 17, 3);

const weatherMemo = new Map<string, number>();

/** Weather's effect on this year's crops: a pure function of the weather model over the growing months. */
export function weatherFactor(E: Econ, year: number): number {
  const memoKey = `${E.state.seed}:${year}`;
  const hit = weatherMemo.get(memoKey);
  if (hit !== undefined) return hit;
  if (weatherMemo.size > 400) weatherMemo.clear();
  let rain = 0, cold = 0;
  const n = 18;
  for (let i = 0; i < n; i++) {
    const w = sampleWeather(E.state.seed, year * 16 + 0.25 + i * 0.5);
    rain += w.rain;
    cold += Math.max(0, 6 - w.temperature) / 12;
  }
  rain /= n; cold /= n;
  const v = Math.max(0.88, Math.min(1.08, 1.04 - 0.7 * Math.abs(rain - 0.16) - 0.25 * cold));
  weatherMemo.set(memoKey, v);
  return v;
}

/** Draws the harvest quality of each kingdom for the coming year (the same distribution life.ts used). */
export function drawHarvest(E: Econ, year: number): void {
  const sd = ({ squire: 0.07, knight: 0.1, lord: 0.13, king: 0.17 } as const)[E.state.difficulty];
  const famine = ({ squire: 0.01, knight: 0.03, lord: 0.05, king: 0.09 } as const)[E.state.difficulty];
  const rng = E.rng('harvest');
  const f: number[] = [];
  for (const k of E.world.kingdoms) {
    let base = 1 + rng.gauss(0, sd);
    if (rng.chance(famine)) base *= rng.range(0.45, 0.7);
    f[k.id] = Math.round(Math.max(0.35, Math.min(1.3, base + 0.01)) * 1000) / 1000;
  }
  E.save.harvest = { year, f };
  E.touchSave();
}

// ---------------------------------------------------------------------------------------------
// Yield
// ---------------------------------------------------------------------------------------------

/** Gross gallons (or pounds, for flax) a strip gives if harvested now. `mult` carries the harvester's own factors. */
export function grossYield(E: Econ, strip: StripState, ex: StripExtra | undefined, crop: CropKind, mult = 1): number {
  const def = CROPS[crop];
  if (!def) return 0;
  const sid = strip.settlement;
  const base = yieldBase(E, sid) * def.ratio;
  const fert = Math.max(0.5, Math.min(1.6, fieldFert(E, sid, strip.field) * stripNoise(strip.id) * (1 + (ex?.m ?? 0))));
  const wf = E.harvestFactor(sid) * weatherFactor(E, E.save.harvest.year >= 0 ? E.save.harvest.year : E.yearIndex);
  const care = 0.82 + 0.18 * (ex?.c ?? 0.6);
  const weeds = ex?.w ? 1 : 0.86;
  const thin = ex?.t ?? 1;
  const late = ex?.r !== undefined ? Math.max(0.35, 1 - 0.06 * Math.max(0, E.day - ex.r - 1.5)) : 1;
  return base * fert * wf * care * weeds * thin * (ex?.y ?? 1) * late * mult;
}

/** Seed corn a holder wants in the barn for the coming year's sowings: one strip's seed for each strip held, a little over. */
export function seedWanted(E: Econ, s: Settlement, holder: number): number {
  let n = 0;
  for (const id of s.strips) if (E.state.strips.get(id)?.holder === holder) n++;
  return n * yieldBase(E, s.id) * 0.3 * 1.05;
}

/** Seed (gallons) a strip takes to sow a crop. */
export function seedFor(E: Econ, strip: StripState, crop: CropKind): number {
  const def = CROPS[crop];
  return Math.round(yieldBase(E, strip.settlement) * def.ratio * def.seed * 100) / 100;
}

// ---------------------------------------------------------------------------------------------
// Seasons and schedules
// ---------------------------------------------------------------------------------------------

export function cropFor(sid: number, field: number, role: 0 | 1 | 2, year: number): CropKind {
  const h = hash01(sid * 3 + field, year, 31);
  if (role === 2) return WINTER_CROPS[h < 0.35 ? 0 : 1];
  return SPRING_CROP_LIST[Math.floor(h * SPRING_CROP_LIST.length) % SPRING_CROP_LIST.length];
}

/** Days from `d` (day of year) until the main harvest begins (about day 4.5). */
export function daysToHarvest(d: number): number {
  const x = 4.5 - d;
  return x > 0.5 ? x : x + 16;
}

/** Is it the season to sow this strip, and with what? null if not now. */
export function sowingNow(E: Econ, strip: StripState): { crop: CropKind; late: number } | null {
  const role = roleOn(strip.field, E.day);
  const d = E.dayOfYear;
  const y = E.yearIndex;
  if (role === 1 && d >= CALENDAR.springSow[0] && d < CALENDAR.springSow[1] + 1) {
    return { crop: cropFor(strip.settlement, strip.field, 1, y), late: Math.max(0, d - 1.8) };
  }
  if (role === 2 && d >= CALENDAR.winterSow[0] && d < CALENDAR.winterSow[1]) {
    return { crop: cropFor(strip.settlement, strip.field, 2, y), late: Math.max(0, d - 10.4) };
  }
  return null;
}

/** Is it time to plough this strip? (spring for the spring crop, autumn for the winter corn.) */
export function ploughingNow(E: Econ, strip: StripState): boolean {
  const role = roleOn(strip.field, E.day);
  const d = E.dayOfYear;
  if (role === 1) return d >= 0 && d < 3.9;
  if (role === 2) return d >= 8.4 && d < 11.9;
  return false;
}

/** The next task a strip needs, or null if it needs nothing now. */
export function nextTask(E: Econ, strip: StripState): StripTask | null {
  const ex = peekExtra(E.farm, strip.id);
  switch (strip.state) {
    case 'fallow': case 'stubble': case 'bare':
      if ((ex?.k ?? 0) > 0.5) return 'carry';
      return ploughingNow(E, strip) ? 'plough' : null;
    case 'ploughed':
      if (!ex?.h) return 'harrow';
      return sowingNow(E, strip) ? 'sow' : null;
    case 'sown': case 'growing':
      return ex?.w ? null : 'weed';
    case 'ripe': return 'reap';
    case 'harvested': return 'bind';
    default: return null;
  }
}

export function taskLabel(task: StripTask, strip: StripState): string {
  switch (task) {
    case 'plough': return 'Plough';
    case 'harrow': return 'Harrow';
    case 'sow': return 'Sow';
    case 'weed': return 'Weed';
    case 'reap': return strip.crop === 'fallow' ? 'Reap' : `Reap ${strip.crop}`;
    case 'bind': return 'Bind sheaves';
    case 'carry': return 'Carry sheaves to the barn';
  }
}

// ---------------------------------------------------------------------------------------------
// Households' labour
// ---------------------------------------------------------------------------------------------

/** Field labour a household can put on its land (the player's own hands are not counted: they work by action). */
export function labourUnits(E: Econ, hh: Household): number {
  let l = 0;
  for (const id of hh.members) {
    const p = E.state.persons.get(id);
    if (!p || p.death || E.isPlayer(id) || E.isHired(id)) continue;
    l += labourOf(E, p);
  }
  for (const h of E.save.helpers) {
    if (h.hh !== hh.id) continue;
    const w = E.state.persons.get(h.w);
    if (w && !w.death) l += 1;
  }
  return l;
}

export function labourOf(E: Econ, p: Person): number {
  const age = E.age(p);
  if (age < 12) return 0;
  let v = age >= 60 ? 0.5 : age >= 14 ? (p.sex === 'm' ? 1 : 0.7) : 0.4;
  if (p.health.conditions.length > 0) v *= 0.3;
  if (p.estate === 'clergy') v *= 0.2;
  return v;
}

/** How fully a household can keep up with the land it holds: 1 = all work done on time. */
export function farmEff(E: Econ, hh: Household, strips: number): number {
  const labour = labourUnits(E, hh);
  const head = E.state.persons.get(hh.head);
  const serf = head?.estate === 'unfree';
  const need = strips * 0.42 * (serf ? 1.3 : 1);
  if (need <= 0) return 1;
  const playerHere = hh.members.some((id) => E.isPlayer(id));
  if (labour <= 0) return playerHere ? 0 : 0.35;
  return Math.max(0.35, Math.min(1, labour / need));
}

// ---------------------------------------------------------------------------------------------
// The macro farm: one settlement, one day
// ---------------------------------------------------------------------------------------------

/** Advances every strip of a settlement for today. Household efficiency is worked out only for strips that have something to do. */
export function farmDay(E: Econ, s: Settlement): void {
  if (s.strips.length === 0) return;
  const state = E.state;
  const cache = new Map<number, number>();
  const effOf = (hid: number): number => {
    let v = cache.get(hid);
    if (v !== undefined) return v;
    if (hid === 0) v = 0.9;
    else {
      const hh = state.households.get(hid);
      let n = 0;
      for (const id of s.strips) if (state.strips.get(id)?.holder === hid) n++;
      v = hh ? farmEff(E, hh, n) : 0.5;
    }
    cache.set(hid, v);
    return v;
  };
  let dirty = false;
  for (const id of s.strips) {
    const st = state.strips.get(id);
    if (st && macroStrip(E, s, st, effOf)) dirty = true;
  }
  if (dirty) E.touchFarm();
}

function holderStores(E: Econ, s: Settlement, strip: StripState): { hh: Household | undefined; bag: Record<string, number> | null } {
  if (strip.holder) {
    const hh = E.state.households.get(strip.holder);
    return { hh, bag: hh ? hh.stores : null };
  }
  const lord = E.lordOf(s.id);
  return { hh: lord?.household, bag: lord?.household ? lord.household.stores : null };
}

/** Days a holder's work runs behind the ideal: the less labour, the later; a diligent player gets first go. */
function lagFor(E: Econ, strip: StripState, eff: number): number {
  if (eff <= 0) return Infinity;
  const holderIsPlayer = strip.holder !== 0 && !!E.state.households.get(strip.holder)?.members.some((id) => E.isPlayer(id));
  return (1 / eff - 1) * 1.1 + (holderIsPlayer ? 1.5 : 0) + 0.9 * hash01(strip.id, 7);
}

function macroStrip(E: Econ, s: Settlement, strip: StripState, effOf: (holder: number) => number): boolean {
  const farm = E.farm;
  const now = E.day;
  const st = strip.state;
  const ex = peekExtra(farm, strip.id);
  if (st === 'sown' || st === 'growing') return growStrip(E.state, strip, ex, now);
  if (ex && (ex.p ?? 0) > 0.001) return false; // somebody is in the middle of a task
  const d = E.dayOfYear;
  const role = roleOn(strip.field, now);

  if (st === 'ripe') {
    const ripeSince = ex?.r ?? now;
    if (now - ripeSince < 0.4) return false;
    const eff = effOf(strip.holder);
    const lag = lagFor(E, strip, eff);
    if (now - ripeSince < 0.4 + lag) return false;
    macroHarvest(E, s, strip, eff);
    return true;
  }
  if (st === 'harvested') {
    const cut = ex?.r ?? now;
    if (now - cut < 2) return false;
    const eff = effOf(strip.holder);
    const lag = lagFor(E, strip, eff);
    if (now - cut < 2 + lag) return false;
    macroHarvest(E, s, strip, eff, true);
    return true;
  }

  // the turn of the year: last year's spring-crop stubble becomes this year's fallow
  if (role === 2 && st === 'stubble' && d < 8) {
    if (ex && (ex.k ?? 0) > 0.5) {
      // sheaves still in the field are brought in first
      const lag = lagFor(E, strip, effOf(strip.holder));
      if (isFinite(lag) && ex.r !== undefined && now - ex.r > 2 + lag) { carryAll(E, s, strip, ex); return true; }
      return false;
    }
    strip.state = 'fallow';
    strip.crop = 'fallow';
    strip.growth = 0;
    E.state.touchStrip(strip);
    if (ex) { for (const k of Object.keys(ex) as Array<keyof StripExtra>) if (k !== 'm') delete ex[k]; }
    addFieldFert(E, s.id, strip.field, 0.09 / Math.max(1, s.strips.length / 3));
    return true;
  }

  if (st === 'fallow' || st === 'stubble' || st === 'bare') {
    if (ex && (ex.k ?? 0) > 0.5) {
      if (ex.r === undefined || now - ex.r <= 2) return false;
      const lag = lagFor(E, strip, effOf(strip.holder));
      if (!isFinite(lag) || now - ex.r <= 2 + lag) return false;
      carryAll(E, s, strip, ex);
      return true;
    }
    if (!ploughingNow(E, strip)) return false;
    const eff = effOf(strip.holder);
    const lag = lagFor(E, strip, eff);
    if (!isFinite(lag)) return false;
    if (d < (role === 1 ? 0.2 + lag : 8.6 + lag)) return false;
    strip.state = 'ploughed';
    strip.crop = 'fallow';
    E.state.touchStrip(strip);
    extraOf(farm, strip.id).h = 1;
    return true;
  }
  if (st === 'ploughed') {
    const sw = sowingNow(E, strip);
    if (!sw) return false;
    const eff = effOf(strip.holder);
    const lag = lagFor(E, strip, eff);
    if (!isFinite(lag)) return false;
    if (d < (role === 1 ? 0.6 + lag : 9.4 + lag)) return false;
    macroSow(E, s, strip, sw.crop);
    return true;
  }
  return false;
}

function macroSow(E: Econ, s: Settlement, strip: StripState, crop: CropKind): void {
  const ex = extraOf(E.farm, strip.id);
  const { bag, hh } = holderStores(E, s, strip);
  const need = seedFor(E, strip, crop);
  const good = CROPS[crop].good;
  let have = 0;
  if (bag) {
    have = Math.min(need, bagGet(bag, good) + bagGet(bag, 'seed_corn'));
    const fromSeed = Math.min(have, bagGet(bag, 'seed_corn'));
    bagAdd(bag, 'seed_corn', -fromSeed);
    bagAdd(bag, good, -(have - fromSeed));
    if (have < need - 0.01 && hh && hh.purse > 1) {
      const buy = marketBuy(E, s.id, good, need - have, hh.purse * 0.8);
      if (buy.qty > 0) { hh.purse = Math.round((hh.purse - buy.cost) * 100) / 100; have += buy.qty; }
    }
    if (hh) E.state.touchHousehold(hh);
  } else {
    have = need;
  }
  strip.crop = crop;
  strip.state = 'sown';
  strip.growth = 0.04;
  ex.s = Math.round(E.day * 100) / 100;
  ex.t = Math.max(0.35, Math.min(1, have / Math.max(0.01, need)));
  ex.c = 0.7;
  ex.h = 1;
  ex.w = 1; // household farming weeds as a matter of course
  delete ex.r; delete ex.p; ex.k = 0;
  E.state.touchStrip(strip);
}

/** Households reap, bind and carry in one go: credits grain, straw, the tithe and the soil's loss. */
function macroHarvest(E: Econ, s: Settlement, strip: StripState, eff: number, alreadyCut = false): void {
  const ex = extraOf(E.farm, strip.id);
  const crop = strip.crop;
  const def = CROPS[crop];
  if (!def) { finishStrip(E, strip, ex); return; }
  const cut = alreadyCut && (ex.k ?? 0) > 0;
  const gross = cut ? (ex.k as number) : grossYield(E, strip, ex, crop, 0.8 + 0.2 * eff);
  creditHarvest(E, s, strip, gross, crop);
  finishStrip(E, strip, ex);
}

function finishStrip(E: Econ, strip: StripState, ex: StripExtra): void {
  strip.state = 'stubble';
  E.state.touchStrip(strip);
  const keep = ex.m;
  for (const k of Object.keys(ex) as Array<keyof StripExtra>) delete ex[k];
  if (keep && keep > 0.02) ex.m = Math.round(keep * 0.4 * 100) / 100;
  if (Object.keys(ex).length === 0) dropExtra(E.farm, strip.id);
}

/** Takes the tithe off a gross harvest and credits the rest. Returns [net, tithe]. */
export function creditHarvest(E: Econ, s: Settlement, strip: StripState, gross: number, crop: CropKind): [number, number] {
  const tithe = Math.round(gross * TITHE * 100) / 100;
  payTithe(E, s, CROPS[crop].good, tithe);
  const net = Math.round((gross - tithe) * 100) / 100;
  creditNet(E, s, strip, net, crop, gross);
  return [net, tithe];
}

/** Puts grain and straw into the holder's stores (the demesne's go to the lord, or into the market) and updates the soil and the tally. */
export function creditNet(E: Econ, s: Settlement, strip: StripState, net: number, crop: CropKind, grossForTally = net): void {
  const def = CROPS[crop];
  const { hh, bag } = holderStores(E, s, strip);
  if (bag) {
    // next year's seed is set aside first, as farmers always did
    const seedWant = seedWanted(E, s, strip.holder);
    const toSeed = Math.max(0, Math.min(net * def.seed / (1 - TITHE) , seedWant - bagGet(bag, 'seed_corn')));
    if (toSeed > 0.01) bagAdd(bag, 'seed_corn', Math.round(toSeed * 100) / 100);
    bagAdd(bag, def.good, Math.round((net - toSeed) * 100) / 100);
    bagAdd(bag, 'straw', Math.round(net * def.straw * 100) / 100);
    if (hh) E.state.touchHousehold(hh);
  } else {
    // nobody holds the demesne: the bailiff sells it into the market
    addStock(E, E.marketFor(s.id), def.good, net);
  }
  addFieldFert(E, s.id, strip.field, def.fert / Math.max(1, s.strips.length / 3));
  const tally = E.save.tally[String(s.id)] ?? (E.save.tally[String(s.id)] = [0, 0, 0, 0]);
  tally[2] = Math.round((tally[2] + grossForTally) * 10) / 10;
  E.touchSave();
}

/** The parish priest's household (or, failing that, the lord's barn) receives the tithe. */
export function payTithe(E: Econ, s: Settlement, good: string, qty: number): void {
  if (qty <= 0) return;
  for (const hh of E.state.householdsIn(s.id)) {
    const head = E.state.persons.get(hh.head);
    if (head && head.career === 'priest' && !head.death) {
      bagAdd(hh.stores, good, qty);
      E.state.touchHousehold(hh);
      return;
    }
  }
  const lord = E.lordOf(s.id);
  if (lord?.household) { bagAdd(lord.household.stores, good, qty); E.state.touchHousehold(lord.household); }
}

/** Carrying the bound sheaves home: grain credited without a second tithe (macro households). */
function carryAll(E: Econ, s: Settlement, strip: StripState, ex: StripExtra): void {
  const crop = strip.crop;
  const sheaves = ex.k ?? 0;
  if (CROPS[crop] && sheaves > 0) creditNet(E, s, strip, Math.round(sheaves * 0.95 * 100) / 100, crop, sheaves);
  const keep = ex.m;
  for (const k of Object.keys(ex) as Array<keyof StripExtra>) delete ex[k];
  if (keep) ex.m = keep;
  if (Object.keys(ex).length === 0) dropExtra(E.farm, strip.id);
}

// ---------------------------------------------------------------------------------------------
// Install and the new year
// ---------------------------------------------------------------------------------------------

/** First install: adopt the placeholder rotation's phases and seed the soil. */
export function initFarm(E: Econ): void {
  const year = E.yearIndex;
  drawHarvest(E, year);
  for (const s of E.world.settlements) {
    if (s.strips.length === 0) continue;
    for (let f = 0; f < 3; f++) E.farm.fert[`${s.id}:${f}`] = Math.round((0.92 + 0.16 * hash01(s.id, f, 3)) * 1000) / 1000;
  }
  E.touchFarm();
}

/** New year: draw the harvest quality, let the soil settle back towards its norm. */
/**
 * Land comes into cultivation and goes out of it, and farmers put in more or less effort, as the price of
 * bread-corn tells them: each year a settlement's yield scale drifts (at most 3%) towards the level at which
 * its market holds the usual price. Without it a shrinking population would sit on a permanent glut.
 */
function adaptYields(E: Econ): void {
  const base = GOODS.wheat.basePrice;
  const scale = (E.farm.scale ??= {});
  for (const s of E.world.settlements) {
    if (s.strips.length === 0) continue;
    const price = postedPrice(E, s.id, 'wheat', 'buy', 0) / base;
    const cur = scale[s.id] ?? 1;
    const drift = Math.max(-0.03, Math.min(0.03, (price - 0.95) * 0.12));
    scale[s.id] = Math.round(Math.max(0.7, Math.min(1.35, cur * (1 + drift))) * 1000) / 1000;
  }
}

export function yearlyFarm(E: Econ, year: number): void {
  drawHarvest(E, year - 1);
  adaptYields(E);
  for (const k of Object.keys(E.farm.fert)) {
    const v = E.farm.fert[k];
    E.farm.fert[k] = Math.round((v + (1 - v) * 0.12) * 1000) / 1000;
  }
  for (const [id, ex] of Object.entries(E.farm.s)) {
    // forgotten extras (strips that went back to the demesne mid-task) do not pile up
    const st = E.state.strips.get(Number(id));
    if (!st || (Object.keys(ex).length === 0)) delete E.farm.s[id];
  }
  E.touchFarm();
}

export { fieldRole };
