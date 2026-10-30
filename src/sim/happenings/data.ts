// Typed access to src/content/happenings.json.
import json from '../../content/happenings.json';
import type { Difficulty } from '../../core/domain';
import type { HappeningKind, RequestType } from './types';

interface FetchGood { good: string; qty: [number, number] }

export interface HappeningData {
  difficulty: Record<Difficulty, Record<'plague' | 'famine' | 'disaster' | 'bandits' | 'revolt' | 'requests', number>>;
  rates: Record<'plague' | 'drought' | 'flood' | 'fire' | 'bandits' | 'winter' | 'tournament' | 'progress', number>;
  calendar: Record<'midsummer' | 'harvest' | 'christmas' | 'fair' | 'tournament' | 'progress' | 'yearEnd', number>;
  famine: { start: number; end: number };
  plague: { duration: [number, number]; infect: number; recover: number; spread: number };
  names: Record<HappeningKind, string>;
  text: Record<HappeningKind, { start: string[]; end: string[] }>;
  requests: {
    maxOpen: number; minGapDays: number; dailyChance: number; offerDays: number;
    weights: Record<RequestType, number>;
    fetch: { goods: FetchGood[]; famineGoods: FetchGood[]; premium: number; days: number; ask: string[]; thanks: string[] };
    loan: { amounts: number[]; interest: number; days: number; offerDays: number; ask: string[]; thanks: string[] };
    work: { count: [number, number]; wage: number; days: number; ask: string[]; thanks: string[] };
    message: { days: number; pay: number; ask: string[]; thanks: string[]; delivered: string[] };
    lost_animal: { radius: [number, number]; found: number; days: number; pay: number; ask: string[]; thanks: string[] };
    watch: { hours: number; days: number; pay: number; ask: string[]; thanks: string[] };
    godparent: { days: number; gift: number; ask: string[]; thanks: string[] };
    marriage: { days: number; ask: string[]; thanks: string[] };
  };
}

export const DATA = json as unknown as HappeningData;

/** Fills {placeholders} in a text. */
export function fill(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (_m, k: string) => (vars[k] !== undefined ? String(vars[k]) : `{${k}}`));
}

/** Buildings that do not burn. */
export const FIREPROOF: ReadonlySet<string> = new Set([
  'church', 'abbey_church', 'cathedral', 'cloister', 'keep_stone', 'tower', 'wall', 'gatehouse', 'well', 'quarry', 'mine',
  'market_cross', 'stocks', 'gallows', 'palisade', 'motte', 'tent', 'kiln', 'bloomery', 'charcoal_mound', 'dock', 'archery_butts',
]);
