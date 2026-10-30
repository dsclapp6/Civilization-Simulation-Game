// The rest of what the player does with the economy: livestock care, errands and odd jobs for coin,
// archery practice at the butts, eating and drinking, and the verbs that open the trade, jobs,
// property, household and career panels (and the few deeds that change a career: pedlar, merchant,
// alewife, freedom).
import { BUILDINGS } from '../../content/types';
import { isHolyDay } from '../calendar';
import type { ActionOption, ActionOutcome, ActionProvider, TargetRef, TradePartnerRef } from '../actions';
import { CAREERS } from '../careers';
import { skillLevel } from '../people';
import { trainStat } from '../skills';
import { shiftFamilyRank } from '../succession';
import { ageYears, type Household, type Person } from '../state';
import type { Econ } from './core';
import { CAREER_ECON, GOODS, GOOD_LIST, careerEcon, keyOf, pd } from './data';
import { RATION } from './diet';
import { bagAdd, bagEntries, bagGet, bagTake, countGood } from './items';
import { employmentOf } from './jobs';
import { buyFreedom, fleeToTown, manumissionPrice } from './obligations';
import { POTTAGE, consume, eatAtHome } from './needs';
import { openChoices, perkSum } from './perks';
import { giveOutput } from './work-craft';
import {
  BOUT_DAYS, boutDone, disabled, giveXp, holyDayBlock, incapable, option, payBout, round1, round2, secondsFor, speedOf, stoch, toolFor, wearOut,
} from './workkit';
import { MARKET_BUILDINGS } from './market';
import { parseItemKey, type ItemKey } from './types';

const FARM_BUILDINGS: ReadonlySet<string> = new Set(['barn', 'tithe_barn', 'cowshed', 'stable', 'sheepfold', 'pigsty', 'henhouse', 'granary']);
const HOME_KINDS: ReadonlySet<string> = new Set(['hovel', 'cottage', 'longhouse', 'townhouse', 'manor_house']);

// ---------------------------------------------------------------------------------------------
// Livestock
// ---------------------------------------------------------------------------------------------

interface StockData { act: 'feed' | 'muck' | 'milk' | 'shear' | 'slaughter' | 'herd'; animal?: string; bld: number }

export function stockProvider(E: Econ): ActionProvider {
  return {
    id: 'stock',
    partial: true,
    list(_ctx, actor, target, out) {
      const p = E.person(actor);
      if (!p || p.death) return;
      const hh = E.hhOf(p);
      if (!hh) return;
      let id = -1;
      let pasture = false;
      if (target.kind === 'building') {
        const b = E.state.buildings.get(target.id);
        if (!b) return;
        const own = hh.home === b.id || b.household === hh.id;
        if (!(FARM_BUILDINGS.has(b.kind) || (own && HOME_KINDS.has(b.kind)))) return;
        if (b.settlement !== p.settlement) return;
        id = b.id;
      } else if (target.kind === 'parcel') {
        const q = E.world.parcels.find((x) => x.id === target.id);
        if (!q || (q.use !== 'pasture' && q.use !== 'meadow') || q.settlement !== p.settlement) return;
        id = target.id;
        pasture = true;
      } else return;
      const t: TargetRef = target;
      const st = hh.stores;
      const sea = Math.floor(E.dayOfYear / 4);
      const block = holyDayBlock(E) ?? incapable(p);
      const cows = bagGet(st, 'cow'), sheep = bagGet(st, 'sheep'), pigs = bagGet(st, 'pig'), oxen = bagGet(st, 'ox'), goats = bagGet(st, 'goat'), hens = bagGet(st, 'chicken');
      const horses = [0, 1, 2, 3, 4].reduce((s, q) => s + bagGet(st, `horse#${q}`), 0);
      const total = cows + sheep + pigs + oxen + goats + hens + horses;
      const push = (o: ActionOption): void => { if (block) { o.enabled = false; o.reason = block; } out.push(o); };
      const base = { target: t, range: pasture ? 18 : 8 };
      if (total < 1) { out.push(disabled({ id: 'stock.none', label: 'Tend the animals', ...base }, 'Your household keeps no animals')); return; }
      const speed = speedOf(E, p, 'husbandry', 'end', null);
      if (pasture) {
        const emp = employmentOf(E, p.id);
        const herdsman = !!emp && emp.career === 'shepherd';
        push(option({
          id: 'stock.herd', label: herdsman ? 'Herd the village flock' : 'Drive the beasts to pasture', seconds: secondsFor(1.2, speed, 8, 40), anim: 'idle', mainHand: 'crook', priority: 40,
          preview: `${herdsman ? 'Paid by the season · ' : 'Well-grazed beasts give more milk · '}Husbandry`, ...base, data: { act: 'herd', bld: id } as StockData,
        }));
        return;
      }
      const hay = bagGet(st, 'hay') + bagGet(p.inventory, 'hay');
      const fodder = bagGet(st, '~f');
      if (sea === 3 || fodder > 0) {
        if (hay < 1) out.push(disabled({ id: 'stock.feed', label: 'Feed the animals', ...base }, 'No hay left: cut some in summer, or buy it'));
        else push(option({ id: 'stock.feed', label: 'Feed the animals with hay', seconds: secondsFor(0.8, speed, 6, 30), anim: 'work_lift', mainHand: 'pitchfork', carry: 'none', priority: sea === 3 ? 50 : 20, preview: 'A fed animal survives the winter · Husbandry', ...base, data: { act: 'feed', bld: id } as StockData }));
      }
      if (oxen + cows + horses + sheep > 0) {
        push(option({ id: 'stock.muck', label: 'Muck out the stalls', seconds: secondsFor(1, speedOf(E, p, 'husbandry', 'str', toolFor(E, p, 'pitchfork')?.quality ?? 0), 6, 30), anim: 'work_lift', mainHand: 'pitchfork', carry: 'none', priority: 15,
          preview: 'A load of manure for the strips · Husbandry', ...base, data: { act: 'muck', bld: id } as StockData }));
      }
      if (cows > 0 && sea !== 3) {
        push(option({ id: 'stock.milk', label: 'Milk the cows', seconds: secondsFor(1, speed, 6, 30), anim: 'work_milk', mainHand: 'bucket', priority: 45,
          preview: `About ${round1(Math.min(cows, 4) * 0.8)} gallons of milk; it keeps one day · Husbandry`, ...base, data: { act: 'milk', bld: id } as StockData }));
      }
      if (sheep > 0 && sea <= 1 && E.dayOfYear >= 2) {
        const marker = `~shY`;
        const done = bagGet(st, marker) === E.yearIndex + 1 ? bagGet(st, '~shN') : 0;
        if (done >= sheep) out.push(disabled({ id: 'stock.shear', label: 'Shear the sheep', ...base }, 'Every sheep has been clipped this year'));
        else push(option({ id: 'stock.shear', label: 'Shear the sheep', seconds: secondsFor(1.2, speed, 8, 40), anim: 'work_milk', mainHand: 'none', priority: 45,
          preview: `About ${round1(Math.min(sheep - done, 6) * 1.4)} lb of wool · Husbandry`, ...base, data: { act: 'shear', bld: id } as StockData }));
      }
      for (const [animal, n, lb] of [['pig', pigs, 11], ['sheep', sheep, 4], ['goat', goats, 3], ['chicken', hens, 0.3]] as const) {
        if (n < 1) continue;
        push(option({ id: `stock.slaughter.${animal}`, label: `Slaughter a ${animal}`, seconds: secondsFor(1.2, speedOf(E, p, 'husbandry', 'str', null), 8, 40), anim: 'work_lift', mainHand: 'none', priority: 5, repeat: false,
          preview: `${lb} lb of meat and a hide · you lose a breeding animal · Husbandry`, ...base, data: { act: 'slaughter', animal, bld: id } as StockData }));
      }
    },
    check(_ctx, actor) {
      const p = E.person(actor);
      return p ? incapable(p) ?? holyDayBlock(E) : 'Nobody there';
    },
    complete(_ctx, actor, o, f) {
      const p = E.person(actor);
      const hh = p ? E.hhOf(p) : undefined;
      if (!p || !hh) return { ok: false };
      const d = o.data as StockData;
      const st = hh.stores;
      const gains: NonNullable<ActionOutcome['gains']> = [{ label: 'Husbandry', ref: 'husbandry' }];
      const yieldM = 1 + perkSum(p, 'husbandry', 'yield');
      const touch = (): void => { E.state.touchHousehold(hh); E.state.touch(p); };
      switch (d.act) {
        case 'feed': {
          const hayHave = bagGet(st, 'hay');
          const bale = Math.min(1, hayHave) * f;
          if (bale < 0.05) { const t = Math.min(1, bagGet(p.inventory, 'hay')); if (t < 0.05) return { ok: false, message: 'No hay left.' }; bagTake(p.inventory, 'hay', t); }
          else bagTake(st, 'hay', bale);
          const cur = bagGet(st, '~f');
          if (cur > 0) { st['~f'] = Math.max(0, Math.round((cur - 0.15 * f) * 100) / 100); if (st['~f'] === 0) delete st['~f']; }
          boutDone(E, p, { skill: 'husbandry', xp: 6, heavy: 0.4, bouts: f });
          touch();
          return { ok: true, message: 'The animals are fed.', gains };
        }
        case 'muck': {
          const n = Math.max(1, stoch(E, 2 * f));
          giveOutput(E, p, 'manure', n);
          boutDone(E, p, { skill: 'husbandry', xp: 5, heavy: 0.6, bouts: f });
          gains.push({ label: 'Manure', amount: n, ref: 'manure' });
          return { ok: true, message: `${n} loads of manure.`, gains };
        }
        case 'milk': {
          const cows = Math.min(bagGet(st, 'cow'), 4);
          const gal = round2(cows * 0.8 * f * yieldM);
          if (gal < 0.05) return { ok: false, message: 'The cows are dry.' };
          giveOutput(E, p, 'milk', gal);
          boutDone(E, p, { skill: 'husbandry', xp: 6, heavy: 0.2, bouts: f });
          gains.push({ label: 'Milk', amount: gal, ref: 'milk' });
          return { ok: true, message: `You milk ${gal} gallons.`, gains };
        }
        case 'shear': {
          const sheep = bagGet(st, 'sheep');
          const done = bagGet(st, '~shY') === E.yearIndex + 1 ? bagGet(st, '~shN') : 0;
          const n = Math.min(sheep - done, Math.max(1, Math.round(6 * f)));
          if (n < 1) return { ok: false, message: 'Every sheep is clipped.' };
          const lb = round2(n * 1.4 * yieldM);
          giveOutput(E, p, 'wool', lb);
          st['~shY'] = E.yearIndex + 1;
          st['~shN'] = done + n;
          boutDone(E, p, { skill: 'husbandry', xp: 7, heavy: 0.3, bouts: f });
          gains.push({ label: 'Wool', amount: lb, ref: 'wool' });
          touch();
          return { ok: true, message: `You clip ${n} sheep: ${lb} lb of wool.`, gains };
        }
        case 'slaughter': {
          const a = d.animal as string;
          if (bagGet(st, a) < 1) return { ok: false, message: 'There is no such beast.' };
          bagAdd(st, a, -1);
          const lb = ({ pig: 11, sheep: 4, goat: 3, chicken: 0.3 } as Record<string, number>)[a] ?? 3;
          const meat = round2(lb * yieldM);
          giveOutput(E, p, 'meat', meat);
          if (a !== 'chicken') giveOutput(E, p, 'hide', a === 'sheep' || a === 'goat' ? 0.4 : 1);
          boutDone(E, p, { skill: 'husbandry', xp: 8, heavy: 0.5, bouts: f });
          gains.push({ label: 'Meat', amount: meat, ref: 'meat' });
          touch();
          return { ok: true, message: `The ${a} yields ${meat} lb of meat.`, gains };
        }
        case 'herd': {
          const emp = employmentOf(E, p.id);
          boutDone(E, p, { skill: 'husbandry', xp: 7, heavy: 0.3, end: 1.2, bouts: f });
          bagAdd(st, 'cheese', 0.25 * f);
          const pay = emp && emp.career === 'shepherd' ? payBout(E, p, 'hired', emp.wage, f, E.lordOf(p.settlement)?.household) : 0;
          if (pay > 0) gains.push({ label: 'Wages', amount: round2(pay), ref: 'money' });
          touch();
          return { ok: true, message: 'The flock grazes well.', gains };
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Errands, odd jobs and practice
// ---------------------------------------------------------------------------------------------

interface WorkData { act: 'errand' | 'practise' | 'eat' | 'eat_home' | 'open' | 'become' | 'free' | 'flee'; [k: string]: unknown }

function errandsToday(E: Econ, p: Person): number {
  const rec = E.save.ww[`e${p.id}`];
  return rec && rec[0] === Math.floor(E.day) ? rec[1] : 0;
}

export function miscProvider(E: Econ): ActionProvider {
  return {
    id: 'misc',
    partial: false,
    list(_ctx, actor, target, out) {
      const p = E.person(actor);
      if (!p || p.death) return;
      if (target.kind === 'self') { listSelf(E, p, out); return; }
      if (target.kind === 'person') { listPerson(E, p, target.id, out); return; }
      if (target.kind === 'building') { listBuilding(E, p, target.id, out); return; }
      if (target.kind === 'settlement') { listSettlement(E, p, target.id, out); return; }
    },
    check(_ctx, actor, o) {
      const p = E.person(actor);
      if (!p) return 'Nobody there';
      const d = o.data as WorkData;
      if (d.act === 'errand' || d.act === 'practise') return incapable(p);
      return null;
    },
    complete(_ctx, actor, o) {
      const p = E.person(actor);
      if (!p || p.death) return { ok: false };
      const d = o.data as WorkData;
      switch (d.act) {
        case 'errand': return errand(E, p, d.person as number);
        case 'practise': return practise(E, p, d.building as number);
        case 'eat': return eatItem(E, p, d.key as string, d.qty as number);
        case 'eat_home': { const r = eatAtHome(E, p); return { ok: r.ok, message: r.message }; }
        case 'open': return { ok: true, ui: d.ui as never };
        case 'become': return becomeCareer(E, p, d.career as string);
        case 'free': { const r = buyFreedom(E, p); return { ok: r.ok, message: r.ok ? 'You are free.' : r.reason }; }
        case 'flee': { const r = fleeToTown(E, p, d.town as number); return { ok: r.ok, message: r.ok ? 'You are away.' : r.reason }; }
      }
    },
  };
}

function listSelf(E: Econ, p: Person, out: ActionOption[]): void {
  const target: TargetRef = { kind: 'self' };
  const base = { target, range: 99, category: 'use' as const, repeat: false };
  // food and drink in the pack
  const foods = bagEntries(p.inventory).filter(([k]) => GOODS[parseItemKey(k).good]?.food).sort((a, b) => b[1] - a[1]).slice(0, 5);
  for (const [k, have] of foods) {
    const g = GOODS[parseItemKey(k).good];
    const hungry = p.needs.hunger;
    const needed = Math.max(0.1, (0.95 - hungry) / (g.food ?? 0.3));
    const unit = g.category === 'drink' ? 0.25 : 1;
    const qty = Math.min(have, Math.max(unit, Math.ceil(needed / unit) * unit));
    const o = option({
      id: `eat.${k}`, label: `${g.category === 'drink' ? 'Drink' : 'Eat'} ${g.name.toLowerCase()} (${round1(qty)})`, seconds: 3, anim: g.category === 'drink' ? 'drink' : 'eat', mainHand: g.category === 'drink' ? 'cup' : 'none',
      preview: `Eases hunger by ${Math.round((g.food ?? 0) * qty * 100)}%`, priority: hungry < 0.5 ? 60 : 10, ...base, data: { act: 'eat', key: k, qty } as WorkData,
    });
    if (hungry >= 0.97) { o.enabled = false; o.reason = 'You are not hungry'; }
    out.push(o);
  }
  // open panels
  out.push(option({ id: 'manage.career', label: 'Think about your career', seconds: 0, ...base, category: 'manage', priority: 3, data: { act: 'open', ui: { panel: 'career', person: p.id } } as WorkData }));
  const choices = openChoices(p);
  if (choices.length > 0) {
    out.push(option({ id: 'manage.perk', label: `Choose a perk (${choices[0].skill})`, seconds: 0, ...base, category: 'manage', priority: 80, data: { act: 'open', ui: { panel: 'perk', person: p.id, skill: choices[0].skill } } as WorkData }));
  }
  if (p.estate === 'unfree') {
    const hh = E.hhOf(p);
    const price = manumissionPrice(E, p);
    const o = option({ id: 'manage.freedom', label: `Buy your freedom (${pd(price)})`, seconds: 0, ...base, category: 'manage', priority: 2, data: { act: 'free' } as WorkData });
    if (!hh || hh.head !== p.id) { o.enabled = false; o.reason = 'Only the head of the household can buy its freedom'; }
    else if (!E.canAfford(p, price)) { o.enabled = false; o.reason = `Freedom costs ${pd(price)}`; }
    out.push(o);
  }
}

function listPerson(E: Econ, p: Person, id: number, out: ActionOption[]): void {
  const q = E.person(id);
  if (!q || q.death || q.id === p.id) return;
  const target: TargetRef = { kind: 'person', id };
  const base = { target, range: 4 };
  const age = ageYears(p, E.day);
  // trade with traders
  const ce = careerEcon(q.career);
  if ((ce.sells?.length ?? 0) + (ce.buys?.length ?? 0) > 0) {
    out.push(option({
      id: 'trade.person', label: `Trade with ${q.first}`, seconds: 0, category: 'trade', repeat: false, priority: 12, ...base,
      preview: `${CAREERS[q.career].label}: ${(ce.sells ?? []).slice(0, 4).join(', ')}`, data: { act: 'open', ui: { panel: 'trade', partner: { kind: 'person', id } } } as WorkData,
    }));
  }
  // an errand for a neighbour
  if (age >= 10 && ageYears(q, E.day) >= 16 && q.settlement === p.settlement) {
    const n = errandsToday(E, p);
    const pay = round2(0.45 * Math.max(0, 1 - n / 6));
    const o = option({
      id: 'errand.run', label: `Run an errand for ${q.first}`, seconds: 9, anim: 'carry_walk', mainHand: 'basket', carry: 'basket', category: 'work', priority: 6, repeat: false,
      preview: pay > 0 ? `A ha'penny or two for the trouble (${pd(pay)}) · Odd jobs` : 'Nobody has more errands for you today', ...base, data: { act: 'errand', person: id } as WorkData,
    });
    const block = holyDayBlock(E) ?? incapable(p);
    if (block) { o.enabled = false; o.reason = block; } else if (pay <= 0) { o.enabled = false; o.reason = 'You have run enough errands today'; }
    out.push(o);
  }
  // the lord's reeve: freedom
  if (p.estate === 'unfree' && q.offices.some((of) => of.office === 'lord' || of.office === 'reeve')) {
    const price = manumissionPrice(E, p);
    const o = option({ id: 'manage.freedom', label: `Ask ${q.first} to free you (${pd(price)})`, seconds: 0, category: 'manage', repeat: false, priority: 4, ...base, data: { act: 'free' } as WorkData });
    const hh = E.hhOf(p);
    if (!hh || hh.head !== p.id) { o.enabled = false; o.reason = 'Only the head of the household can buy its freedom'; } else if (!E.canAfford(p, price)) { o.enabled = false; o.reason = `Freedom costs ${pd(price)}`; }
    out.push(o);
  }
}

function listSettlement(E: Econ, p: Person, id: number, out: ActionOption[]): void {
  const s = E.settlementById.get(id);
  if (!s) return;
  const target: TargetRef = { kind: 'settlement', id };
  const base = { target, range: 60, repeat: false };
  if (s.market) {
    out.push(option({
      id: 'trade.market', label: `Trade at the market of ${s.name}`, seconds: 0, category: 'trade', priority: 14, ...base,
      data: { act: 'open', ui: { panel: 'trade', partner: { kind: 'market', settlement: id } } } as WorkData,
    }));
  }
  out.push(option({ id: 'manage.jobs', label: `Look for work in ${s.name}`, seconds: 0, category: 'manage', priority: 6, ...base, data: { act: 'open', ui: { panel: 'jobs', settlement: id } } as WorkData }));
  out.push(option({ id: 'manage.property', label: `Property to rent or buy in ${s.name}`, seconds: 0, category: 'manage', priority: 5, ...base, data: { act: 'open', ui: { panel: 'property', settlement: id } } as WorkData }));
  if (p.estate === 'unfree' && (s.kind === 'town' || s.kind === 'city') && s.id !== p.settlement) {
    out.push(option({ id: 'manage.flee', label: `Seek refuge in ${s.name} (a year and a day makes you free)`, seconds: 0, category: 'manage', priority: 1, ...base, data: { act: 'flee', town: id } as WorkData }));
  }
}

function listBuilding(E: Econ, p: Person, id: number, out: ActionOption[]): void {
  const b = E.state.buildings.get(id);
  if (!b) return;
  const target: TargetRef = { kind: 'building', id };
  const hh = E.hhOf(p);
  const base = { target, range: 7, repeat: false };
  // trade
  const partner: TradePartnerRef = { kind: 'building', id };
  const shop = MARKET_BUILDINGS.has(b.kind) || GOOD_LIST.some((g) => g.sold?.includes(b.kind));
  if (shop && b.household !== (hh?.id ?? -1) && b.construction >= 1) {
    const isMarket = MARKET_BUILDINGS.has(b.kind);
    out.push(option({
      id: 'trade.building', label: isMarket ? 'Trade at the stalls' : `Buy or sell at the ${BUILDINGS[b.kind].name.toLowerCase()}`, seconds: 0, category: 'trade', priority: 13, ...base,
      data: { act: 'open', ui: { panel: 'trade', partner: isMarket ? { kind: 'market', settlement: b.settlement } : partner } } as WorkData,
    }));
  }
  // boards and halls
  if (['market_hall', 'guildhall', 'tavern', 'alehouse', 'manor_house', 'great_hall'].includes(b.kind)) {
    out.push(option({ id: 'manage.jobs', label: 'Ask about work', seconds: 0, category: 'manage', priority: 6, ...base, data: { act: 'open', ui: { panel: 'jobs', settlement: b.settlement } } as WorkData }));
  }
  if (['market_hall', 'guildhall', 'manor_house', 'church'].includes(b.kind)) {
    out.push(option({ id: 'manage.property', label: 'Ask about property to rent or buy', seconds: 0, category: 'manage', priority: 5, ...base, data: { act: 'open', ui: { panel: 'property', settlement: b.settlement } } as WorkData }));
  }
  // the household's own home
  if (hh && hh.home === id) {
    out.push(option({ id: 'manage.household', label: 'Household affairs', seconds: 0, category: 'manage', priority: 7, ...base, data: { act: 'open', ui: { panel: 'household', id: hh.id } } as WorkData }));
    // eat at the household table
    const hasFood = Object.keys(hh.stores).some((k) => !k.startsWith('~') && ((GOODS[parseItemKey(k).good]?.food && GOODS[parseItemKey(k).good].category !== 'livestock' && hh.stores[k] > 0.2) || (POTTAGE.includes(parseItemKey(k).good) && hh.stores[k] > 0.1)));
    const o = option({
      id: 'eat.home', label: 'Eat at the household table', seconds: 5, anim: 'eat', mainHand: 'none', category: 'use', priority: p.needs.hunger < 0.5 ? 70 : 8, ...base,
      preview: 'A meal from the family stores', data: { act: 'eat_home' } as WorkData,
    });
    if (!hasFood) { o.enabled = false; o.reason = 'The larder is empty'; } else if (p.needs.hunger >= 0.97) { o.enabled = false; o.reason = 'You are not hungry'; }
    out.push(o);
    if (p.career !== 'alewife' && p.career !== 'tavern_keeper' && ageYears(p, E.day) >= 16) {
      const o2 = option({ id: 'career.alewife', label: `Hang out the ale-stake (${pd(6)}): set up as an alewife`, seconds: 0, category: 'manage', priority: 3, ...base, data: { act: 'become', career: 'alewife' } as WorkData });
      if (skillLevel(p.skills.brewing) < 3) { o2.enabled = false; o2.reason = 'Needs Brewing 3: practise brewing ale at home'; } else if (!E.canAfford(p, 6)) { o2.enabled = false; o2.reason = `The stake and sign cost ${pd(6)}`; }
      out.push(o2);
    }
  }
  // the traders' ladder
  if (['market_hall', 'market_stall', 'market_cross', 'warehouse', 'guildhall'].includes(b.kind)) {
    if (p.career !== 'peddler' && p.career !== 'merchant' && p.career !== 'shopkeeper' && ageYears(p, E.day) >= 16) {
      const o = option({ id: 'career.peddler', label: `Buy a pedlar's pack (${pd(24)})`, seconds: 0, category: 'manage', priority: 3, ...base, data: { act: 'become', career: 'peddler' } as WorkData });
      if (!E.canAfford(p, 24)) { o.enabled = false; o.reason = `The pack and its goods cost ${pd(24)}`; }
      out.push(o);
    }
    if (p.career === 'peddler' || (CAREERS[p.career].field === 'trade' && p.careerStage === 0)) {
      const o = option({ id: 'career.merchant', label: `Set up as a merchant (${pd(300)})`, seconds: 0, category: 'manage', priority: 3, ...base, data: { act: 'become', career: 'merchant' } as WorkData });
      if (skillLevel(p.skills.trade) < 5) { o.enabled = false; o.reason = 'Needs Trade 5'; }
      else if (!E.canAfford(p, 300)) { o.enabled = false; o.reason = `A merchant needs ${pd(300)} of capital`; }
      out.push(o);
    }
  }
  // archery at the butts
  if (b.kind === 'archery_butts') {
    const bow = toolFor(E, p, 'longbow') ?? toolFor(E, p, 'shortbow');
    const arrows = countGood(p.inventory, 'arrow');
    const holy = isHolyDay(E.day);
    const o = option({
      id: 'arms.practise', label: holy ? 'Archery practice with the village (holy day)' : 'Practise archery at the butts', seconds: secondsFor(1, speedOf(E, p, 'archery', 'per', null), 8, 25), anim: 'shoot_bow', mainHand: bow && bow.key.startsWith('longbow') ? 'longbow' : 'shortbow',
      category: 'learn', priority: holy ? 65 : 30, repeat: true, preview: `${holy ? 'The whole village shoots together: ' : ''}Archery, Strength and Perception grow with the practice`, target, range: 25,
      data: { act: 'practise', building: id } as WorkData,
    });
    if (!bow) { o.enabled = false; o.reason = 'Needs a bow (the carpenter sells them)'; } else if (arrows < 6) { o.enabled = false; o.reason = 'Needs at least six arrows'; }
    else { const w = incapable(p); if (w) { o.enabled = false; o.reason = w; } }
    out.push(o);
  }
}

// ---------------------------------------------------------------------------------------------
// The effects
// ---------------------------------------------------------------------------------------------

function errand(E: Econ, p: Person, personId: number): ActionOutcome {
  const q = E.person(personId);
  const n = errandsToday(E, p);
  const pay = round2(0.45 * Math.max(0, 1 - n / 6));
  E.save.ww[`e${p.id}`] = [Math.floor(E.day), n + 1];
  E.touchSave();
  if (pay > 0) E.earn(p, pay, 'An errand');
  boutDone(E, p, { skill: 'persuasion', xp: 3, heavy: 0.3, bouts: 0.6 });
  giveXp(E, p, 'trade', 2, 1);
  if (q) E.social.adjustOpinion(q.id, p.id, 1, 'ran an errand');
  return { ok: true, message: `${q ? q.first : 'They'} thanks you${pay > 0 ? ` and gives you ${pd(pay)}` : ''}.`, gains: pay > 0 ? [{ label: 'Coin', amount: pay, ref: 'money' }] : [] };
}

function practise(E: Econ, p: Person, buildingId: number): ActionOutcome {
  const bow = toolFor(E, p, 'longbow') ?? toolFor(E, p, 'shortbow');
  if (!bow) return { ok: false, message: 'You need a bow.' };
  const holy = isHolyDay(E.day);
  const heavy = bow.key.startsWith('longbow') ? 1 : 0.55;
  giveXp(E, p, 'archery', holy ? 13 : 9, 1);
  boutDone(E, p, { skill: 'archery', xp: 0, heavy: 0.5, str: heavy, end: 0.4, bouts: 1 });
  trainStat(E.sim, p, 'per', 0.006 * (holy ? 1.2 : 1));
  // arrows are mostly picked up again; now and then one splits
  if (E.rng('arrows').next() < 0.18) bagTake(p.inventory, keyOf('arrow', 1), 1) || bagTake(p.inventory, keyOf('arrow', 0), 1) || bagTake(p.inventory, keyOf('arrow', 2), 1);
  void buildingId;
  const lvl = skillLevel(p.skills.archery);
  return { ok: true, message: `Your arrows ${lvl < 3 ? 'wander about the target' : lvl < 8 ? 'cluster near the gold' : 'strike the gold'}.`, gains: [{ label: 'Archery', ref: 'archery' }, { label: 'Strength', ref: 'str' }] };
}


function eatItem(E: Econ, p: Person, key: ItemKey, qty: number): ActionOutcome {
  const r = consume(E, p, key, qty);
  return { ok: r.ok, message: r.ok ? `You ${GOODS[parseItemKey(key).good]?.category === 'drink' ? 'drink' : 'eat'} and feel better.` : r.reason };
}

function becomeCareer(E: Econ, p: Person, career: string): ActionOutcome {
  const from = p.career;
  if (career === 'peddler') {
    if (!E.spend(p, 24, "Pedlar's pack", true)) return { ok: false, message: 'You need 24d.' };
    p.career = 'peddler';
    p.careerStage = 0;
    bagAdd(p.inventory, 'sack', 1);
    bagAdd(p.inventory, 'salt', 3);
    bagAdd(p.inventory, 'candle', 6);
    bagAdd(p.inventory, keyOf('needle', 1), 2);
    E.deed('peddler', 15, 'Became a pedlar');
  } else if (career === 'merchant') {
    if (skillLevel(p.skills.trade) < 5 || !E.spend(p, 300, 'Merchant capital set aside', true)) return { ok: false, message: 'You need Trade 5 and 300d.' };
    // the capital stays yours as stock-in-trade
    const hh = E.hhOf(p);
    if (hh) E.credit(hh, 300);
    p.career = 'merchant';
    p.careerStage = 1;
    if (p.rankTier < 3) shiftFamilyRank(E.sim, p, 3);
    E.deed('merchant', 60, 'Became a merchant');
  } else if (career === 'alewife') {
    if (skillLevel(p.skills.brewing) < 3 || !E.spend(p, 6, 'Ale-stake and sign', true)) return { ok: false, message: 'You need Brewing 3 and 6d.' };
    p.career = 'alewife';
    p.careerStage = 1;
    E.deed('alewife', 20, 'Became an alewife');
  } else return { ok: false };
  E.state.touch(p);
  E.sim.events.emit('careerChanged', { person: p.id, from: from, to: p.career, stage: p.careerStage });
  E.state.log(E.day, 'career', `${p.first} ${p.byname} became a ${CAREERS[p.career].label.toLowerCase()}.`, [p.id]);
  return { ok: true, message: `You are a ${CAREERS[p.career].label.toLowerCase()} now.` };
}

export { CAREER_ECON, BOUT_DAYS, perkSum };
