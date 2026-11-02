// Where the building materials come from (civilization pass, docs/CIV.md §7): timber, planks, stone, bricks, iron, nails,
// straw, charcoal, salt, candles, vellum and tallow have stocks in the markets like the foods do (goods.json `supply`), but
// the stock a market keeps is set by what its hinterland USES and what the works of that hinterland MAKE. A kiln, a quarry,
// a saw pit, a salt pan, a lumber camp, a bloomery, a charcoal mound, a tannery or a slaughterhouse in reach raises the
// stock the market holds and lowers its price a little; where none stands the goods come from beyond the map at the usual
// price, and those that lie in the ground (stone, clay for bricks, iron, salt) cost a fifth more when no deposit or works is
// in reach of the market's lands. The works are read from the buildings (so a kiln raised in play counts the day it is done),
// and the deposits from the territory module when there is one. Everything here is a pure reading of the state: the census
// is kept only until a building (or the territory) changes, and is never saved.
import type { Settlement } from '../../world/types';
import type { Econ } from './core';
import { GOODS, MACRO_GOODS, MACRO_INDEX, WORKPLACES } from './data';
import { depositNear } from './deposits';

/** What a market's hinterland uses and makes of every stock-and-flow good (parallel to MACRO_GOODS; zero for the foods), and the price factor that follows. */
interface MarketSupply { demand: Float64Array; made: Float64Array; target: Float64Array; factor: Float64Array }

/** What a settlement has in reach of the goods that lie in the ground. */
interface SourceInfo { stone: boolean; clay: boolean; iron: boolean; salt: boolean }

interface Census {
  /** The state it was counted at: the construction events seen, the number of buildings, the territory service (and its version). */
  rev: number; size: number; terr: number; terrRef: unknown;
  /** Only ever goes up: the caches of targets compare against it. */
  stamp: number;
  /** Settlement → good → units a day when staffed. */
  by: Map<number, Record<string, number>>;
  sources: Map<number, SourceInfo>;
  markets: Map<number, MarketSupply>;
}

const cache = new WeakMap<Econ, Census>();
/** Stamps only ever go up, so a stamp never comes round again after the census is dropped. */
const stamps = new WeakMap<Econ, number>();

/** Radius (m) of the lands a settlement's deposits are looked for in. */
const REACH = 3000;
/** Share of a kiln's output when no clay is dug in reach (it buys clay in from afar). */
const KILN_WITHOUT_CLAY = 0.3;
/** Goods of the ground: what a market lacks pays a fifth more for. */
const LACK_PREMIUM = 1.2;
/** How much of the price the works of a hinterland take off at best (when they make far more than it uses). */
const MAX_DISCOUNT = 0.3;

const DEPOSIT_OF: Readonly<Record<string, keyof SourceInfo>> = { stone: 'stone', brick: 'clay', iron: 'iron', salt: 'salt' };

function sourcesOf(E: Econ, s: Settlement, by: Record<string, number>, own: readonly { kind: string; construction: number }[]): SourceInfo {
  const has = (kind: string): boolean => own.some((b) => b.kind === kind && b.construction >= 1);
  return {
    stone: has('quarry') || depositNear(E, s.x, s.z, REACH, 'stone'),
    clay: has('clay_pit') || depositNear(E, s.x, s.z, REACH, 'clay'),
    iron: has('bloomery') || has('mine') || depositNear(E, s.x, s.z, REACH, 'iron') || (by.iron ?? 0) > 0,
    salt: has('salt_pan') || depositNear(E, s.x, s.z, REACH, 'salt'),
  };
}

/**
 * The census of the world's works, counted again when a building is added or a construction event says one was finished,
 * upgraded or pulled down (`E.worksRev`), or the territory changes: the buildings are touched for a hundred other reasons (a
 * family moves house) and none of them changes what a works makes. A burnt works still counts until it is pulled down.
 */
function census(E: Econ): Census {
  const rev = E.worksRev, size = E.state.buildings.size, terrRef = E.sim.services.territory, terr = terrRef?.version() ?? 0;
  const hit = cache.get(E);
  if (hit && hit.rev === rev && hit.size === size && hit.terr === terr && hit.terrRef === terrRef) return hit;
  const by = new Map<number, Record<string, number>>();
  const sources = new Map<number, SourceInfo>();
  for (const s of E.world.settlements) {
    const list = E.state.buildingsAt.get(s.id) ?? [];
    const out: Record<string, number> = {};
    let any = false;
    for (const b of list) {
      const w = WORKPLACES[b.kind];
      if (!w || b.construction < 1) continue;
      const level = 1 + 0.4 * (b.level - 1);
      for (const good of Object.keys(w)) out[good] = (out[good] ?? 0) + w[good] * level;
      any = true;
    }
    // a kiln fires bricks from clay dug in reach, else from clay brought in
    const srcs = sourcesOf(E, s, out, list);
    sources.set(s.id, srcs);
    if (out.brick) out.brick *= srcs.clay ? 1 : KILN_WITHOUT_CLAY;
    if (any) by.set(s.id, out);
  }
  const stamp = (stamps.get(E) ?? 0) + 1;
  stamps.set(E, stamp);
  const next: Census = { rev, size, terr, terrRef, stamp, by, sources, markets: new Map() };
  cache.set(E, next);
  return next;
}

/**
 * A building raised in play is done (src/sim/construction, event `construction`): the works of the world are counted again
 * and the markets' targets follow at once, so a kiln or a saw pit is part of the supply from the day it is finished.
 */
export function attachConstructionEvents(E: Econ): () => void {
  return E.sim.events.on('construction', (e) => {
    if (e.phase !== 'done' && e.phase !== 'cancelled' && e.phase !== 'placed') return;
    E.worksRev++;
    E.touchMarkets();
  });
}

/** Changes whenever the supply of any market may have changed (the caches of targets are keyed by it). */
export function supplyStamp(E: Econ): number { return census(E).stamp; }

/** What the hinterland of the market at `mid` uses and makes of every material, with the target stock and price factor that follow (cached with the census). */
function supplyAt(E: Econ, mid: number): MarketSupply {
  const c = census(E);
  let m = c.markets.get(mid);
  if (m) return m;
  const n = MACRO_GOODS.length;
  m = { demand: new Float64Array(n), made: new Float64Array(n), target: new Float64Array(n), factor: new Float64Array(n).fill(1) };
  const members = E.hinterland.get(mid) ?? [mid];
  for (let i = 0; i < n; i++) {
    const g = MACRO_GOODS[i];
    const def = GOODS[g].supply;
    if (!def) continue;
    for (const sid of members) {
      const s = E.settlementById.get(sid);
      if (!s) continue;
      const ss = E.state.settlements.get(sid);
      m.demand[i] += (ss ? ss.target : s.population) * def.use;
      m.made[i] += c.by.get(sid)?.[g] ?? 0;
    }
    m.target[i] = Math.max(3, def.cover * (m.demand[i] + m.made[i]));
    let f = m.demand[i] > 0 ? 1 - MAX_DISCOUNT * (m.made[i] / (m.made[i] + m.demand[i])) : 1;
    const need = DEPOSIT_OF[g];
    if (need && m.made[i] <= 0) {
      let have = false;
      for (const sid of members) if (c.sources.get(sid)?.[need]) { have = true; break; }
      if (!have) f *= LACK_PREMIUM;
    }
    m.factor[i] = f;
  }
  c.markets.set(mid, m);
  return m;
}

export interface Supply {
  /** Units a day the hinterland uses. */
  demand: number;
  /** Units a day its works make. */
  made: number;
}

/** What the hinterland of the market at `mid` uses and makes of a stock-and-flow material. */
export function supplyOf(E: Econ, mid: number, good: string): Supply {
  const i = MACRO_INDEX[good];
  if (i === undefined || !GOODS[good]?.supply) return { demand: 0, made: 0 };
  const m = supplyAt(E, mid);
  return { demand: m.demand[i], made: m.made[i] };
}

/** Target stock of a material at a market: days of what is used and made. */
export function materialTarget(E: Econ, mid: number, good: string): number {
  const i = MACRO_INDEX[good];
  return i === undefined || !GOODS[good]?.supply ? 3 : supplyAt(E, mid).target[i];
}

/**
 * Price factor of the local supply: down to 30 percent off where the works make much more than the hinterland uses, a fifth
 * dearer for goods of the ground when nothing in reach of the market's lands yields them.
 */
export function supplyFactor(E: Econ, mid: number, good: string): number {
  const i = MACRO_INDEX[good];
  return i === undefined || !GOODS[good]?.supply ? 1 : supplyAt(E, mid).factor[i];
}
