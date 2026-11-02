// The content of building in play (src/content/construction.json) with typed access and the few derived numbers the rest of
// the module needs: costs by kind and level, prices of materials, wages, crew sizes, counts allowed per settlement.
import { BUILDINGS, BUILDING_KINDS, type BuildingKind } from '../../content/types';
import constructionJson from '../../content/construction.json';
import goodsJson from '../../content/goods.json';
import type { SettlementKind, SkillId } from '../../core/domain';
import type { ResourceKind } from '../../world/types';
import type { BuildCategory, BuildCost } from './types';

export interface LevelCost { goods: Readonly<Record<string, number>>; labour: number; pence: number }

export type MaxPer = number | ({ default?: number } & Partial<Record<SettlementKind, number>>);

export interface KindRules {
  kind: BuildingKind;
  cat: BuildCategory;
  /** Least rank tier of a builder with authority over the land (a title or an office). */
  rank: number;
  /** Least rank tier of a household head building it on their own household's land (0 = not on own land). */
  own: number;
  max?: MaxPer;
  tech?: string;
  terrain?: 'river' | 'rise' | 'coast' | 'deposit' | 'forest';
  deposits?: readonly ResourceKind[];
  /** May found an outpost in the wild. */
  wild: boolean;
  /** Steepest ground (rise over run). */
  slope: number;
  skill: SkillId;
  does: string;
  levels: readonly LevelCost[];
}

export interface OfficeRule { agent: boolean; cats?: readonly BuildCategory[]; maxRank?: number }

interface RawKind {
  cat: BuildCategory; rank: number; own: number; max?: MaxPer; tech?: string; terrain?: KindRules['terrain'];
  deposits?: ResourceKind[]; wild?: boolean; slope?: number; skill?: SkillId; does: string; levels: LevelCost[];
}

interface RawFile {
  wages: { labour: number; skilled: number };
  workHours: [number, number];
  crew: { perDays: number; min: number; max: number };
  horizonDays: number;
  salvage: number;
  cancelRefund: number;
  repair: { goods: number; labour: number; pence: number };
  demolishLabour: number;
  offices: Record<string, OfficeRule>;
  kinds: Record<string, RawKind>;
}

const raw = constructionJson as unknown as RawFile;

export const WAGES = raw.wages;
/** First and one past the last hour of the working day. */
export const WORK_START = raw.workHours[0];
export const WORK_END = raw.workHours[1];
export const WORK_HOURS = WORK_END - WORK_START;
export const HORIZON_DAYS = raw.horizonDays;
export const SALVAGE = raw.salvage;
export const CANCEL_REFUND = raw.cancelRefund;
export const REPAIR = raw.repair;
export const DEMOLISH_LABOUR = raw.demolishLabour;
export const OFFICES: Readonly<Record<string, OfficeRule>> = raw.offices;

export const DEFAULT_SLOPE = 0.28;

export const RULES = new Map<BuildingKind, KindRules>();
for (const kind of BUILDING_KINDS) {
  const r = raw.kinds[kind];
  if (!r) continue;
  RULES.set(kind, {
    kind, cat: r.cat, rank: r.rank, own: r.own, max: r.max, tech: r.tech, terrain: r.terrain, deposits: r.deposits,
    wild: r.wild === true, slope: r.slope ?? DEFAULT_SLOPE, skill: r.skill ?? 'carpentry', does: r.does, levels: r.levels,
  });
}

export function rulesOf(kind: BuildingKind): KindRules {
  const r = RULES.get(kind);
  if (!r) throw new Error(`construction: no rules for ${kind}`);
  return r;
}

// ---------------------------------------------------------------------------------------------
// Prices and costs
// ---------------------------------------------------------------------------------------------

const PRICES = new Map<string, number>();
for (const [id, g] of Object.entries(goodsJson as unknown as Record<string, { basePrice?: number } | string>)) {
  if (id.startsWith('_') || typeof g === 'string') continue;
  PRICES.set(id, g.basePrice ?? 1);
}
/** Reference price (pence) of a material. */
export function priceOf(good: string): number { return PRICES.get(good) ?? 1; }

export function maxLevelOf(kind: BuildingKind): number { return BUILDINGS[kind].maxLevel; }

/** Cost of raising the kind new (level 1) or of upgrading it to `level` (level 2+): the content's entry. */
export function levelCost(kind: BuildingKind, level = 1): BuildCost {
  const r = rulesOf(kind);
  const i = Math.max(1, Math.min(r.levels.length, Math.round(level))) - 1;
  const l = r.levels[i];
  return { goods: l.goods, labour: l.labour, pence: l.pence };
}

/** Everything spent on a building of a level so far (new + the upgrades up to it). */
export function totalCost(kind: BuildingKind, level: number): BuildCost {
  const goods: Record<string, number> = {};
  let labour = 0, pence = 0;
  const top = Math.max(1, Math.min(rulesOf(kind).levels.length, Math.round(level)));
  for (let l = 1; l <= top; l++) {
    const c = levelCost(kind, l);
    for (const [g, q] of Object.entries(c.goods)) goods[g] = (goods[g] ?? 0) + q;
    labour += c.labour;
    pence += c.pence;
  }
  return { goods, labour, pence };
}

/** Worth of the materials alone at reference prices. */
export function goodsValue(goods: Readonly<Record<string, number>>): number {
  let v = 0;
  for (const [g, q] of Object.entries(goods)) v += q * priceOf(g);
  return v;
}

/** Wage (pence per worker-day) for the kind of work: stone and defence work is skilled. */
export function wageFor(kind: BuildingKind): number {
  const r = rulesOf(kind);
  return r.skill === 'masonry' ? WAGES.skilled : WAGES.labour;
}

/** Worth of a whole cost at reference prices, labour at the going wage. */
export function costValue(kind: BuildingKind, cost: BuildCost): number {
  return goodsValue(cost.goods) + cost.labour * wageFor(kind) + cost.pence;
}

/** Most hands that can usefully work on a job of this many worker-days at once. */
export function maxCrew(labour: number): number {
  return Math.max(raw.crew.min, Math.min(raw.crew.max, Math.ceil(labour / raw.crew.perDays)));
}

/** How many of a kind a settlement of that kind may hold (Infinity = no limit). */
export function maxPerSettlement(kind: BuildingKind, settlementKind: SettlementKind | undefined): number {
  const m = rulesOf(kind).max;
  if (m === undefined) return Infinity;
  if (typeof m === 'number') return m;
  const v = (settlementKind ? m[settlementKind] : undefined) ?? m.default;
  return v === undefined ? Infinity : v;
}

export const CATEGORY_NAMES: Record<BuildCategory, string> = {
  home: 'Homes', farm: 'Farm', craft: 'Crafts', food: 'Food', religion: 'Religion', civic: 'Civic', defence: 'Defence',
  resource: 'Resources', military: 'Military',
};

/** Dominant material of a build, for the player's bouts (wood or stone). */
export function stoneWork(kind: BuildingKind, level: number): boolean {
  const c = levelCost(kind, level);
  let stone = 0, wood = 0;
  for (const [g, q] of Object.entries(c.goods)) {
    const v = q * priceOf(g);
    if (g === 'stone' || g === 'brick' || g === 'clay') stone += v; else if (g === 'timber' || g === 'planks' || g === 'straw') wood += v;
  }
  return stone > wood;
}
