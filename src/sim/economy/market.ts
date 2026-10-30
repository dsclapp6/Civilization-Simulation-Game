// Markets and trade (SPEC §9, §12). Two kinds of goods:
//  - macro goods (grains, bread, ale, vegetables, cheese, eggs, meat, fish, firewood) have real
//    stocks in each market town. Households of the town and of its hinterland sell their surplus
//    into the stock and buy their shortfalls out of it; the price follows stock against a target
//    (scarcity), the season and a fixed local factor. Prices differ by place and by season.
//  - every other good has an index price (base × local factor) and is sold by the shops and stalls
//    the settlement has; what the player sells piles up as a glut that fades over days, so there is
//    no money machine in selling a hundred sickles to one town.
import { hash01 } from '../../core/math';
import { toDate } from '../../core/time';
import { dayPart, isHolyDay, isMarketDay, nextMarketDay } from '../calendar';
import { skillLevel } from '../people';
import { gainSkill } from '../skills';
import type { Household, Person } from '../state';
import type { TradePartnerRef } from '../actions';
import { BUILDINGS } from '../../content/types';
import type { Settlement } from '../../world/types';
import type { Econ, MarketRec } from './core';
import { GOODS, GOOD_LIST, MACRO_GOODS, MACRO_INDEX, basePriceOf, careerEcon, goodOf, keyOf, qualityOf, pd } from './data';
import { RATION, STAPLE_GRAINS, dailyUse, marketBuyShare, typicalTier } from './diet';
import { bagAdd, bagGet } from './items';
import { addOwned, canCarry, capacityOf, ownedQty, takeOwned, weightOf } from './own';
import { perkSum, perkTotal } from './perks';
import {
  parseItemKey,
  type ItemKey, type MarketLine, type MarketView, type Quality, type TradeLine, type TradeQuote, type TradeResult,
} from './types';
import type { SkillId } from '../../core/domain';

export const MARKET_SPREAD = 0.07;
export const STALL_SPREAD = 0.1;
export const SHOP_SPREAD = 0.18;
export const DEALER_SPREAD = 0.14;

/** Days of the hinterland's use a market keeps in stock. */
const COVER: Record<string, number> = {
  wheat: 14, rye: 14, barley: 14, oats: 14, peas: 14, beans: 14, bread: 1.5, ale: 3, vegetables: 3, cheese: 10,
  eggs: 4, meat: 4, fish: 3, firewood: 6,
};
/** Daily pull of the stock towards its target (trade with the wider world beyond the modelled markets). */
const RELAX: Record<string, number> = {
  wheat: 0.006, rye: 0.006, barley: 0.006, oats: 0.006, peas: 0.01, beans: 0.01, bread: 1, ale: 1, vegetables: 1,
  cheese: 0.08, eggs: 1, meat: 0.6, fish: 1, firewood: 1,
};
/** Goods merchants carry between neighbouring markets (storable and worth the cart). */
const CARRIED: readonly string[] = ['wheat', 'rye', 'barley', 'oats', 'peas', 'beans', 'cheese', 'fish', 'firewood'];
/** Seasonal price factors (spring, summer, autumn, winter). */
const SEASONAL: Record<string, readonly [number, number, number, number]> = {
  wheat: [1.1, 0.92, 0.95, 1.03], rye: [1.1, 0.92, 0.95, 1.03], barley: [1.1, 0.92, 0.95, 1.03], oats: [1.08, 0.92, 0.95, 1.03],
  peas: [1.1, 0.92, 0.95, 1.03], beans: [1.1, 0.92, 0.95, 1.03], bread: [1.05, 0.96, 0.97, 1.02], ale: [1, 1.1, 1, 0.95],
  vegetables: [1.2, 0.8, 0.85, 1.5], cheese: [1.1, 0.95, 0.9, 1.05], eggs: [0.85, 0.9, 1.1, 1.4], meat: [1.1, 1, 0.8, 0.95],
  fish: [1.15, 0.9, 0.95, 1], firewood: [0.85, 0.7, 1, 1.6],
};

// ---------------------------------------------------------------------------------------------
// Market state
// ---------------------------------------------------------------------------------------------

/** Target stock per macro good for the market at `mid`: a number of days of the hinterland's use. */
export function marketTargets(E: Econ, mid: number): Float64Array {
  let arr = E.targets.get(mid);
  if (arr) return arr;
  arr = new Float64Array(MACRO_GOODS.length);
  for (const sid of E.hinterland.get(mid) ?? [mid]) {
    const s = E.settlementById.get(sid);
    if (!s) continue;
    const ss = E.state.settlements.get(sid);
    const pop = ss ? ss.target : s.population;
    const share = marketBuyShare(s.kind);
    const tier = typicalTier(s.kind);
    const urban = share > 0.5;
    for (let i = 0; i < MACRO_GOODS.length; i++) arr[i] += pop * share * dailyUse(MACRO_GOODS[i], tier, urban);
  }
  for (let i = 0; i < MACRO_GOODS.length; i++) arr[i] = Math.max(3, arr[i] * (COVER[MACRO_GOODS[i]] ?? 5));
  E.targets.set(mid, arr);
  return arr;
}

export function marketRec(E: Econ, mid: number): MarketRec {
  const key = String(mid);
  let rec = E.mk.m[key];
  if (!rec) {
    const t = marketTargets(E, mid);
    rec = { s: Array.from(t, (v) => Math.round(v * 100) / 100), g: {} };
    E.mk.m[key] = rec;
    E.touchMarkets();
  }
  return rec;
}

export function stockOf(E: Econ, mid: number, good: string): number {
  const i = MACRO_INDEX[good];
  return i === undefined || mid < 0 ? 0 : marketRec(E, mid).s[i];
}

export function addStock(E: Econ, mid: number, good: string, qty: number): void {
  const i = MACRO_INDEX[good];
  if (i === undefined || mid < 0) return;
  const rec = marketRec(E, mid);
  rec.s[i] = Math.max(0, Math.round((rec.s[i] + qty) * 100) / 100);
}

const GOOD_ORDER: Record<string, number> = Object.fromEntries(GOOD_LIST.map((g, i) => [g.id, i]));

/** Static local price factors of a settlement (±11%, fish cheaper at ports, wood cheaper in forest), by good order. */
function buildLocal(E: Econ, sid: number): Float64Array {
  const arr = new Float64Array(GOOD_LIST.length);
  const s = E.settlementById.get(sid);
  GOOD_LIST.forEach((g, i) => {
    let f = 1 + 0.22 * (hash01(sid, i + 1, 77) - 0.5);
    if (s) {
      if (g.id === 'fish' && s.port) f *= 0.85;
      if (g.id === 'firewood' || g.id === 'timber' || g.id === 'planks') f *= 0.9 + 0.5 * (1 - E.world.forestAt(s.x, s.z));
      if (s.kind === 'city' && (g.category === 'tool' || g.category === 'clothing')) f *= 1.04;
    }
    arr[i] = f;
  });
  return arr;
}

function localFactor(E: Econ, sid: number, good: string): number {
  let arr = E.localFactors.get(sid);
  if (!arr) { arr = buildLocal(E, sid); E.localFactors.set(sid, arr); }
  return arr[GOOD_ORDER[good]] ?? 1;
}

/** Reference price (no spread, no transport) of a good at a settlement. */
export function midPrice(E: Econ, sid: number, good: string): number {
  const def = GOODS[good];
  if (!def) return 0;
  const lf = localFactor(E, sid, good);
  const mi = MACRO_INDEX[good];
  if (mi === undefined) return def.basePrice * lf;
  const mid = E.marketFor(sid);
  if (mid < 0) return def.basePrice * lf;
  const rec = marketRec(E, mid);
  const target = marketTargets(E, mid)[mi];
  const stock = rec.s[mi];
  const scarcity = Math.max(0.5, Math.min(2.6, Math.pow(target / Math.max(stock, 0.1 * target), 0.5)));
  const season = SEASONAL[good]?.[toDate(E.day).season] ?? 1;
  return def.basePrice * lf * season * scarcity;
}

/** Fraction added to prices for goods carried from the market town to a village (and shaved off what the village gets). */
export function transport(E: Econ, sid: number): number {
  const d = E.marketDist.get(sid) ?? 0;
  return Math.min(0.1, d / 40000);
}

/** Price per unit that a market charges (side 'buy') or pays (side 'sell') at a settlement, with no personal adjustment. */
export function postedPrice(E: Econ, sid: number, key: ItemKey, side: 'buy' | 'sell', spread = MARKET_SPREAD): number {
  const { good } = parseItemKey(key);
  const def = GOODS[good];
  if (!def) return 0;
  const qmult = basePriceOf(key) / def.basePrice;
  const mid = midPrice(E, sid, good) * qmult;
  const tr = transport(E, sid);
  if (side === 'buy') return round3(mid * (1 + spread) * (1 + tr));
  return round3(mid * (1 - spread) * (1 - tr) * glutFactor(E, sid, good));
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

function glutFactor(E: Econ, sid: number, good: string): number {
  if (MACRO_INDEX[good] !== undefined) return 1;
  const mid = E.marketFor(sid);
  if (mid < 0) return 1;
  const g = E.mk.m[String(mid)]?.g[good] ?? 0;
  return 1 / (1 + g);
}

/** How much the market of a settlement can absorb of one manufactured good before prices sag (pence). */
function depthOf(E: Econ, sid: number): number {
  const s = E.settlementById.get(sid);
  switch (s?.kind) {
    case 'city': return 900;
    case 'town': return 320;
    case 'village': return 70;
    default: return 40;
  }
}

/** Daily upkeep of one market: spoilage, imports and exports, the glut of sold goods fading. */
export function marketDay(E: Econ, mid: number): void {
  const rec = marketRec(E, mid);
  const target = marketTargets(E, mid);
  for (let i = 0; i < MACRO_GOODS.length; i++) {
    const g = MACRO_GOODS[i];
    const def = GOODS[g];
    let s = rec.s[i];
    if (def.spoilDays && def.spoilDays < 100) s *= Math.exp(-1 / def.spoilDays);
    s += (RELAX[g] ?? 0.05) * (target[i] - s);
    rec.s[i] = Math.max(0, Math.round(s * 100) / 100);
  }
  for (const k of Object.keys(rec.g)) {
    const v = rec.g[k] * 0.82;
    if (v < 0.01) delete rec.g[k]; else rec.g[k] = Math.round(v * 1000) / 1000;
  }
  E.touchMarkets();
}

/** Neighbouring markets (undirected edges), each market linked to its three nearest, preferring its own kingdom. */
function marketEdges(E: Econ): Array<[number, number, number]> {
  if (E.edges) return E.edges;
  const edges = new Map<string, [number, number, number]>();
  for (const a of E.marketIds) {
    const sa = E.settlementById.get(a);
    if (!sa) continue;
    const near = E.marketIds.filter((b) => b !== a).map((b) => {
      const sb = E.settlementById.get(b) as Settlement;
      const d = Math.hypot(sa.x - sb.x, sa.z - sb.z);
      return { b, d, key: d * (sb.kingdom === sa.kingdom ? 1 : 2.5) };
    }).sort((x, y) => x.key - y.key || x.b - y.b).slice(0, 3);
    for (const n of near) {
      const lo = Math.min(a, n.b), hi = Math.max(a, n.b);
      edges.set(`${lo}:${hi}`, [lo, hi, n.d]);
    }
  }
  E.edges = [...edges.values()].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  return E.edges;
}

/** Merchants even out the markets: stock flows from where it is plentiful to where it is short (part of the gap per day, minus the cost of carriage). */
export function marketFlowsDay(E: Econ): void {
  const edges = marketEdges(E);
  for (const [a, b, dist] of edges) {
    const ra = marketRec(E, a), rb = marketRec(E, b);
    const ta = marketTargets(E, a), tb = marketTargets(E, b);
    const loss = 0.02 + Math.min(0.1, dist / 150000);
    for (const g of CARRIED) {
      const i = MACRO_INDEX[g];
      const fa = ra.s[i] / ta[i], fb = rb.s[i] / tb[i];
      if (Math.abs(fa - fb) < 0.15) continue;
      const [from, to, tf, tt, ff, ft] = fa > fb ? [ra, rb, ta, tb, fa, fb] : [rb, ra, tb, ta, fb, fa];
      if (ff < 0.5) continue;
      const want = ((ff - ft) / 2) * Math.min(tf[i], tt[i]) * 0.3;
      const q = Math.min(want, from.s[i] - 0.35 * tf[i]);
      if (q < 0.3) continue;
      from.s[i] = Math.round((from.s[i] - q) * 100) / 100;
      to.s[i] = Math.round((to.s[i] + q * (1 - loss)) * 100) / 100;
    }
  }
  E.touchMarkets();
}

// ---------------------------------------------------------------------------------------------
// Households trading with their market (macro)
// ---------------------------------------------------------------------------------------------

/** Fixes the macro goods' prices for the length of one settlement's tick, and the cheapest-ration order of the staples. */
export function beginTick(E: Econ, sid: number): void {
  const n = MACRO_GOODS.length;
  const buy = new Float64Array(n), sell = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    buy[i] = postedPrice(E, sid, MACRO_GOODS[i], 'buy');
    sell[i] = postedPrice(E, sid, MACRO_GOODS[i], 'sell');
  }
  const per = (g: string): number => buy[MACRO_INDEX[g]] / RATION[g];
  const order = STAPLE_GRAINS.slice().sort((a, b) => per(a) - per(b));
  const orderBread = [...order, 'bread'].sort((a, b) => per(a) - per(b));
  E.tick = { sid, buy, sell, order, orderBread };
}

export function endTick(E: Econ): void { E.tick = null; }

/** Posted price during a tick (cached), otherwise computed. */
export function tickPrice(E: Econ, sid: number, good: string, side: 'buy' | 'sell'): number {
  const t = E.tick;
  const i = MACRO_INDEX[good];
  if (t && t.sid === sid && i !== undefined) return side === 'buy' ? t.buy[i] : t.sell[i];
  return postedPrice(E, sid, good, side);
}

/** A household buys up to `qty` of a macro good for at most `budget` pence at its market. Returns what it got and paid. */
export function marketBuy(E: Econ, sid: number, good: string, qty: number, budget: number): { qty: number; cost: number } {
  const mid = E.marketFor(sid);
  if (mid < 0 || qty <= 0 || budget <= 0) return { qty: 0, cost: 0 };
  const stock = stockOf(E, mid, good);
  const unit = tickPrice(E, sid, good, 'buy');
  if (unit <= 0) return { qty: 0, cost: 0 };
  const q = Math.min(qty, stock * 0.9, budget / unit);
  if (q < 0.005) return { qty: 0, cost: 0 };
  addStock(E, mid, good, -q);
  E.probe?.(`buy:${good}`, 0, q * unit);
  return { qty: q, cost: q * unit };
}

/** A household sells `qty` of a macro good into its market; returns the money received. */
export function marketSell(E: Econ, sid: number, good: string, qty: number): number {
  const mid = E.marketFor(sid);
  if (mid < 0 || qty <= 0) return 0;
  const unit = tickPrice(E, sid, good, 'sell');
  addStock(E, mid, good, qty);
  E.probe?.(`sell:${good}`, 0, qty * unit);
  return qty * unit;
}

// ---------------------------------------------------------------------------------------------
// Venues: who the player trades with
// ---------------------------------------------------------------------------------------------

interface Venue {
  settlement: number;
  /** Prices come from this settlement's model. */
  spread: number;
  sells: ReadonlySet<string> | null;
  buys: ReadonlySet<string> | null;
  isMarket: boolean;
  payer: Household | undefined;
  seller: number;
  name: string;
  maxQuality: Quality;
}

export const MARKET_BUILDINGS: ReadonlySet<string> = new Set(['market_hall', 'market_stall', 'market_cross', 'warehouse']);

function tagsOf(E: Econ, sid: number): Set<string> {
  const tags = new Set<string>();
  const s = E.settlementById.get(sid);
  if (s?.market) tags.add('market');
  for (const b of E.state.buildingsAt.get(sid) ?? []) tags.add(b.kind);
  return tags;
}

/** Goods a market settlement offers: the macro goods plus whatever its stalls and shops stock. */
export function catalog(E: Econ, sid: number): string[] {
  const tags = tagsOf(E, sid);
  const out: string[] = [];
  for (const g of GOOD_LIST) {
    if (g.macro) { out.push(g.id); continue; }
    if (g.sold?.some((t) => tags.has(t))) out.push(g.id);
  }
  return out;
}

const CRAFT_FOR_KIND: Record<string, { skill: SkillId; careers: readonly string[] }> = {
  smithy: { skill: 'smithing', careers: ['smith', 'wheelwright'] },
  carpenter: { skill: 'carpentry', careers: ['carpenter', 'cooper', 'wheelwright'] },
  sawpit: { skill: 'carpentry', careers: ['carpenter', 'cooper'] },
  weaver: { skill: 'tailoring', careers: ['weaver', 'tailor'] },
  tannery: { skill: 'tailoring', careers: ['tanner', 'cobbler', 'saddler'] },
};

/** Best quality tier the settlement's craftsmen and stalls can supply for a good. */
export function maxQualityAt(E: Econ, sid: number, goodId: string): Quality {
  const def = GOODS[goodId];
  if (!def?.quality || def.category === 'grain') return 1;
  const s = E.settlementById.get(sid);
  let cap = s?.kind === 'city' ? 3 : s?.kind === 'town' ? 2 : 1;
  const tags = tagsOf(E, sid);
  for (const kind of def.sold ?? []) {
    const craft = CRAFT_FOR_KIND[kind];
    if (!craft || !tags.has(kind)) continue;
    let best = 0;
    for (const p of E.state.residentsOf(sid)) {
      if (craft.careers.includes(p.career) && p.careerStage >= 1) best = Math.max(best, skillLevel(p.skills[craft.skill]));
    }
    const q = best >= 15 ? 4 : best >= 10 ? 3 : best >= 5 ? 2 : 1;
    if (q > cap) cap = q;
  }
  return cap as Quality;
}

function venueOf(E: Econ, partner: TradePartnerRef): Venue | null {
  if (partner.kind === 'market') {
    const s = E.settlementById.get(partner.settlement);
    if (!s || !s.market) return null;
    return { settlement: s.id, spread: MARKET_SPREAD, sells: null, buys: null, isMarket: true, payer: undefined, seller: 0, name: `${s.name} market`, maxQuality: 4 };
  }
  if (partner.kind === 'building') {
    const b = E.state.buildings.get(partner.id);
    if (!b) return null;
    if (MARKET_BUILDINGS.has(b.kind)) {
      const s = E.settlementById.get(b.settlement);
      if (!s) return null;
      const mid = E.marketFor(s.id);
      if (mid < 0) return null;
      return { settlement: s.id, spread: STALL_SPREAD, sells: null, buys: null, isMarket: true, payer: undefined, seller: 0, name: BUILDINGS[b.kind].name, maxQuality: 4 };
    }
    const sells = new Set<string>();
    for (const g of GOOD_LIST) if (g.sold?.includes(b.kind)) sells.add(g.id);
    if (sells.size === 0) return null;
    const hh = E.state.households.get(b.household);
    const owner = hh ? E.state.persons.get(hh.head) : undefined;
    const buys = new Set<string>(sells);
    for (const g of careerEcon(owner?.career ?? 'none').buys ?? []) buys.add(g);
    for (const g of RAW_FOR_KIND[b.kind] ?? []) buys.add(g);
    return { settlement: b.settlement, spread: SHOP_SPREAD, sells, buys, isMarket: false, payer: hh, seller: owner?.id ?? 0, name: BUILDINGS[b.kind].name, maxQuality: 4 };
  }
  const p = E.state.persons.get(partner.id);
  if (!p || p.death) return null;
  const ce = careerEcon(p.career);
  const sells = new Set(ce.sells ?? []);
  const buys = new Set(ce.buys ?? []);
  if (sells.size === 0 && buys.size === 0) return null;
  return {
    settlement: p.settlement, spread: DEALER_SPREAD, sells, buys, isMarket: false, payer: E.hhOf(p), seller: p.id,
    name: `${p.first}${p.byname ? ` ${p.byname}` : ''}`, maxQuality: 4,
  };
}

const RAW_FOR_KIND: Record<string, readonly string[]> = {
  smithy: ['iron', 'charcoal', 'iron_ore', 'firewood'], carpenter: ['timber', 'planks', 'nails'], tannery: ['hide'],
  weaver: ['wool', 'yarn', 'flax'], bakehouse: ['flour', 'wheat', 'rye', 'firewood'], brewhouse: ['barley', 'malt', 'firewood'],
  watermill: ['wheat', 'rye', 'barley', 'oats', 'peas', 'beans'], windmill: ['wheat', 'rye', 'barley', 'oats', 'peas', 'beans'],
  alehouse: ['barley', 'malt', 'firewood'], tavern: ['barley', 'malt', 'firewood', 'bread', 'cheese', 'meat'],
  quarry: ['stone'], mine: ['iron_ore'], bloomery: ['iron_ore', 'charcoal'], charcoal_mound: ['firewood'], kiln: ['firewood'],
  sawpit: ['timber'], stable: ['hay', 'oats'],
};

// ---------------------------------------------------------------------------------------------
// The actor's edge
// ---------------------------------------------------------------------------------------------

const SKILL_OF_CATEGORY: Record<string, SkillId> = {
  grain: 'farming', produce: 'farming', food: 'husbandry', drink: 'brewing', material: 'carpentry', textile: 'tailoring',
  fuel: 'woodcutting', metal: 'smithing', tool: 'smithing', weapon: 'smithing', armour: 'smithing', clothing: 'tailoring',
  livestock: 'husbandry', misc: 'trade',
};

function skillOfGood(goodId: string): SkillId {
  switch (goodId) {
    case 'ale': case 'bread': case 'malt': case 'flour': case 'candle': return 'brewing';
    case 'stone': return 'masonry';
    case 'iron_ore': return 'mining';
    case 'timber': case 'firewood': return 'woodcutting';
    case 'planks': case 'barrel': case 'cart': case 'bucket': return 'carpentry';
    default: return SKILL_OF_CATEGORY[GOODS[goodId]?.category ?? 'misc'] ?? 'trade';
  }
}

/** Fraction taken off prices the actor pays / added to prices the actor gets, from trade skill, charm, opinion and perks. */
function edgeOf(E: Econ, actor: Person, v: Venue, side: 'buy' | 'sell', goodId: string): number {
  const tr = skillLevel(actor.skills.trade);
  const opinion = v.seller ? E.social.opinion(v.seller, actor.id) : 0;
  let e = 0.006 * tr + 0.004 * (actor.trained.cha - 10) + opinion / 1500;
  e += perkSum(actor, 'trade', side) + perkSum(actor, 'persuasion', side);
  if (side === 'sell') e += perkSum(actor, skillOfGood(goodId), 'sell');
  return Math.max(-0.1, Math.min(v.spread * 0.92, e));
}

/** Toll for selling at a market you do not live in. */
function tollFor(E: Econ, actor: Person, v: Venue, saleValue: number): number {
  if (!v.isMarket || saleValue <= 0) return 0;
  const home = E.marketFor(actor.settlement);
  if (home === E.marketFor(v.settlement)) return 0;
  const free = Math.min(1, perkTotal(actor, 'fee'));
  const base = Math.max(0.25, Math.min(3, saleValue * 0.03));
  return Math.round(base * (1 - free) * 100) / 100;
}

// ---------------------------------------------------------------------------------------------
// Lines, quotes and trades
// ---------------------------------------------------------------------------------------------

function stockLine(E: Econ, v: Venue, key: ItemKey, actor: Person | null): MarketLine | null {
  const { good, quality } = parseItemKey(key);
  const def = GOODS[good];
  if (!def) return null;
  const mid = E.marketFor(v.settlement);
  const macro = MACRO_INDEX[good] !== undefined;
  const q = quality === undefined ? undefined : (quality as Quality);
  const sellsIt = v.sells ? v.sells.has(good) : true;
  const buysIt = v.buys ? v.buys.has(good) : true;
  let stock = 0;
  if (sellsIt) {
    if (macro) stock = v.isMarket ? Math.max(0, stockOf(E, mid, good)) : Math.round(Math.min(40, (v.payer ? bagGet(v.payer.stores, good) : 0) + 14));
    else if (def.category === 'livestock') stock = 4;
    else stock = !def.quality ? 25 : Math.max(1, 14 - 4 * (qualityOf(key)));
  }
  const ref = basePriceOf(keyOf(good, q));
  let buy = sellsIt ? postedPrice(E, v.settlement, key, 'buy', v.spread) : 0;
  let sell = buysIt ? postedPrice(E, v.settlement, key, 'sell', v.spread) : 0;
  if (!sellsIt) stock = 0;
  if (actor) {
    if (buy > 0) buy = round3(buy * (1 - edgeOf(E, actor, v, 'buy', good)));
    if (sell > 0) sell = round3(sell * (1 + edgeOf(E, actor, v, 'sell', good)));
  }
  const trend = ref > 0 ? Math.max(-1, Math.min(1, midPrice(E, v.settlement, good) * (basePriceOf(key) / def.basePrice) / ref - 1)) : 0;
  return { key, good: def, quality: q, buy, sell, stock: Math.round(stock * 10) / 10, trend: Math.round(trend * 100) / 100 };
}

/** The lines (what the partner sells and buys) for a market, shop or trader, priced for `actor`. */
export function partnerLines(E: Econ, partner: TradePartnerRef, actor: Person | null): MarketLine[] {
  const v = venueOf(E, partner);
  if (!v) return [];
  const goods = v.isMarket ? catalog(E, v.settlement) : GOOD_LIST.filter((g) => (v.sells?.has(g.id) || v.buys?.has(g.id))).map((g) => g.id);
  const out: MarketLine[] = [];
  for (const g of goods) {
    const def = GOODS[g];
    if (def.quality && def.category !== 'grain') {
      const maxQ = Math.min(v.maxQuality, v.isMarket || (v.sells?.has(g) ?? false) ? maxQualityAt(E, v.settlement, g) : 1);
      for (let q = 0; q <= maxQ; q++) {
        const line = stockLine(E, v, keyOf(g, q as Quality), actor);
        if (line) out.push(line);
      }
    } else {
      const line = stockLine(E, v, g, actor);
      if (line) out.push(line);
    }
  }
  return out;
}

export function marketView(E: Econ, settlement: number, actor: Person | null): MarketView | null {
  const s = E.settlementById.get(settlement);
  if (!s || !s.market) return null;
  const day = E.day;
  const part = dayPart(day);
  const open = part !== 'night' && part !== 'dawn' && part !== 'dusk' && !isHolyDay(day);
  const v = venueOf(E, { kind: 'market', settlement });
  return {
    settlement, name: s.name, open, marketDay: isMarketDay(day, settlement), nextMarketDay: nextMarketDay(day, settlement),
    toll: actor && v ? tollFor(E, actor, v, 100) : 0,
    lines: v ? partnerLines(E, { kind: 'market', settlement }, actor) : [],
  };
}

function isOpen(E: Econ, v: Venue): string | null {
  const day = E.day;
  const part = dayPart(day);
  if (isHolyDay(day) && v.isMarket) return 'The market is closed on the holy day';
  if (part === 'night') return 'Everyone is asleep';
  if (v.isMarket && (part === 'dawn' || part === 'dusk')) return 'The stalls are not open now';
  return null;
}

export function quoteTrade(E: Econ, actorId: number, partner: TradePartnerRef, lines: TradeLine[]): TradeQuote {
  const fail = (reason: string): TradeQuote => ({ lines: [], money: 0, ok: false, reason });
  const actor = E.person(actorId);
  if (!actor || actor.death) return fail('Nobody to trade');
  const v = venueOf(E, partner);
  if (!v) return fail(partner.kind === 'person' ? 'They have nothing to trade' : 'Nothing is sold here');
  if (lines.length === 0) return { lines: [], money: 0, ok: true };
  const out: TradeQuote['lines'] = [];
  let spend = 0, gain = 0, weightIn = 0, weightOut = 0, saleValue = 0;
  let reason: string | undefined;
  const given = new Map<string, number>();
  for (const l of lines) {
    if (!(Math.abs(l.qty) > 1e-9)) continue;
    const { good } = parseItemKey(l.key);
    const def = GOODS[good];
    if (!def) { reason = `Unknown item ${l.key}`; continue; }
    const line = stockLine(E, v, l.key, actor);
    if (!line) { reason = `Unknown item ${l.key}`; continue; }
    if (l.qty > 0) {
      if (line.buy <= 0 || (v.sells && !v.sells.has(good))) { reason = reason ?? `${def.name} is not sold here`; continue; }
      if (line.stock + 1e-6 < l.qty) { reason = reason ?? `Only ${line.stock} ${def.unit} on offer`; continue; }
      if (def.category === 'livestock' && !E.hhOf(actor)?.head) { reason = reason ?? 'Only a household head can keep animals'; continue; }
      const total = round2(line.buy * l.qty);
      out.push({ ...l, unitPrice: line.buy, total });
      spend += total;
      weightIn += weightOf(l.key, l.qty);
    } else {
      const q = -l.qty;
      const have = ownedQty(E, actor, l.key) - (given.get(l.key) ?? 0);
      if (have + 1e-6 < q) { reason = reason ?? `You do not have ${q} ${def.unit}`; continue; }
      if (v.buys && !v.buys.has(good)) { reason = reason ?? 'They are not buying that'; continue; }
      let unit = line.sell;
      if (unit <= 0) unit = round3(basePriceOf(l.key) * 0.4);
      if (def.category === 'livestock' && E.hhOf(actor)?.head !== actor.id) { reason = reason ?? 'Those animals are not yours to sell'; continue; }
      const total = round2(unit * q);
      given.set(l.key, (given.get(l.key) ?? 0) + q);
      out.push({ ...l, unitPrice: unit, total });
      gain += total;
      saleValue += total;
      weightOut += weightOf(l.key, q);
    }
  }
  const toll = tollFor(E, actor, v, saleValue);
  const money = round2(spend + toll - gain);
  const closed = isOpen(E, v);
  if (!reason && closed) reason = closed;
  if (!reason && money > 0 && !E.canAfford(actor, money, true)) reason = `You need ${pd(money)}`;
  if (!reason && v.payer && money < 0 && v.payer.purse + 1e-9 < -money) reason = 'They cannot afford that';
  if (!reason && weightIn - weightOut > 0 && !canCarry(actor, weightIn - weightOut)) reason = `Too heavy to carry (you can bear ${capacityOf(actor)} kg)`;
  return reason ? { lines: out, money, ok: false, reason } : { lines: out, money, ok: true };
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

export function doTrade(E: Econ, actorId: number, partner: TradePartnerRef, lines: TradeLine[]): TradeResult {
  const quote = quoteTrade(E, actorId, partner, lines);
  if (!quote.ok) return { ok: false, reason: quote.reason, quote };
  const actor = E.person(actorId) as Person;
  const v = venueOf(E, partner) as Venue;
  const mid = E.marketFor(v.settlement);
  const settlement = v.settlement;
  const seller = v.seller;
  // goods
  for (const l of quote.lines) {
    const { good } = parseItemKey(l.key);
    const def = GOODS[good];
    const macro = MACRO_INDEX[good] !== undefined;
    if (l.qty > 0) {
      addOwned(E, actor, l.key, l.qty);
      if (v.isMarket && macro) addStock(E, mid, good, -l.qty);
      else if (v.payer && macro) { bagAdd(v.payer.stores, good, -Math.min(l.qty, bagGet(v.payer.stores, good))); E.state.touchHousehold(v.payer); }
    } else {
      const q = -l.qty;
      takeOwned(E, actor, l.key, q);
      if (macro) {
        // chaffy grain is winnowed on arrival
        const eff = parseItemKey(l.key).quality === 0 ? q * 0.9 : q;
        if (v.isMarket) addStock(E, mid, good, eff);
        else if (v.payer) { bagAdd(v.payer.stores, good, eff); E.state.touchHousehold(v.payer); }
      } else if (v.isMarket && mid >= 0 && def.category !== 'livestock') {
        const rec = marketRec(E, mid);
        rec.g[good] = Math.round(((rec.g[good] ?? 0) + (l.unitPrice * q) / depthOf(E, settlement)) * 1000) / 1000;
        E.touchMarkets();
      } else if (def.category === 'livestock' && v.payer) {
        bagAdd(v.payer.stores, l.key, q); E.state.touchHousehold(v.payer);
      }
    }
    E.sim.events.emit('trade', {
      buyer: l.qty > 0 ? actor.id : seller, seller: l.qty > 0 ? seller : actor.id, settlement, item: l.key, qty: Math.abs(l.qty), pence: l.total,
    });
  }
  // money
  const label = `Trade at ${v.name}`;
  if (quote.money > 0) {
    E.spend(actor, quote.money, label, true);
    if (v.payer) E.credit(v.payer, quote.money);
  } else if (quote.money < 0) {
    E.earn(actor, -quote.money, label);
    if (v.payer) E.debit(v.payer, -quote.money);
  }
  // practice
  const value = quote.lines.reduce((s, l) => s + l.total, 0);
  gainSkill(E.sim, actor, 'trade', Math.min(8, 1 + value * 0.08));
  E.state.touch(actor);
  return { ok: true, quote };
}

/** Unit price at the settlement's market for the API's `price()` (posted prices, no personal edge). */
export function apiPrice(E: Econ, settlement: number, key: ItemKey, side: 'buy' | 'sell'): number {
  const s = E.settlementById.get(settlement);
  const spread = s?.market ? MARKET_SPREAD : STALL_SPREAD;
  return postedPrice(E, settlement, key, side, spread);
}

/** Estimated value of a stack at the nearest market (pence, whole stack), for the inventory. */
export function stackValue(E: Econ, settlement: number, key: ItemKey, qty: number): number {
  return round2(postedPrice(E, settlement, key, 'sell', MARKET_SPREAD) * qty);
}

export { isHolyDay };
