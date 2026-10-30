// Small pure helpers shared by the social system: age and rank bands, rounding that keeps saved state
// free of negative zero, deterministic text-variation hashing, list formatting.
import type { RankTier } from '../../core/domain';
import { hash3 } from '../../core/math';
import { ageYears, type Person } from '../state';

export type AgeBand = 'child' | 'youth' | 'adult' | 'elder';
export type RankBand = 'low' | 'mid' | 'high';

export function ageBand(age: number): AgeBand {
  return age < 12 ? 'child' : age < 18 ? 'youth' : age < 50 ? 'adult' : 'elder';
}

/** low = unfree and commoners, mid = middling and gentry, high = knights and above. */
export function rankBand(tier: number): RankBand {
  return tier <= 2 ? 'low' : tier <= 4 ? 'mid' : 'high';
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
/** One decimal; never returns -0 (which would not survive a JSON round trip). */
export const round1 = (v: number): number => Math.round(v * 10) / 10 + 0;
export const round2 = (v: number): number => Math.round(v * 100) / 100 + 0;

export function capitalise(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/** "Anne", "Anne and Wat", "Anne, Wat and Tom". */
export function joinNames(names: readonly string[], and = 'and'): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} ${and} ${names[names.length - 1]}`;
}

/** Hash of a string (FNV-1a) so text choices can be keyed by names without touching the RNG. */
export function hashText(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** Deterministic 0..1 from ids and a salt — for cosmetic variation only (never for outcomes). */
export function noise01(a: number, b: number, salt: string | number): number {
  const s = typeof salt === 'number' ? salt : hashText(salt);
  return hash3(a, b, s) / 4294967296;
}

export function ageOf(p: Person, absDay: number): number { return ageYears(p, absDay); }

/** Standing used for deference: the rank tier, clergy counting half a step higher among commoners. */
export function standingOf(p: Pick<Person, 'rankTier' | 'estate'>): number {
  return p.rankTier + (p.estate === 'clergy' && p.rankTier < 5 ? 0.5 : 0);
}

export function isClergy(p: Pick<Person, 'estate'>): boolean { return p.estate === 'clergy'; }

export function tierName(tier: RankTier | number): string {
  return ['', 'unfree', 'commoner', 'middling', 'gentry', 'knightly', 'baronial', 'magnate', 'royal'][tier] ?? '';
}

/** Sorted-unique push. */
export function pushUnique<T>(arr: T[], v: T): void { if (!arr.includes(v)) arr.push(v); }
