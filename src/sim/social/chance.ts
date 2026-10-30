// Chances of success for social checks (persuasion, flattery, favours, courtship …). The number the
// player is shown is exactly the number rolled: probability = base + charisma + Persuasion skill +
// the other's opinion + rank difference + traits, kept within 3%..97%.
import type { Person, TraitId } from '../state';
import { skillOf } from '../skills';
import type { SocialCore } from './core';
import { clamp, round2, standingOf } from './util';

export interface CheckSpec {
  base: number;
  /** Per opinion point the other holds of the actor (default 0.004: ±0.4 at ±100). */
  opinionW?: number;
  /** Per point of Charisma above 10 (default 0.02). */
  chaW?: number;
  /** Per Persuasion level (default 0.012). */
  skillW?: number;
  /** Per tier the other stands above the actor (default −0.04) and below (default +0.015). */
  rankUp?: number;
  rankDown?: number;
  /** Adjustments when the OTHER has the trait / the ACTOR has it. */
  other?: Partial<Record<TraitId, number>>;
  actor?: Partial<Record<TraitId, number>>;
  /** Anything else (courtship progress, gift value …). */
  extra?: number;
  /** Which skill counts (default persuasion). */
  skill?: 'persuasion' | 'leadership';
}

export interface ChanceParts { chance: number; parts: Array<[string, number]> }

export function checkChance(core: SocialCore, actor: Person, other: Person, spec: CheckSpec): number {
  return checkDetail(core, actor, other, spec).chance;
}

export function checkDetail(core: SocialCore, actor: Person, other: Person, spec: CheckSpec): ChanceParts {
  const parts: Array<[string, number]> = [['base', spec.base]];
  let p = spec.base;
  const add = (label: string, v: number): void => { if (v !== 0) { p += v; parts.push([label, v]); } };
  add('opinion', (spec.opinionW ?? 0.004) * core.opinion.total(other, actor));
  add('charisma', (spec.chaW ?? 0.02) * (actor.trained.cha - 10));
  add('skill', (spec.skillW ?? 0.012) * skillOf(actor, spec.skill ?? 'persuasion'));
  const gap = standingOf(other) - standingOf(actor);
  add('rank', gap > 0 ? (spec.rankUp ?? -0.04) * gap : (spec.rankDown ?? 0.015) * gap * -1);
  if (spec.other) for (const t of other.traits) add(`their ${t}`, spec.other[t] ?? 0);
  if (spec.actor) for (const t of actor.traits) add(`your ${t}`, spec.actor[t] ?? 0);
  add('other', spec.extra ?? 0);
  return { chance: round2(clamp(p, 0.03, 0.97)), parts };
}

/** Rolls a check against the social RNG stream. */
export function roll(core: SocialCore, chance: number): boolean {
  return core.rng().next() < chance;
}
