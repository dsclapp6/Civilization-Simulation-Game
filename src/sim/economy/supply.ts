// Where the building materials come from (civilization pass, docs/CIV.md §7): timber, planks, stone, bricks, iron, nails,
// straw, charcoal, salt, candles, vellum and tallow have stocks in the markets like the foods do (goods.json `supply`), but
// the stock a market keeps is set by what its hinterland USES and what the works of that hinterland MAKE. A kiln, a quarry,
// a saw pit, a salt pan, a lumber camp, a bloomery, a charcoal mound, a tannery or a slaughterhouse in reach raises the
// stock the market holds and lowers its price a little; where none stands the goods come from beyond the map at the usual
// price, and those that lie in the ground (stone, clay for bricks, iron, salt) cost a fifth more when no deposit or works is
// in reach of the market's lands. The works are read from the buildings (so a kiln raised in play counts the day it is done),
// and the deposits from the territory module when there is one. Everything here is a pure reading of the state.
import type { Settlement } from '../../world/types';
import type { Econ } from './core';
import { GOODS, WORKPLACES } from './data';
import { depositNear } from './deposits';

/** The works of one settlement: good → units a day when staffed. */
type Census = Map<number, Record<string, number>>;

interface CensusCache { key: string; stamp: number; by: Census; sources: Map<number, SourceInfo> }
/** What a settlement has in reach of the goods that lie in the ground. */
interface SourceInfo { stone: boolean; clay: boolean; iron: boolean; salt: boolean; pit: boolean }

const cache = new WeakMap<Econ, CensusCache>();
/** Stamps only ever go up, so a stamp never comes round again after the census is dropped. */
const stamps = new WeakMap<Econ, number>();

/** Radius (m) of the lands a settlement's deposits are looked for in. */
const REACH = 3000;
/** Share of a kiln's output when no clay is dug in reach (it buys clay in from afar). */
const KILN_WITHOUT_CLAY = 0.3;
/** Deposit goods: what a market lacks pays a fifth more for. */
const LACK_PREMIUM = 1.2;

function keyOf(E: Econ): string {
  return `${E.state.buildingRevision}:${E.state.buildings.size}:${E.sim.services.territory?.version() ?? 0}`;
}

function sourcesOf(E: Econ, s: Settlement, by: Record<string, number>, own: readonly { kind: string; construction: number }[]): SourceInfo {
  const has = (kind: string): boolean => own.some((b) => b.kind === kind && b.construction >= 1);
  return {
    stone: has('quarry') || depositNear(E, s.x, s.z, REACH, 'stone'),
    clay: has('clay_pit') || depositNear(E, s.x, s.z, REACH, 'clay'),
    iron: has('bloomery') || has('mine') || depositNear(E, s.x, s.z, REACH, 'iron') || (by.iron ?? 0) > 0,
    salt: has('salt_pan') || depositNear(E, s.x, s.z, REACH, 'salt'),
    pit: has('clay_pit'),
  };
}

/** The census of the world's works, rebuilt whenever a building (or the territory) changes: never stale, never saved. */
function census(E: Econ): CensusCache {
  const key = keyOf(E);
  const hit = cache.get(E);
  if (hit && hit.key === key) return hit;
  const by: Census = new Map();
  const sources = new Map<number, SourceInfo>();
  for (const s of E.world.settlements) {
    const list = E.state.buildingsAt.get(s.id) ?? [];
    const out: Record<string, number> = {};
    let any = false;
    for (const b of list) {
      const w = WORKPLACES[b.kind];
      if (!w || b.construction < 1 || b.damage > 0.8 || b.onFire) continue;
      const level = 1 + 0.4 * (b.level - 1);
      for (const [good, perDay] of Object.entries(w)) {
        out[good] = (out[good] ?? 0) + perDay * level;
      }
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
  const next: CensusCache = { key, stamp, by, sources };
  cache.set(E, next);
  return next;
}

/**
 * A building raised in play is done (src/sim/construction, event `construction`): the works of the world are counted again
 * and the markets' targets follow at once, so a kiln or a saw pit is part of the supply from the day it is finished.
 */
export function attachConstructionEvents(E: Econ): () => void {
  return E.sim.events.on('construction', (e) => {
    if (e.phase !== 'done' && e.phase !== 'cancelled') return;
    cache.delete(E);
    E.targetStamp.clear();
    E.touchMarkets();
  });
}

/** Changes whenever the supply of any market may have changed (the caches of targets are keyed by it). */
export function supplyStamp(E: Econ): number { return census(E).stamp; }

export interface Supply {
  /** Units a day the hinterland uses. */
  demand: number;
  /** Units a day its works make. */
  made: number;
}

/** What the hinterland of the market at `mid` uses and makes of a stock-and-flow material. */
export function supplyOf(E: Econ, mid: number, good: string): Supply {
  const def = GOODS[good]?.supply;
  if (!def) return { demand: 0, made: 0 };
  const c = census(E);
  let demand = 0, made = 0;
  for (const sid of E.hinterland.get(mid) ?? [mid]) {
    const ss = E.state.settlements.get(sid);
    const s = E.settlementById.get(sid);
    if (!s) continue;
    demand += (ss ? ss.target : s.population) * def.use;
    made += c.by.get(sid)?.[good] ?? 0;
  }
  return { demand, made };
}

/** Target stock of a material at a market: days of what is used and made. */
export function materialTarget(E: Econ, mid: number, good: string): number {
  const def = GOODS[good]?.supply;
  if (!def) return 3;
  const { demand, made } = supplyOf(E, mid, good);
  return Math.max(3, def.cover * (demand + made));
}

const DEPOSIT_OF: Readonly<Record<string, keyof SourceInfo>> = { stone: 'stone', brick: 'clay', iron: 'iron', salt: 'salt' };

/**
 * Price factor of the local supply: down to 30 percent off where the works make much more than the hinterland uses, a fifth
 * dearer for goods of the ground when nothing in reach of the market's lands yields them.
 */
export function supplyFactor(E: Econ, mid: number, good: string): number {
  const def = GOODS[good]?.supply;
  if (!def) return 1;
  const { demand, made } = supplyOf(E, mid, good);
  let f = demand > 0 ? 1 - 0.3 * (made / (made + demand)) : 1;
  const need = DEPOSIT_OF[good];
  if (need && made <= 0) {
    const c = census(E);
    let have = false;
    for (const sid of E.hinterland.get(mid) ?? [mid]) if (c.sources.get(sid)?.[need]) { have = true; break; }
    if (!have) f *= LACK_PREMIUM;
  }
  return f;
}
