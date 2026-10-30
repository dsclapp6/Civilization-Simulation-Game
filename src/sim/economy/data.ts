// Typed loaders for the economy's content tables (src/content/*.json): goods, crops, recipes,
// careers and perks. Everything here is static data; nothing mutable lives in this file.
import careersJson from '../../content/careers.json';
import goodsJson from '../../content/goods.json';
import perksJson from '../../content/perks.json';
import recipesJson from '../../content/recipes.json';
import type { Sex, SkillId, StatId } from '../../core/domain';
import type { AnimState, HeldItem } from '../../core/view';
import type { CareerId } from '../careers';
import { formatMoney } from '../money';
import { CROPS } from '../farming';
import {
  QUALITY_NAMES, parseItemKey,
  type EntryTest, type GoodDef, type ItemKey, type PerkDef, type Quality,
} from './types';

// ---------------------------------------------------------------------------------------------
// Goods
// ---------------------------------------------------------------------------------------------

const rawGoods = goodsJson as unknown as Record<string, Omit<GoodDef, 'id'> | string>;
export const GOODS: Record<string, GoodDef> = {};
for (const [id, def] of Object.entries(rawGoods)) {
  if (id === '_doc' || typeof def === 'string') continue;
  GOODS[id] = { id, ...def };
}
export const GOOD_LIST: readonly GoodDef[] = Object.values(GOODS);
/** Goods that have stocks and flows in the market model, in a stable order. */
export const MACRO_GOODS: readonly string[] = GOOD_LIST.filter((g) => g.macro).map((g) => g.id);
export const MACRO_INDEX: Readonly<Record<string, number>> = Object.fromEntries(MACRO_GOODS.map((g, i) => [g, i]));

export const DEFAULT_QUALITY_PRICE: readonly number[] = [0.55, 1, 2.5, 6, 15];
/** Work speed multiplier of a tool by quality (crude 0.7 … masterwork 1.6). */
export const TOOL_SPEED: readonly number[] = [0.7, 1.0, 1.2, 1.4, 1.6];

/** Builds the canonical item key. Plain goods ignore quality; quality goods keep '#q' (grain keeps it only for 0, chaffy). */
export function keyOf(good: string, quality?: Quality): ItemKey {
  const def = GOODS[good];
  if (!def || !def.quality || quality === undefined) return good;
  if (def.category === 'grain' && quality !== 0) return good;
  return `${good}#${quality}`;
}

/** Quality of a stack: tools default to common (1) when the key has no suffix. */
export function qualityOf(key: ItemKey): Quality {
  const { good, quality } = parseItemKey(key);
  const def = GOODS[good];
  if (!def || !def.quality) return 1;
  return quality ?? 1;
}

export function goodOf(key: ItemKey): GoodDef | undefined {
  return GOODS[parseItemKey(key).good];
}

/** Reference price (pence per unit) of an item key at a normal market. */
export function basePriceOf(key: ItemKey): number {
  const { good, quality } = parseItemKey(key);
  const def = GOODS[good];
  if (!def) return 0;
  if (!def.quality) return def.basePrice;
  const q = quality ?? 1;
  return def.basePrice * (def.qualityPrice ?? DEFAULT_QUALITY_PRICE)[q];
}

const GRAIN_QUALITY_NAMES = ['chaffy', 'common', 'common', 'common', 'common'] as const;

export function qualityLabel(good: GoodDef, q: Quality): string {
  if (good.category === 'grain') return GRAIN_QUALITY_NAMES[q];
  return QUALITY_NAMES[q];
}

/** "good sickle", "3 gallons of wheat", "1 chaffy gallon of barley". */
export function describeItem(key: ItemKey, qty?: number): string {
  const { good, quality } = parseItemKey(key);
  const def = GOODS[good];
  if (!def) return qty !== undefined && qty !== 1 ? `${qty} ${key}` : key;
  const one = qty === undefined ? true : Math.abs(qty - 1) < 1e-9;
  let phrase = one ? (def.unitOne ?? def.name.toLowerCase()) : def.unit;
  if (def.quality && quality !== undefined && (quality !== 1 || def.category !== 'grain')) {
    const label = qualityLabel(def, quality);
    if (label !== 'common' || def.category !== 'grain') {
      const low = def.name.toLowerCase();
      phrase = phrase.includes(low) ? phrase.replace(low, `${label} ${low}`) : `${label} ${phrase}`;
    }
  }
  if (qty === undefined) return phrase;
  const n = Math.round(qty * 100) / 100;
  return `${n} ${phrase}`;
}

// ---------------------------------------------------------------------------------------------
// Crops (tables live in sim/farming.ts so the farm model needs nothing else)
// ---------------------------------------------------------------------------------------------

export { CALENDAR, CROPS, GARDEN_CROPS, SPRING_CROP_LIST as SPRING_CROPS, WINTER_CROPS } from '../farming';
export type { CropDef, FarmCalendar, GardenCropDef } from '../farming';

// ---------------------------------------------------------------------------------------------
// Careers
// ---------------------------------------------------------------------------------------------

export interface CareerEcon {
  skill: SkillId;
  workplace: string[];
  anim: AnimState;
  held: HeldItem;
  /** Pence per day when employed by someone else, by ladder stage. */
  wage: number[];
  /** Pence per working day the head of such a household nets in the macro economy, by stage. */
  income: number[];
  produces?: Record<string, number>;
  consumes?: Record<string, number>;
  premium?: number;
  term?: number;
  minAge: number;
  sells?: string[];
  buys?: string[];
}
export interface FieldInfo { label: string; entry: string; ladder: string[]; sexRule?: string }

const rawCareers = careersJson as unknown as {
  fields: Record<string, FieldInfo>;
  careers: Record<string, CareerEcon>;
  tests: Array<{ career: string; label: string; stats: Partial<Record<StatId, number>>; skills: Partial<Record<SkillId, number>>; kit: string[]; sex?: Sex; minAge: number; maxAge?: number }>;
};
export const FIELD_INFO = rawCareers.fields;
export const CAREER_ECON = rawCareers.careers as Record<CareerId, CareerEcon>;
export const ENTRY_TESTS: readonly EntryTest[] = rawCareers.tests.map((t) => ({ ...t, career: t.career as CareerId }));

export function careerEcon(id: CareerId): CareerEcon { return CAREER_ECON[id] ?? CAREER_ECON.none; }

// ---------------------------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------------------------

export interface RecipeDef {
  id: string;
  name: string;
  building: string[];
  skill: SkillId;
  level: number;
  /** Minimum craft ladder stage (−1: anyone). */
  stage: number;
  tool?: string;
  inputs: Record<string, number>;
  outputs: Record<string, number>;
  work: number;
  quality?: boolean;
  xp: number;
  anim: AnimState;
  held: HeldItem;
}
export interface ApprenticeTask { id: string; name: string; anim: AnimState; held: HeldItem; str: number; end: number }

const rawRecipes = recipesJson as unknown as { recipes: Record<string, Omit<RecipeDef, 'id'>>; apprenticeTasks: Record<string, ApprenticeTask[]> };
export const RECIPES: Record<string, RecipeDef> = {};
for (const [id, r] of Object.entries(rawRecipes.recipes)) RECIPES[id] = { id, ...r };
export const RECIPE_LIST: readonly RecipeDef[] = Object.values(RECIPES);
export const APPRENTICE_TASKS: Readonly<Record<string, ApprenticeTask[]>> = rawRecipes.apprenticeTasks;

/** Recipes that can be made at a building kind (or at home). */
export function recipesAt(kind: string, home: boolean): RecipeDef[] {
  return RECIPE_LIST.filter((r) => r.building.includes(kind) || (home && r.building.includes('home')));
}

// ---------------------------------------------------------------------------------------------
// Perks
// ---------------------------------------------------------------------------------------------

const rawPerks = perksJson as unknown as { perks: PerkDef[] };
export const PERKS: readonly PerkDef[] = rawPerks.perks;
export const PERK_BY_ID: ReadonlyMap<string, PerkDef> = new Map(PERKS.map((p) => [p.id, p]));

/** The two perks offered by (skill, level), in file order. */
export function perksAt(skill: SkillId, level: number): PerkDef[] {
  return PERKS.filter((p) => p.skill === skill && p.level === level);
}

/** Basic consistency check of every table (used by the tests). Returns problems found. */
export function validateData(): string[] {
  const bad: string[] = [];
  for (const r of RECIPE_LIST) {
    for (const g of [...Object.keys(r.inputs), ...Object.keys(r.outputs)]) if (!GOODS[g]) bad.push(`recipe ${r.id}: unknown good ${g}`);
    if (r.tool && !GOODS[r.tool]) bad.push(`recipe ${r.id}: unknown tool ${r.tool}`);
  }
  for (const [id, c] of Object.entries(CROPS)) {
    if (!GOODS[c.good]) bad.push(`crop ${id}: unknown good ${c.good}`);
    if (!GOODS[c.sheaf]) bad.push(`crop ${id}: unknown sheaf ${c.sheaf}`);
  }
  for (const [id, c] of Object.entries(CAREER_ECON)) {
    for (const g of [...(c.sells ?? []), ...(c.buys ?? []), ...Object.keys(c.produces ?? {}), ...Object.keys(c.consumes ?? {})]) if (!GOODS[g]) bad.push(`career ${id}: unknown good ${g}`);
  }
  return bad;
}

/** Money for texts, in the game's style: fractions of a penny below a penny, then "4½d", "1s 4d", "£3 2s". */
export function pd(n: number): string {
  if (n >= 11.5) return formatMoney(Math.round(n));
  if (n >= 0.95) return formatMoney(Math.round(n * 2) / 2);
  return `${Math.round(n * 100) / 100}d`;
}
